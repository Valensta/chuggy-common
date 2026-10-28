/**
 * The check stage the worker runs itself, driven against real processes.
 *
 * THE CASES BELOW SPAWN `/bin/sh`, because what the stage claims is about exit
 * status, ordering and captured output, and a stubbed child process would be a
 * restatement of the code rather than a check on it.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { resultReportCharsMax } from "@chuggy/worker-contract/workerDocuments";
import {
  sessionTaskVariable,
  workerTaskVariable,
} from "@chuggy/worker-contract/workerEnvironment";
import {
  runConfigurationBytesMax,
  workerPlaneUploadBytesMax,
} from "@chuggy/worker-contract/workerPlane";
import {
  briefingLineCharsMax,
  commandLinesMax,
} from "@chuggy/worker-contract/workerTask";

import { credentialScrub } from "./runEvidence.mjs";
import {
  runChecks,
  workerChangeBaseVariable,
  workerCheckCommands,
  workerCheckOutputCharsMax,
  workerCheckStageOutputCharsMax,
  workerGitEnvironment,
  workerImageSteeringVariables,
  workerImageVariable,
  workerInheritedEnvironment,
  workerJobEnvironment,
  workerJobStage,
  workerJobVariables,
  workerSetupEnvironmentVariable,
  workerShellEnvironment,
  workerStageEnvironment,
  workerSummaryCharsMax,
  workerSummaryText,
  workerTemporaryFile,
} from "./checks.mjs";

const workspace = { directory: process.cwd() };

/** The character a capture can hold that costs an escape rather than a byte. */
const controlCharacter = String.fromCodePoint(1);

/** The printable character an authored command line can hold that costs the most bytes. */
const replacementCharacter = String.fromCodePoint(0xfffd);

/** That control character as a serialized artifact spells it. */
const controlEscape = JSON.stringify(controlCharacter).slice(1, -1);

/** A command that writes more than one command's capture keeps. */
const chatty = `yes chatter | head -c ${String(workerCheckOutputCharsMax * 2)}`;

/**
 * One stage, run with its streaming discarded unless the case is about that.
 * A suite that let a chatty command through would print what it produced.
 */
function ran(commands, services = {}) {
  return runChecks(workspace, commands, {
    write: () => undefined,
    ...services,
  });
}

test("a check stage is the mode the task carries and nothing else", () => {
  assert.deepEqual(
    workerCheckCommands({
      worker: { mode: { type: "Commands", commands: ["true", "false"] } },
    }),
    ["true", "false"],
  );
  assert.equal(
    workerCheckCommands({
      worker: { mode: { type: "SingleAgent", agent: "Claude", arguments: [] } },
    }),
    undefined,
  );
  assert.equal(workerCheckCommands({}), undefined);
});

test("a stage whose every command exits zero passes", async () => {
  const { result, output } = await ran(["exit 0", "printf done"]);

  assert.equal(result.verdict, "Pass");
  assert.equal(result.summary, "exit 0 exited 0; printf done exited 0");
  assert.deepEqual(
    output.checks.map((check) => check.exitStatus),
    [0, 0],
  );
});

test("a nonzero exit fails the stage", async () => {
  const { result } = await ran(["exit 1"]);

  assert.equal(result.verdict, "Fail");
});

test("a stage stops at the first command that does not exit zero", async () => {
  const { result, output } = await ran(["exit 0", "exit 1", "exit 0"]);

  assert.equal(result.verdict, "Fail");
  assert.deepEqual(
    output.checks.map((check) => check.command),
    ["exit 0", "exit 1"],
  );
  assert.ok(
    result.summary.includes("1 later command(s) did not run"),
    result.summary,
  );
});

test("the report separates a gate that could not run from one that found something", async () => {
  const couldNotRun = await ran(["exit 2"]);
  const found = await ran(["exit 1"]);

  assert.equal(couldNotRun.result.summary, "exit 2 exited 2");
  assert.equal(found.result.summary, "exit 1 exited 1");
  assert.equal(couldNotRun.result.verdict, "Fail");
  assert.equal(found.result.verdict, "Fail");
});

test("a command killed by a signal is reported as killed and fails the stage", async () => {
  const { result, output } = await ran(["kill -TERM $$"]);

  assert.equal(result.verdict, "Fail");
  assert.equal(output.checks[0].exitStatus, null);
  assert.equal(output.checks[0].signal, "SIGTERM");
  assert.equal(result.summary, "kill -TERM $$ was killed by SIGTERM");
});

test("a command killed by a signal stops the stage like any other failure", async () => {
  const { result, output } = await ran(["kill -TERM $$", "printf ran"]);

  assert.equal(result.verdict, "Fail");
  assert.deepEqual(
    output.checks.map((check) => check.command),
    ["kill -TERM $$"],
  );
  assert.equal(
    result.summary,
    "kill -TERM $$ was killed by SIGTERM; 1 later command(s) did not run",
  );
});

test("a failed stage's report ends with what the failing command wrote", async () => {
  const command = "printf 'format FAILED\\n  [warn] a.tsx\\n'; exit 1";
  const { result } = await ran([command]);

  assert.equal(
    result.summary,
    `${command} exited 1; last output of ${command}: format FAILED [warn] a.tsx`,
  );
});

test("a passing stage's report carries no output", async () => {
  const { result } = await ran(["printf chatter"]);

  assert.equal(result.summary, "printf chatter exited 0");
});

test("the excerpt is one printable line: escapes and control characters become spaces", async () => {
  const command = "printf 'a\\nb\\033[31mc\\033[0m\\td'; exit 1";
  const { result } = await ran([command]);

  assert.ok(result.summary.endsWith(": a b c d"), result.summary);
  assert.equal(/\p{Cc}/u.test(result.summary), false);
});

test("the excerpt fills the report's room and keeps the end of the output", async () => {
  const command = `yes chatter | head -c ${String(resultReportCharsMax * 2)}; printf END; exit 1`;
  const { result } = await ran([command]);

  assert.equal(result.summary.length, resultReportCharsMax);
  assert.ok(result.summary.endsWith("chatter END"), result.summary.slice(-40));
  assert.ok(result.summary.startsWith(`${command} exited 1; last output of `));
});

test("an excerpt of a truncated capture says so", async () => {
  const command = `${chatty}; exit 1`;
  const { result, output } = await ran([command]);

  assert.equal(output.checks[0].truncated, true);
  assert.ok(
    result.summary.includes(`last output of ${command} (capture truncated): `),
    result.summary.slice(0, 200),
  );
  assert.equal(result.summary.length, resultReportCharsMax);
});

test("the report is scrubbed before it is measured, so the entrypoint's scrub cannot lengthen it", async () => {
  const secret = "hunter2-hunter2-hunter2-hunter2";
  const scrub = credentialScrub([secret]);
  const command = `yes ${secret} | head -c ${String(resultReportCharsMax * 2)}; exit 1`;
  const { result } = await ran([command], { scrub });

  assert.equal(result.summary.includes(secret), false);
  assert.ok(result.summary.includes("[redacted credential]"));
  assert.equal(result.summary.length, resultReportCharsMax);
  assert.equal(scrub(result.summary), result.summary);
  assert.ok(result.summary.length <= resultReportCharsMax);
});

test("a cut through astral output lands on a code point, so the report is well formed", async () => {
  const wide = "\u{1F600}";
  const excerpt = `printf '%s' "$(yes ${wide} | head -c ${String(resultReportCharsMax * 8)})"; exit 1`;
  const status = `: ${wide.repeat(resultReportCharsMax)}; exit 1`;
  for (const command of [excerpt, status]) {
    const { result } = await ran([command]);

    assert.ok(result.summary.isWellFormed(), command.slice(0, 40));
    assert.ok(result.summary.length <= resultReportCharsMax);
    assert.ok(result.summary.length >= resultReportCharsMax - 1);
    assert.equal(/\p{Cc}/u.test(result.summary), false);
  }
});

test("a stage whose status lines fill the report carries no excerpt", async () => {
  const command = `printf out; : ${"x".repeat(resultReportCharsMax)}; exit 1`;
  const { result, output } = await ran([command]);

  assert.equal(output.checks[0].output, "out");
  assert.equal(result.summary.length, resultReportCharsMax);
  assert.equal(result.summary.includes("last output of"), false);
});

test("both streams are captured and a chatty command is bounded", async () => {
  const { output } = await ran(["printf out; printf err >&2", chatty]);

  assert.ok(output.checks[0].output.includes("out"));
  assert.ok(output.checks[0].output.includes("err"));
  assert.equal(output.checks[0].truncated, false);
  assert.equal(output.checks[1].output.length, workerCheckOutputCharsMax);
  assert.equal(output.checks[1].truncated, true);
});

test("a chatty command's capture keeps its start and its real ending", async () => {
  const command = `${chatty}; echo FINAL LINE; exit 1`;
  const { result, output } = await ran([command]);
  const [check] = output.checks;

  assert.equal(check.truncated, true);
  assert.ok(check.output.length <= workerCheckOutputCharsMax);
  assert.ok(check.output.startsWith("chatter\n"));
  assert.ok(check.output.endsWith("chatter\nFINAL LINE\n"));
  assert.ok(result.summary.endsWith("chatter FINAL LINE"), result.summary);
});

test("a capture cut through astral output lands on code points", async () => {
  const wide = "\u{1F600}";
  const command = `yes ${wide} | head -c ${String(workerCheckOutputCharsMax * 8)}`;
  const { output } = await ran([command]);

  assert.equal(output.checks[0].truncated, true);
  assert.ok(output.checks[0].output.isWellFormed());
  assert.ok(output.checks[0].output.length <= workerCheckOutputCharsMax);
});

test("what a stage captures across its commands is bounded as one total", async () => {
  const { output } = await ran([chatty, chatty]);

  const kept = output.checks.reduce(
    (total, check) => total + check.output.length,
    0,
  );
  assert.ok(
    workerCheckOutputCharsMax * 2 > workerCheckStageOutputCharsMax,
    "the case must ask for more than the stage total",
  );
  assert.equal(kept, workerCheckStageOutputCharsMax);
  assert.equal(output.checks[1].truncated, true);
});

test("the worst artifact a stage can produce is one the plane accepts", () => {
  const command = replacementCharacter.repeat(briefingLineCharsMax);
  const perCommand = Math.ceil(
    workerCheckStageOutputCharsMax / commandLinesMax,
  );
  const checks = Array.from({ length: commandLinesMax }, () => ({
    command,
    exitStatus: null,
    signal: "SIGKILL",
    truncated: true,
    output: controlCharacter.repeat(perCommand),
  }));
  const serialized = `${JSON.stringify({ checks }, null, 2)}\n`;
  const scrub = credentialScrub([controlEscape.repeat(3)]);

  assert.ok(
    Buffer.byteLength(scrub(serialized)) < workerPlaneUploadBytesMax,
    `the worst artifact is ${String(Buffer.byteLength(scrub(serialized)))} bytes`,
  );
});

test("the heaviest summary an agent's run keeps is one the plane accepts and shows whole", () => {
  const heaviest = replacementCharacter.repeat(workerSummaryCharsMax + 1);
  const kept = workerSummaryText(heaviest, (text) => text);
  const bytes = Buffer.byteLength(kept);

  assert.equal(kept.length, workerSummaryCharsMax);
  assert.ok(bytes <= runConfigurationBytesMax, String(bytes));
  assert.ok(bytes <= workerPlaneUploadBytesMax, String(bytes));
});

test("a stage handed no commands is a crashed run and never a pass", async () => {
  await assert.rejects(ran([]), /check stage was handed no commands to run/u);
});

/**
 * Catches the narrowing being dropped: a stage's commands would again be handed
 * the document that placed the pod, and with it the prose the stage was
 * authored from.
 */
test("a stage's commands inherit the pod's environment but not the task document", async () => {
  const placed = { [workerTaskVariable]: "{}", [sessionTaskVariable]: "{}" };
  const site = "set by the site";
  Object.assign(process.env, placed, { SITE_VARIABLE: site });
  try {
    const { output } = await ran([
      `printf "%s|%s|%s" "\${${workerTaskVariable}-unset}" ` +
        `"\${${sessionTaskVariable}-unset}" "\${SITE_VARIABLE-unset}"`,
    ]);

    assert.equal(output.checks[0].output, `unset|unset|${site}`);
  } finally {
    for (const name of [...Object.keys(placed), "SITE_VARIABLE"])
      delete process.env[name];
  }
});

/** Where the core keeps its own files is the temporary directory as `check.sh` names it. */
test("an unnamed or empty TMPDIR keeps the core's files in /tmp", () => {
  assert.equal(
    workerTemporaryFile("kept", { TMPDIR: "/image/temporary" }),
    "/image/temporary/kept",
  );
  for (const environment of [{}, { TMPDIR: "" }])
    assert.equal(workerTemporaryFile("kept", environment), "/tmp/kept");
});

/** A command that prints what the stage told it of the change's base, or `unset`. */
const printsChangeBase = `printf "%s" "\${${workerChangeBaseVariable}-unset}"`;

/**
 * Catches the base not reaching the stage's shells, which leaves a check that
 * narrows to what changed always running everything.
 */
test("a stage's commands are told the commit the change started from", async () => {
  const changeBase = "b".repeat(40);

  const { output } = await runChecks(
    { ...workspace, changeBase },
    [printsChangeBase, printsChangeBase],
    { write: () => undefined },
  );

  assert.deepEqual(
    output.checks.map((check) => check.output),
    [changeBase, changeBase],
  );
});

/** A command that prints what the stage told it of which job it is in, each `unset` where it told nothing. */
const printsJob = `printf "%s|" ${Object.values(workerJobVariables)
  .map((name) => `"\${${name}-unset}"`)
  .join(" ")}`;

/** An evaluation's task as its document names it, at its second stage. */
const evaluationTask = {
  tenant: "tenant-1",
  project: "project-1",
  ticket: 7,
  attempt: "attempt-1",
  taskKind: "Evaluation",
  stage: 1,
};

/**
 * Catches a job's identity not reaching a stage's shells, or reaching them as
 * anything but its own values, over whatever the pod held under those names.
 */
test("a stage's commands are told which job they are in, over what the pod holds", async () => {
  const pod = Object.fromEntries(
    Object.values(workerJobVariables).map((name) => [name, "the pod's"]),
  );
  Object.assign(process.env, pod);
  try {
    const { output } = await runChecks(
      {
        ...workspace,
        job: workerJobEnvironment(
          evaluationTask,
          "https://github.com/kasofsk/chuggy.git",
        ),
      },
      [printsJob],
      { write: () => undefined },
    );

    assert.equal(
      output.checks[0].output,
      "tenant-1|project-1|https://github.com/kasofsk/chuggy.git|7|attempt-1|Evaluation:2|",
    );
  } finally {
    for (const name of Object.keys(pod)) delete process.env[name];
  }
});

/**
 * Catches a stage spelled other than a configuration keys it, or counted from
 * zero as the document counts it: a line testing for the stage it was written
 * under would never match.
 */
test("a job's stage is spelled as a configuration's keys spell it", () => {
  const unstaged = { ...evaluationTask };
  delete unstaged.stage;

  assert.equal(workerJobStage({ taskKind: "Work" }), "Work");
  assert.equal(workerJobStage({ ...evaluationTask, stage: 0 }), "Evaluation:1");
  assert.equal(workerJobStage(evaluationTask), "Evaluation:2");
  assert.equal(workerJobStage(unstaged), "Evaluation");
});

/** Catches a stage a shell's own tests cannot tell apart: by its kind, and by its number. */
test("a stage's commands can test its stage by kind and by number", async () => {
  const told = async (task) => {
    const { output } = await runChecks(
      { ...workspace, job: workerJobEnvironment(task, "repository-1") },
      [
        'case "$CHUG_STAGE" in Evaluation*) printf evaluation ;; *) printf work ;; esac',
        '[ "$CHUG_STAGE" = Evaluation:2 ] && printf second || printf other',
      ],
      { write: () => undefined },
    );
    return output.checks.map((check) => check.output);
  };

  assert.deepEqual(await told(evaluationTask), ["evaluation", "second"]);
  assert.deepEqual(await told({ ...evaluationTask, stage: 0 }), [
    "evaluation",
    "other",
  ]);
  assert.deepEqual(
    await told({ ...evaluationTask, taskKind: "Work", stage: undefined }),
    ["work", "other"],
  );
});

/** An attempt's git configuration, each key one git reads more than one value of. */
const attemptGit = [
  ["url.https://forge.test/.insteadOf", "git@forge.test:"],
  ["url.https://forge.test/.insteadOf", "ssh://git@forge.test/"],
];

/** A command that prints every value git reads of the attempt's key, read past every file git reads. */
const printsAttemptGit =
  "GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git config --get-all url.https://forge.test/.insteadOf";

/**
 * Catches the attempt's git configuration not reaching a stage's shells, which
 * leaves a check that fetches a submodule another repository holds unable to.
 */
test("a stage's commands are handed the attempt's git configuration", async () => {
  const { output } = await runChecks(
    { ...workspace, git: attemptGit },
    [printsAttemptGit],
    { write: () => undefined },
  );

  assert.equal(
    output.checks[0].output,
    "git@forge.test:\nssh://git@forge.test/\n",
  );
});

/**
 * Catches the attempt's entries replacing the pod's own, or the pod's own left
 * to an inherited name a shell that filters by name, as Codex's does, drops.
 */
test("an attempt's git entries follow the pod's own, which are named again", () => {
  const pod = {
    PATH: "/bin",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.pager",
    GIT_CONFIG_VALUE_0: "cat",
  };

  assert.deepEqual(workerGitEnvironment(pod, attemptGit), {
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.pager",
    GIT_CONFIG_VALUE_0: "cat",
    GIT_CONFIG_KEY_1: attemptGit[0][0],
    GIT_CONFIG_VALUE_1: attemptGit[0][1],
    GIT_CONFIG_KEY_2: attemptGit[1][0],
    GIT_CONFIG_VALUE_2: attemptGit[1][1],
    CARGO_NET_GIT_FETCH_WITH_CLI: "true",
  });
  assert.deepEqual(workerGitEnvironment(pod, []), {});
});

/**
 * Catches Cargo left to fetch a git dependency through libgit2, which reads
 * none of the attempt's git configuration, so a dependency on another
 * repository the project binds is fetched with no credential; and the pod's
 * own say on it overridden.
 */
test("Cargo fetches through git where the attempt configures it, unless the pod says otherwise", () => {
  assert.equal(
    workerStageEnvironment({ PATH: "/bin" }, { git: attemptGit })
      .CARGO_NET_GIT_FETCH_WITH_CLI,
    "true",
  );
  assert.equal(
    workerStageEnvironment(
      { PATH: "/bin", CARGO_NET_GIT_FETCH_WITH_CLI: "false" },
      { git: attemptGit },
    ).CARGO_NET_GIT_FETCH_WITH_CLI,
    "false",
  );
  assert.ok(
    !Object.hasOwn(
      workerStageEnvironment({ PATH: "/bin" }),
      "CARGO_NET_GIT_FETCH_WITH_CLI",
    ),
  );
});

/**
 * Catches a count git refuses carried into every git the attempt runs, where
 * each would fail with an error naming nothing the attempt set.
 */
test("a pod handing git a count it refuses is refused before anything runs", () => {
  assert.throws(
    () => workerGitEnvironment({ GIT_CONFIG_COUNT: "two" }, attemptGit),
    /GIT_CONFIG_COUNT is two/u,
  );
});

/**
 * Catches a base the pod inherited reaching a stage whose attempt knows none:
 * a check would narrow to a diff against a commit this change never started
 * from, where unset makes it run everything.
 */
test("a stage that knows no base leaves the variable unset, whatever the pod holds", async () => {
  process.env[workerChangeBaseVariable] = "c".repeat(40);
  try {
    const { output } = await ran([printsChangeBase]);

    assert.equal(output.checks[0].output, "unset");
  } finally {
    delete process.env[workerChangeBaseVariable];
  }
});

/**
 * What `check.sh` keeps of an image that set each variable it moves aside to
 * `value(name)`, and what that image set.
 */
function imageMoved(value) {
  const pairs = workerImageSteeringVariables.map((name) => [name, value(name)]);
  return {
    kept: Object.fromEntries(
      pairs.map(([name, set]) => [workerImageVariable(name), set]),
    ),
    set: Object.fromEntries(pairs),
  };
}

/**
 * Catches a stage's shells run without what the project's image set them up
 * with, or with chuggy's names for it in their place. The loader's own
 * variables are set empty, which also holds an empty value handed back as
 * set, so the shell the stage starts loads as it would anyway.
 */
test("a stage's commands get back each variable check.sh moved aside, under its own name", async () => {
  const image = imageMoved((name) =>
    name.startsWith("LD_") ? "" : `the image's ${name}`,
  );
  Object.assign(process.env, image.kept);
  try {
    const { output } = await ran([
      workerImageSteeringVariables
        .map((name) => `printf "%s|" "\${${name}-unset}"`)
        .join("; "),
      `printf "%s" "\${${workerImageVariable("NODE_PATH")}-unset}"`,
    ]);

    assert.equal(
      output.checks[0].output,
      Object.values(image.set)
        .map((value) => `${value}|`)
        .join(""),
    );
    assert.equal(output.checks[1].output, "unset");
  } finally {
    for (const name of Object.keys(image.kept)) delete process.env[name];
  }
});

/**
 * Catches a value handed back under another variable's name, or losing to one
 * standing under its own, which only chuggy's own processes could have set.
 */
test("a value check.sh kept is handed back under its own name, over any standing there", () => {
  const image = imageMoved((name) => `the image's ${name}`);

  assert.deepEqual(
    workerStageEnvironment({ ...image.kept, NODE_PATH: "chuggy's" }),
    image.set,
  );
});

/**
 * Catches the stage dropping what an image run without `check.sh` sets, as
 * chuggy's own worker image sets `NODE_PATH`.
 */
test("a variable nothing moved aside reaches a stage as it stands", () => {
  const standing = { NODE_PATH: "/usr/local/lib/node_modules", PATH: "/bin" };

  assert.deepEqual(workerStageEnvironment(standing), standing);
});

/**
 * Catches the image's values reaching what is not a stage's shell: what a
 * session's runtime inherits is chuggy's own process, and keeps them aside.
 */
test("what a pod's runtime inherits keeps the image's values aside", () => {
  const image = imageMoved((name) => `the image's ${name}`);

  assert.deepEqual(
    workerInheritedEnvironment({
      ...image.kept,
      [workerTaskVariable]: "{}",
      [workerChangeBaseVariable]: "c".repeat(40),
    }),
    image.kept,
  );
});

/**
 * Catches a job's identity the pod held reaching what is not a stage's shell,
 * an agent's own process or a hook git runs, as if it were the attempt's.
 */
test("what a pod's runtime inherits holds no job's identity", () => {
  assert.deepEqual(
    workerInheritedEnvironment({
      PATH: "/bin",
      ...Object.fromEntries(
        Object.values(workerJobVariables).map((name) => [name, "the pod's"]),
      ),
    }),
    { PATH: "/bin" },
  );
});

/**
 * Catches a setup file the pod held reaching what is not a setup line: a
 * command or an agent's shell writing to it would be writing to a file nothing
 * reads, or to one a setup line of another job is handed.
 */
test("what a pod's runtime inherits holds no setup file", () => {
  assert.deepEqual(
    workerInheritedEnvironment({
      PATH: "/bin",
      [workerSetupEnvironmentVariable]: "/the/pod's",
    }),
    { PATH: "/bin" },
  );
});

/**
 * Catches what the job's setup passed on not reaching a stage's commands, or
 * losing to the value the image or the pod set, which a setup line that puts a
 * tool on `PATH` or tunes `NODE_OPTIONS` is there to replace.
 */
test("a stage's commands are handed what its setup passed on, over what the image and the pod set", async () => {
  Object.assign(process.env, {
    [workerImageVariable("NODE_OPTIONS")]: "the image's",
    CHUG_SUITE_STANDING: "the pod's",
  });
  try {
    const { output } = await runChecks(
      {
        ...workspace,
        setupEnvironment: {
          NODE_OPTIONS: "setup's",
          CHUG_SUITE_STANDING: "setup's",
          PASSED: "on",
        },
      },
      ['printf "%s|%s|%s" "$NODE_OPTIONS" "$CHUG_SUITE_STANDING" "$PASSED"'],
      { write: () => undefined },
    );

    assert.equal(output.checks[0].output, "setup's|setup's|on");
  } finally {
    delete process.env[workerImageVariable("NODE_OPTIONS")];
    delete process.env.CHUG_SUITE_STANDING;
  }
});

/**
 * Catches a value setup passed on standing over one chuggy sets itself, which
 * setup is refused before it could pass, and Cargo's fetch overridden where
 * setup said how, as the pod's own say on it is not.
 */
test("what chuggy sets in a stage's shells stands over what setup passed on, and Cargo's fetch is setup's to say", () => {
  const job = { [workerJobVariables.stage]: "Work" };
  const shells = workerShellEnvironment(
    { PATH: "/bin" },
    {
      setupEnvironment: {
        [workerChangeBaseVariable]: "setup's",
        [workerJobVariables.stage]: "setup's",
        CARGO_NET_GIT_FETCH_WITH_CLI: "false",
      },
      changeBase: "a".repeat(40),
      job,
      git: attemptGit,
    },
  );

  assert.equal(shells[workerChangeBaseVariable], "a".repeat(40));
  assert.equal(shells[workerJobVariables.stage], "Work");
  assert.equal(shells.GIT_CONFIG_COUNT, String(attemptGit.length));
  assert.equal(shells.CARGO_NET_GIT_FETCH_WITH_CLI, "false");
});

test("each command runs in the workspace the stage was given", async () => {
  const { output } = await runChecks({ directory: "/" }, ["pwd"], {
    write: () => undefined,
  });

  assert.equal(output.checks[0].output.trim(), "/");
});

test("what a command writes reaches the worker's own stdout as it runs", async () => {
  const written = [];

  const { output } = await runChecks(
    workspace,
    ["printf out; printf err >&2"],
    { write: (text) => written.push(text) },
  );

  assert.equal(written.join(""), output.checks[0].output);
  assert.ok(written.join("").includes("out"));
  assert.ok(written.join("").includes("err"));
});

test("stdout keeps what the capture had to drop", async () => {
  const written = [];

  const { output } = await ran([chatty], {
    write: (text) => written.push(text),
  });

  assert.equal(output.checks[0].output.length, workerCheckOutputCharsMax);
  assert.equal(written.join("").length, workerCheckOutputCharsMax * 2);
});
