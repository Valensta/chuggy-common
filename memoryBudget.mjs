/**
 * The memory the containers on one engine may take together, which a
 * container backend holds every runner using that engine to, as a kubelet
 * holds a node's pods to its allocatable memory.
 *
 * THE BUDGET IS THE ENGINE'S MEMORY LESS WHAT ITS RUNNER KEEPS FREE, the
 * engine's as its own `info` says, so an engine in a VM answers for the VM.
 * Every running container is counted against it: one carrying the pool label
 * and a memory cap, as a runner runs each workload, at that cap whichever
 * runner ran it; and every other, such as what a job started through the
 * engine's socket, at what the engine says it uses. A job held for room, or
 * about to start into it, is counted at its cap by its hold until its
 * container runs, and then by its container alone. What is left is the room.
 *
 * WHAT IS APPROXIMATE: a container counted by its use is counted at what it
 * used when the engine was asked, so its growth, and what a job starts once
 * it runs, are counted only by a later count; what the engine and its machine
 * use outside every container is only what the runner keeps free; a
 * container counted at its cap is counted at what it may take, not at what it
 * takes; and where the engine refuses to say what its containers use, as
 * rootless podman on cgroup v1 does, every container counted by its use is
 * counted at none, which the count says.
 *
 * A HOLD IS A VOLUME, which every runner on the engine lists whatever its
 * user, and which needs no image and runs nothing. It carries the job's
 * assignment, its cap, when it was first held, the process holding it, when
 * the assignment's deadline passes, and whether it was made for a job
 * decided to start rather than one held for room. One whose process is not
 * running, or whose deadline has passed, is abandoned: no count counts it,
 * and whichever runner finds it removes it, so a process number another
 * process has since taken keeps a hold no longer than its deadline. Holds are
 * listed before what is running, so a job whose container starts and whose
 * hold goes while the engine is counted is counted by the one or the other.
 *
 * A JOB IS HELD FROM ITS CLAIM, AND STARTS ONLY INTO ROOM. Its runner counts,
 * decides and makes its hold in one hold of a lock that every runner using the
 * engine as this user shares, as the job is placed and before its images are
 * pulled, so every count after counts the job at its cap until its container
 * runs and its hold goes. A job decided to start then starts once its images
 * are here; one held for room is checked again once they are. A job starts
 * where it fits the room its own hold leaves and no job held for room is older,
 * so held jobs start in the order they were held. Runners of another user share
 * no lock, and can start into the same room. Two runners that judge the same
 * abandoned lock at once can both hold one, as `fileLock.mjs` says, which takes
 * a runner that died holding it, and costs at most one start into room another
 * start took.
 *
 * A START ENDS BEFORE ITS HOLD'S DEADLINE. A job is decided to start only
 * where its run can be given `memoryStartMsMin`, or half its hold's life where
 * that is less, before it is cut `memoryStartCutMs` short of that deadline, and its run is cut there, so no
 * count judges a hold past its deadline while its job can still start. A job
 * left less time fails as too late to start.
 *
 * THE CEILING IS THE BUDGET LESS WHAT THE RUNNER RESERVES, which no job it
 * takes may ask past, so a job that would fit only once what is always running
 * has ended goes to another runner instead. A session is bound by the whole
 * budget.
 *
 * A PLANE THAT CLAIMS BY ROOM is told the room, less what the runner is placing
 * that has no hold yet, and the ceiling, and gives only jobs that fit both.
 * Each runner asking it for jobs first takes the claim lock, beside the memory
 * lock, without waiting, and lets it go once each job it was given has its
 * hold, so no two runners on the engine are given the same room. It is
 * abandoned as the memory lock is, and a claim held past its age bound costs at
 * most a job held for room another runner was given. Against a plane that does
 * not, no job is claimed while the room is under `memoryRoomMibMin`, or while
 * any job on the engine is held for room. A count that failed claims none and
 * starts none, since a full engine is the one slowest to answer.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { z } from "zod";

import { diskGib } from "./diskFloor.mjs";
import {
  assignmentLabel,
  engineInfoArgv,
  heldLabel,
  heldListArgv,
  heldMemoryLabel,
  heldProcessLabel,
  heldSinceLabel,
  heldStartingLabel,
  heldUntilLabel,
  inspectArgv,
  kindLabel,
  memoryStatsArgv,
  poolLabel,
  runningListArgv,
  volumeInspectArgv,
  volumeRemoveArgv,
} from "./engineArgv.mjs";
import { engineFailure, engineFailureLine } from "./engineErrors.mjs";
import { fileLocked, fileLockHolderAlive, fileLockTaken } from "./fileLock.mjs";

/**
 * @typedef {import("./engine.mjs").Engine} Engine
 * @typedef {import("./engine.mjs").EngineAnswer} EngineAnswer
 * @typedef {import("./engineArgv.mjs").MemoryHoldLabels} MemoryHold a job held for room, or about to start into it, as its hold says
 *
 * @typedef {object} MemoryCount
 * @property {number} engineBytes the engine's memory
 * @property {number} cappedBytes every running container a runner ran, at its cap
 * @property {number} sessionBytes the sessions among those, at their caps
 * @property {number} usedBytes every other running container, at its use
 * @property {string} [unmeasured] why `usedBytes` counts none: the engine refused to say what its containers use
 * @property {readonly MemoryHold[]} holds every hold not abandoned whose assignment no running container counted at its cap carries
 * @property {readonly string[]} started the assignments the running containers counted at their caps carry
 *
 * @typedef {MemoryCount | {unknown: string}} MemoryCounted
 *
 * @typedef {object} MemoryCountPorts
 * @property {Engine} engine
 * @property {"docker" | "podman"} name the engine's
 * @property {(pid: number) => boolean} holderAlive
 * @property {() => number} nowMs
 * @property {AbortSignal} signal which every call of the count is made under
 *
 * @typedef {"Taking" | "Full" | "Held" | "Unknown"} MemoryBudgetState whether a count takes jobs, and why not
 *
 * @typedef {object} MemoryBudget
 * @property {number} bytesFree what its runner keeps free of the engine's memory
 * @property {number} bytesReserved what its runner reserves of the budget, which no job may ask
 * @property {string} lockFile the memory lock's
 * @property {string | undefined} claimLockFile the claim lock's; none, and the runner claims no job by room
 * @property {MemoryCounted | undefined} counted what the last `held` found, none before the first
 * @property {number} placingBytes the caps of what the runner was placing and had made no hold for, as the last `held` found
 * @property {boolean} jobsTaken whether a plane that does not claim by room is asked for jobs
 * @property {MemoryBudgetState} said what was last logged of it, `Taking` before anything was
 * @property {boolean} saidUnmeasured whether the use was last logged as counted at none
 *
 * @typedef {{decided: "Start"} | {decided: "Running"} | {decided: "Hold", why: string} | {decided: "Late"}} MemoryDecision
 *
 * @typedef {object} MemoryRoom what a poll tells a plane of the engine's memory, in MiB
 * @property {number} roomMib
 * @property {number} [ceilingMib] none where the count failed
 */

const mibBytes = 2 ** 20;

/**
 * The least room a job is claimed into: the least memory a configuration may
 * give a job, chuggy's `configurationMemoryMibMin` in its
 * `src/contract/configurationDocument.ts`. Under it no job fits, so a claim
 * could only be held.
 */
export const memoryRoomMibMin = 512;

/** The longest a pass waits on its count. */
export const memoryCountMsMax = 30_000;

/** The longest the engine calls of one hold of the memory lock take together. */
export const memoryLockCallsMsMax = 60_000;

/** How old the memory lock may be before it is abandoned: longer than any hold, its engine calls included. */
export const memoryLockHeldMsMax = memoryLockCallsMsMax + 60_000;

/** How long a check waits for another's hold of the lock: longer than any live hold lasts, so it waits one out. */
export const memoryLockWaitMsMax = memoryLockHeldMsMax + 60_000;

/** How old the claim lock may be before it is abandoned whoever it names, which frees one whose holder died under a process number since taken. */
export const memoryClaimHeldMsMax = 10 * 60_000;

/** Between two checks of a held job's room, each a count under the lock. */
export const memoryHeldCheckMs = 15_000;

/** The least time a job's run is given once it is decided to start, or half its hold's life where that is less. */
export const memoryStartMsMin = 30_000;

/** How long before its hold's deadline a job's run is cut, so its runner has given the start up before any count judges the hold past it. */
export const memoryStartCutMs = 5_000;

const memoryUnitBytes = new Map([
  ["B", 1],
  ["kB", 1e3],
  ["KB", 1e3],
  ["MB", 1e6],
  ["GB", 1e9],
  ["TB", 1e12],
  ["KiB", 2 ** 10],
  ["MiB", 2 ** 20],
  ["GiB", 2 ** 30],
  ["TiB", 2 ** 40],
]);

/**
 * The bytes a size the engine printed counts, in either engine's units, or
 * nothing for one it did not print.
 *
 * @param {string} size
 */
export function memorySizeBytes(size) {
  const match = /^(\d+(?:\.\d+)?)([A-Za-z]+)$/u.exec(size);
  const unit = match === null ? undefined : memoryUnitBytes.get(match[2]);
  return unit === undefined ? undefined : Number(match?.[1]) * unit;
}

/**
 * A count that could not be made, and why.
 */
class MemoryUncounted extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "MemoryUncounted";
  }
}

/**
 * @param {MemoryCountPorts} ports
 * @param {readonly string[]} argv
 * @param {string} what what the call asks, as its failure says it
 */
async function memoryAsked(ports, argv, what) {
  const answer = await ports.engine.exec(argv, { signal: ports.signal });
  if (answer.code !== 0)
    throw new MemoryUncounted(
      `${ports.name} could not say ${what}: ${engineFailureLine(answer)}`,
    );
  return answer;
}

/**
 * @param {MemoryCountPorts} ports
 * @param {string} stdout
 * @param {z.ZodType} schema
 * @param {string} what
 */
function memoryRead(ports, stdout, schema, what) {
  let parsed;
  try {
    parsed = schema.safeParse(JSON.parse(stdout));
  } catch {
    parsed = { success: false };
  }
  if (!parsed.success)
    throw new MemoryUncounted(
      `${ports.name} answered ${what} this runner cannot read`,
    );
  return parsed.data;
}

const dockerMemorySchema = z.object({ MemTotal: z.number().int().positive() });

const podmanMemorySchema = z.object({
  host: z.object({ memTotal: z.number().int().positive() }),
});

/** @param {MemoryCountPorts} ports */
async function memoryEngineBytes(ports) {
  const { stdout } = await memoryAsked(
    ports,
    engineInfoArgv(),
    "how much memory it has",
  );
  return ports.name === "docker"
    ? memoryRead(ports, stdout, dockerMemorySchema, "an info").MemTotal
    : memoryRead(ports, stdout, podmanMemorySchema, "an info").host.memTotal;
}

const memoryInspectedSchema = z.array(
  z.object({
    Name: z.string(),
    Config: z.object({
      Labels: z.record(z.string(), z.string()).nullish(),
    }),
    HostConfig: z.object({ Memory: z.number().nullish() }).nullish(),
  }),
);

/**
 * Every running container, by name, with its assignment, its cap, which is 0
 * where it has none, and whether it is a session. One removed since the
 * listing is left out.
 *
 * @param {MemoryCountPorts} ports
 */
async function memoryRunning(ports) {
  const listed = await memoryAsked(ports, runningListArgv(), "what is running");
  const ids = listed.stdout.split("\n").filter((line) => line.trim() !== "");
  if (ids.length === 0) return [];
  const answer = await ports.engine.exec(inspectArgv(ids), {
    signal: ports.signal,
  });
  if (answer.code !== 0 && engineFailure(answer) !== "NoSuchContainer")
    throw new MemoryUncounted(
      `${ports.name} could not inspect what is running: ${engineFailureLine(answer)}`,
    );
  return memoryRead(
    ports,
    answer.stdout,
    memoryInspectedSchema,
    "an inspection",
  ).map((inspected) => ({
    name: inspected.Name.replace(/^\//u, ""),
    assignment: inspected.Config.Labels?.[assignmentLabel],
    capped:
      inspected.Config.Labels?.[poolLabel] !== undefined &&
      (inspected.HostConfig?.Memory ?? 0) > 0,
    memoryBytes: inspected.HostConfig?.Memory ?? 0,
    session: inspected.Config.Labels?.[kindLabel] === "Session",
  }));
}

/**
 * What these running containers use together, as the engine says, or none
 * and why where it refuses to say. An engine that could not be reached, or
 * whose CLI could not run, refuses nothing, and the count fails. One it names
 * no use of has ended since it was listed.
 *
 * @param {MemoryCountPorts} ports
 * @param {ReadonlySet<string>} names
 * @returns {Promise<{usedBytes: number, unmeasured?: string}>}
 */
async function memoryUsedBytes(ports, names) {
  const answer = await ports.engine.exec(memoryStatsArgv(), {
    signal: ports.signal,
  });
  if (answer.code !== 0) {
    const why = `${ports.name} could not say what its containers use: ${engineFailureLine(answer)}`;
    if (engineFailure(answer) === "Unreachable") throw new MemoryUncounted(why);
    return { usedBytes: 0, unmeasured: why };
  }
  let used = 0;
  for (const line of answer.stdout.split("\n")) {
    const match = /^(\S+) (\S+) \/ /u.exec(line.trim());
    if (match === null || !names.has(match[1])) continue;
    const bytes = memorySizeBytes(match[2]);
    if (bytes === undefined)
      throw new MemoryUncounted(
        `${ports.name} printed a use of ${match[1]} this runner cannot read: ${match[2]}`,
      );
    used += bytes;
  }
  return { usedBytes: used };
}

const memoryHeldVolumesSchema = z.array(
  z.object({
    Name: z.string(),
    Labels: z.record(z.string(), z.string()).nullish(),
  }),
);

/**
 * A hold as its volume's labels say it, or nothing where they say none.
 *
 * @param {string} name
 * @param {Readonly<Record<string, string>>} labels
 * @returns {MemoryHold | undefined}
 */
function memoryHoldRead(name, labels) {
  const pool = labels[heldLabel];
  const assignment = labels[assignmentLabel];
  const memoryMib = Number(labels[heldMemoryLabel]);
  const heldMs = Number(labels[heldSinceLabel]);
  const pid = Number(labels[heldProcessLabel]);
  const untilMs = Number(labels[heldUntilLabel]);
  const starting = labels[heldStartingLabel];
  if (
    pool === undefined ||
    assignment === undefined ||
    !Number.isSafeInteger(memoryMib) ||
    memoryMib <= 0 ||
    !Number.isSafeInteger(heldMs) ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(untilMs) ||
    (starting !== "true" && starting !== "false")
  )
    return undefined;
  return {
    name,
    pool,
    assignment,
    memoryMib,
    heldMs,
    pid,
    untilMs,
    starting: starting === "true",
  };
}

/**
 * Every hold on the engine, those abandoned apart: whose process is not
 * running, or whose deadline has passed.
 *
 * @param {MemoryCountPorts} ports
 */
async function memoryHoldsListed(ports) {
  const listed = await memoryAsked(ports, heldListArgv(), "what it holds");
  const names = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (names.length === 0) return { holds: [], abandoned: [] };
  const answer = await ports.engine.exec(volumeInspectArgv(names), {
    signal: ports.signal,
  });
  if (answer.code !== 0 && engineFailure(answer) !== "NoSuchVolume")
    throw new MemoryUncounted(
      `${ports.name} could not inspect what it holds: ${engineFailureLine(answer)}`,
    );
  /** @type {MemoryHold[]} */
  const holds = [];
  /** @type {string[]} */
  const abandoned = [];
  for (const volume of memoryRead(
    ports,
    answer.stdout,
    memoryHeldVolumesSchema,
    "an inspection of what it holds",
  )) {
    const hold = memoryHoldRead(volume.Name, volume.Labels ?? {});
    if (hold === undefined) continue;
    if (ports.holderAlive(hold.pid) && hold.untilMs > ports.nowMs())
      holds.push(hold);
    else abandoned.push(hold.name);
  }
  return { holds, abandoned };
}

/**
 * The engine's memory as this module counts it, and the holds it found
 * abandoned, which it does not count; or why it could not be counted.
 *
 * @param {MemoryCountPorts} ports
 * @returns {Promise<{counted: MemoryCounted, abandoned: readonly string[]}>}
 */
export async function memoryCounted(ports) {
  try {
    const engineBytes = await memoryEngineBytes(ports);
    const { holds, abandoned } = await memoryHoldsListed(ports);
    const running = await memoryRunning(ports);
    const capped = running.filter((container) => container.capped);
    /** @param {readonly {memoryBytes: number}[]} containers */
    const capsOf = (containers) =>
      containers.reduce((sum, { memoryBytes }) => sum + memoryBytes, 0);
    const started = capped.flatMap(({ assignment }) =>
      assignment === undefined ? [] : [assignment],
    );
    const measured = new Set(
      running.filter(({ capped }) => !capped).map(({ name }) => name),
    );
    const used =
      measured.size === 0
        ? { usedBytes: 0 }
        : await memoryUsedBytes(ports, measured);
    return {
      counted: {
        engineBytes,
        cappedBytes: capsOf(capped),
        sessionBytes: capsOf(capped.filter(({ session }) => session)),
        ...used,
        holds: holds.filter(({ assignment }) => !started.includes(assignment)),
        started,
      },
      abandoned,
    };
  } catch (failure) {
    if (failure instanceof MemoryUncounted)
      return { counted: { unknown: failure.message }, abandoned: [] };
    if (failure instanceof Error && failure.name === "AbortError")
      return {
        counted: { unknown: `${ports.name} did not answer in time` },
        abandoned: [],
      };
    throw failure;
  }
}

/**
 * Removes holds, answering each that could not be removed with why. One
 * already gone is no failure.
 *
 * @param {Pick<MemoryCountPorts, "engine" | "signal">} ports
 * @param {readonly string[]} names
 * @returns {Promise<{name: string, why: string}[]>}
 */
export async function memoryHoldsRemoved(ports, names) {
  const failed = [];
  for (const name of names) {
    const removed = await ports.engine.exec(volumeRemoveArgv(name), {
      signal: ports.signal,
    });
    if (removed.code !== 0 && engineFailure(removed) !== "NoSuchVolume")
      failed.push({ name, why: engineFailureLine(removed) });
  }
  return failed;
}

/**
 * What the engine's containers may take together.
 *
 * @param {number} bytesFree
 * @param {MemoryCount} count
 */
export function memoryBudgetBytes(bytesFree, count) {
  return count.engineBytes - bytesFree;
}

/**
 * The room a count leaves, one hold not counted where `except` names it.
 *
 * @param {number} bytesFree
 * @param {MemoryCount} count
 * @param {string} [except] a hold's name
 */
export function memoryRoomBytes(bytesFree, count, except) {
  const held = count.holds
    .filter(({ name }) => name !== except)
    .reduce((sum, { memoryMib }) => sum + memoryMib * mibBytes, 0);
  return (
    memoryBudgetBytes(bytesFree, count) -
    count.cappedBytes -
    count.usedBytes -
    held
  );
}

/**
 * Whether a job is claimed: only where the count is known, no job on the
 * engine is held for room, and the room left once `placingBytes` is taken is
 * at least `memoryRoomMibMin`.
 *
 * @param {number} bytesFree
 * @param {MemoryCounted} counted
 * @param {number} placingBytes the caps of what the runner is placing and has made no hold for
 */
export function memoryJobsTaken(bytesFree, counted, placingBytes) {
  if ("unknown" in counted) return false;
  return (
    !counted.holds.some(({ starting }) => !starting) &&
    memoryRoomBytes(bytesFree, counted) - placingBytes >=
      memoryRoomMibMin * mibBytes
  );
}

/** @param {number} bytes */
const memoryMibOf = (bytes) => Math.max(0, Math.floor(bytes / mibBytes));

/**
 * The room and the ceiling the last count found, in whole MiB and never under
 * none: the room less what the runner was placing with no hold yet, and the
 * budget less what it reserves. Before a count, or where it failed, there is
 * no room and no ceiling is known.
 *
 * @param {MemoryBudget} budget
 * @returns {MemoryRoom}
 */
export function memoryRoom(budget) {
  const { counted } = budget;
  if (counted === undefined || "unknown" in counted) return { roomMib: 0 };
  return {
    roomMib: memoryMibOf(
      memoryRoomBytes(budget.bytesFree, counted) - budget.placingBytes,
    ),
    ceilingMib: memoryMibOf(
      memoryBudgetBytes(budget.bytesFree, counted) - budget.bytesReserved,
    ),
  };
}

/**
 * Whether the runner asks for jobs, as the last count found: from a plane that
 * claims by room wherever that count was made, and from one that does not
 * where it takes jobs.
 *
 * @param {MemoryBudget} budget
 * @param {boolean} byRoom whether the plane claims by room
 */
export function memoryBudgetTakes(budget, byRoom) {
  if (!byRoom) return budget.jobsTaken;
  return budget.counted !== undefined && !("unknown" in budget.counted);
}

/**
 * Whether a held hold is older than another, by when each was first held and
 * then by name, so every runner orders the same holds the same way.
 *
 * @param {Pick<MemoryHold, "name" | "heldMs">} hold
 * @param {Pick<MemoryHold, "name" | "heldMs">} other
 */
function memoryHoldOlder(hold, other) {
  return (
    hold.heldMs < other.heldMs ||
    (hold.heldMs === other.heldMs && hold.name < other.name)
  );
}

/**
 * Whether a job starts into the room a count leaves it. One whose container
 * is already running, and so counted, is running, and starts nothing. One
 * whose run could not be given `memoryStartMsMin`, or half its hold's life
 * where that is less, before its hold's deadline less `memoryStartCutMs` is too
 * late. Otherwise it starts where no job held for room is older than it and
 * it fits the room its own hold leaves, and is held where not, why saying what
 * it waits for.
 *
 * @param {number} bytesFree
 * @param {MemoryCounted} counted
 * @param {Pick<MemoryHold, "name" | "assignment" | "memoryMib" | "heldMs" | "untilMs">} job
 * @param {number} nowMs
 * @returns {MemoryDecision}
 */
export function memoryStartDecided(bytesFree, counted, job, nowMs) {
  if (!("unknown" in counted) && counted.started.includes(job.assignment))
    return { decided: "Running" };
  const leastMs = Math.min(memoryStartMsMin, (job.untilMs - job.heldMs) / 2);
  if (job.untilMs - memoryStartCutMs - nowMs < leastMs)
    return { decided: "Late" };
  if ("unknown" in counted)
    return {
      decided: "Hold",
      why: `the engine's memory could not be counted: ${counted.unknown}`,
    };
  const [oldest] = counted.holds
    .filter(
      (hold) =>
        !hold.starting && hold.name !== job.name && memoryHoldOlder(hold, job),
    )
    .toSorted((a, b) => (memoryHoldOlder(a, b) ? -1 : 1));
  if (oldest !== undefined)
    return { decided: "Hold", why: `behind ${oldest.name}, held before it` };
  const room = memoryRoomBytes(bytesFree, counted, job.name);
  if (job.memoryMib * mibBytes <= room) return { decided: "Start" };
  return {
    decided: "Hold",
    why: `needs ${diskGib(job.memoryMib * mibBytes)} GiB, room ${diskGib(Math.max(0, room))} GiB`,
  };
}

/**
 * A budget keeping `bytesFree` free under the lock at `lockFile`, or none
 * where either is absent, reserving `bytesReserved` of it from jobs and
 * claiming by room under the lock at `claimLockFile` where there is one.
 *
 * @param {number | undefined} bytesFree
 * @param {string | undefined} lockFile
 * @param {{bytesReserved?: number, claimLockFile?: string}} [claims]
 * @returns {MemoryBudget | undefined}
 */
export function memoryBudget(bytesFree, lockFile, claims = {}) {
  if (bytesFree === undefined || lockFile === undefined) return undefined;
  return {
    bytesFree,
    bytesReserved: claims.bytesReserved ?? 0,
    lockFile,
    claimLockFile: claims.claimLockFile,
    counted: undefined,
    placingBytes: 0,
    jobsTaken: true,
    said: "Taking",
    saidUnmeasured: false,
  };
}

/**
 * Whether a count takes jobs, and why not: it is unknown, a job on the engine
 * is held for room, or the room left once `placingBytes` is taken is short.
 *
 * @param {number} bytesFree
 * @param {MemoryCounted} counted
 * @param {number} placingBytes the caps of what the runner is placing and has made no hold for
 * @returns {MemoryBudgetState}
 */
export function memoryBudgetState(bytesFree, counted, placingBytes) {
  if ("unknown" in counted) return "Unknown";
  if (counted.holds.some(({ starting }) => !starting)) return "Held";
  return memoryJobsTaken(bytesFree, counted, placingBytes) ? "Taking" : "Full";
}

/**
 * Whether the use of what no runner capped was counted, logged where it
 * differs from what was last logged. A count that failed says nothing of it.
 *
 * @param {MemoryBudget} budget
 * @param {MemoryCounted} counted
 * @param {(line: string) => void} log
 */
function memoryBudgetSaidUse(budget, counted, log) {
  if ("unknown" in counted) return;
  const unmeasured = counted.unmeasured !== undefined;
  if (unmeasured === budget.saidUnmeasured) return;
  budget.saidUnmeasured = unmeasured;
  log(
    unmeasured
      ? `this engine's containers no runner capped are counted as using no memory, since ${String(counted.unmeasured)}`
      : "this engine's containers no runner capped are counted at what they use again",
  );
}

/**
 * What a pass found, logged where it differs from what was last logged.
 *
 * @param {MemoryBudget} budget
 * @param {MemoryCounted} counted
 * @param {MemoryBudgetState} now
 * @param {(line: string) => void} log
 */
function memoryBudgetSaid(budget, counted, now, log) {
  memoryBudgetSaidUse(budget, counted, log);
  if (now === budget.said) return;
  budget.said = now;
  if ("unknown" in counted) {
    log(
      `this engine's memory could not be counted, so this runner takes no job: ${counted.unknown}`,
    );
    return;
  }
  const room = `this engine has ${diskGib(Math.max(0, memoryRoomBytes(budget.bytesFree, counted)))} GiB of room in its ${diskGib(memoryBudgetBytes(budget.bytesFree, counted))} GiB memory budget`;
  if (now === "Held")
    log(
      `${room}, and a job on it is held for room: this runner takes no job until it starts`,
    );
  else if (now === "Full")
    log(
      `${room}, under the ${diskGib(memoryRoomMibMin * mibBytes)} GiB a job needs: this runner takes no job until it has more`,
    );
  else log(`${room}: this runner takes jobs again`);
}

/**
 * Takes a pass's count: whether jobs are taken is what it found, with
 * `placingBytes` taken from its room, and a change is logged.
 *
 * @param {MemoryBudget} budget
 * @param {MemoryCounted} counted
 * @param {number} placingBytes the caps of what the runner is placing and has made no hold for
 * @param {(line: string) => void} log
 */
export function memoryBudgetHeld(budget, counted, placingBytes, log) {
  const now = memoryBudgetState(budget.bytesFree, counted, placingBytes);
  budget.counted = counted;
  budget.placingBytes = placingBytes;
  budget.jobsTaken = now === "Taking";
  memoryBudgetSaid(budget, counted, now, log);
}

/** @type {import("./fileLock.mjs").FileLockPorts} */
const memoryLockPorts = {
  pid: process.pid,
  nowMs: Date.now,
  wait,
  holderAlive: fileLockHolderAlive,
};

/**
 * The claim lock at `lockFile`, whose directory is made where it is not
 * there, taken without waiting: what lets it go, or nothing where another
 * runner holds it.
 *
 * @param {string} lockFile
 * @param {Partial<import("./fileLock.mjs").FileLockPorts>} [ports]
 */
export async function memoryClaimTaken(lockFile, ports = {}) {
  await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
  return fileLockTaken(
    lockFile,
    { heldMsMax: memoryClaimHeldMsMax },
    { ...memoryLockPorts, ...ports },
  );
}

/**
 * `hold` run under the memory lock at `lockFile`, whose directory is made
 * where it is not there.
 *
 * @template T
 * @param {string} lockFile
 * @param {() => Promise<T>} hold
 * @param {Partial<import("./fileLock.mjs").FileLockPorts>} [ports]
 * @returns {Promise<T>}
 */
export async function memoryLocked(lockFile, hold, ports = {}) {
  await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
  return fileLocked(
    lockFile,
    {
      waitMsMax: memoryLockWaitMsMax,
      heldMsMax: memoryLockHeldMsMax,
      pollMs: 100,
      busy: `another runner has held the memory lock at ${lockFile} for longer than a start waits`,
    },
    { ...memoryLockPorts, ...ports },
    hold,
  );
}
