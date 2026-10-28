/**
 * A member's chat host's backend: the pool loop's backend over a chat
 * supervisor, which runs every session the host holds and is spoken to in
 * the protocol of `@chuggy/worker-contract/chatHost`, a frame a line, on its
 * standard streams.
 *
 * THE SUPERVISOR IS TAKEN AT ITS `Ready`, and only where that names the
 * protocol this host speaks. Until then, and once it has ended or been told
 * to drain, it has no room, and a session offered is not placed. One that
 * names another protocol, says nothing within its bound, or writes anything
 * but a frame of this protocol is ended, since nothing it says after that is
 * read. Its room is the `sessionsMax` its `Ready` names.
 *
 * A SESSION IS PLACED ONCE ITS `Start` IS WRITTEN, as a container backend's
 * is once its container is asked for: the supervisor prepares it after, and
 * answers it later. A `Refused` that is not the end of a stop, an `Ended`,
 * and the supervisor's own end are each named once by `ended`, as a session
 * that ended in the phase the supervisor says, or failed; one this host
 * stopped is never named. A session is held from its `Start` until it is
 * answered, stopped or not, since until then it runs; a supervisor that does
 * not answer a stop within its bound is ended and killed. One whose process
 * exited is ended once its output has been read to its end, within a bound,
 * so the frames it wrote before it exited are acted on, and has no room
 * meanwhile.
 *
 * A `Start` IS NEVER LOGGED, NOR WRITTEN ANYWHERE BUT THE SUPERVISOR'S
 * INPUT: it carries the session's bearer. What the supervisor writes on its
 * error stream is its log, and each line of it naming a session this host
 * started, as `chatSessionLabel` writes one, goes to that session's log;
 * every other line, one naming a session this host never started among them,
 * goes to the host's.
 */

import {
  chatHostStartSchema,
  chatProtocolFrameBytesMax,
  chatProtocolLine,
  chatProtocolSpoken,
  chatProtocolVersion,
  parseChatSupervisorFrame,
} from "@chuggy/worker-contract/chatHost";

import { chatLineReader, chatLineText } from "./chatChannel.mjs";
import { chatSessionLabel } from "./chatSession.mjs";
import { poolSessionPhase } from "./poolSessionPlane.mjs";

/**
 * @typedef {import("@chuggy/worker-contract/chatHost").ChatSupervisorReady} ChatSupervisorReady
 * @typedef {import("@chuggy/worker-contract/chatHost").ChatSupervisorFrame} ChatSupervisorFrame
 * @typedef {import("@chuggy/worker-contract/workerPool").WorkerPoolSessionAssignment} WorkerPoolSessionAssignment
 * @typedef {import("./poolLoop.mjs").WorkerPoolAttempt} WorkerPoolAttempt
 * @typedef {import("./poolLoop.mjs").WorkerPoolBackend} WorkerPoolBackend
 * @typedef {import("./poolLoop.mjs").WorkerPoolSessionEnd} WorkerPoolSessionEnd
 *
 * @typedef {object} ChatSupervisorHandle a supervisor started, as its engine runs it
 * @property {import("node:stream").Writable} input
 * @property {import("node:stream").Readable} output
 * @property {import("node:stream").Readable} errors
 * @property {Promise<unknown>} exited settles once its process has ended, however it did
 * @property {() => void} kill ends its process now
 *
 * @typedef {"Absent" | "Starting" | "Ready" | "Draining" | "Ended"} ChatSupervisorPhase
 *
 * @typedef {object} ChatHostBackendSettings
 * @property {number} outputBytesMax what a session may write of its output, which its envelope names
 * @property {number} readyWaitMs how long a supervisor started has to say it is ready
 * @property {number} exitWaitMs how long a supervisor whose input was ended has to exit before it is killed, and one that exited has for its output to end
 * @property {number} stopWaitMs how long a supervisor has to end a session it was told to stop before it is killed
 *
 * @typedef {object} ChatHostBackendSeams
 * @property {(line: string) => void} log the host's own log
 * @property {(assignment: string) => (line: string) => void} logFor the log of the session `assignment`
 *
 * @typedef {object} ChatHostSupervisor
 * @property {ChatSupervisorHandle} handle
 * @property {ChatSupervisorPhase} phase
 * @property {ChatSupervisorReady | undefined} ready
 * @property {boolean} exited whether its process has exited, after which it has no room while what it wrote is read
 * @property {(answer: {ready: ChatSupervisorReady} | {refused: string}) => void} answered settles what `attached` returned
 * @property {Promise<void>} done settles once it has ended
 * @property {() => void} finished
 * @property {ReturnType<typeof globalThis.setTimeout> | undefined} timer bounds its wait for `Ready`, and once it exited its wait for its output to end
 *
 * @typedef {object} ChatHostEntry
 * @property {WorkerPoolAttempt} attempt
 * @property {ChatHostSupervisor} supervisor
 * @property {boolean} stopping
 * @property {ReturnType<typeof globalThis.setTimeout> | undefined} timer bounds its supervisor's answer to its stop
 *
 * @typedef {WorkerPoolBackend & {
 *   attached: (handle: ChatSupervisorHandle) => Promise<{ready: ChatSupervisorReady} | {refused: string}>,
 *   phase: () => ChatSupervisorPhase,
 *   ceiling: () => number,
 *   drain: () => void,
 *   closed: () => Promise<void>,
 * }} ChatHostBackend
 */

/** The longest line of the supervisor's log that is kept, above a session's own line and its label. */
export const chatHostLogLineBytesMax = 32 * 1024;

/** How many sessions that are no longer held a late line of the supervisor's log is still routed to. */
const chatHostRecentMax = 64;

/** A line of the supervisor's log about a session, as `chatSessionLabel` begins one. */
const chatHostLabelPattern =
  /^\[([A-Za-z0-9._%-]+) session-([1-9][0-9]{0,9})\] /u;

/**
 * Where a line of the supervisor's log goes: to the session of `known` it is
 * labelled for, its label taken off, and otherwise to the host's log whole.
 * A label is taken only as `chatSessionLabel` writes it for that session, so
 * one written another way is no session's.
 *
 * @param {string} line
 * @param {Iterable<string>} known
 * @returns {{assignment?: string, line: string}}
 */
export function chatHostLogRouted(line, known) {
  const named = chatHostLabelPattern.exec(line);
  if (named === null) return { line };
  const label = `${named[1]} session-${named[2]}`;
  for (const assignment of known)
    if (chatSessionLabel(assignment, Number(named[2])) === label)
      return { assignment, line: line.slice(named[0].length) };
  return { line };
}

/** Every session a line of the supervisor's log may be routed to. */
function chatHostKnown(state) {
  return new Set([...state.entries.keys(), ...state.recent]);
}

/** Keeps `assignment` among those a late line is routed to, the oldest let go past the bound. */
function chatHostRecentKept(state, assignment) {
  state.recent = [
    ...state.recent.filter((kept) => kept !== assignment),
    assignment,
  ].slice(-chatHostRecentMax);
}

/** Each line of the supervisor's log routed, a line too long dropped before it is split. */
function chatHostErrorsRouted(state, errors) {
  const lines = chatLineReader(chatHostLogLineBytesMax, {
    line: (bytes) => {
      const routed = chatHostLogRouted(bytes.toString(), chatHostKnown(state));
      if (routed.assignment === undefined) state.seams.log(routed.line);
      else state.seams.logFor(routed.assignment)(routed.line);
    },
    overlong: () =>
      state.seams.log(
        "the supervisor wrote a log line too long to keep, which was dropped",
      ),
  });
  errors.on("data", (chunk) => lines.push(chunk));
  errors.once("end", () => lines.end());
  errors.once("error", () => lines.end());
}

/** Names a session that ended, and not one this host stopped, once. */
function chatHostEnded(state, entry, phase, why) {
  const { assignment } = entry.attempt;
  globalThis.clearTimeout(entry.timer);
  state.entries.delete(assignment);
  state.seams.logFor(assignment)(why);
  if (entry.stopping) return;
  state.ended.push({ kind: "Session", session: entry.attempt, phase });
}

/**
 * The supervisor ended, for `why`: every session it held is named as one
 * that failed, its input is ended, and what waits on it is answered.
 *
 * @param {{entries: Map<string, ChatHostEntry>}} state
 * @param {ChatHostSupervisor} supervisor
 * @param {string} why
 */
function chatHostSupervisorEnded(state, supervisor, why) {
  if (supervisor.phase === "Ended") return;
  supervisor.phase = "Ended";
  globalThis.clearTimeout(supervisor.timer);
  supervisor.answered({ refused: why });
  for (const entry of [...state.entries.values()])
    if (entry.supervisor === supervisor)
      chatHostEnded(
        state,
        entry,
        poolSessionPhase(false),
        `the supervisor ended: ${why}`,
      );
  state.seams.log(`the supervisor ended: ${why}`);
  supervisor.handle.input.end();
  supervisor.finished();
}

/** A supervisor no longer followed, for `why`, ended and killed. */
function chatHostUnfollowed(state, supervisor, why) {
  if (supervisor.phase === "Ended") return;
  chatHostSupervisorEnded(state, supervisor, why);
  supervisor.handle.kill();
}

/** The supervisor's `Ready`, taken where it is its first frame and names this protocol. */
function chatHostReady(state, supervisor, ready) {
  if (supervisor.phase !== "Starting") {
    state.seams.log("the supervisor said it was ready again, which is ignored");
    return;
  }
  if (!chatProtocolSpoken(ready)) {
    chatHostUnfollowed(
      state,
      supervisor,
      `the supervisor speaks protocol ${ready.protocols.join(", ")} and this host speaks ${String(chatProtocolVersion)}; run a supervisor image that speaks it`,
    );
    return;
  }
  globalThis.clearTimeout(supervisor.timer);
  supervisor.phase = "Ready";
  supervisor.ready = ready;
  state.seams.log(
    `the supervisor is ready for ${String(ready.sessionsMax)} sessions, built against contract ${ready.contractRelease}`,
  );
  supervisor.answered({ ready });
}

/** The session a frame answers, where this host started it under this supervisor. */
function chatHostAnswered(state, supervisor, assignment) {
  const entry = state.entries.get(assignment);
  if (entry?.supervisor === supervisor) return entry;
  state.seams.log(
    `the supervisor answered ${JSON.stringify(assignment)}, which this host did not start`,
  );
  return undefined;
}

/** A `Refused`: an earlier answer standing for a duplicate, and the session ended otherwise. */
function chatHostRefused(state, supervisor, frame) {
  const entry = chatHostAnswered(state, supervisor, frame.assignment);
  if (entry === undefined) return;
  if (frame.reason === "Duplicate") {
    state.seams.logFor(frame.assignment)(
      "the supervisor already holds this session; its earlier answer stands",
    );
    return;
  }
  chatHostEnded(
    state,
    entry,
    poolSessionPhase(false),
    `the supervisor refused the session: ${frame.reason}`,
  );
}

/**
 * One frame of the supervisor's, acted on as the frame it is.
 *
 * @param {ChatHostSupervisor} supervisor
 * @param {ChatSupervisorFrame} frame
 */
function chatHostFrame(state, supervisor, frame) {
  if (frame.frame === "Ready") return chatHostReady(state, supervisor, frame);
  if (supervisor.phase === "Starting")
    return chatHostUnfollowed(
      state,
      supervisor,
      "the supervisor wrote a frame before it was ready",
    );
  if (frame.frame === "Drained")
    return state.seams.log("the supervisor has drained");
  if (frame.frame === "Refused")
    return chatHostRefused(state, supervisor, frame);
  const entry = chatHostAnswered(state, supervisor, frame.assignment);
  if (entry === undefined) return undefined;
  if (frame.frame === "Started")
    return state.seams.logFor(frame.assignment)("the session started");
  return chatHostEnded(
    state,
    entry,
    frame.phase,
    `the session ended: ${frame.phase}`,
  );
}

/** One line of the supervisor's output, which is never logged. */
function chatHostHeard(state, supervisor, bytes) {
  if (supervisor.phase === "Ended") return;
  let frame;
  try {
    frame = parseChatSupervisorFrame(chatLineText(bytes));
  } catch {
    chatHostUnfollowed(
      state,
      supervisor,
      "the supervisor wrote a line that is no frame of this protocol",
    );
    return;
  }
  chatHostFrame(state, supervisor, frame);
}

/** A supervisor of `handle`'s, not yet ready. */
function chatHostSupervisorOf(handle) {
  /** @type {ChatHostSupervisor} */
  const supervisor = {
    handle,
    phase: "Starting",
    ready: undefined,
    exited: false,
    answered: () => undefined,
    done: Promise.resolve(),
    finished: () => undefined,
    timer: undefined,
  };
  supervisor.done = new Promise((resolve) => {
    supervisor.finished = resolve;
  });
  return supervisor;
}

/**
 * The supervisor's process exited: it ends once what it wrote before it did
 * has been read, which the end of its output says, or past the bound on that.
 */
function chatHostExited(state, supervisor) {
  supervisor.exited = true;
  if (supervisor.phase === "Ended") return;
  globalThis.clearTimeout(supervisor.timer);
  supervisor.timer = globalThis.setTimeout(
    () =>
      chatHostSupervisorEnded(
        state,
        supervisor,
        `it exited, and its output did not end within ${String(state.settings.exitWaitMs)} ms`,
      ),
    state.settings.exitWaitMs,
  );
}

/**
 * Speaks to the supervisor `handle` runs, which is then the host's: what it
 * says is read from now on, and the answer is its `Ready`, or why it was
 * ended without one.
 */
function chatHostAttached(state, handle) {
  if (state.supervisor !== undefined && state.supervisor.phase !== "Ended")
    throw new Error("a chat host speaks to one supervisor at a time");
  const supervisor = chatHostSupervisorOf(handle);
  state.supervisor = supervisor;
  const answer = new Promise((resolve) => {
    supervisor.answered = (answered) => {
      supervisor.answered = () => undefined;
      resolve(answered);
    };
  });
  const frames = chatLineReader(chatProtocolFrameBytesMax, {
    line: (bytes) => chatHostHeard(state, supervisor, bytes),
    overlong: () =>
      chatHostUnfollowed(
        state,
        supervisor,
        "the supervisor wrote a line longer than a frame",
      ),
  });
  const ended = (why) => () => chatHostSupervisorEnded(state, supervisor, why);
  handle.input.on("error", ended("its input could not be written"));
  handle.output.on("data", (chunk) => frames.push(chunk));
  handle.output.once("end", () => {
    frames.end();
    chatHostSupervisorEnded(state, supervisor, "its output ended");
  });
  handle.output.once("error", ended("its output could not be read"));
  const exited = () => chatHostExited(state, supervisor);
  handle.exited.then(exited, exited);
  chatHostErrorsRouted(state, handle.errors);
  supervisor.timer = globalThis.setTimeout(
    () =>
      chatHostUnfollowed(
        state,
        supervisor,
        `it was not ready within ${String(state.settings.readyWaitMs)} ms`,
      ),
    state.settings.readyWaitMs,
  );
  return answer;
}

/**
 * The `Start` of the session `assignment` is, as a line, or nothing where it
 * is no frame the supervisor reads.
 *
 * @param {ChatHostBackendSettings} settings
 * @param {WorkerPoolSessionAssignment} assignment
 */
function chatHostStartLine(settings, assignment) {
  try {
    return chatProtocolLine(
      chatHostStartSchema.parse({
        frame: "Start",
        assignment: assignment.assignment,
        envelope: {
          callbackUrl: assignment.callbackUrl,
          bearer: assignment.bearer,
          timeoutSecsMax: assignment.deadlineSecs,
          outputBytesMax: settings.outputBytesMax,
        },
      }),
    );
  } catch {
    return undefined;
  }
}

/**
 * A session placed once its `Start` is written to a ready supervisor with
 * room for it; a job is never one a chat host takes.
 */
function chatHostPlaced(state, assignment, kind) {
  if (kind !== "Session")
    return {
      placed: "Refused",
      evidence: "a chat host runs sessions alone, and was offered a job",
    };
  if (state.entries.has(assignment.assignment)) return { placed: "Placed" };
  const { supervisor } = state;
  if (
    supervisor?.phase !== "Ready" ||
    supervisor.exited ||
    state.entries.size >= (supervisor.ready?.sessionsMax ?? 0)
  )
    return { placed: "Unavailable" };
  const line = chatHostStartLine(state.settings, assignment);
  if (line === undefined)
    return {
      placed: "Refused",
      evidence: "the session's start is no frame its supervisor reads",
    };
  const { callbackUrl, bearer } = assignment;
  state.entries.set(assignment.assignment, {
    attempt: { assignment: assignment.assignment, callbackUrl, bearer },
    supervisor,
    stopping: false,
    timer: undefined,
  });
  chatHostRecentKept(state, assignment.assignment);
  supervisor.handle.input.write(line);
  state.seams.logFor(assignment.assignment)(
    "the session was handed to the supervisor",
  );
  return { placed: "Placed" };
}

/**
 * A session stopped: its `Stop` written once, and it held until it is
 * answered, or until the bound on that, past which its supervisor is ended
 * and killed and the session is held no longer.
 */
function chatHostStopped(state, assignment) {
  const entry = state.entries.get(assignment);
  if (entry !== undefined && !entry.stopping) {
    entry.stopping = true;
    if (entry.supervisor.phase !== "Ended")
      entry.supervisor.handle.input.write(
        chatProtocolLine({ frame: "Stop", assignment }),
      );
    entry.timer = globalThis.setTimeout(
      () =>
        chatHostUnfollowed(
          state,
          entry.supervisor,
          `it did not end ${JSON.stringify(assignment)} within ${String(state.settings.stopWaitMs)} ms of its stop, and was killed`,
        ),
      state.settings.stopWaitMs,
    );
    state.seams.logFor(assignment)("the session was stopped");
  }
  return { stopped: "Stopped" };
}

/** Tells a ready supervisor to start nothing more and exit once its sessions end of themselves. */
function chatHostDrained(state) {
  const { supervisor } = state;
  if (supervisor?.phase !== "Ready") return;
  supervisor.phase = "Draining";
  supervisor.handle.input.write(chatProtocolLine({ frame: "Drain" }));
  state.seams.log("the supervisor was told to drain");
}

/**
 * The supervisor ended: its input ended, which stops every session it runs,
 * and its process waited for within the bound, and killed past it.
 */
async function chatHostClosed(state) {
  const { supervisor } = state;
  if (supervisor === undefined) return;
  supervisor.handle.input.end();
  let timer;
  const late = new Promise((resolve) => {
    timer = globalThis.setTimeout(
      () => resolve("Late"),
      state.settings.exitWaitMs,
    );
  });
  const exited = supervisor.handle.exited.then(
    () => "Exited",
    () => "Exited",
  );
  const waited = await Promise.race([exited, late]);
  globalThis.clearTimeout(timer);
  if (waited === "Late") {
    supervisor.handle.kill();
    chatHostSupervisorEnded(
      state,
      supervisor,
      `it did not exit within ${String(state.settings.exitWaitMs)} ms of its input ending, and was killed`,
    );
  }
  await supervisor.done;
}

/**
 * @param {ChatHostBackendSettings} settings
 * @returns {ChatHostBackendSettings}
 */
export function checkedChatHostBackendSettings(settings) {
  for (const [name, bound] of Object.entries(settings))
    if (!Number.isSafeInteger(bound) || bound < 1)
      throw new RangeError(
        `chat host backend ${name} must be a positive integer`,
      );
  return settings;
}

/**
 * A chat host's backend, speaking to no supervisor until `attached` is given
 * one.
 *
 * @param {ChatHostBackendSettings} settings
 * @param {ChatHostBackendSeams} seams
 * @returns {ChatHostBackend}
 */
export function chatHostBackend(settings, seams) {
  const state = {
    settings: checkedChatHostBackendSettings(settings),
    seams,
    /** @type {Map<string, ChatHostEntry>} */
    entries: new Map(),
    /** @type {WorkerPoolSessionEnd[]} */
    ended: [],
    /** @type {string[]} */
    recent: [],
    /** @type {ChatHostSupervisor | undefined} */
    supervisor: undefined,
  };
  return {
    place: async (assignment, kind) =>
      chatHostPlaced(
        state,
        /** @type {WorkerPoolSessionAssignment} */ (assignment),
        kind,
      ),
    stop: async (assignment) => chatHostStopped(state, assignment),
    held: async () =>
      [...state.entries.keys()].map((assignment) => ({
        assignment,
        kind: /** @type {const} */ ("Session"),
      })),
    ended: async () => state.ended.splice(0),
    attached: (handle) => chatHostAttached(state, handle),
    phase: () => state.supervisor?.phase ?? "Absent",
    ceiling: () =>
      state.supervisor?.phase === "Ready" && !state.supervisor.exited
        ? (state.supervisor.ready?.sessionsMax ?? 0)
        : 0,
    drain: () => chatHostDrained(state),
    closed: () => chatHostClosed(state),
  };
}
