/**
 * A chat supervisor's sessions, prepared and run on a system that only
 * records: which user each is run as, what is made for it and handed to it,
 * and what is removed after it. Whether the system then keeps sessions apart
 * is the isolation suite's question, asked as root on Linux.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { afterEach } from "node:test";

import {
  chatChannelVariable,
  chatCheckoutVariable,
  chatMintedVariable,
} from "./chatChannel.mjs";
import {
  chatSessionAsUser,
  chatSessionIpcCleared,
  chatSessionHome,
  chatSessionLabel,
  chatSessionMountsWalked,
  chatSessionScratchListed,
  chatSessionsOpened,
} from "./chatSession.mjs";
import { claudeCredentialVariable } from "./claudeCredential.mjs";
import { chatSupervisorCheckout } from "./chatSupervisor.mjs";
import {
  memberSessionAnswer,
  poolHeldSessionAnswer,
} from "./envelope.fixture.mjs";

const bearer = "chgs_fedcba9876543210fedcba9876543210";
const assignment = "assignment-1";
const token = "sk-ant-oat01-subscription-token-0123456789";

const envelope = {
  callbackUrl: "http://pool-plane.test:3002",
  bearer,
  timeoutSecsMax: 1_800,
  outputBytesMax: 4_096,
  providerCredentialFile: "/host/claude-code",
};

const settings = {
  uidFirst: 20_000,
  uidCount: 2,
  sessionsRoot: "/sessions",
  mintedRoot: "/minted",
  supervisorMinted: "/supervisor",
  freeBytesMin: 1_024,
  stopGraceMs: 10,
  clearWaitMs: 60_000,
  node: "/usr/bin/node",
  entrypoint: "/core/entrypoint.mjs",
  credentialFile: "/credentials/provider/claude.json",
  credentialOwner: { uid: 1_000, gid: 1_001 },
  environment: {
    PATH: "/usr/bin:/bin",
    CHUG_CHAT_CREDENTIAL: "/credentials/provider/claude.json",
    CHUG_SUPERVISOR_ONLY: "the supervisor's own",
    RUSTUP_HOME: "/usr/local/rustup",
    CARGO_HOME: "/usr/local/cargo",
  },
};

/** The one read of the credential each session's preparation makes. */
const credentialReadCall = [
  "credentialRead",
  settings.credentialFile,
  settings.credentialOwner,
];

/** Every child a test started, each ended once it is over so no session's deadline outlives it. */
const childrenStarted = [];

afterEach(() => {
  for (const child of childrenStarted.splice(0)) child.emit("exit", 0, null);
});

/** A child process as `spawn` answers one, whose channel's writes are kept. */
function childOf() {
  const child = new EventEmitter();
  const channel = new PassThrough();
  child.written = "";
  channel.on("data", (chunk) => {
    child.written += chunk;
  });
  child.channel = channel;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [null, child.stdout, child.stderr, channel];
  return child;
}

/**
 * A system that records each call in `calls`, starts each child in
 * `children`, and answers `credential()` for each credential read.
 */
function systemOf(overrides = {}) {
  const calls = [];
  const children = [];
  let credential = token;
  const recorded =
    (name) =>
    async (...args) => {
      calls.push([
        name,
        ...args.filter((arg) => !(arg instanceof globalThis.AbortSignal)),
      ]);
    };
  const system = {
    calls,
    children,
    credentialIs: (text) => {
      credential = text;
    },
    spawn: (program, args, options) => {
      const child = childOf();
      children.push({ program, args, options, child });
      childrenStarted.push(child);
      globalThis.queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    freeBytes: async () => 2 ** 40,
    rootMade: recorded("rootMade"),
    made: recorded("made"),
    listed: async () => [],
    credentialRead: async (path, owner) => {
      calls.push(["credentialRead", path, owner]);
      return credential;
    },
    credentialWritten: recorded("credentialWritten"),
    swept: recorded("swept"),
    emptied: recorded("emptied"),
    removed: recorded("removed"),
    scattered: async (uid, roots) => {
      calls.push(["scattered", uid]);
      system.scratched = roots;
    },
    named: async (uids) =>
      new Map(
        uids.map((uid) => [uid, chatSessionHome(settings.sessionsRoot, uid)]),
      ),
    scratchFound: async () => {
      calls.push(["scratchFound"]);
      return ["/tmp", "/run/lock"];
    },
    ...overrides,
  };
  return system;
}

/** The sessions opened on `system`, each logged line kept, under `changed` settings. */
async function sessionsOf(system, changed = {}, seams = {}) {
  const logged = [];
  const checkouts = [];
  const sessions = await chatSessionsOpened(
    { ...settings, ...changed },
    {
      system,
      log: (text) => logged.push(text),
      task: async () => ({ mode: "Session", answer: poolHeldSessionAnswer }),
      checkout: async (task, handed, workspace, asked) => {
        checkouts.push({ task, bearer: handed, workspace, asked });
        return {
          checkout: { directory: `${workspace}/repository`, commit: "abc" },
          group: 30_000,
        };
      },
      ...seams,
    },
  );
  return { sessions, logged, checkouts };
}

const live = () => new globalThis.AbortController().signal;

/** Every call `system` recorded after the `count`th. */
const since = (system, count) => system.calls.slice(count);

test("a session is started as its own user, in its own places, its envelope on its channel and nowhere else", async () => {
  const system = systemOf();
  const { sessions, checkouts } = await sessionsOf(system);
  const before = system.calls.length;

  await sessions.prepared(assignment, envelope, live());

  const [{ program, args, options, child }] = system.children;
  assert.deepEqual(
    [program, ...args],
    [
      "prlimit",
      "--nproc=4096",
      "--",
      "setpriv",
      "--reuid=20000",
      "--regid=20000",
      "--groups=30000",
      "--inh-caps=-all",
      "--bounding-set=-all",
      "--no-new-privs",
      "--",
      "/bin/sh",
      "-c",
      'umask 077 && exec "$@"',
      "sh",
      "/usr/bin/node",
      "/core/entrypoint.mjs",
    ],
  );
  assert.equal(options.cwd, "/sessions/session-20000");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe", "pipe"]);
  assert.deepEqual(options.env, {
    PATH: "/usr/bin:/bin",
    RUSTUP_HOME: "/usr/local/rustup",
    HOME: "/sessions/session-20000/home",
    TMPDIR: "/sessions/session-20000/tmp",
    CHUG_WORKER_WORKSPACE: "/sessions/session-20000",
    [chatChannelVariable]: "3",
    [chatMintedVariable]: "/minted/session-20000",
    [chatCheckoutVariable]: JSON.stringify({
      directory: "/sessions/session-20000/repository",
      commit: "abc",
    }),
  });
  assert.deepEqual(JSON.parse(child.written), {
    ...envelope,
    providerCredentialFile: "/minted/session-20000/provider-credential",
  });
  assert.deepEqual(since(system, before), [
    ["made", "/sessions/session-20000", 20_000],
    ["made", "/sessions/session-20000/home", 20_000],
    ["made", "/sessions/session-20000/tmp", 20_000],
    ["made", "/minted/session-20000", 20_000],
    ["rootMade", "/supervisor/session-20000", 0o700],
    credentialReadCall,
    [
      "credentialWritten",
      "/minted/session-20000/provider-credential",
      token,
      20_000,
    ],
    ["removed", "/supervisor/session-20000"],
  ]);
  assert.deepEqual(checkouts[0].asked.uid, 20_000);
  assert.equal(checkouts[0].asked.minted, "/supervisor/session-20000");
  assert.equal(checkouts[0].bearer, bearer);
  assert.equal(checkouts[0].task.workerPlane.url, envelope.callbackUrl);
});

/**
 * Catches a supervisor that looks the credential up by the slot a session's
 * task names, which fails every session of a deployment whose slot is not the
 * one a host mounted it under, or that reads it as whoever a look at the file
 * reports.
 */
test("a session's credential is the one the supervisor is handed, whatever slot its task names, read as the owner it is told", async () => {
  const system = systemOf();
  const { sessions } = await sessionsOf(
    system,
    {},
    {
      task: async () => ({
        mode: "Session",
        answer: { ...poolHeldSessionAnswer, credentialSlot: "anthropic-site" },
      }),
    },
  );

  await sessions.prepared(assignment, envelope, live());

  assert.deepEqual(
    system.calls.filter(([name]) => name === "credentialRead"),
    [
      [
        "credentialRead",
        "/credentials/provider/claude.json",
        { uid: 1_000, gid: 1_001 },
      ],
    ],
  );
  assert.equal(
    JSON.parse(system.children[0].child.written).providerCredentialFile,
    "/minted/session-20000/provider-credential",
  );
});

test("a command run as an owner runs as its uid and gid, with no other group and no capability", () => {
  assert.deepEqual(
    chatSessionAsUser({ uid: 1_000, gid: 1_001 }, [], ["cat", "--", "/x"]),
    [
      "setpriv",
      "--reuid=1000",
      "--regid=1001",
      "--clear-groups",
      "--inh-caps=-all",
      "--bounding-set=-all",
      "--no-new-privs",
      "--",
      "cat",
      "--",
      "/x",
    ],
  );
});

/** Catches a line the checkout says of a session that the host cannot read back to its assignment. */
test("what the checkout says of a session reaches the log named for it, line by line", async () => {
  const { sessions, logged, checkouts } = await sessionsOf(systemOf());
  await sessions.prepared(assignment, envelope, live());

  checkouts[0].asked.log("session checkout main at abc\n");
  checkouts[0].asked.log("could not discard\nits tree\n");

  assert.deepEqual(logged.join("").split("\n").filter(Boolean), [
    "[assignment-1 session-20000] session checkout main at abc",
    "[assignment-1 session-20000] could not discard",
    "[assignment-1 session-20000] its tree",
  ]);
});

/** Catches a tree with no repository's group handed the group of none, or of another's. */
test("a session with no tree is given no group beside its own", async () => {
  const system = systemOf();
  const { sessions } = await sessionsOf(
    system,
    {},
    {
      checkout: async () => ({ checkout: undefined }),
    },
  );

  await sessions.prepared(assignment, envelope, live());

  const [{ args, options }] = system.children;
  assert.ok(args.includes("--clear-groups"));
  assert.ok(!args.some((arg) => arg.startsWith("--groups")));
  assert.equal(options.env[chatCheckoutVariable], "{}");
});

/**
 * Catches a member's own session, which no repository binds, handed a mirror
 * or a clone by the supervisor's own checkout. A mint would ask a plane this
 * suite does not serve, and the session would not be started.
 */
test("a member's own session is started with no tree, and the supervisor mirrors and clones nothing for it", async () => {
  const system = systemOf();
  const mirrored = [];
  const { sessions } = await sessionsOf(
    system,
    {},
    {
      task: async () => ({ mode: "Session", answer: memberSessionAnswer }),
      checkout: chatSupervisorCheckout(
        {},
        {
          updated: async (...asked) => {
            mirrored.push(asked);
            throw new Error("a member's own session was mirrored for");
          },
        },
      ),
    },
  );

  await sessions.prepared(assignment, envelope, live());

  assert.deepEqual(mirrored, []);
  const [{ args, options }] = system.children;
  assert.ok(args.includes("--clear-groups"));
  assert.ok(!args.some((arg) => arg.startsWith("--groups")));
  assert.equal(options.env[chatCheckoutVariable], "{}");
});

test("what a session writes reaches the supervisor's log named for it, without its bearer or credential", async () => {
  const system = systemOf();
  const { sessions, logged } = await sessionsOf(system);
  await sessions.prepared(assignment, envelope, live());
  const [{ child }] = system.children;

  child.stdout.write(`said ${bearer}\nand `);
  child.stderr.write(`failed with ${token}\n`);
  child.stdout.end("more\n");
  child.stderr.end(`${"x".repeat(64 * 1024)}\n`);
  await new Promise((resolve) => globalThis.setImmediate(resolve));

  const printed = logged.join("");
  assert.ok(!printed.includes(bearer), "the bearer was printed");
  assert.ok(!printed.includes(token), "the credential was printed");
  assert.match(
    printed,
    /^\[assignment-1 session-20000\] said \[redacted credential\]$/mu,
  );
  assert.match(printed, /^\[assignment-1 session-20000\] and more$/mu);
  assert.match(printed, /^\[assignment-1 session-20000\] failed with /mu);
  assert.match(
    printed,
    /^\[assignment-1 session-20000\] a line too long to keep was dropped$/mu,
  );
});

/** Catches an assignment named to end a line, or to begin one as another session's, on a log the host reads back by assignment. */
test("an assignment cannot name its way into another line's prefix", async () => {
  const system = systemOf();
  const { sessions, logged } = await sessionsOf(system);
  const forged = "a session-20001] forged\n[b session-20001] ü%";
  await sessions.prepared(forged, envelope, live());
  await sessions.prepared("b", envelope, live());
  const [{ child }] = system.children;

  child.stdout.end("hello\n");
  await new Promise((resolve) => globalThis.setImmediate(resolve));

  const label =
    "a%20session-20001%5D%20forged%0A%5Bb%20session-20001%5D%20%C3%BC%25";
  assert.equal(chatSessionLabel(forged, 20_000), `${label} session-20000`);
  assert.deepEqual(logged.join("").split("\n").filter(Boolean), [
    `[${label} session-20000] hello`,
  ]);
  assert.match(
    chatSessionLabel(forged, 20_000),
    /^[A-Za-z0-9._%-]+ session-\d+$/u,
  );
});

/** Catches two sessions given one user, or one minted directory, or a credential read once and kept. */
test("two sessions are two users with places apart, each reading the credential as it is then", async () => {
  const system = systemOf();
  const { sessions } = await sessionsOf(system);

  await sessions.prepared(assignment, envelope, live());
  system.credentialIs(`${token}-renewed`);
  await sessions.prepared(assignment, envelope, live());

  const [first, second] = system.children;
  assert.ok(first.args.includes("--reuid=20000"));
  assert.ok(second.args.includes("--reuid=20001"));
  assert.equal(first.options.env[chatMintedVariable], "/minted/session-20000");
  assert.equal(second.options.env[chatMintedVariable], "/minted/session-20001");
  const written = system.calls.filter(([name]) => name === "credentialWritten");
  assert.deepEqual(
    written.map(([, path, text]) => [path, text]),
    [
      ["/minted/session-20000/provider-credential", token],
      ["/minted/session-20001/provider-credential", `${token}-renewed`],
    ],
  );
  await assert.rejects(
    sessions.prepared(assignment, envelope, live()),
    /every user a session may be run as is held/u,
  );
});

test("a session that ends is cleared as its user before its end is told, and its user is free again", async () => {
  const system = systemOf();
  const { sessions } = await sessionsOf(system);
  const running = await sessions.prepared(assignment, envelope, live());
  await sessions.prepared(assignment, envelope, live());
  const before = system.calls.length;

  system.children[0].child.emit("exit", 0, null);

  assert.equal(await running.ended, "Succeeded");
  assert.deepEqual(since(system, before), [
    ["swept", 20_000],
    ["emptied", "/sessions/session-20000", 20_000],
    ["emptied", "/minted/session-20000", 20_000],
    ["removed", "/supervisor/session-20000"],
    ["scattered", 20_000],
  ]);
  await sessions.prepared(assignment, envelope, live());
  assert.ok(system.children[2].args.includes("--reuid=20000"));
});

/** Catches a user given out again at once, where one that has rested since is free. */
test("users are given out in turn, a free one only once those after it have been", async () => {
  const system = systemOf();
  const { sessions } = await sessionsOf(system, { uidCount: 3 });

  for (let session = 0; session < 4; session += 1) {
    const running = await sessions.prepared(assignment, envelope, live());
    system.children[session].child.emit("exit", 0, null);
    await running.ended;
  }

  assert.deepEqual(
    system.children.map(({ args }) =>
      args.find((arg) => arg.startsWith("--reuid=")),
    ),
    ["--reuid=20000", "--reuid=20001", "--reuid=20002", "--reuid=20000"],
  );
});

/** Catches a user given out again with files or IPC objects of its last session still in the places every user writes. */
test("a session's user whose scattered leftovers could not be removed is not given out again", async () => {
  const system = systemOf({
    scattered: async () => {
      if (system.children.length > 0) throw new Error("find: timed out");
    },
  });
  const { sessions, logged } = await sessionsOf(system);
  const running = await sessions.prepared(assignment, envelope, live());

  system.children[0].child.emit("exit", 0, null);
  await running.ended;

  assert.match(
    logged.join(""),
    /\[assignment-1 session-20000\] the removal of what it left in the places every user writes failed: find: timed out/u,
  );
  assert.match(logged.join(""), /its user is not given out again/u);
  await sessions.prepared(assignment, envelope, live());
  await assert.rejects(
    sessions.prepared(assignment, envelope, live()),
    /every user a session may be run as is held/u,
  );
});

/** Catches a stop a host must wait on for as long as a session's directories take to empty. */
test("a session's clear cut short by its bound still ends the session, and its user is not given out again", async () => {
  const signals = [];
  const system = systemOf({
    emptied: (_path, _uid, signal) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const { sessions, logged } = await sessionsOf(system, { clearWaitMs: 20 });
  const running = await sessions.prepared(assignment, envelope, live());

  system.children[0].child.emit("exit", 0, null);

  assert.equal(await running.ended, "Succeeded");
  assert.equal(signals.length, 2);
  assert.match(
    logged.join(""),
    /\[assignment-1 session-20000\] the removal of \/sessions\/session-20000 failed: .*timeout/u,
  );
  assert.match(logged.join(""), /its user is not given out again/u);
  await sessions.prepared(assignment, envelope, live());
  assert.ok(system.children[1].args.includes("--reuid=20001"));
});

/** Catches scattered leftovers removed while a process of the user may still be making more. */

test("what a session scattered is not looked for while its processes may outlive the sweep", async () => {
  const system = systemOf({
    swept: async (uid) => {
      if (uid === 20_000 && system.children.length > 0)
        throw new Error("the processes outlived a sweep");
    },
  });
  const { sessions } = await sessionsOf(system);
  const running = await sessions.prepared(assignment, envelope, live());
  const before = system.calls.length;

  system.children[0].child.emit("exit", 0, null);
  await running.ended;

  assert.ok(!since(system, before).some(([name]) => name === "scattered"));
});

/** Catches a directory made but not handed to its user, left in the way of every later session of that user. */
test("a directory whose handing over failed is cleared with the rest", async () => {
  const system = systemOf({
    made: async (path, uid) => {
      system.calls.push(["made", path, uid]);
      if (path.endsWith("/home")) throw new Error("chown: EPERM");
    },
  });
  const { sessions } = await sessionsOf(system);
  const before = system.calls.length;

  await assert.rejects(
    sessions.prepared(assignment, envelope, live()),
    /EPERM/u,
  );

  assert.deepEqual(
    since(system, before).filter(([name]) => name === "emptied"),
    [["emptied", "/sessions/session-20000", 20_000]],
  );
});

test("a session whose process does not exit clean ends Failed", async () => {
  for (const [code, signal] of [
    [1, null],
    [null, "SIGKILL"],
  ]) {
    const system = systemOf();
    const { sessions } = await sessionsOf(system);
    const running = await sessions.prepared(assignment, envelope, live());

    system.children[0].child.emit("exit", code, signal);

    assert.equal(await running.ended, "Failed");
  }
});

/** Catches a stop that kills at once, or never, or reaches another session's user. */
test("a stop ends the session's channel, and its user's processes are killed once its grace has passed", async () => {
  const system = systemOf();
  const { sessions } = await sessionsOf(system);
  await sessions.prepared(assignment, envelope, live());
  const running = await sessions.prepared(assignment, envelope, live());
  const { child } = system.children[1];
  const ended = new Promise((resolve) => child.channel.once("end", resolve));
  const before = system.calls.length;

  running.stop();
  running.stop();

  await ended;
  assert.deepEqual(since(system, before), []);
  await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
  assert.deepEqual(since(system, before), [["swept", 20_001]]);
  child.emit("exit", 0, null);
  assert.equal(await running.ended, "Succeeded");
});

test("a session still running at its deadline is stopped, and ends Failed however it exits", async () => {
  const system = systemOf();
  const { sessions } = await sessionsOf(system);
  const running = await sessions.prepared(
    assignment,
    { ...envelope, timeoutSecsMax: 1 },
    live(),
  );
  const { child } = system.children[0];

  await new Promise((resolve) => child.channel.once("end", resolve));
  child.emit("exit", 0, null);

  assert.equal(await running.ended, "Failed");
});

/**
 * Catches a refused preparation that leaves what it made, or holds its user,
 * or that says nothing of why.
 */
test("a preparation that fails is refused with everything it made gone and its user free", async () => {
  const system = systemOf({
    credentialRead: async () => {
      throw new Error("the credential is not there");
    },
  });
  const { sessions, logged } = await sessionsOf(system);
  const before = system.calls.length;

  await assert.rejects(
    sessions.prepared(assignment, envelope, live()),
    /the credential is not there/u,
  );

  assert.deepEqual(since(system, before).slice(5), [
    ["swept", 20_000],
    ["emptied", "/sessions/session-20000", 20_000],
    ["emptied", "/minted/session-20000", 20_000],
    ["removed", "/supervisor/session-20000"],
    ["scattered", 20_000],
  ]);
  assert.match(
    logged.join(""),
    /\[assignment-1 session-20000\] was not prepared: /u,
  );
  assert.deepEqual(system.children, []);
  await assert.rejects(
    sessions.prepared(assignment, envelope, live()),
    /not there/u,
  );
  await assert.rejects(
    sessions.prepared(assignment, envelope, live()),
    /not there/u,
  );
  assert.equal(
    system.calls.filter(
      ([name, path]) => name === "made" && path === "/sessions/session-20000",
    ).length,
    2,
    "a user whose preparation failed was not free again",
  );
});

test("a credential the session would refuse is refused before the session starts", async () => {
  const system = systemOf();
  const { sessions } = await sessionsOf(system, {
    environment: {
      ...settings.environment,
      [claudeCredentialVariable]: JSON.stringify({
        kind: "Vertex",
        region: "us-east5",
        project: "example",
      }),
    },
  });
  system.credentialIs("not a service account's key");

  await assert.rejects(sessions.prepared(assignment, envelope, live()));

  assert.deepEqual(system.children, []);
  assert.ok(!system.calls.some(([name]) => name === "credentialWritten"));
});

/** Catches a credential its kind reads from a file named by the supervisor's path, which the session cannot read. */
test("a credential its kind reads from a file is copied for the session, and its copy is what the session names", async () => {
  const system = systemOf();
  const key = JSON.stringify({ type: "service_account", private_key: "k" });
  const kind = JSON.stringify({
    kind: "Vertex",
    region: "us-east5",
    project: "example",
  });
  const { sessions } = await sessionsOf(system, {
    environment: { ...settings.environment, [claudeCredentialVariable]: kind },
  });
  system.credentialIs(key);

  await sessions.prepared(assignment, envelope, live());

  const [{ child, options }] = system.children;
  assert.deepEqual(
    system.calls.find(([name]) => name === "credentialWritten"),
    [
      "credentialWritten",
      "/minted/session-20000/provider-credential",
      key,
      20_000,
    ],
  );
  assert.equal(
    JSON.parse(child.written).providerCredentialFile,
    "/minted/session-20000/provider-credential",
  );
  assert.equal(options.env[claudeCredentialVariable], kind);
});

test("a session is not prepared on a disk with too little free, and nothing is made", async () => {
  const system = systemOf({ freeBytes: async () => 1 });
  const { sessions } = await sessionsOf(system);
  const before = system.calls.length;

  await assert.rejects(
    sessions.prepared(assignment, envelope, live()),
    /\/sessions has too little free space/u,
  );

  assert.ok(!since(system, before).some(([name]) => name === "made"));
});

/** Catches a stop that waits out a plane that does not answer, or that is logged as a failure. */
test("a preparation stopped while the plane is asked is given up, cleared, and not logged as a failure", async () => {
  const system = systemOf();
  const { sessions, logged } = await sessionsOf(
    system,
    {},
    {
      task: () => new Promise(() => undefined),
    },
  );
  const stop = new globalThis.AbortController();

  const prepared = sessions.prepared(assignment, envelope, stop.signal);
  await new Promise((resolve) => globalThis.setImmediate(resolve));
  stop.abort(new Error("stopped"));

  await assert.rejects(prepared, /stopped/u);
  assert.deepEqual(system.children, []);
  assert.ok(system.calls.some(([name]) => name === "emptied"));
  assert.equal(logged.join(""), "");
});

test("a preparation stopped once its checkout is made starts no process", async () => {
  const system = systemOf();
  const stop = new globalThis.AbortController();
  const { sessions } = await sessionsOf(
    system,
    {},
    {
      checkout: async () => {
        stop.abort(new Error("stopped"));
        return { checkout: undefined };
      },
    },
  );

  await assert.rejects(
    sessions.prepared(assignment, envelope, stop.signal),
    /stopped/u,
  );

  assert.deepEqual(system.children, []);
});

test("a process that cannot be started is refused, and its session cleared", async () => {
  const system = systemOf({
    spawn: () => {
      const child = childOf();
      globalThis.queueMicrotask(() =>
        child.emit("error", new Error("spawn prlimit ENOENT")),
      );
      return child;
    },
  });
  const { sessions } = await sessionsOf(system);

  await assert.rejects(
    sessions.prepared(assignment, envelope, live()),
    /ENOENT/u,
  );

  assert.ok(system.calls.some(([name]) => name === "emptied"));
});

/** Catches a user given out again while what its last session left may still be there. */
test("a session's user whose directories could not be removed is not given out again", async () => {
  const system = systemOf({
    emptied: async () => {
      throw new Error("Directory not empty");
    },
  });
  const { sessions, logged } = await sessionsOf(system);
  const running = await sessions.prepared(assignment, envelope, live());

  system.children[0].child.emit("exit", 0, null);
  await running.ended;
  await sessions.prepared(assignment, envelope, live());

  assert.ok(system.children[1].args.includes("--reuid=20001"));
  assert.match(logged.join(""), /its user is not given out again/u);
});

/** Catches a supervisor that hands out a user a predecessor's session still has processes or files of. */
test("sessions opened sweep every session user and clear what a predecessor left", async () => {
  const left = {
    "/sessions": [
      { path: "/sessions/session-20001", uid: 20_001 },
      { path: "/sessions/stray", uid: 0 },
    ],
    "/minted": [{ path: "/minted/session-20001", uid: 20_001 }],
    "/supervisor": [{ path: "/supervisor/session-20001", uid: 0 }],
  };
  const system = systemOf({ listed: async (root) => left[root] ?? [] });

  const { sessions } = await sessionsOf(system);

  assert.deepEqual(system.calls, [
    ["rootMade", "/sessions", 0o711],
    ["rootMade", "/minted", 0o711],
    ["rootMade", "/supervisor", 0o700],
    ["swept", 20_000],
    ["swept", 20_001],
    ["scratchFound"],
    ["scattered", 20_000],
    ["scattered", 20_001],
    ["emptied", "/sessions/session-20001", 20_001],
    ["removed", "/sessions/stray"],
    ["emptied", "/minted/session-20001", 20_001],
    ["removed", "/supervisor/session-20001"],
  ]);
  assert.deepEqual(system.scratched, ["/tmp", "/run/lock"]);
  assert.equal(await sessions.holding(), true);
});

/** Catches a supervisor that gives out a user its image does not name, whose session finds no name, home or identity. */
test("a supervisor whose range holds a user the image does not name refuses to start, naming the range", async () => {
  const system = systemOf({
    named: async (uids) =>
      new Map(
        uids
          .filter((uid) => uid !== 20_001)
          .map((uid) => [uid, chatSessionHome(settings.sessionsRoot, uid)]),
      ),
  });

  await assert.rejects(
    sessionsOf(system),
    /^Error: the users 20000 to 20001 a session may be run as are not all named in this image's passwd$/u,
  );
  assert.deepEqual(system.calls, []);
});

/** Catches a passwd whose home for a session's user is not the one the session is handed, where ssh would look for its keys. */
test("a supervisor whose image names another home for a session's user refuses to start, naming the home it hands", async () => {
  const system = systemOf({
    named: async (uids) =>
      new Map(uids.map((uid) => [uid, `/home/session-${String(uid)}`])),
  });

  await assert.rejects(
    sessionsOf(system),
    /^Error: this image's passwd names a home for user 20000 other than \/sessions\/session-20000\/home, the one a session run as it is handed$/u,
  );
  assert.deepEqual(system.calls, []);
  assert.equal(
    chatSessionHome("/sessions", 20_000),
    "/sessions/session-20000/home",
  );
});

/** Catches IPC objects matched by an owner a session may set to another user's, or one gone before its removal failing the clear. */
test("a user's IPC objects are those it made, and one gone before its removal is gone", async () => {
  const table = (rows) =>
    [
      "       key      shmid perms   size  cpid  lpid nattch   uid   gid  cuid  cgid",
      ...rows,
    ].join("\n");
  const reads = [
    table([
      "         0          7  600   4096    10    10      0 20000 20000 20001 20001",
      "         0          8  600   4096    11    11      0 20001 20001 20000 20000",
    ]),
    table([]),
  ];
  const removed = [];

  await chatSessionIpcCleared(20_000, {
    read: async (path) => (path.endsWith("/shm") ? reads.shift() : undefined),
    remove: async (flag, id) => {
      removed.push([flag, id]);
      throw new Error("ipcrm: invalid id");
    },
  });

  assert.deepEqual(removed, [["-m", "8"]]);
  await assert.rejects(
    chatSessionIpcCleared(20_000, {
      read: async (path) =>
        path.endsWith("/shm")
          ? table([
              "         0          8  600   4096    11    11      0 20000 20000 20000 20000",
            ])
          : undefined,
      remove: async () => undefined,
    }),
    /a System V IPC object user 20000 made outlived its removal/u,
  );
});

/** Catches a clear failed by what another user removed while it looked, or one that passes over a look `find` could not finish. */
test("a scratch place gone while it is looked through is gone, and any other complaint fails the look", async () => {
  const place = await mkdtemp(join(tmpdir(), "chuggy-scratch-listed-"));
  try {
    const kept = join(place, "kept");
    await mkdir(kept);

    assert.deepEqual(
      await chatSessionScratchListed(
        [kept, kept, join(place, "gone")],
        ["-type", "d", "-print0"],
      ),
      [kept],
    );
    await assert.rejects(
      chatSessionScratchListed([kept], ["-no-such-predicate"]),
    );
  } finally {
    await rm(place, { recursive: true, force: true });
  }
});

/** Catches a mount the scratch places are looked for on that a session cannot write, or one it can that is passed over. */
test("the scratch places are looked for on every writable mount a file can be left on", () => {
  const mounts = [
    "overlay / overlay rw,relatime 0 0",
    "proc /proc proc rw,nosuid 0 0",
    "tmpfs /dev tmpfs rw,nosuid 0 0",
    "sysfs /sys sysfs ro,nosuid 0 0",
    "mqueue /dev/mqueue mqueue rw,nosuid 0 0",
    "shm /dev/shm tmpfs rw,nosuid 0 0",
    "tmpfs /proc/acpi tmpfs ro,relatime 0 0",
    "tmpfs /scratch\\040space tmpfs rw 0 0",
    "",
  ].join("\n");

  assert.deepEqual(chatSessionMountsWalked(mounts), [
    "/",
    "/dev",
    "/dev/mqueue",
    "/dev/shm",
    "/scratch space",
  ]);
});

test("a predecessor's directory that cannot be cleared holds its user", async () => {
  const system = systemOf({
    listed: async (root) =>
      root === "/sessions"
        ? [{ path: "/sessions/session-20000", uid: 20_000 }]
        : [],
    emptied: async () => {
      throw new Error("Operation not permitted");
    },
  });
  const { sessions } = await sessionsOf(system);

  await sessions.prepared(assignment, envelope, live());

  assert.ok(system.children[0].args.includes("--reuid=20001"));
});

/** Catches a root-owned leftover named for a session's user, which every later session of that user would fail to make again. */
test("a predecessor's leftover no session user owns, which cannot be removed, holds the user it is named for", async () => {
  const system = systemOf({
    listed: async (root) =>
      root === "/sessions" ? [{ path: "/sessions/session-20000", uid: 0 }] : [],
    removed: async (path) => {
      if (path === "/sessions/session-20000")
        throw new Error("Operation not permitted");
    },
  });
  const { sessions } = await sessionsOf(system);

  await sessions.prepared(assignment, envelope, live());

  assert.ok(system.children[0].args.includes("--reuid=20001"));
});

/** Catches a supervisor kept from starting by one user's process that no kill reaches. */
test("a user whose processes outlive the sweep at the start is held, and the supervisor starts", async () => {
  const system = systemOf({
    swept: async (uid) => {
      if (uid === 20_000) throw new Error("the processes outlived a sweep");
    },
  });
  const { sessions, logged } = await sessionsOf(system);

  await sessions.prepared(assignment, envelope, live());

  assert.ok(system.children[0].args.includes("--reuid=20001"));
  assert.match(logged.join(""), /\[user-20000\] it is not given out/u);
});
