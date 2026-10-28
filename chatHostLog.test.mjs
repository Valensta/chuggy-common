import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  chatSessionLogFile,
  chatSessionLogKeptBytes,
  chatSessionLogs,
} from "./chatHostLog.mjs";
import { savedLogBytesMax, savedLogCutLine } from "./savedLog.mjs";

const identity = { kind: "ChatHost", tenant: "vteng", owner: "geoff" };

/** @param {import("node:test").TestContext} t */
async function logsOf(t) {
  const root = await mkdtemp(join(tmpdir(), "chuggy-chat-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "logs");
  const hostLogged = /** @type {string[]} */ ([]);
  const logs = chatSessionLogs(directory, identity, {
    log: (line) => hostLogged.push(line),
    nowMs: () => Date.UTC(2026, 9, 28, 12),
  });
  return { root, directory, hostLogged, logs };
}

const stamp = "2026-10-28T12:00:00.000Z";

test("a session's log is its own file only its owner reads, opening with its assignment and each line stamped", async (t) => {
  const { directory, logs } = await logsOf(t);
  logs("asg-1")("hello");
  logs("asg-1")("again");
  logs("asg-2")("other");

  const file = chatSessionLogFile(directory, identity, "asg-1");
  assert.match(file, /\/chuggy-chat-[0-9a-f]{20}\.log$/u);
  assert.notEqual(file, chatSessionLogFile(directory, identity, "asg-2"));
  assert.equal(
    await readFile(file, "utf8"),
    `session asg-1\n${stamp} hello\n${stamp} again\n`,
  );
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

/** Catches a host that opens a log again, or counts it from nothing, once it has let go of it. */
test("a log let go of and written again is continued from its file", async (t) => {
  const { directory, logs } = await logsOf(t);
  logs("asg-1")("first");
  for (let other = 0; other < 300; other += 1)
    logs(`asg-o${String(other)}`)("x");
  logs("asg-1")("second");

  assert.equal(
    await readFile(chatSessionLogFile(directory, identity, "asg-1"), "utf8"),
    `session asg-1\n${stamp} first\n${stamp} second\n`,
  );
  const second = chatSessionLogs(directory, identity, {
    log: () => assert.fail("nothing fails"),
    nowMs: () => Date.UTC(2026, 9, 28, 12),
  });
  second("asg-1")("third");
  assert.match(
    await readFile(chatSessionLogFile(directory, identity, "asg-1"), "utf8"),
    /^session asg-1\n(?:.+ (?:first|second|third)\n){3}$/u,
  );
});

/**
 * Catches a log that keeps its start, grows without bound, or says it was
 * cut again at each cut.
 */
test("a log past its bound keeps its last whole lines after its assignment, saying once that it was cut", async (t) => {
  const { directory, hostLogged, logs } = await logsOf(t);
  const write = logs("asg-1");
  const lineBytes = 1024 * 1024;
  const lines = Math.ceil((2 * savedLogBytesMax) / lineBytes) + 1;
  for (let line = 0; line < lines; line += 1)
    write(`${String(line).padStart(4, "0")}${"x".repeat(lineBytes)}`);

  const file = chatSessionLogFile(directory, identity, "asg-1");
  const text = await readFile(file, "utf8");
  assert.ok(Buffer.byteLength(text) <= savedLogBytesMax);
  assert.ok(text.startsWith(`session asg-1\n${savedLogCutLine}`));
  assert.equal(text.split(savedLogCutLine).length, 2);
  assert.equal(text.split("session asg-1\n").length, 2);
  assert.ok(
    text.endsWith(
      `${String(lines - 1).padStart(4, "0")}${"x".repeat(lineBytes)}\n`,
    ),
  );
  assert.ok(!text.includes(`${stamp} 0000`));
  const kept = text.slice(`session asg-1\n${savedLogCutLine}`.length);
  assert.ok(kept.startsWith(stamp), "a kept line begins whole");
  assert.ok(Buffer.byteLength(kept) <= chatSessionLogKeptBytes + 2 * lineBytes);
  assert.deepEqual(await readdir(directory), [
    file.slice(directory.length + 1),
  ]);
  assert.deepEqual(hostLogged, []);
});

/** Catches a log whose write fails throwing into the host's stream handlers, or saying so at every line. */
test("a log that cannot be written stops, saying so once on the host's log, and never throws", async (t) => {
  const { directory, hostLogged, logs } = await logsOf(t);
  await mkdir(chatSessionLogFile(directory, identity, "asg-1"), {
    recursive: true,
  });
  const write = logs("asg-1");
  write("one");
  write("two");
  logs("asg-2")("fine");

  assert.equal(hostLogged.length, 1);
  assert.match(
    hostLogged[0],
    /^the session log .+ could not be written, and keeps nothing more: /u,
  );
  assert.equal(
    await readFile(chatSessionLogFile(directory, identity, "asg-2"), "utf8"),
    `session asg-2\n${stamp} fine\n`,
  );
});

test("logs whose directory cannot be made stop, saying so once each", async (t) => {
  const { root, hostLogged } = await logsOf(t);
  const logs = chatSessionLogs(join(root, "absent", "\0"), identity, {
    log: (line) => hostLogged.push(line),
    nowMs: () => 0,
  });
  logs("asg-1")("one");
  logs("asg-1")("two");
  assert.equal(hostLogged.length, 1);
});
