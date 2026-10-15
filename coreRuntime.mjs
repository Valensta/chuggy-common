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
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The askpass, the agents' binaries and the CA bundle of a core whose module is at `moduleUrl`. */
export function coreRuntimePaths(moduleUrl) {
  const core = dirname(fileURLToPath(moduleUrl));
  const tree = resolve(core, "..", "..");
  return {
    askpass: join(core, "git-askpass.sh"),
    claude: join(tree, "bin", "claude"),
    codex: join(tree, "bin", "codex"),
    certificates: join(tree, "share", "ca-certificates.crt"),
  };
}

/** This core's own. */
export const coreRuntime = coreRuntimePaths(import.meta.url);
