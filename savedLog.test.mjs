import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  savedLogBytesMax,
  savedLogCutLine,
  savedLogKept,
  savedLogLinesMax,
  savedLogTrimmed,
  savedLogWritten,
} from "./savedLog.mjs";

/** @param {import("node:test").TestContext} t */
async function directory(t) {
  const made = await mkdtemp(join(tmpdir(), "chuggy-saved-log-"));
  t.after(() => rm(made, { recursive: true, force: true }));
  return made;
}

test("a whole log is saved as it came, owner-only even where the file was there before", async (t) => {
  const file = join(await directory(t), "job.log");
  await writeFile(file, "older\n", { mode: 0o644 });
  await savedLogWritten(file, Buffer.from("a\nb"), false);
  assert.equal(await readFile(file, "utf8"), "a\nb");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("a cut log opens with the line saying so, from the first whole line after the cut", async (t) => {
  const file = join(await directory(t), "job.log");
  await savedLogWritten(file, Buffer.from("rt of a line\nwhole\n"), true);
  assert.equal(await readFile(file, "utf8"), `${savedLogCutLine}whole\n`);
});

test("a log a job wrote is cut to its end only where it is over the bound, and nothing is left beside it", async (t) => {
  const made = await directory(t);
  const file = join(made, "job.log");
  await writeFile(file, "small\n");
  assert.equal(await savedLogTrimmed(file), false);
  assert.equal(await readFile(file, "utf8"), "small\n");
  await writeFile(file, `first\n${"x".repeat(savedLogBytesMax - 5)}\nend\n`);
  assert.equal(await savedLogTrimmed(file), true);
  assert.equal(await readFile(file, "utf8"), `${savedLogCutLine}end\n`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(made), ["job.log"]);
});

test("a tail is kept whole where nothing was cut, and after the cut line from its first whole line where its bytes were", () => {
  assert.equal(savedLogKept(Buffer.from("a\nb\n"), false), undefined);
  assert.equal(
    String(savedLogKept(Buffer.from("t of a\nb\n"), true)),
    `${savedLogCutLine}b\n`,
  );
  assert.equal(
    String(
      savedLogKept(Buffer.from(`x\n${"l\n".repeat(savedLogLinesMax)}`), false),
    ),
    `${savedLogCutLine}${"l\n".repeat(savedLogLinesMax)}`,
  );
});

test("a log a job wrote of more lines than the bound is cut to its last lines, though it is under the byte bound", async (t) => {
  const file = join(await directory(t), "job.log");
  await writeFile(file, "l\n".repeat(savedLogLinesMax));
  assert.equal(await savedLogTrimmed(file), false);
  await writeFile(file, `first\n${"l\n".repeat(savedLogLinesMax)}`);
  assert.equal(await savedLogTrimmed(file), true);
  assert.equal(
    await readFile(file, "utf8"),
    `${savedLogCutLine}${"l\n".repeat(savedLogLinesMax)}`,
  );
  await writeFile(file, `first\n${"l\n".repeat(savedLogLinesMax - 1)}last`);
  assert.equal(await savedLogTrimmed(file), true);
  assert.equal(
    await readFile(file, "utf8"),
    `${savedLogCutLine}${"l\n".repeat(savedLogLinesMax - 1)}last`,
  );
});
