import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setImmediate, setTimeout as waited } from "node:timers/promises";

import {
  mintedCredentialDirectory,
  workerImageFaults,
  workerImageFaultStatuses,
  workerRuntimeDirectory,
  workerWorkspaceDirectory,
} from "@chuggy/worker-contract/workerEnvironment";

import { claudeCredentialVariable } from "./claudeCredential.mjs";
import {
  checkedContainerBackendSettings,
  containerBackend,
  containerImageOf,
  containerImageFaultTexts,
  containerName,
  logSaveFailureDwellMs,
  ownerVolumesSchema,
  pullFailureDwellMs,
} from "./containerBackend.mjs";
import {
  deferred,
  fakeEngine,
  fakeImageHeldFor,
  fakeImageId,
  fakeImagePlatformDefault,
  unstartedEntrypoint,
} from "./engine.fixture.mjs";
import {
  heldCreateArgv,
  ownerVolumeCreateArgv,
  ownerVolumesOpenArgv,
} from "./engineArgv.mjs";
import {
  jobEngineSocket,
  jobEnvelope,
  jobProviderCredentialFile,
  jobRunDirectory,
} from "./job.mjs";
import { poolProjectDigest } from "./poolIdentity.mjs";
import { diskReclaimIntervalMs } from "./diskFloor.mjs";
import { imageSweepIntervalMs } from "./imageCleanup.mjs";
import { memoryStartCutMs } from "./memoryBudget.mjs";
import {
  savedLogBytesMax,
  savedLogCutLine,
  savedLogLinesMax,
} from "./savedLog.mjs";

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
 * @param {Partial<import("./containerBackend.mjs").ContainerBackendSeams>} [seams] in place of the harness's own
 */
async function harness(t, overrides = {}, seams = {}) {
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
  /** @type {[string, string][]} the credential files the runner was asked about, each with its agent */
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
    tokenFileRefusal: async (file, agent) => {
      tokenFilesAsked.push([file, agent]);
      return tokenFileRefused;
    },
    ...seams,
  });
  return {
    backend,
    engine,
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

/** Jobs `held` lists as containers, which run on once the runner's process ends. */
const listedJobs = (...named) =>
  named.map((assignment) => ({
    assignment,
    kind: "Job",
    outlivesRunner: true,
  }));

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
  assert.deepEqual(await backend.held(), listedJobs("asg-1"));
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

test("a named volume may be listed as its project's, by a name that still names a volume once its project's digest follows it, and a directory may not", () => {
  const scoped = (source) =>
    ownerVolumesRefused([
      { source, target: "/cache/sccache", scope: "project" },
    ]);
  assert.deepEqual(
    ownerVolumesSchema.parse([
      { source: "sccache", target: "/cache/sccache", scope: "project" },
    ]),
    [
      {
        source: "sccache",
        target: "/cache/sccache",
        readonly: false,
        scope: "project",
      },
    ],
  );
  assert.deepEqual(scoped("s".repeat(234)), []);
  assert.deepEqual(scoped("s".repeat(235)), [
    "0.source is too long to be named per project, which takes a name of at most 234 characters",
  ]);
  assert.deepEqual(
    ownerVolumesRefused([{ source: "s".repeat(235), target: "/cache/s" }]),
    [],
  );
  assert.deepEqual(scoped("/srv/cache"), [
    "0.source is a directory, and only a named volume can be one per project",
  ]);
  assert.equal(
    ownerVolumesRefused([
      { source: "sccache", target: "/cache/sccache", scope: "pool" },
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

/**
 * Each pull the engine was asked for: its image, what it added to the
 * engine's environment, and the credential it read, where it read one.
 *
 * @param {ReturnType<typeof fakeEngine>["state"]} state
 */
const pullsMade = (state) =>
  state.calls
    .filter((call) => call.argv[0] === "pull")
    .map((call) => ({
      argv: call.argv.map((word) =>
        call.authDirectory === undefined
          ? word
          : word.replace(call.authDirectory, "<directory>"),
      ),
      environment: Object.fromEntries(
        Object.entries(call.environment).map(([name, value]) => [
          name,
          call.authDirectory === undefined
            ? value
            : value.replace(call.authDirectory, "<directory>"),
        ]),
      ),
      credential:
        call.authFile === undefined ? undefined : JSON.parse(call.authFile),
    }));

test("the pool's token is presented only to the registry the pool was registered for, and any other image is the engine's own pull", async (t) => {
  const elsewhere = [
    "registry.example.com",
    "evil-registry.chuggy.example",
    "registry.chuggy.example.evil.example",
    "registry.chuggy.example:5000",
  ].map((host) => `${host}/x@sha256:${"b".repeat(64)}`);
  const ownPulls = elsewhere.map((other) => ({
    argv: ["pull", "--quiet", other],
    environment: {},
    credential: undefined,
  }));
  const poolCredential = {
    auths: {
      "registry.chuggy.example": {
        auth: Buffer.from("chuggy-pool:pool-token-1").toString("base64"),
      },
    },
  };
  /** @type {Record<"docker" | "podman", object[]>} */
  const expected = {
    podman: [
      {
        argv: [
          "pull",
          "--quiet",
          "--authfile",
          "<directory>/config.json",
          image,
        ],
        environment: {},
        credential: poolCredential,
      },
      ...ownPulls,
    ],
    docker: [
      {
        argv: ["pull", "--quiet", image],
        environment: {
          DOCKER_CONFIG: "<directory>",
          DOCKER_HOST: "unix:///var/run/docker.sock",
          DOCKER_AUTH_CONFIG: "",
        },
        credential: poolCredential,
      },
      ...ownPulls,
    ],
  };
  for (const engine of /** @type {const} */ (["podman", "docker"])) {
    const { backend, state, invalidated, minted, settings } = await harness(t, {
      engine,
      dockerHost:
        engine === "docker" ? "unix:///var/run/docker.sock" : undefined,
    });
    await backend.place(assignment(), "Job");
    await backend.settled();
    for (const [index, other] of elsewhere.entries()) {
      await backend.place(
        assignment({ assignment: `asg-${String(index + 2)}`, image: other }),
        "Job",
      );
      await backend.settled();
    }
    assert.deepEqual(pullsMade(state), expected[engine], engine);
    assert.equal(minted(), 1);
    assert.deepEqual(invalidated, []);
    assert.equal(state.containers.size, 1 + elsewhere.length);
    assert.deepEqual(await readdir(settings.runtimeDir), []);
  }
});

test("a pool whose registration names no registry never writes its token, and pulls as its engine does", async (t) => {
  const { backend, state, minted } = await harness(t, {
    registryHost: undefined,
  });
  await backend.place(assignment(), "Job");
  await backend.settled();
  assert.deepEqual(pullsMade(state), [
    {
      argv: ["pull", "--quiet", image],
      environment: {},
      credential: undefined,
    },
  ]);
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
    /was not started: its image could not be pulled: .*unauthorized/u,
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

test("a running container past its deadline is killed, its logs saved, removed, and its end named timed out", async (t) => {
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
      killed: "Deadline",
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

  assert.deepEqual(await backend.held(), listedJobs("asg-1"));
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
  assert.deepEqual(await backend.held(), listedJobs("asg-2"));
  assert.deepEqual(await backend.stop("asg-2"), { stopped: "Stopped" });
  assert.equal(state.containers.has(name), false);
});

test("a running container inside its deadline is held", async (t) => {
  const { backend, state } = await harness(t);
  seeded(state, "asg-2", "running", startMs / 1000 + 60);
  assert.deepEqual(await backend.held(), listedJobs("asg-2"));
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
      ["logs", "--tail", String(savedLogLinesMax + 1), "id-asg-2"],
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
  assert.match(
    log.at(-1) ?? "",
    /was stopped; its logs could not be saved: podman logs exited 1$/u,
  );

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
  assert.deepEqual(tokenFilesAsked, [[settings.tokenFile, "Claude"]]);
  refuseTokenFile(undefined);
  assert.equal((await backend.place(assignment(), "Job")).placed, "Placed");
  await backend.settled();
});

/**
 * Catches a job requiring Codex handed the Claude credential, or told its
 * kind; any other workload handed the Codex credential; or the runner's check
 * asked of a file other than the one mounted.
 */
test("a job requiring an agent mounts that agent's credential file and is told the Claude credential's kind only where it is Claude's", async (t) => {
  const codexFile = "/home/op/.codex/auth.json";
  const setting = { kind: "Vertex", region: "global", project: "p" };
  const { backend, state, settings, tokenFilesAsked } = await harness(t, {
    agentCredentialFiles: { Codex: codexFile },
    claudeCredential: setting,
    images: [{ image, capabilities: ["Agent:Claude", "Agent:Codex"] }],
  });
  state.images.add(image);
  const required = (assignmentId, agent) =>
    assignment({
      assignment: assignmentId,
      image: undefined,
      capabilities: ["Platform:Linux:Amd64", agent],
    });
  await backend.place(required("asg-codex", "Agent:Codex"), "Job");
  await backend.place(required("asg-claude", "Agent:Claude"), "Job");
  await backend.place(assignment({ assignment: "asg-none" }), "Job");
  await backend.place(
    assignment({ assignment: "ses-1", capabilities: [] }),
    "Session",
  );
  await backend.settled();
  const handed = (assignmentId) => {
    const { argv, envFile } = ranWith(state, assignmentId);
    return [
      argv.find((argument) =>
        argument.endsWith(`,target=${jobProviderCredentialFile},readonly`),
      ),
      envFile.includes(`${claudeCredentialVariable}=`),
    ];
  };
  const mounted = (file) =>
    `type=bind,source=${file},target=${jobProviderCredentialFile},readonly`;
  assert.deepEqual(handed("asg-codex"), [mounted(codexFile), false]);
  for (const claude of ["asg-claude", "asg-none", "ses-1"])
    assert.deepEqual(handed(claude), [mounted(settings.tokenFile), true]);
  assert.deepEqual(tokenFilesAsked, [
    [codexFile, "Codex"],
    [settings.tokenFile, "Claude"],
    [settings.tokenFile, "Claude"],
    [settings.tokenFile, "Claude"],
  ]);
});

/**
 * Catches a job requiring an agent this runner holds no file for refused, or
 * handed it otherwise than a job requiring none is, which a pool running that
 * agent on its Claude file relies on.
 */
test("a job requiring an agent the runner names no credential file for mounts the Claude one, told its kind, as one requiring none does", async (t) => {
  const setting = { kind: "Vertex", region: "global", project: "p" };
  const { backend, state, settings, tokenFilesAsked } = await harness(t, {
    agentCredentialFiles: { Codex: "/home/op/.codex/auth.json" },
    claudeCredential: setting,
    images: [{ image, capabilities: ["Agent:Gemini"] }],
  });
  state.images.add(image);
  assert.equal(
    (
      await backend.place(
        assignment({
          image: undefined,
          capabilities: ["Platform:Linux:Amd64", "Agent:Gemini"],
        }),
        "Job",
      )
    ).placed,
    "Placed",
  );
  await backend.settled();
  const { argv, envFile } = ranWith(state, "asg-1");
  assert.ok(
    argv.includes(
      `type=bind,source=${settings.tokenFile},target=${jobProviderCredentialFile},readonly`,
    ),
  );
  assert.match(envFile, new RegExp(`^${claudeCredentialVariable}=`, "mu"));
  assert.deepEqual(tokenFilesAsked, [[settings.tokenFile, "Claude"]]);
});

/**
 * Catches a job requiring several agents run with one agent's credential
 * rather than refused, or a runner's reason a Codex file cannot be handed
 * over passed by.
 */
test("a job requiring several agents is refused, as is one the runner says cannot read its agent's file, and nothing is run", async (t) => {
  const codexFile = "/home/op/.codex/auth.json";
  const required = (...agents) =>
    assignment({
      image: undefined,
      capabilities: ["Platform:Linux:Amd64", ...agents],
    });
  const { backend, state, tokenFilesAsked, refuseTokenFile } = await harness(
    t,
    {
      images: [{ image, capabilities: ["Agent:Claude", "Agent:Codex"] }],
      agentCredentialFiles: { Codex: codexFile },
    },
  );
  assert.deepEqual(
    await backend.place(
      required("Agent:Claude", "Agent:Codex", "Agent:Claude"),
      "Job",
    ),
    {
      placed: "Refused",
      evidence:
        "the assignment requires Agent:Claude and Agent:Codex, and a job is handed one agent's credential, so this runner cannot tell which; require one agent",
    },
  );
  refuseTokenFile("the Codex auth file is empty");
  assert.deepEqual(await backend.place(required("Agent:Codex"), "Job"), {
    placed: "Refused",
    evidence: "the Codex auth file is empty",
  });
  assert.deepEqual(tokenFilesAsked, [[codexFile, "Codex"]]);
  assert.deepEqual(state.calls, []);
  await assert.rejects(
    harness(t, { agentCredentialFiles: { Claude: codexFile } }),
    /^RangeError: agentCredentialFiles names Claude, whose credential file is tokenFile/u,
  );
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
    { assignment: "ses-running", kind: "Session", outlivesRunner: true },
    { assignment: "asg-running", kind: "Job", outlivesRunner: true },
    { assignment: "asg-unlabelled", kind: "Job", outlivesRunner: true },
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
  assert.deepEqual(await backend.held(), listedJobs("asg-1"));
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

/** Catches a CLI that runs a job loop on a chat host's credentials, which name no pool a container is named for. */
test("a chat host's identity runs no container backend", () => {
  assert.throws(
    () =>
      containerBackendSettingsChecked({
        kind: "ChatHost",
        tenant: "vteng",
        owner: "geoff",
      }),
    /^RangeError: a chat host runs no job, so its credentials run no container backend$/u,
  );
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
    [image, runtime],
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
  assert.deepEqual(await context.backend.held(), listedJobs("asg-1"));
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

/**
 * Catches the kind of a runner's Claude credential not reaching a workload's
 * core, which would read a key as a subscription's token; one reaching a
 * workload whose runner named none, which a core reads as a token today, as
 * it does a site pool's; or one no core could read accepted rather than
 * refused when the backend is made.
 */
test("a job and a session are told the kind of their runner's Claude credential, and only where the runner names one", async (t) => {
  const carried = (state) =>
    state.calls
      .filter(({ argv }) => argv[0] === "run")
      .map(({ envFile }) =>
        (envFile ?? "")
          .split("\n")
          .filter((line) => line.startsWith(`${claudeCredentialVariable}=`)),
      );
  const setting = { kind: "Vertex", region: "global", project: "p" };
  for (const [overrides, expected] of [
    [
      { claudeCredential: setting },
      [`${claudeCredentialVariable}=${JSON.stringify(setting)}`],
    ],
    [{}, []],
  ]) {
    const { backend, state } = await harness(t, overrides);
    state.images.add(image);
    await backend.place(assignment(), "Job");
    await backend.place(assignment({ assignment: "asg-2" }), "Session");
    await backend.settled();
    assert.deepEqual(carried(state), [expected, expected]);
  }
  await assert.rejects(
    harness(t, { claudeCredential: { kind: "Vertex", region: "global" } }),
    /^RangeError: the Claude credential's setting cannot be carried: project is required/u,
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
  assert.deepEqual(await passing.backend.held(), listedJobs("asg-1"));
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
  assert.deepEqual(await backend.held(), listedJobs("asg-1"));
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

/** A job's image the engine holds for arm64, beside `image`, which it holds for amd64. */
const imageArm = `registry.chuggy.example/worker-arm@sha256:${"b".repeat(64)}`;

/**
 * The platform each call `which` picks named, in the order they were made,
 * and the last word of each.
 *
 * @param {Awaited<ReturnType<typeof harness>>["state"]} state
 * @param {(argv: string[]) => boolean} which
 */
const platformsNamed = (state, which) =>
  state.calls
    .filter(({ argv }) => which(argv))
    .map(({ argv }) => [
      argv.includes("--platform")
        ? argv[argv.indexOf("--platform") + 1]
        : undefined,
      argv.at(-1),
    ]);

/** @param {string[]} argv */
const isPull = (argv) => argv[0] === "pull";

/** @param {string[]} argv */
const isFill = (argv) => argv.includes("--rm");

test("a job's image is got before the runtime, which is looked for, pulled and copied for the platform the engine holds that image for, though it is here for another", async (t) => {
  const { backend, state } = await harness(t);
  state.imagePlatforms.set(fakeImageId(state, imageArm), "linux/arm64");
  state.images.add(runtime);
  await backend.place(assignment({ image: imageArm, runtime }), "Job");
  await backend.settled();
  const images = state.calls
    .filter(({ argv }) => argv[0] === "image" || isPull(argv))
    .map(({ argv }) => [argv[0], argv.at(-1)]);
  assert.deepEqual(images, [
    ["image", imageArm],
    ["pull", imageArm],
    ["image", imageArm],
    ["image", runtime],
    ["pull", runtime],
  ]);
  assert.deepEqual(platformsNamed(state, isPull), [
    [undefined, imageArm],
    ["linux/arm64", runtime],
  ]);
  assert.deepEqual(platformsNamed(state, isFill), [
    ["linux/arm64", "/workspace"],
  ]);
  assert.deepEqual(await backend.held(), listedJobs("asg-1"));
});

test("a runtime held for the job's image's architecture is not pulled again for a variant only one of them names", async (t) => {
  const { backend, state } = await harness(t);
  state.imagePlatforms.set(fakeImageId(state, imageArm), "linux/arm64/v8");
  state.imagePlatforms.set(fakeImageId(state, runtime), "linux/arm64");
  state.images.add(imageArm);
  state.images.add(runtime);
  await backend.place(assignment({ image: imageArm, runtime }), "Job");
  await backend.settled();
  assert.ok(!verbs(state).includes("pull"));
  assert.deepEqual(platformsNamed(state, isFill), [
    ["linux/arm64/v8", "/workspace"],
  ]);
  assert.deepEqual(await backend.held(), listedJobs("asg-1"));
});

test("a single-platform runtime for the job's image's own platform is got and copied as it was before any platform was named", async (t) => {
  const { backend, state } = await harness(t);
  const runtimeId = fakeImageId(state, runtime);
  state.images.add(image);
  await backend.place(assignment({ runtime }), "Job");
  await backend.settled();
  assert.deepEqual(platformsNamed(state, isPull), [
    [fakeImagePlatformDefault, runtime],
  ]);
  assert.equal(fakeImageId(state, runtime), runtimeId);
  assert.deepEqual(platformsNamed(state, isFill), [
    [fakeImagePlatformDefault, "/workspace"],
  ]);
  assert.deepEqual(await backend.held(), listedJobs("asg-1"));

  await backend.place(assignment({ assignment: "asg-2", runtime }), "Job");
  await backend.settled();
  assert.equal(platformsNamed(state, isPull).length, 1);
  assert.equal(platformsNamed(state, isFill).length, 2);
  assert.deepEqual(await backend.held(), listedJobs("asg-1", "asg-2"));
});

test("a job whose image and runtime both cannot be got is refused for its image, and the runtime is never looked for", async (t) => {
  const { backend, state } = await harness(t);
  const said = (/** @type {string} */ pulled) =>
    `Error response from daemon: manifest for ${pulled} not found: manifest unknown: manifest unknown`;
  state.pull = (pulled) => failedWith(said(pulled));
  await backend.place(assignment({ runtime }), "Job");
  await backend.settled();
  assert.ok(!state.calls.some(({ argv }) => argv.includes(runtime)));
  assert.deepEqual(await endsNamed(backend), [
    {
      kind: "Job",
      job: heldAttempt,
      why: `${containerImageFaultTexts.ImageUnpullable} The engine said: ${said(image)}`,
      refusal: { fault: "ImageUnpullable" },
    },
  ]);
});

/**
 * An engine holding `image` for amd64 and `imageArm` for arm64, whose every
 * pull waits on one the suite ends, each in the order they were made.
 *
 * @param {Awaited<ReturnType<typeof harness>>["state"]} state
 */
function platformsMixed(state) {
  state.imagePlatforms.set(fakeImageId(state, imageArm), "linux/arm64");
  state.images.add(image);
  state.images.add(imageArm);
  /** @type {ReturnType<typeof deferred<import("./engine.mjs").EngineAnswer>>[]} */
  const pulls = [];
  state.pull = (pulled) => {
    state.images.add(pulled);
    /** @type {ReturnType<typeof deferred<import("./engine.mjs").EngineAnswer>>} */
    const pull = deferred();
    pulls.push(pull);
    return pull.promise;
  };
  return pulls;
}

test("two jobs whose images are for different platforms each copy the runtime's variant for their own, on an engine holding one variant by a name", async (t) => {
  const { backend, state } = await harness(t);
  const pulls = platformsMixed(state);
  await backend.place(assignment({ runtime }), "Job");
  await backend.place(
    assignment({ assignment: "asg-2", image: imageArm, runtime }),
    "Job",
  );
  for (let round = 0; round < 2; round += 1) {
    for (let wait = 0; pulls.length === 0 && wait < 1000; wait += 1)
      await waited(1);
    await waited(50);
    assert.equal(pulls.length, 1, `round ${String(round)}`);
    for (const pull of pulls.splice(0))
      pull.resolve({ code: 0, stdout: "", stderr: "" });
  }
  await backend.settled();
  assert.deepEqual(platformsNamed(state, isPull), [
    [fakeImagePlatformDefault, runtime],
    ["linux/arm64", runtime],
  ]);
  assert.deepEqual(
    platformsNamed(state, isFill).map(([platform]) => platform),
    [fakeImagePlatformDefault, "linux/arm64"],
  );
  assert.deepEqual(await endsNamed(backend), []);
  assert.deepEqual(await backend.held(), listedJobs("asg-1", "asg-2"));
});

test("a job waiting its turn at the runtime fails at its deadline, and the job ahead of it is not held up", async (t) => {
  const { backend, state, clock } = await harness(t);
  state.images.add(image);
  /** @type {ReturnType<typeof deferred<import("./engine.mjs").EngineAnswer>>} */
  const firstPull = deferred();
  state.pull = (pulled) => {
    state.images.add(pulled);
    return firstPull.promise;
  };
  await backend.place(assignment({ runtime }), "Job");
  await calledFor(state, ({ argv }) => isPull(argv));
  clock.nowMs += 999;
  await backend.place(
    assignment({ assignment: "asg-2", runtime, deadlineSecs: 1 }),
    "Job",
  );
  await waited(20);
  firstPull.resolve({ code: 0, stdout: "", stderr: "" });
  await backend.settled();
  const ends = await endsNamed(backend);
  assert.equal(ends.length, 1);
  const [ended] = ends;
  assert.ok(ended.kind === "Job");
  assert.equal(ended.job.assignment, "asg-2");
  assert.equal(ended.refusal, undefined);
  assert.match(
    ended.why,
    /^its container was not started: this runner could not get chuggy's runtime \S+: the assignment's deadline passed first$/u,
  );
  assert.equal(platformsNamed(state, isPull).length, 1);
  assert.deepEqual(await backend.held(), listedJobs("asg-1"));
});

/** @param {string[]} argv */
const isPlatformInspect = (argv) =>
  argv[0] === "image" && argv[2] === "--platform";

test("on docker's containerd store, a runtime held for the job's image's platform beside the one an inspection answers is asked for at that platform, and not pulled", async (t) => {
  const { backend, state } = await harness(t, {
    engine: "docker",
    dockerHost: "unix:///var/run/docker.sock",
  });
  state.containerdStore = true;
  const runtimeId = fakeImageId(state, runtime);
  state.imagePlatforms.set(runtimeId, "linux/arm64");
  state.imageVariants.set(runtimeId, [fakeImagePlatformDefault]);
  state.images.add(image);
  state.images.add(runtime);
  await backend.place(assignment({ runtime }), "Job");
  await backend.settled();
  assert.deepEqual(platformsNamed(state, isPlatformInspect), [
    [fakeImagePlatformDefault, runtime],
  ]);
  assert.ok(!verbs(state).includes("pull"));
  assert.deepEqual(platformsNamed(state, isFill), [
    [fakeImagePlatformDefault, "/workspace"],
  ]);
  assert.deepEqual(await backend.held(), listedJobs("asg-1"));
});

test("on docker's containerd store, a runtime held for no variant of the job's image's platform is pulled for it, beside the one it held", async (t) => {
  const { backend, state } = await harness(t, {
    engine: "docker",
    dockerHost: "unix:///var/run/docker.sock",
  });
  state.containerdStore = true;
  state.imagePlatforms.set(fakeImageId(state, runtime), "linux/arm64");
  state.images.add(image);
  state.images.add(runtime);
  await backend.place(assignment({ runtime }), "Job");
  await backend.settled();
  assert.deepEqual(platformsNamed(state, isPull), [
    [fakeImagePlatformDefault, runtime],
  ]);
  assert.ok(fakeImageHeldFor(state, runtime, "linux/arm64"));
  assert.deepEqual(platformsNamed(state, isFill), [
    [fakeImagePlatformDefault, "/workspace"],
  ]);
  assert.deepEqual(await backend.held(), listedJobs("asg-1"));
});

test("a docker whose inspection takes no platform holds the runtime for none but the one it answers, and the runtime is pulled for the job's image's", async (t) => {
  const { backend, state } = await harness(t, {
    engine: "docker",
    dockerHost: "unix:///var/run/docker.sock",
  });
  state.inspectPlatformUnknown = true;
  state.imagePlatforms.set(fakeImageId(state, runtime), "linux/arm64");
  state.images.add(image);
  state.images.add(runtime);
  await backend.place(assignment({ runtime }), "Job");
  await backend.settled();
  assert.equal(platformsNamed(state, isPlatformInspect).length, 1);
  assert.deepEqual(platformsNamed(state, isPull), [
    [fakeImagePlatformDefault, runtime],
  ]);
  assert.deepEqual(platformsNamed(state, isFill), [
    [fakeImagePlatformDefault, "/workspace"],
  ]);
  assert.deepEqual(await backend.held(), listedJobs("asg-1"));
});

test("two runners sharing a runtime lock on an engine holding one variant by a name get and copy the runtime one at a time, each its own image's platform", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-runtime-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeLock = join(directory, "locks", "runtime.lock");
  /** @type {Partial<import("./containerBackend.mjs").ContainerBackendSeams>} */
  const polled = {
    sleep: (_ms, signal) => waited(5, undefined, { signal }),
  };
  const first = await harness(t, { runtimeLock }, polled);
  const { state } = first;
  const second = await harness(
    t,
    { runtimeLock, pool: { ...pool, pool: "other" } },
    { ...polled, engine: first.engine },
  );
  const pulls = platformsMixed(state);
  const named = () =>
    state.calls.filter(({ argv }) => argv.includes(runtime)).length;
  await first.backend.place(assignment({ runtime }), "Job");
  await calledFor(state, ({ argv }) => isPull(argv));
  await second.backend.place(
    assignment({ assignment: "asg-2", image: imageArm, runtime }),
    "Job",
  );
  await waited(50);
  assert.equal(named(), 2);
  await stat(runtimeLock);
  pulls[0].resolve({ code: 0, stdout: "", stderr: "" });
  for (let wait = 0; pulls.length === 1 && wait < 1000; wait += 1)
    await waited(1);
  pulls[1].resolve({ code: 0, stdout: "", stderr: "" });
  await first.backend.settled();
  await second.backend.settled();
  assert.deepEqual(
    state.calls
      .filter(({ argv }) => argv.includes(runtime) || isFill(argv))
      .map(({ argv }) => [
        isPull(argv) ? "pull" : isFill(argv) ? "fill" : "inspect",
        argv.includes("--platform")
          ? argv[argv.indexOf("--platform") + 1]
          : undefined,
      ]),
    [
      ["inspect", undefined],
      ["pull", fakeImagePlatformDefault],
      ["fill", fakeImagePlatformDefault],
      ["inspect", undefined],
      ["pull", "linux/arm64"],
      ["fill", "linux/arm64"],
    ],
  );
  assert.deepEqual(await endsNamed(first.backend), []);
  assert.deepEqual(await endsNamed(second.backend), []);
  assert.deepEqual(await first.backend.held(), listedJobs("asg-1"));
  assert.deepEqual(await second.backend.held(), listedJobs("asg-2"));
  await assert.rejects(stat(runtimeLock), { code: "ENOENT" });
});

test("a job waiting at a runtime lock another runner holds fails at its deadline as the runner's, and leaves the lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-runtime-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeLock = join(directory, "runtime.lock");
  writeFileSync(runtimeLock, `${String(process.pid)}\n`);
  const { backend, state } = await harness(t, { runtimeLock });
  state.images.add(image);
  await backend.place(assignment({ runtime, deadlineSecs: 5 }), "Job");
  await backend.settled();
  const [ended] = await endsNamed(backend);
  assert.ok(ended.kind === "Job");
  assert.equal(ended.refusal, undefined);
  assert.equal(
    ended.why,
    `its container was not started: this runner could not get chuggy's runtime ${runtime}: the runtime lock was not taken by the assignment's deadline`,
  );
  assert.ok(!state.calls.some(({ argv }) => argv.includes(runtime)));
  assert.equal(readFileSync(runtimeLock, "utf8"), `${String(process.pid)}\n`);
});

/**
 * Waits until the engine has been made a call, failing the test where it
 * never is. It waits by the clock and not by turns, since a call that follows
 * real file I/O, such as taking the runtime lock, can take any number of turns
 * on a loaded host.
 *
 * @param {Awaited<ReturnType<typeof harness>>["state"]} state
 * @param {(call: import("./engine.fixture.mjs").FakeCall) => boolean} wanted
 */
async function calledFor(state, wanted) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
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
  assert.deepEqual(await backend.held(), listedJobs("asg-2"));
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
  assert.deepEqual(await backend.held(), listedJobs("asg-2"));
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
      [ownerVolumeCreateArgv(engine, { source: "cargo" })],
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

test("named volumes their owner made, labelled or not, are mounted as they are, and nothing makes or opens one", async (t) => {
  const context = await harness(t, {
    volumes: [
      ...ownerMounts,
      { source: "npm-cache", target: "/cache/npm", readonly: false },
    ],
  });
  context.state.volumes.set("cargo", { labels: {} });
  context.state.volumes.set("npm-cache", { labels: { "owner.label": "kept" } });
  const container = await placedThroughRuntime(context);
  assert.ok(container?.volumes?.includes("cargo:/cache/cargo:nocopy"));
  assert.ok(container?.volumes?.includes("npm-cache:/cache/npm:nocopy"));
  assert.deepEqual(openings(context.state), []);
  assert.ok(
    !context.state.calls.some(
      ({ argv }) =>
        argv[1] === "create" && argv.includes("io.chuggy.owner-volume"),
    ),
  );
  assert.deepEqual(context.state.volumes.get("cargo"), { labels: {} });
  assert.deepEqual(context.state.volumes.get("npm-cache"), {
    labels: { "owner.label": "kept" },
  });
});

test("a session mounts no owner's volume and readies none, so one that is not there fails no session", async (t) => {
  const { backend, state } = await harness(t, { volumes: ownerMounts });
  state.images.add(image);
  await backend.place(assignment({ assignment: "ses-1" }), "Session");
  await backend.settled();
  assert.ok(state.containers.has(containerName(pool, "ses-1")));
  assert.ok(
    !state.calls.some(({ argv }) => argv[0] === "volume"),
    JSON.stringify(state.calls.map(({ argv }) => argv)),
  );
  assert.deepEqual(openings(state), []);
  assert.equal(state.volumes.size, 0);
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

/** A volume listed as its project's. */
const projectMount = {
  source: "sccache",
  target: "/cache/sccache",
  readonly: false,
  scope: /** @type {const} */ ("project"),
};

/** The name `projectMount` has for `pool`'s project. */
const projectVolume = `sccache-${String(poolProjectDigest(pool))}`;

/** The labels of a volume this runner made as `pool`'s project's. */
const projectVolumeLabels = {
  ...ownerVolumeLabels,
  "io.chuggy.owner-volume.project": "vteng/chuggy",
};

test("a volume listed as its project's is mounted by a name of that project's, which is made labelled as that project's and opened", async (t) => {
  for (const engine of /** @type {const} */ (["docker", "podman"])) {
    const context = await harness(t, { engine, volumes: [projectMount] });
    const container = await placedThroughRuntime(context);
    assert.ok(
      container?.volumes?.includes(`${projectVolume}:/cache/sccache:nocopy`),
      engine,
    );
    assert.deepEqual(
      context.state.volumes.get(projectVolume),
      { labels: projectVolumeLabels },
      engine,
    );
    assert.deepEqual(
      openings(context.state).map(({ argv }) => argv),
      [ownerVolumesOpenArgv(engine, [projectVolume], runtime)],
      engine,
    );
  }
  assert.deepEqual(
    ownerVolumesRefused([{ source: projectVolume, target: "/cache/s" }]),
    [],
  );
});

test("a volume listed as its project's that is there labelled as that project's is mounted, and not made again", async (t) => {
  const context = await harness(t, { volumes: [projectMount] });
  context.state.volumes.set(projectVolume, { labels: projectVolumeLabels });
  const container = await placedThroughRuntime(context);
  assert.ok(
    container?.volumes?.includes(`${projectVolume}:/cache/sccache:nocopy`),
  );
  assert.ok(
    !context.state.calls.some(
      ({ argv }) => argv[1] === "create" && argv.at(-1) === projectVolume,
    ),
  );
});

/** A member's personal runner in `pool`'s tenant. */
const personal = {
  kind: /** @type {const} */ ("Personal"),
  tenant: "vteng",
  owner: "28:https://auth.chuggy.example/geoff",
};

/**
 * What a job placed through chuggy's runtime in `project` ran with on a
 * runner whose owner lists `projectMount`: the volume calls it made, and its
 * container's mounts.
 *
 * @param {import("node:test").TestContext} t
 * @param {import("./poolIdentity.mjs").PoolIdentity} identity
 * @param {string} [project] the project its assignment names
 * @param {Record<string, {labels: Record<string, string>}>} [there] the volumes there before it
 */
async function projectMountPlaced(t, identity, project, there = {}) {
  const context = await harness(t, {
    pool: identity,
    volumes: [projectMount],
  });
  for (const [name, volume] of Object.entries(there))
    context.state.volumes.set(name, volume);
  context.state.images.add(image);
  context.state.images.add(runtime);
  await context.backend.place(
    assignment({ runtime, ...(project === undefined ? {} : { project }) }),
    "Job",
  );
  await context.backend.settled();
  return {
    context,
    made: context.state.calls
      .filter(({ argv }) => argv[0] === "volume" && argv[1] === "create")
      .map(({ argv }) => argv)
      .filter((argv) => argv.some((value) => value.startsWith("sccache"))),
    mounts: (
      context.state.containers.get(containerName(identity, "asg-1"))?.volumes ??
      []
    ).filter((value) => value.startsWith("sccache")),
  };
}

test("a personal runner's job mounts the volume a pool's job in its project does: one name, made with one label, so the two share it", async (t) => {
  const pooled = await projectMountPlaced(t, pool);
  const ownersJob = await projectMountPlaced(t, personal, "chuggy");
  assert.equal(pooled.made.length, 1);
  assert.deepEqual(ownersJob.made, pooled.made);
  assert.deepEqual(ownersJob.mounts, pooled.mounts);
  assert.deepEqual(ownersJob.mounts, [
    `${projectVolume}:/cache/sccache:nocopy`,
  ]);
  assert.deepEqual(ownersJob.context.state.volumes.get(projectVolume), {
    labels: projectVolumeLabels,
  });
  const shared = await projectMountPlaced(t, personal, "chuggy", {
    [projectVolume]: { labels: projectVolumeLabels },
  });
  assert.deepEqual(shared.made, [], "a volume a pool made was made again");
  assert.deepEqual(shared.mounts, pooled.mounts);
});

test("a personal runner's jobs in two projects mount two volumes, each made as its own project's, and one labelled as another's is refused", async (t) => {
  const other = await projectMountPlaced(t, personal, "other");
  const otherVolume = `sccache-${String(poolProjectDigest(personal, "other"))}`;
  assert.notEqual(otherVolume, projectVolume);
  assert.deepEqual(other.mounts, [`${otherVolume}:/cache/sccache:nocopy`]);
  assert.deepEqual(other.context.state.volumes.get(otherVolume), {
    labels: {
      ...ownerVolumeLabels,
      "io.chuggy.owner-volume.project": "vteng/other",
    },
  });
  const mislabelled = await projectMountPlaced(t, personal, "other", {
    [otherVolume]: { labels: projectVolumeLabels },
  });
  assert.deepEqual(mislabelled.made, []);
  assert.equal(mislabelled.context.state.containers.size, 0);
  const [ended] = await endsNamed(mislabelled.context.backend);
  assert.ok(ended?.kind === "Job");
  assert.equal(
    ended.why,
    `its container was not started: its owner's volume ${otherVolume} is labelled as vteng/chuggy's, not vteng/other's`,
  );
});

test("a personal runner's job whose assignment names no project mounts none listed as its project's, and each says so; a session never", async (t) => {
  const context = await harness(t, {
    pool: personal,
    volumes: [...ownerMounts, projectMount],
  });
  context.state.images.add(image);
  context.state.volumes.set("cargo", { labels: ownerVolumeLabels });
  await context.backend.held();
  await context.backend.place(assignment({ assignment: "ses-1" }), "Session");
  await context.backend.settled();
  assert.deepEqual(
    context.log.filter((line) => line.includes("sccache")),
    [],
  );
  await context.backend.place(assignment(), "Job");
  await context.backend.place(assignment({ assignment: "asg-2" }), "Job");
  await context.backend.settled();
  for (const job of ["asg-1", "asg-2"]) {
    const argv = ranWith(context.state, job).argv;
    assert.ok(holdsRun(argv, ownerMountArgv), job);
    assert.ok(!argv.some((value) => /sccache/u.test(value)), argv.join(" "));
  }
  assert.deepEqual(
    context.log.filter((line) => line.includes("sccache")),
    ["asg-1", "asg-2"].map(
      (job) =>
        `${containerName(personal, job)}: its owner's volume sccache is scoped per project, and this job's assignment names no project: it runs without it`,
    ),
  );
});

test("a volume another project's labels or none mark, or one listed unscoped that a project's label marks, fails the job's placement and is mounted by none", async (t) => {
  /** @type {[string, Record<string, string>, unknown[], string][]} */
  const cases = [
    [
      projectVolume,
      { ...ownerVolumeLabels, "io.chuggy.owner-volume.project": "vteng/other" },
      [projectMount],
      `its owner's volume ${projectVolume} is labelled as vteng/other's, not vteng/chuggy's`,
    ],
    [
      projectVolume,
      ownerVolumeLabels,
      [projectMount],
      `its owner's volume ${projectVolume} is labelled as no project's, and is listed as vteng/chuggy's`,
    ],
    [
      projectVolume,
      {},
      [projectMount],
      `its owner's volume ${projectVolume} is labelled as no project's, and is listed as vteng/chuggy's`,
    ],
    [
      "cargo",
      projectVolumeLabels,
      ownerMounts,
      "its owner's volume cargo is labelled as vteng/chuggy's, and is listed as no project's",
    ],
  ];
  for (const [volume, labels, volumes, why] of cases) {
    const context = await harness(t, { volumes });
    context.state.volumes.set(volume, { labels });
    await placedThroughRuntime(context);
    assert.equal(context.state.containers.size, 0, why);
    assert.deepEqual(openings(context.state), [], why);
    assert.deepEqual(context.state.volumes.get(volume), { labels }, why);
    const [ended] = await endsNamed(context.backend);
    assert.ok(ended?.kind === "Job");
    assert.equal(ended.why, `its container was not started: ${why}`);
  }
});

/**
 * A harness whose backend keeps its images' record, and what the record
 * holds now.
 *
 * @param {import("node:test").TestContext} t
 * @param {Partial<import("./containerBackend.mjs").ContainerBackendSettings>} [overrides]
 * @param {Partial<import("./containerBackend.mjs").ContainerBackendSeams>} [seams]
 */
async function recordHarness(t, overrides = {}, seams = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-images-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imageRecord = join(directory, "images", "podman.json");
  const context = await harness(t, { imageRecord, ...overrides }, seams);
  return {
    ...context,
    imageRecord,
    /** @returns {import("./imageRecord.mjs").ImageRecord} */
    record: () => JSON.parse(readFileSync(imageRecord, "utf8")),
  };
}

const runtimeRepository = "registry.chuggy.example/runtime";
const dayMs = 86_400_000;

/**
 * A runtime image pulled by digest alone, built `days` before the harness's
 * start, here.
 *
 * @param {ReturnType<typeof fakeEngine>["state"]} state
 * @param {string} hex
 * @param {number} days
 */
function runtimeHere(state, hex, days) {
  const reference = `${runtimeRepository}@sha256:${hex.repeat(64)}`;
  state.images.add(reference);
  state.imageCreated.set(
    fakeImageId(state, reference),
    new Date(startMs - days * dayMs).toISOString(),
  );
  return reference;
}

/**
 * A record begun a month before the harness's start that knows the
 * runtime's repository and these images.
 *
 * @param {string} file
 * @param {Record<string, unknown>} [images]
 */
async function recordWritten(file, images = {}) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      createdMs: startMs - 30 * dayMs,
      repositories: { [runtimeRepository]: { kinds: ["Runtime"] } },
      images,
      holds: {},
    }),
  );
}

/** @param {ReturnType<typeof fakeEngine>["state"]} state */
const imageCalls = (state) =>
  state.calls
    .filter((call) => call.argv[0] === "image" && call.argv[1] !== "inspect")
    .map((call) => call.argv.slice(1).join(" "));

test("a placement holds its images in the record before it first looks for one, and records their use and what it pulled once run answered", async (t) => {
  const { backend, state, record, imageRecord } = await recordHarness(t);
  state.images.add(runtime);
  /** @type {import("./imageRecord.mjs").ImageRecord | undefined} */
  let looked;
  state.intercept = (call) => {
    if (looked === undefined && call.argv[0] === "image")
      looked = JSON.parse(readFileSync(imageRecord, "utf8"));
    return undefined;
  };
  await backend.place(assignment({ runtime }), "Job");
  await backend.settled();
  const name = containerName(pool, "asg-1");
  assert.ok(state.containers.has(name));
  assert.deepEqual(looked?.holds, {
    [name]: { images: [image, runtime], untilMs: startMs + 3_600_000 },
  });
  const after = record();
  assert.deepEqual(after.holds, {});
  assert.deepEqual(after.images, {
    [image]: {
      kinds: ["Job"],
      usedMs: startMs,
      pulledId: fakeImageId(state, image),
    },
    [runtime]: { kinds: ["Runtime"], usedMs: startMs },
  });
  assert.deepEqual(after.repositories, {
    [runtimeRepository]: { kinds: ["Runtime"] },
  });
});

test("a placement that never started drops its hold, and records what it pulled", async (t) => {
  const { backend, state, record } = await recordHarness(t);
  state.images.add(runtime);
  state.containers.set(containerName(pool, "asg-1"), {
    id: "id-other",
    name: containerName(pool, "asg-1"),
    labels: {},
    status: "running",
    image,
  });
  await backend.place(assignment({ runtime }), "Job");
  await backend.settled();
  assert.deepEqual(record().holds, {});
  assert.equal(record().images[image]?.pulledId, fakeImageId(state, image));
});

test("a backend given no record holds, records and sweeps nothing, and a reclaim removes nothing", async (t) => {
  const { backend, state, clock } = await harness(t);
  await backend.place(assignment(), "Job");
  await backend.settled();
  for (let pass = 0; pass < 2; pass++) {
    await backend.held();
    clock.nowMs += 2 * 3_600_000;
  }
  await backend.settled();
  assert.deepEqual(
    await backend.imagesReclaimed(new globalThis.AbortController().signal),
    [],
  );
  assert.deepEqual(
    state.calls
      .filter((call) => call.argv[0] === "image")
      .map((call) => call.argv),
    [["image", "inspect", "--format", "{{.Id}}", image]],
  );
});

test("a record, a retention or a runtime lock that names nothing a backend can keep is refused", () => {
  const settings = {
    engine: /** @type {const} */ ("podman"),
    pool,
    tokenFile: "/run/claude-token",
    timeoutSecsMax: 7200,
    outputBytesMax: 1024,
    environment: {},
    network: "chuggy-jobs",
    runtimeDir: "/run/runtime",
    logDir: "/run/logs",
    machine: { cpuMillis: 8000, memoryMib: 16384 },
    pullRetryMs: 5000,
  };
  assert.equal(checkedContainerBackendSettings(settings), settings);
  assert.throws(
    () => checkedContainerBackendSettings({ ...settings, imageRecord: "" }),
    /^RangeError: imageRecord must name a file$/u,
  );
  assert.throws(
    () => checkedContainerBackendSettings({ ...settings, runtimeLock: "" }),
    /^RangeError: runtimeLock must name a file$/u,
  );
  for (const imageUnusedSecsMax of [-1, 1.5, Number.NaN])
    assert.throws(
      () =>
        checkedContainerBackendSettings({ ...settings, imageUnusedSecsMax }),
      /^RangeError: imageUnusedSecsMax must be a whole number of seconds, 0 or more$/u,
    );
});

test("a sweep is made behind the pass that found it due, once an interval for every backend sharing the record", async (t) => {
  const first = await recordHarness(t);
  const second = await harness(t, { imageRecord: first.imageRecord });
  await recordWritten(first.imageRecord);
  await first.backend.held();
  await first.backend.settled();
  assert.deepEqual(imageCalls(first.state), ["ls --quiet --no-trunc"]);
  assert.equal(first.record().sweptMs, startMs);
  await second.backend.held();
  second.clock.nowMs += imageSweepIntervalMs - 1;
  await second.backend.held();
  await second.backend.settled();
  assert.deepEqual(imageCalls(second.state), []);
  second.clock.nowMs += 1;
  await second.backend.held();
  await second.backend.settled();
  assert.deepEqual(imageCalls(second.state), ["ls --quiet --no-trunc"]);
  await first.backend.held();
  await first.backend.settled();
  assert.deepEqual(imageCalls(first.state), ["ls --quiet --no-trunc"]);
});

test("a sweep removes a runtime repository's images past its two newest, oldest first and unforced, each named once", async (t) => {
  const { backend, state, log, imageRecord } = await recordHarness(t);
  const references = [
    runtimeHere(state, "1", 40),
    runtimeHere(state, "2", 30),
    runtimeHere(state, "3", 20),
    runtimeHere(state, "4", 10),
  ];
  await recordWritten(imageRecord);
  await backend.held();
  await backend.settled();
  assert.deepEqual(imageCalls(state), [
    "ls --quiet --no-trunc",
    `rm ${references[0]}`,
    `rm ${references[1]}`,
  ]);
  assert.deepEqual([...state.images], references.slice(2));
  assert.deepEqual(
    log.filter((line) => line.startsWith("removed ")),
    references
      .slice(0, 2)
      .map(
        (reference) =>
          `removed ${reference}, which no runner here was recorded using`,
      ),
  );
});

/**
 * Four runtime images here and a record knowing their repository, the oldest
 * used by a running container, answering the two oldest.
 *
 * @param {ReturnType<typeof fakeEngine>["state"]} state
 * @param {string} imageRecord
 */
async function oldestInUse(state, imageRecord) {
  const references = [
    runtimeHere(state, "1", 40),
    runtimeHere(state, "2", 30),
    runtimeHere(state, "3", 20),
    runtimeHere(state, "4", 10),
  ];
  const user = seeded(state, "asg-2", "running", startMs / 1000 + 60);
  /** @type {import("./engine.fixture.mjs").FakeContainer} */ (
    state.containers.get(user)
  ).image = references[0];
  await recordWritten(imageRecord);
  return references;
}

test("an image a container uses is kept at the cost of one line, and the sweep goes on", async (t) => {
  const { backend, state, log, imageRecord } = await recordHarness(t);
  const [oldest, older] = await oldestInUse(state, imageRecord);
  await backend.held();
  await backend.settled();
  assert.ok(state.images.has(oldest));
  assert.ok(!state.images.has(older));
  assert.deepEqual(
    log.filter((line) => line.includes(oldest)),
    [`${oldest} is kept: a container uses it`],
  );
});

test("a candidate whose containers could not be listed is kept, and the sweep goes on unless the engine could not be reached", async (t) => {
  for (const [stderr, gone] of [
    ["Error response from daemon: i/o timeout", true],
    [
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      false,
    ],
  ]) {
    const { backend, state, log, imageRecord } = await recordHarness(t);
    const [oldest, older] = await oldestInUse(state, imageRecord);
    state.intercept = (call) =>
      call.argv.at(-1) === `ancestor=${fakeImageId(state, older)}`
        ? failedWith(stderr)
        : undefined;
    const newer = runtimeHere(state, "5", 25);
    await backend.held();
    await backend.settled();
    assert.ok(state.images.has(oldest));
    assert.ok(state.images.has(older));
    assert.equal(state.images.has(newer), !gone, stderr);
    assert.ok(
      log.includes(
        `${older} was not removed: its containers could not be listed: ${stderr}`,
      ),
      log.join("\n"),
    );
  }
});

test("a candidate another runner holds by its turn is kept, though the sweep decided to remove it", async (t) => {
  const { backend, state, log, imageRecord } = await recordHarness(t);
  const [oldest, older] = await oldestInUse(state, imageRecord);
  state.intercept = (call) => {
    if (call.argv.at(-1) !== `ancestor=${fakeImageId(state, oldest)}`)
      return undefined;
    const record = JSON.parse(readFileSync(imageRecord, "utf8"));
    record.holds["chuggy-other-1"] = {
      images: [older],
      untilMs: startMs + 3_600_000,
    };
    writeFileSync(imageRecord, JSON.stringify(record));
    return undefined;
  };
  await backend.held();
  await backend.settled();
  assert.ok(state.images.has(oldest));
  assert.ok(state.images.has(older));
  assert.deepEqual(imageCalls(state), ["ls --quiet --no-trunc"]);
  assert.ok(log.every((line) => !line.startsWith("removed ")));
});

test("a job's image this runner pulled goes once unused for the retention, unless its name now names another", async (t) => {
  const { backend, state, clock, imageRecord } = await recordHarness(t, {
    imageUnusedSecsMax: 86_400,
  });
  state.images.add(image);
  const job = { kinds: ["Job"], usedMs: startMs - 2 * dayMs };
  await recordWritten(imageRecord, {
    [image]: { ...job, pulledId: "sha256:other" },
  });
  await backend.held();
  await backend.settled();
  assert.ok(state.images.has(image));
  await recordWritten(imageRecord, {
    [image]: { ...job, pulledId: fakeImageId(state, image) },
  });
  clock.nowMs += imageSweepIntervalMs;
  await backend.held();
  await backend.settled();
  assert.ok(!state.images.has(image));
});

test("a sweep or a record that fails fails no placement and no pass", async (t) => {
  const listed = await recordHarness(t);
  await recordWritten(listed.imageRecord);
  listed.state.intercept = (call) =>
    call.argv[1] === "ls"
      ? failedWith("Error response from daemon: i/o timeout")
      : undefined;
  assert.deepEqual(await listed.backend.held(), []);
  await listed.backend.settled();
  assert.ok(
    listed.log.includes(
      "this machine's images could not be listed: Error response from daemon: i/o timeout",
    ),
  );

  const directory = await mkdtemp(join(tmpdir(), "chuggy-images-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "file"), "");
  const unwritable = await harness(t, {
    imageRecord: join(directory, "file", "podman.json"),
  });
  await unwritable.backend.place(assignment(), "Job");
  await unwritable.backend.settled();
  assert.deepEqual(await unwritable.backend.held(), listedJobs("asg-1"));
  await unwritable.backend.settled();
  const name = containerName(pool, "asg-1");
  assert.ok(
    unwritable.log.some((line) =>
      line.startsWith(`${name}'s hold on its images could not be recorded in `),
    ),
  );
  assert.ok(
    unwritable.log.some((line) =>
      line.startsWith("this machine's images were not swept: ENOTDIR"),
    ),
  );
});

test("a reclaim keeps only a runtime repository's newest, oldest first, and stops when its signal aborts", async (t) => {
  const { backend, state, imageRecord } = await recordHarness(t);
  const references = [
    runtimeHere(state, "1", 40),
    runtimeHere(state, "2", 30),
    runtimeHere(state, "3", 20),
  ];
  await recordWritten(imageRecord);
  const aborted = new globalThis.AbortController();
  aborted.abort();
  assert.deepEqual(await backend.imagesReclaimed(aborted.signal), []);
  const reclaim = new globalThis.AbortController();
  state.intercept = (call) => {
    if (call.argv[1] === "rm") reclaim.abort();
    return undefined;
  };
  assert.deepEqual(await backend.imagesReclaimed(reclaim.signal), [
    references[0],
  ]);
  state.intercept = () => undefined;
  assert.deepEqual(
    await backend.imagesReclaimed(new globalThis.AbortController().signal),
    [references[1]],
  );
  assert.deepEqual([...state.images], [references[2]]);
});

test("a job's image some container was run from, stopped or not, keeps every name, though its classic store would untag all but its last", async (t) => {
  const { backend, state, log, imageRecord } = await recordHarness(t, {
    imageUnusedSecsMax: 86_400,
  });
  const tagged = "registry.chuggy.example/worker:1";
  state.images.add(tagged);
  state.images.add(image);
  state.imageIds.set(tagged, fakeImageId(state, image));
  state.containers.set("leftover", {
    id: "id-leftover",
    name: "leftover",
    labels: {},
    status: "exited",
    image: tagged,
  });
  await recordWritten(imageRecord, {
    [tagged]: {
      kinds: ["Job"],
      usedMs: startMs - 2 * dayMs,
      pulledId: fakeImageId(state, image),
    },
  });
  await backend.held();
  await backend.settled();
  assert.deepEqual(imageCalls(state), ["ls --quiet --no-trunc"]);
  assert.deepEqual([...state.images], [tagged, image]);
  assert.deepEqual(
    log.filter((line) => line.includes(" is kept")),
    [`${tagged} is kept: a container uses it`],
  );
});

const gib = 2 ** 30;

/**
 * A backend keeping a floor of 20 GiB, and its images' record, over a disk at
 * /var/lib/docker whose free bytes the suite sets; each cap it sets is the
 * suite's to pass, and none passes of itself.
 *
 * @param {import("node:test").TestContext} t
 * @param {Partial<import("./containerBackend.mjs").ContainerBackendSettings>} [overrides]
 */
async function floorHarness(t, overrides = {}) {
  const disk = {
    /** @type {import("./diskFloor.mjs").DiskFree | (() => Promise<import("./diskFloor.mjs").DiskFree>)} */
    answer: /** @type {import("./diskFloor.mjs").DiskFree} */ ({
      free: 30 * gib,
      where: "/var/lib/docker",
    }),
    /** @param {number} free */
    set: (free) => {
      disk.answer = { free, where: "/var/lib/docker" };
    },
    /** @param {number} bytes */
    freed: (bytes) => {
      if ("free" in disk.answer) disk.set(disk.answer.free + bytes);
    },
  };
  /** @type {(() => void)[]} */
  const caps = [];
  const context = await recordHarness(
    t,
    { diskFreeBytesMin: 20 * gib, ...overrides },
    {
      diskFree: async () =>
        typeof disk.answer === "function" ? disk.answer() : disk.answer,
      sleep: (_ms, signal) =>
        new Promise((resolve, reject) => {
          caps.push(() => resolve());
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    },
  );
  await mkdir(dirname(context.imageRecord), { recursive: true });
  await writeFile(
    context.imageRecord,
    JSON.stringify({
      version: 1,
      createdMs: startMs - 30 * dayMs,
      sweptMs: startMs,
      repositories: { [runtimeRepository]: { kinds: ["Runtime"] } },
      images: {},
      holds: {},
    }),
  );
  return { ...context, disk, caps };
}

/**
 * Each removal the engine makes frees `bytes` of the floor's disk.
 *
 * @param {Awaited<ReturnType<typeof floorHarness>>} context
 * @param {number} bytes
 */
function removalsFree(context, bytes) {
  context.state.intercept = (call) => {
    if (call.argv[0] === "image" && call.argv[1] === "rm")
      context.disk.freed(bytes);
    return undefined;
  };
}

/**
 * A running job seeded as a predecessor started it, `minutes` after the
 * harness's start, with a workspace volume of its own.
 *
 * @param {ReturnType<typeof fakeEngine>["state"]} state
 * @param {string} id
 * @param {number} minutes
 */
function runningJob(state, id, minutes) {
  const name = seeded(state, id, "running", startMs / 1000 + 3600);
  const container =
    /** @type {import("./engine.fixture.mjs").FakeContainer} */ (
      state.containers.get(name)
    );
  container.startedAt = new Date(startMs + minutes * 60_000).toISOString();
  container.labels["io.chuggy.workspace"] = `workspace-${id}`;
  state.volumes.set(`workspace-${id}`, { labels: {} });
  return name;
}

/** @param {readonly string[]} log */
const floorLines = (log) =>
  log.filter((line) => line.startsWith("this runner's"));

test("a backend given no measurement, or a floor of 0, keeps none and takes jobs", async (t) => {
  const unmeasured = await harness(t, { diskFreeBytesMin: 20 * gib });
  await unmeasured.backend.held();
  assert.equal(unmeasured.backend.jobsTaken(), true);
  let measured = 0;
  const off = await harness(
    t,
    { diskFreeBytesMin: 0 },
    {
      diskFree: async () => {
        measured += 1;
        return { free: 0, where: "/" };
      },
    },
  );
  await off.backend.held();
  assert.equal(off.backend.jobsTaken(), true);
  assert.equal(measured, 0);
  for (const diskFreeBytesMin of [-1, 1.5])
    assert.throws(
      () =>
        checkedContainerBackendSettings({
          ...unmeasured.settings,
          diskFreeBytesMin,
        }),
      /^RangeError: diskFreeBytesMin must be a whole number of bytes, 0 or more$/u,
    );
});

test("a backend given a floor and no record of its images still kills a job under half of it", async (t) => {
  const { backend, state } = await harness(
    t,
    { diskFreeBytesMin: 20 * gib },
    {
      diskFree: async () => ({ free: 5 * gib, where: "/var/lib/docker" }),
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    },
  );
  runningJob(state, "asg-1", 0);
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(
    state.calls
      .filter((call) => call.argv[0] === "kill")
      .map((call) => call.argv),
    [["kill", "id-asg-1"]],
  );
  assert.equal(backend.jobsTaken(), false);
});

test("a disk under its floor has a reclaim remove what it may, oldest first, until it is over, and says each way once", async (t) => {
  const context = await floorHarness(t);
  const { backend, state, log, disk } = context;
  const references = [
    runtimeHere(state, "1", 40),
    runtimeHere(state, "2", 30),
    runtimeHere(state, "3", 20),
  ];
  disk.set(15 * gib);
  removalsFree(context, 6 * gib);
  await backend.held();
  assert.equal(backend.jobsTaken(), true);
  assert.deepEqual(imageCalls(state), [
    "ls --quiet --no-trunc",
    `rm ${references[0]}`,
  ]);
  assert.deepEqual(floorLines(log), [
    "this runner's disk has 15 GiB free at /var/lib/docker, under its floor of 20 GiB: it takes no job until it is over",
    "this runner's disk has 21 GiB free at /var/lib/docker, over its floor of 20 GiB: it takes jobs again",
  ]);
});

test("a disk a reclaim leaves under its floor takes no job, whether the plane claims by room or not, with no line more, until a pass finds it over", async (t) => {
  const context = await floorHarness(t);
  const { backend, state, log, disk, clock } = context;
  const references = [
    runtimeHere(state, "1", 40),
    runtimeHere(state, "2", 30),
    runtimeHere(state, "3", 20),
  ];
  disk.set(12 * gib);
  removalsFree(context, gib);
  await backend.held();
  assert.equal(backend.jobsTaken(), false);
  assert.equal(backend.jobsTaken(true), false);
  assert.deepEqual([...state.images], [references[2]]);
  clock.nowMs += 1000;
  await backend.held();
  assert.equal(backend.jobsTaken(), false);
  disk.set(25 * gib);
  await backend.held();
  assert.equal(backend.jobsTaken(), true);
  assert.equal(backend.jobsTaken(true), true);
  assert.deepEqual(floorLines(log), [
    "this runner's disk has 12 GiB free at /var/lib/docker, under its floor of 20 GiB: it takes no job until it is over",
    "this runner's disk has 25 GiB free at /var/lib/docker, over its floor of 20 GiB: it takes jobs again",
  ]);
});

test("under half its floor, a reclaim that brings the disk back over half stops no job", async (t) => {
  const context = await floorHarness(t);
  const { backend, state, disk } = context;
  const references = [runtimeHere(state, "1", 40), runtimeHere(state, "2", 30)];
  runningJob(state, "asg-1", 0);
  disk.set(5 * gib);
  removalsFree(context, 6 * gib);
  assert.deepEqual(await backend.held(), listedJobs("asg-1"));
  assert.equal(backend.jobsTaken(), false);
  assert.deepEqual([...state.images], [references[1]]);
  assert.ok(state.calls.every((call) => call.argv[0] !== "kill"));
  assert.deepEqual(await backend.ended(), []);
});

test("under half its floor after the reclaim, the job holding most is killed, its logs saved and its volumes removed, and its end named disk low; never a session", async (t) => {
  const context = await floorHarness(t, { engine: "docker" });
  const { backend, state, log, disk, settings } = context;
  const most = runningJob(state, "asg-most", 0);
  runningJob(state, "asg-newer", 10);
  seeded(
    state,
    "asg-session",
    "running",
    startMs / 1000 + 3600,
    containerName(pool, "asg-session"),
    "Session",
  );
  disk.set(5 * gib);
  state.intercept = (call) =>
    call.argv[0] === "system"
      ? {
          code: 0,
          stdout: `${JSON.stringify({
            Images: [],
            Containers: [
              { ID: "id-asg-most", Size: "68B" },
              { ID: "id-asg-newer", Size: "2.3GB" },
              { ID: "id-asg-session", Size: "98.28GB" },
            ],
            Volumes: [
              { Name: "workspace-asg-most", Size: "60.12GB" },
              { Name: "workspace-asg-newer", Size: "1.5GB" },
              { Name: "owner-cache", Size: "N/A" },
            ],
            BuildCache: [],
          })}\n`,
          stderr: "",
        }
      : undefined;
  assert.deepEqual(await backend.held(), [
    ...listedJobs("asg-newer"),
    { assignment: "asg-session", kind: "Session", outlivesRunner: true },
  ]);
  assert.deepEqual(
    state.calls
      .filter((call) => call.argv[0] === "kill")
      .map((call) => call.argv),
    [["kill", "id-asg-most"]],
  );
  assert.ok(!state.containers.has(most));
  assert.ok(!state.volumes.has("workspace-asg-most"));
  assert.ok(state.volumes.has("workspace-asg-newer"));
  assert.equal(
    await readFile(join(settings.logDir, `${most}.log`), "utf8"),
    `the log of ${most}\n`,
  );
  assert.ok(
    log.includes(
      `${most} was killed for low disk; logs saved to ${join(settings.logDir, `${most}.log`)}, container removed`,
    ),
  );
  assert.deepEqual(await backend.ended(), [
    {
      kind: "Job",
      job: seededAttempt("asg-most"),
      why: "its container was killed because this runner's disk had 5 GiB free at /var/lib/docker, under half its floor of 20 GiB. Free space on this runner, then resume the ticket",
      killed: "DiskLow",
    },
  ]);
  assert.equal(backend.jobsTaken(), false);
});

for (const [engine, answer] of [
  ["podman", undefined],
  ["docker", { code: 1, stdout: "", stderr: "Error: i/o timeout\n" }],
  ["docker", { code: 0, stdout: "not json\n", stderr: "" }],
])
  test(`under half its floor on ${engine}${answer === undefined ? "" : ` answering ${answer.stdout || answer.stderr}`.trimEnd()}, the newest job is killed`, async (t) => {
    const context = await floorHarness(t, {
      engine: /** @type {"docker" | "podman"} */ (engine),
    });
    const { backend, state, disk } = context;
    runningJob(state, "asg-older", 0);
    runningJob(state, "asg-newest", 10);
    runningJob(state, "asg-old", 5);
    disk.set(5 * gib);
    state.intercept = (call) =>
      call.argv[0] === "system" ? answer : undefined;
    assert.deepEqual(await backend.held(), listedJobs("asg-older", "asg-old"));
    assert.deepEqual(
      state.calls
        .filter((call) => call.argv[0] === "kill")
        .map((call) => call.argv),
      [["kill", "id-asg-newest"]],
    );
    assert.equal(
      state.calls.some((call) => call.argv[0] === "system"),
      engine === "docker",
    );
  });

test("a reclaim is begun at most once an interval between the floor and half of it, and under half on every pass, before each kill", async (t) => {
  const context = await floorHarness(t);
  const { backend, state, clock, disk } = context;
  runningJob(state, "asg-1", 0);
  runningJob(state, "asg-2", 10);
  const made = () =>
    state.calls.flatMap((call) =>
      call.argv[0] === "kill"
        ? ["kill"]
        : call.argv[0] === "image" && call.argv[1] === "ls"
          ? ["reclaim"]
          : [],
    );
  disk.set(15 * gib);
  await backend.held();
  clock.nowMs += diskReclaimIntervalMs - 1;
  await backend.held();
  assert.deepEqual(made(), ["reclaim"]);
  clock.nowMs += 1;
  await backend.held();
  assert.deepEqual(made(), ["reclaim", "reclaim"]);
  disk.set(5 * gib);
  await backend.held();
  clock.nowMs += 1;
  await backend.held();
  assert.deepEqual(made(), [
    "reclaim",
    "reclaim",
    "reclaim",
    "kill",
    "reclaim",
    "kill",
  ]);
});

test("under half its floor, a later pass reclaims what the job it killed left, and once back over half kills no other", async (t) => {
  const context = await floorHarness(t);
  const { backend, state, clock, disk } = context;
  const references = [runtimeHere(state, "1", 40), runtimeHere(state, "2", 30)];
  const killed = runningJob(state, "asg-killed", 10);
  /** @type {import("./engine.fixture.mjs").FakeContainer} */ (
    state.containers.get(killed)
  ).image = references[0];
  runningJob(state, "asg-kept", 0);
  removalsFree(context, 6 * gib);
  disk.set(8 * gib);
  assert.deepEqual(await backend.held(), listedJobs("asg-kept"));
  assert.ok(state.images.has(references[0]));
  clock.nowMs += 25_000;
  assert.deepEqual(await backend.held(), listedJobs("asg-kept"));
  assert.deepEqual(
    state.calls
      .filter((call) => call.argv[0] === "kill")
      .map((call) => call.argv),
    [["kill", "id-asg-killed"]],
  );
  assert.deepEqual([...state.images], [references[1]]);
  assert.equal(backend.jobsTaken(), false);
});

test("a reclaim that could not begin before its cap, behind a sweep it aborted, stops no job and counts as none, and the sweep removes nothing more", async (t) => {
  for (const [free, killing] of /** @type {const} */ ([
    [5, true],
    [15, false],
  ])) {
    const context = await floorHarness(t);
    const { backend, state, clock, disk, caps } = context;
    const references = [
      runtimeHere(state, "1", 40),
      runtimeHere(state, "2", 30),
      runtimeHere(state, "3", 20),
    ];
    runningJob(state, "asg-1", 0);
    await recordWritten(context.imageRecord);
    disk.set(free * gib);
    const listing = deferred();
    state.intercept = (call) =>
      call.argv[0] === "image" && call.argv[1] === "ls"
        ? listing.promise
        : undefined;
    const pass = backend.held();
    while (caps.length < 2) await setImmediate();
    caps[1]?.();
    assert.deepEqual(await pass, listedJobs("asg-1"), String(free));
    state.intercept = () => undefined;
    listing.resolve({
      code: 0,
      stdout: references
        .map((reference) => `${fakeImageId(state, reference)}\n`)
        .join(""),
      stderr: "",
    });
    await backend.settled();
    assert.deepEqual(
      imageCalls(state),
      ["ls --quiet --no-trunc"],
      String(free),
    );
    assert.deepEqual([...state.images], references, String(free));
    clock.nowMs += 1;
    assert.deepEqual(
      await backend.held(),
      killing ? [] : listedJobs("asg-1"),
      String(free),
    );
    assert.deepEqual([...state.images], [references[2]], String(free));
    assert.deepEqual(
      state.calls
        .filter((call) => call.argv[0] === "kill")
        .map((call) => call.argv),
      killing ? [["kill", "id-asg-1"]] : [],
      String(free),
    );
  }
});

test("an image a container uses is said kept once each time the disk goes under its floor, however often a reclaim tries it", async (t) => {
  const context = await floorHarness(t);
  const { backend, state, clock, disk, log } = context;
  const references = [runtimeHere(state, "1", 40), runtimeHere(state, "2", 30)];
  const user = seeded(state, "asg-2", "running", startMs / 1000 + 3600);
  /** @type {import("./engine.fixture.mjs").FakeContainer} */ (
    state.containers.get(user)
  ).image = references[0];
  const kept = () =>
    log.filter(
      (line) => line === `${references[0]} is kept: a container uses it`,
    ).length;
  disk.set(15 * gib);
  await backend.held();
  clock.nowMs += diskReclaimIntervalMs;
  await backend.held();
  assert.equal(kept(), 1);
  disk.set(25 * gib);
  await backend.held();
  disk.set(15 * gib);
  clock.nowMs += diskReclaimIntervalMs;
  await backend.held();
  assert.equal(kept(), 2);
  assert.ok(state.images.has(references[0]));
});

test("a measurement unknown, or that fails, holds no floor, reclaims nothing and is said once", async (t) => {
  const { backend, state, disk, log } = await floorHarness(t);
  disk.answer = {
    unknown: "docker's daemon runs in a VM, whose disk this runner cannot see",
  };
  await backend.held();
  assert.equal(backend.jobsTaken(), true);
  disk.answer = async () => {
    throw new Error("EACCES: permission denied, statfs '/var/lib/docker'");
  };
  await backend.held();
  await backend.settled();
  assert.deepEqual(imageCalls(state), []);
  disk.set(5 * gib);
  await backend.held();
  assert.deepEqual(floorLines(log), [
    "this runner's free disk could not be measured, so it holds no floor: docker's daemon runs in a VM, whose disk this runner cannot see",
    "this runner's disk has 5 GiB free at /var/lib/docker, under its floor of 20 GiB: it takes no job until it is over",
  ]);
  assert.equal(backend.jobsTaken(), false);
});

test("a measurement unknown once a reclaim is done holds no floor either, and is said", async (t) => {
  const { backend, disk, log } = await floorHarness(t);
  let measured = 0;
  disk.answer = async () => {
    measured += 1;
    return measured === 1
      ? { free: 15 * gib, where: "/var/lib/docker" }
      : { unknown: "docker could not be asked where it stores what it holds" };
  };
  await backend.held();
  assert.equal(backend.jobsTaken(), true);
  assert.deepEqual(floorLines(log), [
    "this runner's disk has 15 GiB free at /var/lib/docker, under its floor of 20 GiB: it takes no job until it is over",
    "this runner's free disk could not be measured, so it holds no floor: docker could not be asked where it stores what it holds",
  ]);
});

test("a reclaim that has not answered by its cap is left, aborted, and the pass goes on to measure and kill", async (t) => {
  const context = await floorHarness(t);
  const { backend, state, disk, caps } = context;
  const references = [runtimeHere(state, "1", 40), runtimeHere(state, "2", 30)];
  runningJob(state, "asg-1", 0);
  disk.set(5 * gib);
  const listing = deferred();
  state.intercept = (call) =>
    call.argv[0] === "image" && call.argv[1] === "ls"
      ? listing.promise
      : undefined;
  const pass = backend.held();
  while (
    !state.calls.some(
      (call) => call.argv[0] === "image" && call.argv[1] === "ls",
    )
  )
    await setImmediate();
  caps.at(-1)?.();
  assert.deepEqual(await pass, []);
  assert.deepEqual(
    state.calls
      .filter((call) => call.argv[0] === "kill")
      .map((call) => call.argv),
    [["kill", "id-asg-1"]],
  );
  listing.resolve({
    code: 0,
    stdout: [
      ...new Set(references.map((reference) => fakeImageId(state, reference))),
    ]
      .map((id) => `${id}\n`)
      .join(""),
    stderr: "",
  });
  await backend.settled();
  assert.deepEqual(imageCalls(state), ["ls --quiet --no-trunc"]);
  assert.deepEqual([...state.images], references);
});

test("an ended container whose logs could not be saved is removed without them once kept past the dwell, and its end named once", async (t) => {
  const { backend, state, clock, log } = await harness(t);
  const name = seeded(state, "asg-done", "exited", startMs / 1000 + 60);
  state.logsFail = true;
  assert.deepEqual(await backend.held(), []);
  clock.nowMs += logSaveFailureDwellMs - 1;
  assert.deepEqual(await backend.held(), []);
  assert.equal(state.containers.size, 1);
  clock.nowMs += 1;
  assert.deepEqual(await backend.held(), []);
  assert.equal(state.containers.size, 0);
  assert.deepEqual(log.slice(-2), [
    `${name} ended; its logs could not be saved since ${new Date(startMs).toISOString()}, and are lost with it: podman logs exited 1`,
    `${name} ended; logs lost, container removed`,
  ]);
  assert.equal((await backend.ended()).length, 1);
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(await backend.ended(), []);
});

test("logs that could not be saved are said to by how the engine's call ended, never by what it printed", async (t) => {
  const { backend, state, log } = await harness(t);
  const name = seeded(state, "asg-done", "exited", startMs / 1000 + 60);
  state.logsFail = true;
  state.logsStderr = [
    "Error: push refused for https://x:SECRET@host/r",
    "error from daemon in stream: Error grabbing logs: invalid character",
  ].join("\n");
  assert.deepEqual(await backend.held(), []);
  assert.equal(
    log.at(-1),
    `${name} ended; its logs could not be saved: podman logs exited 1`,
  );
  assert.ok(log.every((line) => !line.includes("SECRET")));
});

test("a log directory that cannot be written is a save that failed, and keeps the container", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-logs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "file"), "");
  const { backend, state, log } = await harness(t, {
    logDir: join(directory, "file", "logs"),
  });
  seeded(state, "asg-done", "exited", startMs / 1000 + 60);
  assert.deepEqual(await backend.held(), []);
  assert.equal(state.containers.size, 1);
  assert.match(
    log.at(-1) ?? "",
    /ended; its logs could not be saved: ENOTDIR/u,
  );
});

test("a log longer than a saved log's bound is saved as its end, opening with the line saying so", async (t) => {
  for (const [log, end] of [
    ["l\n".repeat(savedLogLinesMax + 5), "l\n".repeat(savedLogLinesMax)],
    [`${"x".repeat(savedLogBytesMax)}\nend\n`, "end\n"],
  ]) {
    const { backend, state, settings } = await harness(t);
    const name = seeded(state, "asg-done", "exited", startMs / 1000 + 60);
    const container =
      /** @type {import("./engine.fixture.mjs").FakeContainer} */ (
        state.containers.get(name)
      );
    container.log = log;
    await backend.held();
    assert.equal(
      await readFile(join(settings.logDir, `${name}.log`), "utf8"),
      `${savedLogCutLine}${end}`,
    );
  }
});

const memoryGib = 2 ** 30;

/**
 * A backend keeping 2 GiB of its fake engine's memory free, whose held job's
 * every check waits for `checked()`, which moves its clock on by the wait.
 *
 * @param {import("node:test").TestContext} t
 * @param {Partial<import("./containerBackend.mjs").ContainerBackendSettings>} [overrides]
 * @param {Partial<import("./containerBackend.mjs").ContainerBackendSeams>} [seams]
 * @param {string} [lockFile] another backend's, which shares its engine through `seams`
 */
async function memoryHarness(t, overrides = {}, seams = {}, lockFile) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-memory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  /** @type {(() => void)[]} */
  const waits = [];
  const memoryLock = lockFile ?? join(directory, "memory", "podman.lock");
  const context = await harness(
    t,
    { memoryFreeBytesMin: 2 * memoryGib, memoryLock, ...overrides },
    {
      sleep: (ms, signal) =>
        new Promise((resolve, reject) => {
          waits.push(() => {
            context.clock.nowMs += ms;
            resolve();
          });
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      ...seams,
    },
  );
  context.state.images.add(image);
  return {
    ...context,
    memoryLock,
    /** Ends one held check's wait. */
    checked: () => waits.shift()?.(),
    waiting: () => waits.length,
  };
}

/**
 * Waits, in real time, since the memory lock is polled in it, until `ready`.
 *
 * @param {() => boolean} ready
 */
async function until(ready) {
  for (let tries = 0; tries < 1000; tries += 1) {
    if (ready()) return;
    await waited(5);
  }
  assert.fail("what the test waited for never came");
}

/**
 * A running container on the engine, labelled as given and capped where a
 * cap is given.
 *
 * @param {ReturnType<typeof fakeEngine>["state"]} state
 * @param {string} name
 * @param {{labels?: Record<string, string>, memoryBytes?: number, usedBytes?: number}} what
 */
function occupied(state, name, what) {
  state.containers.set(name, {
    id: `id-${name}`,
    name,
    status: "running",
    image: "registry.example/other",
    labels: what.labels ?? {},
    memoryBytes: what.memoryBytes ?? 0,
    usedBytes: what.usedBytes ?? 0,
  });
}

const otherPool = { tenant: "vteng", project: "chuggy", pool: "other" };

/** @param {ReturnType<typeof fakeEngine>["state"]} state */
const holdNames = (state) =>
  [...state.volumes.entries()]
    .filter(([, volume]) => volume.labels["io.chuggy.held"] !== undefined)
    .map(([name]) => name);

/** @param {ReturnType<typeof fakeEngine>["state"]} state */
const runningWorkloads = (state) =>
  [...state.containers.values()]
    .filter(
      (container) =>
        container.status === "running" &&
        container.labels["io.chuggy.kind"] === "Job",
    )
    .map(({ name }) => name);

test("a pass counts every service's workloads at their caps, sessions among them, and everything else at its use", async (t) => {
  const { backend, state } = await memoryHarness(t);
  occupied(state, "chuggy-other-job", {
    labels: { "io.chuggy.pool": "vteng/chuggy/other", "io.chuggy.kind": "Job" },
    memoryBytes: 4 * memoryGib,
  });
  occupied(state, "chuggy-shame-session", {
    labels: {
      "io.chuggy.pool": "vteng/chuggy/shame",
      "io.chuggy.kind": "Session",
    },
    memoryBytes: 4 * memoryGib,
  });
  occupied(state, "chuggy-jobs-postgres", { usedBytes: 5.5 * memoryGib });
  await backend.held();
  assert.equal(backend.jobsTaken(), true);

  occupied(state, "chuggy-jobs-postgres", {
    usedBytes: 5.5 * memoryGib + 2 ** 20,
  });
  await backend.held();
  assert.equal(backend.jobsTaken(), false);
});

test("a pass's room is what its own placements will take less, and no job is taken while it is under the least a job asks", async (t) => {
  const { backend, state, log } = await memoryHarness(t);
  occupied(state, "chuggy-jobs-postgres", { usedBytes: 9 * memoryGib });
  const pull = deferred();
  state.pull = () => pull.promise;
  state.images.delete(image);
  await backend.place(assignment({ memoryMib: 4096 }), "Job");
  await setImmediate();
  await backend.held();
  assert.equal(backend.jobsTaken(), true);
  await backend.place(
    assignment({ assignment: "asg-2", memoryMib: 1024 }),
    "Session",
  );
  await backend.held();
  assert.equal(backend.jobsTaken(), false);
  assert.deepEqual(
    log.filter((line) => line.startsWith("this engine")),
    [
      "this engine has 0 GiB of room in its 14 GiB memory budget, under the 0.5 GiB a job needs: this runner takes no job until it has more",
    ],
  );
  pull.resolve({ code: 1, stdout: "", stderr: "Error: no such image\n" });
  await backend.settled();
});

test("a job that does not fit the room is held from its placement, and is started once a later check finds room, its deadline counted from its start", async (t) => {
  const { backend, state, clock, log, checked, waiting } =
    await memoryHarness(t);
  occupied(state, "chuggy-jobs-postgres", { usedBytes: 8 * memoryGib });
  await backend.held();
  let moved = false;
  state.intercept = () => {
    if (!moved) clock.nowMs += 10_000;
    moved = true;
    return undefined;
  };
  await backend.place(assignment({ memoryMib: 8192 }), "Job");
  await until(() => waiting() === 1);

  const name = containerName(pool, "asg-1");
  assert.deepEqual(backend.inFlight(), [
    {
      assignment: "asg-1",
      kind: "Job",
      name,
      image,
      phase: "Held",
      deadlineEpochSecs: startMs / 1000 + 3600,
      memoryMib: 8192,
      waiting: "needs 8 GiB, room 6 GiB",
    },
  ]);
  assert.deepEqual(holdNames(state), [`${name}-held`]);
  assert.deepEqual(state.volumes.get(`${name}-held`)?.labels, {
    "io.chuggy.held": "vteng/chuggy/shame",
    "io.chuggy.assignment": "asg-1",
    "io.chuggy.held.memory-mib": "8192",
    "io.chuggy.held.since-ms": String(startMs),
    "io.chuggy.held.pid": String(process.pid),
    "io.chuggy.held.until-ms": String(startMs + 3600 * 1000),
    "io.chuggy.held.starting": "false",
  });
  assert.deepEqual(await backend.held(), heldJobs("asg-1"));
  assert.equal(backend.jobsTaken(), false);
  assert.ok(!state.calls.some((call) => call.argv[0] === "run"));

  checked();
  await until(() => waiting() === 1);
  assert.ok(!state.calls.some((call) => call.argv[0] === "run"));

  state.containers.delete("chuggy-jobs-postgres");
  checked();
  await backend.settled();
  assert.deepEqual(runningWorkloads(state), [name]);
  assert.equal(
    state.containers.get(name)?.labels["io.chuggy.deadline"],
    String(startMs / 1000 + 10 + 30 + 3600),
  );
  assert.deepEqual(holdNames(state), []);
  assert.deepEqual(
    log.filter((line) => line.startsWith(name)),
    [
      `${name} is held for room on this engine: needs 8 GiB, room 6 GiB`,
      `${name} started`,
    ],
  );
  await backend.held();
  assert.equal(backend.jobsTaken(), true);
});

test("another service's hold is counted against this one's room, and neither takes a job while either holds one", async (t) => {
  const first = await memoryHarness(t);
  const second = await memoryHarness(
    t,
    { pool: otherPool },
    { engine: first.engine },
    first.memoryLock,
  );
  await first.engine.exec(
    heldCreateArgv({
      name: "chuggy-third-later-held",
      pool: "vteng/chuggy/third",
      assignment: "asg-later",
      memoryMib: 6144,
      heldMs: startMs + 1,
      pid: process.pid,
      untilMs: startMs + 3600 * 1000,
      starting: false,
    }),
  );
  await first.backend.held();
  await second.backend.held();
  assert.equal(first.backend.jobsTaken(), false);
  assert.equal(second.backend.jobsTaken(), false);

  await first.backend.place(assignment({ memoryMib: 10240 }), "Job");
  await until(() => first.waiting() === 1);
  assert.equal(
    first.backend.inFlight()[0]?.waiting,
    "needs 10 GiB, room 8 GiB",
  );
  first.backend.stop("asg-1");
  await first.backend.settled();
});

test("two services starting into the same room start one, and the other is held behind its hold until there is room", async (t) => {
  const first = await memoryHarness(t);
  const second = await memoryHarness(
    t,
    { pool: otherPool },
    { engine: first.engine },
    first.memoryLock,
  );
  const { state } = first;
  second.state.images.delete(image);
  await first.backend.held();
  await second.backend.held();
  await Promise.all([
    first.backend.place(assignment({ memoryMib: 8192 }), "Job"),
    second.backend.place(
      assignment({ assignment: "asg-2", memoryMib: 8192 }),
      "Job",
    ),
  ]);
  await until(() => first.waiting() + second.waiting() === 1);
  const [held] = [first, second].filter(({ waiting }) => waiting() === 1);
  const [ran] = [first, second].filter(({ waiting }) => waiting() === 0);
  assert.ok(held !== undefined && ran !== undefined);
  await ran.backend.settled();
  assert.equal(runningWorkloads(state).length, 1);
  assert.equal(held.backend.inFlight()[0]?.phase, "Held");
  assert.equal(holdNames(state).length, 1);
  await held.backend.held();
  assert.equal(held.backend.jobsTaken(), false);

  held.checked();
  await until(() => held.waiting() === 1);
  assert.equal(runningWorkloads(state).length, 1);

  const [started] = runningWorkloads(state);
  const container = state.containers.get(started ?? "");
  if (container !== undefined) container.status = "exited";
  held.checked();
  await held.backend.settled();
  assert.equal(runningWorkloads(state).length, 1);
  assert.deepEqual(holdNames(state), []);
});

test("a job asking more than the memory budget is refused, naming it, and one within it is placed", async (t) => {
  const { backend } = await memoryHarness(t);
  await backend.held();
  assert.deepEqual(
    await backend.place(assignment({ memoryMib: 14337 }), "Job"),
    {
      placed: "Refused",
      evidence:
        "the assignment asks for 14337 MiB and this runner's memory budget is 14336 MiB: the engine's 16384 MiB less the 2048 MiB this runner keeps free",
    },
  );
  assert.deepEqual(
    await backend.place(
      assignment({ assignment: "asg-2", memoryMib: 14336 }),
      "Job",
    ),
    { placed: "Placed" },
  );
  await backend.settled();
});

test("a job is held from its placement, before its image is pulled: as starting where it fits the room, and as held for room behind it where it does not", async (t) => {
  const { backend, state } = await memoryHarness(t);
  occupied(state, "chuggy-jobs-postgres", { usedBytes: 6 * memoryGib });
  state.images.delete(image);
  const pull = deferred();
  /** @type {Record<string, string | undefined>[]} */
  const heldAtPull = [];
  state.pull = () => {
    heldAtPull.push(
      Object.fromEntries(
        holdNames(state).map((name) => [
          name,
          state.volumes.get(name)?.labels["io.chuggy.held.starting"],
        ]),
      ),
    );
    return pull.promise;
  };
  await backend.held();
  await backend.place(assignment({ memoryMib: 4096 }), "Job");
  const first = `${containerName(pool, "asg-1")}-held`;
  assert.deepEqual(holdNames(state), [first]);
  await backend.place(
    assignment({ assignment: "asg-2", memoryMib: 6144 }),
    "Job",
  );
  const second = `${containerName(pool, "asg-2")}-held`;
  await until(() => heldAtPull.length === 2);
  assert.deepEqual(heldAtPull, [
    { [first]: "true" },
    { [first]: "true", [second]: "false" },
  ]);
  await backend.held();
  assert.equal(backend.jobsTaken(), false);
  assert.equal(backend.jobsTaken(true), true);
  assert.deepEqual(backend.memoryRoom(), { roomMib: 0, ceilingMib: 14 * 1024 });
  for (const placement of ["asg-1", "asg-2"]) backend.stop(placement);
  pull.resolve({ code: 1, stdout: "", stderr: "Error: no such image\n" });
  await backend.settled();
  assert.deepEqual(holdNames(state), []);
});

test("a poll is told the room less what this runner places with no hold, and the budget less what it reserves from jobs", async (t) => {
  const { backend, state } = await memoryHarness(t, {
    memoryReservedBytes: 4 * memoryGib,
  });
  assert.deepEqual(backend.memoryRoom(), { roomMib: 0 });
  occupied(state, "chuggy-jobs-postgres", { usedBytes: 3 * memoryGib });
  const pull = deferred();
  state.pull = () => pull.promise;
  state.images.delete(image);
  await backend.place(assignment({ memoryMib: 1024 }), "Session");
  await backend.held();
  assert.deepEqual(backend.memoryRoom(), {
    roomMib: 10 * 1024,
    ceilingMib: 10 * 1024,
  });
  backend.stop("asg-1");
  pull.resolve({ code: 1, stdout: "", stderr: "Error: no such image\n" });
  await backend.settled();

  const none = await harness(t);
  assert.equal(none.backend.memoryRoom(), undefined);
});

test("a job asking past the budget less what this runner reserves is refused, naming both, its ceiling none where the reserve passes the budget, and a session asking within the budget is placed", async (t) => {
  const { backend } = await memoryHarness(t, {
    memoryReservedBytes: 4 * memoryGib,
  });
  await backend.held();
  assert.deepEqual(
    await backend.place(assignment({ memoryMib: 10241 }), "Job"),
    {
      placed: "Refused",
      evidence:
        "the assignment asks for 10241 MiB and this runner's ceiling for a job is 10240 MiB: its memory budget of 14336 MiB less the 4096 MiB it reserves",
    },
  );
  assert.deepEqual(
    await backend.place(
      assignment({ assignment: "asg-2", memoryMib: 14336 }),
      "Session",
    ),
    { placed: "Placed" },
  );
  assert.deepEqual(
    await backend.place(
      assignment({ assignment: "asg-3", memoryMib: 14337 }),
      "Session",
    ),
    {
      placed: "Refused",
      evidence:
        "the assignment asks for 14337 MiB and this runner's memory budget is 14336 MiB: the engine's 16384 MiB less the 2048 MiB this runner keeps free",
    },
  );
  await backend.settled();

  const reservedPast = await memoryHarness(t, {
    memoryReservedBytes: 15 * memoryGib,
  });
  await reservedPast.backend.held();
  assert.deepEqual(
    await reservedPast.backend.place(assignment({ memoryMib: 1 }), "Job"),
    {
      placed: "Refused",
      evidence:
        "the assignment asks for 1 MiB and this runner's ceiling for a job is 0 MiB: its memory budget of 14336 MiB less the 15360 MiB it reserves",
    },
  );
});

test("a job whose hold could not be made at its claim is counted as placing", async (t) => {
  const { backend, state } = await memoryHarness(t);
  const name = containerName(pool, "asg-1");
  state.intercept = (call) =>
    call.argv[1] === "create" && call.argv.at(-1) === `${name}-held`
      ? { code: 1, stdout: "", stderr: "Error: no space left on device\n" }
      : undefined;
  const pull = deferred();
  state.pull = () => pull.promise;
  state.images.delete(image);
  await backend.held();
  await backend.place(assignment({ memoryMib: 4096 }), "Job");
  await backend.held();
  assert.deepEqual(holdNames(state), []);
  assert.deepEqual(backend.memoryRoom(), {
    roomMib: 10 * 1024,
    ceilingMib: 14 * 1024,
  });
  backend.stop("asg-1");
  pull.resolve({ code: 1, stdout: "", stderr: "Error: no such image\n" });
  await backend.settled();
});

test("a job too late to start at its claim makes no hold, and fails without running", async (t) => {
  const { backend, state, clock, log } = await memoryHarness(t);
  const name = containerName(pool, "asg-1");
  await backend.held();
  state.intercept = (call) => {
    if (call.argv[0] === "info")
      clock.nowMs = startMs + 3600 * 1000 - memoryStartCutMs;
    return undefined;
  };
  await backend.place(assignment(), "Job");
  await backend.settled();
  assert.ok(!state.calls.some((call) => call.argv.at(-1) === `${name}-held`));
  assert.ok(!state.calls.some((call) => call.argv[0] === "run"));
  assert.ok(
    log.includes(
      `${name} was not started: it could not start before the assignment's deadline`,
    ),
    log.join("\n"),
  );
});

test("a backend takes the claim only where it keeps a budget and is given the claim lock, one backend at a time", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-claim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const memoryClaimLock = join(directory, "claim", "podman.claim");
  const first = await memoryHarness(t, { memoryClaimLock });
  const second = await memoryHarness(
    t,
    { pool: otherPool, memoryClaimLock },
    { engine: first.engine },
    first.memoryLock,
  );
  const release = await first.backend.claimed?.();
  assert.ok(release !== undefined);
  assert.equal(await second.backend.claimed?.(), undefined);
  await release();
  const again = await second.backend.claimed?.();
  assert.ok(again !== undefined);
  await again();

  assert.equal((await memoryHarness(t)).backend.claimed, undefined);
  assert.equal(
    (await harness(t, { memoryClaimLock })).backend.claimed,
    undefined,
  );
});

test("a held job stopped, or too near its deadline to start, leaves no hold", async (t) => {
  const { backend, state, log, checked, waiting } = await memoryHarness(t);
  occupied(state, "chuggy-jobs-postgres", { usedBytes: 12 * memoryGib });
  await backend.held();
  await backend.place(assignment({ memoryMib: 4096 }), "Job");
  await until(() => waiting() === 1);
  assert.equal(holdNames(state).length, 1);
  assert.deepEqual(await backend.stop("asg-1"), { stopped: "Stopped" });
  assert.deepEqual(holdNames(state), []);
  const name = containerName(pool, "asg-1");
  assert.ok(log.includes(`${name} was stopped before it started`));

  await backend.place(
    assignment({ assignment: "asg-2", memoryMib: 4096, deadlineSecs: 70 }),
    "Job",
  );
  await until(() => waiting() === 1);
  checked();
  await until(() => waiting() === 1);
  checked();
  await until(() => waiting() === 1);
  checked();
  await backend.settled();
  assert.deepEqual(holdNames(state), []);
  assert.ok(
    log.includes(
      `${containerName(pool, "asg-2")} was not started: it had no room on this engine by the assignment's deadline`,
    ),
    log.join("\n"),
  );
});

test("a hold whose runner is no longer running, or whose deadline has passed, is not counted and is removed, and one of this pool's no placement makes is removed", async (t) => {
  const { backend, engine, state, log } = await memoryHarness(
    t,
    {},
    { holderAlive: (pid) => pid !== 4242 },
  );
  for (const [name, holder, ownPool, untilMs] of /** @type {const} */ ([
    ["chuggy-other-gone-held", 4242, "vteng/chuggy/other", startMs + 1],
    ["chuggy-other-late-held", process.pid, "vteng/chuggy/other", startMs],
    ["chuggy-shame-left-held", process.pid, "vteng/chuggy/shame", startMs + 1],
    ["chuggy-other-live-held", process.pid, "vteng/chuggy/other", startMs + 1],
  ]))
    await engine.exec(
      heldCreateArgv({
        name,
        pool: ownPool,
        assignment: `asg-${name}`,
        memoryMib: 1024,
        heldMs: startMs,
        pid: holder,
        untilMs,
        starting: false,
      }),
    );
  await backend.held();
  assert.deepEqual(holdNames(state), ["chuggy-other-live-held"]);
  assert.deepEqual(
    log.filter((line) => line.startsWith("the hold")),
    [
      "the hold chuggy-other-gone-held, whose runner is no longer running or whose deadline has passed, was removed",
      "the hold chuggy-other-late-held, whose runner is no longer running or whose deadline has passed, was removed",
      "the hold chuggy-shame-left-held, which no placement of this runner's makes, was removed",
    ],
  );
  assert.equal(backend.jobsTaken(), false);
  state.volumes.delete("chuggy-other-live-held");
  await backend.held();
  assert.equal(backend.jobsTaken(), true);
});

test("a count the engine does not answer in time takes no job and starts none", async (t) => {
  const { backend, state, log, waiting } = await memoryHarness(t);
  occupied(state, "chuggy-jobs-postgres", { usedBytes: memoryGib });
  state.intercept = (call) =>
    call.argv[0] === "stats"
      ? Promise.reject(
          Object.assign(new Error("The operation was aborted"), {
            name: "AbortError",
          }),
        )
      : undefined;
  await backend.held();
  assert.equal(backend.jobsTaken(), false);
  await backend.place(assignment(), "Job");
  await until(() => waiting() === 1);
  assert.equal(
    backend.inFlight()[0]?.waiting,
    "the engine's memory could not be counted: podman did not answer in time",
  );
  assert.ok(
    log.includes(
      "this engine's memory could not be counted, so this runner takes no job: podman did not answer in time",
    ),
  );
  await backend.stop("asg-1");
  await backend.settled();
});

test("where the engine refuses its stats, what no runner capped counts as none, which is logged once, and jobs are taken and started into what is left", async (t) => {
  const { backend, state, log } = await memoryHarness(t);
  occupied(state, "chuggy-jobs-postgres", { usedBytes: 15 * memoryGib });
  occupied(state, "chuggy-other-job", {
    labels: { "io.chuggy.pool": "vteng/chuggy/other", "io.chuggy.kind": "Job" },
    memoryBytes: 6 * memoryGib,
  });
  state.intercept = (call) =>
    call.argv[0] === "stats"
      ? {
          code: 125,
          stdout: "",
          stderr: "Error: cgroups v1 is not supported\n",
        }
      : undefined;
  await backend.held();
  await backend.held();
  assert.equal(backend.jobsTaken(), true);
  await backend.place(assignment({ memoryMib: 8192 }), "Job");
  await backend.settled();
  assert.deepEqual(runningWorkloads(state), [
    "chuggy-other-job",
    containerName(pool, "asg-1"),
  ]);
  assert.deepEqual(
    log.filter((line) => line.startsWith("this engine")),
    [
      "this engine's containers no runner capped are counted as using no memory, since podman could not say what its containers use: Error: cgroups v1 is not supported",
    ],
  );
});

test("a job placed again once its container runs is counted by that container, makes no hold and starts however full the engine is", async (t) => {
  const { backend, state, log, waiting } = await memoryHarness(t);
  await backend.held();
  await backend.place(assignment({ memoryMib: 8192 }), "Job");
  await backend.settled();
  occupied(state, "chuggy-jobs-postgres", { usedBytes: 8 * memoryGib });
  const made = state.calls.length;
  await backend.place(assignment({ memoryMib: 8192 }), "Job");
  await until(
    () => waiting() === 1 || /was already running$/u.test(log.at(-1) ?? ""),
  );
  assert.equal(waiting(), 0, backend.inFlight()[0]?.waiting);
  await backend.settled();
  assert.ok(
    !state.calls
      .slice(made)
      .some((call) => call.argv[0] === "volume" && call.argv[1] === "create"),
  );
  assert.deepEqual(holdNames(state), []);
});

test("a job is counted by its hold until its container has started, however long the start takes, and a pass meanwhile counts it at its cap and says nothing", async (t) => {
  const { backend, engine, state, log } = await memoryHarness(t);
  const name = containerName(pool, "asg-1");
  /** @type {string[][]} */
  const heldAtRun = [];
  /** @type {[boolean, number | undefined][]} */
  const takenAtRun = [];
  state.intercept = (call) => {
    if (call.argv[0] !== "run" || heldAtRun.length > 0) return undefined;
    heldAtRun.push(holdNames(state));
    return (async () => {
      await backend.held();
      takenAtRun.push([backend.jobsTaken(), backend.memoryRoom()?.roomMib]);
      return engine.exec(call.argv);
    })();
  };
  await backend.held();
  await backend.place(assignment({ memoryMib: 4096 }), "Job");
  await backend.settled();
  assert.deepEqual(heldAtRun, [[`${name}-held`]]);
  assert.deepEqual(takenAtRun, [[true, 10 * 1024]]);
  assert.deepEqual(runningWorkloads(state), [name]);
  assert.deepEqual(holdNames(state), []);
  await backend.held();
  assert.equal(backend.jobsTaken(), true);
  assert.deepEqual(
    log.filter((line) => line.startsWith("this engine")),
    [],
  );
});

test("a job too near its deadline to start fails, so another service's count never finds its hold past that deadline while it starts, and the other's job alone takes the room", async (t) => {
  const first = await memoryHarness(t);
  const second = await memoryHarness(
    t,
    { pool: otherPool },
    { engine: first.engine, nowMs: () => first.clock.nowMs },
    first.memoryLock,
  );
  const { state } = first;
  occupied(state, "chuggy-jobs-postgres", { usedBytes: 8 * memoryGib });
  await first.backend.held();
  await second.backend.held();
  await first.backend.place(
    assignment({ memoryMib: 8192, deadlineSecs: 50 }),
    "Job",
  );
  await until(() => first.waiting() === 1);
  first.checked();
  await until(() => first.waiting() === 1);
  state.containers.delete("chuggy-jobs-postgres");
  const other = async () => {
    await second.backend.place(
      assignment({ assignment: "asg-2", memoryMib: 8192 }),
      "Job",
    );
    await second.backend.settled();
  };
  /** @type {Promise<void> | undefined} */
  let during;
  state.intercept = (call) => {
    if (
      call.argv[0] !== "run" ||
      !call.argv.includes(containerName(pool, "asg-1")) ||
      during !== undefined
    )
      return undefined;
    first.clock.nowMs += 21_000;
    during = other();
    return during.then(() => first.engine.exec(call.argv));
  };
  first.checked();
  await first.backend.settled();
  await (during ?? other());
  assert.deepEqual(runningWorkloads(state), [
    containerName(otherPool, "asg-2"),
  ]);
  assert.deepEqual(holdNames(state), []);
  assert.ok(
    first.log.includes(
      `${containerName(pool, "asg-1")} was not started: it had no room on this engine by the assignment's deadline`,
    ),
    first.log.join("\n"),
  );
});

test("a job whose check crosses its deadline fails, and does not remake its hold and start late", async (t) => {
  const { backend, state, clock, log, checked, waiting } =
    await memoryHarness(t);
  const name = containerName(pool, "asg-1");
  occupied(state, "chuggy-jobs-postgres", { usedBytes: 8 * memoryGib });
  await backend.held();
  await backend.place(assignment({ memoryMib: 8192, deadlineSecs: 60 }), "Job");
  await until(() => waiting() === 1);
  checked();
  await until(() => waiting() === 1);
  state.containers.delete("chuggy-jobs-postgres");
  let crossed = false;
  state.intercept = (call) => {
    if (!crossed && call.argv[0] === "info") clock.nowMs += 34_000;
    if (call.argv[0] === "info") crossed = true;
    return undefined;
  };
  checked();
  await backend.settled();
  assert.equal(crossed, true);
  assert.deepEqual(runningWorkloads(state), []);
  assert.deepEqual(holdNames(state), []);
  assert.ok(
    log.includes(
      `${name} was not started: it had no room on this engine by the assignment's deadline`,
    ),
    log.join("\n"),
  );
});

test("a start still running as its hold's deadline nears is cut, the container it made removed, and the job fails too late to start", async (t) => {
  const { backend, state, clock, log } = await memoryHarness(t);
  const name = containerName(pool, "asg-1");
  /** @type {(string | undefined)[]} */
  const starting = [];
  state.intercept = (call) => {
    if (call.argv[1] === "create" && call.argv.at(-1) === `${name}-held`) {
      starting.push(
        call.argv
          .find((each) => each.startsWith("io.chuggy.held.starting="))
          ?.split("=")[1],
      );
      clock.nowMs = startMs + 3600 * 1000 - memoryStartCutMs - 50;
    }
    if (call.argv[0] !== "run") return undefined;
    occupied(state, name, {
      labels: {
        "io.chuggy.pool": "vteng/chuggy/shame",
        "io.chuggy.assignment": "asg-1",
        "io.chuggy.kind": "Job",
      },
      memoryBytes: 4 * memoryGib,
    });
    return waited(2000).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };
  await backend.held();
  await backend.place(assignment(), "Job");
  await backend.settled();
  assert.deepEqual(runningWorkloads(state), []);
  assert.ok(
    state.calls.some((call) => call.argv.join(" ") === `rm --force ${name}`),
  );
  assert.deepEqual(holdNames(state), []);
  assert.ok(
    log.includes(
      `${name} was not started: it could not start before the assignment's deadline`,
    ),
    log.join("\n"),
  );
  assert.deepEqual(starting, ["true"]);
});

test("a job whose hold was made too late for its start to be cut short of the deadline fails without running", async (t) => {
  const { backend, state, clock, log } = await memoryHarness(t);
  const name = containerName(pool, "asg-1");
  state.intercept = (call) => {
    if (call.argv[1] === "create" && call.argv.at(-1) === `${name}-held`)
      clock.nowMs = startMs + 3600 * 1000 - memoryStartCutMs;
    return undefined;
  };
  await backend.held();
  await backend.place(assignment(), "Job");
  await backend.settled();
  assert.ok(!state.calls.some((call) => call.argv[0] === "run"));
  assert.deepEqual(holdNames(state), []);
  assert.ok(
    log.includes(
      `${name} was not started: it could not start before the assignment's deadline`,
    ),
    log.join("\n"),
  );
});

test("a job first held near its deadline is given half the time left to start, and starts where it has room", async (t) => {
  const { backend, state } = await memoryHarness(t);
  await backend.held();
  await backend.place(assignment({ deadlineSecs: 30 }), "Job");
  await backend.settled();
  assert.deepEqual(runningWorkloads(state), [containerName(pool, "asg-1")]);
});

test("a job whose count leaves it too little time to start fails without running, its time read once the count is done", async (t) => {
  const { backend, state, clock, log, checked, waiting } =
    await memoryHarness(t);
  const name = containerName(pool, "asg-1");
  occupied(state, "chuggy-jobs-postgres", { usedBytes: 8 * memoryGib });
  await backend.held();
  await backend.place(assignment({ memoryMib: 8192, deadlineSecs: 90 }), "Job");
  await until(() => waiting() === 1);
  checked();
  await until(() => waiting() === 1);
  state.containers.delete("chuggy-jobs-postgres");
  let counted = false;
  state.intercept = (call) => {
    if (!counted && call.argv[0] === "info") {
      counted = true;
      clock.nowMs += 30_000;
    }
    return undefined;
  };
  checked();
  await backend.settled();
  assert.equal(counted, true);
  assert.ok(!state.calls.some((call) => call.argv[0] === "run"));
  assert.deepEqual(holdNames(state), []);
  assert.ok(
    log.includes(
      `${name} was not started: it had no room on this engine by the assignment's deadline`,
    ),
    log.join("\n"),
  );
});

test("a session is started however full the engine is, and a backend with no budget counts nothing", async (t) => {
  const { backend, state } = await memoryHarness(t);
  occupied(state, "chuggy-jobs-postgres", { usedBytes: 15 * memoryGib });
  await backend.held();
  await backend.place(assignment(), "Session");
  await backend.settled();
  assert.ok(state.calls.some((call) => call.argv[0] === "run"));
  assert.deepEqual(holdNames(state), []);

  const none = await harness(t);
  none.state.images.add(image);
  await none.backend.held();
  await none.backend.place(assignment(), "Job");
  await none.backend.settled();
  assert.ok(
    !none.state.calls.some(
      (call) =>
        call.argv[0] === "stats" || call.argv.includes("label=io.chuggy.held"),
    ),
  );
  for (const [key, value] of /** @type {const} */ ([
    ["memoryFreeBytesMin", -1],
    ["memoryFreeBytesMin", 0.5],
    ["memoryReservedBytes", -1],
    ["memoryReservedBytes", 0.5],
    ["memoryLock", ""],
    ["memoryClaimLock", ""],
  ]))
    assert.throws(
      () => checkedContainerBackendSettings({ ...none.settings, [key]: value }),
      RangeError,
    );
});
