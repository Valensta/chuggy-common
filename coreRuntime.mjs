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
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The askpass and the agents' binaries of a core whose module is at `moduleUrl`. */
export function coreRuntimePaths(moduleUrl) {
  const core = dirname(fileURLToPath(moduleUrl));
  const bin = resolve(core, "..", "..", "bin");
  return {
    askpass: join(core, "git-askpass.sh"),
    claude: join(bin, "claude"),
    codex: join(bin, "codex"),
  };
}

/** This core's own. */
export const coreRuntime = coreRuntimePaths(import.meta.url);
