import assert from "node:assert/strict";
import test from "node:test";

import {
  workerTaskVariable,
  workerWorkspaceVariable,
} from "@chuggy/worker-contract/workerEnvironment";

import {
  jobEnvelope,
  jobEnvironmentAttempt,
  jobEnvironmentFile,
  reservedJobVariables,
} from "./job.mjs";

const assignment = {
  assignment: "asg-1",
  capabilities: ["container"],
  image: "registry.chuggy.example/worker:1",
  cpuMillis: 1000,
  memoryMib: 1024,
  deadlineSecs: 600,
  callbackUrl: "https://chuggy.example/worker",
  bearer: "attempt-bearer-secret",
};
const bounds = { timeoutSecsMax: 3600, outputBytesMax: 65536 };

test("the envelope is the assignment's callback and bearer with the runner's bounds and paths", () => {
  assert.deepEqual(JSON.parse(jobEnvelope(assignment, bounds)), {
    callbackUrl: "https://chuggy.example/worker",
    bearer: "attempt-bearer-secret",
    workspace: "/workspace",
    timeoutSecsMax: 3600,
    outputBytesMax: 65536,
    providerCredentialFile: "/var/run/chuggy/credentials/claude-code",
  });
});

test("an envelope the contract refuses names its fields and never their values", () => {
  assert.throws(
    () =>
      jobEnvelope(
        { ...assignment, callbackUrl: "attempt-bearer-secret", bearer: "" },
        bounds,
      ),
    (error) =>
      error instanceof RangeError &&
      error.message ===
        "the assignment makes no envelope its container can read: callbackUrl, bearer",
  );
});

test("the env file carries the envelope first and each variable a line", () => {
  assert.equal(
    jobEnvironmentFile('{"a":"b c"}', {
      GIT_AUTHOR_NAME: "chuggy bot",
      EMPTY: "",
    }),
    'CHUG_WORKER_TASK={"a":"b c"}\nGIT_AUTHOR_NAME=chuggy bot\nEMPTY=\n',
  );
});

test("a value that would break a line is refused rather than split", () => {
  for (const value of ["a\nINJECTED=1", "a\rb"])
    assert.throws(
      () => jobEnvironmentFile("{}", { NAME: value }),
      /NAME cannot be carried by an env file/u,
    );
});

test("the attempt is read back from the envelope among a container's variables", () => {
  const variables = jobEnvironmentFile(jobEnvelope(assignment, bounds), {
    GIT_AUTHOR_NAME: "chuggy bot",
  })
    .split("\n")
    .filter((line) => line.length > 0);
  assert.deepEqual(
    jobEnvironmentAttempt([
      "PATH=/usr/bin",
      "CHUG_WORKER_TASK_OTHER={}",
      ...variables,
    ]),
    {
      callbackUrl: "https://chuggy.example/worker",
      bearer: "attempt-bearer-secret",
    },
  );
});

test("variables carrying no envelope the contract reads hold no attempt", () => {
  const envelope = JSON.parse(jobEnvelope(assignment, bounds));
  for (const variables of [
    [],
    ["CHUG_WORKER_TASK_OTHER={}"],
    ["CHUG_WORKER_TASK={not json"],
    [`CHUG_WORKER_TASK=${JSON.stringify({ ...envelope, bearer: "" })}`],
  ])
    assert.equal(
      jobEnvironmentAttempt(variables),
      undefined,
      String(variables),
    );
});

/** Catches a variable the runner sets in a job left for a runner's environment to name, and so shadow. */
test("each variable a job is handed by the runner or its core is reserved", () => {
  assert.deepEqual(
    reservedJobVariables.toSorted(),
    [
      workerTaskVariable,
      "CLAUDE_CODE_OAUTH_TOKEN",
      workerWorkspaceVariable,
    ].toSorted(),
  );
});
