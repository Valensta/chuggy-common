/**
 * `WorkerPoolBackend` over a container engine on this machine: a container
 * per assignment, run from the image the assignment pins, whose entrypoint is
 * the worker core. chuggy's Kubernetes pool backend is the behaviour this
 * mirrors, with a container where it has a pod.
 *
 * AN ASSIGNMENT THAT PINS NO IMAGE RUNS IN ONE ITS OWNER LISTED: the first of
 * `images` declaring every capability the assignment names but its platform,
 * which is this engine's. Nothing here checks that an image meets what it
 * declares; its owner declared it, as the pool's own capabilities are.
 *
 * A SESSION IS RUN AS A JOB IS. Its container is a job's but for the kind it
 * is labelled with, which `held` and `ended` read back, and its deadline,
 * which is its assignment's own: a session ends of itself once idle, and the
 * runner's cap is a job's. Chuggy's runtime and this machine's engine, below,
 * are a job's alone. A container with no kind label is a job's: a runner that
 * ran nothing else started it.
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
 *
 * A JOB WHOSE ASSIGNMENT NAMES A RUNTIME STARTS THROUGH IT, whatever image it
 * names, as chuggy's cluster starts one: the runtime image is got as a job's
 * image is, a volume of the job's own is filled from it, and the job's
 * container mounts that volume read-only and runs the runtime's check of the
 * image before the core, in a workspace volume of its own that every user
 * can write, as a cluster's emptyDir is. A job whose image cannot be got,
 * started or pass that check is named refused rather than ended, with the
 * image's fault in one fixed text a fault. A runtime this runner cannot get or
 * copy is the site's failure and never the image's, so that job's placement
 * fails as any does. The volumes go with the job's container, or with its
 * placement where the job never starts in them, the container filling them
 * first. Any a runner left, stopped mid-placement or refused a removal, are
 * removed by a later `held`, which never takes one of a placement in flight
 * or of a container it lists. An assignment naming no runtime runs its
 * image's own entrypoint.
 *
 * A JOB IS HANDED THIS MACHINE'S ENGINE where its runner hands jobs one: the
 * engine's socket, mounted into its container, and the variables that tell
 * docker's clients and testcontainers where it is, which are the backend's
 * whatever the runner's environment says. What a job starts there is the
 * engine's, beside the job's container rather than in it, and goes with
 * neither that container nor its volumes. A session is never handed the
 * engine.
 *
 * A JOB MOUNTS EACH VOLUME ITS OWNER LISTS, a named volume or a directory of
 * this machine, whatever image it runs and however it starts. A named volume
 * that is not there is made, labelled as this runner's, before the job that
 * mounts it starts, and each this runner made is opened to the job's user
 * then, by the job's runtime image, as its runtime volumes are filled, so one
 * whose opening a stopped runner cut short is opened by the next job.
 * One its owner made is mounted as it is. A job started through no runtime
 * has no image to open one with, so it mounts one only once it is there.
 * A named volume listed as its project's is one per project: its name carries
 * a digest of the pool's project and its label names that project. One of
 * that name labelled as another project's or as none is refused, and so is
 * one listed unscoped that is labelled as a project's. A personal runner
 * serves no one project, so no job of its mounts a volume listed as its
 * project's, which it says once. These volumes are the owner's, and nothing
 * here removes one: none carries a pool's label, and none is a job's own. A
 * session mounts none: it runs its site's session image, whose environment
 * points at none of them, and, as with the engine, is given nothing of this
 * machine it does not need.
 */

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

import {
  workerImageFaults,
  workerImageFaultStatuses,
  workerJobCommand,
  workerWorkspaceVariable,
} from "@chuggy/worker-contract/workerEnvironment";
import {
  workerImageCharsMax,
  workerPoolCapabilitySchema,
} from "@chuggy/worker-contract/workerPool";
import { z } from "zod";

import { claudeCredentialCarried } from "./claudeCredential.mjs";
import {
  assignmentLabel,
  bindMountNameable,
  deadlineLabel,
  fillLabel,
  forcedRemoveArgv,
  imageInspectArgv,
  inspectArgv,
  killArgv,
  kindLabel,
  listArgv,
  logsArgv,
  ownerVolumeCreateArgv,
  ownerVolumeDirectory,
  ownerVolumeLabel,
  ownerVolumeProjectLabel,
  ownerVolumesOpenArgv,
  removeArgv,
  runArgv,
  runtimeFillArgv,
  runtimeLabel,
  runtimeVolumeCreateArgv,
  volumeInspectArgv,
  volumeListArgv,
  volumeRemoveArgv,
  workloadMountTargets,
  workspaceLabel,
} from "./engineArgv.mjs";
import {
  engineCommandUnstarted,
  engineFailure,
  engineFailureLine,
  enginePullRefused,
} from "./engineErrors.mjs";
import {
  jobEngineSocketEnvironment,
  jobEnvelope,
  jobEnvironmentAttempt,
  jobEnvironmentFile,
  jobRunDirectory,
  jobWorkspace,
} from "./job.mjs";
import {
  poolIdentityDigest,
  poolIdentityDigestChars,
  poolIdentityPersonal,
  poolLabelValue,
  poolProjectDigest,
  poolProjectLabelValue,
} from "./poolIdentity.mjs";
import { imageRegistryHost, registryPull } from "./registryAuth.mjs";
import { runtimeScratch } from "./runtimeScratch.mjs";

/**
 * @typedef {import("@chuggy/worker-contract/workerPool").WorkerPoolAssignment} WorkerPoolAssignment
 * @typedef {import("@chuggy/worker-contract/workerEnvironment").WorkerImageFault} WorkerImageFault
 * @typedef {import("./poolLoop.mjs").WorkerPoolAttempt} WorkerPoolAttempt
 * @typedef {import("./poolLoop.mjs").WorkerPoolJobRefusal} WorkerPoolJobRefusal
 * @typedef {import("./poolLoop.mjs").WorkerPoolBackend} WorkerPoolBackend
 * @typedef {import("./poolLoop.mjs").WorkerPoolEnded} WorkerPoolEnded
 * @typedef {import("./poolLoop.mjs").WorkerPoolHeld} WorkerPoolHeld
 * @typedef {import("./poolLoop.mjs").WorkerPoolStopped} WorkerPoolStopped
 * @typedef {import("./poolLoop.mjs").WorkerPoolWorkloadKind} WorkerPoolWorkloadKind
 * @typedef {import("./poolLoop.mjs").WorkerPoolTokens} WorkerPoolTokens
 * @typedef {import("./engine.mjs").Engine} Engine
 * @typedef {import("./engine.mjs").EngineAnswer} EngineAnswer
 * @typedef {import("./engineArgv.mjs").OwnerVolume} OwnerVolume
 * @typedef {import("./poolIdentity.mjs").PoolIdentity} PoolIdentity
 *
 * @typedef {object} ContainerBackendSettings
 * @property {"docker" | "podman"} engine
 * @property {PoolIdentity} pool
 * @property {string} tokenFile the Claude credential file, which each workload mounts
 * @property {import("./claudeCredential.mjs").ClaudeCredentialSetting} [claudeCredential] the kind of credential `tokenFile` is; none, and a workload's core reads it as a subscription's token, as it does a site pool's
 * @property {string | undefined} registryHost the one registry the pool's token is presented to
 * @property {string | undefined} dockerHost the endpoint docker's context names, which a pull of the pool's registry is told; docker's alone
 * @property {number} timeoutSecsMax
 * @property {number} outputBytesMax
 * @property {Readonly<Record<string, string>>} environment
 * @property {string} network
 * @property {string} runtimeDir
 * @property {string} logDir
 * @property {{cpuMillis: number, memoryMib: number}} machine
 * @property {number} pullRetryMs the wait before a pull the registry refused is tried again
 * @property {import("./engineArgv.mjs").EngineSocket} [engineSocket] this machine's engine, which each job is handed through its socket and no session is; none, and no workload is
 * @property {readonly OwnerImage[]} [images] what a job whose assignment pins no image runs in; none, and no such job is taken
 * @property {readonly OwnerVolumeListed[]} [volumes] what its owner mounts into each job and no session; none, and nothing is
 *
 * @typedef {z.infer<typeof ownerVolumesSchema>[number]} OwnerVolumeListed a volume as its owner lists it, which `ownerVolumesServed` makes one a job mounts
 *
 * @typedef {object} OwnerImage an image its pool's owner runs work in that names capabilities rather than an image
 * @property {string} image
 * @property {readonly string[]} capabilities what the owner declares it meets
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
 * @typedef {object} PlacementRuntime what a job placed through chuggy's runtime starts from
 * @property {string} image the runtime image its assignment named
 * @property {string[]} made the job's volumes made so far, which go where the job does not start in them
 * @property {import("./engineArgv.mjs").RuntimeVolumes | undefined} volumes once both are made, and the container that fills them can have been run
 *
 * @typedef {InFlightPlacement & {
 *   runtime: PlacementRuntime | undefined,
 *   controller: AbortController,
 *   done: Promise<void>,
 * }} Placement
 *
 * @typedef {object} PoolContainer
 * @property {string} id
 * @property {string} name
 * @property {string | undefined} assignment
 * @property {WorkerPoolWorkloadKind} kind
 * @property {string} status
 * @property {number | undefined} exitCode
 * @property {number | undefined} deadlineEpochSecs
 * @property {string | undefined} runtimeVolume the volume holding its copy of chuggy's runtime, where it was started through one
 * @property {string | undefined} workspaceVolume the volume its workspace is, where it was started through chuggy's runtime
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
 * @property {WorkerPoolJobRefusal} [refusal] where this site refused the job for its image's fault rather than ran it, which a job's end carries
 * @property {true} [timedOut] where `held` killed it at its deadline, which a job's end carries
 *
 * @typedef {object} State
 * @property {ContainerBackendSettings} settings
 * @property {ContainerBackendSeams} seams
 * @property {readonly OwnerVolume[]} volumes what each job mounts of its owner's, as `ownerVolumesServed` serves them
 * @property {Map<string, Placement>} placements
 * @property {Ends} ends
 * @property {boolean} strays whether volumes of chuggy's runtime that nothing answers for may be left: from the start, since a predecessor may have left some, and after any removal of one failed
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

/**
 * What this runner tells the person whose job's image it could not run, one
 * fixed text a fault. Nothing the workload printed is ever relayed.
 */
export const containerImageFaultTexts = {
  ImageUnpullable: "This runner could not pull the image this job names.",
  ImageLacksShell:
    "The image this job names has no executable /bin/sh, so this runner could not start chuggy's check of the image.",
  ImageLibcUnsupported:
    "The image this job names cannot load chuggy's runtime, which needs the image's glibc and libstdc++.",
  ImageLacksGit: "The image this job names has no git on its PATH.",
  ImageHomeUnwritable:
    "The image this job names gives the job's user no HOME it can write.",
  ImageWorkspaceUnwritable: `The image this job names gives the job's user no ${jobWorkspace} it can write.`,
  ImageTmpUnwritable:
    "The image this job names gives the job's user no temporary directory it can write.",
};

/**
 * A fault's text, with the engine's own line after it where the fault is one
 * whose cause only the engine knows: a pull and a start.
 *
 * @param {WorkerImageFault} fault
 * @param {string} [said]
 */
export function containerImageFaultText(fault, said) {
  const text = containerImageFaultTexts[fault];
  return said === undefined ? text : `${text} The engine said: ${said}`;
}

/**
 * The fault the runtime's check exits with this status for, read from the
 * contract and never restated.
 *
 * @param {number} exitCode
 * @returns {WorkerImageFault | undefined}
 */
function checkedImageFault(exitCode) {
  /** @type {Readonly<Partial<Record<WorkerImageFault, number>>>} */
  const statuses = workerImageFaultStatuses;
  return workerImageFaults.find((fault) => statuses[fault] === exitCode);
}

/**
 * How long after its first pull a job's image may go on failing to pull for
 * a cause that can pass before the failure is read as the image's: the
 * counterpart of the dwell chuggy's cluster reads a pull by,
 * `kubernetesPullFailureDwellSecs` in chuggy's
 * `src/adapters/kubernetes/podFaults.ts`. It is counted from that pull, so a
 * runtime slow to pull before it takes none of it.
 */
export const pullFailureDwellMs = 120_000;

/**
 * An inspection or a pull of an image the engine answered as failed, kept
 * with that answer for a caller to read why.
 */
class ImageCallFailed extends Error {
  /**
   * @param {string} message
   * @param {EngineAnswer} answer
   */
  constructor(message, answer) {
    super(message);
    this.name = "ImageCallFailed";
    this.answer = answer;
  }
}

/**
 * The fault of a job's image that stops this site carrying the job through,
 * which names its end refused rather than failed.
 */
class PlacementRefused extends Error {
  /**
   * @param {string} why
   * @param {WorkerImageFault} fault
   */
  constructor(why, fault) {
    super(why);
    this.name = "PlacementRefused";
    this.fault = fault;
  }
}

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

const inspectedVolumesSchema = z.array(
  z.object({
    Name: z.string(),
    Labels: z.record(z.string(), z.string()).nullish(),
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
  claudeCredentialCarried(settings.claudeCredential);
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
    runtimeVolume: labels[runtimeLabel],
    workspaceVolume: labels[workspaceLabel],
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
 * Removes one of a job's volumes of chuggy's runtime, answering whether it is
 * gone. One that could not be removed is logged by name and left for a later
 * `held` to remove.
 *
 * @param {State} state
 * @param {string} owner the container it was made for
 * @param {string} volume
 */
async function runtimeVolumeRemoved(state, owner, volume) {
  const removed = await state.seams.engine.exec(volumeRemoveArgv(volume));
  if (removed.code === 0 || engineFailure(removed) === "NoSuchVolume")
    return true;
  state.strays = true;
  state.seams.log(
    `${owner}: its volume ${volume} was not removed: ${engineFailureLine(removed)}`,
  );
  return false;
}

/**
 * Removes a job's volumes of chuggy's runtime, which an engine removing the
 * container they were mounted in keeps, as it keeps every named volume.
 *
 * @param {State} state
 * @param {string} owner the container they were made for
 * @param {(string | undefined)[]} volumes
 */
async function runtimeVolumesRemoved(state, owner, volumes) {
  for (const volume of volumes)
    if (volume !== undefined) await runtimeVolumeRemoved(state, owner, volume);
}

/**
 * Removes the container that fills a job's volumes of chuggy's runtime,
 * running or not, so that the volumes it holds can go; one already gone is
 * no failure.
 *
 * @param {State} state
 * @param {string} owner the container the volumes were made for
 * @param {string} fill
 */
async function fillRemoved(state, owner, fill) {
  const removed = await state.seams.engine.exec(forcedRemoveArgv(fill));
  if (removed.code !== 0 && engineFailure(removed) !== "NoSuchContainer")
    state.seams.log(
      `${owner}: the container filling its volumes, ${fill}, was not removed: ${engineFailureLine(removed)}`,
    );
}

/**
 * This pool's volumes as the engine describes them, or nothing where it
 * could not, which is logged. One removed between the listing and the
 * inspection is left out of the answer.
 *
 * @param {State} state
 */
async function poolVolumes(state) {
  const { settings, seams } = state;
  const listed = await seams.engine.exec(
    volumeListArgv(poolLabelValue(settings.pool)),
  );
  if (listed.code !== 0) {
    seams.log(
      `${settings.engine} could not list this pool's volumes: ${engineFailureLine(listed)}`,
    );
    return undefined;
  }
  const names = listedIds(listed);
  if (names.length === 0) return [];
  const answer = await seams.engine.exec(volumeInspectArgv(names));
  if (answer.code !== 0 && engineFailure(answer) !== "NoSuchVolume") {
    seams.log(
      `${settings.engine} could not inspect this pool's volumes: ${engineFailureLine(answer)}`,
    );
    return undefined;
  }
  try {
    return inspectedVolumesSchema.parse(JSON.parse(answer.stdout));
  } catch {
    seams.log(
      `${settings.engine} answered an inspection of this pool's volumes this runner cannot read`,
    );
    return undefined;
  }
}

/**
 * Removes the volumes of chuggy's runtime that nothing answers for: each of
 * an assignment `held` listed no container of and found no placement of in
 * flight, the placements read again as each is removed, since a placement
 * makes its volumes after it is placed. The container filling them goes
 * first. A sweep that could not finish leaves `strays` set for the next.
 *
 * @param {State} state
 * @param {ReadonlySet<string>} listed the assignments `held` found in flight or listed a container of
 */
async function strayVolumesRemoved(state, listed) {
  state.strays = false;
  const volumes = await poolVolumes(state);
  if (volumes === undefined) {
    state.strays = true;
    return;
  }
  const fills = new Set();
  for (const { Name: volume, Labels: labels } of volumes) {
    const assignment = labels?.[assignmentLabel];
    if (
      assignment === undefined ||
      listed.has(assignment) ||
      state.placements.has(assignment)
    )
      continue;
    const owner = containerName(state.settings.pool, assignment);
    const fill = labels?.[fillLabel];
    if (fill !== undefined && !fills.has(fill)) {
      fills.add(fill);
      await fillRemoved(state, owner, fill);
    }
    if (await runtimeVolumeRemoved(state, owner, volume))
      state.seams.log(
        `${owner}: its volume ${volume}, which nothing answered for, was removed`,
      );
  }
}

/**
 * Saves a container's logs and removes it, and the volumes of chuggy's
 * runtime it was started through with it. A container whose logs could not
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
  if (removed.code === 0)
    await runtimeVolumesRemoved(state, container.name, [
      container.runtimeVolume,
      container.workspaceVolume,
    ]);
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
 * to one, and otherwise by the state it was left in. A container started
 * through chuggy's runtime that exited with one of the check's statuses was
 * stopped by its image, and is refused with that fault.
 *
 * @param {PoolContainer} container
 * @returns {ContainerEnd}
 */
function containerEnded(container) {
  const exited =
    exitedStatuses.has(container.status) && container.exitCode !== undefined;
  const fault =
    exited && container.runtimeVolume !== undefined
      ? checkedImageFault(/** @type {number} */ (container.exitCode))
      : undefined;
  if (fault !== undefined)
    return {
      why: containerImageFaultText(fault),
      succeeded: false,
      refusal: { fault },
    };
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
  timedOut: true,
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
  if (kind === "Session")
    return {
      kind,
      session: attempt,
      phase: end.succeeded ? "Succeeded" : "Failed",
    };
  return {
    kind,
    job: attempt,
    why: end.why,
    ...(end.refusal === undefined ? {} : { refusal: end.refusal }),
    ...(end.timedOut === true ? { timedOut: true } : {}),
  };
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
 * between the two is listed as a container. A container runs on when this
 * process ends, and a runner started after it lists it again; a placement is
 * this process's own, and ends with it.
 *
 * The ends of placements that failed before that read are made ready only
 * where the listing finds no container of theirs and no stop came meanwhile:
 * a `run` that failed can still have started one, and a listed container
 * answers for its own attempt.
 *
 * While some may be left, the volumes of chuggy's runtime that nothing
 * answers for are removed before any listed container is retired, so one
 * that a retirement fails to remove is left to the next pass, which finds
 * its container gone.
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
  const containers = (await poolContainers(state)).map((inspected) => ({
    inspected,
    container: poolContainer(inspected),
  }));
  if (state.strays)
    await strayVolumesRemoved(
      state,
      new Set([
        ...placing,
        ...containers.flatMap(({ container }) => container.assignment ?? []),
      ]),
    );
  for (const { inspected, container } of containers) {
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
  return [...held].map(([assignment, kind]) =>
    placing.has(assignment)
      ? { assignment, kind }
      : { assignment, kind, outlivesRunner: true },
  );
}

/** The images an owner lists for work that pins none, as a runner's settings name them. */
export const ownerImagesSchema = z.array(
  z.strictObject({
    image: z.string().min(1).max(workerImageCharsMax),
    capabilities: z.array(
      workerPoolCapabilitySchema.refine(
        (capability) => !capability.startsWith("Platform:"),
        "names a platform, which is the engine's",
      ),
    ),
  }),
);

/**
 * The link images make of `/var/run`, to `/run`, through which a mount under
 * `/run` lands under `/var/run`.
 */
const runDirectoryLink = { link: "/var/run", to: "/run" };

/**
 * The paths of chuggy's own in a job's container, which no owner's volume is
 * mounted at, in or above: each `runArgv` mounts, and chuggy's own run
 * directory, which the credentials it mints are in, each under `/var/run`
 * also as `runDirectoryLink` reaches it.
 */
export const ownerVolumeTargetsRefused = [
  ...workloadMountTargets,
  jobRunDirectory,
].flatMap((path) => {
  const under = posix.relative(runDirectoryLink.link, path);
  return under.startsWith("..")
    ? [path]
    : [path, posix.join(runDirectoryLink.to, under)];
});

/** A name both docker and podman give a volume. */
const ownerVolumeNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]+$/u;

/**
 * Why an owner's volume cannot be this source, or nothing.
 *
 * @param {string} source
 */
function ownerVolumeSourceRefusal(source) {
  if (ownerVolumeDirectory(source))
    return bindMountNameable(source)
      ? undefined
      : "cannot be named in a bind mount: it has a comma or a line break";
  return ownerVolumeNamePattern.test(source)
    ? undefined
    : "names neither a volume, by two or more letters, digits, '_', '.' and '-' from a letter or digit, nor a directory by its absolute path";
}

/**
 * Why an owner's volume cannot be mounted at this target, or nothing. A
 * target is an absolute path in its normal form, which both `--mount` and
 * `--volume` can name, and neither is one of chuggy's paths nor is in or
 * holds one, since a mount there would hide chuggy's or be hidden by it.
 *
 * @param {string} target
 */
function ownerVolumeTargetRefusal(target) {
  if (target === "/") return "may not be the container's root";
  if (
    !posix.isAbsolute(target) ||
    posix.normalize(target) !== target ||
    target.endsWith("/")
  )
    return "must be an absolute path in its normal form, with no '.' or '..' and no doubled or trailing '/'";
  if (/[,:\r\n]/u.test(target))
    return "cannot be named in a mount: it has a comma, a colon or a line break";
  const refused = ownerVolumeTargetsRefused;
  const at = refused.find((path) => target === path);
  if (at !== undefined) return `is ${at}, chuggy's own`;
  const within = refused.find((path) => target.startsWith(`${path}/`));
  if (within !== undefined) return `is in ${within}, chuggy's own`;
  const holding = refused.find((path) => path.startsWith(`${target}/`));
  if (holding !== undefined) return `holds ${holding}, chuggy's own`;
  return undefined;
}

/** The longest name docker gives a volume, which names a directory of this machine, as podman's does. */
const ownerVolumeNameCharsMax = 255;

/** The longest name of a volume that can be listed as its project's, whose name there is followed by `-` and the project's digest. */
const ownerVolumeScopedNameCharsMax =
  ownerVolumeNameCharsMax - 1 - poolIdentityDigestChars;

/**
 * Why an owner's volume cannot be listed as its project's, or nothing: a
 * directory is not made, so it cannot be made per project, and a name must
 * still name a volume once the project's digest follows it.
 *
 * @param {string} source
 */
function ownerVolumeScopeRefusal(source) {
  if (ownerVolumeDirectory(source))
    return "is a directory, and only a named volume can be one per project";
  return source.length > ownerVolumeScopedNameCharsMax
    ? `is too long to be named per project, which takes a name of at most ${String(ownerVolumeScopedNameCharsMax)} characters`
    : undefined;
}

/**
 * Adds an issue where a refusal names one.
 *
 * @param {(value: string) => string | undefined} refusal
 */
function ownerVolumeRefined(refusal) {
  return z.string().superRefine((value, context) => {
    const why = refusal(value);
    if (why !== undefined) context.addIssue({ code: "custom", message: why });
  });
}

/**
 * What a runner's owner mounts into each job, as a runner's settings name
 * it: the source, told apart as `ownerVolumeDirectory` says, its target in
 * the job's container, each target once, whether the job may only read it,
 * and whether it is one per project, which only a named volume can be.
 */
export const ownerVolumesSchema = z
  .array(
    z
      .strictObject({
        source: ownerVolumeRefined(ownerVolumeSourceRefusal),
        target: ownerVolumeRefined(ownerVolumeTargetRefusal),
        readonly: z.boolean().default(false),
        scope: z.literal("project").optional(),
      })
      .superRefine(({ source, scope }, context) => {
        const why =
          scope === undefined ? undefined : ownerVolumeScopeRefusal(source);
        if (why !== undefined)
          context.addIssue({ code: "custom", path: ["source"], message: why });
      }),
  )
  .superRefine((volumes, context) => {
    volumes.forEach(({ target }, index) => {
      const first = volumes.findIndex((volume) => volume.target === target);
      if (first !== index)
        context.addIssue({
          code: "custom",
          path: [index, "target"],
          message: `is volume ${String(first)}'s target too`,
        });
    });
  });

/**
 * The image an assignment runs in: the one it pins, or else the first its
 * owner listed declaring every capability it names but its platform, which an
 * engine's image is only where it is Linux.
 *
 * @param {readonly OwnerImage[]} images
 * @param {Pick<WorkerPoolAssignment, "image" | "capabilities">} assignment
 * @returns {string | undefined}
 */
export function containerImageOf(images, assignment) {
  if (assignment.image !== undefined) return assignment.image;
  if (
    assignment.capabilities.some(
      (capability) =>
        capability.startsWith("Platform:") &&
        !capability.startsWith("Platform:Linux:"),
    )
  )
    return undefined;
  const needed = assignment.capabilities.filter(
    (capability) => !capability.startsWith("Platform:"),
  );
  return images.find((listed) =>
    needed.every((capability) => listed.capabilities.includes(capability)),
  )?.image;
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
  if (containerImageOf(state.settings.images ?? [], assignment) === undefined)
    return "the assignment pins no image, and no image this pool's owner listed meets it: a Linux one declaring every capability it names";
  if (assignment.cpuMillis > machine.cpuMillis)
    return `the assignment asks for ${String(assignment.cpuMillis)} CPU millis and this machine has ${String(machine.cpuMillis)}`;
  if (assignment.memoryMib > machine.memoryMib)
    return `the assignment asks for ${String(assignment.memoryMib)} MiB and this machine has ${String(machine.memoryMib)}`;
  return state.seams.tokenFileRefusal(state.settings.tokenFile);
}

/**
 * @param {State} state
 * @param {string} image
 * @param {string} named how a failure names the image: `its image` for the job's own
 */
async function imagePresent(state, image, named) {
  const answer = await state.seams.engine.exec(imageInspectArgv(image));
  if (answer.code === 0) return true;
  if (engineFailure(answer) === "NotFound") return false;
  throw new ImageCallFailed(
    `${named} could not be inspected: ${engineFailureLine(answer)}`,
    answer,
  );
}

/**
 * One pull, made as `registryPull` makes it.
 *
 * @param {State} state
 * @param {string} image
 * @param {import("./registryAuth.mjs").RegistryCredential | undefined} credential
 * @param {AbortSignal} signal
 */
function pullAttempt(state, image, credential, signal) {
  return registryPull(state.settings, image, credential, (argv, environment) =>
    state.seams.engine.exec(argv, { environment, signal }),
  );
}

/**
 * What a call made for a placement runs under: a signal a stop or the
 * assignment's deadline aborts.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {string} late what the placement had not done by its deadline, where it is already past
 */
function placementSignal(state, placement, late) {
  const remainingMs = placement.deadlineEpochSecs * 1000 - state.seams.nowMs();
  if (remainingMs <= 0) throw new Error(`${late} by the assignment's deadline`);
  return globalThis.AbortSignal.any([
    placement.controller.signal,
    globalThis.AbortSignal.timeout(remainingMs),
  ]);
}

/**
 * An image of the pool's own registry is pulled under the pool's token until
 * it is here, the registry refuses it for a reason a new token will not
 * change, or the deadline passes; a refused token is discarded so the next
 * attempt is made under a fresh one. Any other image is pulled once, as the
 * engine's own configuration pulls it, and a refusal there says nothing about
 * the pool's token.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {string} image
 * @param {string} named how a failure names the image: `its image` for the job's own
 */
async function pulled(state, placement, image, named) {
  const { settings, seams } = state;
  const host = imageRegistryHost(image);
  const late = `${named} was not pulled`;
  if (host !== settings.registryHost) {
    const signal = placementSignal(state, placement, late);
    const answer = await pullAttempt(state, image, undefined, signal);
    if (answer.code === 0) return;
    throw new ImageCallFailed(
      `${named} could not be pulled: ${engineFailureLine(answer)}`,
      answer,
    );
  }
  for (;;) {
    const signal = placementSignal(state, placement, late);
    const acquired = await seams.tokens.acquire();
    if (acquired.acquired === "Denied")
      throw new Error(
        `the pool has no token to pull with: ${acquired.evidence}`,
      );
    if (acquired.acquired === "Token") {
      const credential = { host, token: acquired.token };
      const answer = await pullAttempt(state, image, credential, signal);
      if (answer.code === 0) return;
      if (engineFailure(answer) !== "Unauthorized")
        throw new ImageCallFailed(
          `${named} could not be pulled: ${engineFailureLine(answer)}`,
          answer,
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
 * A failure to get a job's image as the image's fault, where it is one.
 *
 * @param {ImageCallFailed} failure
 */
function unpullable(failure) {
  return new PlacementRefused(
    containerImageFaultText(
      "ImageUnpullable",
      engineFailureLine(failure.answer),
    ),
    "ImageUnpullable",
  );
}

/**
 * A job's image pulled where its job starts through chuggy's runtime, where
 * a pull that fails is the image's fault: at once where the registry refused
 * the image or the reference names none, and otherwise, since any other cause
 * can pass, only once it has gone on failing until `pullFailureDwellMs` after
 * the first pull. An engine that could not be reached, a pool with no
 * token to pull with and the deadline are this runner's, never the image's.
 *
 * @param {State} state
 * @param {Placement} placement
 */
async function jobImagePulled(state, placement) {
  const { settings, seams } = state;
  const firstPullMs = seams.nowMs();
  for (;;) {
    try {
      await pulled(state, placement, placement.image, "its image");
      return;
    } catch (failure) {
      if (
        !(failure instanceof ImageCallFailed) ||
        engineFailure(failure.answer) === "Unreachable"
      )
        throw failure;
      if (
        enginePullRefused(failure.answer) ||
        seams.nowMs() - firstPullMs >= pullFailureDwellMs
      )
        throw unpullable(failure);
      seams.log(
        `${placement.name}: its image could not be pulled yet, and is pulled again: ${engineFailureLine(failure.answer)}`,
      );
      await seams.sleep(
        settings.pullRetryMs,
        placementSignal(state, placement, "its image was not pulled"),
      );
    }
  }
}

/**
 * A job's image here where its job starts through chuggy's runtime: an
 * inspection the engine refused because the reference names no image is the
 * image's fault as a pull's would be, and any other is this runner's.
 *
 * @param {State} state
 * @param {Placement} placement
 */
async function jobImageHere(state, placement) {
  let present;
  try {
    present = await imagePresent(state, placement.image, "its image");
  } catch (failure) {
    if (failure instanceof ImageCallFailed && enginePullRefused(failure.answer))
      throw unpullable(failure);
    throw failure;
  }
  if (present) return;
  placement.phase = "Pulling";
  await jobImagePulled(state, placement);
}

/**
 * A job's image here where its job starts through its own entrypoint.
 *
 * @param {State} state
 * @param {Placement} placement
 */
async function imageHere(state, placement) {
  if (await imagePresent(state, placement.image, "its image")) return;
  placement.phase = "Pulling";
  await pulled(state, placement, placement.image, "its image");
}

/**
 * A failure of this runner's own work on chuggy's runtime as the failure of
 * the job's placement, naming what the runner could not do. Where a stop was
 * why, the stop's end stands instead.
 *
 * @param {unknown} failure
 * @param {string} what what this runner could not do
 */
function runtimeFailure(failure, what) {
  const why =
    failure instanceof Error && failure.name === "AbortError"
      ? "the assignment's deadline passed first"
      : failure instanceof Error
        ? failure.message
        : String(failure);
  return new Error(`${what}: ${why}`);
}

/**
 * Chuggy's runtime image here, pulled as any image is where it is not.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {PlacementRuntime} runtime
 */
async function runtimeHere(state, placement, runtime) {
  try {
    if (!(await imagePresent(state, runtime.image, "the runtime"))) {
      placement.phase = "Pulling";
      await pulled(state, placement, runtime.image, "the runtime");
    }
  } catch (failure) {
    throw runtimeFailure(
      failure,
      `this runner could not get chuggy's runtime ${runtime.image}`,
    );
  }
}

/**
 * The job's own volumes of chuggy's runtime, made for this placement alone so
 * that none a predecessor left half filled is taken for its own: its copy of
 * the runtime, filled from the runtime image, and its workspace, opened.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {PlacementRuntime} runtime
 */
async function runtimeFilled(state, placement, runtime) {
  const { settings, seams } = state;
  const stem = `${placement.name}-${randomBytes(4).toString("hex")}`;
  const volumes = {
    volume: `${stem}-runtime`,
    workspace: `${stem}-workspace`,
    fill: `${stem}-fill`,
  };
  try {
    for (const volume of [volumes.volume, volumes.workspace]) {
      const created = await seams.engine.exec(
        runtimeVolumeCreateArgv(
          volume,
          poolLabelValue(settings.pool),
          placement.assignment,
          volumes.fill,
        ),
      );
      if (created.code !== 0)
        throw new Error(
          `its volume ${volume} could not be made: ${engineFailureLine(created)}`,
        );
      runtime.made.push(volume);
    }
    runtime.volumes = volumes;
    const filled = await seams.engine.exec(
      runtimeFillArgv(volumes, runtime.image),
      {
        signal: placementSignal(state, placement, "the runtime was not copied"),
      },
    );
    if (filled.code !== 0)
      throw new Error(
        `its volumes could not be filled: ${engineFailureLine(filled)}`,
      );
  } catch (failure) {
    throw runtimeFailure(
      failure,
      `this runner could not copy chuggy's runtime ${runtime.image}`,
    );
  }
}

/**
 * The labels of an owner's named volume that is there, or nothing where it is
 * not.
 *
 * @param {State} state
 * @param {string} volume
 * @returns {Promise<Record<string, string> | undefined>}
 */
async function ownerVolumeLabels(state, volume) {
  const answer = await state.seams.engine.exec(volumeInspectArgv([volume]));
  if (answer.code !== 0 && engineFailure(answer) === "NoSuchVolume")
    return undefined;
  if (answer.code !== 0)
    throw new Error(
      `its owner's volume ${volume} could not be inspected: ${engineFailureLine(answer)}`,
    );
  let inspected;
  try {
    [inspected] = inspectedVolumesSchema.parse(JSON.parse(answer.stdout));
  } catch {
    throw new Error(
      `${state.settings.engine} answered an inspection of its owner's volume ${volume} this runner cannot read`,
    );
  }
  return inspected === undefined ? undefined : (inspected.Labels ?? {});
}

/**
 * Each volume its owner lists, as a job of this pool mounts it, and the
 * sources of those none does: one listed as its project's is named and
 * labelled as the pool's project's, and a personal runner, serving no one
 * project, withholds it.
 *
 * @param {readonly OwnerVolumeListed[]} volumes
 * @param {PoolIdentity} pool
 * @returns {{served: OwnerVolume[], withheld: string[]}}
 */
export function ownerVolumesServed(volumes, pool) {
  const project = poolProjectLabelValue(pool);
  const digest = poolProjectDigest(pool);
  /** @type {OwnerVolume[]} */
  const served = [];
  /** @type {string[]} */
  const withheld = [];
  for (const { scope, ...volume } of volumes)
    if (scope === undefined) served.push(volume);
    else if (project === undefined || digest === undefined)
      withheld.push(volume.source);
    else
      served.push({ ...volume, source: `${volume.source}-${digest}`, project });
  return { served, withheld };
}

/**
 * What a personal runner says of a volume `ownerVolumesServed` withholds, as
 * its runner's doctor says it too.
 *
 * @param {string} source
 */
export function ownerVolumeWithheldLine(source) {
  return `${source} is scoped per project, and a personal runner mounts no volume scoped per project: its jobs run without it, and a project's own pool is how to get one`;
}

/**
 * Why an owner's named volume that is there, labelled `labels`, cannot be
 * mounted as `volume`, or nothing: one listed as its project's must be
 * labelled as that project's, and one listed unscoped as no project's, so no
 * job mounts a volume made for another project.
 *
 * @param {Pick<OwnerVolume, "project">} volume
 * @param {Readonly<Record<string, string>>} labels
 */
export function ownerVolumeLabelsRefusal({ project }, labels) {
  const labelled = Object.hasOwn(labels, ownerVolumeProjectLabel)
    ? labels[ownerVolumeProjectLabel]
    : undefined;
  if (labelled === project) return undefined;
  if (labelled === undefined)
    return `is labelled as no project's, and is listed as ${String(project)}'s`;
  if (project === undefined)
    return `is labelled as ${labelled}'s, and is listed as no project's`;
  return `is labelled as ${labelled}'s, not ${project}'s`;
}

/**
 * Makes an owner's named volume that was not there. One another placement
 * made since, which podman refuses to make again, is taken as made.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {OwnerVolume} volume
 */
async function ownerVolumeMade(state, placement, volume) {
  const { settings, seams } = state;
  const created = await seams.engine.exec(
    ownerVolumeCreateArgv(settings.engine, volume),
  );
  if (created.code === 0)
    seams.log(
      `${placement.name}: its owner's volume ${volume.source} was made`,
    );
  else if ((await ownerVolumeLabels(state, volume.source)) === undefined)
    throw new Error(
      `its owner's volume ${volume.source} could not be made: ${engineFailureLine(created)}`,
    );
}

/**
 * Readies each named volume a job's owner mounts into it, as this backend's
 * header says: refused where its labels say it is not the one listed, made
 * where it is not there, then, with every other this runner made, opened by
 * the container `ownerVolumesOpenArgv` names.
 *
 * @param {State} state
 * @param {Placement} placement
 */
async function ownerVolumesReady(state, placement) {
  const { settings, seams } = state;
  const runtime = placement.runtime?.image;
  /** @type {string[]} */
  const opened = [];
  for (const volume of ownerVolumesReadyNamed(state.volumes)) {
    const labels = await ownerVolumeLabels(state, volume.source);
    const refusal =
      labels === undefined
        ? undefined
        : ownerVolumeLabelsRefusal(volume, labels);
    if (refusal !== undefined)
      throw new Error(`its owner's volume ${volume.source} ${refusal}`);
    if (labels !== undefined && !Object.hasOwn(labels, ownerVolumeLabel))
      continue;
    if (runtime === undefined) {
      if (labels !== undefined) continue;
      throw new Error(
        `its owner's volume ${volume.source} is not there, and only a job started through chuggy's runtime can make one`,
      );
    }
    if (labels === undefined) await ownerVolumeMade(state, placement, volume);
    opened.push(volume.source);
  }
  if (runtime === undefined || opened.length === 0) return;
  try {
    const answer = await seams.engine.exec(
      ownerVolumesOpenArgv(settings.engine, opened, runtime),
      {
        signal: placementSignal(
          state,
          placement,
          "its owner's volumes were not opened",
        ),
      },
    );
    if (answer.code !== 0) throw new Error(engineFailureLine(answer));
  } catch (failure) {
    throw runtimeFailure(
      failure,
      `this runner could not open its owner's volumes ${opened.join(", ")}`,
    );
  }
}

/**
 * The named volumes among a job's owner's, each once by its name and project.
 *
 * @param {readonly OwnerVolume[]} volumes
 */
function ownerVolumesReadyNamed(volumes) {
  /** @type {Map<string, OwnerVolume>} */
  const named = new Map();
  for (const volume of volumes)
    if (!ownerVolumeDirectory(volume.source))
      named.set(JSON.stringify([volume.source, volume.project]), volume);
  return named.values();
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
 * This machine's engine where a workload is handed it: a job's, where the
 * runner hands its jobs one, and never a session's.
 *
 * @param {ContainerBackendSettings} settings
 * @param {Placement} placement
 */
function workloadEngineSocket(settings, placement) {
  return placement.kind === "Job" ? settings.engineSocket : undefined;
}

/**
 * What a workload is given of its owner's volumes: each served, where it is a
 * job.
 *
 * @param {State} state
 * @param {Placement} placement
 */
function workloadOwnerVolumes(state, placement) {
  return placement.kind === "Job" ? state.volumes : undefined;
}

/**
 * The environment a workload's env file carries beside its envelope: the
 * runner's, then the kind of Claude credential it mounts where the runner
 * names one, what a job handed this machine's engine is told of it, and for a
 * job started through chuggy's runtime the workspace its check is to find
 * writable, which is the one its envelope names.
 *
 * @param {ContainerBackendSettings} settings
 * @param {Placement} placement
 */
function workloadEnvironment(settings, placement) {
  const socket = workloadEngineSocket(settings, placement);
  return {
    ...settings.environment,
    ...claudeCredentialCarried(settings.claudeCredential),
    ...(socket === undefined
      ? {}
      : jobEngineSocketEnvironment(settings.engine, socket.path)),
    ...(placement.runtime === undefined
      ? {}
      : { [workerWorkspaceVariable]: jobWorkspace }),
  };
}

/**
 * Removes a container whose run failed before its command started, so the
 * failed placement's end is the one named.
 *
 * @param {State} state
 * @param {string} name
 */
async function unstartedRemoved(state, name) {
  const removed = await state.seams.engine.exec(removeArgv(name));
  if (removed.code !== 0 && engineFailure(removed) !== "NoSuchContainer")
    state.seams.log(
      `${name} did not start and was not removed: ${engineFailureLine(removed)}`,
    );
}

/**
 * Runs the container, the envelope reaching it through an env file only its
 * owner can read, which is removed once `run` has answered. A container of
 * this name already carrying this assignment is a repeated placement. A job
 * started through chuggy's runtime whose image's shell could not be started
 * is refused with that fault, its unstarted container removed.
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
      jobEnvironmentFile(envelope, workloadEnvironment(settings, placement)),
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
        runtime: placement.runtime?.volumes,
        engineSocket: workloadEngineSocket(settings, placement),
        volumes: workloadOwnerVolumes(state, placement),
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
  if (
    placement.runtime !== undefined &&
    engineCommandUnstarted(answer, workerJobCommand[0])
  ) {
    await unstartedRemoved(state, placement.name);
    throw new PlacementRefused(
      containerImageFaultText("ImageLacksShell", engineFailureLine(answer)),
      "ImageLacksShell",
    );
  }
  throw new Error(
    `its container could not be run: ${engineFailureLine(answer)}`,
  );
}

/**
 * Gets what a placement starts from and starts it: chuggy's runtime first
 * where the job starts through one, then the job's image, then the job's
 * volumes of the runtime, then its owner's. The runtime's are removed where
 * the job did not start in them, as where a predecessor's container was found
 * already running the job, and where it failed the container filling them
 * goes first: a stop or the deadline ends only the engine's CLI, and leaves
 * that container holding them.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {WorkerPoolAssignment} assignment
 * @param {string} envelope
 */
async function placementRun(state, placement, assignment, envelope) {
  const { runtime } = placement;
  let outcome;
  try {
    if (runtime === undefined) await imageHere(state, placement);
    else {
      await runtimeHere(state, placement, runtime);
      await jobImageHere(state, placement);
    }
    placement.controller.signal.throwIfAborted();
    placement.phase = "Starting";
    if (runtime !== undefined) await runtimeFilled(state, placement, runtime);
    if (placement.kind === "Job") await ownerVolumesReady(state, placement);
    outcome = await started(state, placement, assignment, envelope);
  } catch (failure) {
    if (runtime?.volumes !== undefined)
      await fillRemoved(state, placement.name, runtime.volumes.fill);
    if (runtime !== undefined)
      await runtimeVolumesRemoved(state, placement.name, runtime.made);
    throw failure;
  }
  state.seams.log(`${placement.name} ${outcome}`);
  if (outcome === "was already running" && runtime !== undefined)
    await runtimeVolumesRemoved(state, placement.name, runtime.made);
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
  const placedMs = seams.nowMs();
  /** @type {Placement} */
  const placement = {
    assignment: assignment.assignment,
    kind,
    name: containerName(settings.pool, assignment.assignment),
    image: /** @type {string} */ (
      containerImageOf(settings.images ?? [], assignment)
    ),
    phase: "Placing",
    deadlineEpochSecs:
      Math.floor(placedMs / 1000) +
      Math.min(assignment.deadlineSecs, bounds.timeoutSecsMax),
    runtime:
      kind === "Job" && assignment.runtime !== undefined
        ? { image: assignment.runtime, made: [], volumes: undefined }
        : undefined,
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
  /** @type {ContainerEnd} */
  let end;
  if (
    failure instanceof PlacementRefused &&
    !placement.controller.signal.aborted
  ) {
    state.seams.log(`${placement.name} was refused: ${failure.message}`);
    end = {
      why: failure.message,
      succeeded: false,
      refusal: { fault: failure.fault },
    };
  } else {
    const why = placementFailure(placement, failure);
    state.seams.log(`${placement.name} ${why}`);
    end = { why: `its container ${why}`, succeeded: false };
  }
  if (endAccounted(state, placement.assignment))
    state.ends.pending.push(
      workloadEnd(
        placement.kind,
        {
          assignment: assignment.assignment,
          callbackUrl: assignment.callbackUrl,
          bearer: assignment.bearer,
        },
        end,
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
  const checked = checkedContainerBackendSettings(settings);
  const volumes = ownerVolumesServed(checked.volumes ?? [], checked.pool);
  for (const source of volumes.withheld)
    seams.log(`its owner's volume ${ownerVolumeWithheldLine(source)}`);
  /** @type {State} */
  const state = {
    settings: checked,
    seams,
    volumes: volumes.served,
    placements: new Map(),
    ends: { pending: [], ready: [], accounted: new Set() },
    strays: true,
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
