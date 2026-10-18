/**
 * The lock's races, opened on purpose: the file system's own calls are slowed
 * or answered by a competitor here, so this file is a process of its own and
 * the store is imported only once they are in place.
 */
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers";

const competitor = { slowCreate: false, retake: false, removals: 0 };
const realWriteFile = fsp.writeFile;
const realRm = fsp.rm;
fsp.writeFile = async (path, data, options) => {
  if (!competitor.slowCreate || options?.flag !== "wx")
    return realWriteFile(path, data, options);
  const handle = await fsp.open(path, "wx", options.mode);
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
};
fsp.rm = async (path, options) => {
  await realRm(path, options);
  if (!competitor.retake || !String(path).endsWith(".lock")) return;
  competitor.removals += 1;
  if (competitor.removals > 1_000)
    throw new Error("the lock was taken again past the deadline");
  await realWriteFile(path, "4242\n");
};
syncBuiltinESMExports();
const { localTokenStore, localTokenStoreHolderAlive } =
  await import("./localTokenStore.mjs");

async function pathOf(t) {
  const directory = await fsp.mkdtemp(join(tmpdir(), "local-token-race-"));
  t.after(() => realRm(directory, { recursive: true, force: true }));
  return join(directory, "renewal");
}

test("where creating a file is slow, no server judges a lock before it names its holder, and holds never overlap", async (t) => {
  const path = await pathOf(t);
  competitor.slowCreate = true;
  t.after(() => {
    competitor.slowCreate = false;
  });
  const judged = [];
  const holderAlive = (pid) => {
    judged.push(pid);
    return localTokenStoreHolderAlive(pid);
  };
  let holding = 0;
  let overlapped = false;
  await Promise.all(
    Array.from({ length: 2 }, () =>
      localTokenStore(path, {
        holderAlive,
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms / 20)),
      }).locked(async () => {
        holding += 1;
        overlapped ||= holding > 1;
        await new Promise((resolve) => setTimeout(resolve, 2));
        holding -= 1;
      }),
    ),
  );
  assert.deepEqual(new Set(judged), new Set([process.pid]));
  assert.equal(overlapped, false);
});

test("a lock taken again after every removal is waited on no longer than the deadline", async (t) => {
  const path = await pathOf(t);
  await realWriteFile(`${path}.lock`, "4242\n");
  competitor.retake = true;
  t.after(() => {
    competitor.retake = false;
  });
  let nowMs = Date.now();
  const store = localTokenStore(path, {
    nowMs: () => nowMs,
    holderAlive: () => {
      nowMs += 1_000;
      return false;
    },
    wait: async (ms) => {
      nowMs += ms;
    },
  });
  await assert.rejects(
    store.locked(async () => "ran"),
    /held the sign-in lock/,
  );
});
