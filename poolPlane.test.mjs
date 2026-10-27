import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  workerContractHeader,
  workerContractRelease,
} from "@chuggy/worker-contract/workerContract";
import {
  workerPoolCapabilitiesMax,
  workerRunnerPollWaitHeader,
  workerRunnerCapabilitiesHeader,
  workerRunnerCapabilitiesOf,
  workerRunnerHeader,
  workerRunnerMemoryCeilingHeader,
  workerRunnerCountOf,
  workerRunnerMemoryRoomHeader,
  workerRunnerOf,
} from "@chuggy/worker-contract/workerPool";

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

/** One answer as the plane would send it, naming its release as every one does, with no server to send it. */
function answered(status, body) {
  return new globalThis.Response(status === 204 ? null : body, {
    status,
    headers: { [workerContractHeader]: workerContractRelease },
  });
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

test("the plane's own 404, empty as it sends one, denies the pool from a poll and from a settlement", async () => {
  const refusing = answering(404, "");
  assert.deepEqual(await refusing.poll("pool-token", [], 1), {
    polled: "Denied",
    evidence: "the plane serves no such pool",
  });
  assert.equal(
    await refusing.settle("pool-token", "one", { outcome: "Accepted" }),
    "Denied",
  );
});

test("a 404 or a 400 naming no release of the plane's is an outage, from a poll and from a settlement", async () => {
  for (const [status, body, headers] of [
    [404, "404 page not found\n", { "content-type": "text/plain" }],
    [400, "400 Bad Request", { "content-type": "text/plain" }],
    [404, "", { [workerContractHeader]: "not a release" }],
  ]) {
    const proxy = poolPlaneClient(
      planeSettings,
      async () => new globalThis.Response(body, { status, headers }),
    );
    assert.deepEqual(await proxy.poll("pool-token", [], 1), {
      polled: "Unavailable",
      evidence: `the plane's address answered ${String(status)}, naming no release`,
    });
    assert.equal(
      await proxy.settle("pool-token", "one", { outcome: "Accepted" }),
      "Unavailable",
      `status ${String(status)}`,
    );
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

/** The release chuggy pins for a runner's package, as a poll's answer names it. */
const release = {
  package: "chuggy-linux",
  version: "0.14.1",
  url: "https://github.com/kasofsk/chuggy-linux/releases/download/v0.14.1/chuggy-linux-0.14.1.tgz",
  integrity: `sha512-${"A".repeat(86)}==`,
};

test("a runner's poll names its package and version, and the release the answer pins for it is passed on", async () => {
  const headers = [];
  const plane = poolPlaneClient(
    {
      ...planeSettings,
      runner: { package: "chuggy-linux", version: "0.14.0" },
    },
    async (_input, init) => {
      headers.push(init.headers);
      return answered(
        200,
        JSON.stringify({ assignments: [], sessions: [], stop: [], release }),
      );
    },
  );
  assert.deepEqual(await plane.poll("pool-token", [], 1), {
    polled: "Reconciled",
    assignments: [],
    sessions: [],
    stop: [],
    release,
  });
  assert.deepEqual(workerRunnerOf(headers[0][workerRunnerHeader]), {
    package: "chuggy-linux",
    version: "0.14.0",
  });
});

test("a client that is no runner names none, and an answer pinning no release passes none on", async () => {
  const headers = [];
  const plane = poolPlaneClient(planeSettings, async (_input, init) => {
    headers.push(init.headers);
    return answered(
      200,
      JSON.stringify({ assignments: [], sessions: [], stop: [] }),
    );
  });
  const polled = await plane.poll("pool-token", [], 1);
  assert.equal(workerRunnerHeader in headers[0], false);
  assert.equal("release" in polled, false);
});

test("a runner the contract cannot name is refused at once, and a release it cannot read is an outage", async () => {
  for (const runner of [
    { package: "chuggy-linux", version: "0.14.0-rc.1" },
    { package: "Chuggy", version: "0.14.0" },
  ])
    assert.throws(
      () => poolPlaneClient({ ...planeSettings, runner }),
      /pool plane runner must name a package and a plain release version/u,
    );
  const polled = await answering(
    200,
    JSON.stringify({
      assignments: [],
      sessions: [],
      stop: [],
      release: { ...release, url: release.url.replace("https:", "http:") },
    }),
  ).poll("pool-token", [], 1);
  assert.equal(polled.polled, "Unavailable");
});

/**
 * The header each poll of a client given `capabilities` sends, as the plane
 * reads it.
 *
 * @param {readonly string[] | undefined} capabilities
 */
async function capabilitiesNamed(capabilities) {
  const headers = [];
  const plane = poolPlaneClient(
    capabilities === undefined
      ? planeSettings
      : { ...planeSettings, capabilities },
    async (_input, init) => {
      headers.push(init.headers);
      return answered(
        200,
        JSON.stringify({ assignments: [], sessions: [], stop: [] }),
      );
    },
  );
  await plane.poll("pool-token", [], 1);
  await plane.poll("pool-token", [], 1);
  return headers.map((sent) => ({
    present: workerRunnerCapabilitiesHeader in sent,
    named: workerRunnerCapabilitiesOf(sent[workerRunnerCapabilitiesHeader]),
  }));
}

/**
 * Catches a duplicate reaching the wire, which the plane refuses with a 400
 * that ends the pool, and a set left off any poll.
 */
test("a runner's every poll names its capabilities as a set the plane reads, each once, and the empty set as one", async () => {
  for (const [given, set] of [
    [
      ["Platform:Linux:Amd64", "Agent:Claude", "Tool:Bazel", "Agent:Claude"],
      ["Platform:Linux:Amd64", "Agent:Claude", "Tool:Bazel"],
    ],
    [[], []],
  ])
    assert.deepEqual(
      await capabilitiesNamed(given),
      Array(2).fill({
        present: true,
        named: { named: "Set", capabilities: set },
      }),
      JSON.stringify(given),
    );
});

/** Catches a client given no capabilities naming a set, which would replace the one its registration recorded. */
test("a client given no capabilities names none on any poll", async () => {
  assert.deepEqual(
    await capabilitiesNamed(undefined),
    Array(2).fill({ present: false, named: { named: "None" } }),
  );
});

/**
 * Catches capabilities the plane would refuse reaching a poll, whose 400 ends
 * the pool, and a set bounded before its duplicates are dropped.
 */
test("capabilities the contract cannot read are refused at once, a set past its bound only once its duplicates are dropped", async () => {
  const bounded = Array.from(
    { length: workerPoolCapabilitiesMax },
    (_, index) => `Tool:${String(index)}`,
  );
  for (const capabilities of [
    ["Tool Bazel"],
    ["Tool:Bazel,Agent:Claude"],
    [""],
    [...bounded, "Tool:over"],
  ])
    assert.throws(
      () => poolPlaneClient({ ...planeSettings, capabilities }),
      /pool plane capabilities must be at most \d+ tokens a pool can declare/u,
      JSON.stringify(capabilities),
    );
  const [named] = await capabilitiesNamed([...bounded, bounded[0]]);
  assert.deepEqual(named.named, { named: "Set", capabilities: bounded });
});

/**
 * Catches a room or a ceiling the plane would refuse reaching a poll, whose
 * 400 ends the pool, and a wait sent where none was asked.
 */
test("a poll names the room its pool offers jobs and its ceiling, each only where the contract reads it, and the wait only where one is given", async () => {
  /** @type {Record<string, string>[]} */
  const seen = [];
  const plane = poolPlaneClient(planeSettings, async (_input, init) => {
    seen.push(init.headers);
    return answered(
      200,
      JSON.stringify({ assignments: [], sessions: [], stop: [] }),
    );
  });
  await plane.poll("pool-token", [], 1, 0, {
    memory: { roomMib: 4096, ceilingMib: 12288 },
  });
  await plane.poll("pool-token", [], 1, 0, {
    memory: { roomMib: 0 },
    waitSecs: 0,
  });
  await plane.poll("pool-token", [], 1, 0, {
    memory: { roomMib: -1, ceilingMib: 1.5 },
  });
  await plane.poll("pool-token", [], 1);
  assert.deepEqual(
    seen.map((headers) => [
      headers[workerRunnerMemoryRoomHeader],
      headers[workerRunnerMemoryCeilingHeader],
      headers[workerRunnerPollWaitHeader],
    ]),
    [
      ["4096", "12288", undefined],
      ["0", undefined, "0"],
      [undefined, undefined, undefined],
      [undefined, undefined, undefined],
    ],
  );
  for (const sent of ["4096", "12288", "0"])
    assert.equal(workerRunnerCountOf(sent).named, "Count");
});

/**
 * Catches a pool claiming by room from a plane that does not claim so, or
 * that did not say whether a job waits, which would never ask it for one.
 */
test("an answer says whether a job waits only from a plane that claims by room and said, and the client keeps whether its last reconciled answer did", async () => {
  let release = workerContractRelease;
  /** @type {Record<string, unknown>} */
  let body = { assignments: [], sessions: [], stop: [], jobsWaiting: true };
  let status = 200;
  const plane = poolPlaneClient(
    planeSettings,
    async () =>
      new globalThis.Response(JSON.stringify(body), {
        status,
        headers: { [workerContractHeader]: release },
      }),
  );
  assert.equal(plane.claimsByRoom(), false);
  const waiting = await plane.poll("pool-token", [], 0);
  assert.equal(waiting.polled === "Reconciled" && waiting.jobsWaiting, true);
  assert.equal(plane.claimsByRoom(), true);
  body = { ...body, jobsWaiting: false };
  const none = await plane.poll("pool-token", [], 0);
  assert.equal(none.polled === "Reconciled" && none.jobsWaiting, false);
  assert.equal(plane.claimsByRoom(), true);
  status = 503;
  await plane.poll("pool-token", [], 0);
  assert.equal(plane.claimsByRoom(), true);
  status = 200;
  release = "1.20.0";
  body = { ...body, jobsWaiting: true };
  assert.deepEqual(await plane.poll("pool-token", [], 0), {
    polled: "Reconciled",
    assignments: [],
    sessions: [],
    stop: [],
  });
  assert.equal(plane.claimsByRoom(), false);
  release = workerContractRelease;
  await plane.poll("pool-token", [], 0);
  assert.equal(plane.claimsByRoom(), true);
  body = { assignments: [], sessions: [], stop: [] };
  await plane.poll("pool-token", [], 0);
  assert.equal(plane.claimsByRoom(), false);
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
  assert.equal(
    (await answering(409, "").poll("pool-token", [], 1)).polled,
    "Unavailable",
  );
});
