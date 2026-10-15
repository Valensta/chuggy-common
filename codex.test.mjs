import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resultReportCharsMax } from "@chuggy/worker-contract/workerDocuments";

import {
  codexAgent,
  codexConfiguration,
  codexInvocation,
  codexResult,
  prepareCodexCredential,
} from "./codex.mjs";
import { coreRuntime } from "./coreRuntime.mjs";

const task = {
  worker: {
    mode: {
      type: "SingleAgent",
      agent: "Codex",
      model: "gpt-5.3-codex",
      arguments: [],
    },
  },
  briefing: { text: "briefing" },
};

test("a Codex invocation is ephemeral and constrained to the result schema", () => {
  assert.deepEqual(
    codexInvocation(task, { resultSchema: "/tmp/result.json" }),
    [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--model",
      "gpt-5.3-codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "--output-schema",
      "/tmp/result.json",
      "briefing",
    ],
  );
});

test("Codex configuration records the runtime version and pinned model", async () => {
  const executed = [];
  assert.deepEqual(
    await codexConfiguration(task, { CODEX_HOME: "/tmp/codex" }, (...args) => {
      executed.push(args);
      return Promise.resolve({ stdout: "codex-cli 0.151.0\n" });
    }),
    {
      agent: "Codex",
      codexVersion: "codex-cli 0.151.0",
      model: "gpt-5.3-codex",
      userConfig: "Ignored",
      projectRules: "Ignored",
    },
  );
  assert.deepEqual(executed, [
    [
      coreRuntime.codex,
      ["--version"],
      { env: { CODEX_HOME: "/tmp/codex" }, maxBuffer: 4096 },
    ],
  ]);
});

test("attached values cannot evade reserved Codex short options", () => {
  for (const argument of [
    "-mother-model",
    '-cmodel="other"',
    "-pother-profile",
    "-sread-only",
    "-C/other/workspace",
  ])
    assert.throws(
      () =>
        codexInvocation(
          {
            ...task,
            worker: {
              mode: { ...task.worker.mode, arguments: [argument] },
            },
          },
          { resultSchema: "/tmp/result.json" },
        ),
      /reserves Codex argument/u,
    );
});

test("the final Codex agent message supplies the structured result", () => {
  const output = {
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({ verdict: "Pass", summary: "done" }),
    },
  };
  assert.deepEqual(codexResult([output]), {
    output,
    result: { verdict: "Pass", summary: "done" },
  });
});

test("Codex must return a structured verdict", () => {
  assert.throws(
    () =>
      codexResult([
        {
          type: "item.completed",
          item: { type: "agent_message", text: "done" },
        },
      ]),
    /Codex returned no structured verdict/u,
  );
});

test("a summary the schema admits is taken though its code units exceed the bound", () => {
  const summary = "\u{1F600}".repeat(resultReportCharsMax);
  const output = {
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({ verdict: "Pass", summary }),
    },
  };
  assert.equal(codexResult([output]).result.summary, summary);
});

test("ticket configuration cannot replace worker-owned Codex arguments", () => {
  assert.throws(
    () =>
      codexInvocation(
        {
          ...task,
          worker: {
            mode: {
              type: "SingleAgent",
              agent: "Codex",
              model: "gpt-5.3-codex",
              arguments: ["--output-schema=mine.json"],
            },
          },
        },
        { resultSchema: "/tmp/result.json" },
      ),
    /reserves Codex argument --output-schema=/u,
  );
});

test("ticket configuration cannot override the pinned Codex model through config", () => {
  assert.throws(
    () =>
      codexInvocation(
        {
          ...task,
          worker: {
            mode: {
              ...task.worker.mode,
              arguments: ['--config=model="other"'],
            },
          },
        },
        { resultSchema: "/tmp/result.json" },
      ),
    /reserves Codex argument --config=/u,
  );
});

test("Codex usage is translated into the run evidence vocabulary", () => {
  assert.deepEqual(
    codexAgent.observed({
      type: "turn.completed",
      usage: { input_tokens: 3, cached_input_tokens: 2, output_tokens: 1 },
    }),
    {
      usage: {
        input_tokens: 3,
        output_tokens: 1,
        cache_read_input_tokens: 2,
      },
      num_turns: 1,
    },
  );
});

test("a mounted Codex OAuth document becomes a private writable CODEX_HOME", async () => {
  const parent = await mkdtemp(join(tmpdir(), "chuggy-codex-test-"));
  const home = join(parent, "home");
  const auth = JSON.stringify({
    tokens: {
      access_token: "access-token-long-enough",
      refresh_token: "refresh-token-long-enough",
    },
  });
  const prepared = await prepareCodexCredential(auth, home);
  assert.deepEqual(prepared.environment, { CODEX_HOME: home });
  assert.deepEqual(prepared.secrets, [
    auth,
    "access-token-long-enough",
    "refresh-token-long-enough",
  ]);
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), `${auth}\n`);
});

/** Catches a Codex home outside HOME, the directory a job's check found writable. */
test("a Codex credential's home is under HOME where none is named", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "chuggy-codex-default-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    await rm(home, { recursive: true, force: true });
  });

  const prepared = await prepareCodexCredential(JSON.stringify({ tokens: {} }));

  assert.equal(dirname(prepared.environment.CODEX_HOME), home);
  await readFile(join(prepared.environment.CODEX_HOME, "auth.json"), "utf8");
});
