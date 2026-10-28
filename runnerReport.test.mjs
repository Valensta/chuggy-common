import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { URL } from "node:url";

import { sessionContainerEnds } from "@chuggy/worker-contract/sessionPlane";
import {
  workerContractHeader,
  workerContractRelease,
} from "@chuggy/worker-contract/workerContract";
import {
  workerPoolSettlementOutcomes,
  workerRunnerHostCharsMax,
  workerRunnerImagePullBoundsSecs,
  workerRunnerJobEnds,
  workerRunnerRefusalFaults,
  workerRunnerReportBytesMax,
  workerRunnerReportRoute,
  workerRunnerReportSchema,
  workerRunnerRunBoundsSecs,
  workerRunnerRunKinds,
} from "@chuggy/worker-contract/workerPool";

import { workerPoolClientPass } from "./poolLoop.mjs";
import { poolRunnerClient, poolRunnerLoop } from "./poolRunner.mjs";
import {
  runnerMeasuredSum,
  runnerMeasures,
  runnerReportHost,
  runnerReportIntervalMs,
  runnerReportText,
} from "./runnerReport.mjs";

/** The release a plane naming the first version that takes reports names. */
const releaseReporting = "1.28.0";

/** A release naming the version before it. */
const releaseBefore = "1.27.4";

const credentials = /** @type {never} */ ({
  planeUrl: "https://pool-plane.invalid",
});

/** @param {Record<string, unknown>} [overrides] */
function job(id, overrides = {}) {
  return {
    assignment: id,
    capabilities: [],
    cpuMillis: 500,
    memoryMib: 512,
    deadlineSecs: 600,
    callbackUrl: "https://worker-plane.invalid/v1/ticket-execution",
    bearer: `bearer-of-${id}`,
    ...overrides,
  };
}

/** @param {string} id */
function session(id) {
  return { ...job(id), image: "registry.invalid/chuggy/session:1" };
}

/** @param {string} id */
function attempt(id) {
  const { assignment, callbackUrl, bearer } = job(id);
  return { assignment, callbackUrl, bearer };
}

/**
 * A pool plane over fetch, answering each poll as `answer` says under the
 * release `release` names, each settlement 204, and each report as `report`
 * says; every report it takes is held to the contract's schema and bound.
 */
function fakePlane() {
  const plane = {
    release: releaseReporting,
    /** @type {() => Response | Promise<Response>} */
    answer: () => plane.reconciled({}),
    /** @type {() => Response | Promise<Response>} */
    report: () => plane.answered(204),
    /** @type {string[]} every request but the reports, as method, path and bearer */
    requests: [],
    /** @type {{bearer: string, body: import("@chuggy/worker-contract/workerPool").WorkerRunnerReport}[]} */
    reports: [],
    /** @type {string[]} why each report the contract would refuse is one */
    unread: [],
    /** @param {number} status @param {string | null} [body] */
    answered: (status, body = null) =>
      new globalThis.Response(body, {
        status,
        headers: { [workerContractHeader]: plane.release },
      }),
    /** @param {Record<string, unknown>} reconciliation */
    reconciled: (reconciliation) =>
      plane.answered(
        200,
        JSON.stringify({
          assignments: [],
          sessions: [],
          stop: [],
          ...reconciliation,
        }),
      ),
    /** @type {typeof globalThis.fetch} */
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      const headers = /** @type {Record<string, string>} */ (init.headers);
      if (url.pathname === workerRunnerReportRoute) {
        const text = String(init.body);
        const read = workerRunnerReportSchema.safeParse(JSON.parse(text));
        if (!read.success) plane.unread.push(read.error.message);
        if (Buffer.byteLength(text) > workerRunnerReportBytesMax)
          plane.unread.push(`${String(Buffer.byteLength(text))} bytes`);
        plane.reports.push({ bearer: headers.authorization, body: read.data });
        return plane.report();
      }
      plane.requests.push(
        `${String(init.method)} ${url.pathname} ${headers.authorization}`,
      );
      return init.method === "GET" ? plane.answer() : plane.answered(204);
    },
  };
  return plane;
}

/** A backend whose next `held` and `ended` are set by the case, and whose placements are as `refused` says. */
function fakeBackend() {
  const measures = runnerMeasures();
  const backend = {
    /** @type {{assignment: string, kind: "Job" | "Session"}[]} */
    holding: [],
    /** @type {unknown[]} */
    ending: [],
    /** @type {Set<string>} */
    refused: new Set(),
    measures,
    held: async () => backend.holding,
    ended: async () => backend.ending.splice(0),
    place: async (/** @type {{assignment: string}} */ placed) =>
      backend.refused.has(placed.assignment)
        ? { placed: "Refused", evidence: "this machine cannot run it" }
        : { placed: "Placed" },
    stop: async () => ({ stopped: "Stopped" }),
    measured: measures.measured,
  };
  return backend;
}

/** Waits the case releases one at a time, each one a report's interval. */
function fakeWaits() {
  /** @type {{ms: number, resolve: () => void}[]} */
  const waits = [];
  return {
    waits,
    /** @type {(ms: number, signal: AbortSignal) => Promise<void>} */
    wait: (ms, signal) =>
      new Promise((resolve, reject) => {
        const waited = { ms, resolve: () => resolve() };
        waits.push(waited);
        signal.addEventListener(
          "abort",
          () => {
            waits.splice(waits.indexOf(waited), 1);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    /** Ends the wait asked first, and lets what it starts settle. */
    elapsed: async () => {
      const next = waits.shift();
      assert.ok(next !== undefined, "no report waits");
      next.resolve();
      await settled();
    },
  };
}

/** Lets every send behind the passes run as far as it can. */
async function settled() {
  for (let turn = 0; turn < 20; turn += 1) await setImmediate();
}

/**
 * A runner's client over the fakes, reporting where `reports` says, and
 * given no reports at all where it is null, each pass minting its token
 * afresh.
 *
 * @param {{on: boolean, machine?: () => unknown, host?: string} | null} [reports]
 */
function harness(reports = { on: true }) {
  const plane = fakePlane();
  const backend = fakeBackend();
  const clock = fakeWaits();
  /** @type {string[]} */
  const log = [];
  let minted = 0;
  const client = poolRunnerClient(
    credentials,
    /** @type {never} */ (backend),
    { concurrencyMax: 3, sessionsMax: 2 },
    {
      tokens: {
        acquire: async () => ({
          acquired: "Token",
          token: `pool-token-${String(++minted)}`,
        }),
        invalidate: () => undefined,
      },
      fetch: async () => new globalThis.Response(null, { status: 204 }),
      planeFetch: plane.fetch,
      ...(reports === null
        ? {}
        : {
            reports: /** @type {never} */ ({
              log: (/** @type {string} */ line) => log.push(line),
              host: "runner-1.example",
              uptimeSecs: () => 42,
              wait: clock.wait,
              ...reports,
            }),
          }),
    },
  );
  /** One pass, and whatever it started behind it. */
  const pass = async () => {
    const passed = await workerPoolClientPass(client);
    await settled();
    return passed;
  };
  return { client, plane, backend, clock, log, pass };
}

test("a report counts what the runner did through the paths that did it, since its client was made", async (t) => {
  const { client, plane, backend, clock, pass } = harness();
  t.after(() => client.reporting?.ended());
  backend.measures.pulled(3);
  backend.measures.ran("Job", 45);
  backend.refused.add("job-b");
  plane.answer = () =>
    plane.reconciled({
      assignments: [job("job-a"), job("job-b")],
      sessions: [session("session-s")],
    });
  await pass();
  backend.holding = [
    { assignment: "job-a", kind: "Job" },
    { assignment: "session-s", kind: "Session" },
    { assignment: "job-c", kind: "Job" },
  ];
  backend.ending = [
    { kind: "Job", job: attempt("job-d"), why: "exited", ran: "Succeeded" },
    { kind: "Job", job: attempt("job-e"), why: "late", killed: "Deadline" },
    {
      kind: "Job",
      job: attempt("job-f"),
      why: "it has no git",
      refusal: { fault: "ImageLacksGit" },
    },
    { kind: "Job", job: attempt("job-g"), why: "exited", ran: "Failed" },
    { kind: "Session", session: attempt("session-t"), phase: "Failed" },
  ];
  plane.answer = () => plane.reconciled({ stop: ["job-a", "session-s"] });
  await pass();
  backend.holding = [{ assignment: "job-c", kind: "Job" }];
  plane.answer = () => {
    throw new TypeError("fetch failed");
  };
  await pass();
  plane.answer = () => new globalThis.Response("bad gateway", { status: 502 });
  await pass();
  plane.answer = () => plane.reconciled({});
  await pass();
  await clock.elapsed();

  assert.deepEqual(plane.unread, []);
  assert.deepEqual(plane.reports.at(-1)?.body, {
    host: "runner-1.example",
    uptimeSecs: 42,
    jobsRunning: 1,
    concurrencyMax: 3,
    sessionsRunning: 0,
    sessionsMax: 2,
    polls: 5,
    pollsFailed: 2,
    settlements: { Accepted: 2, Refused: 2 },
    refusals: { NoFault: 1, ImageLacksGit: 1 },
    jobsEnded: {
      PlacementFailed: 2,
      Succeeded: 1,
      Deadline: 1,
      Failed: 1,
      Stopped: 1,
    },
    sessionsEnded: { Failed: 1 },
    imagePullSecs: backend.measures.measured().imagePullSecs,
    runSecs: backend.measures.measured().runSecs,
  });
});

test("a report is sent at once after the first poll whose answer names a version that takes it, then once each interval, and never after its run ends", async () => {
  const { client, plane, clock, pass } = harness();
  plane.release = releaseBefore;
  await pass();
  assert.equal(plane.reports.length, 0);
  assert.deepEqual(clock.waits, []);
  plane.release = releaseReporting;
  await pass();
  assert.equal(plane.reports.length, 1);
  assert.deepEqual(
    clock.waits.map(({ ms }) => ms),
    [runnerReportIntervalMs],
  );
  await pass();
  await pass();
  assert.equal(plane.reports.length, 1);
  await clock.elapsed();
  assert.equal(plane.reports.length, 2);
  assert.deepEqual(
    clock.waits.map(({ ms }) => ms),
    [runnerReportIntervalMs],
  );
  plane.answer = () => plane.answered(404);
  await poolRunnerLoop(client, {
    sleep: async () => undefined,
    log: () => undefined,
  });
  await settled();
  assert.deepEqual(clock.waits, []);
  await pass();
  assert.equal(plane.reports.length, 2);
  assert.deepEqual(plane.unread, []);
});

test("a report is sent under the bearer of the last poll the plane did not reject, through the client that polled", async (t) => {
  const { client, plane, clock, pass } = harness();
  t.after(() => client.reporting?.ended());
  await pass();
  assert.equal(plane.reports[0]?.bearer, "Bearer pool-token-1");
  await pass();
  plane.answer = () => plane.answered(401);
  await pass();
  await clock.elapsed();
  assert.equal(plane.reports[1]?.bearer, "Bearer pool-token-2");
});

test("a plane naming a version before the reports' is sent none, and one naming it again is sent them again", async (t) => {
  const { client, plane, clock, pass } = harness();
  t.after(() => client.reporting?.ended());
  for (const release of [releaseBefore, "0.99.0", "2.28.0"]) {
    plane.release = release;
    await pass();
  }
  assert.equal(plane.reports.length, 0);
  assert.deepEqual(clock.waits, []);
  plane.release = workerContractRelease;
  await pass();
  assert.equal(plane.reports.length, 1);
  plane.release = releaseBefore;
  await pass();
  await clock.elapsed();
  assert.equal(plane.reports.length, 1);
  plane.answer = () => new globalThis.Response(null, { status: 502 });
  plane.release = releaseReporting;
  await pass();
  await clock.elapsed();
  assert.equal(plane.reports.length, 1);
  plane.answer = () => plane.reconciled({});
  await pass();
  await clock.elapsed();
  assert.equal(plane.reports.length, 2);
});

test("a runner whose reports are off sends none, and makes every other request as one that reports does", async () => {
  /** @param {ReturnType<typeof harness>} runner */
  const run = async (runner) => {
    runner.backend.refused.add("job-b");
    runner.plane.answer = () =>
      runner.plane.reconciled({
        assignments: [job("job-a"), job("job-b")],
        sessions: [session("session-s")],
      });
    await runner.pass();
    runner.backend.holding = [{ assignment: "job-a", kind: "Job" }];
    runner.backend.ending = [
      {
        kind: "Job",
        job: attempt("job-f"),
        why: "it has no git",
        refusal: { fault: "ImageLacksGit" },
      },
    ];
    runner.plane.answer = () => runner.plane.reconciled({ stop: ["job-a"] });
    return [await runner.pass(), await runner.pass()];
  };
  const on = harness();
  const passedOn = await run(on);
  on.client.reporting?.ended();
  for (const reports of [null, { on: false }]) {
    const off = harness(/** @type {never} */ (reports));
    assert.equal(off.client.reporting, undefined);
    assert.deepEqual(await run(off), passedOn);
    assert.deepEqual(off.plane.requests, on.plane.requests);
    assert.deepEqual(off.plane.reports, []);
    assert.deepEqual(off.clock.waits, []);
  }
  assert.ok(on.plane.reports.length > 0);
});

test("a report that fails, hangs or throws leaves every poll, placement and settlement as it was, and is said as its failures start and end", async (t) => {
  const { client, plane, clock, log, pass } = harness();
  t.after(() => client.reporting?.ended());
  plane.report = () => plane.answered(500);
  plane.answer = () => plane.reconciled({ assignments: [job("job-a")] });
  assert.deepEqual(await pass(), {
    passed: "Reconciled",
    placed: 1,
    stopped: 0,
    refused: 0,
    ended: 0,
  });
  plane.answer = () => plane.reconciled({});
  await clock.elapsed();
  plane.report = () => {
    throw new TypeError("fetch failed");
  };
  await clock.elapsed();
  assert.deepEqual(log, [
    "a runner report was not taken: the plane answered 500; reports go on, and this is said again once one is",
  ]);
  plane.report = () => plane.answered(204);
  await clock.elapsed();
  plane.report = () => new Promise(() => undefined);
  await clock.elapsed();
  assert.deepEqual(log.slice(1), ["runner reports are taken again"]);
  const polls = plane.requests.length;
  for (let passed = 0; passed < 3; passed += 1)
    assert.equal((await pass()).passed, "Reconciled");
  assert.equal(plane.requests.length, polls + 3);
  assert.equal(plane.reports.length, 5);
});

test("a machine's facts are the companion's, each one the contract does not read left out, and none where its seam fails", async () => {
  for (const [machine, named] of /** @type {const} */ ([
    [
      () => ({
        cpus: 8,
        loadAverageOneMinute: 0.25,
        memoryTotalBytes: 2 ** 34,
        memoryAvailableBytes: -1,
        diskFreeBytes: 1.5,
        diskFloorBytes: 2 ** 30,
        swapBytes: 7,
      }),
      {
        cpus: 8,
        loadAverageOneMinute: 0.25,
        memoryTotalBytes: 2 ** 34,
        diskFloorBytes: 2 ** 30,
      },
    ],
    [
      async () => ({ memoryAvailableBytes: 2 ** 32 }),
      { memoryAvailableBytes: 2 ** 32 },
    ],
    [
      () => {
        throw new Error("no statfs here");
      },
      {},
    ],
    [async () => undefined, {}],
    [undefined, {}],
  ])) {
    const { client, plane, pass } = harness(
      machine === undefined ? { on: true } : { on: true, machine },
    );
    await pass();
    client.reporting?.ended();
    assert.deepEqual(plane.unread, []);
    const body = plane.reports[0]?.body ?? {};
    assert.deepEqual(
      Object.fromEntries(
        [
          "cpus",
          "loadAverageOneMinute",
          "memoryTotalBytes",
          "memoryAvailableBytes",
          "diskFreeBytes",
          "diskFloorBytes",
        ].flatMap((field) =>
          field in body
            ? [[field, body[/** @type {keyof typeof body} */ (field)]]]
            : [],
        ),
      ),
      named,
    );
    assert.equal("swapBytes" in body, false);
  }
});

test("a machine's name the contract does not read is made one it does, so the runner still reports", async () => {
  for (const [name, read] of [
    ["runner-1.example", "runner-1.example"],
    ["Kim’s MacBook Pro", "Kim-s-MacBook-Pro"],
    ["-_.runner", "runner"],
    ["", "unnamed"],
    ["ü", "unnamed"],
    [
      "a".repeat(workerRunnerHostCharsMax + 9),
      "a".repeat(workerRunnerHostCharsMax),
    ],
  ]) {
    assert.equal(runnerReportHost(name), read);
    assert.ok(workerRunnerReportSchema.shape.host.safeParse(read).success);
  }
  const { client, plane, pass } = harness({ on: true, host: "my host!" });
  await pass();
  client.reporting?.ended();
  assert.equal(plane.reports[0]?.body.host, "my-host-");
});

test("the heaviest report the contract reads is one sent, and a body it does not read is sent as none", () => {
  const countMax = Number.MAX_SAFE_INTEGER;
  /** @param {readonly string[]} labels */
  const full = (labels) =>
    Object.fromEntries(labels.map((label) => [label, countMax]));
  /** @param {readonly number[]} bounds */
  const histogram = (bounds) => ({
    bucketCounts: [...bounds, 0].map(() => countMax),
    sumSecs: Number.MAX_VALUE,
  });
  const heaviest = {
    host: "a".repeat(workerRunnerHostCharsMax),
    uptimeSecs: Number.MAX_VALUE,
    jobsRunning: countMax,
    concurrencyMax: countMax,
    sessionsRunning: countMax,
    sessionsMax: countMax,
    diskFreeBytes: countMax,
    diskFloorBytes: countMax,
    cpus: countMax,
    loadAverageOneMinute: Number.MAX_VALUE,
    memoryTotalBytes: countMax,
    memoryAvailableBytes: countMax,
    polls: countMax,
    pollsFailed: countMax,
    settlements: full(workerPoolSettlementOutcomes),
    refusals: full(workerRunnerRefusalFaults),
    jobsEnded: full(workerRunnerJobEnds),
    sessionsEnded: full(sessionContainerEnds),
    imagePullSecs: histogram(workerRunnerImagePullBoundsSecs),
    runSecs: Object.fromEntries(
      workerRunnerRunKinds.map((kind) => [
        kind,
        histogram(workerRunnerRunBoundsSecs),
      ]),
    ),
  };
  const text = runnerReportText(heaviest);
  assert.ok(text !== undefined);
  assert.ok(Buffer.byteLength(text) <= workerRunnerReportBytesMax);
  assert.deepEqual(JSON.parse(text), heaviest);
  for (const unread of [
    { ...heaviest, host: "a b" },
    { ...heaviest, polls: -1 },
    { ...heaviest, swapBytes: 1 },
    {},
  ])
    assert.equal(runnerReportText(unread), undefined);
});

test("a histogram counts a duration in the first bucket whose bound it does not pass, or the one past the last, and no duration a clock could not give", () => {
  const measures = runnerMeasures();
  const [first, second] = workerRunnerImagePullBoundsSecs;
  const last = /** @type {number} */ (workerRunnerImagePullBoundsSecs.at(-1));
  for (const secs of [0, first, first + 0.5, second, last + 1, -1, Number.NaN])
    measures.pulled(secs);
  const expected = [
    2,
    2,
    ...workerRunnerImagePullBoundsSecs.slice(2).map(() => 0),
    1,
  ];
  assert.deepEqual(measures.measured().imagePullSecs, {
    bucketCounts: expected,
    sumSecs: 0 + first + first + 0.5 + second + last + 1,
  });
  measures.ran("Session", 1);
  const summed = runnerMeasuredSum([measures.measured(), measures.measured()]);
  assert.deepEqual(
    summed.imagePullSecs.bucketCounts,
    expected.map((count) => count * 2),
  );
  assert.equal(summed.runSecs.Session.sumSecs, 2);
  assert.equal(summed.runSecs.Job.sumSecs, 0);
});
