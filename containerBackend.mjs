/**
 * `WorkerPoolBackend` over a container engine on this machine: a container
 * per assignment, run from the image the assignment pins, whose entrypoint is
 * the worker core. chuggy's Kubernetes pool backend is the behaviour this
 * mirrors, with a container where it has a pod.
 *
 * A SESSION IS RUN AS A JOB IS. Its container is a job's but for the kind it
 * is labelled with, which `held` and `ended` read back, and its deadline,
 * which is its assignment's own: a session ends of itself once idle, and the
 * runner's cap is a job's. A container with no kind label is a job's: a
 * runner that ran nothing else started it.
 *
 * PLACEMENT IS ASYNCHRONOUS. The plane renews a lease only while a poll names
 * it held, and a cold pull can outlast a lease, so `place` decides only
 * whether this machine can take the work; the pull and the run happen behind
 * it, and `held` answers for them meanwhile. One that fails leaves `held` and
 * is logged.
 *
 * WHAT IS RUNNING IS READ FROM THE ENGINE. `held` lists this pool's containers
 * by label and reads each one's assignment, kind and deadline off its labels,
 * so a restarted runner picks up what its predecessor started. A container that
 * has ended, or has run past its deadline, has its logs saved and is removed
 * rather than answered. A listing that failed throws, because the emptier
 * answer is the one that loses work.
 *
 * WHAT ENDED OF ITSELF IS NAMED ONCE. `ended` names the attempt of each
 * container `held` found ended or killed at its deadline, and of each
 * placement that failed and left no container: a job's with this backend's own
 * reason, never the job's log, which can hold a secret, and a session's with
 * its phase, `Succeeded` only for a container that exited 0. A failed
 * placement's attempt is the one it held; a container's is read back from the
 * envelope it was run with. One this pool stopped is never named.
 */

import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  assignmentLabel,
  deadlineLabel,
  imageInspectArgv,
  inspectArgv,
  killArgv,
  kindLabel,
  listArgv,
  logsArgv,
  pullArgv,
  removeArgv,
  runArgv,
} from "./engineArgv.mjs";
import { engineFailure, engineFailureLine } from "./engineErrors.mjs";
import {
  jobEnvelope,
  jobEnvironmentAttempt,
  jobEnvironmentFile,
} from "./job.mjs";
import {
  poolIdentityDigest,
  poolIdentityPersonal,
  poolLabelValue,
} from "./poolIdentity.mjs";
import { imageRegistryHost, withRegistryAuth } from "./registryAuth.mjs";
import { runtimeScratch } from "./runtimeScratch.mjs";

/**
 * @typedef {import("@chuggy/worker-contract/workerPool").WorkerPoolAssignment} WorkerPoolAssignment
 * @typedef {import("./poolLoop.mjs").WorkerPoolAttempt} WorkerPoolAttempt
 * @typedef {import("./poolLoop.mjs").WorkerPoolBackend} WorkerPoolBackend
 * @typedef {import("./poolLoop.mjs").WorkerPoolEnded} WorkerPoolEnded
 * @typedef {import("./poolLoop.mjs").WorkerPoolHeld} WorkerPoolHeld
 * @typedef {import("./poolLoop.mjs").WorkerPoolStopped} WorkerPoolStopped
 * @typedef {import("./poolLoop.mjs").WorkerPoolWorkloadKind} WorkerPoolWorkloadKind
 * @typedef {import("./poolLoop.mjs").WorkerPoolTokens} WorkerPoolTokens
 * @typedef {import("./engine.mjs").Engine} Engine
 * @typedef {import("./engine.mjs").EngineAnswer} EngineAnswer
 * @typedef {import("./poolIdentity.mjs").PoolIdentity} PoolIdentity
 *
 * @typedef {object} ContainerBackendSettings
 * @property {"docker" | "podman"} engine
 * @property {PoolIdentity} pool
 * @property {string} tokenFile
 * @property {string | undefined} registryHost the one registry the pool's token is presented to
 * @property {string | undefined} dockerHost the endpoint docker's context names; docker's alone
 * @property {number} timeoutSecsMax
 * @property {number} outputBytesMax
 * @property {Readonly<Record<string, string>>} environment
 * @property {string} network
 * @property {string} runtimeDir
 * @property {string} logDir
 * @property {{cpuMillis: number, memoryMib: number}} machine
 * @property {number} pullRetryMs the wait before a pull the registry refused is tried again
 *
 * @typedef {object} ContainerBackendSeams
 * @property {Engine} engine
 * @property {WorkerPoolTokens} tokens the pool's own, which the loop shares
 * @property {(tokenFile: string) => Promise<string | undefined>} tokenFileRefusal why this machine cannot hand a job the Claude token file the backend mounts, or nothing: the runner's to judge, since whether a job can read it turns on how its engine maps users
 * @property {() => number} nowMs
 * @property {(ms: number, signal: AbortSignal) => Promise<void>} sleep
 * @property {(line: string) => void} log
 *
 * @typedef {object} InFlightPlacement
 * @property {string} assignment
 * @property {WorkerPoolWorkloadKind} kind
 * @property {string} name
 * @property {string} image
 * @property {"Placing" | "Pulling" | "Starting"} phase
 * @property {number} deadlineEpochSecs
 *
 * @typedef {InFlightPlacement & {controller: AbortController, done: Promise<void>}} Placement
 *
 * @typedef {object} PoolContainer
 * @property {string} id
 * @property {string} name
 * @property {string | undefined} assignment
 * @property {WorkerPoolWorkloadKind} kind
 * @property {string} status
 * @property {number | undefined} exitCode
 * @property {number | undefined} deadlineEpochSecs
 *
 * @typedef {WorkerPoolBackend & {
 *   inFlight: () => InFlightPlacement[],
 *   containers: () => Promise<PoolContainer[]>,
 *   settled: () => Promise<void>,
 * }} ContainerBackend
 *
 * @typedef {object} Ends what `ended` names next, and what it never will
 * @property {WorkerPoolEnded[]} pending failed placements' ends, which the next `held` makes ready unless it lists their containers
 * @property {WorkerPoolEnded[]} ready
 * @property {Set<string>} accounted assignments stopped or named, kept while `held` still finds them
 *
 * @typedef {object} ContainerEnd how a workload's container ended
 * @property {string} why in this backend's words, which a job's end carries
 * @property {boolean} succeeded whether it exited 0, which a session's end carries
 *
 * @typedef {{settings: ContainerBackendSettings, seams: ContainerBackendSeams, placements: Map<string, Placement>, ends: Ends}} State
 *
 * @typedef {z.infer<typeof inspectedSchema>[number]} InspectedContainer
 */

/** The states a container does no more work in; podman adds two docker lacks. */
const endedStatuses = new Set([
  "created",
  "exited",
  "dead",
  "stopped",
  "configured",
]);

/** The ended states a container ran to an exit status in. */
const exitedStatuses = new Set(["exited", "stopped"]);

const inspectedSchema = z.array(
  z.object({
    Id: z.string(),
    Name: z.string(),
    Config: z.object({
      Labels: z.record(z.string(), z.string()).nullish(),
      Env: z.array(z.string()).nullish(),
    }),
    State: z.object({ Status: z.string(), ExitCode: z.number().optional() }),
  }),
);

/**
 * The one container an assignment runs as, named so a repeated placement
 * names it again. The digest is of the pool's identity with the assignment,
 * since an assignment is named uniquely only within its pool.
 *
 * @param {PoolIdentity} pool
 * @param {string} assignment
 */
export function containerName(pool, assignment) {
  return `chuggy-${containerNameSegment(pool)}-${poolIdentityDigest(pool, assignment)}`;
}

/**
 * What a container's name carries of the runner it serves: a pool's name, or
 * `personal` for a personal runner, whose owner's principal names no container.
 *
 * @param {PoolIdentity} pool
 */
function containerNameSegment(pool) {
  return poolIdentityPersonal(pool) ? "personal" : pool.pool;
}

/** @param {ContainerBackendSettings} settings */
export function checkedContainerBackendSettings(settings) {
  const segment = containerNameSegment(settings.pool);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(segment))
    throw new RangeError(
      `pool ${segment} cannot name a container; register it under a name of letters, digits, '_', '.' and '-'`,
    );
  return settings;
}

/**
 * @param {InspectedContainer} inspected
 * @returns {PoolContainer}
 */
function poolContainer(inspected) {
  const labels = inspected.Config.Labels ?? {};
  const deadline = Number(labels[deadlineLabel]);
  return {
    id: inspected.Id,
    name: inspected.Name.replace(/^\//u, ""),
    assignment: labels[assignmentLabel],
    kind: labels[kindLabel] === "Session" ? "Session" : "Job",
    status: inspected.State.Status,
    exitCode: inspected.State.ExitCode,
    deadlineEpochSecs: Number.isSafeInteger(deadline) ? deadline : undefined,
  };
}

/**
 * The containers an inspection answered for, as the engine described them:
 * their variables included, which carry the envelope and its bearer.
 *
 * @param {State} state
 * @param {EngineAnswer} answer
 * @returns {InspectedContainer[]}
 */
function inspectionContainers(state, answer) {
  try {
    return inspectedSchema.parse(JSON.parse(answer.stdout));
  } catch {
    throw new Error(
      `${state.settings.engine} answered an inspection this runner cannot read`,
    );
  }
}

/**
 * Inspected containers, which the engine answers for even where one of them
 * was removed between the listing and the inspection.
 *
 * @param {State} state
 * @param {readonly string[]} containers
 * @returns {Promise<InspectedContainer[]>}
 */
async function inspectedContainers(state, containers) {
  const answer = await state.seams.engine.exec(inspectArgv(containers));
  if (answer.code !== 0 && engineFailure(answer) !== "NoSuchContainer")
    throw new Error(
      `${state.settings.engine} could not inspect this pool's containers: ${engineFailureLine(answer)}`,
    );
  return inspectionContainers(state, answer);
}

/**
 * The containers a listing answered, by id.
 *
 * @param {EngineAnswer} listed
 */
function listedIds(listed) {
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * @param {State} state
 * @returns {Promise<InspectedContainer[]>}
 */
async function poolContainers(state) {
  const listed = await state.seams.engine.exec(
    listArgv(poolLabelValue(state.settings.pool)),
  );
  if (listed.code !== 0)
    throw new Error(
      `${state.settings.engine} could not list this pool's containers: ${engineFailureLine(listed)}`,
    );
  const ids = listedIds(listed);
  return ids.length === 0 ? [] : inspectedContainers(state, ids);
}

/**
 * A container's logs into a file only its owner can read, since what a
 * workload printed before its core began scrubbing can hold a secret.
 *
 * @param {State} state
 * @param {PoolContainer} container
 */
async function savedLogs(state, container) {
  await mkdir(state.settings.logDir, { recursive: true, mode: 0o700 });
  const file = join(state.settings.logDir, `${container.name}.log`);
  const handle = await open(file, "w", 0o600);
  try {
    await handle.chmod(0o600);
    const answer = await state.seams.engine.execToFd(
      logsArgv(container.id),
      handle.fd,
    );
    return answer.code === 0 ? file : undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Saves a container's logs and removes it. A container whose logs could not
 * be saved is left for the next pass to try again, rather than lost with them.
 *
 * @param {State} state
 * @param {PoolContainer} container
 * @param {string} why
 */
async function retired(state, container, why) {
  const file = await savedLogs(state, container);
  if (file === undefined) {
    state.seams.log(`${container.name} ${why}; its logs could not be saved`);
    return;
  }
  const removed = await state.seams.engine.exec(removeArgv(container.id));
  state.seams.log(
    removed.code === 0
      ? `${container.name} ${why}; logs saved to ${file}, container removed`
      : `${container.name} ${why}; logs saved to ${file}, not removed: ${engineFailureLine(removed)}`,
  );
}

/**
 * Accounts for the end of an assignment, answering whether it was not already:
 * one this pool stopped, or whose end it has named, is not named again.
 *
 * @param {State} state
 * @param {string} assignment
 */
function endAccounted(state, assignment) {
  if (state.ends.accounted.has(assignment)) return false;
  state.ends.accounted.add(assignment);
  return true;
}

/**
 * How a container that ended of itself ended: by an exit status where it ran
 * to one, and otherwise by the state it was left in.
 *
 * @param {PoolContainer} container
 * @returns {ContainerEnd}
 */
function containerEnded(container) {
  const exited =
    exitedStatuses.has(container.status) && container.exitCode !== undefined;
  return {
    why: exited
      ? `its container exited with status ${String(container.exitCode)}`
      : `its container was left ${container.status}`,
    succeeded: exited && container.exitCode === 0,
  };
}

/** How a container `held` killed at its deadline ended. */
const deadlineEnd = {
  why: "its container passed its deadline and was killed",
  succeeded: false,
};

/**
 * An end as the loop is told it, by the kind the workload was placed as.
 *
 * @param {WorkerPoolWorkloadKind} kind
 * @param {WorkerPoolAttempt} attempt
 * @param {ContainerEnd} end
 * @returns {WorkerPoolEnded}
 */
function workloadEnd(kind, attempt, end) {
  return kind === "Session"
    ? { kind, session: attempt, phase: end.succeeded ? "Succeeded" : "Failed" }
    : { kind, job: attempt, why: end.why };
}

/**
 * The assignment an end is of, whichever kind it is.
 *
 * @param {WorkerPoolEnded} ended
 */
function endedAssignment(ended) {
  return ended.kind === "Session"
    ? ended.session.assignment
    : ended.job.assignment;
}

/**
 * Names the end of a listed container's workload, its attempt read back from
 * the envelope it was run with. One whose envelope cannot be read is left to
 * its lease.
 *
 * @param {State} state
 * @param {InspectedContainer} inspected
 * @param {PoolContainer & {assignment: string}} container
 * @param {ContainerEnd} end
 */
function containerEndNamed(state, inspected, container, end) {
  if (!endAccounted(state, container.assignment)) return;
  const attempt = jobEnvironmentAttempt(inspected.Config.Env ?? []);
  if (attempt === undefined) {
    state.seams.log(
      `${container.name}: its envelope could not be read, so its attempt is left to its lease`,
    );
    return;
  }
  state.ends.ready.push(
    workloadEnd(
      container.kind,
      { assignment: container.assignment, ...attempt },
      end,
    ),
  );
}

/**
 * Whether a listed container is held. One that has ended, or that a kill at
 * its deadline ends, is retired instead, and its end named.
 *
 * @param {State} state
 * @param {InspectedContainer} inspected
 * @param {PoolContainer & {assignment: string}} container
 * @param {number} nowSecs
 */
async function listedHeld(state, inspected, container, nowSecs) {
  if (endedStatuses.has(container.status)) {
    await retired(state, container, "ended");
    containerEndNamed(state, inspected, container, containerEnded(container));
    return false;
  }
  if (container.status === "removing") return false;
  if (
    container.deadlineEpochSecs !== undefined &&
    nowSecs < container.deadlineEpochSecs
  )
    return true;
  const killed = await state.seams.engine.exec(killArgv(container.id));
  if (killed.code !== 0)
    state.seams.log(
      `${container.name} passed its deadline and was not killed: ${engineFailureLine(killed)}`,
    );
  await retired(state, container, "passed its deadline");
  if (killed.code === 0)
    containerEndNamed(state, inspected, container, deadlineEnd);
  return false;
}

/**
 * What this pool holds, each with the kind it was placed as: every placement
 * still pulling or starting, and every container still running inside its
 * deadline. The placements are read before the listing, so one that finishes
 * between the two is listed as a container.
 *
 * The ends of placements that failed before that read are made ready only
 * where the listing finds no container of theirs and no stop came meanwhile:
 * a `run` that failed can still have started one, and a listed container
 * answers for its own attempt.
 *
 * @param {State} state
 * @returns {Promise<WorkerPoolHeld[]>}
 */
async function heldAssignments(state) {
  /** @type {Map<string, WorkerPoolWorkloadKind>} */
  const held = new Map(
    [...state.placements.values()].map(({ assignment, kind }) => [
      assignment,
      kind,
    ]),
  );
  const placing = new Set(held.keys());
  const failed = state.ends.pending.splice(0);
  for (const ended of failed)
    state.ends.accounted.delete(endedAssignment(ended));
  const listed = new Set(placing);
  const nowSecs = Math.floor(state.seams.nowMs() / 1000);
  for (const inspected of await poolContainers(state)) {
    const container = poolContainer(inspected);
    const { assignment } = container;
    if (assignment === undefined || placing.has(assignment)) continue;
    listed.add(assignment);
    if (
      await listedHeld(state, inspected, { ...container, assignment }, nowSecs)
    )
      held.set(assignment, container.kind);
  }
  for (const ended of failed) {
    const assignment = endedAssignment(ended);
    if (!listed.has(assignment) && !state.ends.accounted.has(assignment))
      state.ends.ready.push(ended);
  }
  for (const assignment of state.ends.accounted)
    if (!listed.has(assignment)) state.ends.accounted.delete(assignment);
  return [...held].map(([assignment, kind]) => ({ assignment, kind }));
}

/**
 * Why this machine will not take an assignment, or nothing.
 *
 * @param {State} state
 * @param {WorkerPoolAssignment} assignment
 * @returns {Promise<string | undefined>}
 */
async function placementRefusal(state, assignment) {
  const { machine } = state.settings;
  if (assignment.image === undefined)
    return "the assignment pins no image, and this pool runs only an image its assignment pins";
  if (assignment.cpuMillis > machine.cpuMillis)
    return `the assignment asks for ${String(assignment.cpuMillis)} CPU millis and this machine has ${String(machine.cpuMillis)}`;
  if (assignment.memoryMib > machine.memoryMib)
    return `the assignment asks for ${String(assignment.memoryMib)} MiB and this machine has ${String(machine.memoryMib)}`;
  return state.seams.tokenFileRefusal(state.settings.tokenFile);
}

/**
 * @param {State} state
 * @param {string} image
 */
async function imagePresent(state, image) {
  const answer = await state.seams.engine.exec(imageInspectArgv(image));
  if (answer.code === 0) return true;
  if (engineFailure(answer) === "NotFound") return false;
  throw new Error(
    `its image could not be inspected: ${engineFailureLine(answer)}`,
  );
}

/**
 * One pull, under the credential given or under none.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {import("./registryAuth.mjs").RegistryCredential | undefined} credential
 * @param {AbortSignal} signal
 */
function pullAttempt(state, placement, credential, signal) {
  const { settings, seams } = state;
  return withRegistryAuth(
    settings.runtimeDir,
    settings.engine,
    credential,
    (directory) => {
      const pull = pullArgv(
        settings.engine,
        placement.image,
        directory,
        settings.dockerHost,
      );
      return seams.engine.exec(pull.argv, {
        environment: pull.environment,
        signal,
      });
    },
  );
}

/**
 * What a pull runs under: a signal a stop or the assignment's deadline aborts.
 *
 * @param {State} state
 * @param {Placement} placement
 */
function pullSignal(state, placement) {
  const remainingMs = placement.deadlineEpochSecs * 1000 - state.seams.nowMs();
  if (remainingMs <= 0)
    throw new Error("its image was not pulled by the assignment's deadline");
  return globalThis.AbortSignal.any([
    placement.controller.signal,
    globalThis.AbortSignal.timeout(remainingMs),
  ]);
}

/**
 * An image of the pool's own registry is pulled under the pool's token until
 * it is here, the registry refuses it for a reason a new token will not
 * change, or the deadline passes; a refused token is discarded so the next
 * attempt is made under a fresh one. Any other image is pulled once, under no
 * credential, and a refusal there says nothing about the pool's token.
 *
 * @param {State} state
 * @param {Placement} placement
 */
async function pulled(state, placement) {
  const { settings, seams } = state;
  const host = imageRegistryHost(placement.image);
  if (host !== settings.registryHost) {
    const signal = pullSignal(state, placement);
    const answer = await pullAttempt(state, placement, undefined, signal);
    if (answer.code === 0) return;
    throw new Error(
      `its image could not be pulled under no credential, as every image not of the pool's registry is: ${engineFailureLine(answer)}`,
    );
  }
  for (;;) {
    const signal = pullSignal(state, placement);
    const acquired = await seams.tokens.acquire();
    if (acquired.acquired === "Denied")
      throw new Error(
        `the pool has no token to pull with: ${acquired.evidence}`,
      );
    if (acquired.acquired === "Token") {
      const credential = { host, token: acquired.token };
      const answer = await pullAttempt(state, placement, credential, signal);
      if (answer.code === 0) return;
      if (engineFailure(answer) !== "Unauthorized")
        throw new Error(
          `its image could not be pulled: ${engineFailureLine(answer)}`,
        );
      seams.tokens.invalidate(acquired.token);
      seams.log(
        `${placement.name}: the registry refused the pool's token; pulling again under a fresh one`,
      );
    } else
      seams.log(
        `${placement.name}: no token to pull with yet: ${acquired.evidence}`,
      );
    await seams.sleep(settings.pullRetryMs, signal);
  }
}

/**
 * Which assignment an existing container of this name carries.
 *
 * @param {State} state
 * @param {string} name
 */
async function containerAssignment(state, name) {
  const [inspected] = await inspectedContainers(state, [name]);
  return inspected === undefined
    ? undefined
    : poolContainer(inspected).assignment;
}

/**
 * Runs the container, the envelope reaching it through an env file only its
 * owner can read, which is removed once `run` has answered. A container of
 * this name already carrying this assignment is a repeated placement.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {WorkerPoolAssignment} assignment
 * @param {string} envelope
 * @returns {Promise<"started" | "was already running">} what the log says of it
 */
async function started(state, placement, assignment, envelope) {
  const { settings, seams } = state;
  await mkdir(settings.runtimeDir, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(
    join(settings.runtimeDir, runtimeScratch("job")),
  );
  let answer;
  try {
    const envFile = join(directory, "env");
    await writeFile(
      envFile,
      jobEnvironmentFile(envelope, settings.environment),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    answer = await seams.engine.exec(
      runArgv(settings.engine, {
        name: placement.name,
        pool: poolLabelValue(settings.pool),
        assignment: placement.assignment,
        kind: placement.kind,
        deadlineEpochSecs: placement.deadlineEpochSecs,
        envFile,
        cpuMillis: assignment.cpuMillis,
        memoryMib: assignment.memoryMib,
        tokenFile: settings.tokenFile,
        network: settings.network,
        image: placement.image,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  if (answer.code === 0) return "started";
  if (
    engineFailure(answer) === "NameConflict" &&
    (await containerAssignment(state, placement.name)) === placement.assignment
  )
    return "was already running";
  throw new Error(
    `its container could not be run: ${engineFailureLine(answer)}`,
  );
}

/**
 * @param {State} state
 * @param {Placement} placement
 * @param {WorkerPoolAssignment} assignment
 * @param {string} envelope
 */
async function placementRun(state, placement, assignment, envelope) {
  if (!(await imagePresent(state, placement.image))) {
    placement.phase = "Pulling";
    await pulled(state, placement);
  }
  placement.controller.signal.throwIfAborted();
  placement.phase = "Starting";
  const outcome = await started(state, placement, assignment, envelope);
  state.seams.log(`${placement.name} ${outcome}`);
}

/**
 * What became of a placement that never started. Its signal aborts on a stop
 * or at the deadline, and only a stop aborts its controller.
 *
 * @param {Placement} placement
 * @param {unknown} failure
 */
function placementFailure(placement, failure) {
  if (placement.controller.signal.aborted)
    return "was stopped before it started";
  if (failure instanceof Error && failure.name === "AbortError")
    return "was not started: its image was not pulled by the assignment's deadline";
  return `was not started: ${failure instanceof Error ? failure.message : String(failure)}`;
}

/**
 * The bounds a workload's envelope carries. A session's time is its
 * assignment's own, since the runner's cap is a job's.
 *
 * @param {ContainerBackendSettings} settings
 * @param {WorkerPoolAssignment} assignment
 * @param {WorkerPoolWorkloadKind} kind
 * @returns {import("./job.mjs").JobBounds}
 */
function workloadBounds(settings, assignment, kind) {
  return {
    timeoutSecsMax:
      kind === "Session" ? assignment.deadlineSecs : settings.timeoutSecsMax,
    outputBytesMax: settings.outputBytesMax,
  };
}

/**
 * @param {State} state
 * @param {WorkerPoolAssignment} assignment
 * @param {WorkerPoolWorkloadKind} kind
 */
async function placed(state, assignment, kind) {
  const { settings, seams } = state;
  if (kind !== "Job" && kind !== "Session")
    throw new TypeError(
      `an assignment was placed as ${String(kind)}, which is no workload's kind`,
    );
  if (state.placements.has(assignment.assignment)) return { placed: "Placed" };
  const refusal = await placementRefusal(state, assignment);
  if (refusal !== undefined) return { placed: "Refused", evidence: refusal };
  const bounds = workloadBounds(settings, assignment, kind);
  let envelope;
  try {
    envelope = jobEnvelope(assignment, bounds);
  } catch (failure) {
    return {
      placed: "Refused",
      evidence: /** @type {Error} */ (failure).message,
    };
  }
  /** @type {Placement} */
  const placement = {
    assignment: assignment.assignment,
    kind,
    name: containerName(settings.pool, assignment.assignment),
    image: /** @type {string} */ (assignment.image),
    phase: "Placing",
    deadlineEpochSecs:
      Math.floor(seams.nowMs() / 1000) +
      Math.min(assignment.deadlineSecs, bounds.timeoutSecsMax),
    controller: new globalThis.AbortController(),
    done: Promise.resolve(),
  };
  state.placements.set(placement.assignment, placement);
  placement.done = placementRun(state, placement, assignment, envelope).then(
    () => placementForgotten(state, placement),
    (failure) => placementFailed(state, placement, assignment, failure),
  );
  return { placed: "Placed" };
}

/**
 * Drops a placement that has run its course from those `held` names.
 *
 * @param {State} state
 * @param {Placement} placement
 */
function placementForgotten(state, placement) {
  if (state.placements.get(placement.assignment) === placement)
    state.placements.delete(placement.assignment);
}

/**
 * Drops a placement that failed, logs why, and queues its end with the
 * attempt it held for the next `held`, unless this pool stopped it. Dropping
 * and queueing are one step, so a `held` reads the placement or its end and
 * never both.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {WorkerPoolAssignment} assignment
 * @param {unknown} failure
 */
function placementFailed(state, placement, assignment, failure) {
  placementForgotten(state, placement);
  const why = placementFailure(placement, failure);
  state.seams.log(`${placement.name} ${why}`);
  if (endAccounted(state, placement.assignment))
    state.ends.pending.push(
      workloadEnd(
        placement.kind,
        {
          assignment: assignment.assignment,
          callbackUrl: assignment.callbackUrl,
          bearer: assignment.bearer,
        },
        { why: `its container ${why}`, succeeded: false },
      ),
    );
}

/**
 * What a stop answers of an engine call that failed: a container that is not
 * there is one already stopped.
 *
 * @param {EngineAnswer} answer
 * @returns {WorkerPoolStopped}
 */
function stopAnswer(answer) {
  const failure = engineFailure(answer);
  if (failure === "NoSuchContainer") return { stopped: "Stopped" };
  return {
    stopped: "Unavailable",
    evidence:
      failure === "Unreachable"
        ? "the container engine could not be reached to stop this workload"
        : `the container engine did not stop this workload: ${engineFailureLine(answer)}`,
  };
}

/**
 * Kills one container's workload and retires the container, as `held` does
 * one past its deadline. The kill is judged by the container it leaves, since
 * a workload that ended on its own just before refuses one; a workload that
 * has ended is stopped even where its container is kept for `held` to retire.
 *
 * @param {State} state
 * @param {string} id
 * @returns {Promise<WorkerPoolStopped>}
 */
async function containerStopped(state, id) {
  const { engine } = state.seams;
  const killed = await engine.exec(killArgv(id));
  const inspected = await engine.exec(inspectArgv([id]));
  if (inspected.code !== 0) return stopAnswer(inspected);
  const [container] = inspectionContainers(state, inspected).map(poolContainer);
  if (!endedStatuses.has(container.status)) return stopAnswer(killed);
  await retired(state, container, "was stopped");
  return { stopped: "Stopped" };
}

/**
 * Stops an assignment's workload, whichever kind it is. A placement still in
 * flight is cancelled and waited out first, so a `run` it was already making
 * is killed too rather than left behind. Its container is found by its
 * labels, as `held` finds it, so one a run under another naming started is
 * found too. Its end is never named, and one already waiting to be is dropped.
 *
 * @param {State} state
 * @param {string} assignment
 * @returns {Promise<WorkerPoolStopped>}
 */
async function stopped(state, assignment) {
  state.ends.accounted.add(assignment);
  /** @param {WorkerPoolEnded} ended */
  const kept = (ended) => endedAssignment(ended) !== assignment;
  state.ends.pending = state.ends.pending.filter(kept);
  state.ends.ready = state.ends.ready.filter(kept);
  const placement = state.placements.get(assignment);
  if (placement !== undefined) {
    placement.controller.abort();
    await placement.done;
  }
  const listed = await state.seams.engine.exec(
    listArgv(poolLabelValue(state.settings.pool), assignment),
  );
  if (listed.code !== 0) return stopAnswer(listed);
  for (const id of listedIds(listed)) {
    const answer = await containerStopped(state, id);
    if (answer.stopped !== "Stopped") return answer;
  }
  return { stopped: "Stopped" };
}

/**
 * @param {ContainerBackendSettings} settings
 * @param {ContainerBackendSeams} seams
 * @returns {ContainerBackend}
 */
export function containerBackend(settings, seams) {
  /** @type {State} */
  const state = {
    settings: checkedContainerBackendSettings(settings),
    seams,
    placements: new Map(),
    ends: { pending: [], ready: [], accounted: new Set() },
  };
  return {
    place: (assignment, kind) => placed(state, assignment, kind),
    stop: (assignment) => stopped(state, assignment),
    held: () => heldAssignments(state),
    ended: async () => state.ends.ready.splice(0),
    inFlight: () =>
      [...state.placements.values()].map((placement) => ({
        assignment: placement.assignment,
        kind: placement.kind,
        name: placement.name,
        image: placement.image,
        phase: placement.phase,
        deadlineEpochSecs: placement.deadlineEpochSecs,
      })),
    containers: async () => (await poolContainers(state)).map(poolContainer),
    settled: async () => {
      await Promise.all(
        [...state.placements.values()].map((placement) => placement.done),
      );
    },
  };
}
