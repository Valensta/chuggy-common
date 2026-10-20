/**
 * The pool loop's plane: the poll and the settlement over HTTP. chuggy's
 * `src/adapters/http/poolPlaneClient.ts` is the same client in TypeScript.
 *
 * The status is the answer and nothing here retries it; a settlement's 409 is
 * the one status two answers share, told apart by its body. An answer this
 * side cannot read is an outage rather than a denial, because a denial ends
 * the pool over a skew the plane did not refuse.
 *
 * A runner names its package and version on the poll, and the answer may name
 * the release chuggy pins for that package; the cluster's client names none.
 */

import { TextDecoder } from "node:util";
import { URL } from "node:url";

import {
  contractVersionRefusalSchema,
  contractVersionRefusalStatus,
  workerContractRelease,
} from "@chuggy/worker-contract/workerContract";
import {
  workerPoolPollQuery,
  workerPoolPollRoute,
  workerPoolReconciliationSchema,
  workerPoolSettlementPath,
  workerRunnerHeader,
  workerRunnerSchema,
} from "@chuggy/worker-contract/workerPool";

import { boundedResponseBytes } from "./boundedResponse.mjs";
import { workerPlaneHeaders } from "./transport.mjs";

/**
 * @typedef {import("@chuggy/worker-contract/workerPool").AssignmentOutcome} AssignmentOutcome
 * @typedef {import("@chuggy/worker-contract/workerPool").WorkerRunner} WorkerRunner
 * @typedef {import("./poolLoop.mjs").WorkerPoolPlane} WorkerPoolPlane
 * @typedef {import("./poolLoop.mjs").WorkerPoolPolled} WorkerPoolPolled
 * @typedef {import("./poolLoop.mjs").WorkerPoolSettled} WorkerPoolSettled
 *
 * @typedef {object} PoolPlaneClientSettings
 * @property {string} baseUrl
 * @property {number} pollTimeoutMs the operator's to size, since a long poll cut shorter than the plane's own wait is an outage every idle window
 * @property {number} settleTimeoutMs
 * @property {WorkerRunner} [runner] the runner's package and version, which each poll names
 */

/** The most one reconciliation may weigh, orders above a bounded batch of assignments. */
export const poolPlaneAnswerBytesMax = 1024 * 1024;

/** How many chunks that may arrive in, which ends a body yielding empty ones. */
const poolPlaneAnswerReadsMax = 1_024;

/**
 * The answer as text, or nothing where it passed a bound or was no UTF-8: a
 * bound passed is this client's own refusal, read by the caller as an outage.
 *
 * @param {Response} answered
 * @returns {Promise<string | undefined>}
 */
async function poolPlaneAnswerText(answered) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await boundedResponseBytes(
        answered,
        poolPlaneAnswerBytesMax,
        poolPlaneAnswerReadsMax,
      ),
    );
  } catch {
    return undefined;
  }
}

/**
 * @param {PoolPlaneClientSettings} input
 * @returns {PoolPlaneClientSettings}
 */
export function checkedPoolPlaneClientSettings(input) {
  const url = new URL(
    input.baseUrl.endsWith("/") ? input.baseUrl : `${input.baseUrl}/`,
  );
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new RangeError("pool plane URL must be HTTP or HTTPS");
  if (url.username !== "" || url.password !== "")
    throw new RangeError("pool plane URL must carry no credentials");
  for (const [name, bound] of [
    ["poll", input.pollTimeoutMs],
    ["settle", input.settleTimeoutMs],
  ])
    if (!Number.isSafeInteger(bound) || bound < 1)
      throw new RangeError(
        `pool plane ${name} timeout must be a positive integer`,
      );
  if (
    input.runner !== undefined &&
    !workerRunnerSchema.safeParse(input.runner).success
  )
    throw new RangeError(
      "pool plane runner must name a package and a plain release version",
    );
  return { ...input, baseUrl: url.toString() };
}

/**
 * A contract route joined beneath the base, which may carry a path prefix of
 * its own that a route spelled from the root would replace.
 *
 * @param {PoolPlaneClientSettings} settings
 * @param {string} route
 */
function poolPlaneUrl(settings, route) {
  return new URL(route.replace(/^\//u, ""), settings.baseUrl);
}

/**
 * @param {PoolPlaneClientSettings} settings
 * @param {readonly string[]} held
 * @param {number} wanted
 * @param {number} wantedSessions
 */
function poolPlaneAssignmentsUrl(settings, held, wanted, wantedSessions) {
  const url = poolPlaneUrl(settings, workerPoolPollRoute);
  for (const assignment of held)
    url.searchParams.append(workerPoolPollQuery.held, assignment);
  url.searchParams.set(workerPoolPollQuery.wanted, String(wanted));
  url.searchParams.set(
    workerPoolPollQuery.wantedSessions,
    String(wantedSessions),
  );
  return url;
}

/**
 * @param {number} status
 * @returns {WorkerPoolPolled}
 */
function poolPlaneRefusal(status) {
  if (status === 401) return { polled: "Stale" };
  if (status === 404)
    return { polled: "Denied", evidence: "the plane serves no such pool" };
  if (status === 400)
    return {
      polled: "Denied",
      evidence: "the plane refused this pool's own request",
    };
  if (status === contractVersionRefusalStatus)
    return {
      polled: "Denied",
      evidence: `the plane does not serve worker contract ${workerContractRelease}`,
    };
  return {
    polled: "Unavailable",
    evidence: `the plane answered ${String(status)}`,
  };
}

/**
 * @param {Response} answered
 * @returns {Promise<WorkerPoolPolled>}
 */
async function poolPlaneReconciled(answered) {
  const text = await poolPlaneAnswerText(answered);
  if (text === undefined)
    return {
      polled: "Unavailable",
      evidence: "the plane answered more than a reconciliation",
    };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { polled: "Unavailable", evidence: "the plane answered no JSON" };
  }
  const read = workerPoolReconciliationSchema.safeParse(parsed);
  return read.success
    ? {
        polled: "Reconciled",
        assignments: read.data.assignments,
        sessions: read.data.sessions,
        stop: read.data.stop,
        ...(read.data.release === undefined
          ? {}
          : { release: read.data.release }),
      }
    : {
        polled: "Unavailable",
        evidence: "the plane answered no reconciliation this pool can read",
      };
}

/**
 * @param {PoolPlaneClientSettings} settings
 * @param {typeof fetch} fetcher
 * @param {string} token
 * @param {readonly string[]} held
 * @param {number} wanted
 * @param {number} wantedSessions
 * @returns {Promise<WorkerPoolPolled>}
 */
async function poolPlanePolled(
  settings,
  fetcher,
  token,
  held,
  wanted,
  wantedSessions,
) {
  let answered;
  try {
    const url = poolPlaneAssignmentsUrl(settings, held, wanted, wantedSessions);
    const { runner } = settings;
    answered = await fetcher(url, {
      method: "GET",
      signal: globalThis.AbortSignal.timeout(settings.pollTimeoutMs),
      headers: workerPlaneHeaders(token, {
        accept: "application/json",
        ...(runner === undefined
          ? {}
          : { [workerRunnerHeader]: `${runner.package}/${runner.version}` }),
      }),
    });
  } catch {
    return {
      polled: "Unavailable",
      evidence: "the plane could not be reached",
    };
  }
  return answered.status === 200
    ? poolPlaneReconciled(answered)
    : poolPlaneRefusal(answered.status);
}

/**
 * A settlement's body, which is the outcome's arm without its tag.
 *
 * @param {AssignmentOutcome} outcome
 */
function poolPlaneOutcomeBody(outcome) {
  if (outcome.outcome !== "Refused") return "{}";
  const { evidence, fault } = outcome;
  return JSON.stringify(
    fault === undefined ? { evidence } : { evidence, fault },
  );
}

/**
 * Whether a 409 is the plane refusing this client's release rather than a
 * lost assignment.
 *
 * @param {Response} answered
 */
async function poolPlaneReleaseRefused(answered) {
  if (answered.status !== contractVersionRefusalStatus) return false;
  const text = await poolPlaneAnswerText(answered);
  if (text === undefined) return false;
  try {
    return contractVersionRefusalSchema.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

/**
 * @param {number} status
 * @returns {WorkerPoolSettled}
 */
function poolPlaneSettlement(status) {
  if (status === 204) return "Settled";
  if (status === 409) return "Lost";
  if (status === 401) return "Stale";
  if (status === 404 || status === 400) return "Denied";
  return "Unavailable";
}

/**
 * @param {PoolPlaneClientSettings} settings
 * @param {typeof fetch} fetcher
 * @param {string} token
 * @param {string} assignment
 * @param {AssignmentOutcome} outcome
 * @returns {Promise<WorkerPoolSettled>}
 */
async function poolPlaneSettled(settings, fetcher, token, assignment, outcome) {
  const url = poolPlaneUrl(
    settings,
    workerPoolSettlementPath(outcome.outcome, assignment),
  );
  try {
    const answered = await fetcher(url, {
      method: "POST",
      signal: globalThis.AbortSignal.timeout(settings.settleTimeoutMs),
      headers: workerPlaneHeaders(token, {
        accept: "application/json",
        "content-type": "application/json",
      }),
      body: poolPlaneOutcomeBody(outcome),
    });
    return (await poolPlaneReleaseRefused(answered))
      ? "Denied"
      : poolPlaneSettlement(answered.status);
  } catch {
    return "Unavailable";
  }
}

/**
 * @param {PoolPlaneClientSettings} input
 * @param {typeof fetch} [fetcher]
 * @returns {WorkerPoolPlane}
 */
export function poolPlaneClient(input, fetcher = globalThis.fetch) {
  const settings = checkedPoolPlaneClientSettings(input);
  return {
    poll: (token, held, wanted, wantedSessions = 0) =>
      poolPlanePolled(settings, fetcher, token, held, wanted, wantedSessions),
    settle: (token, assignment, outcome) =>
      poolPlaneSettled(settings, fetcher, token, assignment, outcome),
  };
}
