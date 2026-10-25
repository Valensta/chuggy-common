import assert from "node:assert/strict";
import test from "node:test";

import {
  workerContractHeader,
  workerContractRelease,
} from "@chuggy/worker-contract/workerContract";

import { pausedClock } from "./clock.fixture.mjs";
import {
  workerPlaneAwayMillisecondsMax,
  WorkerPlaneRefusal,
  workerRequest,
} from "./transport.mjs";

const task = { workerPlane: { url: "http://worker-plane.test:3001" } };

/** An answer as the plane gives one, naming its release as it does on every answer. */
function planeAnswered(status) {
  return new globalThis.Response(null, {
    status,
    headers: { [workerContractHeader]: workerContractRelease },
  });
}

/** What a proxy answers in front of a plane it cannot reach: a status of its own, naming no release, whatever `headers` it adds. */
function proxyAnswered(status, headers = {}) {
  return new globalThis.Response("no plane answered this\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

test("a refused connection is retried in the same worker", async () => {
  const requests = [];
  const waits = [];
  const response = { ok: true, status: 200 };
  const received = await workerRequest(
    task,
    "secret",
    "/v1/input",
    {},
    {
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        if (requests.length < 3) throw new TypeError("fetch failed");
        return response;
      },
      wait: async (milliseconds) => waits.push(milliseconds),
    },
  );

  assert.equal(received, response);
  assert.equal(requests.length, 3);
  assert.deepEqual(waits, [2_000, 4_000]);
  assert.equal(requests[0].url, "http://worker-plane.test:3001/v1/input");
  assert.equal(requests[0].init.headers.authorization, "Bearer secret");
});

test("every request names the contract release the image was built with, whatever headers its caller sets", async () => {
  const requests = [];
  await workerRequest(
    task,
    "secret",
    "/v1/report",
    {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        [workerContractHeader]: "0.0.0",
      },
    },
    {
      fetch: async (_url, init) => {
        requests.push(init);
        return { ok: true, status: 202 };
      },
    },
  );

  assert.deepEqual(requests[0].headers, {
    authorization: "Bearer secret",
    "content-type": "text/plain",
    [workerContractHeader]: workerContractRelease,
  });
});

/**
 * A refusal the caller settles for is an answer, not a fault: without the list
 * every other failing status is a throw.
 */
test("a status the caller settles for is handed back, and every other is a fault", async () => {
  let requests = 0;
  const refused = planeAnswered(404);
  const received = await workerRequest(
    task,
    "secret",
    "/v1/credential",
    {},
    {
      fetch: async () => {
        requests += 1;
        return refused;
      },
      wait: async () => undefined,
      settled: [404],
    },
  );

  assert.equal(received, refused);
  assert.equal(requests, 1);

  await assert.rejects(
    workerRequest(
      task,
      "secret",
      "/v1/credential",
      {},
      {
        fetch: async () => planeAnswered(500),
        ...pausedClock(),
        settled: [404],
      },
    ),
    /answered 500/u,
  );
});

/**
 * A refusal is told from a plane that never answered by what is raised, which
 * is what lets a lease end on the one and ask again after the other.
 */
test("a refusal raises at the first answer, and a server error is asked again until the plane has been away a lease", async () => {
  for (const status of [400, 401, 404, 409, 413, 415, 503]) {
    let requests = 0;
    const clock = pausedClock();
    const raised = await workerRequest(
      task,
      "secret",
      "/v1/heartbeat",
      { method: "POST" },
      {
        fetch: async () => {
          requests += 1;
          return planeAnswered(status);
        },
        ...clock,
      },
    ).catch((failure) => failure);

    assert.match(raised.message, new RegExp(`answered ${String(status)}`, "u"));
    assert.equal(raised instanceof WorkerPlaneRefusal, status !== 503);
    assert.equal(clock.pauses.length, requests - 1, String(status));
    if (status === 503)
      assert.ok(
        clock.now() >= workerPlaneAwayMillisecondsMax,
        String(clock.now()),
      );
    else assert.equal(requests, 1, String(status));
  }
});

/**
 * A proxy's status is no decision of the plane's, whatever it is, nor one a
 * caller settles for: it is asked past as a server error is, and what is
 * finally raised is no refusal.
 */
test("a failing status naming no release is asked again until the plane has been away a lease, and never raises a refusal", async () => {
  for (const [status, headers] of [
    [400],
    [401],
    [403],
    [404],
    [409],
    [404, { [workerContractHeader]: "not a release" }],
  ]) {
    const clock = pausedClock();
    const raised = await workerRequest(
      task,
      "secret",
      "/v1/report",
      { method: "POST" },
      {
        fetch: async () => proxyAnswered(status, headers),
        ...clock,
        settled: [404],
      },
    ).catch((failure) => failure);

    assert.equal(
      raised.message,
      `worker plane /v1/report answered ${String(status)}, naming no release`,
    );
    assert.equal(raised instanceof WorkerPlaneRefusal, false, String(status));
    assert.ok(clock.now() >= workerPlaneAwayMillisecondsMax, String(status));
  }
});

test("a report a proxy answered for is made again, and lands once the plane answers", async () => {
  const answers = [proxyAnswered(404), planeAnswered(202)];
  const clock = pausedClock();
  const received = await workerRequest(
    task,
    "secret",
    "/v1/report",
    { method: "POST" },
    { fetch: async () => answers.shift(), ...clock },
  );

  assert.equal(received.status, 202);
  assert.deepEqual(clock.pauses, [2_000]);
});

/**
 * The bound is the time the plane has been away, met from both sides: the last
 * pause began inside it and ended at or past it. The pauses double to a
 * ceiling and stay there.
 */
test("worker-plane retries are bounded by how long the plane has been away", async () => {
  let requests = 0;
  const clock = pausedClock();
  await assert.rejects(
    workerRequest(
      task,
      "secret",
      "/v1/input",
      {},
      {
        fetch: async () => {
          requests += 1;
          throw new TypeError("fetch failed");
        },
        ...clock,
      },
    ),
    /fetch failed/,
  );

  assert.equal(clock.pauses.length, requests - 1);
  assert.ok(clock.now() >= workerPlaneAwayMillisecondsMax, String(clock.now()));
  assert.ok(clock.now() - clock.pauses.at(-1) < workerPlaneAwayMillisecondsMax);
  assert.deepEqual(clock.pauses.slice(0, 4), [2_000, 4_000, 8_000, 16_000]);
  assert.deepEqual([...new Set(clock.pauses.slice(3))], [16_000]);
});

/** Catches a transport that gives up on a plane whose lease on the attempt is still running. */
test("a plane away for less than a lease is waited out", async () => {
  const awayMilliseconds = 120_000;
  assert.ok(awayMilliseconds < workerPlaneAwayMillisecondsMax);
  const clock = pausedClock();
  const response = { ok: true, status: 204 };

  const received = await workerRequest(
    task,
    "secret",
    "/v1/report",
    { method: "POST" },
    {
      fetch: async () => {
        if (clock.now() < awayMilliseconds) throw new TypeError("fetch failed");
        return response;
      },
      ...clock,
    },
  );

  assert.equal(received, response);
  assert.ok(clock.now() >= awayMilliseconds);
});
