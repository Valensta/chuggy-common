import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { access, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  dockerCli,
  dockerDaemon,
  environmentLogin,
  fileLogin,
  helperLogin,
  loginDocument,
} from "./docker.fixture.mjs";
import {
  imageRegistryHost,
  registryAuthDocument,
  registryPull,
  withRegistryAuth,
} from "./registryAuth.mjs";

/** @param {import("node:test").TestContext} t */
async function runtimeDir(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "runtime");
}

test("an image's registry is its first component when that names a host, and Docker Hub otherwise", () => {
  assert.deepEqual(
    [
      "registry.chuggy.example/worker@sha256:aa",
      "localhost:5000/chuggy/worker:1",
      "localhost/worker:1",
      "192.0.2.10:30500/worker",
      "registry.example.com/x@sha256:aa",
      "chuggy/worker:1",
      "foo/bar",
      "busybox",
    ].map(imageRegistryHost),
    [
      "registry.chuggy.example",
      "localhost:5000",
      "localhost",
      "192.0.2.10:30500",
      "registry.example.com",
      "docker.io",
      "docker.io",
      "docker.io",
    ],
  );
});

const credential = { host: "registry.chuggy.example", token: "pool-token" };

test("the credential is the pool's token under the pool's user, for that host alone", () => {
  const document = JSON.parse(registryAuthDocument(credential));
  assert.deepEqual(Object.keys(document), ["auths"]);
  assert.deepEqual(Object.keys(document.auths), ["registry.chuggy.example"]);
  assert.equal(
    Buffer.from(
      document.auths["registry.chuggy.example"].auth,
      "base64",
    ).toString("utf8"),
    "chuggy-pool:pool-token",
  );
});

const poolImage = `registry.chuggy.example/worker@sha256:${"a".repeat(64)}`;

test("a pull with no credential is the engine's own: the plain pull, adding no variable and making no directory", async (t) => {
  const runtime = await runtimeDir(t);
  for (const engine of /** @type {const} */ (["docker", "podman"])) {
    const site = { engine, runtimeDir: runtime, dockerHost: undefined };
    assert.deepEqual(
      await registryPull(
        site,
        "ghcr.io/someone/private:1",
        undefined,
        undefined,
        (argv, environment) => Promise.resolve({ argv, environment }),
      ),
      {
        argv: ["pull", "--quiet", "ghcr.io/someone/private:1"],
        environment: {},
      },
    );
  }
  await assert.rejects(access(runtime));
});

test("a pull under the pool's token reads it from a directory of its own: docker's DOCKER_CONFIG, told its endpoint, and podman's --authfile", async (t) => {
  const runtime = await runtimeDir(t);
  const pulls = [];
  for (const engine of /** @type {const} */ (["docker", "podman"]))
    pulls.push(
      await registryPull(
        { engine, runtimeDir: runtime, dockerHost: "unix:///run/docker.sock" },
        poolImage,
        undefined,
        credential,
        async (argv, environment) => {
          const directory =
            engine === "docker"
              ? environment.DOCKER_CONFIG
              : argv[argv.indexOf("--authfile") + 1].replace(
                  /\/config\.json$/u,
                  "",
                );
          return {
            argv: argv.map((word) => word.replace(directory, "<directory>")),
            environment: Object.fromEntries(
              Object.entries(environment).map(([name, value]) => [
                name,
                value.replace(directory, "<directory>"),
              ]),
            ),
            inRuntime: directory.startsWith(`${runtime}/`),
            text: await readFile(join(directory, "config.json"), "utf8"),
          };
        },
      ),
    );
  assert.deepEqual(pulls, [
    {
      argv: ["pull", "--quiet", poolImage],
      environment: {
        DOCKER_CONFIG: "<directory>",
        DOCKER_HOST: "unix:///run/docker.sock",
        DOCKER_AUTH_CONFIG: "",
      },
      inRuntime: true,
      text: registryAuthDocument(credential),
    },
    {
      argv: [
        "pull",
        "--quiet",
        "--authfile",
        "<directory>/config.json",
        poolImage,
      ],
      environment: {},
      inRuntime: true,
      text: registryAuthDocument(credential),
    },
  ]);
  assert.deepEqual(await readdir(runtime), []);
});

test("a pull for a platform names it on every path: the engine's own, and under the pool's token on either engine", async (t) => {
  const runtime = await runtimeDir(t);
  /** @type {Array<["docker" | "podman", typeof credential | undefined]>} */
  const pulls = [
    ["docker", undefined],
    ["docker", credential],
    ["podman", credential],
  ];
  for (const [engine, pulledWith] of pulls) {
    const argv = await registryPull(
      { engine, runtimeDir: runtime, dockerHost: "unix:///run/docker.sock" },
      poolImage,
      "linux/arm64",
      pulledWith,
      async (pulled) => pulled,
    );
    assert.equal(argv[argv.indexOf("--platform") + 1], "linux/arm64", engine);
    assert.equal(argv.at(-1), poolImage, engine);
  }
});

/** Images of no pool's registry: one that names its registry, and one of Docker Hub's. */
const machineImages = ["ghcr.io/someone/private:1", "busybox:1"];

/** @param {{Username: string, Secret: string}} login */
const loginText = (login) => `${login.Username}:${login.Secret}`;

/**
 * What a pull's `X-Registry-Auth` presented, as the user and the password.
 *
 * @param {unknown} auth
 */
function presented(auth) {
  return auth !== null &&
    typeof auth === "object" &&
    "username" in auth &&
    "password" in auth
    ? `${String(auth.username)}:${String(auth.password)}`
    : undefined;
}

/**
 * The pool's image and each of the machine's pulled through docker's own CLI
 * as `registryPull` makes each, in this environment of the machine's: what
 * each presented, and which helpers each asked.
 *
 * @param {import("node:test").TestContext} t
 * @param {import("./engine.mjs").Engine} docker
 * @param {Awaited<ReturnType<typeof dockerDaemon>>} daemon
 * @param {Record<string, string>} machine
 */
async function pulledThroughDocker(t, docker, daemon, machine) {
  const site = {
    engine: /** @type {const} */ ("docker"),
    runtimeDir: await runtimeDir(t),
    dockerHost: daemon.host,
  };
  /** @type {Array<[string, typeof credential | undefined]>} */
  const pulls = [
    [poolImage, credential],
    ...machineImages.map(
      (image) => /** @type {[string, undefined]} */ ([image, undefined]),
    ),
  ];
  const seen = [];
  for (const [image, pulledWith] of pulls) {
    const askedBefore = (await daemon.asked()).length;
    const authsBefore = daemon.registryAuths.length;
    const answer = await registryPull(
      site,
      image,
      undefined,
      pulledWith,
      (argv, environment) =>
        docker.exec(argv, { environment: { ...machine, ...environment } }),
    );
    assert.equal(answer.code, 0, answer.stderr);
    assert.equal(daemon.registryAuths.length, authsBefore + 1);
    seen.push({
      image,
      presented: presented(daemon.registryAuths.at(-1)),
      asked: (await daemon.asked()).slice(askedBefore),
    });
  }
  return seen;
}

/**
 * What each of the pulls `pulledThroughDocker` makes should present: the
 * pool's token to the pool's registry, asking no helper, and this login of
 * the machine's to every other.
 *
 * @param {{Username: string, Secret: string}} login
 * @param {string[]} asked the helpers a pull of the machine's asks
 */
function presentedAs(login, asked) {
  return [
    { image: poolImage, presented: "chuggy-pool:pool-token", asked: [] },
    ...machineImages.map((image) => ({
      image,
      presented: loginText(login),
      asked,
    })),
  ];
}

test("docker's own CLI pulls an image of no pool's registry under the machine's login, from its helper or its file, and the pool's under the pool's token alone", async (t) => {
  const cli = await dockerCli();
  if (cli === undefined) {
    t.skip("docker's CLI is not installed");
    return;
  }
  const daemon = await dockerDaemon(t);
  /** @type {Array<[string, string, boolean, string[]]>} */
  const helpered = [
    [
      "the helper its file names",
      '{"credsStore":"secretservice"}',
      false,
      ["secretservice"],
    ],
    ["the helper docker finds on its PATH", "{}", false, ["secretservice"]],
    ["the helper docker finds where pass is", "{}", true, ["pass"]],
  ];
  for (const [named, text, withPass, asked] of helpered)
    assert.deepEqual(
      await pulledThroughDocker(t, cli.docker, daemon, {
        DOCKER_CONFIG: await daemon.machineConfig(text),
        DOCKER_HOST: daemon.host,
        DOCKER_AUTH_CONFIG: "",
        PATH: daemon.path(withPass),
      }),
      presentedAs(helperLogin, asked),
      named,
    );
  assert.deepEqual(
    await pulledThroughDocker(t, cli.docker, daemon, {
      DOCKER_CONFIG: await daemon.machineConfig(loginDocument(fileLogin)),
      DOCKER_HOST: daemon.host,
      DOCKER_AUTH_CONFIG: "",
      PATH: daemon.path(false),
    }),
    presentedAs(fileLogin, []),
    "the login its file holds",
  );
});

test("docker's own CLI pulls an image of no pool's registry under the machine's DOCKER_AUTH_CONFIG, and the pool's under the pool's token alone", async (t) => {
  const cli = await dockerCli();
  if (cli === undefined) {
    t.skip("docker's CLI is not installed");
    return;
  }
  const [major, minor] = cli.version;
  if (major < 28 || (major === 28 && minor < 3)) {
    t.skip(
      `docker's CLI is ${String(major)}.${String(minor)}, and reads DOCKER_AUTH_CONFIG only from 28.3`,
    );
    return;
  }
  const daemon = await dockerDaemon(t);
  assert.deepEqual(
    await pulledThroughDocker(t, cli.docker, daemon, {
      DOCKER_CONFIG: await daemon.machineConfig(loginDocument(fileLogin)),
      DOCKER_HOST: daemon.host,
      DOCKER_AUTH_CONFIG: loginDocument(environmentLogin),
      PATH: daemon.path(false),
    }),
    presentedAs(environmentLogin, []),
  );
});

test("a pull's directory is owner-only, holds its credential, and is gone after", async (t) => {
  const runtime = await runtimeDir(t);
  const seen = await withRegistryAuth(
    runtime,
    credential,
    async (directory) => ({
      name: directory.slice(runtime.length + 1),
      directory: (await stat(directory)).mode & 0o777,
      file: (await stat(join(directory, "config.json"))).mode & 0o777,
      text: await readFile(join(directory, "config.json"), "utf8"),
    }),
  );
  assert.match(seen.name, new RegExp(`^pull-${String(process.pid)}-`, "u"));
  assert.deepEqual(
    { ...seen, name: undefined },
    {
      name: undefined,
      directory: 0o700,
      file: 0o600,
      text: registryAuthDocument(credential),
    },
  );
  assert.equal((await stat(runtime)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(runtime), []);
});

test("a pull's directory is gone after a pull that threw", async (t) => {
  const runtime = await runtimeDir(t);
  await assert.rejects(
    withRegistryAuth(runtime, credential, async () => {
      throw new Error("the pull was aborted");
    }),
    /the pull was aborted/u,
  );
  assert.deepEqual(await readdir(runtime), []);
});
