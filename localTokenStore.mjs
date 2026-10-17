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
 * THE LOCK IS A FILE NAMING ITS HOLDER'S PROCESS, created exclusively. One
 * whose process is gone is removed and taken again. Two servers that judge the
 * same abandoned lock at once can both remove it, and then both hold one: that
 * takes a holder that died inside a renewal and two others renewing at that
 * moment, and what it costs is a sign-in, because a spent token ends it. That
 * limit is accepted rather than closed with a lock protocol of its own.
 *
 * A write goes to a file of its own and is renamed over the token, so a reader
 * never sees half of one. The file is the person's alone, as the runner's own
 * secrets are.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

/** How long a renewal waits for another server's hold to end before it gives up. */
export const localTokenStoreLockWaitMsMax = 20_000;

/** How long between two looks at a lock another server holds. */
export const localTokenStoreLockPollMs = 100;

const localTokenStoreFileMode = 0o600;
const localTokenStoreDirectoryMode = 0o700;

/** Whether the process a lock names is still running; one of another user's is. */
export function localTokenStoreHolderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (failure) {
    return failure?.code === "EPERM";
  }
}

async function localTokenStoreText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (failure) {
    if (failure?.code === "ENOENT") return undefined;
    throw failure;
  }
}

async function localTokenStoreAcquire(lockPath, ports) {
  const deadlineMs = ports.nowMs() + localTokenStoreLockWaitMsMax;
  for (;;) {
    try {
      await writeFile(lockPath, `${String(ports.pid)}\n`, {
        flag: "wx",
        mode: localTokenStoreFileMode,
      });
      return;
    } catch (failure) {
      if (failure?.code !== "EEXIST") throw failure;
    }
    const holder = Number((await localTokenStoreText(lockPath))?.trim());
    if (!ports.holderAlive(holder)) {
      await rm(lockPath, { force: true });
      continue;
    }
    if (ports.nowMs() >= deadlineMs)
      throw new Error(
        `another chuggy tool server has held the sign-in lock at ${lockPath} for longer than a renewal waits`,
      );
    await ports.wait(localTokenStoreLockPollMs);
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
    holderAlive: localTokenStoreHolderAlive,
    ...overrides,
  };
  const lockPath = `${path}.lock`;
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
      await localTokenStoreAcquire(lockPath, ports);
      try {
        return await renewal();
      } finally {
        await rm(lockPath, { force: true });
      }
    },
  };
}
