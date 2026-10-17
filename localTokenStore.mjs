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
 * THE LOCK IS A FILE NAMING ITS HOLDER'S PROCESS, written whole beside it and
 * linked into place, so it exists only once it names its holder and a second
 * link fails. One whose process is gone, or that is older than any renewal
 * holds it, is abandoned: removed and taken again. The age is what frees a lock
 * whose holder's process number was reused. Two servers that judge the same
 * abandoned lock at once can both remove it, and then both hold one: that
 * takes a holder that died inside a renewal and two others renewing at that
 * moment, and what it costs is a sign-in, because a spent token ends it. That
 * limit is accepted rather than closed with a lock protocol of its own.
 *
 * A write goes to a file of its own and is renamed over the token, so a reader
 * never sees half of one. The file is the person's alone, as the runner's own
 * secrets are.
 */

import {
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

/** How long a renewal waits for another server's hold to end before it gives up. */
export const localTokenStoreLockWaitMsMax = 20_000;

/** How old a lock may be before it is abandoned whoever it names: longer than any renewal holds one. */
export const localTokenStoreLockHeldMsMax = 300_000;

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

/**
 * Whether the lock at `lockPath` is one no holder will end: it names a process
 * that is gone, or it is older than any renewal holds one. A lock gone since
 * it was found is not abandoned; the next attempt takes it.
 */
async function localTokenStoreAbandoned(lockPath, ports) {
  const text = await localTokenStoreText(lockPath);
  const written = await stat(lockPath).catch(() => undefined);
  if (text === undefined || written === undefined) return false;
  return (
    !ports.holderAlive(Number(text.trim())) ||
    ports.nowMs() - written.mtimeMs > localTokenStoreLockHeldMsMax
  );
}

/** Whether this attempt linked a lock naming this process into place. */
async function localTokenStoreLinked(lockPath, ports) {
  const staged = `${lockPath}.${randomUUID()}`;
  await writeFile(staged, `${String(ports.pid)}\n`, {
    flag: "wx",
    mode: localTokenStoreFileMode,
  });
  try {
    await link(staged, lockPath);
    return true;
  } catch (failure) {
    if (failure?.code === "EEXIST") return false;
    throw failure;
  } finally {
    await rm(staged, { force: true });
  }
}

async function localTokenStoreAcquire(lockPath, ports) {
  const deadlineMs = ports.nowMs() + localTokenStoreLockWaitMsMax;
  for (;;) {
    if (ports.nowMs() >= deadlineMs)
      throw new Error(
        `another chuggy tool server has held the sign-in lock at ${lockPath} for longer than a renewal waits`,
      );
    if (await localTokenStoreLinked(lockPath, ports)) return;
    if (await localTokenStoreAbandoned(lockPath, ports))
      await rm(lockPath, { force: true });
    else await ports.wait(localTokenStoreLockPollMs);
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
