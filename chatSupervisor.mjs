/**
 * The supervisor in a member's chat container: it reads the member's chat
 * host's frames on its standard input, runs each session the host starts as a
 * user of its own (`./chatSession.mjs`), and writes its own frames on its
 * standard output, as `@chuggy/worker-contract/chatHost` states them. It is
 * started as root, under an init that forwards its signals, and its own
 * process id is nothing it relies on.
 *
 * EVERY `Start` IS ANSWERED ONCE. A preparation or a running session is an
 * entry under its assignment from the `Start` that made it to the frame that
 * ends it — `Refused` for a preparation, `Ended` for a session — so a later
 * `Start` for it is a `Duplicate` before anything else is asked, and the
 * entries are what `sessionsMax` counts. A preparation a `Stop` reaches is
 * cancelled and refused `Stopped` once what it made is gone; one that had
 * already started its process stops it first, and is still refused, since the
 * host was told of no session to end.
 *
 * `Drain` ONLY WAITS. Every later `Start` is refused `Draining`, unless it is
 * a `Duplicate`, and once no entry is left `Drained` is written and the
 * supervisor exits.
 *
 * THE END OF ITS INPUT ENDS EVERYTHING. Every preparation is cancelled and
 * refused `Stopped`, every session is stopped and its `Ended` written, and
 * the supervisor exits. A line longer than a frame, or one that is not a
 * frame, is a host this supervisor cannot follow, which it trusts no less
 * for it: it says so on its log, without the line, reads nothing more, and
 * ends as it would at the end of its input, exiting non-zero. A signal to end
 * is taken as the end of its input.
 *
 * THE PROTOCOL IS MORE THAN THE FRAMES. A host and a supervisor are built from
 * cores released apart, and `chatProtocolVersion` names everything one hands
 * the other: the frames, and the environment, mounts and tmpfs a host runs
 * this supervisor with. The host names the protocol it speaks in
 * `CHUG_CHAT_PROTOCOL`, which the supervisor reads before anything else, and
 * exits refusing a host that names none or one not in
 * `chatSupervisorProtocols`, saying which side to update. A supervisor's
 * `Ready` names the same protocols, and a host ends one that lacks its own.
 * So a change to any of that bumps the version, and the supervisor speaks the
 * old one beside it, reading either shape, for one release window: a host
 * and a supervisor a release apart then agree, and any further apart each
 * refuses the other before a session is claimed. `chatProtocol.test.mjs`
 * holds that shape against the version; it sees names and mounts, so a
 * value's form or meaning changing under a name it already holds — the JSON
 * in `CHUG_WORKER_CLAUDE_CREDENTIAL`, what `CHUG_CHAT_CREDENTIAL_UID` is the
 * uid of — bumps the version by hand. The version is chuggy's, in
 * `@chuggy/worker-contract`, so a bump is a contract release and then this
 * core's lock moved to it.
 *
 * THE WINDOW ENDS AT THE PLANE'S FLOOR. N-1 leaves `chatSupervisorProtocols`
 * only once the plane admits no host that speaks only N-1: once chuggy's
 * `workerContractChatHost.min`, the contract release below which a chat host
 * is refused every pool plane route, is at or past the release that brought
 * N. The release a poll names (`./runnerUpdate.mjs`) moves a host forward and
 * refuses none, so it ends no window.
 */

import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chatProtocolFrameBytesMax,
  chatProtocolLine,
  chatProtocolVersion,
  parseChatHostFrame,
} from "@chuggy/worker-contract/chatHost";
import { workerContractRelease } from "@chuggy/worker-contract/workerContract";
import { workerRepositoriesVariable } from "@chuggy/worker-contract/workerEnvironment";

import { chatLineReader, chatLineText } from "./chatChannel.mjs";
import {
  chatCheckout,
  chatMirrorGroupCount,
  chatMirrorGroupFirst,
  chatMirrorsDirectory,
  chatMirrorsOpened,
} from "./chatCheckout.mjs";
import {
  chatSessionClearWaitMs,
  chatSessionEntrypoint,
  chatSessionFreeBytesMin,
  chatSessionStopGraceMs,
  chatSessionUidCount,
  chatSessionUidFirst,
  chatSessionsDirectory,
  chatSessionsMintedDirectory,
  chatSessionsOpened,
  chatSupervisorMintedDirectory,
  chatSystem,
} from "./chatSession.mjs";
import { envelopeTask } from "./entrypoint.mjs";
import { planeCredential, sessionCredentialPath } from "./planeCredential.mjs";
import { workerRepositories } from "./repository.mjs";
import { sessionRequest } from "./sessionTransport.mjs";

/**
 * The protocols this supervisor speaks, newest last: the version, and in a
 * release window the one before it, as the module says.
 */
export const chatSupervisorProtocols = Object.freeze([chatProtocolVersion]);

/** Where the host names the protocol it speaks, which it sets beside every other variable. */
export const chatSupervisorProtocolVariable = "CHUG_CHAT_PROTOCOL";

/**
 * Why this supervisor cannot follow the host whose environment is
 * `environment`, naming the side to update, or nothing where it speaks the
 * host's protocol.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 */
export function chatSupervisorProtocolRefusal(environment) {
  const named = environment[chatSupervisorProtocolVariable];
  const spoken = /^[1-9]\d*$/u.test(named ?? "") ? Number(named) : undefined;
  if (spoken !== undefined && chatSupervisorProtocols.includes(spoken))
    return undefined;
  const newest = chatSupervisorProtocols.at(-1) ?? chatProtocolVersion;
  const side =
    spoken !== undefined && spoken > newest
      ? "update this image to one whose supervisor speaks it"
      : "update the host's runner to one that speaks one of these";
  return `this image's supervisor speaks protocol(s) [${chatSupervisorProtocols.join(", ")}]; the host speaks ${named === undefined || named.length === 0 ? "none" : named}: run matching versions; ${side}`;
}

/**
 * The variables a supervisor's places and bounds are read from, each its
 * constant where it is unset, and the provider credential's file and the
 * owner it is read as, which have none.
 */
export const chatSupervisorVariables = {
  uidFirst: "CHUG_CHAT_UID_FIRST",
  uidCount: "CHUG_CHAT_UID_COUNT",
  sessionsMax: "CHUG_CHAT_SESSIONS_MAX",
  sessionsRoot: "CHUG_CHAT_SESSIONS",
  mintedRoot: "CHUG_CHAT_MINTED",
  supervisorMinted: "CHUG_CHAT_SUPERVISOR_MINTED",
  mirrorsRoot: "CHUG_CHAT_MIRRORS",
  groupFirst: "CHUG_CHAT_MIRROR_GROUP_FIRST",
  groupCount: "CHUG_CHAT_MIRROR_GROUP_COUNT",
  credential: "CHUG_CHAT_CREDENTIAL",
  credentialUid: "CHUG_CHAT_CREDENTIAL_UID",
  credentialGid: "CHUG_CHAT_CREDENTIAL_GID",
};

/** A whole number `environment` names under `name`, `fallback` where it names none. */
function chatSupervisorCount(environment, name, fallback, least) {
  const value = environment[name];
  if (value === undefined || value.length === 0) return fallback;
  const count = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(count) || count < least)
    throw new RangeError(
      `${name} must be a whole number of at least ${String(least)}`,
    );
  return count;
}

/**
 * The provider credential's file and the owner it is read as, as
 * `environment` names them, refused where it names either not at all, or an
 * owner a session is run as, who could then read it.
 */
function chatSupervisorCredential(environment, uidFirst, uidCount) {
  const names = chatSupervisorVariables;
  const credentialFile = environment[names.credential] ?? "";
  if (!credentialFile.startsWith("/"))
    throw new RangeError(
      `${names.credential} must name the provider credential's file by its absolute path`,
    );
  const uid = chatSupervisorCount(environment, names.credentialUid, -1, 0);
  const gid = chatSupervisorCount(environment, names.credentialGid, -1, 0);
  if (uid < 0 || gid < 0)
    throw new RangeError(
      `${names.credentialUid} and ${names.credentialGid} must name the owner the provider credential is read as`,
    );
  if (uid >= uidFirst && uid < uidFirst + uidCount)
    throw new RangeError(
      `the credential's owner ${String(uid)} is among the users a session is run as`,
    );
  return { credentialFile, credentialOwner: { uid, gid } };
}

/**
 * Where a supervisor makes what it makes, how many sessions it runs, and the
 * credential it hands them, read from `environment`, refused where a
 * session's user could be root, could share a number with a mirror's group,
 * which its own group would then be, or could own the credential.
 */
export function chatSupervisorSettings(environment) {
  const names = chatSupervisorVariables;
  const count = (name, fallback, least = 1) =>
    chatSupervisorCount(environment, name, fallback, least);
  const uidCount = count(names.uidCount, chatSessionUidCount);
  const uidFirst = count(names.uidFirst, chatSessionUidFirst);
  const settings = {
    uidFirst,
    uidCount,
    sessionsMax: Math.min(uidCount, count(names.sessionsMax, uidCount)),
    sessionsRoot: environment[names.sessionsRoot] || chatSessionsDirectory,
    mintedRoot: environment[names.mintedRoot] || chatSessionsMintedDirectory,
    supervisorMinted:
      environment[names.supervisorMinted] || chatSupervisorMintedDirectory,
    mirrorsRoot: environment[names.mirrorsRoot] || chatMirrorsDirectory,
    groupFirst: count(names.groupFirst, chatMirrorGroupFirst),
    groupCount: count(names.groupCount, chatMirrorGroupCount),
    freeBytesMin: chatSessionFreeBytesMin,
    stopGraceMs: chatSessionStopGraceMs,
    clearWaitMs: chatSessionClearWaitMs,
    node: process.execPath,
    entrypoint: chatSessionEntrypoint,
    ...chatSupervisorCredential(environment, uidFirst, uidCount),
    environment,
  };
  const uidLast = settings.uidFirst + settings.uidCount - 1;
  const groupLast = settings.groupFirst + settings.groupCount - 1;
  if (settings.uidFirst <= groupLast && settings.groupFirst <= uidLast)
    throw new RangeError(
      "the users a session may be run as overlap the groups a mirror may have",
    );
  return settings;
}

/** One frame on the supervisor's output. */
function chatSupervisorWritten(state, frame) {
  state.output.write(chatProtocolLine(frame));
}

/** The answer to `assignment`'s `Start` that it did not become a session, its entry gone. */
function chatSupervisorRefused(state, assignment, reason) {
  chatSupervisorWritten(state, { frame: "Refused", assignment, reason });
}

/** The supervisor's end, once no entry is left after a `Drain` or the end of its input. */
function chatSupervisorSettled(state) {
  if (state.finished || state.entries.size > 0) return;
  if (!state.draining && !state.closing) return;
  state.finished = true;
  if (state.draining) chatSupervisorWritten(state, { frame: "Drained" });
  state.finish(state.code);
}

/** An entry's preparation, then its session, answered and ended as its frames say. */
async function chatSupervisorPrepared(state, assignment, envelope, entry) {
  const { signal } = entry.cancel;
  let running;
  try {
    running = await state.sessions.prepared(assignment, envelope, signal);
  } catch {
    running = undefined;
  }
  if (running === undefined || signal.aborted) {
    if (running !== undefined) {
      running.stop();
      await running.ended;
    }
    chatSupervisorRefused(
      state,
      assignment,
      signal.aborted ? "Stopped" : "Unprepared",
    );
  } else {
    entry.running = running;
    chatSupervisorWritten(state, { frame: "Started", assignment });
    const phase = await running.ended;
    chatSupervisorWritten(state, { frame: "Ended", assignment, phase });
  }
  state.entries.delete(assignment);
  chatSupervisorSettled(state);
}

/** A `Start`, answered at once where it is refused, and prepared where it is not. */
function chatSupervisorStart(state, { assignment, envelope }) {
  if (state.entries.has(assignment))
    return chatSupervisorRefused(state, assignment, "Duplicate");
  if (state.draining)
    return chatSupervisorRefused(state, assignment, "Draining");
  if (state.entries.size >= state.sessionsMax)
    return chatSupervisorRefused(state, assignment, "Full");
  const entry = {
    cancel: new globalThis.AbortController(),
    running: undefined,
  };
  state.entries.set(assignment, entry);
  void chatSupervisorPrepared(state, assignment, envelope, entry);
  return undefined;
}

/** An entry asked to end: its preparation cancelled, or its session stopped. */
function chatSupervisorStopped(entry) {
  if (entry.running === undefined) entry.cancel.abort();
  else entry.running.stop();
}

/** The end of the host's frames, whether its stream ended or could not be followed. */
function chatSupervisorClosed(state) {
  if (state.closing) return;
  state.closing = true;
  for (const entry of state.entries.values()) chatSupervisorStopped(entry);
  chatSupervisorSettled(state);
}

/** A host this supervisor cannot follow: said on its log, and its frames ended. */
function chatSupervisorUnfollowed(state, why) {
  if (state.closing) return;
  state.log(`${why}; reading nothing more from it\n`);
  state.code = 1;
  chatSupervisorClosed(state);
}

/** One line of the host's, acted on as the frame it is. */
function chatSupervisorHeard(state, bytes) {
  if (state.closing) return undefined;
  let frame;
  try {
    frame = parseChatHostFrame(chatLineText(bytes));
  } catch {
    return chatSupervisorUnfollowed(
      state,
      "the host wrote a line that is not a frame",
    );
  }
  if (frame.frame === "Start") return chatSupervisorStart(state, frame);
  if (frame.frame === "Stop") {
    const entry = state.entries.get(frame.assignment);
    if (entry !== undefined) chatSupervisorStopped(entry);
    return undefined;
  }
  state.draining = true;
  return chatSupervisorSettled(state);
}

/**
 * A supervisor speaking the protocol on `input` and `output` over `sessions`,
 * which prepares and runs one (`./chatSession.mjs`'s `prepared`), at most
 * `sessionsMax` at once: `Ready` first, then each frame the host's call for.
 * It settles with the code the supervisor exits with, once it has nothing
 * left to answer; `closed` is a signal taken as the end of `input`.
 */
export function chatSupervised({
  input,
  output,
  log,
  sessions,
  sessionsMax,
  closed,
}) {
  const state = {
    output,
    log,
    sessions,
    sessionsMax,
    entries: new Map(),
    draining: false,
    closing: false,
    finished: false,
    code: 0,
    finish: () => undefined,
  };
  const settled = new Promise((resolved) => {
    state.finish = resolved;
  });
  chatSupervisorWritten(state, {
    frame: "Ready",
    protocols: [...chatSupervisorProtocols],
    sessionsMax,
    contractRelease: workerContractRelease,
  });
  const lines = chatLineReader(chatProtocolFrameBytesMax, {
    line: (bytes) => chatSupervisorHeard(state, bytes),
    overlong: () =>
      chatSupervisorUnfollowed(
        state,
        "the host wrote a line longer than a frame",
      ),
  });
  input.on("data", (chunk) => {
    if (!state.closing) lines.push(chunk);
  });
  input.once("end", () => {
    if (!state.closing) lines.end();
    chatSupervisorClosed(state);
  });
  input.once("error", () => chatSupervisorClosed(state));
  closed?.addEventListener("abort", () => chatSupervisorClosed(state), {
    once: true,
  });
  return settled;
}

/**
 * The tree a session reads, checked out by the supervisor as root under a
 * credential the plane mints for the session's own attempt; it is handed no
 * repository's credential file of its own.
 */
function chatSupervisorCheckout(environment, mirrors) {
  const named = environment[workerRepositoriesVariable];
  const repositories =
    named === undefined || named.length === 0 ? {} : workerRepositories(named);
  return (task, bearer, workspace, { signal, uid, minted, log }) =>
    chatCheckout(task, bearer, workspace, {
      mint: (repository) =>
        planeCredential({
          task,
          bearer,
          path: sessionCredentialPath,
          repository,
          request: sessionRequest,
          directory: minted,
        }),
      mirrors,
      repositories,
      credentialFiles: {},
      environment,
      user: { uid, gid: uid },
      signal,
      log,
    });
}

/** The supervisor as its image starts it, on its own standard streams. */
export async function chatSupervisorMain(environment = process.env) {
  const log = (text) => process.stderr.write(text);
  const refused = chatSupervisorProtocolRefusal(environment);
  if (refused !== undefined) {
    log(`${refused}\n`);
    return 1;
  }
  const settings = chatSupervisorSettings(environment);
  const mirrors = await chatMirrorsOpened({
    root: settings.mirrorsRoot,
    groupFirst: settings.groupFirst,
    groupCount: settings.groupCount,
  });
  const sessions = await chatSessionsOpened(settings, {
    system: chatSystem(),
    log,
    task: (envelope) => envelopeTask(envelope),
    checkout: chatSupervisorCheckout(environment, mirrors),
  });
  if (!(await sessions.holding())) await mirrors.pruned(log);
  const closed = new globalThis.AbortController();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
    process.once(signal, () => closed.abort());
  const code = await chatSupervised({
    input: process.stdin,
    output: process.stdout,
    log,
    sessions,
    sessionsMax: settings.sessionsMax,
    closed: closed.signal,
  });
  await new Promise((written) =>
    process.stdout.write("", () => written(undefined)),
  );
  return code;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  chatSupervisorMain().then(
    (code) => process.exit(code),
    (failure) => {
      process.stderr.write(
        `${failure instanceof Error ? failure.message : String(failure)}\n`,
      );
      process.exit(1);
    },
  );
