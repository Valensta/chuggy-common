#!/bin/sh
# What a job container runs first, in the project's own image and before
# chuggy's node: whether the image can run a job, then the worker core. An
# image that cannot is named by the first thing it lacks, in one line on
# stderr and in an exit status kept for that fault alone, which is what a site
# reads the fault from. Nothing else here exits with one of those statuses.
#
# THE RUNTIME IS WHERE THIS SCRIPT IS. Its `bin/` holds chuggy's node, claude
# and tini, and its `lib/chuggy/` the core, which finds the same `bin/` from
# where it sits; that `bin/` is never put on PATH, so the node a project's
# shells find is still the image's own. A runtime that is not whole is the
# site's fault and not the image's, and exits with no fault's status.
#
# THE CORE RUNS UNDER TINI, so what is orphaned in the job is reaped and a
# signal the container is sent ends node as it would any process; node as the
# container's first process does neither. Tini is told to be a subreaper, so it
# reaps them where an engine's own init is that first process instead.
#
# WHAT WOULD STEER CHUGGY'S OWN PROCESSES IS MOVED ASIDE FIRST: each variable
# `workerImageSteeringVariables` in `checks.mjs` names is unset, and its value
# kept under the name `workerImageVariable` gives it, from which the core
# hands it back to the project's own shells.
#
# EVERY NAME THIS SCRIPT ASSIGNS STARTS `chuggy_check_`. A variable the image
# exported under a name the script assigns would be overwritten in place, and
# the overwritten value is the one the core would inherit.
#
# POSIX sh and its builtins only: nothing is known of the image yet but that
# it has a /bin/sh, which may be dash or busybox's.
#
# Usage:
#   /bin/sh <runtime>/check.sh           check, then start the core
#   /bin/sh <runtime>/check.sh check     check, and exit 0 where it passes
set -u

case "$#:${1-}" in
0:) chuggy_check_start=yes ;;
1:check) chuggy_check_start=no ;;
*)
	printf 'usage: /bin/sh %s [check]\n' "$0" >&2
	exit 2
	;;
esac

case "$0" in
*/*) chuggy_check_runtime="${0%/*}" ;;
*) chuggy_check_runtime=. ;;
esac

for chuggy_check_name in NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT; do
	if eval "[ -n \"\${$chuggy_check_name+set}\" ]"; then
		eval "export CHUG_IMAGE_$chuggy_check_name=\"\$$chuggy_check_name\""
		unset "$chuggy_check_name"
	else
		unset "CHUG_IMAGE_$chuggy_check_name"
	fi
done

fault() { # <status> <line>
	printf 'chuggy: %s\n' "$2" >&2
	exit "$1"
}

writable() { # <directory>
	[ -d "$1" ] && [ -w "$1" ] && [ -x "$1" ]
}

for chuggy_check_binary in node claude tini; do
	if [ ! -f "$chuggy_check_runtime/bin/$chuggy_check_binary" ] ||
		[ ! -x "$chuggy_check_runtime/bin/$chuggy_check_binary" ]; then
		fault 1 "the runtime at $chuggy_check_runtime holds no $chuggy_check_binary this container can execute"
	fi
done

"$chuggy_check_runtime/bin/node" --version >/dev/null ||
	fault 81 "this image cannot load chuggy's node, which needs the image's glibc and libstdc++"
"$chuggy_check_runtime/bin/claude" --version >/dev/null ||
	fault 81 "this image cannot load chuggy's claude, which needs the image's glibc"
command -v git >/dev/null 2>&1 ||
	fault 82 "this image has no git on PATH"
git --version >/dev/null ||
	fault 82 "this image's git does not run"
[ -n "${HOME-}" ] ||
	fault 83 "this image sets no HOME"
writable "$HOME" ||
	fault 83 "HOME, $HOME, is not a directory this user can write"
chuggy_check_workspace="${CHUG_WORKER_WORKSPACE:-/workspace}"
writable "$chuggy_check_workspace" ||
	fault 84 "the workspace, $chuggy_check_workspace, is not a directory this user can write"
chuggy_check_temporary="${TMPDIR:-/tmp}"
writable "$chuggy_check_temporary" ||
	fault 85 "the temporary directory, $chuggy_check_temporary, is not a directory this user can write"

if [ "$chuggy_check_start" = no ]; then
	printf 'chuggy: this image can run a job\n'
	exit 0
fi
exec "$chuggy_check_runtime/bin/tini" -s -- \
	"$chuggy_check_runtime/bin/node" "$chuggy_check_runtime/lib/chuggy/worker.mjs"
