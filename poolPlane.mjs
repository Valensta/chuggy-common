/**
 * The pool loop's plane: the poll and the settlement over HTTP. chuggy's
 * `src/adapters/http/poolPlaneClient.ts` is the same client in TypeScript, and
 * a change to one is a change to both, but for what a runner names on a poll
 * and what an answer names for it, which that cluster client neither names
 * nor reads.
 *
 * The status is the answer and nothing here retries it; a 409 is the one
 * status two answers share, told apart by its body. A 404 or a 400 denies the
 * pool only where the plane gave it, which the plane says by naming its
 * release on every answer: a proxy in front of a plane it cannot reach answers
 * those of its own. An answer this side cannot read is an outage rather than a
 * denial, because a denial ends the pool over a skew the plane did not refuse.
 *
 * A runner names its package and version on the poll, and the answer may name
 * the release chuggy pins for that package. A runner may name its capabilities
 * on the poll too, whose set replaces the one its registration recorded, and a
 * client given none names none, leaving that set as it is.
 *
 * A poll may name the memory room the pool offers jobs and its ceiling for
 * one, each only where the contract reads it, since a plane refuses a poll
 * naming one it cannot read; and how long the plane may wait before it
 * answers. A plane whose answers name `workerContractMemoryRoom` or later
 * gives only jobs that fit the room, and says whether one waits that would.
 * The client keeps whether the last answer said so, which is how its pool
 * knows to claim by room.
 */

import { TextDecoder } from "node:util";
import { URL } from "node:url";

import {
  contractVersionRefusalSchema,
  contractVersionRefusalStatus,
  workerContractHeader,
  workerContractMemoryRoom,
  workerContractRelease,
  workerContractVersionOf,
} from "@chuggy/worker-contract/workerContract";
import {
  workerPoolCapabilitiesMax,
  workerPoolPollQuery,
  workerPoolPollRoute,
  workerRunnerPollWaitHeader,
  workerPoolReconciliationSchema,
  workerPoolSettlementPath,
  workerRunnerCapabilitiesHeader,
  workerRunnerCapabilitiesSchema,
  workerRunnerHeader,
  workerRunnerMemoryCeilingHeader,
  workerRunnerCountOf,
  workerRunnerMemoryRoomHeader,
  workerRunnerSchema,
} from "@chuggy/worker-contract/workerPool";

import { boundedResponseBytes } from "./boundedResponse.mjs";
import { workerPlaneHeaders } from "./transport.mjs";

/**
 * @typedef {import("@chuggy/worker-contract/workerPool").AssignmentOutcome} AssignmentOutcome
 * @typedef {import("@chuggy/worker-contract/workerPool").WorkerRunner} WorkerRunner
 * @typedef {import("./poolLoop.mjs").WorkerPoolPlane} WorkerPoolPlane
 * @typedef {import("./poolLoop.mjs").WorkerPoolPollTerms} WorkerPoolPollTerms
 * @typedef {import("./poolLoop.mjs").WorkerPoolPolled} WorkerPoolPolled
 * @typedef {import("./poolLoop.mjs").WorkerPoolSettled} WorkerPoolSettled
 *
 * @typedef {object} PoolPlaneClientSettings
 * @property {string} baseUrl
 * @property {number} pollTimeoutMs the operator's to size, since a long poll cut shorter than the plane's own wait is an outage every idle window
 * @property {number} settleTimeoutMs
 * @property {WorkerRunner} [runner] the runner's package and version, which each poll names
 * @property {readonly string[]} [capabilities] the runner's capabilities, which each poll names, each once
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
  const capabilities =
    input.capabilities === undefined
      ? undefined
      : [...new Set(input.capabilities)];
  if (
    capabilities !== undefined &&
    !workerRunnerCapabilitiesSchema.safeParse(capabilities).success
  )
    throw new RangeError(
      `pool plane capabilities must be at most ${String(workerPoolCapabilitiesMax)} tokens a pool can declare`,
    );
  return {
    ...input,
    baseUrl: url.toString(),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
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
 * The version the plane that gave an answer was built with, as the answer
 * names it, or nothing where it names none.
 *
 * @param {Response} answered
 */
function poolPlaneVersion(answered) {
  const release = answered.headers.get(workerContractHeader);
  return release === null ? undefined : workerContractVersionOf(release);
}

/**
 * Whether the plane itself gave an answer, which names the release it was
 * built with.
 *
 * @param {Response} answered
 */
function poolPlaneAnswered(answered) {
  return poolPlaneVersion(answered) !== undefined;
}

/**
 * Whether the plane that gave an answer claims by the room a poll names.
 *
 * @param {Response} answered
 */
function poolPlaneClaimsByRoom(answered) {
  const version = poolPlaneVersion(answered);
  return (
    version !== undefined &&
    version.major === workerContractMemoryRoom.major &&
    version.minor >= workerContractMemoryRoom.minor
  );
}

/**
 * The headers naming what a poll's terms carry: the room and the ceiling each
 * where the contract reads it, and the wait.
 *
 * @param {WorkerPoolPollTerms} terms
 * @returns {Record<string, string>}
 */
function poolPlaneTermHeaders(terms) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [header, mib] of /** @type {const} */ ([
    [workerRunnerMemoryRoomHeader, terms.memory?.roomMib],
    [workerRunnerMemoryCeilingHeader, terms.memory?.ceilingMib],
  ])) {
    const text = mib === undefined ? undefined : String(mib);
    if (workerRunnerCountOf(text).named === "Count")
      headers[header] = /** @type {string} */ (text);
  }
  if (terms.waitSecs !== undefined)
    headers[workerRunnerPollWaitHeader] = String(terms.waitSecs);
  return headers;
}

/**
 * @param {Response} answered
 * @returns {Promise<WorkerPoolPolled>}
 */
async function poolPlaneRefusal(answered) {
  const { status } = answered;
  if (status === 401) return { polled: "Stale" };
  if (await poolPlaneReleaseRefused(answered))
    return {
      polled: "Denied",
      evidence: `the plane does not serve worker contract ${workerContractRelease}`,
    };
  if ((status === 404 || status === 400) && !poolPlaneAnswered(answered))
    return {
      polled: "Unavailable",
      evidence: `the plane's address answered ${String(status)}, naming no release`,
    };
  if (status === 404)
    return { polled: "Denied", evidence: "the plane serves no such pool" };
  if (status === 400)
    return {
      polled: "Denied",
      evidence: "the plane refused this pool's own request",
    };
  return {
    polled: "Unavailable",
    evidence: `the plane answered ${String(status)}`,
  };
}

/**
 * A reconciliation, saying whether a job waits only where the plane that gave
 * it claims by room and said.
 *
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
  if (!read.success)
    return {
      polled: "Unavailable",
      evidence: "the plane answered no reconciliation this pool can read",
    };
  const { release, jobsWaiting } = read.data;
  const waiting = poolPlaneClaimsByRoom(answered) ? jobsWaiting : undefined;
  return {
    polled: "Reconciled",
    assignments: read.data.assignments,
    sessions: read.data.sessions,
    stop: read.data.stop,
    ...(release === undefined ? {} : { release }),
    ...(waiting === undefined ? {} : { jobsWaiting: waiting }),
  };
}

/**
 * @param {PoolPlaneClientSettings} settings
 * @param {typeof fetch} fetcher
 * @param {string} token
 * @param {readonly string[]} held
 * @param {number} wanted
 * @param {number} wantedSessions
 * @param {WorkerPoolPollTerms} terms
 * @returns {Promise<WorkerPoolPolled>}
 */
async function poolPlanePolled(
  settings,
  fetcher,
  token,
  held,
  wanted,
  wantedSessions,
  terms,
) {
  let answered;
  try {
    const url = poolPlaneAssignmentsUrl(settings, held, wanted, wantedSessions);
    const { runner, capabilities } = settings;
    answered = await fetcher(url, {
      method: "GET",
      signal: globalThis.AbortSignal.timeout(settings.pollTimeoutMs),
      headers: workerPlaneHeaders(token, {
        accept: "application/json",
        ...(runner === undefined
          ? {}
          : { [workerRunnerHeader]: `${runner.package}/${runner.version}` }),
        ...(capabilities === undefined
          ? {}
          : { [workerRunnerCapabilitiesHeader]: capabilities.join(",") }),
        ...poolPlaneTermHeaders(terms),
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
    : poolPlaneRefusal(answered);
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
 * @param {Response} answered
 * @returns {WorkerPoolSettled}
 */
function poolPlaneSettlement(answered) {
  const { status } = answered;
  if (status === 204) return "Settled";
  if (status === 409) return "Lost";
  if (status === 401) return "Stale";
  if ((status === 404 || status === 400) && poolPlaneAnswered(answered))
    return "Denied";
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
      : poolPlaneSettlement(answered);
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
  /** @type {boolean | undefined} */
  let byRoom;
  return {
    poll: async (token, held, wanted, wantedSessions = 0, terms = {}) => {
      const polled = await poolPlanePolled(
        settings,
        fetcher,
        token,
        held,
        wanted,
        wantedSessions,
        terms,
      );
      if (polled.polled === "Reconciled")
        byRoom = polled.jobsWaiting !== undefined;
      return polled;
    },
    claimsByRoom: () => byRoom,
    settle: (token, assignment, outcome) =>
      poolPlaneSettled(settings, fetcher, token, assignment, outcome),
  };
}
