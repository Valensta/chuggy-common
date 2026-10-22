/**
 * Git's reach of a remote, tried again where git says its transport failed and
 * never where the remote refused.
 *
 * A REFUSAL IS FINAL. A remote that denied the credential, refused the ref or
 * declined the push answers the same on every try, so a failure naming one is
 * not tried again, whatever else it names. A failure naming git's own
 * transport is tried again; anything else, a hook's included, is final.
 *
 * WHAT IS READ IS GIT'S STANDARD ERROR. A failure carrying none, a child that
 * could not start among them, is final.
 */

import { setTimeout as delay } from "node:timers/promises";

/** How many times one reach of a remote is tried, the first included. */
export const gitRemoteTriesMax = 4;

/** The pause before the second try, doubled before each try after it. */
export const gitRemotePauseMs = 2_000;

/** Lines naming a remote's refusal: of the credential, of the repository, or of the ref. */
const gitRefusals = [
  /returned error: 40[134]\b/u,
  /\bHTTP 40[134]\b/u,
  /Authentication failed/u,
  /could not read (?:Username|Password)/u,
  /\[remote rejected\]/u,
  /! \[rejected\]/u,
  /protected branch/iu,
  /declined/iu,
];

/** Lines naming git's transport failing: the connection, its TLS, or a server error. */
const gitTransportFailures = [
  /returned error: (?:5\d\d|429)\b/u,
  /\bHTTP (?:5\d\d|429)\b/u,
  /RPC failed; curl \d+/u,
  /unable to access .*(?:Could not resolve|Failed to connect|timed out|Connection reset|Recv failure|Send failure|Empty reply|SSL|TLS|gnutls)/u,
  /unexpected disconnect/u,
  /early EOF/u,
];

/** What git wrote to standard error, line by line. */
function gitErrorLines(failure) {
  const stderr = failure?.stderr;
  if (typeof stderr !== "string") return [];
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The first of `lines` any of `patterns` matches. */
function lineMatching(lines, patterns) {
  return lines.find((line) => patterns.some((pattern) => pattern.test(line)));
}

/**
 * The line that says why git failed: the refusal or the transport failure it
 * names, and otherwise its last `fatal:` or `error:` line. Nothing where it
 * wrote none of them.
 */
export function gitFailureLine(failure) {
  const lines = gitErrorLines(failure);
  return (
    lineMatching(lines, gitRefusals) ??
    lineMatching(lines, gitTransportFailures) ??
    lines.findLast((line) => /^(?:fatal|error):/u.test(line))
  );
}

/** Whether a try that failed so may succeed again. */
export function gitRemoteRetries(failure) {
  const lines = gitErrorLines(failure);
  return (
    lineMatching(lines, gitRefusals) === undefined &&
    lineMatching(lines, gitTransportFailures) !== undefined
  );
}

/**
 * What `reach` resolves to, tried until it does, until it fails in a way
 * another try cannot fix, or until it has been tried `gitRemoteTriesMax`
 * times; its last failure is thrown. `again` runs before every try after the
 * first, and `pause` is the wait before it.
 */
export async function gitRemoteTried(reach, seams = {}) {
  const { again = async () => undefined, pause = delay } = seams;
  for (let tried = 1; ; tried += 1) {
    try {
      return await reach();
    } catch (failure) {
      if (tried >= gitRemoteTriesMax || !gitRemoteRetries(failure))
        throw failure;
    }
    await pause(gitRemotePauseMs * 2 ** (tried - 1));
    await again();
  }
}
