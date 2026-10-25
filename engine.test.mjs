/**
 * The engine is Node itself here, so each call runs a real process through
 * the same `execFile` and `spawn` a container engine is run with.
 */
import assert from "node:assert/strict";
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

test("output of any length is kept to its last bytes, with whether more came and how many lines it had", async () => {
  const answer = await node.execTail(
    ["-e", "process.stdout.write('x\\n'.repeat(1 << 20))"],
    1024,
  );
  assert.equal(answer.code, 0);
  assert.equal(answer.tail.toString("utf8"), "x\n".repeat(512));
  assert.equal(answer.cut, true);
  assert.equal(answer.lines, 1 << 20);

  const whole = await node.execTail(
    ["-e", "process.stdout.write('a\\nb')"],
    1024,
  );
  assert.deepEqual(
    { tail: whole.tail.toString("utf8"), cut: whole.cut, lines: whole.lines },
    { tail: "a\nb", cut: false, lines: 1 },
  );
});

test("both streams are kept as they arrive, and stderr is answered as itself too", async () => {
  const answer = await node.execTail(
    [
      "-e",
      "process.stderr.write('err\\n'); setTimeout(() => process.stdout.write('out\\n'), 100)",
    ],
    1024,
  );
  assert.equal(answer.tail.toString("utf8"), "err\nout\n");
  assert.equal(answer.stderr, "err\n");
});

test("a call kept to its tail that failed answers its status and the end of its stderr", async () => {
  const answer = await node.execTail(
    ["-e", "process.stderr.write('No such container: c1'); process.exit(1)"],
    1024,
  );
  assert.equal(answer.code, 1);
  assert.equal(answer.stderr, "No such container: c1");
  const unstarted = await containerEngine(
    "/nonexistent/chuggy-engine",
    10_000,
  ).execTail(["logs", "c1"], 1024);
  assert.equal(unstarted.failed, "Unstarted");
});
