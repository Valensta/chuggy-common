import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";

import { workerJobVariables } from "./checks.mjs";
import { claudeCredentialVariable } from "./claudeCredential.mjs";
import {
  checkedHostBackendSettings,
  hostBackend,
  hostEnvironmentRefusal,
  hostExitWatched,
  hostJobEnvironment,
  hostJobName,
  hostPlatformsDeclared,
  hostRoutedBackend,
  hostRuns,
} from "./hostBackend.mjs";
import { runnerMeasures } from "./runnerReport.mjs";
import { savedLogCutLine, savedLogLinesMax } from "./savedLog.mjs";

/**
 * A stand-in for the worker core: it writes what it was started with to
 * `HOST_FIXTURE_OUT`, then does what `HOST_FIXTURE_MODE` says.
 */
const fixtureCore = `
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const out = process.env.HOST_FIXTURE_OUT;
const directory = process.env.CHUGGY_HOST_JOB;
const seen = { cwd: process.cwd(), env: process.env, places: readdirSync(directory).sort() };
const mode = process.env.HOST_FIXTURE_MODE;
if (mode === "grandchild" || mode === "stubborn" || mode === "orphan") {
  const body = mode === "grandchild" ? "" : "process.on('SIGTERM', () => {});";
  const grandchild = spawn(process.execPath, ["-e", body + "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  seen.grandchild = grandchild.pid;
}
if (mode === "readonly") {
  mkdirSync(join(process.env.HOME, "go", "pkg"), { recursive: true });
  writeFileSync(join(process.env.HOME, "go", "pkg", "mod.txt"), "cached");
  chmodSync(join(process.env.HOME, "go", "pkg", "mod.txt"), 0o444);
  chmodSync(join(process.env.HOME, "go", "pkg"), 0o555);
  chmodSync(join(process.env.HOME, "go"), 0o555);
}
writeFileSync(out, JSON.stringify(seen));
process.stdout.write("fixture output\\n");
if (mode === "loud") {
  process.stdout.write("loud\\n".repeat(3 * 1024 * 1024));
  process.exit(0);
}
if (mode?.startsWith("exit:")) process.exit(Number(mode.slice(5)));
if (mode === "orphan" || mode === "readonly") setTimeout(() => process.exit(0), 100);
setInterval(() => {}, 1000);
`;

const callbackUrl = "https://chuggy.example/worker";
const bearer = "attempt-bearer-secret";

/** @param {Partial<import("@chuggy/worker-contract/workerPool").WorkerPoolAssignment>} overrides */
function assignment(overrides = {}) {
  return {
    assignment: "asg-1",
    capabilities: ["Platform:MacOS:Arm64", "Agent:Claude", "Tool:Xcode"],
    cpuMillis: 2000,
    memoryMib: 4096,
    deadlineSecs: 3600,
    callbackUrl,
    bearer,
    ...overrides,
  };
}

/**
 * @param {import("node:test").TestContext} t
 * @param {string} mode
 * @param {Partial<import("./hostBackend.mjs").HostBackendSettings>} [overrides]
 */
async function harness(t, mode, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "chuggy-host-"));
  const core = join(root, "core.mjs");
  await writeFile(core, fixtureCore);
  const out = join(root, "seen.json");
  /** @type {string[]} */
  const log = [];
  /** @type {(() => void)[]} */
  const exits = [];
  /** @type {string | undefined} */
  let tokenFileRefused;
  /** @type {[string, string][]} the credential files the runner was asked about, each with its agent */
  const tokenFilesAsked = [];
  const settings = {
    platforms: ["Platform:MacOS:Arm64"],
    directory: join(root, "jobs"),
    logDir: join(root, "logs"),
    tokenFile: join(root, "claude-token"),
    timeoutSecsMax: 7200,
    outputBytesMax: 1024 * 1024,
    environment: { HOST_FIXTURE_OUT: out, HOST_FIXTURE_MODE: mode },
    machine: { cpuMillis: 8000, memoryMib: 16384 },
    core,
    ...overrides,
  };
  const backend = hostBackend(settings, {
    environment: {
      PATH: process.env.PATH,
      OWNER_SHELL: "kept",
      HOME: "/Users/owner",
      CLAUDE_CODE_OAUTH_TOKEN: "runner-token-secret",
    },
    atExit: (onExit) => exits.push(onExit),
    tokenFileRefusal: async (file, agent) => {
      tokenFilesAsked.push([file, agent]);
      return tokenFileRefused;
    },
    log: (line) => log.push(line),
  });
  t.after(async () => {
    for (const onExit of exits) onExit();
    await backend.settled();
    await rm(root, { recursive: true, force: true });
  });
  return {
    backend,
    settings,
    log,
    exits,
    root,
    tokenFilesAsked,
    seen: async () => {
      for (;;) {
        try {
          return JSON.parse(await readFile(out, "utf8"));
        } catch {
          await wait(10);
        }
      }
    },
    refuseTokenFile: (/** @type {string} */ why) => {
      tokenFileRefused = why;
    },
  };
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a job is the core run in a directory of its own, told its places and handed the owner's environment over the runner's", async (t) => {
  const { backend, settings, seen } = await harness(t, "sleep");
  assert.deepEqual(await backend.place(assignment(), "Job"), {
    placed: "Placed",
  });
  const started = await seen();
  const directory = started.env.CHUGGY_HOST_JOB;
  assert.equal(started.cwd.endsWith(directory.split("/").pop()), true);
  assert.deepEqual(started.places, ["home", "minted", "tmp", "workspace"]);
  assert.equal(started.env.HOME, join(directory, "home"));
  assert.equal(started.env.TMPDIR, join(directory, "tmp"));
  assert.equal(started.env.OWNER_SHELL, "kept");
  assert.equal(started.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual(JSON.parse(started.env.CHUG_WORKER_TASK), {
    callbackUrl,
    bearer,
    workspace: join(directory, "workspace"),
    timeoutSecsMax: 7200,
    outputBytesMax: 1024 * 1024,
    providerCredentialFile: settings.tokenFile,
  });
  assert.deepEqual(await backend.held(), [
    { assignment: "asg-1", kind: "Job" },
  ]);
  assert.equal(backend.holds("asg-1"), true);
  const [running] = backend.inFlight();
  assert.deepEqual(
    { ...running, deadlineEpochSecs: undefined },
    {
      assignment: "asg-1",
      kind: "Job",
      name: hostJobName("asg-1"),
      image: "host",
      phase: "Running",
      deadlineEpochSecs: undefined,
    },
  );
  assert.ok(
    Math.abs(running.deadlineEpochSecs - (Date.now() / 1000 + 3600)) < 60,
  );
});

test("a job that ended of itself is named once, after held stops naming it, its directory gone and its output kept", async (t) => {
  const { backend, settings, seen } = await harness(t, "exit:3");
  await backend.place(assignment(), "Job");
  const directory = (await seen()).env.CHUGGY_HOST_JOB;
  await backend.settled();
  assert.deepEqual(await backend.ended(), []);
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(await backend.ended(), [
    {
      kind: "Job",
      job: { assignment: "asg-1", callbackUrl, bearer },
      why: "the job's process exited 3",
      ran: "Failed",
    },
  ]);
  assert.deepEqual(await backend.ended(), []);
  const { Job: ran } = backend.measured().runSecs;
  assert.equal(
    ran.bucketCounts.reduce((sum, count) => sum + count, 0),
    1,
  );
  await assert.rejects(access(directory));
  assert.equal(
    await readFile(
      join(settings.logDir, `${hostJobName("asg-1")}.log`),
      "utf8",
    ),
    "fixture output\n",
  );
});

test("a job's output is kept to its last lines once the job ends, saying it was cut", async (t) => {
  const { backend, settings } = await harness(t, "loud");
  await backend.place(assignment(), "Job");
  await backend.settled();
  assert.equal(
    await readFile(
      join(settings.logDir, `${hostJobName("asg-1")}.log`),
      "utf8",
    ),
    `${savedLogCutLine}${"loud\n".repeat(savedLogLinesMax)}`,
  );
});

test("a stop kills the job's whole group, and its end is never named", async (t) => {
  const { backend, seen } = await harness(t, "grandchild");
  await backend.place(assignment(), "Job");
  const { grandchild } = await seen();
  assert.equal(alive(grandchild), true);
  assert.deepEqual(await backend.stop("asg-1"), { stopped: "Stopped" });
  for (let tries = 0; alive(grandchild) && tries < 100; tries++) await wait(10);
  assert.equal(alive(grandchild), false);
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(await backend.ended(), []);
  assert.deepEqual(await backend.stop("asg-1"), { stopped: "Stopped" });
});

test("a stop kills what of the group outlives its leader", async (t) => {
  const { backend, seen } = await harness(t, "stubborn");
  await backend.place(assignment(), "Job");
  const { grandchild } = await seen();
  await backend.stop("asg-1");
  for (let tries = 0; alive(grandchild) && tries < 100; tries++) await wait(10);
  assert.equal(alive(grandchild), false);
});

test("a job that ends leaving a process behind has its group killed", async (t) => {
  const { backend, seen } = await harness(t, "orphan");
  await backend.place(assignment(), "Job");
  const { grandchild } = await seen();
  await backend.settled();
  for (let tries = 0; alive(grandchild) && tries < 100; tries++) await wait(10);
  assert.equal(alive(grandchild), false);
});

test("a job whose directory holds a read-only tree still ends, named, its directory gone", async (t) => {
  const { backend, settings } = await harness(t, "readonly");
  await backend.place(assignment(), "Job");
  await backend.settled();
  await backend.held();
  assert.equal((await backend.ended()).length, 1);
  assert.deepEqual(await readdir(settings.directory), []);
});

test("the runner's exit or a signal ending it kills its jobs, and a signal nothing else handles still ends it", () => {
  const process = Object.assign(new EventEmitter(), {
    pid: 7,
    /** @type {[number, string][]} */
    killed: [],
    /** @param {number} pid @param {string} signal */
    kill(pid, signal) {
      this.killed.push([pid, signal]);
      return true;
    },
  });
  let exits = 0;
  hostExitWatched(() => (exits += 1), /** @type {never} */ (process));
  const handled = [];
  process.once("SIGINT", () => handled.push("SIGINT"));
  process.emit("SIGTERM");
  assert.equal(exits, 1);
  assert.deepEqual(process.killed, [[7, "SIGTERM"]]);
  process.emit("SIGINT");
  assert.equal(exits, 2);
  assert.deepEqual(handled, ["SIGINT"]);
  assert.deepEqual(process.killed, [[7, "SIGTERM"]]);
  process.emit("SIGHUP");
  assert.equal(exits, 3);
  assert.deepEqual(process.killed, [
    [7, "SIGTERM"],
    [7, "SIGHUP"],
  ]);
  process.emit("exit");
  assert.equal(exits, 4);
});

test("an owner's environment naming what a host job's core or places set is refused by name", () => {
  assert.equal(hostEnvironmentRefusal({ CI: "1" }), undefined);
  assert.match(
    String(hostEnvironmentRefusal({ TMPDIR: "/var/tmp" })),
    /^TMPDIR is set for every host job/u,
  );
});

/**
 * Catches an owner's environment naming a variable a host job's shells are
 * told which job they are in by, which the core would set over it unseen.
 */
test("an owner's environment naming a job's identity is refused by name", () => {
  for (const name of Object.values(workerJobVariables))
    assert.equal(
      hostEnvironmentRefusal({ CI: "1", [name]: "the owner's" }),
      `${name} is set for every host job, and the owner's environment cannot name it`,
    );
});

/**
 * Catches a kind of Claude credential the runner's own environment or the
 * owner's names reaching a host job's core, which would read the file as that
 * kind and not the one the host names; or any other variable of the runner's
 * withheld from a job, which its core withholds from Claude Code itself where
 * a kind is named and leaves as it always has where none is.
 */
test("a job is handed no kind of Claude credential the runner's environment names, and the owner's cannot name one", () => {
  assert.deepEqual(
    hostJobEnvironment(
      {
        PATH: "/bin",
        [claudeCredentialVariable]: '{"kind":"ApiKey"}',
        ANTHROPIC_API_KEY: "the runner's",
      },
      {},
      "/jobs/job-1",
      "{}",
    ),
    {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "the runner's",
      HOME: "/jobs/job-1/home",
      TMPDIR: "/jobs/job-1/tmp",
      CHUGGY_HOST_JOB: "/jobs/job-1",
      CHUG_WORKER_TASK: "{}",
    },
  );
  assert.equal(
    hostEnvironmentRefusal({ [claudeCredentialVariable]: '{"kind":"ApiKey"}' }),
    `${claudeCredentialVariable} is set for every host job, and the owner's environment cannot name it`,
  );
});

/**
 * Catches the kind of a host's Claude credential not reaching its job's core,
 * which would read a key as a subscription's token; one reaching a job whose
 * host named none, which a core reads as a token today; or one no core could
 * read accepted rather than refused when the host is made.
 */
test("a job is told the kind of its host's Claude credential, and only where the host names one", async (t) => {
  const named = await harness(t, "sleep", {
    claudeCredential: { kind: "Bedrock", region: "us-west-2" },
  });
  await named.backend.place(assignment(), "Job");
  assert.equal(
    (await named.seen()).env[claudeCredentialVariable],
    '{"kind":"Bedrock","region":"us-west-2"}',
  );

  const unnamed = await harness(t, "sleep");
  await unnamed.backend.place(assignment(), "Job");
  assert.ok(
    !Object.hasOwn((await unnamed.seen()).env, claudeCredentialVariable),
  );

  assert.throws(
    () =>
      checkedHostBackendSettings({
        ...unnamed.settings,
        claudeCredential: /** @type {any} */ ({ kind: "Bedrock" }),
      }),
    /^RangeError: the Claude credential's setting cannot be carried: region is required/u,
  );
});

/**
 * Catches a job requiring Codex handed the Claude credential, or told its
 * kind; any other job handed the Codex credential, one requiring an agent the
 * host holds no file for among them; or the runner's check asked of a file
 * other than the one the job reads.
 */
test("a job requiring an agent reads that agent's credential file, or the Claude one where the host names none for it, told the Claude credential's kind only where it is Claude's", async (t) => {
  const codexFile = "/Users/owner/.codex/auth.json";
  const overrides = {
    agentCredentialFiles: { Codex: codexFile },
    claudeCredential: /** @type {const} */ ({
      kind: "Bedrock",
      region: "us-west-2",
    }),
  };
  for (const [capabilities, agent] of [
    [["Platform:MacOS:Arm64", "Agent:Codex"], "Codex"],
    [["Platform:MacOS:Arm64", "Agent:Claude"], "Claude"],
    [["Platform:MacOS:Arm64"], "Claude"],
    [["Platform:MacOS:Arm64", "Agent:Gemini"], "Claude"],
  ]) {
    const { backend, settings, seen, tokenFilesAsked } = await harness(
      t,
      "sleep",
      overrides,
    );
    await backend.place(assignment({ capabilities }), "Job");
    const { env } = await seen();
    const file = agent === "Codex" ? codexFile : settings.tokenFile;
    assert.equal(
      JSON.parse(env.CHUG_WORKER_TASK).providerCredentialFile,
      file,
      agent,
    );
    assert.equal(
      Object.hasOwn(env, claudeCredentialVariable),
      agent === "Claude",
      agent,
    );
    assert.deepEqual(tokenFilesAsked, [[file, agent]]);
  }
});

/**
 * Catches a job requiring several agents run with one agent's credential
 * rather than refused, or a runner's reason a Codex file cannot be read
 * passed by.
 */
test("a job requiring several agents is refused, as is one the runner says cannot read its agent's file, and nothing is run", async (t) => {
  const codexFile = "/Users/owner/.codex/auth.json";
  const required = (...agents) =>
    assignment({ capabilities: ["Platform:MacOS:Arm64", ...agents] });
  const { backend, root, tokenFilesAsked, refuseTokenFile, settings } =
    await harness(t, "sleep", { agentCredentialFiles: { Codex: codexFile } });
  assert.deepEqual(
    await backend.place(required("Agent:Claude", "Agent:Codex"), "Job"),
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
  await assert.rejects(readdir(join(root, "jobs")), { code: "ENOENT" });
  assert.throws(
    () =>
      checkedHostBackendSettings({
        ...settings,
        agentCredentialFiles: { Claude: codexFile },
      }),
    /^RangeError: agentCredentialFiles names Claude, whose credential file is tokenFile/u,
  );
});

test("a job past its deadline is killed and named timed out", async (t) => {
  const { backend } = await harness(t, "sleep");
  await backend.place(assignment({ deadlineSecs: 1 }), "Job");
  await backend.settled();
  await backend.held();
  assert.deepEqual(await backend.ended(), [
    {
      kind: "Job",
      job: { assignment: "asg-1", callbackUrl, bearer },
      why: "the job ran past its deadline and was killed",
      killed: "Deadline",
    },
  ]);
});

test("the runner's exit kills every job it started", async (t) => {
  const { backend, exits, seen } = await harness(t, "grandchild");
  await backend.place(assignment(), "Job");
  const { grandchild } = await seen();
  for (const onExit of exits) onExit();
  for (let tries = 0; alive(grandchild) && tries < 100; tries++) await wait(10);
  assert.equal(alive(grandchild), false);
});

test("a repeated placement is placed once", async (t) => {
  const { backend, root } = await harness(t, "sleep");
  await backend.place(assignment(), "Job");
  assert.deepEqual(await backend.place(assignment(), "Job"), {
    placed: "Placed",
  });
  assert.equal((await readdir(join(root, "jobs"))).length, 1);
});

test("what this host cannot take is refused, naming no value of the envelope", async (t) => {
  const { backend, refuseTokenFile, root } = await harness(t, "sleep");
  const refusals = [
    [assignment(), "Session", /a session runs in a container/u],
    [
      assignment({ image: "registry.example/x" }),
      "Job",
      /pins an image, which this host runs no job in/u,
    ],
    [
      assignment({ capabilities: ["Platform:Linux:Arm64"] }),
      "Job",
      /names no platform this host is, which is Platform:MacOS:Arm64/u,
    ],
    [
      assignment({ cpuMillis: 8001 }),
      "Job",
      /8001 CPU millis and this machine has 8000/u,
    ],
    [
      assignment({ memoryMib: 16385 }),
      "Job",
      /16385 MiB and this machine has 16384/u,
    ],
    [
      assignment({ callbackUrl: "attempt-bearer-secret" }),
      "Job",
      /makes no envelope its container can read: callbackUrl$/u,
    ],
  ];
  for (const [refused, kind, why] of refusals) {
    const answer = await backend.place(
      /** @type {never} */ (refused),
      /** @type {"Job" | "Session"} */ (kind),
    );
    assert.equal(answer.placed, "Refused", JSON.stringify(refused));
    assert.match(/** @type {{evidence: string}} */ (answer).evidence, why);
    assert.ok(
      !(/** @type {{evidence: string}} */ (answer).evidence.includes(bearer)),
    );
  }
  refuseTokenFile("the token file cannot be read");
  assert.deepEqual(await backend.place(assignment(), "Job"), {
    placed: "Refused",
    evidence: "the token file cannot be read",
  });
  assert.deepEqual(await readdir(join(root, "jobs")), []);
  assert.deepEqual(await backend.held(), []);
});

test("the first held removes the job directories a predecessor left", async (t) => {
  const { backend, root } = await harness(t, "sleep");
  const left = join(root, "jobs", "job-left");
  await mkdir(join(left, "workspace"), { recursive: true });
  await backend.place(assignment(), "Job");
  await backend.held();
  const remaining = await readdir(join(root, "jobs"));
  assert.equal(remaining.length, 1);
  assert.notEqual(remaining[0], "job-left");
});

test("a host's settings name its platforms, and leave chuggy's variables alone", () => {
  const settings = {
    platforms: ["Platform:MacOS:Arm64"],
    directory: "/d",
    logDir: "/l",
    tokenFile: "/t",
    timeoutSecsMax: 1,
    outputBytesMax: 1,
    environment: {},
    machine: { cpuMillis: 1, memoryMib: 1 },
  };
  assert.equal(checkedHostBackendSettings(settings), settings);
  for (const [overrides, why] of [
    [{ platforms: [] }, /at least one platform/u],
    [{ platforms: ["Tool:Xcode"] }, /is no platform token/u],
    [{ timeoutSecsMax: 2_147_484 }, /timeout is at most 2147483 seconds/u],
    [{ environment: { HOME: "/x" } }, /HOME is set for every host job/u],
    [
      { environment: { CHUG_WORKER_TASK: "x" } },
      /CHUG_WORKER_TASK is set for every host job/u,
    ],
  ])
    assert.throws(
      () => checkedHostBackendSettings({ ...settings, ...overrides }),
      why,
    );
});

test("a job's environment is the runner's less chuggy's, then the owner's, then its places", () => {
  assert.deepEqual(
    hostJobEnvironment(
      {
        PATH: "/bin",
        HOME: "/Users/owner",
        CHUGGY_HOST_JOB: "/x",
        GONE: undefined,
      },
      { PATH: "/opt/owner/bin:/bin" },
      "/jobs/job-1",
      "{}",
    ),
    {
      PATH: "/opt/owner/bin:/bin",
      HOME: "/jobs/job-1/home",
      TMPDIR: "/jobs/job-1/tmp",
      CHUGGY_HOST_JOB: "/jobs/job-1",
      CHUG_WORKER_TASK: "{}",
    },
  );
});

test("a job runs on the host only where it pins no image and names a platform the host is", () => {
  const platforms = ["Platform:MacOS:Arm64"];
  assert.equal(hostRuns(platforms, assignment()), true);
  assert.equal(hostRuns(platforms, assignment({ image: "x" })), false);
  assert.equal(
    hostRuns(platforms, assignment({ capabilities: ["Platform:Linux:Arm64"] })),
    false,
  );
});

/**
 * A backend that records what it is asked, holding what it placed.
 *
 * @param {string[]} calls
 * @param {string} name
 */
function recording(calls, name, held = new Set()) {
  return {
    place: async (
      /** @type {{assignment: string}} */ placed,
      /** @type {string} */ kind,
    ) => {
      calls.push(`${name}.place ${placed.assignment} ${kind}`);
      held.add(placed.assignment);
      return { placed: /** @type {const} */ ("Placed") };
    },
    stop: async (/** @type {string} */ stopped) => {
      calls.push(`${name}.stop ${stopped}`);
      return { stopped: /** @type {const} */ ("Stopped") };
    },
    held: async () => [
      { assignment: `${name}-held`, kind: /** @type {const} */ ("Job") },
    ],
    ended: async () => [],
    holds: (/** @type {string} */ asked) => held.has(asked),
    inFlight: () => [`${name}-placing`],
    settled: async () => {
      calls.push(`${name}.settled`);
    },
    containers: async () => [`${name}-container`],
  };
}

test("a pool runs work on its host on the platforms of the host's system it declared, only where registered to", () => {
  const capabilities = [
    "Platform:Linux:Arm64",
    "Platform:MacOS:Arm64",
    "Agent:Claude",
  ];
  assert.deepEqual(hostPlatformsDeclared({ capabilities }, "MacOS"), []);
  assert.deepEqual(
    hostPlatformsDeclared({ capabilities, host: true }, "MacOS"),
    ["Platform:MacOS:Arm64"],
  );
  assert.deepEqual(
    hostPlatformsDeclared({ capabilities, host: true }, "Linux"),
    ["Platform:Linux:Arm64"],
  );
});

/** Catches a CLI that runs a job on its host under a chat host's credentials. */
test("a chat host's credentials run no job on its host", () => {
  assert.throws(
    () =>
      hostPlatformsDeclared(
        { kind: "ChatHost", capabilities: [], host: true },
        "Linux",
      ),
    /^RangeError: a chat host runs no job, so its credentials run none on its host$/u,
  );
});

test("a host beside a container backend takes its own jobs, and everything else goes to the containers", async () => {
  /** @type {string[]} */
  const calls = [];
  const host = recording(calls, "host");
  const container = recording(calls, "container");
  const routed = hostRoutedBackend(
    /** @type {never} */ (container),
    /** @type {never} */ (host),
    ["Platform:MacOS:Arm64"],
  );
  await routed.place(/** @type {never} */ (assignment()), "Job");
  await routed.place(
    /** @type {never} */ (
      assignment({
        assignment: "asg-2",
        capabilities: ["Platform:Linux:Arm64"],
      })
    ),
    "Job",
  );
  await routed.place(
    /** @type {never} */ (assignment({ assignment: "asg-3", image: "x" })),
    "Job",
  );
  await routed.place(
    /** @type {never} */ ({
      ...assignment({ assignment: "asg-4" }),
      image: "s",
    }),
    "Session",
  );
  await routed.stop("asg-1");
  await routed.stop("asg-2");
  assert.deepEqual(calls, [
    "host.place asg-1 Job",
    "container.place asg-2 Job",
    "container.place asg-3 Job",
    "container.place asg-4 Session",
    "host.stop asg-1",
    "container.stop asg-2",
  ]);
  assert.deepEqual(await routed.held(), [
    { assignment: "container-held", kind: "Job" },
    { assignment: "host-held", kind: "Job" },
  ]);
  assert.deepEqual(routed.inFlight(), ["container-placing", "host-placing"]);
  assert.deepEqual(await routed.containers(), ["container-container"]);
  calls.splice(0);
  await routed.settled();
  assert.deepEqual(calls, ["container.settled", "host.settled"]);
});

test("a job whose process exited 0 is named as one that succeeded", async (t) => {
  const { backend } = await harness(t, "exit:0");
  await backend.place(assignment(), "Job");
  await backend.settled();
  await backend.held();
  assert.deepEqual(
    (await backend.ended()).map((ended) => ended.kind === "Job" && ended.ran),
    ["Succeeded"],
  );
});

test("a host beside a container backend measures what both measured", () => {
  const container = runnerMeasures();
  const host = runnerMeasures();
  container.pulled(3);
  container.ran("Session", 40);
  host.ran("Job", 40);
  const routed = hostRoutedBackend(
    /** @type {never} */ ({
      ...recording([], "container"),
      measured: container.measured,
    }),
    /** @type {never} */ ({
      ...recording([], "host"),
      measured: host.measured,
    }),
    ["Platform:MacOS:Arm64"],
  );
  const measured = routed.measured?.();
  assert.equal(measured?.imagePullSecs.sumSecs, 3);
  assert.deepEqual(measured?.runSecs.Job, host.measured().runSecs.Job);
  assert.deepEqual(
    measured?.runSecs.Session,
    container.measured().runSecs.Session,
  );
});
