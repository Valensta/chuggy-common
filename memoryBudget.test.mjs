import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { fakeEngine } from "./engine.fixture.mjs";
import { heldCreateArgv } from "./engineArgv.mjs";
import {
  memoryBudget,
  memoryBudgetHeld,
  memoryBudgetState,
  memoryCounted,
  memoryJobsTaken,
  memoryLocked,
  memoryRoomBytes,
  memoryRoomMibMin,
  memorySizeBytes,
  memoryStartCutMs,
  memoryStartDecided,
  memoryStartMsMin,
} from "./memoryBudget.mjs";

const gib = 2 ** 30;
const mib = 2 ** 20;

/** When every count here is made. */
const nowMs = 5000;

/**
 * A container on the fake engine.
 *
 * @param {ReturnType<typeof fakeEngine>["state"]} state
 * @param {string} name
 * @param {{labels?: Record<string, string>, memoryBytes?: number, usedBytes?: number, status?: string}} [what]
 */
function running(state, name, what = {}) {
  state.containers.set(name, {
    id: `id-${name}`,
    name,
    status: what.status ?? "running",
    image: "registry.example/any",
    labels: what.labels ?? {},
    memoryBytes: what.memoryBytes ?? 0,
    usedBytes: what.usedBytes ?? 0,
  });
}

/**
 * A hold on the fake engine, as a runner makes one.
 *
 * @param {ReturnType<typeof fakeEngine>["engine"]} engine
 * @param {Partial<import("./memoryBudget.mjs").MemoryHold>} hold
 */
async function held(engine, hold) {
  const answer = await engine.exec(
    heldCreateArgv({
      name: "chuggy-shame-aaa-held",
      pool: "vteng/chuggy/shame",
      assignment: "asg-held",
      memoryMib: 4096,
      heldMs: 1000,
      pid: 101,
      untilMs: nowMs + 1,
      starting: false,
      ...hold,
    }),
  );
  assert.equal(answer.code, 0);
}

/**
 * @param {ReturnType<typeof fakeEngine>["engine"]} engine
 * @param {{name?: "docker" | "podman", alive?: (pid: number) => boolean}} [what]
 */
function counted(engine, what = {}) {
  return memoryCounted({
    engine,
    name: what.name ?? "docker",
    holderAlive: what.alive ?? (() => true),
    nowMs: () => nowMs,
    signal: new globalThis.AbortController().signal,
  });
}

/** @param {Partial<import("./memoryBudget.mjs").MemoryCount>} [count] */
const count = (count = {}) => ({
  engineBytes: 16 * gib,
  cappedBytes: 0,
  usedBytes: 0,
  holds: [],
  started: [],
  ...count,
});

test("a size is read in docker's binary units and podman's decimal ones, and nothing else", () => {
  assert.equal(memorySizeBytes("355.5MiB"), 355.5 * mib);
  assert.equal(memorySizeBytes("1.5GiB"), 1.5 * gib);
  assert.equal(memorySizeBytes("0B"), 0);
  assert.equal(memorySizeBytes("1.982MB"), 1.982e6);
  assert.equal(memorySizeBytes("33.42GB"), 33.42e9);
  assert.equal(memorySizeBytes("12kB"), 12e3);
  assert.equal(memorySizeBytes("--"), undefined);
  assert.equal(memorySizeBytes("12constructor"), undefined);
  assert.equal(memorySizeBytes("1.5 GiB"), undefined);
});

test("every pool's workloads are counted at their caps, and everything else at its use", async () => {
  const { engine, state } = fakeEngine();
  running(state, "chuggy-shame-job", {
    labels: { "io.chuggy.pool": "vteng/chuggy/shame", "io.chuggy.kind": "Job" },
    memoryBytes: 4 * gib,
    usedBytes: 1 * gib,
  });
  running(state, "chuggy-other-job", {
    labels: { "io.chuggy.pool": "vteng/chuggy/other" },
    memoryBytes: 6 * gib,
    usedBytes: 1 * gib,
  });
  running(state, "chuggy-shame-session", {
    labels: {
      "io.chuggy.pool": "vteng/chuggy/shame",
      "io.chuggy.kind": "Session",
    },
    memoryBytes: 2 * gib,
    usedBytes: 1 * gib,
  });
  running(state, "chuggy-jobs-postgres", { usedBytes: 256 * mib });
  running(state, "testcontainers-postgres", {
    labels: { "org.testcontainers": "true" },
    memoryBytes: 8 * gib,
    usedBytes: 300 * mib,
  });
  running(state, "chuggy-uncapped", {
    labels: { "io.chuggy.pool": "vteng/chuggy/shame" },
    usedBytes: 100 * mib,
  });
  running(state, "chuggy-ended", {
    labels: { "io.chuggy.pool": "vteng/chuggy/shame" },
    memoryBytes: 8 * gib,
    status: "exited",
  });

  const { counted: found, abandoned } = await counted(engine);

  assert.deepEqual(found, {
    engineBytes: 16 * gib,
    cappedBytes: 12 * gib,
    usedBytes: 656 * mib,
    holds: [],
    started: [],
  });
  assert.deepEqual(abandoned, []);
});

test("the engine's memory is podman's own where the engine is podman", async () => {
  const { engine, state } = fakeEngine();
  state.memTotalBytes = 24 * gib;
  state.intercept = (call) =>
    call.argv[0] === "info"
      ? {
          code: 0,
          stdout: `${JSON.stringify({ host: { memTotal: 24 * gib } })}\n`,
          stderr: "",
        }
      : undefined;

  const { counted: found } = await counted(engine, { name: "podman" });

  assert.equal("engineBytes" in found && found.engineBytes, 24 * gib);
});

test("a hold is counted at its cap whichever runner holds it, and one whose process ended or whose deadline passed is not", async () => {
  const { engine } = fakeEngine();
  await held(engine, {
    name: "chuggy-other-x-held",
    pool: "vteng/chuggy/other",
  });
  await held(engine, {
    name: "chuggy-shame-y-held",
    pid: 202,
    memoryMib: 2048,
  });
  await held(engine, { name: "chuggy-shame-z-held", pid: 303 });
  await held(engine, { name: "chuggy-shame-late-held", untilMs: nowMs });

  const { counted: found, abandoned } = await counted(engine, {
    alive: (pid) => pid !== 303,
  });

  assert.ok("holds" in found);
  assert.deepEqual(
    found.holds.map(({ name, pool, memoryMib, pid }) => ({
      name,
      pool,
      memoryMib,
      pid,
    })),
    [
      {
        name: "chuggy-other-x-held",
        pool: "vteng/chuggy/other",
        memoryMib: 4096,
        pid: 101,
      },
      {
        name: "chuggy-shame-y-held",
        pool: "vteng/chuggy/shame",
        memoryMib: 2048,
        pid: 202,
      },
    ],
  );
  assert.deepEqual(abandoned, [
    "chuggy-shame-z-held",
    "chuggy-shame-late-held",
  ]);
  assert.equal(memoryRoomBytes(2 * gib, found), 8 * gib);
});

test("a count the engine cannot answer is unknown, and says why", async () => {
  const { engine, state } = fakeEngine();
  running(state, "chuggy-jobs-postgres", { usedBytes: 256 * mib });
  state.intercept = (call) =>
    call.argv[0] === "volume"
      ? { code: 1, stdout: "", stderr: "Error: volumes are not served\n" }
      : undefined;
  assert.deepEqual((await counted(engine)).counted, {
    unknown:
      "docker could not say what it holds: Error: volumes are not served",
  });

  state.intercept = (call) =>
    call.argv[0] === "stats"
      ? { code: 0, stdout: "chuggy-jobs-postgres -- / --\n", stderr: "" }
      : undefined;
  assert.deepEqual((await counted(engine)).counted, {
    unknown:
      "docker printed a use of chuggy-jobs-postgres this runner cannot read: --",
  });

  state.intercept = (call) =>
    call.argv[0] === "info"
      ? { code: 0, stdout: "{}\n", stderr: "" }
      : undefined;
  assert.deepEqual((await counted(engine)).counted, {
    unknown: "docker answered an info this runner cannot read",
  });
});

test("where the engine refuses its stats, what no runner capped is counted at none and the count says why; stats that never answer fail the count", async () => {
  const { engine, state } = fakeEngine();
  running(state, "chuggy-jobs-postgres", { usedBytes: 256 * mib });
  running(state, "chuggy-shame-job", {
    labels: { "io.chuggy.pool": "vteng/chuggy/shame" },
    memoryBytes: 4 * gib,
  });
  await held(engine, { memoryMib: 1024 });
  state.intercept = (call) =>
    call.argv[0] === "stats"
      ? {
          code: 125,
          stdout: "",
          stderr:
            "Error: stats is not supported in rootless mode without cgroups v2\n",
        }
      : undefined;
  const { counted: refused } = await counted(engine, { name: "podman" });
  assert.deepEqual(refused, {
    engineBytes: 16 * gib,
    cappedBytes: 4 * gib,
    usedBytes: 0,
    unmeasured:
      "podman could not say what its containers use: Error: stats is not supported in rootless mode without cgroups v2",
    holds: [
      {
        name: "chuggy-shame-aaa-held",
        pool: "vteng/chuggy/shame",
        assignment: "asg-held",
        memoryMib: 1024,
        heldMs: 1000,
        pid: 101,
        untilMs: nowMs + 1,
        starting: false,
      },
    ],
    started: [],
  });
  assert.equal(memoryRoomBytes(0, refused), 11 * gib);

  state.intercept = (call) =>
    call.argv[0] === "stats"
      ? Promise.reject(
          Object.assign(new Error("The operation was aborted"), {
            name: "AbortError",
          }),
        )
      : undefined;
  assert.deepEqual((await counted(engine)).counted, {
    unknown: "docker did not answer in time",
  });
});

test("stats that found the engine unreachable, or whose CLI could not start, fail the count rather than count as a refusal", async () => {
  const { engine, state } = fakeEngine();
  running(state, "chuggy-jobs-postgres", { usedBytes: 256 * mib });
  for (const unreachable of [
    {
      code: 1,
      stdout: "",
      stderr:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
    },
    {
      code: -1,
      stdout: "",
      stderr: "spawn docker EAGAIN",
      failed: /** @type {const} */ ("Unstarted"),
    },
  ]) {
    state.intercept = (call) =>
      call.argv[0] === "stats" ? unreachable : undefined;
    const { counted: unreached } = await counted(engine);
    assert.ok("unknown" in unreached);
    assert.match(
      unreached.unknown,
      /^docker could not say what its containers use: /u,
    );
  }
});

test("a job whose container starts and whose hold goes while the engine is counted is counted once, by the one or the other", async () => {
  const { engine, state } = fakeEngine();
  const job = {
    labels: {
      "io.chuggy.pool": "vteng/chuggy/shame",
      "io.chuggy.assignment": "asg-held",
    },
    memoryBytes: 4 * gib,
  };
  running(state, "chuggy-jobs-postgres", { usedBytes: 1 * gib });
  await held(engine, {});
  state.intercept = (call) => {
    if (call.argv[0] === "stats" && !state.containers.has("chuggy-shame-aaa")) {
      running(state, "chuggy-shame-aaa", job);
      state.volumes.delete("chuggy-shame-aaa-held");
    }
    return undefined;
  };
  const { counted: during } = await counted(engine);
  assert.ok("holds" in during);
  assert.equal(memoryRoomBytes(0, during), 11 * gib);

  await held(engine, {});
  const { counted: both } = await counted(engine);
  assert.ok("holds" in both);
  assert.deepEqual(both.holds, []);
  assert.deepEqual(both.started, ["asg-held"]);
  assert.equal(memoryRoomBytes(0, both), 11 * gib);

  state.containers.delete("chuggy-shame-aaa");
  await held(engine, {});
  let listings = 0;
  state.intercept = (call) => {
    if (
      call.argv[0] === "ps" ||
      call.argv.slice(0, 2).join(" ") === "volume ls"
    )
      listings += 1;
    if (listings === 2 && !state.containers.has("chuggy-shame-aaa")) {
      running(state, "chuggy-shame-aaa", job);
      state.volumes.delete("chuggy-shame-aaa-held");
    }
    return undefined;
  };
  const { counted: between } = await counted(engine);
  assert.equal(listings, 2);
  assert.ok("holds" in between);
  assert.equal(memoryRoomBytes(0, between), 11 * gib);
});

test("no stats are asked while every running container is a capped workload", async () => {
  const { engine, state } = fakeEngine();
  running(state, "chuggy-shame-job", {
    labels: { "io.chuggy.pool": "vteng/chuggy/shame" },
    memoryBytes: 4 * gib,
  });
  await counted(engine);
  assert.ok(!state.calls.some((call) => call.argv[0] === "stats"));
});

test("a job is claimed only while the room left is at least the least a job asks and nothing is held", () => {
  const floor = memoryRoomMibMin * mib;
  const free = 2 * gib;
  const full = count({ cappedBytes: 14 * gib - floor });
  assert.equal(memoryJobsTaken(free, full, 0), true);
  assert.equal(memoryJobsTaken(free, full, 1), false);
  assert.equal(
    memoryJobsTaken(free, count({ cappedBytes: 14 * gib - floor + 1 }), 0),
    false,
  );
  assert.equal(
    memoryJobsTaken(free, count({ cappedBytes: 4 * gib }), 2 * gib),
    true,
  );
  assert.equal(
    memoryJobsTaken(
      free,
      count({ cappedBytes: 4 * gib }),
      10 * gib - floor + 1,
    ),
    false,
  );
  assert.equal(
    memoryJobsTaken(
      free,
      count({
        holds: [
          {
            name: "h",
            pool: "p",
            assignment: "a",
            memoryMib: 512,
            heldMs: 0,
            pid: 1,
            untilMs: nowMs + 1,
            starting: false,
          },
        ],
      }),
      0,
    ),
    false,
  );
  assert.equal(memoryJobsTaken(free, { unknown: "why" }, 0), false);
});

/**
 * @param {string} name
 * @param {number} heldMs
 * @param {number} [memoryMib]
 */
const hold = (name, heldMs, memoryMib = 4096) => ({
  name,
  pool: "vteng/chuggy/shame",
  assignment: `asg-${name}`,
  memoryMib,
  heldMs,
  pid: 1,
  untilMs: nowMs + memoryStartCutMs + memoryStartMsMin,
  starting: false,
});

test("a job starts where it fits the room its own hold leaves, and is held where it does not", () => {
  const free = 2 * gib;
  const own = hold("own", 50, 8192);
  assert.deepEqual(
    memoryStartDecided(
      free,
      count({ cappedBytes: 6 * gib, holds: [own] }),
      own,
      nowMs,
    ),
    { decided: "Start" },
  );
  assert.deepEqual(
    memoryStartDecided(
      free,
      count({ cappedBytes: 6 * gib, usedBytes: 1, holds: [own] }),
      own,
      nowMs,
    ),
    { decided: "Hold", why: "needs 8 GiB, room 8 GiB" },
  );
  assert.deepEqual(
    memoryStartDecided(free, count({ cappedBytes: 13 * gib }), own, nowMs),
    { decided: "Hold", why: "needs 8 GiB, room 1 GiB" },
  );
  assert.deepEqual(
    memoryStartDecided(free, count({ cappedBytes: 20 * gib }), own, nowMs),
    { decided: "Hold", why: "needs 8 GiB, room 0 GiB" },
  );
  assert.deepEqual(memoryStartDecided(free, { unknown: "why" }, own, nowMs), {
    decided: "Hold",
    why: "the engine's memory could not be counted: why",
  });
  assert.deepEqual(
    memoryStartDecided(
      free,
      count({
        cappedBytes: 14 * gib,
        holds: [hold("older", 10)],
        started: [own.assignment],
      }),
      own,
      nowMs,
    ),
    { decided: "Running" },
  );
});

test("a job whose start could not be given its least time before its hold's deadline, less the cut, is too late, whatever the count, unless its container is running", () => {
  const free = 2 * gib;
  const own = hold("own", 50, 512);
  assert.deepEqual(memoryStartDecided(free, count(), own, nowMs), {
    decided: "Start",
  });
  for (const counted of [count(), { unknown: "why" }])
    assert.deepEqual(memoryStartDecided(free, counted, own, nowMs + 1), {
      decided: "Late",
    });
  assert.deepEqual(
    memoryStartDecided(
      free,
      count({ started: [own.assignment] }),
      own,
      nowMs + 1,
    ),
    { decided: "Running" },
  );
});

test("a job waits behind every hold older than its own, oldest first, however it fits", () => {
  const free = 2 * gib;
  const own = hold("b", 50, 512);
  const holds = [hold("c", 50), hold("z", 40), hold("a", 50), own];
  assert.deepEqual(memoryStartDecided(free, count({ holds }), own, nowMs), {
    decided: "Hold",
    why: "behind z, held before it",
  });
  assert.deepEqual(
    memoryStartDecided(
      free,
      count({ holds: [hold("c", 50), own] }),
      own,
      nowMs,
    ),
    { decided: "Start" },
  );
  assert.deepEqual(
    memoryStartDecided(
      free,
      count({ holds: [hold("a", 50), own] }),
      own,
      nowMs,
    ),
    { decided: "Hold", why: "behind a, held before it" },
  );
  assert.deepEqual(
    memoryStartDecided(
      free,
      count({ holds: [hold("a", 60)] }),
      {
        name: "new",
        assignment: "asg-new",
        memoryMib: 512,
        heldMs: 70,
        untilMs: own.untilMs,
      },
      nowMs,
    ),
    { decided: "Hold", why: "behind a, held before it" },
  );
});

test("a pass's count says what changed once, and takes no job while held, full or unknown", () => {
  const budget = memoryBudget(2 * gib, "/unused");
  assert.ok(budget !== undefined);
  /** @type {string[]} */
  const log = [];
  memoryBudgetHeld(
    budget,
    count({ cappedBytes: 4 * gib }),
    0,
    log.push.bind(log),
  );
  assert.equal(budget.jobsTaken, true);
  assert.deepEqual(log, []);

  memoryBudgetHeld(
    budget,
    count({ cappedBytes: 14 * gib }),
    0,
    log.push.bind(log),
  );
  memoryBudgetHeld(
    budget,
    count({ cappedBytes: 14 * gib }),
    0,
    log.push.bind(log),
  );
  assert.equal(budget.jobsTaken, false);
  memoryBudgetHeld(
    budget,
    count({ holds: [hold("a", 1)] }),
    0,
    log.push.bind(log),
  );
  assert.equal(budget.jobsTaken, false);
  memoryBudgetHeld(budget, { unknown: "no answer" }, 0, log.push.bind(log));
  assert.equal(budget.jobsTaken, false);
  memoryBudgetHeld(budget, count(), 0, log.push.bind(log));
  assert.equal(budget.jobsTaken, true);
  const refused = count({
    unmeasured:
      "podman could not say what its containers use: Error: no cgroups",
  });
  memoryBudgetHeld(budget, refused, 0, log.push.bind(log));
  memoryBudgetHeld(budget, { unknown: "no answer" }, 0, log.push.bind(log));
  memoryBudgetHeld(budget, refused, 0, log.push.bind(log));
  assert.equal(budget.jobsTaken, true);
  memoryBudgetHeld(budget, count(), 0, log.push.bind(log));
  assert.deepEqual(log, [
    "this engine has 0 GiB of room in its 14 GiB memory budget, under the 0.5 GiB a job needs: this runner takes no job until it has more",
    "this engine has 10 GiB of room in its 14 GiB memory budget, and a job on it is held for room: this runner takes no job until it starts",
    "this engine's memory could not be counted, so this runner takes no job: no answer",
    "this engine has 14 GiB of room in its 14 GiB memory budget: this runner takes jobs again",
    "this engine's containers no runner capped are counted as using no memory, since podman could not say what its containers use: Error: no cgroups",
    "this engine's memory could not be counted, so this runner takes no job: no answer",
    "this engine has 14 GiB of room in its 14 GiB memory budget: this runner takes jobs again",
    "this engine's containers no runner capped are counted at what they use again",
  ]);
  assert.deepEqual(
    [
      count({ cappedBytes: 4 * gib }),
      count({ cappedBytes: 14 * gib }),
      count({ holds: [hold("a", 1)] }),
      count({ holds: [{ ...hold("a", 1), starting: true }] }),
      count({ holds: [hold("a", 1), { ...hold("b", 1), starting: true }] }),
      { unknown: "no answer" },
    ].map((each) => memoryBudgetState(2 * gib, each, 0)),
    ["Taking", "Full", "Held", "Starting", "Held", "Unknown"],
  );
});

test("a job starting takes no job and logs nothing, from whatever was last logged", () => {
  const budget = memoryBudget(2 * gib, "/unused");
  assert.ok(budget !== undefined);
  /** @type {string[]} */
  const log = [];
  const starting = count({ holds: [{ ...hold("a", 1), starting: true }] });
  memoryBudgetHeld(budget, starting, 0, log.push.bind(log));
  assert.equal(budget.jobsTaken, false);
  memoryBudgetHeld(budget, count(), 0, log.push.bind(log));
  assert.equal(budget.jobsTaken, true);
  memoryBudgetHeld(
    budget,
    count({ holds: [hold("a", 1)] }),
    0,
    log.push.bind(log),
  );
  memoryBudgetHeld(budget, starting, 0, log.push.bind(log));
  memoryBudgetHeld(budget, count(), 0, log.push.bind(log));
  assert.deepEqual(log, [
    "this engine has 10 GiB of room in its 14 GiB memory budget, and a job on it is held for room: this runner takes no job until it starts",
    "this engine has 14 GiB of room in its 14 GiB memory budget: this runner takes jobs again",
  ]);
});

test("no budget is kept without what it keeps free or a lock", () => {
  assert.equal(memoryBudget(undefined, "/lock"), undefined);
  assert.equal(memoryBudget(0, undefined), undefined);
  assert.ok(memoryBudget(0, "/lock") !== undefined);
});

test("two holds of the memory lock never overlap", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-memory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockFile = join(directory, "locks", "docker.lock");
  /** @type {string[]} */
  const order = [];
  /** @param {string} who */
  const hold = (who) =>
    memoryLocked(
      lockFile,
      async () => {
        order.push(`${who} in`);
        await setImmediate();
        await setImmediate();
        order.push(`${who} out`);
      },
      { wait: () => setImmediate() },
    );
  await Promise.all([hold("a"), hold("b")]);
  const [first] = order;
  const [one, other] = first === "a in" ? ["a", "b"] : ["b", "a"];
  assert.deepEqual(order, [
    `${one} in`,
    `${one} out`,
    `${other} in`,
    `${other} out`,
  ]);
});
