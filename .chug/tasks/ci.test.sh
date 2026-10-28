#!/bin/sh
# Shell test for ci.sh — the sequencer's own behaviour, not the gates'.
#
# Cases run against throwaway repos holding stub gates with controllable exit
# codes: what is under test is how ci.sh *treats* a verdict — that a finding
# and a could-not-run stay different answers all the way to its own exit code,
# that the only time bound on the suites is each one's own cap, and that a pass
# on record is reused only where its key still holds.
#
# The fixture carries a stub for every gate the sequencer names, because a
# named gate that is absent is itself a could-not-run. A fixture short of one
# would exercise that rather than the case it was written for.
#
# Run:  .chug/tasks/ci.test.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/_suite.sh"
SUT="$HERE/ci.sh"
BARE="$(mktemp -d)"
trap 'rm -rf "$WORK" "$BARE"' EXIT

R="$WORK/repo"

# No case inherits a sequencer input it did not choose, less
# CHUG_CI_SHELL_SUITES — the recursion guard, which each case that reaches the
# suite stage sets for itself.
unset CHUG_CI_SUITE_TIMEOUT_SECS TRACK_RECORD_TOKEN TRACK_RECORD_TOKEN_FILE \
	TRACK_RECORD_URL TRACK_RECORD_NAMESPACE TRACK_RECORD_FRESH TRACK_RECORD_OFF

ROOT="$(cd "$HERE/../.." && pwd)"
grep -F '    ./.chug/tasks/ci.sh' "$ROOT/justfile" >/dev/null

# Read off the sequencer rather than listed here: the roster is the calls, and
# a second copy of it would be the half that drifts.
named_gates() { # <script> — the gates it calls, by bare name
	grep -o '\./\.chug/tasks/[a-z-]*\.sh' "$1" | sed 's|.*/||; s|\.sh$||'
}

# An empty roster would leave every case below passing against a repo with no
# gates at all — the exact reading this suite exists to refuse.
if [ -z "$(named_gates "$SUT")" ]; then
	echo "ci.test.sh: no gate calls found in $SUT; the fixture would stub nothing"
	exit 2
fi

stub_repo() { # <exit> — every named gate stubbed clean but check-paths
	fresh_repo "$R"
	mkdir -p "$R/.chug/tasks"
	cp "$SUT" "$R/.chug/tasks/ci.sh"
	chmod +x "$R/.chug/tasks/ci.sh"
	for gate in $(named_gates "$SUT"); do
		printf '#!/bin/sh\necho stub %s\nexit 0\n' "$gate" > "$R/.chug/tasks/$gate.sh"
		chmod +x "$R/.chug/tasks/$gate.sh"
	done
	printf '#!/bin/sh\necho stub check-paths\nexit %s\n' "$1" > "$R/.chug/tasks/check-paths.sh"
	chmod +x "$R/.chug/tasks/check-paths.sh"
	git -C "$R" add -A
}

# The gate stage alone: with the suite stage on, the fixture's empty suite glob
# would add a second could-not-run and the counts below would stop being about
# the roster.
run_gates_only() {
	OUT="$WORK/.out"
	set +e
	(cd "$R" && CHUG_CI_SHELL_SUITES=0 ./.chug/tasks/ci.sh) >"$OUT" 2>&1
	RC=$?
	set -e
}

# The real ci.sh hands every suite CHUG_CI_SHELL_SUITES=0 so this file cannot
# recurse into a live run. That guard is inherited here and would skip the
# suite stage in the cases that exist to exercise it, so they set it back
# explicitly; recursion stays bounded because the stub ci.sh under test passes
# the guard down to its own stub suites.
run_ci() {
	OUT="$WORK/.out"
	set +e
	(cd "$R" && CHUG_CI_SHELL_SUITES=1 ./.chug/tasks/ci.sh) >"$OUT" 2>&1
	RC=$?
	set -e
}

stub_repo 0
run_gates_only
check "all gates clean exits 0" 0 "$RC" "all gates clean"
check "CHUG_CI_SHELL_SUITES=0 skips the suite stage" 0 "$RC" "SKIPPED"
for gate in $(named_gates "$SUT"); do
	check "every run runs $gate" 0 "$RC" "stub $gate"
done

stub_repo 1
run_gates_only
check "a gate finding exits 1" 1 "$RC" "1 gate(s) failed"

# A gate that could not run exits 2, NOT 1 and never 0.
stub_repo 2
run_gates_only
check "a gate that could not run exits 2" 2 "$RC" "could not run"
check "could-not-run is reported as not a pass" 2 "$RC" "this is not a pass"

# A gate the sequencer names but the tree does not carry is a could-not-run
# too, or it would print "all gates clean" having never attempted the gate.
stub_repo 0
rm -f "$R/.chug/tasks/check-boundaries.sh"
git -C "$R" add -A
run_gates_only
check "a missing named gate exits 2, not 0" 2 "$RC" "1 gate(s) could not run"
check "the missing gate is named" 2 "$RC" "check-boundaries.sh is missing"

# The half a diff hides in a mode line.
stub_repo 0
chmod -x "$R/.chug/tasks/check-source.sh"
git -C "$R" add -A
run_gates_only
check "a non-executable named gate exits 2, not 0" 2 "$RC" "1 gate(s) could not run"
check "the non-executable gate is named" 2 "$RC" "check-source.sh is not executable"

stub_repo 0
printf '#!/bin/sh\nexit 1\n' > "$R/.chug/tasks/failing.test.sh"
chmod +x "$R/.chug/tasks/failing.test.sh"
git -C "$R" add -A
run_ci
check "a failing suite fails the run" 1 "$RC" "failing.test.sh"

stub_repo 0
printf '#!/bin/sh\nexit 0\n' > "$R/.chug/tasks/passing.test.sh"
chmod +x "$R/.chug/tasks/passing.test.sh"
git -C "$R" add -A
run_ci
check "a passing suite leaves the run clean" 0 "$RC" "all gates clean"

# The stage has no total: a clock that reads an hour later every time it is
# asked stops no suite, so a slower machine runs them all.
stub_repo 0
for suite in one two; do
	printf '#!/bin/sh\ntouch "%s/ran-%s"\n' "$WORK" "$suite" > "$R/.chug/tasks/$suite.test.sh"
done
mkdir -p "$WORK/clock"
printf '#!/bin/sh\nn="$(cat "%s/hours" 2>/dev/null || echo 0)"\necho $((n + 1)) > "%s/hours"\necho $((n * 3600))\n' \
	"$WORK/clock" "$WORK/clock" > "$WORK/clock/date"
chmod +x "$WORK/clock/date"
git -C "$R" add -A
OUT="$WORK/.out"
set +e
(cd "$R" && PATH="$WORK/clock:$PATH" CHUG_CI_SHELL_SUITES=1 ./.chug/tasks/ci.sh) >"$OUT" 2>&1
RC=$?
set -e
ls "$WORK" >>"$OUT"
check "hours between suites stop none of them" 0 "$RC" "all gates clean"
check "the first suite ran" 0 "$RC" "ran-one"
check "the last suite ran" 0 "$RC" "ran-two"
check "the stage states the one bound it applies" 0 "$RC" "per suite, no total"

# A suite past its own cap is stopped and fails the run by name.
stub_repo 0
printf '#!/bin/sh\nexec sleep 5\n' > "$R/.chug/tasks/slow.test.sh"
git -C "$R" add -A
OUT="$WORK/.out"
set +e
(cd "$R" && CHUG_CI_SHELL_SUITES=1 CHUG_CI_SUITE_TIMEOUT_SECS=1 \
	./.chug/tasks/ci.sh) >"$OUT" 2>&1
RC=$?
set -e
check "a suite past its cap fails the run" 1 "$RC" "slow.test.sh ran past the 1s cap"

# A glob matching nothing must not read as "the suites passed".
stub_repo 0
run_ci
check "no suites found exits 2, not 0" 2 "$RC" "matched nothing"

# A PASS ON RECORD IS REUSED RATHER THAN RUN AGAIN. The stub stands in for
# track-record: it answers the probe with STUB_TR_VERSION_RC and logs each
# call's arguments and the store's variables it was handed. It keys each call
# on its arguments, what each tool prints and every tracked file as it is on
# disk, and neither looks up nor records where a tool fails; it replays a pass
# on record unless TRACK_RECORD_FRESH=1, and records an exit of 0.
TRBIN="$WORK/trbin"
TRLOG="$WORK/tr.log"
STORE="$WORK/store"
mkdir -p "$TRBIN"
cat > "$TRBIN/track-record" <<'STUB'
#!/bin/sh
if [ "$1" = "--version" ]; then exit "${STUB_TR_VERSION_RC:-0}"; fi
{
	printf '%s|' "$@"
	printf '\n'
	printf 'env|FRESH=%s|URL=%s|NAMESPACE=%s|\n' "${TRACK_RECORD_FRESH-unset}" \
		"${TRACK_RECORD_URL-unset}" "${TRACK_RECORD_NAMESPACE-unset}"
} >>"$STUB_TR_LOG"
material="$STUB_TR_LOG.material"
printf '%s\n' "$@" >"$material"
name=""
keyed=1
while [ "$#" -gt 0 ]; do
	case "$1" in
	--) shift; break ;;
	--name) name="$2"; shift 2 ;;
	--tool) sh -c "$2" >>"$material" 2>&1 || keyed=0; shift 2 ;;
	--salt) shift 2 ;;
	*) shift ;;
	esac
done
git ls-files -s >>"$material"
git ls-files | while IFS= read -r file; do cksum <"$file"; done >>"$material"
key="$(cksum <"$material" | cut -d' ' -f1)"
if [ "$keyed" = 1 ] && [ "${TRACK_RECORD_FRESH:-0}" != 1 ] && [ -e "$STUB_TR_STORE/$key" ]; then
	echo "stub log replayed for $name"
	echo "track-record: REUSED $name (recorded 2026-01-01T00:00:00Z by stub)" >&2
	exit 0
fi
"$@"
rc=$?
if [ "$rc" -eq 0 ] && [ "$keyed" = 1 ]; then : >"$STUB_TR_STORE/$key"; fi
exit "$rc"
STUB
chmod +x "$TRBIN/track-record"
salt="$(sed -n 's/^record_salt="\(.*\)"$/\1/p' "$SUT")"
record_tool_node="" record_tool_install=""
eval "$(sed -n '/^record_tool_[a-z]*="[^"]*"$/p' "$SUT")"
[ -n "$salt" ] && [ -n "$record_tool_node" ] && [ -n "$record_tool_install" ]
gate_calls="$(named_gates "$SUT" | wc -l | tr -d ' ')"

# The stub repo with npm's record of an install, which git does not track, and
# a commit, without which check-paths' history cannot be read into its key.
stub_installed() {
	stub_repo 0
	mkdir -p "$R/node_modules"
	echo '{"packages":{"node_modules/@chuggy/worker-contract":{"version":"1"}}}' \
		> "$R/node_modules/.package-lock.json"
	echo node_modules > "$R/.gitignore"
	git -C "$R" add -A
	git -C "$R" commit -qm fixture
	rm -rf "$STORE"
	mkdir -p "$STORE"
}

# A run with the stub first on PATH and whatever VAR=value the case names; the
# token is the case's to give.
run_recorded() { # [VAR=value...]
	OUT="$WORK/.out"
	: > "$TRLOG"
	set +e
	(cd "$R" && env PATH="$TRBIN:$PATH" STUB_TR_LOG="$TRLOG" STUB_TR_STORE="$STORE" \
		CHUG_CI_SHELL_SUITES=0 "$@" ./.chug/tasks/ci.sh) >"$OUT" 2>&1
	RC=$?
	set -e
}
# The log as $OUT, with the calls counted into it.
recorded_log() {
	cp "$TRLOG" "$WORK/.log"
	printf 'calls %s\n' "$(grep -c '^run|' "$TRLOG" || true)" >> "$WORK/.log"
	OUT="$WORK/.log"
}

# Without a token, with a token file that is missing or holds none, with a
# track-record that does not run, and with TRACK_RECORD_OFF=1, the run is the
# one it is with no track-record at all, and every gate runs itself.
stub_installed
run_gates_only
cp "$OUT" "$WORK/.plain"
printf ' \n' > "$WORK/blank-token"
for case in "no token|" "a token file that is not there|TRACK_RECORD_TOKEN_FILE=$WORK/absent-token" \
	"a token file that holds none|TRACK_RECORD_TOKEN_FILE=$WORK/blank-token" \
	"a track-record that does not run|TRACK_RECORD_TOKEN=t STUB_TR_VERSION_RC=1" \
	"TRACK_RECORD_OFF=1|TRACK_RECORD_TOKEN=t TRACK_RECORD_OFF=1"; do
	# shellcheck disable=SC2086 # the case's assignments are words by construction
	run_recorded ${case#*|}
	for gate in $(named_gates "$SUT"); do
		check "${case%%|*} runs $gate" 0 "$RC" "stub $gate"
	done
	if cmp -s "$OUT" "$WORK/.plain"; then echo "same output" >> "$OUT"; fi
	check "${case%%|*} leaves the run as it is with no track-record" 0 "$RC" "same output"
	recorded_log
	check "${case%%|*} wraps nothing" 0 "$RC" "calls 0"
done

# A token, in the variable or in a file, wraps every gate once, named by its
# label and keyed on node, the install record and the salt, and never on the
# platform; check-paths also on the paths history deleted. The store defaults
# to the shared one, under chuggy's namespace.
printf 'trk_stub\n' > "$WORK/token"
stub_installed
run_recorded TRACK_RECORD_TOKEN_FILE="$WORK/token"
check "a token file wraps the run" 0 "$RC" "a pass on record at https://track-record.vteng.io (chuggy) is reused"
check "a first wrapped run reuses nothing" 0 "$RC" "ci: all gates clean (0 reused)"
for gate in $(named_gates "$SUT"); do
	check "a first wrapped run runs $gate" 0 "$RC" "stub $gate"
done
recorded_log
check "every gate is wrapped once" 0 "$RC" "calls $gate_calls"
refute "no gate is keyed on the platform" 0 "$RC" "|--platform|"
check "the store defaults to the shared one" 0 "$RC" "env|FRESH=unset|URL=https://track-record.vteng.io|NAMESPACE=chuggy|"
common="--tool|$record_tool_node|--tool|$record_tool_install|--salt|$salt|"
check "check-source is keyed on the tree, node, the install and the salt" 0 "$RC" \
	"run|--name|check-source|$common--|./.chug/tasks/check-source.sh|"
check "check-paths is keyed on deleted paths too" 0 "$RC" \
	"run|--name|check-paths|$common--tool|git log --no-renames --diff-filter=D --name-only --format=|--|./.chug/tasks/check-paths.sh|"

# Each pass was recorded, so the same tree reuses every one of them and runs
# no gate.
run_recorded TRACK_RECORD_TOKEN=t
check "a pass on record is reused" 0 "$RC" "ci: all gates clean ($gate_calls reused)"
for gate in $(named_gates "$SUT"); do
	refute "a reused $gate does not run" 0 "$RC" "stub $gate"
	check "a reused $gate's log is printed" 0 "$RC" "stub log replayed for $gate"
done

# A tracked file changed, or a different install, is a key not on record.
echo "# changed" >> "$R/.gitignore"
run_recorded TRACK_RECORD_TOKEN=t
check "a changed tree runs every gate again" 0 "$RC" "ci: all gates clean (0 reused)"
echo '{"packages":{"node_modules/@chuggy/worker-contract":{"link":true}}}' \
	> "$R/node_modules/.package-lock.json"
run_recorded TRACK_RECORD_TOKEN=t
check "a different install runs check-source again" 0 "$RC" "stub check-source"
check "a different install reuses nothing" 0 "$RC" "ci: all gates clean (0 reused)"

# Without the install record the key cannot be made: nothing is reused or
# recorded, and every gate runs.
rm -f "$R/node_modules/.package-lock.json"
run_recorded TRACK_RECORD_TOKEN=t
run_recorded TRACK_RECORD_TOKEN=t
check "no install record runs every gate every time" 0 "$RC" "ci: all gates clean (0 reused)"

# TRACK_RECORD_FRESH=1 looks nothing up and still records.
stub_installed
run_recorded TRACK_RECORD_TOKEN=t TRACK_RECORD_FRESH=1
check "a fresh run says it reuses nothing" 0 "$RC" "and none on record is reused"
run_recorded TRACK_RECORD_TOKEN=t TRACK_RECORD_FRESH=1
check "a fresh run runs a gate on record" 0 "$RC" "stub check-source"
run_recorded TRACK_RECORD_TOKEN=t
check "a fresh run's passes are recorded" 0 "$RC" "ci: all gates clean ($gate_calls reused)"

run_recorded TRACK_RECORD_TOKEN=t TRACK_RECORD_URL=http://store.test TRACK_RECORD_NAMESPACE=elsewhere
recorded_log
check "the store and namespace can be named" 0 "$RC" "env|FRESH=unset|URL=http://store.test|NAMESPACE=elsewhere|"

# Only a pass is recorded: a finding runs again, and keeps its exit.
stub_installed
printf '#!/bin/sh\necho stub check-paths\nexit 1\n' > "$R/.chug/tasks/check-paths.sh"
git -C "$R" add -A
run_recorded TRACK_RECORD_TOKEN=t
run_recorded TRACK_RECORD_TOKEN=t
check "a finding is not recorded and fails the run again" 1 "$RC" "stub check-paths"
check "a wrapped finding is still a finding" 1 "$RC" "ci: FAILED — check-paths"

# A suite is wrapped too, keyed on the platform as well, and a reused one is
# counted and says so.
stub_installed
printf '#!/bin/sh\ntouch "%s/ran-passing"\n' "$WORK" > "$R/.chug/tasks/passing.test.sh"
git -C "$R" add -A
run_recorded TRACK_RECORD_TOKEN=t CHUG_CI_SHELL_SUITES=1
recorded_log
check "a suite is wrapped, keyed on the platform" 0 "$RC" \
	"run|--name|.chug/tasks/passing.test.sh|$common--platform|--|sh|.chug/tasks/passing.test.sh|"
rm -f "$WORK/ran-passing"
run_recorded TRACK_RECORD_TOKEN=t CHUG_CI_SHELL_SUITES=1
check "a reused suite says so" 0 "$RC" "    track-record: REUSED .chug/tasks/passing.test.sh (recorded"
check "a reused suite is counted" 0 "$RC" "ci: all gates clean ($((gate_calls + 1)) reused)"
ls "$WORK" >> "$OUT"
refute "a reused suite does not run" 0 "$RC" "ran-passing"

OUT="$BARE/.out"
set +e
(cd "$BARE" && "$SUT") >"$OUT" 2>&1
RC=$?
set -e
check "outside a git checkout exits 2, not 0" 2 "$RC" "LINTER ERROR"

done_ "ci.test.sh"
