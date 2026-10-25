import { setTimeout as wait } from "node:timers/promises";
import { URL } from "node:url";

import {
  workerContractHeader,
  workerContractRelease,
  workerContractVersionOf,
} from "@chuggy/worker-contract/workerContract";

/**
 * How long a plane may go without answering one request before the request
 * gives up: the lease chuggy's worker plane grants at each heartbeat where its
 * deployment names no other. Nothing a pod is handed names its own. A plane
 * silent that long has let such a lease lapse and the attempt go, so nothing
 * sent after would count.
 */
export const workerPlaneAwayMillisecondsMax = 300_000;

const retryMilliseconds = 2_000;
const retryMillisecondsMax = 16_000;
const serverErrorStatusMin = 500;

/**
 * The pause after `tries` tries went unanswered: the first doubled each time,
 * up to a ceiling, so a plane coming back is not asked by every pod at the
 * first pause's pace.
 */
export function workerPlaneRetryPause(tries) {
  return Math.min(retryMilliseconds * 2 ** (tries - 1), retryMillisecondsMax);
}

/**
 * A failing status the plane answered and nothing asks again: its decision,
 * which a caller tells by this from a plane that never answered.
 */
export class WorkerPlaneRefusal extends Error {}

/**
 * Whether the plane itself gave an answer, which names the release it was
 * built with. A proxy or an edge in front of a plane it cannot reach answers
 * statuses of its own, naming none.
 */
export function workerPlaneAnswered(response) {
  const release = response.headers.get(workerContractHeader);
  return release !== null && workerContractVersionOf(release) !== undefined;
}

/** The headers every worker-plane request carries: the caller's own, its bearer, and the contract release this image was built with. */
export function workerPlaneHeaders(bearer, headers = {}) {
  return {
    authorization: `Bearer ${bearer}`,
    ...headers,
    [workerContractHeader]: workerContractRelease,
  };
}

/**
 * One request to the worker plane, asked again while the plane does not answer
 * it and until it has been away `workerPlaneAwayMillisecondsMax`.
 *
 * A RETRY IS FOR A CONDITION, NEVER FOR A DECISION. A thrown fetch, a server
 * error and a failing status the plane did not answer are retried; any other
 * failing status is the plane's answer, and asking again only delays the
 * caller hearing it. So it raises at once, unless the caller names it as
 * settled — a credential this deployment does not mint — and reads it instead.
 */
export async function workerRequest(
  task,
  bearer,
  path,
  init = {},
  transport = {},
) {
  const {
    fetch: send = globalThis.fetch,
    wait: pause = wait,
    now = Date.now,
    settled = [],
  } = transport;
  const began = now();
  for (let tries = 1; ; tries += 1) {
    let response;
    let failure;
    try {
      response = await send(new URL(path, task.workerPlane.url), {
        ...init,
        headers: workerPlaneHeaders(bearer, init.headers),
      });
    } catch (thrown) {
      failure = thrown;
    }
    if (response !== undefined) {
      if (response.ok) return response;
      const answered = `worker plane ${path} answered ${String(response.status)}`;
      if (!workerPlaneAnswered(response))
        failure = new Error(`${answered}, naming no release`);
      else if (settled.includes(response.status)) return response;
      else if (response.status < serverErrorStatusMin)
        throw new WorkerPlaneRefusal(answered);
      else failure = new Error(answered);
    }
    if (now() - began >= workerPlaneAwayMillisecondsMax) throw failure;
    await pause(workerPlaneRetryPause(tries));
  }
}
