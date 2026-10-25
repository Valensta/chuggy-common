/**
 * The record every runner using one engine on a machine keeps of the images
 * it used, in one file: what each placement in flight holds, when each image
 * was last used and as what, which a job's image the runner pulled itself is
 * by its id then, and the repositories chuggy's runtime and sessions came
 * from. `imageSweep.mjs` decides from it.
 *
 * A CHANGE IS MADE UNDER THE RECORD'S LOCK, `fileLock.mjs`'s beside it, and
 * written whole to a file of its own that is renamed over the record, so a
 * reader never sees half of one. Two runners that judge the same abandoned
 * lock at once can both hold one: that takes a runner that died holding it,
 * and what it costs is one write lost or one removal decided without the
 * other's hold, which fails that placement's start and removes nothing a
 * container uses, since no removal is forced.
 *
 * A RECORD THIS RUNNER CANNOT READ IS BEGUN AGAIN: one that is not there, is
 * larger than `imageRecordBytesMax`, or is not a record. Forgetting can only
 * keep an image, since nothing is removed for being absent from it. One a
 * later version wrote is never written or swept by this one. A field this
 * version does not know is kept through every change, so a version that adds
 * one need not be a later version.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { z } from "zod";

import { fileLocked, fileLockHolderAlive } from "./fileLock.mjs";
import { imageName } from "./imageSweep.mjs";

/**
 * @typedef {z.infer<typeof imageRecordSchema>} ImageRecord
 * @typedef {import("./imageSweep.mjs").ImageUseKind} ImageUseKind
 *
 * @typedef {object} ImageUse an image a placement used
 * @property {string} reference as its assignment named it
 * @property {ImageUseKind} kind
 * @property {string} [pulledId] its id once this runner pulled it
 *
 * @typedef {{read: "Record", record: ImageRecord}
 *   | {read: "Begun", record: ImageRecord, why?: string}
 *   | {read: "Later", version: number}} ImageRecordRead
 *
 * @typedef {import("./fileLock.mjs").FileLockPorts} FileLockPorts
 */

/** The record's own version, which a later one raises only where this one would misread it. */
export const imageRecordVersion = 1;

/** Far above a record of every image one machine holds. */
export const imageRecordBytesMax = 4 * 1024 * 1024;

/** The longest every engine call made under the lock may take together. */
export const imageRecordHoldCallsMsMax = 120_000;

/** How old the lock may be before it is abandoned: longer than any hold, its engine calls and file writes included. */
export const imageRecordLockHeldMsMax = imageRecordHoldCallsMsMax + 60_000;

/** How long a change waits for another's hold: longer than any live hold lasts, so it waits one out. */
export const imageRecordLockWaitMsMax = imageRecordLockHeldMsMax + 60_000;

const imageRecordFileMode = 0o600;
const imageRecordDirectoryMode = 0o700;

const imageRecordSchema = z.looseObject({
  version: z.literal(imageRecordVersion),
  createdMs: z.number(),
  sweptMs: z.number().optional(),
  repositories: z.record(
    z.string(),
    z.looseObject({ kinds: z.array(z.string()) }),
  ),
  images: z.record(
    z.string(),
    z.looseObject({
      kinds: z.array(z.string()),
      usedMs: z.number(),
      pulledId: z.string().optional(),
    }),
  ),
  holds: z.record(
    z.string(),
    z.looseObject({ images: z.array(z.string()), untilMs: z.number() }),
  ),
});

/**
 * @param {number} nowMs
 * @returns {ImageRecord}
 */
function imageRecordBegun(nowMs) {
  return {
    version: imageRecordVersion,
    createdMs: nowMs,
    repositories: {},
    images: {},
    holds: {},
  };
}

/**
 * The record's text, or why it has none this runner reads.
 *
 * @param {string} file
 * @returns {Promise<{text: string} | {why?: string}>}
 */
async function imageRecordText(file) {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (failure) {
    if (/** @type {NodeJS.ErrnoException} */ (failure).code === "ENOENT")
      return {};
    throw failure;
  }
  try {
    const { size } = await handle.stat();
    if (size > imageRecordBytesMax)
      return { why: `it is larger than ${String(imageRecordBytesMax)} bytes` };
    return { text: await handle.readFile("utf8") };
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} file
 * @param {number} nowMs
 * @returns {Promise<ImageRecordRead>}
 */
export async function imageRecordRead(file, nowMs) {
  const read = await imageRecordText(file);
  if (!("text" in read))
    return { read: "Begun", record: imageRecordBegun(nowMs), ...read };
  let parsed;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return {
      read: "Begun",
      record: imageRecordBegun(nowMs),
      why: "it is not JSON",
    };
  }
  const version = parsed?.version;
  if (typeof version === "number" && version > imageRecordVersion)
    return { read: "Later", version };
  const checked = imageRecordSchema.safeParse(parsed);
  return checked.success
    ? { read: "Record", record: checked.data }
    : {
        read: "Begun",
        record: imageRecordBegun(nowMs),
        why: "it is not a record of this version's",
      };
}

/**
 * @param {string} file
 * @param {ImageRecord} record
 */
async function imageRecordWritten(file, record) {
  const staged = `${file}.${randomUUID()}`;
  try {
    await writeFile(staged, `${JSON.stringify(record)}\n`, {
      flag: "wx",
      mode: imageRecordFileMode,
    });
    await rename(staged, file);
  } catch (failure) {
    await rm(staged, { force: true });
    throw failure;
  }
}

/** @type {FileLockPorts} */
const imageRecordLockPorts = {
  pid: process.pid,
  nowMs: Date.now,
  wait,
  holderAlive: fileLockHolderAlive,
};

/**
 * Runs `change` on the record under its lock, and writes the record it
 * answers; `change` answering nothing writes nothing. A record a later
 * version wrote is handed to no change.
 *
 * @template T
 * @param {string} file
 * @param {() => number} nowMs
 * @param {(read: Exclude<ImageRecordRead, {read: "Later"}>) => Promise<{record?: ImageRecord, answer: T}>} change
 * @param {Partial<FileLockPorts>} [ports]
 * @returns {Promise<{changed: true, answer: T} | {changed: false, version: number}>}
 */
export async function imageRecordChanged(file, nowMs, change, ports = {}) {
  await mkdir(dirname(file), {
    recursive: true,
    mode: imageRecordDirectoryMode,
  });
  const lockPath = `${file}.lock`;
  return fileLocked(
    lockPath,
    {
      waitMsMax: imageRecordLockWaitMsMax,
      heldMsMax: imageRecordLockHeldMsMax,
      pollMs: 100,
      busy: `another runner has held the image record's lock at ${lockPath} for longer than a change waits`,
    },
    { ...imageRecordLockPorts, ...ports },
    async () => {
      const read = await imageRecordRead(file, nowMs());
      if (read.read === "Later")
        return { changed: /** @type {const} */ (false), version: read.version };
      const { record, answer } = await change(read);
      if (record !== undefined) await imageRecordWritten(file, record);
      return { changed: /** @type {const} */ (true), answer };
    },
  );
}

/**
 * The record without the holds that have run out.
 *
 * @param {ImageRecord} record
 * @param {number} nowMs
 * @returns {ImageRecord}
 */
function holdsLive(record, nowMs) {
  return {
    ...record,
    holds: Object.fromEntries(
      Object.entries(record.holds).filter(([, hold]) => hold.untilMs > nowMs),
    ),
  };
}

/**
 * A placement's hold on the images it is about to use, until its deadline.
 *
 * @param {ImageRecord} record
 * @param {string} name the placement's container
 * @param {readonly string[]} images
 * @param {number} untilMs
 * @param {number} nowMs
 * @returns {ImageRecord}
 */
export function imageHoldTaken(record, name, images, untilMs, nowMs) {
  const live = holdsLive(record, nowMs);
  return {
    ...live,
    holds: { ...live.holds, [name]: { images: [...images], untilMs } },
  };
}

/**
 * @param {readonly string[]} kinds
 * @param {string} kind
 */
const kindAdded = (kinds, kind) =>
  kinds.includes(kind) ? [...kinds] : [...kinds, kind];

/**
 * What a placement used, recorded as used now, its hold dropped.
 *
 * @param {ImageRecord} record
 * @param {string} name the placement's container
 * @param {readonly ImageUse[]} uses
 * @param {number} nowMs
 * @returns {ImageRecord}
 */
export function imageUsesRecorded(record, name, uses, nowMs) {
  const live = holdsLive(record, nowMs);
  const holds = Object.fromEntries(
    Object.entries(live.holds).filter(([held]) => held !== name),
  );
  const images = { ...live.images };
  const repositories = { ...live.repositories };
  for (const { reference, kind, pulledId } of uses) {
    const entry = images[reference];
    images[reference] = {
      ...entry,
      kinds: kindAdded(entry?.kinds ?? [], kind),
      usedMs: nowMs,
      ...(pulledId === undefined ? {} : { pulledId }),
    };
    if (kind === "Job") continue;
    const { repository } = imageName(reference);
    repositories[repository] = {
      ...repositories[repository],
      kinds: kindAdded(repositories[repository]?.kinds ?? [], kind),
    };
  }
  return { ...live, holds, images, repositories };
}

/**
 * The record without these entries.
 *
 * @param {ImageRecord} record
 * @param {readonly string[]} references
 * @returns {ImageRecord}
 */
export function imageEntriesForgotten(record, references) {
  const gone = new Set(references);
  return {
    ...record,
    images: Object.fromEntries(
      Object.entries(record.images).filter(
        ([reference]) => !gone.has(reference),
      ),
    ),
  };
}
