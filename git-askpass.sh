#!/bin/sh
# What git asks a credential of: the username, where the prompt begins as
# git's username prompt does, or the credential file's first line less its
# trailing whitespace, which is all of an answer git reads. Only the start of
# the prompt is read, because the rest names the remote, whose path may hold
# any word. Shell builtins only, because the image a job runs in need have
# nothing else.

case "$1" in
  Username*) printf '%s\n' "${CHUG_WORKER_GIT_CREDENTIAL_USERNAME:?}" ;;
  *)
    credential=
    { IFS= read -r credential || :; } <"${CHUG_WORKER_GIT_CREDENTIAL_FILE:?}" ||
      exit 1
    printf '%s\n' "${credential%"${credential##*[![:space:]]}"}"
    ;;
esac
