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
 * names, as chuggy's cluster starts one: once the job's image is here, the
 * runtime image is got as a job's image is, for the platform the engine holds
 * the job's image for, a volume of the job's own is filled from that variant
 * of it, and the job's container mounts that volume read-only and runs the
 * runtime's check of the image before the core, in a workspace volume of its
 * own that every user can write, as a cluster's emptyDir is. One placement at
 * a time gets and copies a runtime image, as `runtimeTurnTaken` says. A job
 * whose image cannot be got, started or pass that check is named refused
 * rather than ended, with the image's fault in one fixed text a fault. A
 * runtime this runner cannot get or copy is the site's failure and never the
 * image's, so that job's placement fails as any does. The volumes go with the
 * job's container, or with its placement where the job never starts in them,
 * the container filling them first. Any a runner left, stopped mid-placement
 * or refused a removal, are removed by a later `held`, which never takes one
 * of a placement in flight or of a container it lists. An assignment naming
 * no runtime runs its image's own entrypoint.
 *
 * A JOB IS HANDED THIS MACHINE'S ENGINE where its runner hands jobs one: the
 * engine's socket, mounted into its container, and the variables that tell
 * docker's clients and testcontainers where it is, which are the backend's
 * whatever the runner's environment says. What a job starts there is the
 * engine's, beside the job's container rather than in it, and goes with
 * neither that container nor its volumes. A session is never handed the
 * engine.
 *
 * AN ENDED CONTAINER'S LOGS ARE SAVED BEFORE IT IS REMOVED, their tail as
 * `savedLog.mjs` bounds it. One whose logs could not be saved is kept for a
 * later pass to try again, until `logSaveFailureDwellMs` after the first
 * failure, when it is removed without them, which is logged: a machine whose
 * log directory cannot be written is one whose containers would otherwise
 * never go.
 *
 * THIS MACHINE'S IMAGES ARE SWEPT where the runner names a record of them,
 * as `imageCleanup.mjs` says: each placement holds what it is about to use
 * before it looks, and records the use once `run` has answered. With no
 * record, no image is held, recorded or removed.
 *
 * A JOB STARTS ONLY INTO ROOM where the runner keeps a memory budget, as
 * `memoryBudget.mjs` says. Its hold is made as it is placed, so its memory is
 * held while its images are pulled, and `place` answers once it is. One decided
 * to start then starts once its images are here and its volumes ready; one that
 * is not is checked again then, and every `memoryHeldCheckMs` after, until it
 * starts, is stopped or is too near its deadline to start, which bounds a hold
 * as it bounds a pull. Its `run` is cut short of that deadline, and a container
 * it may have made is removed, so its hold outlasts its start. `held` names a
 * held job held. Whether jobs are asked for, and the claim taken to ask a plane
 * that claims by room, are as `memoryBudget.mjs` says. A job asking more than
 * the ceiling is refused, as one asking more than the machine is, and a session
 * more than the whole budget. A session is counted but never held: it is a
 * person waiting on a reply, and its own ceiling bounds it. A workload's
 * container is given its deadline as it is run, so neither a pull nor a hold
 * takes from its run.
 *
 * `held` HOLDS A FLOOR OF FREE DISK where the runner measures one, as
 * `diskFloor.mjs` says. The job it stops is the one docker says holds most in
 * its container and workspace, where several run, and otherwise the newest;
 * never a session.
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
 * a digest of the job's project and its label names that project, as
 * `poolProjectDigest` and `poolProjectLabelValue` key it, so a pool's job and
 * a personal runner's in one project mount the same volume. One of that name
 * labelled as another project's or as none is refused, and so is one listed
 * unscoped that is labelled as a project's. A personal runner's job whose
 * assignment names no project mounts none listed as its project's, which its
 * placement says. These volumes are the owner's, and nothing
 * here removes one: none carries a pool's label, and none is a job's own. A
 * session mounts none: it runs its site's session image, whose environment
 * points at none of them, and, as with the engine, is given nothing of this
 * machine it does not need.
 */

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  dockerDiskUsageArgv,
  fillLabel,
  forcedRemoveArgv,
  heldCreateArgv,
  imageInspectArgv,
  imageInspectManyArgv,
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
  jobClaudeAgent,
  jobCredentialFilesChecked,
  jobCredentialHanded,
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
import {
  diskFloor,
  diskFloorCapped,
  diskFloorHeld,
  dockerDiskUsage,
} from "./diskFloor.mjs";
import { fileLockHolderAlive } from "./fileLock.mjs";
import {
  imageCleanup,
  imageCleanupNone,
  imageUnusedSecsMaxDefault,
} from "./imageCleanup.mjs";
import {
  memoryBudget,
  memoryBudgetBytes,
  memoryBudgetHeld,
  memoryBudgetTakes,
  memoryClaimTaken,
  memoryCountMsMax,
  memoryCounted,
  memoryHeldCheckMs,
  memoryHoldsRemoved,
  memoryLockCallsMsMax,
  memoryLocked,
  memoryRoom,
  memoryStartCutMs,
  memoryStartDecided,
} from "./memoryBudget.mjs";
import { imageRegistryHost, registryPull } from "./registryAuth.mjs";
import { runtimeScratch } from "./runtimeScratch.mjs";
import {
  savedLogBytesMax,
  savedLogLinesMax,
  savedLogWritten,
} from "./savedLog.mjs";

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
 * @property {string} tokenFile the Claude credential file, which each workload mounts but one whose job requires another agent `agentCredentialFiles` names
 * @property {import("./claudeCredential.mjs").ClaudeCredentialSetting} [claudeCredential] the kind of credential `tokenFile` is; none, and a workload's core reads it as a subscription's token, as it does a site pool's
 * @property {Readonly<Record<string, string>>} [agentCredentialFiles] the credential file of each agent but Claude, by the name its `Agent:` capability gives it, which a job requiring that agent mounts in place of `tokenFile`; none, and such a job mounts `tokenFile`
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
 * @property {string} [imageRecord] the file `imageCleanup.mjs` keeps this machine's images' record in, one for every runner using this engine as this user; none, and no image is held, recorded or removed
 * @property {number} [imageUnusedSecsMax] how long a job's image this runner pulled may go unused before it is removed, 0 keeping them; `imageUnusedSecsMaxDefault` where none
 * @property {number} [diskFreeBytesMin] the floor `held` keeps free where `diskFree` measures; none or 0, and none is kept
 * @property {number} [memoryFreeBytesMin] what the memory budget keeps free of the engine's memory; none, and no budget is kept
 * @property {string} [memoryLock] the file every runner using this engine as this user takes the memory lock at, which a budget needs; none, and no budget is kept
 * @property {number} [memoryReservedBytes] what the budget reserves from jobs, which no job may ask past the rest of; none or 0, and a job may ask the whole budget
 * @property {string} [memoryClaimLock] the file every runner using this engine as this user takes the claim lock at, to ask a plane that claims by room for jobs; none, and the runner asks it as it asks any plane
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
 * @property {(file: string, agent: string) => Promise<string | undefined>} tokenFileRefusal why this machine cannot hand a job the credential file the backend mounts, which is `agent`'s, or nothing: the runner's to judge, since whether a job can read it turns on how its engine maps users
 * @property {() => number} nowMs
 * @property {(ms: number, signal: AbortSignal) => Promise<void>} sleep
 * @property {(line: string) => void} log
 * @property {() => Promise<import("./diskFloor.mjs").DiskFree>} [diskFree] the bytes free where the engine stores what it holds, the runner's to measure, since an engine in a VM answers for the VM's disk; none, and no floor is kept
 * @property {(pid: number) => boolean} [holderAlive] whether the process a memory hold names is running; `fileLockHolderAlive` where none
 *
 * @typedef {object} InFlightPlacement
 * @property {string} assignment
 * @property {WorkerPoolWorkloadKind} kind
 * @property {string} name
 * @property {string} image
 * @property {"Placing" | "Pulling" | "Starting" | "Held"} phase
 * @property {number} deadlineEpochSecs by which its images are pulled and, where it makes a memory hold, it has started, or it fails
 * @property {number} memoryMib its cap
 * @property {string} [waiting] what a held one waits for
 *
 * @typedef {object} PlacementRuntime what a job placed through chuggy's runtime starts from
 * @property {string} image the runtime image its assignment named
 * @property {string[]} made the job's volumes made so far, which go where the job does not start in them
 * @property {import("./engineArgv.mjs").RuntimeVolumes | undefined} volumes once both are made, and the container that fills them can have been run
 *
 * @typedef {object} PlacementMemory a job's hold on its engine's memory, made as it is placed
 * @property {import("./memoryBudget.mjs").MemoryHold} hold
 * @property {import("./memoryBudget.mjs").MemoryDecision} decision what the count it was made under decided
 *
 * @typedef {InFlightPlacement & {
 *   runSecs: number,
 *   memory: PlacementMemory | undefined,
 *   holding: boolean,
 *   credential: import("./job.mjs").JobCredential,
 *   runtime: PlacementRuntime | undefined,
 *   volumes: readonly OwnerVolume[] | undefined,
 *   pulled: Map<string, string>,
 *   controller: AbortController,
 *   done: Promise<void>,
 * }} Placement each image it pulled in `pulled`, by the id it was pulled as; how long its container may run in `runSecs`; its hold in `memory`, none for a session or without a budget, and whether that hold is on the engine in `holding`
 *
 * @typedef {object} PoolContainer
 * @property {string} id
 * @property {string} name
 * @property {string | undefined} assignment
 * @property {WorkerPoolWorkloadKind} kind
 * @property {string} status
 * @property {number | undefined} exitCode
 * @property {number | undefined} deadlineEpochSecs
 * @property {number | undefined} startedMs where the engine says it started
 * @property {string | undefined} runtimeVolume the volume holding its copy of chuggy's runtime, where it was started through one
 * @property {string | undefined} workspaceVolume the volume its workspace is, where it was started through chuggy's runtime
 *
 * @typedef {WorkerPoolBackend & {
 *   inFlight: () => InFlightPlacement[],
 *   containers: () => Promise<PoolContainer[]>,
 *   imagesReclaimed: (signal: AbortSignal) => Promise<string[]>,
 *   jobsTaken: (byRoom?: boolean) => boolean,
 *   memoryRoom: () => import("./memoryBudget.mjs").MemoryRoom | undefined,
 *   settled: () => Promise<void>,
 * }} ContainerBackend `imagesReclaimed` removes what `imageCleanup.mjs`'s reclaim does, answering the names it removed
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
 * @property {"Deadline" | "DiskLow"} [killed] where `held` killed it, at its deadline or for low disk, which a job's end carries
 *
 * @typedef {object} State
 * @property {ContainerBackendSettings} settings
 * @property {ContainerBackendSeams} seams
 * @property {readonly OwnerVolumeListed[]} volumes what its owner lists to mount into each job, which `ownerVolumesServed` serves each
 * @property {Map<string, Placement>} placements
 * @property {Ends} ends
 * @property {boolean} strays whether volumes of chuggy's runtime that nothing answers for may be left: from the start, since a predecessor may have left some, and after any removal of one failed
 * @property {import("./imageCleanup.mjs").ImageCleanup} images
 * @property {Map<string, number>} logFailures when each listed container's logs first could not be saved, by its id
 * @property {import("./diskFloor.mjs").DiskFloor | undefined} disk
 * @property {import("./memoryBudget.mjs").MemoryBudget | undefined} memory
 * @property {Map<string, Promise<unknown>>} runtimeTurns the turn last queued at each runtime image, which `runtimeTurnTaken` gives one placement at a time
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
 * How long after an ended container's logs first could not be saved it is
 * kept for a later pass to try again: several of the passes a long poll
 * paces.
 */
export const logSaveFailureDwellMs = 600_000;

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
    State: z.object({
      Status: z.string(),
      ExitCode: z.number().optional(),
      StartedAt: z.string().optional(),
    }),
  }),
);

/** An image's inspection, of which only the platform it is for is read. */
const inspectedImageSchema = z.tuple([
  z.object({
    Os: z.string().min(1),
    Architecture: z.string().min(1),
    Variant: z.string().optional(),
  }),
]);

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
  jobCredentialFilesChecked(settings);
  const unused = settings.imageUnusedSecsMax;
  if (unused !== undefined && (!Number.isSafeInteger(unused) || unused < 0))
    throw new RangeError(
      "imageUnusedSecsMax must be a whole number of seconds, 0 or more",
    );
  if (settings.imageRecord !== undefined && settings.imageRecord.length === 0)
    throw new RangeError("imageRecord must name a file");
  for (const key of /** @type {const} */ ([
    "diskFreeBytesMin",
    "memoryFreeBytesMin",
    "memoryReservedBytes",
  ])) {
    const floor = settings[key];
    if (floor !== undefined && (!Number.isSafeInteger(floor) || floor < 0))
      throw new RangeError(`${key} must be a whole number of bytes, 0 or more`);
  }
  for (const key of /** @type {const} */ (["memoryLock", "memoryClaimLock"]))
    if (settings[key] !== undefined && settings[key].length === 0)
      throw new RangeError(`${key} must name a file`);
  return settings;
}

/**
 * @param {InspectedContainer} inspected
 * @returns {PoolContainer}
 */
function poolContainer(inspected) {
  const labels = inspected.Config.Labels ?? {};
  const deadline = Number(labels[deadlineLabel]);
  const started = Date.parse(inspected.State.StartedAt ?? "");
  return {
    id: inspected.Id,
    name: inspected.Name.replace(/^\//u, ""),
    assignment: labels[assignmentLabel],
    kind: labels[kindLabel] === "Session" ? "Session" : "Job",
    status: inspected.State.Status,
    exitCode: inspected.State.ExitCode,
    deadlineEpochSecs: Number.isSafeInteger(deadline) ? deadline : undefined,
    startedMs: Number.isNaN(started) ? undefined : started,
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
 * Why a call for a container's logs failed, by how it ended alone: what it
 * printed on stderr can be the workload's own output, which is never logged.
 *
 * @param {string} engine
 * @param {import("./engine.mjs").EngineAnswer} answer
 */
function logsFailure(engine, answer) {
  if (answer.failed === "Unstarted") return `${engine} could not be started`;
  if (answer.failed === "Interrupted")
    return `${engine} logs did not answer in time`;
  return `${engine} logs exited ${String(answer.code)}`;
}

/**
 * A container's logs saved as `savedLog.mjs` bounds them, answering the file,
 * or why they could not be: how the engine's call ended, or this machine's
 * failure.
 *
 * @param {State} state
 * @param {PoolContainer} container
 * @returns {Promise<{file: string} | {why: string}>}
 */
async function savedLogs(state, container) {
  try {
    const answer = await state.seams.engine.execTail(
      logsArgv(container.id, savedLogLinesMax + 1),
      savedLogBytesMax,
    );
    if (answer.code !== 0)
      return { why: logsFailure(state.settings.engine, answer) };
    await mkdir(state.settings.logDir, { recursive: true, mode: 0o700 });
    const file = join(state.settings.logDir, `${container.name}.log`);
    await savedLogWritten(
      file,
      answer.tail,
      answer.cut || answer.lines > savedLogLinesMax,
    );
    return { file };
  } catch (failure) {
    return {
      why: failure instanceof Error ? failure.message : String(failure),
    };
  }
}

/**
 * Whether a container whose logs could not be saved is kept for a later pass
 * to try again, which it is until `logSaveFailureDwellMs` after the first
 * pass that could not.
 *
 * @param {State} state
 * @param {PoolContainer} container
 * @param {string} why
 * @param {string} cause why its logs could not be saved
 */
function unsavedKept(state, container, why, cause) {
  const nowMs = state.seams.nowMs();
  const firstMs = state.logFailures.get(container.id) ?? nowMs;
  state.logFailures.set(container.id, firstMs);
  if (nowMs - firstMs < logSaveFailureDwellMs) {
    state.seams.log(
      `${container.name} ${why}; its logs could not be saved: ${cause}`,
    );
    return true;
  }
  state.seams.log(
    `${container.name} ${why}; its logs could not be saved since ${new Date(firstMs).toISOString()}, and are lost with it: ${cause}`,
  );
  return false;
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
 * be saved is left for the next pass to try again, rather than lost with
 * them, until `unsavedKept` says it has been kept long enough.
 *
 * @param {State} state
 * @param {PoolContainer} container
 * @param {string} why
 */
async function retired(state, container, why) {
  const saved = await savedLogs(state, container);
  if ("why" in saved && unsavedKept(state, container, why, saved.why)) return;
  const removed = await state.seams.engine.exec(removeArgv(container.id));
  if (removed.code === 0) state.logFailures.delete(container.id);
  const kept = "file" in saved ? `logs saved to ${saved.file}` : "logs lost";
  state.seams.log(
    removed.code === 0
      ? `${container.name} ${why}; ${kept}, container removed`
      : `${container.name} ${why}; ${kept}, not removed: ${engineFailureLine(removed)}`,
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
  killed: /** @type {const} */ ("Deadline"),
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
    ...(end.killed === undefined ? {} : { killed: end.killed }),
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
 * @typedef {{inspected: InspectedContainer, container: PoolContainer & {assignment: string}}} RunningJob
 */

/**
 * The running job that holds most: where several run on docker, the most its
 * container and workspace volume hold, as docker says; and otherwise, or
 * where docker cannot say, the newest.
 *
 * @param {State} state
 * @param {readonly RunningJob[]} running at least one
 * @returns {Promise<RunningJob>}
 */
async function largestJob(state, running) {
  const newest = running.toSorted(
    (a, b) =>
      (b.container.startedMs ?? -Infinity) -
      (a.container.startedMs ?? -Infinity),
  );
  if (running.length === 1 || state.settings.engine !== "docker")
    return /** @type {RunningJob} */ (newest[0]);
  const answer = await diskFloorCapped(state.seams, (signal) =>
    state.seams.engine.exec(dockerDiskUsageArgv(), { signal }),
  );
  const usage = answer?.code === 0 ? dockerDiskUsage(answer.stdout) : undefined;
  if (usage === undefined) return /** @type {RunningJob} */ (newest[0]);
  /** @param {RunningJob} job */
  const holds = ({ container }) =>
    (usage.containers.get(container.id) ?? 0) +
    (container.workspaceVolume === undefined
      ? 0
      : (usage.volumes.get(container.workspaceVolume) ?? 0));
  return /** @type {RunningJob} */ (
    newest.toSorted((a, b) => holds(b) - holds(a))[0]
  );
}

/**
 * Kills the running job that holds most and retires it, naming its end
 * `why`, and answers its assignment; or nothing where no job runs or the kill
 * failed, which leaves it held.
 *
 * @param {State} state
 * @param {readonly RunningJob[]} running
 * @param {string} why
 */
async function diskLowKilled(state, running, why) {
  if (running.length === 0) return undefined;
  const { inspected, container } = await largestJob(state, running);
  const killed = await state.seams.engine.exec(killArgv(container.id));
  if (killed.code !== 0) {
    state.seams.log(
      `${container.name} was not killed for low disk: ${engineFailureLine(killed)}`,
    );
    return undefined;
  }
  await retired(state, container, "was killed for low disk");
  containerEndNamed(state, inspected, container, {
    why,
    succeeded: false,
    killed: "DiskLow",
  });
  return container.assignment;
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
  state.images.due();
  const failed = state.ends.pending.splice(0);
  for (const ended of failed)
    state.ends.accounted.delete(endedAssignment(ended));
  const listed = new Set(placing);
  const nowSecs = Math.floor(state.seams.nowMs() / 1000);
  const containers = (await poolContainers(state)).map((inspected) => ({
    inspected,
    container: poolContainer(inspected),
  }));
  const ids = new Set(containers.map(({ container }) => container.id));
  for (const id of state.logFailures.keys())
    if (!ids.has(id)) state.logFailures.delete(id);
  if (state.strays)
    await strayVolumesRemoved(
      state,
      new Set([
        ...placing,
        ...containers.flatMap(({ container }) => container.assignment ?? []),
      ]),
    );
  /** @type {RunningJob[]} */
  const running = [];
  for (const { inspected, container } of containers) {
    const { assignment } = container;
    if (assignment === undefined || placing.has(assignment)) continue;
    listed.add(assignment);
    if (
      await listedHeld(state, inspected, { ...container, assignment }, nowSecs)
    ) {
      held.set(assignment, container.kind);
      if (container.kind === "Job")
        running.push({ inspected, container: { ...container, assignment } });
    }
  }
  await memoryHeld(state);
  if (state.disk !== undefined)
    await diskFloorHeld(state.disk, {
      ...state.seams,
      reclaimed: (signal, made) => state.images.reclaimed(signal, made),
      killed: async (why) => {
        const killed = await diskLowKilled(state, running, why);
        if (killed !== undefined) held.delete(killed);
      },
    });
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
 * Why this machine will not take an assignment, its credential aside, or
 * nothing.
 *
 * @param {State} state
 * @param {WorkerPoolAssignment} assignment
 * @param {WorkerPoolWorkloadKind} kind
 * @returns {string | undefined}
 */
function placementRefusal(state, assignment, kind) {
  const { machine } = state.settings;
  if (containerImageOf(state.settings.images ?? [], assignment) === undefined)
    return "the assignment pins no image, and no image this pool's owner listed meets it: a Linux one declaring every capability it names";
  if (assignment.cpuMillis > machine.cpuMillis)
    return `the assignment asks for ${String(assignment.cpuMillis)} CPU millis and this machine has ${String(machine.cpuMillis)}`;
  if (assignment.memoryMib > machine.memoryMib)
    return `the assignment asks for ${String(assignment.memoryMib)} MiB and this machine has ${String(machine.memoryMib)}`;
  return placementRefusalMemory(state, assignment, kind);
}

/** @param {number} bytes */
const placementRefusalMib = (bytes) => String(Math.floor(bytes / 2 ** 20));

/**
 * Why the memory budget will not take an assignment, as the last count found
 * it: where a job asks more than the ceiling, the budget less what it
 * reserves, or a session more than the whole budget, which no room ever has.
 *
 * @param {State} state
 * @param {WorkerPoolAssignment} assignment
 * @param {WorkerPoolWorkloadKind} kind
 */
function placementRefusalMemory(state, assignment, kind) {
  const counted = state.memory?.counted;
  if (state.memory === undefined || counted === undefined) return undefined;
  if ("unknown" in counted) return undefined;
  const budget = memoryBudgetBytes(state.memory.bytesFree, counted);
  const reserved = kind === "Job" ? state.memory.bytesReserved : 0;
  if (assignment.memoryMib * 2 ** 20 <= budget - reserved) return undefined;
  const asked = `the assignment asks for ${String(assignment.memoryMib)} MiB`;
  if (reserved > 0)
    return `${asked} and this runner's ceiling for a job is ${placementRefusalMib(Math.max(0, budget - reserved))} MiB: its memory budget of ${placementRefusalMib(budget)} MiB less the ${placementRefusalMib(reserved)} MiB it reserves`;
  return `${asked} and this runner's memory budget is ${placementRefusalMib(budget)} MiB: the engine's ${placementRefusalMib(counted.engineBytes)} MiB less the ${placementRefusalMib(state.memory.bytesFree)} MiB this runner keeps free`;
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
 * The platform the engine holds an image for, as `--platform` names one, or
 * nothing where it holds no image of that name. Docker's classic store and
 * podman hold one variant by a name; of the several docker's containerd store
 * can hold, it answers the one nearest this machine's.
 *
 * @param {State} state
 * @param {string} image
 * @param {string} named how a failure names the image: `its image` for the job's own
 */
async function imagePlatform(state, image, named) {
  const answer = await state.seams.engine.exec(imageInspectManyArgv([image]));
  if (answer.code !== 0 && engineFailure(answer) === "NotFound")
    return undefined;
  if (answer.code !== 0)
    throw new ImageCallFailed(
      `${named} could not be inspected: ${engineFailureLine(answer)}`,
      answer,
    );
  let inspected;
  try {
    [inspected] = inspectedImageSchema.parse(JSON.parse(answer.stdout));
  } catch {
    throw new Error(
      `${state.settings.engine} answered an inspection of ${named} that names no platform this runner can read`,
    );
  }
  const { Os, Architecture, Variant } = inspected;
  return Variant === undefined || Variant === ""
    ? `${Os}/${Architecture}`
    : `${Os}/${Architecture}/${Variant}`;
}

/**
 * Whether an image held for `held` is one for `wanted`: the same system and
 * architecture, and the same variant where both name one, since an image
 * naming none is its architecture's default variant.
 *
 * @param {string} held
 * @param {string} wanted
 */
function imagePlatformMatched(held, wanted) {
  const [heldOs, heldArchitecture, heldVariant] = held.split("/");
  const [wantedOs, wantedArchitecture, wantedVariant] = wanted.split("/");
  return (
    heldOs === wantedOs &&
    heldArchitecture === wantedArchitecture &&
    (heldVariant === undefined ||
      wantedVariant === undefined ||
      heldVariant === wantedVariant)
  );
}

/**
 * One pull, made as `registryPull` makes it.
 *
 * @param {State} state
 * @param {string} image
 * @param {string | undefined} platform
 * @param {import("./registryAuth.mjs").RegistryCredential | undefined} credential
 * @param {AbortSignal} signal
 */
function pullAttempt(state, image, platform, credential, signal) {
  return registryPull(
    state.settings,
    image,
    platform,
    credential,
    (argv, environment) =>
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
 * @param {string} [platform] the one variant pulled; none, and the engine's own
 */
async function pulled(state, placement, image, named, platform) {
  await pullMade(state, placement, image, named, platform);
  const id = await state.images.pulledId(image);
  if (id !== undefined) placement.pulled.set(image, id);
}

/**
 * The pull `pulled` makes.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {string} image
 * @param {string} named how a failure names the image: `its image` for the job's own
 * @param {string | undefined} platform
 */
async function pullMade(state, placement, image, named, platform) {
  const { settings, seams } = state;
  const host = imageRegistryHost(image);
  const late = `${named} was not pulled`;
  if (host !== settings.registryHost) {
    const signal = placementSignal(state, placement, late);
    const answer = await pullAttempt(state, image, platform, undefined, signal);
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
      const answer = await pullAttempt(
        state,
        image,
        platform,
        credential,
        signal,
      );
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
 * A job's image here where its job starts through chuggy's runtime, and the
 * platform the engine holds it for: an inspection the engine refused because
 * the reference names no image is the image's fault as a pull's would be, and
 * any other is this runner's.
 *
 * @param {State} state
 * @param {Placement} placement
 */
async function jobImageHere(state, placement) {
  let platform;
  try {
    platform = await imagePlatform(state, placement.image, "its image");
  } catch (failure) {
    if (failure instanceof ImageCallFailed && enginePullRefused(failure.answer))
      throw unpullable(failure);
    throw failure;
  }
  if (platform !== undefined) return platform;
  placement.phase = "Pulling";
  await jobImagePulled(state, placement);
  platform = await imagePlatform(state, placement.image, "its image");
  if (platform === undefined)
    throw new Error("its image was pulled and then was not here");
  return platform;
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
 * Waits until no other placement is getting or copying a runtime image, or
 * the placement's signal aborts, and returns what ends its own turn at it:
 * where an engine holds one variant of an image by its name, a pull of it for
 * one platform would take the name from another's about to be copied.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {string} image
 */
async function runtimeTurnTaken(state, placement, image) {
  const ahead = state.runtimeTurns.get(image) ?? Promise.resolve();
  const own = Promise.withResolvers();
  const queued = ahead.then(() => own.promise);
  state.runtimeTurns.set(image, queued);
  const ended = () => {
    own.resolve(undefined);
    if (state.runtimeTurns.get(image) === queued)
      state.runtimeTurns.delete(image);
  };
  try {
    const signal = placementSignal(state, placement, "the runtime was not got");
    const aborted = new Promise((_, reject) => {
      signal.addEventListener(
        "abort",
        () =>
          reject(
            new globalThis.DOMException("the turn was not taken", {
              name: "AbortError",
              cause: signal.reason,
            }),
          ),
        { once: true },
      );
    });
    await Promise.race([ahead, aborted]);
  } catch (failure) {
    ended();
    throw failure;
  }
  return ended;
}

/**
 * Chuggy's runtime image here for the platform of the job's image, pulled for
 * it where the engine holds it for no other, in the placement's turn at it,
 * whose end it returns.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {PlacementRuntime} runtime
 * @param {string} platform the job's image's
 */
async function runtimeHere(state, placement, runtime, platform) {
  let turnEnded = () => undefined;
  try {
    turnEnded = await runtimeTurnTaken(state, placement, runtime.image);
    const held = await imagePlatform(state, runtime.image, "the runtime");
    if (held === undefined || !imagePlatformMatched(held, platform)) {
      placement.phase = "Pulling";
      await pulled(state, placement, runtime.image, "the runtime", platform);
    }
    return turnEnded;
  } catch (failure) {
    turnEnded();
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
 * @param {string} platform the job's image's, whose variant of the runtime is copied
 */
async function runtimeFilled(state, placement, runtime, platform) {
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
      runtimeFillArgv(volumes, runtime.image, platform),
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
 * sources of those it does not: one listed as its project's is named and
 * labelled as the job's project's, and withheld from a personal runner's job
 * whose assignment names no project.
 *
 * @param {readonly OwnerVolumeListed[]} volumes
 * @param {PoolIdentity} pool
 * @param {string} [assigned] the project the job's assignment names
 * @returns {{served: OwnerVolume[], withheld: string[]}}
 */
export function ownerVolumesServed(volumes, pool, assigned) {
  const project = poolProjectLabelValue(pool, assigned);
  const digest = poolProjectDigest(pool, assigned);
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
 * What a personal runner says of a volume `ownerVolumesServed` withholds from
 * a job.
 *
 * @param {string} source
 */
function ownerVolumeWithheldLine(source) {
  return `${source} is scoped per project, and this job's assignment names no project: it runs without it`;
}

/**
 * What a personal runner's doctor says of a volume listed as its project's,
 * which it does not look for: the runner serves its member across projects,
 * and doctor holds no job's project to look under.
 *
 * @param {string} source
 */
export function ownerVolumeProjectsLine(source) {
  return `${source} is scoped per project: each job mounts its own project's, which, where it is missing, the first job in that project started through chuggy's runtime makes`;
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
  for (const volume of ownerVolumesReadyNamed(placement.volumes ?? [])) {
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
 * The environment a workload's env file carries beside its envelope: the
 * runner's, then the kind of Claude credential where it mounts Claude's and
 * the runner names one, what a job handed this machine's engine is told of
 * it, and for a job started through chuggy's runtime the workspace its check
 * is to find writable, which is the one its envelope names.
 *
 * @param {ContainerBackendSettings} settings
 * @param {Placement} placement
 */
function workloadEnvironment(settings, placement) {
  const socket = workloadEngineSocket(settings, placement);
  return {
    ...settings.environment,
    ...(placement.credential.agent === jobClaudeAgent
      ? claudeCredentialCarried(settings.claudeCredential)
      : {}),
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
 * is refused with that fault, its unstarted container removed. A `run` that
 * `cut` ended fails the job too late to start, the container it may have
 * made removed.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {WorkerPoolAssignment} assignment
 * @param {string} envelope
 * @param {AbortSignal} [cut] what ends `run` where its start is bounded
 * @returns {Promise<"started" | "was already running">} what the log says of it
 */
async function started(state, placement, assignment, envelope, cut) {
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
    answer = await startRun(state, placement, cut, {
      name: placement.name,
      pool: poolLabelValue(settings.pool),
      assignment: placement.assignment,
      kind: placement.kind,
      deadlineEpochSecs: Math.floor(seams.nowMs() / 1000) + placement.runSecs,
      envFile,
      cpuMillis: assignment.cpuMillis,
      memoryMib: assignment.memoryMib,
      credentialFile: placement.credential.file,
      network: settings.network,
      image: placement.image,
      runtime: placement.runtime?.volumes,
      engineSocket: workloadEngineSocket(settings, placement),
      volumes: placement.volumes,
    });
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
 * The placement's `run`, capped as any call is and cut sooner by `cut` where
 * there is one, after which the container it may have made is removed and the
 * job fails too late to start.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {AbortSignal | undefined} cut
 * @param {import("./engineArgv.mjs").WorkloadContainer} spec
 */
async function startRun(state, placement, cut, spec) {
  try {
    return await state.seams.engine.exec(
      runArgv(state.settings.engine, spec),
      cut === undefined ? {} : { cut },
    );
  } catch (failure) {
    if (cut?.aborted !== true) throw failure;
    const removed = await state.seams.engine.exec(
      forcedRemoveArgv(placement.name),
    );
    if (removed.code !== 0 && engineFailure(removed) !== "NoSuchContainer")
      state.seams.log(
        `${placement.name} was cut short of its start and was not removed: ${engineFailureLine(removed)}`,
      );
    throw new Error(memoryStartLate, { cause: failure });
  }
}

/** What a held job had not found by its deadline, which a failure names. */
const memoryHeldLate = "it had no room on this engine";

/** Why a job that was not held fails too near its deadline to start. */
const memoryStartLate = "it could not start before the assignment's deadline";

/**
 * The hold a job's placement makes on its engine's memory, named for its
 * container, first held now and abandoned at the assignment's deadline. It is
 * labelled starting where it is made for a job decided to start.
 *
 * @param {State} state
 * @param {Placement} placement
 * @returns {import("./memoryBudget.mjs").MemoryHold}
 */
function memoryHoldOf(state, placement) {
  return {
    name: `${placement.name}-held`,
    pool: poolLabelValue(state.settings.pool),
    assignment: placement.assignment,
    memoryMib: placement.memoryMib,
    heldMs: state.seams.nowMs(),
    pid: process.pid,
    untilMs: placement.deadlineEpochSecs * 1000,
    starting: false,
  };
}

/**
 * Removes holds and logs each: as removed where `why` says why it went,
 * and otherwise only where it could not be.
 *
 * @param {State} state
 * @param {readonly string[]} names
 * @param {AbortSignal} signal
 * @param {string} [why]
 */
async function memoryHoldsGone(state, names, signal, why) {
  if (names.length === 0) return;
  let failed;
  try {
    failed = await memoryHoldsRemoved(
      { engine: state.seams.engine, signal },
      names,
    );
  } catch {
    failed = names.map((name) => ({
      name,
      why: "the engine did not answer in time",
    }));
  }
  const left = new Map(failed.map((each) => [each.name, each.why]));
  for (const name of names) {
    const cause = left.get(name);
    if (cause !== undefined)
      state.seams.log(`the hold ${name} was not removed: ${cause}`);
    else if (why !== undefined)
      state.seams.log(`the hold ${name}, ${why}, was removed`);
  }
}

/**
 * The engine's memory as a check or a pass counts it, the holds found
 * abandoned removed.
 *
 * @param {State} state
 * @param {AbortSignal} signal
 */
async function memoryCountedNow(state, signal) {
  const { counted, abandoned } = await memoryCounted({
    engine: state.seams.engine,
    name: state.settings.engine,
    holderAlive: state.seams.holderAlive ?? fileLockHolderAlive,
    nowMs: state.seams.nowMs,
    signal,
  });
  await memoryHoldsGone(
    state,
    abandoned,
    signal,
    "whose runner is no longer running or whose deadline has passed",
  );
  return counted;
}

/**
 * One check of a held job's room, under the memory lock: a count, the
 * decision, and, unless the job is too late to start, its hold made where the
 * count lists neither it nor a container of its assignment, since a job about
 * to start is counted by its hold as a held one is. A check that could not
 * take the lock or make the hold holds the job. One that finds its container
 * running counts its hold made, which then goes as any hold does.
 *
 * @param {State} state
 * @param {import("./memoryBudget.mjs").MemoryBudget} budget
 * @param {import("./memoryBudget.mjs").MemoryHold} hold
 * @returns {Promise<{made: boolean, decision: import("./memoryBudget.mjs").MemoryDecision}>}
 */
async function memoryChecked(state, budget, hold) {
  let made = false;
  try {
    const decision = await memoryLocked(budget.lockFile, async () => {
      const signal = globalThis.AbortSignal.timeout(memoryLockCallsMsMax);
      const counted = await memoryCountedNow(state, signal);
      const decided = memoryStartDecided(
        budget.bytesFree,
        counted,
        hold,
        state.seams.nowMs(),
      );
      if (
        decided.decided === "Running" ||
        (!("unknown" in counted) &&
          counted.holds.some(({ name }) => name === hold.name))
      )
        made = true;
      if (made || decided.decided === "Late") return decided;
      const starting = decided.decided === "Start";
      const answer = await state.seams.engine.exec(
        heldCreateArgv({ ...hold, starting }),
        { signal },
      );
      if (answer.code !== 0)
        return {
          decided: /** @type {const} */ ("Hold"),
          why: `its hold could not be made: ${engineFailureLine(answer)}`,
        };
      made = true;
      return decided;
    });
    return { made, decision };
  } catch (failure) {
    const why =
      failure instanceof Error && failure.name === "AbortError"
        ? "the engine did not answer in time"
        : failure instanceof Error
          ? failure.message
          : String(failure);
    return { made, decision: { decided: "Hold", why } };
  }
}

/**
 * Holds a job's memory as it is placed, before its images are pulled: one
 * check, which makes its hold, and what it decided kept for the start. A
 * session, or any workload where the runner keeps no budget, holds nothing.
 *
 * @param {State} state
 * @param {Placement} placement
 */
async function memoryPlaced(state, placement) {
  const budget = state.memory;
  if (budget === undefined || placement.kind !== "Job") return;
  const hold = memoryHoldOf(state, placement);
  const checked = await memoryChecked(state, budget, hold);
  if (checked.made) placement.holding = true;
  placement.memory = { hold, decision: checked.decision };
}

/**
 * Removes a placement's hold, where it is on the engine.
 *
 * @param {State} state
 * @param {Placement} placement
 */
async function memoryPlacementGone(state, placement) {
  if (placement.holding && placement.memory !== undefined)
    await memoryHoldsGone(
      state,
      [placement.memory.hold.name],
      globalThis.AbortSignal.timeout(memoryCountMsMax),
    );
  placement.holding = false;
}

/**
 * Runs `start` once the engine's memory has room for a job, where it holds
 * that memory: at once where its placement decided it starts, and otherwise
 * once a check, made under the memory lock at once and then every
 * `memoryHeldCheckMs`, does, until it is stopped or too near its deadline to
 * start. `start` is given what cuts it `memoryStartCutMs` short of the
 * deadline its hold carries, unless the job's container is already running,
 * when it starts nothing. A session starts as it would without a budget.
 *
 * @template T
 * @param {State} state
 * @param {Placement} placement
 * @param {(cut?: AbortSignal) => Promise<T>} start
 * @returns {Promise<T>}
 */
async function memoryStarted(state, placement, start) {
  const budget = state.memory;
  const { memory } = placement;
  if (budget === undefined || memory === undefined) return start();
  /** @type {import("./memoryBudget.mjs").MemoryDecision | undefined} */
  let decision =
    memory.decision.decided === "Hold" ? undefined : memory.decision;
  for (;;) {
    const signal = placementSignal(state, placement, memoryHeldLate);
    if (decision === undefined) {
      const checked = await memoryChecked(state, budget, memory.hold);
      if (checked.made) placement.holding = true;
      decision = checked.decision;
    }
    placement.controller.signal.throwIfAborted();
    if (decision.decided === "Running") {
      placement.phase = "Starting";
      placement.waiting = undefined;
      return await start();
    }
    const cutMs = memory.hold.untilMs - memoryStartCutMs - state.seams.nowMs();
    if (decision.decided === "Late" || cutMs <= 0)
      throw new Error(
        placement.phase === "Held"
          ? `${memoryHeldLate} by the assignment's deadline`
          : memoryStartLate,
      );
    if (decision.decided === "Start") {
      placement.phase = "Starting";
      placement.waiting = undefined;
      return await start(globalThis.AbortSignal.timeout(cutMs));
    }
    if (placement.phase !== "Held")
      state.seams.log(
        `${placement.name} is held for room on this engine: ${decision.why}`,
      );
    placement.phase = "Held";
    placement.waiting = decision.why;
    await state.seams.sleep(memoryHeldCheckMs, signal);
    decision = undefined;
  }
}

/**
 * The pass's count of the engine's memory, which `jobsTaken` answers from.
 * Each of this pool's holds that no placement of this runner's is making is
 * removed first, as one a runner before it left.
 *
 * @param {State} state
 */
async function memoryHeld(state) {
  const budget = state.memory;
  if (budget === undefined) return;
  const signal = globalThis.AbortSignal.timeout(memoryCountMsMax);
  let counted = await memoryCountedNow(state, signal);
  if (!("unknown" in counted)) {
    const pool = poolLabelValue(state.settings.pool);
    /** @param {import("./memoryBudget.mjs").MemoryHold} hold */
    const left = (hold) =>
      hold.pool === pool && !state.placements.has(hold.assignment);
    await memoryHoldsGone(
      state,
      counted.holds.filter(left).map(({ name }) => name),
      signal,
      "which no placement of this runner's makes",
    );
    counted = {
      ...counted,
      holds: counted.holds.filter((hold) => !left(hold)),
    };
  }
  const placing = [...state.placements.values()]
    .filter(({ holding }) => !holding)
    .reduce((sum, { memoryMib }) => sum + memoryMib * 2 ** 20, 0);
  memoryBudgetHeld(budget, counted, placing, state.seams.log);
}

/**
 * A placement's images, each as the assignment named it and with what it was
 * used as.
 *
 * @param {Placement} placement
 * @returns {import("./imageRecord.mjs").ImageUse[]}
 */
function placementImages(placement) {
  /** @param {string} reference */
  const pulledId = (reference) => {
    const id = placement.pulled.get(reference);
    return id === undefined ? {} : { pulledId: id };
  };
  return [
    {
      reference: placement.image,
      kind: placement.kind,
      ...pulledId(placement.image),
    },
    ...(placement.runtime === undefined
      ? []
      : [
          {
            reference: placement.runtime.image,
            kind: /** @type {const} */ ("Runtime"),
            ...pulledId(placement.runtime.image),
          },
        ]),
  ];
}

/**
 * Starts a placement, its images held in the record from before it looks for
 * them until its `run` has answered, when their use is recorded, whether or
 * not it started. Its hold on the engine's memory goes then too.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {WorkerPoolAssignment} assignment
 * @param {string} envelope
 */
async function placementRun(state, placement, assignment, envelope) {
  try {
    await state.images.held(
      placement.name,
      placementImages(placement).map(({ reference }) => reference),
      placement.deadlineEpochSecs * 1000,
    );
    try {
      await placementStarted(state, placement, assignment, envelope);
    } finally {
      await state.images.used(placement.name, placementImages(placement));
    }
  } finally {
    await memoryPlacementGone(state, placement);
  }
}

/**
 * The job's image here, then chuggy's runtime for its platform, copied into
 * the job's own volumes before the placement's turn at the runtime ends.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {PlacementRuntime} runtime
 */
async function runtimeReady(state, placement, runtime) {
  const platform = await jobImageHere(state, placement);
  const turnEnded = await runtimeHere(state, placement, runtime, platform);
  try {
    placement.controller.signal.throwIfAborted();
    placement.phase = "Starting";
    await runtimeFilled(state, placement, runtime, platform);
  } finally {
    turnEnded();
  }
}

/**
 * Gets what a placement starts from and starts it: the job's image first,
 * then, where the job starts through chuggy's runtime, that runtime for the
 * image's platform and the job's volumes of it, then its owner's volumes. A
 * job whose image and runtime both cannot be got is refused for its image,
 * since the runtime is got for the platform read from it. The runtime's
 * volumes are removed where the job did not start in them, as where a
 * predecessor's container was found already running the job, and where it
 * failed the container filling them goes first: a stop or the deadline ends
 * only the engine's CLI, and leaves that container holding them.
 *
 * @param {State} state
 * @param {Placement} placement
 * @param {WorkerPoolAssignment} assignment
 * @param {string} envelope
 */
async function placementStarted(state, placement, assignment, envelope) {
  const { runtime } = placement;
  let outcome;
  try {
    if (runtime === undefined) await imageHere(state, placement);
    else await runtimeReady(state, placement, runtime);
    placement.controller.signal.throwIfAborted();
    placement.phase = "Starting";
    if (placement.kind === "Job") await ownerVolumesReady(state, placement);
    outcome = await memoryStarted(state, placement, (cut) =>
      started(state, placement, assignment, envelope, cut),
    );
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
    return placement.phase === "Held"
      ? `was not started: ${memoryHeldLate} by the assignment's deadline`
      : "was not started: its image was not pulled by the assignment's deadline";
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
  const refusal = placementRefusal(state, assignment, kind);
  if (refusal !== undefined) return { placed: "Refused", evidence: refusal };
  const credential = await jobCredentialHanded(
    settings,
    assignment.capabilities,
    seams.tokenFileRefusal,
  );
  if ("refused" in credential)
    return { placed: "Refused", evidence: credential.refused };
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
  const volumes =
    kind === "Job"
      ? ownerVolumesServed(state.volumes, settings.pool, assignment.project)
      : undefined;
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
    memoryMib: assignment.memoryMib,
    runSecs: Math.min(assignment.deadlineSecs, bounds.timeoutSecsMax),
    memory: undefined,
    holding: false,
    credential,
    runtime:
      kind === "Job" && assignment.runtime !== undefined
        ? { image: assignment.runtime, made: [], volumes: undefined }
        : undefined,
    volumes: volumes?.served,
    pulled: new Map(),
    controller: new globalThis.AbortController(),
    done: Promise.resolve(),
  };
  state.placements.set(placement.assignment, placement);
  for (const source of volumes?.withheld ?? [])
    seams.log(
      `${placement.name}: its owner's volume ${ownerVolumeWithheldLine(source)}`,
    );
  await memoryPlaced(state, placement);
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
  /** @type {State} */
  const state = {
    settings: checked,
    seams,
    volumes: checked.volumes ?? [],
    placements: new Map(),
    ends: { pending: [], ready: [], accounted: new Set() },
    strays: true,
    images:
      checked.imageRecord === undefined
        ? imageCleanupNone
        : imageCleanup(
            {
              record: checked.imageRecord,
              unusedSecsMax:
                checked.imageUnusedSecsMax ?? imageUnusedSecsMaxDefault,
            },
            seams,
          ),
    logFailures: new Map(),
    disk: diskFloor(checked.diskFreeBytesMin, seams.diskFree),
    memory: memoryBudget(checked.memoryFreeBytesMin, checked.memoryLock, {
      bytesReserved: checked.memoryReservedBytes,
      claimLockFile: checked.memoryClaimLock,
    }),
    runtimeTurns: new Map(),
  };
  const claimLock = state.memory?.claimLockFile;
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
        memoryMib: placement.memoryMib,
        ...(placement.waiting === undefined
          ? {}
          : { waiting: placement.waiting }),
      })),
    containers: async () => (await poolContainers(state)).map(poolContainer),
    imagesReclaimed: (signal) => state.images.reclaimed(signal),
    jobsTaken: (byRoom = false) =>
      (state.disk?.jobsTaken ?? true) &&
      (state.memory === undefined || memoryBudgetTakes(state.memory, byRoom)),
    memoryRoom: () =>
      state.memory === undefined ? undefined : memoryRoom(state.memory),
    ...(claimLock === undefined
      ? {}
      : { claimed: () => memoryClaimTaken(claimLock) }),
    settled: async () => {
      await Promise.all(
        [...state.placements.values()].map((placement) => placement.done),
      );
      await state.images.settled();
    },
  };
}
