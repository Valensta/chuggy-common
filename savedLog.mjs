/**
 * How much of an ended workload's output a runner keeps: its last
 * `savedLogBytesMax` bytes, in a file only its owner can read, since what a
 * workload printed before its core began scrubbing can hold a secret. A log
 * cut to that opens with a line saying so, and begins at the first whole line
 * after the cut.
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
 * Writes a log's kept tail to `file`, owner-only whoever made it first.
 *
 * @param {string} file
 * @param {Buffer} tail
 * @param {boolean} cut
 */
export async function savedLogWritten(file, tail, cut) {
  const handle = await open(file, "w", savedLogMode);
  try {
    await handle.chmod(savedLogMode);
    await handle.writeFile(savedLogText(tail, cut));
  } finally {
    await handle.close();
  }
}

/**
 * Cuts a log a workload wrote whole to its last `savedLogBytesMax` bytes, as
 * `savedLogWritten` saves one, answering whether it was cut. The cut log is
 * written beside it and renamed over it.
 *
 * @param {string} file
 */
export async function savedLogTrimmed(file) {
  const handle = await open(file, "r");
  let tail;
  try {
    const { size } = await handle.stat();
    if (size <= savedLogBytesMax) return false;
    tail = Buffer.alloc(savedLogBytesMax);
    await handle.read(tail, 0, savedLogBytesMax, size - savedLogBytesMax);
  } finally {
    await handle.close();
  }
  const staged = `${file}.${randomUUID()}`;
  try {
    await savedLogWritten(staged, tail, true);
    await rename(staged, file);
  } catch (failure) {
    await rm(staged, { force: true });
    throw failure;
  }
  return true;
}
