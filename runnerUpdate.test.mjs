/**
 * A runner's update of itself, against a release packed here, served by a
 * fetch of the suite's own and installed by an npm that copies its manifest
 * into a prefix under a temporary directory. The system's `tar` unpacks it
 * and this suite's own Node runs its bin, as they would on a machine.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { setTimeout } from "node:timers";
import { URL } from "node:url";

import { workerPoolClientPass, workerPoolUpdating } from "./poolLoop.mjs";
import {
  runnerEnginesRefusal,
  runnerUpdateBytesMax,
  runnerUpdateFetchMsMax,
  runnerUpdateInstallMsMax,
  runnerUpdater,
  runnerUpdateRun,
  runnerVersionAbove,
} from "./runnerUpdate.mjs";

const packageName = "chuggy-test";
const releasePrefix =
  "https://github.com/kasofsk/chuggy-test/releases/download/";
const ownVersion = "0.4.2";
const wanted = "0.5.0";

/** A bin that answers `--version` as a runner's does. */
const versionBin = (answer) =>
  `if (process.argv[2] === "--version") console.log(${JSON.stringify(answer)});\n`;

/**
 * A release tarball as npm packs one: everything under `package/`.
 *
 * @param {string} root
 * @param {{manifest?: Record<string, unknown>, bin?: string, files?: Record<string, string>}} [shape]
 */
async function packed(root, shape = {}) {
  const build = await mkdtemp(join(root, "build-"));
  const top = join(build, "package");
  await mkdir(top);
  const manifest = shape.manifest ?? {
    name: packageName,
    version: wanted,
    engines: { node: ">=24" },
    bin: { [packageName]: "cli.mjs" },
  };
  await writeFile(join(top, "package.json"), JSON.stringify(manifest));
  await writeFile(
    join(top, "cli.mjs"),
    shape.bin ?? versionBin(`${packageName} ${wanted}`),
  );
  for (const [name, text] of Object.entries(shape.files ?? {}))
    await writeFile(join(top, name), text);
  const tarball = join(build, "release.tgz");
  const tarred = await runnerUpdateRun(
    "tar",
    ["-czf", tarball, "-C", build, "package"],
    { timeoutMs: 30_000 },
  );
  assert.equal(tarred.code, 0, tarred.stderr);
  return readFile(tarball);
}

/** @param {Uint8Array} bytes */
const integrityOf = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/**
 * @param {Uint8Array} bytes
 * @param {Partial<import("./runnerUpdate.mjs").RunnerRelease>} [fields]
 */
const releaseOf = (bytes, fields = {}) => ({
  package: packageName,
  version: wanted,
  url: `${releasePrefix}v${wanted}/${packageName}-${wanted}.tgz`,
  integrity: integrityOf(bytes),
  ...fields,
});

/** A machine whose npm cannot write its cache, as a root-owned `~/.npm` leaves it. */
const uncached = async (file, args, call) =>
  args[0] === "install"
    ? {
        code: 243,
        stdout: "",
        stderr:
          "npm error code EACCES\nnpm error path /home/runner/.npm/_cacache/tmp\n",
      }
    : runnerUpdateRun(file, args, call);

/**
 * A machine with this runner installed globally under a prefix of its own,
 * a fetch answering the release's address with `bytes`, and an npm that
 * installs a tarball by copying its manifest into the prefix it is given.
 *
 * @param {import("node:test").TestContext} t
 * @param {{bytes?: Uint8Array, ports?: Record<string, unknown>, installedVersion?: string}} [options]
 */
async function machine(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "runner-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = join(root, "prefix");
  const installed = join(prefix, "lib", "node_modules", packageName);
  await mkdir(installed, { recursive: true });
  await mkdir(join(prefix, "bin"));
  await writeFile(
    join(installed, "package.json"),
    JSON.stringify({
      name: packageName,
      version: options.installedVersion ?? ownVersion,
    }),
  );
  const temporary = join(root, "tmp");
  await mkdir(temporary);
  const bytes = options.bytes ?? (await packed(root));
  /** @type {{file: string, args: readonly string[], environment?: Readonly<Record<string, string>>}[]} */
  const npmCalls = [];
  /** @type {{url: string, init: RequestInit}[]} */
  const fetched = [];
  const ports = {
    fetch: async (url, init) => {
      fetched.push({ url: String(url), init });
      return new globalThis.Response(bytes, { status: 200 });
    },
    run: async (file, args, call) => {
      if (args[0] !== "install") return runnerUpdateRun(file, args, call);
      npmCalls.push({ file, args, environment: call.environment });
      const scratch = await mkdtemp(join(root, "npm-"));
      const untarred = await runnerUpdateRun(
        "tar",
        ["-xzf", args.at(-1), "-C", scratch],
        { timeoutMs: 30_000 },
      );
      assert.equal(untarred.code, 0, untarred.stderr);
      const target = join(args[3], "lib", "node_modules", packageName);
      await mkdir(target, { recursive: true });
      await writeFile(
        join(target, "package.json"),
        await readFile(join(scratch, "package", "package.json")),
      );
      return { code: 0, stdout: "", stderr: "" };
    },
    executable: async () => false,
    temporary,
    ...options.ports,
  };
  const settings = {
    runner: { package: packageName, version: ownVersion },
    releasePrefix,
    installed,
    lockPath: join(root, "state", "update.lock"),
  };
  return {
    root,
    prefix,
    installed,
    temporary,
    bytes,
    npmCalls,
    fetched,
    settings,
    ports,
    updater: runnerUpdater(settings, ports),
    installedVersion: async () =>
      JSON.parse(await readFile(join(installed, "package.json"), "utf8"))
        .version,
  };
}

test("a release proved whole is installed into the prefix the runner was installed under, and nothing is left staged", async (t) => {
  const box = await machine(t);
  const updated = await box.updater.update(releaseOf(box.bytes));
  assert.deepEqual(updated, { updated: "Installed", version: wanted });
  assert.equal(await box.installedVersion(), wanted);
  assert.equal(box.npmCalls.length, 1);
  const [{ args }] = box.npmCalls;
  assert.deepEqual(args.slice(0, -1), [
    "install",
    "--global",
    "--prefix",
    box.prefix,
    "--no-audit",
    "--no-fund",
  ]);
  assert.match(args.at(-1) ?? "", /chuggy-test-0\.5\.0\.tgz$/u);
  assert.deepEqual(await readdir(box.temporary), []);
  await assert.rejects(readFile(box.settings.lockPath), { code: "ENOENT" });
});

test("a release proved whole is installed by npm only into a prefix of the proof's own, no lock is taken and nothing is left staged", async (t) => {
  const box = await machine(t);
  assert.deepEqual(await box.updater.prove(releaseOf(box.bytes)), {
    proved: "Proved",
  });
  assert.equal(box.fetched.length, 1);
  assert.equal(box.npmCalls.length, 1);
  const [{ file, args, environment }] = box.npmCalls;
  assert.equal(file, "npm");
  assert.deepEqual(
    [...args.slice(0, 3), ...args.slice(4, -1)],
    ["install", "--global", "--prefix", "--no-audit", "--no-fund"],
  );
  assert.ok(args[3].startsWith(join(box.temporary, "chuggy-runner-update-")));
  assert.match(args.at(-1) ?? "", /chuggy-test-0\.5\.0\.tgz$/u);
  assert.equal(
    environment?.PATH?.split(delimiter)[0],
    dirname(process.execPath),
  );
  assert.equal(await box.installedVersion(), ownVersion);
  assert.deepEqual(await readdir(box.temporary), []);
  await assert.rejects(readFile(box.settings.lockPath), { code: "ENOENT" });
});

test("a release whose update would fail before npm, or at npm's own failure, fails its proof for the same reason", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tooNew = await packed(root, {
    manifest: {
      name: packageName,
      version: wanted,
      engines: { node: ">=99" },
      bin: { [packageName]: "cli.mjs" },
    },
  });
  const misnamed = await packed(root, {
    bin: versionBin(`${packageName} 0.5.1`),
  });
  const missing = async () => new globalThis.Response("", { status: 404 });
  for (const [options, fields, why] of [
    [{}, { package: "chuggy-darwin" }, /release of chuggy-darwin/u],
    [{ ports: { fetch: missing } }, {}, /^its download answered 404$/u],
    [{}, { integrity: `sha512-${"A".repeat(86)}==` }, /integrity chuggy/u],
    [{ bytes: tooNew }, {}, /needs Node >=99/u],
    [{ bytes: misnamed }, {}, /^its bin answered/u],
    [
      { ports: { run: uncached } },
      {},
      /^npm could not install it: npm error code EACCES; npm error path /u,
    ],
  ]) {
    const box = await machine(t, options);
    const release = releaseOf(box.bytes, fields);
    const proved = await box.updater.prove(release);
    assert.equal(proved.proved, "Failed", String(why));
    assert.match(proved.reason, why);
    assert.deepEqual(await box.updater.update(release), {
      updated: "Failed",
      reason: proved.reason,
    });
    assert.equal(box.npmCalls.length, 0);
    assert.deepEqual(await readdir(box.temporary), []);
  }
});

test(
  "a release npm cannot install never drains a pool whose work would end with its process, and is not proved again before the backoff",
  { timeout: 60_000 },
  async (t) => {
    const box = await machine(t, { ports: { run: uncached } });
    const release = releaseOf(box.bytes);
    /** @type {number[][]} */
    const rooms = [];
    /** @type {string[]} */
    const logged = [];
    const pooled = {
      tokens: {
        acquire: async () => ({ acquired: "Token", token: "pool-token" }),
        invalidate: () => undefined,
      },
      plane: {
        poll: async (_token, _held, jobs, sessions) => {
          rooms.push([jobs, sessions]);
          return {
            polled: "Reconciled",
            assignments: [],
            sessions: [],
            stop: [],
            release,
          };
        },
        settle: async () => "Settled",
      },
      jobs: { end: async () => "Ended" },
      sessions: { end: async () => "Ended" },
      backend: {
        held: async () => [{ assignment: "host-1", kind: "Job" }],
        ended: async () => [],
        place: async () => ({ placed: "Placed" }),
        stop: async () => ({ stopped: "Stopped" }),
      },
      settings: {
        concurrencyMax: 2,
        sessionsMax: 1,
        outageBackoffMs: 1,
        passesMax: 1,
      },
    };
    const updating = workerPoolUpdating(
      { on: true, updater: box.updater },
      { log: (line) => logged.push(line), nowMs: () => 0 },
    );
    await workerPoolClientPass(/** @type {any} */ (pooled), updating);
    await workerPoolClientPass(/** @type {any} */ (pooled), updating);
    for (
      let waits = 0;
      waits < 3000 && !logged.some((line) => line.startsWith("did not update"));
      waits += 1
    )
      await new Promise((settle) => {
        setTimeout(settle, 10);
      });
    await workerPoolClientPass(/** @type {any} */ (pooled), updating);
    await workerPoolClientPass(/** @type {any} */ (pooled), updating);
    assert.deepEqual(rooms, [
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
    assert.equal(box.fetched.length, 1);
    assert.match(
      logged.at(-1) ?? "",
      /^did not update to chuggy-test 0\.5\.0: npm could not install it: npm error code EACCES/u,
    );
    assert.equal(await box.installedVersion(), ownVersion);
  },
);

test("a copy another service already brought to or past the release is proved without a fetch", async (t) => {
  for (const present of [wanted, "0.6.0"]) {
    const box = await machine(t, { installedVersion: present });
    assert.deepEqual(await box.updater.prove(releaseOf(box.bytes)), {
      proved: "Proved",
    });
    assert.deepEqual(box.fetched, []);
  }
});

test("a release of another package, or not above this runner's own version, is refused before anything is fetched", async (t) => {
  const box = await machine(t);
  for (const [fields, why] of [
    [{ package: "chuggy-darwin" }, /release of chuggy-darwin/u],
    [{ version: ownVersion }, /not above this runner's own version/u],
    [{ version: "0.4.1" }, /not above this runner's own version/u],
  ]) {
    const release = releaseOf(box.bytes, fields);
    assert.match(String(await box.updater.refusal(release)), why);
    const updated = await box.updater.update(release);
    assert.equal(updated.updated, "Failed");
    assert.match(updated.reason, why);
  }
  assert.deepEqual(box.fetched, []);
  assert.equal(box.npmCalls.length, 0);
});

test("an address that is not one of this package's release downloads is refused before anything is fetched", async (t) => {
  const box = await machine(t);
  for (const url of [
    `https://github.com/kasofsk/other/releases/download/v${wanted}/a.tgz`,
    `http://github.com/kasofsk/chuggy-test/releases/download/v${wanted}/a.tgz`,
    `${releasePrefix}v${wanted}/../../../../other/releases/download/v1/a.tgz`,
    `${releasePrefix}v${wanted}%2F..%2F..%2Fother/a.tgz`,
    `${releasePrefix}v${wanted}/a.tgz?b=c`,
    `${releasePrefix}a.tgz`,
    `${releasePrefix}../${packageName}.tgz`,
  ]) {
    const updated = await box.updater.update(releaseOf(box.bytes, { url }));
    assert.equal(updated.updated, "Failed", url);
    assert.match(updated.reason, /is not a release download under/u, url);
  }
  assert.deepEqual(box.fetched, []);
});

test("a copy not installed where npm installs a package globally, or under a prefix it cannot write, refuses", async (t) => {
  const box = await machine(t);
  for (const installed of [
    join(box.root, "checkout", packageName),
    join(box.prefix, "lib", "packages", packageName),
    join(box.prefix, "share", "node_modules", packageName),
    join(box.prefix, "lib", "node_modules", "chuggy-other"),
  ]) {
    const elsewhere = runnerUpdater({ ...box.settings, installed }, box.ports);
    assert.match(
      String(await elsewhere.refusal(releaseOf(box.bytes))),
      /not where npm installs a package globally/u,
      installed,
    );
  }
  for (const unwritable of [
    join(box.prefix, "lib", "node_modules"),
    join(box.prefix, "bin"),
  ]) {
    const locked = runnerUpdater(box.settings, {
      ...box.ports,
      writable: async (path) => path !== unwritable,
    });
    const updated = await locked.update(releaseOf(box.bytes));
    assert.equal(updated.updated, "Failed");
    assert.match(updated.reason, /cannot write/u);
    assert.ok(updated.reason.includes(unwritable));
  }
  assert.deepEqual(box.fetched, []);
  assert.equal(await box.updater.refusal(releaseOf(box.bytes)), undefined);
});

test("a prefix this user cannot write is found unwritable on the machine itself", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root writes any directory");
    return;
  }
  const box = await machine(t);
  await chmod(join(box.prefix, "bin"), 0o500);
  try {
    assert.match(
      String(await box.updater.refusal(releaseOf(box.bytes))),
      /cannot write/u,
    );
  } finally {
    await chmod(join(box.prefix, "bin"), 0o700);
  }
});

test("bytes that are not the ones chuggy named are refused, and nothing is installed", async (t) => {
  const box = await machine(t);
  const other = await packed(box.root, {
    bin: versionBin(`${packageName} ${wanted} `),
  });
  const updated = await box.updater.update(
    releaseOf(box.bytes, { integrity: integrityOf(other) }),
  );
  assert.deepEqual(updated, {
    updated: "Failed",
    reason: "its tarball is not the one whose integrity chuggy named",
  });
  assert.equal(box.npmCalls.length, 0);
  assert.equal(await box.installedVersion(), ownVersion);
});

test("a download runs under a deadline, and one that does not answer in time fails", async (t) => {
  /** @type {number[]} */
  const deadlines = [];
  const box = await machine(t, {
    ports: {
      deadline: (ms) => {
        deadlines.push(ms);
        const deadline = new globalThis.AbortController();
        setTimeout(() => deadline.abort(new Error("the deadline passed")), 20);
        return deadline.signal;
      },
      fetch: (_url, init) => {
        const signal = init?.signal;
        if (!signal) return Promise.reject(new Error("fetched unbounded"));
        return new Promise((_settle, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      },
    },
  });
  const updated = await box.updater.update(releaseOf(box.bytes));
  assert.equal(updated.updated, "Failed");
  assert.equal(updated.reason, "its download failed: the deadline passed");
  assert.deepEqual(deadlines, [runnerUpdateFetchMsMax]);
  assert.equal(box.npmCalls.length, 0);
});

test("a download is followed through https redirects, and one sent on to http, or sent on too often, fails", async (t) => {
  const packing = await mkdtemp(join(tmpdir(), "runner-pack-"));
  t.after(() => rm(packing, { recursive: true, force: true }));
  const bytes = await packed(packing);
  const served = (hops, last) => async (url, init) => {
    assert.equal(init.redirect, "manual");
    const at = Number(new URL(url).searchParams.get("hop") ?? "0");
    if (at < hops)
      return new globalThis.Response(null, {
        status: 302,
        headers: {
          location:
            at + 1 === hops && last !== undefined
              ? last
              : `https://objects.example/asset?hop=${String(at + 1)}`,
        },
      });
    return new globalThis.Response(bytes, { status: 200 });
  };
  const followed = await machine(t, { bytes, ports: { fetch: served(1) } });
  assert.equal(
    (await followed.updater.update(releaseOf(bytes))).updated,
    "Installed",
  );
  const plain = await machine(t, {
    bytes,
    ports: { fetch: served(1, "http://objects.example/asset?hop=1") },
  });
  const insecure = await plain.updater.update(releaseOf(bytes));
  assert.equal(insecure.updated, "Failed");
  assert.match(insecure.reason, /which is not https/u);
  const looping = await machine(t, { bytes, ports: { fetch: served(99) } });
  const endless = await looping.updater.update(releaseOf(bytes));
  assert.equal(endless.updated, "Failed");
  assert.match(endless.reason, /sent on more times than a runner follows/u);
});

test("a download that answers anything but its bytes, or more of them than a release weighs, fails", async (t) => {
  const missing = await machine(t, {
    ports: {
      fetch: async () => new globalThis.Response("gone", { status: 404 }),
    },
  });
  assert.deepEqual(await missing.updater.update(releaseOf(missing.bytes)), {
    updated: "Failed",
    reason: "its download answered 404",
  });
  // One chunk past the bound, then the end: a read without the bound fails
  // the reason below rather than filling the machine's memory.
  let sent = 0;
  const heavy = await machine(t, {
    ports: {
      fetch: async () =>
        new globalThis.Response(
          new globalThis.ReadableStream({
            pull(controller) {
              if (sent > runnerUpdateBytesMax) controller.close();
              else {
                controller.enqueue(new Uint8Array(1024 * 1024));
                sent += 1024 * 1024;
              }
            },
          }),
          { status: 200 },
        ),
    },
  });
  const updated = await heavy.updater.update(releaseOf(heavy.bytes));
  assert.equal(updated.updated, "Failed");
  assert.match(updated.reason, /byte bound/u);
  assert.ok(runnerUpdateBytesMax > heavy.bytes.byteLength);
});

test("a tarball that cannot be unpacked fails", async (t) => {
  const box = await machine(t, { bytes: Buffer.from("not a tarball") });
  const updated = await box.updater.update(releaseOf(box.bytes));
  assert.equal(updated.updated, "Failed");
  assert.match(updated.reason, /^its tarball could not be unpacked: /u);
});

test("a release whose manifest names another package or version fails", async (t) => {
  for (const [manifest, why] of [
    [
      { name: "chuggy-other", version: wanted },
      /^its package\.json names chuggy-other$/u,
    ],
    [
      { name: packageName, version: "0.5.1" },
      /^its package\.json names version 0\.5\.1$/u,
    ],
  ]) {
    const root = await mkdtemp(join(tmpdir(), "runner-pack-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bytes = await packed(root, {
      manifest: { ...manifest, bin: { [packageName]: "cli.mjs" } },
    });
    const box = await machine(t, { bytes });
    const updated = await box.updater.update(releaseOf(bytes));
    assert.equal(updated.updated, "Failed");
    assert.match(updated.reason, why);
    assert.equal(box.npmCalls.length, 0);
  }
});

test("a release whose engines.node this Node does not meet, or that this runner does not read, fails", async (t) => {
  for (const [node, why] of [
    [">=99", /needs Node >=99/u],
    ["^24", /a range this runner does not read/u],
  ]) {
    const root = await mkdtemp(join(tmpdir(), "runner-pack-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bytes = await packed(root, {
      manifest: {
        name: packageName,
        version: wanted,
        engines: { node },
        bin: { [packageName]: "cli.mjs" },
      },
    });
    const box = await machine(t, { bytes });
    const updated = await box.updater.update(releaseOf(bytes));
    assert.equal(updated.updated, "Failed");
    assert.match(updated.reason, why);
  }
});

test("engines.node is read in the forms a runner names, and nothing else passes", () => {
  assert.equal(runnerEnginesRefusal(undefined, "24.1.0"), undefined);
  assert.equal(runnerEnginesRefusal(">=24", "24.0.0"), undefined);
  assert.equal(runnerEnginesRefusal(">= 24", "25.0.0"), undefined);
  assert.equal(runnerEnginesRefusal(">=24.3.1", "24.3.1"), undefined);
  assert.equal(runnerEnginesRefusal(">=24.3.1", "24.10.0"), undefined);
  for (const [range, node] of [
    [">=24", "22.11.0"],
    [">=24.3.1", "24.3.0"],
    [">=24.3.1", "24.2.9"],
  ])
    assert.match(String(runnerEnginesRefusal(range, node)), /needs Node/u);
  for (const range of [">=24.3", "^24", "24", ">24", ">=24 <26", "*", 24])
    assert.match(
      String(runnerEnginesRefusal(range, "30.0.0")),
      /does not read/u,
    );
});

test("a release with no bin of its package's name, or one outside the package, fails", async (t) => {
  for (const [bin, why] of [
    [{ other: "cli.mjs" }, /names no bin called chuggy-test/u],
    [{ [packageName]: "../outside.mjs" }, /is outside its package/u],
  ]) {
    const root = await mkdtemp(join(tmpdir(), "runner-pack-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bytes = await packed(root, {
      manifest: { name: packageName, version: wanted, bin },
    });
    const box = await machine(t, { bytes });
    const updated = await box.updater.update(releaseOf(bytes));
    assert.equal(updated.updated, "Failed");
    assert.match(updated.reason, why);
  }
});

test("a manifest whose bin is a string names the package's bin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = await packed(root, {
    manifest: { name: packageName, version: wanted, bin: "cli.mjs" },
  });
  const box = await machine(t, { bytes });
  assert.equal(
    (await box.updater.update(releaseOf(bytes))).updated,
    "Installed",
  );
});

test("a bin that fails under this Node, or answers another version, fails", async (t) => {
  for (const [bin, why] of [
    ["process.exit(3);\n", /its bin exited 3 asked its version/u],
    [versionBin(`${packageName} 0.5.0-rc.1`), /its bin answered/u],
    [versionBin(`${packageName} v${wanted}`), /its bin answered/u],
    ['import "./missing.mjs";\n', /its bin exited 1/u],
  ]) {
    const root = await mkdtemp(join(tmpdir(), "runner-pack-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bytes = await packed(root, { bin });
    const box = await machine(t, { bytes });
    const updated = await box.updater.update(releaseOf(bytes));
    assert.equal(updated.updated, "Failed", bin);
    assert.match(updated.reason, why, bin);
    assert.equal(box.npmCalls.length, 0);
  }
});

test("a bin is run under this process's Node", async (t) => {
  /** @type {string[]} */
  const ran = [];
  const box = await machine(t);
  const updater = runnerUpdater(box.settings, {
    ...box.ports,
    run: async (file, args, call) => {
      ran.push(file);
      return box.ports.run(file, args, call);
    },
  });
  assert.equal(
    (await updater.update(releaseOf(box.bytes))).updated,
    "Installed",
  );
  assert.deepEqual(ran, ["tar", process.execPath, "npm"]);
});

test("an install already at or past the version under the lock installs nothing and restarts", async (t) => {
  for (const present of [wanted, "0.6.0"]) {
    const box = await machine(t);
    const updater = runnerUpdater(box.settings, {
      ...box.ports,
      run: async (file, args, call) => {
        if (args[1] === "--version")
          await writeFile(
            join(box.installed, "package.json"),
            JSON.stringify({ name: packageName, version: present }),
          );
        return box.ports.run(file, args, call);
      },
    });
    assert.deepEqual(await updater.update(releaseOf(box.bytes)), {
      updated: "AlreadyInstalled",
      version: present,
    });
    assert.equal(box.npmCalls.length, 0);
  }
});

test("an install another service already brought to or past the version restarts without fetching", async (t) => {
  for (const present of [wanted, "0.6.0"]) {
    const box = await machine(t, { installedVersion: present });
    assert.deepEqual(await box.updater.update(releaseOf(box.bytes)), {
      updated: "AlreadyInstalled",
      version: present,
    });
    assert.deepEqual(box.fetched, []);
    assert.equal(box.npmCalls.length, 0);
  }
});

test("an install of another package's manifest, or none, is installed over", async (t) => {
  const box = await machine(t);
  await writeFile(
    join(box.installed, "package.json"),
    JSON.stringify({ name: "chuggy-other", version: "9.9.9" }),
  );
  assert.equal(
    (await box.updater.update(releaseOf(box.bytes))).updated,
    "Installed",
  );
  await rm(join(box.installed, "package.json"));
  const again = runnerUpdater(box.settings, box.ports);
  assert.equal((await again.update(releaseOf(box.bytes))).updated, "Installed");
});

test("the install waits for another service's hold, and takes a lock whose holder is gone", async (t) => {
  const box = await machine(t);
  await mkdir(dirname(box.settings.lockPath), { recursive: true });
  await writeFile(box.settings.lockPath, "4242\n");
  /** @type {number[]} */
  const waited = [];
  const live = runnerUpdater(box.settings, {
    ...box.ports,
    holderAlive: () => waited.length < 3,
    wait: async (ms) => {
      waited.push(ms);
    },
  });
  assert.equal((await live.update(releaseOf(box.bytes))).updated, "Installed");
  assert.equal(waited.length, 3);
  assert.equal(box.npmCalls.length, 1);
});

test("a lock its holder still names is waited on, and taken once it is older than any install holds one", async (t) => {
  const box = await machine(t);
  await mkdir(dirname(box.settings.lockPath), { recursive: true });
  await writeFile(box.settings.lockPath, `${String(process.pid)}\n`);
  const startedMs = Date.now();
  let nowMs = startedMs;
  const held = runnerUpdater(box.settings, {
    ...box.ports,
    nowMs: () => nowMs,
    wait: async (ms) => {
      nowMs += ms;
    },
  });
  assert.equal((await held.update(releaseOf(box.bytes))).updated, "Installed");
  assert.ok(nowMs - startedMs > runnerUpdateInstallMsMax);
  assert.equal(box.npmCalls.length, 1);
});

test("npm's failure, or an install that does not name the version after, fails", async (t) => {
  const box = await machine(t);
  const failing = runnerUpdater(box.settings, {
    ...box.ports,
    run: async (file, args, call) =>
      args[0] === "install"
        ? { code: 243, stdout: "", stderr: "npm error code EACCES\n" }
        : box.ports.run(file, args, call),
  });
  assert.deepEqual(await failing.update(releaseOf(box.bytes)), {
    updated: "Failed",
    reason: "npm could not install it: npm error code EACCES",
  });
  const silent = runnerUpdater(box.settings, {
    ...box.ports,
    run: async (file, args, call) =>
      args[0] === "install"
        ? { code: 0, stdout: "", stderr: "" }
        : box.ports.run(file, args, call),
  });
  const updated = await silent.update(releaseOf(box.bytes));
  assert.equal(updated.updated, "Failed");
  assert.match(updated.reason, /names version 0\.4\.2$/u);
});

test("npm is the one beside this Node where there is one, else PATH's, and runs with this Node first on PATH", async (t) => {
  const box = await machine(t);
  const nodeDirectory = join(box.root, "node", "bin");
  await mkdir(nodeDirectory, { recursive: true });
  const node = join(nodeDirectory, "node");
  await symlink(process.execPath, node);
  const environment = { PATH: "/usr/bin:/bin" };
  for (const [beside, file] of [
    [true, join(nodeDirectory, "npm")],
    [false, "npm"],
  ]) {
    const updater = runnerUpdater(
      {
        ...box.settings,
        runner: { package: packageName, version: ownVersion },
      },
      {
        ...box.ports,
        execPath: node,
        environment,
        executable: async (path) =>
          beside && path === join(nodeDirectory, "npm"),
      },
    );
    await writeFile(
      join(box.installed, "package.json"),
      JSON.stringify({ name: packageName, version: ownVersion }),
    );
    assert.equal(
      (await updater.update(releaseOf(box.bytes))).updated,
      "Installed",
    );
    const call = box.npmCalls.at(-1);
    assert.equal(call?.file, file);
    assert.deepEqual(call?.environment, {
      PATH: `${nodeDirectory}${delimiter}/usr/bin:/bin`,
    });
  }
});

test("a runner's settings that name no package, version or https prefix are refused at once", () => {
  const settings = {
    runner: { package: packageName, version: ownVersion },
    releasePrefix,
    installed: "/usr/lib/node_modules/chuggy-test",
    lockPath: "/tmp/update.lock",
  };
  for (const [changed, why] of [
    [
      { runner: { package: "Chuggy", version: ownVersion } },
      /no package name/u,
    ],
    [{ runner: { package: packageName, version: "0.4" } }, /no plain release/u],
    [{ releasePrefix: "http://github.com/x/" }, /no https address/u],
    [{ releasePrefix: "https://github.com/x" }, /no https address/u],
    [{ releasePrefix: "https://github.com/x/?y=1/" }, /no https address/u],
    [{ releasePrefix: "https://u:p@github.com/x/" }, /no https address/u],
  ])
    assert.throws(() => runnerUpdater({ ...settings, ...changed }), why);
  assert.ok(runnerUpdater(settings));
});

test("versions compare as plain releases, and nothing else is above anything", () => {
  assert.equal(runnerVersionAbove("0.5.0", "0.4.9"), true);
  assert.equal(runnerVersionAbove("0.10.0", "0.9.0"), true);
  assert.equal(runnerVersionAbove("1.0.0", "0.99.99"), true);
  assert.equal(runnerVersionAbove("0.4.2", "0.4.2"), false);
  assert.equal(runnerVersionAbove("0.4.1", "0.4.2"), false);
  assert.equal(runnerVersionAbove("0.5.0-rc.1", "0.4.2"), false);
  assert.equal(runnerVersionAbove("05.0.0", "0.4.2"), false);
});

test("a process run for an update is answered with its code and streams, and one that cannot start or runs past its cap with -1", async () => {
  assert.deepEqual(
    await runnerUpdateRun(
      process.execPath,
      ["-e", 'console.log("out"); console.error("err"); process.exit(4)'],
      { timeoutMs: 30_000 },
    ),
    { code: 4, stdout: "out\n", stderr: "err\n" },
  );
  assert.equal(
    (
      await runnerUpdateRun(process.execPath, ["-e", "process.exit(0)"], {
        timeoutMs: 30_000,
        environment: { CHUGGY_PROBE: "1" },
      })
    ).code,
    0,
  );
  assert.equal(
    (await runnerUpdateRun("/nonexistent/binary", [], { timeoutMs: 1_000 }))
      .code,
    -1,
  );
  assert.equal(
    (
      await runnerUpdateRun(
        process.execPath,
        ["-e", "setTimeout(() => {}, 60_000)"],
        { timeoutMs: 100 },
      )
    ).code,
    -1,
  );
});
