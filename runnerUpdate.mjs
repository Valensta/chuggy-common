/**
 * A runner's update of itself to the release chuggy names: its own package's
 * tarball, from its own repository's release downloads, installed by npm over
 * the copy that is running, which the caller then restarts on.
 *
 * NOTHING IS INSTALLED UNTIL THE RELEASE IS PROVED. Its tarball is fetched
 * over https alone, bounded in bytes and time, and must match the integrity
 * chuggy named. Unpacked where nothing runs it, it must name the package and
 * the version, accept this process's Node, and answer `--version` with that
 * version when its bin runs under that Node. Any failure leaves the running
 * copy as it was. `prove` is that proof alone, installing nothing, so a runner
 * whose work would end with its process stops taking work only for a release
 * that has already proved itself.
 *
 * EVERY SERVICE SHARING THE INSTALL TAKES ONE LOCK to install, and one that
 * finds the installed copy already at or past the version, before it fetches
 * or once it holds the lock, installs nothing and only restarts. Two services
 * taking one abandoned lock at once cost two npm installs of one release over
 * one prefix, each proved before it runs.
 *
 * npm is the one beside this process's Node, else the first on PATH, and runs
 * with that Node's directory first on PATH, so its own Node is this one.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { URL } from "node:url";

import { boundedResponseBytes } from "./boundedResponse.mjs";
import { fileLocked, fileLockHolderAlive } from "./fileLock.mjs";

/**
 * @typedef {{package: string, version: string}} RunnerIdentity
 * @typedef {RunnerIdentity & {url: string, integrity: string}} RunnerRelease
 *
 * @typedef {object} RunnerUpdateSettings
 * @property {RunnerIdentity} runner this copy's package and version
 * @property {string} releasePrefix where this package's releases are downloaded from: an `https:` address ending in `/`, under which a release is `<tag>/<file>`
 * @property {string} installed the directory this copy is installed in, which npm made `<prefix>/lib/node_modules/<package>`
 * @property {string} lockPath the lock every service sharing the install takes
 *
 * @typedef {{code: number, stdout: string, stderr: string}} RunnerUpdateRan `code` is -1 where the process could not start or ran past its cap
 * @typedef {(file: string, args: readonly string[], call: {timeoutMs: number, environment?: Readonly<Record<string, string>>}) => Promise<RunnerUpdateRan>} RunnerUpdateRun
 *
 * @typedef {object} RunnerUpdatePorts
 * @property {typeof globalThis.fetch} fetch
 * @property {(ms: number) => AbortSignal} deadline a signal that aborts once `ms` have passed
 * @property {RunnerUpdateRun} run the system's `tar`, the staged bin, npm
 * @property {(path: string) => Promise<boolean>} writable
 * @property {(path: string) => Promise<boolean>} executable
 * @property {string} execPath this process's Node
 * @property {string} nodeVersion that Node's, as `process.versions.node` says it
 * @property {Readonly<Record<string, string | undefined>>} environment this process's, whose PATH npm's is made from
 * @property {string} temporary where a release is staged
 * @property {number} pid
 * @property {() => number} nowMs
 * @property {(ms: number) => Promise<unknown>} wait
 * @property {(pid: number) => boolean} holderAlive
 *
 * @typedef {{updated: "Installed", version: string} | {updated: "AlreadyInstalled", version: string}
 *   | {updated: "Failed", reason: string}} RunnerUpdated the first two are a restart now; `reason` is a clause a log line reads after the release it names
 *
 * @typedef {{proved: "Proved"} | {proved: "Failed", reason: string}} RunnerProved `Proved` is a release `update` would install, or a copy already at or past it; `reason` reads as `RunnerUpdated`'s does
 *
 * @typedef {object} RunnerUpdater
 * @property {RunnerIdentity} runner
 * @property {(release: RunnerRelease) => Promise<string | undefined>} refusal why the release is refused before anything is fetched, or nothing
 * @property {(release: RunnerRelease) => Promise<RunnerProved>} prove
 * @property {(release: RunnerRelease) => Promise<RunnerUpdated>} update
 */

/** How long a release's download may take, redirects and all. */
export const runnerUpdateFetchMsMax = 300_000;

/** The most a release's tarball may weigh, orders above a runner's. */
export const runnerUpdateBytesMax = 64 * 1024 * 1024;

/** The chunks a download may arrive in, which ends a body yielding empty ones. */
const runnerUpdateReadsMax = 1024 * 1024;

const runnerUpdateRedirectsMax = 5;

/** How long unpacking a release, or its bin answering `--version`, may take. */
const runnerUpdateStepMsMax = 120_000;

/** How long npm's install may take, which guards a hung npm and not a slow one. */
export const runnerUpdateInstallMsMax = 600_000;

/** Longer than any hold of the install lock lasts. */
const runnerUpdateLockHeldMsMax = runnerUpdateInstallMsMax + 60_000;

/** Long enough to see a live holder's install end, or its lock age out. */
const runnerUpdateLockWaitMsMax = 2 * runnerUpdateLockHeldMsMax;

const runnerUpdateOutputBytesMax = 16 * 1024 * 1024;

const runnerPackagePattern = /^[a-z][a-z0-9-]{0,62}$/u;
const runnerVersionPattern =
  /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/u;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

/**
 * @param {readonly number[]} left
 * @param {readonly number[]} right
 */
function runnerVersionPartsCompared(left, right) {
  for (let at = 0; at < left.length; at += 1)
    if (left[at] !== right[at]) return left[at] < right[at] ? -1 : 1;
  return 0;
}

/** @param {unknown} version */
function runnerVersionParts(version) {
  const match =
    typeof version === "string" ? runnerVersionPattern.exec(version) : null;
  return match === null ? undefined : match.slice(1).map(Number);
}

/**
 * Whether `version` is a plain release at or above `floor`, which is one.
 *
 * @param {unknown} version
 * @param {string} floor
 */
function runnerVersionAtLeast(version, floor) {
  const parts = runnerVersionParts(version);
  const floorParts = runnerVersionParts(floor);
  return (
    parts !== undefined &&
    floorParts !== undefined &&
    runnerVersionPartsCompared(parts, floorParts) >= 0
  );
}

/**
 * Whether `version` is a plain release strictly above `than`, which is one: a
 * runner only ever rolls forward.
 *
 * @param {string} version
 * @param {string} than
 */
export function runnerVersionAbove(version, than) {
  return runnerVersionAtLeast(version, than) && version !== than;
}

/**
 * Why a release's `engines.node` refuses this Node, or nothing where it
 * accepts it or names none. Only `>=N` and `>=N.M.P` are read, and any other
 * range is refused rather than passed.
 *
 * @param {unknown} range
 * @param {string} nodeVersion
 */
export function runnerEnginesRefusal(range, nodeVersion) {
  if (range === undefined) return undefined;
  const match =
    typeof range === "string"
      ? /^>=\s*([0-9]+)(?:\.([0-9]+)\.([0-9]+))?$/u.exec(range.trim())
      : null;
  if (match === null)
    return `it names engines.node ${JSON.stringify(range)}, a range this runner does not read`;
  const floor = [match[1], match[2] ?? "0", match[3] ?? "0"].map(Number);
  const node = /^([0-9]+)\.([0-9]+)\.([0-9]+)/u
    .exec(nodeVersion)
    ?.slice(1)
    .map(Number);
  return node !== undefined && runnerVersionPartsCompared(node, floor) >= 0
    ? undefined
    : `it needs Node ${range}, and this runner's Node is ${nodeVersion}`;
}

/**
 * The npm prefix a copy installed at `installed` was installed under, or
 * nothing where it is not where a global install puts a package.
 *
 * @param {string} installed
 * @param {string} packageName
 */
function runnerNpmPrefix(installed, packageName) {
  const directory = resolve(installed);
  const modules = dirname(directory);
  const lib = dirname(modules);
  return basename(directory) === packageName &&
    basename(modules) === "node_modules" &&
    basename(lib) === "lib"
    ? dirname(lib)
    : undefined;
}

/**
 * @param {RunnerUpdateSettings} settings
 * @returns {RunnerUpdateSettings}
 */
function checkedRunnerUpdateSettings(settings) {
  const { runner, releasePrefix } = settings;
  if (!runnerPackagePattern.test(runner.package))
    throw new RangeError(`runner package ${runner.package} is no package name`);
  if (runnerVersionParts(runner.version) === undefined)
    throw new RangeError(
      `runner version ${runner.version} is no plain release`,
    );
  const prefix = URL.canParse(releasePrefix)
    ? new URL(releasePrefix)
    : undefined;
  if (
    prefix?.href !== releasePrefix ||
    prefix.protocol !== "https:" ||
    !releasePrefix.endsWith("/") ||
    prefix.username !== "" ||
    prefix.password !== "" ||
    prefix.search !== "" ||
    prefix.hash !== ""
  )
    throw new RangeError(
      `release prefix ${releasePrefix} is no https address ending in /`,
    );
  return settings;
}

/**
 * Why a release's address is not one of this package's release downloads, or
 * nothing. It must be written as a URL writes itself, so no `..` survives in
 * it, and be the prefix and then `<tag>/<file>` of plain characters, so no
 * escaped separator does either.
 *
 * @param {string} url
 * @param {string} prefix
 */
function runnerReleaseUrlRefusal(url, prefix) {
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  return parsed?.href === url &&
    url.startsWith(prefix) &&
    /^[A-Za-z0-9._+-]+\/[A-Za-z0-9._+-]+$/u.test(url.slice(prefix.length))
    ? undefined
    : `its address, ${url}, is not a release download under ${prefix}`;
}

/** @param {string} text */
function runnerUpdateTail(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length === 0 ? "it said nothing" : lines.slice(0, 3).join("; ");
}

/**
 * @param {string} reason
 * @returns {never}
 */
function runnerUpdateRefused(reason) {
  throw new Error(reason);
}

/** @type {RunnerUpdateRun} */
export function runnerUpdateRun(file, args, call) {
  return new Promise((settle) => {
    execFile(
      file,
      args,
      {
        env: { ...process.env, ...call.environment },
        timeout: call.timeoutMs,
        maxBuffer: runnerUpdateOutputBytesMax,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error === null) settle({ code: 0, stdout, stderr });
        else if (typeof error.code === "number")
          settle({ code: error.code, stdout, stderr });
        else
          settle({ code: -1, stdout, stderr: `${error.message}\n${stderr}` });
      },
    );
  });
}

/** @param {string} path */
function runnerUpdateAllowed(path, mode) {
  return access(path, mode).then(
    () => true,
    () => false,
  );
}

/**
 * The release's bytes, followed through redirects that stay on https.
 *
 * @param {RunnerRelease} release
 * @param {RunnerUpdatePorts} ports
 */
async function runnerReleaseBytes(release, ports) {
  const signal = ports.deadline(runnerUpdateFetchMsMax);
  let address = release.url;
  for (let redirects = 0; ; redirects += 1) {
    if (new URL(address).protocol !== "https:")
      runnerUpdateRefused(
        `its download was sent on to ${address}, which is not https`,
      );
    const response = await ports.fetch(address, { redirect: "manual", signal });
    const location = response.headers.get("location");
    if (!redirectStatuses.has(response.status) || location === null) {
      if (response.status !== 200) {
        await response.body?.cancel();
        runnerUpdateRefused(`its download answered ${String(response.status)}`);
      }
      return boundedResponseBytes(
        response,
        runnerUpdateBytesMax,
        runnerUpdateReadsMax,
      );
    }
    await response.body?.cancel();
    if (redirects >= runnerUpdateRedirectsMax)
      runnerUpdateRefused(
        "its download was sent on more times than a runner follows",
      );
    address = new URL(location, address).href;
  }
}

/**
 * The release's tarball, written into `staging` once its bytes are the ones
 * chuggy named.
 *
 * @param {RunnerRelease} release
 * @param {string} staging
 * @param {RunnerUpdatePorts} ports
 */
async function runnerReleaseFetched(release, staging, ports) {
  let bytes;
  try {
    bytes = await runnerReleaseBytes(release, ports);
  } catch (failure) {
    const why = /** @type {Error} */ (failure).message;
    throw new Error(
      why.startsWith("its ") ? why : `its download failed: ${why}`,
      { cause: failure },
    );
  }
  const digest = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (digest !== release.integrity)
    runnerUpdateRefused(
      "its tarball is not the one whose integrity chuggy named",
    );
  const tarball = join(staging, `${release.package}-${release.version}.tgz`);
  await writeFile(tarball, bytes, { mode: 0o600 });
  return tarball;
}

/**
 * The bin a staged manifest names for its package, inside the package.
 *
 * @param {Record<string, unknown>} manifest
 * @param {string} root
 * @param {string} packageName
 */
function runnerStagedBin(manifest, root, packageName) {
  const { bin } = manifest;
  const named =
    typeof bin === "string"
      ? bin
      : bin !== null && typeof bin === "object"
        ? /** @type {Record<string, unknown>} */ (bin)[packageName]
        : undefined;
  if (typeof named !== "string")
    runnerUpdateRefused(`its package.json names no bin called ${packageName}`);
  const path = resolve(root, named);
  const inside = relative(root, path);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside))
    runnerUpdateRefused(`its bin, ${named}, is outside its package`);
  return path;
}

/**
 * Unpacks the tarball beside it and proves what it holds: the package and the
 * version wanted, a Node range this Node meets, and a bin that answers
 * `--version` with the version under this Node.
 *
 * @param {RunnerRelease} release
 * @param {string} tarball
 * @param {RunnerUpdatePorts} ports
 */
async function runnerReleaseStaged(release, tarball, ports) {
  const unpacked = join(dirname(tarball), "unpacked");
  await mkdir(unpacked);
  const untarred = await ports.run("tar", ["-xzf", tarball, "-C", unpacked], {
    timeoutMs: runnerUpdateStepMsMax,
  });
  if (untarred.code !== 0)
    runnerUpdateRefused(
      `its tarball could not be unpacked: ${runnerUpdateTail(untarred.stderr)}`,
    );
  const root = join(unpacked, "package");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch {
    runnerUpdateRefused(
      "its tarball holds no package.json this runner can read",
    );
  }
  if (manifest?.name !== release.package)
    runnerUpdateRefused(`its package.json names ${String(manifest?.name)}`);
  if (manifest.version !== release.version)
    runnerUpdateRefused(
      `its package.json names version ${String(manifest.version)}`,
    );
  const engines = runnerEnginesRefusal(
    manifest.engines?.node,
    ports.nodeVersion,
  );
  if (engines !== undefined) runnerUpdateRefused(engines);
  const bin = runnerStagedBin(manifest, root, release.package);
  const answered = await ports.run(ports.execPath, [bin, "--version"], {
    timeoutMs: runnerUpdateStepMsMax,
  });
  if (answered.code !== 0)
    runnerUpdateRefused(
      `its bin exited ${String(answered.code)} asked its version: ${runnerUpdateTail(answered.stderr)}`,
    );
  if (!answered.stdout.split(/\s+/u).includes(release.version))
    runnerUpdateRefused(
      `its bin answered ${JSON.stringify(answered.stdout.trim().slice(0, 200))} asked its version`,
    );
}

/**
 * The version the installed copy's manifest names, where it names this
 * package.
 *
 * @param {string} installed
 * @param {string} packageName
 */
async function runnerInstalledVersion(installed, packageName) {
  try {
    const manifest = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    );
    return manifest?.name === packageName ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The answer for a copy already installed at or past `release`, or nothing.
 *
 * @param {string} installed
 * @param {RunnerRelease} release
 * @returns {Promise<RunnerUpdated | undefined>}
 */
async function runnerAlreadyInstalled(installed, release) {
  const present = await runnerInstalledVersion(installed, release.package);
  return runnerVersionAtLeast(present, release.version)
    ? { updated: "AlreadyInstalled", version: String(present) }
    : undefined;
}

/**
 * Installs the proved tarball under the install lock, unless the installed
 * copy is already at or past it.
 *
 * @param {RunnerRelease} release
 * @param {string} tarball
 * @param {{settings: RunnerUpdateSettings, prefix: string, ports: RunnerUpdatePorts}} context
 * @returns {Promise<RunnerUpdated>}
 */
async function runnerReleaseInstalled(release, tarball, context) {
  const { settings, prefix, ports } = context;
  const already = await runnerAlreadyInstalled(settings.installed, release);
  if (already !== undefined) return already;
  const beside = join(dirname(ports.execPath), "npm");
  const npm = (await ports.executable(beside)) ? beside : "npm";
  const path = ports.environment.PATH;
  const installed = await ports.run(
    npm,
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    {
      timeoutMs: runnerUpdateInstallMsMax,
      environment: {
        PATH: [
          dirname(ports.execPath),
          ...(path === undefined ? [] : [path]),
        ].join(delimiter),
      },
    },
  );
  if (installed.code !== 0)
    runnerUpdateRefused(
      `npm could not install it: ${runnerUpdateTail(installed.stderr)}`,
    );
  const now = await runnerInstalledVersion(settings.installed, release.package);
  if (now !== release.version)
    runnerUpdateRefused(
      `npm installed it, and ${join(settings.installed, "package.json")} names version ${String(now)}`,
    );
  return { updated: "Installed", version: release.version };
}

/**
 * @typedef {object} RunnerUpdateContext
 * @property {RunnerUpdateSettings} settings
 * @property {string | undefined} prefix the npm prefix the copy was installed under, if it was installed globally
 * @property {RunnerUpdatePorts} ports
 */

/**
 * Why a release is refused before anything is fetched, or nothing.
 *
 * @param {RunnerUpdateContext} context
 * @param {RunnerRelease} release
 */
async function runnerUpdateRefusal(context, release) {
  const { settings, prefix, ports } = context;
  const { runner } = settings;
  if (release.package !== runner.package)
    return `it is a release of ${release.package}, and this runner is ${runner.package}`;
  if (!runnerVersionAbove(release.version, runner.version))
    return `it is not above this runner's own version, ${runner.version}`;
  const address = runnerReleaseUrlRefusal(release.url, settings.releasePrefix);
  if (address !== undefined) return address;
  if (prefix === undefined)
    return `this runner is installed at ${settings.installed}, which is not where npm installs a package globally`;
  for (const directory of [
    join(prefix, "lib", "node_modules"),
    join(prefix, "bin"),
  ])
    if (!(await ports.writable(directory)))
      return `this runner cannot write ${directory}, where npm would install it`;
  return undefined;
}

/**
 * The answer known before anything is fetched, a refusal or a copy already at
 * or past the release, or else the prefix the release would be installed
 * under.
 *
 * @param {RunnerUpdateContext} context
 * @param {RunnerRelease} release
 * @returns {Promise<RunnerUpdated | {prefix: string}>}
 */
async function runnerUpdateUnfetched(context, release) {
  const reason = await runnerUpdateRefusal(context, release);
  if (reason !== undefined || context.prefix === undefined)
    return { updated: "Failed", reason: String(reason) };
  return (
    (await runnerAlreadyInstalled(context.settings.installed, release)) ?? {
      prefix: context.prefix,
    }
  );
}

/**
 * What `proven` makes of the release's tarball once it is proved, while it is
 * still staged in a directory of this process's own. Throws why the release
 * did not prove itself.
 *
 * @template T
 * @param {RunnerUpdatePorts} ports
 * @param {RunnerRelease} release
 * @param {(tarball: string) => Promise<T>} proven
 * @returns {Promise<T>}
 */
async function runnerReleaseProved(ports, release, proven) {
  const staging = await mkdtemp(join(ports.temporary, "chuggy-runner-update-"));
  try {
    const tarball = await runnerReleaseFetched(release, staging, ports);
    await runnerReleaseStaged(release, tarball, ports);
    return await proven(tarball);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** @param {unknown} failure */
function runnerUpdateFailure(failure) {
  return /** @type {Error} */ (failure).message;
}

/**
 * @param {RunnerUpdateContext} context
 * @param {RunnerRelease} release
 * @returns {Promise<RunnerProved>}
 */
async function runnerUpdateProve(context, release) {
  try {
    const unfetched = await runnerUpdateUnfetched(context, release);
    if ("prefix" in unfetched)
      await runnerReleaseProved(context.ports, release, async () => undefined);
    else if (unfetched.updated === "Failed")
      return { proved: "Failed", reason: unfetched.reason };
    return { proved: "Proved" };
  } catch (failure) {
    return { proved: "Failed", reason: runnerUpdateFailure(failure) };
  }
}

/**
 * @param {RunnerUpdateContext} context
 * @param {RunnerRelease} release
 * @returns {Promise<RunnerUpdated>}
 */
async function runnerUpdateInstall(context, release) {
  const { settings, ports } = context;
  const { lockPath } = settings;
  const lockBounds = {
    waitMsMax: runnerUpdateLockWaitMsMax,
    heldMsMax: runnerUpdateLockHeldMsMax,
    pollMs: 1_000,
    busy: `another service has held the install lock at ${lockPath} for longer than an install waits`,
  };
  try {
    const unfetched = await runnerUpdateUnfetched(context, release);
    if (!("prefix" in unfetched)) return unfetched;
    const { prefix } = unfetched;
    return await runnerReleaseProved(ports, release, async (tarball) => {
      await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
      return fileLocked(lockPath, lockBounds, ports, () =>
        runnerReleaseInstalled(release, tarball, { settings, prefix, ports }),
      );
    });
  } catch (failure) {
    return { updated: "Failed", reason: runnerUpdateFailure(failure) };
  }
}

/**
 * The update of a copy installed as `settings` says, through `overrides`
 * where a suite stands in for the network, npm or the machine.
 *
 * @param {RunnerUpdateSettings} settings
 * @param {Partial<RunnerUpdatePorts>} [overrides]
 * @returns {RunnerUpdater}
 */
export function runnerUpdater(settings, overrides = {}) {
  checkedRunnerUpdateSettings(settings);
  /** @type {RunnerUpdateContext} */
  const context = {
    settings,
    prefix: runnerNpmPrefix(settings.installed, settings.runner.package),
    ports: {
      fetch: globalThis.fetch,
      deadline: (ms) => globalThis.AbortSignal.timeout(ms),
      run: runnerUpdateRun,
      writable: (path) => runnerUpdateAllowed(path, constants.W_OK),
      executable: (path) => runnerUpdateAllowed(path, constants.X_OK),
      execPath: process.execPath,
      nodeVersion: process.versions.node,
      environment: process.env,
      temporary: tmpdir(),
      pid: process.pid,
      nowMs: Date.now,
      wait,
      holderAlive: fileLockHolderAlive,
      ...overrides,
    },
  };
  return {
    runner: settings.runner,
    refusal: (release) => runnerUpdateRefusal(context, release),
    prove: (release) => runnerUpdateProve(context, release),
    update: (release) => runnerUpdateInstall(context, release),
  };
}
