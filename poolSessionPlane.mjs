/**
 * The session plane as a pool reaches it, for one thing: telling it that a
 * session's container ended, under that session's own bearer, so the attempt
 * ends when its container did rather than when its lease runs out. The pool
 * says only how the container ended; what the attempt is recorded under is
 * the plane's to derive.
 *
 * The call is made once, as `./poolJobPlane.mjs` ends a job, because an
 * attempt the plane did not hear about is still ended by its lease. A refusal
 * is final, because nothing a second call carries would change it.
 */

import {
  sessionEndedSchema,
  sessionPlaneRoutes,
} from "@chuggy/worker-contract/sessionPlane";

import { poolAttemptStatus, poolEndAnswer } from "./poolJobPlane.mjs";

/**
 * @typedef {import("./poolLoop.mjs").WorkerPoolEndAnswer} WorkerPoolEndAnswer
 * @typedef {import("./poolLoop.mjs").WorkerPoolSessionEnd} WorkerPoolSessionEnd
 * @typedef {import("./poolLoop.mjs").WorkerPoolSessionPlane} WorkerPoolSessionPlane
 *
 * @typedef {object} PoolSessionPlaneClientSettings
 * @property {number} timeoutMs each call's own
 */

/**
 * @param {PoolSessionPlaneClientSettings} input
 * @returns {PoolSessionPlaneClientSettings}
 */
export function checkedPoolSessionPlaneClientSettings(input) {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)
    throw new RangeError(
      "pool session plane timeout must be a positive integer",
    );
  return input;
}

/**
 * The body is checked before anything is sent, so a backend naming no end the
 * contract knows throws out of the run, as an unknown placement does, rather
 * than reading as an outage.
 *
 * @param {PoolSessionPlaneClientSettings} settings
 * @param {typeof fetch} fetcher
 * @param {WorkerPoolSessionEnd} ended
 * @returns {Promise<WorkerPoolEndAnswer>}
 */
async function poolSessionPlaneEnded(settings, fetcher, ended) {
  const body = JSON.stringify(sessionEndedSchema.parse({ phase: ended.phase }));
  try {
    return poolEndAnswer(
      await poolAttemptStatus(
        settings,
        fetcher,
        ended.session,
        sessionPlaneRoutes.ended.path,
        {
          method: sessionPlaneRoutes.ended.method,
          contentType: "application/json",
          body,
        },
      ),
    );
  } catch {
    return "Unavailable";
  }
}

/**
 * @param {PoolSessionPlaneClientSettings} input
 * @param {typeof fetch} [fetcher]
 * @returns {WorkerPoolSessionPlane}
 */
export function poolSessionPlaneClient(input, fetcher = globalThis.fetch) {
  const settings = checkedPoolSessionPlaneClientSettings(input);
  return { end: (ended) => poolSessionPlaneEnded(settings, fetcher, ended) };
}

/**
 * The phase a session's process is reported to have ended in: `Succeeded`
 * where it ended as it should, `Failed` wherever it did not.
 *
 * @param {boolean} succeeded
 * @returns {WorkerPoolSessionEnd["phase"]}
 */
export function poolSessionPhase(succeeded) {
  return succeeded ? "Succeeded" : "Failed";
}
