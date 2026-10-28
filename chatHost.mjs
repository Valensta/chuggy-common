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
 * with no room and nothing held as one that is not live. Its room is then
 * the least of its own ceiling and the supervisor's. A supervisor that could
 * not be started, or ended of itself, is started again no sooner than a
 * backoff after.
 *
 * THE SUPERVISOR'S CONTAINER IS ROOT WITH THE FEW CAPABILITIES IT NEEDS to
 * make each session's user, directories and mirrors and to drop to that
 * user, and gains none. The Claude credential is mounted read-only in a
 * directory only its owner opens, which the supervisor reads it as.
 */

import {
  workerCredentialFilesVariable,
  workerRepositoriesVariable,
} from "@chuggy/worker-contract/workerEnvironment";
import { z } from "zod";

import { chatHostBackend } from "./chatHostBackend.mjs";
import { chatMirrorsDirectory } from "./chatCheckout.mjs";
import { chatSessionsDirectory } from "./chatSession.mjs";
import {
  chatSupervisorSettings,
  chatSupervisorVariables,
} from "./chatSupervisor.mjs";
import { claudeCredentialCarried } from "./claudeCredential.mjs";
import { imageInspectArgv } from "./engineArgv.mjs";
import { engineFailure, engineFailureLine } from "./engineErrors.mjs";
import { jobRunDirectory } from "./job.mjs";
import { poolIdentityDigest } from "./poolIdentity.mjs";
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
 * @typedef {import("./engine.mjs").Engine} Engine
 * @typedef {import("./poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("./poolIdentity.mjs").ChatHostIdentity} ChatHostIdentity
 * @typedef {import("./poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("./poolLoop.mjs").WorkerPoolPass} WorkerPoolPass
 * @typedef {import("./poolLoop.mjs").WorkerPoolUpdates} WorkerPoolUpdates
 * @typedef {import("./registryAuth.mjs").PullSite} PullSite
 * @typedef {import("./runnerUpdate.mjs").RunnerIdentity} RunnerIdentity
 *
 * @typedef {z.infer<typeof chatHostImageSettingSchema>} ChatHostImageSetting
 *
 * @typedef {object} ChatSupervisorPlaces what a supervisor's container is given of this machine
 * @property {{sessions: string, mirrors: string}} volumes the engine's volumes its sessions' directories and its mirrors are kept in
 * @property {Readonly<Record<string, string>>} credentialFiles each credential a session may be handed, by its slot, as the path of its file on this machine
 * @property {{uid: number, gid: number}} credentialOwner who owns those files as the engine shows them inside a container
 * @property {ClaudeCredentialSetting} [claudeCredential] the kind of credential the Claude one is
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
 * @property {Readonly<Record<string, string>>} environment
 *
 * @typedef {object} ChatHostSettings
 * @property {number} sessionsMax the most sessions the host runs at once, whatever its supervisor's room
 * @property {number} idleSecs how long a session it claims may sit idle, which each poll names
 * @property {number} outputBytesMax what a session may write of its output
 * @property {ChatHostImageSetting} [image] the host's own image, run in place of the plane's
 * @property {ChatSupervisorPlaces} places
 *
 * @typedef {object} ChatHostSeams
 * @property {Engine} engine
 * @property {PullSite} site
 * @property {(container: ChatSupervisorContainer) => ChatSupervisorHandle | Promise<ChatSupervisorHandle>} started the supervisor run as `container` says
 * @property {(line: string) => void} log
 * @property {(assignment: string) => (line: string) => void} logFor
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} nowMs
 * @property {WorkerPoolClient["tokens"]} [tokens]
 * @property {typeof globalThis.fetch} [fetch] what every plane is reached by, when not the global fetch
 * @property {RunnerIdentity} [runner]
 * @property {WorkerPoolUpdates} [updates]
 *
 * @typedef {object} ChatHostStatus
 * @property {string | undefined} named the image the plane last named
 * @property {string | undefined} used the image the supervisor runs, or the last one started ran
 * @property {ChatHostImageSetting | undefined} own the host's own image, which it runs in place of the plane's
 * @property {import("./chatHostBackend.mjs").ChatSupervisorPhase} supervisor
 */

/** How long a session a host claims may sit idle, where its setting names nothing; the plane caps it. */
export const chatHostIdleSecs = 600;

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

/** Where each credential a session may be handed is mounted, in a directory only its owner opens. */
export const chatSupervisorCredentialsDirectory = `${jobRunDirectory}/credentials`;

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

/** A slot as a file's name in the credentials' directory. */
const chatSupervisorSlotPattern = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/u;

/** The host's own image, and when it is pulled: each time a supervisor starts, only where it is not here, or never. */
export const chatHostImageSettingSchema = z.strictObject({
  image: z.string().min(1).max(1024),
  pull: z.enum(["always", "missing", "never"]).default("missing"),
});

/** How long a supervisor started has to say it is ready, which takes it no more than opening its mirrors. */
const chatHostReadyWaitMs = 5 * 60 * 1000;

/** How long a supervisor whose input ended has to exit, above the grace each session it stops is given. */
const chatHostExitWaitMs = 60 * 1000;

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

/** The supervisor's counts as `places` names them, refused where the supervisor would refuse them or a session's user could own a credential. */
function chatSupervisorCounts(places) {
  const variables = places.variables ?? {};
  for (const name of Object.keys(variables))
    if (!chatSupervisorCountVariables.includes(name))
      throw new RangeError(
        `${name} is no count of the supervisor's a host may set`,
      );
  const settings = chatSupervisorSettings(variables);
  const { uid } = places.credentialOwner;
  if (uid >= settings.uidFirst && uid < settings.uidFirst + settings.uidCount)
    throw new RangeError(
      `the credentials' owner ${String(uid)} is among the users a session is run as`,
    );
  return variables;
}

/** Each credential's mount, refused where its slot is no file's name or its file no absolute path. */
function chatSupervisorCredentialMounts(places) {
  return Object.entries(places.credentialFiles).map(([slot, source]) => {
    if (!chatSupervisorSlotPattern.test(slot) || slot === "." || slot === "..")
      throw new RangeError(`${JSON.stringify(slot)} is no credential slot`);
    if (!source.startsWith("/"))
      throw new RangeError(`the ${slot} credential's file is no absolute path`);
    return {
      slot,
      source,
      target: `${chatSupervisorCredentialsDirectory}/${slot}`,
    };
  });
}

/**
 * The supervisor's container, for any engine to run: root with the
 * capabilities it needs and none to gain, its input held open, its
 * sessions' directories and mirrors in volumes of its own, its run directory
 * a tmpfs a session's user may pass through, and each credential bound
 * read-only into a tmpfs only that credential's owner opens.
 *
 * @param {string} image
 * @param {ChatSupervisorPlaces} places
 * @returns {ChatSupervisorContainer}
 */
export function chatSupervisorContainer(image, places) {
  const variables = chatSupervisorCounts(places);
  const mounts = chatSupervisorCredentialMounts(places);
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
    binds: mounts.map(({ source, target }) => ({ source, target })),
    environment: {
      ...variables,
      [workerCredentialFilesVariable]: JSON.stringify(
        Object.fromEntries(mounts.map(({ slot, target }) => [slot, target])),
      ),
      ...claudeCredentialCarried(places.claudeCredential),
      ...(places.repositories === undefined
        ? {}
        : { [workerRepositoriesVariable]: places.repositories }),
    },
  };
}

/** Whether the engine holds `image` now. */
async function chatHostImageHere(state, image) {
  const answer = await state.seams.engine.exec(imageInspectArgv(image));
  return answer.code === 0;
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
      (argv, environment) => seams.engine.exec(argv, { environment }),
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
    (argv, environment) => state.seams.engine.exec(argv, { environment }),
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

/** A supervisor started in `image` and spoken to, or why it was not, the next start put off. */
async function chatHostStarted(state, image) {
  const { seams } = state;
  try {
    await chatHostPulled(state, image);
    const handle = await seams.started(
      chatSupervisorContainer(image, state.settings.places),
    );
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
 * and one started where none runs, an image is wanted, and the backoff is
 * past. One that ended of itself puts the next start off by the backoff.
 */
async function chatHostFollowed(state, draining) {
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
    wanted === undefined ||
    draining ||
    state.seams.nowMs() < state.startableMs
  )
    return;
  await state.backend.closed();
  state.endSeen = false;
  state.drained = false;
  await chatHostStarted(state, wanted);
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
 * @param {ChatHostSettings} settings
 * @returns {ChatHostSettings}
 */
export function checkedChatHostSettings(settings) {
  for (const [name, bound] of /** @type {const} */ ([
    ["sessionsMax", settings.sessionsMax],
    ["idleSecs", settings.idleSecs],
    ["outputBytesMax", settings.outputBytesMax],
  ]))
    if (!Number.isSafeInteger(bound) || bound < 1)
      throw new RangeError(`chat host ${name} must be a positive integer`);
  const image =
    settings.image === undefined
      ? undefined
      : chatHostImageSettingSchema.parse(settings.image);
  chatSupervisorContainer("checked", settings.places);
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
  const checked = checkedChatHostSettings(settings);
  const backend = chatHostBackend(
    {
      outputBytesMax: checked.outputBytesMax,
      readyWaitMs: chatHostReadyWaitMs,
      exitWaitMs: chatHostExitWaitMs,
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
  };
  client.plane = chatHostPlane(state, client.plane);
  return {
    run: () => chatHostRun(state),
    status: () => ({
      named: state.named,
      used: state.used,
      own: checked.image,
      supervisor: backend.phase(),
    }),
  };
}

/**
 * One pass, with the room the supervisor has now: none until it is ready,
 * and then the least of the host's ceiling and the supervisor's; and
 * whether the next is to wait, which one with no room does unless it starts
 * a supervisor.
 *
 * @param {ChatHostState} state
 * @param {import("./poolLoop.mjs").WorkerPoolUpdating | undefined} updating
 */
async function chatHostPass(state, updating) {
  await chatHostFollowed(state, updating?.draining() ?? false);
  const ceiling = state.backend.ceiling();
  state.client.settings = {
    ...state.client.settings,
    sessionsMax: Math.min(state.settings.sessionsMax, ceiling),
  };
  const pass = await workerPoolClientPass(state.client, updating);
  const phase = state.backend.phase();
  const starting =
    (phase === "Absent" || phase === "Ended") &&
    chatHostWanted(state) !== undefined &&
    state.seams.nowMs() >= state.startableMs;
  return { pass, waiting: ceiling === 0 && !starting };
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
      if (waiting) await seams.sleep(chatHostUnreadyWaitMs);
      else if (pass.claim !== undefined)
        await seams.sleep(workerPoolClaimWaitMs);
    }
  } finally {
    await state.backend.closed();
  }
}
