/**
 * `check.sh` run as a job container runs it, against a runtime tree whose stub
 * binaries fail as a real image makes chuggy's fail: the loader's own words
 * and statuses, an interpreter the image does not have, no git, and a HOME, a
 * workspace and a temporary directory this user cannot write or search. Every
 * case runs under each shell an image's `/bin/sh` may be.
 *
 * THE NODE A PASSING TREE STARTS THE CORE WITH IS THIS SUITE'S OWN, on a stub
 * core that reports what it was started with. That is how what the check
 * moved aside is read, and where the core's derivation of its runtime is held
 * to the tree the check ran from.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { workerImageFaultStatuses } from "@chuggy/worker-contract/workerEnvironment";

import {
  workerImageSteeringVariables,
  workerImageVariable,
  workerStageEnvironment,
} from "./checks.mjs";
import { posixShells } from "./shells.fixture.mjs";

/** What the check exits with where the fault is not the image's: its own usage, and a runtime that is not whole. */
const usageStatus = 2;
const runtimeBrokenStatus = 1;

/** The longest one run of the check may take, which only a hung stub reaches. */
const checkRunMsMax = 30_000;

/** What a loader writes for a node built against a newer glibc than the image's. */
const nodeGlibcOld =
  "/opt/chuggy/bin/node: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.28' not found (required by /opt/chuggy/bin/node)";

/** What a loader writes for a node whose C++ runtime the image lacks. */
const nodeLibstdcxxAbsent =
  "/opt/chuggy/bin/node: error while loading shared libraries: libstdc++.so.6: cannot open shared object file: No such file or directory";

/** What a loader writes for a claude built against a newer glibc than the image's. */
const claudeGlibcOld =
  "/opt/chuggy/bin/claude: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.25' not found (required by /opt/chuggy/bin/claude)";

/** `text` as one shell word, whatever quotes it holds. */
function shellWord(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The text of a stub binary: one that answers, one that fails as a loader does, and one no image can start. */
const stub = {
  answers: (line) => `#!/bin/sh\nprintf '%s\\n' ${shellWord(line)}\n`,
  fails: (line, status) =>
    `#!/bin/sh\nprintf '%s\\n' ${shellWord(line)} >&2\nexit ${String(status)}\n`,
  interpreterAbsent: "#!/lib/ld-chuggy-suite-absent.so.1\n",
};

/** The core a passing check starts: it reports its environment, its argv and where it finds its runtime. */
const startedCore = `import { coreRuntime } from "./coreRuntime.mjs";
process.stdout.write(JSON.stringify({ environment: process.env, argv: process.argv.slice(1), coreRuntime }));
`;

/** A file that runs, written where nothing stands yet. */
async function checkExecutable(path, text) {
  await writeFile(path, text, { flag: "wx", mode: 0o755 });
}

/**
 * A runtime tree as a site mounts it, with the image's PATH, HOME, workspace
 * and temporary directory beside it. `node` is this suite's own unless a stub is named;
 * `claude` and `git` answer unless a stub is named, and are absent where named
 * `null`.
 */
async function checkTree(t, binaries = {}) {
  const root = await mkdtemp(join(tmpdir(), "chuggy-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "runtime");
  const core = join(runtime, "lib", "chuggy");
  const tree = {
    root,
    runtime,
    check: join(runtime, "check.sh"),
    path: join(root, "path"),
    home: join(root, "home"),
    workspace: join(root, "workspace"),
    temporary: join(root, "temporary"),
  };
  for (const directory of [join(runtime, "bin"), core, tree.path])
    await mkdir(directory, { recursive: true });
  await mkdir(tree.home);
  await mkdir(tree.workspace);
  await mkdir(tree.temporary);
  const here = (name) => fileURLToPath(new URL(name, import.meta.url));
  await copyFile(here("check.sh"), tree.check);
  await copyFile(here("coreRuntime.mjs"), join(core, "coreRuntime.mjs"));
  await writeFile(join(core, "worker.mjs"), startedCore);
  const {
    node,
    claude = stub.answers("2.1.300 (Claude Code)"),
    git = stub.answers("git version 2.47.3"),
  } = binaries;
  if (node === undefined)
    await symlink(process.execPath, join(runtime, "bin", "node"));
  else await checkExecutable(join(runtime, "bin", "node"), node);
  if (claude !== null)
    await checkExecutable(join(runtime, "bin", "claude"), claude);
  if (git !== null) await checkExecutable(join(tree.path, "git"), git);
  return tree;
}

/**
 * The check run under `shell` as a job container runs it, in an environment
 * of the tree's PATH, HOME, workspace and temporary directory and
 * `environment` over them, where a
 * variable named `undefined` is unset.
 */
function checked(shell, tree, environment = {}, args = []) {
  const variables = { ...checkBase(tree), ...environment };
  const ran = spawnSync(
    shell.argv[0],
    [...shell.argv.slice(1), tree.check, ...args],
    {
      env: Object.fromEntries(
        Object.entries(variables).filter(([, value]) => value !== undefined),
      ),
      encoding: "utf8",
      timeout: checkRunMsMax,
    },
  );
  const lines = ran.stderr.trimEnd().split("\n");
  return { ...ran, line: lines.at(-1) };
}

/** Whether `path` is a directory this user can make an entry in. */
function checkWritable(path) {
  try {
    accessSync(path, constants.W_OK | constants.X_OK);
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Why a case is skipped where uid 0 writes and searches a directory whatever its mode. */
const checkRootWrites =
  process.getuid?.() === 0
    ? "uid 0 writes and searches a directory whatever its mode"
    : false;

/** The line naming a directory this user cannot write. */
const unwritable = (label, path) =>
  `chuggy: ${label}, ${path}, is not a directory this user can write`;

/**
 * Each fault an image can have, the tree and environment that reproduce it,
 * the fault the check names it by, and its line. `loader` is what the failing
 * binary wrote, which reaches the container's log ahead of the check's line.
 * `readOnly` names a directory of the tree left unwritable, and `unsearchable`
 * one left writable but not searchable.
 */
const imageFaults = [
  {
    name: "a node the image's glibc is too old for",
    binaries: { node: stub.fails(nodeGlibcOld, 1) },
    fault: "ImageLibcUnsupported",
    line: () =>
      "chuggy: this image cannot load chuggy's node, which needs the image's glibc and libstdc++",
    loader: nodeGlibcOld,
  },
  {
    name: "a node whose libstdc++ the image lacks",
    binaries: { node: stub.fails(nodeLibstdcxxAbsent, 127) },
    fault: "ImageLibcUnsupported",
    line: () =>
      "chuggy: this image cannot load chuggy's node, which needs the image's glibc and libstdc++",
    loader: nodeLibstdcxxAbsent,
  },
  {
    name: "a node whose loader the image does not have",
    binaries: { node: stub.interpreterAbsent },
    fault: "ImageLibcUnsupported",
    line: () =>
      "chuggy: this image cannot load chuggy's node, which needs the image's glibc and libstdc++",
  },
  {
    name: "a claude the image's glibc is too old for",
    binaries: { claude: stub.fails(claudeGlibcOld, 1) },
    fault: "ImageLibcUnsupported",
    line: () =>
      "chuggy: this image cannot load chuggy's claude, which needs the image's glibc",
    loader: claudeGlibcOld,
  },
  {
    name: "a claude whose loader the image does not have",
    binaries: { claude: stub.interpreterAbsent },
    fault: "ImageLibcUnsupported",
    line: () =>
      "chuggy: this image cannot load chuggy's claude, which needs the image's glibc",
  },
  {
    name: "no git on PATH",
    binaries: { git: null },
    fault: "ImageLacksGit",
    line: () => "chuggy: this image has no git on PATH",
  },
  {
    name: "a git that does not run",
    binaries: {
      git: stub.fails(
        "git: error while loading shared libraries: libpcre2-8.so.0: cannot open shared object file: No such file or directory",
        127,
      ),
    },
    fault: "ImageLacksGit",
    line: () => "chuggy: this image's git does not run",
  },
  {
    name: "no HOME",
    environment: () => ({ HOME: undefined }),
    fault: "ImageHomeUnwritable",
    line: () => "chuggy: this image sets no HOME",
  },
  {
    name: "a HOME that does not exist",
    environment: (tree) => ({ HOME: join(tree.root, "absent") }),
    fault: "ImageHomeUnwritable",
    line: (tree) => unwritable("HOME", join(tree.root, "absent")),
  },
  {
    name: "a HOME that is a file",
    environment: (tree) => ({ HOME: tree.check }),
    fault: "ImageHomeUnwritable",
    line: (tree) => unwritable("HOME", tree.check),
  },
  {
    name: "a HOME this user cannot write",
    readOnly: "home",
    fault: "ImageHomeUnwritable",
    line: (tree) => unwritable("HOME", tree.home),
  },
  {
    name: "a HOME this user can write but not search",
    unsearchable: "home",
    fault: "ImageHomeUnwritable",
    line: (tree) => unwritable("HOME", tree.home),
  },
  {
    name: "a workspace that does not exist",
    environment: (tree) => ({
      CHUG_WORKER_WORKSPACE: join(tree.root, "absent"),
    }),
    fault: "ImageWorkspaceUnwritable",
    line: (tree) => unwritable("the workspace", join(tree.root, "absent")),
  },
  {
    name: "a workspace this user cannot write",
    readOnly: "workspace",
    fault: "ImageWorkspaceUnwritable",
    line: (tree) => unwritable("the workspace", tree.workspace),
  },
  {
    name: "a workspace this user can write but not search",
    unsearchable: "workspace",
    fault: "ImageWorkspaceUnwritable",
    line: (tree) => unwritable("the workspace", tree.workspace),
  },
  {
    name: "a temporary directory that does not exist",
    environment: (tree) => ({ TMPDIR: join(tree.root, "absent") }),
    fault: "ImageTmpUnwritable",
    line: (tree) =>
      unwritable("the temporary directory", join(tree.root, "absent")),
  },
  {
    name: "a temporary directory this user cannot write",
    readOnly: "temporary",
    fault: "ImageTmpUnwritable",
    line: (tree) => unwritable("the temporary directory", tree.temporary),
  },
  {
    name: "a temporary directory this user can write but not search",
    unsearchable: "temporary",
    fault: "ImageTmpUnwritable",
    line: (tree) => unwritable("the temporary directory", tree.temporary),
  },
  {
    name: "an image lacking everything, named by its node",
    binaries: {
      node: stub.interpreterAbsent,
      claude: stub.interpreterAbsent,
      git: null,
    },
    environment: (tree) => ({
      HOME: undefined,
      CHUG_WORKER_WORKSPACE: join(tree.root, "absent"),
      TMPDIR: join(tree.root, "absent"),
    }),
    fault: "ImageLibcUnsupported",
    line: () =>
      "chuggy: this image cannot load chuggy's node, which needs the image's glibc and libstdc++",
  },
  {
    name: "an image whose binaries load and that lacks the rest, named by its git",
    binaries: { git: null },
    environment: (tree) => ({
      HOME: undefined,
      CHUG_WORKER_WORKSPACE: join(tree.root, "absent"),
    }),
    fault: "ImageLacksGit",
    line: () => "chuggy: this image has no git on PATH",
  },
  {
    name: "an image lacking a workspace and a temporary directory, named by its workspace",
    environment: (tree) => ({
      CHUG_WORKER_WORKSPACE: join(tree.root, "absent"),
      TMPDIR: join(tree.root, "absent"),
    }),
    fault: "ImageWorkspaceUnwritable",
    line: (tree) => unwritable("the workspace", join(tree.root, "absent")),
  },
  {
    name: "an image with git that lacks a HOME and a workspace, named by its HOME",
    environment: (tree) => ({
      HOME: join(tree.root, "absent"),
      CHUG_WORKER_WORKSPACE: join(tree.root, "absent"),
    }),
    fault: "ImageHomeUnwritable",
    line: (tree) => unwritable("HOME", join(tree.root, "absent")),
  },
];

/** One fault, reproduced under `shell` and checked for its status, its line and the loader's words before it. */
async function checkFault(t, shell, fault) {
  const tree = await checkTree(t, fault.binaries);
  if (fault.readOnly !== undefined) await chmod(tree[fault.readOnly], 0o555);
  if (fault.unsearchable !== undefined)
    await chmod(tree[fault.unsearchable], 0o666);
  for (const args of [[], ["check"]]) {
    const ran = checked(shell, tree, fault.environment?.(tree), args);

    assert.equal(ran.status, workerImageFaultStatuses[fault.fault], ran.stderr);
    assert.equal(ran.line, fault.line(tree), ran.stderr);
    assert.equal(ran.stdout, "", "the core started on an image with a fault");
    if (fault.loader !== undefined)
      assert.ok(ran.stderr.includes(fault.loader), ran.stderr);
  }
}

/** The variables an image sets that the check leaves standing, beside those it moves. */
const imageStanding = {
  CHUG_SUITE_IMAGE_VARIABLE: "the image's own",
  NODE_EXTRA_CA_CERTS: "/image/certificates.pem",
  LD_BIND_NOW: "1",
};

/**
 * An image setting every variable the check moves aside: one empty, one to
 * what a shell would change were the value parsed again rather than copied,
 * and `NODE_OPTIONS` to what would stop this suite's node where it reached
 * it. The loader's own complaints are no evidence either way, since the
 * image's shell is started with them before the check can move anything.
 */
function imageSteering() {
  return {
    ...Object.fromEntries(
      workerImageSteeringVariables.map((name) => [name, `/image/${name}.so`]),
    ),
    NODE_OPTIONS: "--require /image/absent-preload.cjs",
    NODE_PATH: "",
    LD_LIBRARY_PATH:
      '/image/it\'s "lib" $(echo substituted) `echo ticked` back\\slash\nembedded\n',
  };
}

/** The variables a shell adds of its own to what it execs. */
const shellOwnVariables = ["PWD", "SHLVL", "OLDPWD", "_"];

/** What the stub core reported it was started with, less what the shell added of its own. */
function checkStarted(ran) {
  const started = JSON.parse(ran.stdout);
  for (const name of shellOwnVariables) delete started.environment[name];
  return started;
}

/** What every run of a tree is handed beside what a case sets. */
function checkBase(tree) {
  return {
    PATH: tree.path,
    HOME: tree.home,
    CHUG_WORKER_WORKSPACE: tree.workspace,
    TMPDIR: tree.temporary,
  };
}

/**
 * Catches the check starting the core with what would steer it, moving what
 * it should leave, or keeping a value a stage's shells are not handed back.
 */
async function checkStartsCore(t, shell) {
  const tree = await checkTree(t);
  const image = imageSteering();
  const ran = checked(shell, tree, { ...imageStanding, ...image });

  assert.equal(ran.status, 0, ran.stderr);
  const started = checkStarted(ran);
  const kept = Object.fromEntries(
    Object.entries(image).map(([name, value]) => [
      workerImageVariable(name),
      value,
    ]),
  );
  assert.deepEqual(started.environment, {
    ...checkBase(tree),
    ...imageStanding,
    ...kept,
  });
  assert.deepEqual(
    workerStageEnvironment(started.environment),
    { ...checkBase(tree), ...imageStanding, ...image },
    "a stage's shells are not handed back what the image set",
  );
  return { tree, started };
}

/** Catches the core finding a runtime other than the one the check probed and started it from. */
function checkSameRuntime(tree, started) {
  assert.deepEqual(started.argv, [
    join(tree.runtime, "lib", "chuggy", "worker.mjs"),
  ]);
  assert.deepEqual(started.coreRuntime, {
    askpass: join(tree.runtime, "lib", "chuggy", "git-askpass.sh"),
    claude: join(tree.runtime, "bin", "claude"),
    codex: join(tree.runtime, "bin", "codex"),
    certificates: join(tree.runtime, "share", "ca-certificates.crt"),
  });
}

/** What one runtime that is not whole says, which names the binary it lacks and blames no image. */
async function checkRuntimeBroken(t, shell, tree, binary) {
  const ran = checked(shell, tree, {}, ["check"]);

  assert.equal(ran.status, runtimeBrokenStatus, ran.stderr);
  assert.equal(
    ran.line,
    `chuggy: the runtime at ${tree.runtime} holds no ${binary} this container can execute`,
  );
}

/** What every name `check.sh` assigns starts with. */
const checkOwnPrefix = "chuggy_check_";

/** The names `check.sh` assigns, each one only it would set. */
const checkOwnNames = [
  "chuggy_check_binary",
  "chuggy_check_name",
  "chuggy_check_runtime",
  "chuggy_check_start",
  "chuggy_check_temporary",
  "chuggy_check_workspace",
];

/**
 * Every name `check.sh` assigns, read from the script, comments aside: each
 * assignment, one in a string an `eval` runs among them, each `${name:=}`, and
 * each loop's variable.
 */
function checkAssignedNames() {
  const code = readFileSync(
    fileURLToPath(new URL("check.sh", import.meta.url)),
    "utf8",
  )
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const named = (pattern) =>
    [...code.matchAll(pattern)].map(([, name]) => name);
  return [
    ...new Set([
      ...named(/(?:^|[\s;()"'])([A-Za-z_]\w*)=/gmu),
      ...named(/\$\{([A-Za-z_]\w*):?=/gu),
      ...named(/\bfor\s+([A-Za-z_]\w*)\s+in\b/gu),
    ]),
  ].sort();
}

/** Every case run under each shell, beside one per image fault. */
const checkCases = [
  {
    name: "an image that can run a job starts the core, unsteered",
    run: async (t, shell) => {
      const { tree, started } = await checkStartsCore(t, shell);
      checkSameRuntime(tree, started);
    },
  },
  {
    name: "a value kept under the check's name for one the image did not set is dropped",
    run: async (t, shell) => {
      const tree = await checkTree(t);
      const stale = Object.fromEntries(
        workerImageSteeringVariables.map((name) => [
          workerImageVariable(name),
          "kept by nothing",
        ]),
      );
      const ran = checked(shell, tree, stale);

      assert.equal(ran.status, 0, ran.stderr);
      assert.deepEqual(checkStarted(ran).environment, checkBase(tree));
    },
  },
  {
    name: "an image's variables under the plain names of the check's own reach the core as the image set them",
    run: async (t, shell) => {
      const tree = await checkTree(t);
      const image = Object.fromEntries(
        checkOwnNames.map((name) => {
          const plain = name.slice(checkOwnPrefix.length);
          return [plain, `the image's own ${plain}`];
        }),
      );
      const ran = checked(shell, tree, image);

      assert.equal(ran.status, 0, ran.stderr);
      assert.deepEqual(checkStarted(ran).environment, {
        ...checkBase(tree),
        ...image,
      });
    },
  },
  {
    name: "the check mode passes an image that can run a job and starts nothing",
    run: async (t, shell) => {
      const ran = checked(shell, await checkTree(t), {}, ["check"]);

      assert.equal(ran.status, 0, ran.stderr);
      assert.equal(ran.stdout, "chuggy: this image can run a job\n");
      assert.equal(ran.stderr, "");
    },
  },
  ...imageFaults.map((fault) => ({
    name: fault.name,
    skip:
      (fault.readOnly !== undefined || fault.unsearchable !== undefined) &&
      checkRootWrites,
    run: (t, shell) => checkFault(t, shell, fault),
  })),
  {
    name: "an unnamed workspace is the one a pool's envelope names",
    run: async (t, shell) => {
      const tree = await checkTree(t);
      const ran = checked(shell, tree, { CHUG_WORKER_WORKSPACE: undefined }, [
        "check",
      ]);

      if (checkWritable("/workspace")) assert.equal(ran.status, 0, ran.stderr);
      else {
        assert.equal(
          ran.status,
          workerImageFaultStatuses.ImageWorkspaceUnwritable,
        );
        assert.equal(ran.line, unwritable("the workspace", "/workspace"));
      }
    },
  },
  {
    name: "an unnamed or empty TMPDIR names /tmp",
    run: async (t, shell) => {
      const tree = await checkTree(t);
      for (const TMPDIR of [undefined, ""]) {
        const ran = checked(shell, tree, { TMPDIR }, ["check"]);

        if (checkWritable("/tmp")) assert.equal(ran.status, 0, ran.stderr);
        else {
          assert.equal(ran.status, workerImageFaultStatuses.ImageTmpUnwritable);
          assert.equal(ran.line, unwritable("the temporary directory", "/tmp"));
        }
      }
    },
  },
  {
    name: "a runtime without its claude is no fault of the image's",
    run: async (t, shell) =>
      checkRuntimeBroken(
        t,
        shell,
        await checkTree(t, { claude: null }),
        "claude",
      ),
  },
  {
    name: "a runtime whose node cannot be executed is no fault of the image's",
    run: async (t, shell) => {
      const tree = await checkTree(t, { node: stub.answers("v24.0.0") });
      await chmod(join(tree.runtime, "bin", "node"), 0o644);
      await checkRuntimeBroken(t, shell, tree, "node");
    },
  },
  {
    name: "an argument but the check mode is refused before anything runs",
    run: async (t, shell) => {
      const tree = await checkTree(t);
      for (const args of [["chek"], ["check", "check"]]) {
        const ran = checked(shell, tree, {}, args);

        assert.equal(ran.status, usageStatus, ran.stderr);
        assert.equal(ran.line, `usage: /bin/sh ${tree.check} [check]`);
        assert.equal(ran.stdout, "");
      }
    },
  },
];

for (const shell of posixShells)
  test(`check.sh under ${shell.name}`, { skip: shell.absent }, async (t) => {
    for (const { name, skip, run } of checkCases)
      await t.test(name, { skip }, (t) => run(t, shell));
  });

/**
 * Catches a name the check assigns that an image may have exported, which
 * the check would overwrite in place and the core would inherit overwritten.
 */
test("every name check.sh assigns is its own", () => {
  assert.deepEqual(checkAssignedNames(), checkOwnNames);
  for (const name of checkOwnNames)
    assert.ok(name.startsWith(checkOwnPrefix), name);
});

/** Catches a status that is a fault's and is also what the check exits with for something that is not the image's. */
test("no status the check exits with for itself is a fault's", () => {
  const statuses = Object.values(workerImageFaultStatuses);

  assert.equal(new Set(statuses).size, statuses.length);
  assert.ok(!statuses.includes(usageStatus));
  assert.ok(!statuses.includes(runtimeBrokenStatus));
});

/** Catches a fault the contract says the check tells by its status that no case has the check find. */
test("every fault the contract gives a status has the check find it", () => {
  assert.deepEqual(
    [...new Set(imageFaults.map(({ fault }) => fault))].sort(),
    Object.keys(workerImageFaultStatuses).sort(),
  );
});
