import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { fileLockHolderAlive, fileRenamedOver } from "./fileLock.mjs";

test("a holder is alive while its process runs", () => {
  assert.equal(fileLockHolderAlive(process.pid), true);
  assert.equal(fileLockHolderAlive(Number.NaN), false);
  assert.equal(fileLockHolderAlive(0), false);
});

/**
 * A rename failing with each code in `codes` in turn and then renaming,
 * recording each try and each wait.
 *
 * @param {readonly string[]} codes
 */
function renameFailing(codes) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    ports: {
      rename: async (/** @type {string} */ from, /** @type {string} */ to) => {
        calls.push(`rename ${from} ${to}`);
        const code =
          codes[calls.filter((c) => c.startsWith("rename")).length - 1];
        if (code !== undefined) throw Object.assign(new Error(code), { code });
      },
      wait: async (/** @type {number} */ ms) => {
        calls.push(`wait ${String(ms)}`);
      },
    },
  };
}

test("a rename Windows refuses for another process's brief hold is tried again, and any other failure is not", async () => {
  const held = renameFailing(["EPERM", "EBUSY", "EACCES"]);
  await fileRenamedOver("a", "b", held.ports);
  assert.deepEqual(held.calls.filter((c) => c.startsWith("rename")).length, 4);
  assert.ok(held.calls.includes("wait 100"));
  const missing = renameFailing(["ENOENT"]);
  await assert.rejects(fileRenamedOver("a", "b", missing.ports), {
    code: "ENOENT",
  });
  assert.deepEqual(missing.calls, ["rename a b"]);
  const stuck = renameFailing(Array(10).fill("EPERM"));
  await assert.rejects(fileRenamedOver("a", "b", stuck.ports), {
    code: "EPERM",
  });
  assert.equal(stuck.calls.filter((c) => c.startsWith("rename")).length, 5);
});
