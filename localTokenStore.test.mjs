import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers";

import {
  localTokenStore,
  localTokenStoreHolderAlive,
  localTokenStoreLockHeldMsMax,
  localTokenStoreLockWaitMsMax,
} from "./localTokenStore.mjs";

async function directoryOf(t) {
  const directory = await mkdtemp(join(tmpdir(), "local-token-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a token written is read back, the person's alone, and forgotten on clear", async (t) => {
  const path = join(await directoryOf(t), "config", "renewal");
  const store = localTokenStore(path);
  assert.equal(await store.read(), undefined);
  await store.write("renewal-one");
  await store.write("renewal-two");
  assert.equal(await store.read(), "renewal-two");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await store.clear();
  assert.equal(await store.read(), undefined);
});

test("a second hold waits for the first to end", async (t) => {
  const store = localTokenStore(join(await directoryOf(t), "renewal"));
  const order = [];
  let release;
  let held;
  const holding = new Promise((resolve) => {
    held = resolve;
  });
  const first = store.locked(
    () =>
      new Promise((resolve) => {
        order.push("first held");
        release = resolve;
        held();
      }),
  );
  await holding;
  const second = store.locked(async () => {
    order.push("second held");
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(order, ["first held"]);
  release();
  await first;
  await second;
  assert.deepEqual(order, ["first held", "second held"]);
});

test("a lock whose holder is gone is taken, and one still held past the wait raises", async (t) => {
  const path = join(await directoryOf(t), "renewal");
  await writeFile(`${path}.lock`, "4242\n");
  const abandoned = localTokenStore(path, { holderAlive: () => false });
  assert.equal(await abandoned.locked(async () => "renewed"), "renewed");
  await assert.rejects(readFile(`${path}.lock`), { code: "ENOENT" });

  await writeFile(`${path}.lock`, "4242\n");
  let nowMs = Date.now();
  const startedMs = nowMs;
  const held = localTokenStore(path, {
    holderAlive: () => true,
    nowMs: () => nowMs,
    wait: async (ms) => {
      nowMs += ms;
    },
  });
  let ran = false;
  await assert.rejects(
    held.locked(async () => {
      ran = true;
    }),
    /held the sign-in lock/,
  );
  assert.equal(ran, false);
  assert.ok(nowMs - startedMs >= localTokenStoreLockWaitMsMax);
  await readFile(`${path}.lock`);
});

test("a lock older than any renewal holds one is taken whoever it names, and a younger one is waited on", async (t) => {
  const path = join(await directoryOf(t), "renewal");
  await writeFile(`${path}.lock`, `${String(process.pid)}\n`);
  const startedMs = Date.now();
  let nowMs = startedMs;
  const store = localTokenStore(path, {
    nowMs: () => nowMs,
    wait: async (ms) => {
      nowMs += ms;
    },
  });
  await assert.rejects(
    store.locked(async () => "taken"),
    /held the sign-in lock/,
  );
  nowMs = startedMs + localTokenStoreLockHeldMsMax + 1_000;
  assert.equal(await store.locked(async () => "taken"), "taken");
});

test("a held lock names its holder whole", async (t) => {
  const path = join(await directoryOf(t), "renewal");
  const store = localTokenStore(path);
  const seen = await store.locked(async () => readFile(`${path}.lock`, "utf8"));
  assert.equal(seen, `${String(process.pid)}\n`);
});

test("a holder is alive while its process runs", () => {
  assert.equal(localTokenStoreHolderAlive(process.pid), true);
  assert.equal(localTokenStoreHolderAlive(Number.NaN), false);
  assert.equal(localTokenStoreHolderAlive(0), false);
});
