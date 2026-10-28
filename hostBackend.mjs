/**
 * `WorkerPoolBackend` on this machine's host: a process of the worker core per
 * job that pins no image and names a platform this host is, run as the
 * runner's own user. `hostRoutedBackend` puts it beside a container backend,
 * which runs everything else.
 *
 * NOTHING ISOLATES A HOST JOB. It runs as its runner's user, reads what that
 * user can read and runs whatever its task asks with that user's rights. A
 * pool runs one only where its operator registered it with `--host`, which
 * its pool file then says, accepting that of every project it serves.
 *
 * WHAT IS RUNNING IS THIS PROCESS'S OWN. A host has no engine to read back, so
 * a restarted runner holds nothing its predecessor started: those jobs leave
 * `held`, their leases lapse and their attempts fail as a lost pod's do. Each
 * job runs in a process group of its own, which its end, a stop, its deadline
 * and the runner's own exit or signal kill whole. A runner killed outright,
 * by SIGKILL or the kernel, kills none: its jobs run on undeadlined until they
 * end, and the next start removes their directories.
 *
 * EACH JOB HAS A DIRECTORY OF ITS OWN, where a container has mounts: its
 * workspace, its home, its temporary files and the credentials it mints, as
 * `jobHostPlaces` names them. It inherits the runner's environment, then the
 * owner's and, where it reads Claude's credential, that credential's kind,
 * then the job's own places, and the directory goes when the job does. Any a
 * predecessor left are removed the first time `held` is asked.
 *
 * WHAT ENDED OF ITSELF IS NAMED ONCE, after `held` stopped naming it, with this
 * backend's own reason and never the job's output, which is written to the log
 * directory as it runs, can hold a secret, and is cut to its end as
 * `savedLog.mjs` bounds a saved log once the job ends. One this pool stopped
 * is never named.
 */

import { spawn as spawnDefault } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";

import { workerTaskVariable } from "@chuggy/worker-contract/workerEnvironment";

import { claudeCredentialCarried } from "./claudeCredential.mjs";
import { hostJobVariable } from "./coreRuntime.mjs";
import {
  jobClaudeAgent,
  jobCredentialFilesChecked,
  jobCredentialHanded,
  jobEnvelope,
  jobHostPlaces,
  reservedJobVariables,
} from "./job.mjs";
import { savedLogTrimmed } from "./savedLog.mjs";

/**
 * @typedef {import("@chuggy/worker-contract/workerPool").WorkerPoolAssignment} WorkerPoolAssignment
 * @typedef {import("./poolLoop.mjs").WorkerPoolBackend} WorkerPoolBackend
 * @typedef {import("./poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("./poolLoop.mjs").WorkerPoolEnded} WorkerPoolEnded
 * @typedef {import("./poolLoop.mjs").WorkerPoolHeld} WorkerPoolHeld
 * @typedef {import("./poolLoop.mjs").WorkerPoolPlacement} WorkerPoolPlacement
 * @typedef {import("./poolLoop.mjs").WorkerPoolStopped} WorkerPoolStopped
 * @typedef {import("./poolLoop.mjs").WorkerPoolWorkloadKind} WorkerPoolWorkloadKind
 * @typedef {import("node:child_process").ChildProcess} ChildProcess
 *
 * @typedef {object} HostBackendSettings
 * @property {readonly string[]} platforms the platform tokens this host is
 * @property {string} directory where each job's directory is made, this pool's alone
 * @property {string} logDir where each ended job's output is kept
 * @property {string} tokenFile the Claude credential file, which a job reads where it is unless it requires another agent `agentCredentialFiles` names
 * @property {import("./claudeCredential.mjs").ClaudeCredentialSetting} [claudeCredential] the kind of credential `tokenFile` is; none, and a job's core reads it as a subscription's token
 * @property {Readonly<Record<string, string>>} [agentCredentialFiles] the credential file of each agent but Claude, by the name its `Agent:` capability gives it, which a job requiring that agent reads in place of `tokenFile`; none, and such a job reads `tokenFile`
 * @property {number} timeoutSecsMax
 * @property {number} outputBytesMax
 * @property {Readonly<Record<string, string>>} environment the owner's, over the runner's own
 * @property {{cpuMillis: number, memoryMib: number}} machine
 * @property {string} [core] the worker core's entry; this core's own where absent
 *
 * @typedef {object} HostBackendSeams
 * @property {typeof spawnDefault} [spawn]
 * @property {(pid: number, signal: NodeJS.Signals) => void} [kill] signals a process group
 * @property {Readonly<Record<string, string | undefined>>} [environment] the runner's own, which a job inherits
 * @property {(onExit: () => void) => void} [atExit] runs `onExit` as the runner ends, `hostExitWatched` where absent
 * @property {(file: string, agent: string) => Promise<string | undefined>} tokenFileRefusal why a job cannot read the credential file, which is `agent`'s, or nothing
 * @property {(line: string) => void} log
 * @property {() => number} [nowMs]
 *
 * @typedef {object} HostJob
 * @property {string} assignment
 * @property {string} name what its log is kept under
 * @property {number} deadlineEpochSecs
 * @property {{assignment: string, callbackUrl: string, bearer: string}} attempt
 * @property {ChildProcess} child
 * @property {string} directory
 * @property {boolean} stopped whether this pool stopped it, whose end is then never named
 * @property {boolean} expired whether its deadline killed it
 * @property {boolean} reaped whether its group was killed once its process closed, after which nothing signals it
 * @property {Promise<void>} done settles once it has ended and its directory is gone
 *
 * @typedef {object} HostInFlight a job running on the host, as a runner's status names it beside its containers' placements
 * @property {string} assignment
 * @property {"Job"} kind
 * @property {string} name
 * @property {"host"} image
 * @property {"Running"} phase
 * @property {number} deadlineEpochSecs
 *
 * @typedef {WorkerPoolBackend & {
 *   holds: (assignment: string) => boolean,
 *   inFlight: () => HostInFlight[],
 *   settled: () => Promise<void>,
 * }} HostBackend
 *
 * @typedef {object} State
 * @property {HostBackendSettings} settings
 * @property {HostBackendSeams} seams
 * @property {typeof spawnDefault} spawn
 * @property {(pid: number, signal: NodeJS.Signals) => void} kill
 * @property {Readonly<Record<string, string | undefined>>} inherited
 * @property {string} core
 * @property {Map<string, HostJob>} jobs
 * @property {WorkerPoolEnded[]} pending ends `held` has not yet stopped naming
 * @property {WorkerPoolEnded[]} ready ends `ended` names next
 * @property {boolean} swept whether a predecessor's directories were removed
 */

/** How long a job asked to stop is given before its group is killed outright. */
export const hostStopGraceMs = 10_000;

/** The longest deadline a timer can hold, which bounds `timeoutSecsMax`. */
export const hostTimeoutSecsMax = Math.floor((2 ** 31 - 1) / 1000);

/** The variables a host job's places set, which the owner's environment may not name. */
const hostPlaceVariables = ["HOME", "TMPDIR"];

/** The variables a job is never handed from its runner's environment: the ones its core or its places set. */
const hostWithheldVariables = [...reservedJobVariables, ...hostPlaceVariables];

/**
 * The settings as given, or a throw naming what is wrong with them.
 *
 * @param {HostBackendSettings} settings
 */
export function checkedHostBackendSettings(settings) {
  if (settings.platforms.length === 0)
    throw new RangeError("a host backend runs on at least one platform");
  if (settings.timeoutSecsMax > hostTimeoutSecsMax)
    throw new RangeError(
      `a host job's timeout is at most ${String(hostTimeoutSecsMax)} seconds`,
    );
  claudeCredentialCarried(settings.claudeCredential);
  jobCredentialFilesChecked(settings);
  for (const platform of settings.platforms)
    if (!/^Platform:[A-Za-z0-9]+:[A-Za-z0-9]+$/u.test(platform))
      throw new RangeError(`${platform} is no platform token`);
  const named = hostEnvironmentRefusal(settings.environment);
  if (named !== undefined) throw new RangeError(named);
  return settings;
}

/**
 * Why an owner's environment cannot be a host job's, or nothing: it names a
 * variable the job's core or its places set.
 *
 * @param {Readonly<Record<string, string>>} environment
 * @returns {string | undefined}
 */
export function hostEnvironmentRefusal(environment) {
  const name = Object.keys(environment).find((each) =>
    hostWithheldVariables.includes(each),
  );
  return name === undefined
    ? undefined
    : `${name} is set for every host job, and the owner's environment cannot name it`;
}

/**
 * The platforms a pool runs work on its host: those of the host's operating
 * system it declared, where its operator registered it to, and none otherwise.
 * A chat host's credentials are refused, since a chat host runs no job.
 *
 * @param {Pick<PoolCredentials, "capabilities" | "host"> & {kind?: string}} credentials
 * @param {"Linux" | "MacOS"} operatingSystem the host's
 */
export function hostPlatformsDeclared(credentials, operatingSystem) {
  if (credentials.kind === "ChatHost")
    throw new RangeError(
      "a chat host runs no job, so its credentials run none on its host",
    );
  if (credentials.host !== true) return [];

  return credentials.capabilities.filter((capability) =>
    capability.startsWith(`Platform:${operatingSystem}:`),
  );
}

/**
 * Whether a job runs on this host: it pins no image, and names one of the
 * platforms the host is.
 *
 * @param {readonly string[]} platforms
 * @param {Pick<WorkerPoolAssignment, "image" | "capabilities">} assignment
 */
export function hostRuns(platforms, assignment) {
  return (
    assignment.image === undefined &&
    assignment.capabilities.some((capability) => platforms.includes(capability))
  );
}

/**
 * The name a job's log is kept under, which carries no part of its assignment
 * a reader of the directory could take for its bearer.
 *
 * @param {string} assignment
 */
export function hostJobName(assignment) {
  return `job-${createHash("sha256").update(assignment, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * Why this host will not take an assignment, its credential aside, or
 * nothing.
 *
 * @param {HostBackendSettings} settings
 * @param {WorkerPoolAssignment} assignment
 * @param {WorkerPoolWorkloadKind} kind
 * @returns {string | undefined}
 */
function hostRefusal(settings, assignment, kind) {
  if (kind !== "Job")
    return "a session runs in a container, never on its runner's host";
  if (assignment.image !== undefined)
    return "the assignment pins an image, which this host runs no job in";
  if (!hostRuns(settings.platforms, assignment))
    return `the assignment names no platform this host is, which is ${settings.platforms.join(" or ")}`;
  if (assignment.cpuMillis > settings.machine.cpuMillis)
    return `the assignment asks for ${String(assignment.cpuMillis)} CPU millis and this machine has ${String(settings.machine.cpuMillis)}`;
  if (assignment.memoryMib > settings.machine.memoryMib)
    return `the assignment asks for ${String(assignment.memoryMib)} MiB and this machine has ${String(settings.machine.memoryMib)}`;
  return undefined;
}

/**
 * The environment a host job starts with: the runner's, less what chuggy sets,
 * then the owner's, then the job's own.
 *
 * @param {Readonly<Record<string, string | undefined>>} inherited
 * @param {Readonly<Record<string, string>>} owned
 * @param {string} directory
 * @param {string} envelope
 * @returns {Record<string, string>}
 */
export function hostJobEnvironment(inherited, owned, directory, envelope) {
  /** @type {Record<string, string>} */
  const environment = {};
  for (const [name, value] of Object.entries(inherited))
    if (value !== undefined && !hostWithheldVariables.includes(name))
      environment[name] = value;
  const places = jobHostPlaces(directory);
  return {
    ...environment,
    ...owned,
    HOME: places.home,
    TMPDIR: join(directory, "tmp"),
    [hostJobVariable]: directory,
    [workerTaskVariable]: envelope,
  };
}

/**
 * Why a process ended, in this backend's words.
 *
 * @param {HostJob} job
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 */
function hostJobEndedWhy(job, code, signal) {
  if (job.expired) return "the job ran past its deadline and was killed";
  return signal === null
    ? `the job's process exited ${String(code)}`
    : `the job's process was killed by ${signal}`;
}

/**
 * Settles once a child has started, or throws why it could not.
 *
 * @param {ChildProcess} child
 * @returns {Promise<void>}
 */
function hostJobStarted(child) {
  return new Promise((started, failed) => {
    child.once("spawn", () => started());
    child.once("error", failed);
  });
}

/**
 * Signals a job's group, until it was killed as its process closed: the group
 * outlives its leader, and its id can be another's once the group is gone.
 *
 * @param {State} state
 * @param {HostJob} job
 * @param {NodeJS.Signals} signal
 */
function signalled(state, job, signal) {
  const { pid } = job.child;
  if (pid === undefined || job.reaped) return;
  try {
    state.kill(pid, signal);
  } catch {
    // The group has ended since.
  }
}

/**
 * Asks a job to end, kills its group once the grace runs out, and settles once
 * it has ended.
 *
 * @param {State} state
 * @param {HostJob} job
 */
async function hostJobEnded(state, job) {
  signalled(state, job, "SIGTERM");
  const outright = setTimeout(
    () => signalled(state, job, "SIGKILL"),
    hostStopGraceMs,
  );
  try {
    await job.done;
  } finally {
    clearTimeout(outright);
  }
}

/**
 * Removes a job's directory, making each directory in it writable where a
 * removal was refused, as a module cache's read-only tree is; or logs why it
 * could not, so that no job's end waits on it.
 *
 * @param {State} state
 * @param {string} directory
 */
async function hostDirectoryRemoved(state, directory) {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    try {
      await hostDirectoryWritable(directory);
      await rm(directory, { recursive: true, force: true });
    } catch (failure) {
      state.seams.log(
        `${directory} could not be removed: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
  }
}

/**
 * Makes a directory and every directory under it its owner's to change,
 * each before it is read.
 *
 * @param {string} directory
 */
async function hostDirectoryWritable(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory())
      await hostDirectoryWritable(join(directory, entry.name));
}

/**
 * Removes the job directories no job of this run holds, which a predecessor
 * left.
 *
 * @param {State} state
 */
async function hostSwept(state) {
  state.swept = true;
  const held = new Set([...state.jobs.values()].map((job) => job.directory));
  let names;
  try {
    names = await readdir(state.settings.directory);
  } catch {
    return;
  }
  for (const name of names) {
    const directory = join(state.settings.directory, name);
    if (!held.has(directory)) await hostDirectoryRemoved(state, directory);
  }
}

/**
 * A job's own directory, made with every place in it, and the envelope that
 * names them and the credential file it reads; or why the assignment makes
 * none, its directory gone.
 *
 * @param {State} state
 * @param {WorkerPoolAssignment} assignment
 * @param {string} credentialFile
 * @returns {Promise<{directory: string, envelope: string} | {refused: string}>}
 */
async function hostJobDirectory(state, assignment, credentialFile) {
  const { settings } = state;
  await mkdir(settings.directory, { recursive: true, mode: 0o700 });
  await mkdir(settings.logDir, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(settings.directory, "job-"));
  const places = jobHostPlaces(directory);
  try {
    const envelope = jobEnvelope(
      assignment,
      {
        timeoutSecsMax: settings.timeoutSecsMax,
        outputBytesMax: settings.outputBytesMax,
      },
      {
        workspace: places.workspace,
        providerCredentialFile: credentialFile,
      },
    );
    for (const place of [...Object.values(places), join(directory, "tmp")])
      await mkdir(place, { mode: 0o700 });
    return { directory, envelope };
  } catch (failure) {
    await rm(directory, { recursive: true, force: true });
    return { refused: /** @type {Error} */ (failure).message };
  }
}

/**
 * The core started in a job's directory, its output to the job's log; or
 * nothing where it could not start, its directory gone and why logged.
 *
 * @param {State} state
 * @param {string} name
 * @param {{directory: string, envelope: string}} made
 * @param {string} agent whose credential file the job reads
 * @returns {Promise<{child: ChildProcess, log: import("node:fs/promises").FileHandle} | undefined>}
 */
async function hostJobSpawned(state, name, made, agent) {
  const log = await open(
    join(state.settings.logDir, `${name}.log`),
    "a",
    0o600,
  );
  try {
    const child = state.spawn(globalThis.process.execPath, [state.core], {
      cwd: made.directory,
      detached: true,
      env: hostJobEnvironment(
        state.inherited,
        {
          ...state.settings.environment,
          ...(agent === jobClaudeAgent
            ? claudeCredentialCarried(state.settings.claudeCredential)
            : {}),
        },
        made.directory,
        made.envelope,
      ),
      stdio: ["ignore", log.fd, log.fd],
    });
    await hostJobStarted(child);
    return { child, log };
  } catch (failure) {
    await log.close();
    await hostDirectoryRemoved(state, made.directory);
    state.seams.log(
      `${name} could not start: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
    return undefined;
  }
}

/**
 * Watches a started job: its deadline kills it, and its end kills what is left
 * of its group, removes its directory and, unless this pool stopped it, is
 * named.
 *
 * @param {State} state
 * @param {HostJob} job
 * @param {string} name
 * @param {import("node:fs/promises").FileHandle} log
 * @param {number} deadlineSecs
 */
function hostJobWatched(state, job, name, log, deadlineSecs) {
  const deadline = setTimeout(() => {
    job.expired = true;
    void hostJobEnded(state, job);
  }, deadlineSecs * 1000);
  job.done = new Promise((settle) => {
    job.child.once("close", (code, signal) => {
      clearTimeout(deadline);
      signalled(state, job, "SIGKILL");
      job.reaped = true;
      void (async () => {
        try {
          await log.close().catch(() => undefined);
          await savedLogTrimmed(
            join(state.settings.logDir, `${name}.log`),
          ).catch((failure) =>
            state.seams.log(
              `${name}: its log could not be cut to its end: ${failure instanceof Error ? failure.message : String(failure)}`,
            ),
          );
          await hostDirectoryRemoved(state, job.directory);
        } finally {
          if (state.jobs.get(job.assignment) === job)
            state.jobs.delete(job.assignment);
          if (!job.stopped) {
            const why = hostJobEndedWhy(job, code, signal);
            state.seams.log(`${name} ended: ${why}`);
            state.pending.push({
              kind: "Job",
              job: job.attempt,
              why,
              ...(job.expired ? { killed: "Deadline" } : {}),
            });
          }
          settle();
        }
      })();
    });
  });
}

/**
 * @param {State} state
 * @param {WorkerPoolAssignment} assignment
 * @param {WorkerPoolWorkloadKind} kind
 * @returns {Promise<WorkerPoolPlacement>}
 */
async function hostPlaced(state, assignment, kind) {
  const { settings, seams } = state;
  if (state.jobs.has(assignment.assignment)) return { placed: "Placed" };
  const refusal = hostRefusal(settings, assignment, kind);
  if (refusal !== undefined) return { placed: "Refused", evidence: refusal };
  const credential = await jobCredentialHanded(
    settings,
    assignment.capabilities,
    seams.tokenFileRefusal,
  );
  if ("refused" in credential)
    return { placed: "Refused", evidence: credential.refused };
  const made = await hostJobDirectory(state, assignment, credential.file);
  if ("refused" in made) return { placed: "Refused", evidence: made.refused };
  const name = hostJobName(assignment.assignment);
  const started = await hostJobSpawned(state, name, made, credential.agent);
  if (started === undefined) return { placed: "Unavailable" };
  const deadlineSecs = Math.min(
    assignment.deadlineSecs,
    settings.timeoutSecsMax,
  );
  /** @type {HostJob} */
  const job = {
    assignment: assignment.assignment,
    name,
    deadlineEpochSecs:
      Math.floor((seams.nowMs ?? Date.now)() / 1000) + deadlineSecs,
    attempt: {
      assignment: assignment.assignment,
      callbackUrl: assignment.callbackUrl,
      bearer: assignment.bearer,
    },
    child: started.child,
    directory: made.directory,
    stopped: false,
    expired: false,
    reaped: false,
    done: Promise.resolve(),
  };
  hostJobWatched(state, job, name, started.log, deadlineSecs);
  state.jobs.set(job.assignment, job);
  return { placed: "Placed" };
}

/**
 * @param {State} state
 * @param {string} assignment
 * @returns {Promise<WorkerPoolStopped>}
 */
async function hostStopped(state, assignment) {
  const job = state.jobs.get(assignment);
  if (job === undefined) return { stopped: "Stopped" };
  job.stopped = true;
  await hostJobEnded(state, job);
  return { stopped: "Stopped" };
}

/**
 * @param {State} state
 * @returns {Promise<WorkerPoolHeld[]>}
 */
async function hostHeld(state) {
  if (!state.swept) await hostSwept(state);
  state.ready.push(...state.pending.splice(0));
  return [...state.jobs.keys()].map((assignment) => ({
    assignment,
    kind: "Job",
  }));
}

/**
 * Runs `onExit` as this process exits, or as a SIGTERM, SIGINT or SIGHUP ends it: a
 * signal's default end emits no exit, and a host job's group is its own, so
 * neither a service manager nor a terminal reaches it. A runner that handles
 * the signal itself still does; one that does not is ended by it as before.
 *
 * @param {() => void} onExit
 * @param {Pick<NodeJS.Process, "once" | "prependOnceListener" | "listenerCount" | "kill" | "pid">} [process]
 */
export function hostExitWatched(onExit, process = globalThis.process) {
  process.once("exit", onExit);
  for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]))
    process.prependOnceListener(signal, () => {
      onExit();
      if (process.listenerCount(signal) === 0)
        process.kill(process.pid, signal);
    });
}

/**
 * @param {HostBackendSettings} settings
 * @param {HostBackendSeams} seams
 * @returns {HostBackend}
 */
export function hostBackend(settings, seams) {
  /** @type {State} */
  const state = {
    settings: checkedHostBackendSettings(settings),
    seams,
    spawn: seams.spawn ?? spawnDefault,
    kill:
      seams.kill ?? ((pid, signal) => globalThis.process.kill(-pid, signal)),
    inherited: seams.environment ?? globalThis.process.env,
    core:
      settings.core ??
      fileURLToPath(new URL("./entrypoint.mjs", import.meta.url)),
    jobs: new Map(),
    pending: [],
    ready: [],
    swept: false,
  };
  (seams.atExit ?? hostExitWatched)(() => {
    for (const job of state.jobs.values()) signalled(state, job, "SIGKILL");
  });
  return {
    place: /** @type {WorkerPoolBackend["place"]} */ (
      /**
       * @param {WorkerPoolAssignment} assignment
       * @param {WorkerPoolWorkloadKind} kind
       */
      (assignment, kind) => hostPlaced(state, assignment, kind)
    ),
    stop: (assignment) => hostStopped(state, assignment),
    held: () => hostHeld(state),
    ended: async () => state.ready.splice(0),
    holds: (assignment) => state.jobs.has(assignment),
    inFlight: () =>
      [...state.jobs.values()].map((job) => ({
        assignment: job.assignment,
        kind: /** @type {const} */ ("Job"),
        name: job.name,
        image: /** @type {const} */ ("host"),
        phase: /** @type {const} */ ("Running"),
        deadlineEpochSecs: job.deadlineEpochSecs,
      })),
    settled: async () => {
      await Promise.all([...state.jobs.values()].map((job) => job.done));
    },
  };
}

/**
 * A container backend with a host beside it: a job that pins no image and
 * names a platform the host is runs there, and every other workload in a
 * container. What either holds, is placing or ended is read of both, and the
 * container backend's own reads are kept.
 *
 * @template {WorkerPoolBackend & {inFlight: () => readonly unknown[], settled: () => Promise<void>}} Container
 * @param {Container} container
 * @param {HostBackend} host
 * @param {readonly string[]} platforms the host's, as its settings name them
 * @returns {Container}
 */
export function hostRoutedBackend(container, host, platforms) {
  return {
    ...container,
    place: /** @type {WorkerPoolBackend["place"]} */ (
      /**
       * @param {WorkerPoolAssignment} assignment
       * @param {WorkerPoolWorkloadKind} kind
       */
      (assignment, kind) =>
        kind === "Job" && hostRuns(platforms, assignment)
          ? host.place(assignment, kind)
          : container.place(/** @type {never} */ (assignment), kind)
    ),
    stop: (assignment) =>
      host.holds(assignment)
        ? host.stop(assignment)
        : container.stop(assignment),
    held: async () => [...(await container.held()), ...(await host.held())],
    ended: async () => [...(await container.ended()), ...(await host.ended())],
    inFlight: () => [...container.inFlight(), ...host.inFlight()],
    settled: async () => {
      await Promise.all([container.settled(), host.settled()]);
    },
  };
}
