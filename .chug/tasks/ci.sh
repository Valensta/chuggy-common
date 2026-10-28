#!/bin/sh
# The gate sequencer. `just check` is a thin wrapper around this, and the
# pre-commit hook calls the gates directly — the sequencing has one
# definition, here. Every gate runs on every run where no pass is reused: none
# is slow enough to be worth selecting around, and a selection would be a
# second thing to get wrong.
#
# THE PROTOCOL IS 0 clean, 1 finding, 2 could-not-run, and this script keeps the
# distinction all the way to its own exit. A gate that could not run is a
# failure here, reported under its own heading.
#
# THE CALL IS THE ROSTER. A gate named below must exist and be executable;
# absent or unexecutable, it is a could-not-run like any other.
# `check-contract.sh` is not named: it is `check-source.sh`'s precondition, and
# runs there.
#
# A PASS ON RECORD IS REUSED RATHER THAN RUN AGAIN, given a Track Record token
# and a `track-record` that runs. Every gate and every suite then runs under
# `track-record run`, keyed on every tracked file as it is on disk, npm's
# record of what it installed, the version of node and the salt below; a
# suite's key holds the platform too, and check-paths' the deleted paths it
# reads from history. The install record is what keeps check-contract the
# precondition it is: a pass of check-source is reused only where the release
# installed is the one the pass was keyed on. A key on record replays its log
# instead of running, only an exit of 0 is recorded, and a reused pass is
# counted as one. What no key sees, a reused pass does not check: a file
# outside the tree, a package changed under node_modules by hand, and git's
# own state but for check-paths' history. Without a token or a `track-record`
# that runs, or with TRACK_RECORD_OFF=1, nothing is wrapped and every gate runs
# itself.
#
# Env:
#   CHUG_CI_SHELL_SUITES=0        skip the shell-suite stage (set for the
#                                 suites themselves, so ci.test.sh cannot
#                                 recurse into a real run)
#   CHUG_CI_SUITE_TIMEOUT_SECS    per-suite cap, default 300
#   TRACK_RECORD_TOKEN, TRACK_RECORD_TOKEN_FILE
#                                 a Track Record token, or the file holding
#                                 one; either turns reuse on, and a file that
#                                 is missing or holds none does not
#   TRACK_RECORD_URL              the store, default https://track-record.vteng.io
#   TRACK_RECORD_NAMESPACE        the store's namespace, default chuggy
#   TRACK_RECORD_FRESH=1          look nothing up, and still record each pass
#   TRACK_RECORD_OFF=1            wrap nothing, though a token is set
set -eu
export LC_ALL=C

root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$root" ]; then
	echo "ci: LINTER ERROR — not a git checkout" >&2
	exit 2
fi
cd "$root" || exit 2

# Every key carries the salt, so a new value disowns every pass on record.
# The namespace is chuggy's, shared by the project's repositories under one
# token; the salt keeps this tree's keys its own.
record_salt="chuggy-common-ci-1"
record_tool_node="node --version"
record_tool_install="cat node_modules/.package-lock.json"
record=""
# A token is read as track-record reads one, so a variable naming a file that
# is not there wraps nothing rather than announcing reuse that cannot happen.
# The binary is probed functionally — `command -v` says it exists, not that
# it runs.
if [ "${TRACK_RECORD_OFF:-0}" != "1" ] &&
	{ [ -n "${TRACK_RECORD_TOKEN:-}" ] ||
		grep -q '[^[:space:]]' "${TRACK_RECORD_TOKEN_FILE:-/dev/null}" 2>/dev/null; } &&
	track-record --version >/dev/null 2>&1 &&
	record_dir="$(mktemp -d 2>/dev/null)"; then
	record=1
	trap 'rm -rf "$record_dir"' EXIT
	TRACK_RECORD_URL="${TRACK_RECORD_URL:-https://track-record.vteng.io}"
	TRACK_RECORD_NAMESPACE="${TRACK_RECORD_NAMESPACE:-chuggy}"
	export TRACK_RECORD_URL TRACK_RECORD_NAMESPACE
	if [ "${TRACK_RECORD_FRESH:-0}" = "1" ]; then
		echo "ci: every pass is recorded at $TRACK_RECORD_URL ($TRACK_RECORD_NAMESPACE), and none on record is reused"
	else
		echo "ci: a pass on record at $TRACK_RECORD_URL ($TRACK_RECORD_NAMESPACE) is reused"
	fi
fi

failed=0
errored=0
reused=0

# Whether the run whose stderr is in the file was a pass on record: on one,
# the command never ran, and track-record's line saying so is the last there.
record_reused() { # <name> <stderr file>
	case "$(tail -n 1 "$2" 2>/dev/null)" in
	"track-record: REUSED $1 ("*) return 0 ;;
	esac
	return 1
}

# Its stderr passes through as written and a copy is kept, from which
# `record_reused` reads; sets $rc and $record_hit.
record_gate() { # <label> <script> [args...]
	record_name="$1"
	shift
	case "$record_name" in
	check-paths) set -- --tool 'git log --no-renames --diff-filter=D --name-only --format=' -- "$@" ;;
	*) set -- -- "$@" ;;
	esac
	rm -f "$record_dir/rc"
	{
		{
			track-record run --name "$record_name" --tool "$record_tool_node" \
				--tool "$record_tool_install" --salt "$record_salt" "$@" 2>&1 1>&3 3>&-
			echo "$?" >"$record_dir/rc"
		} | tee "$record_dir/err" >&2
	} 3>&1
	rc="$(cat "$record_dir/rc" 2>/dev/null || echo 2)"
	record_hit=0
	if record_reused "$record_name" "$record_dir/err"; then record_hit=1; fi
}

run_gate() { # <label> <script> [args...]
	label="$1"
	shift
	printf '\n--- %s\n' "$label"
	if [ ! -x "$1" ]; then
		if [ -e "$1" ]; then why="is not executable"; else why="is missing"; fi
		echo "ci: LINTER ERROR — $1 $why; this is not a pass"
		errored=$((errored + 1))
		return 0
	fi
	set +e
	record_hit=0
	if [ -n "$record" ]; then
		record_gate "$label" "$@"
	else
		"$@"
		rc=$?
	fi
	set -e
	case "$rc" in
	0) reused=$((reused + record_hit)) ;;
	1)
		echo "ci: FAILED — $label"
		failed=$((failed + 1))
		;;
	*)
		echo "ci: LINTER ERROR ($rc) — $label could not run; this is not a pass"
		errored=$((errored + 1))
		;;
	esac
}

run_gate "check-paths" ./.chug/tasks/check-paths.sh
run_gate "check-duplication" ./.chug/tasks/check-duplication.sh

if [ "${CHUG_CI_SHELL_SUITES:-1}" = "0" ]; then
	printf '\n--- shell suites: SKIPPED (CHUG_CI_SHELL_SUITES=0)\n'
else
	printf '\n--- shell suites\n'
	suite_cap="${CHUG_CI_SUITE_TIMEOUT_SECS:-300}"

	# Probed functionally — `command -v` says a binary exists, not that it
	# runs. macOS ships no GNU `timeout`; `gtimeout` arrives with coreutils.
	# Its absence warns rather than errors: what the rule forbids is
	# announcing a bound that is not being applied, and the uncapped path says
	# exactly that.
	timeout_cmd=""
	if timeout 5 true >/dev/null 2>&1; then
		timeout_cmd="timeout"
	elif gtimeout 5 true >/dev/null 2>&1; then
		timeout_cmd="gtimeout"
	fi

	suites="$(git ls-files '*.test.sh' 2>/dev/null || true)"
	if [ -z "$suites" ]; then
		echo "ci: LINTER ERROR — no *.test.sh found; the suite glob matched nothing"
		errored=$((errored + 1))
	else
		if [ -n "$timeout_cmd" ]; then
			echo "ci: cap ${suite_cap}s per suite, no total"
		else
			echo "ci: WARNING — no working \`timeout\` or \`gtimeout\`, so suites run"
			echo "ci:           UNCAPPED. Install coreutils for the cap."
		fi
		# A suite's key takes the platform as well, since `sh` is not one
		# program everywhere. Its stderr is kept only when it is wrapped,
		# where track-record's last line there says whether it ran.
		suite_err=/dev/null
		if [ -n "$record" ]; then suite_err="$record_dir/err"; fi
		started="$(date +%s)"
		IFS='
'
		for suite in $suites; do
			printf '  - %s\n' "$suite"
			if [ -n "$record" ]; then
				set -- track-record run --name "$suite" --tool "$record_tool_node" \
					--tool "$record_tool_install" --salt "$record_salt" --platform -- sh "$suite"
			else
				set -- sh "$suite"
			fi
			set +e
			if [ -n "$timeout_cmd" ]; then
				CHUG_CI_SHELL_SUITES=0 "$timeout_cmd" "$suite_cap" "$@" >/dev/null 2>"$suite_err"
			else
				CHUG_CI_SHELL_SUITES=0 "$@" >/dev/null 2>"$suite_err"
			fi
			rc=$?
			set -e
			if [ "$rc" -eq 124 ] && [ -n "$timeout_cmd" ]; then
				echo "ci: FAILED — $suite ran past the ${suite_cap}s cap (CHUG_CI_SUITE_TIMEOUT_SECS); rerun with: sh $suite"
				failed=$((failed + 1))
			elif [ "$rc" -ne 0 ]; then
				echo "ci: FAILED — $suite (rc=$rc); rerun with: sh $suite"
				failed=$((failed + 1))
			elif [ -n "$record" ] && record_reused "$suite" "$suite_err"; then
				printf '    %s\n' "$(tail -n 1 "$suite_err")"
				reused=$((reused + 1))
			fi
		done
		unset IFS
		echo "ci: suites finished in $(( $(date +%s) - started ))s"
	fi
fi

run_gate "check-boundaries" ./.chug/tasks/check-boundaries.sh
run_gate "check-source" ./.chug/tasks/check-source.sh

printf '\n'
if [ "$errored" -gt 0 ]; then
	echo "ci: $errored gate(s) could not run, $failed failed"
	exit 2
fi
if [ "$failed" -gt 0 ]; then
	echo "ci: $failed gate(s) failed"
	exit 1
fi
if [ -n "$record" ]; then
	echo "ci: all gates clean ($reused reused)"
else
	echo "ci: all gates clean"
fi
