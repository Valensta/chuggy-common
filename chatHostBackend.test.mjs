/**
 * A chat host's backend over a supervisor a suite speaks for frame by frame,
 * and over the supervisor itself, whose sessions a suite prepares and ends by
 * hand: what each frame of its means to the pool loop, and that the bearer a
 * `Start` carries reaches the supervisor's input and nothing else.
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  chatProtocolLine,
  chatProtocolVersion,
  parseChatHostFrame,
} from "@chuggy/worker-contract/chatHost";
import { workerContractRelease } from "@chuggy/worker-contract/workerContract";

import {
  chatHostBackend,
  chatHostLogLineBytesMax,
  chatHostLogRouted,
} from "./chatHostBackend.mjs";
import { chatSessionLabel } from "./chatSession.mjs";
import { chatSupervised } from "./chatSupervisor.mjs";

const bearer = "chgs_0123456789abcdef0123456789abcdef";

const settings = {
  outputBytesMax: 4_096,
  readyWaitMs: 5_000,
  exitWaitMs: 5_000,
  stopWaitMs: 5_000,
};

/** A session the plane offers, under `bearer`. */
function sessionOf(assignment) {
  return {
    assignment,
    capabilities: [],
    cpuMillis: 500,
    memoryMib: 512,
    deadlineSecs: 1_800,
    callbackUrl: "https://worker-plane.invalid/v1/session",
    bearer,
    image: "registry.invalid/chuggy/chat:1",
  };
}

const ready = {
  frame: "Ready",
  protocols: [chatProtocolVersion],
  sessionsMax: 2,
  contractRelease: workerContractRelease,
};

/** Every pending callback run, so what a frame starts has answered. */
async function settled() {
  for (let turn = 0; turn < 4; turn += 1)
    await new Promise((resolve) => globalThis.setImmediate(resolve));
}

/** Past a bound of a millisecond, and every callback it starts run. */
async function elapsed() {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  await settled();
}

/**
 * A backend and a supervisor a suite speaks for: `frames` is what the host
 * wrote it, `say` writes its frames, `logged` every line either log took,
 * each naming its log, and `exit` ends its process.
 */
function hostOf(given = settings) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const written = [];
  input.on("data", (chunk) => written.push(String(chunk)));
  let exit;
  const handle = {
    input,
    output,
    errors,
    exited: new Promise((resolve) => {
      exit = resolve;
    }),
    kills: 0,
    kill: () => {
      handle.kills += 1;
      exit();
    },
  };
  const logged = [];
  const backend = chatHostBackend(given, {
    log: (line) => logged.push(["host", line]),
    logFor: (assignment) => (line) => logged.push([assignment, line]),
  });
  return {
    backend,
    handle,
    logged,
    frames: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line !== "")
        .map(parseChatHostFrame),
    say: (...frames) => output.write(frames.map(chatProtocolLine).join("")),
    exit: () => exit(),
    endedInput: () => input.writableEnded,
  };
}

/** A host whose supervisor said it was ready. */
async function readyHost(given = settings) {
  const host = hostOf(given);
  const attached = host.backend.attached(host.handle);
  host.say(ready);
  assert.deepEqual(await attached, { ready });
  return host;
}

/** Asserts no log took the bearer. */
function bearerUnlogged(host) {
  assert.ok(
    host.logged.every(([, line]) => !line.includes(bearer)),
    JSON.stringify(host.logged),
  );
}

test("a supervisor has no room until it is ready, and then the room its Ready names", async () => {
  const host = hostOf();
  assert.equal(host.backend.phase(), "Absent");
  const attached = host.backend.attached(host.handle);
  assert.equal(host.backend.phase(), "Starting");
  assert.equal(host.backend.ceiling(), 0);
  assert.deepEqual(await host.backend.place(sessionOf("a"), "Session"), {
    placed: "Unavailable",
  });
  host.say(ready);
  assert.deepEqual(await attached, { ready });
  assert.equal(host.backend.phase(), "Ready");
  assert.equal(host.backend.ceiling(), 2);
  assert.deepEqual(host.frames(), []);
  assert.throws(
    () => host.backend.attached(hostOf().handle),
    /one supervisor at a time/u,
  );
});

test("a supervisor that does not speak this protocol, writes before it is ready, or says nothing in bound is ended and killed", async () => {
  const other = hostOf();
  const attached = other.backend.attached(other.handle);
  other.say({ ...ready, protocols: [chatProtocolVersion + 1] });
  const answer = await attached;
  assert.match(
    "refused" in answer ? answer.refused : "",
    new RegExp(
      `speaks protocol ${String(chatProtocolVersion + 1)} and this host speaks ${String(chatProtocolVersion)}`,
      "u",
    ),
  );
  for (const host of [other]) {
    assert.equal(host.backend.phase(), "Ended");
    assert.equal(host.handle.kills, 1);
    assert.ok(host.endedInput());
  }
  const early = hostOf();
  const earlyAttached = early.backend.attached(early.handle);
  early.say({ frame: "Drained" });
  assert.match(
    JSON.stringify(await earlyAttached),
    /a frame before it was ready/u,
  );
  const silent = hostOf({ ...settings, readyWaitMs: 1 });
  assert.match(
    JSON.stringify(await silent.backend.attached(silent.handle)),
    /not ready within 1 ms/u,
  );
  assert.equal(silent.handle.kills, 1);
  assert.equal(silent.backend.ceiling(), 0);
});

test("a session is placed once its Start is written, carrying its bearer to the supervisor and to no log", async () => {
  const host = await readyHost();
  assert.deepEqual(await host.backend.place(sessionOf("a"), "Session"), {
    placed: "Placed",
  });
  assert.deepEqual(await host.backend.place(sessionOf("a"), "Session"), {
    placed: "Placed",
  });
  assert.deepEqual(host.frames(), [
    {
      frame: "Start",
      assignment: "a",
      envelope: {
        callbackUrl: "https://worker-plane.invalid/v1/session",
        bearer,
        timeoutSecsMax: 1_800,
        outputBytesMax: 4_096,
      },
    },
  ]);
  assert.deepEqual(await host.backend.held(), [
    { assignment: "a", kind: "Session" },
  ]);
  await host.backend.place(sessionOf("b"), "Session");
  assert.deepEqual(await host.backend.place(sessionOf("c"), "Session"), {
    placed: "Unavailable",
  });
  assert.deepEqual(await host.backend.place(sessionOf("d"), "Job"), {
    placed: "Refused",
    evidence: "a chat host runs sessions alone, and was offered a job",
  });
  host.say({ frame: "Started", assignment: "a" });
  await settled();
  bearerUnlogged(host);
});

test("a Start longer than a frame is refused, naming nothing of it, and nothing is written", async () => {
  const host = await readyHost();
  const long = { ...sessionOf("a"), bearer: `${bearer}${"x".repeat(17_000)}` };
  const placed = await host.backend.place(long, "Session");
  assert.deepEqual(placed, {
    placed: "Refused",
    evidence: "the session's start is no frame its supervisor reads",
  });
  assert.deepEqual(host.frames(), []);
  assert.deepEqual(await host.backend.held(), []);
  bearerUnlogged(host);
});

test("each answer to a Start is named by ended once, in the phase the supervisor says, and a duplicate's earlier answer stands", async () => {
  const host = await readyHost({ ...settings });
  host.say({ ...ready, sessionsMax: 9 });
  for (const assignment of ["a", "b"])
    await host.backend.place(sessionOf(assignment), "Session");
  host.say(
    { frame: "Started", assignment: "a" },
    { frame: "Refused", assignment: "a", reason: "Duplicate" },
    { frame: "Ended", assignment: "a", phase: "Succeeded" },
    { frame: "Refused", assignment: "b", reason: "Unprepared" },
  );
  await settled();
  const attempt = (assignment) => ({
    assignment,
    callbackUrl: "https://worker-plane.invalid/v1/session",
    bearer,
  });
  assert.deepEqual(await host.backend.ended(), [
    { kind: "Session", session: attempt("a"), phase: "Succeeded" },
    { kind: "Session", session: attempt("b"), phase: "Failed" },
  ]);
  assert.deepEqual(await host.backend.ended(), []);
  assert.deepEqual(await host.backend.held(), []);
  for (const reason of ["Full", "Draining"]) {
    await host.backend.place(sessionOf(reason), "Session");
    host.say({ frame: "Refused", assignment: reason, reason });
  }
  host.say({ frame: "Ended", assignment: "never", phase: "Succeeded" });
  await settled();
  assert.deepEqual(
    (await host.backend.ended()).map(({ session, phase }) => [
      session.assignment,
      phase,
    ]),
    [
      ["Full", "Failed"],
      ["Draining", "Failed"],
    ],
  );
  assert.equal(host.backend.phase(), "Ready");
  assert.ok(
    host.logged.some(([, line]) => /said it was ready again/u.test(line)),
  );
  assert.ok(
    host.logged.some(([, line]) =>
      /"never", which this host did not start/u.test(line),
    ),
  );
});

test("a session stopped is stopped once, held until it is answered, and never named by ended", async () => {
  const host = await readyHost();
  for (const assignment of ["a", "b"])
    await host.backend.place(sessionOf(assignment), "Session");
  host.say({ frame: "Started", assignment: "b" });
  await settled();
  for (const assignment of ["a", "a", "b", "unknown"])
    assert.deepEqual(await host.backend.stop(assignment), {
      stopped: "Stopped",
    });
  assert.deepEqual(
    host.frames().filter(({ frame }) => frame === "Stop"),
    [
      { frame: "Stop", assignment: "a" },
      { frame: "Stop", assignment: "b" },
    ],
  );
  assert.deepEqual(
    (await host.backend.held()).map(({ assignment }) => assignment),
    ["a", "b"],
  );
  host.say(
    { frame: "Refused", assignment: "a", reason: "Stopped" },
    { frame: "Ended", assignment: "b", phase: "Failed" },
  );
  await settled();
  assert.deepEqual(await host.backend.held(), []);
  assert.deepEqual(await host.backend.ended(), []);
});

test("a supervisor that does not answer a stop in bound is ended and killed, and the session is held no longer", async () => {
  const host = await readyHost({ ...settings, stopWaitMs: 1 });
  for (const assignment of ["stopping", "running"])
    await host.backend.place(sessionOf(assignment), "Session");
  host.say(
    { frame: "Started", assignment: "stopping" },
    { frame: "Started", assignment: "running" },
  );
  await settled();
  await host.backend.stop("stopping");
  await elapsed();
  assert.equal(host.handle.kills, 1);
  assert.equal(host.backend.phase(), "Ended");
  assert.deepEqual(await host.backend.held(), []);
  assert.deepEqual(
    (await host.backend.ended()).map(({ session, phase }) => [
      session.assignment,
      phase,
    ]),
    [["running", "Failed"]],
  );
  assert.ok(
    host.logged.some(([, line]) =>
      /did not end "stopping" within 1 ms of its stop/u.test(line),
    ),
  );
});

test("a supervisor that exited is ended once its output ends, so what it wrote before it exited is read", async () => {
  const host = await readyHost();
  await host.backend.place(sessionOf("a"), "Session");
  host.say({ frame: "Started", assignment: "a" });
  host.exit();
  await settled();
  assert.equal(host.backend.phase(), "Ready");
  host.say(
    { frame: "Ended", assignment: "a", phase: "Succeeded" },
    { frame: "Drained" },
  );
  host.handle.output.end();
  await settled();
  assert.equal(host.backend.phase(), "Ended");
  assert.deepEqual(
    (await host.backend.ended()).map(({ session, phase }) => [
      session.assignment,
      phase,
    ]),
    [["a", "Succeeded"]],
  );
  await host.backend.closed();
  assert.equal(host.handle.kills, 0);
});

for (const [end, how] of /** @type {const} */ ([
  ["output", (host) => host.handle.output.end()],
  ["exit, its output not ending in bound", (host) => host.exit()],
  ["no frame", (host) => host.handle.output.write("not a frame\n")],
  [
    "an overlong line",
    (host) => host.handle.output.write(`${"x".repeat(17_000)}\n`),
  ],
]))
  test(`a supervisor's end by ${end} fails every session it was preparing or running, but one stopped, and it has no room after`, async () => {
    const host = await readyHost({ ...settings, exitWaitMs: 1 });
    host.say({ ...ready, sessionsMax: 3 });
    for (const assignment of ["preparing", "running", "stopping"])
      await host.backend.place(sessionOf(assignment), "Session");
    host.say(
      { frame: "Started", assignment: "running" },
      { frame: "Started", assignment: "stopping" },
    );
    await settled();
    await host.backend.stop("stopping");
    how(host);
    await elapsed();
    assert.equal(host.backend.phase(), "Ended");

    assert.equal(host.backend.ceiling(), 0);
    assert.deepEqual(
      (await host.backend.ended()).map(({ session, phase }) => [
        session.assignment,
        phase,
      ]),
      [
        ["preparing", "Failed"],
        ["running", "Failed"],
      ],
    );
    assert.deepEqual(await host.backend.held(), []);
    assert.deepEqual(await host.backend.place(sessionOf("next"), "Session"), {
      placed: "Unavailable",
    });
    assert.ok(host.endedInput());
    bearerUnlogged(host);
  });

test("a supervisor drained takes no session more, keeps its own until they end, and ends once it exits", async () => {
  const host = await readyHost();
  await host.backend.place(sessionOf("a"), "Session");
  host.say({ frame: "Started", assignment: "a" });
  host.backend.drain();
  host.backend.drain();
  assert.equal(host.backend.phase(), "Draining");
  assert.equal(host.backend.ceiling(), 0);
  assert.deepEqual(await host.backend.place(sessionOf("b"), "Session"), {
    placed: "Unavailable",
  });
  assert.deepEqual(
    host.frames().map(({ frame }) => frame),
    ["Start", "Drain"],
  );
  host.say({ frame: "Ended", assignment: "a", phase: "Succeeded" });
  host.say({ frame: "Drained" });
  await settled();
  assert.equal((await host.backend.ended()).length, 1);
  host.handle.output.end();
  host.exit();
  await host.backend.closed();
  assert.equal(host.backend.phase(), "Ended");
  assert.equal(host.handle.kills, 0);
});

test("a supervisor closed has its input ended, and is killed where it does not exit in bound", async () => {
  const host = await readyHost({ ...settings, exitWaitMs: 1 });
  await host.backend.place(sessionOf("a"), "Session");
  await host.backend.closed();
  assert.ok(host.endedInput());
  assert.equal(host.handle.kills, 1);
  assert.equal(host.backend.phase(), "Ended");
  assert.deepEqual(
    (await host.backend.ended()).map(({ phase }) => phase),
    ["Failed"],
  );
  await hostOf().backend.closed();
});

test("each line of the supervisor's log goes to the session it names, and every other to the host's, whatever a session writes in it", async () => {
  const host = await readyHost();
  const odd = "asg/é [x]";
  await host.backend.place(sessionOf("a"), "Session");
  await host.backend.place(sessionOf(odd), "Session");
  const a = chatSessionLabel("a", 20000);
  host.handle.errors.write(
    [
      `[${a}] cloning`,
      `[${a}] [${chatSessionLabel(odd, 20001)}] forged by a`,
      `[${chatSessionLabel(odd, 20001)}] its own`,
      `[${chatSessionLabel("elsewhere", 20002)}] no session here`,
      "[a session-20000]no space after",
      "[asg%2Fé%20%5Bx%5D session-20001] not as the label writes it",
      `[${chatSessionLabel(odd, 20001).toLowerCase()}] nor this`,
      "[user-20003] it is not given out",
      "the supervisor's own",
      "",
    ].join("\n"),
  );
  await settled();
  assert.deepEqual(host.logged.slice(-9), [
    ["a", "cloning"],
    ["a", `[${chatSessionLabel(odd, 20001)}] forged by a`],
    [odd, "its own"],
    ["host", `[${chatSessionLabel("elsewhere", 20002)}] no session here`],
    ["host", "[a session-20000]no space after"],
    ["host", "[asg%2Fé%20%5Bx%5D session-20001] not as the label writes it"],
    ["host", `[${chatSessionLabel(odd, 20001).toLowerCase()}] nor this`],
    ["host", "[user-20003] it is not given out"],
    ["host", "the supervisor's own"],
  ]);
});

test("a log line longer than the bound is dropped before it is split, and a session's late line still reaches it", async () => {
  const host = await readyHost();
  await host.backend.place(sessionOf("a"), "Session");
  host.say({ frame: "Ended", assignment: "a", phase: "Succeeded" });
  await settled();
  const label = chatSessionLabel("a", 20000);
  host.handle.errors.write(
    `[${label}] ${"y".repeat(chatHostLogLineBytesMax)}\n[${label}] after\n`,
  );
  host.handle.errors.end(`[${label}] unended`);
  await settled();
  assert.deepEqual(host.logged.slice(-3), [
    [
      "host",
      "the supervisor wrote a log line too long to keep, which was dropped",
    ],
    ["a", "after"],
    ["a", "unended"],
  ]);
});

test("a line is routed only by a label as the session's own is written", () => {
  assert.deepEqual(chatHostLogRouted("[a session-1] x", ["a"]), {
    assignment: "a",
    line: "x",
  });
  for (const line of [
    "[a session-01] x",
    "[a session-0] x",
    "[a  session-1] x",
    "[%61 session-1] x",
    " [a session-1] x",
  ])
    assert.deepEqual(chatHostLogRouted(line, ["a"]), { line });
});

/** A supervisor of this core's on the other end of the streams, over sessions a suite prepares and ends by hand. */
function supervisedHost() {
  const host = hostOf();
  const toSupervisor = host.handle.input;
  const preparations = [];
  const input = new PassThrough();
  toSupervisor.pipe(input);
  const exited = chatSupervised({
    input,
    output: { write: (line) => host.handle.output.write(line) },
    log: (text) => host.handle.errors.write(text),
    sessions: {
      prepared: (assignment, envelope, signal) =>
        new Promise((resolve, reject) => {
          preparations.push({ assignment, envelope, resolve });
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    },
    sessionsMax: 2,
  });
  exited.then(
    () => {
      host.handle.output.end();
      host.exit();
    },
    () => host.exit(),
  );
  return { ...host, preparations, exited };
}

/** A running session a suite ends by hand. */
function runningOf() {
  let end;
  return {
    stop: () => end("Failed"),
    ended: new Promise((resolve) => {
      end = resolve;
    }),
    end: (phase) => end(phase),
  };
}

test("against this core's supervisor, a session is started, stopped and drained as the protocol says", async () => {
  const host = supervisedHost();
  assert.ok("ready" in (await host.backend.attached(host.handle)));
  for (const assignment of ["a", "b"])
    await host.backend.place(sessionOf(assignment), "Session");
  await settled();
  assert.deepEqual(
    host.preparations.map(({ assignment, envelope }) => [
      assignment,
      envelope.bearer,
    ]),
    [
      ["a", bearer],
      ["b", bearer],
    ],
  );
  const a = runningOf();
  host.preparations[0].resolve(a);
  await host.backend.stop("b");
  await settled();
  assert.deepEqual(
    (await host.backend.held()).map(({ assignment }) => assignment),
    ["a"],
  );
  host.backend.drain();
  await settled();
  a.end("Succeeded");
  await settled();
  assert.deepEqual(
    (await host.backend.ended()).map(({ session, phase }) => [
      session.assignment,
      phase,
    ]),
    [["a", "Succeeded"]],
  );
  assert.equal(await host.exited, 0);
  await host.backend.closed();
  assert.equal(host.backend.phase(), "Ended");
  bearerUnlogged(host);
});
