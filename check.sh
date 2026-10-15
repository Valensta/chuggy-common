#!/bin/sh
# What a job container runs first, in the project's own image and before
# chuggy's node: whether the image can run a job, then the worker core. An
# image that cannot is named by the first thing it lacks, in one line on
# stderr and in an exit status kept for that fault alone, which is what a site
# reads the fault from. Nothing else here exits with one of those statuses.
#
# THE RUNTIME IS WHERE THIS SCRIPT IS. Its `bin/` holds chuggy's node and
# claude, and its `lib/chuggy/` the core, which finds the same `bin/` from
# where it sits; that `bin/` is never put on PATH, so the node a project's
# shells find is still the image's own. A runtime that is not whole is the
# site's fault and not the image's, and exits with no fault's status.
#
# WHAT WOULD STEER CHUGGY'S OWN PROCESSES IS MOVED ASIDE FIRST: each variable
# `workerImageSteeringVariables` in `checks.mjs` names is unset, and its value
# kept under the name `workerImageVariable` gives it, from which the core
# hands it back to the project's own shells.
#
# POSIX sh and its builtins only: nothing is known of the image yet but that
# it has a /bin/sh, which may be dash or busybox's.
#
# Usage:
#   /bin/sh <runtime>/check.sh           check, then start the core
#   /bin/sh <runtime>/check.sh check     check, and exit 0 where it passes
set -u

case "$#:${1-}" in
0:) start=yes ;;
1:check) start=no ;;
*)
	printf 'usage: /bin/sh %s [check]\n' "$0" >&2
	exit 2
	;;
esac

case "$0" in
*/*) runtime="${0%/*}" ;;
*) runtime=. ;;
esac

for name in NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT; do
	if eval "[ -n \"\${$name+set}\" ]"; then
		eval "export CHUG_IMAGE_$name=\"\$$name\""
		unset "$name"
	else
		unset "CHUG_IMAGE_$name"
	fi
done

fault() { # <status> <line>
	printf 'chuggy: %s\n' "$2" >&2
	exit "$1"
}

writable() { # <directory>
	[ -d "$1" ] && [ -w "$1" ] && [ -x "$1" ]
}

for binary in node claude; do
	if [ ! -f "$runtime/bin/$binary" ] || [ ! -x "$runtime/bin/$binary" ]; then
		fault 1 "the runtime at $runtime holds no $binary this container can execute"
	fi
done

"$runtime/bin/node" --version >/dev/null ||
	fault 81 "this image cannot load chuggy's node, which needs the image's glibc and libstdc++"
"$runtime/bin/claude" --version >/dev/null ||
	fault 81 "this image cannot load chuggy's claude, which needs the image's glibc"
command -v git >/dev/null 2>&1 ||
	fault 82 "this image has no git on PATH"
git --version >/dev/null ||
	fault 82 "this image's git does not run"
[ -n "${HOME-}" ] ||
	fault 83 "this image sets no HOME"
writable "$HOME" ||
	fault 83 "HOME, $HOME, is not a directory this user can write"
workspace="${CHUG_WORKER_WORKSPACE:-/workspace}"
writable "$workspace" ||
	fault 84 "the workspace, $workspace, is not a directory this user can write"

if [ "$start" = no ]; then
	printf 'chuggy: this image can run a job\n'
	exit 0
fi
exec "$runtime/bin/node" "$runtime/lib/chuggy/worker.mjs"
