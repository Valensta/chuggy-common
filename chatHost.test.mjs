/**
 * A member's chat host over a plane, an engine and supervisors a suite
 * fakes: which image its supervisor runs in and when it is started again,
 * what its polls ask for while it has no supervisor, and the container a
 * supervisor is run as.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { URL } from "node:url";

import {
  chatProtocolLine,
  chatProtocolVersion,
  parseChatHostFrame,
} from "@chuggy/worker-contract/chatHost";
import {
  workerContractHeader,
  workerContractRelease,
} from "@chuggy/worker-contract/workerContract";
import { workerRunnerPollWaitHeader } from "@chuggy/worker-contract/workerPool";

import { chatMirrorGroupCount, chatMirrorGroupFirst } from "./chatCheckout.mjs";
import {
  chatCredentialAloneRefusal,
  chatHost,
  chatHostConfigSchema,
  chatHostConfigured,
  chatHostControl,
  chatHostIdleSecs,
  chatHostMemoryBytes,
  chatHostRestartBackoffMs,
  chatHostSessionsMaxDefault,
  chatHostSettingsLine,
  chatHostStatusAsked,
  chatHostStatusLines,
  chatHostStopWaitMs,
  chatHostUnreadyWaitMs,
  chatHostVolumes,
  chatImagePulled,
  chatSessionIdsNeeded,
  chatSessionMemoryBytesDefault,
  chatSupervisorContainer,
  chatSupervisorLeftoverRemoved,
  chatSupervisorName,
  chatSupervisorNaming,
  chatSupervisorStarted,
  chatSupervisorStateAsked,
  checkedChatHostSettings,
} from "./chatHost.mjs";
import {
  chatSessionClearWaitMs,
  chatSessionStopGraceMs,
  chatSessionSweepPauseMs,
  chatSessionSweepsMax,
  chatSessionUidCount,
  chatSessionUidFirst,
} from "./chatSession.mjs";
import { chatSupervisorSettings } from "./chatSupervisor.mjs";
import { controlAsked, controlServer, controlSocketPath } from "./control.mjs";
import { poolLabelValue } from "./poolIdentity.mjs";

const bearer = "chgs_0123456789abcdef0123456789abcdef";

const credentials = {
  kind: "ChatHost",
  tenant: "vteng",
  owner: "28:https://auth.invalid/geoff",
  tokenUrl: "https://auth.invalid/oauth2/token",
  audience: "https://chuggy.invalid/api",
  planeUrl: "https://pool-plane.invalid/",
  registryHost: "registry.invalid",
  clientId: "chat-host-client",
  clientSecret: "chat-host-secret",
};

const places = {
  volumes: { sessions: "chat-sessions", mirrors: "chat-mirrors" },
  credentialFile: "/home/geoff/.chuggy/claude/claude.json",
  credentialOwner: { uid: 0, gid: 0 },
};

const gib = 2 ** 30;

const settings = {
  sessionsMax: 2,
  sessionMemoryBytes: 3 * gib,
  idleSecs: 600,
  outputBytesMax: 4_096,
  places,
};

const one = `registry.invalid/chuggy/chat@sha256:${"1".repeat(64)}`;
const two = `registry.invalid/chuggy/chat@sha256:${"2".repeat(64)}`;

/** A session the plane offers. */
function sessionOf(assignment) {
  return {
    assignment,
    capabilities: [],
    cpuMillis: 500,
    memoryMib: 512,
    deadlineSecs: 1_800,
    callbackUrl: "https://worker-plane.invalid",
    bearer,
    image: one,
  };
}

/** Every pending callback run, so what a frame starts has answered. */
async function settled() {
  for (let turn = 0; turn < 8; turn += 1)
    await new Promise((resolve) => globalThis.setImmediate(resolve));
}

/**
 * A supervisor answering as the protocol says, of `sessionsMax`: each
 * session started at once, and, told to drain, each ended and itself gone,
 * or, `lingering`, once `finish` is called; `frames` is what the host wrote
 * it.
 */
function supervisorOf(sessionsMax = 3, lingering = false) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const frames = [];
  const running = new Set();
  let exit;
  const exited = new Promise((resolve) => {
    exit = resolve;
  });
  const say = (frame) => output.write(chatProtocolLine(frame));
  const gone = () => {
    if (!output.writableEnded) output.end();
    exit();
  };
  const finish = () => {
    for (const assignment of running)
      say({ frame: "Ended", assignment, phase: "Succeeded" });
    running.clear();
    say({ frame: "Drained" });
    gone();
  };
  let pending = "";
  input.on("data", (chunk) => {
    pending += String(chunk);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const frame of lines.map(parseChatHostFrame)) {
      frames.push(frame);
      if (frame.frame === "Start") {
        running.add(frame.assignment);
        say({ frame: "Started", assignment: frame.assignment });
      } else if (frame.frame === "Stop" && running.delete(frame.assignment))
        say({ frame: "Ended", assignment: frame.assignment, phase: "Failed" });
      else if (frame.frame === "Drain" && !lingering) finish();
    }
  });
  input.on("finish", gone);
  say({
    frame: "Ready",
    protocols: [chatProtocolVersion],
    sessionsMax,
    contractRelease: workerContractRelease,
  });
  return {
    frames,
    finish,
    crash: gone,
    handle: { input, output, errors, exited, kill: gone },
  };
}

/** One answer as the plane sends it. */
function answered(status, body) {
  return new globalThis.Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { [workerContractHeader]: workerContractRelease },
  });
}

/** Settles once `signal` aborts, as an engine's call cut short ends. */
function cutOf(signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) resolve(undefined);
    signal?.addEventListener("abort", resolve, { once: true });
  });
}

/** Every pending callback run, and a real moment past, so a start a fake engine makes has settled. */
async function moment() {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 1));
  await settled();
}

/**
 * An engine holding `present`, whose pulls answer `pulls` in turn, each
 * once `gate` settles or the call is cut short.
 */
function engineOf(seen, { present, pulls, gate }) {
  return {
    exec: async (argv, call) => {
      seen.execs.push({ argv: [...argv], environment: call?.environment });
      if (argv[0] === "image")
        return {
          code: present.includes(argv.at(-1)) ? 0 : 1,
          stdout: "",
          stderr: "no such image",
        };
      await Promise.race([gate, cutOf(call?.cut)]);
      const answer = pulls.shift() ?? { code: 0, stdout: "", stderr: "" };
      if (answer.code === 0) present.push(argv.at(-1));
      return answer;
    },
    execTail: async () => assert.fail("no tail is read"),
  };
}

/**
 * A chat host over fakes: `answers` is each poll's answer in turn, a poll
 * past them denied, and `present` the images the engine holds. A pull waits
 * on `gate`; a host's wait outlasts a start it is making unless `hasty`, so
 * a start takes no time of the host's clock. A start answers what `handed`
 * makes of each supervisor's handle, given what the host has logged. Its
 * site's engine is `engine`.
 */
async function hostOf(
  t,
  {
    answers,
    present = [],
    pulls = [],
    given = {},
    gate,
    hasty = false,
    lingering = false,
    handed = (handle) => handle,
    engine = "docker",
  },
) {
  const runtimeDir = await mkdtemp(join(tmpdir(), "chuggy-chat-host-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const seen = {
    polls: [],
    ended: [],
    execs: [],
    started: [],
    engines: [],
    startedMs: [],
    sleeps: [],
    events: [],
  };
  const logged = [];
  const supervisors = [];
  const invalidated = [];
  let clock = 0;
  let minted = 0;
  /** @type {ReturnType<typeof chatHost> | undefined} */
  let host;
  host = chatHost(
    credentials,
    { ...settings, ...given },
    {
      engine: engineOf(seen, { present, pulls, gate }),
      site: { engine, runtimeDir, dockerHost: "unix:///docker.sock" },
      started: (container, engineName) => {
        seen.started.push(container);
        seen.engines.push(engineName);
        seen.startedMs.push(clock);
        seen.events.push(`started ${container.image}`);
        const supervisor = supervisorOf(3, lingering);
        supervisors.push(supervisor);
        return handed(supervisor.handle, logged);
      },
      log: (line) => logged.push(line),
      logFor: (assignment) => (line) => logged.push(`${assignment}: ${line}`),
      sleep: async (ms) => {
        seen.sleeps.push(ms);
        while (!hasty && host?.status().starting) await moment();
        clock += ms;
      },
      nowMs: () => clock,
      tokens: {
        acquire: async () => ({
          acquired: "Token",
          token: `pool-${String((minted += 1))}`,
        }),
        invalidate: (token) => invalidated.push(token),
      },
      fetch: planeOf(seen, answers, supervisors, {
        nowMs: () => clock,
        status: () => host?.status(),
      }),
    },
  );
  return { host, seen, logged, supervisors, invalidated };
}

/**
 * A plane answering each poll with the next of `answers`, or what the next,
 * a function of the supervisors started and of the host's clock and status,
 * settles to, and denying the host past them; every settlement and
 * session's end is taken.
 */
function planeOf(seen, answers, supervisors, host) {
  return async (input, init) => {
    await settled();
    const url = new URL(String(input));
    if (url.pathname.endsWith("/session/ended")) {
      seen.ended.push(JSON.parse(String(init.body)).phase);
      seen.events.push("ended");
      return answered(204);
    }
    if (init.method === "POST") return answered(204);
    seen.events.push("poll");
    seen.polls.push({
      wantedSessions: url.searchParams.get("wantedSessions"),
      held: url.searchParams.getAll("held"),
      idleSecs: url.searchParams.get("idleSecs"),
      waitSecs: init.headers[workerRunnerPollWaitHeader],
    });
    let next = answers.shift();
    if (typeof next === "function")
      next = await next(supervisors, host.nowMs(), host.status);
    await settled();
    return next === undefined
      ? answered(404, {})
      : answered(200, { assignments: [], sessions: [], stop: [], ...next });
  };
}

test("a host polls with no room and for an answer at once until the plane names an image, then runs a supervisor in it and asks for the room it has", async (t) => {
  const run = await hostOf(t, {
    answers: [
      {},
      { chatImage: one },
      { chatImage: one, sessions: [sessionOf("a")] },
    ],
  });
  assert.equal((await run.host.run()).passed, "Denied");
  assert.deepEqual(run.seen.polls, [
    { wantedSessions: "0", held: [], idleSecs: "600", waitSecs: "0" },
    { wantedSessions: "0", held: [], idleSecs: "600", waitSecs: "0" },
    { wantedSessions: "2", held: [], idleSecs: "600", waitSecs: undefined },
    { wantedSessions: "1", held: ["a"], idleSecs: "600", waitSecs: undefined },
  ]);
  assert.deepEqual(run.seen.sleeps, [
    chatHostUnreadyWaitMs,
    chatHostUnreadyWaitMs,
  ]);
  assert.deepEqual(
    run.seen.started.map(({ image }) => image),
    [one],
  );
  assert.deepEqual(
    run.supervisors[0].frames.map(({ frame }) => frame),
    ["Start"],
  );
  assert.ok(run.supervisors[0].handle.input.writableEnded);
  assert.deepEqual(run.host.status(), {
    named: one,
    used: one,
    own: undefined,
    supervisor: "Ended",
    starting: false,
  });
  assert.ok(
    run.logged.every((line) => !line.includes(bearer)),
    run.logged.join("\n"),
  );
});

test("a supervisor's room is the least of its own and the host's", async (t) => {
  const run = await hostOf(t, {
    answers: [{ chatImage: one }, { chatImage: one }],
    given: { sessionsMax: 9 },
  });
  await run.host.run();
  assert.equal(run.seen.polls[1].wantedSessions, "3");
});

test("an image the plane names anew drains the supervisor, whose sessions end of themselves, and one is started in it once they are named", async (t) => {
  const run = await hostOf(t, {
    answers: [
      { chatImage: one },
      { chatImage: one, sessions: [sessionOf("a")] },
      { chatImage: two },
      { chatImage: two },
      { chatImage: two },
    ],
  });
  await run.host.run();
  assert.deepEqual(
    run.seen.started.map(({ image }) => image),
    [one, two],
  );
  assert.deepEqual(
    run.supervisors[0].frames.map(({ frame }) => frame),
    ["Start", "Drain"],
  );
  assert.deepEqual(run.seen.ended, ["Succeeded"]);
  assert.deepEqual(
    run.seen.polls.map(({ wantedSessions, waitSecs }) => [
      wantedSessions,
      waitSecs,
    ]),
    [
      ["0", "0"],
      ["2", undefined],
      ["1", undefined],
      ["0", "0"],
      ["0", "0"],
      ["2", undefined],
    ],
  );
  assert.deepEqual(run.host.status().used, two);
});

test("a drained supervisor's sessions are named as ended before a supervisor is started in the image named anew", async (t) => {
  const run = await hostOf(t, {
    answers: [
      { chatImage: one },
      { chatImage: one, sessions: [sessionOf("a")] },
      { chatImage: two },
      (supervisors) => {
        supervisors[0].finish();
        return { chatImage: two };
      },
      { chatImage: two },
      { chatImage: two },
    ],
    lingering: true,
  });
  await run.host.run();
  assert.deepEqual(run.seen.ended, ["Succeeded"]);
  const { events } = run.seen;
  assert.ok(
    events.indexOf("ended") < events.indexOf(`started ${two}`),
    events.join(", "),
  );
  assert.deepEqual(run.host.status().used, two);
});

test("a host goes on polling while its image is pulled, and a pull the host's end cuts short starts nothing", async (t) => {
  let release = () => undefined;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const named = () => ({ chatImage: one });
  /** @type {unknown[]} */
  const pulling = [];
  const run = await hostOf(t, {
    answers: [
      named(),
      named(),
      named(),
      (_supervisors, _nowMs, status) => {
        pulling.push(status());
        release();
        return named();
      },
      async (_supervisors, _nowMs, status) => {
        while (status().starting) await moment();
        return named();
      },
      named(),
    ],
    gate,
    hasty: true,
  });
  await run.host.run();
  const { events } = run.seen;
  assert.deepEqual(events.slice(0, 4), ["poll", "poll", "poll", "poll"]);
  assert.deepEqual(
    events.filter((event) => event.startsWith("started")),
    [`started ${one}`],
  );
  assert.equal(run.seen.polls.at(-1).wantedSessions, "2");
  assert.deepEqual(pulling, [
    {
      named: one,
      used: undefined,
      own: undefined,
      supervisor: "Absent",
      starting: true,
      startingIn: one,
    },
  ]);
  assert.equal(run.host.status().startingIn, undefined);
  const cut = await hostOf(t, {
    answers: [named(), named(), named()],
    gate: new Promise(() => undefined),
    hasty: true,
  });
  await cut.host.run();
  assert.equal(cut.seen.started.length, 0);
  assert.equal(cut.seen.polls.length, 4);
  assert.equal(cut.host.status().starting, false);
});

/**
 * Catches a host that ends the input of a supervisor started after the host
 * ended with nothing listening for its error, which, the supervisor already
 * gone, ends the host's process.
 */
test("a supervisor started once the host has ended is killed, its input's failure to end taken", async (t) => {
  const killed = [];
  const run = await hostOf(t, {
    answers: [{ chatImage: one }, { chatImage: one }],
    present: [one],
    hasty: true,
    handed: async (handle, logged) => {
      while (!logged.some((line) => line.startsWith("the plane denied")))
        await moment();
      const input = new Writable({
        write: (_chunk, _encoding, done) => done(),
        final: (done) =>
          done(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
      });
      return {
        ...handle,
        input,
        kill: () => {
          killed.push("killed");
          handle.kill();
        },
      };
    },
  });
  assert.equal((await run.host.run()).passed, "Denied");
  await moment();
  assert.equal(run.seen.started.length, 1);
  assert.deepEqual(killed, ["killed"]);
  assert.equal(run.host.status().used, undefined);
});

test("an image of the pool's registry is pulled under the pool's token, once more under a fresh one where it was refused, and one already here is not pulled", async (t) => {
  const run = await hostOf(t, {
    answers: [{ chatImage: one }, { chatImage: one }],
    pulls: [
      {
        code: 1,
        stdout: "",
        stderr: "Error: unauthorized: authentication required",
      },
    ],
  });
  await run.host.run();
  const pulls = run.seen.execs.filter(({ argv }) => argv[0] === "pull");
  assert.equal(pulls.length, 2);
  for (const { argv, environment } of pulls) {
    assert.deepEqual(argv, ["pull", "--quiet", one]);
    assert.equal(environment.DOCKER_HOST, "unix:///docker.sock");
    assert.equal(environment.DOCKER_AUTH_CONFIG, "");
  }
  assert.equal(run.invalidated.length, 1);
  const here = await hostOf(t, {
    answers: [{ chatImage: one }, { chatImage: one }],
    present: [one],
  });
  await here.host.run();
  assert.deepEqual(
    here.seen.execs.map(({ argv }) => argv[0]),
    ["image"],
  );
  assert.equal(here.seen.started.length, 1);
});

test("a supervisor that could not be pulled for, or ended of itself, is started again only a backoff after", async (t) => {
  const named = () => ({ chatImage: one });
  const waits = chatHostRestartBackoffMs / chatHostUnreadyWaitMs;
  let crashedMs = 0;
  const run = await hostOf(t, {
    answers: [
      named(),
      ...Array.from({ length: waits + 1 }, named),
      (supervisors, nowMs) => {
        supervisors[0].crash();
        crashedMs = nowMs;
        return named();
      },
      ...Array.from({ length: waits + 1 }, named),
    ],
    pulls: [{ code: 1, stdout: "", stderr: "Error: manifest unknown" }],
  });
  await run.host.run();
  assert.ok(
    run.logged.some((line) =>
      /did not start in .*manifest unknown/u.test(line),
    ),
    run.logged.join("\n"),
  );
  const [first, second] = run.seen.startedMs;
  assert.equal(run.seen.startedMs.length, 2);
  for (const [startedMs, fromMs] of [
    [first, 0],
    [second, crashedMs],
  ]) {
    assert.ok(
      startedMs >= fromMs + chatHostRestartBackoffMs,
      String(startedMs),
    );
    assert.ok(
      startedMs <= fromMs + chatHostRestartBackoffMs + chatHostUnreadyWaitMs,
      String(startedMs),
    );
  }
});

test("a host's own image is run whatever the plane names, and pulled as its setting says", async (t) => {
  const own = "ghcr.io/geoff/chat:dev";
  const run = await hostOf(t, {
    answers: [{ chatImage: one }, { chatImage: two }],
    given: { image: { image: own } },
  });
  await run.host.run();
  assert.deepEqual(
    run.seen.started.map(({ image }) => image),
    [own],
  );
  assert.equal(run.seen.polls[1].wantedSessions, "2");

  assert.deepEqual(
    run.seen.execs.map(({ argv, environment }) => [
      argv.join(" "),
      environment,
    ]),
    [
      [`image inspect --format {{.Id}} ${own}`, undefined],
      [`pull --quiet ${own}`, {}],
    ],
  );
  assert.deepEqual(run.host.status(), {
    named: two,
    used: own,
    own: { image: own, pull: "missing" },
    supervisor: "Ended",
    starting: false,
  });

  const never = await hostOf(t, {
    answers: [{}, {}],
    given: { image: { image: own, pull: "never" } },
  });
  await never.host.run();
  assert.equal(never.seen.started.length, 0);
  assert.ok(never.logged.some((line) => /pulls it never/u.test(line)));
  const always = await hostOf(t, {
    answers: [{}],
    present: [own],
    given: { image: { image: own, pull: "always" } },
  });
  await always.host.run();
  assert.deepEqual(
    always.seen.execs.map(({ argv }) => argv[0]),
    ["pull"],
  );
});

/** A supervisor's container given all a host can give it. */
function supervisorContainerOf() {
  return chatSupervisorContainer(
    one,
    {
      ...places,
      credentialOwner: { uid: 1000, gid: 1001 },
      claudeCredential: { kind: "Subscription" },
      repositories: '{"kasofsk/chuggy":{}}',
      variables: { CHUG_CHAT_SESSIONS_MAX: "4" },
    },
    6 * gib,
  );
}

test("a supervisor's container is root with the capabilities it needs and none to gain, its memory capped, and its credential's directory read-only beneath one only its owner opens", () => {
  const container = supervisorContainerOf();
  assert.deepEqual(container, {
    image: one,
    command: [
      "/opt/chuggy/bin/tini",
      "-s",
      "--",
      "/opt/chuggy/bin/node",
      "/opt/chuggy/lib/chuggy/chatSupervisor.mjs",
    ],
    user: "0:0",
    capabilities: {
      drop: ["ALL"],
      add: [
        "CHOWN",
        "DAC_OVERRIDE",
        "FOWNER",
        "FSETID",
        "SETUID",
        "SETGID",
        "SETPCAP",
      ],
    },
    securityOptions: ["no-new-privileges"],
    interactive: true,
    volumes: [
      { volume: "chat-sessions", target: "/sessions" },
      { volume: "chat-mirrors", target: "/var/lib/chuggy/mirrors" },
    ],
    tmpfs: [
      {
        target: "/var/run/chuggy",
        mode: 0o711,
        uid: 0,
        gid: 0,
        sizeBytes: 64 * 1024 * 1024,
        flags: ["nosuid", "nodev", "noexec"],
      },
      {
        target: "/var/run/chuggy/credentials",
        mode: 0o700,
        uid: 1000,
        gid: 1001,
        sizeBytes: 1024 * 1024,
        flags: ["nosuid", "nodev", "noexec"],
      },
    ],
    binds: [
      {
        source: "/home/geoff/.chuggy/claude",
        target: "/var/run/chuggy/credentials/provider",
        readonly: true,
      },
    ],
    memoryBytes: 6 * gib,
    environment: container.environment,
  });
});

test("a supervisor's container is told the protocol its host speaks, its counts, the credential's file and owner, and the site's", () => {
  assert.deepEqual(supervisorContainerOf().environment, {
    CHUG_CHAT_PROTOCOL: String(chatProtocolVersion),
    CHUG_CHAT_SESSIONS_MAX: "4",
    CHUG_CHAT_CREDENTIAL: "/var/run/chuggy/credentials/provider/claude.json",
    CHUG_CHAT_CREDENTIAL_UID: "1000",
    CHUG_CHAT_CREDENTIAL_GID: "1001",
    CHUG_WORKER_CLAUDE_CREDENTIAL: '{"kind":"Subscription"}',
    CHUG_WORKER_REPOSITORIES: '{"kasofsk/chuggy":{}}',
  });
});

/** Catches a supervisor's environment the supervisor would refuse, found only once its container has started. */
test("a container's environment is one its supervisor reads, and is told the credential's file and owner", () => {
  const container = chatSupervisorContainer(
    one,
    { ...places, credentialOwner: { uid: 501, gid: 20 } },
    gib,
  );
  const read = chatSupervisorSettings(container.environment);
  assert.equal(
    read.credentialFile,
    "/var/run/chuggy/credentials/provider/claude.json",
  );
  assert.deepEqual(read.credentialOwner, { uid: 501, gid: 20 });
  assert.ok(!("CHUG_WORKER_CREDENTIAL_FILES" in container.environment));
});

test("a container whose credential a session's user could own or open another way, or whose supervisor would move its places, is refused", () => {
  for (const [changed, why] of [
    [
      { credentialOwner: { uid: 20_005, gid: 0 } },
      /owner 20005 is among the users/u,
    ],
    [
      {
        credentialOwner: { uid: 41_000, gid: 0 },
        variables: { CHUG_CHAT_UID_FIRST: "41000" },
      },
      /owner 41000 is among the users/u,
    ],
    [
      { variables: { CHUG_CHAT_SESSIONS: "/tmp" } },
      /no count of the supervisor's/u,
    ],
    [
      { variables: { CHUG_CHAT_CREDENTIAL_UID: "1" } },
      /no count of the supervisor's/u,
    ],
    [{ variables: { CHUG_CHAT_UID_FIRST: "30000" } }, /overlap the groups/u],
    [{ credentialFile: "relative.json" }, /no absolute path/u],
    [{ credentialFile: "/a/../b.json" }, /written plainly/u],
    [{ credentialFile: "/a/" }, /no directory of its own/u],
    [{ credentialFile: "/b.json" }, /no directory of its own/u],
  ])
    assert.throws(
      () => chatSupervisorContainer(one, { ...places, ...changed }, gib),
      why,
    );
  for (const memoryBytes of [0, -1, 1.5, 2 ** 53])
    assert.throws(
      () => chatSupervisorContainer(one, places, memoryBytes),
      /memory must be a positive integer/u,
    );
});

/** Catches a supervisor started with no cap, or one that is not room for each session the host runs. */
test("a host's supervisor is capped at its memory for each session it runs at once", async (t) => {
  const { host, seen } = await hostOf(t, { answers: [{ chatImage: one }, {}] });
  await host.run();
  assert.equal(seen.started[0].memoryBytes, 2 * 3 * gib);
  assert.equal(chatHostMemoryBytes(settings), 2 * 3 * gib);
});

test("a host's settings from a runner's file are its defaults where the file names none", () => {
  assert.equal(chatHostSessionsMaxDefault, 4);
  assert.equal(chatSessionMemoryBytesDefault, 2 * gib);
  assert.deepEqual(chatHostConfigured(undefined, 1_000), {
    sessionsMax: chatHostSessionsMaxDefault,
    sessionMemoryBytes: chatSessionMemoryBytesDefault,
    idleSecs: chatHostIdleSecs,
    outputBytesMax: 1_000,
  });
  const image = { image: one, pull: "never" };
  assert.deepEqual(
    chatHostConfigured(
      chatHostConfigSchema.parse({
        image,
        sessionsMax: 3,
        sessionMemoryMib: 1_024,
        idleSecs: 60,
        outputBytesMax: 5,
      }),
      1_000,
    ),
    {
      sessionsMax: 3,
      sessionMemoryBytes: gib,
      idleSecs: 60,
      outputBytesMax: 5,
      image,
    },
  );
  assert.deepEqual(chatHostConfigSchema.parse({ image: { image: one } }), {
    image: { image: one, pull: "missing" },
  });
});

/** Catches a setting that would cap a supervisor below what a session is claimed into, or a key misspelled into silence. */
test("a host's settings refuse too little memory a session, and keys they do not hold", () => {
  for (const config of [
    { sessionMemoryMib: 511 },
    { sessionsMax: 0 },
    { sessionMemory: 2048 },
    { image: { image: one, pull: "sometimes" } },
  ])
    assert.equal(chatHostConfigSchema.safeParse(config).success, false);
  assert.throws(
    () =>
      checkedChatHostSettings({
        ...settings,
        sessionMemoryBytes: 511 * 2 ** 20,
      }),
    /sessionMemoryBytes must be at least/u,
  );
  assert.throws(
    () =>
      checkedChatHostSettings({
        ...settings,
        sessionsMax: 2 ** 40,
        sessionMemoryBytes: 2 ** 30,
      }),
    /memory must be a positive integer/u,
  );
});

/** Catches a podman host whose credential's owner is not root, refused only at each start of its supervisor. */
test("a host's settings are refused before any start where its engine could not run its supervisor", () => {
  const owned = {
    ...settings,
    places: { ...places, credentialOwner: { uid: 1000, gid: 1000 } },
  };
  assert.equal(checkedChatHostSettings(owned, "docker").sessionsMax, 2);
  assert.equal(checkedChatHostSettings(settings, "podman").sessionsMax, 2);
  assert.throws(
    () => checkedChatHostSettings(owned, "podman"),
    /podman leaves a tmpfs root's/u,
  );
  assert.throws(
    () =>
      chatHost(credentials, owned, {
        site: { engine: "podman", runtimeDir: "/run/chuggy" },
      }),
    /podman leaves a tmpfs root's/u,
  );
});

test("the ids a session or a mirror takes lie below what a host's engine must map", () => {
  assert.deepEqual(chatSessionIdsNeeded, { uids: 20_032, gids: 31_024 });
  assert.equal(
    chatSessionIdsNeeded.uids,
    chatSessionUidFirst + chatSessionUidCount,
  );
  assert.equal(
    chatSessionIdsNeeded.gids,
    chatMirrorGroupFirst + chatMirrorGroupCount,
  );
});

/** Catches a host that kills a healthy supervisor, and every session it runs, for one stop it is still clearing. */
test("a host waits on a stopped session longer than its supervisor may take to end it", () => {
  assert.ok(
    chatHostStopWaitMs >
      chatSessionStopGraceMs +
        chatSessionSweepsMax * chatSessionSweepPauseMs +
        chatSessionClearWaitMs,
  );
});

test("a host's volumes are its own", () => {
  const geoff = { kind: "ChatHost", tenant: "vteng", owner: "geoff" };
  const volumes = chatHostVolumes(geoff);
  assert.match(volumes.sessions, /^chuggy-chat-[0-9a-f]{20}-sessions$/u);
  assert.match(volumes.mirrors, /^chuggy-chat-[0-9a-f]{20}-mirrors$/u);
  assert.notEqual(
    chatHostVolumes({ ...geoff, owner: "other" }).sessions,
    volumes.sessions,
  );
});

const geoffHost = { kind: "ChatHost", tenant: "vteng", owner: "geoff" };

test("a host's supervisor is named for its host as its volumes are, and carries its host's pool label", () => {
  const naming = chatSupervisorNaming(geoffHost, "chuggy");
  assert.equal(naming.name, chatSupervisorName(geoffHost));
  assert.equal(`${naming.name}-sessions`, chatHostVolumes(geoffHost).sessions);
  assert.deepEqual(
    { label: naming.label, network: naming.network },
    { label: poolLabelValue(geoffHost), network: "chuggy" },
  );
});

/** A child process a fake spawn hands back, which exits once killed. */
function childOf() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: /** @type {string[]} */ ([]),
    kill: (/** @type {string} */ signal) => {
      child.killed.push(signal);
      child.emit("exit", null, signal);
    },
  });
  return child;
}

/** A supervisor's start over an engine whose removal answers `removed`. */
function startOf(removed) {
  const seen = { execs: [], spawned: [] };
  const child = childOf();
  const started = chatSupervisorStarted({
    engine: {
      exec: async (argv) => {
        seen.execs.push([...argv]);
        return argv[0] === "rm" ? removed : { code: 0, stdout: "", stderr: "" };
      },
      execTail: async () => assert.fail("no tail is read"),
    },
    naming: chatSupervisorNaming(geoffHost, "chuggy"),
    spawn: /** @type {any} */ (
      (command, argv, options) => {
        seen.spawned.push({ command, argv, env: options.env });
        return child;
      }
    ),
  });
  return { started, seen, child };
}

/**
 * Catches a start that runs a second supervisor beside one still running,
 * kills one to make room, or writes a value of its environment into an argv.
 */
test("a supervisor is started once a container of its name that has exited is removed, and never beside one still there", async () => {
  const name = chatSupervisorName(geoffHost);
  const container = chatSupervisorContainer(one, places, gib);
  for (const removed of [
    { code: 0, stdout: name, stderr: "" },
    { code: 1, stdout: "", stderr: `Error: No such container: ${name}` },
  ]) {
    const { started, seen } = startOf(removed);
    await started(container, "docker");
    assert.deepEqual(seen.execs, [["rm", "-v", name]]);
    assert.equal(seen.spawned.length, 1);
    const [{ command, argv, env }] = seen.spawned;
    assert.equal(command, "docker");
    assert.equal(argv.at(argv.indexOf("--name") + 1), name);
    assert.equal(
      env.CHUG_CHAT_CREDENTIAL,
      "/var/run/chuggy/credentials/provider/claude.json",
    );
    assert.ok(argv.includes("CHUG_CHAT_CREDENTIAL"));
    assert.ok(!argv.some((arg) => arg.startsWith("CHUG_CHAT_CREDENTIAL=")));
  }

  const { started, seen } = startOf({
    code: 1,
    stdout: "",
    stderr: `Error response from daemon: cannot remove container "${name}": container is running: stop the container before removing or force remove`,
  });
  await assert.rejects(
    started(container, "docker"),
    /is still there, and nothing is started beside it/u,
  );
  assert.deepEqual(seen.execs, [["rm", "-v", name]]);
  assert.deepEqual(seen.spawned, []);
});

/**
 * Catches a supervisor run on an engine other than the one its host's
 * settings were checked against, which would run what that engine refuses.
 */
test("a host's supervisor is started on the engine its site names, which its settings are checked against", async (t) => {
  const { started, seen } = startOf({ code: 0, stdout: "", stderr: "" });
  await started(chatSupervisorContainer(one, places, gib), "podman");
  assert.equal(seen.spawned[0].command, "podman");
  assert.ok(seen.spawned[0].argv.includes("--userns=host"));

  const run = await hostOf(t, {
    answers: [{ chatImage: one }, {}],
    engine: "podman",
  });
  await run.host.run();
  assert.deepEqual(run.seen.engines, ["podman"]);
});

test("a started supervisor's kill ends its child and asks the engine to kill its container", async () => {
  const { started, seen, child } = startOf({ code: 0, stdout: "", stderr: "" });
  const handle = await started(
    chatSupervisorContainer(one, places, gib),
    "docker",
  );
  assert.equal(handle.input, child.stdin);
  handle.kill();
  await handle.exited;
  assert.deepEqual(child.killed, ["SIGKILL"]);
  assert.deepEqual(seen.execs.at(-1), ["kill", chatSupervisorName(geoffHost)]);
});

/** Catches a CLI's status that reads a host's state through a runner's answer, which carries none of it. */
test("a host's status is asked of its service's door, which a runner's service and an absent one do not answer", async (t) => {
  const directory = await mkdtemp("/tmp/chuggy-chat-control-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = controlSocketPath(directory);
  assert.equal(await chatHostStatusAsked(path), undefined);

  const status = {
    named: one,
    used: one,
    own: undefined,
    supervisor: /** @type {const} */ ("Ready"),
    starting: false,
  };
  const server = await controlServer(
    path,
    chatHostControl({
      run: async () => assert.fail("not run"),
      status: () => status,
    }),
  );
  assert.deepEqual(await chatHostStatusAsked(path), {
    named: one,
    used: one,
    supervisor: "Ready",
    starting: false,
  });
  assert.deepEqual(await controlAsked(path, { op: "status" }), {
    inFlight: [],
  });
  assert.deepEqual(
    await controlAsked(path, { op: "stop", assignment: "asg-1" }),
    { refused: "a chat host's sessions are stopped in chuggy" },
  );
  await new Promise((resolve) => server.close(resolve));

  const runner = await controlServer(path, {
    inFlight: () => [],
    stop: async () => ({ stopped: "Stopped" }),
  });
  t.after(() => runner.close());
  await assert.rejects(
    chatHostStatusAsked(path),
    /answered no chat host's status/u,
  );
});

/** Catches a credential whose directory hands its supervisor more than the credential, or a link that leads nowhere inside its container. */
test("a credential is handed a supervisor only alone in its directory, and not as a link", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chuggy-chat-credential-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alone = join(root, "alone", "claude.json");
  await mkdir(join(root, "alone"));
  await writeFile(alone, "{}");
  assert.equal(await chatCredentialAloneRefusal(alone), undefined);

  const crowded = join(root, "crowded", "claude.json");
  await mkdir(join(root, "crowded"));
  await writeFile(crowded, "{}");
  for (const other of ["a", "b", "c", "d"])
    await writeFile(join(root, "crowded", other), "");
  assert.match(
    String(await chatCredentialAloneRefusal(crowded)),
    /holds a, b, c and more beside the credential/u,
  );

  const linked = join(root, "linked", "claude.json");
  await mkdir(join(root, "linked"));
  await symlink(alone, linked);
  assert.match(String(await chatCredentialAloneRefusal(linked)), /is a link/u);

  assert.match(
    String(await chatCredentialAloneRefusal(join(root, "absent", "x.json"))),
    /cannot be read/u,
  );
});

/**
 * A pull of `image` through an engine holding `present`, whose pulls answer
 * `pulls` in turn, and a pool whose tokens `acquired` says are issued.
 */
async function pullOf(t, { present = [], pulls = [], own, acquired = true }) {
  const runtimeDir = await mkdtemp(join(tmpdir(), "chuggy-chat-pull-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const seen = { execs: [], cuts: [], invalidated: [] };
  const cut = new globalThis.AbortController().signal;
  let minted = 0;
  const pull = {
    engine: {
      exec: async (argv, call) => {
        seen.execs.push({ argv: [...argv], environment: call?.environment });
        seen.cuts.push(call?.cut);
        if (argv[0] === "image")
          return {
            code: present.includes(argv.at(-1)) ? 0 : 1,
            stdout: "",
            stderr: "no such image",
          };
        return pulls.shift() ?? { code: 0, stdout: "", stderr: "" };
      },
      execTail: async () => assert.fail("no tail is read"),
    },
    site: { engine: "docker", runtimeDir, dockerHost: "unix:///docker.sock" },
    registryHost: "registry.invalid",
    tokens: {
      acquire: async () =>
        acquired
          ? { acquired: "Token", token: `pool-${String((minted += 1))}` }
          : { acquired: "Unavailable", evidence: "the issuer is down" },
      invalidate: (token) => seen.invalidated.push(token),
    },
    ...(own === undefined ? {} : { own }),
    cut,
  };
  return { pull, seen, cut };
}

const unauthorized = {
  code: 1,
  stdout: "",
  stderr: "Error: unauthorized: authentication required",
};

/**
 * Catches a CLI's doctor pulling a pool's image other than as its host
 * would: without the pool's token, or not once more under a fresh one.
 */
test("a session image the plane names is pulled under the pool's token, once more under a fresh one, and no more", async (t) => {
  const pooled = await pullOf(t, { pulls: [unauthorized] });
  assert.deepEqual(await chatImagePulled(pooled.pull, one), {
    pulled: "Pulled",
    pooled: true,
  });
  const pulls = pooled.seen.execs.filter(({ argv }) => argv[0] === "pull");
  assert.equal(pulls.length, 2);
  for (const { environment } of pulls)
    assert.equal(environment.DOCKER_AUTH_CONFIG, "");
  assert.deepEqual(pooled.seen.invalidated, ["pool-1"]);
  assert.ok(pooled.seen.cuts.every((cut) => cut === pooled.cut));

  const refused = await pullOf(t, { pulls: [unauthorized, unauthorized] });
  await assert.rejects(
    chatImagePulled(refused.pull, one),
    /could not be pulled: /u,
  );
  assert.equal(
    refused.seen.execs.filter(({ argv }) => argv[0] === "pull").length,
    2,
  );
  const tokenless = await pullOf(t, { acquired: false });
  await assert.rejects(
    chatImagePulled(tokenless.pull, one),
    /the pool has no token to pull .+: the issuer is down/u,
  );
});

/** Catches a host's own image pulled other than as its setting says, or under the pool's token. */
test("a host's own image is pulled by the engine's login as its setting says, and a session image here is not pulled", async (t) => {
  const here = await pullOf(t, { present: [one] });
  assert.deepEqual(await chatImagePulled(here.pull, one), { pulled: "Here" });
  assert.deepEqual(
    here.seen.execs.map(({ argv }) => argv[0]),
    ["image"],
  );

  const elsewhere = "ghcr.io/geoff/chat:dev";
  for (const own of [
    undefined,
    { image: elsewhere, pull: "missing" },
    { image: one, pull: "missing" },
  ]) {
    const image = own?.image ?? elsewhere;
    const login = await pullOf(t, { own });
    assert.deepEqual(await chatImagePulled(login.pull, image), {
      pulled: "Pulled",
      pooled: false,
    });
    assert.deepEqual(
      login.seen.execs.map(({ argv, environment }) => [
        argv.join(" "),
        environment,
      ]),
      [
        [`image inspect --format {{.Id}} ${image}`, undefined],
        [`pull --quiet ${image}`, {}],
      ],
    );
  }

  const always = await pullOf(t, {
    present: [elsewhere],
    own: { image: elsewhere, pull: "always" },
  });
  assert.deepEqual(await chatImagePulled(always.pull, elsewhere), {
    pulled: "Pulled",
    pooled: false,
  });
  assert.deepEqual(
    always.seen.execs.map(({ argv }) => argv[0]),
    ["pull"],
  );
  const kept = await pullOf(t, {
    present: [elsewhere],
    own: { image: elsewhere, pull: "never" },
  });
  assert.deepEqual(await chatImagePulled(kept.pull, elsewhere), {
    pulled: "Here",
  });
  const never = await pullOf(t, { own: { image: elsewhere, pull: "never" } });
  await assert.rejects(
    chatImagePulled(never.pull, elsewhere),
    /is not here, and the host's setting pulls it never/u,
  );
  assert.deepEqual(
    never.seen.execs.map(({ argv }) => argv[0]),
    ["image"],
  );
});

/** An engine answering `rm` and `container inspect` with `answer`, and anything else with nothing. */
function engineAnswering(answer) {
  const seen = [];
  return {
    seen,
    engine: {
      exec: async (argv) => {
        seen.push([...argv]);
        return answer;
      },
      execTail: async () => assert.fail("no tail is read"),
    },
  };
}

/** Catches a CLI removing a container that is still running, or taking one it could not remove as gone. */
test("a leftover container is removed where it has exited or is not there, and refused where it is still there", async () => {
  for (const answer of [
    { code: 0, stdout: "x", stderr: "" },
    { code: 1, stdout: "", stderr: "Error: No such container: x" },
  ]) {
    const { engine, seen } = engineAnswering(answer);
    await chatSupervisorLeftoverRemoved(engine, "x");
    assert.deepEqual(seen, [["rm", "-v", "x"]]);
  }
  const { engine } = engineAnswering({
    code: 1,
    stdout: "",
    stderr:
      'Error response from daemon: cannot remove container "x": container is running: stop the container before removing or force remove',
  });
  await assert.rejects(
    chatSupervisorLeftoverRemoved(engine, "x"),
    /^Error: the container x is still there, and nothing is started beside it: /u,
  );
});

/** Catches a CLI taking a paused or restarting supervisor as one a start removes, or an engine it could not ask as one holding none. */
test("a supervisor's container is asked of the engine: none, its state and whether a start removes it, or why that could not be read", async () => {
  const name = chatSupervisorName(geoffHost);
  const stateOf = (Status) => ({
    code: 0,
    stdout: JSON.stringify([{ State: { Status } }]),
    stderr: "",
  });
  for (const [answer, asked] of [
    [
      { code: 1, stdout: "", stderr: `Error: No such container: ${name}` },
      { asked: "None" },
    ],
    [
      { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" },
      { asked: "Failed", reason: "Cannot connect to the Docker daemon" },
    ],
    [
      { code: 0, stdout: "not json", stderr: "" },
      { asked: "Unread", reason: `the inspection of ${name} is no JSON` },
    ],
    [
      { code: 0, stdout: "[{}]", stderr: "" },
      { asked: "Unread", reason: `the inspection of ${name} names no state` },
    ],
    [stateOf("exited"), { asked: "State", state: "exited", removable: true }],
    [stateOf("created"), { asked: "State", state: "created", removable: true }],
    [stateOf("stopped"), { asked: "State", state: "stopped", removable: true }],
    [
      stateOf("running"),
      { asked: "State", state: "running", removable: false },
    ],
    [stateOf("paused"), { asked: "State", state: "paused", removable: false }],
  ]) {
    const { engine, seen } = engineAnswering(answer);
    assert.deepEqual(await chatSupervisorStateAsked(engine, geoffHost), asked);
    assert.deepEqual(seen, [["container", "inspect", name]]);
  }
});

/** Catches two CLIs saying a host's settings or its service's status apart. */
test("a host's settings and its service's status are said in lines a CLI prints", () => {
  assert.equal(
    chatHostSettingsLine(chatHostConfigured(undefined, 4_096)),
    "sessionsMax 4, sessionMemoryMib 2048, so the supervisor is capped at 8192 MiB, idleSecs 600, outputBytesMax 4096, image the one chuggy names",
  );
  assert.equal(
    chatHostSettingsLine({
      ...settings,
      image: { image: "ghcr.io/geoff/chat:dev", pull: "always" },
    }),
    "sessionsMax 2, sessionMemoryMib 3072, so the supervisor is capped at 6144 MiB, idleSecs 600, outputBytesMax 4096, image ghcr.io/geoff/chat:dev, pulled before each start",
  );
  assert.deepEqual(chatHostStatusLines(undefined), ["service: not running"]);
  assert.deepEqual(
    chatHostStatusLines({ supervisor: "Absent", starting: false }),
    ["service: running", "supervisor: absent", "image: chuggy names none yet"],
  );
  assert.deepEqual(
    chatHostStatusLines({
      named: two,
      used: one,
      own: { image: one, pull: "missing" },
      supervisor: "Ready",
      starting: false,
    }),
    [
      "service: running",
      `supervisor: ready in ${one}`,
      `image: chuggy names ${two}, and the host runs its own, ${one}`,
    ],
  );
});

/**
 * Catches a status naming the image of a supervisor that has ended, or one
 * still being started, as the image a supervisor runs.
 */
test("a host's status names the image a supervisor is starting in, and the one last ready where none runs", () => {
  const said = (status) =>
    chatHostStatusLines({ named: two, used: one, ...status })[1];
  assert.equal(
    said({ supervisor: "Draining", starting: false }),
    `supervisor: draining in ${one}`,
  );
  assert.equal(
    said({ supervisor: "Ended", starting: true, startingIn: two }),
    `supervisor: ended, last ready in ${one}; a start in ${two} is under way`,
  );
  assert.equal(
    said({ supervisor: "Starting", starting: true, startingIn: two }),
    `supervisor: starting in ${two}`,
  );
  assert.equal(
    said({ supervisor: "Ended", starting: false }),
    `supervisor: ended, last ready in ${one}`,
  );
  assert.equal(
    chatHostStatusLines({
      supervisor: "Absent",
      starting: true,
      startingIn: one,
    })[1],
    `supervisor: absent; a start in ${one} is under way`,
  );
});
