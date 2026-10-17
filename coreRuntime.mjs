/**
 * Where this core finds what it runs beside, read off where its own modules
 * sit rather than off PATH.
 *
 * THE CORE SITS IN `lib/chuggy/` OF A TREE WHOSE `bin/` HOLDS THE AGENTS. That
 * is chuggy's runtime tree, which chuggy's own images carry and a job of any
 * other image mounts, and the derivation names no tree's root, so a core
 * copied into any such tree finds that tree's agents.
 *
 * THAT `bin/` IS NEVER PUT ON PATH. It holds chuggy's own node, which would
 * then be the node a project's checks and its agent's shell run.
 *
 * THE TREE'S `share/` HOLDS THE CA BUNDLE CODEX IS GIVEN.
 *
 * A CORE RUN ON ITS RUNNER'S HOST HAS NO SUCH TREE, so its agents are the
 * ones its PATH finds, which is its owner's, and Codex verifies a peer
 * against the host's own store.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** What names a host-run job's directory to the core it runs, which it is set for no other. */
export const hostJobVariable = "CHUGGY_HOST_JOB";

/**
 * The askpass, the agents' binaries and the CA bundle of a core whose module
 * is at `moduleUrl`, run as `environment` says.
 *
 * @param {string} moduleUrl
 * @param {Readonly<Record<string, string | undefined>>} [environment]
 */
export function coreRuntimePaths(moduleUrl, environment = {}) {
  const core = dirname(fileURLToPath(moduleUrl));
  const tree = resolve(core, "..", "..");
  const hosted = environment[hostJobVariable] !== undefined;
  return {
    askpass: join(core, "git-askpass.sh"),
    claude: hosted ? "claude" : join(tree, "bin", "claude"),
    codex: hosted ? "codex" : join(tree, "bin", "codex"),
    certificates: hosted
      ? undefined
      : join(tree, "share", "ca-certificates.crt"),
  };
}

/** This core's own. */
export const coreRuntime = coreRuntimePaths(import.meta.url, process.env);
