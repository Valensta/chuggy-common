import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { setImmediate } from "node:timers";

import {
  runEndedEvidences,
  runModelCharsMax,
  runTranscriptBatchBytesMax,
  runTranscriptBatchesMax,
  runTurnSeriesMax,
} from "@chuggy/worker-contract/workerPlane";

import { drawnSecrets, drawnText, seeded } from "./credentialText.fixture.mjs";
import {
  credentialScrub,
  credentialScrubbing,
  credentialScrubCharsMin,
  credentialScrubHead,
  endedEvidence,
  RunStepFailure,
  runCloneFailed,
  runCommitFailed,
  runEvidenceRecorder,
  runPushFailed,
  runSetupFailed,
  runStep,
  runTimedOut,
  runTotals,
  runTranscriptEventBytesMax,
  runTurn,
  truncatedEvent,
} from "./runEvidence.mjs";
import { observeRateLimit, rateLimitSightings } from "./rateLimit.mjs";

/** The sightings a run that saw exactly these frames, in this order, ends with. */
function seenBy(...events) {
  return events.reduce(observeRateLimit, rateLimitSightings());
}

const task = { workerPlane: { url: "http://worker-plane.test:3001" } };
const secret = "sk-ant-oat01-0123456789abcdefghijklmnopqrstuvwxyz";

function harness(options = {}) {
  const calls = [];
  let ticked;
  const recorder = runEvidenceRecorder(
    task,
    "bearer",
    options.scrub ?? ((text) => text),
    {
      request: async (_task, _bearer, path, init) => {
        calls.push({ path, init });
        await options.behaviour?.(path);
        if (path !== "/v1/run/turns") return { ok: true, status: 204 };
        return {
          ok: true,
          status: 200,
          json: async () => ({ turnsRecorded: options.turnsRecorded ?? 0 }),
        };
      },
      setInterval: (callback) => {
        ticked = callback;
        return { unref: () => undefined };
      },
      clearInterval: () => undefined,
      warn: () => undefined,
    },
  );
  return { recorder, calls, tick: () => ticked() };
}

function assistantEvent(model, usage) {
  return { type: "assistant", message: { model, usage } };
}

/** A plane that answers nothing until `back()`, as one that is away and then returns does. */
function awayPlane() {
  let back;
  const away = new Promise((returned) => {
    back = returned;
  });
  return { behaviour: () => away, back };
}

/** The transcript batches a plane was sent, in the order it was sent them. */
function transcriptBatches(calls) {
  return calls.filter(({ path }) => path.startsWith("/v1/run/tran"));
}

test("a credential the worker was handed is redacted wherever it appears", () => {
  const scrub = credentialScrub([secret]);
  assert.equal(
    scrub(`before ${secret} between ${secret} after`),
    "before [redacted credential] between [redacted credential] after",
  );
});

test("a value one character short of a credential is left alone", () => {
  const scrub = credentialScrub([secret]);
  const nearMiss = secret.slice(0, -1);
  assert.equal(scrub(`before ${nearMiss} after`), `before ${nearMiss} after`);
});

test("a credential too short to be distinctive is not scrubbed", () => {
  const short = "a".repeat(credentialScrubCharsMin - 1);
  assert.equal(credentialScrub([short])(`x ${short} y`), `x ${short} y`);
});

test("a credential minted after the scrub was handed out is scrubbed by it", () => {
  const { scrub, keepSecret } = credentialScrubbing([
    { kind: "agent", value: secret },
  ]);
  const minted = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";

  assert.equal(scrub(`saw ${minted}`), `saw ${minted}`);
  keepSecret({ kind: "minted", value: minted });

  assert.equal(scrub(`saw ${minted}`), "saw [redacted credential]");
  assert.equal(scrub(`saw ${secret}`), "saw [redacted credential]");
});

test("a text still being written is scrubbed only as far as no later text can change it", () => {
  const head = credentialScrubHead([secret]);
  const begun = secret.slice(0, 20);

  assert.equal(head(`the token is ${begun}`), "the token is ");
  assert.equal(
    head(`the token is ${begun} and more`),
    `the token is ${begun} and more`,
    "a beginning that turned out not to be the credential stayed held back",
  );
  assert.equal(
    head(`the token is ${secret} and more`),
    "the token is [redacted credential] and more",
  );
  assert.equal(
    head(`one ${secret} two ${secret.slice(0, 1)}`),
    "one [redacted credential] two ",
    "the credential's first character was sent before what follows it was known",
  );
});

/**
 * Where one credential holds another, the store replaces the longer whole and
 * the shorter wherever it stands alone, and a text in pieces sends neither:
 * the shorter is held back while it may still be the longer's middle.
 */
test("a credential inside another is never sent, whichever of them the text turns out to hold", () => {
  const inner = "inner-0123456789abcdef";
  const outer = `outer-${inner}-tail-0123`;
  const [scrub, head] = [credentialScrub, credentialScrubHead].map((make) =>
    make([inner, outer]),
  );

  assert.equal(scrub(`a ${outer} b`), "a [redacted credential] b");
  assert.equal(scrub(`a ${inner} b`), "a [redacted credential] b");
  for (const whole of [
    `a ${outer} b`,
    `a outer-${inner}-other b`,
    `a ${inner}`,
  ])
    for (let cut = 0; cut <= whole.length; cut += 1) {
      const sent = head(whole.slice(0, cut));
      assert.ok(
        scrub(whole).startsWith(sent),
        `${whole} cut at ${String(cut)}`,
      );
      assert.ok(
        !sent.includes(inner.slice(0, 8)),
        `${sent} holds a credential`,
      );
    }
});

/**
 * Where two credentials overlap in a text, the store replaces the one the
 * scrub reaches first, the longer, and leaves what remains of the other. A
 * text in pieces sends that remainder too and nothing else: never more than
 * the store holds.
 */
test("credentials that overlap are sent as the store holds them, the longer replaced and the rest left", () => {
  const first = "0123456789abcdefXYZ";
  const second = "abcdefXYZ0123456789-q";
  const overlapped = `${first}${second.slice("abcdefXYZ".length)}`;
  const [scrub, head] = [credentialScrub, credentialScrubHead].map((make) =>
    make([first, second]),
  );

  assert.equal(
    scrub(`a ${overlapped} b`),
    "a 0123456789[redacted credential] b",
  );
  for (let cut = 0; cut <= overlapped.length + 4; cut += 1)
    assert.ok(
      scrub(`a ${overlapped} b`).startsWith(
        head(`a ${overlapped} b`.slice(0, cut)),
      ),
      `cut at ${String(cut)}`,
    );
});

/**
 * The property the live stream rests on, over drawn credentials and texts:
 * whatever was scrubbed of a text's beginning is how the scrub of the whole
 * text begins, it only grows as the text does, and nothing is held back once
 * the text's last character is one no credential holds.
 */
test("whatever a text's beginning is scrubbed to is how the whole text's scrub begins", () => {
  for (let seed = 1; seed <= 400; seed += 1) {
    const random = seeded(seed);
    const secrets = drawnSecrets(random);
    const text = drawnText(random, secrets, 12);
    const [scrub, head] = [credentialScrub, credentialScrubHead].map((make) =>
      make(secrets),
    );
    const whole = scrub(text);
    let before = "";
    for (let cut = 0; cut <= text.length; cut += 1) {
      const begun = text.slice(0, cut);
      const sent = head(begun);
      const named = `seed ${String(seed)} cut at ${String(cut)}`;
      assert.ok(whole.startsWith(sent), `${named} sent what the store redacts`);
      assert.ok(sent.startsWith(before), `${named} took back what was sent`);
      if (!secrets.some((value) => value.includes(begun.slice(-1))))
        assert.equal(sent, scrub(begun), `${named} held back settled text`);
      before = sent;
    }
    assert.equal(scrub(text).startsWith(head(text)), true);
  }
});

test("a credential minted after the head scrub was handed out is held back by it", () => {
  const { scrubHead, keepSecret } = credentialScrubbing([
    { kind: "agent", value: secret },
  ]);
  const minted = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";

  assert.equal(
    scrubHead(`saw ${minted.slice(0, 20)}`),
    `saw ${minted.slice(0, 20)}`,
  );
  keepSecret({ kind: "minted", value: minted });

  assert.equal(scrubHead(`saw ${minted.slice(0, 20)}`), "saw ");
  assert.equal(
    scrubHead(`saw ${minted} then`),
    "saw [redacted credential] then",
  );
});

/**
 * What a push is checked for is what the scrub replaces. Catches a held set
 * that drifted from it: a short value kept, which no scrub replaces, a
 * repeated one named twice, or a later kind renaming one held first.
 */
test("the held secrets are the scrub's, each once under the kind it was first held as", () => {
  const minted = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";
  const { held, keepSecret } = credentialScrubbing([
    { kind: "agent", value: secret },
    { kind: "bearer", value: "a".repeat(credentialScrubCharsMin - 1) },
    { kind: "mounted", value: secret },
  ]);
  keepSecret({ kind: "minted", value: minted });

  assert.deepEqual(held(), [
    { kind: "agent", value: secret },
    { kind: "minted", value: minted },
  ]);
});

test("an oversized event keeps its type and position and loses its payload", () => {
  const payload = "p".repeat(runTranscriptEventBytesMax * 2);
  const line = JSON.stringify({
    type: "user",
    ordinal: 7,
    message: { content: [{ type: "tool_result", content: payload }] },
  });
  const kept = JSON.parse(truncatedEvent(line));

  assert.ok(
    Buffer.byteLength(truncatedEvent(line)) <= runTranscriptEventBytesMax,
  );
  assert.equal(kept.type, "user");
  assert.equal(kept.ordinal, 7);
  assert.equal(kept.message.content[0].type, "tool_result");
  assert.equal(
    kept.message.content[0].content.chuggy_truncated.bytes,
    payload.length,
  );
  assert.match(
    kept.message.content[0].content.chuggy_truncated.digest,
    /^[0-9a-f]{64}$/u,
  );
});

test("an event within the bound is kept byte for byte", () => {
  const line = JSON.stringify({ type: "system", subtype: "init" });
  assert.equal(truncatedEvent(line), line);
});

test("the run's totals are the runtime's own figures", () => {
  const totals = runTotals(
    {
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      num_turns: 4,
      duration_ms: 252_000,
      duration_api_ms: 190_000,
      total_cost_usd: 0.4237185,
      permission_denials: [{ tool_name: "Bash" }],
      usage: {
        input_tokens: 11,
        output_tokens: 22,
        cache_creation_input_tokens: 33,
        cache_read_input_tokens: 44,
      },
      modelUsage: {
        "claude-opus-4": {
          inputTokens: 11,
          outputTokens: 22,
          cacheCreationInputTokens: 33,
          cacheReadInputTokens: 44,
          costUSD: 0.4237185,
        },
      },
    },
    [],
  );

  assert.deepEqual(totals, {
    tokensInput: 11,
    tokensOutput: 22,
    tokensCacheCreation: 33,
    tokensCacheRead: 44,
    turns: 4,
    durationMs: 252_000,
    durationApiMs: 190_000,
    costUsdMicros: 423_719,
    costBasis: "List",
    models: [
      {
        model: "claude-opus-4",
        tokensInput: 11,
        tokensOutput: 22,
        tokensCacheCreation: 33,
        tokensCacheRead: 44,
        costUsdMicros: 423_719,
      },
    ],
    permissionDenials: 1,
    resultSubtype: "success",
    stopReason: "end_turn",
  });
});

test("a run that emitted no result event still states its totals", () => {
  const turns = [
    runTurn(
      assistantEvent("claude-opus-4", {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 8,
      }),
      1,
    ),
    runTurn(
      assistantEvent("claude-opus-4", {
        input_tokens: 16,
        output_tokens: 32,
        cache_creation_input_tokens: 64,
        cache_read_input_tokens: 128,
      }),
      2,
    ),
    runTurn(
      assistantEvent("claude-haiku-4", {
        input_tokens: 256,
        output_tokens: 512,
        cache_creation_input_tokens: 1_024,
        cache_read_input_tokens: 2_048,
      }),
      3,
    ),
  ];
  const totals = runTotals(undefined, turns);

  assert.equal(totals.turns, 3);
  assert.equal(totals.costUsdMicros, 0);
  assert.equal(totals.costBasis, "List");
  assert.equal(totals.tokensInput, 273);
  assert.equal(totals.tokensOutput, 546);
  assert.equal(totals.tokensCacheCreation, 1_092);
  assert.equal(totals.tokensCacheRead, 2_184);
  assert.deepEqual(totals.models, [
    {
      model: "claude-opus-4",
      tokensInput: 17,
      tokensOutput: 34,
      tokensCacheCreation: 68,
      tokensCacheRead: 136,
      costUsdMicros: 0,
    },
    {
      model: "claude-haiku-4",
      tokensInput: 256,
      tokensOutput: 512,
      tokensCacheCreation: 1_024,
      tokensCacheRead: 2_048,
      costUsdMicros: 0,
    },
  ]);
});

test("a turn the runtime left unnamed still names a model the plane takes", () => {
  const turn = runTurn(assistantEvent("", { input_tokens: 3 }), 1);

  assert.ok(turn.model.length >= 1);
  assert.ok(turn.model.length <= runModelCharsMax);
  assert.equal(turn.model, "unknown");
  assert.equal(turn.tokensInput, 3);
});

test("a model identity longer than the plane stores is cut to it", () => {
  const turn = runTurn(assistantEvent("m".repeat(500), {}), 1);

  assert.equal(turn.model.length, runModelCharsMax);
});

test("an unnamed model in the runtime's own breakdown is named too", () => {
  const totals = runTotals(
    { type: "result", modelUsage: { "": { inputTokens: 4, costUSD: 0.5 } } },
    [],
  );

  assert.equal(totals.models[0].model, "unknown");
  assert.equal(totals.models[0].tokensInput, 4);
});

test("an event that is not a charged turn folds to nothing", () => {
  assert.equal(runTurn({ type: "system" }, 1), undefined);
  assert.equal(runTurn({ type: "assistant", message: {} }, 1), undefined);
});

test("an interval that produced no bytes ships nothing", async () => {
  const { calls, tick } = harness();
  await tick();
  await tick();
  assert.deepEqual(calls, []);
});

test("turns are posted before the batch that covers them", async () => {
  const { recorder, calls, tick } = harness();
  const event = assistantEvent("claude-opus-4", {
    input_tokens: 1,
    output_tokens: 2,
  });
  await recorder.record(JSON.stringify(event), event);
  await tick();

  assert.deepEqual(
    calls.map(({ path }) => path),
    ["/v1/run/turns", "/v1/run/transcript/1"],
  );
  assert.deepEqual(JSON.parse(calls[0].init.body).turns, [
    {
      ordinal: 1,
      model: "claude-opus-4",
      tokensInput: 1,
      tokensOutput: 2,
      tokensCacheCreation: 0,
      tokensCacheRead: 0,
    },
  ]);
});

test("a turn row carries what the plane takes and nothing besides", async () => {
  const { recorder, calls, tick } = harness();
  const event = assistantEvent("claude-opus-4", { input_tokens: 1 });
  await recorder.record(JSON.stringify(event), event);
  await tick();

  const [row] = JSON.parse(
    calls.find(({ path }) => path === "/v1/run/turns").init.body,
  ).turns;
  assert.deepEqual(Object.keys(row).sort(), [
    "model",
    "ordinal",
    "tokensCacheCreation",
    "tokensCacheRead",
    "tokensInput",
    "tokensOutput",
  ]);
});

test("a buffer that would exceed one body's worth is shipped first", async () => {
  const { recorder, calls, tick } = harness();
  const line = JSON.stringify({ type: "system", text: "x".repeat(1_000) });
  for (let written = 0; written < 200; written += 1)
    await recorder.record(line, { type: "system" });
  await tick();

  const batches = calls.filter(({ path }) => path.startsWith("/v1/run/tran"));
  assert.deepEqual(
    batches.map(({ path }) => path),
    [
      "/v1/run/transcript/1",
      "/v1/run/transcript/2",
      "/v1/run/transcript/3",
      "/v1/run/transcript/4",
    ],
  );
  for (const batch of batches)
    assert.ok(batch.init.body.byteLength <= runTranscriptBatchBytesMax);
});

test("the transcript stops at its run cap with a line saying so", async () => {
  const { recorder, calls, tick } = harness();
  const line = JSON.stringify({ type: "system" });
  for (let batch = 0; batch < runTranscriptBatchesMax + 2; batch += 1) {
    await recorder.record(line, { type: "system" });
    await tick();
  }

  const batches = calls.filter(({ path }) => path.startsWith("/v1/run/tran"));
  assert.equal(batches.length, runTranscriptBatchesMax);
  assert.equal(
    batches.at(-1).path,
    `/v1/run/transcript/${String(runTranscriptBatchesMax)}`,
  );
  assert.deepEqual(JSON.parse(batches.at(-1).init.body.toString("utf8")), {
    type: "chuggy_transcript_truncated",
    batches: runTranscriptBatchesMax,
  });
});

test("the turn series stops at its bound and the transcript says so", async () => {
  const { recorder, calls, tick } = harness();
  const event = assistantEvent("claude-opus-4", { input_tokens: 1 });
  const line = JSON.stringify(event);
  for (let turn = 0; turn < runTurnSeriesMax + 5; turn += 1)
    await recorder.record(line, event);
  await tick();

  const posted = calls
    .filter(({ path }) => path === "/v1/run/turns")
    .flatMap(({ init }) => JSON.parse(init.body).turns);
  assert.equal(posted.length, runTurnSeriesMax);
  assert.equal(posted.at(-1).ordinal, runTurnSeriesMax);
  const shipped = calls
    .filter(({ path }) => path.startsWith("/v1/run/tran"))
    .map(({ init }) => init.body.toString("utf8"))
    .join("");
  assert.ok(
    shipped.includes(
      JSON.stringify({
        type: "chuggy_turns_truncated",
        turns: runTurnSeriesMax,
      }),
    ),
  );
});

test("a refused evidence call stops the transcript and never fails the run", async () => {
  const { recorder, calls, tick } = harness({
    behaviour: (path) => {
      if (path.startsWith("/v1/run/tran")) throw new Error("plane refused");
    },
  });
  const event = assistantEvent("claude-opus-4", { input_tokens: 1 });
  const line = JSON.stringify(event);
  await recorder.record(line, event);
  await tick();
  const refusedAt = calls.length;
  await recorder.record(line, event);
  await tick();

  assert.deepEqual(
    calls.slice(0, refusedAt).map(({ path }) => path),
    ["/v1/run/turns", "/v1/run/transcript/1"],
  );
  assert.equal(calls.length, refusedAt);
});

/** Catches a refusal that leaves the batches queued behind it to be offered again. */
test("a refusal stops the batches waiting behind the one refused", async () => {
  const { recorder, calls, tick } = harness({
    behaviour: (path) => {
      if (path.startsWith("/v1/run/tran")) throw new Error("plane refused");
    },
  });
  const line = JSON.stringify({ type: "system", text: "x".repeat(1_000) });
  for (let written = 0; written < 200; written += 1)
    recorder.record(line, { type: "system" });
  await tick();
  await tick();
  await recorder.finish();

  assert.deepEqual(
    transcriptBatches(calls).map(({ path }) => path),
    ["/v1/run/transcript/1"],
  );
});

/** Catches a flush queued behind another on every interval a slow plane outlasts. */
test("a tick that finds a flush in flight starts no other", async () => {
  const plane = awayPlane();
  const { recorder, calls, tick } = harness(plane);
  recorder.record(JSON.stringify({ type: "system" }), { type: "system" });
  const inFlight = tick();

  assert.equal(tick(), inFlight);
  assert.equal(tick(), inFlight);
  plane.back();
  await inFlight;

  assert.deepEqual(
    calls.map(({ path }) => path),
    ["/v1/run/transcript/1"],
  );
});

/** Catches a run whose end took the flush in flight for the last one, and posted its totals over a line still buffered. */
test("a run that ends with a flush in flight ships what that flush left behind", async () => {
  const plane = awayPlane();
  const { recorder, calls, tick } = harness(plane);
  const lines = ["first", "second"].map((text) =>
    JSON.stringify({ type: "system", text }),
  );
  recorder.record(lines[0], { type: "system" });
  tick();
  await new Promise((turned) => setImmediate(turned));
  recorder.record(lines[1], { type: "system" });
  const finished = recorder.finish();
  plane.back();
  await finished;

  assert.deepEqual(
    calls.map(({ path, init }) => [path, init.body.toString("utf8")]),
    [
      ["/v1/run/transcript/1", `${lines[0]}\n`],
      ["/v1/run/transcript/2", `${lines[1]}\n`],
      ["/v1/run/totals", calls.at(-1).init.body],
    ],
  );
});

/**
 * An agent writing more than a batch while the plane is away. Catches a writer
 * held until the plane answers, a line dropped or reordered while it waited,
 * and a batch closed over the size one body carries.
 */
test("a line written while the plane is away waits for nothing, and none is lost", async () => {
  const plane = awayPlane();
  const { recorder, calls, tick } = harness(plane);
  const lines = Array.from({ length: 200 }, (_, written) =>
    JSON.stringify({ type: "system", text: String(written).padEnd(1_000) }),
  );
  recorder.record(lines[0], { type: "system" });
  const inFlight = tick();
  const written = (async () => {
    for (const line of lines.slice(1))
      await recorder.record(line, { type: "system" });
  })();

  const waited = await Promise.race([
    written.then(() => false),
    new Promise((turned) => setImmediate(() => turned(true))),
  ]);
  assert.equal(waited, false, "the writer waited on a plane that was away");
  plane.back();
  await inFlight;
  await recorder.finish();

  const batches = transcriptBatches(calls);
  assert.ok(batches.length > 2, String(batches.length));
  assert.deepEqual(
    batches.map(({ path }) => path),
    batches.map((_, sent) => `/v1/run/transcript/${String(sent + 1)}`),
  );
  for (const batch of batches)
    assert.ok(batch.init.body.byteLength <= runTranscriptBatchBytesMax);
  assert.equal(
    batches.map(({ init }) => init.body.toString("utf8")).join(""),
    lines.map((line) => `${line}\n`).join(""),
  );
});

/**
 * An agent taking turns while a batch waits on the plane, enough of them to
 * close another. Catches that batch sent ahead of the turns it covers, which
 * were folded after the flush sent its own.
 */
test("a batch closed while another waited is sent after the turns it covers", async () => {
  const plane = awayPlane();
  const { recorder, calls, tick } = harness({
    behaviour: (path) =>
      path === "/v1/run/transcript/1" ? plane.behaviour() : undefined,
  });
  const turn = (ordinal) => {
    const event = {
      ...assistantEvent("claude-test", { input_tokens: ordinal }),
      padding: "x".repeat(runTranscriptEventBytesMax / 2),
    };
    recorder.record(JSON.stringify(event), event);
  };
  turn(1);
  const inFlight = tick();
  await new Promise((turned) => setImmediate(turned));
  const turns = (4 * runTranscriptBatchBytesMax) / runTranscriptEventBytesMax;
  for (let ordinal = 2; ordinal <= turns; ordinal += 1) turn(ordinal);
  plane.back();
  await inFlight;
  await recorder.finish();

  let posted = 0;
  let covered = 0;
  for (const { path, init } of calls) {
    if (path === "/v1/run/turns")
      posted = JSON.parse(init.body).turns.at(-1).ordinal;
    if (!path.startsWith("/v1/run/tran")) continue;
    covered += init.body.toString("utf8").split("\n").length - 1;
    assert.ok(covered <= posted, `${path} went before turn ${covered}`);
  }
  assert.equal(covered, turns);
  assert.ok(transcriptBatches(calls).length > 2);
});

/**
 * What waits on a plane that is away is counted against the run's cap with
 * what was sent, so the queue ends where the transcript does. Catches a cap
 * read off the batches sent alone, which a plane that is away never moves.
 */
test("the batches waiting on a plane that is away stop at the run cap", async () => {
  let away;
  let back;
  const { recorder, calls, tick } = harness({ behaviour: () => away });
  const line = JSON.stringify({ type: "system" });
  const waiting = 3;
  for (let batch = 0; batch < runTranscriptBatchesMax - waiting; batch += 1) {
    recorder.record(line, { type: "system" });
    await tick();
  }
  away = new Promise((returned) => {
    back = returned;
  });
  recorder.record(line, { type: "system" });
  const inFlight = tick();
  const full = JSON.stringify({
    type: "system",
    text: "x".repeat(runTranscriptEventBytesMax / 2),
  });
  const fullBatches = 2 * waiting;
  for (
    let bytes = 0;
    bytes < fullBatches * runTranscriptBatchBytesMax;
    bytes += Buffer.byteLength(full)
  )
    recorder.record(full, { type: "system" });
  back();
  await inFlight;
  await recorder.finish();

  const batches = transcriptBatches(calls);
  assert.equal(batches.length, runTranscriptBatchesMax);
  assert.deepEqual(JSON.parse(batches.at(-1).init.body.toString("utf8")), {
    type: "chuggy_transcript_truncated",
    batches: runTranscriptBatchesMax,
  });
});

test("a run that outlived its evidence still names the plane as the reason", () => {
  assert.equal(
    endedEvidence({ subtype: "error_max_turns" }, false, undefined),
    "RunTurnsExhausted",
  );
  assert.equal(endedEvidence(undefined, true, undefined), "RunUploadRefused");
  assert.equal(endedEvidence(undefined, false, undefined), "RunFailed");
  assert.equal(
    endedEvidence({ subtype: "error_during_execution" }, false, undefined),
    "RunFailed",
  );
});

test("a run stopped at a step is that step's, whatever else it saw", () => {
  const steps = [
    runCloneFailed,
    runSetupFailed,
    runCommitFailed,
    runPushFailed,
    runTimedOut,
  ];
  assert.equal(new Set(steps).size, steps.length);
  for (const step of steps) {
    assert.ok(runEndedEvidences.includes(step), step);
    assert.equal(
      endedEvidence(
        { subtype: "error_max_turns" },
        true,
        seenBy(rejection),
        step,
      ),
      step,
    );
  }
});

test("a step's failure carries its label, led by what the step says of it", async () => {
  const failure = Object.assign(new Error("Command failed: git push"), {
    stderr: "fatal: denied",
  });
  const failed = await runStep(
    runPushFailed,
    () => Promise.reject(failure),
    ({ stderr }) => stderr,
  ).catch((thrown) => thrown);

  assert.ok(failed instanceof RunStepFailure);
  assert.equal(failed.evidence, runPushFailed);
  assert.equal(failed.message, "fatal: denied\n\nCommand failed: git push");
  assert.equal(failed.cause, failure);
  assert.equal(await runStep(runPushFailed, async () => "pushed"), "pushed");
});

test("a step's failure inside another step keeps its own label and text", async () => {
  const inner = new RunStepFailure(runCommitFailed, "the commit failed");
  const failed = await runStep(
    runPushFailed,
    () => Promise.reject(inner),
    () => "a lead",
  ).catch((thrown) => thrown);

  assert.equal(failed, inner);
});

test("a step's failure says nothing more where nothing leads it", async () => {
  const failed = await runStep(runCloneFailed, () => {
    throw new Error("no repository configuration for repository-1");
  }).catch((thrown) => thrown);

  assert.equal(failed.evidence, runCloneFailed);
  assert.equal(failed.message, "no repository configuration for repository-1");
});

/**
 * The frames kasofsk/chuggy#386 reports, as the runtime declares them: the
 * status is on `rate_limit_info`, and the result the issue quotes says only
 * `api_error`. Nothing in either carries the text the label used to look for.
 */
const rejection = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected",
    rateLimitType: "five_hour",
    utilization: 1,
    resetsAt: 1787823600,
  },
};
const apiErrorResult = {
  type: "result",
  subtype: "error_during_execution",
  terminal_reason: "api_error",
};

test("the run the issue reports is a hold, and the same run without the rejection is not", () => {
  const seen = seenBy(rejection);
  assert.equal(endedEvidence(apiErrorResult, false, seen), "RunRateLimited");
  assert.equal(
    endedEvidence(apiErrorResult, false, rateLimitSightings()),
    "RunFailed",
  );
});

test("an assistant frame naming the rate-limited error kind is a hold", () => {
  assert.equal(
    endedEvidence(
      apiErrorResult,
      false,
      seenBy({ type: "assistant", error: "rate_limit" }),
    ),
    "RunRateLimited",
  );
  assert.equal(
    endedEvidence(
      apiErrorResult,
      false,
      seenBy({ type: "assistant", error: "server_error" }),
    ),
    "RunFailed",
  );
});

test("a rejection the provider then lifted is not a hold when the run ends", () => {
  assert.equal(
    endedEvidence(
      apiErrorResult,
      false,
      seenBy(rejection, {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed" },
      }),
    ),
    "RunFailed",
  );
});

test("a hold outranks the turn count, because a held run had no turns to spend", () => {
  assert.equal(
    endedEvidence({ subtype: "error_max_turns" }, false, seenBy(rejection)),
    "RunRateLimited",
  );
});

test("the recorder folds the frames it ships, so the ending reads the whole run", async () => {
  const { recorder, calls } = harness();
  const line = JSON.stringify(rejection);
  await recorder.record(line, rejection);
  recorder.observed(apiErrorResult);
  await recorder.ended();

  const ended = calls.find(({ path }) => path === "/v1/run/ended");
  assert.deepEqual(JSON.parse(ended.init.body), {
    evidence: "RunRateLimited",
  });
});

test("every transcript byte the worker ships has passed the scrub", async () => {
  const { recorder, calls, tick } = harness({
    scrub: credentialScrub([secret]),
  });
  const event = { type: "user", message: { content: `env printed ${secret}` } };
  await recorder.record(JSON.stringify(event), event);
  await tick();

  const shipped = calls
    .filter(({ path }) => path.startsWith("/v1/run/tran"))
    .map(({ init }) => init.body.toString("utf8"))
    .join("");
  assert.ok(!shipped.includes(secret));
  assert.ok(shipped.includes("[redacted credential]"));
});

test("a refused configuration does not stop the transcript it precedes", async () => {
  const { recorder, calls, tick } = harness({
    behaviour: (path) => {
      if (path === "/v1/run/configuration") throw new Error("plane refused");
    },
  });
  const event = assistantEvent("claude-opus-4", { input_tokens: 1 });
  await recorder.configuration(Buffer.from("{}"));
  await recorder.record(JSON.stringify(event), event);
  await tick();

  assert.deepEqual(
    calls.map(({ path }) => path),
    ["/v1/run/configuration", "/v1/run/turns", "/v1/run/transcript/1"],
  );
});

test("a lost acknowledgement is resynced from the plane's own high-water", async () => {
  const { recorder, calls, tick } = harness({ turnsRecorded: 3 });
  const event = assistantEvent("claude-opus-4", { input_tokens: 1 });
  const line = JSON.stringify(event);
  await recorder.record(line, event);
  await tick();
  await recorder.record(line, event);
  await recorder.record(line, event);
  await tick();
  await recorder.record(line, event);
  await tick();

  const posted = calls.filter(({ path }) => path === "/v1/run/turns");
  assert.equal(posted.length, 2);
  assert.deepEqual(
    JSON.parse(posted[0].init.body).turns.map(({ ordinal }) => ordinal),
    [1],
  );
  assert.deepEqual(
    JSON.parse(posted[1].init.body).turns.map(({ ordinal }) => ordinal),
    [4],
  );
});

test("a run the runtime accounted for is not labelled by an earlier refusal", async () => {
  const refuseTranscript = {
    behaviour: (path) => {
      if (path.startsWith("/v1/run/tran")) throw new Error("plane refused");
    },
  };
  const first = harness(refuseTranscript);
  await first.recorder.record(JSON.stringify({ type: "system" }), {
    type: "system",
  });
  await first.tick();
  first.recorder.observed({
    type: "result",
    subtype: "error_during_execution",
  });
  await first.recorder.ended();

  const second = harness(refuseTranscript);
  second.recorder.observed({
    type: "result",
    subtype: "error_during_execution",
  });
  await second.recorder.record(JSON.stringify({ type: "system" }), {
    type: "system",
  });
  await second.tick();
  await second.recorder.ended();

  for (const { calls } of [first, second])
    assert.equal(
      JSON.parse(calls.at(-1).init.body).evidence,
      "RunFailed",
      "the runtime's own account of the run outranks a refused upload",
    );
});

test("a run nothing else accounts for is labelled by the refusal", async () => {
  const { recorder, calls, tick } = harness({
    behaviour: (path) => {
      if (path.startsWith("/v1/run/tran")) throw new Error("plane refused");
    },
  });
  await recorder.record(JSON.stringify({ type: "system" }), { type: "system" });
  await tick();
  await recorder.ended();

  assert.equal(JSON.parse(calls.at(-1).init.body).evidence, "RunUploadRefused");
});

test("the totals a run ends with are posted once", async () => {
  const { recorder, calls } = harness();
  const event = { type: "result", num_turns: 2, total_cost_usd: 0.5 };
  recorder.observed(event);
  await recorder.finish();
  await recorder.finish();

  const totals = calls.filter(({ path }) => path === "/v1/run/totals");
  assert.equal(totals.length, 1);
  assert.equal(JSON.parse(totals[0].init.body).costUsdMicros, 500_000);
});
