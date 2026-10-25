import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
import { URL } from "node:url";

import {
  imageEntriesForgotten,
  imageHoldTaken,
  imageRecordBytesMax,
  imageRecordChanged,
  imageRecordRead,
  imageUsesRecorded,
} from "./imageRecord.mjs";

const nowMs = 1_800_000_000_000;
const runtime = `registry.chuggy.example/chuggy/runtime@sha256:${"c".repeat(64)}`;

/** @param {import("node:test").TestContext} t */
async function recordFile(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-image-record-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "images", "docker.json");
}

test("a record that is not there is begun, and says nothing of why", async (t) => {
  const read = await imageRecordRead(await recordFile(t), nowMs);
  assert.deepEqual(read, {
    read: "Begun",
    record: {
      version: 1,
      createdMs: nowMs,
      repositories: {},
      images: {},
      holds: {},
    },
  });
});

for (const [what, text, why] of [
  ["not JSON", "{", "it is not JSON"],
  [
    "not a record",
    JSON.stringify({ version: 1, images: [] }),
    "it is not a record of this version's",
  ],
  [
    "too large",
    " ".repeat(imageRecordBytesMax + 1),
    `it is larger than ${String(imageRecordBytesMax)} bytes`,
  ],
])
  test(`a record that is ${what} is begun again, saying why`, async (t) => {
    const file = await recordFile(t);
    await imageRecordChanged(
      file,
      () => nowMs,
      async () => ({
        answer: undefined,
      }),
    );
    await writeFile(file, text);
    const read = await imageRecordRead(file, nowMs);
    assert.equal(read.read, "Begun");
    assert.equal("why" in read ? read.why : undefined, why);
  });

test("a record a later version wrote is handed to no change and left as it is", async (t) => {
  const file = await recordFile(t);
  await imageRecordChanged(
    file,
    () => nowMs,
    async () => ({ answer: 1 }),
  );
  const later = `${JSON.stringify({ version: 2, holds: "theirs" })}\n`;
  await writeFile(file, later);
  let changes = 0;
  const changed = await imageRecordChanged(
    file,
    () => nowMs,
    async (read) => {
      changes += 1;
      return { record: read.record, answer: undefined };
    },
  );
  assert.deepEqual(changed, { changed: false, version: 2 });
  assert.equal(changes, 0);
  assert.equal(await readFile(file, "utf8"), later);
});

test("a change is written whole and owner-only, and keeps every field this version does not know", async (t) => {
  const file = await recordFile(t);
  await imageRecordChanged(
    file,
    () => nowMs,
    async (read) => ({
      record: {
        ...read.record,
        laterField: "kept",
        images: {
          [runtime]: { kinds: ["Runtime"], usedMs: nowMs, laterEntryField: 1 },
        },
      },
      answer: undefined,
    }),
  );
  await imageRecordChanged(
    file,
    () => nowMs,
    async (read) => ({
      record: imageHoldTaken(
        read.record,
        "chuggy-1",
        [runtime],
        nowMs + 1,
        nowMs,
      ),
      answer: undefined,
    }),
  );
  const read = await imageRecordRead(file, nowMs);
  assert.equal(read.read, "Record");
  assert.equal(read.record.laterField, "kept");
  assert.equal(read.record.images[runtime].laterEntryField, 1);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(join(file, ".."))).toSorted(), [
    "docker.json",
  ]);
});

test("a use drops its placement's hold, keeps what the image was used as and pulled as, and marks a runtime's repository", () => {
  let record = imageHoldTaken(
    {
      version: 1,
      createdMs: nowMs,
      repositories: {},
      images: {},
      holds: { gone: { images: [runtime], untilMs: nowMs } },
    },
    "chuggy-1",
    [runtime],
    nowMs + 60_000,
    nowMs,
  );
  assert.deepEqual(Object.keys(record.holds), ["chuggy-1"]);
  record = imageUsesRecorded(
    record,
    "chuggy-1",
    [{ reference: runtime, kind: "Runtime", pulledId: "sha256:1" }],
    nowMs + 1,
  );
  record = imageUsesRecorded(
    record,
    "chuggy-2",
    [{ reference: runtime, kind: "Job" }],
    nowMs + 2,
  );
  assert.deepEqual(record.holds, {});
  assert.deepEqual(record.images[runtime], {
    kinds: ["Runtime", "Job"],
    usedMs: nowMs + 2,
    pulledId: "sha256:1",
  });
  assert.deepEqual(record.repositories, {
    "registry.chuggy.example/chuggy/runtime": { kinds: ["Runtime"] },
  });
  assert.deepEqual(imageEntriesForgotten(record, [runtime]).images, {});
});

test("a change waits out another process's hold of the lock, and sees what it wrote", async (t) => {
  const file = await recordFile(t);
  await imageRecordChanged(
    file,
    () => nowMs,
    async () => ({ answer: 1 }),
  );
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      const record = await import(process.argv[1]);
      await record.imageRecordChanged(process.argv[2], Date.now, async (read) => {
        process.stdout.write("held\\n");
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          record: record.imageHoldTaken(read.record, "theirs", ["busybox"], Date.now() + 60_000, Date.now()),
          answer: undefined,
        };
      });
      `,
      new URL("./imageRecord.mjs", import.meta.url).href,
      file,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const closed = once(child, "close");
  await Promise.race([
    once(child.stdout, "data"),
    closed.then(() =>
      assert.fail("the other process ended before it held the lock"),
    ),
  ]);
  await imageRecordChanged(file, Date.now, async (read) => ({
    record: imageHoldTaken(
      read.record,
      "ours",
      ["busybox"],
      Date.now() + 60_000,
      Date.now(),
    ),
    answer: undefined,
  }));
  await closed;
  const read = await imageRecordRead(file, Date.now());
  assert.equal(read.read, "Record");
  assert.deepEqual(Object.keys(read.record.holds).toSorted(), [
    "ours",
    "theirs",
  ]);
});
