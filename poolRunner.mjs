/**
 * A pool runner composed beside its backend: the pool's token source and plane
 * client from its credentials, the job and session planes, and the loop. Each
 * runner brings its own backend, service manager and platform checks.
 *
 * THE RUN IS PASSES UNTIL A DENIAL, OR THE RUNNER'S UPDATE OF ITSELF, rather
 * than `workerPoolClientRun`'s count of them, because the placements a run has
 * in flight live in its memory. Each outage is logged, since under a service
 * manager an unlogged one is a pool that silently stopped working. A pass that
 * throws ends the run, and the service manager's restart begins the next from
 * what the backend lists.
 */

import { poolJobPlaneClient } from "./poolJobPlane.mjs";
import {
  checkedWorkerPoolClientSettings,
  workerPoolClientPass,
  workerPoolUpdating,
} from "./poolLoop.mjs";
import { poolPlaneClient } from "./poolPlane.mjs";
import { poolSessionPlaneClient } from "./poolSessionPlane.mjs";
import { poolClientTokens } from "./poolTokens.mjs";

/**
 * @typedef {import("./poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("./poolLoop.mjs").WorkerPoolBackend} WorkerPoolBackend
 * @typedef {import("./poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("./poolLoop.mjs").WorkerPoolPass} WorkerPoolPass
 * @typedef {import("./poolLoop.mjs").WorkerPoolUpdates} WorkerPoolUpdates
 * @typedef {import("./runnerUpdate.mjs").RunnerIdentity} RunnerIdentity
 *
 * @typedef {object} PoolRunnerLimits
 * @property {number} concurrencyMax
 * @property {number} sessionsMax
 */

/**
 * Chuggy's own pool client's bounds, which its issuer and plane are sized for.
 * A refusal is confirmed for longer than the issuer stays ready with its
 * database away, which its readiness probe bounds, and for little more, since
 * a deleted client's run ends only once it has passed.
 */
const tokenSettings = {
  requestTimeoutMs: 10_000,
  responseBytesMax: 64 * 1024,
  responseReadsMax: 64,
  refreshMarginMs: 60_000,
  mintCooldownMs: 1_000,
  refusalConfirmMs: 90_000,
};
const planeSettings = { pollTimeoutMs: 120_000, settleTimeoutMs: 10_000 };
const jobPlaneSettings = { timeoutMs: 10_000 };
const sessionPlaneSettings = { timeoutMs: 10_000 };
const outageBackoffMs = 5_000;

/**
 * @param {PoolCredentials} credentials
 * @returns {WorkerPoolClient["tokens"]}
 */
export function poolRunnerTokens(credentials) {
  return poolClientTokens({
    tokenUrl: credentials.tokenUrl,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    audience: [credentials.audience],
    scope: [],
    ...tokenSettings,
  });
}

/**
 * @param {PoolCredentials} credentials
 * @param {RunnerIdentity} [runner] the runner's package and version, which each poll names
 * @param {readonly string[]} [capabilities] the runner's capabilities, which each poll names; none, and the set its registration recorded stands
 * @returns {WorkerPoolClient["plane"]}
 */
export function poolRunnerPlane(credentials, runner, capabilities) {
  return poolPlaneClient({
    baseUrl: credentials.planeUrl,
    ...planeSettings,
    ...(runner === undefined ? {} : { runner }),
    ...(capabilities === undefined ? {} : { capabilities }),
  });
}

/**
 * The client a run passes with, one pass at a time.
 *
 * @param {PoolCredentials} credentials
 * @param {WorkerPoolBackend} backend
 * @param {PoolRunnerLimits} limits
 * @param {{tokens?: WorkerPoolClient["tokens"], fetch?: typeof globalThis.fetch, runner?: RunnerIdentity, capabilities?: readonly string[]}} [seams] the token source when not the pool file's, the fetch a job's or a session's plane is reached by when not the global one, and the runner and the capabilities each poll names
 * @returns {WorkerPoolClient}
 */
export function poolRunnerClient(credentials, backend, limits, seams = {}) {
  return {
    tokens: seams.tokens ?? poolRunnerTokens(credentials),
    plane: poolRunnerPlane(credentials, seams.runner, seams.capabilities),
    jobs: poolJobPlaneClient(jobPlaneSettings, seams.fetch),
    sessions: poolSessionPlaneClient(sessionPlaneSettings, seams.fetch),
    backend,
    settings: checkedWorkerPoolClientSettings({
      concurrencyMax: limits.concurrencyMax,
      sessionsMax: limits.sessionsMax,
      outageBackoffMs,
      passesMax: 1,
    }),
  };
}

/**
 * What a pass did, as a log line, naming the workloads it ended only where it
 * ended any.
 *
 * @param {{placed: number, stopped: number, refused: number, ended: number}} pass
 */
export function poolRunnerPassLine(pass) {
  const line = `placed ${String(pass.placed)}, stopped ${String(pass.stopped)}, refused ${String(pass.refused)}`;
  return pass.ended === 0 ? line : `${line}, ended ${String(pass.ended)}`;
}

/**
 * The pool loop until the plane denies the pool, or until the runner has
 * installed the release it updates itself to, which it is restarted on.
 *
 * @param {WorkerPoolClient} client
 * @param {{sleep: (ms: number) => Promise<void>, log: (line: string) => void, updates?: WorkerPoolUpdates, nowMs?: () => number}} seams `updates` where the runner updates itself or says a release is out
 * @returns {Promise<Extract<WorkerPoolPass, {passed: "Denied" | "Updated"}>>}
 */
export async function poolRunnerLoop(client, seams) {
  const updating =
    seams.updates === undefined
      ? undefined
      : workerPoolUpdating(seams.updates, {
          log: seams.log,
          nowMs: seams.nowMs ?? Date.now,
        });
  for (;;) {
    const pass = await workerPoolClientPass(client, updating);
    if (pass.passed === "Updated") return pass;
    if (pass.passed === "Denied") {
      seams.log(`the plane denied this pool: ${pass.evidence}`);
      return pass;
    }
    if (pass.passed === "Unavailable") {
      seams.log(`outage: ${pass.evidence}`);
      await seams.sleep(client.settings.outageBackoffMs);
    } else if (pass.placed + pass.stopped + pass.refused + pass.ended > 0)
      seams.log(poolRunnerPassLine(pass));
  }
}
