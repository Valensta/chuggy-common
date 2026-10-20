import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  workerRunnerHeader,
  workerRunnerOf,
} from "@chuggy/worker-contract/workerPool";

import { poolRunnerClient, poolRunnerLoop } from "./poolRunner.mjs";

/**
 * A client whose issuer is down for its first pass and whose plane answers
 * each poll after that from a script, as its backend answers what ended.
 *
 * @param {Array<() => unknown>} polls
 * @param {unknown[][]} ends
 */
function scriptedClient(polls, ends = []) {
  /** @type {string[]} */
  const placed = [];
  let acquired = 0;
  let polled = 0;
  let ending = 0;
  const client = {
    tokens: {
      acquire: async () =>
        acquired++ === 0
          ? {
              acquired: "Unavailable",
              evidence: "the issuer could not be reached",
            }
          : { acquired: "Token", token: "pool-token" },
      invalidate: () => undefined,
    },
    plane: {
      poll: async () => polls[polled++](),
      settle: async () => "Settled",
    },
    jobs: { end: async () => "Ended" },
    backend: {
      held: async () => [],
      ended: async () => ends[ending++] ?? [],
      place: async (/** @type {{assignment: string}} */ assignment) => {
        placed.push(assignment.assignment);
        return { placed: "Placed" };
      },
      stop: async () => ({ stopped: "Stopped" }),
    },
    settings: { concurrencyMax: 2, outageBackoffMs: 5000, passesMax: 1 },
  };
  return { client, placed };
}

test("a run passes until the plane denies the pool, logging each outage and each pass that did something", async () => {
  const { client, placed } = scriptedClient([
    () => ({
      polled: "Reconciled",
      assignments: [{ assignment: "asg-1" }],
      sessions: [],
      stop: [],
    }),
    () => ({ polled: "Reconciled", assignments: [], sessions: [], stop: [] }),
    () => ({ polled: "Denied", evidence: "the pool was revoked" }),
  ]);
  /** @type {string[]} */
  const log = [];
  /** @type {number[]} */
  const slept = [];
  const denied = await poolRunnerLoop(/** @type {any} */ (client), {
    sleep: async (ms) => {
      slept.push(ms);
    },
    log: (line) => log.push(line),
  });
  assert.deepEqual(denied, {
    passed: "Denied",
    evidence: "the pool was revoked",
  });
  assert.deepEqual(placed, ["asg-1"]);
  assert.deepEqual(slept, [5000]);
  assert.deepEqual(log, [
    "outage: the issuer could not be reached",
    "placed 1, stopped 0, refused 0",
    "the plane denied this pool: the pool was revoked",
  ]);
});

test("a pass that ended a job is logged with how many, and one that ended none names no count", async () => {
  const quiet = () => ({
    polled: "Reconciled",
    assignments: [],
    sessions: [],
    stop: [],
  });
  const { client } = scriptedClient(
    [
      quiet,
      quiet,
      () => ({ polled: "Denied", evidence: "the pool was revoked" }),
    ],
    [
      [
        {
          kind: "Job",
          job: {
            assignment: "asg-1",
            callbackUrl: "https://chuggy.example/worker",
            bearer: "attempt-bearer",
          },
          why: "its container exited with status 1",
        },
      ],
    ],
  );
  /** @type {string[]} */
  const log = [];
  await poolRunnerLoop(/** @type {any} */ (client), {
    sleep: async () => undefined,
    log: (line) => log.push(line),
  });
  assert.deepEqual(log, [
    "outage: the issuer could not be reached",
    "placed 0, stopped 0, refused 0, ended 1",
    "the plane denied this pool: the pool was revoked",
  ]);
});

/** A registration's credentials, as the pool file holds them. */
const credentials = {
  tenant: "acme",
  project: "app",
  pool: "laptop",
  capabilities: ["Platform:Linux:Arm64"],
  tokenUrl: "https://auth.example/oauth2/token",
  audience: "https://chuggy.example",
  planeUrl: "https://chuggy.example/pool",
  clientId: "pool-client",
  clientSecret: "pool-secret",
};

test("a runner's client makes one pass a run, holds its limits, and takes the token source it is given", () => {
  const tokens = {
    acquire: async () => ({ acquired: "Token", token: "pool-token" }),
    invalidate: () => undefined,
  };
  const backend = /** @type {any} */ ({});
  const client = poolRunnerClient(
    credentials,
    backend,
    { concurrencyMax: 3, sessionsMax: 0 },
    { tokens },
  );
  assert.equal(client.tokens, tokens);
  assert.equal(client.backend, backend);
  assert.equal(client.settings.passesMax, 1);
  assert.equal(client.settings.concurrencyMax, 3);
  assert.equal(client.settings.sessionsMax, 0);
  assert.throws(
    () =>
      poolRunnerClient(
        credentials,
        backend,
        { concurrencyMax: 0, sessionsMax: 0 },
        { tokens },
      ),
    RangeError,
  );
});

test("a run whose runner has installed the release it updates to ends with the version it is restarted on", async () => {
  const release = {
    package: "chuggy-linux",
    version: "0.14.1",
    url: "https://github.com/kasofsk/chuggy-linux/releases/download/v0.14.1/chuggy-linux-0.14.1.tgz",
    integrity: `sha512-${"A".repeat(86)}==`,
  };
  const pinned = () => ({
    polled: "Reconciled",
    assignments: [],
    sessions: [],
    stop: [],
    release,
  });
  const { client } = scriptedClient([pinned, pinned]);
  /** @type {string[]} */
  const log = [];
  const updated = await poolRunnerLoop(/** @type {any} */ (client), {
    sleep: async () => undefined,
    log: (line) => log.push(line),
    updates: {
      on: true,
      updater: {
        runner: { package: "chuggy-linux", version: "0.14.0" },
        refusal: async () => undefined,
        prove: async () => ({ proved: "Proved" }),
        update: async () => ({ updated: "Installed", version: "0.14.1" }),
      },
    },
  });
  assert.deepEqual(updated, { passed: "Updated", version: "0.14.1" });
  assert.deepEqual(log, [
    "outage: the issuer could not be reached",
    "updating to chuggy-linux 0.14.1",
    "chuggy-linux 0.14.1 is installed, and this runner ends to start on it",
  ]);
});

test("a runner's client names the runner it is given on each poll, and one given none names none", async (t) => {
  /** @type {Array<Record<string, string>>} */
  const sent = [];
  mock.method(globalThis, "fetch", async (_input, init) => {
    sent.push(init.headers);
    return new globalThis.Response(
      JSON.stringify({ assignments: [], sessions: [], stop: [] }),
      { status: 200 },
    );
  });
  t.after(() => mock.restoreAll());
  const backend = /** @type {any} */ ({});
  const limits = { concurrencyMax: 1, sessionsMax: 0 };
  const runner = { package: "chuggy-linux", version: "0.14.0" };
  await poolRunnerClient(credentials, backend, limits, { runner }).plane.poll(
    "pool-token",
    [],
    1,
    0,
  );
  await poolRunnerClient(credentials, backend, limits).plane.poll(
    "pool-token",
    [],
    1,
    0,
  );
  assert.deepEqual(workerRunnerOf(sent[0][workerRunnerHeader]), runner);
  assert.equal(workerRunnerHeader in sent[1], false);
});
