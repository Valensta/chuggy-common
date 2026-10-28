/**
 * Two sessions run as a supervisor runs them, as root on Linux: each its own
 * user, on real directories, real mirrors and real processes, with
 * `./chatIsolation.fixture.mjs` in place of the core, probing what one
 * session can reach of the other's and of the mirrors. A suite run anywhere
 * else proves none of it, and is skipped saying so.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  chown,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { workerCredentialFilesVariable } from "@chuggy/worker-contract/workerEnvironment";

import { chatCheckout, chatMirrorsOpened } from "./chatCheckout.mjs";
import {
  chatSessionHome,
  chatSessionsOpened,
  chatSessionLabel,
  chatSystem,
  chatUserProcesses,
} from "./chatSession.mjs";
import { poolHeldSessionAnswer } from "./envelope.fixture.mjs";

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));

/** Why this machine cannot answer the suite's question, or nothing where it can. */
const skipped =
  process.platform !== "linux"
    ? `sessions are users of a Linux container, and this is ${process.platform}`
    : process.getuid?.() !== 0
      ? "only root can run a session as a user of its own"
      : false;

/** The users the suite's sessions run as, and the groups its mirrors have. */
const uidFirst = 41_000;
const groupFirst = 42_000;

/** A user of the image's own that holds the provider credential, which the supervisor is to read as. */
const credentialOwner = 1_000;

/** The users this suite made for its sessions to run as, by uid, removed once it is over. */
const usersMade = new Map();

/** Each user and group the suite's sessions run as made where the machine does not name it, as an image names its own. */
before(async () => {
  if (skipped !== false) return;
  for (const uid of [uidFirst, uidFirst + 1]) {
    const named = await run("getent", ["passwd", String(uid)]).then(
      () => true,
      () => false,
    );
    if (named) continue;
    const name = `chuggy-suite-${String(uid)}`;
    await run("groupadd", ["--gid", String(uid), name]);
    await run("useradd", [
      "--uid",
      String(uid),
      "--gid",
      String(uid),
      "--no-create-home",
      "--shell",
      "/usr/sbin/nologin",
      name,
    ]);
    usersMade.set(uid, name);
  }
});

after(async () => {
  for (const name of usersMade.values()) {
    await run("userdel", [name]).catch(() => undefined);
    await run("groupdel", [name]).catch(() => undefined);
  }
  usersMade.clear();
});

/** The assignment every session of the suite is prepared for, named as no log prefix may hold it. */
const assignment = "isolation run] [1";

const bearers = [
  "chgs_a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
  "chgs_b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
];

function envelopeOf(bearer) {
  return {
    callbackUrl: "http://pool-plane.test:3002",
    bearer,
    timeoutSecsMax: 1_800,
    outputBytesMax: 4_096,
  };
}

/** The task the plane answers a session bound to `reference`, granted that repository's credential. */
function answerOf(reference, slot = "claude-code") {
  return {
    ...poolHeldSessionAnswer,
    credentialSlot: slot,
    repository: { reference },
    authority: {
      ...poolHeldSessionAnswer.authority,
      credentials: [`git-${reference}`],
    },
  };
}

/** A repository at `path` with one commit, and that commit. */
async function remoteOf(path, text) {
  await run("git", ["init", "--quiet", "--initial-branch=trunk", path]);
  return committed(path, text);
}

async function committed(path, text) {
  await writeFile(join(path, "CLAUDE.md"), text);
  await run("git", ["add", "CLAUDE.md"], { cwd: path });
  await run(
    "git",
    [
      "-c",
      "user.email=s@chuggy.invalid",
      "-c",
      "user.name=s",
      "commit",
      "-qm",
      text,
    ],
    { cwd: path },
  );
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: path });
  return stdout.trim();
}

/** A digest of `bearer`, which the probe says in its place since its output is scrubbed of it. */
function digestOf(bearer) {
  return createHash("sha256").update(bearer).digest("hex");
}

/** The first line `logged` holds of the session `label` names carrying `key`, once one does. */
async function said(logged, label, key) {
  const prefix = `[${label}] `;
  for (let tries = 0; tries < 400; tries += 1) {
    for (const line of logged.join("").split("\n")) {
      if (!line.startsWith(`${prefix}{`)) continue;
      const parsed = JSON.parse(line.slice(prefix.length));
      if (parsed[key] !== undefined) return parsed[key];
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
  throw new Error(`${label} never said ${key}: ${logged.join("")}`);
}

/** `body` handed a directory every user may enter, removed after. */
async function inMachine(body) {
  const root = await mkdtemp(join(tmpdir(), "chuggy-chat-isolation-"));
  await chmod(root, 0o755);
  try {
    await body((name) => join(root, name));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A file `credentialOwner` owns, holding `text`, in a directory made with `mode`. */
async function ownedCredential(directory, mode, text) {
  await mkdir(directory, { mode });
  const file = join(directory, "claude-code");
  await writeFile(file, text, { mode: 0o600 });
  await chown(file, credentialOwner, credentialOwner);
  return file;
}

/**
 * What a machine holds before its supervisor starts: two remotes only root
 * reads, the provider credential its owner reads and one its owner cannot,
 * and the probe every session user reads.
 */
async function machinePlaced(place) {
  await mkdir(place("remotes"), { mode: 0o700 });
  const heads = {
    a: await remoteOf(join(place("remotes"), "a"), "# a\n"),
    b: await remoteOf(join(place("remotes"), "b"), "# b\n"),
  };
  const credentials = {
    "claude-code": await ownedCredential(place("credentials"), 0o755, "x"),
    locked: await ownedCredential(place("locked"), 0o700, "y"),
  };
  await copyFile(join(here, "chatIsolation.fixture.mjs"), place("probe.mjs"));
  await chmod(place("probe.mjs"), 0o644);
  return { heads, credentials };
}

/** The checkout a supervisor makes, over `mirrors`, of the machine's remotes. */
function checkoutOf(place, mirrors, log) {
  const repositories = Object.fromEntries(
    ["a", "b"].map((reference) => [
      reference,
      {
        url: join(place("remotes"), reference),
        credential: `git-${reference}`,
        credentialUsername: "x",
      },
    ]),
  );
  return (task, bearer, workspace, { signal, uid }) =>
    chatCheckout(task, bearer, workspace, {
      mint: async () => undefined,
      mirrors,
      repositories,
      credentialFiles: { "git-a": "/absent", "git-b": "/absent" },
      environment: process.env,
      user: { uid, gid: uid },
      signal,
      log,
    });
}

/**
 * A supervisor's sessions on a machine placed under `place`, run as
 * `uidCount` users from `uidFirst`, each answered the task `answers` holds
 * for its bearer. Each user the suite made is given the home a session run
 * as it is handed there, as an image names it.
 */

async function supervisorIn(place, uidCount = 2) {
  const { heads, credentials } = await machinePlaced(place);
  for (const [uid, name] of usersMade)
    await run("usermod", [
      "--home",
      chatSessionHome(place("sessions"), uid),
      name,
    ]);

  const logged = [];
  const log = (text) => logged.push(text);
  const mirrors = await chatMirrorsOpened({
    root: place("mirrors"),
    groupFirst,
    groupCount: 4,
  });
  const answers = new Map();
  const sessions = await chatSessionsOpened(
    {
      uidFirst,
      uidCount,
      sessionsRoot: place("sessions"),
      mintedRoot: place("minted"),
      supervisorMinted: place("supervisor"),
      freeBytesMin: 1,
      stopGraceMs: 300,
      clearWaitMs: 60_000,
      node: process.execPath,
      entrypoint: place("probe.mjs"),
      environment: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        [workerCredentialFilesVariable]: JSON.stringify(credentials),
      },
    },
    {
      system: chatSystem(),
      log,
      task: async (envelope) => ({
        mode: "Session",
        answer: answers.get(envelope.bearer),
      }),
      checkout: checkoutOf(place, mirrors, log),
    },
  );
  return { heads, logged, sessions, answers };
}

/** The mirror a session's tree borrows from, read from its alternates. */
async function mirrorOf(workspace) {
  const alternates = await readFile(
    join(workspace, "repository", ".git", "objects", "info", "alternates"),
    "utf8",
  );
  return dirname(alternates.trim());
}

/** One session's places, by its user. */
function placesOf(place, uid) {
  const id = `session-${String(uid)}`;
  return {
    id,
    label: chatSessionLabel(assignment, uid),
    workspace: join(place("sessions"), id),
    minted: join(place("minted"), id),
  };
}

/** Asks the probe in `workspace` to try `targets`, a file it sees only once whole. */
async function probeAsked(workspace, targets) {
  const partial = join(workspace, "probe.json.partial");
  await writeFile(partial, JSON.stringify(targets));
  await rename(partial, join(workspace, "probe.json"));
}

/** What a session's probe is to try, against the session `other` and its own `mirror` and the other's. */
function targetsOf(place, own, other, mirrors) {
  return {
    sessions: place("sessions"),
    otherWorkspace: other.workspace,
    otherMinted: other.minted,
    otherPid: other.hello?.pid ?? 1,
    mirror: mirrors[0],
    otherMirror: mirrors[1] ?? "/nonexistent",
    credential: join(own.minted, "provider-credential"),
  };
}

/** Two sessions started on `machine`, the first bound to `a` and the second to `b`, and what each said as it started. */
async function twoStarted(place, machine) {
  machine.answers.set(bearers[0], answerOf("a"));
  machine.answers.set(bearers[1], answerOf("b"));
  const live = new globalThis.AbortController().signal;
  const started = [];
  for (const [index, bearer] of bearers.entries()) {
    const running = await machine.sessions.prepared(
      assignment,
      envelopeOf(bearer),
      live,
    );
    const own = placesOf(place, uidFirst + index);
    started.push({
      ...own,
      running,
      hello: await said(machine.logged, own.label, "hello"),
      mirror: await mirrorOf(own.workspace),
    });
  }
  return started;
}

/** What `own` was started as, and its probe found, of `other` and of the mirrors. */
async function isolationAsserted(machine, own, index, reference, probed) {
  const { hello } = own;
  assert.equal(hello.uid, uidFirst + index);
  assert.equal(hello.gid, uidFirst + index);
  assert.deepEqual(
    [...hello.groups].sort(),
    [uidFirst + index, (await stat(own.mirror)).gid].sort(),
  );
  assert.equal(hello.capabilities, "0000000000000000");
  assert.equal(hello.noNewPrivileges, "1");
  assert.equal(hello.processesMax, "4096");
  assert.ok(!hello.variables.includes(workerCredentialFilesVariable));
  assert.deepEqual(probed, {
    bearer: digestOf(bearers[index]),
    tree: machine.heads[reference],
    made: 0o600,
    sessions: "EACCES",
    otherWorkspace: "EACCES",
    otherMinted: "EACCES",
    otherSignal: "EPERM",
    mirrorWrite: "EACCES",
    mirrorConfig: "EACCES",
    otherMirror: "EACCES",
    credential: "ok",
  });
  const copy = await stat(join(own.minted, "provider-credential"));
  assert.equal(copy.mode & 0o777, 0o400);
  assert.equal(copy.uid, uidFirst + index);
  assert.ok(
    !machine.logged.join("").includes(bearers[index]),
    "a bearer was logged",
  );
  assert.ok(
    (await chatUserProcesses(uidFirst + index)).includes(hello.background),
    "a session's background process was not left running to be stopped",
  );
}

/** Catches a session that can read, write or signal anything of another's, or a mirror its project does not bind. */
test(
  "two sessions are two users, neither reaching the other or a mirror not its own, and a stop leaves nothing of either",
  { skip: skipped },
  () =>
    inMachine(async (place) => {
      const machine = await supervisorIn(place);
      const started = await twoStarted(place, machine);
      const privateTree = join(
        tmpdir(),
        `chuggy-private-${String(process.pid)}`,
      );
      for (const [index, own] of started.entries()) {
        const other = started[1 - index];
        await probeAsked(own.workspace, {
          ...targetsOf(place, own, other, [own.mirror, other.mirror]),
          ignoreStop: index === 1,
          ...(index === 1 ? { privateTree } : {}),
        });
      }
      for (const [index, own] of started.entries())
        await isolationAsserted(
          machine,
          own,
          index,
          ["a", "b"][index],
          await said(machine.logged, own.label, "probed"),
        );

      for (const { running } of started) running.stop();

      assert.equal(await started[0].running.ended, "Succeeded");
      assert.equal(await started[1].running.ended, "Failed");
      for (const [index, own] of started.entries()) {
        assert.deepEqual(
          await chatUserProcesses(uidFirst + index),
          [],
          "a process of a stopped session was left",
        );
        await assert.rejects(stat(own.workspace), { code: "ENOENT" });
        await assert.rejects(stat(own.minted), { code: "ENOENT" });
      }
      assert.deepEqual(await readdir(place("supervisor")), []);
      assert.equal((await readdir(place("mirrors"))).length, 2);
      assert.doesNotMatch(
        machine.logged.join(""),
        /its user is not given out again/u,
        "a session's clear failed on what another session left",
      );
      await assert.rejects(stat(privateTree), { code: "ENOENT" });
    }),
);

/** Catches a mirror whose later fetch leaves what it added unreadable by the group a session borrows through. */
test(
  "a later session reads what its mirror fetched since, through its group",
  { skip: skipped },
  () =>
    inMachine(async (place) => {
      const machine = await supervisorIn(place, 1);
      machine.answers.set(bearers[0], answerOf("a"));
      const live = new globalThis.AbortController().signal;
      const own = placesOf(place, uidFirst);
      const first = await machine.sessions.prepared(
        assignment,
        envelopeOf(bearers[0]),
        live,
      );
      await said(machine.logged, own.label, "hello");
      first.stop();
      await first.ended;
      const later = await committed(join(place("remotes"), "a"), "# later\n");
      machine.logged.length = 0;

      const second = await machine.sessions.prepared(
        assignment,
        envelopeOf(bearers[0]),
        live,
      );
      await said(machine.logged, own.label, "hello");
      await probeAsked(
        own.workspace,
        targetsOf(place, own, placesOf(place, uidFirst + 1), [
          await mirrorOf(own.workspace),
        ]),
      );

      assert.equal(
        (await said(machine.logged, own.label, "probed")).tree,
        later,
      );
      second.stop();
      assert.equal(await second.ended, "Succeeded");
    }),
);

/** The ids of every System V IPC object `uid` owns or made. */
async function ipcOf(uid) {
  const held = [];
  for (const table of ["shm", "msg", "sem"]) {
    const text = await readFile(join("/proc/sysvipc", table), "utf8");
    const [header = "", ...rows] = text.trim().split("\n");
    const columns = header.trim().split(/\s+/u);
    const owners = [columns.indexOf("uid"), columns.indexOf("cuid")];
    for (const row of rows) {
      const fields = row.trim().split(/\s+/u);
      if (owners.some((at) => fields[at] === String(uid)))
        held.push(`${table} ${String(fields[1])}`);
    }
  }
  return held;
}

/** One session on `machine` run to its end, having first been asked to do what `targets` says. */
async function oneRun(place, machine, targets) {
  const own = placesOf(place, uidFirst);
  const running = await machine.sessions.prepared(
    assignment,
    envelopeOf(bearers[0]),
    new globalThis.AbortController().signal,
  );
  await said(machine.logged, own.label, "hello");
  await probeAsked(own.workspace, {
    ...targetsOf(place, own, placesOf(place, uidFirst + 1), [
      await mirrorOf(own.workspace),
    ]),
    ...targets,
  });

  const probed = await said(machine.logged, own.label, "probed");
  machine.logged.length = 0;
  running.stop();
  assert.equal(await running.ended, "Succeeded");
  return probed;
}

/** Catches a user given out again with what its last session left where every user writes, or in System V IPC. */
test(
  "what a session leaves in the places every user writes is gone before its user runs another",
  { skip: skipped },
  () =>
    inMachine(async (place) => {
      const machine = await supervisorIn(place, 1);
      machine.answers.set(bearers[0], answerOf("a"));
      const name = `chuggy-scattered-${String(process.pid)}`;
      const scatter = ["/tmp", "/var/tmp", "/dev/shm", "/run/lock"].map(
        (root) => join(root, name),
      );

      const first = await oneRun(place, machine, { scatter });

      assert.equal(first.scattered, "ok");
      for (const path of scatter)
        for (const each of [path, `${path}.d`])
          await assert.rejects(stat(each), { code: "ENOENT" });
      assert.deepEqual(await ipcOf(uidFirst), [], machine.logged.join(""));
      const second = await oneRun(place, machine, { seek: scatter });
      assert.deepEqual(second.found, []);
    }),
);

/**
 * Catches a user's clear that walks another session user's tree, which that
 * user may make too deep to walk or closed to root, and so fail every other
 * user's clear.
 */
test(
  "a user's clear leaves another session user's directory to that user, whatever it holds",
  { skip: skipped },
  () =>
    inMachine(async (place) => {
      const [own, other] = [uidFirst, uidFirst + 1];
      const scratch = place("scratch");
      await mkdir(scratch, { mode: 0o1777 });
      await chmod(scratch, 0o1777);
      const left = join(scratch, "left");
      await writeFile(left, "x");
      await chown(left, own, own);
      let deeper = join(scratch, "theirs");
      await mkdir(deeper, { mode: 0o700 });
      await chown(deeper, other, other);
      for (let depth = 0; depth < 8; depth += 1) {
        deeper = join(deeper, "d");
        await mkdir(deeper, { mode: 0o700 });
        await chown(deeper, other, other);
      }
      const planted = join(deeper, "planted");
      await writeFile(planted, "x");
      await chown(planted, own, own);

      await chatSystem().scattered(own, [scratch]);

      await assert.rejects(stat(left), { code: "ENOENT" });
      assert.equal((await stat(planted)).uid, own);
    }),
);

/** Catches a provider credential read with root's reach rather than its owner's. */
test(
  "a provider credential its owner cannot read is not read for a session",
  { skip: skipped },
  () =>
    inMachine(async (place) => {
      const machine = await supervisorIn(place);
      machine.answers.set(bearers[0], answerOf("a", "locked"));

      await assert.rejects(
        machine.sessions.prepared(
          assignment,
          envelopeOf(bearers[0]),
          new globalThis.AbortController().signal,
        ),
      );
    }),
);
