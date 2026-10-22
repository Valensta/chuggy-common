import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  author,
  git,
  handedAsTheImage,
  headOf,
  inCheckout,
  recordingGit,
  remoteRefs,
} from "./checkout.fixture.mjs";
import { gitRemotePauseMs } from "./gitRemote.mjs";
import { workerCredentialEnvironment } from "./repository.mjs";
import {
  RunStepFailure,
  runCommitFailed,
  runPushFailed,
} from "./runEvidence.mjs";
import {
  commitAndPushSource,
  resultDocument,
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

test("ticket branch is deterministic, bounded, and names the ticket", () => {
  assert.equal(
    ticketBranch({ ticket: 42, attempt: "attempt-identity" }),
    "refs/heads/chuggy/tickets/42/attempts/" +
      "9a33b56cbbac4db829e4917c5ac9369958062635f18534cfc26b48071229a39f",
  );
});

test("source publication commits all changes and pushes a new attempt ref", async () => {
  const calls = [];
  const command = async (executable, args, options) => {
    calls.push({ executable, args, options });
    return args[0] === "rev-parse" ? { stdout: "abc123\n" } : { stdout: "" };
  };
  const environment = { GIT_ASKPASS: "askpass" };
  const source = await commitAndPushSource({
    task: {
      ticket: 7,
      attempt: "opaque",
      worker: { files: [{ path: ".claude/settings.json" }] },
    },
    repositoryId: "chuggy",
    repository: "http://git/rig.git",
    base: "base123",
    directory: "/workspace/repository",
    command,
    environment,
    secrets: [],
  });

  assert.deepEqual(source, {
    repository: "chuggy",
    ref: ticketBranch({ ticket: 7, attempt: "opaque" }),
    commit: "abc123",
    base: "base123",
  });
  assert.deepEqual(calls.at(-1), {
    executable: "git",
    args: ["push", "http://git/rig.git", `abc123:${source.ref}`],
    options: { cwd: "/workspace/repository", env: environment },
  });
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

test("a push that can take a fresh credential takes one, and uses it", async () => {
  const calls = [];
  const command = async (executable, args, options) => {
    calls.push({ executable, args, options });
    return args[0] === "rev-parse" ? { stdout: "abc123\n" } : { stdout: "" };
  };
  const refreshed = {
    GIT_ASKPASS: "askpass",
    CHUG_WORKER_GIT_CREDENTIAL_FILE: "/tmp/later",
  };
  let refreshes = 0;

  await commitAndPushSource({
    task: { ticket: 7, attempt: "opaque", worker: {} },
    repositoryId: "chuggy",
    repository: "http://git/rig.git",
    base: "base123",
    directory: "/workspace/repository",
    command,
    environment: {
      GIT_ASKPASS: "askpass",
      CHUG_WORKER_GIT_CREDENTIAL_FILE: "/tmp/earlier",
    },
    secrets: [],
    refresh: async () => {
      assert.equal(
        calls.at(-1).args[0],
        "rev-parse",
        "the credential is taken after everything the commit needed, not before",
      );
      refreshes += 1;
      return refreshed;
    },
  });

  assert.equal(refreshes, 1);
  assert.equal(calls.at(-1).args[0], "push");
  assert.deepEqual(calls.at(-1).options.env, refreshed);
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
 * Catches the push handed the attempt's reads as they stand, under which the
 * cache client answers the URL it pushes to with a read the forge refuses a
 * push with; and the commit's hooks handed the clear, which would hand them
 * the push's askpass for the job's own repository.
 */
test("the push is handed the attempt's git with every helper cleared for the URL it pushes to, and the commit as it is", async () => {
  const calls = [];
  const command = async (_executable, args, options) => {
    calls.push({ args, options });
    return args[0] === "rev-parse" ? { stdout: "abc123\n" } : { stdout: "" };
  };
  const git = [
    ["credential.http://git.helper", ""],
    ["credential.http://git.helper", "cache --socket '/minted/reads.sock'"],
  ];

  await commitAndPushSource({
    task: { ticket: 7, attempt: "opaque", worker: {} },
    repositoryId: "chuggy",
    repository: "http://git/rig.git",
    base: "base123",
    directory: "/workspace/repository",
    command,
    environment: {},
    secrets: [],
    git,
    refresh: async () => ({ GIT_ASKPASS: "askpass" }),
  });

  const handed = (verb) =>
    gitEntries(calls.find(({ args }) => args[0] === verb).options.env);
  assert.deepEqual(handed("push"), [
    ...git,
    ["credential.http://git/rig.git.helper", ""],
  ]);
  assert.deepEqual(handed("commit"), git);
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
 * many times it took a credential, and each pause between pushes.
 */
async function pushedThrough(
  pushes,
  { commit, refresh = async () => ({ GIT_ASKPASS: "askpass" }) } = {},
) {
  let pushed = 0;
  let refreshes = 0;
  const pauses = [];
  const command = async (_executable, args) => {
    if (args[0] === "commit" && commit !== undefined) throw commit;
    if (args[0] === "push") {
      pushed += 1;
      if (pushes[pushed - 1] !== undefined) throw pushes[pushed - 1];
    }
    return args[0] === "rev-parse" ? { stdout: "abc123\n" } : { stdout: "" };
  };
  const outcome = await commitAndPushSource({
    task: { ticket: 7, attempt: "opaque", worker: {} },
    repositoryId: "chuggy",
    repository: "http://git/rig.git",
    base: "base123",
    directory: "/workspace/repository",
    command,
    environment: {},
    secrets: [],
    refresh: () => {
      refreshes += 1;
      return refresh();
    },
    pause: async (ms) => {
      pauses.push(ms);
    },
  }).catch((failure) => failure);
  return { outcome, pushed, refreshes, pauses };
}

test("a push the forge failed with a server error is tried again under the one credential, and lands", async () => {
  const { outcome, pushed, refreshes, pauses } = await pushedThrough([
    gitFailed(
      "fatal: unable to access 'http://git/rig.git/': The requested URL returned error: 502\n",
    ),
  ]);

  assert.equal(outcome.commit, "abc123");
  assert.equal(pushed, 2);
  assert.equal(refreshes, 1);
  assert.deepEqual(pauses, [gitRemotePauseMs]);
});

test("a push refused, or stopped by its hook, is tried once and fails the push step, led by why", async () => {
  for (const [stderr, why] of [
    [
      "remote: Permission to rig.git denied to bot.\nfatal: unable to access 'http://git/rig.git/': The requested URL returned error: 403\n",
      "fatal: unable to access 'http://git/rig.git/': The requested URL returned error: 403",
    ],
    [
      "remote: error: GH006: Protected branch update failed for refs/heads/chuggy.\n ! [remote rejected] abc123 -> chuggy (protected branch hook declined)\nerror: failed to push some refs to 'http://git/rig.git'\n",
      "remote: error: GH006: Protected branch update failed for refs/heads/chuggy.",
    ],
    [
      "pre-push: lint failed\nerror: failed to push some refs to 'http://git/rig.git'\n",
      "error: failed to push some refs to 'http://git/rig.git'",
    ],
  ]) {
    const { outcome, pushed } = await pushedThrough([gitFailed(stderr)]);

    assert.ok(outcome instanceof RunStepFailure, why);
    assert.equal(outcome.evidence, runPushFailed, why);
    assert.equal(outcome.message.split("\n")[0], why);
    assert.ok(outcome.message.includes(stderr), why);
    assert.equal(pushed, 1, why);
  }
});

test("a push that cannot take its credential fails the push step and pushes nothing", async () => {
  const { outcome, pushed } = await pushedThrough([], {
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
});

test("a commit its hook stops fails the commit step and takes no credential", async () => {
  const { outcome, pushed, refreshes } = await pushedThrough([], {
    commit: gitFailed("pre-commit: secrets found\nerror: hook refused\n"),
  });

  assert.ok(outcome instanceof RunStepFailure);
  assert.equal(outcome.evidence, runCommitFailed);
  assert.equal(outcome.message.split("\n")[0], "error: hook refused");
  assert.equal(pushed, 0);
  assert.equal(refreshes, 0);
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
 * `check.sh` moved aside. Catches any git call of the push's, or a hook one of
 * them runs, handed the core's own environment: without that value, or with
 * the task document, which carries the attempt's bearer.
 */
test("each git a push runs, and each hook it runs, is handed the image's environment and no task document", async (t) => {
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
      environment: workerCredentialEnvironment(join(remote, "unread"), "x"),
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
      "git push",
      "pre-push",
    ])
      assert.ok(labels.includes(expected), `${expected} was never recorded`);
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
