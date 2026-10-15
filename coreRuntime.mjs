/**
 * Where this core finds what it runs beside, read off where its own modules
 * sit rather than off PATH.
 *
 * THE CORE SITS IN `lib/chuggy/` OF A TREE WHOSE `bin/` HOLDS THE AGENTS. That
 * is chuggy's runtime tree, and it is also chuggy's worker image, where the
 * core is copied into npm's global `lib/` and the agents are installed into
 * the `bin/` beside it; so one derivation finds both.
 *
 * THAT `bin/` IS NEVER PUT ON PATH. In the runtime it holds chuggy's own node,
 * which would then be the node a project's checks and its agent's shell run.
 *
 * THE TREE'S `share/` HOLDS THE CA BUNDLE CODEX IS GIVEN, where the tree ships
 * one: chuggy's runtime does, and the worker image's npm tree does not.
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
