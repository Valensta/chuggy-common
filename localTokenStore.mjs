/**
 * Where a person's renewal token is kept between runs of the local tool
 * server, and the lock every renewal is made under.
 *
 * THE RENEWAL TOKEN IS SPENT BY THE REQUEST THAT USES IT, and the issuer ends
 * the whole sign-in when shown a spent one. Every chat on the machine runs a
 * server of its own over the same file, so a renewal reads the token, spends
 * it and writes its replacement inside one hold of the lock, and no server
 * keeps a renewal token in memory past that hold.
 *
 * THE LOCK IS `fileLock.mjs`'s, beside the token. Two servers that judge the
 * same abandoned lock at once can both hold one: that takes a holder that died
 * inside a renewal and two others renewing at that moment, and what it costs
 * is a sign-in, because a spent token ends it. That limit is accepted rather
 * than closed with a lock protocol of its own.
 *
 * A write goes to a file of its own and is renamed over the token, so a reader
 * never sees half of one. The file is the person's alone, as the runner's own
 * secrets are.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { fileLocked, fileLockHolderAlive } from "./fileLock.mjs";

/** How long a renewal waits for another server's hold to end before it gives up. */
export const localTokenStoreLockWaitMsMax = 20_000;

/** How old a lock may be before it is abandoned whoever it names: longer than any renewal holds one. */
export const localTokenStoreLockHeldMsMax = 300_000;

/** How long between two looks at a lock another server holds. */
export const localTokenStoreLockPollMs = 100;

const localTokenStoreFileMode = 0o600;
const localTokenStoreDirectoryMode = 0o700;

async function localTokenStoreText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (failure) {
    if (failure?.code === "ENOENT") return undefined;
    throw failure;
  }
}

/**
 * The renewal token at `path`. `read` answers it or nothing, `write` replaces
 * it, `clear` forgets it, and `locked` runs one renewal under the lock.
 */
export function localTokenStore(path, overrides = {}) {
  const ports = {
    pid: process.pid,
    nowMs: Date.now,
    wait,
    holderAlive: fileLockHolderAlive,
    ...overrides,
  };
  const lockPath = `${path}.lock`;
  const bounds = {
    waitMsMax: localTokenStoreLockWaitMsMax,
    heldMsMax: localTokenStoreLockHeldMsMax,
    pollMs: localTokenStoreLockPollMs,
    busy: `another chuggy tool server has held the sign-in lock at ${lockPath} for longer than a renewal waits`,
  };
  return {
    async read() {
      const text = (await localTokenStoreText(path))?.trim();
      return text === undefined || text.length === 0 ? undefined : text;
    },
    async write(token) {
      await mkdir(dirname(path), {
        recursive: true,
        mode: localTokenStoreDirectoryMode,
      });
      const staged = `${path}.${randomUUID()}`;
      await writeFile(staged, `${token}\n`, {
        flag: "wx",
        mode: localTokenStoreFileMode,
      });
      await rename(staged, path);
    },
    async clear() {
      await rm(path, { force: true });
    },
    async locked(renewal) {
      await mkdir(dirname(path), {
        recursive: true,
        mode: localTokenStoreDirectoryMode,
      });
      return fileLocked(lockPath, bounds, ports, renewal);
    },
  };
}
