import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import {
  mintedCredentialDirectory,
  workerImageFaults,
  workerImageFaultStatuses,
  workerRuntimeDirectory,
  workerWorkspaceDirectory,
} from "@chuggy/worker-contract/workerEnvironment";

import {
  checkedContainerBackendSettings,
  containerBackend,
  containerImageOf,
  containerImageFaultTexts,
  containerName,
  ownerVolumesSchema,
  pullFailureDwellMs,
} from "./containerBackend.mjs";
import {
  deferred,
  fakeEngine,
  unstartedEntrypoint,
} from "./engine.fixture.mjs";
import { ownerVolumeCreateArgv, ownerVolumesOpenArgv } from "./engineArgv.mjs";
import {
  jobEngineSocket,
  jobEnvelope,
  jobProviderCredentialFile,
  jobRunDirectory,
} from "./job.mjs";

const pool = { tenant: "vteng", project: "chuggy", pool: "shame" };
const image = "registry.chuggy.example/worker@sha256:" + "a".repeat(64);
const runtime = `registry.chuggy.example/runtime@sha256:${"c".repeat(64)}`;
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

test("a job that pins no image runs in the first image its owner listed declaring every capability it names but its platform", async (t) => {
  const xcode = "registry.example/owner/xcode:16";
  const bazel = "registry.example/owner/bazel:7";
  const { backend, state } = await harness(t, {
    images: [
      { image: bazel, capabilities: ["Tool:Bazel"] },
      { image: xcode, capabilities: ["Agent:Claude", "Tool:Xcode"] },
      { image, capabilities: ["Agent:Claude", "Tool:Xcode", "Cache:Warm"] },
    ],
  });
  state.images.add(xcode);
  await backend.place(
    assignment({
      image: undefined,
      capabilities: ["Platform:Linux:Amd64", "Agent:Claude", "Tool:Xcode"],
    }),
    "Job",
  );
  await backend.settled();
  const run = state.calls.find((call) => call.argv[0] === "run");
  assert.ok(run?.argv.includes(xcode), JSON.stringify(run?.argv));
  assert.deepEqual(
    await backend.place(
      assignment({
        assignment: "asg-2",
        image: undefined,
        capabilities: ["Platform:Linux:Amd64", "Agent:Codex"],
      }),
      "Job",
    ),
    {
      placed: "Refused",
      evidence:
        "the assignment pins no image, and no image this pool's owner listed meets it: a Linux one declaring every capability it names",
    },
  );
});

test("an image an assignment pins is the one it runs, whatever its owner listed, and an owner's runs only Linux work", () => {
  const listed = [{ image: "registry.example/owner/any", capabilities: [] }];
  assert.equal(
    containerImageOf(listed, { image, capabilities: ["Platform:Linux:Amd64"] }),
    image,
  );
  assert.equal(
    containerImageOf(listed, {
      image: undefined,
      capabilities: ["Platform:Linux:Arm64"],
    }),
    "registry.example/owner/any",
  );
  assert.equal(
    containerImageOf([], { image: undefined, capabilities: [] }),
    undefined,
  );
  assert.equal(
    containerImageOf(listed, {
      image: undefined,
      capabilities: ["Platform:MacOS:Arm64"],
    }),
    undefined,
  );
});

/**
 * What a runner's settings print of these owner volumes' refusals, each
 * issue's path and message.
 *
 * @param {unknown[]} volumes
 */
function ownerVolumesRefused(volumes) {
  const parsed = ownerVolumesSchema.safeParse(volumes);
  return parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) => `${issue.path.join(".")} ${issue.message}`,
      );
}

/** @param {string} target */
const mountedAt = (target) => [{ source: "cargo", target }];

/** What `ownerVolumesSchema` says of a target not in its normal form. */
const abnormalTarget =
  "0.target must be an absolute path in its normal form, with no '.' or '..' and no doubled or trailing '/'";

/**
 * A path under `/var/run` as an image that links `/var/run` to `/run` also
 * reaches it, or nothing for any other.
 *
 * @param {string} path
 */
const runLinked = (path) =>
  path.startsWith("/var/run/") ? [path.replace(/^\/var\/run/u, "/run")] : [];

test("an owner's volume is refused at, in, and above each path chuggy mounts or keeps in a job's container, each under /var/run also under /run, and at each written otherwise", () => {
  const paths = [
    workerRuntimeDirectory,
    workerWorkspaceDirectory,
    mintedCredentialDirectory,
    jobRunDirectory,
    jobProviderCredentialFile,
    jobEngineSocket,
  ];
  for (const path of paths.flatMap((path) => [path, ...runLinked(path)])) {
    assert.deepEqual(ownerVolumesRefused(mountedAt(path)), [
      `0.target is ${path}, chuggy's own`,
    ]);
    assert.deepEqual(ownerVolumesRefused(mountedAt(`${path}/cache`)), [
      `0.target is in ${path}, chuggy's own`,
    ]);
    const [above] = ownerVolumesRefused(mountedAt(dirname(path)));
    assert.match(
      above ?? "",
      /^0\.target (?:(?:holds|is(?: in)?) \/\S+, chuggy's own|may not be the container's root)$/u,
      path,
    );
    for (const written of [`${path}/`, `/${path}`, `/cache/..${path}`])
      assert.deepEqual(ownerVolumesRefused(mountedAt(written)), [
        abnormalTarget,
      ]);
  }
  assert.match(
    ownerVolumesRefused(mountedAt("/run"))[0] ?? "",
    /^0\.target holds \/run\/\S+, chuggy's own$/u,
  );
  assert.deepEqual(ownerVolumesRefused(mountedAt("/run/cache")), []);
});

test("an owner's volume is refused at the container's root, a relative or abnormal path, or one no mount can name", () => {
  assert.deepEqual(ownerVolumesRefused(mountedAt("/")), [
    "0.target may not be the container's root",
  ]);
  for (const target of [
    "cache",
    "./cache",
    "",
    "/cache/",
    "//cache",
    "/cache//cargo",
    "/cache/./cargo",
    "/cache/../cargo",
  ])
    assert.deepEqual(ownerVolumesRefused(mountedAt(target)), [abnormalTarget]);
  for (const target of [
    "/cache:cargo",
    "/cache,cargo",
    "/cache\ncargo",
    "/cache\rcargo",
  ])
    assert.deepEqual(ownerVolumesRefused(mountedAt(target)), [
      "0.target cannot be named in a mount: it has a comma, a colon or a line break",
    ]);
  assert.deepEqual(ownerVolumesRefused(mountedAt("/home/runner/.cargo")), []);
});

test("two owner's volumes mounted at one target are refused, the later named", () => {
  assert.deepEqual(
    ownerVolumesRefused([
      { source: "cargo", target: "/cache/cargo" },
      { source: "npm-cache", target: "/cache/npm" },
      { source: "/srv/cargo", target: "/cache/cargo" },
    ]),
    ["2.target is volume 0's target too"],
  );
});

test("an owner's volume is a named volume by a name both engines give one, or a directory by an absolute path a bind mount can name", () => {
  const sourced = (source) =>
    ownerVolumesRefused([{ source, target: "/cache/cargo" }]);
  for (const source of ["cargo", "npm.cache-2", "/srv/cargo", "/srv/a b"])
    assert.deepEqual(sourced(source), [], source);
  for (const source of [
    "c",
    "-cargo",
    "cargo cache",
    "cargo:cache",
    "srv/cargo",
    "./cargo",
  ])
    assert.deepEqual(
      sourced(source),
      [
        "0.source names neither a volume, by two or more letters, digits, '_', '.' and '-' from a letter or digit, nor a directory by its absolute path",
      ],
      source,
    );
  for (const source of ["/srv/a,b", "/srv/a\nb", "/srv/a\rb"])
    assert.deepEqual(sourced(source), [
      "0.source cannot be named in a bind mount: it has a comma or a line break",
    ]);
  assert.deepEqual(
    ownerVolumesSchema.parse([{ source: "cargo", target: "/cache/cargo" }]),
    [{ source: "cargo", target: "/cache/cargo", readonly: false }],
  );
  assert.equal(
    ownerVolumesRefused([
      { source: "cargo", target: "/cache/cargo", type: "volume" },
    ]).length,
    1,
  );
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
  assert.deepEqual(verbs(state), [
    "ps",
    "container",
    "volume",
    "kill",
    "logs",
    "rm",
  ]);
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
    [
      assignment({ image: undefined }),
      /pins no image, and no image this pool's owner listed meets it/u,
    ],
    [assignment({ image: undefined, runtime }), /pins no image/u],
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
 * The argv a `run` was made with, its env file's text and the envelope that
 * text carried.
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
  const envFile = run?.envFile ?? "";
  const [task] = envFile.split("\n");
  return {
    argv: run?.argv ?? [],
    envFile,
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

/**
 * A run's argv without its env file's path, which is its placement's own.
 *
 * @param {string[]} argv
 */
const envFileUnnamed = (argv) =>
  argv.filter((_, index) => argv[index - 1] !== "--env-file");

/**
 * Checks that a backend whose runner hands its jobs this machine's engine
 * through `socket` runs a job as one handed none is run, with the socket's
 * mount and then `group` after its token file's mount and `variables` after
 * its environment, and runs a session exactly as one is run handed none.
 *
 * @param {import("node:test").TestContext} t
 * @param {"docker" | "podman"} engine
 * @param {import("./engineArgv.mjs").EngineSocket} socket
 * @param {string[]} group
 * @param {string} variables the env file's lines after the runner's environment
 */
async function assertJobsHandedEngineSocket(
  t,
  engine,
  socket,
  group,
  variables,
) {
  const without = await harness(t, { engine });
  const handed = await harness(t, {
    engine,
    tokenFile: without.settings.tokenFile,
    engineSocket: socket,
  });
  for (const { backend, state } of [without, handed]) {
    state.images.add(image);
    await backend.place(assignment(), "Job");
    await backend.place(assignment({ assignment: "ses-1" }), "Session");
    await backend.settled();
  }
  const job = ranWith(without.state, "asg-1");
  const tmpfs = job.argv.indexOf("--tmpfs");
  const handedJob = ranWith(handed.state, "asg-1");
  assert.deepEqual(
    envFileUnnamed(handedJob.argv),
    envFileUnnamed([
      ...job.argv.slice(0, tmpfs),
      "--mount",
      `type=bind,source=${socket.path},target=/var/run/docker.sock,readonly`,
      ...group,
      ...job.argv.slice(tmpfs),
    ]),
  );
  assert.equal(handedJob.envFile, `${job.envFile}${variables}`);
  const session = ranWith(without.state, "ses-1");
  const handedSession = ranWith(handed.state, "ses-1");
  assert.deepEqual(
    envFileUnnamed(handedSession.argv),
    envFileUnnamed(session.argv),
  );
  assert.equal(handedSession.envFile, session.envFile);
}

test("a docker job is handed the engine's socket read-only, the socket's group, and where the socket is in its container and on this machine, and a session is handed none of it", async (t) => {
  await assertJobsHandedEngineSocket(
    t,
    "docker",
    { path: "/var/run/docker.sock", gid: 125 },
    ["--group-add", "125"],
    "DOCKER_HOST=unix:///var/run/docker.sock\nTESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock\n",
  );
});

test("a podman job is handed the engine's socket read-only with no group, where the socket is in its container and on this machine, and where what it starts is reached, and a session is handed none of it", async (t) => {
  await assertJobsHandedEngineSocket(
    t,
    "podman",
    { path: "/run/user/1000/podman/podman.sock", gid: 1000 },
    [],
    "DOCKER_HOST=unix:///var/run/docker.sock\nTESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/run/user/1000/podman/podman.sock\nTESTCONTAINERS_HOST_OVERRIDE=host.containers.internal\n",
  );
});

test("a job's variables of the engine are the backend's, whatever the runner's environment says", async (t) => {
  const { backend, state } = await harness(t, {
    environment: {
      DOCKER_HOST: "tcp://elsewhere:2375",
      TESTCONTAINERS_HOST_OVERRIDE: "elsewhere",
    },
    engineSocket: { path: "/run/user/1000/podman/podman.sock", gid: 1000 },
  });
  state.images.add(image);
  await backend.place(assignment(), "Job");
  await backend.settled();
  assert.deepEqual(
    ranWith(state, "asg-1")
      .envFile.split("\n")
      .filter((line) => /^(DOCKER|TESTCONTAINERS)_/u.test(line)),
    [
      "DOCKER_HOST=unix:///var/run/docker.sock",
      "TESTCONTAINERS_HOST_OVERRIDE=host.containers.internal",
      "TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/run/user/1000/podman/podman.sock",
    ],
  );
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

/** The job attempt `assignment()` holds, as an end names it. */
const heldAttempt = {
  assignment: "asg-1",
  callbackUrl: "https://chuggy.example/worker",
  bearer: "attempt-bearer-secret",
};

/** @param {string} stderr */
const failedWith = (stderr, code = 1) => ({
  code,
  stdout: "",
  stderr: `${stderr}\n`,
});

/**
 * A job placed through chuggy's runtime, each image already here, run until
 * its container is started or its placement has failed.
 *
 * @param {Awaited<ReturnType<typeof harness>>} context
 */
async function placedThroughRuntime({ backend, state }) {
  state.images.add(image);
  state.images.add(runtime);
  await backend.place(assignment({ runtime }), "Job");
  await backend.settled();
  return state.containers.get(containerName(pool, "asg-1"));
}

/**
 * What the pool names once `held` has read every end.
 *
 * @param {Awaited<ReturnType<typeof harness>>["backend"]} backend
 */
async function endsNamed(backend) {
  await backend.held();
  return backend.ended();
}

test("a job given a runtime starts through its own copy of it, mounted read-only, with the runtime's check as its command", async (t) => {
  const context = await harness(t);
  const { state } = context;
  state.pull = (pulled) => {
    state.images.add(pulled);
    return { code: 0, stdout: "", stderr: "" };
  };
  await context.backend.place(assignment({ runtime }), "Job");
  await context.backend.settled();
  const pulls = state.calls.filter((call) => call.argv[0] === "pull");
  assert.deepEqual(
    pulls.map((call) => call.argv.at(-1)),
    [runtime, image],
  );
  const [volume, workspace, ...others] = state.volumes.keys();
  assert.deepEqual(others, []);
  const stem = `${containerName(pool, "asg-1")}-[0-9a-f]+`;
  assert.match(volume, new RegExp(`^${stem}-runtime$`, "u"));
  assert.match(workspace, new RegExp(`^${stem}-workspace$`, "u"));
  const fill = volume.replace(/-runtime$/u, "-fill");
  const filling = state.calls.find((call) => call.argv.includes("--rm"));
  assert.ok(filling?.argv.join(" ").includes(`--name ${fill} `));
  assert.ok(!state.containers.has(fill));
  const labels = {
    "io.chuggy.pool": "vteng/chuggy/shame",
    "io.chuggy.assignment": "asg-1",
    "io.chuggy.fill": fill,
  };
  assert.deepEqual(state.volumes.get(volume), { labels, filledFrom: runtime });
  assert.deepEqual(state.volumes.get(workspace), { labels });
  const container = state.containers.get(containerName(pool, "asg-1"));
  assert.equal(container?.labels["io.chuggy.runtime"], volume);
  assert.equal(container?.labels["io.chuggy.workspace"], workspace);
  assert.ok(container?.volumes?.includes(`${volume}:/opt/chuggy:ro,nocopy`));
  assert.ok(container?.volumes?.includes(`${workspace}:/workspace:nocopy,U`));
  assert.equal(container?.entrypoint, "/bin/sh");
  assert.deepEqual(container?.command, ["/opt/chuggy/check.sh"]);
  const run = state.calls.find((call) => call.argv.includes("-d"));
  assert.match(run?.envFile ?? "", /^CHUG_WORKER_WORKSPACE=\/workspace$/mu);
  assert.deepEqual(await context.backend.held(), heldJobs("asg-1"));
});

test("a runtime job's workspace variable is the workspace its envelope names, whatever the runner's environment says", async (t) => {
  const { backend, state } = await harness(t, {
    environment: { CHUG_WORKER_WORKSPACE: "/elsewhere" },
  });
  state.images.add(image);
  state.images.add(runtime);
  await backend.place(assignment({ runtime }), "Job");
  await backend.settled();
  const run = state.calls.find((call) => call.argv.includes("-d"));
  assert.deepEqual(
    (run?.envFile ?? "")
      .split("\n")
      .filter((line) => line.startsWith("CHUG_WORKER_WORKSPACE=")),
    ["CHUG_WORKER_WORKSPACE=/workspace"],
  );
});

test("a job given no runtime, and a session whatever it is given, runs its image's own entrypoint with nothing of a runtime", async (t) => {
  const { backend, state } = await harness(t);
  state.images.add(image);
  state.images.add(runtime);
  await backend.place(assignment(), "Job");
  await backend.place(assignment({ assignment: "asg-2", runtime }), "Session");
  await backend.settled();
  assert.deepEqual(verbs(state).sort(), ["image", "image", "run", "run"]);
  assert.equal(state.volumes.size, 0);
  for (const container of state.containers.values()) {
    assert.equal(container.entrypoint, undefined);
    assert.deepEqual(container.command, []);
    assert.equal(container.labels["io.chuggy.runtime"], undefined);
  }
  for (const call of state.calls.filter(({ argv }) => argv[0] === "run"))
    assert.doesNotMatch(call.envFile ?? "", /CHUG_WORKER_WORKSPACE/u);
});

test("every fault of the contract has its text, and each the runtime's check exits with refuses the job with it, its volume removed with its container", async (t) => {
  assert.deepEqual(
    Object.keys(containerImageFaultTexts).sort(),
    [...workerImageFaults].sort(),
  );
  for (const [fault, status] of Object.entries(workerImageFaultStatuses)) {
    const context = await harness(t);
    const container = await placedThroughRuntime(context);
    assert.ok(container !== undefined);
    container.status = "exited";
    container.exitCode = status;
    assert.deepEqual(await endsNamed(context.backend), [
      {
        kind: "Job",
        job: heldAttempt,
        why: containerImageFaultTexts[
          /** @type {keyof typeof containerImageFaultTexts} */ (fault)
        ],
        refusal: { fault },
      },
    ]);
    assert.equal(context.state.containers.size, 0);
    assert.equal(context.state.volumes.size, 0, fault);
  }
});

test("a job started through a runtime that exited otherwise, or one started without that exited with a check's status, ended as any job does", async (t) => {
  const through = await harness(t);
  const container = await placedThroughRuntime(through);
  assert.ok(container !== undefined);
  container.status = "exited";
  container.exitCode = 1;
  assert.deepEqual(await endsNamed(through.backend), [
    {
      kind: "Job",
      job: heldAttempt,
      why: "its container exited with status 1",
    },
  ]);
  assert.equal(through.state.volumes.size, 0);

  const without = await harness(t);
  without.state.images.add(image);
  await without.backend.place(assignment(), "Job");
  await without.backend.settled();
  const [plain] = without.state.containers.values();
  plain.status = "exited";
  plain.exitCode = workerImageFaultStatuses.ImageLacksGit;
  assert.deepEqual(await endsNamed(without.backend), [
    {
      kind: "Job",
      job: heldAttempt,
      why: `its container exited with status ${String(workerImageFaultStatuses.ImageLacksGit)}`,
    },
  ]);
});

test("a job whose image has no shell to start the runtime's check is refused ImageLacksShell, its container and volume removed", async (t) => {
  const context = await harness(t);
  context.state.shellless.add(image);
  assert.equal(await placedThroughRuntime(context), undefined);
  assert.equal(context.state.volumes.size, 0);
  const said = unstartedEntrypoint("/bin/sh").stderr.trim();
  assert.deepEqual(await endsNamed(context.backend), [
    {
      kind: "Job",
      job: heldAttempt,
      why: `${containerImageFaultTexts.ImageLacksShell} The engine said: ${said}`,
      refusal: { fault: "ImageLacksShell" },
    },
  ]);
});

test("a run that answers as an unstarted shell does is no fault of a job given no runtime", async (t) => {
  const { backend, state } = await harness(t);
  state.images.add(image);
  state.intercept = (call) =>
    call.argv[0] === "run" ? unstartedEntrypoint("/bin/sh") : undefined;
  await backend.place(assignment(), "Job");
  await backend.settled();
  const [ended] = await endsNamed(backend);
  assert.equal(ended?.kind === "Job" && ended.refusal, undefined);
  assert.match(
    ended?.kind === "Job" ? ended.why : "",
    /^its container was not started: its container could not be run: /u,
  );
});

test("a job whose unstarted container could not be removed is left to the container's own end", async (t) => {
  const context = await harness(t);
  context.state.shellless.add(image);
  context.state.intercept = (call) =>
    call.argv[0] === "rm"
      ? failedWith(
          "Error response from daemon: removal of container is already in progress",
        )
      : undefined;
  const container = await placedThroughRuntime(context);
  assert.equal(container?.status, "created");
  context.state.intercept = () => undefined;
  assert.deepEqual(await endsNamed(context.backend), [
    { kind: "Job", job: heldAttempt, why: "its container was left created" },
  ]);
  assert.equal(context.state.volumes.size, 0);
});

test("a runner that cannot get the runtime, or cannot copy it, fails the placement as any that did not start, runs nothing and keeps no volume", async (t) => {
  /** @type {[string, (state: Awaited<ReturnType<typeof harness>>["state"]) => void, RegExp][]} */
  const cases = [
    [
      "pulled",
      (state) => {
        state.images.delete(runtime);
        state.pull = () =>
          failedWith(
            `Error response from daemon: manifest for ${runtime} not found: manifest unknown: manifest unknown`,
          );
      },
      /^its container was not started: this runner could not get chuggy's runtime \S+: the runtime could not be pulled: Error response from daemon: manifest for /u,
    ],
    [
      "made",
      (state) => {
        state.intercept = (call) =>
          call.argv[0] === "volume" && call.argv[1] === "create"
            ? failedWith("Error response from daemon: no space left on device")
            : undefined;
      },
      /^its container was not started: this runner could not copy chuggy's runtime \S+: its volume \S+-runtime could not be made: .*no space left/u,
    ],
    [
      "filled",
      (state) => {
        state.fill = () =>
          failedWith(
            'docker: Error response from daemon: failed to create task for container: exec: "/opt/chuggy/bin/node": stat /opt/chuggy/bin/node: no such file or directory: unknown',
            127,
          );
      },
      /^its container was not started: this runner could not copy chuggy's runtime \S+: its volumes could not be filled: .*\/opt\/chuggy\/bin\/node/u,
    ],
  ];
  for (const [what, arrange, why] of cases) {
    const context = await harness(t);
    context.state.images.add(image);
    context.state.images.add(runtime);
    arrange(context.state);
    await context.backend.place(assignment({ runtime }), "Job");
    await context.backend.settled();
    assert.equal(context.state.containers.size, 0, what);
    assert.equal(context.state.volumes.size, 0, what);
    const ends = await endsNamed(context.backend);
    assert.equal(ends.length, 1, what);
    const [ended] = ends;
    assert.ok(ended.kind === "Job");
    assert.equal(ended.refusal, undefined, what);
    assert.match(ended.why, why, what);
    assert.match(
      context.log.join("\n"),
      /was not started: this runner could not/u,
    );
  }
});

test("a job's image the registry refused through a runtime is refused ImageUnpullable at once", async (t) => {
  const { backend, state } = await harness(t);
  state.images.add(runtime);
  const said = `Error response from daemon: manifest for ${image} not found: manifest unknown: manifest unknown`;
  state.pull = () => failedWith(said);
  await backend.place(assignment({ runtime }), "Job");
  await backend.settled();
  assert.equal(verbs(state).filter((verb) => verb === "pull").length, 1);
  assert.deepEqual(await endsNamed(backend), [
    {
      kind: "Job",
      job: heldAttempt,
      why: `${containerImageFaultTexts.ImageUnpullable} The engine said: ${said}`,
      refusal: { fault: "ImageUnpullable" },
    },
  ]);
  assert.ok(!state.calls.some(({ argv }) => argv.includes("create")));
});

test("a job's image whose reference names none through a runtime is refused ImageUnpullable at its inspection, and one whose inspection failed otherwise fails as any placement does", async (t) => {
  /** @type {[string, Record<string, unknown> | undefined][]} */
  const cases = [
    [
      "Error response from daemon: invalid reference format: repository name (Upper) must be lowercase",
      { fault: "ImageUnpullable" },
    ],
    ["Error response from daemon: i/o timeout", undefined],
  ];
  for (const [said, refusal] of cases) {
    const { backend, state } = await harness(t);
    state.images.add(runtime);
    state.intercept = (call) =>
      call.argv[0] === "image" && call.argv.at(-1) === image
        ? failedWith(said)
        : undefined;
    await backend.place(assignment({ runtime }), "Job");
    await backend.settled();
    assert.ok(!verbs(state).includes("pull"), said);
    const [ended] = await endsNamed(backend);
    assert.ok(ended?.kind === "Job");
    assert.deepEqual(ended.refusal, refusal, said);
    assert.ok(ended.why.endsWith(said), ended.why);
  }
});

test("a job's image whose pull can still pass is pulled again through a runtime, until it is here or the dwell since its first pull has passed", async (t) => {
  const said =
    'Error response from daemon: Get "https://registry.chuggy.example/v2/": dial tcp: lookup registry.chuggy.example on 127.0.0.53:53: no such host';
  const failing = await harness(t);
  failing.state.images.add(runtime);
  failing.state.pull = () => failedWith(said);
  await failing.backend.place(assignment({ runtime }), "Job");
  await failing.backend.settled();
  assert.equal(failing.clock.nowMs - startMs, pullFailureDwellMs);
  assert.equal(
    verbs(failing.state).filter((verb) => verb === "pull").length,
    pullFailureDwellMs / failing.settings.pullRetryMs + 1,
  );
  const [ended] = await endsNamed(failing.backend);
  assert.ok(ended?.kind === "Job");
  assert.deepEqual(ended.refusal, { fault: "ImageUnpullable" });

  const passing = await harness(t);
  passing.state.images.add(runtime);
  let pulls = 0;
  passing.state.pull = (pulled) => {
    pulls += 1;
    if (pulls < 3) return failedWith(said);
    passing.state.images.add(pulled);
    return { code: 0, stdout: "", stderr: "" };
  };
  await passing.backend.place(assignment({ runtime }), "Job");
  await passing.backend.settled();
  assert.deepEqual(await passing.backend.held(), heldJobs("asg-1"));
  assert.match(
    passing.log.join("\n"),
    /its image could not be pulled yet, and is pulled again: .*no such host/u,
  );
});

test("a runtime slow to pull takes none of the dwell its job's image is pulled again in", async (t) => {
  const { backend, state, clock } = await harness(t);
  let failures = 0;
  state.pull = (pulled) => {
    if (pulled === runtime) clock.nowMs += pullFailureDwellMs;
    else if (failures++ === 0)
      return failedWith(
        'Error response from daemon: Get "https://registry.chuggy.example/v2/": net/http: TLS handshake timeout',
      );
    state.images.add(pulled);
    return { code: 0, stdout: "", stderr: "" };
  };
  await backend.place(assignment({ runtime }), "Job");
  await backend.settled();
  assert.equal(failures, 2);
  assert.deepEqual(await backend.held(), heldJobs("asg-1"));
});

test("a job's image whose engine could not be reached through a runtime fails as any placement does", async (t) => {
  const { backend, state } = await harness(t);
  state.images.add(runtime);
  state.pull = () => ({
    code: -1,
    stdout: "",
    stderr: "",
    failed: /** @type {const} */ ("Interrupted"),
  });
  await backend.place(assignment({ runtime }), "Job");
  await backend.settled();
  const [ended] = await endsNamed(backend);
  assert.ok(ended?.kind === "Job");
  assert.equal(ended.refusal, undefined);
  assert.match(
    ended.why,
    /^its container was not started: its image could not be pulled/u,
  );
});

/**
 * Waits until the engine has been made a call, failing the test where it
 * never is.
 *
 * @param {Awaited<ReturnType<typeof harness>>["state"]} state
 * @param {(call: import("./engine.fixture.mjs").FakeCall) => boolean} wanted
 */
async function calledFor(state, wanted) {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (state.calls.some(wanted)) return;
    await setImmediate();
  }
  assert.fail("the engine was never made the call awaited");
}

/**
 * The container filling a placement's volumes, once the suite's `fill` holds it.
 *
 * @param {Awaited<ReturnType<typeof harness>>["state"]} state
 */
async function fillHeld(state) {
  await calledFor(state, (call) => call.argv.includes("--rm"));
  const [volume] = state.volumes.keys();
  return volume.replace(/-runtime$/u, "-fill");
}

/**
 * Whether the container filling a placement's volumes was removed before any
 * of them.
 *
 * @param {Awaited<ReturnType<typeof harness>>["state"]} state
 * @param {string} fill
 */
function fillRemovedFirst(state, fill) {
  const removals = state.calls.flatMap(({ argv }) =>
    argv.includes("--force") && argv.at(-1) === fill
      ? ["fill"]
      : argv[0] === "volume" && argv[1] === "rm"
        ? ["volume"]
        : [],
  );
  return removals[0] === "fill" && removals[1] === "volume";
}

test("a stop while the runtime is copied removes the container copying it, then the copy, and names no end", async (t) => {
  const { backend, state, log } = await harness(t);
  state.images.add(image);
  state.images.add(runtime);
  state.fill = () => new Promise(() => undefined);
  await backend.place(assignment({ runtime }), "Job");
  const fill = await fillHeld(state);
  assert.ok(state.containers.has(fill));
  assert.deepEqual(await backend.stop("asg-1"), { stopped: "Stopped" });
  await backend.settled();
  assert.equal(state.containers.size, 0);
  assert.equal(state.volumes.size, 0);
  assert.ok(fillRemovedFirst(state, fill));
  assert.ok(!state.calls.some((call) => call.argv.includes("-d")));
  assert.deepEqual(await endsNamed(backend), []);
  assert.match(log.at(-1) ?? "", /was stopped before it started$/u);
});

test("a deadline passing while the runtime is copied removes the container copying it, then the copy, and fails the placement", async (t) => {
  const context = await harness(t);
  const { backend, state, clock } = context;
  state.images.add(image);
  state.images.add(runtime);
  state.fill = () => new Promise(() => undefined);
  clock.nowMs += 999;
  await backend.place(assignment({ runtime, deadlineSecs: 1 }), "Job");
  const fill = await fillHeld(state);
  await backend.settled();
  assert.equal(state.containers.size, 0);
  assert.equal(state.volumes.size, 0);
  assert.ok(fillRemovedFirst(state, fill));
  const [ended] = await endsNamed(backend);
  assert.ok(ended?.kind === "Job");
  assert.match(ended.why, /: the assignment's deadline passed first$/u);
});

test("a stop while a job's run is answered as an unstarted shell names no refusal", async (t) => {
  const { backend, state, log } = await harness(t);
  state.images.add(image);
  state.images.add(runtime);
  /** @type {ReturnType<typeof deferred<import("./engine.mjs").EngineAnswer>>} */
  const run = deferred();
  state.intercept = (call) =>
    call.argv.includes("-d") ? run.promise : undefined;
  await backend.place(assignment({ runtime }), "Job");
  while (!state.calls.some((call) => call.argv.includes("-d")))
    await setImmediate();
  const stopping = backend.stop("asg-1");
  run.resolve(unstartedEntrypoint("/bin/sh"));
  assert.deepEqual(await stopping, { stopped: "Stopped" });
  assert.ok(!log.some((line) => line.includes("was refused")), log.join("\n"));
  assert.ok(log.some((line) => line.endsWith("was stopped before it started")));
  assert.deepEqual(await endsNamed(backend), []);
});

test("a placement that finds the job already running keeps that container's copy and removes its own", async (t) => {
  const context = await harness(t);
  const first = await placedThroughRuntime(context);
  const kept = [
    first?.labels["io.chuggy.runtime"],
    first?.labels["io.chuggy.workspace"],
  ];
  await context.backend.place(assignment({ runtime }), "Job");
  await context.backend.settled();
  assert.match(context.log.at(-1) ?? "", /was already running$/u);
  assert.deepEqual([...context.state.volumes.keys()], kept);
  assert.equal(
    context.state.calls.filter(
      (call) => call.argv[0] === "volume" && call.argv[1] === "create",
    ).length,
    4,
  );
});

test("each runtime volume the engine would not remove is logged by name, and the others are removed", async (t) => {
  const context = await harness(t);
  const container = await placedThroughRuntime(context);
  assert.ok(container !== undefined);
  container.status = "exited";
  container.exitCode = 0;
  const volume = container.labels["io.chuggy.runtime"];
  const workspace = container.labels["io.chuggy.workspace"];
  context.state.intercept = (call) =>
    call.argv[1] === "rm" && call.argv.at(-1) === volume
      ? failedWith(
          "Error response from daemon: remove: device or resource busy",
        )
      : undefined;
  await endsNamed(context.backend);
  assert.ok(
    context.log.some((line) =>
      line.includes(`its volume ${volume} was not removed: `),
    ),
    context.log.join("\n"),
  );
  assert.deepEqual([...context.state.volumes.keys()], [volume]);
  assert.ok(!context.state.volumes.has(workspace));
  context.state.intercept = () => undefined;
  await context.backend.held();
  assert.equal(context.state.volumes.size, 0);
  assert.match(
    context.log.at(-1) ?? "",
    new RegExp(
      `its volume ${volume}, which nothing answered for, was removed$`,
      "u",
    ),
  );
});

/**
 * One of a job's volumes of chuggy's runtime as the engine holds it.
 *
 * @param {string} assignmentId
 * @param {string} fill
 */
const runtimeVolume = (assignmentId, fill, owner = "vteng/chuggy/shame") => ({
  labels: {
    "io.chuggy.pool": owner,
    "io.chuggy.assignment": assignmentId,
    "io.chuggy.fill": fill,
  },
});

test("volumes of chuggy's runtime nothing answers for are removed at the first held, the container filling them first, and no other is", async (t) => {
  const { backend, state, log } = await harness(t);
  state.volumes.set("left-runtime", runtimeVolume("asg-gone", "left-fill"));
  state.volumes.set("left-workspace", runtimeVolume("asg-gone", "left-fill"));
  state.containers.set("left-fill", {
    id: "id-left-fill",
    name: "left-fill",
    labels: {},
    status: "created",
    image: runtime,
    volumes: ["left-runtime:/opt/chuggy", "left-workspace:/workspace:nocopy"],
  });
  const name = seeded(state, "asg-2", "running", startMs / 1000 + 60);
  const running = state.containers.get(name);
  assert.ok(running !== undefined);
  running.volumes = ["held-runtime:/opt/chuggy:ro,nocopy"];
  state.volumes.set("held-runtime", runtimeVolume("asg-2", "held-fill"));
  state.volumes.set(
    "other-runtime",
    runtimeVolume("asg-gone", "other-fill", "vteng/other/shame"),
  );
  state.volumes.set("unassigned", {
    labels: { "io.chuggy.pool": "vteng/chuggy/shame" },
  });
  assert.deepEqual(await backend.held(), heldJobs("asg-2"));
  assert.deepEqual(
    [...state.volumes.keys()],
    ["held-runtime", "other-runtime", "unassigned"],
  );
  assert.ok(!state.containers.has("left-fill"));
  assert.ok(fillRemovedFirst(state, "left-fill"));
  assert.ok(
    !state.calls.some(({ argv }) => argv.at(-1) === "held-fill"),
    "a listed container's fill is left alone",
  );
  const owner = containerName(pool, "asg-gone");
  assert.deepEqual(
    log.filter((line) => line.startsWith(owner)),
    [
      `${owner}: its volume left-runtime, which nothing answered for, was removed`,
      `${owner}: its volume left-workspace, which nothing answered for, was removed`,
    ],
  );
  const calls = state.calls.length;
  assert.deepEqual(await backend.held(), heldJobs("asg-2"));
  assert.ok(!verbs(state).slice(calls).includes("volume"));
});

test("a sweep leaves the volumes of a placement that began after held read its placements", async (t) => {
  const { backend, state } = await harness(t);
  state.images.add(image);
  state.images.add(runtime);
  state.fill = () => new Promise(() => undefined);
  /** @type {ReturnType<typeof deferred<import("./engine.mjs").EngineAnswer>>} */
  const listing = deferred();
  state.intercept = (call) =>
    call.argv[1] === "ls" ? listing.promise : undefined;
  const holding = backend.held();
  await calledFor(state, (call) => call.argv[1] === "ls");
  await backend.place(assignment({ runtime }), "Job");
  const fill = await fillHeld(state);
  listing.resolve({
    code: 0,
    stdout: [...state.volumes.keys()].map((volume) => `${volume}\n`).join(""),
    stderr: "",
  });
  assert.deepEqual(await holding, []);
  assert.equal(state.volumes.size, 2);
  assert.ok(state.containers.has(fill));
  assert.ok(!state.calls.some(({ argv }) => argv.includes("--force")));
  assert.deepEqual(await backend.stop("asg-1"), { stopped: "Stopped" });
});

test("a sweep the engine could not answer is logged, and made again at the next held", async (t) => {
  const timeout = failedWith("Error response from daemon: i/o timeout");
  /** @type {[string, (call: import("./engine.fixture.mjs").FakeCall) => import("./engine.mjs").EngineAnswer | undefined, RegExp][]} */
  const cases = [
    [
      "listed",
      (call) => (call.argv[1] === "ls" ? timeout : undefined),
      /^podman could not list this pool's volumes: .*i\/o timeout$/mu,
    ],
    [
      "inspected",
      (call) => (call.argv[1] === "inspect" ? timeout : undefined),
      /^podman could not inspect this pool's volumes: .*i\/o timeout$/mu,
    ],
    [
      "read",
      (call) =>
        call.argv[1] === "inspect"
          ? { code: 0, stdout: "[{}]\n", stderr: "" }
          : undefined,
      /^podman answered an inspection of this pool's volumes this runner cannot read$/mu,
    ],
  ];
  for (const [what, intercept, said] of cases) {
    const { backend, state, log } = await harness(t);
    state.volumes.set("left-runtime", runtimeVolume("asg-gone", "left-fill"));
    state.intercept = intercept;
    assert.deepEqual(await backend.held(), [], what);
    assert.match(log.join("\n"), said, what);
    assert.ok(state.volumes.has("left-runtime"), what);
    state.intercept = () => undefined;
    await backend.held();
    assert.equal(state.volumes.size, 0, what);
  }
});

test("a volume gone before the sweep inspects or removes it is no failure", async (t) => {
  const { backend, state, log } = await harness(t);
  state.volumes.set("left-runtime", runtimeVolume("asg-gone", "left-fill"));
  state.volumes.set("left-workspace", runtimeVolume("asg-gone", "left-fill"));
  state.intercept = (call) => {
    if (call.argv[1] === "ls")
      return {
        code: 0,
        stdout: "gone-runtime\nleft-runtime\nleft-workspace\n",
        stderr: "",
      };
    if (call.argv[1] !== "rm" || call.argv.at(-1) !== "left-runtime")
      return undefined;
    state.volumes.delete("left-runtime");
    return failedWith(
      "Error response from daemon: get left-runtime: no such volume",
    );
  };
  await backend.held();
  assert.equal(state.volumes.size, 0);
  assert.ok(
    !log.some((line) => /not removed|could not/u.test(line)),
    log.join("\n"),
  );
  const calls = state.calls.length;
  await backend.held();
  assert.ok(!verbs(state).slice(calls).includes("volume"));
});

test("a fill already gone is no failure in podman's words as in docker's, and one the engine would not remove is logged", async (t) => {
  /** @type {[string, boolean][]} */
  const cases = [
    [
      'Error: no container with name or ID "chuggy-shame-fill" found: no such container',
      false,
    ],
    [
      "Error response from daemon: removal of container is already in progress",
      true,
    ],
  ];
  for (const [said, logged] of cases) {
    const { backend, state, log } = await harness(t);
    state.images.add(image);
    state.images.add(runtime);
    state.intercept = (call) =>
      call.argv.includes("-d")
        ? failedWith("Error response from daemon: no space left on device")
        : call.argv.includes("--force")
          ? failedWith(said)
          : undefined;
    await backend.place(assignment({ runtime }), "Job");
    await backend.settled();
    assert.equal(state.volumes.size, 0, said);
    assert.equal(
      log.some((line) =>
        /: the container filling its volumes, \S+-fill, was not removed: /u.test(
          line,
        ),
      ),
      logged,
      said,
    );
  }
});

/** What a job's owner mounts into it in the suites below, a volume of each kind. */
const ownerMounts = [
  { source: "/srv/cache", target: "/cache/shared", readonly: true },
  { source: "cargo", target: "/cache/cargo", readonly: false },
];

/** The argv a job's container mounts `ownerMounts` with. */
const ownerMountArgv = [
  "--mount",
  "type=bind,source=/srv/cache,target=/cache/shared,readonly",
  "--volume",
  "cargo:/cache/cargo:nocopy",
];

/** The labels of an owner's volume this runner made. */
const ownerVolumeLabels = { "io.chuggy.owner-volume": "" };

/**
 * Whether `argv` holds `wanted` in a run.
 *
 * @param {string[]} argv
 * @param {string[]} wanted
 */
const holdsRun = (argv, wanted) =>
  argv.some((_, index) =>
    wanted.every((value, offset) => argv[index + offset] === value),
  );

/**
 * The calls that open owner volumes.
 *
 * @param {Awaited<ReturnType<typeof harness>>["state"]} state
 */
const openings = (state) =>
  state.calls.filter(({ argv }) => argv.includes("CHOWN"));

test("a job mounts each of its owner's volumes, whatever image it runs and however it starts, and a session none", async (t) => {
  const { backend, state } = await harness(t, {
    volumes: ownerMounts,
    images: [{ image, capabilities: ["container"] }],
  });
  state.images.add(image);
  state.images.add(runtime);
  state.volumes.set("cargo", { labels: {} });
  await backend.place(assignment(), "Job");
  await backend.place(assignment({ assignment: "asg-2", runtime }), "Job");
  await backend.place(
    assignment({ assignment: "asg-3", image: undefined }),
    "Job",
  );
  await backend.place(assignment({ assignment: "ses-1" }), "Session");
  await backend.settled();
  for (const job of ["asg-1", "asg-2", "asg-3"])
    assert.ok(holdsRun(ranWith(state, job).argv, ownerMountArgv), job);
  const session = ranWith(state, "ses-1").argv;
  assert.ok(!session.some((value) => /cache/u.test(value)), session.join(" "));
});

test("a named volume not there is made labelled as the owner's, and opened to the job's user with each other this runner made, after its runtime is copied and before it starts, on either engine", async (t) => {
  for (const engine of /** @type {const} */ (["docker", "podman"])) {
    const { backend, state, log } = await harness(t, {
      engine,
      volumes: [
        ...ownerMounts,
        { source: "npm-cache", target: "/cache/npm", readonly: false },
        { source: "theirs", target: "/cache/theirs", readonly: true },
      ],
    });
    state.volumes.set("npm-cache", { labels: ownerVolumeLabels });
    state.volumes.set("theirs", { labels: {} });
    await placedThroughRuntime({ backend, state });
    const made = state.calls.filter(
      ({ argv }) =>
        argv[1] === "create" && argv.includes("io.chuggy.owner-volume"),
    );
    assert.deepEqual(
      made.map(({ argv }) => argv),
      [ownerVolumeCreateArgv(engine, "cargo")],
      engine,
    );
    assert.deepEqual(state.volumes.get("cargo"), { labels: ownerVolumeLabels });
    assert.deepEqual(
      openings(state).map(({ argv }) => argv),
      [ownerVolumesOpenArgv(engine, ["cargo", "npm-cache"], runtime)],
      engine,
    );
    const order = [
      (argv) => argv.includes("--rm") && !argv.includes("CHOWN"),
      (argv) => argv.includes("CHOWN"),
      (argv) => argv.includes("-d"),
    ].map((wanted) => state.calls.findIndex(({ argv }) => wanted(argv)));
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      engine,
    );
    assert.ok(order[0] >= 0, engine);
    assert.ok(
      log.includes(
        `${containerName(pool, "asg-1")}: its owner's volume cargo was made`,
      ),
      log.join("\n"),
    );
  }
});

test("named volumes their owner made are mounted as they are, and nothing makes or opens one", async (t) => {
  const context = await harness(t, { volumes: ownerMounts });
  context.state.volumes.set("cargo", { labels: { "owner.label": "kept" } });
  const container = await placedThroughRuntime(context);
  assert.ok(container?.volumes?.includes("cargo:/cache/cargo:nocopy"));
  assert.deepEqual(openings(context.state), []);
  assert.ok(
    !context.state.calls.some(
      ({ argv }) => argv[1] === "create" && argv.at(-1) === "cargo",
    ),
  );
  assert.deepEqual(context.state.volumes.get("cargo"), {
    labels: { "owner.label": "kept" },
  });
});

test("a job started through no runtime mounts a named volume that is there as it is, and its placement fails, making nothing, where one is not", async (t) => {
  const there = await harness(t, { volumes: ownerMounts });
  there.state.images.add(image);
  there.state.volumes.set("cargo", { labels: ownerVolumeLabels });
  await there.backend.place(assignment(), "Job");
  await there.backend.settled();
  assert.ok(holdsRun(ranWith(there.state, "asg-1").argv, ownerMountArgv));
  assert.deepEqual(openings(there.state), []);

  const missing = await harness(t, { volumes: ownerMounts });
  missing.state.images.add(image);
  await missing.backend.place(assignment(), "Job");
  await missing.backend.settled();
  assert.equal(missing.state.containers.size, 0);
  assert.equal(missing.state.volumes.size, 0);
  const [ended] = await endsNamed(missing.backend);
  assert.ok(ended?.kind === "Job");
  assert.equal(
    ended.why,
    "its container was not started: its owner's volume cargo is not there, and only a job started through chuggy's runtime can make one",
  );
});

test("a runner that cannot inspect, make or open an owner's volume fails the placement and keeps none of the job's own volumes", async (t) => {
  /** @type {[string, (state: Awaited<ReturnType<typeof harness>>["state"]) => void, RegExp, string[]][]} */
  const cases = [
    [
      "inspected",
      (state) => {
        state.intercept = (call) =>
          call.argv[1] === "inspect" && call.argv.at(-1) === "cargo"
            ? failedWith("Error response from daemon: i/o timeout")
            : undefined;
      },
      /^its container was not started: its owner's volume cargo could not be inspected: .*i\/o timeout$/u,
      [],
    ],
    [
      "read",
      (state) => {
        state.intercept = (call) =>
          call.argv[1] === "inspect" && call.argv.at(-1) === "cargo"
            ? { code: 0, stdout: "[{}]\n", stderr: "" }
            : undefined;
      },
      /^its container was not started: podman answered an inspection of its owner's volume cargo this runner cannot read$/u,
      [],
    ],
    [
      "made",
      (state) => {
        state.intercept = (call) =>
          call.argv[1] === "create" && call.argv.at(-1) === "cargo"
            ? failedWith("Error response from daemon: no space left on device")
            : undefined;
      },
      /^its container was not started: its owner's volume cargo could not be made: .*no space left/u,
      [],
    ],
    [
      "opened",
      (state) => {
        state.intercept = (call) =>
          call.argv.includes("CHOWN")
            ? failedWith(
                "node:fs:1: Error: EPERM: operation not permitted, chown '/var/run/chuggy/volumes/cargo'",
              )
            : undefined;
      },
      /^its container was not started: this runner could not open its owner's volumes cargo: .*EPERM/u,
      ["cargo"],
    ],
  ];
  for (const [what, arrange, why, kept] of cases) {
    const context = await harness(t, { volumes: ownerMounts });
    arrange(context.state);
    await placedThroughRuntime(context);
    assert.equal(context.state.containers.size, 0, what);
    assert.deepEqual([...context.state.volumes.keys()], kept, what);
    const [ended] = await endsNamed(context.backend);
    assert.ok(ended?.kind === "Job");
    assert.match(ended.why, why, what);
  }
});

test("an owner's volume another placement made after this one found it missing is taken as made", async (t) => {
  const raced = await harness(t, { volumes: ownerMounts });
  raced.state.intercept = (call) => {
    if (call.argv[1] !== "create" || call.argv.at(-1) !== "cargo")
      return undefined;
    raced.state.volumes.set("cargo", { labels: ownerVolumeLabels });
    return failedWith(
      "Error: volume with name cargo already exists: volume already exists",
      125,
    );
  };
  const container = await placedThroughRuntime(raced);
  assert.ok(container?.volumes?.includes("cargo:/cache/cargo:nocopy"));
  assert.equal(openings(raced.state).length, 1);
});

test("no sweep removes an owner's volume: not a restarted runner's first held, nor the end of a job that mounted it", async (t) => {
  const context = await harness(t, {
    volumes: [
      ...ownerMounts,
      { source: "npm-cache", target: "/cache/npm", readonly: false },
      { source: "theirs", target: "/cache/theirs", readonly: true },
    ],
  });
  const { backend, state } = context;
  state.volumes.set("left-runtime", runtimeVolume("asg-gone", "left-fill"));
  state.volumes.set("npm-cache", { labels: ownerVolumeLabels });
  state.volumes.set("theirs", { labels: {} });
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual([...state.volumes.keys()].sort(), ["npm-cache", "theirs"]);

  const container = await placedThroughRuntime(context);
  assert.ok(container !== undefined);
  container.status = "exited";
  container.exitCode = 0;
  assert.equal((await endsNamed(backend)).length, 1);
  assert.equal(state.containers.size, 0);
  assert.deepEqual([...state.volumes.keys()].sort(), [
    "cargo",
    "npm-cache",
    "theirs",
  ]);
  await backend.held();
  assert.deepEqual(state.volumes.get("cargo"), { labels: ownerVolumeLabels });
});
