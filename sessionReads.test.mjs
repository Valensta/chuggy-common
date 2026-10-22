/**
 * The reads a session's shell makes of its project's repositories, its own
 * among them: which sessions are served them, what a git the runtime starts is answered,
 * the scrub a read minted mid-session is held to, and the end of the socket
 * with the session's.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sessionPlaneRoutes } from "@chuggy/worker-contract/sessionPlane";
import { sessionTaskVariable } from "@chuggy/worker-contract/workerEnvironment";

import { forgeGitIsolated, forgeServed } from "./gitForge.fixture.mjs";
import { projectReadsFields } from "./projectReads.mjs";
import {
  environment,
  facts,
  leadRoster,
  mintedCredential,
  planeOf,
  queryOf,
  rejection,
  result,
  run,
  task,
  threadRoster,
  turnOne,
} from "./sessionHarness.fixture.mjs";
import {
  blockStop,
  liveReader,
  messageStart,
  messageStop,
  settled,
  streamed,
  textDelta,
  textStart,
} from "./sessionLive.fixture.mjs";

const own = "https://forge.test/org/own.git";
const lib = "https://forge.test/org/lib.git";

/** The read the plane mints of the library while a session runs. */
const read = {
  username: "x-access-token",
  password: "ghs_readOfLibMintedMidSession0123",
  expiresAtMs: mintedCredential.expiresAtMs,
};

const threadFacts = { ...facts, kind: "Thread", capabilities: threadRoster };
const leadFacts = { ...facts, kind: "Lead", capabilities: leadRoster };
const init = { type: "system", subtype: "init", session_id: "runtime-1" };
const credentialPath = sessionPlaneRoutes.credential.path;

/** A plane minting the session's own repository its credential, `lib` its read, and nothing for any other. */
function mintsOf(ownRepository, libRepository) {
  return (repository) => {
    if (repository === ownRepository) return mintedCredential;
    return repository === libRepository ? read : undefined;
  };
}

/** Every repository the session's credential route was asked for, in order. */
function credentialAsks(plane) {
  return plane.calls
    .filter(({ path }) => path === credentialPath)
    .map(({ body }) => body.repository);
}

/**
 * One git run under what the runtime was handed and nothing of this machine's
 * configuration, `input` on its stdin, which a git that reads none may have
 * closed before it is written.
 */
function gitUnder(handed, args, input = "") {
  return new Promise((ran) => {
    const child = execFile(
      "git",
      args,
      { env: { ...handed, PATH: process.env.PATH ?? "", ...forgeGitIsolated } },
      (error, stdout, stderr) =>
        ran({ code: error?.code ?? 0, stdout, stderr }),
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** What git's credential machinery fills in for `url` under `handed`, or nothing it could not. */
async function filledUnder(handed, url) {
  const ran = await gitUnder(handed, ["credential", "fill"], `url=${url}\n\n`);
  if (ran.code !== 0) return undefined;
  const fields = projectReadsFields(ran.stdout);
  return { username: fields.get("username"), password: fields.get("password") };
}

/**
 * One session placed against `reference` and run over `script`, its reads
 * served under a directory of the case's own: the runtime's options, what it
 * printed, and the socket its reads were served at, which `during` says was
 * there when the runtime opened.
 */
/** A script whose runtime throws as it is opened, before any turn is read. */
const unopened = () => [];

async function readingSession(t, plane, script, reference = own) {
  const minted = await mkdtemp(join(tmpdir(), "chuggy-session-reads-"));
  t.after(() => rm(minted, { recursive: true, force: true }));
  const socket = join(minted, "chuggy-git-reads.sock");
  const warned = [];
  const scripted = queryOf(script);
  let during;
  const opened = script !== unopened;
  const code = await run({
    request: plane.request,
    requestOnce: plane.requestOnce,
    query: (asked) => {
      during = existsSync(socket);
      if (!opened) throw new Error("the runtime would not open");
      return scripted.query(asked);
    },
    environment: {
      ...environment,
      [sessionTaskVariable]: JSON.stringify({
        ...task,
        repository: { reference },
      }),
    },
    write: async () => undefined,
    checkout: async () => undefined,
    minted,
    warn: (text) => warned.push(text),
    liveBounds: { postGapMsMin: 0 },
  });
  return { code, seen: scripted.seen, warned, socket, during };
}

/** A turn that asks git for the library's credential before anything else, and then yields `then`. */
function mintingFirst(then) {
  const asked = {};
  return {
    asked,
    script: (_turn, _index, options) => [
      init,
      async () => {
        asked.filled = await filledUnder(options.env, lib);
      },
      ...then(options),
    ],
  };
}

/**
 * Catches a thread whose git is configured to ask nothing, or asks for the
 * library and is answered anything but the plane's read; and a lead, whose
 * roster runs no command, served reads it has no git to use.
 */
test("a thread's git is answered the plane's read of another repository its project binds, and a lead's is handed nothing", async (t) => {
  const answers = {};
  for (const [kind, sessionFacts] of [
    ["thread", threadFacts],
    ["lead", leadFacts],
  ]) {
    const plane = planeOf(
      [turnOne],
      sessionFacts,
      undefined,
      mintsOf(own, lib),
    );
    const turn = mintingFirst(() => [result("success", { result: "read" })]);

    const { code, seen } = await readingSession(t, plane, turn.script);

    assert.equal(code, 0, kind);
    answers[kind] = {
      filled: turn.asked.filled,
      counted: seen.options.env.GIT_CONFIG_COUNT,
      asks: credentialAsks(plane),
    };
  }

  assert.deepEqual(answers.thread.filled, {
    username: read.username,
    password: read.password,
  });
  assert.equal(answers.thread.counted, "5");
  assert.deepEqual(answers.thread.asks, [own, lib]);
  assert.deepEqual(answers.lead, {
    filled: undefined,
    counted: undefined,
    asks: [own],
  });
});

/**
 * Over a forge that holds them. Catches a repository the project does not
 * bind presented anything, a refusal that ends the reads for the git after
 * it, and the session's own repository refused through them, which leaves its
 * shell unable to fetch the repository it works in.
 */
test("a repository the project does not bind is answered nothing, and git goes on to read the session's own and one it binds", async (t) => {
  const names = {
    own: "org/own.git",
    lib: "org/lib.git",
    unbound: "org/unbound.git",
  };
  const forge = await forgeServed(t, Object.values(names));
  await forge.seed(names.lib, { "lib.txt": "the library\n" });
  await forge.seed(names.unbound, { "x.txt": "unbound\n" });
  await forge.seed(names.own, { "README.md": "# own\n" });
  forge.accept(names.lib, read.password);
  forge.accept(names.own, mintedCredential.password);
  forge.accept(names.unbound, mintedCredential.password);
  const plane = planeOf(
    [turnOne],
    threadFacts,
    undefined,
    mintsOf(forge.url(names.own), forge.url(names.lib)),
  );
  const ran = {};
  const script = (_turn, _index, options) => [
    async () => {
      for (const name of ["unbound", "own", "lib"])
        ran[name] = await gitUnder(options.env, [
          "ls-remote",
          forge.url(names[name]),
          "main",
        ]);
    },
    result("success", { result: "read" }),
  ];

  await readingSession(t, plane, script, forge.url(names.own));

  const presented = (name) =>
    forge.presented
      .filter(({ repository }) => repository === names[name])
      .map(({ password }) => password);
  assert.notEqual(ran.unbound.code, 0);
  for (const name of ["own", "lib"]) {
    assert.equal(ran[name].code, 0, ran[name].stderr);
    assert.match(ran[name].stdout, /^[0-9a-f]{40}\trefs\/heads\/main$/mu);
  }
  assert.deepEqual(presented("unbound"), []);
  assert.deepEqual([...new Set(presented("own"))], [mintedCredential.password]);
  assert.deepEqual([...new Set(presented("lib"))], [read.password]);
  assert.deepEqual(credentialAsks(plane), [
    forge.url(names.own),
    forge.url(names.unbound),
    forge.url(names.own),
    forge.url(names.lib),
  ]);
});

/** Catches a read the plane minted after the session's scrub was built left in a turn's answer. */
test("a read minted mid-session is scrubbed out of the turn's answer", async (t) => {
  const plane = planeOf([turnOne], threadFacts, undefined, mintsOf(own, lib));
  const turn = mintingFirst(() => [
    result("success", { result: `cloned with ${read.password}` }),
  ]);

  await readingSession(t, plane, turn.script);

  const answered = plane.calls.find(
    ({ path }) => path === sessionPlaneRoutes.turnAnswer.path,
  ).body.result;
  assert.equal(answered, "cloned with [redacted credential]");
  assert.equal(turn.asked.filled?.password, read.password);
});

/** Catches the store, opened before the read was minted, uploading it in a transcript. */
test("a read minted mid-session is scrubbed out of the transcript the store uploads", async (t) => {
  const plane = planeOf([turnOne], threadFacts, undefined, mintsOf(own, lib));
  const turn = mintingFirst((options) => [
    () =>
      options.sessionStore.append({ sessionId: "runtime-1" }, [
        {
          uuid: "a",
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: `read ${read.password}` }],
          },
        },
      ]),
    result("success", { result: "stored" }),
  ]);

  await readingSession(t, plane, turn.script);

  const stored = plane.calls.find(
    ({ path }) => path === "/v1/session/store/runtime-1/1",
  );
  assert.ok(stored, "the transcript was never stored");
  assert.ok(
    !String(stored.body).includes(read.password),
    "the read was stored",
  );
  assert.ok(String(stored.body).includes("read [redacted credential]"));
  assert.equal(turn.asked.filled?.password, read.password);
});

/**
 * Catches the live sender, opened before the read was minted, posting a head
 * of it: every delta is one character and is posted on its own, so each head
 * of the read is a post that could have carried it.
 */
test("a read minted mid-session is never posted at the head of a thread's stream", async (t) => {
  const plane = planeOf([turnOne], threadFacts, undefined, mintsOf(own, lib));
  const text = `the read ${read.password} is held`;
  const turn = mintingFirst(() =>
    [
      messageStart("message-1"),
      textStart(0),
      ...[...text].map((delta) => textDelta(0, delta)),
      blockStop(0),
      messageStop,
    ]
      .flatMap((event) => [streamed(event), settled])
      .concat([result("success", { result: "held" })]),
  );

  await readingSession(t, plane, turn.script);

  const posts = plane.calls
    .filter(({ path }) => path === sessionPlaneRoutes.turnLive.path)
    .map(({ body }) => body);
  const head = read.password.slice(0, 4);
  for (const post of posts)
    assert.ok(!JSON.stringify(post).includes(head), JSON.stringify(post));
  const reader = liveReader();
  for (const post of posts) reader.posted(post);
  assert.equal(
    reader.states.at(-2).blocks[0].text,
    "the read [redacted credential] is held",
  );
  assert.equal(turn.asked.filled?.password, read.password);
});

/** Catches the failure path, which took the scrub before the read was minted, printing it. */
test("a read minted mid-session is scrubbed out of what a failed session prints", async (t) => {
  const plane = planeOf([turnOne], threadFacts, undefined, mintsOf(own, lib));
  const turn = mintingFirst(() => [
    () => {
      throw new Error(`the remote refused ${read.password}`);
    },
  ]);

  const { code, warned } = await readingSession(t, plane, turn.script);

  assert.equal(code, 1);
  assert.ok(!warned.join("").includes(read.password), warned.join(""));
  assert.ok(warned.includes("the remote refused [redacted credential]\n"));
  assert.equal(turn.asked.filled?.password, read.password);
});

/**
 * Catches a socket left behind a session, whose server keeps the pod's
 * process from exiting after its last turn. Each case is a way a session
 * ends: its mailbox idle, its budget spent, its turns run out, its account
 * held, the store refusing it, the plane stopping it, its runtime failing, and
 * its runtime never opening.
 */
test("the reads end with the session on every path it ends by", async (t) => {
  const ending =
    (...messages) =>
    () =>
      messages;
  const cases = [
    { name: "idle", turns: [], script: ending(), code: 0 },
    {
      name: "budget",
      script: ending(result("error_max_budget_usd")),
      code: 0,
    },
    { name: "turns", script: ending(result("error_max_turns")), code: 0 },
    {
      name: "held",
      script: ending(rejection, result("success", { result: "held" })),
      code: 0,
    },
    {
      name: "store refused",
      script: ending(
        { type: "system", subtype: "mirror_error" },
        result("success", { result: "refused" }),
      ),
      code: 1,
    },
    {
      name: "plane stopped",
      turns: [],
      refuse: (path) =>
        path === sessionPlaneRoutes.turn.path ? 401 : undefined,
      script: ending(),
      code: 0,
    },
    {
      name: "failed",
      script: ending(() => {
        throw new Error("the runtime failed");
      }),
      code: 1,
    },
    { name: "never opened", script: unopened, code: 1 },
  ];

  for (const ended of cases) {
    const plane = planeOf(
      ended.turns ?? [turnOne],
      threadFacts,
      ended.refuse,
      mintsOf(own, lib),
    );

    const { code, during, socket } = await readingSession(
      t,
      plane,
      ended.script,
    );

    assert.equal(code, ended.code, ended.name);
    assert.equal(during, true, `${ended.name}: the reads were never served`);
    await assert.rejects(
      access(socket),
      { code: "ENOENT" },
      `${ended.name}: the socket outlived the session`,
    );
  }
});
