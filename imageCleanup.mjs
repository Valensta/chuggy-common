/**
 * What a container backend does with this machine's images through the
 * record `imageRecord.mjs` keeps: each placement holds the images it is about
 * to use before it looks for them and records their use once its `run` has
 * answered, and a sweep removes what `imageSweep.mjs` decides, every
 * `imageSweepIntervalMs`, by whichever runner sharing the record finds it due.
 *
 * NO REMOVAL IS FORCED. Each is decided again under the record's lock, from
 * the record as it then is and the image as the engine then describes it, so
 * a hold taken since the sweep began keeps its image: a placement inspects
 * only after its hold is written, and an image gone by then is one it pulls.
 * An image a container uses is one the engine refuses to remove, which costs
 * one line. A removal the engine refuses for any other cause is logged and
 * the sweep goes on; one of an engine it could not reach, or a record it could
 * not write, ends the sweep there.
 *
 * NOTHING HERE FAILS A PLACEMENT OR A PASS. A hold or a use that could not be
 * recorded is logged and the placement goes on, and a sweep runs behind the
 * pass that found it due.
 *
 * A RECLAIM is a sweep that keeps only the newest of a runtime or session
 * repository's untagged images and ignores the retention, oldest use first
 * until its signal aborts, made in turn with the sweeps.
 */

import { z } from "zod";

import {
  imageInspectArgv,
  imageInspectManyArgv,
  imageListArgv,
  imageRemoveArgv,
} from "./engineArgv.mjs";
import { engineFailure, engineFailureLine } from "./engineErrors.mjs";
import {
  imageEntriesForgotten,
  imageHoldTaken,
  imageRecordChanged,
  imageRecordHoldCallsMsMax,
  imageRecordRead,
  imageUsesRecorded,
} from "./imageRecord.mjs";
import {
  imageEntriesStale,
  imageSweepRemovals,
  storedImage,
} from "./imageSweep.mjs";

/**
 * @typedef {import("./engine.mjs").Engine} Engine
 * @typedef {import("./engine.mjs").EngineAnswer} EngineAnswer
 * @typedef {import("./imageRecord.mjs").ImageRecord} ImageRecord
 * @typedef {import("./imageRecord.mjs").ImageRecordRead} ImageRecordRead
 * @typedef {import("./imageRecord.mjs").ImageUse} ImageUse
 * @typedef {import("./imageSweep.mjs").ImageRemoval} ImageRemoval
 * @typedef {import("./imageSweep.mjs").ImageSweepPolicy} ImageSweepPolicy
 * @typedef {import("./imageSweep.mjs").StoredImage} StoredImage
 *
 * @typedef {object} ImageCleanupSettings
 * @property {string} record the record's file, one for every runner on this machine using this engine as this user
 * @property {number} unusedSecsMax how long a job's image the runner pulled may go unused before it is removed; 0 keeps them
 *
 * @typedef {object} ImageCleanupSeams
 * @property {Engine} engine
 * @property {() => number} nowMs
 * @property {(line: string) => void} log
 * @property {Partial<import("./fileLock.mjs").FileLockPorts>} [lockPorts]
 *
 * @typedef {object} ImageCleanup
 * @property {(name: string, images: readonly string[], untilMs: number) => Promise<void>} held a placement's hold, until its deadline
 * @property {(name: string, uses: readonly ImageUse[]) => Promise<void>} used what a placement used, its hold dropped
 * @property {(image: string) => Promise<string | undefined>} pulledId the id of an image just pulled, where the record keeps one
 * @property {() => void} due starts a sweep behind the caller where one is due
 * @property {(signal: AbortSignal) => Promise<string[]>} reclaimed the references a reclaim removed
 * @property {() => Promise<void>} settled
 */

/** How often a machine's images are swept. */
export const imageSweepIntervalMs = 3_600_000;

/** The retention a runner's job images get where its runner names none. */
export const imageUnusedSecsMaxDefault = 604_800;

/** How many images one inspection names. */
const imageInspectBatch = 64;

const inspectedImagesSchema = z.array(
  z.looseObject({
    Id: z.string(),
    RepoTags: z.array(z.string()).nullish(),
    RepoDigests: z.array(z.string()).nullish(),
    Created: z.string().nullish(),
  }),
);

/** A cleanup that holds, records and removes nothing, for a backend given no record. */
export const imageCleanupNone = /** @type {ImageCleanup} */ ({
  held: async () => undefined,
  used: async () => undefined,
  pulledId: async () => undefined,
  due: () => undefined,
  reclaimed: async () => [],
  settled: async () => undefined,
});

/**
 * @typedef {object} CleanupState
 * @property {ImageCleanupSettings} settings
 * @property {ImageCleanupSeams} seams
 * @property {number} nextCheckMs when a sweep may next be due
 * @property {boolean} sweepQueued
 * @property {Promise<unknown>} queue the sweeps and reclaims, each after the last
 * @property {boolean} laterLogged
 */

/**
 * A change to the record, or nothing where it could not be made, which is
 * logged as `what` could not be recorded.
 *
 * @template T
 * @param {CleanupState} state
 * @param {string} what
 * @param {(read: Exclude<ImageRecordRead, {read: "Later"}>) => Promise<{record?: ImageRecord, answer: T}>} change
 * @returns {Promise<T | undefined>}
 */
async function recordChange(state, what, change) {
  const { settings, seams } = state;
  try {
    const changed = await imageRecordChanged(
      settings.record,
      seams.nowMs,
      async (read) => {
        if (read.read === "Begun" && read.why !== undefined)
          seams.log(
            `the image record at ${settings.record} is begun again: ${read.why}`,
          );
        return change(read);
      },
      seams.lockPorts,
    );
    if (changed.changed) return changed.answer;
    if (!state.laterLogged)
      seams.log(
        `the image record at ${settings.record} is version ${String(changed.version)}'s, which this runner neither changes nor sweeps by`,
      );
    state.laterLogged = true;
  } catch (failure) {
    seams.log(
      `${what} could not be recorded in ${settings.record}: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }
  return undefined;
}

/**
 * The images an inspection describes, which the engine answers for though one
 * was removed since it was named; or nothing where it could not, logged.
 *
 * @param {CleanupState} state
 * @param {readonly string[]} ids
 * @param {AbortSignal} [signal]
 * @returns {Promise<StoredImage[] | undefined>}
 */
async function inspectedImages(state, ids, signal) {
  const answer = await state.seams.engine.exec(imageInspectManyArgv(ids), {
    signal,
  });
  const gone = answer.code !== 0 && engineFailure(answer) === "NotFound";
  if (answer.code !== 0 && !gone) {
    state.seams.log(
      `this machine's images could not be inspected: ${engineFailureLine(answer)}`,
    );
    return undefined;
  }
  if (gone && answer.stdout.trim() === "") return [];
  try {
    return inspectedImagesSchema
      .parse(JSON.parse(answer.stdout))
      .map(storedImage);
  } catch {
    state.seams.log(
      "the engine answered an inspection of this machine's images this runner cannot read",
    );
    return undefined;
  }
}

/**
 * Every image this machine's engine holds, or nothing where it could not say,
 * logged.
 *
 * @param {CleanupState} state
 * @returns {Promise<StoredImage[] | undefined>}
 */
async function machineImages(state) {
  const listed = await state.seams.engine.exec(imageListArgv());
  if (listed.code !== 0) {
    state.seams.log(
      `this machine's images could not be listed: ${engineFailureLine(listed)}`,
    );
    return undefined;
  }
  const ids = [
    ...new Set(
      listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ];
  /** @type {StoredImage[]} */
  const images = [];
  for (let start = 0; start < ids.length; start += imageInspectBatch) {
    const batch = await inspectedImages(
      state,
      ids.slice(start, start + imageInspectBatch),
    );
    if (batch === undefined) return undefined;
    images.push(...batch);
  }
  return images;
}

/**
 * What one removal's line says of when its image was last used.
 *
 * @param {ImageRemoval} removal
 */
function removalUse(removal) {
  return removal.usedMs === undefined
    ? "which no runner here was recorded using"
    : `last used ${new Date(removal.usedMs).toISOString()}`;
}

/**
 * Removes each name a removal names, unforced, answering which went, whether
 * all did, and whether the sweep is to end here.
 *
 * @param {CleanupState} state
 * @param {ImageRemoval} removal
 * @param {AbortSignal} signal
 */
async function referencesRemoved(state, removal, signal) {
  const { engine, log } = state.seams;
  /** @type {string[]} */
  const removed = [];
  for (const reference of removal.references) {
    let answer;
    try {
      answer = await engine.exec(imageRemoveArgv(reference), { signal });
    } catch {
      log(`${reference} was not removed: the engine did not answer in time`);
      return { removed, all: false, ended: true };
    }
    const failure = answer.code === 0 ? undefined : engineFailure(answer);
    if (failure === undefined || failure === "NotFound") {
      removed.push(reference);
      continue;
    }
    log(
      failure === "ImageInUse"
        ? `${reference} is kept: a container uses it`
        : `${reference} was not removed: ${engineFailureLine(answer)}`,
    );
    return { removed, all: false, ended: failure === "Unreachable" };
  }
  log(`removed ${removal.references.join(", ")}, ${removalUse(removal)}`);
  return { removed, all: true, ended: false };
}

/**
 * One image's removal, decided again under the lock from the record as it
 * now is and the image as the engine now describes it. Answers the names
 * that went, or nothing where the sweep is to end.
 *
 * @param {CleanupState} state
 * @param {ImageRemoval} candidate
 * @param {readonly StoredImage[]} images
 * @param {ImageSweepPolicy} policy
 * @returns {Promise<string[] | undefined>}
 */
async function candidateRemoved(state, candidate, images, policy) {
  const signal = globalThis.AbortSignal.timeout(imageRecordHoldCallsMsMax);
  const { id } = candidate.image;
  const outcome = await recordChange(
    state,
    `the removal of ${candidate.references.join(", ")}`,
    async (read) => {
      if (read.read === "Begun") return { answer: undefined };
      const fresh = await inspectedImages(state, [id], signal);
      if (fresh === undefined) return { answer: undefined };
      const [now] = fresh;
      if (now === undefined)
        return {
          record: imageEntriesForgotten(read.record, candidate.forgotten),
          answer: [],
        };
      const again = imageSweepRemovals(
        images.map((image) => (image.id === id ? now : image)),
        read.record,
        state.seams.nowMs(),
        policy,
      ).find((removal) => removal.image.id === id);
      if (again === undefined) return { answer: [] };
      const result = await referencesRemoved(state, again, signal);
      return {
        record: result.all
          ? imageEntriesForgotten(read.record, again.forgotten)
          : undefined,
        answer: result.ended ? undefined : result.removed,
      };
    },
  );
  return outcome;
}

/**
 * The removals a sweep or a reclaim makes, from one listing of the images:
 * the record's stale entries forgotten first, and for a sweep the interval
 * claimed, so that one runner sharing the record sweeps it. Answers the
 * names removed.
 *
 * @param {CleanupState} state
 * @param {ImageSweepPolicy} policy
 * @param {{claim: boolean, signal?: AbortSignal}} made
 * @returns {Promise<string[]>}
 */
async function removalsMade(state, policy, made) {
  const listedMs = state.seams.nowMs();
  const images = await machineImages(state);
  if (images === undefined) return [];
  const claimed = await recordChange(
    state,
    "a sweep of this machine's images",
    async ({ record }) => {
      if (made.claim && sweptWithin(record, listedMs))
        return { answer: undefined };
      const forgotten = imageEntriesForgotten(
        record,
        imageEntriesStale(images, record, listedMs),
      );
      const next = made.claim ? { ...forgotten, sweptMs: listedMs } : forgotten;
      return { record: next, answer: next };
    },
  );
  if (claimed === undefined) return [];
  /** @type {string[]} */
  const removed = [];
  let present = images;
  const removals = imageSweepRemovals(
    images,
    claimed,
    state.seams.nowMs(),
    policy,
  );
  for (const candidate of removals) {
    if (made.signal?.aborted === true) break;
    const gone = await candidateRemoved(state, candidate, present, policy);
    if (gone === undefined) break;
    removed.push(...gone);
    present = present.filter((image) => image.id !== candidate.image.id);
  }
  return removed;
}

/**
 * Whether the record was swept within the interval before `nowMs`.
 *
 * @param {ImageRecord} record
 * @param {number} nowMs
 */
function sweptWithin(record, nowMs) {
  return (
    record.sweptMs !== undefined &&
    nowMs - record.sweptMs < imageSweepIntervalMs
  );
}

/**
 * A sweep where the record says one is due, which next looks again an
 * interval after the last.
 *
 * @param {CleanupState} state
 */
async function swept(state) {
  const { settings, seams } = state;
  const nowMs = seams.nowMs();
  state.nextCheckMs = nowMs + imageSweepIntervalMs;
  const read = await imageRecordRead(settings.record, nowMs);
  if (read.read === "Later") return;
  if (read.read === "Record" && sweptWithin(read.record, nowMs)) {
    state.nextCheckMs =
      /** @type {number} */ (read.record.sweptMs) + imageSweepIntervalMs;
    return;
  }
  await removalsMade(
    state,
    {
      keptPerRepository: 2,
      unusedMsMax: settings.unusedSecsMax * 1000,
    },
    { claim: true },
  );
}

/**
 * `made` after every sweep and reclaim before it, its failure logged.
 *
 * @template T
 * @param {CleanupState} state
 * @param {() => Promise<T>} made
 * @param {T} failed what it answers where it failed
 * @returns {Promise<T>}
 */
function queued(state, made, failed) {
  const next = state.queue.then(made).catch((failure) => {
    state.seams.log(
      `this machine's images were not swept: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
    return failed;
  });
  state.queue = next;
  return next;
}

/**
 * @param {ImageCleanupSettings} settings
 * @param {ImageCleanupSeams} seams
 * @returns {ImageCleanup}
 */
export function imageCleanup(settings, seams) {
  /** @type {CleanupState} */
  const state = {
    settings,
    seams,
    nextCheckMs: 0,
    sweepQueued: false,
    queue: Promise.resolve(),
    laterLogged: false,
  };
  return {
    held: async (name, images, untilMs) => {
      await recordChange(
        state,
        `${name}'s hold on its images`,
        async (read) => ({
          record: imageHoldTaken(
            read.record,
            name,
            images,
            untilMs,
            seams.nowMs(),
          ),
          answer: undefined,
        }),
      );
    },
    used: async (name, uses) => {
      await recordChange(
        state,
        `${name}'s use of its images`,
        async (read) => ({
          record: imageUsesRecorded(read.record, name, uses, seams.nowMs()),
          answer: undefined,
        }),
      );
    },
    pulledId: async (image) => {
      const answer = await seams.engine.exec(imageInspectArgv(image));
      return answer.code === 0 ? answer.stdout.trim() : undefined;
    },
    due: () => {
      if (state.sweepQueued || seams.nowMs() < state.nextCheckMs) return;
      state.sweepQueued = true;
      void queued(
        state,
        () => swept(state).finally(() => (state.sweepQueued = false)),
        undefined,
      );
    },
    reclaimed: (signal) =>
      queued(
        state,
        () =>
          removalsMade(
            state,
            { keptPerRepository: 1, unusedMsMax: "Ignored" },
            { claim: false, signal },
          ),
        /** @type {string[]} */ ([]),
      ),
    settled: async () => {
      await state.queue;
    },
  };
}
