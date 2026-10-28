import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import {
  author,
  git,
  handedAsTheImage,
  headOf,
  inCheckout,
  recordingGit,
  remoteRefs,
} from "./checkout.fixture.mjs";
import { workerGitVariable } from "./checks.mjs";
import { forgeServed } from "./gitForge.fixture.mjs";
import { gitRemotePauseMs, gitRemoteTriesMax } from "./gitRemote.mjs";
import { workerCredentialEnvironment } from "./repository.mjs";
import {
  RunStepFailure,
  runCommitFailed,
  runPushFailed,
} from "./runEvidence.mjs";
import {
  commitAndPushSource,
  resultDocument,
  sourcePushPlacingVariables,
  sourceSecretReader,
  ticketBranch,
} from "./source.mjs";

/** Two secrets a pod holds, as its push is handed them. */
const held = [
  {
    kind: "the Claude Code credential",
    value: "sk-ant-oat01-0123456789abcdefghijklmnop",
  },
  {
    kind: "the git credential the plane minted",
    value: "ghs_0123456789abcdefghijklmnopqrstuvwxyz",
  },
];

/** The commit a stand-in git names, as git prints a commit's name. */
const stubbedCommit = "abc123".padEnd(40, "0");

/** The verb of one git call, past any `-c` entries before it. */
function gitVerb(args) {
  return args.find((arg, index) => arg !== "-c" && args[index - 1] !== "-c");
}

/**
 * A stand-in git that records each call in `calls` and answers it as
 * `answer` does where `answer` answers anything; otherwise `rev-parse` with a
 * workspace's object directory where it asks for one and `stubbedCommit`
 * where it does not, `init` as git itself does, since the push is made from
 * the repository it makes, and anything else with nothing.
 */
function stubbedGit(calls, answer = async () => undefined) {
  return async (executable, args, options) => {
    calls.push({ executable, args, options });
    const answered = await answer(args, options);
    if (answered !== undefined) return answered;
    if (gitVerb(args) === "init")
      return git(executable, args, {
        ...options,
        env: { PATH: process.env.PATH ?? "", ...options.env },
      });
    if (args.includes("--git-path")) return { stdout: ".git/objects\n" };
    return gitVerb(args) === "rev-parse"
      ? { stdout: `${stubbedCommit}\n` }
      : { stdout: "" };
  };
}

/**
 * Clears `process.env` of every variable git reads configuration entries
 * from until `t` ends, so a suite run as a job, whose worker hands it entries
 * of its own, reads and spawns git as a pod whose image names none.
 */
function withoutStandingGitEntries(t) {
  const standing = Object.entries(process.env).filter(([name]) =>
    workerGitVariable(name),
  );
  for (const [name] of standing) delete process.env[name];
  t.after(() => {
    Object.assign(process.env, Object.fromEntries(standing));
  });
}

/** The one call of `verb` among `calls`. */
function callOf(calls, verb) {
  const found = calls.filter(({ args }) => gitVerb(args) === verb);
  assert.equal(
    found.length,
    1,
    `git ${verb} ran ${String(found.length)} times`,
  );
  return found[0];
}

/** Whether `path` is `directory` or anywhere under it. */
function within(directory, path) {
  const way = relative(directory, path);
  return way === "" || (way !== ".." && !way.startsWith(`..${sep}`));
}

/** Whether anything is at `path`. */
async function present(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** One attempt published through `command`, a stand-in git, from `/workspace/repository`, holding no secret. */
function stubPublished(command, more = {}) {
  return commitAndPushSource({
    task: { ticket: 7, attempt: "opaque", worker: {} },
    repositoryId: "chuggy",
    repository: "http://git/rig.git",
    base: "base123",
    directory: "/workspace/repository",
    command,
    environment: { GIT_ASKPASS: "askpass" },
    secrets: [],
    ...more,
  });
}

test("ticket branch is deterministic, bounded, and names the ticket", () => {
  assert.equal(
    ticketBranch({ ticket: 42, attempt: "attempt-identity" }),
    "refs/heads/chuggy/tickets/42/attempts/" +
      "9a33b56cbbac4db829e4917c5ac9369958062635f18534cfc26b48071229a39f",
  );
});

/** What the directory a push is made from holds as the push runs: the alternates of its repository, its hooks directory, its global configuration and its home. */
async function pushPlaceHolding({ cwd, env }) {
  return {
    alternates: await readFile(
      join(env.GIT_DIR, "objects", "info", "alternates"),
      "utf8",
    ),
    hooks: await readdir(join(cwd, "hooks")),
    global: await readFile(env.GIT_CONFIG_GLOBAL, "utf8"),
    home: await readdir(env.HOME),
  };
}

/**
 * Catches a push made from the workspace, or from a repository of the core's
 * that holds a hook, borrows no objects or outlives the push; a push that
 * reads a configuration file it was not handed, a home that holds one, or any
 * helper; and a push
 * whose URL or refspec is anything but the attempt's.
 */
test("source publication commits all changes and pushes a new attempt ref from a repository of its own", async () => {
  const calls = [];
  let seen;
  const command = stubbedGit(calls, async (args, options) => {
    if (gitVerb(args) !== "push") return undefined;
    seen = await pushPlaceHolding(options);
    return { stdout: "" };
  });
  const source = await stubPublished(command, {
    task: {
      ticket: 7,
      attempt: "opaque",
      worker: { files: [{ path: ".claude/settings.json" }] },
    },
  });

  assert.deepEqual(source, {
    repository: "chuggy",
    ref: ticketBranch({ ticket: 7, attempt: "opaque" }),
    commit: stubbedCommit,
    base: "base123",
  });
  const push = calls.at(-1);
  const made = push.options.cwd;
  assert.ok(!within("/workspace/repository", made), made);
  assert.deepEqual(push.args, [
    "-c",
    `core.hooksPath=${join(made, "hooks")}`,
    "-c",
    "credential.helper=",
    "push",
    "http://git/rig.git",
    `${stubbedCommit}:${source.ref}`,
  ]);
  assert.deepEqual(push.options.env, {
    GIT_ASKPASS: "askpass",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(made, "configuration"),
    HOME: join(made, "home"),
    XDG_CONFIG_HOME: join(made, "home"),
    GIT_DIR: join(made, "repository"),
    GIT_DEFAULT_HASH: "sha1",
  });
  assert.deepEqual(callOf(calls, "init").args, [
    "init",
    "--quiet",
    "--bare",
    "--template=",
  ]);
  assert.deepEqual(seen, {
    alternates: "/workspace/repository/.git/objects\n",
    hooks: [],
    global: "",
    home: [],
  });
  assert.equal(await present(made), false, "the push's repository outlived it");
  assert.ok(calls.some(({ args }) => args[0] === "add" && args[1] === "--all"));
  assert.ok(
    calls.some(
      ({ args }) =>
        args[0] === "reset" && args.at(-1) === ".claude/settings.json",
    ),
  );
  assert.ok(
    calls.some(
      ({ args }) => args[0] === "commit" && args.includes("--allow-empty"),
    ),
  );
});

/**
 * Catches a variable that places a repository reaching the push, which would
 * have it made from the repository the variable names rather than the core's.
 */
test("the push is handed no variable that places a repository, whatever the pod holds", async () => {
  const calls = [];
  const placing = Object.fromEntries(
    sourcePushPlacingVariables.map((name) => [name, `/pod/${name}`]),
  );

  await stubPublished(stubbedGit(calls), {
    environment: { ...placing, GIT_ASKPASS: "askpass" },
  });

  const push = callOf(calls, "push").options;
  for (const name of sourcePushPlacingVariables)
    assert.ok(
      !Object.values(push.env).includes(`/pod/${name}`),
      `${name} reached the push`,
    );
  assert.equal(push.env.GIT_DIR, join(push.cwd, "repository"));
});

/**
 * Catches a variable that places a repository left off the list the push is
 * cleared of, where the git this suite runs names it.
 */
test("the push is cleared of every variable git names local to a repository but the two carrying configuration entries", async () => {
  const { stdout } = await git("git", ["rev-parse", "--local-env-vars"]);
  const named = stdout.split("\n").filter((name) => name.length > 0);

  assert.deepEqual(
    named.filter((name) => !sourcePushPlacingVariables.includes(name)).sort(),
    ["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"],
  );
});

test("a push that can take a fresh credential takes one once its repository is made, and uses it", async () => {
  const calls = [];
  let refreshes = 0;

  await stubPublished(stubbedGit(calls), {
    environment: {
      GIT_ASKPASS: "askpass",
      CHUG_WORKER_GIT_CREDENTIAL_FILE: "/tmp/earlier",
    },
    refresh: async () => {
      assert.equal(
        gitVerb(calls.at(-1).args),
        "init",
        "the credential is taken before everything the push needs but the push",
      );
      refreshes += 1;
      return {
        GIT_ASKPASS: "askpass",
        CHUG_WORKER_GIT_CREDENTIAL_FILE: "/tmp/later",
      };
    },
  });

  assert.equal(refreshes, 1);
  assert.equal(gitVerb(calls.at(-1).args), "push");
  assert.equal(
    calls.at(-1).options.env.CHUG_WORKER_GIT_CREDENTIAL_FILE,
    "/tmp/later",
  );
});

/** The `[key, value]` entries `environment` hands git, in the order git reads them. */
function gitEntries(environment) {
  return Array.from(
    { length: Number(environment.GIT_CONFIG_COUNT ?? "0") },
    (_, index) => [
      environment[`GIT_CONFIG_KEY_${String(index)}`],
      environment[`GIT_CONFIG_VALUE_${String(index)}`],
    ],
  );
}

/**
 * Catches the push handed the attempt's reads, which it reaches no other
 * repository with, or the entries the image's environment names dropped from
 * it; and the commit's hooks handed anything less than the reads.
 */
test("the commit is handed the attempt's git, and the push only what the image's environment names", async (t) => {
  withoutStandingGitEntries(t);
  const calls = [];
  const reads = [
    ["credential.http://git.helper", ""],
    ["credential.http://git.helper", "cache --socket '/minted/reads.sock'"],
  ];
  const image = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: "X-Image: kept",
  };

  await stubPublished(stubbedGit(calls), {
    environment: {},
    git: reads,
    refresh: async () => ({ GIT_ASKPASS: "askpass", ...image }),
  });

  assert.deepEqual(gitEntries(callOf(calls, "push").options.env), [
    ["http.extraHeader", "X-Image: kept"],
  ]);
  assert.deepEqual(gitEntries(callOf(calls, "commit").options.env), reads);
});

/** A git child that failed, writing `stderr`, as `execFile` rejects with it. */
function gitFailed(stderr) {
  return Object.assign(new Error(`Command failed: git\n${stderr}`), {
    code: 1,
    stderr,
  });
}

/**
 * One attempt published through a stand-in git whose pushes fail in turn as
 * `pushes` says and then succeed, and whose commit throws `commit` where it is
 * given: what the attempt declared or threw, how many times it pushed, how
 * many times it took a credential, each pause between pushes, each directory
 * a push was made from, the directory the repository it pushes from was made
 * in, and whether that directory is still there.
 */
async function pushedThrough(
  pushes,
  { commit, refresh = async () => ({ GIT_ASKPASS: "askpass" }) } = {},
) {
  let pushed = 0;
  let refreshes = 0;
  const pauses = [];
  const from = [];
  const calls = [];
  const command = stubbedGit(calls, async (args, options) => {
    if (gitVerb(args) === "commit" && commit !== undefined) throw commit;
    if (gitVerb(args) !== "push") return undefined;
    pushed += 1;
    from.push(options.cwd);
    if (pushes[pushed - 1] !== undefined) throw pushes[pushed - 1];
    return { stdout: "" };
  });
  const outcome = await stubPublished(command, {
    environment: {},
    refresh: () => {
      refreshes += 1;
      return refresh();
    },
    pause: async (ms) => {
      pauses.push(ms);
    },
  }).catch((failure) => failure);
  const made = calls.find(({ args }) => gitVerb(args) === "init")?.options.cwd;
  const left = made !== undefined && (await present(made));
  return { outcome, pushed, refreshes, pauses, from, made, left };
}

/** A server error a push is tried again after. */
const serverError = gitFailed(
  "fatal: unable to access 'http://git/rig.git/': The requested URL returned error: 502\n",
);

test("a push the forge failed with a server error is tried again under the one credential from the one repository, and lands", async () => {
  const { outcome, pushed, refreshes, pauses, from, made, left } =
    await pushedThrough([serverError]);

  assert.equal(outcome.commit, stubbedCommit);
  assert.equal(pushed, 2);
  assert.equal(refreshes, 1);
  assert.deepEqual(pauses, [gitRemotePauseMs]);
  assert.deepEqual(from, [made, made]);
  assert.equal(left, false, "the push's repository outlived it");
});

/** GitHub's answer to a credential minted moments before, as git reports it. */
const notFound = gitFailed(
  "remote: Repository not found.\nfatal: repository 'http://git/rig.git/' not found\n",
);

test("a push the forge answered not found is tried again under the one credential from the one repository, and lands", async () => {
  const { outcome, pushed, refreshes, pauses, from, made } =
    await pushedThrough([notFound]);

  assert.equal(outcome.commit, stubbedCommit);
  assert.equal(pushed, 2);
  assert.equal(refreshes, 1);
  assert.deepEqual(pauses, [gitRemotePauseMs]);
  assert.deepEqual(from, [made, made]);
});

test("a push the forge never finds the repository for fails the push step once every try is spent, led by git's own line", async () => {
  const { outcome, pushed, left } = await pushedThrough(
    Array.from({ length: gitRemoteTriesMax + 1 }, () => notFound),
  );

  assert.ok(outcome instanceof RunStepFailure);
  assert.equal(outcome.evidence, runPushFailed);
  assert.equal(
    outcome.message.split("\n")[0],
    "fatal: repository 'http://git/rig.git/' not found",
  );
  assert.equal(outcome.cause, notFound);
  assert.equal(pushed, gitRemoteTriesMax);
  assert.equal(left, false, "the push's repository outlived it");
});

test("a push failing every try fails the push step and leaves no repository of its own behind", async () => {
  const { outcome, pushed, made, left } = await pushedThrough(
    Array.from({ length: 8 }, () => serverError),
  );

  assert.equal(outcome.evidence, runPushFailed);
  assert.ok(pushed > 1);
  assert.notEqual(made, undefined);
  assert.equal(left, false, "the push's repository outlived it");
});

/**
 * Catches a directory made under a relative `TMPDIR` and named to git as it
 * was made: the push runs from inside it, so every path git is handed under it
 * would be read against itself.
 */
test("a push made under a relative temporary directory lands and leaves nothing behind", async () => {
  const room = await mkdtemp(join(tmpdir(), "chuggy-push-relative-"));
  const held = { cwd: process.cwd(), TMPDIR: process.env.TMPDIR };
  try {
    await mkdir(join(room, "temporary"));
    process.chdir(room);
    process.env.TMPDIR = "temporary";
    const calls = [];
    const outcome = await stubPublished(stubbedGit(calls)).catch(
      (failure) => failure,
    );

    assert.ok(!(outcome instanceof Error), String(outcome.message));
    const made = callOf(calls, "push").options.cwd;
    assert.ok(made.startsWith(join(room, "temporary", sep)), made);
    assert.deepEqual(await readdir(join(room, "temporary")), []);
  } finally {
    process.chdir(held.cwd);
    if (held.TMPDIR === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = held.TMPDIR;
    await rm(room, { recursive: true, force: true });
  }
});

/**
 * Catches a removal whose failure is raised over how the push ended: a push
 * that landed would be reported failed.
 */
test("a push whose repository cannot be removed still reports that it landed", async () => {
  let locked;
  const calls = [];
  const command = stubbedGit(calls, async (args, options) => {
    if (gitVerb(args) !== "push") return undefined;
    locked = join(options.cwd, "locked");
    await mkdir(join(locked, "inside"), { recursive: true });
    await chmod(locked, 0o500);
    return { stdout: "" };
  });
  const written = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => written.push(String(chunk));
  try {
    const outcome = await stubPublished(command).catch((failure) => failure);

    assert.ok(!(outcome instanceof Error), String(outcome.message));
    assert.equal(outcome.commit, stubbedCommit);
    assert.ok(
      written.some((line) =>
        line.startsWith(
          `the push's repository ${dirname(locked)} could not be removed: `,
        ),
      ),
      written.join(""),
    );
  } finally {
    process.stderr.write = write;
    await chmod(locked, 0o700);
    await rm(dirname(locked), { recursive: true, force: true });
  }
});

test("a push the forge refuses is tried once and fails the push step, led by why", async () => {
  for (const [stderr, why] of [
    [
      "remote: Permission to rig.git denied to bot.\nfatal: unable to access 'http://git/rig.git/': The requested URL returned error: 403\n",
      "fatal: unable to access 'http://git/rig.git/': The requested URL returned error: 403",
    ],
    [
      "remote: error: GH006: Protected branch update failed for refs/heads/chuggy.\n ! [remote rejected] abc123 -> chuggy (protected branch hook declined)\nerror: failed to push some refs to 'http://git/rig.git'\n",
      "remote: error: GH006: Protected branch update failed for refs/heads/chuggy.",
    ],
  ]) {
    const { outcome, pushed, left } = await pushedThrough([gitFailed(stderr)]);

    assert.ok(outcome instanceof RunStepFailure, why);
    assert.equal(outcome.evidence, runPushFailed, why);
    assert.equal(outcome.message.split("\n")[0], why);
    assert.ok(outcome.message.includes(stderr), why);
    assert.equal(pushed, 1, why);
    assert.equal(left, false, why);
  }
});

test("a push that cannot take its credential fails the push step, pushes nothing and leaves no repository of its own behind", async () => {
  const { outcome, pushed, made, left } = await pushedThrough([], {
    refresh: async () => {
      throw new Error("the worker plane answered 503 for a credential");
    },
  });

  assert.equal(outcome.evidence, runPushFailed);
  assert.equal(
    outcome.message,
    "the worker plane answered 503 for a credential",
  );
  assert.equal(pushed, 0);
  assert.notEqual(made, undefined);
  assert.equal(left, false, "the push's repository outlived it");
});

test("a commit its hook stops fails the commit step, takes no credential and makes no repository to push from", async () => {
  const { outcome, pushed, refreshes, made } = await pushedThrough([], {
    commit: gitFailed("pre-commit: secrets found\nerror: hook refused\n"),
  });

  assert.ok(outcome instanceof RunStepFailure);
  assert.equal(outcome.evidence, runCommitFailed);
  assert.equal(outcome.message.split("\n")[0], "error: hook refused");
  assert.equal(pushed, 0);
  assert.equal(refreshes, 0);
  assert.equal(made, undefined);
});

/**
 * One attempt published from a checkout by git itself, holding `held`: the
 * source it declared or the error it was refused with, and how many times its
 * push asked for a credential. `meanwhile` runs as the push asks, after the
 * check.
 */
async function publishedFrom(
  { remote, directory, base },
  meanwhile = async () => undefined,
) {
  const asked = { refreshes: 0 };
  const source = commitAndPushSource({
    task: { ticket: 9, attempt: "opaque", worker: {} },
    repositoryId: "chuggy",
    repository: remote,
    base,
    directory,
    command: git,
    environment: process.env,
    secrets: held,
    refresh: async () => {
      asked.refreshes += 1;
      await meanwhile();
      return process.env;
    },
  });
  return { asked, source: await source.catch((error) => error) };
}

/**
 * Driven against real repositories, because whether a commit exists when nothing
 * changed is git's answer and not the stub's. Catches a commit that stopped
 * being `--allow-empty`: the attempt would crash where it should have declared
 * the work its commands found nothing left to do.
 */
/**
 * Catches a push repository made in an object format other than the
 * workspace's: it could borrow none of its objects, and the push would fail.
 */
test("a SHA-256 workspace pushes to a SHA-256 remote", async () => {
  const root = await mkdtemp(join(tmpdir(), "chuggy-push-sha256-"));
  try {
    const remote = join(root, "remote.git");
    const directory = join(root, "checkout");
    await git("git", [
      "init",
      "--quiet",
      "--object-format=sha256",
      "--bare",
      remote,
    ]);
    await git("git", ["init", "--quiet", "--object-format=sha256", directory]);
    await writeFile(join(directory, "a"), "a\n");
    await git("git", ["add", "a"], { cwd: directory });
    await git("git", [...author, "commit", "--quiet", "-m", "base"], {
      cwd: directory,
    });
    const base = await headOf(directory);
    await git("git", ["push", "--quiet", remote, "HEAD:refs/heads/main"], {
      cwd: directory,
    });
    await writeFile(join(directory, "b"), "b\n");

    const { source } = await publishedFrom({ remote, directory, base });

    assert.ok(!(source instanceof Error), String(source.message));
    assert.equal(source.commit.length, 64);
    const { stdout } = await git("git", ["rev-parse", source.ref], {
      cwd: remote,
    });
    assert.equal(stdout.trim(), source.commit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an attempt that changed nothing still declares a commit on its branch", async () => {
  await inCheckout(async ({ remote, directory, base }) => {
    const { source } = await publishedFrom({ remote, directory, base });

    const { stdout: changed } = await git(
      "git",
      ["diff", "--name-only", base, source.commit],
      { cwd: directory },
    );
    assert.equal(changed, "", "the attempt changed the tree it was given");
    assert.notEqual(source.commit, base);
    const { stdout: pushed } = await git("git", ["rev-parse", source.ref], {
      cwd: remote,
    });
    assert.equal(pushed.trim(), source.commit);
  });
});

/**
 * Catches a check that refuses what it should pass: an attempt holding secrets
 * whose commits carry none pushes as it did before there was a check, and
 * takes its credential only once the check is done.
 */
test("an attempt whose commits carry no held secret pushes them", async () => {
  await inCheckout(async (checkout) => {
    await writeFile(
      join(checkout.directory, "large.bin"),
      Buffer.concat([
        Buffer.alloc(1 << 20),
        Buffer.from(held[0].value.slice(1)),
      ]),
    );

    const { asked, source } = await publishedFrom(checkout);

    assert.equal(asked.refreshes, 1);
    const { stdout: pushed } = await git("git", ["rev-parse", source.ref], {
      cwd: checkout.remote,
    });
    assert.equal(pushed.trim(), source.commit);
  });
});

/** Asserts `refused` is the check's refusal of `secret` in `commit`, and that nothing left the checkout. */
async function assertRefused(checkout, { refused, asked }, expected) {
  assert.ok(refused instanceof Error, "the attempt pushed a secret");
  assert.equal(refused.evidence, runCommitFailed);
  assert.equal(
    refused.message,
    `commit ${expected.commit} carries ${expected.secret.kind} in ${expected.place}, so the attempt pushes nothing`,
  );
  assert.ok(!refused.message.includes(expected.secret.value));
  assert.equal(
    asked.refreshes,
    0,
    "a credential was minted for a refused push",
  );
  assert.equal(await remoteRefs(checkout.remote), "");
}

/**
 * Catches a check that reads only the first secret, or only text: each held
 * secret is refused at the end of a binary file too large for one read.
 */
test("a file carrying any held secret is refused, and nothing is pushed", async () => {
  for (const secret of held)
    await inCheckout(async (checkout) => {
      await writeFile(
        join(checkout.directory, "large.bin"),
        Buffer.concat([Buffer.alloc(1 << 20), Buffer.from(secret.value)]),
      );

      const { asked, source: refused } = await publishedFrom(checkout);

      await assertRefused(
        checkout,
        { refused, asked },
        {
          secret,
          commit: await headOf(checkout.directory),
          place: "a file",
        },
      );
    });
});

/** A file the agent committed itself, and the commit it made. */
async function agentCommitted(directory, path, content) {
  await writeFile(join(directory, path), content);
  await git("git", ["add", path], { cwd: directory });
  await git("git", [...author, "commit", "-m", "the agent's"], {
    cwd: directory,
  });
  return headOf(directory);
}

/**
 * The check reads every commit the push adds, and names the first to carry
 * the secret. Catches a check of the attempt's final tree, which a secret the
 * agent committed and the attempt's own commit removed would pass, and one
 * naming the attempt's own commit for a secret the agent's put there.
 */
test("a secret is refused at the commit that first carries it, whether or not a later one removes it", async () => {
  for (const removed of [true, false])
    await inCheckout(async (checkout) => {
      const { directory } = checkout;
      const added = await agentCommitted(directory, "token", held[1].value);
      if (removed) await rm(join(directory, "token"));

      const { asked, source: refused } = await publishedFrom(checkout);

      await assertRefused(
        checkout,
        { refused, asked },
        { secret: held[1], commit: added, place: "a file" },
      );
    });
});

test("a secret in a commit's message is refused", async () => {
  await inCheckout(async (checkout) => {
    const { directory } = checkout;
    await git(
      "git",
      [...author, "commit", "--allow-empty", "-m", `saw ${held[0].value}`],
      { cwd: directory },
    );
    const carrying = await headOf(directory);

    const { asked, source: refused } = await publishedFrom(checkout);

    await assertRefused(
      checkout,
      { refused, asked },
      {
        secret: held[0],
        commit: carrying,
        place: "its message",
      },
    );
  });
});

test("a secret in a file's name is refused", async () => {
  await inCheckout(async (checkout) => {
    await writeFile(join(checkout.directory, held[0].value), "named\n");

    const { asked, source: refused } = await publishedFrom(checkout);

    await assertRefused(
      checkout,
      { refused, asked },
      {
        secret: held[0],
        commit: await headOf(checkout.directory),
        place: "a path",
      },
    );
  });
});

/**
 * A push sends the objects a commit names, whatever a replacement ref stands
 * in for them. Catches a check that reads the replacement: an agent's
 * `git replace` would show it a clean file while the secret was pushed.
 */
test("a secret behind a replacement ref is refused", async () => {
  await inCheckout(async (checkout) => {
    const { directory } = checkout;
    const carrying = await agentCommitted(directory, "token", held[1].value);
    const { stdout: blob } = await git("git", ["rev-parse", "HEAD:token"], {
      cwd: directory,
    });
    await writeFile(join(directory, "clean"), "clean\n");
    const { stdout: clean } = await git("git", ["hash-object", "-w", "clean"], {
      cwd: directory,
    });
    await rm(join(directory, "clean"));
    await git("git", ["replace", blob.trim(), clean.trim()], {
      cwd: directory,
    });

    const { asked, source: refused } = await publishedFrom(checkout);

    await assertRefused(
      checkout,
      { refused, asked },
      { secret: held[1], commit: carrying, place: "a file" },
    );
  });
});

/**
 * What is pushed is the commit that was checked. Catches a push of `HEAD`,
 * which a process the agent left running could move between the check and the
 * push, onto a commit the check never read.
 */
test("a commit made after the check is never what is pushed", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote } = checkout;

    const { source } = await publishedFrom(checkout, async () => {
      await agentCommitted(directory, "late", held[0].value);
    });

    const { stdout: pushed } = await git("git", ["rev-parse", source.ref], {
      cwd: remote,
    });
    assert.equal(pushed.trim(), source.commit);
    assert.notEqual(source.commit, await headOf(directory));
  });
});

/**
 * A check git could not run found nothing, and is no reason to push. Catches
 * an exit status left unread: a base the checkout does not have lists no
 * object at all, which reads exactly like a clean push.
 */
test("a check git cannot run refuses the push", async () => {
  await inCheckout(async (checkout) => {
    const { asked, source: refused } = await publishedFrom({
      ...checkout,
      base: "f".repeat(40),
    });

    assert.ok(refused instanceof Error, "the attempt pushed unchecked");
    assert.match(
      refused.message,
      /^git rev-list exited 128 checking the push for secrets: /u,
    );
    assert.equal(asked.refreshes, 0);
    assert.equal(await remoteRefs(checkout.remote), "");
  });
});

/**
 * An image's git, and the hooks its project installed, may need a value
 * `check.sh` moved aside. Catches any git call of the publication's, or a
 * hook its commit runs, handed the core's own environment: without that
 * value, or with the task document, which carries the attempt's bearer; and
 * a push that runs the hook the workspace installed for it.
 */
test("each git a publication runs, and each hook its commit runs, is handed the image's environment and no task document, and its push runs none", async (t) => {
  await inCheckout(async ({ remote, directory, base }) => {
    const recording = await recordingGit(t);
    await git("git", ["config", "core.hooksPath", recording.hooks], {
      cwd: directory,
    });
    await writeFile(join(directory, "provisioned"), "set up\n");
    recording.start();

    await commitAndPushSource({
      task: {
        ticket: 9,
        attempt: "opaque",
        worker: { files: [{ path: "provisioned" }] },
      },
      repositoryId: "chuggy",
      repository: remote,
      base,
      directory,
      command: git,
      environment: workerCredentialEnvironment(
        join(remote, "unread"),
        "x",
        remote,
      ),
      secrets: held,
    });

    const records = await recording.records();
    for (const [label, ...handed] of records)
      assert.deepEqual(handed, handedAsTheImage, label);
    const labels = records.map(([label]) => label);
    for (const expected of [
      "git config",
      "git add",
      "git reset",
      "git commit",
      "pre-commit",
      "git rev-parse",
      "git rev-list",
      "git cat-file",
      "git init",
      "git push",
    ])
      assert.ok(labels.includes(expected), `${expected} was never recorded`);
    assert.ok(
      !labels.includes("pre-push"),
      "the push ran the workspace's hook",
    );
  });
});

/** Where a push runs, and what the repository it is made from holds as git reads it under the push's own environment. */
async function madeHolding(options) {
  const inMade = (args) =>
    git("git", args, {
      cwd: options.cwd,
      env: { PATH: process.env.PATH ?? "", ...options.env },
    });
  const { stdout: configured } = await inMade(["config", "--list"]);
  return {
    where: options.cwd,
    refs: (await inMade(["for-each-ref"])).stdout,
    keys: configured
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.slice(0, line.indexOf("="))),
    alternates: await readFile(
      join(options.env.GIT_DIR, "objects", "info", "alternates"),
      "utf8",
    ),
  };
}

/** How many objects a bare repository holds in packs. */
async function packedObjects(bare) {
  const { stdout } = await git("git", ["count-objects", "-v"], { cwd: bare });
  return Number(/^in-pack: (\d+)$/mu.exec(stdout)[1]);
}

/**
 * Driven by git itself, because what the remote is sent is git's answer to
 * what it advertises. Catches a push from a repository that copied a ref or
 * the workspace's configuration, one that cannot reach the attempt's commit,
 * one that sends the remote objects it already holds, and one under a
 * namespace the pod names, which would land its ref elsewhere.
 */
test("the push is made from a repository holding none of the workspace's refs or configuration, borrowing its objects, and sends only what the remote lacks", async (t) => {
  withoutStandingGitEntries(t);
  await inCheckout(async (checkout) => {
    const { remote, directory } = checkout;
    await git("git", ["push", "--quiet", remote, "HEAD:refs/heads/main"], {
      cwd: directory,
    });
    await git("git", ["config", "receive.unpackLimit", "1"], { cwd: remote });
    await git("git", ["config", "chuggy.workspace", "set"], { cwd: directory });
    await git("git", ["branch", "kept"], { cwd: directory });
    await writeFile(join(directory, "notes.md"), "what the attempt wrote\n");
    let seen;
    const command = async (executable, args, options) => {
      if (gitVerb(args) === "push") seen = await madeHolding(options);
      return git(executable, args, options);
    };

    const source = await commitAndPushSource({
      task: { ticket: 9, attempt: "opaque", worker: {} },
      repositoryId: "chuggy",
      repository: remote,
      base: checkout.base,
      directory,
      command,
      environment: { ...process.env, GIT_NAMESPACE: "elsewhere" },
      secrets: [],
    });

    assert.ok(!within(directory, seen.where), seen.where);
    assert.equal(seen.refs, "");
    assert.deepEqual(
      seen.keys.filter((key) => !key.startsWith("core.")),
      [],
      seen.keys.join(", "),
    );
    assert.equal(seen.alternates, `${join(directory, ".git", "objects")}\n`);
    const { stdout: pushed } = await git("git", ["rev-parse", source.ref], {
      cwd: remote,
    });
    assert.equal(pushed.trim(), source.commit);
    assert.equal(
      await packedObjects(remote),
      3,
      "the push sent more than the attempt's commit, its tree and its file",
    );
  });
});

/** The repository on the suite's forge an attempt pushes, and the password the forge accepts for it alone. */
const forgeRig = {
  name: "rig.git",
  password: "ghs_rigWrite0123456789abcdefghijklmn",
};

/**
 * Every way a configuration on this machine could turn the push, each a key
 * and a value reading the witnesses in `room`: a hook, a helper, a proxy, and
 * a rewrite of the URL it is told for its push alone or for every use.
 */
const configuredTurns = {
  hook: (room) => ["core.hooksPath", room.hooks],
  helper: (room) => [
    "credential.helper",
    `!f() { echo "$1" >> '${join(room.marks, "helper")}'; }; f`,
  ],
  proxy: (room) => ["http.proxy", room.proxy],
  pushInsteadOf: (room) => [
    `url.${room.elsewhere}/.pushInsteadOf`,
    `${room.origin}/`,
  ],
  insteadOf: (room) => [`url.${room.elsewhere}/.insteadOf`, `${room.origin}/`],
};

/** `entry` written to the configuration file at `file`. */
async function configuredFile(file, [key, value]) {
  await mkdir(dirname(file), { recursive: true });
  await git("git", ["config", "--file", file, key, value]);
}

/**
 * Each place an entry can be written for git to read it: each writes `entry`
 * there for `checkout`, its files under `room`, and answers what the push's
 * environment holds for git to find it.
 */
const configuredPlaces = {
  "the workspace's configuration": async (checkout, _room, [key, value]) => {
    await git("git", ["config", key, value], { cwd: checkout.directory });
    return {};
  },
  "the workspace's own hooks directory": async (checkout, room) => {
    await copyFile(
      join(room.hooks, "pre-push"),
      join(checkout.directory, ".git", "hooks", "pre-push"),
    );
    return {};
  },
  $HOME: async (_checkout, room, entry) => {
    await configuredFile(join(room.root, "home", ".gitconfig"), entry);
    return { HOME: join(room.root, "home") };
  },
  $XDG_CONFIG_HOME: async (_checkout, room, entry) => {
    await configuredFile(join(room.root, "xdg", "git", "config"), entry);
    return { XDG_CONFIG_HOME: join(room.root, "xdg") };
  },
  "the system's configuration": async (_checkout, room, entry) => {
    await configuredFile(join(room.root, "system"), entry);
    return { GIT_CONFIG_SYSTEM: join(room.root, "system") };
  },
  "the image's environment": async (_checkout, _room, [key, value]) => ({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: key,
    GIT_CONFIG_VALUE_0: value,
  }),
};

/** A witness that records each connection made to it and ends it unanswered, as a proxy the push used would be reached. */
async function proxyWitness(t) {
  const reached = [];
  const server = createServer((socket) => {
    reached.push(socket.remoteAddress);
    socket.destroy();
  });
  await new Promise((listening) => {
    server.listen(0, "127.0.0.1", () => listening(undefined));
  });
  t.after(() => new Promise((closed) => server.close(() => closed(undefined))));
  return { url: `http://127.0.0.1:${String(server.address().port)}`, reached };
}

/**
 * The forge an attempt pushes, the proxy witness, the askpass as an image
 * installs it, and the credential file it reads, until `t` ends.
 */
async function forgeBench(t) {
  const root = await mkdtemp(join(tmpdir(), "chuggy-push-turns-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const forge = await forgeServed(t, [forgeRig.name]);
  forge.accept(forgeRig.name, forgeRig.password);
  const askpass = join(root, "git-askpass.sh");
  await copyFile(
    fileURLToPath(new URL("./git-askpass.sh", import.meta.url)),
    askpass,
  );
  await chmod(askpass, 0o555);
  const token = join(root, "token");
  await writeFile(token, `${forgeRig.password}\n`);
  return { root, forge, proxy: await proxyWitness(t), askpass, token };
}

/**
 * The room one push's witnesses are kept in: a hooks directory whose
 * pre-push marks that it ran, an empty directory of marks, and the repository
 * a rewritten URL would reach in place of the forge's.
 */
async function witnessRoom(bench) {
  const root = await mkdtemp(join(bench.root, "room-"));
  const room = {
    root,
    hooks: join(root, "hooks"),
    marks: join(root, "marks"),
    elsewhere: join(root, "elsewhere"),
    origin: bench.forge.origin,
    proxy: bench.proxy.url,
  };
  await mkdir(room.hooks);
  await mkdir(room.marks);
  const hook = join(room.hooks, "pre-push");
  await writeFile(
    hook,
    `#!/bin/sh\necho ran >> '${join(room.marks, "pre-push")}'\n`,
  );
  await chmod(hook, 0o755);
  await git("git", [
    "init",
    "--quiet",
    "--bare",
    join(room.elsewhere, forgeRig.name),
  ]);
  return room;
}

/**
 * Asserts one attempt published from `checkout` to the forge, its push handed
 * the askpass environment and `placed` beside it, reached the forge alone,
 * ran no hook, asked no helper and used no proxy.
 */
async function assertPushedUnturned(bench, room, { checkout, placed, label }) {
  const url = bench.forge.url(forgeRig.name);
  const source = await commitAndPushSource({
    task: { ticket: 9, attempt: label, worker: {} },
    repositoryId: "chuggy",
    repository: url,
    base: checkout.base,
    directory: checkout.directory,
    command: git,
    environment: {
      ...workerCredentialEnvironment(bench.token, "x-access-token", url),
      GIT_ASKPASS: bench.askpass,
      ...placed,
    },
    secrets: [],
    pause: async () => undefined,
  }).catch((failure) => failure);

  assert.ok(!(source instanceof Error), `${label}: ${String(source.message)}`);
  const { stdout } = await git("git", ["rev-parse", source.ref], {
    cwd: bench.forge.bare(forgeRig.name),
  });
  assert.equal(stdout.trim(), source.commit, label);
  assert.deepEqual(await readdir(room.marks), [], label);
  assert.deepEqual(bench.proxy.reached, [], label);
  assert.equal(
    await remoteRefs(join(room.elsewhere, forgeRig.name)),
    "",
    label,
  );
}

/**
 * Catches a push that reads any configuration but the core's own, in any of
 * the places git looks for one, or hands the image's entries the last word on
 * its hooks and helpers: each would run the hook, ask the helper, reach the
 * proxy or push where the rewrite says.
 */
for (const [turn, places] of [
  ["hook", Object.keys(configuredPlaces)],
  [
    "helper",
    Object.keys(configuredPlaces).filter((place) => !place.includes("hooks")),
  ],
  ...["proxy", "pushInsteadOf", "insteadOf"].map((named) => [
    named,
    Object.keys(configuredPlaces).filter(
      (place) => !place.includes("hooks") && !place.includes("image"),
    ),
  ]),
])
  test(`a push is turned by no ${turn} the workspace or this machine configures${places.some((place) => place.includes("image")) ? ", or the image's environment names" : ""}`, async (t) => {
    const bench = await forgeBench(t);
    for (const place of places)
      await inCheckout(async (checkout) => {
        const room = await witnessRoom(bench);
        const placed = await configuredPlaces[place](
          checkout,
          room,
          configuredTurns[turn](room),
        );

        await assertPushedUnturned(bench, room, {
          checkout,
          placed,
          label: `${turn} in ${place}`,
        });
      });
  });

/** `git cat-file --batch` output for blobs of these contents. */
function catFileOutput(...contents) {
  return Buffer.concat(
    contents.map((content, index) =>
      Buffer.from(
        `${String(index).repeat(40)} blob ${String(Buffer.byteLength(content))}\n${content}\n`,
      ),
    ),
  );
}

/** What a reader answers for `output` fed in chunks cut at `cuts`. */
function readInChunks(output, cuts) {
  const reader = sourceSecretReader(held);
  const bounds = [0, ...cuts, output.length];
  for (let index = 1; index < bounds.length; index += 1) {
    const found = reader.read(
      output.subarray(bounds[index - 1], bounds[index]),
    );
    if (found !== undefined) return found;
  }
  reader.end();
  return undefined;
}

/**
 * Chunks are where a pipe cuts them, never where an object does. Catches a
 * secret lost at a chunk boundary, and the opposite: two objects whose ends
 * meet to spell one.
 */
test("a secret is found across the chunks of one object and never across two objects", () => {
  const secret = held[0].value;
  const half = Math.floor(secret.length / 2);
  const whole = catFileOutput(`before ${secret} after`);
  const cut = whole.indexOf(secret) + half;
  for (const cuts of [[cut], [3, cut, cut + 1]])
    assert.equal(
      readInChunks(whole, cuts)?.kind,
      held[0].kind,
      `cut at ${cuts}`,
    );

  const apart = catFileOutput(secret.slice(0, half), secret.slice(half));
  for (let cut = 1; cut < apart.length; cut += 1)
    assert.equal(readInChunks(apart, [cut]), undefined, `cut at ${cut}`);
});

test("every worker report uses the schema that carries its summary", () => {
  assert.equal(
    resultDocument({ verdict: "Fail", report: "failed" }).version,
    3,
  );
  assert.equal(
    resultDocument({
      verdict: "Pass",
      report: "passed",
      source: { repository: "chuggy" },
    }).version,
    3,
  );
});
