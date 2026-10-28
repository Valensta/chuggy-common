/**
 * Each session's log on a member's chat host, as `ChatHostSeams.logFor`
 * writes it: a file of its own, named by a digest of the host and the
 * session's assignment, which only its owner reads. It opens naming its
 * assignment, and each line is stamped with when it was written.
 *
 * IT KEEPS ITS END, as a job's saved log does. A line that would take it past
 * `savedLogBytesMax` first cuts it to the whole lines of its last
 * `chatSessionLogKeptBytes`, after its assignment and the line `savedLog.mjs`
 * says a cut with, which the next cut drops with what it cuts, so a log says
 * once that it was cut however often it was.
 *
 * WRITING TO A LOG NEVER THROWS, since the host writes from its handlers of
 * its supervisor's streams. A log that cannot be written stops, and says so
 * once on the host's log.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { poolIdentityDigest } from "./poolIdentity.mjs";
import { savedLogBytesMax, savedLogKept } from "./savedLog.mjs";

/**
 * @typedef {import("./poolIdentity.mjs").ChatHostIdentity} ChatHostIdentity
 *
 * @typedef {object} ChatSessionLog
 * @property {string} file
 * @property {string} opening its first line, naming its assignment
 * @property {number} bytes how long it is
 * @property {boolean} stopped whether it could not be written, and keeps nothing more
 */

/** What a cut keeps of a session's log, below its bound so a cut is not made again at its next line. */
export const chatSessionLogKeptBytes = savedLogBytesMax / 2;

/** How many sessions' logs are kept count of at once, the least recently written let go and counted again from its file. */
const chatSessionLogsOpenMax = 256;

const chatSessionLogMode = 0o600;

/**
 * The file a host's session's log is.
 *
 * @param {string} directory
 * @param {ChatHostIdentity} identity
 * @param {string} assignment
 */
export function chatSessionLogFile(directory, identity, assignment) {
  return join(
    directory,
    `chuggy-chat-${poolIdentityDigest(identity, assignment)}.log`,
  );
}

/**
 * Each session's log under `directory`, as the module says.
 *
 * @param {string} directory
 * @param {ChatHostIdentity} identity
 * @param {{log: (line: string) => void, nowMs: () => number}} seams `log` the host's own
 * @returns {(assignment: string) => (line: string) => void}
 */
export function chatSessionLogs(directory, identity, seams) {
  /** @type {Map<string, ChatSessionLog>} */
  const open = new Map();
  /** @param {string} assignment */
  const opened = (assignment) => {
    const known = open.get(assignment);
    if (known !== undefined) {
      open.delete(assignment);
      open.set(assignment, known);
      return known;
    }
    const log = chatSessionLogOpened(directory, identity, assignment, seams);
    open.set(assignment, log);
    while (open.size > chatSessionLogsOpenMax)
      open.delete(/** @type {string} */ (open.keys().next().value));
    return log;
  };
  return (assignment) => (line) =>
    chatSessionLogWritten(
      opened(assignment),
      `${new Date(seams.nowMs()).toISOString()} ${line}\n`,
      seams,
    );
}

/** A session's log, counted from its file, which is begun with its opening where it is not there. */
function chatSessionLogOpened(directory, identity, assignment, seams) {
  /** @type {ChatSessionLog} */
  const log = {
    file: chatSessionLogFile(directory, identity, assignment),
    opening: `session ${assignment}\n`,
    bytes: 0,
    stopped: false,
  };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    log.bytes = statSync(log.file).size;
  } catch (failure) {
    if (/** @type {NodeJS.ErrnoException} */ (failure).code !== "ENOENT")
      return chatSessionLogStopped(log, failure, seams);
  }
  if (log.bytes === 0) chatSessionLogWritten(log, log.opening, seams);
  return log;
}

/** A log that could not be written, stopped and said so of on the host's log. */
function chatSessionLogStopped(log, failure, seams) {
  log.stopped = true;
  seams.log(
    `the session log ${log.file} could not be written, and keeps nothing more: ${failure instanceof Error ? failure.message : String(failure)}`,
  );
  return log;
}

/** `text` appended to `log`, which is cut first where it would pass its bound. */
function chatSessionLogWritten(log, text, seams) {
  if (log.stopped) return;
  const bytes = Buffer.byteLength(text);
  try {
    if (log.bytes + bytes > savedLogBytesMax) chatSessionLogCut(log);
    appendFileSync(log.file, text, { mode: chatSessionLogMode });
    log.bytes += bytes;
  } catch (failure) {
    chatSessionLogStopped(log, failure, seams);
  }
}

/**
 * `log` cut to what of its last `chatSessionLogKeptBytes` `savedLogKept`
 * keeps, after its opening, written beside it and renamed over it.
 *
 * @param {ChatSessionLog} log
 */
function chatSessionLogCut(log) {
  const handle = openSync(log.file, "r");
  let tail;
  let size;
  try {
    ({ size } = fstatSync(handle));
    const length = Math.min(size, chatSessionLogKeptBytes);
    tail = Buffer.alloc(length);
    readSync(handle, tail, 0, length, size - length);
  } finally {
    closeSync(handle);
  }
  const text = Buffer.concat([
    Buffer.from(log.opening),
    savedLogKept(tail, size > tail.length) ?? tail,
  ]);
  const staged = `${log.file}.${randomUUID()}`;
  try {
    writeFileSync(staged, text, { mode: chatSessionLogMode, flag: "wx" });
    renameSync(staged, log.file);
  } catch (failure) {
    rmSync(staged, { force: true });
    throw failure;
  }
  log.bytes = text.length;
}
