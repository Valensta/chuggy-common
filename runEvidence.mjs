/**
 * The evidence a worker produces while the agent runs: the per-turn fold, the
 * transcript batcher, the run totals and the credential scrub every uploaded
 * byte passes through.
 *
 * THE SCRUB IS THE ONLY FILTER. It replaces exact occurrences of the values the
 * worker was itself handed, so what a reader sees is what the run emitted and
 * nothing else was decided about it here.
 *
 * THE BATCHER NUMBERS FROM ONE AND NEVER REORDERS. One flush runs at a time and
 * carries the turns it covers before the bytes, so the plane's contiguity rule
 * is met by construction and a re-delivered flush costs nothing.
 *
 * A LINE THE AGENT WRITES IS RECORDED WITHOUT WAITING ON THE PLANE. It is
 * buffered and never awaited, and a batch that is full is closed and queued
 * behind the ones a plane that is away has not taken. What waits is counted
 * against the run's own cap on batches as it is queued, so it is never more
 * than a transcript.
 *
 * EVIDENCE NEVER FAILS A RUN. A refused evidence call stops the transcript and
 * is remembered as the reason an already-failing run ended; it does not itself
 * end one, because the ticket's work is not what this module is for.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  nativeHttpPageItemsMax,
  runEndedEvidences,
  runModelCharsMax,
  runOutcomeLabelCharsMax,
  runTranscriptBatchBytesMax,
  runTranscriptBatchesMax,
  runTurnSeriesMax,
  workerPlaneBytesMediaType,
  workerPlaneRoutes,
} from "@chuggy/worker-contract/workerPlane";

import {
  observeRateLimit,
  rateLimitSightings,
  rateLimited,
} from "./rateLimit.mjs";
import { workerRequest } from "./transport.mjs";
import { rosterLabel, routePath } from "./wire.mjs";

/** The interval a run's transcript is shipped on, whether or not anyone reads. */
export const runTranscriptFlushMs = 5_000;

/** The largest event kept whole; a larger one keeps its shape and loses its
 * oversized string payloads. */
export const runTranscriptEventBytesMax = 16_384;

/** How deep and how wide an oversized event is walked before it is replaced
 * whole. */
export const runTranscriptEventDepthMax = 16;
export const runTranscriptEventStringsMax = 4_096;

/** Values shorter than this are not distinctive enough to replace without
 * mangling ordinary text. */
export const credentialScrubCharsMin = 16;

/** Where an attempt that ended without a result leaves the text saying why. */
export const workerErrorPath = ".chuggy/worker-error.txt";

const credentialRedaction = "[redacted credential]";
const turnsExhaustedSubtype = "error_max_turns";
const runCostBasis = "List";
const unnamedModel = "unknown";
const runTurnPagesMax = Math.ceil(runTurnSeriesMax / nativeHttpPageItemsMax);

/** The plane's labels for how a run ended, each refused as this module loads where the contract no longer has it. */
const [runFailed, runRateLimited, runTurnsExhausted, runUploadRefused] = [
  "RunFailed",
  "RunRateLimited",
  "RunTurnsExhausted",
  "RunUploadRefused",
].map((label) => rosterLabel(runEndedEvidences, label));

/** The labels of the harness's own steps, each ending a run that stopped at it. */
export const [
  runCloneFailed,
  runSetupFailed,
  runCommitFailed,
  runPushFailed,
  runTimedOut,
] = [
  "RunCloneFailed",
  "RunSetupFailed",
  "RunCommitFailed",
  "RunPushFailed",
  "RunTimedOut",
].map((label) => rosterLabel(runEndedEvidences, label));

/** A failure of one of the harness's own steps, carrying that step's label. */
export class RunStepFailure extends Error {
  constructor(evidence, message, options) {
    super(message, options);
    this.name = "RunStepFailure";
    this.evidence = evidence;
  }
}

/**
 * What `run` resolves to, or its failure thrown as the step labelled
 * `evidence`, its text led by the line `lead` answers of it where it answers
 * one. A failure already a step's keeps its own label and text.
 */
export async function runStep(evidence, run, lead = () => undefined) {
  try {
    return await run();
  } catch (failure) {
    if (failure instanceof RunStepFailure) throw failure;
    const message =
      failure instanceof Error ? failure.message : String(failure);
    const first = lead(failure);
    throw new RunStepFailure(
      evidence,
      first === undefined ? message : `${first}\n\n${message}`,
      { cause: failure },
    );
  }
}

/**
 * The scrub every uploaded byte passes through, replacing exact occurrences of
 * the credential values the worker was handed. It matches a value as written,
 * so one carrying a quote, a backslash or a newline is replaced in raw text but
 * not where JSON has escaped it.
 */
export function credentialScrub(secrets) {
  const values = credentialScrubValues(secrets);
  return (text) =>
    values.reduce(
      (scrubbed, value) => scrubbed.split(value).join(credentialRedaction),
      text,
    );
}

/** The values a scrub replaces, in the order it replaces them: longest first. */
function credentialScrubValues(secrets) {
  return [...new Set(secrets)]
    .filter(credentialScrubReplaces)
    .sort((left, right) => right.length - left.length);
}

function credentialScrubReplaces(secret) {
  return typeof secret === "string" && secret.length >= credentialScrubCharsMin;
}

/**
 * The scrub of a text still being written: a head of what `credentialScrub`
 * makes of `text` followed by anything at all. Each value is replaced in the
 * scrub's own order, and each is handed only what the one before it settled,
 * so no later text changes a character of what this returns. What is left out
 * is a tail that may be a credential's beginning, and it is returned once
 * later text says it was not one.
 */
export function credentialScrubHead(secrets) {
  const values = credentialScrubValues(secrets);
  return (text) => values.reduce(credentialScrubSettled, text);
}

/** `text` with `value` replaced, less the longest tail that begins `value`. */
function credentialScrubSettled(text, value) {
  const pieces = text.split(value);
  const tail = pieces.pop();
  let undecided = Math.min(tail.length, value.length - 1);
  while (undecided > 0 && !tail.endsWith(value.slice(0, undecided)))
    undecided -= 1;
  pieces.push(tail.slice(0, tail.length - undecided));
  return pieces.join(credentialRedaction);
}

/**
 * The same scrub over a set of secrets that grows. A credential the plane mints
 * after the run started is as much this pod's to hide as one its launcher
 * mounted, and the evidence recorder, the diagnostics and the failure path all
 * took the function before that mint — so what the one they hold delegates to is
 * what a later secret replaces.
 *
 * Each secret is a `{ kind, value }`, and `held` answers the ones the scrub
 * replaces, each once under the first kind it was held as, so a secret can be
 * named without being printed. `scrubHead` is `credentialScrubHead` over the
 * same set.
 */
export function credentialScrubbing(secrets) {
  const held = [...secrets];
  const values = () => held.map(({ value }) => value);
  let scrubbing = credentialScrub(values());
  let heading = credentialScrubHead(values());
  return {
    scrub: (text) => scrubbing(text),
    scrubHead: (text) => heading(text),
    keepSecret: (secret) => {
      held.push(secret);
      scrubbing = credentialScrub(values());
      heading = credentialScrubHead(values());
    },
    held: () => {
      const kinds = new Map();
      for (const { kind, value } of held)
        if (credentialScrubReplaces(value) && !kinds.has(value))
          kinds.set(value, kind);
      return [...kinds].map(([value, kind]) => ({ kind, value }));
    },
  };
}

function digestOf(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** What replaces a payload too large to keep, naming its size and its digest so
 * the elision is still a reference. */
export function truncationMarker(value) {
  return {
    chuggy_truncated: {
      bytes: Buffer.byteLength(value),
      digest: digestOf(value),
    },
  };
}

function eventStringSites(node, sites, depth) {
  if (depth > runTranscriptEventDepthMax) return false;
  let complete = true;
  for (const [key, value] of Object.entries(node)) {
    if (sites.length >= runTranscriptEventStringsMax) return false;
    if (typeof value === "string")
      sites.push({ container: node, key, bytes: Buffer.byteLength(value) });
    else if (value !== null && typeof value === "object")
      complete = eventStringSites(value, sites, depth + 1) && complete;
  }
  return complete;
}

function replacedEvent(line, type) {
  const marker = truncationMarker(line);
  return JSON.stringify(
    typeof type === "string" ? { type, ...marker } : marker,
  );
}

/**
 * The line as it is kept, with the oversized string payloads of an oversized
 * event replaced so its type, order and position survive.
 */
export function truncatedEvent(line) {
  let bytes = Buffer.byteLength(line);
  if (bytes <= runTranscriptEventBytesMax) return line;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return replacedEvent(line, undefined);
  }
  if (event === null || typeof event !== "object")
    return replacedEvent(line, undefined);
  const sites = [];
  if (!eventStringSites(event, sites, 0))
    return replacedEvent(line, event.type);
  sites.sort((left, right) => right.bytes - left.bytes);
  for (const site of sites) {
    if (bytes <= runTranscriptEventBytesMax) break;
    const marker = truncationMarker(site.container[site.key]);
    bytes -= site.bytes - Buffer.byteLength(JSON.stringify(marker));
    site.container[site.key] = marker;
  }
  const truncated = JSON.stringify(event);
  return Buffer.byteLength(truncated) <= runTranscriptEventBytesMax
    ? truncated
    : replacedEvent(line, event.type);
}

function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function micros(usd) {
  return typeof usd === "number" && Number.isFinite(usd) && usd > 0
    ? Math.round(usd * 1e6)
    : 0;
}

function label(name, value) {
  return typeof value === "string" && value.length > 0
    ? { [name]: value.slice(0, runOutcomeLabelCharsMax) }
    : {};
}

/** A model identity inside the length the plane stores, named where the runtime
 * left it blank. */
function boundedModel(model) {
  const named = model.slice(0, runModelCharsMax);
  return named.length > 0 ? named : unnamedModel;
}

function streamTokens(usage) {
  return {
    tokensInput: count(usage?.input_tokens),
    tokensOutput: count(usage?.output_tokens),
    tokensCacheCreation: count(usage?.cache_creation_input_tokens),
    tokensCacheRead: count(usage?.cache_read_input_tokens),
  };
}

/**
 * One assistant turn's usage, or nothing when the event is not a turn the
 * runtime charged for. It carries no instant: the plane dates the row it
 * stores, and a worker clock is no authority on when a row was stored.
 */
export function runTurn(event, ordinal) {
  const model = event?.message?.model;
  if (event?.type !== "assistant" || typeof model !== "string")
    return undefined;
  return {
    ordinal,
    model: boundedModel(model),
    ...streamTokens(event.message.usage),
  };
}

function reportedModels(modelUsage) {
  if (modelUsage === null || typeof modelUsage !== "object") return [];
  return Object.entries(modelUsage)
    .slice(0, nativeHttpPageItemsMax)
    .map(([model, usage]) => ({
      model: boundedModel(model),
      tokensInput: count(usage?.inputTokens),
      tokensOutput: count(usage?.outputTokens),
      tokensCacheCreation: count(usage?.cacheCreationInputTokens),
      tokensCacheRead: count(usage?.cacheReadInputTokens),
      costUsdMicros: micros(usage?.costUSD),
    }));
}

function foldedModels(turns) {
  const byModel = new Map();
  for (const turn of turns.slice(0, runTurnSeriesMax)) {
    const held = byModel.get(turn.model) ?? {
      model: turn.model,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheCreation: 0,
      tokensCacheRead: 0,
      costUsdMicros: 0,
    };
    held.tokensInput += turn.tokensInput;
    held.tokensOutput += turn.tokensOutput;
    held.tokensCacheCreation += turn.tokensCacheCreation;
    held.tokensCacheRead += turn.tokensCacheRead;
    byModel.set(turn.model, held);
  }
  return [...byModel.values()].slice(0, nativeHttpPageItemsMax);
}

function summed(models, kind) {
  return models.reduce((total, held) => total + held[kind], 0);
}

function foldedTotals(turns) {
  const models = foldedModels(turns);
  return {
    tokensInput: summed(models, "tokensInput"),
    tokensOutput: summed(models, "tokensOutput"),
    tokensCacheCreation: summed(models, "tokensCacheCreation"),
    tokensCacheRead: summed(models, "tokensCacheRead"),
    turns: turns.length,
    durationMs: 0,
    durationApiMs: 0,
    costUsdMicros: 0,
    costBasis: runCostBasis,
    models,
    permissionDenials: 0,
  };
}

/**
 * What one run spent, from the runtime's own result event where there is one and
 * from the folded turn series where the run died before emitting one.
 */
export function runTotals(result, turns) {
  if (result === null || result === undefined) return foldedTotals(turns);
  return {
    ...streamTokens(result.usage),
    turns: count(result.num_turns),
    durationMs: count(result.duration_ms),
    durationApiMs: count(result.duration_api_ms),
    costUsdMicros: micros(result.total_cost_usd),
    costBasis: runCostBasis,
    models: reportedModels(result.modelUsage),
    permissionDenials: Array.isArray(result.permission_denials)
      ? result.permission_denials.length
      : 0,
    ...label("resultSubtype", result.subtype),
    ...label("stopReason", result.stop_reason),
  };
}

/**
 * Which of the plane's run-ended labels this failure was. A run that stopped at
 * one of the harness's own steps is labelled by that `step`, whatever else it
 * saw. A run the runtime accounted for is labelled by that account, so a
 * refused upload names the end only of a run nothing else speaks for.
 *
 * A hold outranks the account, because a run that exhausted its turns while the
 * provider was refusing every request never had the turns to spend. What counts
 * as a hold is `rateLimit.mjs`'s, folded from the frames as they went past.
 */
export function endedEvidence(result, planeRefused, sightings, step) {
  const subtype = typeof result?.subtype === "string" ? result.subtype : "";
  if (step !== undefined) return step;
  if (rateLimited(sightings)) return runRateLimited;
  if (subtype === turnsExhaustedSubtype) return runTurnsExhausted;
  if (result !== null && result !== undefined) return runFailed;
  return planeRefused === true ? runUploadRefused : runFailed;
}

function transcriptTruncationLine(batches) {
  return JSON.stringify({ type: "chuggy_transcript_truncated", batches });
}

function turnsTruncationLine(turns) {
  return JSON.stringify({ type: "chuggy_turns_truncated", turns });
}

function evidenceState(scrub) {
  return {
    scrub,
    lines: [],
    bufferedBytes: 0,
    sealed: [],
    nextBatch: 1,
    stopped: false,
    transcriptRefused: false,
    planeRefused: false,
    acknowledged: 0,
    ordinal: 0,
    turns: [],
    pending: [],
    result: undefined,
    sightings: rateLimitSightings(),
    totalsPosted: false,
    flushing: undefined,
  };
}

function appendLine(state, text) {
  state.lines.push(text);
  state.bufferedBytes += Buffer.byteLength(text) + 1;
}

function wouldExceedBatch(state, text) {
  return (
    state.lines.length > 0 &&
    state.bufferedBytes + Buffer.byteLength(text) + 1 >
      runTranscriptBatchBytesMax
  );
}

function foldTurn(state, event) {
  if (state.ordinal >= runTurnSeriesMax) return undefined;
  const turn = runTurn(event, state.ordinal + 1);
  if (turn === undefined) return undefined;
  state.ordinal += 1;
  state.turns.push(turn);
  if (!state.transcriptRefused && state.ordinal > state.acknowledged)
    state.pending.push(turn);
  return state.ordinal === runTurnSeriesMax
    ? turnsTruncationLine(runTurnSeriesMax)
    : undefined;
}

async function acknowledgedTurns(answer) {
  if (typeof answer?.json !== "function") return 0;
  try {
    return count((await answer.json())?.turnsRecorded);
  } catch {
    return 0;
  }
}

async function deliverTurns(state, call) {
  for (
    let page = 0;
    page < runTurnPagesMax && state.pending.length > 0;
    page += 1
  ) {
    const rows = state.pending.slice(0, nativeHttpPageItemsMax);
    const answer = await call(workerPlaneRoutes.runTurns.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turns: rows }),
    });
    state.acknowledged = Math.max(
      state.acknowledged,
      await acknowledgedTurns(answer),
      rows.at(-1).ordinal,
    );
    state.pending = state.pending.filter(
      (turn) => turn.ordinal > state.acknowledged,
    );
  }
}

/**
 * The buffered lines closed as the batch after every one sent or queued. The
 * run's last is the line saying the transcript stops there, and nothing is
 * buffered after it.
 */
function sealBatch(state) {
  if (state.lines.length === 0) return;
  const batch = state.nextBatch + state.sealed.length;
  const final = batch >= runTranscriptBatchesMax;
  state.sealed.push(
    final
      ? `${transcriptTruncationLine(batch)}\n`
      : `${state.lines.join("\n")}\n`,
  );
  state.lines = [];
  state.bufferedBytes = 0;
  if (final) state.stopped = true;
}

/**
 * Every batch closed so far, oldest first, each behind the turns folded before
 * it was closed: one closed while this waited on the plane covers turns the
 * flush had not yet sent.
 */
async function deliverBatches(state, call) {
  sealBatch(state);
  for (
    let sent = 0;
    sent < runTranscriptBatchesMax && state.sealed.length > 0;
    sent += 1
  ) {
    await deliverTurns(state, call);
    await call(
      routePath(workerPlaneRoutes.runTranscript, String(state.nextBatch)),
      {
        method: "PUT",
        headers: { "content-type": workerPlaneBytesMediaType },
        body: Buffer.from(state.sealed[0]),
      },
    );
    state.sealed.shift();
    state.nextBatch += 1;
  }
}

function failureText(failure) {
  return failure instanceof Error ? failure.message : "run evidence refused";
}

function refuse(state, warn, what, failure) {
  state.planeRefused = true;
  warn(`${what} refused: ${failureText(failure)}\n`);
}

async function flushOnce(state, call, warn) {
  try {
    await deliverTurns(state, call);
    await deliverBatches(state, call);
  } catch (failure) {
    state.transcriptRefused = true;
    state.lines = [];
    state.bufferedBytes = 0;
    state.sealed = [];
    state.pending = [];
    refuse(state, warn, "run evidence", failure);
  }
}

function evidenceUploads(state, call, warn, drain, done) {
  return {
    async configuration(content) {
      try {
        await call(workerPlaneRoutes.runConfiguration.path, {
          method: "PUT",
          headers: { "content-type": workerPlaneBytesMediaType },
          body: content,
        });
      } catch (failure) {
        refuse(state, warn, "run configuration", failure);
      }
    },
    async finish() {
      if (state.totalsPosted) return;
      state.totalsPosted = true;
      done();
      await drain();
      try {
        await call(workerPlaneRoutes.runTotals.path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(runTotals(state.result, state.turns)),
        });
      } catch (failure) {
        refuse(state, warn, "run totals", failure);
      }
    },
    async ended(step) {
      done();
      await call(workerPlaneRoutes.runEnded.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          evidence: endedEvidence(
            state.result,
            state.planeRefused,
            state.sightings,
            step,
          ),
        }),
      });
    },
    stop: done,
  };
}

/**
 * The worker's evidence client: it buffers the stream, ships it on the flush
 * interval and posts the run's totals before anything terminalizes the
 * execution.
 */
export function runEvidenceRecorder(task, bearer, scrub, services = {}) {
  const {
    request = workerRequest,
    setInterval: schedule = globalThis.setInterval,
    clearInterval: unschedule = globalThis.clearInterval,
    warn = (text) => process.stderr.write(text),
  } = services;
  const state = evidenceState(scrub);
  const call = (path, init) => request(task, bearer, path, init);
  // One flush at a time: a tick that finds one in flight starts no other, and
  // what it would have shipped goes with the next.
  const flush = () => {
    state.flushing ??= flushOnce(state, call, warn).finally(() => {
      state.flushing = undefined;
    });
    return state.flushing;
  };
  const drain = async () => {
    await state.flushing;
    await flush();
  };
  const append = (text) => {
    if (state.stopped || state.transcriptRefused) return;
    if (wouldExceedBatch(state, text)) sealBatch(state);
    if (!state.stopped) appendLine(state, text);
  };
  const timer = schedule(flush, runTranscriptFlushMs);
  timer?.unref?.();
  return {
    ...evidenceUploads(state, call, warn, drain, () => unschedule(timer)),
    record(line, event) {
      observeRateLimit(state.sightings, event);
      append(state.scrub(truncatedEvent(line)));
      const marker = foldTurn(state, event);
      if (marker !== undefined) append(marker);
    },
    observed(result) {
      state.result = result;
    },
  };
}
