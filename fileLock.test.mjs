import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { fileLockHolderAlive } from "./fileLock.mjs";

test("a holder is alive while its process runs", () => {
  assert.equal(fileLockHolderAlive(process.pid), true);
  assert.equal(fileLockHolderAlive(Number.NaN), false);
  assert.equal(fileLockHolderAlive(0), false);
});
