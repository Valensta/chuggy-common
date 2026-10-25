/**
 * The session pod's way to reach the worker plane: `workerRequest`'s bounded
 * retry, for as long and at the same pace, against the same base URL, with the
 * same headers and under the session bearer. `sessionRequestOnce` is the same
 * request with no retry, for the callers that may not wait.
 *
 * A RETRY IS FOR A CONDITION, NEVER FOR A DECISION. The session routes answer
 * `stop` and `retry` as distinct things — a fenced attempt is `401`, a batch
 * that changed under its own number is `409`, an exhausted store is `413` — and
 * asking any of those again gets the same answer, later. So a thrown fetch, a
 * server error and a failing status the plane did not answer are retried, and
 * every other status is returned for the caller to read.
 *
 * THE FIFTH ARGUMENT IS THE SAME BAG `workerRequest` TAKES. A caller reaching
 * the plane through whichever of the two its mode was given cannot name the
 * module, so naming one field here must not unset the others: each is
 * destructured with its own default. `settled` names statuses that are answers
 * rather than conditions, which for everything below the server range this
 * already returns, so it only ever adds to what a caller reads back.
 */

import { setTimeout as wait } from "node:timers/promises";
import { URL } from "node:url";

import { sessionPlaneAnswers } from "@chuggy/worker-contract/sessionPlane";
import { workerPlaneStopSchema } from "@chuggy/worker-contract/workerPlane";

import {
  workerPlaneAnswered,
  workerPlaneAwayMillisecondsMax,
  workerPlaneHeaders,
  workerPlaneRetryPause,
} from "./transport.mjs";
import { answeredWith } from "./wire.mjs";

const retryAfterMillisecondsMax = 60_000;
const serverErrorStatusMin = 500;

/** How long the plane asked to be left alone for, inside this module's own cap, or `unasked` where it named no time. */
function retryDelay(response, unasked) {
  const asked = Number.parseInt(
    response?.headers?.get?.("retry-after") ?? "",
    10,
  );
  if (!Number.isSafeInteger(asked) || asked <= 0) return unasked;
  return Math.min(asked * 1_000, retryAfterMillisecondsMax);
}

export async function sessionRequest(
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
    let refusal;
    let delay = workerPlaneRetryPause(tries);
    try {
      const response = await send(new URL(path, task.workerPlane.url), {
        ...init,
        headers: workerPlaneHeaders(bearer, init.headers),
      });
      const answered = response.ok || workerPlaneAnswered(response);
      if (
        answered &&
        (response.status < serverErrorStatusMin ||
          settled.includes(response.status))
      )
        return response;
      refusal = new Error(
        `worker plane ${path} answered ${String(response.status)}${answered ? "" : ", naming no release"}`,
      );
      delay = retryDelay(response, delay);
    } catch (failure) {
      refusal = failure;
    }
    if (now() - began >= workerPlaneAwayMillisecondsMax) throw refusal;
    await pause(delay);
  }
}

/**
 * One request under the same headers, asked once and abandoned at
 * `deadlineMs`, or when `signal` says its asker has let go of it. It is what
 * a caller no turn waits for reaches the plane through: every status the
 * plane answered is returned for it to read, and a thrown fetch, a failing
 * status the plane did not answer, a passed deadline or an asker that let go
 * raises at once.
 */
export async function sessionRequestOnce(
  task,
  bearer,
  path,
  init = {},
  transport = {},
) {
  const { fetch: send = globalThis.fetch, deadlineMs, signal } = transport;
  const deadline = globalThis.AbortSignal.timeout(deadlineMs);
  const response = await send(new URL(path, task.workerPlane.url), {
    ...init,
    headers: workerPlaneHeaders(bearer, init.headers),
    signal:
      signal === undefined
        ? deadline
        : globalThis.AbortSignal.any([signal, deadline]),
  });
  if (response.ok || workerPlaneAnswered(response)) return response;
  await response.body?.cancel();
  throw new Error(
    `worker plane ${path} answered ${String(response.status)}, naming no release`,
  );
}

/** What the plane answers a heartbeat with once the lease is gone, which is a stop on every route. */
const stoppedStatuses = answeredWith(
  sessionPlaneAnswers.heartbeat,
  workerPlaneStopSchema,
);

/** What the plane says when the answer is a decision the pod may not retry past. */
export function sessionStopped(response) {
  return stoppedStatuses.includes(response.status);
}
