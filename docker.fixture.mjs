/**
 * Docker's own CLI pointed at a daemon that only records what a pull sends
 * it, on a PATH whose credential helpers record being asked and answer with
 * a login of the machine's. A pull there shows which credential docker would
 * present, and nothing is pulled.
 */

import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { containerEngine } from "./engine.mjs";

/**
 * The machine's logins, one for each place docker finds one: its credential
 * helpers, its configuration file and `DOCKER_AUTH_CONFIG`.
 */
export const helperLogin = { Username: "operator", Secret: "helper-secret" };
export const fileLogin = { Username: "operator", Secret: "file-secret" };
export const environmentLogin = {
  Username: "operator",
  Secret: "environment-secret",
};

/** Every registry the suites pull from, as docker keys a login to each. */
const loginHosts = [
  "registry.chuggy.example",
  "ghcr.io",
  "https://index.docker.io/v1/",
];

/**
 * A configuration's `auths`, holding this login for every registry the
 * suites pull from, as a configuration file or `DOCKER_AUTH_CONFIG` holds it.
 *
 * @param {{Username: string, Secret: string}} login
 */
export function loginDocument(login) {
  const auth = Buffer.from(`${login.Username}:${login.Secret}`).toString(
    "base64",
  );
  return JSON.stringify({
    auths: Object.fromEntries(loginHosts.map((host) => [host, { auth }])),
  });
}

/**
 * Docker's CLI with its version, or nothing where it is not installed.
 *
 * @returns {Promise<{docker: import("./engine.mjs").Engine, version: [number, number]} | undefined>}
 */
export async function dockerCli() {
  const docker = containerEngine("docker", 30_000);
  const answer = await docker.exec(["--version"]);
  const version = /^Docker version (\d+)\.(\d+)\./u.exec(answer.stdout);
  return answer.code === 0 && version !== null
    ? { docker, version: [Number(version[1]), Number(version[2])] }
    : undefined;
}

/**
 * @param {string} directory
 * @param {string} asked
 */
async function credentialHelpers(directory, asked) {
  const helpers = join(directory, "helpers");
  const pass = join(directory, "pass");
  await mkdir(helpers);
  await mkdir(pass);
  const login = JSON.stringify({ ServerURL: "", ...helperLogin });
  for (const store of ["secretservice", "pass"])
    await writeFile(
      join(helpers, `docker-credential-${store}`),
      `#!/bin/sh\necho ${store} >> '${asked}'\ncat > /dev/null\nprintf '%s' '${login}'\n`,
      { mode: 0o755 },
    );
  await writeFile(join(pass, "pass"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return { helpers, pass };
}

/** @param {import("node:test").TestContext} t */
export async function dockerDaemon(t) {
  // Under /tmp, since a long TMPDIR could put the socket's path past the
  // length one may have.
  const directory = await mkdtemp("/tmp/chuggy-docker-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const asked = join(directory, "asked");
  const { helpers, pass } = await credentialHelpers(directory, asked);
  /** @type {unknown[]} */
  const registryAuths = [];
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/_ping") === true) {
      response.writeHead(200, { "Api-Version": "1.47", Ostype: "linux" });
      response.end();
      return;
    }
    const header = request.headers["x-registry-auth"];
    registryAuths.push(
      typeof header === "string"
        ? JSON.parse(Buffer.from(header, "base64url").toString("utf8"))
        : undefined,
    );
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"status":"pulled"}\n');
  });
  const socket = join(directory, "docker.sock");
  await new Promise((resolve) => {
    server.listen(socket, () => resolve(undefined));
  });
  t.after(() => server.close());
  let configurations = 0;
  return {
    host: `unix://${socket}`,
    /**
     * A PATH holding both helpers, and with `pass` too when docker should
     * pick the helper that uses it.
     *
     * @param {boolean} withPass
     */
    path: (withPass) =>
      [helpers, ...(withPass ? [pass] : []), process.env.PATH].join(":"),
    /**
     * A configuration directory of the machine's, as `DOCKER_CONFIG` names
     * one, whose `config.json` is this text.
     *
     * @param {string} text
     */
    machineConfig: async (text) => {
      configurations += 1;
      const configuration = join(directory, `config-${String(configurations)}`);
      await mkdir(configuration);
      await writeFile(join(configuration, "config.json"), text);
      return configuration;
    },
    /** Which helpers docker asked, in order. */
    asked: async () =>
      (await readFile(asked, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line !== ""),
    /** What each pull's `X-Registry-Auth` carried, decoded. */
    registryAuths,
  };
}
