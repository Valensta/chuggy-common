/**
 * The job plane as a pool reaches it, for one thing: ending the attempt of a
 * workload that ended without its harness reporting, under that assignment's
 * own bearer, as a crashed harness ends its own. The attempt then ends when
 * its workload did rather than when its lease runs out. A job the pool
 * refused is not ended here but only left its text, since its refusal is the
 * pool plane's to settle.
 *
 * Each call is made once and nothing here retries it, because an attempt the
 * plane did not hear about is still ended by its lease. One that already
 * reported is no longer live, so the plane refuses this and the report stands.
 */

import { Buffer } from "node:buffer";
import { URL } from "node:url";

import {
  runEndedEvidences,
  workerPlaneBytesMediaType,
  workerPlaneRoutes,
} from "@chuggy/worker-contract/workerPlane";

import { workerReportText } from "./checks.mjs";
import { credentialScrub, workerErrorPath } from "./runEvidence.mjs";
import { workerPlaneHeaders } from "./transport.mjs";
import { rosterLabel, routePath } from "./wire.mjs";

/**
 * @typedef {import("./poolLoop.mjs").WorkerPoolAttempt} WorkerPoolAttempt
 * @typedef {import("./poolLoop.mjs").WorkerPoolEndAnswer} WorkerPoolEndAnswer
 * @typedef {import("./poolLoop.mjs").WorkerPoolJobEnd} WorkerPoolJobEnd
 * @typedef {import("./poolLoop.mjs").WorkerPoolJobPlane} WorkerPoolJobPlane
 *
 * @typedef {object} PoolJobPlaneClientSettings
 * @property {number} timeoutMs each call's own
 */

const runFailed = rosterLabel(runEndedEvidences, "RunFailed");

/**
 * The error text an ended workload leaves: the backend's reason, as a report
 * carries any text, scrubbed of the bearer it was handed.
 *
 * @param {WorkerPoolJobEnd} ended
 */
export function poolJobEndedText({ job, why }) {
  return `${workerReportText(
    `Worker exited before reporting: ${why}`,
    credentialScrub([job.bearer]),
  )}\n`;
}

/**
 * The error text a refused job leaves: the backend's reason alone, since its
 * workload may never have started, scrubbed as an ended workload's is.
 *
 * @param {WorkerPoolJobEnd} ended
 */
export function poolJobRefusedText({ job, why }) {
  return `${workerReportText(why, credentialScrub([job.bearer]))}\n`;
}

/**
 * @param {PoolJobPlaneClientSettings} input
 * @returns {PoolJobPlaneClientSettings}
 */
export function checkedPoolJobPlaneClientSettings(input) {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)
    throw new RangeError("pool job plane timeout must be a positive integer");
  return input;
}

/**
 * One call to an attempt's plane, resolved against its callback as the
 * harness resolves its own, answered by its status alone. A session's end is
 * the same call to its own plane (`./poolSessionPlane.mjs`).
 *
 * @param {PoolJobPlaneClientSettings} settings
 * @param {typeof fetch} fetcher
 * @param {WorkerPoolAttempt} attempt
 * @param {string} path
 * @param {{method: string, contentType: string, body: string | Buffer}} sent
 */
export async function poolAttemptStatus(
  settings,
  fetcher,
  attempt,
  path,
  sent,
) {
  const answered = await fetcher(new URL(path, attempt.callbackUrl), {
    method: sent.method,
    signal: globalThis.AbortSignal.timeout(settings.timeoutMs),
    headers: workerPlaneHeaders(attempt.bearer, {
      "content-type": sent.contentType,
    }),
    body: sent.body,
  });
  await answered.body?.cancel();
  return answered.status;
}

/**
 * @param {number} status
 * @returns {WorkerPoolEndAnswer}
 */
export function poolEndAnswer(status) {
  if (status === 204) return "Ended";
  if (status >= 400 && status < 500) return "Refused";
  return "Unavailable";
}

/**
 * Leaves an attempt its error text, the answer unread: what follows is asked
 * for either way.
 *
 * @param {PoolJobPlaneClientSettings} settings
 * @param {typeof fetch} fetcher
 * @param {WorkerPoolJobEnd} ended
 * @param {string} text
 */
async function poolJobErrorLeft(settings, fetcher, ended, text) {
  try {
    await poolAttemptStatus(
      settings,
      fetcher,
      ended.job,
      routePath(workerPlaneRoutes.artifact, workerErrorPath),
      {
        method: workerPlaneRoutes.artifact.method,
        contentType: workerPlaneBytesMediaType,
        body: Buffer.from(text),
      },
    );
  } catch {
    // What follows is asked for regardless.
  }
}

/**
 * The error text first, since only a live attempt takes it: the end is what
 * matters, and is asked for either way.
 *
 * @param {PoolJobPlaneClientSettings} settings
 * @param {typeof fetch} fetcher
 * @param {WorkerPoolJobEnd} ended
 * @returns {Promise<WorkerPoolEndAnswer>}
 */
async function poolJobPlaneEnded(settings, fetcher, ended) {
  await poolJobErrorLeft(settings, fetcher, ended, poolJobEndedText(ended));
  try {
    return poolEndAnswer(
      await poolAttemptStatus(
        settings,
        fetcher,
        ended.job,
        workerPlaneRoutes.runEnded.path,
        {
          method: workerPlaneRoutes.runEnded.method,
          contentType: "application/json",
          body: JSON.stringify({ evidence: runFailed }),
        },
      ),
    );
  } catch {
    return "Unavailable";
  }
}

/**
 * @param {PoolJobPlaneClientSettings} input
 * @param {typeof fetch} [fetcher]
 * @returns {WorkerPoolJobPlane}
 */
export function poolJobPlaneClient(input, fetcher = globalThis.fetch) {
  const settings = checkedPoolJobPlaneClientSettings(input);
  return {
    end: (ended) => poolJobPlaneEnded(settings, fetcher, ended),
    left: (ended) =>
      poolJobErrorLeft(settings, fetcher, ended, poolJobRefusedText(ended)),
  };
}
