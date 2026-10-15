import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

import { workTaskAnswerSchema } from "@chuggy/worker-contract/workerTask";

import { claudeAgent, claudeInvocation, claudeResult } from "./claude.mjs";

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
    "--mcp-config",
    '{"mcpServers":{}}',
    "--allowedTools=Bash,Edit,Read,Write,Glob,Grep",
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
