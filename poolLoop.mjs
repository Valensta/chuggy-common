/**
 * The pool loop: each pass takes a token, reads what the backend holds, ends
 * the attempts of workloads that ended without reporting, polls the plane for
 * the room left, stops what it is told to and places what it is offered.
 * chuggy's `src/interpreter/workerPoolClient.ts` is the same loop in
 * TypeScript, and a change to one is a change to both, but for a runner's
 * update of itself, which that cluster client never makes, and a backend
 * that takes no job while its disk is low or its engine's memory has no
 * room, and claims jobs by that room, which a cluster leaves to its kubelet.
 *
 * A JOB AND A SESSION ARE COUNTED APART. Each kind has its own ceiling, its
 * own room on the poll and its own offers, so a session never takes a job's
 * room nor a job a session's, a pool that names no session ceiling asks for
 * none, and one whose job ceiling is 0, or whose backend takes no job, asks
 * for no job. Each kind's end is reported to its own plane.
 *
 * A JOB THE BACKEND REFUSED AFTER TAKING IT IS SETTLED REFUSED, not ended: its
 * text is left on its attempt, which only a live attempt takes, and its
 * assignment is then settled `Refused` on the pool's plane, naming the image's
 * fault, so the attempt's execution is blocked rather than its run failed and
 * retried.
 *
 * A POOL SHARING ITS ENGINE CLAIMS JOBS BY ITS ROOM, ONE POOL AT A TIME,
 * where the plane's last answer said it claims by room and the backend keeps
 * a claim lock. Each poll then asks for no job, naming the memory room the
 * pool offers jobs, and an answer saying a job that fits waits has the pass
 * take the claim, without waiting. Holding it, the pass reads the backend
 * again and asks for the jobs that read has room for in a poll the plane
 * answers at once, places each, which holds its memory, and lets the claim
 * go. A pass that found it held, or placed no job under it, ends there, and
 * the next polls after `workerPoolClaimWaitMs`, since the plane answers it at
 * once while that job waits. Otherwise a poll asks for jobs as it always has,
 * naming the room too.
 *
 * Nothing is held between passes. What is running is read from the backend,
 * so a restarted loop reconciles the work its predecessor placed, and a
 * settlement is never retried because the next poll's `held` renews the lease.
 * A denial ends the run; an outage backs off and comes back.
 *
 * A RUNNER UPDATES ITSELF BETWEEN JOBS. Once a poll names a release above the
 * runner's own, a run that updates installs it behind its passes, which go on
 * renewing what it holds and ask for no more work, and the pass after the
 * install ends the run for the restart. Where something it holds would end
 * with its process, it first proves the release while taking work as before,
 * and only then asks for no more and waits for that work to end, so a release
 * that fails its proof never drains the pool. A run that does not update says
 * once per release that one is out. A refused or failed update is logged and
 * not tried again before `workerPoolUpdateBackoffMs` has passed.
 */

import { workerPoolEvidenceCharsMax } from "@chuggy/worker-contract/workerPool";

import { runnerVersionAbove } from "./runnerUpdate.mjs";

/**
 * @typedef {import("@chuggy/worker-contract/workerPool").WorkerPoolAssignment} WorkerPoolAssignment
 * @typedef {import("@chuggy/worker-contract/workerPool").WorkerPoolSessionAssignment} WorkerPoolSessionAssignment
 * @typedef {import("@chuggy/worker-contract/workerPool").AssignmentOutcome} AssignmentOutcome
 * @typedef {import("@chuggy/worker-contract/sessionPlane").SessionContainerEnd} SessionContainerEnd
 * @typedef {import("@chuggy/worker-contract/workerEnvironment").WorkerImageFault} WorkerImageFault
 *
 * @typedef {import("@chuggy/worker-contract/workerPool").WorkerRunnerRelease} WorkerRunnerRelease
 * @typedef {import("./runnerUpdate.mjs").RunnerUpdater} RunnerUpdater
 *
 * @typedef {"Job" | "Session"} WorkerPoolWorkloadKind
 * @typedef {object} WorkerPoolHeld
 * @property {string} assignment
 * @property {WorkerPoolWorkloadKind} kind
 * @property {true} [outlivesRunner] where the workload runs on once this process ends and a runner started after it holds it again; one that does not say ends with the process
 * @typedef {Pick<WorkerPoolAssignment, "assignment" | "callbackUrl" | "bearer">} WorkerPoolAttempt what an assignment's own plane is reached at, and under
 *
 * @typedef {{placed: "Placed"} | {placed: "Refused", evidence: string} | {placed: "Unavailable"}} WorkerPoolPlacement
 * @typedef {{stopped: "Stopped", found?: WorkerPoolStopFound} | {stopped: "Refused", evidence: string} | {stopped: "Unavailable", evidence: string}} WorkerPoolStopped `found` none where the backend cannot tell what the stop found
 * @typedef {{found: "Running"} | {found: "Ended", ended: WorkerPoolStopEnded}} WorkerPoolStopFound whether the stop interrupted the workload, or found it already ended, and how
 * @typedef {Omit<WorkerPoolJobEnd, "job"> | Omit<WorkerPoolSessionEnd, "session">} WorkerPoolStopEnded
 *
 * @typedef {object} WorkerPoolJobEnd a job that ended of itself, which its harness may never have reported
 * @property {"Job"} kind
 * @property {WorkerPoolAttempt} job
 * @property {string} why the backend's own words, never the workload's, which may carry a secret no scrub here holds
 * @property {WorkerPoolJobRefusal} [refusal] where the backend refused the job for its image's fault rather than ran it, `why` being the refusal's evidence
 * @property {"Deadline" | "DiskLow"} [killed] where the backend killed it: at its deadline, or for its machine's low disk
 * @property {"Succeeded" | "Failed"} [ran] how its process ended where it ran to an end of its own, `Succeeded` only for one that exited 0; none where it never ran or was killed
 *
 * @typedef {object} WorkerPoolJobRefusal
 * @property {WorkerImageFault} fault what the job's image lacks
 *
 * @typedef {object} WorkerPoolSessionEnd a session whose container ended, which only the pool holding it sees
 * @property {"Session"} kind
 * @property {WorkerPoolAttempt} session
 * @property {SessionContainerEnd} phase `Succeeded` for a container that exited cleanly, `Failed` for any other end
 *
 * @typedef {WorkerPoolJobEnd | WorkerPoolSessionEnd} WorkerPoolEnded
 *
 * @typedef {object} WorkerPoolBackend where the work runs, and the only record of what is running
 * @property {((assignment: WorkerPoolAssignment, kind: "Job") => Promise<WorkerPoolPlacement>)
 *   & ((assignment: WorkerPoolSessionAssignment, kind: "Session") => Promise<WorkerPoolPlacement>)} place
 * @property {(assignment: string) => Promise<WorkerPoolStopped>} stop idempotent, whichever kind it is
 * @property {() => Promise<readonly WorkerPoolHeld[]>} held every workload of either kind, each with the kind it was placed as
 * @property {() => Promise<readonly WorkerPoolEnded[]>} ended each one once, after `held` stopped naming it; never one this pool stopped
 * @property {(byRoom: boolean) => boolean} [jobsTaken] whether it takes a job now, as its last `held` found, from a plane that claims by room or one that does not; false while its machine's disk is low or its engine's memory has no room for it, and true for a backend that keeps neither
 * @property {() => WorkerPoolMemoryRoom | undefined} [memoryRoom] its engine's memory as its last `held` found; none for a backend that keeps no budget
 * @property {() => Promise<(() => Promise<void>) | undefined>} [claimed] takes its engine's claim without waiting: what lets it go, or nothing while another pool holds it; none for a backend that keeps no claim lock
 * @property {() => import("./runnerReport.mjs").RunnerMeasured} [measured] the image pulls it made and the runs that ended, since it was made; none for a backend that measures neither
 *
 * @typedef {object} WorkerPoolMemoryRoom in MiB
 * @property {number} roomMib what jobs may take now, none where the count failed
 * @property {number} [ceilingMib] what any one job may ask, unknown where the count failed
 *
 * @typedef {{polled: "Reconciled", assignments: readonly WorkerPoolAssignment[],
 *   sessions: readonly WorkerPoolSessionAssignment[], stop: readonly string[], release?: WorkerRunnerRelease,
 *   jobsWaiting?: boolean, chatImage?: string}
 *   | {polled: "Stale"} | {polled: "Denied", evidence: string} | {polled: "Unavailable", evidence: string}} WorkerPoolPolled `jobsWaiting` where the plane claims by room: whether a job waits that fits what the poll named; `chatImage` the image a chat host's sessions run in, where the plane names one
 *
 * @typedef {object} WorkerPoolPollTerms what a poll names beside its query
 * @property {WorkerPoolMemoryRoom} [memory] the room it offers jobs, and its ceiling
 * @property {number} [waitSecs] the longest the plane may wait before it answers; none, and the plane's own
 *
 * @typedef {"Settled" | "Lost" | "Stale" | "Denied" | "Unavailable"} WorkerPoolSettled
 *
 * @typedef {object} WorkerPoolPlane `Stale` is a token to replace; `Denied` a pool the plane will not serve
 * @property {(token: string, held: readonly string[], wanted: number, wantedSessions: number, terms?: WorkerPoolPollTerms) => Promise<WorkerPoolPolled>} poll
 * @property {(token: string, assignment: string, outcome: AssignmentOutcome) => Promise<WorkerPoolSettled>} settle
 * @property {() => boolean | undefined} [claimsByRoom] whether its last reconciled answer said whether a job waits, undefined before it has one; none, and it never does
 * @property {() => WorkerContractVersion | undefined} [polledVersion] the version its last poll's answer named, undefined where it named none or never came
 * @property {(token: string, body: string) => Promise<WorkerPoolReported>} [report] posts a runner's report, its body as JSON
 *
 * @typedef {{reported: "Reported"} | {reported: "Failed", evidence: string}} WorkerPoolReported
 * @typedef {import("@chuggy/worker-contract/workerContract").WorkerContractVersion} WorkerContractVersion
 *
 * @typedef {"Ended" | "Refused" | "Unavailable"} WorkerPoolEndAnswer
 *
 * @typedef {object} WorkerPoolJobPlane `Refused` is an attempt no longer live, whose own report stands
 * @property {(ended: WorkerPoolJobEnd) => Promise<WorkerPoolEndAnswer>} end
 * @property {(ended: WorkerPoolJobEnd) => Promise<void>} left leaves a refused job's text on its attempt, answering nothing, since the refusal is settled either way
 *
 * @typedef {object} WorkerPoolSessionPlane `Refused` is a session attempt no longer live, or one the plane refused to end
 * @property {(ended: WorkerPoolSessionEnd) => Promise<WorkerPoolEndAnswer>} end
 *
 * @typedef {{acquired: "Token", token: string} | {acquired: "Denied", evidence: string}
 *   | {acquired: "Unavailable", evidence: string}} WorkerPoolTokenAcquired
 *
 * @typedef {object} WorkerPoolTokens holds the grant, so it is asked every pass
 * @property {() => Promise<WorkerPoolTokenAcquired>} acquire
 * @property {(token: string) => void} invalidate discards a token the plane rejected
 *
 * @typedef {object} WorkerPoolClientSettings
 * @property {number} concurrencyMax the jobs held at once, which each poll's `wanted` is measured from; none where it is 0
 * @property {number} [sessionsMax] the sessions held at once, which each poll's `wantedSessions` is measured from; none where absent, and above 0 where `concurrencyMax` is 0
 * @property {number} outageBackoffMs the wait after a pass that met an outage
 * @property {number} passesMax the passes one run makes
 *
 * @typedef {{placed: number, stopped: number, refused: number}} WorkerPoolTally
 *
 * @typedef {{passed: "Reconciled", placed: number, stopped: number, refused: number, ended: number, claim?: WorkerPoolClaimSpent}
 *   | {passed: "Denied", evidence: string} | {passed: "Unavailable", evidence: string}
 *   | {passed: "Updated", version: string}} WorkerPoolPass `Updated` is a runner installed at `version`, to restart on; `claim` where the pass asked for jobs under its engine's claim and placed none, and the next waits `workerPoolClaimWaitMs`
 *
 * @typedef {"Busy" | "Empty"} WorkerPoolClaimSpent `Busy` where another pool held the claim, `Empty` where this one took it and placed no job
 *
 * @typedef {object} WorkerPoolUpdates what a run is told of its runner's update of itself
 * @property {boolean} on whether it updates, or only says a release is out
 * @property {RunnerUpdater} updater
 *
 * @typedef {object} WorkerPoolUpdating a run's update, from the release a poll names to the restart
 * @property {() => boolean} draining whether the pool asks for no work, for a release it installs
 * @property {(held: readonly WorkerPoolHeld[]) => string | undefined} restart the version installed to restart on, if any; otherwise starts the install of a release named or drained for where nothing held ends with this process, or the proof of one named where something does
 * @property {(release: WorkerRunnerRelease | undefined) => Promise<void>} named takes what a reconciled poll named
 *
 * @typedef {object} WorkerPoolClient
 * @property {WorkerPoolTokens} tokens
 * @property {WorkerPoolPlane} plane
 * @property {WorkerPoolJobPlane} jobs
 * @property {WorkerPoolSessionPlane} sessions
 * @property {WorkerPoolBackend} backend
 * @property {WorkerPoolClientSettings} settings
 */

/**
 * @param {WorkerPoolClientSettings} settings
 * @returns {WorkerPoolClientSettings}
 */
export function checkedWorkerPoolClientSettings(settings) {
  for (const [name, bound] of [
    ["outageBackoffMs", settings.outageBackoffMs],
    ["passesMax", settings.passesMax],
  ])
    if (!Number.isSafeInteger(bound) || bound <= 0)
      throw new RangeError(
        `worker pool client ${name} must be a positive safe integer`,
      );
  const { concurrencyMax, sessionsMax } = settings;
  if (!Number.isSafeInteger(concurrencyMax) || concurrencyMax < 0)
    throw new RangeError(
      "worker pool client concurrencyMax must be a safe integer of zero or more",
    );
  if (
    sessionsMax !== undefined &&
    (!Number.isSafeInteger(sessionsMax) || sessionsMax < 0)
  )
    throw new RangeError(
      "worker pool client sessionsMax must be a safe integer of zero or more, or absent",
    );
  if (concurrencyMax === 0 && (sessionsMax ?? 0) === 0)
    throw new RangeError(
      "worker pool client concurrencyMax is 0 and sessionsMax is 0 or absent, so the pool would take no work",
    );
  return settings;
}

/**
 * How many of a kind the pool holds at once.
 *
 * @param {WorkerPoolClientSettings} settings
 * @param {WorkerPoolWorkloadKind} kind
 */
function workerPoolClientCeiling(settings, kind) {
  return kind === "Session"
    ? (settings.sessionsMax ?? 0)
    : settings.concurrencyMax;
}

/**
 * How many of a kind are running, less those this pass has stopped.
 *
 * @param {readonly WorkerPoolHeld[]} held
 * @param {WorkerPoolWorkloadKind} kind
 * @param {readonly string[]} stopped
 */
function workerPoolClientRunning(held, kind, stopped) {
  return held.filter(
    (workload) =>
      workload.kind === kind && !stopped.includes(workload.assignment),
  ).length;
}

/**
 * The room a poll asks for of a kind: its ceiling less what is running.
 *
 * @param {WorkerPoolClientSettings} settings
 * @param {readonly WorkerPoolHeld[]} held
 * @param {WorkerPoolWorkloadKind} kind
 */
function workerPoolClientRoom(settings, held, kind) {
  return Math.max(
    workerPoolClientCeiling(settings, kind) -
      workerPoolClientRunning(held, kind, []),
    0,
  );
}

/**
 * A pool that holds sessions has a plane to end them on. It is checked by the
 * pass rather than with the settings, because a runner may check its settings
 * before the client they go into exists, and drive the pass itself.
 *
 * @param {WorkerPoolClient} client
 */
function checkedWorkerPoolClientSessions(client) {
  if (
    workerPoolClientCeiling(client.settings, "Session") > 0 &&
    client.sessions === undefined
  )
    throw new TypeError(
      "worker pool client sessionsMax is above zero with no session plane to end a session on",
    );
}

/**
 * A backend's entry as a refusal names it: by its keys, never its values,
 * which may carry an attempt's bearer.
 *
 * @param {unknown} entry
 */
function workerPoolClientShape(entry) {
  if (entry === null || typeof entry !== "object")
    return `an entry of type ${entry === null ? "null" : typeof entry}`;
  const keys = Object.keys(entry).sort();
  return keys.length === 0
    ? "an entry with no keys"
    : `an entry keyed ${keys.join(", ")}`;
}

/**
 * What the backend holds, every entry checked before any is used: one naming
 * no assignment would drop out of the poll's `held` and let a running
 * workload's lease lapse, and one of no kind the loop knows would count
 * against no ceiling.
 *
 * @param {WorkerPoolClient} client
 * @returns {Promise<readonly WorkerPoolHeld[]>}
 */
async function workerPoolClientHeld(client) {
  const held = await client.backend.held();
  for (const workload of held) {
    if (typeof workload?.assignment !== "string" || workload.assignment === "")
      throw new TypeError(
        `a backend held ${workerPoolClientShape(workload)}, which names no assignment`,
      );
    if (workload.kind !== "Job" && workload.kind !== "Session")
      throw new TypeError(
        `a backend held ${workerPoolClientShape(workload)}, whose kind is no workload's`,
      );
  }
  return held;
}

/** @param {WorkerPoolClient} client */
async function workerPoolClientToken(client) {
  const acquired = await client.tokens.acquire();
  if (acquired.acquired === "Denied")
    return { passed: "Denied", evidence: acquired.evidence };
  if (acquired.acquired === "Unavailable")
    return { passed: "Unavailable", evidence: acquired.evidence };
  return { token: acquired.token };
}

/**
 * Stops everything the plane flagged. An unreachable fabric ends the pass
 * before anything is placed; one that refused ends the run, because polling on
 * would renew the lease of work this pool cannot abandon.
 *
 * @param {WorkerPoolClient} client
 * @param {readonly string[]} stop
 */
async function workerPoolClientStopped(client, stop) {
  let stopped = 0;
  for (const assignment of stop) {
    const outcome = await client.backend.stop(assignment);
    if (outcome.stopped === "Refused")
      return { passed: "Denied", evidence: outcome.evidence };
    if (outcome.stopped === "Unavailable")
      return { passed: "Unavailable", evidence: outcome.evidence };
    stopped += 1;
  }
  return { stopped };
}

/**
 * A refusal's evidence, cut to what a settlement carries.
 *
 * @param {string} why
 */
function workerPoolClientEvidence(why) {
  let evidence = "";
  for (const point of why) {
    if (evidence.length + point.length > workerPoolEvidenceCharsMax) break;
    evidence += point;
  }
  return evidence;
}

/**
 * Settles a job the backend refused: its text left first, then the refusal,
 * under the pass's token. A refusal the plane did not take is left to the
 * attempt's lease, as an end is.
 *
 * @param {WorkerPoolClient} client
 * @param {string} token
 * @param {WorkerPoolJobEnd} ended
 * @param {WorkerPoolJobRefusal} refusal
 * @returns {Promise<WorkerPoolEndAnswer>}
 */
async function workerPoolClientRefused(client, token, ended, refusal) {
  await client.jobs.left(ended);
  const settled = await client.plane.settle(token, ended.job.assignment, {
    outcome: "Refused",
    evidence: workerPoolClientEvidence(ended.why),
    fault: refusal.fault,
  });
  if (settled === "Stale") client.tokens.invalidate(token);
  if (settled === "Settled") return "Ended";
  return settled === "Lost" || settled === "Denied" ? "Refused" : "Unavailable";
}

/**
 * @param {WorkerPoolClient} client
 * @param {string} token
 * @param {WorkerPoolEnded} workload
 * @returns {Promise<WorkerPoolEndAnswer>}
 */
function workerPoolClientEnd(client, token, workload) {
  switch (workload.kind) {
    case "Job":
      return workload.refusal === undefined
        ? client.jobs.end(workload)
        : workerPoolClientRefused(client, token, workload, workload.refusal);
    case "Session":
      return client.sessions.end(workload);
    default:
      throw new TypeError(
        `a backend ended ${workerPoolClientShape(workload)}, whose kind is no workload's`,
      );
  }
}

/**
 * Ends each attempt whose workload ended unreported, each on its own kind's
 * plane, and settles each job refused, counting the ends the planes took. One
 * not taken is left to its lease.
 *
 * @param {WorkerPoolClient} client
 * @param {string} token
 */
async function workerPoolClientEnded(client, token) {
  let ended = 0;
  for (const workload of await client.backend.ended())
    if ((await workerPoolClientEnd(client, token, workload)) === "Ended")
      ended += 1;
  return ended;
}

/**
 * @param {WorkerPoolPlacement} placement
 * @returns {AssignmentOutcome}
 */
function workerPoolClientOutcome(placement) {
  switch (placement.placed) {
    case "Placed":
      return { outcome: "Accepted" };
    case "Refused":
      return { outcome: "Refused", evidence: placement.evidence };
    case "Unavailable":
      return { outcome: "Unavailable" };
    default:
      throw new TypeError(
        `a backend answered ${String(placement.placed)}, which is no placement`,
      );
  }
}

/**
 * Places what there is room for of one kind and settles the rest as
 * `Unavailable`: the poll asked for no more than the room, so the rest is a
 * plane that offered past it. Room is the kind's ceiling less what is running
 * of it and what this pass has placed of it, and none while the pool takes
 * none of the kind.
 *
 * @param {WorkerPoolClient} client
 * @param {string} token
 * @param {readonly WorkerPoolAssignment[]} offered
 * @param {WorkerPoolWorkloadKind} kind
 * @param {{running: number, taking: boolean}} room
 */
async function workerPoolClientPlaced(client, token, offered, kind, room) {
  const tally = { placed: 0, refused: 0 };
  const { running } = room;
  const ceiling = room.taking
    ? workerPoolClientCeiling(client.settings, kind)
    : 0;
  for (const assignment of offered) {
    const placement =
      running + tally.placed < ceiling
        ? await client.backend.place(assignment, kind)
        : { placed: "Unavailable" };
    const outcome = workerPoolClientOutcome(placement);
    if (placement.placed === "Placed") tally.placed += 1;
    if (placement.placed === "Refused") tally.refused += 1;
    const settled = await client.plane.settle(
      token,
      assignment.assignment,
      outcome,
    );
    if (settled === "Stale") client.tokens.invalidate(token);
  }
  return tally;
}

/** How long a runner whose update was refused or failed waits before it tries one again. */
export const workerPoolUpdateBackoffMs = 60 * 60 * 1000;

/**
 * Where a run's update stands. `Named` passed the updater's refusal and is
 * installed at once where nothing held ends with this process, else proved
 * first; `Proving` and `Proved` take work as before, and the poll that still
 * names a `Proved` release drains for it.
 *
 * @typedef {{at: "Idle"} | {at: "Installed", version: string}
 *   | {at: "Named" | "Proving" | "Proved" | "Draining" | "Installing", release: WorkerRunnerRelease}} WorkerPoolUpdateStage
 *
 * @typedef {object} WorkerPoolUpdateState what a run remembers between passes of its update
 * @property {WorkerPoolUpdates} updates
 * @property {{log: (line: string) => void, nowMs: () => number}} seams
 * @property {WorkerPoolUpdateStage} stage
 * @property {number} retryAtMs when a refused or failed update may be tried again
 * @property {string} [announced] the release last said to be out, where updates are off
 */

/** @param {WorkerRunnerRelease} release */
function workerPoolReleaseNamed(release) {
  return `${release.package} ${release.version}`;
}

/** @param {unknown} thrown */
function workerPoolThrownReason(thrown) {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * Leaves the release, and says why.
 *
 * @param {WorkerPoolUpdateState} state
 * @param {WorkerRunnerRelease} release
 * @param {string} reason
 */
function workerPoolUpdateFailed(state, release, reason) {
  state.stage = { at: "Idle" };
  state.retryAtMs = state.seams.nowMs() + workerPoolUpdateBackoffMs;
  state.seams.log(
    `did not update to ${workerPoolReleaseNamed(release)}: ${reason}; the next try is in ${String(workerPoolUpdateBackoffMs / 60_000)} minutes`,
  );
}

/**
 * Proves the release behind the passes, which go on taking work meanwhile.
 *
 * @param {WorkerPoolUpdateState} state
 * @param {WorkerRunnerRelease} release
 */
function workerPoolProofStarted(state, release) {
  state.stage = { at: "Proving", release };
  state.seams.log(
    `proving ${workerPoolReleaseNamed(release)} before this pool stops taking work for it`,
  );
  void state.updates.updater.prove(release).then(
    (proved) => {
      if (proved.proved === "Failed")
        workerPoolUpdateFailed(state, release, proved.reason);
      else state.stage = { at: "Proved", release };
    },
    (thrown) =>
      workerPoolUpdateFailed(state, release, workerPoolThrownReason(thrown)),
  );
}

/**
 * Installs the release behind the passes, which renew what the pool holds
 * meanwhile.
 *
 * @param {WorkerPoolUpdateState} state
 * @param {WorkerRunnerRelease} release
 */
function workerPoolInstallStarted(state, release) {
  state.stage = { at: "Installing", release };
  state.seams.log(`updating to ${workerPoolReleaseNamed(release)}`);
  void state.updates.updater.update(release).then(
    (updated) => {
      if (updated.updated === "Failed")
        workerPoolUpdateFailed(state, release, updated.reason);
      else {
        state.stage = { at: "Installed", version: updated.version };
        state.seams.log(
          `${release.package} ${updated.version} is installed, and this runner ends to start on it`,
        );
      }
    },
    (thrown) =>
      workerPoolUpdateFailed(state, release, workerPoolThrownReason(thrown)),
  );
}

/**
 * Whether the stage is one for this very release.
 *
 * @param {WorkerPoolUpdateStage} stage
 * @param {WorkerRunnerRelease} release
 */
function workerPoolStageFor(stage, release) {
  return (
    "release" in stage &&
    ["package", "version", "url", "integrity"].every(
      (field) => stage.release[field] === release[field],
    )
  );
}

/**
 * Takes the release a reconciled poll named: one above the runner's own is
 * named for the next pass, where updates are on and nothing refuses it, or
 * said to be out once where they are off; a proved one the poll still names
 * is drained for. One the poll stops naming is left, and nothing a poll names
 * moves a proof or an install begun.
 *
 * @param {WorkerPoolUpdateState} state
 * @param {WorkerRunnerRelease | undefined} release
 */
async function workerPoolUpdateNamed(state, release) {
  const { on, updater } = state.updates;
  const { stage } = state;
  if (["Proving", "Installing", "Installed"].includes(stage.at)) return;
  if (
    release === undefined ||
    !runnerVersionAbove(release.version, updater.runner.version)
  ) {
    state.stage = { at: "Idle" };
    return;
  }
  if (!on) {
    if (state.announced !== release.version)
      state.seams.log(
        `${workerPoolReleaseNamed(release)} is out, and this runner, ${updater.runner.version}, does not update itself`,
      );
    state.announced = release.version;
    return;
  }
  if (workerPoolStageFor(stage, release)) {
    if (stage.at === "Proved") {
      state.stage = { at: "Draining", release };
      state.seams.log(
        `${workerPoolReleaseNamed(release)} is proved, and this pool takes no new work until it has updated`,
      );
    }
    return;
  }
  if (state.seams.nowMs() < state.retryAtMs) return;
  const reason = await updater.refusal(release);
  if (reason === undefined) state.stage = { at: "Named", release };
  else workerPoolUpdateFailed(state, release, reason);
}

/**
 * A run's update of its runner, from the release a poll names to the restart.
 *
 * @param {WorkerPoolUpdates} updates
 * @param {{log: (line: string) => void, nowMs: () => number}} seams
 * @returns {WorkerPoolUpdating}
 */
export function workerPoolUpdating(updates, seams) {
  /** @type {WorkerPoolUpdateState} */
  const state = { updates, seams, stage: { at: "Idle" }, retryAtMs: 0 };
  return {
    draining: () =>
      ["Draining", "Installing", "Installed"].includes(state.stage.at),
    restart: (held) => {
      const { stage } = state;
      if (stage.at === "Installed") return stage.version;
      const outlived = held.every(
        (workload) => workload.outlivesRunner === true,
      );
      if ((stage.at === "Named" || stage.at === "Draining") && outlived)
        workerPoolInstallStarted(state, stage.release);
      else if (stage.at === "Named")
        workerPoolProofStarted(state, stage.release);
      return undefined;
    },
    named: (release) => workerPoolUpdateNamed(state, release),
  };
}

/** How long a pool that placed no job under its engine's claim waits before it polls again. */
export const workerPoolClaimWaitMs = 1_000;

/**
 * The memory a poll names: the backend's room where the pool takes a job and
 * has room under its job ceiling, and an empty room where it does not, so a
 * plane that claims by room never says a job waits that the pool would not
 * ask for.
 *
 * @param {WorkerPoolClient} client
 * @param {readonly WorkerPoolHeld[]} held
 * @param {boolean} jobsTaken
 * @returns {WorkerPoolPollTerms}
 */
function workerPoolClientTerms(client, held, jobsTaken) {
  const memory = client.backend.memoryRoom?.();
  if (memory === undefined) return {};
  const offered =
    jobsTaken && workerPoolClientRoom(client.settings, held, "Job") > 0;
  return { memory: { ...memory, roomMib: offered ? memory.roomMib : 0 } };
}

/**
 * One poll and what it is answered with: what it asks for of each kind
 * measured from `held`, every stop delivered, and what was offered placed or
 * settled. A poll that was not reconciled, or a stop that failed, ends the
 * pass.
 *
 * @param {WorkerPoolClient} client
 * @param {string} token
 * @param {readonly WorkerPoolHeld[]} held
 * @param {{jobs: boolean, sessions: boolean}} taking whether it asks for each kind
 * @param {WorkerPoolPollTerms} terms
 * @returns {Promise<{tally: WorkerPoolTally, polled: Extract<WorkerPoolPolled, {polled: "Reconciled"}>}
 *   | Extract<WorkerPoolPass, {passed: "Denied" | "Unavailable"}>>}
 */
async function workerPoolClientReconciled(client, token, held, taking, terms) {
  const polled = await client.plane.poll(
    token,
    held.map(({ assignment }) => assignment),
    taking.jobs ? workerPoolClientRoom(client.settings, held, "Job") : 0,
    taking.sessions
      ? workerPoolClientRoom(client.settings, held, "Session")
      : 0,
    terms,
  );
  if (polled.polled === "Stale") {
    client.tokens.invalidate(token);
    return { passed: "Unavailable", evidence: "the pool token was rejected" };
  }
  if (polled.polled !== "Reconciled")
    return { passed: polled.polled, evidence: polled.evidence };
  const stopped = await workerPoolClientStopped(client, polled.stop);
  if ("passed" in stopped) return stopped;
  const jobs = await workerPoolClientPlaced(
    client,
    token,
    polled.assignments,
    "Job",
    {
      running: workerPoolClientRunning(held, "Job", polled.stop),
      taking: taking.jobs,
    },
  );
  const sessions = await workerPoolClientPlaced(
    client,
    token,
    polled.sessions,
    "Session",
    {
      running: workerPoolClientRunning(held, "Session", polled.stop),
      taking: taking.sessions,
    },
  );
  return {
    tally: {
      placed: jobs.placed + sessions.placed,
      stopped: stopped.stopped,
      refused: jobs.refused + sessions.refused,
    },
    polled,
  };
}

/** What a poll that placed, stopped and refused nothing did. */
const workerPoolTallyNone = { placed: 0, stopped: 0, refused: 0 };

/**
 * Asks for jobs under the engine's claim, taken without waiting: what the
 * backend holds is read again, then a poll the plane answers at once asks for
 * what that read has room for and places it, each job holding its memory as
 * it is placed, and the claim goes once they all have. A claim another pool
 * holds is busy, and one that placed no job is empty.
 *
 * @param {WorkerPoolClient} client
 * @param {string} token
 * @param {() => Promise<(() => Promise<void>) | undefined>} claimed
 * @returns {Promise<{tally: WorkerPoolTally, polled?: Extract<WorkerPoolPolled, {polled: "Reconciled"}>, claim?: WorkerPoolClaimSpent}
 *   | Extract<WorkerPoolPass, {passed: "Denied" | "Unavailable"}>>}
 */
async function workerPoolClientClaimed(client, token, claimed) {
  const release = await claimed();
  if (release === undefined)
    return { tally: workerPoolTallyNone, claim: "Busy" };
  try {
    const held = await workerPoolClientHeld(client);
    const jobsTaken = client.backend.jobsTaken?.(true) ?? true;
    if (!jobsTaken || workerPoolClientRoom(client.settings, held, "Job") === 0)
      return { tally: workerPoolTallyNone, claim: "Empty" };
    const reconciled = await workerPoolClientReconciled(
      client,
      token,
      held,
      { jobs: true, sessions: false },
      { ...workerPoolClientTerms(client, held, true), waitSecs: 0 },
    );
    if ("passed" in reconciled || reconciled.tally.placed > 0)
      return reconciled;
    return { ...reconciled, claim: "Empty" };
  } finally {
    await release();
  }
}

/**
 * Whether the plane claims by room, for a pool whose backend keeps a claim:
 * undefined until an answer of the plane's has said.
 *
 * @param {WorkerPoolClient} client
 * @returns {boolean | undefined}
 */
function workerPoolClientByRoom(client) {
  const { claimsByRoom } = client.plane;
  return client.backend.claimed === undefined || claimsByRoom === undefined
    ? false
    : claimsByRoom();
}

/**
 * Asks for jobs by count, as a pool of a plane that does not claim by room
 * does, once a poll asking none has found the plane is one.
 *
 * @param {WorkerPoolClient} client
 * @param {string} token
 */
async function workerPoolClientCounted(client, token) {
  const held = await workerPoolClientHeld(client);
  const jobsTaken = client.backend.jobsTaken?.(false) ?? true;
  if (!jobsTaken) return { tally: workerPoolTallyNone };
  return workerPoolClientReconciled(
    client,
    token,
    held,
    { jobs: true, sessions: false },
    workerPoolClientTerms(client, held, true),
  );
}

/**
 * What a pass that takes a job asks after its first poll: a claim where the
 * plane claims by room and said a job waits, and jobs by count where that poll
 * was the one to find out the plane does not. A pass taking no job asks
 * nothing more, so it reads what it holds no more, which may reclaim the disk.
 *
 * @param {WorkerPoolClient} client
 * @param {string} token
 * @param {boolean | undefined} byRoom whether the plane claimed by room before that poll
 * @param {boolean} jobsTaken whether the pass takes a job
 * @param {Extract<WorkerPoolPolled, {polled: "Reconciled"}>} polled
 */
async function workerPoolClientFollowed(
  client,
  token,
  byRoom,
  jobsTaken,
  polled,
) {
  const { claimed } = client.backend;
  const found = workerPoolClientByRoom(client);
  if (!jobsTaken) return { tally: workerPoolTallyNone };
  if (claimed !== undefined && found === true && polled.jobsWaiting === true)
    return workerPoolClientClaimed(client, token, claimed);
  if (byRoom === undefined && found === false)
    return workerPoolClientCounted(client, token);
  return { tally: workerPoolTallyNone };
}

/**
 * One reconciliation pass. The room is asked before the stops are known, so a
 * stop this pass delivers frees room the next pass asks for. The ended are
 * ended before the poll, which may wait on the plane for work to offer, and
 * before a pass ends the run for its runner's restart.
 *
 * A pool keeping a claim asks a plane that has not yet said whether it claims
 * by room for no job, and to answer at once, since it would otherwise claim
 * by room without the claim. A plane that does not reads no wait, so that
 * poll costs its whole wait once, and the jobs it would have given are asked
 * for after it.
 *
 * @param {WorkerPoolClient} client
 * @param {WorkerPoolUpdating} [updating] the run's update of its runner, where it makes one
 * @returns {Promise<WorkerPoolPass>}
 */
export async function workerPoolClientPass(client, updating) {
  checkedWorkerPoolClientSessions(client);
  const minted = await workerPoolClientToken(client);
  if (!("token" in minted)) return minted;
  const held = await workerPoolClientHeld(client);
  const ended = await workerPoolClientEnded(client, minted.token);
  const restart = updating?.restart(held);
  if (restart !== undefined) return { passed: "Updated", version: restart };
  const sessionsTaken = !(updating?.draining() ?? false);
  const byRoom = workerPoolClientByRoom(client);
  const jobsTaken =
    sessionsTaken && (client.backend.jobsTaken?.(byRoom !== false) ?? true);
  const polled = await workerPoolClientReconciled(
    client,
    minted.token,
    held,
    { jobs: jobsTaken && byRoom === false, sessions: sessionsTaken },
    {
      ...workerPoolClientTerms(client, held, jobsTaken),
      ...(byRoom === undefined ? { waitSecs: 0 } : {}),
    },
  );
  if ("passed" in polled) return polled;
  const claim = await workerPoolClientFollowed(
    client,
    minted.token,
    byRoom,
    jobsTaken,
    polled.polled,
  );
  if ("passed" in claim) return claim;
  await updating?.named((claim.polled ?? polled.polled).release);
  return {
    passed: "Reconciled",
    placed: polled.tally.placed + claim.tally.placed,
    stopped: polled.tally.stopped + claim.tally.stopped,
    refused: polled.tally.refused + claim.tally.refused,
    ended,
    ...("claim" in claim ? { claim: claim.claim } : {}),
  };
}

/**
 * The whole loop, `passesMax` passes long so a run has an end, and ended early
 * by a denial because no later pass would be answered differently.
 *
 * @param {WorkerPoolClient} client
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<WorkerPoolPass>}
 */
export async function workerPoolClientRun(client, sleep) {
  checkedWorkerPoolClientSettings(client.settings);
  /** @type {WorkerPoolPass} */
  let last = {
    passed: "Reconciled",
    placed: 0,
    stopped: 0,
    refused: 0,
    ended: 0,
  };
  for (let pass = 0; pass < client.settings.passesMax; pass += 1) {
    last = await workerPoolClientPass(client);
    if (last.passed === "Denied") return last;
    if (last.passed === "Unavailable")
      await sleep(client.settings.outageBackoffMs);
    else if (last.passed === "Reconciled" && last.claim !== undefined)
      await sleep(workerPoolClaimWaitMs);
  }
  return last;
}
