/**
 * A lock every process on the machine shares: a file naming its holder's
 * process, written whole beside it and linked into place, so it exists only
 * once it names its holder and a second link fails.
 *
 * One whose process is gone, or that is older than any hold lasts, is
 * abandoned: removed and taken again. The age is what frees a lock whose
 * holder's process number was reused. Two processes that judge the same
 * abandoned lock at once can both remove it, and then both hold one, so a
 * caller says what that costs it.
 */

import { randomUUID } from "node:crypto";
import { link, readFile, rm, stat, writeFile } from "node:fs/promises";

/**
 * @typedef {object} FileLockBounds
 * @property {number} waitMsMax how long a hold waits for another's to end before it gives up
 * @property {number} heldMsMax how old a lock may be before it is abandoned whoever it names: longer than any hold lasts
 * @property {number} pollMs between two looks at a lock another process holds
 * @property {string} busy what the error says where the wait gives up
 *
 * @typedef {object} FileLockPorts
 * @property {number} pid this process's
 * @property {() => number} nowMs
 * @property {(ms: number) => Promise<unknown>} wait
 * @property {(pid: number) => boolean} holderAlive
 */

const fileLockMode = 0o600;

/** Whether the process a lock names is still running; one of another user's is. */
export function fileLockHolderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (failure) {
    return failure?.code === "EPERM";
  }
}

async function fileLockText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (failure) {
    if (failure?.code === "ENOENT") return undefined;
    throw failure;
  }
}

/**
 * Whether the lock is one no holder will end. A lock gone since it was found
 * is not abandoned; the next attempt takes it.
 *
 * @param {string} lockPath
 * @param {FileLockBounds} bounds
 * @param {FileLockPorts} ports
 */
async function fileLockAbandoned(lockPath, bounds, ports) {
  const text = await fileLockText(lockPath);
  const written = await stat(lockPath).catch(() => undefined);
  if (text === undefined || written === undefined) return false;
  return (
    !ports.holderAlive(Number(text.trim())) ||
    ports.nowMs() - written.mtimeMs > bounds.heldMsMax
  );
}

/**
 * Whether this attempt linked a lock naming this process into place.
 *
 * @param {string} lockPath
 * @param {FileLockPorts} ports
 */
async function fileLockLinked(lockPath, ports) {
  const staged = `${lockPath}.${randomUUID()}`;
  await writeFile(staged, `${String(ports.pid)}\n`, {
    flag: "wx",
    mode: fileLockMode,
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

/**
 * @param {string} lockPath
 * @param {FileLockBounds} bounds
 * @param {FileLockPorts} ports
 */
async function fileLockAcquired(lockPath, bounds, ports) {
  const deadlineMs = ports.nowMs() + bounds.waitMsMax;
  for (;;) {
    if (ports.nowMs() >= deadlineMs) throw new Error(bounds.busy);
    if (await fileLockLinked(lockPath, ports)) return;
    if (await fileLockAbandoned(lockPath, bounds, ports))
      await rm(lockPath, { force: true });
    else await ports.wait(bounds.pollMs);
  }
}

/**
 * `hold` run under the lock at `lockPath`, whose directory is there.
 *
 * @template T
 * @param {string} lockPath
 * @param {FileLockBounds} bounds
 * @param {FileLockPorts} ports
 * @param {() => Promise<T>} hold
 * @returns {Promise<T>}
 */
export async function fileLocked(lockPath, bounds, ports, hold) {
  await fileLockAcquired(lockPath, bounds, ports);
  try {
    return await hold();
  } finally {
    await rm(lockPath, { force: true });
  }
}
