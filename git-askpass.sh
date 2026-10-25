#!/bin/sh
# What git asks a credential of, answered only for the host it is for,
# `CHUG_WORKER_GIT_CREDENTIAL_HOST`, port and all: the username, where the
# prompt begins as git's username prompt does, or the credential file's first
# line less its trailing whitespace, which is all of an answer git reads. A
# prompt naming any other host, or none, is answered nothing. The host is read
# from the URL the prompt quotes, past its scheme and any user and before its
# path, query or fragment, and the prompt's kind only from its start, because
# the path names the remote and may hold any word. Shell builtins only,
# because the image a job runs in need have nothing else.

case "$1" in
  "Username for '"*"': " | "Password for '"*"': ") ;;
  *) exit 1 ;;
esac
remote=${1#*"'"}
remote=${remote%"'"*}
case "$remote" in
  *://*) ;;
  *) exit 1 ;;
esac
host=${remote#*://}
host=${host%%[/?#]*}
host=${host##*@}
[ "$host" = "${CHUG_WORKER_GIT_CREDENTIAL_HOST:?}" ] || exit 1

case "$1" in
  Username*) printf '%s\n' "${CHUG_WORKER_GIT_CREDENTIAL_USERNAME:?}" ;;
  *)
    credential=
    { IFS= read -r credential || :; } <"${CHUG_WORKER_GIT_CREDENTIAL_FILE:?}" ||
      exit 1
    printf '%s\n' "${credential%"${credential##*[![:space:]]}"}"
    ;;
esac
