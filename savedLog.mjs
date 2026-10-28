/**
 * How much of an ended workload's output a runner keeps: at most its last
 * `savedLogBytesMax` bytes and its last `savedLogLinesMax` lines, whichever
 * keeps less, in a file only its owner can read, since what a workload
 * printed before its core began scrubbing can hold a secret. A log cut to
 * that opens with a line saying so, and begins at the first whole line after
 * the cut.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";

/** The kubelet's own default bound on a container's log file. */
export const savedLogBytesMax = 10 * 1024 * 1024;

/** The most lines a container's saved log is read with, which bounds the engine's own read of it. */
export const savedLogLinesMax = 200_000;

const savedLogMode = 0o600;

/** The line a cut log opens with. */
export const savedLogCutLine = `[chuggy kept only the end of this log, at most its last ${String(savedLogBytesMax)} bytes and ${String(savedLogLinesMax)} lines]\n`;

/**
 * A log's kept tail as it is saved: where its start was cut, from the first
 * whole line after the cut, after the line saying so.
 *
 * @param {Buffer} tail
 * @param {boolean} cut
 */
function savedLogText(tail, cut) {
  if (!cut) return tail;
  const newline = tail.indexOf(10);
  return Buffer.concat([
    Buffer.from(savedLogCutLine),
    newline === -1 ? tail : tail.subarray(newline + 1),
  ]);
}

/**
 * Writes a log's text to `file`, owner-only whoever made it first.
 *
 * @param {string} file
 * @param {Buffer} text
 */
async function savedLogFile(file, text) {
  const handle = await open(file, "w", savedLogMode);
  try {
    await handle.chmod(savedLogMode);
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
}

/**
 * Writes a log's kept tail to `file`.
 *
 * @param {string} file
 * @param {Buffer} tail
 * @param {boolean} cut
 */
export async function savedLogWritten(file, tail, cut) {
  await savedLogFile(file, savedLogText(tail, cut));
}

/**
 * Where a log's last `savedLogLinesMax` lines begin, or 0 where it has no
 * more lines than that.
 *
 * @param {Buffer} text
 */
function lastLinesStart(text) {
  let at = text.length - (text.at(-1) === 10 ? 1 : 0);
  for (let line = 0; line < savedLogLinesMax; line++) {
    if (at <= 0) return 0;
    at = text.lastIndexOf(10, at - 1);
    if (at === -1) return 0;
  }
  return at + 1;
}

/**
 * What is kept of a log whose last bytes are `tail`, more having come
 * before them where `bytesCut`: those bytes cut further to their last
 * `savedLogLinesMax` lines, after the line saying the log was cut, or
 * nothing where nothing was cut.
 *
 * @param {Buffer} tail
 * @param {boolean} bytesCut
 * @returns {Buffer | undefined}
 */
export function savedLogKept(tail, bytesCut) {
  const start = lastLinesStart(tail);
  if (start === 0 && !bytesCut) return undefined;
  return start === 0
    ? savedLogText(tail, true)
    : Buffer.concat([Buffer.from(savedLogCutLine), tail.subarray(start)]);
}

/**
 * Cuts a log a workload wrote whole to the bounds `savedLogWritten` saves
 * one to, answering whether it was cut. The cut log is written beside it and
 * renamed over it.
 *
 * @param {string} file
 */
export async function savedLogTrimmed(file) {
  const handle = await open(file, "r");
  let tail;
  let bytesCut;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, savedLogBytesMax);
    tail = Buffer.alloc(length);
    await handle.read(tail, 0, length, size - length);
    bytesCut = size > savedLogBytesMax;
  } finally {
    await handle.close();
  }
  const text = savedLogKept(tail, bytesCut);
  if (text === undefined) return false;
  const staged = `${file}.${randomUUID()}`;
  try {
    await savedLogFile(staged, text);
    await rename(staged, file);
  } catch (failure) {
    await rm(staged, { force: true });
    throw failure;
  }
  return true;
}
