/**
 * The reads a job makes of its project's other repositories, asked as git
 * itself asks them: through its own cache client, at the socket served.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { forgeGitIsolated } from "./gitForge.fixture.mjs";
import { workerGitEnvironment } from "./checks.mjs";
import {
  projectReadsConfiguration,
  projectReadsFields,
  projectReadsForge,
  projectReadsGitTooOld,
  projectReadsGitWarning,
  projectReadsRepository,
  projectReadsServed,
} from "./projectReads.mjs";

const own = "https://forge.test/org/own.git";
const lib = "https://forge.test/org/lib.git";
const read = {
  username: "x-access-token",
  password: "ghs_readOfLib0123456789",
};

test("a forge is the origin of an HTTP binding that carries no credential", () => {
  assert.deepEqual(projectReadsForge(own), {
    origin: "https://forge.test",
    hostname: "forge.test",
  });
  assert.deepEqual(projectReadsForge("http://127.0.0.1:8080/org/own.git"), {
    origin: "http://127.0.0.1:8080",
    hostname: "127.0.0.1",
  });
  for (const unread of [
    "git@forge.test:org/own.git",
    "/srv/git/own.git",
    "repository-1",
    "https://x-access-token:ghs_secret@forge.test/org/own.git",
  ])
    assert.equal(projectReadsForge(unread), undefined, unread);
});

/**
 * Catches a repository asked for under a name its binding is not, which the
 * plane answers not minted although the project binds it.
 */
test("a repository is asked for by the clone URL it is bound under", () => {
  const forge = projectReadsForge(own);
  const asked = (fields) =>
    projectReadsRepository(forge, new Map(Object.entries(fields)));

  for (const path of ["org/lib.git", "org/lib", "org/lib/", "org/lib.git/"])
    assert.equal(
      asked({ protocol: "https", host: "forge.test", path }),
      lib,
      path,
    );
  assert.equal(asked({ protocol: "https", host: "forge.test" }), undefined);
  assert.equal(
    asked({ protocol: "https", host: "other.test", path: "org/lib.git" }),
    undefined,
  );
  assert.equal(
    asked({ protocol: "http", host: "forge.test", path: "org/lib.git" }),
    undefined,
  );
});

test("the first value of a field is the one read, and a line naming none is skipped", () => {
  assert.deepEqual(
    [...projectReadsFields("action=get\npath=a\npath=b\nnot a field\n=x\n")],
    [
      ["action", "get"],
      ["path", "a"],
    ],
  );
});

/**
 * One git run under nothing but `git`'s entries and what `image` sets, `input`
 * on its stdin, which a git that reads none may have closed before it is
 * written.
 */
function gitWith(git, args, input = "", image = {}) {
  return new Promise((ran) => {
    const child = execFile(
      "git",
      args,
      {
        env: {
          PATH: process.env.PATH ?? "",
          ...forgeGitIsolated,
          ...image,
          ...workerGitEnvironment(image, git),
        },
      },
      (error, stdout, stderr) =>
        ran({ code: error?.code ?? 0, stdout, stderr }),
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** What git's credential machinery fills in for `url`, or nothing it could not. */
async function filled(git, url) {
  const ran = await gitWith(git, ["credential", "fill"], `url=${url}\n\n`);
  if (ran.code !== 0) return undefined;
  const fields = projectReadsFields(ran.stdout);
  return { username: fields.get("username"), password: fields.get("password") };
}

/**
 * The reads served for `own` until `t` ends, `answer(repository)` the plane's,
 * and every repository the plane was asked for and every password kept. The
 * job's git prints `printed` for its version, or fails where that is nothing.
 */
async function served(
  t,
  answer,
  warn = () => undefined,
  printed = "git version 2.51.0\n",
) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-reads-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const asked = [];
  const kept = [];
  const reads = await projectReadsServed({
    repositoryId: own,
    directory,
    mint: async (repository) => {
      asked.push(repository);
      return answer(repository, asked.length);
    },
    keep: (password) => kept.push(password),
    gitVersion: async () => {
      if (printed === undefined) throw new Error("git does not run");
      return printed;
    },
    warn,
  });
  t.after(() => reads.close());
  return { ...reads, directory, asked, kept };
}

/**
 * Catches a git before the configuration it is handed left unnamed, or one
 * that reads it named, by what `git --version` prints in the builds images
 * carry.
 */
test("a git is too old for its configuration by the version it prints", () => {
  for (const [printed, tooOld] of [
    ["git version 2.30.2\n", "2.30.2"],
    ["git version 1.8.3.1\n", "1.8.3.1"],
    ["git version 2.31.0\n", undefined],
    ["git version 2.39.5 (Apple Git-154)\n", undefined],
    ["git version 2.47.1.windows.1\n", undefined],
    ["git version 3.0.0\n", undefined],
    ["git version unreadable\n", undefined],
  ])
    assert.equal(projectReadsGitTooOld(printed), tooOld, printed);
});

/**
 * Catches a job whose git reads none of its configuration, and so none of
 * its project's other repositories, said nothing of; said more than once; or
 * a git that reads it warned of.
 */
test("a job's git too old for its configuration is warned of once, and one that reads it is not", async (t) => {
  const warned = [];
  const old = await served(
    t,
    () => read,
    (text) => warned.push(text),
    "git version 2.30.2\n",
  );
  await filled(old.git, lib);

  assert.deepEqual(warned, [projectReadsGitWarning("2.30.2")]);
  assert.match(
    warned[0],
    /git 2\.30\.2 .*use an image with git 2\.31 or later$/u,
  );
  for (const printed of ["git version 2.31.0\n", undefined]) {
    const silent = [];
    await served(
      t,
      () => read,
      (text) => silent.push(text),
      printed,
    );

    assert.deepEqual(silent, [], String(printed));
  }
});

/**
 * Catches git told no path, which names no repository the plane can mint
 * for; and a password answered and not held, which a push could then carry.
 */
test("git asks for another repository by its path and is answered the plane's read, held once", async (t) => {
  const reads = await served(t, () => read);

  assert.deepEqual(await filled(reads.git, lib), read);
  assert.deepEqual(await filled(reads.git, "https://forge.test/org/lib"), read);

  assert.deepEqual(reads.asked, [lib, lib]);
  assert.deepEqual(reads.kept, [read.password]);
});

/**
 * Catches the job's own repository answered here, which would hand an agent's
 * git a credential for it where it holds none today, and a work attempt's its
 * push.
 */
test("the job's own repository is never asked for", async (t) => {
  const reads = await served(t, () => read);

  assert.equal(await filled(reads.git, own), undefined);
  assert.deepEqual(reads.asked, []);
});

/** Catches a repository the plane mints nothing for answered anything. */
test("a repository the plane mints nothing for is answered nothing", async (t) => {
  const reads = await served(t, () => undefined);

  assert.equal(await filled(reads.git, lib), undefined);
  assert.deepEqual(reads.asked, [lib]);
  assert.deepEqual(reads.kept, []);
});

/**
 * Catches a mint that failed ending the reads or answering something, where
 * git is to go on as it would with nothing; and the failure kept from the log.
 */
test("a read the plane failed to mint is answered nothing, and said", async (t) => {
  const warned = [];
  const reads = await served(
    t,
    (_repository, nth) => {
      if (nth === 1) throw new Error("the plane is away");
      return read;
    },
    (text) => warned.push(text),
  );

  assert.equal(await filled(reads.git, lib), undefined);
  assert.deepEqual(await filled(reads.git, lib), read);
  assert.deepEqual(warned, [
    `a read of ${lib} could not be minted: the plane is away`,
  ]);
});

/**
 * Catches a token answered from anything but the plane's latest answer, which
 * leaves a job holding an expired one failing every fetch from then on.
 */
test("every ask is the plane's, so a token it minted again is the one answered", async (t) => {
  const reads = await served(t, (_repository, nth) => ({
    username: "x-access-token",
    password: `ghs_mintedForTheAsk${String(nth)}`,
  }));

  assert.equal(
    (await filled(reads.git, lib))?.password,
    "ghs_mintedForTheAsk1",
  );
  assert.equal(
    (await filled(reads.git, lib))?.password,
    "ghs_mintedForTheAsk2",
  );
  assert.deepEqual(reads.kept, [
    "ghs_mintedForTheAsk1",
    "ghs_mintedForTheAsk2",
  ]);
});

/**
 * Catches what git hands back kept and answered later: the job's own push
 * credential stored by its push, and then answered to whatever asks.
 */
test("a credential git stores or erases is dropped, and every answer stays the plane's", async (t) => {
  const reads = await served(t, () => undefined);
  const pushed =
    "url=https://forge.test/org/lib.git\nusername=x-access-token\npassword=ghs_ownPushCredential\n\n";

  for (const verb of ["approve", "reject"])
    assert.equal(
      (await gitWith(reads.git, ["credential", verb], pushed)).code,
      0,
    );

  assert.equal(await filled(reads.git, lib), undefined);
  assert.deepEqual(reads.asked, [lib]);
});

/**
 * Catches a helper the image configures asked before the plane, or handed a
 * read that worked to store, which a store helper would leave on the node's
 * disk; or the image's helpers cleared beyond the forge.
 */
test("no helper the image names is asked or handed anything for the forge, and every other host keeps them", async (t) => {
  const reads = await served(t, () => read);
  const log = join(reads.directory, "image-helper.log");
  const config = join(reads.directory, "image.gitconfig");
  await writeFile(
    config,
    `[credential]\n\thelper = "!f() { echo \\"$1\\" >> '${log}'; echo username=image; echo password=ghs_imageHelperAnswer; }; f"\n`,
  );
  const image = { GIT_CONFIG_GLOBAL: config };
  const ask = (url) => `url=${url}\n\n`;

  const forge = await gitWith(
    reads.git,
    ["credential", "fill"],
    ask(lib),
    image,
  );
  await gitWith(
    reads.git,
    ["credential", "approve"],
    `url=${lib}\nusername=${read.username}\npassword=${read.password}\n\n`,
    image,
  );
  await assert.rejects(access(log), { code: "ENOENT" });
  const elsewhere = await gitWith(
    reads.git,
    ["credential", "fill"],
    ask("https://other.test/org/lib.git"),
    image,
  );

  assert.equal(projectReadsFields(forge.stdout).get("password"), read.password);
  assert.equal(
    projectReadsFields(elsewhere.stdout).get("password"),
    "ghs_imageHelperAnswer",
  );
  assert.equal(await readFile(log, "utf8"), "get\n");
});

/** Catches a password that would break the line git reads it from answered at all. */
test("a minted value git's protocol cannot carry is answered nothing", async (t) => {
  const reads = await served(t, () => ({
    username: "x-access-token",
    password: "ghs_one\nusername=another",
  }));

  assert.equal(await filled(reads.git, lib), undefined);
  assert.deepEqual(reads.kept, []);
});

/**
 * Catches a submodule written with an ssh address left to ssh, which a pod
 * holds no key for, rather than read over the forge's HTTP.
 */
test("an ssh address on the forge is fetched at its HTTP one", async (t) => {
  const reads = await served(t, () => undefined);

  for (const address of [
    "git@forge.test:org/lib.git",
    "ssh://git@forge.test/org/lib.git",
  ]) {
    const ran = await gitWith(reads.git, ["ls-remote", "--get-url", address]);
    assert.equal(ran.stdout.trim(), lib, address);
  }
  const elsewhere = await gitWith(reads.git, [
    "ls-remote",
    "--get-url",
    "git@other.test:org/lib.git",
  ]);
  assert.equal(elsewhere.stdout.trim(), "git@other.test:org/lib.git");
});

test("a socket path git's shell would split is still one helper argument", () => {
  const [, [, helper]] = projectReadsConfiguration(
    projectReadsForge(own),
    "/minted/it's here",
  );

  assert.equal(helper, `cache --socket '/minted/it'\\''s here'`);
});

/** Catches a client that never stops writing held as long as it writes. */
test("a request past what is read is dropped unanswered", async (t) => {
  const reads = await served(t, () => read);
  const [, [, helper]] = reads.git;
  const socket = join(reads.directory, "chuggy-git-reads.sock");
  assert.match(helper, /chuggy-git-reads\.sock'$/u);

  const answered = await new Promise((ended) => {
    const client = connect(socket);
    let text = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      text += chunk;
    });
    client.on("error", () => undefined);
    client.on("close", () => ended(text));
    client.write(`action=get\npath=${"a".repeat(70_000)}\n`);
  });

  assert.equal(answered, "");
  assert.deepEqual(reads.asked, []);
});

/** Catches a socket left behind the attempt, which a later git would ask in vain. */
test("closed reads leave no socket", async (t) => {
  const reads = await served(t, () => read);
  const socket = join(reads.directory, "chuggy-git-reads.sock");
  await access(socket);

  await reads.close();

  await assert.rejects(access(socket), { code: "ENOENT" });
});

/** Catches a job whose repository names no forge configuring git anyway. */
test("a job bound at no HTTP remote serves nothing and configures nothing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-reads-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const reads = await projectReadsServed({
    repositoryId: "/srv/git/own.git",
    directory,
    mint: async () => read,
    keep: () => undefined,
  });

  assert.deepEqual(reads.git, []);
  await assert.rejects(access(join(directory, "chuggy-git-reads.sock")), {
    code: "ENOENT",
  });
  await reads.close();
});
