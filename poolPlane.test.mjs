import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  workerContractHeader,
  workerContractRelease,
} from "@chuggy/worker-contract/workerContract";

import {
  checkedPoolPlaneClientSettings,
  poolPlaneAnswerBytesMax,
  poolPlaneClient,
} from "./poolPlane.mjs";

const planeSettings = {
  baseUrl: "https://pool-plane.invalid",
  pollTimeoutMs: 1_000,
  settleTimeoutMs: 1_000,
};

const assignment = {
  assignment: "assignment-one",
  capabilities: ["linux-containers"],
  cpuMillis: 500,
  memoryMib: 512,
  deadlineSecs: 60,
  callbackUrl: "https://worker-plane.invalid/v1/ticket-execution",
  bearer: "attempt-bearer",
};

/** A session the plane offers, which always names its image. */
const session = {
  ...assignment,
  assignment: "session-one",
  image: "registry.invalid/chuggy/session:1",
  bearer: "session-bearer",
};

/** One answer as the plane would send it, with no server to send it. */
function answered(status, body) {
  return new globalThis.Response(status === 204 ? null : body, { status });
}

/** A plane client whose every request is answered `status` and `body`. */
function answering(status, body = "{}", settings = planeSettings) {
  return poolPlaneClient(settings, async () => answered(status, body));
}

test("a poll names what the pool holds and wants of each kind, and carries its own token", async () => {
  const seen = [];
  const plane = poolPlaneClient(planeSettings, async (input, init) => {
    seen.push({ url: String(input), init });
    return answered(
      200,
      JSON.stringify({
        assignments: [assignment],
        sessions: [session],
        stop: ["a"],
      }),
    );
  });
  const polled = await plane.poll("pool-token", ["one", "two"], 3, 2);
  assert.equal(
    seen[0].url,
    "https://pool-plane.invalid/v1/assignments?held=one&held=two&wanted=3&wantedSessions=2",
  );
  assert.equal(seen[0].init.method, "GET");
  assert.equal(seen[0].init.headers.authorization, "Bearer pool-token");
  assert.deepEqual(polled, {
    polled: "Reconciled",
    assignments: [assignment],
    sessions: [session],
    stop: ["a"],
  });
});

test("a base address's own path is kept beneath every route", async () => {
  const sent = [];
  const plane = poolPlaneClient(
    { ...planeSettings, baseUrl: "https://gateway.invalid/pools" },
    async (input) => {
      sent.push(String(input));
      return answered(
        200,
        JSON.stringify({ assignments: [], sessions: [], stop: [] }),
      );
    },
  );
  await plane.poll("pool-token", [], 1);
  await plane.settle("pool-token", "one", { outcome: "Accepted" });
  assert.deepEqual(sent, [
    "https://gateway.invalid/pools/v1/assignments?wanted=1&wantedSessions=0",
    "https://gateway.invalid/pools/v1/assignments/one/accepted",
  ]);
});

test("each refusing status is the arm the plane means by it", async () => {
  for (const [status, expected] of [
    [401, "Stale"],
    [404, "Denied"],
    [400, "Denied"],
    [503, "Unavailable"],
    [500, "Unavailable"],
  ]) {
    const polled = await answering(status).poll("pool-token", [], 1);
    assert.equal(polled.polled, expected, `status ${String(status)}`);
  }
});

/** A reconciliation the schema reads, as bytes, with `stop` naming each of `stopped`. */
function reconciliationBytes(stopped) {
  return Buffer.from(
    JSON.stringify({ assignments: [], sessions: [], stop: stopped }),
  );
}

test("an answer this pool cannot read is an outage rather than a refusal", async () => {
  const identity = "x".repeat(256);
  for (const body of [
    "not json",
    JSON.stringify({ assignments: [{}] }),
    Buffer.concat([
      reconciliationBytes(["stop"]).subarray(0, -3),
      Buffer.from([0xff, 0x22, 0x5d, 0x7d]),
    ]),
    reconciliationBytes(
      Array.from(
        { length: Math.ceil(poolPlaneAnswerBytesMax / identity.length) },
        () => identity,
      ),
    ),
  ]) {
    const polled = await answering(200, body).poll("pool-token", [], 1);
    assert.equal(polled.polled, "Unavailable");
  }
});

test("a plane that could not be reached is an outage and raises nothing", async () => {
  const plane = poolPlaneClient(planeSettings, async () => {
    throw new Error("connection refused");
  });
  assert.equal((await plane.poll("pool-token", [], 1)).polled, "Unavailable");
  assert.equal(
    await plane.settle("pool-token", "one", { outcome: "Accepted" }),
    "Unavailable",
  );
});

test("each settlement is the path it is said on and the body it needs", async () => {
  const sent = [];
  const plane = poolPlaneClient(planeSettings, async (input, init) => {
    sent.push({ url: String(input), init });
    return answered(204, "");
  });
  assert.equal(
    await plane.settle("pool-token", "one", { outcome: "Accepted" }),
    "Settled",
  );
  await plane.settle("pool-token", "two", {
    outcome: "Refused",
    evidence: "refused",
  });
  await plane.settle("pool-token", "three", { outcome: "Unavailable" });
  await plane.settle("pool-token", "four", {
    outcome: "Refused",
    evidence: "no git",
    fault: "ImageLacksGit",
  });
  assert.deepEqual(
    sent.map((request) => request.url),
    [
      "https://pool-plane.invalid/v1/assignments/one/accepted",
      "https://pool-plane.invalid/v1/assignments/two/refused",
      "https://pool-plane.invalid/v1/assignments/three/unavailable",
      "https://pool-plane.invalid/v1/assignments/four/refused",
    ],
  );
  assert.deepEqual(
    sent.map((request) => request.init.body),
    [
      "{}",
      '{"evidence":"refused"}',
      "{}",
      '{"evidence":"no git","fault":"ImageLacksGit"}',
    ],
  );
  for (const request of sent) {
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.headers.authorization, "Bearer pool-token");
    assert.equal(request.init.headers["content-type"], "application/json");
  }
});

test("a settlement the plane will not take says which kind of no it was", async () => {
  for (const [status, expected] of [
    [204, "Settled"],
    [409, "Lost"],
    [401, "Stale"],
    [404, "Denied"],
    [400, "Denied"],
    [503, "Unavailable"],
  ])
    assert.equal(
      await answering(status).settle("pool-token", "one", {
        outcome: "Accepted",
      }),
      expected,
      `status ${String(status)}`,
    );
});

test("a plane address that carries a credential or no web scheme is refused", () => {
  for (const baseUrl of [
    "https://pool:secret@plane.invalid",
    "ftp://plane.invalid",
  ])
    assert.throws(
      () => checkedPoolPlaneClientSettings({ ...planeSettings, baseUrl }),
      RangeError,
    );
});

test("a timeout that is not a positive whole number is refused", () => {
  for (const name of ["pollTimeoutMs", "settleTimeoutMs"])
    for (const refused of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])
      assert.throws(
        () => poolPlaneClient({ ...planeSettings, [name]: refused }),
        /timeout must be a positive integer/u,
      );
});

test("a poll and every settlement name the release this client was built with", async () => {
  const named = [];
  const plane = poolPlaneClient(planeSettings, async (_input, init) => {
    named.push(init.headers[workerContractHeader]);
    return answered(
      200,
      JSON.stringify({ assignments: [], sessions: [], stop: [] }),
    );
  });
  await plane.poll("pool-token", [], 1);
  await plane.settle("pool-token", "one", { outcome: "Accepted" });
  assert.deepEqual(named, [workerContractRelease, workerContractRelease]);
});

test("a plane refusing this client's release ends the pool rather than losing an assignment", async () => {
  const refusal = JSON.stringify({
    action: "stop",
    reason: "UnsupportedContractVersion",
    accepted: { min: "1.0", max: "1.0" },
  });
  const refusing = answering(409, refusal);
  const polled = await refusing.poll("pool-token", [], 1);
  assert.equal(polled.polled, "Denied");
  assert.ok(polled.evidence.includes(workerContractRelease));
  assert.equal(
    await refusing.settle("pool-token", "one", { outcome: "Accepted" }),
    "Denied",
  );
  assert.equal(
    await answering(409, "").settle("pool-token", "one", {
      outcome: "Accepted",
    }),
    "Lost",
  );
});
