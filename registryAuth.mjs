/**
 * The credential of the one pull made under a configuration of the runner's
 * own: a pull of the pool's registry, under the pool's token. That token is
 * chuggy's credential and not this machine's, so it is presented to that
 * registry alone, and in place of any login this machine keeps for it, but for
 * one a credential helper hands podman where its `registries.conf` names the
 * helper ahead of `containers-auth.json`, or names no `containers-auth.json`.
 * It is written for that registry into a directory made for that one pull and
 * removed after it, whatever its outcome, and the engine reads it from there,
 * so it is never in an argv. An image of any other registry is pulled as the
 * engine's own configuration pulls it, under whatever its user set up.
 */

import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { poolPullArgv, pullArgv, registryAuthFile } from "./engineArgv.mjs";
import { runtimeScratch } from "./runtimeScratch.mjs";

/**
 * @typedef {{host: string, token: string}} RegistryCredential
 *
 * @typedef {object} PullSite where a pull is made
 * @property {"docker" | "podman"} engine
 * @property {string} runtimeDir where the pool's credential is given a directory of its own
 * @property {string | undefined} dockerHost the endpoint docker's context names, which a pull of the pool's registry is told; docker's alone
 */

/** The user a registry is told; the registry authorizes on the token alone. */
const registryUser = "chuggy-pool";

/** Where an image whose reference names no registry is pulled from. */
const defaultRegistryHost = "docker.io";

/**
 * The registry an image reference names, by the rule both engines share: a
 * first component with a dot or a colon, or `localhost`, is a host, and a
 * reference without one is Docker Hub's.
 *
 * @param {string} reference
 * @returns {string}
 */
export function imageRegistryHost(reference) {
  const slash = reference.indexOf("/");
  const first = slash < 0 ? "" : reference.slice(0, slash);
  return first.includes(".") || first.includes(":") || first === "localhost"
    ? first
    : defaultRegistryHost;
}

/**
 * The pool's token for its registry alone. Docker asks no credential helper of
 * a configuration holding a credential; it falls back on the machine's only
 * for one holding none.
 *
 * @param {RegistryCredential} credential
 */
export function registryAuthDocument(credential) {
  const auth = Buffer.from(
    `${registryUser}:${credential.token}`,
    "utf8",
  ).toString("base64");
  return JSON.stringify({ auths: { [credential.host]: { auth } } });
}

/**
 * Runs `pull` with a directory holding the pool's credential, made owner-only
 * under `runtimeDir` and removed however `pull` ends.
 *
 * @template T
 * @param {string} runtimeDir
 * @param {RegistryCredential} credential
 * @param {(directory: string) => Promise<T>} pull
 * @returns {Promise<T>}
 */
export async function withRegistryAuth(runtimeDir, credential, pull) {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(runtimeDir, runtimeScratch("pull")));
  try {
    await writeFile(
      join(directory, registryAuthFile),
      registryAuthDocument(credential),
      { mode: 0o600, flag: "wx" },
    );
    return await pull(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * One pull of `image`, handed to `run` as its argv and the variables it adds
 * to the engine's environment: under the pool's token where `credential` is
 * given, and otherwise as the engine's own configuration makes it, adding
 * none.
 *
 * @template T
 * @param {PullSite} site
 * @param {string} image
 * @param {RegistryCredential | undefined} credential
 * @param {(argv: string[], environment: Record<string, string>) => Promise<T>} run
 * @returns {Promise<T>}
 */
export function registryPull(site, image, credential, run) {
  if (credential === undefined) return run(pullArgv(image), {});
  return withRegistryAuth(site.runtimeDir, credential, (directory) => {
    const pull = poolPullArgv(site.engine, image, directory, site.dockerHost);
    return run(pull.argv, pull.environment);
  });
}
