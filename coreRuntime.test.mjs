import assert from "node:assert/strict";
import { access, constants } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { claudeAgent } from "./claude.mjs";
import { codexAgent } from "./codex.mjs";
import { coreRuntime, coreRuntimePaths } from "./coreRuntime.mjs";

/**
 * Catches a derivation that finds the runtime's agents and loses the ones
 * chuggy's worker image installs, which is every pod running today's image.
 */
test("a core where chuggy's worker image copies it finds the agents npm installed beside it", () => {
  assert.deepEqual(
    coreRuntimePaths("file:///usr/local/lib/chuggy/coreRuntime.mjs"),
    {
      askpass: "/usr/local/lib/chuggy/git-askpass.sh",
      claude: "/usr/local/bin/claude",
      codex: "/usr/local/bin/codex",
    },
  );
});

/** Catches a derivation that reaches past the runtime it was mounted in. */
test("a core in chuggy's runtime finds the agents in the runtime's own bin", () => {
  assert.deepEqual(
    coreRuntimePaths("file:///opt/chuggy/lib/chuggy/coreRuntime.mjs"),
    {
      askpass: "/opt/chuggy/lib/chuggy/git-askpass.sh",
      claude: "/opt/chuggy/bin/claude",
      codex: "/opt/chuggy/bin/codex",
    },
  );
});

/** Catches an askpass named anywhere but beside the modules that hand it to git. */
test("this core's askpass is the one shipped beside its modules", async () => {
  assert.equal(
    coreRuntime.askpass,
    fileURLToPath(new URL("./git-askpass.sh", import.meta.url)),
  );
  await access(coreRuntime.askpass, constants.R_OK);
});

/** Catches an agent found by PATH, where the project's image decides which binary answers. */
test("each agent is spawned by its path in the runtime", () => {
  assert.equal(claudeAgent.executable, coreRuntime.claude);
  assert.equal(codexAgent.executable, coreRuntime.codex);
});
