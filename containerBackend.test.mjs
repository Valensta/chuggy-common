import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import {
  checkedContainerBackendSettings,
  containerBackend,
  containerName,
} from "./containerBackend.mjs";
import { deferred, fakeEngine } from "./engine.fixture.mjs";
import { jobEnvelope } from "./job.mjs";

const pool = { tenant: "vteng", project: "chuggy", pool: "shame" };
const image = "registry.chuggy.example/worker@sha256:" + "a".repeat(64);
const startMs = 1_800_000_000_000;

/** @param {Partial<import("@chuggy/worker-contract/workerPool").WorkerPoolAssignment>} overrides */
function assignment(overrides = {}) {
  return {
    assignment: "asg-1",
    capabilities: ["container"],
    image,
    cpuMillis: 2000,
    memoryMib: 4096,
    deadlineSecs: 3600,
    callbackUrl: "https://chuggy.example/worker",
    bearer: "attempt-bearer-secret",
    ...overrides,
  };
}

/**
 * @param {import("node:test").TestContext} t
 * @param {Partial<import("./containerBackend.mjs").ContainerBackendSettings>} overrides
 */
async function harness(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-backend-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, "claude-token");
  const { engine, state } = fakeEngine();
  const clock = { nowMs: startMs };
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} */
  const invalidated = [];
  let minted = 0;
  /** @type {string | undefined} why the runner says the token file cannot be handed over */
  let tokenFileRefused;
  /** @type {string[]} the token files the runner was asked about */
  const tokenFilesAsked = [];
  const settings = {
    engine: /** @type {"docker" | "podman"} */ ("podman"),
    pool,
    tokenFile,
    registryHost: /** @type {string | undefined} */ ("registry.chuggy.example"),
    dockerHost: /** @type {string | undefined} */ (undefined),
    timeoutSecsMax: 7200,
    outputBytesMax: 1024 * 1024,
    environment: { GIT_AUTHOR_NAME: "chuggy" },
    network: "chuggy-jobs",
    runtimeDir: join(directory, "runtime"),
    logDir: join(directory, "logs"),
    machine: { cpuMillis: 8000, memoryMib: 16384 },
    pullRetryMs: 5000,
    ...overrides,
  };
  const backend = containerBackend(settings, {
    engine,
    tokens: {
      acquire: async () => ({
        acquired: "Token",
        token: `pool-token-${String(++minted)}`,
      }),
      invalidate: (token) => invalidated.push(token),
    },
    nowMs: () => clock.nowMs,
    sleep: async (ms) => {
      clock.nowMs += ms;
    },
    log: (line) => log.push(line),
    tokenFileRefusal: async (file) => {
      tokenFilesAsked.push(file);
      return tokenFileRefused;
    },
  });
  return {
    backend,
    state,
    clock,
    log,
    invalidated,
    settings,
    minted: () => minted,
    tokenFilesAsked,
    /** @param {string | undefined} why */
    refuseTokenFile: (why) => {
      tokenFileRefused = why;
    },
  };
}

/** @param {ReturnType<typeof fakeEngine>["state"]} state */
const verbs = (state) => state.calls.map((call) => call.argv[0]);

/**
 * What `held` answers for jobs of these assignments.
 *
 * @param {...string} named
 */
const heldJobs = (...named) =>
  named.map((assignment) => ({ assignment, kind: "Job" }));

/**
 * The attempt a seeded container was run for.
 *
 * @param {string} id
 */
function seededAttempt(id) {
  return {
    assignment: id,
    callbackUrl: "https://chuggy.example/worker",
    bearer: `bearer-of-${id}`,
  };
}

/**
 * A container a predecessor started, as the engine lists it, with the
 * envelope of its attempt among its variables, labelled with a kind only
 * where one is given.
 *
 * @param {ReturnType<typeof fakeEngine>["state"]} state
 * @param {string} id
 * @param {string} status
 * @param {number} deadlineEpochSecs
 * @param {string} name
 * @param {"Job" | "Session"} [kind]
 */
function seeded(
  state,
  id,
  status,
  deadlineEpochSecs,
  name = containerName(pool, id),
  kind = undefined,
) {
  const envelope = jobEnvelope(assignment(seededAttempt(id)), {
    timeoutSecsMax: 7200,
    outputBytesMax: 1024 * 1024,
  });
  state.containers.set(name, {
    id: `id-${id}`,
    name,
    status,
    image,
    labels: {
      "io.chuggy.pool": "vteng/chuggy/shame",
      "io.chuggy.assignment": id,
      ...(kind === undefined ? {} : { "io.chuggy.kind": kind }),
      "io.chuggy.deadline": String(deadlineEpochSecs),
    },
    env: [`CHUG_WORKER_TASK=${envelope}`, "GIT_AUTHOR_NAME=chuggy"],
  });
  return name;
}

test("a slow pull keeps the assignment held, and the container it starts is held after it", async (t) => {
  const { backend, state, settings } = await harness(t);
  const pull = deferred();
  state.pull = () => pull.promise;

  assert.deepEqual(await backend.place(assignment(), "Job"), {
    placed: "Placed",
  });
  await setImmediate();
  assert.deepEqual(await backend.held(), heldJobs("asg-1"));
  assert.equal(backend.inFlight()[0]?.phase, "Pulling");

  state.images.add(image);
  pull.resolve({ code: 0, stdout: "", stderr: "" });
  await backend.settled();

  const name = containerName(pool, "asg-1");
  assert.deepEqual(state.containers.get(name)?.labels, {
    "io.chuggy.pool": "vteng/chuggy/shame",
    "io.chuggy.assignment": "asg-1",
    "io.chuggy.kind": "Job",
    "io.chuggy.deadline": String(startMs / 1000 + 3600),
  });
  assert.deepEqual(backend.inFlight(), []);
  assert.deepEqual(await backend.held(), heldJobs("asg-1"));
  assert.deepEqual(await readdir(settings.runtimeDir), []);
});

test("a job's env file carries the envelope and the environment, and is gone once run answers", async (t) => {
  const { backend, state, settings } = await harness(t);
  state.images.add(image);
  await backend.place(assignment(), "Job");
  await backend.settled();

  const run = state.calls.find((call) => call.argv[0] === "run");
  assert.match(
    run?.argv[run.argv.indexOf("--env-file") + 1] ?? "",
    new RegExp(`/job-${String(process.pid)}-[^/]+/env$`, "u"),
  );
  const [task, ...rest] = (run?.envFile ?? "").split("\n");
  assert.deepEqual(JSON.parse(task.replace(/^CHUG_WORKER_TASK=/u, "")), {
    callbackUrl: "https://chuggy.example/worker",
    bearer: "attempt-bearer-secret",
    workspace: "/workspace",
    timeoutSecsMax: 7200,
    outputBytesMax: 1024 * 1024,
    providerCredentialFile: "/var/run/chuggy/credentials/claude-code",
  });
  assert.deepEqual(rest, ["GIT_AUTHOR_NAME=chuggy", ""]);
  assert.ok(
    !run?.argv.some((argument) => argument.includes("attempt-bearer-secret")),
  );
  assert.deepEqual(await readdir(settings.runtimeDir), []);
});

test("a present image is not pulled", async (t) => {
  const { backend, state } = await harness(t);
  state.images.add(image);
  await backend.place(assignment(), "Job");
  await backend.settled();
  assert.deepEqual(verbs(state), ["image", "run"]);
});

test("a pull that fails drops out of held and is logged", async (t) => {
  const { backend, state, log, settings } = await harness(t);
  state.pull = () => ({
    code: 1,
    stdout: "",
    stderr: `Error response from daemon: manifest for ${image} not found: manifest unknown: manifest unknown\n`,
  });
  await backend.place(assignment(), "Job");
  await backend.settled();
  assert.deepEqual(await backend.held(), []);
  assert.match(
    log.join("\n"),
    /was not started: its image could not be pulled: Error response from daemon: manifest for/u,
  );
  assert.ok(!verbs(state).includes("run"));
  assert.deepEqual(await readdir(settings.runtimeDir), []);
});

/** @param {string} authFile */
function pulledAs(authFile) {
  const document = JSON.parse(authFile);
  const [host] = Object.keys(document.auths);
  return [
    host,
    Buffer.from(document.auths[host].auth, "base64").toString("utf8"),
  ];
}

test("a pull the registry refused is made again under a fresh token", async (t) => {
  const { backend, state, invalidated, settings } = await harness(t);
  let pulls = 0;
  state.pull = (pulledImage) => {
    pulls += 1;
    if (pulls === 1)
      return {
        code: 1,
        stdout: "",
        stderr:
          'Error response from daemon: Head "https://registry.chuggy.example/v2/worker/manifests/sha256:aaaa": unauthorized: authentication required\n',
      };
    state.images.add(pulledImage);
    return { code: 0, stdout: "", stderr: "" };
  };
  await backend.place(assignment(), "Job");
  await backend.settled();

  const pullCalls = state.calls.filter((call) => call.argv[0] === "pull");
  assert.deepEqual(
    pullCalls.map((call) => pulledAs(call.authFile ?? "{}")),
    [
      ["registry.chuggy.example", "chuggy-pool:pool-token-1"],
      ["registry.chuggy.example", "chuggy-pool:pool-token-2"],
    ],
  );
  assert.deepEqual(invalidated, ["pool-token-1"]);
  assert.ok(verbs(state).includes("run"));
  assert.deepEqual(await readdir(settings.runtimeDir), []);
});

test("a pull refused until the deadline gives up there", async (t) => {
  const { backend, state, invalidated, log } = await harness(t);
  state.pull = () => ({
    code: 1,
    stdout: "",
    stderr: "Error response from daemon: unauthorized\n",
  });
  await backend.place(assignment({ deadlineSecs: 12 }), "Job");
  await backend.settled();
  assert.deepEqual(invalidated, [
    "pool-token-1",
    "pool-token-2",
    "pool-token-3",
  ]);
  assert.match(
    log.at(-1) ?? "",
    /was not started: its image was not pulled by the assignment's deadline$/u,
  );
  assert.deepEqual(await backend.held(), []);
});

test("a pull's credential directory is owner-only while the pull runs", async (t) => {
  const { backend, state } = await harness(t);
  /** @type {number[]} */
  const modes = [];
  state.pull = async (pulledImage, call) => {
    const directory = call.authDirectory ?? "";
    modes.push((await stat(directory)).mode & 0o777);
    modes.push((await stat(join(directory, "config.json"))).mode & 0o777);
    state.images.add(pulledImage);
    return { code: 0, stdout: "", stderr: "" };
  };
  await backend.place(assignment(), "Job");
  await backend.settled();
  assert.deepEqual(modes, [0o700, 0o600]);
});

test("the pool's token is presented only to the registry the pool was registered for", async (t) => {
  const { backend, state, invalidated, minted } = await harness(t);
  const elsewhere = `registry.example.com/x@sha256:${"b".repeat(64)}`;
  await backend.place(assignment(), "Job");
  await backend.place(
    assignment({ assignment: "asg-2", image: elsewhere }),
    "Job",
  );
  await backend.settled();
  const pulls = state.calls.filter((call) => call.argv[0] === "pull");
  assert.deepEqual(
    Object.fromEntries(
      pulls.map((call) => [call.argv.at(-1), JSON.parse(call.authFile ?? "")]),
    ),
    {
      [image]: {
        auths: {
          "registry.chuggy.example": {
            auth: Buffer.from("chuggy-pool:pool-token-1").toString("base64"),
          },
        },
      },
      [elsewhere]: { auths: {} },
    },
  );
  assert.equal(pulls.length, 2);
  assert.equal(minted(), 1);
  assert.deepEqual(invalidated, []);
  assert.equal(state.containers.size, 2);
});

test("a pool whose registration names no registry never writes its token", async (t) => {
  const { backend, state, minted } = await harness(t, {
    registryHost: undefined,
  });
  await backend.place(assignment(), "Job");
  await backend.settled();
  const [pull] = state.calls.filter((call) => call.argv[0] === "pull");
  assert.deepEqual(JSON.parse(pull.authFile ?? ""), { auths: {} });
  assert.equal(minted(), 0);
  assert.ok(verbs(state).includes("run"));
});

test("a registry the pool's token was not sent to refusing a pull is not retried, and costs the token nothing", async (t) => {
  const { backend, state, invalidated, minted, log } = await harness(t);
  state.pull = () => ({
    code: 1,
    stdout: "",
    stderr:
      'Error response from daemon: Head "https://registry.example.com/v2/x/manifests/sha256:bbbb": unauthorized: authentication required\n',
  });
  await backend.place(
    assignment({ image: `registry.example.com/x@sha256:${"b".repeat(64)}` }),
    "Job",
  );
  await backend.settled();
  assert.equal(verbs(state).filter((verb) => verb === "pull").length, 1);
  assert.equal(minted(), 0);
  assert.deepEqual(invalidated, []);
  assert.match(
    log.at(-1) ?? "",
    /was not started: its image could not be pulled under no credential, as every image not of the pool's registry is: .*unauthorized/u,
  );
  assert.deepEqual(await backend.held(), []);
});

test("a repeated placement is placed once, in flight and after its container runs", async (t) => {
  const { backend, state, log } = await harness(t);
  const pull = deferred();
  state.pull = () => pull.promise;
  await backend.place(assignment(), "Job");
  assert.deepEqual(await backend.place(assignment(), "Job"), {
    placed: "Placed",
  });
  state.images.add(image);
  pull.resolve({ code: 0, stdout: "", stderr: "" });
  await backend.settled();

  assert.deepEqual(await backend.place(assignment(), "Job"), {
    placed: "Placed",
  });
  await backend.settled();
  assert.equal(state.containers.size, 1);
  assert.equal(verbs(state).filter((verb) => verb === "pull").length, 1);
  assert.match(log.at(-1) ?? "", /was already running$/u);
  assert.ok(
    !log.some((line) => line.includes("was not started")),
    log.join("\n"),
  );
});

test("a name another assignment holds is a placement that failed", async (t) => {
  const { backend, state, log } = await harness(t);
  state.images.add(image);
  seeded(
    state,
    "asg-other",
    "running",
    startMs / 1000 + 60,
    containerName(pool, "asg-1"),
  );
  await backend.place(assignment(), "Job");
  await backend.settled();
  assert.match(
    log.at(-1) ?? "",
    /was not started: its container could not be run: .*is already in use/u,
  );
});

test("a running container past its deadline is killed, its logs saved, and removed", async (t) => {
  const { backend, state, clock, settings } = await harness(t);
  const name = seeded(state, "asg-late", "running", startMs / 1000 + 10);
  clock.nowMs += 10_000;
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(verbs(state), ["ps", "container", "kill", "logs", "rm"]);
  assert.deepEqual(state.calls.at(-1)?.argv, ["rm", "-v", "id-asg-late"]);
  const saved = join(settings.logDir, `${name}.log`);
  assert.equal(await readFile(saved, "utf8"), `the log of ${name}\n`);
  assert.equal((await stat(saved)).mode & 0o777, 0o600);
  assert.deepEqual(await backend.ended(), [
    {
      kind: "Job",
      job: seededAttempt("asg-late"),
      why: "its container passed its deadline and was killed",
    },
  ]);
});

for (const [status, exitCode, why] of [
  ["exited", 3, "its container exited with status 3"],
  ["exited", undefined, "its container was left exited"],
  ["dead", 3, "its container was left dead"],
  ["created", 0, "its container was left created"],
])
  test(`a container left ${status}, exit status ${String(exitCode ?? "none")}, has its logs saved, is removed, and has its end named once`, async (t) => {
    const { backend, state, settings } = await harness(t);
    const name = seeded(state, "asg-done", status, startMs / 1000 + 60);
    const container =
      /** @type {import("./engine.fixture.mjs").FakeContainer} */ (
        state.containers.get(name)
      );
    container.exitCode = exitCode;
    assert.deepEqual(await backend.held(), []);
    assert.equal(state.containers.size, 0);
    assert.ok(verbs(state).every((verb) => verb !== "kill"));
    assert.equal(
      await readFile(join(settings.logDir, `${name}.log`), "utf8"),
      `the log of ${name}\n`,
    );
    assert.deepEqual(await backend.ended(), [
      { kind: "Job", job: seededAttempt("asg-done"), why },
    ]);
    assert.deepEqual(await backend.ended(), []);
  });

test("an ended container whose logs could not be saved is kept for the next pass", async (t) => {
  const { backend, state, log } = await harness(t);
  seeded(state, "asg-done", "exited", startMs / 1000 + 60);
  state.logsFail = true;
  assert.deepEqual(await backend.held(), []);
  assert.equal(state.containers.size, 1);
  assert.match(log.join("\n"), /ended; its logs could not be saved/u);
});

test("a job that exited of itself is named once, with its status and the attempt read back from its container", async (t) => {
  const { backend, state } = await harness(t);
  state.images.add(image);
  await backend.place(assignment(), "Job");
  await backend.settled();
  const [container] = state.containers.values();
  container.status = "exited";
  container.exitCode = 1;

  assert.deepEqual(await backend.ended(), []);
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(await backend.ended(), [
    {
      kind: "Job",
      job: {
        assignment: "asg-1",
        callbackUrl: "https://chuggy.example/worker",
        bearer: "attempt-bearer-secret",
      },
      why: "its container exited with status 1",
    },
  ]);
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(await backend.ended(), []);
});

test("an end is named once, though its container outlives the pass that named it", async (t) => {
  const { backend, state, clock } = await harness(t);
  seeded(state, "asg-late", "running", startMs / 1000 + 10);
  clock.nowMs += 10_000;
  state.logsFail = true;
  assert.deepEqual(await backend.held(), []);
  assert.equal(state.containers.size, 1);
  assert.equal((await backend.ended()).length, 1);

  state.logsFail = false;
  assert.deepEqual(await backend.held(), []);
  assert.equal(state.containers.size, 0);
  assert.deepEqual(await backend.ended(), []);
});

test("an assignment's end is accounted for only while a container of it is listed", async (t) => {
  const { backend, state } = await harness(t);
  for (const pass of ["named", "named again after a pass that listed none"]) {
    seeded(state, "asg-done", "exited", startMs / 1000 + 60);
    assert.deepEqual(await backend.held(), []);
    assert.deepEqual(
      (await backend.ended()).map(({ job }) => job),
      [seededAttempt("asg-done")],
      pass,
    );
    assert.deepEqual(await backend.held(), []);
  }
});

test("a container past its deadline that its kill did not end is not named", async (t) => {
  const { backend, state, clock, log } = await harness(t);
  seeded(state, "asg-late", "running", startMs / 1000 + 10);
  clock.nowMs += 10_000;
  state.killInterrupted = true;
  assert.deepEqual(await backend.held(), []);
  assert.match(log.join("\n"), /passed its deadline and was not killed/u);
  assert.deepEqual(await backend.ended(), []);
});

test("a container whose envelope cannot be read is left to its lease, and says so", async (t) => {
  const { backend, state, log } = await harness(t);
  const name = seeded(state, "asg-done", "exited", startMs / 1000 + 60);
  const container =
    /** @type {import("./engine.fixture.mjs").FakeContainer} */ (
      state.containers.get(name)
    );
  container.env = ["GIT_AUTHOR_NAME=chuggy"];
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(await backend.ended(), []);
  assert.match(
    log.join("\n"),
    /its envelope could not be read, so its attempt is left to its lease$/mu,
  );
});

test("a placement that failed is named with its failure and the job it held, once held no longer names it", async (t) => {
  const { backend, state } = await harness(t);
  const pull = deferred();
  state.pull = () => pull.promise;
  await backend.place(assignment(), "Job");
  await setImmediate();
  assert.deepEqual(await backend.held(), heldJobs("asg-1"));
  pull.resolve({
    code: 1,
    stdout: "",
    stderr: "Error response from daemon: manifest unknown\n",
  });
  await backend.settled();

  assert.deepEqual(await backend.ended(), []);
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(await backend.ended(), [
    {
      kind: "Job",
      job: {
        assignment: "asg-1",
        callbackUrl: "https://chuggy.example/worker",
        bearer: "attempt-bearer-secret",
      },
      why: "its container was not started: its image could not be pulled: Error response from daemon: manifest unknown",
    },
  ]);
  assert.deepEqual(await backend.ended(), []);
});

test("a stop drops the end of a failed placement, whether or not held has made it ready", async (t) => {
  const { backend, state } = await harness(t);
  state.pull = () => ({
    code: 1,
    stdout: "",
    stderr: "Error response from daemon: manifest unknown\n",
  });
  await backend.place(assignment(), "Job");
  await backend.settled();
  assert.deepEqual(await backend.held(), []);
  await backend.place(assignment({ assignment: "asg-2" }), "Job");
  await backend.settled();
  for (const stopped of ["asg-1", "asg-2"])
    assert.deepEqual(await backend.stop(stopped), { stopped: "Stopped" });
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(await backend.ended(), []);
});

test("a placement whose run failed after its container started answers through that container: held while it runs, named once it ends", async (t) => {
  const { backend, state, log } = await harness(t);
  state.images.add(image);
  state.runInterrupted = true;
  await backend.place(assignment(), "Job");
  await backend.settled();
  assert.match(
    log.at(-1) ?? "",
    /was not started: its container could not be run/u,
  );

  assert.deepEqual(await backend.held(), heldJobs("asg-1"));
  assert.deepEqual(await backend.ended(), []);
  const [container] = state.containers.values();
  container.status = "exited";
  container.exitCode = 1;
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(await backend.ended(), [
    {
      kind: "Job",
      job: {
        assignment: "asg-1",
        callbackUrl: "https://chuggy.example/worker",
        bearer: "attempt-bearer-secret",
      },
      why: "its container exited with status 1",
    },
  ]);
  assert.deepEqual(await backend.ended(), []);
});

test("a stop that lands while held is under way keeps an in-flight placement's end unnamed", async (t) => {
  const { backend, state } = await harness(t);
  const pull = deferred();
  state.pull = () => pull.promise;
  await backend.place(assignment(), "Job");
  await setImmediate();
  assert.deepEqual(await Promise.all([backend.held(), backend.stop("asg-1")]), [
    heldJobs("asg-1"),
    { stopped: "Stopped" },
  ]);
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(await backend.ended(), []);
});

test("a stop that lands while held is under way drops a failed placement's end", async (t) => {
  const { backend, state } = await harness(t);
  state.pull = () => ({
    code: 1,
    stdout: "",
    stderr: "Error response from daemon: manifest unknown\n",
  });
  await backend.place(assignment(), "Job");
  await backend.settled();
  assert.deepEqual(await Promise.all([backend.held(), backend.stop("asg-1")]), [
    [],
    { stopped: "Stopped" },
  ]);
  assert.deepEqual(await backend.ended(), []);
});

test("two pools of one name in different projects name an assignment's container apart", () => {
  const other = { tenant: "newtenant", project: "arbbot", pool: "shame" };
  assert.match(containerName(pool, "asg-1"), /^chuggy-shame-[0-9a-f]{20}$/u);
  assert.match(containerName(other, "asg-1"), /^chuggy-shame-[0-9a-f]{20}$/u);
  assert.notEqual(containerName(pool, "asg-1"), containerName(other, "asg-1"));
  assert.equal(
    containerName(pool, "asg-1"),
    containerName({ ...pool }, "asg-1"),
  );
});

test("another project's pool of the same name keeps its containers: this pool neither holds nor stops them", async (t) => {
  const { backend, state } = await harness(t);
  const other = { tenant: "newtenant", project: "arbbot", pool: "shame" };
  const name = containerName(other, "asg-2");
  state.containers.set(name, {
    id: "id-other",
    name,
    status: "running",
    image,
    labels: {
      "io.chuggy.pool": "newtenant/arbbot/shame",
      "io.chuggy.assignment": "asg-2",
      "io.chuggy.deadline": String(startMs / 1000 + 60),
    },
  });
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(await backend.stop("asg-2"), { stopped: "Stopped" });
  assert.equal(state.containers.get(name)?.status, "running");
  assert.ok(!verbs(state).includes("kill"), verbs(state).join(" "));
});

test("a container a run named before names were scoped by project is held, and stopped, by its labels", async (t) => {
  const { backend, state } = await harness(t);
  const digest = createHash("sha256").update("asg-2", "utf8").digest("hex");
  const name = seeded(
    state,
    "asg-2",
    "running",
    startMs / 1000 + 60,
    `chuggy-shame-${digest.slice(0, 20)}`,
  );
  assert.deepEqual(await backend.held(), heldJobs("asg-2"));
  assert.deepEqual(await backend.stop("asg-2"), { stopped: "Stopped" });
  assert.equal(state.containers.has(name), false);
});

test("a running container inside its deadline is held", async (t) => {
  const { backend, state } = await harness(t);
  seeded(state, "asg-2", "running", startMs / 1000 + 60);
  assert.deepEqual(await backend.held(), heldJobs("asg-2"));
});

test("a listing that failed throws rather than answering nothing held", async (t) => {
  const { backend, state } = await harness(t, { engine: "docker" });
  state.unreachable = true;
  await assert.rejects(
    backend.held(),
    /docker could not list this pool's containers: Cannot connect to the Docker daemon/u,
  );
});

test("a stop of an in-flight placement cancels its pull, and nothing is run", async (t) => {
  const { backend, state, log } = await harness(t);
  state.pull = () => new Promise(() => undefined);
  await backend.place(assignment(), "Job");
  await setImmediate();
  assert.deepEqual(await backend.stop("asg-1"), { stopped: "Stopped" });
  assert.deepEqual(backend.inFlight(), []);
  assert.deepEqual(await backend.held(), []);
  assert.ok(!verbs(state).includes("run"));
  assert.match(log.join("\n"), /was stopped before it started/u);
  assert.deepEqual(await backend.ended(), []);
});

test("a stop of a running container kills it, saves its logs, and removes it with its volumes", async (t) => {
  const { backend, state, settings, log } = await harness(t);
  const name = seeded(state, "asg-2", "running", startMs / 1000 + 60);
  assert.deepEqual(await backend.stop("asg-2"), { stopped: "Stopped" });
  assert.deepEqual(
    state.calls.map((call) => call.argv),
    [
      [
        "ps",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        "label=io.chuggy.pool=vteng/chuggy/shame",
        "--filter",
        "label=io.chuggy.assignment=asg-2",
      ],
      ["kill", "id-asg-2"],
      ["container", "inspect", "id-asg-2"],
      ["logs", "id-asg-2"],
      ["rm", "-v", "id-asg-2"],
    ],
  );
  const saved = join(settings.logDir, `${name}.log`);
  assert.equal(await readFile(saved, "utf8"), `the log of ${name}\n`);
  assert.equal((await stat(saved)).mode & 0o777, 0o600);
  assert.equal(state.containers.size, 0);
  assert.match(
    log.at(-1) ?? "",
    /was stopped; logs saved to .*, container removed$/u,
  );
  assert.deepEqual(await backend.stop("asg-2"), { stopped: "Stopped" });
});

test("a stop of a job that ended on its own just before saves its logs and removes it", async (t) => {
  const { backend, state, settings } = await harness(t);
  const name = seeded(state, "asg-2", "exited", startMs / 1000 + 60);
  assert.deepEqual(await backend.stop("asg-2"), { stopped: "Stopped" });
  assert.deepEqual(verbs(state), ["ps", "kill", "container", "logs", "rm"]);
  assert.equal(state.containers.size, 0);
  assert.equal(
    await readFile(join(settings.logDir, `${name}.log`), "utf8"),
    `the log of ${name}\n`,
  );
});

test("a stop whose logs could not be saved ends the job, and keeps its container for held to retire", async (t) => {
  const { backend, state, settings, log } = await harness(t);
  const name = seeded(state, "asg-2", "running", startMs / 1000 + 60);
  state.logsFail = true;
  assert.deepEqual(await backend.stop("asg-2"), { stopped: "Stopped" });
  assert.equal(state.containers.get(name)?.status, "exited");
  assert.ok(!verbs(state).includes("rm"));
  assert.match(log.at(-1) ?? "", /was stopped; its logs could not be saved$/u);

  state.logsFail = false;
  assert.deepEqual(await backend.held(), []);
  assert.equal(state.containers.size, 0);
  assert.equal(
    await readFile(join(settings.logDir, `${name}.log`), "utf8"),
    `the log of ${name}\n`,
  );
  assert.deepEqual(await backend.ended(), []);
});

test("a job still running after its kill is not stopped, and its container is left alone", async (t) => {
  const { backend, state } = await harness(t);
  const name = seeded(state, "asg-2", "running", startMs / 1000 + 60);
  state.killInterrupted = true;
  assert.deepEqual(await backend.stop("asg-2"), {
    stopped: "Unavailable",
    evidence: "the container engine could not be reached to stop this workload",
  });
  assert.deepEqual(verbs(state), ["ps", "kill", "container"]);
  assert.equal(state.containers.get(name)?.status, "running");
});

test("a stop the engine could not be reached for is unavailable", async (t) => {
  const { backend, state } = await harness(t);
  state.unreachable = true;
  assert.deepEqual(await backend.stop("asg-2"), {
    stopped: "Unavailable",
    evidence: "the container engine could not be reached to stop this workload",
  });
});

test("what this machine cannot take is refused, naming no value of the envelope", async (t) => {
  const { backend, state } = await harness(t);
  const refusals = [
    [assignment({ image: undefined }), /pins no image/u],
    [
      assignment({ cpuMillis: 8001 }),
      /8001 CPU millis and this machine has 8000/u,
    ],
    [assignment({ memoryMib: 16385 }), /16385 MiB and this machine has 16384/u],
    [
      assignment({ callbackUrl: "attempt-bearer-secret" }),
      /makes no envelope its container can read: callbackUrl$/u,
    ],
    [
      assignment({ bearer: "" }),
      /makes no envelope its container can read: bearer$/u,
    ],
  ];
  for (const [refused, evidence] of refusals) {
    const placed = await backend.place(/** @type {any} */ (refused), "Job");
    assert.equal(placed.placed, "Refused");
    assert.match(placed.evidence ?? "", evidence);
    assert.ok(!(placed.evidence ?? "").includes("attempt-bearer-secret"));
  }
  assert.deepEqual(state.calls, []);
});

test("an assignment is refused, and nothing run, while the runner says the Claude token file cannot be handed to a job", async (t) => {
  const { backend, state, settings, tokenFilesAsked, refuseTokenFile } =
    await harness(t);
  refuseTokenFile("the Claude token file is empty");
  assert.deepEqual(await backend.place(assignment(), "Job"), {
    placed: "Refused",
    evidence: "the Claude token file is empty",
  });
  assert.deepEqual(state.calls, []);
  assert.deepEqual(tokenFilesAsked, [settings.tokenFile]);
  refuseTokenFile(undefined);
  assert.equal((await backend.place(assignment(), "Job")).placed, "Placed");
  await backend.settled();
});

test("a job's deadline is the assignment's capped at the runner's, and a session's is its assignment's alone", async (t) => {
  const { backend, state } = await harness(t, { timeoutSecsMax: 600 });
  state.images.add(image);
  await backend.place(assignment(), "Job");
  await backend.place(assignment({ assignment: "ses-1" }), "Session");
  await backend.settled();
  assert.deepEqual(
    [...state.containers.values()]
      .map((container) => [
        container.labels["io.chuggy.assignment"],
        container.labels["io.chuggy.deadline"],
      ])
      .sort(),
    [
      ["asg-1", String(startMs / 1000 + 600)],
      ["ses-1", String(startMs / 1000 + 3600)],
    ],
  );
});

/**
 * The argv a `run` was made with and the envelope its env file carried.
 *
 * @param {ReturnType<typeof fakeEngine>["state"]} state
 * @param {string} assignmentId
 */
function ranWith(state, assignmentId) {
  const run = state.calls.find(
    (call) =>
      call.argv[0] === "run" &&
      call.argv.includes(`io.chuggy.assignment=${assignmentId}`),
  );
  const [task] = (run?.envFile ?? "").split("\n");
  return {
    argv: run?.argv ?? [],
    envelope: JSON.parse(task.replace(/^CHUG_WORKER_TASK=/u, "")),
  };
}

test("a session's container is run as a job's is, labelled a session, its envelope bounded by its own deadline", async (t) => {
  const { backend, state } = await harness(t);
  state.images.add(image);
  await backend.place(assignment(), "Job");
  await backend.place(
    assignment({ assignment: "ses-1", bearer: "session-bearer-secret" }),
    "Session",
  );
  await backend.settled();
  const job = ranWith(state, "asg-1");
  const session = ranWith(state, "ses-1");
  const envFileAt = job.argv.indexOf("--env-file") + 1;
  assert.deepEqual(
    session.argv,
    job.argv.map((argument, index) => {
      if (index === envFileAt) return session.argv[index];
      if (argument === containerName(pool, "asg-1"))
        return containerName(pool, "ses-1");
      return (
        {
          "io.chuggy.assignment=asg-1": "io.chuggy.assignment=ses-1",
          "io.chuggy.kind=Job": "io.chuggy.kind=Session",
        }[argument] ?? argument
      );
    }),
  );
  assert.ok(job.argv.includes("io.chuggy.kind=Job"));
  assert.deepEqual(session.envelope, {
    ...job.envelope,
    bearer: "session-bearer-secret",
    timeoutSecsMax: 3600,
  });
  assert.equal(job.envelope.timeoutSecsMax, 7200);
});

test("held and ended name each workload by the kind it was placed as, and a container labelled with none as a job", async (t) => {
  const { backend, state } = await harness(t);
  const pull = deferred();
  state.pull = () => pull.promise;
  await backend.place(assignment({ assignment: "ses-placing" }), "Session");
  await setImmediate();
  assert.deepEqual(
    backend.inFlight().map(({ assignment, kind }) => [assignment, kind]),
    [["ses-placing", "Session"]],
  );
  seeded(
    state,
    "ses-running",
    "running",
    startMs / 1000 + 60,
    undefined,
    "Session",
  );
  seeded(
    state,
    "asg-running",
    "running",
    startMs / 1000 + 60,
    undefined,
    "Job",
  );
  seeded(state, "asg-unlabelled", "running", startMs / 1000 + 60);
  seeded(
    state,
    "ses-done",
    "exited",
    startMs / 1000 + 60,
    undefined,
    "Session",
  );
  seeded(state, "asg-done", "exited", startMs / 1000 + 60);
  for (const container of state.containers.values())
    if (container.status === "exited") container.exitCode = 0;
  assert.deepEqual(await backend.held(), [
    { assignment: "ses-placing", kind: "Session" },
    { assignment: "ses-running", kind: "Session" },
    { assignment: "asg-running", kind: "Job" },
    { assignment: "asg-unlabelled", kind: "Job" },
  ]);
  assert.deepEqual(await backend.ended(), [
    {
      kind: "Session",
      session: seededAttempt("ses-done"),
      phase: "Succeeded",
    },
    {
      kind: "Job",
      job: seededAttempt("asg-done"),
      why: "its container exited with status 0",
    },
  ]);
  pull.resolve({ code: 1, stdout: "", stderr: "Error: manifest unknown\n" });
  await backend.settled();
});

for (const [end, status, exitCode, phase] of [
  ["exited 0", "exited", 0, "Succeeded"],
  ["stopped 0", "stopped", 0, "Succeeded"],
  ["exited 1", "exited", 1, "Failed"],
  ["killed", "exited", 137, "Failed"],
  ["exited with no status", "exited", undefined, "Failed"],
  ["left dead", "dead", 0, "Failed"],
  ["left created", "created", 0, "Failed"],
])
  test(`a session whose container ${end} ended ${phase}`, async (t) => {
    const { backend, state } = await harness(t);
    const name = seeded(
      state,
      "ses-1",
      status,
      startMs / 1000 + 60,
      undefined,
      "Session",
    );
    const container =
      /** @type {import("./engine.fixture.mjs").FakeContainer} */ (
        state.containers.get(name)
      );
    container.exitCode = exitCode;
    assert.deepEqual(await backend.held(), []);
    assert.deepEqual(await backend.ended(), [
      { kind: "Session", session: seededAttempt("ses-1"), phase },
    ]);
  });

test("a session killed at its deadline, or whose placement failed, ended Failed", async (t) => {
  const { backend, state, clock } = await harness(t);
  seeded(
    state,
    "ses-late",
    "running",
    startMs / 1000 + 10,
    undefined,
    "Session",
  );
  state.pull = () => ({
    code: 1,
    stdout: "",
    stderr: "Error response from daemon: manifest unknown\n",
  });
  await backend.place(
    assignment({
      assignment: "ses-unpulled",
      bearer: "bearer-of-ses-unpulled",
    }),
    "Session",
  );
  await backend.settled();
  clock.nowMs += 10_000;
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(await backend.ended(), [
    { kind: "Session", session: seededAttempt("ses-late"), phase: "Failed" },
    {
      kind: "Session",
      session: seededAttempt("ses-unpulled"),
      phase: "Failed",
    },
  ]);
});

test("a session is stopped by its assignment as a job is, and its end is never named, though its placement had failed", async (t) => {
  const { backend, state } = await harness(t);
  const name = seeded(
    state,
    "ses-1",
    "running",
    startMs / 1000 + 60,
    undefined,
    "Session",
  );
  state.pull = () => ({ code: 1, stdout: "", stderr: "manifest unknown\n" });
  await backend.place(assignment({ assignment: "ses-2" }), "Session");
  await backend.settled();
  assert.deepEqual(await backend.stop("ses-1"), { stopped: "Stopped" });
  assert.deepEqual(await backend.stop("ses-2"), { stopped: "Stopped" });
  assert.equal(state.containers.has(name), false);
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(await backend.ended(), []);
});

test("an assignment placed as no kind the loop names is thrown before anything is asked of the engine", async (t) => {
  const { backend, state } = await harness(t);
  for (const kind of [undefined, "job", "Work"])
    await assert.rejects(
      backend.place(assignment(), /** @type {any} */ (kind)),
      {
        name: "TypeError",
        message: `an assignment was placed as ${String(kind)}, which is no workload's kind`,
      },
    );
  assert.deepEqual(state.calls, []);
  assert.deepEqual(backend.inFlight(), []);
});

test("a personal runner's containers are named and labelled by its tenant and owner, and a pool's of its tenant are not its own", async (t) => {
  const personal = {
    kind: /** @type {const} */ ("Personal"),
    tenant: "vteng",
    owner: "28:https://auth.chuggy.example/geoff",
  };
  const { backend, state } = await harness(t, { pool: personal });
  const poolName = seeded(state, "asg-2", "running", startMs / 1000 + 60);
  state.images.add(image);
  await backend.place(assignment(), "Job");
  await backend.settled();
  const name = containerName(personal, "asg-1");
  assert.match(name, /^chuggy-personal-[0-9a-f]{20}$/u);
  assert.equal(
    state.containers.get(name)?.labels["io.chuggy.pool"],
    "vteng/28:https:%2F%2Fauth.chuggy.example%2Fgeoff",
  );
  assert.deepEqual(await backend.held(), heldJobs("asg-1"));
  assert.deepEqual(await backend.stop("asg-2"), { stopped: "Stopped" });
  assert.equal(state.containers.get(poolName)?.status, "running");
});

test("a pool whose name cannot name a container is refused, and a personal runner, which names none, is not", () => {
  assert.throws(
    () => containerBackendSettingsChecked({ ...pool, pool: "a b" }),
    /pool a b cannot name a container/u,
  );
  const personal = {
    kind: /** @type {const} */ ("Personal"),
    tenant: "vteng",
    owner: "a b",
  };
  assert.equal(containerBackendSettingsChecked(personal).pool, personal);
});

/** @param {import("./poolIdentity.mjs").PoolIdentity} identity */
function containerBackendSettingsChecked(identity) {
  return checkedContainerBackendSettings(
    /** @type {import("./containerBackend.mjs").ContainerBackendSettings} */ ({
      pool: identity,
    }),
  );
}
