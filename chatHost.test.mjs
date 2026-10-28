/**
 * A member's chat host over a plane, an engine and supervisors a suite
 * fakes: which image its supervisor runs in and when it is started again,
 * what its polls ask for while it has no supervisor, and the container a
 * supervisor is run as.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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

import {
  chatHost,
  chatHostRestartBackoffMs,
  chatHostUnreadyWaitMs,
  chatHostVolumes,
  chatSupervisorContainer,
} from "./chatHost.mjs";

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
  credentialFiles: { claude: "/home/geoff/.chuggy/claude.json" },
  credentialOwner: { uid: 0, gid: 0 },
};

const settings = {
  sessionsMax: 2,
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
 * A chat host over fakes:
 `answers` is each poll's answer in turn, a poll
 * past them denied, and `present` the images the engine holds. A pull waits
 * on `gate`; a host's wait outlasts a start it is making unless `hasty`, so
 * a start takes no time of the host's clock.
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
  },
) {
  const runtimeDir = await mkdtemp(join(tmpdir(), "chuggy-chat-host-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const seen = {
    polls: [],
    ended: [],
    execs: [],
    started: [],
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
      site: { engine: "docker", runtimeDir, dockerHost: "unix:///docker.sock" },
      started: (container) => {
        seen.started.push(container);
        seen.startedMs.push(clock);
        seen.events.push(`started ${container.image}`);
        const supervisor = supervisorOf(3, lingering);
        supervisors.push(supervisor);
        return supervisor.handle;
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
  const run = await hostOf(t, {
    answers: [
      named(),
      named(),
      named(),
      () => {
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

test("a supervisor's container is root with the capabilities it needs and none to gain, its credentials read-only beneath a directory only their owner opens", () => {
  const container = chatSupervisorContainer(one, {
    ...places,
    credentialOwner: { uid: 1000, gid: 1000 },
    claudeCredential: { kind: "Subscription" },
    repositories: '{"kasofsk/chuggy":{}}',
    variables: { CHUG_CHAT_SESSIONS_MAX: "4" },
  });
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
        gid: 1000,
        sizeBytes: 1024 * 1024,
        flags: ["nosuid", "nodev", "noexec"],
      },
    ],
    binds: [
      {
        source: "/home/geoff/.chuggy/claude.json",
        target: "/var/run/chuggy/credentials/claude",
      },
    ],
    environment: {
      CHUG_CHAT_SESSIONS_MAX: "4",
      CHUG_WORKER_CREDENTIAL_FILES:
        '{"claude":"/var/run/chuggy/credentials/claude"}',
      CHUG_WORKER_CLAUDE_CREDENTIAL: '{"kind":"Subscription"}',
      CHUG_WORKER_REPOSITORIES: '{"kasofsk/chuggy":{}}',
    },
  });
});

test("a container whose credentials a session's user could own or open another way, or whose supervisor would move its places, is refused", () => {
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
    [{ variables: { CHUG_CHAT_UID_FIRST: "30000" } }, /overlap the groups/u],
    [{ credentialFiles: { "../x": "/a" } }, /no credential slot/u],
    [{ credentialFiles: { "..": "/a" } }, /no credential slot/u],
    [{ credentialFiles: { claude: "relative.json" } }, /no absolute path/u],
  ])
    assert.throws(
      () => chatSupervisorContainer(one, { ...places, ...changed }),
      why,
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
