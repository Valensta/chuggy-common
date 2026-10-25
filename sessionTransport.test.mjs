import assert from "node:assert/strict";
import test from "node:test";
import { clearTimeout, setTimeout } from "node:timers";

import {
  workerContractHeader,
  workerContractRelease,
} from "@chuggy/worker-contract/workerContract";

import { pausedClock } from "./clock.fixture.mjs";
import {
  sessionRequest,
  sessionRequestOnce,
  sessionStopped,
} from "./sessionTransport.mjs";
import { workerPlaneAwayMillisecondsMax } from "./transport.mjs";

const task = { workerPlane: { url: "http://worker-plane.test:3001" } };

/**
 * A plane answering each request with the next of `answers`, and the last
 * from then on. Each names the plane's release, as the plane does on every
 * answer, unless it is a proxy's answer in its place.
 */
function transportOf(answers) {
  const calls = [];
  const clock = pausedClock();
  return {
    calls,
    waits: clock.pauses,
    now: clock.now,
    transport: {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        const answer = answers[Math.min(calls.length, answers.length) - 1];
        if (answer instanceof Error) throw answer;
        return new globalThis.Response(null, {
          status: answer.status,
          headers: {
            ...(answer.proxy === true
              ? {}
              : { [workerContractHeader]: workerContractRelease }),
            ...answer.headers,
          },
        });
      },
      wait: clock.wait,
      now: clock.now,
    },
  };
}

test("the bearer, the release and the plane's base url are what the request is made against", async () => {
  const { calls, transport } = transportOf([{ status: 204 }]);

  await sessionRequest(task, "chgs_secret", "/v1/session/turn", {}, transport);

  assert.equal(calls[0].url, "http://worker-plane.test:3001/v1/session/turn");
  assert.deepEqual(calls[0].init.headers, {
    authorization: "Bearer chgs_secret",
    [workerContractHeader]: workerContractRelease,
  });
});

test("a decision is answered to the caller rather than asked again", async () => {
  for (const status of [200, 204, 400, 401, 409, 413]) {
    const { calls, transport } = transportOf([{ status }]);

    const response = await sessionRequest(
      task,
      "b",
      "/v1/session",
      {},
      transport,
    );

    assert.equal(response.status, status);
    assert.equal(calls.length, 1, `status ${String(status)} was retried`);
  }
});

test("a server error is retried, and the plane's own delay is what is waited", async () => {
  const { calls, waits, transport } = transportOf([
    { status: 503, headers: { "retry-after": "5" } },
    { status: 204 },
  ]);

  const response = await sessionRequest(
    task,
    "b",
    "/v1/session",
    {},
    transport,
  );

  assert.equal(response.status, 204);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [5_000]);
});

test("a delay the plane asks for is capped by this module's own bound", async () => {
  const { waits, transport } = transportOf([
    { status: 503, headers: { "retry-after": "86400" } },
    { status: 204 },
  ]);

  await sessionRequest(task, "b", "/v1/session", {}, transport);

  assert.ok(waits[0] <= 60_000, `waited ${String(waits[0])}`);
});

/**
 * The bound is `workerRequest`'s, met from both sides, and the pauses with no
 * delay of the plane's own are its too.
 */
test("a transport that never answers is given up on once the plane has been away a lease, and raises its own refusal", async () => {
  const { calls, waits, now, transport } = transportOf([
    new Error("connection refused"),
  ]);

  await assert.rejects(
    sessionRequest(task, "b", "/v1/session", {}, transport),
    /connection refused/u,
  );
  assert.equal(waits.length, calls.length - 1);
  assert.ok(now() >= workerPlaneAwayMillisecondsMax, String(now()));
  assert.ok(now() - waits.at(-1) < workerPlaneAwayMillisecondsMax);
  assert.deepEqual(waits.slice(0, 4), [2_000, 4_000, 8_000, 16_000]);
  assert.deepEqual([...new Set(waits.slice(3))], [16_000]);
});

/** Catches a session that exits on a plane its lease would have outlasted, whether the plane was unreachable or answering a server error. */
test("a plane away for less than a lease is waited out", async () => {
  const awayMilliseconds = 120_000;
  assert.ok(awayMilliseconds < workerPlaneAwayMillisecondsMax);
  for (const away of [new Error("connection refused"), { status: 503 }]) {
    const clock = pausedClock();

    const response = await sessionRequest(
      task,
      "b",
      "/v1/session/turn/answer",
      { method: "POST" },
      {
        fetch: async () => {
          if (clock.now() >= awayMilliseconds)
            return new globalThis.Response(null, { status: 204 });
          if (away instanceof Error) throw away;
          return new globalThis.Response(null, away);
        },
        ...clock,
      },
    );

    assert.equal(response.status, 204);
  }
});

/**
 * A proxy in front of a plane it cannot reach answers a status of its own,
 * naming no release: a heartbeat it answered for, or a claim, is asked again
 * as a server error is, and what is raised at last is its status.
 */
test("a failing status naming no release is asked again until the plane answers", async () => {
  for (const status of [400, 401, 404, 409, 413]) {
    const { calls, waits, transport } = transportOf([
      { status, proxy: true },
      { status: 204 },
    ]);

    const response = await sessionRequest(
      task,
      "b",
      "/v1/session/heartbeat",
      { method: "POST" },
      transport,
    );

    assert.equal(response.status, 204, String(status));
    assert.equal(calls.length, 2, String(status));
    assert.deepEqual(waits, [2_000], String(status));
  }
  const { now, transport } = transportOf([{ status: 404, proxy: true }]);
  await assert.rejects(
    sessionRequest(task, "b", "/v1/session/heartbeat", {}, transport),
    /^Error: worker plane \/v1\/session\/heartbeat answered 404, naming no release$/u,
  );
  assert.ok(now() >= workerPlaneAwayMillisecondsMax, String(now()));
});

test("stop is the status the plane fences with, and nothing else", () => {
  assert.ok(sessionStopped({ status: 401 }));
  assert.ok(sessionStopped({ status: 409 }));
  assert.ok(!sessionStopped({ status: 200 }));
  assert.ok(!sessionStopped({ status: 204 }));
  assert.ok(!sessionStopped({ status: 413 }));
});

const livePath = "/v1/session/turn/live";

test("a request asked once is asked once, whatever the plane answers, under the same headers", async () => {
  for (const status of [204, 400, 401, 409, 503]) {
    const { calls, waits, transport } = transportOf([{ status }]);

    const response = await sessionRequestOnce(
      task,
      "chgs_secret",
      livePath,
      { method: "POST", headers: { "content-type": "application/json" } },
      { ...transport, deadlineMs: 1_000 },
    );

    assert.equal(response.status, status);
    assert.equal(calls.length, 1, `status ${String(status)} was asked again`);
    assert.deepEqual(waits, [], `status ${String(status)} was waited on`);
    assert.equal(calls[0].url, `http://worker-plane.test:3001${livePath}`);
    assert.deepEqual(calls[0].init.headers, {
      "content-type": "application/json",
      authorization: "Bearer chgs_secret",
      [workerContractHeader]: workerContractRelease,
    });
  }
});

test("a request asked once raises a failing status naming no release, and does not ask again", async () => {
  for (const status of [400, 401, 404, 409, 503]) {
    const { calls, waits, transport } = transportOf([{ status, proxy: true }]);

    await assert.rejects(
      sessionRequestOnce(
        task,
        "b",
        livePath,
        {},
        { ...transport, deadlineMs: 1_000 },
      ),
      new RegExp(`answered ${String(status)}, naming no release$`, "u"),
    );
    assert.equal(calls.length, 1, String(status));
    assert.deepEqual(waits, [], String(status));
  }
});

test("a request asked once raises the fetch that failed, and does not ask again", async () => {
  const { calls, waits, transport } = transportOf([new Error("unreachable")]);

  await assert.rejects(
    sessionRequestOnce(
      task,
      "b",
      livePath,
      {},
      { ...transport, deadlineMs: 1_000 },
    ),
    /unreachable/u,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test("a request asked once is abandoned at its deadline", async () => {
  // The deadline's own timer does not hold the process open, and nothing else here would.
  const held = setTimeout(() => undefined, 60_000);
  const unanswered = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  try {
    await assert.rejects(
      sessionRequestOnce(
        task,
        "b",
        livePath,
        {},
        { fetch: unanswered, deadlineMs: 5 },
      ),
      { name: "TimeoutError" },
    );
  } finally {
    clearTimeout(held);
  }
});
