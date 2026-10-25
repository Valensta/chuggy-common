import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";

import {
  sessionTaskVariable,
  workerCredentialFilesSchema,
  workerRepositoriesSchema,
  workerTaskVariable,
} from "@chuggy/worker-contract/workerEnvironment";

import { workerImageVariable } from "./checks.mjs";
import { forgeGitIsolated, forgeServed } from "./gitForge.fixture.mjs";
import {
  workerCredentialEnvironment,
  workerCredentialHost,
  workerRepositories,
  workerRepository,
  workerRepositoryUrl,
} from "./repository.mjs";
import { posixShells } from "./shells.fixture.mjs";

const executeFile = promisify(execFile);
const askpass = fileURLToPath(new URL("./git-askpass.sh", import.meta.url));

/** The two variables as the contract states a site writes them, read the way a pod reads its environment. */
test("a repository resolves against the pair the contract states a site writes", () => {
  const credentialFiles = workerCredentialFilesSchema([
    "workspace",
    "claude-code",
  ]).parse({
    workspace: "/run/chuggy/credentials/workspace",
    "claude-code": "/run/chuggy/credentials/claude-code",
  });
  const repositories = workerRepositoriesSchema.parse({
    repository: {
      url: "https://git.invalid/repository.git",
      credential: "workspace",
      credentialUsername: "worker",
    },
  });

  const selected = workerRepository(
    workerRepositories(JSON.stringify(repositories)),
    workerRepositories(JSON.stringify(credentialFiles)),
    "repository",
  );

  assert.equal(selected.repository, repositories.repository.url);
  assert.equal(
    selected.environment.CHUG_WORKER_GIT_CREDENTIAL_FILE,
    credentialFiles.workspace,
  );
  assert.equal(
    selected.environment.CHUG_WORKER_GIT_CREDENTIAL_USERNAME,
    repositories.repository.credentialUsername,
  );
});

test("a worker repository selects its own credential", () => {
  const repositories = {
    internal: {
      url: "http://git.internal/chuggy.git",
      credential: "internal-worker",
      credentialUsername: "worker",
    },
    github: {
      url: "https://github.com/kasofsk/chuggy.git",
      credential: "github-worker",
      credentialUsername: "x-access-token",
    },
  };

  const selected = workerRepository(
    repositories,
    {
      "internal-worker": "/credentials/internal",
      "github-worker": "/credentials/github",
    },
    "github",
  );

  assert.equal(selected.repository, repositories.github.url);
  assert.equal(selected.credential, repositories.github.credential);
  assert.equal(
    selected.environment.CHUG_WORKER_GIT_CREDENTIAL_FILE,
    "/credentials/github",
  );
  assert.equal(
    selected.environment.CHUG_WORKER_GIT_CREDENTIAL_USERNAME,
    repositories.github.credentialUsername,
  );
  assert.equal(
    selected.environment.CHUG_WORKER_GIT_CREDENTIAL_HOST,
    "github.com",
  );
  assert.equal(selected.environment.GIT_ASKPASS, askpass);
  assert.equal(selected.environment.GIT_TERMINAL_PROMPT, "0");
});

/**
 * Catches a host read other than as git's prompt names it: a port dropped, a
 * user kept, a path, query or fragment read as part of it, or a remote that
 * is no URL given a host the askpass would answer.
 */
test("the host a credential is presented for is the one git's prompt names", () => {
  for (const [remote, host] of [
    ["https://github.com/kasofsk/chuggy.git", "github.com"],
    ["https://Git.Example:8443/org/x.git", "Git.Example:8443"],
    ["http://x-access-token@127.0.0.1:3000/org/x.git", "127.0.0.1:3000"],
    ["https://github.com?x=/y", "github.com"],
    ["https://github.com#/y", "github.com"],
    ["https://github.com", "github.com"],
    ["/var/lib/git/rig.git", ""],
    ["git@github.com:kasofsk/chuggy.git", ""],
  ])
    assert.equal(workerCredentialHost(remote), host, remote);
});

/**
 * Catches git reaching a remote with the core's own environment: without the
 * image's value of a variable `check.sh` moved aside, with the name `check.sh`
 * kept it under, or with a task document. A session's clone is handed the same.
 */
test("the askpass environment is what the image's programs are handed, and the askpass", (t) => {
  const kept = workerImageVariable("LD_LIBRARY_PATH");
  const pod = {
    [kept]: "/the/image/lib",
    [workerTaskVariable]: "the task document",
    [sessionTaskVariable]: "the session's task document",
    SITE_VARIABLE: "set by the site",
  };
  const saved = Object.keys(pod).map((name) => [name, process.env[name]]);
  Object.assign(process.env, pod);
  t.after(() => {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });

  const environment = workerCredentialEnvironment(
    "/credentials/github",
    "x",
    "https://github.com/kasofsk/chuggy.git",
  );

  assert.equal(environment.LD_LIBRARY_PATH, "/the/image/lib");
  assert.equal(environment.SITE_VARIABLE, "set by the site");
  for (const name of [kept, workerTaskVariable, sessionTaskVariable])
    assert.ok(!Object.hasOwn(environment, name), `${name} reaches git`);
  assert.equal(
    environment.CHUG_WORKER_GIT_CREDENTIAL_FILE,
    "/credentials/github",
  );
  assert.equal(environment.GIT_ASKPASS, askpass);
});

test("a worker repository refuses incomplete credential configuration", () => {
  assert.throws(
    () => workerRepository({}, {}, "missing"),
    /no repository configuration for missing/u,
  );
  assert.throws(
    () =>
      workerRepository(
        {
          repository: {
            url: "https://example.invalid/repository.git",
            credential: "repository-worker",
            credentialUsername: "worker",
          },
        },
        { "repository-worker": "relative/token" },
        "repository",
      ),
    /credential file is relative/u,
  );
  assert.throws(
    () => workerRepository({}, {}, "toString"),
    /no repository configuration for toString/u,
  );
});

test("a minted repository the map does not name is cloned at its own id", () => {
  assert.equal(
    workerRepositoryUrl({}, "https://github.com/kasofsk/chuggy.git"),
    "https://github.com/kasofsk/chuggy.git",
  );
  assert.equal(
    workerRepositoryUrl(
      { "https://github.com/kasofsk/chuggy.git": { credential: "github" } },
      "https://github.com/kasofsk/chuggy.git",
    ),
    "https://github.com/kasofsk/chuggy.git",
  );
});

test("a minted repository the map names is cloned at the map's url", () => {
  assert.equal(
    workerRepositoryUrl(
      {
        "https://github.com/kasofsk/chuggy.git": {
          url: "http://mirror.internal/chuggy.git",
        },
      },
      "https://github.com/kasofsk/chuggy.git",
    ),
    "http://mirror.internal/chuggy.git",
  );
  assert.throws(
    () =>
      workerRepositoryUrl(
        { "https://github.com/kasofsk/chuggy.git": { url: "" } },
        "https://github.com/kasofsk/chuggy.git",
      ),
    /has no URL/u,
  );
});

test("a mounted repository the map does not name is still refused", () => {
  assert.throws(
    () => workerRepository({}, {}, "https://github.com/kasofsk/chuggy.git"),
    /no repository configuration for https:\/\/github.com\/kasofsk\/chuggy.git/u,
  );
});

test("worker repositories are one keyed object", () => {
  assert.deepEqual(workerRepositories('{"repository":{"url":"url"}}'), {
    repository: { url: "url" },
  });
  assert.throws(
    () => workerRepositories("[]"),
    /worker repositories must be an object/u,
  );
});

/**
 * The prompts git asks an askpass for its own host, each naming a remote whose
 * path holds the word git's username prompt begins with, as a remote named
 * with git's `credential.useHttpPath` does.
 */
const askpassPrompts = {
  username: [
    "Username for 'https://github.com': ",
    "Username for 'https://github.com/org/UsernameTools.git': ",
  ],
  password: [
    "Password for 'https://selected-user@github.com': ",
    "Password for 'https://selected-user@github.com/org/UsernameTools.git': ",
  ],
};

/**
 * Catches a password prompt answered with the username because the remote it
 * names holds the word, which fails every push to that repository.
 */
test("git askpass reads the selected repository credential", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-askpass-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialFile = join(directory, "token");
  await writeFile(credentialFile, "selected-token  \n");
  const environment = {
    ...process.env,
    CHUG_WORKER_GIT_CREDENTIAL_FILE: credentialFile,
    CHUG_WORKER_GIT_CREDENTIAL_USERNAME: "selected-user",
    CHUG_WORKER_GIT_CREDENTIAL_HOST: "github.com",
  };

  for (const [asked, answer] of [
    ["username", "selected-user\n"],
    ["password", "selected-token\n"],
  ])
    for (const prompt of askpassPrompts[asked]) {
      const { stdout } = await executeFile("/bin/sh", [askpass, prompt], {
        env: environment,
      });

      assert.equal(stdout, answer, prompt);
    }
});

/**
 * The answer the askpass gives `prompt` under `shell` on a PATH of nothing,
 * for `github.com`, the credential file holding `content`.
 */
async function askpassAnswer(
  shell,
  directory,
  content,
  prompt = "Password for 'https://x-access-token@github.com/org/x.git': ",
) {
  const credentialFile = join(directory, "credential");
  await rm(credentialFile, { force: true });
  if (content !== undefined) await writeFile(credentialFile, content);
  return executeFile(shell.argv[0], [...shell.argv.slice(1), askpass, prompt], {
    env: {
      PATH: join(directory, "nothing"),
      CHUG_WORKER_GIT_CREDENTIAL_FILE: credentialFile,
      CHUG_WORKER_GIT_CREDENTIAL_USERNAME: "x-access-token",
      CHUG_WORKER_GIT_CREDENTIAL_HOST: "github.com",
    },
  });
}

/**
 * Catches an askpass that reaches for a command, which an image a job runs in
 * need not have, or that trims more than the trailing whitespace a mounted
 * token ends with.
 */
for (const shell of posixShells)
  test(
    `git askpass answers from its shell's builtins alone, under ${shell.name}`,
    { skip: shell.absent },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "chuggy-askpass-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      for (const [content, answer] of [
        ["token  \t\r\nsecond line\n", "token\n"],
        ["  leading kept *? [x]  ", "  leading kept *? [x]\n"],
        ["", "\n"],
      ]) {
        const { stdout } = await askpassAnswer(shell, directory, content);

        assert.equal(stdout, answer, JSON.stringify(content));
      }
      await assert.rejects(askpassAnswer(shell, directory, undefined), {
        code: 1,
      });
    },
  );

/**
 * Prompts naming a host other than `github.com`, or naming it as only part of
 * another: another host, its own on another port, its own as the user of
 * another, another with its own in the path, query or fragment; prompts
 * naming no host at all; and a prompt for something other than a username or
 * a password.
 */
const askpassForeignPrompts = [
  "Password for 'https://evil.example': ",
  "Username for 'https://evil.example/org/x.git': ",
  "Password for 'https://github.com:8443': ",
  "Username for 'https://github.com:8443/org/x.git': ",
  "Password for 'https://github.com@evil.example': ",
  "Password for 'https://evil.example/@github.com': ",
  "Password for 'https://evil.example?@github.com': ",
  "Password for 'https://evil.example#@github.com': ",
  "Password for 'https://github.com.evil.example': ",
  "Password for 'github.com': ",
  "Passphrase for 'https://github.com': ",
  "Password: ",
  "Username: ",
];

/**
 * Catches an askpass that answers a prompt for any host but its own, which
 * would hand the job's credential to whichever host a remote names.
 */
for (const shell of posixShells)
  test(
    `git askpass answers nothing for any host but its own, under ${shell.name}`,
    { skip: shell.absent },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "chuggy-askpass-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      for (const prompt of askpassForeignPrompts)
        await assert.rejects(
          askpassAnswer(shell, directory, "token\n", prompt),
          (failure) => failure.code !== 0 && failure.stdout === "",
          prompt,
        );
      const { stdout } = await askpassAnswer(
        shell,
        directory,
        "token\n",
        "Username for 'https://github.com': ",
      );
      assert.equal(stdout, "x-access-token\n");
    },
  );

/**
 * The askpass under `directory`, executable as an image installs it, and the
 * credential file it reads, holding `askpassForgePassword`.
 */
async function askpassInstalled(directory) {
  const installed = join(directory, "git-askpass.sh");
  await copyFile(askpass, installed);
  await chmod(installed, 0o555);
  const credentialFile = join(directory, "credential");
  await writeFile(credentialFile, `${askpassForgePassword}\n`);
  return { installed, credentialFile };
}

/** What `git ls-remote` of `url` exits with under the askpass `installed`, answering for `host`. */
async function askpassListed({ installed, credentialFile }, url, host) {
  return executeFile("git", ["ls-remote", url], {
    env: {
      PATH: process.env.PATH ?? "",
      ...forgeGitIsolated,
      GIT_ASKPASS: installed,
      CHUG_WORKER_GIT_CREDENTIAL_FILE: credentialFile,
      CHUG_WORKER_GIT_CREDENTIAL_USERNAME: "x-access-token",
      CHUG_WORKER_GIT_CREDENTIAL_HOST: host,
    },
  }).then(
    () => 0,
    (failure) => failure.code,
  );
}

/** The password the suite's forge accepts. */
const askpassForgePassword = "ghs_askpass0123456789abcdefghijklmnop";

/**
 * Driven by git itself, because the prompt git writes is git's to decide.
 * Catches an askpass that cannot read the host out of git's own prompt, and
 * one that answers the forge's host on a port it was not given.
 */
test("git askpass answers git's own prompt for its host, and nothing for its host on another port", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-askpass-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const forge = await forgeServed(t, ["rig.git"]);
  forge.accept("rig.git", askpassForgePassword);
  const url = forge.url("rig.git");
  const { port } = new URL(forge.origin);
  const installed = await askpassInstalled(directory);

  assert.equal(
    await askpassListed(
      installed,
      url,
      `127.0.0.1:${String(Number(port) + 1)}`,
    ),
    128,
  );
  assert.equal(await askpassListed(installed, url, "127.0.0.1"), 128);
  assert.deepEqual(forge.presented, []);
  assert.equal(
    await askpassListed(installed, url, workerCredentialHost(url)),
    0,
  );
  assert.deepEqual(
    [...new Set(forge.presented.map(({ password }) => password))],
    [askpassForgePassword],
  );
});
