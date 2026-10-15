import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { URL } from "node:url";

import { workTaskAnswerSchema } from "@chuggy/worker-contract/workerTask";

import {
  workerImageVariable,
  workerStageEnvironment,
  workerUnkeptEnvironment,
} from "./checks.mjs";
import {
  claudeAgent,
  claudeInvocation,
  claudeResult,
  claudeShellScript,
  prepareClaudeShell,
} from "./claude.mjs";
import { agentShells, posixShells } from "./shells.fixture.mjs";

/** Catches a job's agent moving a long command to the background, where the headless run kills it unseen. */
test("a Claude job never moves a command to the background", () => {
  assert.equal(
    claudeAgent.prepareCredential("token").environment
      .CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
    "1",
  );
});

/** Catches a run's Claude Code replacing itself, which an image's environment no longer prevents. */
test("a Claude run never updates its Claude Code", () => {
  assert.equal(
    claudeAgent.prepareCredential("token").environment.DISABLE_AUTOUPDATER,
    "1",
  );
});

/** The worker is parsed by the contract first, so the fixture is one a plane could serve. */
test("a configured Claude worker composes a valid default Claude invocation", async () => {
  const configuration = JSON.parse(
    await readFile(
      new URL("./configuration.fixture.json", import.meta.url),
      "utf8",
    ),
  );
  const task = {
    worker: workTaskAnswerSchema.shape.worker.parse(configuration.worker),
    briefing: { text: "briefing" },
  };

  assert.deepEqual(claudeInvocation(task).slice(-4), [
    '--mcp-config={"mcpServers":{}}',
    "--allowedTools=Bash,Edit,Read,Write,Glob,Grep",
    "--",
    "briefing",
  ]);
  assert.deepEqual(claudeInvocation(task).slice(0, 5), [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
  ]);
});

test("the final structured event is retained after streamed progress", () => {
  const final = {
    type: "result",
    structured_output: { verdict: "Pass", summary: "done" },
  };
  assert.deepEqual(
    claudeResult([{ type: "assistant", message: "working" }, final]),
    { output: final, result: final.structured_output },
  );
});

/**
 * Catches the briefing taken as a value of the option before it, which
 * `--mcp-config` and a worker's own variadic option both take every word
 * after them for, and which leaves a run with no prompt.
 */
test("a Claude briefing is the prompt whatever options precede it", () => {
  for (const configured of [[], ["--allowedTools", "Bash", "Read"]]) {
    const argv = claudeInvocation({
      worker: {
        mode: { type: "SingleAgent", agent: "Claude", arguments: configured },
      },
      briefing: { text: "briefing" },
    });

    assert.deepEqual(argv.slice(-2), ["--", "briefing"]);
    assert.equal(argv.indexOf("--"), argv.length - 2);
    assert.ok(argv.includes('--mcp-config={"mcpServers":{}}'));
    assert.ok(!argv.includes("--mcp-config"));
  }
});

/** Catches a worker's `--` making the run's own `--` and briefing two prompts. */
test("ticket configuration cannot end the run's options itself", () => {
  assert.throws(
    () =>
      claudeInvocation({
        worker: {
          mode: { type: "SingleAgent", agent: "Claude", arguments: ["--"] },
        },
        briefing: { text: "briefing" },
      }),
    /reserves Claude argument --$/u,
  );
});

test("ticket configuration cannot replace worker-owned Claude arguments", () => {
  assert.throws(
    () =>
      claudeInvocation({
        worker: {
          mode: {
            type: "SingleAgent",
            agent: "Claude",
            arguments: ["--mcp-config={}"],
          },
        },
        briefing: { text: "briefing" },
      }),
    /reserves Claude argument --mcp-config=/,
  );
});

/**
 * A pod's environment as a job's `check.sh` leaves it, for an image that set
 * three of the variables it moves aside: one to what this suite's node runs
 * under, one empty, and one to a value no shell word survives unquoted.
 */
const checkedPod = {
  PATH: process.env.PATH ?? "",
  CHUG_SUITE_POD_VARIABLE: "the pod's own",
  [workerImageVariable("NODE_OPTIONS")]: "--max-old-space-size=4096",
  [workerImageVariable("NODE_PATH")]: "",
  [workerImageVariable("LD_LIBRARY_PATH")]:
    '/image/it\'s "lib":$HOME/`id`\\\n\tend',
};

/** The variables a shell adds of its own to what it execs. */
const shellOwnVariables = ["PWD", "SHLVL", "OLDPWD", "_"];

/**
 * What a command of Claude Code's Bash tool is started with, the script run
 * as Claude Code runs it: its text, then the command, in one shell started
 * with the agent's own environment. The command is this suite's node, which
 * reports the environment it was handed. Its stdin is closed, since bash
 * takes the socket node would hand it for a remote shell's and reads this
 * machine's bashrc.
 */
function claudeCommandEnvironment(shell, script, environment) {
  const report = "process.stdout.write(JSON.stringify(process.env))";
  const ran = spawnSync(
    shell.argv[0],
    [
      ...shell.argv.slice(1),
      "-c",
      `${script.trim()}\n: && exec "$0" -e '${report}'`,
      process.execPath,
    ],
    { env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(ran.status, 0, ran.stderr);
  const seen = JSON.parse(ran.stdout);
  for (const name of shellOwnVariables) delete seen[name];
  return seen;
}

/**
 * Catches an agent's shell running a project's commands in an environment a
 * check stage's shells are not handed: a value lost, mangled by its quoting,
 * or left under the name `check.sh` kept it under.
 */
for (const shell of [...agentShells, ...posixShells])
  test(
    `a Claude command under ${shell.name} is handed what a check stage's shells are`,
    {
      skip: shell.absent,
    },
    () => {
      assert.deepEqual(
        claudeCommandEnvironment(
          shell,
          claudeShellScript(checkedPod),
          workerUnkeptEnvironment(checkedPod),
        ),
        workerStageEnvironment(checkedPod),
      );
    },
  );

/** Catches a script that leaves a variable set where the image set none. */
test("an image that set nothing a check moves aside gives Claude's shell nothing to run", () => {
  assert.equal(claudeShellScript({ PATH: "/usr/bin" }), "");
});

/**
 * Catches the script where Claude Code is not told of it, readable by another
 * user, or written over one something else left, which this run would then
 * take for its own.
 */
test("a Claude run's shell script is written once, privately, where CLAUDE_ENV_FILE names it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-claude-shell-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "shell.sh");

  assert.deepEqual(await prepareClaudeShell(checkedPod, file), {
    environment: { CLAUDE_ENV_FILE: file },
    arguments: [],
  });
  assert.equal(await readFile(file, "utf8"), claudeShellScript(checkedPod));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(prepareClaudeShell(checkedPod, file), /EEXIST/u);
  assert.equal(claudeAgent.prepareShell, prepareClaudeShell);
});

/** Catches the script written outside HOME, the directory a job's check found writable. */
test("a Claude run's shell script is under HOME where none is named", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "chuggy-claude-home-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    await rm(home, { recursive: true, force: true });
  });

  const prepared = await prepareClaudeShell(checkedPod);

  assert.equal(dirname(prepared.environment.CLAUDE_ENV_FILE), home);
});
