/**
 * A chat supervisor's checkouts, driven against real repositories on this
 * machine: what is claimed is git's answer — a mirror made once and fetched
 * again, and a tree that borrows its objects — which a stubbed git would not
 * give. Who owns what is the isolation suite's question, asked as root, so
 * here a mirror's owner is recorded rather than set.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";

import {
  chatCheckout,
  chatMirrorGroupFirst,
  chatMirrorsOpened,
} from "./chatCheckout.mjs";
import { credentialUnreachedCases } from "./credentialUnreached.fixture.mjs";
import { sessionCheckoutGit } from "./sessionCheckout.mjs";

const run = promisify(execFile);

const bearer = "chgs_0123456789abcdef0123456789abcdef";

const task = {
  tenant: "vteng",
  project: "chuggy",
  authority: {
    tools: [],
    credentials: ["chuggy-git"],
    network: true,
    filesystem: "ReadWorkspace",
    mayCompleteTask: false,
  },
  repository: { reference: "chuggy" },
};

const credentialFiles = { "chuggy-git": "/var/run/chuggy/credentials/git" };

function repositories(url) {
  return {
    chuggy: { url, credential: "chuggy-git", credentialUsername: "chuggy" },
  };
}

/** A commit of `text` to the work repository at `work`, and the commit it made. */
async function committed(work, text) {
  await writeFile(join(work, "CLAUDE.md"), text);
  await run("git", ["add", "CLAUDE.md"], { cwd: work });
  await run(
    "git",
    [
      "-c",
      "user.email=suite@chuggy.invalid",
      "-c",
      "user.name=suite",
      "commit",
      "-m",
      text,
    ],
    { cwd: work },
  );
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: work });
  return stdout.trim();
}

/** A repository whose default branch is not `main`, so the head is the remote's own. */
async function remoteOf(root, name = "work") {
  const work = join(root, name);
  await run("git", ["init", "--quiet", "--initial-branch=trunk", work]);
  return { url: work, head: await committed(work, "# the tree's notes\n") };
}

/**
 * A scratch directory holding mirrors opened under it, whose owners are
 * recorded in `owned` rather than set, and every git call in `ran`.
 */
async function scratch(body) {
  const root = await mkdtemp(join(tmpdir(), "chuggy-chat-checkout-"));
  const owned = [];
  const ran = [];
  try {
    const mirrors = await chatMirrorsOpened({
      root: join(root, "mirrors"),
      owner: process.getuid(),
      own: async (path, user, group) => owned.push({ path, user, group }),
      run: (args, options) => {
        ran.push(args);
        return sessionCheckoutGit(args, options);
      },
    });
    return await body({ root, mirrors, owned, ran });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The services one checkout is made with. */
function servicesOf(mirrors, url, extra = {}) {
  return {
    mint: async () => undefined,
    mirrors,
    repositories: repositories(url),
    credentialFiles,
    environment: process.env,
    user: { uid: process.getuid(), gid: process.getgid() },
    log: () => undefined,
    ...extra,
  };
}

async function gitOut(args, cwd) {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

test("a session's tree is a shared clone of its repository's mirror, at the remote's own default branch", async () => {
  await scratch(async ({ root, mirrors, owned }) => {
    const { url, head } = await remoteOf(root);
    const workspace = join(root, "session-1");
    const logged = [];

    const made = await chatCheckout(
      task,
      bearer,
      workspace,
      servicesOf(mirrors, url, { log: (text) => logged.push(text) }),
    );

    const directory = join(workspace, "repository");
    assert.deepEqual(made, {
      checkout: { directory, commit: head },
      group: chatMirrorGroupFirst,
    });
    assert.deepEqual(logged, [`session checkout chuggy at ${head}\n`]);
    assert.equal(
      await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], directory),
      "trunk",
    );
    assert.equal(await gitOut(["remote", "get-url", "origin"], directory), url);
    const [mirror] = await readdir(join(root, "mirrors"));
    const path = join(root, "mirrors", mirror);
    assert.deepEqual(owned, [
      { path, user: process.getuid(), group: chatMirrorGroupFirst },
    ]);
    const alternates = await readFile(
      join(directory, ".git", "objects", "info", "alternates"),
      "utf8",
    );
    assert.equal(alternates.trim(), join(path, "objects"));
    assert.equal(await gitOut(["config", "gc.auto"], path), "0");
    assert.equal(
      await gitOut(["config", "core.sharedRepository"], path),
      "0640",
    );
    assert.equal((await stat(path)).mode & 0o7777, 0o2750);
  });
});

/** Catches a mirror made again for each session, or one a later session's tree does not see fetched. */
test("a later session's tree is made from the same mirror, fetched to what the remote has since", async () => {
  await scratch(async ({ root, mirrors, owned }) => {
    const { url } = await remoteOf(root);
    await chatCheckout(
      task,
      bearer,
      join(root, "session-1"),
      servicesOf(mirrors, url),
    );
    const later = await committed(url, "# the tree, later\n");

    const made = await chatCheckout(
      task,
      bearer,
      join(root, "session-2"),
      servicesOf(mirrors, url),
    );

    assert.equal(made.checkout?.commit, later);
    assert.equal((await readdir(join(root, "mirrors"))).length, 1);
    assert.equal(owned.length, 1, "the mirror was made twice");
  });
});

test("a second repository is mirrored apart, under a group of its own", async () => {
  await scratch(async ({ root, mirrors }) => {
    const first = await remoteOf(root, "first");
    const second = await remoteOf(root, "second");
    await chatCheckout(
      task,
      bearer,
      join(root, "session-1"),
      servicesOf(mirrors, first.url),
    );

    const made = await chatCheckout(
      task,
      bearer,
      join(root, "session-2"),
      servicesOf(mirrors, second.url),
    );

    assert.equal(made.checkout?.commit, second.head);
    assert.equal(made.group, chatMirrorGroupFirst + 1);
    assert.equal((await readdir(join(root, "mirrors"))).length, 2);
  });
});

/** Catches a supervisor that reads each mirror's group back wrong, and would hand a session another repository's. */
test("mirrors opened again keep the groups they were made with", async () => {
  await scratch(async ({ root, mirrors }) => {
    const { url } = await remoteOf(root);
    await chatCheckout(
      task,
      bearer,
      join(root, "session-1"),
      servicesOf(mirrors, url),
    );
    const [mirror] = await readdir(join(root, "mirrors"));
    const had = (await stat(join(root, "mirrors", mirror))).gid;
    const reopened = await chatMirrorsOpened({
      root: join(root, "mirrors"),
      groupFirst: had,
      groupCount: 2,
      own: async () => undefined,
    });
    const other = await remoteOf(root, "other");

    const made = await chatCheckout(
      task,
      bearer,
      join(root, "session-2"),
      servicesOf(reopened, other.url),
    );

    assert.equal(made.group, had + 1, "a new mirror was given a group in use");
  });
});

test("a project that binds no repository is given no tree, and nothing is minted or fetched", async () => {
  const made = await chatCheckout(
    { ...task, repository: undefined },
    bearer,
    "/sessions/session-1",
    servicesOf(
      { updated: () => assert.fail("a mirror was fetched") },
      "/nowhere",
      { mint: () => assert.fail("a credential was minted") },
    ),
  );

  assert.deepEqual(made, { checkout: undefined });
});

/** Catches the plane's word that its app does not reach the repository read as a tree to fetch anyway. */
test("a repository the plane's app does not reach is refused with the plane's reason, and nothing is fetched", async () => {
  for (const { unreached, told } of credentialUnreachedCases) {
    const made = await chatCheckout(
      task,
      bearer,
      "/sessions/session-1",
      servicesOf(
        { updated: () => assert.fail("a mirror was fetched") },
        "/nowhere",
        { mint: async () => ({ unreached }) },
      ),
    );

    for (const phrase of told)
      assert.ok(made.checkout.refused.includes(phrase));
  }
});

test("a repository the site does not map is refused, and nothing is fetched", async () => {
  const made = await chatCheckout(task, bearer, "/sessions/session-1", {
    ...servicesOf(
      { updated: () => assert.fail("a mirror was fetched") },
      "/nowhere",
    ),
    repositories: {},
  });

  assert.match(made.checkout.refused, /cannot resolve chuggy/u);
});

/** Catches a failed fetch that prints the minted password or bearer, or leaves a half-made tree. */
test("a remote that cannot be fetched is no tree, its failure logged without a secret, and nothing left", async () => {
  await scratch(async ({ root, mirrors }) => {
    const password = "ghs_minted0123456789abcdef";
    const url = join(root, `absent-${password}-${bearer}`);
    const workspace = join(root, "session-1");
    const logged = [];

    const made = await chatCheckout(
      task,
      bearer,
      workspace,
      servicesOf(mirrors, url, {
        mint: async () => ({
          file: join(root, "credential"),
          username: "x-access-token",
          password,
        }),
        log: (text) => logged.push(text),
      }),
    );

    assert.deepEqual(made, { checkout: undefined });
    const printed = logged.join("");
    assert.match(printed, /session checkout chuggy failed/u);
    assert.ok(!printed.includes(password), "the password was printed");
    assert.ok(!printed.includes(bearer), "the bearer was printed");
    await assert.rejects(stat(join(workspace, "repository")), {
      code: "ENOENT",
    });
  });
});

/** Catches a stop that waits out a plane that does not answer. */
test("a checkout stopped while the plane is asked is given up at once, and nothing is fetched", async () => {
  const stop = new globalThis.AbortController();
  const made = chatCheckout(
    task,
    bearer,
    "/sessions/session-1",
    servicesOf(
      { updated: () => assert.fail("a mirror was fetched") },
      "/nowhere",
      { mint: () => new Promise(() => undefined), signal: stop.signal },
    ),
  );
  stop.abort(new Error("stopped"));

  await assert.rejects(made, /stopped/u);
});

/** Catches a mirror its first session's stop left half-made refusing every later session. */
test("a checkout its session's stop cancels is no tree, and the next is made", async () => {
  await scratch(async ({ root }) => {
    const { url, head } = await remoteOf(root);
    const workspace = join(root, "session-1");
    const stop = new globalThis.AbortController();
    const mirrors = await chatMirrorsOpened({
      root: join(root, "mirrors"),
      own: async () => undefined,
      run: (args, options) => {
        if (args[0] === "init") stop.abort();
        return sessionCheckoutGit(args, options);
      },
    });

    const made = await chatCheckout(
      task,
      bearer,
      workspace,
      servicesOf(mirrors, url, { signal: stop.signal }),
    );

    assert.deepEqual(made, { checkout: undefined });
    await assert.rejects(stat(join(workspace, "repository")), {
      code: "ENOENT",
    });
    const next = await chatCheckout(
      task,
      bearer,
      join(root, "session-2"),
      servicesOf(mirrors, url),
    );
    assert.equal(next.checkout?.commit, head);
  });
});

/** Catches a prune that drops what a branch the remote deleted alone reached, which a tree may still borrow. */
test("a prune drops from every mirror what no ref of its reaches", async () => {
  await scratch(async ({ root, mirrors, ran }) => {
    const { url } = await remoteOf(root);
    await run("git", ["branch", "gone"], { cwd: url });
    await run("git", ["switch", "--quiet", "gone"], { cwd: url });
    const dropped = await committed(url, "# only on a branch\n");
    await run("git", ["switch", "--quiet", "trunk"], { cwd: url });
    await chatCheckout(
      task,
      bearer,
      join(root, "session-1"),
      servicesOf(mirrors, url),
    );
    await run("git", ["branch", "--quiet", "-D", "gone"], { cwd: url });
    await chatCheckout(
      task,
      bearer,
      join(root, "session-2"),
      servicesOf(mirrors, url),
    );
    const [mirror] = await readdir(join(root, "mirrors"));
    const path = join(root, "mirrors", mirror);
    await run("git", ["cat-file", "-e", dropped], { cwd: path });

    await mirrors.pruned();

    assert.ok(ran.some((args) => args.includes("gc")));
    await assert.rejects(
      run("git", ["cat-file", "-e", dropped], { cwd: path }),
    );
  });
});
