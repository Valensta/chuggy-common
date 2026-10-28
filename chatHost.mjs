/**
 * A member's chat host: the pool loop over `./chatHostBackend.mjs`, with the
 * supervisor it speaks to started in the session image, and started again
 * when that image changes. Each CLI brings its engine, its service manager
 * and the way a container is run from `chatSupervisorContainer`'s spec.
 *
 * THE IMAGE IS THE ONE THE PLANE NAMES, unless the host's own setting names
 * one, which is then the only one it runs and is never replaced by the
 * plane's. A poll's answer names it, so the host polls before it has a
 * supervisor, asking for no session and for an answer at once, and starts
 * one once an image is named. An image the plane names is pulled under the
 * pool's token where it is in the pool's registry; the host's own is pulled
 * as the engine's own login pulls it, as its setting says. While what is
 * named and what runs differ, the supervisor running is drained, taking no
 * session more, and once it has exited one is started in the image named.
 *
 * UNTIL A SUPERVISOR IS READY THE HOST HAS NO ROOM, and its polls name none
 * and ask for an answer at once, a short wait apart: a plane takes a host
 * with no room and nothing held as one that is not live. A start never holds
 * them up: an image is pulled and a supervisor readied beside them, and none
 * is started before the sessions of the one before are named. Its room is
 * then the least of its own ceiling and the supervisor's. A supervisor that
 * could not be started, or ended of itself, is started again no sooner than
 * a backoff after.
 *
 * THE SUPERVISOR'S CONTAINER IS ROOT WITH THE FEW CAPABILITIES IT NEEDS to
 * make each session's user, directories and mirrors and to drop to that
 * user, and gains none. Its memory is capped at room for each session the
 * host runs at once, with no swap past it, and it is named for its host, so
 * none is started beside another. The Claude credential's directory is
 * mounted read-only in one only the credential's owner opens, and the
 * supervisor is told that owner, which it reads the credential as.
 *
 * THE CREDENTIAL'S DIRECTORY IS BOUND, NOT ITS FILE. A file bound alone stays
 * the file that was there when the container started, so a credential
 * renewed by being replaced, as most writers renew a file, is never seen by
 * a supervisor started before it; its directory shows each renewal, however
 * it was written. The supervisor can read whatever else that directory
 * holds, so a CLI refuses a credential that is not alone in it, as
 * `chatCredentialAloneRefusal` says.
 */

import { spawn as spawnDefault } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { posix } from "node:path";
import process from "node:process";

import { chatProtocolVersion } from "@chuggy/worker-contract/chatHost";
import { workerRepositoriesVariable } from "@chuggy/worker-contract/workerEnvironment";
import { z } from "zod";

import { chatHostBackend, chatSupervisorPhases } from "./chatHostBackend.mjs";
import {
  chatMirrorGroupCount,
  chatMirrorGroupFirst,
  chatMirrorsDirectory,
} from "./chatCheckout.mjs";
import {
  chatSessionClearWaitMs,
  chatSessionStopGraceMs,
  chatSessionSweepPauseMs,
  chatSessionSweepsMax,
  chatSessionUidCount,
  chatSessionUidFirst,
  chatSessionsDirectory,
} from "./chatSession.mjs";
import {
  chatSupervisorProtocolRefusal,
  chatSupervisorProtocolVariable,
  chatSupervisorSettings,
  chatSupervisorVariables,
} from "./chatSupervisor.mjs";
import { claudeCredentialCarried } from "./claudeCredential.mjs";
import { controlAsked } from "./control.mjs";
import {
  chatSupervisorRunArgv,
  imageInspectArgv,
  killArgv,
  removeArgv,
} from "./engineArgv.mjs";
import { engineFailure, engineFailureLine } from "./engineErrors.mjs";
import { jobRunDirectory } from "./job.mjs";
import { memoryRoomMibMin } from "./memoryBudget.mjs";
import { poolIdentityDigest, poolLabelValue } from "./poolIdentity.mjs";
import {
  workerPoolClaimWaitMs,
  workerPoolClientPass,
  workerPoolUpdating,
} from "./poolLoop.mjs";
import { poolRunnerClient, poolRunnerPassLine } from "./poolRunner.mjs";
import { imageRegistryHost, registryPull } from "./registryAuth.mjs";

/**
 * @typedef {import("./chatHostBackend.mjs").ChatHostBackend} ChatHostBackend
 * @typedef {import("./chatHostBackend.mjs").ChatSupervisorHandle} ChatSupervisorHandle
 * @typedef {import("./claudeCredential.mjs").ClaudeCredentialSetting} ClaudeCredentialSetting
 * @typedef {import("./control.mjs").ControlBackend} ControlBackend
 * @typedef {import("./engine.mjs").Engine} Engine
 * @typedef {import("./engineArgv.mjs").ChatSupervisorNaming} ChatSupervisorNaming
 * @typedef {import("./engineArgv.mjs").EngineName} EngineName
 * @typedef {import("./poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("./poolIdentity.mjs").ChatHostIdentity} ChatHostIdentity
 * @typedef {import("./poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("./poolLoop.mjs").WorkerPoolPass} WorkerPoolPass
 * @typedef {import("./poolLoop.mjs").WorkerPoolUpdates} WorkerPoolUpdates
 * @typedef {import("./registryAuth.mjs").PullSite} PullSite
 * @typedef {import("./runnerUpdate.mjs").RunnerIdentity} RunnerIdentity
 *
 * @typedef {z.infer<typeof chatHostImageSettingSchema>} ChatHostImageSetting
 * @typedef {z.infer<typeof chatHostConfigSchema>} ChatHostConfig
 * @typedef {z.infer<typeof chatHostStatusSchema>} ChatHostStatus
 *
 * @typedef {object} ChatSupervisorPlaces what a supervisor's container is given of this machine
 * @property {{sessions: string, mirrors: string}} volumes the engine's volumes its sessions' directories and its mirrors are kept in
 * @property {string} credentialFile the Claude credential's file on this machine, whose directory the supervisor is given whole, and which each session is handed under whatever slot its task names
 * @property {{uid: number, gid: number}} credentialOwner who owns that file as the engine shows it inside a container, which the supervisor reads it as and no session's user may be
 * @property {ClaudeCredentialSetting} [claudeCredential] the kind of credential it is
 * @property {string} [repositories] the site's map of the repositories a session may reach, as `CHUG_WORKER_REPOSITORIES` carries it
 * @property {Readonly<Record<string, string>>} [variables] the supervisor's own counts, by the `CHUG_CHAT_` name of each
 *
 * @typedef {object} ChatSupervisorContainer what a supervisor's container is, for any engine to run
 * @property {string} image
 * @property {readonly string[]} command run as the image's entrypoint
 * @property {string} user
 * @property {{drop: readonly string[], add: readonly string[]}} capabilities
 * @property {readonly string[]} securityOptions
 * @property {true} interactive its input held open, which is the host's stream to it
 * @property {readonly {volume: string, target: string}[]} volumes
 * @property {readonly {target: string, mode: number, uid: number, gid: number, sizeBytes: number, flags: readonly string[]}[]} tmpfs in the order they are mounted, each beneath the one before it
 * @property {readonly {source: string, target: string}[]} binds each read-only
 * @property {number} memoryBytes the most memory it may take, swap included
 * @property {Readonly<Record<string, string>>} environment
 *
 * @typedef {object} ChatHostSettings
 * @property {number} sessionsMax the most sessions the host runs at once, whatever its supervisor's room
 * @property {number} sessionMemoryBytes the memory its supervisor is given for each of those
 * @property {number} idleSecs how long a session it claims may sit idle, which each poll names
 * @property {number} outputBytesMax what a session may write of its output
 * @property {ChatHostImageSetting} [image] the host's own image, run in place of the plane's
 * @property {ChatSupervisorPlaces} places
 *
 * @typedef {object} ChatHostSeams
 * @property {Engine} engine
 * @property {PullSite} site
 * @property {(container: ChatSupervisorContainer, engineName: EngineName) => ChatSupervisorHandle | Promise<ChatSupervisorHandle>} started the supervisor run as `container` says, on the engine `site` names
 * @property {(line: string) => void} log
 * @property {(assignment: string) => (line: string) => void} logFor
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} nowMs
 * @property {WorkerPoolClient["tokens"]} [tokens]
 * @property {typeof globalThis.fetch} [fetch] what every plane is reached by, when not the global fetch
 * @property {RunnerIdentity} [runner]
 * @property {WorkerPoolUpdates} [updates]
 */

/** How long a session a host claims may sit idle, where its setting names nothing; the plane caps it. */
export const chatHostIdleSecs = 600;

/** The most sessions a host runs at once, where its setting names no other. */
export const chatHostSessionsMaxDefault = 4;

/** The memory a host's supervisor is given for each session it runs at once, where its setting names no other. */
export const chatSessionMemoryBytesDefault = 2 * 2 ** 30;

/** The least memory a setting may give a session: the least a job is claimed into. */
const chatSessionMemoryBytesMin = memoryRoomMibMin * 2 ** 20;

/**
 * What every uid a session is run as, and every gid a session or a mirror
 * has, lies below, which an engine that maps ids must map from 0 without a
 * gap.
 */
export const chatSessionIdsNeeded = Object.freeze({
  uids: chatSessionUidFirst + chatSessionUidCount,
  gids: Math.max(
    chatSessionUidFirst + chatSessionUidCount,
    chatMirrorGroupFirst + chatMirrorGroupCount,
  ),
});

/** The supervisor as its image runs it, under the image's own init, which reaps what a session leaves. */
export const chatSupervisorCommand = Object.freeze([
  "/opt/chuggy/bin/tini",
  "-s",
  "--",
  "/opt/chuggy/bin/node",
  "/opt/chuggy/lib/chuggy/chatSupervisor.mjs",
]);

/**
 * What the supervisor needs as root: owning and opening each session's
 * directories and mirrors whoever made them, keeping a mirror's group on
 * what is made in it, which a mirror whose group root is not in loses
 * without `FSETID`, and dropping to a session's user, its groups and none
 * of its own capabilities.
 */
export const chatSupervisorCapabilities = Object.freeze([
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "SETUID",
  "SETGID",
  "SETPCAP",
]);

/** Where the credential's directory is mounted, in one only its owner opens. */
export const chatSupervisorCredentialsDirectory = `${jobRunDirectory}/credentials`;
const chatSupervisorCredentialDirectory = `${chatSupervisorCredentialsDirectory}/provider`;

/** What the supervisor's run directory and its credentials' may hold, which is minted credentials and mount points. */
const chatSupervisorRunBytesMax = 64 * 1024 * 1024;
const chatSupervisorCredentialsBytesMax = 1024 * 1024;

/** The supervisor's counts a host may set; its places are its container's and never moved. */
const chatSupervisorCountVariables = [
  chatSupervisorVariables.uidFirst,
  chatSupervisorVariables.uidCount,
  chatSupervisorVariables.sessionsMax,
  chatSupervisorVariables.groupFirst,
  chatSupervisorVariables.groupCount,
];

/** The host's own image, and when it is pulled: each time a supervisor starts, only where it is not here, or never. */
export const chatHostImageSettingSchema = z.strictObject({
  image: z.string().min(1).max(1024),
  pull: z.enum(["always", "missing", "never"]).default("missing"),
});

const chatHostPositiveSchema = z.number().int().positive().safe();

/**
 * A member's chat host's own settings as a runner's file holds them, each
 * absent one a default, as `chatHostConfigured` gives them.
 */
export const chatHostConfigSchema = z.strictObject({
  /** The image its supervisor runs in place of the one chuggy names, and when it is pulled. */
  image: chatHostImageSettingSchema.optional(),
  /** The most sessions it runs at once, whatever its supervisor's room. */
  sessionsMax: chatHostPositiveSchema.optional(),
  /** The memory, in MiB, its supervisor is given for each of those. */
  sessionMemoryMib: chatHostPositiveSchema
    .min(memoryRoomMibMin)
    .max(Math.floor(Number.MAX_SAFE_INTEGER / 2 ** 20))
    .optional(),
  /** How long a session it claims may sit idle, which chuggy caps. */
  idleSecs: chatHostPositiveSchema.optional(),
  /** The most output a session may report; the runner's own where absent. */
  outputBytesMax: chatHostPositiveSchema.optional(),
});

/** What a host's door says of it, as `chatHostStatusAsked` reads it. */
export const chatHostStatusSchema = z.object({
  /** The image the plane last named. */
  named: z.string().optional(),
  /** The image the supervisor runs, or the last one started ran. */
  used: z.string().optional(),
  /** The host's own image, which it runs in place of the plane's. */
  own: chatHostImageSettingSchema.optional(),
  supervisor: z.enum(chatSupervisorPhases),
  /** Whether a supervisor is being started: its image pulled, or its Ready awaited. */
  starting: z.boolean(),
});

/** How long a supervisor started has to say it is ready, which takes it no more than opening its mirrors. */
const chatHostReadyWaitMs = 5 * 60 * 1000;

/** How long a supervisor whose input ended has to exit, above the grace each session it stops is given. */
const chatHostExitWaitMs = 60 * 1000;

/**
 * How long a supervisor has to end a session it was told to stop: the
 * session's grace, the sweep of its user once that has passed, and the
 * bound on its clear, each as the supervisor gives it, above which is room
 * for what neither bounds, such as giving up a preparation and telling the
 * end. Killing a supervisor ends every session it runs, so this errs long.
 */
export const chatHostStopWaitMs =
  chatSessionStopGraceMs +
  chatSessionSweepsMax * chatSessionSweepPauseMs +
  chatSessionClearWaitMs +
  60_000;

/** The wait between polls of a host with no room, which ask for an answer at once. */
export const chatHostUnreadyWaitMs = 5_000;

/** The least time between starts of a supervisor, after one that failed or ended of itself. */
export const chatHostRestartBackoffMs = 30_000;

/**
 * The volumes a host's supervisor keeps its sessions' directories and its
 * mirrors in, named for the host so no other's shares them.
 *
 * @param {ChatHostIdentity} identity
 */
export function chatHostVolumes(identity) {
  const digest = poolIdentityDigest(identity);
  return {
    sessions: `chuggy-chat-${digest}-sessions`,
    mirrors: `chuggy-chat-${digest}-mirrors`,
  };
}

/** The supervisor's counts as `places` names them, refused where one is no count a host may set. */
function chatSupervisorCounts(places) {
  const variables = places.variables ?? {};
  for (const name of Object.keys(variables))
    if (!chatSupervisorCountVariables.includes(name))
      throw new RangeError(
        `${name} is no count of the supervisor's a host may set`,
      );
  return variables;
}

/**
 * The credential's mount, its directory bound where the supervisor finds
 * it: refused where its file is no absolute path written plainly, or its
 * directory the root.
 *
 * @param {string} file
 */
function chatSupervisorCredentialMount(file) {
  if (!file.startsWith("/") || posix.normalize(file) !== file)
    throw new RangeError(
      "the credential's file is no absolute path written plainly",
    );
  const source = posix.dirname(file);
  if (source === "/" || file.endsWith("/"))
    throw new RangeError("the credential's file is in no directory of its own");
  return {
    source,
    target: chatSupervisorCredentialDirectory,
    file: `${chatSupervisorCredentialDirectory}/${posix.basename(file)}`,
  };
}

/** The supervisor's environment, refused wherever the supervisor would refuse it. */
function chatSupervisorEnvironment(places, mount) {
  const names = chatSupervisorVariables;
  const environment = {
    [chatSupervisorProtocolVariable]: String(chatProtocolVersion),
    ...chatSupervisorCounts(places),
    [names.credential]: mount.file,
    [names.credentialUid]: String(places.credentialOwner.uid),
    [names.credentialGid]: String(places.credentialOwner.gid),
    ...claudeCredentialCarried(places.claudeCredential),
    ...(places.repositories === undefined
      ? {}
      : { [workerRepositoriesVariable]: places.repositories }),
  };
  const refused = chatSupervisorProtocolRefusal(environment);
  if (refused !== undefined) throw new RangeError(refused);
  chatSupervisorSettings(environment);
  return environment;
}

/**
 * The supervisor's container, for any engine to run: root with the
 * capabilities it needs and none to gain, its input held open, its memory
 * `memoryBytes`, its sessions' directories and mirrors in volumes of its
 * own, its run directory a tmpfs a session's user may pass through, and the
 * credential's directory bound read-only into a tmpfs only the credential's
 * owner opens.
 *
 * @param {string} image
 * @param {ChatSupervisorPlaces} places
 * @param {number} memoryBytes
 * @returns {ChatSupervisorContainer}
 */
export function chatSupervisorContainer(image, places, memoryBytes) {
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1)
    throw new RangeError("a supervisor's memory must be a positive integer");
  const mount = chatSupervisorCredentialMount(places.credentialFile);
  const environment = chatSupervisorEnvironment(places, mount);
  const flags = ["nosuid", "nodev", "noexec"];
  const { uid, gid } = places.credentialOwner;
  return {
    image,
    command: chatSupervisorCommand,
    user: "0:0",
    capabilities: { drop: ["ALL"], add: chatSupervisorCapabilities },
    securityOptions: ["no-new-privileges"],
    interactive: true,
    volumes: [
      { volume: places.volumes.sessions, target: chatSessionsDirectory },
      { volume: places.volumes.mirrors, target: chatMirrorsDirectory },
    ],
    tmpfs: [
      {
        target: jobRunDirectory,
        mode: 0o711,
        uid: 0,
        gid: 0,
        sizeBytes: chatSupervisorRunBytesMax,
        flags,
      },
      {
        target: chatSupervisorCredentialsDirectory,
        mode: 0o700,
        uid,
        gid,
        sizeBytes: chatSupervisorCredentialsBytesMax,
        flags,
      },
    ],
    binds: [{ source: mount.source, target: mount.target }],
    memoryBytes,
    environment,
  };
}

/**
 * The supervisor's container's name, one per host as its volumes are, so a
 * second is never started beside a first.
 *
 * @param {ChatHostIdentity} identity
 */
export function chatSupervisorName(identity) {
  return `chuggy-chat-${poolIdentityDigest(identity)}`;
}

/**
 * What a host's supervisor's container is called and carries: its name, its
 * host's pool label, and `network`, which it joins.
 *
 * @param {ChatHostIdentity} identity
 * @param {string} network
 * @returns {ChatSupervisorNaming}
 */
export function chatSupervisorNaming(identity, network) {
  return {
    name: chatSupervisorName(identity),
    label: poolLabelValue(identity),
    network,
  };
}

/**
 * @typedef {object} ChatSupervisorRunSeams
 * @property {Engine} engine the CLI the host's site names, which runs the supervisor too
 * @property {ChatSupervisorNaming} naming
 * @property {typeof spawnDefault} [spawn] what starts the engine's `run`, when not Node's own
 */

/**
 * What starts the supervisor, as `ChatHostSeams.started`: the engine's `run`
 * as a child of this process, its standard streams the supervisor's, once a
 * container of its name that has exited is removed, which a run the engine
 * did not see end leaves behind. A container of its name that is not
 * removed, one still running among them, refuses the start, and is never
 * killed for it. The supervisor has exited once the child has, or could not
 * start. A kill ends the child and asks the engine to kill the container,
 * which a client's end alone does not. The engine is the one the host's
 * site names, which its settings were checked against.
 *
 * @param {ChatSupervisorRunSeams} seams
 * @returns {ChatHostSeams["started"]}
 */
export function chatSupervisorStarted(seams) {
  const { engine, naming } = seams;
  const spawn = seams.spawn ?? spawnDefault;
  return async (container, engineName) => {
    const { argv, environment } = chatSupervisorRunArgv(
      engineName,
      container,
      naming,
    );
    const removed = await engine.exec(removeArgv(naming.name));
    if (removed.code !== 0 && engineFailure(removed) !== "NoSuchContainer")
      throw new Error(
        `the container ${naming.name} is still there, and no supervisor is started beside it: ${engineFailureLine(removed)}`,
      );
    const child = spawn(engineName, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...environment },
    });
    const exited = new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    });
    return {
      input: child.stdin,
      output: child.stdout,
      errors: child.stderr,
      exited,
      kill: () => {
        child.kill("SIGKILL");
        engine.exec(killArgv(naming.name)).catch(() => undefined);
      },
    };
  };
}

/** Whether the engine holds `image` now. */
async function chatHostImageHere(state, image) {
  const answer = await state.seams.engine.exec(imageInspectArgv(image), {
    cut: state.cut.signal,
  });
  return answer.code === 0;
}

/** Runs one engine call of a pull, cut short once the host ends. */
function chatHostPullRun(state) {
  return (argv, environment) =>
    state.seams.engine.exec(argv, { environment, cut: state.cut.signal });
}

/**
 * An image of the plane's pulled, for the engine's own platform: under the
 * pool's token where it is in the pool's registry, once more under a fresh one
 * where that was refused, and otherwise as the engine's own login pulls it.
 */
async function chatHostNamedPulled(state, image) {
  const { seams } = state;
  const host = imageRegistryHost(image);
  if (host !== state.registryHost) return chatHostPullMade(state, image);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const acquired = await state.client.tokens.acquire();
    if (acquired.acquired !== "Token")
      throw new Error(
        `the pool has no token to pull ${image} with: ${acquired.evidence}`,
      );
    const answer = await registryPull(
      seams.site,
      image,
      undefined,
      { host, token: acquired.token },
      chatHostPullRun(state),
    );
    if (answer.code === 0) return undefined;
    if (engineFailure(answer) !== "Unauthorized" || attempt > 0)
      throw new Error(
        `${image} could not be pulled: ${engineFailureLine(answer)}`,
      );
    state.client.tokens.invalidate(acquired.token);
  }
  return undefined;
}

/** An image pulled as the engine's own login pulls it, for its own platform. */
async function chatHostPullMade(state, image) {
  const answer = await registryPull(
    state.seams.site,
    image,
    undefined,
    undefined,
    chatHostPullRun(state),
  );
  if (answer.code !== 0)
    throw new Error(
      `${image} could not be pulled: ${engineFailureLine(answer)}`,
    );
}

/** The image a supervisor is about to start in, here: the host's own as its setting says, the plane's where it is not here. */
async function chatHostPulled(state, image) {
  const own = state.settings.image;
  if (own === undefined)
    return (await chatHostImageHere(state, image))
      ? undefined
      : chatHostNamedPulled(state, image);
  if (own.pull === "always") return chatHostPullMade(state, image);
  if (await chatHostImageHere(state, image)) return undefined;
  if (own.pull === "never")
    throw new Error(
      `${image} is not here, and the host's setting pulls it never`,
    );
  return chatHostPullMade(state, image);
}

/** The image the host is to run: its own, or the one the plane last named. */
function chatHostWanted(state) {
  return state.settings.image?.image ?? state.named;
}

/**
 * A supervisor started in `image` and spoken to, or why it was not, the next
 * start put off; none is started once the host ends, and one whose start
 * outlasted the host is killed, its input ended with its failure to end
 * taken, since one already gone answers that end with an error.
 */
async function chatHostStarted(state, image) {
  const { seams } = state;
  try {
    await chatHostPulled(state, image);
    if (state.cut.signal.aborted) return;
    const handle = await seams.started(
      chatSupervisorContainer(
        image,
        state.settings.places,
        chatHostMemoryBytes(state.settings),
      ),
      seams.site.engine,
    );
    if (state.cut.signal.aborted) {
      handle.input.on("error", () => undefined);
      handle.input.end();
      handle.kill();
      return;
    }
    const answer = await state.backend.attached(handle);
    if ("refused" in answer)
      throw new Error(`its supervisor was not ready: ${answer.refused}`);
    state.used = image;
    seams.log(`the supervisor runs ${image}`);
  } catch (failure) {
    state.startableMs = seams.nowMs() + chatHostRestartBackoffMs;
    seams.log(
      `the supervisor did not start in ${image}: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }
}

/**
 * The supervisor brought to the image wanted: one running another drained,
 * and one started where none ran as the pass began, so the sessions of the
 * one before are named first, none is starting, an image is wanted, and the
 * backoff is past. One that ended of itself puts the next start off by the
 * backoff. A start runs beside the passes, which go on polling while an
 * image is pulled and a supervisor readies.
 */
function chatHostFollowed(state, draining, idle) {
  if (state.starting !== undefined) return;
  const wanted = chatHostWanted(state);
  const phase = state.backend.phase();
  if (phase === "Ready" && wanted !== undefined && wanted !== state.used) {
    state.seams.log(
      `the session image is now ${wanted}; the supervisor running ${String(state.used)} is drained`,
    );
    state.backend.drain();
    state.drained = true;
    return;
  }
  if (phase === "Ended" && !state.endSeen) {
    state.endSeen = true;
    if (!state.drained)
      state.startableMs = state.seams.nowMs() + chatHostRestartBackoffMs;
  }
  if (
    (phase !== "Absent" && phase !== "Ended") ||
    !idle ||
    wanted === undefined ||
    draining ||
    state.cut.signal.aborted ||
    state.seams.nowMs() < state.startableMs
  )
    return;
  state.endSeen = false;
  state.drained = false;
  state.starting = (async () => {
    await state.backend.closed();
    await chatHostStarted(state, wanted);
  })().finally(() => {
    state.starting = undefined;
  });
}

/**
 * The plane a pass polls: asking for an answer at once while the host has
 * no room, and keeping the image each answer names.
 *
 * @param {ChatHostState} state
 * @param {WorkerPoolClient["plane"]} plane
 * @returns {WorkerPoolClient["plane"]}
 */
function chatHostPlane(state, plane) {
  return {
    ...plane,
    poll: async (token, held, wanted, wantedSessions, terms = {}) => {
      const polled = await plane.poll(
        token,
        held,
        wanted,
        wantedSessions,
        state.backend.ceiling() > 0 ? terms : { ...terms, waitSecs: 0 },
      );
      if (polled.polled === "Reconciled" && polled.chatImage !== undefined) {
        if (polled.chatImage !== state.named)
          state.seams.log(
            `the plane names the session image ${polled.chatImage}`,
          );
        state.named = polled.chatImage;
      }
      return polled;
    },
  };
}

/**
 * The memory a host's supervisor is capped at: room for each session the
 * host runs at once.
 *
 * @param {Pick<ChatHostSettings, "sessionsMax" | "sessionMemoryBytes">} settings
 */
export function chatHostMemoryBytes(settings) {
  return settings.sessionsMax * settings.sessionMemoryBytes;
}

/**
 * A host's settings from its section of a runner's file, each it does not
 * name its default, and its output bound the runner's where it names none.
 *
 * @param {ChatHostConfig | undefined} config as `chatHostConfigSchema` parsed it
 * @param {number} outputBytesMax the runner's own
 * @returns {Omit<ChatHostSettings, "places">}
 */
export function chatHostConfigured(config, outputBytesMax) {
  const { image, sessionsMax, sessionMemoryMib, idleSecs } = config ?? {};
  return {
    sessionsMax: sessionsMax ?? chatHostSessionsMaxDefault,
    sessionMemoryBytes:
      sessionMemoryMib === undefined
        ? chatSessionMemoryBytesDefault
        : sessionMemoryMib * 2 ** 20,
    idleSecs: idleSecs ?? chatHostIdleSecs,
    outputBytesMax: config?.outputBytesMax ?? outputBytesMax,
    ...(image === undefined ? {} : { image }),
  };
}

/**
 * `settings`, refused where a supervisor could not be started from them,
 * on `engineName` too where one is named, so a container that engine
 * cannot run is refused before any start.
 *
 * @param {ChatHostSettings} settings
 * @param {EngineName} [engineName]
 * @returns {ChatHostSettings}
 */
export function checkedChatHostSettings(settings, engineName) {
  for (const [name, bound] of /** @type {const} */ ([
    ["sessionsMax", settings.sessionsMax],
    ["sessionMemoryBytes", settings.sessionMemoryBytes],
    ["idleSecs", settings.idleSecs],
    ["outputBytesMax", settings.outputBytesMax],
  ]))
    if (!Number.isSafeInteger(bound) || bound < 1)
      throw new RangeError(`chat host ${name} must be a positive integer`);
  if (settings.sessionMemoryBytes < chatSessionMemoryBytesMin)
    throw new RangeError(
      `chat host sessionMemoryBytes must be at least ${String(chatSessionMemoryBytesMin)}`,
    );
  const image =
    settings.image === undefined
      ? undefined
      : chatHostImageSettingSchema.parse(settings.image);
  const container = chatSupervisorContainer(
    "checked",
    settings.places,
    chatHostMemoryBytes(settings),
  );
  if (engineName !== undefined)
    chatSupervisorRunArgv(engineName, container, {
      name: "checked",
      label: "checked",
      network: "checked",
    });
  return { ...settings, ...(image === undefined ? {} : { image }) };
}

/**
 * @typedef {object} ChatHostState
 * @property {ChatHostSettings} settings
 * @property {ChatHostSeams} seams
 * @property {ChatHostBackend} backend
 * @property {WorkerPoolClient} client
 * @property {string | undefined} registryHost
 * @property {string | undefined} named
 * @property {string | undefined} used
 * @property {number} startableMs
 * @property {boolean} endSeen
 * @property {boolean} drained
 * @property {Promise<void> | undefined} starting a supervisor's start, while one runs
 * @property {AbortController} cut aborted once the host ends, which cuts a pull short and starts nothing more
 *
 * @typedef {object} ChatHost
 * @property {() => Promise<Extract<WorkerPoolPass, {passed: "Denied" | "Updated"}>>} run passes until the plane denies the host or its runner has updated itself, its supervisor ended after
 * @property {() => ChatHostStatus} status
 */

/**
 * A member's chat host from its pool file, speaking to no supervisor until
 * it runs.
 *
 * @param {PoolCredentials} credentials
 * @param {ChatHostSettings} settings
 * @param {ChatHostSeams} seams
 * @returns {ChatHost}
 */
export function chatHost(credentials, settings, seams) {
  const checked = checkedChatHostSettings(settings, seams.site.engine);
  const backend = chatHostBackend(
    {
      outputBytesMax: checked.outputBytesMax,
      readyWaitMs: chatHostReadyWaitMs,
      exitWaitMs: chatHostExitWaitMs,
      stopWaitMs: chatHostStopWaitMs,
    },
    { log: seams.log, logFor: seams.logFor },
  );
  const client = poolRunnerClient(
    credentials,
    backend,
    { concurrencyMax: 0, sessionsMax: checked.sessionsMax },
    {
      ...(seams.tokens === undefined ? {} : { tokens: seams.tokens }),
      ...(seams.fetch === undefined
        ? {}
        : { fetch: seams.fetch, planeFetch: seams.fetch }),
      ...(seams.runner === undefined ? {} : { runner: seams.runner }),
      idleSecs: checked.idleSecs,
    },
  );
  /** @type {ChatHostState} */
  const state = {
    settings: checked,
    seams,
    backend,
    client,
    registryHost: credentials.registryHost,
    named: undefined,
    used: undefined,
    startableMs: 0,
    endSeen: false,
    drained: false,
    starting: undefined,
    cut: new globalThis.AbortController(),
  };
  client.plane = chatHostPlane(state, client.plane);
  return {
    run: () => chatHostRun(state),
    status: () => ({
      named: state.named,
      used: state.used,
      own: checked.image,
      supervisor: backend.phase(),
      starting: state.starting !== undefined,
    }),
  };
}

/**
 * One pass, with the room the supervisor has now: none until it is ready,
 * and then the least of the host's ceiling and the supervisor's; and
 * whether the next is to wait, which one with no room does. The sessions
 * that ended are named and the plane polled before the supervisor is
 * followed to the image the poll names, so neither waits on a start.
 *
 * @param {ChatHostState} state
 * @param {import("./poolLoop.mjs").WorkerPoolUpdating | undefined} updating
 */
async function chatHostPass(state, updating) {
  const before = state.backend.phase();
  const ceiling = state.backend.ceiling();
  state.client.settings = {
    ...state.client.settings,
    sessionsMax: Math.min(state.settings.sessionsMax, ceiling),
  };
  const pass = await workerPoolClientPass(state.client, updating);
  chatHostFollowed(
    state,
    updating?.draining() ?? false,
    before === "Absent" || before === "Ended",
  );
  return { pass, waiting: ceiling === 0 };
}

/**
 * The pool loop until the plane denies the host, or its runner has
 * installed the release it updates itself to, after which its supervisor is
 * ended, stopping every session it runs.
 *
 * @param {ChatHostState} state
 */
async function chatHostRun(state) {
  const { seams } = state;
  const updating =
    seams.updates === undefined
      ? undefined
      : workerPoolUpdating(seams.updates, {
          log: seams.log,
          nowMs: seams.nowMs,
        });
  try {
    for (;;) {
      const { pass, waiting } = await chatHostPass(state, updating);
      if (pass.passed === "Updated") return pass;
      if (pass.passed === "Denied") {
        seams.log(`the plane denied this chat host: ${pass.evidence}`);
        return pass;
      }
      if (pass.passed === "Unavailable") {
        seams.log(`outage: ${pass.evidence}`);
        await seams.sleep(state.client.settings.outageBackoffMs);
        continue;
      }
      if (pass.placed + pass.stopped + pass.refused + pass.ended > 0)
        seams.log(poolRunnerPassLine(pass));
      if (waiting) await chatHostUnready(state);
      else if (pass.claim !== undefined)
        await seams.sleep(workerPoolClaimWaitMs);
    }
  } finally {
    state.cut.abort();
    await state.backend.closed();
    await state.starting;
    await state.backend.closed();
  }
}

/** The wait of a host with no room, which a start that settles ends sooner. */
async function chatHostUnready(state) {
  const slept = state.seams.sleep(chatHostUnreadyWaitMs);
  await (state.starting === undefined
    ? slept
    : Promise.race([slept, state.starting]));
}

/**
 * What a host's service's door answers of it: its status, to `chatStatus`;
 * nothing it is placing, since it places no container; and a refusal of
 * every stop, since a session is stopped in chuggy.
 *
 * @param {ChatHost} chat
 * @returns {ControlBackend}
 */
export function chatHostControl(chat) {
  return {
    inFlight: () => [],
    stop: async () => ({
      refused: "a chat host's sessions are stopped in chuggy",
    }),
    chatStatus: () => chat.status(),
  };
}

/**
 * What the host's service at the door `path` says of it, or nothing where no
 * service answers there; one that answers no chat host's status is refused.
 *
 * @param {string} path
 * @returns {Promise<ChatHostStatus | undefined>}
 */
export async function chatHostStatusAsked(path) {
  const answered = await controlAsked(path, { op: "chatStatus" });
  if (answered === undefined) return undefined;
  const parsed = z
    .object({ chatStatus: chatHostStatusSchema })
    .safeParse(answered);
  if (!parsed.success)
    throw new Error(`the service at ${path} answered no chat host's status`);
  return parsed.data.chatStatus;
}

/**
 * Why the credential's file cannot be handed to a supervisor, which is given
 * its directory whole, or nothing: it is a link, which leads nowhere inside
 * the container, or its directory cannot be read or holds anything else,
 * which the supervisor could then read. Only names are read.
 *
 * @param {string} file
 * @returns {Promise<string | undefined>}
 */
export async function chatCredentialAloneRefusal(file) {
  const directory = posix.dirname(file);
  let entries;
  try {
    if ((await lstat(file)).isSymbolicLink())
      return `the credential ${file} is a link, and a chat host's supervisor is handed its directory, where a link out of it leads nowhere; name the file itself`;
    entries = await readdir(directory);
  } catch (failure) {
    return `the credential ${file} or its directory cannot be read: ${failure instanceof Error ? failure.message : String(failure)}`;
  }
  const others = entries.filter((entry) => entry !== posix.basename(file));
  if (others.length === 0) return undefined;
  return `${directory} holds ${others.slice(0, 3).join(", ")}${others.length > 3 ? " and more" : ""} beside the credential ${file}, and a chat host's supervisor is handed the directory whole; keep the credential in a directory of its own`;
}
