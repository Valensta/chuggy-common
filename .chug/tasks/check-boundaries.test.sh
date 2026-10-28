#!/bin/sh
# Shell test for check-boundaries.sh.
#
# EVERY RULE IN `.dependency-cruiser.cjs` GETS A TREE THAT VIOLATES IT. A rule
# that has never rejected anything is an unverified control, and the real tree
# passes, which is what a fixture carrying the violation is for. Each fixture
# copies the real config — a suite testing a config of its own invention would
# pass while this tree's rules were broken.
#
# A CASE NAMES ITS RULE WITH THE COLON THE REPORTER PRINTS AFTER IT. The bare
# name is a substring, and a rule renamed around it would satisfy the match and
# read as the rule working.
#
# Run:  .chug/tasks/check-boundaries.test.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/_suite.sh"
SUT="$HERE/check-boundaries.sh"
ROOT="$(cd "$HERE/../.." && pwd)"

R="$WORK/repo"

run_in() { # <dir>
	OUT="$WORK/.out"
	set +e
	(cd "$1" && "$SUT") >"$OUT" 2>&1
	RC=$?
	set -e
}

# A tree holding every package an image installs beside the harness. The tool
# and zod are this tree's own, linked rather than installed so the resolver is
# the one this tree pins; the contract and the globally installed packages are
# stand-ins of their names.
fixture() {
	rm -rf "$R"
	mkdir -p "$R/node_modules/@chuggy/worker-contract"
	cp "$ROOT/.dependency-cruiser.cjs" "$R/.dependency-cruiser.cjs"
	printf '%s\n' '{ "name": "fixture", "private": true, "type": "module" }' > "$R/package.json"
	ln -s "$ROOT/node_modules/.bin" "$R/node_modules/.bin"
	ln -s "$ROOT/node_modules/zod" "$R/node_modules/zod"
	printf '%s\n' '{ "name": "@chuggy/worker-contract", "type": "module", "exports": { "./wire": "./wire.js" } }' \
		> "$R/node_modules/@chuggy/worker-contract/package.json"
	printf '%s\n' 'export const wire = 1' > "$R/node_modules/@chuggy/worker-contract/wire.js"
	for installed in @anthropic-ai/claude-agent-sdk @modelcontextprotocol/sdk @anthropic-ai/claude-code @openai/codex; do
		mkdir -p "$R/node_modules/$installed"
		printf '{ "name": "%s", "type": "module", "exports": "./index.js" }\n' "$installed" > "$R/node_modules/$installed/package.json"
		printf '%s\n' 'export const x = 1' > "$R/node_modules/$installed/index.js"
	done
	git -C "$R" init -q -b main
	git -C "$R" config user.email t@example.com
	git -C "$R" config user.name t
}

# A module that names the contract and nothing else, for the cases whose
# violation is somewhere else.
harness_module() {
	printf '%s\n' 'import { wire } from "@chuggy/worker-contract/wire"' 'export const run = () => wire' > "$R/run.mjs"
}

seal() {
	git -C "$R" add -A
	run_in "$R"
}

# --- The gate's own contract -------------------------------------------------

run_in "$WORK"
check "outside a git checkout exits 2, not 0" 2 "$RC" "not a git checkout"

fixture
rm "$R/.dependency-cruiser.cjs"
harness_module
seal
check "no config exits 2, not 0" 2 "$RC" "there are no rules to apply"

fixture
seal
check "no module exits 2, not 0" 2 "$RC" "the graph would be empty"

fixture
rm "$R/node_modules/.bin"
harness_module
seal
check "no local depcruise exits 2, not 0" 2 "$RC" "no local depcruise"

# A tree that breaks no rule is clean, which is what makes every case below a
# statement about the rule rather than about the fixture.
fixture
printf '%s\n' 'export const x = 1' > "$R/a.mjs"
printf '%s\n' 'import { x } from "./a.mjs"' 'export const y = x' > "$R/b.mjs"
seal
check "a clean graph passes" 0 "$RC" "graph clean"
check "the clean line counts the modules cruised" 0 "$RC" "across 2 module(s)"

# --- harness-reaches-only-the-contract ----------------------------------------

# Every exit the harness has. A red here would mean a rule below over-fires on
# the imports a pod is built from.
fixture
printf '%s\n' 'import { wire } from "@chuggy/worker-contract/wire"' 'import { join } from "node:path"' 'import { z } from "zod"' 'import { x as sdk } from "@anthropic-ai/claude-agent-sdk"' 'import { x as mcp } from "@modelcontextprotocol/sdk"' 'import { x as code } from "@anthropic-ai/claude-code"' 'import { x as codex } from "@openai/codex"' 'export const run = () => join(String(wire), String(z), String(sdk + mcp + code + codex))' > "$R/run.mjs"
seal
check "the harness may name the contract, a platform module and every package an image installs" 0 "$RC" "graph clean"

fixture
ln -s "$ROOT/node_modules/typescript" "$R/node_modules/typescript"
printf '%s\n' 'import { wire } from "@chuggy/worker-contract/wire"' 'import ts from "typescript"' 'export const run = () => String(ts) + wire' > "$R/run.mjs"
seal
check "the harness may not name a devDependency" 1 "$RC" "harness-reaches-only-the-contract:"

# An image runs the suites too.
fixture
harness_module
ln -s "$ROOT/node_modules/typescript" "$R/node_modules/typescript"
printf '%s\n' 'import { run } from "./run.mjs"' 'import ts from "typescript"' 'export const z = String(ts) + run()' > "$R/run.test.mjs"
seal
check "a suite may not name a devDependency either" 1 "$RC" "harness-reaches-only-the-contract:"

# The lazy import of a literal is an edge like any other.
fixture
ln -s "$ROOT/node_modules/typescript" "$R/node_modules/typescript"
printf '%s\n' 'import { wire } from "@chuggy/worker-contract/wire"' 'export const run = async () => String(await import("typescript")) + wire' > "$R/run.mjs"
seal
check "a dynamic import of a devDependency is a finding" 1 "$RC" "harness-reaches-only-the-contract:"

# A module that is not a root `.mjs` is not the harness's, so the edge to it is
# the finding, whatever it goes on to reach.
fixture
harness_module
mkdir -p "$R/lib"
printf '%s\n' 'import { run } from "../run.mjs"' 'export const helper = run' > "$R/lib/helper.mjs"
printf '%s\n' 'import { helper } from "./lib/helper.mjs"' 'export const z = helper' > "$R/b.mjs"
seal
check "the harness may not reach a module outside the root" 1 "$RC" "harness-reaches-only-the-contract:"

fixture
harness_module
printf '%s\n' 'import { run } from "./run.mjs"' 'export const relay = run' > "$R/relay.js"
printf '%s\n' 'import { relay } from "./relay.js"' 'export const z = relay' > "$R/b.mjs"
seal
check "the harness may not reach a root module that is not its own" 1 "$RC" "harness-reaches-only-the-contract:"

# --- harness-names-packages-by-name -------------------------------------------

fixture
printf '%s\n' 'import { wire } from "./node_modules/@chuggy/worker-contract/wire.js"' 'export const run = () => wire' > "$R/run.mjs"
seal
check "the harness may not reach a package by a path an image lacks" 1 "$RC" "harness-names-packages-by-name:"

# --- harness-resolves-every-import --------------------------------------------

# The contract gone, as an install that skipped it would leave it.
fixture
rm -r "$R/node_modules/@chuggy"
harness_module
seal
check "an import the harness cannot resolve is a finding" 1 "$RC" "harness-resolves-every-import:"

# --- The whole graph ----------------------------------------------------------

fixture
printf '%s\n' 'import { y } from "./b.mjs"' 'export const x = () => y' > "$R/a.mjs"
printf '%s\n' 'import { x } from "./a.mjs"' 'export const y = () => x' > "$R/b.mjs"
seal
check "a cycle is a finding" 1 "$RC" "no-circular-dependency:"

fixture
harness_module
printf '%s\n' 'export const orphaned = 1' > "$R/orphan.mjs"
seal
check "an orphan module is a finding" 1 "$RC" "no-orphan-module:"

done_ "check-boundaries.test.sh"
