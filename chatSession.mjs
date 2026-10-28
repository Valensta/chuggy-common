/**
 * A chat supervisor's sessions, each prepared and run as a user of its own in
 * the member's chat container, where the supervisor is root.
 *
 * A SESSION IS ITS USER. Each is given the lowest user of the supervisor's
 * range no other session holds, as its group too, and everything it is handed
 * is that user's alone: a directory under `sessionsRoot` its workspace, home
 * and temporary files are in, a directory under `mintedRoot` its credentials
 * are written to, and the tree the supervisor checked out for it. The one
 * other group it is given is the mirror's its tree borrows from
 * (`./chatCheckout.mjs`). It is started without capabilities, unable to gain
 * any, under a bound on its processes, with a umask that keeps what it makes
 * its own, and with an environment that carries none of the supervisor's
 * secrets: its bearer crosses on its channel (`./chatChannel.mjs`).
 *
 * ITS PROVIDER CREDENTIAL IS READ AGAIN FOR EACH SESSION, from the file the
 * supervisor's credential map names for the task's slot, as that file's own
 * owner, so a credential renewed in place is the next session's and the
 * supervisor reads nothing its owner could not. It is checked as the session
 * would check it and copied into the session's minted directory, where only
 * the session reads it; every kind that names a file names the copy.
 *
 * A STOP ENDS THE CHANNEL AND THEN THE USER. The session is given
 * `stopGraceMs` to end its turn as a plane's stop ends one; then every process
 * of its user is killed, as its user, which reaches what it left running in
 * the background and nothing of any other session's. Its deadline is a stop
 * that ends it `Failed`.
 *
 * NOTHING OF A SESSION OUTLIVES IT. Once its process has exited its user's
 * processes are killed, its directories emptied as that user and removed, and
 * only then is the user free for another session and the end told. A user
 * whose directories could not be removed is not given out again.
 */

import { execFile, spawn as spawnDefault } from "node:child_process";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  workerCredentialFilesVariable,
  workerRepositoriesVariable,
  workerWorkspaceVariable,
} from "@chuggy/worker-contract/workerEnvironment";

import {
  chatChannelDescriptor,
  chatChannelLine,
  chatChannelVariable,
  chatCheckoutCarried,
  chatCheckoutVariable,
  chatLineReader,
  chatMintedVariable,
} from "./chatChannel.mjs";
import { chatAbortable } from "./chatCheckout.mjs";
import { claudeCredentialPrepared } from "./claude.mjs";
import { claudeCredentialVariable } from "./claudeCredential.mjs";
import {
  workerImageSteeringVariables,
  workerImageVariable,
} from "./checks.mjs";
import { jobPidsMax, jobRunDirectory } from "./job.mjs";
import { poolSessionPhase } from "./poolSessionPlane.mjs";
import { credentialScrub } from "./runEvidence.mjs";

const executeFile = promisify(execFile);

/** The first user a session is run as. */
export const chatSessionUidFirst = 20_000;

/** How many users follow it, which is the most sessions a supervisor runs at once. */
export const chatSessionUidCount = 32;

/** Where each session's own directory is made. */
export const chatSessionsDirectory = "/sessions";

/** Where each session's own minted directory is made. */
export const chatSessionsMintedDirectory = join(jobRunDirectory, "sessions");

/** Where the supervisor writes what it mints for a checkout, which no session reads. */
export const chatSupervisorMintedDirectory = join(
  jobRunDirectory,
  "supervisor",
);

/** The least free space `sessionsRoot` is to have before a session is prepared on it. */
export const chatSessionFreeBytesMin = 2 * 2 ** 30;

/** How long a session asked to stop is given before its user's processes are killed. */
export const chatSessionStopGraceMs = 10_000;

/** The core's own entrypoint, which a session is started as. */
export const chatSessionEntrypoint = fileURLToPath(
  new URL("./entrypoint.mjs", import.meta.url),
);

/** The longest line of a session's output kept, which is a bound on what one line costs the supervisor. */
const chatSessionLineBytesMax = 16 * 1024;

/** The largest provider credential file read. */
const chatSessionCredentialBytesMax = 1024 * 1024;

/** How often a session's user is swept before its processes are taken to be past killing. */
const chatSessionSweepsMax = 16;

/** How long a sweep waits for what it killed to go before it looks again. */
const chatSessionSweepPauseMs = 50;

/** The longest a timer holds. */
const chatTimerMsMax = 2 ** 31 - 1;

/** What a session's directories are made with: its user's alone. */
const chatSessionDirectoryMode = 0o700;

/** What the roots the sessions' directories are in are made with: entered by anyone, listed by their owner alone. */
const chatSessionsRootMode = 0o711;

/** What a session's copy of its provider credential is made with. */
const chatSessionCredentialMode = 0o400;

/** The name of that copy in its minted directory. */
const chatSessionCredentialName = "provider-credential";

/** The variables of the supervisor's own a session is handed, none a secret. */
const chatSessionPassedVariables = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  claudeCredentialVariable,
  workerRepositoriesVariable,
  ...workerImageSteeringVariables.map(workerImageVariable),
];

/**
 * The program, and its arguments, that runs `command` as `uid` and its own
 * group, with `groups` beside it or none, with no capability and none to gain.
 */
export function chatSessionAsUser(uid, groups, command) {
  return [
    "setpriv",
    `--reuid=${String(uid)}`,
    `--regid=${String(uid)}`,
    groups.length === 0
      ? "--clear-groups"
      : `--groups=${groups.map(String).join(",")}`,
    "--inh-caps=-all",
    "--bounding-set=-all",
    "--no-new-privs",
    "--",
    ...command,
  ];
}

/**
 * What a session's process is: the core in its session mode, run as the
 * session's user under the bound on its processes, making nothing another
 * user reads.
 */
export function chatSessionCommand(settings, uid, groups) {
  return [
    "prlimit",
    `--nproc=${String(jobPidsMax)}`,
    "--",
    ...chatSessionAsUser(uid, groups, [
      "/bin/sh",
      "-c",
      'umask 077 && exec "$@"',
      "sh",
      settings.node,
      settings.entrypoint,
    ]),
  ];
}

/** Every process of `uid` but a zombie, read from `/proc`. */
export async function chatUserProcesses(uid) {
  const held = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    let status;
    try {
      status = await readFile(join("/proc", name, "status"), "utf8");
    } catch {
      continue;
    }
    const ids = /^Uid:\s+(.*)$/mu.exec(status)?.[1]?.split(/\s+/u) ?? [];
    if (/^State:\s+Z/mu.test(status)) continue;
    if (ids.includes(String(uid))) held.push(Number(name));
  }
  return held;
}

/**
 * The system a supervisor prepares sessions on, as root on Linux: every way
 * it touches users, files and processes, so a suite can stand in for it.
 */
export function chatSystem({ spawn = spawnDefault } = {}) {
  const asUser = (uid, command, options = {}) => {
    const [program, ...args] = chatSessionAsUser(uid, [], command);
    return executeFile(program, args, options);
  };
  return {
    spawn,
    freeBytes: async (path) => {
      const measured = await statfs(path);
      return measured.bavail * measured.bsize;
    },
    rootMade: async (path, mode) => {
      await mkdir(path, { recursive: true, mode });
      await chown(path, 0, 0);
      await chmod(path, mode);
    },
    made: async (path, uid) => {
      await mkdir(path, { mode: chatSessionDirectoryMode });
      await chown(path, uid, uid);
      await chmod(path, chatSessionDirectoryMode);
    },
    listed: async (path) =>
      Promise.all(
        (await readdir(path)).map(async (name) => ({
          path: join(path, name),
          uid: (await lstat(join(path, name))).uid,
        })),
      ),
    credentialRead: async (path) => {
      const { uid } = await stat(path);
      const { stdout } = await asUser(uid, ["cat", "--", path], {
        maxBuffer: chatSessionCredentialBytesMax,
      });
      return stdout;
    },
    credentialWritten: async (path, text, uid) => {
      await writeFile(path, text, {
        mode: chatSessionCredentialMode,
        flag: "wx",
      });
      await chown(path, uid, uid);
    },
    swept: async (uid) => {
      for (let sweep = 0; sweep < chatSessionSweepsMax; sweep += 1) {
        if ((await chatUserProcesses(uid)).length === 0) return;
        await asUser(uid, ["/bin/sh", "-c", "kill -9 -1"]).catch(
          () => undefined,
        );
        await new Promise((resolve) =>
          globalThis.setTimeout(resolve, chatSessionSweepPauseMs),
        );
      }
      throw new Error(`the processes of user ${String(uid)} outlived a sweep`);
    },
    emptied: async (path, uid) => {
      await asUser(uid, [
        "/bin/sh",
        "-c",
        'chmod -R u+rwX -- "$1"; find "$1" -mindepth 1 -delete',
        "sh",
        path,
      ]);
      await rmdir(path);
    },
    removed: (path) => rm(path, { recursive: true, force: true }),
  };
}

/**
 * A session's places: its user, its directory and the ones in it, its minted
 * directory, and the supervisor's for its checkout.
 */
function chatSessionPlace(settings, uid) {
  const id = `session-${String(uid)}`;
  const workspace = join(settings.sessionsRoot, id);
  return {
    id,
    uid,
    workspace,
    home: join(workspace, "home"),
    temporary: join(workspace, "tmp"),
    minted: join(settings.mintedRoot, id),
    checkoutMinted: join(settings.supervisorMinted, id),
    made: [],
  };
}

/** The lowest user no session holds, now held. */
function chatSessionUid(state) {
  const { uidFirst, uidCount } = state.settings;
  for (let uid = uidFirst; uid < uidFirst + uidCount; uid += 1)
    if (!state.held.has(uid)) {
      state.held.add(uid);
      return uid;
    }
  throw new Error("every user a session may be run as is held");
}

/**
 * Everything of a session's gone, its user free again where it all went, and
 * held for good where some of it did not.
 */
async function chatSessionCleared(state, place) {
  const { system, log } = state;
  let cleared = true;
  const attempt = async (what, step) => {
    try {
      await step();
    } catch (failure) {
      cleared = false;
      log(
        `[${place.id}] ${what} failed: ${failure instanceof Error ? failure.message : String(failure)}\n`,
      );
    }
  };
  await attempt("the sweep of its processes", () => system.swept(place.uid));
  for (const path of [place.workspace, place.minted])
    if (place.made.includes(path))
      await attempt(`the removal of ${path}`, () =>
        system.emptied(path, place.uid),
      );
  await attempt(`the removal of ${place.checkoutMinted}`, () =>
    system.removed(place.checkoutMinted),
  );
  if (cleared) state.held.delete(place.uid);
  else log(`[${place.id}] its user is not given out again\n`);
}

/** The directories a session is prepared in, made as its user's. */
async function chatSessionDirectories(state, place) {
  const { system } = state;
  for (const path of [place.workspace, place.home, place.temporary]) {
    await system.made(path, place.uid);
    place.made.push(path);
  }
  await system.made(place.minted, place.uid);
  place.made.push(place.minted);
  await system.rootMade(place.checkoutMinted, chatSessionDirectoryMode);
}

/**
 * The session's copy of the provider credential the supervisor's map names
 * for `slot`, read as its file's owner and checked as the session will check
 * it, and every secret it holds.
 */
async function chatSessionCredential(state, slot, place) {
  const files = JSON.parse(
    state.settings.environment[workerCredentialFilesVariable] ?? "{}",
  );
  const path = files[slot];
  if (typeof path !== "string")
    throw new Error(`the session credential ${slot} is not mounted`);
  const text = await state.system.credentialRead(path);
  const file = join(place.minted, chatSessionCredentialName);
  const prepared = claudeCredentialPrepared(text.trim(), {
    path: file,
    environment: state.settings.environment,
  });
  await state.system.credentialWritten(file, text, place.uid);
  return { file, secrets: [text.trim(), ...prepared.secrets] };
}

/** What a session's process is started with of the supervisor's environment and its own places. */
function chatSessionEnvironment(state, place, checkout) {
  const inherited = state.settings.environment;
  return {
    ...Object.fromEntries(
      chatSessionPassedVariables.flatMap((name) =>
        inherited[name] === undefined ? [] : [[name, inherited[name]]],
      ),
    ),
    HOME: place.home,
    TMPDIR: place.temporary,
    [workerWorkspaceVariable]: place.workspace,
    [chatChannelVariable]: String(chatChannelDescriptor),
    [chatMintedVariable]: place.minted,
    [chatCheckoutVariable]: chatCheckoutCarried(checkout),
  };
}

/** Each line `stream` carries, scrubbed and named for its session, on the supervisor's log. */
function chatSessionOutput(state, place, stream, scrub) {
  const lines = chatLineReader(chatSessionLineBytesMax, {
    line: (bytes) => state.log(`[${place.id}] ${scrub(bytes.toString())}\n`),
    overlong: () =>
      state.log(`[${place.id}] a line too long to keep was dropped\n`),
  });
  stream.on("data", (chunk) => lines.push(chunk));
  stream.on("end", () => lines.end());
}

/**
 * The session's process, once it has started: `stop` asks it to end, and
 * `ended` is the phase it ended in, once nothing of it is left.
 */
function chatSessionRunning(state, place, child, launch) {
  const channel = child.stdio[chatChannelDescriptor];
  channel.on("error", () => undefined);
  child.on("error", () => undefined);
  channel.write(chatChannelLine(launch.envelope));
  chatSessionOutput(state, place, child.stdout, launch.scrub);
  chatSessionOutput(state, place, child.stderr, launch.scrub);
  let stopping = false;
  let expired = false;
  let grace;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    channel.end();
    grace = globalThis.setTimeout(() => {
      state.system.swept(place.uid).catch(() => undefined);
    }, state.settings.stopGraceMs);
  };
  const deadline = globalThis.setTimeout(
    () => {
      expired = true;
      stop();
    },
    Math.min(launch.envelope.timeoutSecsMax * 1_000, chatTimerMsMax),
  );
  const ended = new Promise((resolve) => {
    child.once("exit", (code) => {
      globalThis.clearTimeout(deadline);
      globalThis.clearTimeout(grace);
      channel.destroy();
      resolve(poolSessionPhase(!expired && code === 0));
    });
  }).then(async (phase) => {
    await chatSessionCleared(state, place);
    return phase;
  });
  return { stop, ended };
}

/** The session's process started, or the reason it could not be. */
function chatSessionSpawned(state, place, launch) {
  const [program, ...args] = chatSessionCommand(
    state.settings,
    place.uid,
    launch.group === undefined ? [] : [launch.group],
  );
  const child = state.system.spawn(program, args, {
    cwd: place.workspace,
    env: chatSessionEnvironment(state, place, launch.checkout),
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.off("error", reject);
      resolve(chatSessionRunning(state, place, child, launch));
    });
  });
}

/** Every step of a session's preparation, and its process started. */
async function chatSessionMade(state, place, envelope, signal) {
  const { settings, system } = state;
  if ((await system.freeBytes(settings.sessionsRoot)) < settings.freeBytesMin)
    throw new Error(`${settings.sessionsRoot} has too little free space`);
  await chatSessionDirectories(state, place);
  signal.throwIfAborted();
  const fetched = await chatAbortable(signal, state.task(envelope));
  if (fetched.mode !== "Session")
    throw new Error("the worker plane answered a task that is not a session's");
  const credential = await chatSessionCredential(
    state,
    fetched.answer.credentialSlot,
    place,
  );
  signal.throwIfAborted();
  const { checkout, group } = await state.checkout(
    { ...fetched.answer, workerPlane: { url: envelope.callbackUrl } },
    envelope.bearer,
    place.workspace,
    { signal, uid: place.uid, minted: place.checkoutMinted },
  );
  await system.removed(place.checkoutMinted);
  signal.throwIfAborted();
  return chatSessionSpawned(state, place, {
    envelope: { ...envelope, providerCredentialFile: credential.file },
    checkout,
    group,
    scrub: credentialScrub([envelope.bearer, ...credential.secrets]),
  });
}

/**
 * The session `envelope` stands for, prepared and started as a user of its
 * own, or the reason it was not, with everything made for it gone. `signal`
 * cancels the preparation, whose refusal is then its reason.
 */
async function chatSessionPrepared(state, envelope, signal) {
  const place = chatSessionPlace(state.settings, chatSessionUid(state));
  try {
    return await chatSessionMade(state, place, envelope, signal);
  } catch (failure) {
    if (!signal.aborted)
      state.log(
        credentialScrub([envelope.bearer])(
          `[${place.id}] was not prepared: ${failure instanceof Error ? failure.message : String(failure)}\n`,
        ),
      );
    await chatSessionCleared(state, place);
    throw failure;
  }
}

/**
 * What a predecessor left under `root`: each entry emptied as the session
 * user that owns it, or removed as root where no session's user does, and a
 * user that cannot be cleared held.
 */
async function chatSessionsLeftCleared(state, root) {
  const { settings, system, log } = state;
  const first = settings.uidFirst;
  for (const { path, uid } of await system.listed(root)) {
    const session = uid >= first && uid < first + settings.uidCount;
    try {
      if (session) await system.emptied(path, uid);
      else await system.removed(path);
    } catch (failure) {
      if (session) state.held.add(uid);
      log(
        `what a predecessor left at ${path} could not be removed: ${failure instanceof Error ? failure.message : String(failure)}\n`,
      );
    }
  }
}

/**
 * The sessions a supervisor runs on `system`: its roots made, every session
 * user's processes a predecessor left killed and what it left removed.
 * `prepared` starts one; `holding` is whether any session's directory is
 * there, which a mirror's prune waits on.
 *
 * `task` is the plane's answer for an envelope, and `checkout` the tree a
 * session reads (`./chatCheckout.mjs`), each a seam a suite stands in for.
 */
export async function chatSessionsOpened(settings, seams) {
  const { system, log, task, checkout } = seams;
  const state = { settings, system, log, task, checkout, held: new Set() };
  await system.rootMade(settings.sessionsRoot, chatSessionsRootMode);
  await system.rootMade(settings.mintedRoot, chatSessionsRootMode);
  await system.rootMade(settings.supervisorMinted, chatSessionDirectoryMode);
  for (let offset = 0; offset < settings.uidCount; offset += 1)
    await system.swept(settings.uidFirst + offset);
  await chatSessionsLeftCleared(state, settings.sessionsRoot);
  await chatSessionsLeftCleared(state, settings.mintedRoot);
  await chatSessionsLeftCleared(state, settings.supervisorMinted);
  return {
    prepared: (envelope, signal) =>
      chatSessionPrepared(state, envelope, signal),
    holding: async () =>
      (await system.listed(settings.sessionsRoot)).length > 0,
  };
}
