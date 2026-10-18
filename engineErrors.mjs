/**
 * What an engine's failure was, read off its stderr in this one place. Docker
 * and podman word the same failures differently, and the suite holds each
 * class to the words both engines were seen to print.
 */

/**
 * @typedef {import("./engine.mjs").EngineAnswer} EngineAnswer
 *
 * @typedef {"Unreachable" | "NoSuchContainer" | "NoSuchVolume" | "NameConflict" | "Unauthorized" | "NotFound" | "Other"} EngineFailure
 */

const engineFailures = /** @type {const} */ ([
  [
    "Unreachable",
    /cannot connect to the docker daemon|permission denied while trying to connect to the docker daemon|failed to connect to the docker api|cannot connect to podman/iu,
  ],
  ["NoSuchContainer", /no such container/iu],
  ["NoSuchVolume", /no such volume/iu],
  ["NameConflict", /is already in use/iu],
  [
    "Unauthorized",
    /unauthorized|authentication required|no basic auth credentials/iu,
  ],
  ["NotFound", /no such image|image not known|manifest unknown|not found/iu],
]);

/**
 * An engine that could not be started or did not answer is unreachable
 * whatever it printed.
 *
 * @param {EngineAnswer} answer
 * @returns {EngineFailure}
 */
export function engineFailure(answer) {
  if (answer.failed !== undefined) return "Unreachable";
  for (const [failure, words] of engineFailures)
    if (words.test(answer.stderr)) return failure;
  return "Other";
}

/**
 * The words a failed pull says when its registry refused the image for good,
 * or when no image could be named by the reference: it is not there, it is
 * not this puller's to have, or the reference is not one. A refusal word is
 * read only standing as a word, between spaces or the stderr's ends with at
 * most a punctuation mark after it, since a host or a repository the
 * reference names can spell one inside itself.
 */
const pullRefusalWords = [
  "not found",
  "manifest unknown",
  "unauthorized",
  "authentication required",
  "no basic auth credentials",
  "denied",
  "forbidden",
  "invalid reference format",
];

const pullRefusal = new RegExp(
  `(?:^|\\s)(?:${pullRefusalWords.join("|")})[,.;:]?(?:\\s|$)`,
  "iu",
);

/**
 * What this machine says of a failure of its own, in words a refusal also
 * uses: a file the engine's user may not open, as rootless storage can be,
 * and a program its PATH lacks, as a credential helper can. Neither is read
 * as a refusal.
 */
const localFailurePhrasings = /permission denied|executable file not found/giu;

/**
 * Whether a pull or an inspection of an image the engine answered as failed
 * was refused in a way no second try changes. An engine that could not be
 * reached refused nothing, whatever its words.
 *
 * @param {EngineAnswer} answer
 */
export function enginePullRefused(answer) {
  return (
    engineFailure(answer) !== "Unreachable" &&
    pullRefusal.test(answer.stderr.replace(localFailurePhrasings, " "))
  );
}

/**
 * The statuses both engines' `run` answers with when the container's own
 * command could not be invoked or found, which are not the one it answers a
 * failure of the engine's own with.
 */
const unstartedStatuses = new Set([126, 127]);

/**
 * Whether a `run` failed because the container's runtime could not execute
 * `command`, which runc's error of its lookup names quoted after `exec:` and
 * crun's names between backquotes, whether the file is absent, not
 * executable or not a file. Both engines also answer the same statuses for
 * any start failure whose cause reads as a missing file or a refused
 * permission, so the status alone names no command.
 *
 * @param {EngineAnswer} answer
 * @param {string} command an absolute path
 */
export function engineCommandUnstarted(answer, command) {
  return (
    unstartedStatuses.has(answer.code) &&
    (answer.stderr.includes(`exec: ${JSON.stringify(command)}: `) ||
      answer.stderr.includes(`\`${command}\``))
  );
}

/** A daemon's error can quote a whole request, which a log line does not need. */
const failureLineCharsMax = 300;

/**
 * The line of a failure worth logging: the first naming an error, since podman
 * says what it is trying before it says what failed, else the first at all.
 *
 * @param {EngineAnswer} answer
 */
export function engineFailureLine(answer) {
  const lines = answer.stderr
    .split("\n")
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  const line =
    lines.find((text) => /error/iu.test(text)) ??
    lines[0] ??
    `exit ${String(answer.code)}`;
  return line.length > failureLineCharsMax
    ? `${line.slice(0, failureLineCharsMax)}…`
    : line;
}
