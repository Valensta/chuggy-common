/**
 * The engine is Node itself here, so each call runs a real process through
 * the same `execFile` and `spawn` a container engine is run with.
 */
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { containerEngine } from "./engine.mjs";

const node = containerEngine(process.execPath, 10_000);

test("an answer is the exit code and both streams", async () => {
  assert.deepEqual(
    await node.exec([
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
    ]),
    { code: 3, stdout: "out", stderr: "err" },
  );
  assert.deepEqual(await node.exec(["-e", "process.stdout.write('ok')"]), {
    code: 0,
    stdout: "ok",
    stderr: "",
  });
});

test("a call's variables are added to this process's own", async () => {
  const answer = await node.exec(
    [
      "-e",
      "process.stdout.write(`${process.env.CHUGGY_PROBE} ${typeof process.env.PATH}`)",
    ],
    { environment: { CHUGGY_PROBE: "set" } },
  );
  assert.equal(answer.stdout, "set string");
});

test("an argument reaches the engine as itself, never through a shell", async () => {
  const argument = "$(touch /tmp/x); `id` 'quoted' \"double\" *";
  const answer = await node.exec([
    "-e",
    "process.stdout.write(process.argv[1])",
    argument,
  ]);
  assert.equal(answer.stdout, argument);
});

test("an engine that could not start is answered as unstarted", async () => {
  const answer = await containerEngine(
    "/nonexistent/chuggy-engine",
    10_000,
  ).exec(["ps"]);
  assert.equal(answer.failed, "Unstarted");
  assert.match(answer.stderr, /ENOENT/u);
});

test("a call past its cap is answered as interrupted", async () => {
  const answer = await containerEngine(process.execPath, 50).exec([
    "-e",
    "setTimeout(() => {}, 10_000)",
  ]);
  assert.equal(answer.failed, "Interrupted");
});

test("a call with a signal of its own is not capped, and rejects when it aborts", async () => {
  const capped = containerEngine(process.execPath, 50);
  const slow = await capped.exec(
    ["-e", "setTimeout(() => process.stdout.write('late'), 200)"],
    {
      signal: new globalThis.AbortController().signal,
    },
  );
  assert.deepEqual(slow, { code: 0, stdout: "late", stderr: "" });
  const controller = new globalThis.AbortController();
  const aborted = capped.exec(["-e", "setTimeout(() => {}, 10_000)"], {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
});

test("output of any length goes to a file descriptor, both streams whole, each in its own order", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-engine-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "log");
  const handle = await open(file, "w");
  const answer = await node.execToFd(
    [
      "-e",
      "process.stdout.write('x'.repeat(1 << 20)); process.stderr.write('end')",
    ],
    handle.fd,
  );
  await handle.close();
  assert.deepEqual(answer, { code: 0, stdout: "", stderr: "" });
  const text = await readFile(file, "utf8");
  assert.equal(text.length, (1 << 20) + 3);
  // The streams reach the file through pipes of their own, so where one's
  // bytes fall among the other's is not fixed; each stream's are whole.
  assert.equal(text.replace("end", ""), "x".repeat(1 << 20));
});

test("output that cannot be written to its file descriptor ends the copy, not the process, and the call is still answered", async () => {
  const answer = await node.execToFd(
    [
      "-e",
      "process.stdout.write('x'.repeat(1 << 16)); process.stderr.write('end')",
    ],
    1 << 30,
  );
  assert.deepEqual(answer, { code: 0, stdout: "", stderr: "" });
});
