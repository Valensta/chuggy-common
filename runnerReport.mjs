/**
 * A runner's report of how its machine and its work are doing, which its pool
 * plane holds against the runner its bearer names. It is made only where the
 * runner's companion turns it on, and off nothing here is made at all.
 *
 * WHAT IT COUNTS IS WHAT THE RUNNER ALREADY DOES, seen through its own plane
 * and backend, wrapped: each poll and whether its answer named a release,
 * which only the plane's own does; each settlement by its outcome, and each
 * refusal by its image's fault; each job's end by how it ended, a stop this
 * pool made and a placement its backend refused included; each session's end
 * by its phase; and what its last `held` found running of each kind. Its
 * backend measures its image pulls and its runs. Every count is since this
 * process made the client, and nothing a wrapper counts changes what the
 * wrapped call does or answers.
 *
 * THE MACHINE IS THE COMPANION'S TO DESCRIBE. A fact its seam leaves out, or
 * gives as no figure the contract reads, is left out of the report, since
 * only the companion knows what its OS's figures mean. A machine's name the
 * contract does not read is sent with each character it does not read as a
 * `-`, and with nothing before its first letter or digit; a name of none is
 * `unnamed`.
 *
 * A REPORT IS SENT ONLY TO A PLANE THAT TAKES ONE, as the version the last
 * poll's answer naming one says: one at once after the first poll whose
 * answer names `workerContractRunnerReport` or later, and then every
 * `runnerReportIntervalMs` while the latest named still does. It is sent
 * under the token the last poll the plane did not reject was made under, by
 * the plane client that made it, behind the passes, which never wait on it.
 * A body the contract's schema does not read, or that weighs more than
 * `workerRunnerReportBytesMax`, is not sent. A report that fails is dropped,
 * and is said once as the failures start and once as one is taken again.
 */

import { setTimeout as waitDefault } from "node:timers/promises";
import { TextEncoder } from "node:util";

import { workerContractRunnerReport } from "@chuggy/worker-contract/workerContract";
import {
  workerRunnerHostCharsMax,
  workerRunnerImagePullBoundsSecs,
  workerRunnerReportBytesMax,
  workerRunnerReportSchema,
  workerRunnerRunBoundsSecs,
} from "@chuggy/worker-contract/workerPool";

/**
 * @typedef {import("@chuggy/worker-contract/workerPool").WorkerRunnerReport} WorkerRunnerReport
 * @typedef {import("@chuggy/worker-contract/workerContract").WorkerContractVersion} WorkerContractVersion
 * @typedef {import("./poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("./poolLoop.mjs").WorkerPoolBackend} WorkerPoolBackend
 * @typedef {import("./poolLoop.mjs").WorkerPoolPlane} WorkerPoolPlane
 * @typedef {import("./poolLoop.mjs").WorkerPoolWorkloadKind} WorkerPoolWorkloadKind
 * @typedef {import("./poolLoop.mjs").WorkerPoolEnded} WorkerPoolEnded
 *
 * @typedef {{bucketCounts: number[], sumSecs: number}} RunnerHistogram
 * @typedef {{imagePullSecs: RunnerHistogram, runSecs: Record<WorkerPoolWorkloadKind, RunnerHistogram>}} RunnerMeasured
 *
 * @typedef {object} RunnerMeasures what a backend measures of itself
 * @property {(secs: number) => void} pulled an image pull that was made
 * @property {(kind: WorkerPoolWorkloadKind, secs: number) => void} ran a run that ended, however
 * @property {() => RunnerMeasured} measured
 *
 * @typedef {Pick<WorkerRunnerReport, "diskFreeBytes" | "diskFloorBytes" | "cpus" | "loadAverageOneMinute" | "memoryTotalBytes" | "memoryAvailableBytes">} RunnerMachine
 *
 * @typedef {object} RunnerReportingSeams
 * @property {(line: string) => void} log
 * @property {() => RunnerMachine | Promise<RunnerMachine>} [machine] the companion's facts of its machine; none, and the report names none
 * @property {string} host the machine's name
 * @property {() => number} [uptimeSecs] how long this process has run; `process.uptime` where absent
 * @property {(ms: number, signal: AbortSignal) => Promise<unknown>} [wait] rejects once `signal` aborts
 *
 * @typedef {object} RunnerReporting
 * @property {WorkerPoolClient} client the client given, but for a plane and a backend that count what they do
 * @property {() => void} ended sends no more
 */

/** How long a runner waits after one report before it sends the next. */
export const runnerReportIntervalMs = 60_000;

/**
 * A histogram of `bounds` that observed nothing.
 *
 * @param {readonly number[]} bounds
 * @returns {RunnerHistogram}
 */
function runnerHistogramNone(bounds) {
  return { bucketCounts: [...bounds.map(() => 0), 0], sumSecs: 0 };
}

/**
 * Counts `secs` in the first bucket whose bound it does not pass, or the one
 * past the last; a duration no clock could give is not counted.
 *
 * @param {RunnerHistogram} histogram
 * @param {readonly number[]} bounds
 * @param {number} secs
 */
function runnerHistogramObserved(histogram, bounds, secs) {
  if (!Number.isFinite(secs) || secs < 0) return;
  const bucket = bounds.findIndex((bound) => secs <= bound);
  histogram.bucketCounts[bucket === -1 ? bounds.length : bucket] += 1;
  histogram.sumSecs += secs;
}

/** @returns {RunnerMeasured} */
function runnerMeasuredNone() {
  return {
    imagePullSecs: runnerHistogramNone(workerRunnerImagePullBoundsSecs),
    runSecs: {
      Job: runnerHistogramNone(workerRunnerRunBoundsSecs),
      Session: runnerHistogramNone(workerRunnerRunBoundsSecs),
    },
  };
}

/**
 * What a backend measures of itself from now.
 *
 * @returns {RunnerMeasures}
 */
export function runnerMeasures() {
  const measured = runnerMeasuredNone();
  return {
    pulled: (secs) =>
      runnerHistogramObserved(
        measured.imagePullSecs,
        workerRunnerImagePullBoundsSecs,
        secs,
      ),
    ran: (kind, secs) =>
      runnerHistogramObserved(
        measured.runSecs[kind],
        workerRunnerRunBoundsSecs,
        secs,
      ),
    measured: () => globalThis.structuredClone(measured),
  };
}

/**
 * What several backends measured, together.
 *
 * @param {readonly RunnerMeasured[]} each
 * @returns {RunnerMeasured}
 */
export function runnerMeasuredSum(each) {
  /**
   * @param {RunnerHistogram} into
   * @param {RunnerHistogram} from
   */
  const added = (into, from) => {
    from.bucketCounts.forEach((count, bucket) => {
      into.bucketCounts[bucket] += count;
    });
    into.sumSecs += from.sumSecs;
  };
  const sum = runnerMeasuredNone();
  for (const measured of each) {
    added(sum.imagePullSecs, measured.imagePullSecs);
    added(sum.runSecs.Job, measured.runSecs.Job);
    added(sum.runSecs.Session, measured.runSecs.Session);
  }
  return sum;
}

/**
 * A machine's name as the contract reads one.
 *
 * @param {string} name
 */
export function runnerReportHost(name) {
  const read = name
    .replace(/[^A-Za-z0-9._-]/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "")
    .slice(0, workerRunnerHostCharsMax);
  return read === "" ? "unnamed" : read;
}

/**
 * Whether a plane whose answers name `version` takes a report.
 *
 * @param {WorkerContractVersion | undefined} version
 */
export function runnerReportTaken(version) {
  return (
    version !== undefined &&
    version.major === workerContractRunnerReport.major &&
    version.minor >= workerContractRunnerReport.minor
  );
}

/**
 * @typedef {object} RunnerReportCounts
 * @property {number} polls
 * @property {number} pollsFailed
 * @property {Record<string, number>} settlements
 * @property {Record<string, number>} refusals
 * @property {Record<string, number>} jobsEnded
 * @property {Record<string, number>} sessionsEnded
 * @property {Map<string, WorkerPoolWorkloadKind>} held what the last `held` found, by assignment
 *
 * @typedef {object} RunnerReportState
 * @property {WorkerPoolClient} client the one reporting, whose settings are read as each report is made
 * @property {WorkerPoolBackend} backend the one given, which measures itself
 * @property {Required<Pick<WorkerPoolPlane, "report">>} plane
 * @property {RunnerReportingSeams} seams
 * @property {RunnerReportCounts} counts
 * @property {WorkerContractVersion | undefined} version the latest a poll's answer named
 * @property {string | undefined} token
 * @property {boolean} ticking
 * @property {boolean} failing
 * @property {AbortController} cut
 */

/**
 * @param {Record<string, number>} tally
 * @param {string} label
 */
function runnerReportCounted(tally, label) {
  tally[label] = (tally[label] ?? 0) + 1;
}

/**
 * How a job's end is counted.
 *
 * @param {Extract<WorkerPoolEnded, {kind: "Job"}>} ended
 */
function runnerReportJobEnd(ended) {
  return ended.killed ?? ended.ran ?? "PlacementFailed";
}

/**
 * The plane, counting each poll and settlement and starting the reports
 * once a poll's answer names a version that takes them.
 *
 * @param {RunnerReportState} state
 * @param {WorkerPoolPlane} plane
 * @returns {WorkerPoolPlane}
 */
function runnerReportPlane(state, plane) {
  const { counts } = state;
  return {
    ...plane,
    poll: async (token, ...asked) => {
      const polled = await plane.poll(token, ...asked);
      const version = plane.polledVersion?.();
      counts.polls += 1;
      if (version === undefined) counts.pollsFailed += 1;
      else state.version = version;
      if (polled.polled !== "Stale") state.token = token;
      runnerReportStarted(state);
      return polled;
    },
    settle: (token, assignment, outcome) => {
      runnerReportCounted(counts.settlements, outcome.outcome);
      if (outcome.outcome === "Refused")
        runnerReportCounted(counts.refusals, outcome.fault ?? "NoFault");
      return plane.settle(token, assignment, outcome);
    },
  };
}

/**
 * The backend, counting what it holds and how what it held ended.
 *
 * @param {RunnerReportCounts} counts
 * @param {WorkerPoolBackend} backend
 * @returns {WorkerPoolBackend}
 */
function runnerReportBackend(counts, backend) {
  return {
    ...backend,
    held: async () => {
      const held = await backend.held();
      counts.held = new Map(
        held.map(({ assignment, kind }) => [assignment, kind]),
      );
      return held;
    },
    ended: async () => {
      const ended = await backend.ended();
      for (const workload of ended)
        if (workload.kind === "Job")
          runnerReportCounted(counts.jobsEnded, runnerReportJobEnd(workload));
        else runnerReportCounted(counts.sessionsEnded, workload.phase);
      return ended;
    },
    place: /** @type {WorkerPoolBackend["place"]} */ (
      async (
        /** @type {never} */ assignment,
        /** @type {WorkerPoolWorkloadKind} */ kind,
      ) => {
        const placement = await backend.place(assignment, kind);
        if (kind === "Job" && placement.placed === "Refused")
          runnerReportCounted(counts.jobsEnded, "PlacementFailed");
        return placement;
      }
    ),
    stop: async (assignment) => {
      const stopped = await backend.stop(assignment);
      if (
        stopped.stopped === "Stopped" &&
        counts.held.get(assignment) === "Job"
      )
        runnerReportCounted(counts.jobsEnded, "Stopped");
      return stopped;
    },
  };
}

/**
 * How many of a kind the last `held` found.
 *
 * @param {RunnerReportCounts} counts
 * @param {WorkerPoolWorkloadKind} kind
 */
function runnerReportRunning(counts, kind) {
  return [...counts.held.values()].filter((held) => held === kind).length;
}

/** The facts a report may take of its machine. */
const runnerMachineFields = /** @type {const} */ ([
  "diskFreeBytes",
  "diskFloorBytes",
  "cpus",
  "loadAverageOneMinute",
  "memoryTotalBytes",
  "memoryAvailableBytes",
]);

/**
 * The companion's facts of its machine that the contract reads, each on its
 * own; none where it gives none or its seam fails.
 *
 * @param {RunnerReportingSeams} seams
 * @returns {Promise<RunnerMachine>}
 */
async function runnerReportMachine(seams) {
  if (seams.machine === undefined) return {};
  /** @type {Partial<Record<string, unknown>>} */
  let facts;
  try {
    facts = (await seams.machine()) ?? {};
  } catch {
    return {};
  }
  return Object.fromEntries(
    runnerMachineFields.flatMap((field) =>
      facts[field] !== undefined &&
      workerRunnerReportSchema.shape[field].safeParse(facts[field]).success
        ? [[field, facts[field]]]
        : [],
    ),
  );
}

/**
 * The report as it stands, its machine's facts given.
 *
 * @param {RunnerReportState} state
 * @param {RunnerMachine} machine
 */
function runnerReportBody(state, machine) {
  const { counts, client, seams } = state;
  const measured = state.backend.measured?.() ?? runnerMeasuredNone();
  return {
    host: seams.host,
    uptimeSecs: (seams.uptimeSecs ?? (() => globalThis.process.uptime()))(),
    jobsRunning: runnerReportRunning(counts, "Job"),
    concurrencyMax: client.settings.concurrencyMax,
    sessionsRunning: runnerReportRunning(counts, "Session"),
    sessionsMax: client.settings.sessionsMax ?? 0,
    ...machine,
    polls: counts.polls,
    pollsFailed: counts.pollsFailed,
    settlements: { ...counts.settlements },
    refusals: { ...counts.refusals },
    jobsEnded: { ...counts.jobsEnded },
    sessionsEnded: { ...counts.sessionsEnded },
    imagePullSecs: measured.imagePullSecs,
    runSecs: measured.runSecs,
  };
}

/**
 * A body as it is sent, or nothing where the contract's schema does not read
 * it or it weighs more than the plane takes.
 *
 * @param {unknown} body
 */
export function runnerReportText(body) {
  const read = workerRunnerReportSchema.safeParse(body);
  if (!read.success) return undefined;
  const text = JSON.stringify(read.data);
  return new TextEncoder().encode(text).byteLength > workerRunnerReportBytesMax
    ? undefined
    : text;
}

/**
 * Why one report was not taken, or nothing where it was. It never throws.
 *
 * @param {RunnerReportState} state
 * @param {string} token
 * @returns {Promise<string | undefined>}
 */
async function runnerReportFailure(state, token) {
  try {
    const text = runnerReportText(
      runnerReportBody(state, await runnerReportMachine(state.seams)),
    );
    if (text === undefined)
      return "its body is not one the contract reads, so it was not sent";
    const reported = await state.plane.report(token, text);
    return reported.reported === "Reported" ? undefined : reported.evidence;
  } catch (thrown) {
    return thrown instanceof Error ? thrown.message : String(thrown);
  }
}

/**
 * Sends one report where the plane last named takes one, saying so where
 * that starts or ends a run of failures.
 *
 * @param {RunnerReportState} state
 */
async function runnerReportSent(state) {
  const { token } = state;
  if (!runnerReportTaken(state.version) || token === undefined) return;
  const failure = await runnerReportFailure(state, token);
  if (failure !== undefined && !state.failing)
    state.seams.log(
      `a runner report was not taken: ${failure}; reports go on, and this is said again once one is`,
    );
  else if (failure === undefined && state.failing)
    state.seams.log("runner reports are taken again");
  state.failing = failure !== undefined;
}

/**
 * Sends a report, then another each `runnerReportIntervalMs`, until reporting
 * ends.
 *
 * @param {RunnerReportState} state
 */
async function runnerReportTicks(state) {
  const wait =
    state.seams.wait ??
    ((ms, signal) => waitDefault(ms, undefined, { signal, ref: false }));
  const { signal } = state.cut;
  while (!signal.aborted) {
    await runnerReportSent(state);
    try {
      await wait(runnerReportIntervalMs, signal);
    } catch {
      return;
    }
  }
}

/**
 * Starts the reports, once, at the first poll whose answer names a version
 * that takes them.
 *
 * @param {RunnerReportState} state
 */
function runnerReportStarted(state) {
  if (state.ticking || state.cut.signal.aborted) return;
  if (!runnerReportTaken(state.version) || state.token === undefined) return;
  state.ticking = true;
  void runnerReportTicks(state);
}

/**
 * A client that reports on itself: `client` with its plane and backend
 * counting what they do, and the reports that send what they counted.
 *
 * @param {WorkerPoolClient} client
 * @param {RunnerReportingSeams} seams
 * @returns {RunnerReporting}
 */
export function runnerReporting(client, seams) {
  const { report } = client.plane;
  if (report === undefined || client.plane.polledVersion === undefined)
    throw new TypeError(
      "a runner that reports needs a plane that takes reports and names the version each poll's answer named",
    );
  /** @type {RunnerReportState} */
  const state = {
    client: { ...client },
    backend: client.backend,
    plane: { report },
    seams: { ...seams, host: runnerReportHost(seams.host) },
    counts: {
      polls: 0,
      pollsFailed: 0,
      settlements: {},
      refusals: {},
      jobsEnded: {},
      sessionsEnded: {},
      held: new Map(),
    },
    version: undefined,
    token: undefined,
    ticking: false,
    failing: false,
    cut: new globalThis.AbortController(),
  };
  state.client.plane = runnerReportPlane(state, client.plane);
  state.client.backend = runnerReportBackend(state.counts, client.backend);
  return { client: state.client, ended: () => state.cut.abort() };
}
