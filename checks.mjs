/**
 * The check stage the worker runs itself: the command lines the plane resolved,
 * run in order in the repository workspace, and the verdict, report and
 * diagnostic they produce.
 *
 * THE WORKER RUNS THE LIST IT WAS HANDED. `Commands` mode carries the resolved
 * lines, so nothing here reads a configuration block, and a stage's lines can
 * gain another source without a second path into the worker.
 *
 * THE TASK'S KIND NEVER REACHES HERE. A work task's commands are its work and
 * their exit status is its verdict, exactly as an evaluation's are; what a
 * passing stage then leaves behind is the entrypoint's, and is the one place
 * the kind is read.
 *
 * THE SHELLS A STAGE'S BLOCK LAUNCHES INHERIT THE POD'S ENVIRONMENT, LESS THE
 * TASK DOCUMENT. The pod is placed with the whole document in a variable, and a
 * shell that read it would be reading the prose its own stage was authored
 * from; everything else the pod was given is what a gate expects to find, and
 * is passed on whole. The entrypoint takes the same environment from here for
 * the setup lines of the same block, which run in the same workspace moments
 * earlier: narrowing one shell and not the other leaves the document one `cp`
 * away from the commands.
 *
 * THOSE SHELLS ARE HANDED BACK WHAT THE IMAGE SET TO STEER A PROCESS. A job's
 * `check.sh` moves each such variable aside before chuggy's node starts, so
 * that none of chuggy's own processes is steered by the image; a stage's
 * shells are the project's, and run as the image set them up to.
 *
 * THOSE SHELLS ARE TOLD THE COMMIT THE CHANGE STARTED FROM, in
 * `CHUG_CHANGE_BASE`, so a check can run only what the change touched. It is
 * set only where the attempt knows that commit, and one the pod inherited is
 * dropped, so a shell that finds it unset runs everything rather than trusting
 * a base nobody gave this attempt. The shell runs with `-u`, so a line reads it
 * as `${CHUG_CHANGE_BASE-}`, and `"$CHUG_CHANGE_BASE"` aborts where it is unset.
 *
 * THOSE SHELLS ARE TOLD WHICH JOB THEY ARE IN, under `workerJobVariables`:
 * the task's tenant, project, ticket and attempt, the repository its bundle
 * pins, and its stage as a configuration's keys spell it. Every attempt knows
 * each of them, so each is always set, and one the pod inherited is dropped.
 *
 * THOSE SHELLS ARE HANDED WHAT THE JOB'S SETUP LINES PASSED ON
 * (`setupEnvironment.mjs`), over what the image set and under every variable
 * chuggy sets itself. A setup line is told the file it passes variables on in
 * under `workerSetupEnvironmentVariable`, and one the pod inherited is dropped,
 * so no other shell finds it set.
 *
 * THOSE SHELLS ARE HANDED THE ATTEMPT'S GIT CONFIGURATION, through the
 * variables git reads entries from after every file it reads, appended to any
 * the pod holds. The pod's own entries are named again beside the attempt's,
 * because an agent that filters its shell's environment by name, as Codex
 * drops any name holding `KEY`, would leave git a count whose keys are gone,
 * which git refuses. Cargo is told to fetch a git dependency through git,
 * which reads those entries, rather than through libgit2, which does not; a
 * value the pod or the job's setup already holds for that variable is left to
 * stand.
 *
 * AN AGENT'S SHELL IS HANDED WHAT THOSE SHELLS ARE, so that a check the agent
 * runs is handed what the stage's would be. The agent is started from what
 * they inherit, and its shell is handed the moved values, the attempt's own
 * change base, which job it is in and its git configuration by the agent's own
 * means, with what its setup passed on, beside what the agent itself was given
 * to run with.
 *
 * THE FIRST FAILURE STOPS THE STAGE, and a command killed by a signal is a
 * failure like any other. What follows a command that did not exit cleanly
 * cannot be trusted to mean anything, so the commands after it do not run and
 * are not reported as having passed.
 *
 * THE REPORT KEEPS THE STATUS AND NOT ONLY THE VERDICT, because a gate that
 * could not run and a gate that found something are both a failed stage and are
 * not the same fact.
 *
 * WHAT A COMMAND WRITES GOES TWO PLACES. It is streamed to the worker's own
 * stdout as it arrives, so a stage that dies mid-run leaves the pod log the
 * account it reached; and it is captured, bounded, for the diagnostic artifact
 * the plane keeps: all of it where it fits, and otherwise its start and its
 * end, marked where output between them was dropped.
 *
 * THE CAPTURE IS BOUNDED AGAINST THE UPLOAD AND NOT AGAINST MEMORY. The
 * artifact the plane refuses is the one that turns a stage's Fail into a
 * crashed run, so the stage's whole room is taken from what one upload may
 * weigh, and one command's own cap only keeps a single chatty gate from
 * spending all of it.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

import { resultReportCharsMax } from "@chuggy/worker-contract/workerDocuments";
import {
  sessionTaskVariable,
  workerTaskVariable,
} from "@chuggy/worker-contract/workerEnvironment";
import {
  runConfigurationBytesMax,
  workerPlaneUploadBytesMax,
} from "@chuggy/worker-contract/workerPlane";

/**
 * What one character of a stage's own text can cost in that artifact. The
 * artifact is UTF-8 JSON, where the worst character escapes rather than
 * encoding as bytes, and it then passes the credential scrub, which can only
 * lengthen what it replaces. Neither is measured here: both are bounds, and the
 * suite builds the worst case and weighs it.
 */
const checkArtifactCharBytesMax = 8;

/** The room the artifact's own keys, indentation and command lines are left. */
const checkArtifactFrameBytesMax = 65_536;

/**
 * The characters one whole stage keeps, which is what is left of the upload. A
 * body over the upload bound is refused, and a refused diagnostic ends the
 * attempt as a crashed run rather than the verdict the stage actually reached.
 */
export const workerCheckStageOutputCharsMax = Math.floor(
  (workerPlaneUploadBytesMax - checkArtifactFrameBytesMax) /
    checkArtifactCharBytesMax,
);

/** The characters one command keeps, so no single command spends the stage's room. */
export const workerCheckOutputCharsMax = 262_144;

/**
 * What one character of a summary can weigh as the UTF-8 it is uploaded in.
 * Not measured here: the suite builds the heaviest summary and weighs it.
 */
const checkSummaryCharBytesMax = 3;

/**
 * The characters an agent's summary keeps as an output. chuggy refuses to show
 * an output heavier than its `outputPreviewBytesMax`, a bound the contract
 * carries only as `runConfigurationBytesMax`, which chuggy's suite holds equal
 * to it.
 */
export const workerSummaryCharsMax = Math.floor(
  runConfigurationBytesMax / checkSummaryCharBytesMax,
);

/** What the report says before the failing command's output, which is what makes the excerpt readable as one. */
const checkReportExcerptLabel = "; last output of ";

/** What a capture holds where it dropped output, between the head it kept and the end. */
const checkCaptureMarker = "\n[capture dropped output here]\n";

/** What a scrub is where the caller hands none, which is the suite's case and never the worker's. */
const checkNoScrub = (text) => text;

/** The escape that introduces a terminal control sequence, spelled by code because it is not printable. */
const checkEscape = String.fromCodePoint(0x1b);

/**
 * One terminal control sequence, or any lone control character, which the
 * report row refuses. Built from the escape's code rather than written into a
 * pattern, because a control character spelled in a literal is what the lint
 * rule against them refuses, and here the control character is the point.
 */
const checkControlSequence = new RegExp(
  `${checkEscape}\\[[0-?]*[ -/]*[@-~]|\\p{Cc}`,
  "gu",
);

/** The resolved command lines this task runs itself, or nothing when an agent runs it. */
export function workerCheckCommands(task) {
  const mode = task.worker?.mode;
  return mode?.type === "Commands" ? mode.commands : undefined;
}

/** One command's exit as a reader reads it: a status, or the signal that replaced one. */
function checkExit(code, signal) {
  return code === null
    ? { exitStatus: null, signal: signal ?? "unknown" }
    : { exitStatus: code };
}

/** Whether this command ended the way a stage may carry on after. */
function checkPassed(outcome) {
  return outcome.exitStatus === 0;
}

/** The environment variables a launcher places a whole task document in. */
const checkTaskDocuments = [workerTaskVariable, sessionTaskVariable];

/** The variable a stage's shells find the commit the change started from in. */
export const workerChangeBaseVariable = "CHUG_CHANGE_BASE";

/** The variable a setup line finds the file it passes variables on in named by. */
export const workerSetupEnvironmentVariable = "CHUG_ENV";

/** The variables a job's shells find which job they are in, by what each names. */
export const workerJobVariables = {
  tenant: "CHUG_TENANT",
  project: "CHUG_PROJECT",
  repository: "CHUG_REPOSITORY",
  ticket: "CHUG_TICKET",
  attempt: "CHUG_ATTEMPT",
  stage: "CHUG_STAGE",
};

/** Every name of `workerJobVariables`. */
const checkJobVariableNames = Object.values(workerJobVariables);

/**
 * A task's stage as a configuration's keys spell it: `Work`, or `Evaluation:N`
 * counted from one. An evaluation whose task numbers no stage is
 * `Evaluation`, the key every evaluation stage answers to.
 */
export function workerJobStage(task) {
  return task.taskKind === "Evaluation" && task.stage !== undefined
    ? `Evaluation:${String(task.stage + 1)}`
    : task.taskKind;
}

/**
 * What a job's shells are told of which job they are in: `task`'s identity and
 * stage, and `repository`, the reference its bundle pins the checkout by.
 */
export function workerJobEnvironment(task, repository) {
  return {
    [workerJobVariables.tenant]: task.tenant,
    [workerJobVariables.project]: task.project,
    [workerJobVariables.repository]: repository,
    [workerJobVariables.ticket]: String(task.ticket),
    [workerJobVariables.attempt]: task.attempt,
    [workerJobVariables.stage]: workerJobStage(task),
  };
}

/**
 * The variables an image's environment would steer chuggy's own processes by,
 * which a job's `check.sh` moves aside before chuggy's node starts.
 */
export const workerImageSteeringVariables = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
];

/** The name `check.sh` keeps the image's value of one of them under. */
export function workerImageVariable(name) {
  return `CHUG_IMAGE_${name}`;
}

/** Every name `check.sh` keeps a moved value under. */
const checkImageKeptVariables =
  workerImageSteeringVariables.map(workerImageVariable);

/** `environment` less every name `check.sh` keeps a moved value under. */
function workerUnkeptEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !checkImageKeptVariables.includes(name),
    ),
  );
}

/**
 * What the pod holds, less the documents that placed it and any change base,
 * setup file or job's identity it inherited. Everything else stands, the
 * site's own variables among it.
 */
export function workerInheritedEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !checkTaskDocuments.includes(name) &&
        name !== workerChangeBaseVariable &&
        name !== workerSetupEnvironmentVariable &&
        !checkJobVariableNames.includes(name),
    ),
  );
}

/** The image's own value of each variable `check.sh` moved aside, under its own name again. */
function workerImageEnvironment(environment) {
  return Object.fromEntries(
    workerImageSteeringVariables.flatMap((name) => {
      const kept = workerImageVariable(name);
      return Object.hasOwn(environment, kept)
        ? [[name, environment[kept]]]
        : [];
    }),
  );
}

/**
 * What an agent's own process is started from: the pod's inherited
 * environment, less every name `check.sh` keeps a moved value under.
 */
export function workerAgentEnvironment(environment) {
  return workerUnkeptEnvironment(workerInheritedEnvironment(environment));
}

/**
 * `environment` less each of `names`.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @param {readonly string[]} names
 */
export function workerEnvironmentWithout(environment, names) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !names.includes(name)),
  );
}

/**
 * Where the core keeps a file of its own: the temporary directory, named as a
 * job's `check.sh` names the one it found this user can write.
 */
export function workerTemporaryFile(name, environment = process.env) {
  return join(environment.TMPDIR || "/tmp", name);
}

/** The variable git reads how many configuration entries the environment holds from. */
const workerGitCountVariable = "GIT_CONFIG_COUNT";

/** The variable that has Cargo fetch a git dependency through git rather than libgit2. */
const workerCargoGitVariable = "CARGO_NET_GIT_FETCH_WITH_CLI";

/** The variables git reads the key and the value of entry `index` from. */
function workerGitEntryVariables(index) {
  return [
    `GIT_CONFIG_KEY_${String(index)}`,
    `GIT_CONFIG_VALUE_${String(index)}`,
  ];
}

/** Whether `name` is one of the variables git reads configuration entries from. */
export function workerGitVariable(name) {
  return (
    name === workerGitCountVariable ||
    /^GIT_CONFIG_(?:KEY|VALUE)_[0-9]+$/u.test(name)
  );
}

/** How many configuration entries `environment` hands git, refused where git would refuse it. */
function workerGitCount(environment) {
  const count = environment[workerGitCountVariable] ?? "";
  if (!/^[0-9]*$/u.test(count))
    throw new Error(`${workerGitCountVariable} is ${count}, which git refuses`);
  return Number(count);
}

/**
 * `git`, each `[key, value]` an entry git reads, appended to the entries
 * `environment` already hands git, every one of those named again; and Cargo
 * told to fetch through git, where `environment` does not already say how.
 * Nothing where `git` names no entry.
 */
export function workerGitEnvironment(environment, git) {
  if (git.length === 0) return {};
  const standing = workerGitCount(environment);
  const kept = Array.from({ length: standing }, (_, index) =>
    workerGitEntryVariables(index).filter((name) =>
      Object.hasOwn(environment, name),
    ),
  )
    .flat()
    .map((name) => [name, environment[name]]);
  const added = git.flatMap((entry, index) => {
    const [key, value] = workerGitEntryVariables(standing + index);
    return [
      [key, entry[0]],
      [value, entry[1]],
    ];
  });
  return Object.fromEntries([
    [workerGitCountVariable, String(standing + git.length)],
    ...kept,
    ...added,
    ...(Object.hasOwn(environment, workerCargoGitVariable)
      ? []
      : [[workerCargoGitVariable, "true"]]),
  ]);
}

/**
 * What a stage's shells are handed beyond that, which an agent's shell is
 * handed by the agent's own means: each variable `check.sh` moved aside, back
 * under its own name; `handed.setupEnvironment`, what the job's setup lines
 * passed on, over those; `handed.changeBase` where the attempt knows one;
 * `handed.job`, what `workerJobEnvironment` tells a job's shells; and
 * `handed.git`, the entries the attempt's git configuration adds.
 */
export function workerShellEnvironment(environment, handed = {}) {
  const { setupEnvironment = {}, changeBase, job = {}, git = [] } = handed;
  return {
    ...workerImageEnvironment(environment),
    ...setupEnvironment,
    ...(changeBase === undefined
      ? {}
      : { [workerChangeBaseVariable]: changeBase }),
    ...job,
    ...workerGitEnvironment({ ...environment, ...setupEnvironment }, git),
  };
}

/**
 * What a stage's shells are handed. With nothing `handed` it is what each of
 * the image's programs the core runs itself is handed: git, and every hook a
 * project's setup installed for it, which need the image's values as its
 * shells do and are not to be handed the task document.
 */
export function workerStageEnvironment(environment, handed) {
  return {
    ...workerAgentEnvironment(environment),
    ...workerShellEnvironment(environment, handed),
  };
}

/** One command's account: what ran, how it ended, and what it wrote. */
async function runCheckCommand(command, room, services) {
  const child = services.spawnProcess("/bin/sh", ["-eu", "-c", command], {
    cwd: services.directory,
    env: services.environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = checkCapture(Math.min(workerCheckOutputCharsMax, room));
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      services.write(chunk);
      capture.take(chunk);
    });
  }
  const [code, signal] = await new Promise((settle, refuse) => {
    child.once("error", refuse);
    child.once("close", (exitCode, exitSignal) =>
      settle([exitCode, exitSignal]),
    );
  });
  return { command, ...checkExit(code, signal), ...capture.kept() };
}

/**
 * A command's output within `units` code units: everything, while it fits, and
 * otherwise its head and a rolling tail of what came last, joined by the
 * dropped marker where the marker fits, so the capture still ends where the
 * command did. Until output is dropped the head also holds the marker's room,
 * and gives it up when the tail first drops something. The tail is cut before
 * it is added to, so the two together never hold more than `units`.
 */
function checkCapture(units) {
  const marker = units >= checkCaptureMarker.length ? checkCaptureMarker : "";
  const headUnits = Math.floor((units - marker.length) / 2);
  const tailUnits = units - marker.length - headUnits;
  let head = "";
  let headOpen = true;
  let tail = "";
  let truncated = false;
  return {
    take(chunk) {
      const room = units - tailUnits - head.length;
      const taken = headOpen ? checkHead(chunk, room) : "";
      head += taken;
      if (taken.length === chunk.length) return;
      headOpen = false;
      const rest = checkTail(chunk.slice(taken.length), tailUnits);
      const kept = checkTail(tail, tailUnits - rest.length);
      const dropped =
        kept.length + rest.length < tail.length + chunk.length - taken.length;
      if (dropped && !truncated) head = checkHead(head, headUnits);
      truncated ||= dropped;
      tail = kept + rest;
    },
    kept: () => ({
      truncated,
      output: truncated ? `${head}${marker}${tail}` : `${head}${tail}`,
    }),
  };
}

/** How one command's end reads in the stage's report. */
function checkReportLine(ran) {
  return ran.exitStatus === null
    ? `${ran.command} was killed by ${ran.signal}`
    : `${ran.command} exited ${String(ran.exitStatus)}`;
}

/** Text as the report row accepts it: well formed, with escapes and control characters made spaces. */
function checkClean(text) {
  return text.toWellFormed().replace(checkControlSequence, " ");
}

/** What a command wrote, as one printable line with its whitespace collapsed. */
function checkPrintable(text) {
  return checkClean(text).replace(/\s+/gu, " ").trim();
}

/**
 * Any text as a report carries it: scrubbed while it is still as it was
 * written, so a secret spanning lines is still matched, then printable on one
 * line and no longer than a report holds, whatever the scrub put in.
 */
export function workerReportText(text, scrub) {
  return checkHead(checkPrintable(scrub(text)), resultReportCharsMax);
}

/**
 * An agent's summary as an output carries it: scrubbed as a report's is and
 * otherwise as it was written, line breaks kept, well formed, and cut to what
 * an output holds. Empty where nothing in it is printable.
 */
export function workerSummaryText(text, scrub) {
  const written = scrub(text).toWellFormed();
  return checkPrintable(written).length === 0
    ? ""
    : checkHead(written, workerSummaryCharsMax);
}

/** The longest head of a well-formed text within this many code units that ends on a code point. */
function checkHead(text, units) {
  let head = "";
  for (const point of text) {
    if (head.length + point.length > units) break;
    head += point;
  }
  return head;
}

/** The longest tail of a well-formed text within this many code units that starts on a code point. */
function checkTail(text, units) {
  if (text.length <= units) return text;
  const start = text.length - units;
  const lowSurrogate = /^[\uDC00-\uDFFF]$/u.test(text[start]);
  return text.slice(lowSurrogate ? start + 1 : start);
}

/**
 * The end of what the failing command wrote, scrubbed and printable, in the
 * room the status lines leave. Nothing is appended where there is no room for
 * the label and at least one character, or where nothing printable was written.
 */
function checkReportExcerpt(failed, room, scrub) {
  const printable = checkPrintable(scrub(failed.output));
  const capture = failed.truncated ? " (capture truncated)" : "";
  const label = checkClean(
    scrub(`${checkReportExcerptLabel}${failed.command}${capture}: `),
  );
  const kept = room - label.length;
  if (printable.length === 0 || kept < 1) return "";
  return `${label}${checkTail(printable, kept)}`;
}

/** The stage's report: every command that ran, its status, and the end of what the failing one wrote. */
function checkReport(commands, ran, scrub) {
  const skipped = commands.length - ran.length;
  const lines = [
    ...ran.map(checkReportLine),
    ...(skipped > 0 ? [`${String(skipped)} later command(s) did not run`] : []),
  ];
  const status = checkHead(
    checkClean(scrub(lines.join("; "))),
    resultReportCharsMax,
  );
  const failed = ran.find((outcome) => !checkPassed(outcome));
  if (failed === undefined) return status;
  const room = resultReportCharsMax - status.length;
  return `${status}${checkReportExcerpt(failed, room, scrub)}`;
}

/**
 * Runs one check stage: every command in order, stopping at the first that does
 * not exit cleanly, and reporting each command's own status through the
 * caller's credential scrub. `context` names the directory the commands run in,
 * what the job's setup lines passed on, the commit the change started from
 * where the attempt knows it, what a job's shells are told of which job they
 * are in, and the attempt's git configuration where it has one.
 */
export async function runChecks(context, commands, services = {}) {
  if (commands.length === 0)
    throw new Error("check stage was handed no commands to run");
  const {
    spawnProcess = spawn,
    write = (text) => process.stdout.write(text),
    scrub = checkNoScrub,
  } = services;
  const environment = workerStageEnvironment(process.env, {
    setupEnvironment: context.setupEnvironment,
    changeBase: context.changeBase,
    job: context.job,
    git: context.git,
  });
  const ran = [];
  let kept = 0;
  for (const command of commands) {
    const outcome = await runCheckCommand(
      command,
      workerCheckStageOutputCharsMax - kept,
      { directory: context.directory, environment, spawnProcess, write },
    );
    kept += outcome.output.length;
    ran.push(outcome);
    if (!checkPassed(outcome)) break;
  }
  const passed = ran.length === commands.length && ran.every(checkPassed);
  return {
    output: { checks: ran },
    result: {
      verdict: passed ? "Pass" : "Fail",
      summary: checkReport(commands, ran, scrub),
    },
  };
}
