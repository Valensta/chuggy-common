import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import { URL } from "node:url";

import { sessionStoreBatchBytesMax } from "@chuggy/worker-contract/sessionPlane";
import {
  agenticRefusalsAnsweredMax,
  allChuggyTools,
  briefLineCharsMax,
  chuggyDocsIndex,
  chuggyToolDocsResponseBytesMax,
  chuggyToolImageResponseBytesMax,
  chuggyToolPrefix,
  chuggyToolResponseBytesMax,
  chuggyToolRunErrorResponseBytesMax,
  chuggyToolRunTranscriptResponseBytesMax,
  chuggyToolTicketLandingBytesMax,
  chuggyToolTicketLandingsResponseBytesMax,
  chuggyToolTimeoutMs,
  nativeHttpPageItemsMax,
  runTranscriptBatchBytesMax,
  runTranscriptPageBatchesMax,
  selectorHistoryLimitMax,
  threadTurnsAnsweredMax,
  ticketLandingsAnsweredMax,
} from "@chuggy/worker-contract/sessionTools";
import { workerPlaneUploadBytesMax } from "@chuggy/worker-contract/workerPlane";
import { z } from "zod";

import {
  chuggyRequestAttemptsMax,
  chuggyRequestRetryMs,
} from "./chuggyApi.mjs";
import {
  chuggyOperationIdentity,
  chuggyToolAnswerBytes,
  chuggyToolAnswerBytesMax,
  chuggyToolAnswerCopiesInEntry,
  chuggyToolAnswerEnvelopeBytesMax,
  chuggyProjectTools,
  chuggyToolContext,
  chuggyToolDefinitions,
  chuggyToolHandler,
  chuggyToolImageFiles,
  chuggyToolServer,
  chuggyTranscriptBodyBytesMax,
  sessionAllowedTools,
  sessionBuiltInTools,
  sessionCapabilityTools,
} from "./chuggyTools.mjs";
import { leadDecisionStaging } from "./leadDecision.mjs";
import { credentialScrub, runTranscriptEventBytesMax } from "./runEvidence.mjs";
import { leadRoster, threadRoster } from "./sessionHarness.fixture.mjs";
import { sessionStoreAdapter } from "./sessionStore.mjs";

const task = {
  tenant: "vteng",
  project: "chuggy",
  api: { url: "https://api.test:8443" },
};
const bearer = "chgs_0123456789abcdef0123456789abcdef";
const everyCapability = Object.keys(sessionCapabilityTools);

function apiOf(answer) {
  const calls = [];
  return {
    calls,
    request: async (_task, _bearer, path, init) => {
      calls.push({ path, method: init?.method ?? "GET", init });
      const given = answer?.(path, init) ?? { status: 200, body: "{}" };
      return {
        status: given.status,
        text: async () => given.body ?? "",
      };
    },
  };
}

function toolsOf(services = {}, answer) {
  const api = apiOf(answer);
  const staging = services.staging ?? leadDecisionStaging();
  const context = chuggyToolContext(task, bearer, {
    capabilities: everyCapability,
    request: api.request,
    turn: () => "turn-1",
    staging,
    ...services,
  });
  const held = new Map(
    chuggyToolDefinitions(context).map((definition) => [
      definition.name,
      chuggyToolHandler(definition, z),
    ]),
  );
  return { api, staging, context, call: (name, args) => held.get(name)(args) };
}

function textOf(answer) {
  return answer.content[0].text;
}

test("a tool the roster does not grant is never registered", () => {
  const registered = (capabilities) =>
    chuggyToolDefinitions(
      chuggyToolContext(task, bearer, {
        capabilities,
        staging: leadDecisionStaging(),
      }),
    ).map(({ name }) => name);

  assert.deepEqual(registered([]), []);
  assert.deepEqual(registered(["RepositoryRead"]), []);
  assert.deepEqual(
    registered(["LeadDecision"]),
    sessionCapabilityTools.LeadDecision,
  );
  assert.deepEqual(
    registered(everyCapability).sort(),
    [...allChuggyTools].sort(),
  );
});

/**
 * Every tool that takes a brief, each with what its `brief` parameter says. The
 * brief is described there rather than in the tool's description, which
 * Claude Code cuts.
 */
function briefTakers() {
  return chuggyToolDefinitions(
    chuggyToolContext(task, bearer, {
      capabilities: everyCapability,
      staging: leadDecisionStaging(),
    }),
  )
    .filter((definition) => "brief" in definition.shape(z))
    .map(({ name, shape }) => ({
      name,
      description: shape(z).brief.description ?? "",
    }));
}

/**
 * `brief` is an open object on the wire, so a session learns what one carries
 * from the parameter's description alone. A tool that takes one and does not
 * name the title is a tool that files untitled tickets.
 */
test("every tool that takes a brief names the title it carries", () => {
  const taking = briefTakers();

  assert.deepEqual(taking.map(({ name }) => name).sort(), [
    "create_draft",
    "file_dependent",
    "revise_draft",
  ]);
  for (const { name, description } of taking) {
    assert.ok(description.includes("`title`"), `${name} names no title`);
    assert.ok(
      description.includes("always give one"),
      `${name} does not ask for one`,
    );
  }
});

/**
 * What bounds an intent, which a model cannot infer from an open object. An
 * intent is bounded as a whole, so a description that gives one a line bound
 * has the model break sentences the door never asked it to break.
 */
test("every tool that takes a brief says an intent is bounded as a whole, and gives it no line bound", () => {
  const taking = briefTakers();

  assert.notEqual(taking.length, 0, "no tool takes a brief");
  for (const { name, description } of taking) {
    const [, intent] = /`intent` is ([^;]*);/u.exec(description) ?? [];
    assert.ok(intent !== undefined, `${name} does not say what an intent is`);
    assert.ok(
      intent.includes("bounded only as a whole"),
      `${name} does not say what bounds an intent`,
    );
    assert.ok(
      intent.includes("no bound on a line of it or on how many lines it has"),
      `${name} does not say an intent's lines are free`,
    );
    assert.equal(
      intent.includes("break"),
      false,
      `${name} tells a session where to break an intent`,
    );
  }
});

/** Which bound each read's page is held to is written here; the bound itself is the contract's. */
const pageBounds = {
  list_tickets: nativeHttpPageItemsMax,
  list_drafts: nativeHttpPageItemsMax,
  list_configurations: nativeHttpPageItemsMax,
  read_decision_log: selectorHistoryLimitMax,
  read_refusals: agenticRefusalsAnsweredMax,
  list_executions: nativeHttpPageItemsMax,
  read_thread: threadTurnsAnsweredMax,
};

test("every read that takes a limit admits its route's bound and no more", () => {
  const limited = chuggyToolDefinitions(
    chuggyToolContext(task, bearer, {
      capabilities: everyCapability,
      staging: leadDecisionStaging(),
    }),
  ).filter((definition) => "limit" in definition.shape(z));

  assert.deepEqual(
    limited.map(({ name }) => name).sort(),
    Object.keys(pageBounds).sort(),
  );
  for (const { name, shape } of limited) {
    const { limit } = shape(z);
    assert.ok(
      limit.safeParse(pageBounds[name]).success,
      `${name} at its bound`,
    );
    assert.ok(
      !limit.safeParse(pageBounds[name] + 1).success,
      `${name} past it`,
    );
  }
});

test("the server the runtime is handed carries exactly the tools the roster admits", () => {
  const seen = [];
  const sdk = {
    z,
    tool: (name, description, shape, handler) => ({
      name,
      description,
      shape,
      handler,
    }),
    createSdkMcpServer: (options) => {
      seen.push(options);
      return options;
    },
  };

  const server = chuggyToolServer(
    chuggyToolContext(task, bearer, {
      capabilities: ["ProjectRead"],
      staging: leadDecisionStaging(),
    }),
    sdk,
  );

  assert.equal(seen.length, 1);
  assert.equal(server.timeout, chuggyToolTimeoutMs);
  assert.deepEqual(
    server.tools.map(({ name }) => name),
    sessionCapabilityTools.ProjectRead,
  );
  for (const { description } of server.tools)
    assert.ok(description.length > 0, "a registered tool describes nothing");
});

/**
 * The decision channel through the server's own registration, which is where a
 * staged answer meets the protocol. The tools' own suite holds each answer's
 * text; this holds the bridge that carries it.
 */
test("a decision tool the server registers answers a well-formed result", async () => {
  const staging = leadDecisionStaging();
  staging.reset(
    JSON.stringify({ candidates: [{ ticket: 4, ticketVersion: 2 }] }),
  );
  const { api, call } = toolsOf({ staging });

  const answer = await call("dispatch", {
    ticket: 4,
    expectedTicketVersion: 2,
  });

  assert.deepEqual(answer.content, [
    { type: "text", text: "dispatch staged for ticket 4" },
  ]);
  assert.ok(answer.isError === undefined);
  assert.equal(api.calls.length, 0, "a decision tool wrote something");
  assert.equal(staging.document().dispatches.length, 1);
});

test("every read answers one page, relays the route's own body and names its cursor", async () => {
  const body = JSON.stringify({ tickets: [], nextAfter: 41 });
  const { api, call } = toolsOf({}, () => ({ status: 200, body }));

  const answer = await call("list_tickets", { after: 40, limit: 25 });

  assert.equal(api.calls.length, 1, "one tool call walked more than one page");
  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy?after=40&limit=25",
  );
  assert.equal(api.calls[0].method, "GET");
  assert.equal(textOf(answer), `HTTP 200\n${body}`);
  assert.ok(answer.isError === undefined);
});

test("a page larger than the pod draws is refused rather than answered cut", async () => {
  assert.ok(
    chuggyToolAnswerBytesMax < chuggyToolResponseBytesMax,
    "a body cut at the draw bound is over the answer bound, which is what refuses it",
  );
  const { call } = toolsOf({}, () => ({
    status: 200,
    body: "x".repeat(70_000),
  }));

  const answer = await call("read_ticket", { ticket: 7 });

  assert.equal(answer.isError, true);
  assert.match(textOf(answer), /larger than the/);
  assert.ok(!textOf(answer).includes("xxx"), "a cut body was answered anyway");
});

/**
 * What the refusal tells the model to do, which is nothing it can do for a tool
 * with no page bound and nothing again for one already asking for a single item.
 * A remedy the caller has already taken is a loop.
 */
test("the refusal names what this caller can lower, and says so where there is nothing", async () => {
  const body = "x".repeat(70_000);
  for (const [name, args, remedy] of [
    [
      "list_executions",
      { limit: 100 },
      /list_executions is already asking for one; move past it with cursor\.$/,
    ],
    [
      "list_tickets",
      { limit: 1 },
      /list_tickets is already asking for one; move past it with after\.$/,
    ],
    [
      "list_tickets",
      { order: "RecentActivity", limit: 1 },
      /list_tickets is already asking for one, so this one cannot be answered\.$/,
    ],
    [
      "read_refusals",
      {},
      /read_refusals is already asking for one, so this one cannot be answered\.$/,
    ],
    [
      "list_tickets",
      { phase: Array.from({ length: 4_096 }, () => "") },
      /list_tickets refused its arguments and asked for nothing\.$/,
    ],
    [
      "read_thread",
      { session: "t-1", limit: 1 },
      /read_thread is already asking for one; move past it with before\.$/,
    ],
    [
      "read_execution",
      { execution: "e-1" },
      /read_execution takes no limit, so this one cannot be answered\.$/,
    ],
  ]) {
    const answer = await routeOf(
      name,
      args,
      apiOf(() => ({ status: 200, body })),
    );

    assert.equal(answer.isError, true, name);
    assert.match(textOf(answer), remedy, name);
  }
});

/**
 * The bound at its own edge, over the relays that answer a route's body. The
 * weight is the escaped one because that is what the entry's line is charged,
 * and a page under the wire bound can be over this one.
 */
test("an answer at the bound is served and one over it never reaches the model", async () => {
  const head = "HTTP 200\n";
  const room = chuggyToolAnswerBytesMax - chuggyToolAnswerBytes(head);
  for (const [name, args] of [
    ["list_executions", { limit: 100 }],
    ["read_thread", { session: "t-1", limit: 32 }],
  ]) {
    const at = await routeOf(
      name,
      args,
      apiOf(() => ({ status: 200, body: "x".repeat(room) })),
    );
    const over = await routeOf(
      name,
      args,
      apiOf(() => ({ status: 200, body: "x".repeat(room + 1) })),
    );

    assert.ok(at.isError === undefined, name);
    assert.equal(
      chuggyToolAnswerBytes(textOf(at)),
      chuggyToolAnswerBytesMax,
      name,
    );
    assert.equal(over.isError, true, name);
    assert.match(textOf(over), /larger than the/, name);
    assert.ok(!textOf(over).includes("xxx"), name);
  }
});

/**
 * The tool #569 was filed on, against a batch of the size the plane refused
 * that session for. The route pages by store batch and a batch is bounded by
 * the store's own line bound, so the answer has to be cut below the page.
 */
test("a thread transcript of one full batch is read whole, page by page, under the bound", async () => {
  const entries = Array.from({ length: 89 }, (_, index) => ({
    uuid: `u-${String(index)}`,
    type: "assistant",
    message: { role: "assistant", content: "x".repeat(700) },
  }));
  const body = JSON.stringify({
    stream: "t-1",
    entries,
    held: ["u-1"],
    elided: 0,
    truncated: false,
  });
  assert.ok(
    chuggyToolAnswerBytes(body) > chuggyToolAnswerBytesMax,
    "the batch under test is smaller than one answer",
  );
  const { api, call } = toolsOf({}, () => ({ status: 200, body }));
  const read = [];
  let cursor = {};

  for (let page = 0; page < 64; page += 1) {
    const answer = await call("read_thread_transcript", {
      session: "t-1",
      ...cursor,
    });

    assert.ok(answer.isError === undefined, `page ${String(page)} was refused`);
    assert.ok(
      chuggyToolAnswerBytes(textOf(answer)) <= chuggyToolAnswerBytesMax,
      `page ${String(page)} is over the bound`,
    );
    const given = JSON.parse(textOf(answer));
    read.push(...given.entries.map(({ uuid }) => uuid));
    if (given.next === undefined) break;
    cursor = given.next;
  }

  assert.deepEqual(
    read,
    entries.map(({ uuid }) => uuid),
    "the transcript was not read whole",
  );
  assert.ok(api.calls.length > 1, "one answer carried a whole batch");
  assert.ok(
    api.calls.every(({ path }) => path.includes("limit=1")),
    "a transcript read asked for more than the batch it cuts from",
  );
});

/**
 * The lead's transcript at the weight its route answered on a live project: a
 * page under the bound as the route sends it and over it as an answer escapes
 * it. It is answered in part, and the read after resumes inside the same batch.
 */
test("a lead transcript page a little over the bound is answered across two reads", async () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({
    uuid: `u-${String(index)}`,
    type: "assistant",
    message: { role: "assistant", content: "x".repeat(936) },
  }));
  const body = JSON.stringify({
    stream: "lead-1",
    entries,
    elided: 0,
    truncated: false,
    nextAfter: 1,
  });
  assert.ok(
    Buffer.byteLength(body) <= chuggyToolAnswerBytesMax &&
      chuggyToolAnswerBytes(body) > chuggyToolAnswerBytesMax,
    "the page under test is not one the bound falls inside",
  );
  const { api, call } = toolsOf({}, () => ({ status: 200, body }));

  const answers = [await call("read_lead_transcript", {})];
  const first = JSON.parse(textOf(answers[0]));
  answers.push(await call("read_lead_transcript", first.next));
  const second = JSON.parse(textOf(answers[1]));

  for (const answer of answers) {
    assert.ok(answer.isError === undefined);
    assert.ok(
      chuggyToolAnswerBytes(textOf(answer)) <= chuggyToolAnswerBytesMax,
    );
  }
  assert.deepEqual(first.next, { after: 0, entry: first.entries.length });
  assert.ok(first.entries.length > 0 && second.entries.length > 0);
  assert.deepEqual([...first.entries, ...second.entries], entries);
  assert.deepEqual(second.next, { after: 1, entry: 0 });
  assert.deepEqual(
    api.calls.map(({ path }) => path),
    [
      "/api/v1/tenants/vteng/projects/chuggy/lead/transcript?limit=1",
      "/api/v1/tenants/vteng/projects/chuggy/lead/transcript?after=0&limit=1",
    ],
  );
});

/** One batch of a run's transcript as its route answers it, a line for each event. */
function runBatchOf(batch, events) {
  const content = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  return {
    batch,
    recordedAt: "2026-10-22T12:00:00.000Z",
    bytes: Buffer.byteLength(content),
    read: "Content",
    content,
  };
}

/** One page of a run's transcript as its route answers it. */
function runPageOf(batches, fields = {}) {
  return JSON.stringify({
    batches,
    observedAt: "2026-10-22T12:00:05.000Z",
    complete: true,
    ...fields,
  });
}

/** One event a run wrote, its text `filler` repeated `count` times. */
function runEventOf(uuid, filler, count) {
  return {
    type: "assistant",
    uuid,
    message: { role: "assistant", content: filler.repeat(count) },
  };
}

/** A run's transcript read the way a caller reads it, page after page: the events given whole, those previewed, and every answer. */
async function runWalked(call, pagesMax) {
  const read = [];
  const previews = [];
  const answers = [];
  let cursor = {};
  for (let page = 0; page < pagesMax; page += 1) {
    const answer = await call("read_run_transcript", {
      execution: "e-1",
      attempt: "a-1",
      ...cursor,
    });
    answers.push(answer);
    assert.ok(answer.isError === undefined, `page ${String(page)} was refused`);
    const given = JSON.parse(textOf(answer));
    for (const entry of given.entries)
      if (entry.preview === undefined) read.push(entry);
      else previews.push(entry);
    if (given.next === undefined) return { read, previews, answers };
    cursor = given.next;
  }
  assert.fail("the walk did not terminate");
}

test("a run transcript page of the most batches, each full, is read whole, page by page, under the bound", async () => {
  const events = [];
  const batches = [];
  for (let batch = 1; batch <= runTranscriptPageBatchesMax; batch += 1) {
    const held = [];
    for (;;) {
      const event = runEventOf(
        `r-${String(batch)}-${String(held.length)}`,
        'say "x" ',
        512,
      );
      if (
        runBatchOf(batch, [...held, event]).bytes > runTranscriptBatchBytesMax
      )
        break;
      held.push(event);
    }
    events.push(...held);
    batches.push(runBatchOf(batch, held));
  }
  const body = runPageOf(batches);
  assert.ok(
    Buffer.byteLength(body) > chuggyTranscriptBodyBytesMax &&
      Buffer.byteLength(body) <= chuggyToolRunTranscriptResponseBytesMax,
    "the page under test is not one only the run's own draw bound admits",
  );
  const { api, call } = toolsOf({}, () => ({ status: 200, body }));

  const { read, previews, answers } = await runWalked(call, 1_024);

  assert.deepEqual(read, events, "the transcript was not read whole");
  assert.deepEqual(previews, []);
  for (const answer of answers)
    assert.ok(
      chuggyToolAnswerBytes(textOf(answer)) <= chuggyToolAnswerBytesMax,
    );
  assert.ok(answers.length > runTranscriptPageBatchesMax);
  assert.ok(
    api.calls.every(({ path }) =>
      /\/executions\/e-1\/attempts\/a-1\/transcript(\?after=0)?$/u.test(path),
    ),
    "a read moved off the page its walk had not finished",
  );
});

test("a run event of the largest size, too heavy for one answer as the transcript escapes it, is previewed and the walk moves past it", async () => {
  const empty = runEventOf("r-2", "", 0);
  const heavy = runEventOf(
    "r-2",
    "\\",
    Math.floor(
      (runTranscriptEventBytesMax - Buffer.byteLength(JSON.stringify(empty))) /
        2,
    ),
  );
  const line = JSON.stringify(heavy);
  assert.ok(Buffer.byteLength(line) <= runTranscriptEventBytesMax);
  assert.ok(chuggyToolAnswerBytes(line) > chuggyToolAnswerBytesMax);
  const light = [runEventOf("r-1", "x", 40), runEventOf("r-3", "x", 40)];
  const body = runPageOf([runBatchOf(1, [light[0], heavy, light[1]])]);
  const { call } = toolsOf({}, () => ({ status: 200, body }));

  const { read, previews } = await runWalked(call, 8);

  assert.deepEqual(read, light);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].uuid, "r-2");
  assert.equal(previews[0].type, "assistant");
  assert.equal(previews[0].bytes, Buffer.byteLength(line));
});

test("a run transcript page at its draw bound is read, and one past it is refused", async () => {
  const page = runPageOf([runBatchOf(1, [runEventOf("r-1", "x", 8)])]);
  const at = `${page}${" ".repeat(
    chuggyToolRunTranscriptResponseBytesMax - Buffer.byteLength(page),
  )}`;
  const args = { execution: "e-1", attempt: "a-1" };

  const read = await routeOf(
    "read_run_transcript",
    args,
    apiOf(() => ({ status: 200, body: at })),
  );
  const over = await routeOf(
    "read_run_transcript",
    args,
    apiOf(() => ({ status: 200, body: `${at} ` })),
  );

  assert.ok(read.isError === undefined);
  assert.equal(JSON.parse(textOf(read)).entries.length, 1);
  assert.equal(over.isError, true);
  assert.match(
    textOf(over),
    new RegExp(
      `larger than the ${String(chuggyToolRunTranscriptResponseBytesMax)} bytes`,
      "u",
    ),
  );
});

/** What `read_run_error` answers when its route answers `content`, read from the route it names. */
async function runErrorRead(content) {
  const api = apiOf(() => ({
    status: 200,
    body: JSON.stringify({ read: "Content", content }),
  }));
  const answer = await routeOf(
    "read_run_error",
    { execution: "e-1", attempt: "a-1" },
    api,
  );
  assert.deepEqual(
    api.calls.map(({ path }) => path),
    ["/api/v1/tenants/vteng/projects/chuggy/executions/e-1/attempts/a-1/error"],
  );
  return answer;
}

test("an attempt's error text is answered whole, with its size", async () => {
  const content =
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";

  const answer = await runErrorRead(content);

  assert.ok(answer.isError === undefined);
  assert.deepEqual(JSON.parse(textOf(answer)), {
    bytes: Buffer.byteLength(content),
    content,
  });
});

test("an error text as large as an upload, every line of it coloured, is answered by the longest end that fits, with the size of the whole", async () => {
  const why = "the line that says why\n";
  const line = "\u001b[31m\u0001rror\u001b[0m: \u001b[2Kstep\n";
  const head = line.repeat(
    Math.floor(
      (workerPlaneUploadBytesMax - Buffer.byteLength(why)) /
        Buffer.byteLength(line),
    ),
  );
  const content = `${head}${"\u001b".repeat(
    workerPlaneUploadBytesMax -
      Buffer.byteLength(head) -
      Buffer.byteLength(why),
  )}${why}`;
  const body = JSON.stringify({ read: "Content", content });
  assert.equal(Buffer.byteLength(content), workerPlaneUploadBytesMax);
  assert.ok(
    Buffer.byteLength(body) > chuggyToolResponseBytesMax &&
      Buffer.byteLength(body) <= chuggyToolRunErrorResponseBytesMax,
    "the text under test is not one only the error text's own draw bound admits",
  );

  const answer = await runErrorRead(content);

  assert.ok(answer.isError === undefined);
  assert.ok(chuggyToolAnswerBytes(textOf(answer)) <= chuggyToolAnswerBytesMax);
  const { bytes, tail, ...rest } = JSON.parse(textOf(answer));
  assert.deepEqual(rest, {});
  assert.equal(bytes, workerPlaneUploadBytesMax);
  assert.ok(content.endsWith(tail) && tail.endsWith(why));
  assert.ok(
    chuggyToolAnswerBytes(
      JSON.stringify({ bytes, tail: content.slice(-tail.length - 1) }),
    ) > chuggyToolAnswerBytesMax,
    "a longer end would have fit",
  );
});

test("an error text's end is the longest that fits, and starts on a whole character, never inside a surrogate pair", async () => {
  for (let pad = 0; pad < 8; pad += 1) {
    const content = `${"\u{1F600}y".repeat(12_000)}${"z".repeat(pad)}`;

    const answer = await runErrorRead(content);

    const { tail } = JSON.parse(textOf(answer));
    assert.ok(content.endsWith(tail), String(pad));
    assert.ok(
      tail.isWellFormed(),
      `the end of pad ${String(pad)} splits a pair`,
    );
    const before = [...content.slice(0, content.length - tail.length)].at(-1);
    assert.ok(
      chuggyToolAnswerBytes(
        JSON.stringify({
          bytes: Buffer.byteLength(content),
          tail: `${before}${tail}`,
        }),
      ) > chuggyToolAnswerBytesMax,
      `a longer end of pad ${String(pad)} would have fit`,
    );
  }
});

test("a plain error text's end is the longest that fits", async () => {
  const content = "a".repeat(100_000);

  const answer = await runErrorRead(content);

  const { bytes, tail } = JSON.parse(textOf(answer));
  assert.ok(content.endsWith(tail));
  assert.ok(
    chuggyToolAnswerBytes(
      JSON.stringify({ bytes, tail: content.slice(-tail.length - 1) }),
    ) > chuggyToolAnswerBytesMax,
    "a longer end would have fit",
  );
});

test("an error text too large to answer whole is answered by an end that leaves some out, even where the whole would fit as an end", async () => {
  const fitsAs = (key, text) =>
    chuggyToolAnswerBytes(
      JSON.stringify({ bytes: Buffer.byteLength(text), [key]: text }),
    ) <= chuggyToolAnswerBytesMax;
  let content = "";
  for (let length = chuggyToolAnswerBytesMax; !content; length -= 1) {
    const text = "a".repeat(length);
    if (!fitsAs("content", text) && fitsAs("tail", text)) content = text;
    assert.ok(length > 0, "no text found to test");
  }

  const answer = await runErrorRead(content);

  const { bytes, tail, ...rest } = JSON.parse(textOf(answer));
  assert.deepEqual(rest, {});
  assert.equal(bytes, content.length);
  assert.equal(tail, content.slice(1));
});

test("an attempt with no error text is answered as having none, and not as a failure", async () => {
  const api = apiOf(() => ({
    status: 404,
    body: JSON.stringify({
      error: { code: "NotFound", message: "Resource not found." },
    }),
  }));

  const answer = await routeOf(
    "read_run_error",
    { execution: "e-1", attempt: "a-1" },
    api,
  );

  assert.ok(answer.isError === undefined);
  assert.match(textOf(answer), /^This attempt has no error text/u);
});

test("an error text the plane cannot answer now, or cannot verify, is relayed as the refusal it is", async () => {
  for (const [status, code] of [
    [409, "RunErrorCorrupt"],
    [503, "RunErrorUnavailable"],
  ]) {
    const body = JSON.stringify({ error: { code, message: code } });

    const answer = await routeOf(
      "read_run_error",
      { execution: "e-1", attempt: "a-1" },
      apiOf(() => ({ status, body })),
    );

    assert.equal(answer.isError, true, code);
    assert.equal(textOf(answer), `HTTP ${String(status)}\n${body}`, code);
  }
});

test("an error text route's body that is not one error text is refused rather than answered", async () => {
  for (const body of [
    "{}",
    "not JSON",
    JSON.stringify({ read: "Content", content: 7 }),
    JSON.stringify({ read: "Missing", content: "x" }),
  ]) {
    const answer = await routeOf(
      "read_run_error",
      { execution: "e-1", attempt: "a-1" },
      apiOf(() => ({ status: 200, body })),
    );

    assert.equal(answer.isError, true, body);
    assert.match(textOf(answer), /not one error text/u, body);
  }
});

test("an error text's answer at its draw bound is read, and one past it is refused", async () => {
  const body = JSON.stringify({ read: "Content", content: "x" });
  const at = `${body}${" ".repeat(
    chuggyToolRunErrorResponseBytesMax - Buffer.byteLength(body),
  )}`;
  const args = { execution: "e-1", attempt: "a-1" };

  const read = await routeOf(
    "read_run_error",
    args,
    apiOf(() => ({ status: 200, body: at })),
  );
  const over = await routeOf(
    "read_run_error",
    args,
    apiOf(() => ({ status: 200, body: `${at} ` })),
  );

  assert.deepEqual(JSON.parse(textOf(read)), { bytes: 1, content: "x" });
  assert.equal(over.isError, true);
  assert.match(
    textOf(over),
    new RegExp(
      `larger than the ${String(chuggyToolRunErrorResponseBytesMax)} bytes`,
      "u",
    ),
  );
});

/** A ticket's landings read over a route answering `body`, and the one path it asked. */
async function landingsRead(body, status = 200) {
  const api = apiOf(() => ({ status, body }));
  const answer = await routeOf("read_ticket_landings", { ticket: 7 }, api);
  assert.deepEqual(
    api.calls.map(({ path }) => path),
    ["/api/v1/tenants/vteng/projects/chuggy/tickets/7/landings"],
  );
  return answer;
}

/**
 * A landing of the cycle given weighing `bytes` as the route answers it, of
 * backslashes, the text an answer's escaping weighs twice: every byte of a JSON
 * text escapes to at most two, and a backslash is one that does.
 */
function landingWeighing(cycle, bytes) {
  const landing = { state: "Held", cycle, held: "", pad: "" };
  const fixed = Buffer.byteLength(JSON.stringify(landing));
  const held = Math.floor((bytes - fixed) / 2);
  const weighed = {
    ...landing,
    held: "\\".repeat(held),
    pad: "a".repeat(bytes - fixed - 2 * held),
  };
  assert.equal(Buffer.byteLength(JSON.stringify(weighed)), bytes);
  return weighed;
}

/** Whether `landings` as one answer would fit, `truncated` as given. */
function landingsFit(landings, truncated) {
  return (
    chuggyToolAnswerBytes(JSON.stringify({ landings, truncated })) <=
    chuggyToolAnswerBytesMax
  );
}

test("a ticket's landings that fit one answer are answered whole, as JSON", async () => {
  for (const truncated of [false, true]) {
    const body = {
      landings: [
        { state: "Failed", cycle: 1 },
        { state: "AwaitingMerge", cycle: 2 },
      ],
      truncated,
    };

    const answer = await landingsRead(JSON.stringify(body));

    assert.ok(answer.isError === undefined);
    assert.deepEqual(JSON.parse(textOf(answer)), body);
  }
  const none = await landingsRead(
    JSON.stringify({ landings: [], truncated: false }),
  );
  assert.deepEqual(JSON.parse(textOf(none)), {
    landings: [],
    truncated: false,
  });
});

test("the heaviest landings the route answers are drawn whole, and the newest that fit are answered", async () => {
  const landings = Array.from({ length: ticketLandingsAnsweredMax }, (_, at) =>
    landingWeighing(at + 1, chuggyToolTicketLandingBytesMax),
  );
  const body = JSON.stringify({ landings, truncated: false });
  assert.ok(
    Buffer.byteLength(body) > chuggyToolResponseBytesMax &&
      Buffer.byteLength(body) <= chuggyToolTicketLandingsResponseBytesMax,
    "the landings under test are not ones only their own draw bound admits",
  );

  const answer = await landingsRead(body);

  assert.ok(answer.isError === undefined, textOf(answer));
  assert.ok(chuggyToolAnswerBytes(textOf(answer)) <= chuggyToolAnswerBytesMax);
  const answered = JSON.parse(textOf(answer));
  assert.equal(answered.truncated, true);
  assert.ok(
    answered.landings.length > 0,
    "the newest landing was not answered",
  );
  assert.deepEqual(
    answered.landings,
    landings.slice(-answered.landings.length),
  );
  assert.ok(
    !landingsFit(landings.slice(-answered.landings.length - 1), true),
    "an older landing would have fit",
  );
});

test("landings left out to fit say so, and the route's own truncation is kept where every one fits", async () => {
  const landings = Array.from({ length: ticketLandingsAnsweredMax }, (_, at) =>
    landingWeighing(at + 1, 4_000),
  );
  const fit = landings.findLastIndex(
    (_, at) => !landingsFit(landings.slice(at), true),
  );
  assert.ok(fit > 0, "every landing under test fits one answer");

  const cut = JSON.parse(
    textOf(await landingsRead(JSON.stringify({ landings, truncated: false }))),
  );
  const whole = JSON.parse(
    textOf(
      await landingsRead(
        JSON.stringify({ landings: landings.slice(fit + 1), truncated: true }),
      ),
    ),
  );

  assert.deepEqual(cut, { landings: landings.slice(fit + 1), truncated: true });
  assert.deepEqual(whole, cut);
});

test("a newest landing too large alone is refused rather than cut", async () => {
  const landing = landingWeighing(1, chuggyToolAnswerBytesMax);

  const answer = await landingsRead(
    JSON.stringify({ landings: [landing], truncated: false }),
  );

  assert.equal(answer.isError, true);
  assert.match(textOf(answer), /newest landing is larger alone/u);
});

test("a ticket the project does not have, and a landings read the plane refuses, are relayed as the refusal they are", async () => {
  for (const [status, code] of [
    [404, "NotFound"],
    [503, "Unavailable"],
  ]) {
    const body = JSON.stringify({ error: { code, message: code } });

    const answer = await landingsRead(body, status);

    assert.equal(answer.isError, true, code);
    assert.equal(textOf(answer), `HTTP ${String(status)}\n${body}`, code);
  }
});

test("a landings route's body that is not a ticket's landings is refused rather than answered", async () => {
  for (const body of [
    "{}",
    "not JSON",
    "null",
    JSON.stringify({ landings: {}, truncated: false }),
    JSON.stringify({ landings: [], truncated: "no" }),
    JSON.stringify({
      landings: Array.from({ length: ticketLandingsAnsweredMax + 1 }, () => ({
        state: "Failed",
      })),
      truncated: false,
    }),
  ]) {
    const answer = await landingsRead(body);

    assert.equal(answer.isError, true, body);
    assert.match(textOf(answer), /not a ticket's landings/u, body);
  }
});

test("a landings answer at its draw bound is read, and one past it is refused", async () => {
  const body = JSON.stringify({ landings: [], truncated: false });
  const at = `${body}${" ".repeat(
    chuggyToolTicketLandingsResponseBytesMax - Buffer.byteLength(body),
  )}`;

  const read = await landingsRead(at);
  const over = await landingsRead(`${at} `);

  assert.deepEqual(JSON.parse(textOf(read)), {
    landings: [],
    truncated: false,
  });
  assert.equal(over.isError, true);
  assert.match(
    textOf(over),
    new RegExp(
      `larger than the ${String(chuggyToolTicketLandingsResponseBytesMax)} bytes`,
      "u",
    ),
  );
});

test("a raise too large to store is refused like any other answer", async () => {
  const huge = "x".repeat(chuggyToolAnswerBytesMax);
  const api = {
    request: async () => {
      throw new Error(huge);
    },
  };

  const answer = await routeOf("read_ticket", { ticket: 7 }, api);

  assert.equal(answer.isError, true);
  assert.ok(!textOf(answer).includes("xxx"), "the raise was answered whole");
  assert.match(textOf(answer), /larger than the/);
});

/**
 * The entry a tool answer becomes, captured off a transcript the pinned runtime
 * wrote rather than composed here. An entry this suite composed would hold the
 * shape this suite believes in, which is what the bound is derived from.
 */
function capturedEntry() {
  return JSON.parse(
    readFileSync(new URL("./toolAnswerEntry.fixture.json", import.meta.url)),
  );
}

test("the captured entry carries one answer as many times as the bound divides by", () => {
  const entry = capturedEntry();
  const inMessage = entry.message.content[0].content[0].text;

  assert.equal(entry.toolUseResult[0].text, inMessage, "the copies differ");
  assert.equal(
    JSON.stringify(entry).split(JSON.stringify(inMessage).slice(1, -1)).length -
      1,
    chuggyToolAnswerCopiesInEntry,
    "the entry carries the answer a different number of times than the bound divides by",
  );
});

test("the reserve is wider than the captured envelope by more than the whole of it", () => {
  const entry = capturedEntry();
  entry.message.content[0].content[0].text = "";
  entry.toolUseResult[0].text = "";

  assert.ok(
    Buffer.byteLength(JSON.stringify(entry)) * 2 <=
      chuggyToolAnswerEnvelopeBytesMax,
    `the captured envelope weighs ${String(Buffer.byteLength(JSON.stringify(entry)))} bytes against a reserve of ${String(chuggyToolAnswerEnvelopeBytesMax)}`,
  );
});

/**
 * The tool's bound held against the store's, through that entry. The answer at
 * the bound goes into both copies, because that is where the runtime puts it.
 */
test("a maximal answer inside the captured entry is one batch the store can post", async () => {
  const posted = [];
  const store = sessionStoreAdapter(
    { workerPlane: { url: "http://worker-plane.test:3001" } },
    "chgs_b",
    {
      request: async (_task, _bearer, _path, init) => {
        posted.push(init.body);
        return { status: 204 };
      },
      scrub: (text) => text,
    },
  );
  const entry = capturedEntry();
  const text = `HTTP 200\n${"x".repeat(
    chuggyToolAnswerBytesMax - chuggyToolAnswerBytes("HTTP 200\n"),
  )}`;
  entry.message.content[0].content[0].text = text;
  entry.toolUseResult[0].text = text;

  await store.append({ sessionId: entry.sessionId }, [entry]);

  assert.equal(chuggyToolAnswerBytes(text), chuggyToolAnswerBytesMax);
  assert.equal(posted.length, 1);
  assert.ok(
    posted[0].length <= sessionStoreBatchBytesMax,
    `the entry posted ${String(posted[0].length)} bytes and one batch holds ${String(sessionStoreBatchBytesMax)}`,
  );
});

/** One tool's own definition behind its handler, with no session's roster between. */
function routeOf(name, args, api) {
  const definition = chuggyProjectTools.find((held) => held.name === name);
  return chuggyToolHandler(
    {
      ...definition,
      call: (called) =>
        definition.call(
          chuggyToolContext(task, bearer, { request: api.request }),
          called,
        ),
    },
    z,
  )(args);
}

test("each read reaches the route its roster names, and only it", async () => {
  const cases = [
    [["read_ticket", { ticket: 7 }], "/tickets/7"],
    [["read_draft", { ticket: 7 }], "/drafts/7"],
    [["list_drafts", { limit: 5 }], "/drafts?limit=5"],
    [["list_configurations", { limit: 5 }], "/configurations?limit=5"],
    [["read_configuration", { revision: "r/1" }], "/configurations/r%2F1"],
    [
      ["read_decision_log", { after: 3, limit: 2 }],
      "/selector-history?after=3&limit=2",
    ],
    [["read_refusals", { limit: 4 }], "/agentic-refusals?limit=4"],
    [["read_ticket_refusals", { ticket: 9 }], "/tickets/9/agentic-refusals"],
    [["read_ticket_landings", { ticket: 9 }], "/tickets/9/landings"],
    [["read_lead", {}], "/lead"],
    [
      ["read_lead_transcript", { after: 2, entry: 3 }],
      "/lead/transcript?after=2&limit=1",
    ],
    [
      ["list_executions", { ticket: 3, state: ["Running"] }],
      "/executions?ticket=3&state=Running",
    ],
    [["read_execution", { execution: "e-1" }], "/executions/e-1"],
    [
      [
        "read_run_transcript",
        { execution: "e-1", attempt: "a-1", after: 2, entry: 3 },
      ],
      "/executions/e-1/attempts/a-1/transcript?after=2",
    ],
    [
      ["read_run_error", { execution: "e-1", attempt: "a-1" }],
      "/executions/e-1/attempts/a-1/error",
    ],
    [["read_operation", { operation: "o-1" }], "/operations/o-1"],
    [["initialize_draft", { revision: "r1" }], "/draft-initializations/r1"],
    [["list_threads", {}], "/threads"],
    [["read_thread", { session: "thread-1/a" }], "/threads/thread-1%2Fa"],
    [
      ["read_thread", { session: "thread-1", before: 7, limit: 32 }],
      "/threads/thread-1?before=7&limit=32",
    ],
    [
      ["read_thread_transcript", { session: "thread-1", after: 2, entry: 3 }],
      "/threads/thread-1/transcript?after=2&limit=1",
    ],
    [["list_repositories", {}], "/repositories"],
    [
      ["fetch_image", { artifact: "image/png:ce47" }],
      "/artifacts/image%2Fpng%3Ace47",
    ],
  ];
  for (const [[name, args], suffix] of cases) {
    const api = apiOf();

    await routeOf(name, args, api);

    assert.equal(
      api.calls[0].path,
      `/api/v1/tenants/vteng/projects/chuggy${suffix}`,
      name,
    );
  }
});

/** A listing of one plain, one retired and one unreached binding, as the route answers it. */
const repositoriesListed = [
  {
    repository: "https://github.com/vteng/chuggy.git",
    boundAt: "2026-10-01T00:00:00.000Z",
    landing: { mode: "PullRequest" },
    pipelinesWritable: false,
    configured: true,
    configurationsHeld: { result: "Imported", count: 2 },
  },
  {
    repository: "https://github.com/vteng/chuggy-common.git",
    boundAt: "2026-10-02T00:00:00.000Z",
    landing: { mode: "Push" },
    pipelinesWritable: false,
    retiredAt: "2026-10-03T00:00:00.000Z",
    configured: false,
  },
  {
    repository: "https://github.com/vteng/chuggy-docs.git",
    boundAt: "2026-10-04T00:00:00.000Z",
    landing: { mode: "PullRequest" },
    pipelinesWritable: true,
    configured: true,
    configurationsHeld: { result: "Bootstrapped", revision: "r0" },
    workerReach: {
      reach: "Unselected",
      installationId: "42",
      settingsUrl: "https://github.com/settings/installations/42",
    },
  },
];

test("the project's repositories are read from its own repositories route, and each row says whether a ticket may be filed in it and is otherwise as answered", async () => {
  const { api, call } = toolsOf({}, () => ({
    status: 200,
    body: JSON.stringify({ repositories: repositoriesListed }),
  }));

  const answer = await call("list_repositories", {});

  assert.deepEqual(
    api.calls.map(({ path, method }) => [method, path]),
    [["GET", "/api/v1/tenants/vteng/projects/chuggy/repositories"]],
  );
  assert.ok(answer.isError === undefined);
  const [status, body] = textOf(answer).split("\n");
  assert.equal(status, "HTTP 200");
  const [plain, retired, unreached] = JSON.parse(body).repositories;
  assert.deepEqual(plain, { ...repositoriesListed[0], fileable: true });
  assert.deepEqual(retired, {
    ...repositoriesListed[1],
    fileable: false,
    fileableReason:
      "Retired at 2026-10-03T00:00:00.000Z, so a draft naming it is refused.",
  });
  assert.deepEqual(unreached, {
    ...repositoriesListed[2],
    fileable: false,
    fileableReason:
      "Not reached by the worker app (workerReach Unselected), so a ticket in it stops at its clone.",
  });
});

test("a binding the forge could not say the worker app reaches is not fileable, and says so", async () => {
  const { call } = toolsOf({}, () => ({
    status: 200,
    body: JSON.stringify({
      repositories: [
        { ...repositoriesListed[0], workerReach: { reach: "Unknown" } },
      ],
    }),
  }));

  const [row] = JSON.parse(
    textOf(await call("list_repositories", {})).split("\n")[1],
  ).repositories;

  assert.equal(row.fileable, false);
  assert.match(
    row.fileableReason,
    /could not say whether the worker app reaches it/,
  );
});

/** A draft's initialization as the route answers it, its configuration's canonical document included. */
const draftInitialized = {
  configuration: {
    partition: "vteng/chuggy",
    revision: "r1",
    canonical: JSON.stringify({ version: 2, prompt: "x".repeat(4_096) }),
    digest: "sha256:ab",
    version: 2,
  },
  fence: { projectSequence: 12, configurationDigest: "sha256:ab" },
  defaults: { program: { 1: { evaluators: [] } }, dependencies: [] },
  choices: { programStagesMax: 4, evaluatorsMax: 8 },
  dependencyCandidates: [3, 5],
  dependencyCandidatesTruncated: false,
  commandedCheckStage: 1,
  commandedCheckStageNote: "stage 1",
};

test("a draft's initialization is answered without its configuration's canonical document, and otherwise as answered", async () => {
  const { call } = toolsOf({}, () => ({
    status: 200,
    body: JSON.stringify(draftInitialized),
  }));

  const answer = await call("initialize_draft", { revision: "r1" });

  assert.ok(answer.isError === undefined);
  const [status, body] = textOf(answer).split("\n");
  assert.equal(status, "HTTP 200");
  const { canonical, ...identified } = draftInitialized.configuration;
  assert.ok(canonical.length > 0);
  assert.deepEqual(JSON.parse(body), {
    ...draftInitialized,
    configuration: identified,
  });
  assert.ok(!body.includes("canonical"), "the canonical document was answered");
});

test("a refused read of either reshaped tool is relayed as the refusal it is", async () => {
  const refusal = JSON.stringify({ error: "NotFound" });
  const { call } = toolsOf({}, () => ({ status: 404, body: refusal }));

  for (const [name, args] of [
    ["list_repositories", {}],
    ["initialize_draft", { revision: "r1" }],
  ]) {
    const answer = await call(name, args);
    assert.equal(answer.isError, true, name);
    assert.equal(textOf(answer), `HTTP 404\n${refusal}`, name);
  }
});

test("a body that is not the listing or the initialization the contract answers is refused rather than answered", async () => {
  for (const body of [
    "not json",
    "null",
    JSON.stringify({ repositories: [7] }),
  ]) {
    const { call } = toolsOf({}, () => ({ status: 200, body }));
    const answer = await call("list_repositories", {});
    assert.equal(answer.isError, true, body);
    assert.match(textOf(answer), /not this project's repositories/, body);
  }
  const { call } = toolsOf({}, () => ({
    status: 200,
    body: JSON.stringify({ configuration: "r1" }),
  }));
  const answer = await call("initialize_draft", { revision: "r1" });
  assert.equal(answer.isError, true);
  assert.match(textOf(answer), /not a draft's initialization/);
});

/** An image's bytes, opening as a PNG does, and the route's answer carrying them. */
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const pngAnswered = {
  content: png.toString("base64"),
  mediaType: "image/png",
  encoding: "base64",
};

/** A temporary directory of the suite's own, removed when the test ends. */
async function temporaryOf(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** The tools with each image they read written under `temporary`, every route answering `answer`. */
function imageToolsOf(temporary, answer) {
  return toolsOf(
    { imageFile: chuggyToolImageFiles({ TMPDIR: temporary }) },
    answer,
  );
}

/** Every file the tools wrote under `temporary`, named from it. */
async function writtenUnder(temporary) {
  const written = [];
  for (const directory of await readdir(temporary))
    for (const file of await readdir(join(temporary, directory)))
      written.push(join(directory, file));
  return written.sort();
}

test("an image is read from its project's artifact route into a new file of this user's alone, and the answer names the file", async (t) => {
  const temporary = await temporaryOf(t);
  const { api, call } = imageToolsOf(temporary, () => ({
    status: 200,
    body: JSON.stringify(pngAnswered),
  }));

  const first = await call("fetch_image", { artifact: "image/png:ce47" });
  const second = await call("fetch_image", { artifact: "image/png:ce47" });

  assert.deepEqual(
    api.calls.map(({ path, method }) => [method, path]),
    Array.from({ length: 2 }, () => [
      "GET",
      "/api/v1/tenants/vteng/projects/chuggy/artifacts/image%2Fpng%3Ace47",
    ]),
  );
  const written = await writtenUnder(temporary);
  assert.equal(written.length, 2, "a read did not write a new file");
  for (const [at, answer] of [first, second].entries()) {
    const file = join(temporary, written[at]);
    assert.ok(answer.isError === undefined, textOf(answer));
    assert.equal(
      textOf(answer),
      `image/png, ${String(png.byteLength)} bytes, written to ${file}. Open that file with Read to see the image.`,
    );
    assert.ok(isAbsolute(file));
    assert.match(written[at], /^chuggy-tool-images-[^/]+\/\d+\.png$/u);
    assert.deepEqual(await readFile(file), png);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(!textOf(answer).includes(pngAnswered.content));
  }
  assert.equal(
    dirname(written[0]),
    dirname(written[1]),
    "one context's reads were written to two directories",
  );
});

test("a refused image read is relayed as its status and body, and writes nothing", async (t) => {
  const temporary = await temporaryOf(t);
  for (const status of [403, 404]) {
    const body = JSON.stringify({ error: { code: "NotFound" } });
    const { api, call } = imageToolsOf(temporary, () => ({ status, body }));

    const answer = await call("fetch_image", { artifact: "image/png:ce47" });

    assert.equal(textOf(answer), `HTTP ${String(status)}\n${body}`);
    assert.equal(answer.isError, true);
    assert.equal(api.calls.length, 1, "a refused read was asked again");
  }
  assert.deepEqual(await readdir(temporary), []);
});

test("an image answer not in the route's shape is an error, and writes nothing", async (t) => {
  const temporary = await temporaryOf(t);
  for (const body of [
    "not json",
    "null",
    JSON.stringify({}),
    JSON.stringify({ ...pngAnswered, content: 7 }),
    JSON.stringify({ ...pngAnswered, mediaType: "image/svg+xml" }),
    JSON.stringify({ ...pngAnswered, encoding: "utf8" }),
    JSON.stringify({ ...pngAnswered, content: "*not base64*" }),
    JSON.stringify({ ...pngAnswered, content: "iVBORw0KGgoBAg" }),
  ]) {
    const { call } = imageToolsOf(temporary, () => ({ status: 200, body }));

    const answer = await call("fetch_image", { artifact: "image/png:ce47" });

    assert.equal(answer.isError, true, body);
    assert.match(textOf(answer), /nothing was written\.$/u, body);
    assert.ok(!textOf(answer).includes(body), body);
  }
  assert.deepEqual(await readdir(temporary), []);
});

/**
 * The bound at its own edge. The image's answer is held to the contract's
 * image bound rather than to an ordinary answer's, and is refused past it
 * rather than decoded from what fit.
 */
test("an image answer at the route's bound is read, and one past it is refused rather than cut", async (t) => {
  const temporary = await temporaryOf(t);
  const body = JSON.stringify(pngAnswered);
  const padded = (bytes) =>
    `${body}${" ".repeat(bytes - Buffer.byteLength(body))}`;
  assert.ok(chuggyToolImageResponseBytesMax > chuggyToolResponseBytesMax);

  const at = await imageToolsOf(temporary, () => ({
    status: 200,
    body: padded(chuggyToolImageResponseBytesMax),
  })).call("fetch_image", { artifact: "image/png:ce47" });
  const over = await imageToolsOf(temporary, () => ({
    status: 200,
    body: padded(chuggyToolImageResponseBytesMax + 1),
  })).call("fetch_image", { artifact: "image/png:ce47" });

  assert.ok(at.isError === undefined, textOf(at));
  assert.equal(over.isError, true);
  assert.match(textOf(over), /larger than the/u);
  assert.equal((await writtenUnder(temporary)).length, 1);
});

/**
 * The capability that admits the read, which is the only thing that keeps it
 * from a roster: a roster without ProjectRead neither registers nor allows it.
 */
test("fetch_image is registered and allowed under ProjectRead, and under nothing else", () => {
  const registered = (capabilities) =>
    chuggyToolDefinitions(
      chuggyToolContext(task, bearer, {
        capabilities,
        staging: leadDecisionStaging(),
      }),
    ).map(({ name }) => name);
  const others = everyCapability.filter((held) => held !== "ProjectRead");
  const qualified = `${chuggyToolPrefix}fetch_image`;

  assert.ok(registered(["ProjectRead"]).includes("fetch_image"));
  assert.ok(
    sessionAllowedTools(["ProjectRead"]).allowedTools.includes(qualified),
  );
  assert.ok(!registered(others).includes("fetch_image"));
  assert.ok(sessionAllowedTools(others).disallowedTools.includes(qualified));
  for (const roster of [leadRoster, threadRoster])
    assert.ok(registered([...roster]).includes("fetch_image"));
});

/** The docs tools, each fetch the docs host is asked recorded and answered by `answer`. */
function docsToolsOf(answer) {
  const fetched = [];
  const tools = toolsOf({
    docsFetch: async (url, init) => {
      fetched.push({ url: String(url), init });
      return answer(String(url));
    },
  });
  return { ...tools, fetched };
}

const docsPage = new URL("guide/tickets.md", chuggyDocsIndex).href;

test("read_docs with no page answers the index the contract names, verbatim", async () => {
  const index = "# chuggy\n\n- [Tickets](https://example.test/x.md)\n";
  const { api, call, fetched } = docsToolsOf(
    () => new globalThis.Response(index),
  );

  const answer = await call("read_docs", {});

  assert.equal(answer.isError, undefined, textOf(answer));
  assert.equal(textOf(answer), index);
  assert.deepEqual(
    fetched.map(({ url }) => url),
    [chuggyDocsIndex],
  );
  assert.equal(api.calls.length, 0, "the docs were asked of chuggy's API");
});

test("read_docs with a page under the index's directory answers that page, verbatim", async () => {
  const markdown = "# Tickets\n\nA ticket is … ✓\n";
  const { call, fetched } = docsToolsOf(
    () => new globalThis.Response(markdown),
  );

  const answer = await call("read_docs", { page: docsPage });

  assert.equal(answer.isError, undefined, textOf(answer));
  assert.equal(textOf(answer), markdown);
  assert.deepEqual(
    fetched.map(({ url }) => url),
    [docsPage],
  );
});

test("read_docs refuses a page outside the index's directory without fetching anything", async () => {
  const directory = new URL(".", chuggyDocsIndex);
  for (const page of [
    "not a url",
    "https://example.test/llms.txt",
    `http://${directory.host}${directory.pathname}guide.md`,
    `https://${directory.host}:8443${directory.pathname}guide.md`,
    new URL("../other/guide.md", directory).href,
    `${directory.href}../other/guide.md`,
    `${directory.href.slice(0, -1)}line/guide.md`,
    `${directory.origin}/kasofsk/chuggy/main/README.md`,
  ]) {
    const { call, fetched } = docsToolsOf(
      () => new globalThis.Response("leaked"),
    );

    const answer = await call("read_docs", { page });

    assert.equal(answer.isError, true, page);
    assert.match(textOf(answer), /nothing was fetched\.$/u, page);
    assert.deepEqual(fetched, [], page);
  }
});

test("read_docs refuses a body past the contract's bound rather than cutting it", async () => {
  const over = "x".repeat(chuggyToolDocsResponseBytesMax + 1);
  for (const response of [
    () => new globalThis.Response(over),
    () =>
      new globalThis.Response(over, {
        headers: { "content-length": String(Buffer.byteLength(over)) },
      }),
  ]) {
    const { call } = docsToolsOf(response);

    const answer = await call("read_docs", { page: docsPage });

    assert.equal(answer.isError, true);
    assert.match(
      textOf(answer),
      new RegExp(
        `larger than the ${String(chuggyToolDocsResponseBytesMax)} bytes`,
        "u",
      ),
    );
    assert.ok(!textOf(answer).includes("xxxx"));
  }
});

test("read_docs answers a status other than a 2xx as a refusal, and not its body", async () => {
  for (const status of [301, 404, 500]) {
    const { call } = docsToolsOf(
      () =>
        new globalThis.Response("the host's own page", {
          status,
          headers: status === 301 ? { location: "https://example.test/" } : {},
        }),
    );

    const answer = await call("read_docs", {});

    assert.equal(answer.isError, true, String(status));
    assert.equal(
      textOf(answer),
      `the docs host answered HTTP ${String(status)} for ${chuggyDocsIndex}.`,
    );
  }
});

test("read_docs sends the docs host no header of chuggy's, follows no redirect, and is bounded in time", async () => {
  const { call, fetched } = docsToolsOf(() => new globalThis.Response("# x"));

  await call("read_docs", {});
  await call("read_docs", { page: docsPage });

  for (const { init } of fetched) {
    assert.deepEqual(Object.keys(init).sort(), ["redirect", "signal"]);
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal instanceof globalThis.AbortSignal);
    assert.ok(!JSON.stringify(init).includes(bearer));
  }
});

/**
 * Every identity a tool puts in a path segment, given one that carries the
 * separator. A segment is model-chosen text bounded only by `identity(z)`, so
 * an unencoded one is a tool that reaches a route its roster does not name:
 * `new URL(path, origin)` resolves `..` before the request is made, which is
 * how `…/threads/../lead/transcript` becomes the lead's route. The assertion is
 * on the RESOLVED pathname rather than on the string this file built, because
 * the string is not what the API is asked for.
 */
test("an identity carrying a separator stays inside the route its tool names", async () => {
  const escaping = "../lead";
  const escaped = "..%2Flead";
  const partition = "/api/v1/tenants/vteng/projects/chuggy";
  const cases = [
    [
      ["read_configuration", { revision: escaping }],
      `/configurations/${escaped}`,
    ],
    [["read_execution", { execution: escaping }], `/executions/${escaped}`],
    [
      ["read_run_transcript", { execution: escaping, attempt: escaping }],
      `/executions/${escaped}/attempts/${escaped}/transcript`,
    ],
    [
      ["read_run_error", { execution: escaping, attempt: escaping }],
      `/executions/${escaped}/attempts/${escaped}/error`,
    ],
    [["read_operation", { operation: escaping }], `/operations/${escaped}`],
    [
      ["initialize_draft", { revision: escaping }],
      `/draft-initializations/${escaped}`,
    ],
    [["read_thread", { session: escaping }], `/threads/${escaped}`],
    [
      ["read_thread_transcript", { session: escaping }],
      `/threads/${escaped}/transcript`,
    ],
    [["fetch_image", { artifact: escaping }], `/artifacts/${escaped}`],
  ];
  for (const [[name, args], suffix] of cases) {
    const api = apiOf();

    await routeOf(name, args, api);

    assert.equal(api.calls.length, 1, name);
    assert.equal(
      new URL(api.calls[0].path, "https://api.test").pathname,
      `${partition}${suffix}`,
      name,
    );
  }
});

test("a thread read past its bound is refused before it asks, and within it asks", async () => {
  for (const [name, args] of [
    ["read_thread", { session: "" }],
    ["read_thread", { session: "t-1", limit: 0 }],
    ["read_thread", { session: "t-1", limit: 33 }],
    ["read_thread", { session: "t-1", before: 0 }],
    ["read_thread_transcript", { session: "t-1", entry: -1 }],
    ["read_thread_transcript", { session: "" }],
  ]) {
    const api = apiOf();

    const answer = await routeOf(name, args, api);

    assert.equal(answer.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.equal(api.calls.length, 0, name);
  }
  const api = apiOf();

  await routeOf("read_thread_transcript", { session: "t-1", entry: 0 }, api);

  assert.equal(api.calls.length, 1, "a transcript at its cursor was refused");
});

test("an argument past its bound is refused before any call is made", async () => {
  const { api, call } = toolsOf();

  for (const [name, args] of [
    ["read_ticket", { ticket: 0 }],
    ["list_tickets", { limit: 101 }],
    ["read_decision_log", { limit: 51 }],
    ["read_refusals", { limit: 33 }],
    ["read_lead_transcript", { after: -1 }],
    ["read_execution", { execution: "" }],
    ["fetch_image", { artifact: "" }],
    ["fetch_image", { artifact: "x".repeat(257) }],
  ]) {
    const answer = await call(name, args);

    assert.equal(answer.isError, true, name);
  }
  assert.equal(api.calls.length, 0, "a refused argument still reached the API");
});

test("a write relays the status and the body the API answered, unaltered", async () => {
  for (const status of [409, 422, 429]) {
    const body = JSON.stringify({ error: "Stale", status });
    const { api, call } = toolsOf({}, () => ({ status, body }));

    const answer = await call("delete_draft", {
      ticket: 4,
      expectedVersion: 2,
    });

    assert.equal(textOf(answer), `HTTP ${String(status)}\n${body}`);
    assert.equal(answer.isError, true);
    assert.equal(api.calls.length, 1, "a refused write was asked again");
    assert.equal(
      api.calls[0].path,
      "/api/v1/tenants/vteng/projects/chuggy/drafts/4?expectedVersion=2",
    );
    assert.equal(api.calls[0].method, "DELETE");
  }
});

test("a write is written in the versioned media type the API requires", async () => {
  const { api, call } = toolsOf();

  await call("revise_draft", {
    ticket: 4,
    expectedVersion: 2,
    configurationRevision: "r1",
    authoring: { dependencies: [] },
    brief: { title: "t" },
  });

  assert.equal(api.calls[0].method, "PUT");
  assert.equal(
    api.calls[0].init.headers["content-type"],
    "application/vnd.chuggy.v1+json",
  );
  assert.deepEqual(JSON.parse(api.calls[0].init.body), {
    expectedVersion: 2,
    configurationRevision: "r1",
    authoring: { dependencies: [] },
    brief: { title: "t" },
  });
});

/** A draft's version starts at one, so a fence at zero is one no draft ever had. */
test("a draft fenced at version zero is refused before any call, and one at version one is asked", async () => {
  const revision = {
    ticket: 4,
    configurationRevision: "r1",
    authoring: { dependencies: [] },
    brief: { title: "t" },
  };
  for (const [name, args] of [
    ["revise_draft", revision],
    ["delete_draft", { ticket: 4 }],
  ]) {
    const refused = toolsOf();
    const asked = toolsOf();

    const answer = await refused.call(name, { ...args, expectedVersion: 0 });
    await asked.call(name, { ...args, expectedVersion: 1 });

    assert.equal(answer.isError, true, name);
    assert.equal(refused.api.calls.length, 0, `${name} asked at version 0`);
    assert.equal(asked.api.calls.length, 1, `${name} refused version 1`);
  }
});

/**
 * The fence is a value the session reads off an answer, so the parameter says
 * which answer and which field: a session that fenced on the ticket's own
 * `version` would be refused at every write.
 */
test("a draft write's expected version says it is the draft's authoringVersion, from one, and what a stale one answers", () => {
  for (const name of ["revise_draft", "delete_draft"]) {
    const tool = chuggyProjectTools.find((held) => held.name === name);
    const described = tool?.shape(z).expectedVersion?.description ?? "";

    for (const said of [
      /draft's `authoringVersion`/,
      /read_draft/,
      /a new draft is at 1/,
      /refused with the draft's `currentVersion`/,
    ])
      assert.match(described, said, name);
  }
});

/**
 * A new draft's fence is the project's journal head, which moves under any
 * command at all, so the parameter says where it is read, that a stale one is
 * answered with the head to send again, and that a project which is not active
 * refuses at every head: a session told only "stale" reads again for ever.
 */
test("a new draft's expected project sequence says it is the project head, and what a stale one and an inactive project answer", () => {
  for (const name of ["create_draft", "file_dependent"]) {
    const tool = chuggyProjectTools.find((held) => held.name === name);
    const described = tool?.shape(z).expectedProjectSequence?.description ?? "";

    for (const said of [
      /`fence\.projectSequence` initialize_draft answered/,
      /every command anywhere in the project moves/,
      /\(DraftInitializationStale\) with the head it is at now as `currentProjectSequence`/,
      /the same write may be sent again with/,
      /\(ProjectNotActive\), naming its `lifecycle`/,
    ])
      assert.match(described, said, name);
  }
});

/**
 * A revision replaces the brief whole, so what read_draft answered and the
 * session leaves out is cleared: the parameter names each field a session
 * would not think to send back.
 */
test("a revision's brief says to send back the repository and the images read_draft answered", () => {
  const tool = chuggyProjectTools.find((held) => held.name === "revise_draft");
  assert.match(
    tool?.shape(z).brief?.description ?? "",
    /send back the `repository` and `images` read_draft answered or the revision clears them/,
  );
});

test("a write names the media type only when it sends a body", async () => {
  const { api, call } = toolsOf();

  await call("revise_draft", {
    ticket: 4,
    expectedVersion: 2,
    configurationRevision: "r1",
    authoring: { dependencies: [] },
    brief: { title: "t" },
  });
  await call("delete_draft", { ticket: 4, expectedVersion: 2 });

  const [withBody, withoutBody] = api.calls;
  assert.equal(withBody.method, "PUT");
  assert.equal(
    withBody.init.headers["content-type"],
    "application/vnd.chuggy.v1+json",
  );
  assert.equal(typeof withBody.init.body, "string");
  assert.equal(withoutBody.method, "DELETE");
  assert.equal("body" in withoutBody.init, false);
  assert.equal(
    "content-type" in withoutBody.init.headers,
    false,
    "a bodyless write names a JSON body it does not send",
  );
});

const dependent = {
  parent: 7,
  relation: "FollowUp",
  configurationRevision: "r1",
  configurationDigest: "d1",
  expectedProjectSequence: 12,
  authoring: { dependencies: [7] },
  brief: { title: "t" },
};

test("a dependent is filed with its parent among the draft's dependencies", async () => {
  const { api, call } = toolsOf();

  await call("file_dependent", dependent);

  assert.equal(api.calls[0].method, "POST");
  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy/drafts",
  );
  assert.deepEqual(JSON.parse(api.calls[0].init.body).authoring, {
    dependencies: [7],
  });
});

test("a prerequisite is refused, and the refusal names the update that would carry it", async () => {
  const { api, call } = toolsOf();

  const answer = await call("file_dependent", {
    ...dependent,
    relation: "Prerequisite",
  });

  assert.equal(answer.isError, true);
  assert.match(
    textOf(answer),
    /file_dependent changes no ticket but the draft it files/,
  );
  assert.match(textOf(answer), /FollowUp/);
  assert.match(textOf(answer), /update_ticket releases/);
  assert.equal(api.calls.length, 0);
});

test("a dependent that does not carry its parent is refused", async () => {
  const { api, call } = toolsOf();

  const answer = await call("file_dependent", {
    ...dependent,
    authoring: { dependencies: [8] },
  });

  assert.equal(answer.isError, true);
  assert.match(textOf(answer), /does not name ticket 7/);
  assert.equal(api.calls.length, 0);
});

test("a relation outside the roster never reaches the refusal that explains one", async () => {
  const { call } = toolsOf();

  const answer = await call("file_dependent", {
    ...dependent,
    relation: "Supersedes",
  });

  assert.equal(answer.isError, true);
});

test("releasing a draft submits one operation and answers its id, not an outcome", async () => {
  const accepted = JSON.stringify({ operation: "o", state: "Accepted" });
  const { api, call } = toolsOf({}, () => ({ status: 202, body: accepted }));

  const answer = await call("release_draft", {
    ticket: 4,
    authoringVersion: 3,
    configurationRevision: "r1",
  });

  const body = JSON.parse(api.calls[0].init.body);
  assert.deepEqual(body.mutation, {
    mutation: "ReleaseDraft",
    ticket: 4,
    authoringVersion: 3,
    configurationRevision: "r1",
  });
  assert.equal(api.calls[0].init.headers["idempotency-key"], body.operation);
  assert.equal(textOf(answer), `HTTP 202\n${accepted}`);
});

test("revoking a ticket submits one operation naming that ticket and nothing else, and answers its id", async () => {
  const accepted = JSON.stringify({ operation: "o", state: "Pending" });
  const { api, call } = toolsOf({}, () => ({ status: 202, body: accepted }));

  const answer = await call("revoke_ticket", { ticket: 26 });

  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].method, "POST");
  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy/operations",
  );
  assert.equal(
    api.calls[0].init.headers["content-type"],
    "application/vnd.chuggy.v1+json",
  );
  const body = JSON.parse(api.calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ["mutation", "operation"]);
  assert.deepEqual(body.mutation, { mutation: "RevokeTicket", ticket: 26 });
  assert.equal(
    body.operation,
    chuggyOperationIdentity("turn-1", body.mutation),
  );
  assert.equal(api.calls[0].init.headers["idempotency-key"], body.operation);
  assert.equal(textOf(answer), `HTTP 202\n${accepted}`);
  assert.ok(answer.isError === undefined);
});

test("updating a ticket submits one operation naming the ticket, the revision read and the draft's, and answers its id", async () => {
  const accepted = JSON.stringify({ operation: "o", state: "Pending" });
  const { api, call } = toolsOf({}, () => ({ status: 202, body: accepted }));

  const answer = await call("update_ticket", {
    ticket: 26,
    expectedRevision: 3,
    authoringVersion: 2,
    configurationRevision: "r1",
  });

  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].method, "POST");
  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy/operations",
  );
  const body = JSON.parse(api.calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ["mutation", "operation"]);
  assert.deepEqual(body.mutation, {
    mutation: "UpdateTicket",
    ticket: 26,
    expectedRevision: 3,
    authoringVersion: 2,
    configurationRevision: "r1",
  });
  assert.equal(
    body.operation,
    chuggyOperationIdentity("turn-1", body.mutation),
  );
  assert.equal(api.calls[0].init.headers["idempotency-key"], body.operation);
  assert.equal(textOf(answer), `HTTP 202\n${accepted}`);
});

/** A dispatch view page holding `candidates`, as the route answers one. */
function dispatchViewPage(candidates) {
  return JSON.stringify({
    result: "Page",
    token: {},
    candidates,
    notificationCursor: 0,
  });
}

test("dispatching a ticket reads its version from the dispatch view and submits it, answering the operation's id", async () => {
  const accepted = JSON.stringify({ operation: "o", state: "Pending" });
  const { api, call } = toolsOf({}, (_path, init) =>
    init?.method === "POST"
      ? { status: 202, body: accepted }
      : {
          status: 200,
          body: dispatchViewPage([{ ticket: 26, ticketVersion: 41 }]),
        },
  );

  const answer = await call("dispatch_ticket", { ticket: 26 });

  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[0].method, "GET");
  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy/dispatch-view?after=25&limit=1",
  );
  assert.equal(api.calls[1].method, "POST");
  assert.equal(
    api.calls[1].path,
    "/api/v1/tenants/vteng/projects/chuggy/operations",
  );
  const body = JSON.parse(api.calls[1].init.body);
  assert.deepEqual(body.mutation, {
    mutation: "ManualDispatch",
    ticket: 26,
    expectedTicketVersion: 41,
  });
  assert.equal(
    body.operation,
    chuggyOperationIdentity("turn-1", body.mutation),
  );
  assert.equal(api.calls[1].init.headers["idempotency-key"], body.operation);
  assert.equal(textOf(answer), `HTTP 202\n${accepted}`);
});

test("the first ticket is read from the start of the dispatch view", async () => {
  const { api, call } = toolsOf({}, () => ({
    status: 200,
    body: dispatchViewPage([]),
  }));

  await call("dispatch_ticket", { ticket: 1 });

  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy/dispatch-view?limit=1",
  );
});

test("a ticket the dispatch view does not hold is answered and nothing is submitted", async () => {
  for (const candidates of [[], [{ ticket: 27, ticketVersion: 41 }]]) {
    const { api, call } = toolsOf({}, () => ({
      status: 200,
      body: dispatchViewPage(candidates),
    }));

    const answer = await call("dispatch_ticket", { ticket: 26 });

    assert.equal(answer.isError, true);
    assert.match(textOf(answer), /ticket 26 cannot be dispatched now/);
    assert.match(textOf(answer), /nothing was submitted/);
    assert.equal(api.calls.length, 1);
  }
});

test("a dispatch view being rebuilt, refused or unreadable submits nothing", async () => {
  for (const [given, said] of [
    [{ status: 200, body: JSON.stringify({ result: "Reset" }) }, /rebuilt/],
    [
      { status: 403, body: JSON.stringify({ error: { code: "Forbidden" } }) },
      /^HTTP 403/,
    ],
    [{ status: 200, body: "{}" }, /not a dispatch view/],
    [
      {
        status: 200,
        body: dispatchViewPage([{ ticket: 26, ticketVersion: "41" }]),
      },
      /not a dispatch view/,
    ],
  ]) {
    const { api, call } = toolsOf({}, () => given);

    const answer = await call("dispatch_ticket", { ticket: 26 });

    assert.equal(answer.isError, true);
    assert.match(textOf(answer), said);
    assert.equal(api.calls.length, 1);
  }
});

test("the dispatch tool says whose word it takes and that it is the owner's own dispatch", () => {
  const { description } = chuggyProjectTools.find(
    ({ name }) => name === "dispatch_ticket",
  );

  for (const said of [
    /on your owner's word only/,
    /your owner's dispatch/,
    /Pending ticket whose dependencies are all Done/,
    /TicketChanged/,
    /read_operation/,
  ])
    assert.match(description, said);
});

test("one call revokes one ticket: a list, a ticket that is no number and no ticket at all reach nothing", async () => {
  const { api, call } = toolsOf();

  for (const args of [
    { ticket: [26, 27] },
    { ticket: 0 },
    { ticket: "26" },
    {},
  ])
    assert.equal((await call("revoke_ticket", args)).isError, true);
  assert.equal(api.calls.length, 0);
});

test("a revocation the machine refuses is relayed unaltered and never asked again", async () => {
  const body = JSON.stringify({ error: { code: "MutationNotAdmitted" } });
  const { api, call } = toolsOf({}, () => ({ status: 409, body }));

  const answer = await call("revoke_ticket", { ticket: 25 });

  assert.equal(textOf(answer), `HTTP 409\n${body}`);
  assert.equal(answer.isError, true);
  assert.equal(api.calls.length, 1);
});

/**
 * A session learns what revoking does from the description alone, and the two
 * things it cannot learn anywhere else are that a revocation is final and that
 * it settles one ticket: the dependents of a revoked ticket wait until an
 * update drops it or they are revoked too.
 */
test("the revocation tool says it is final, whose word it takes and what is left behind it", () => {
  const { description } = chuggyProjectTools.find(
    ({ name }) => name === "revoke_ticket",
  );

  for (const said of [
    /on your owner's word only/,
    /ends the ticket for good/,
    /undoes nothing that already landed/,
    /revokes no other ticket/,
    /`revokedDependencies`/,
    /an update that drops them \(revise_draft, then update_ticket\) lets it start/,
    /otherwise it can only be revoked too/,
    /read_operation/,
  ])
    assert.match(description, said);
});

/**
 * A ticket runs on the agent of the configuration it is released against, and
 * the listing answers no agent, so the read is where a session finds one and
 * its description is what says where.
 */
test("the configuration read says where the agent that does the work is named", () => {
  const described = (tool) =>
    chuggyProjectTools.find(({ name }) => name === tool).description;

  assert.match(described("read_configuration"), /`worker\.mode`/);
  assert.match(described("read_configuration"), /the agent/);
  assert.match(described("read_configuration"), /a model/);
  assert.match(described("list_configurations"), /read_configuration/);
});

/**
 * What the server does with a brief that no answer shows until it is too late
 * to act on: that its checks need a commanded Check stage, where the
 * initialization says which one, and a program running it, where a brief
 * naming no landing takes one and that the write says whose it took, and that
 * a proposal's branch is never the default one. Every tool that takes a brief
 * says it on its `brief` parameter.
 */
const briefClaims = [
  /\{title\?, intent, links, images\?, checks\?/,
  /`images` are this project's images the work is handed, each by the identity fetch_image takes/,
  new RegExp(
    `each one line of 1 to ${String(briefLineCharsMax)} characters with no tab, line break or other control character in it`,
    "u",
  ),
  /`commandedCheckStage`, its program stage key, counted from one/,
  /`commandedCheckStageNote` \(the same stage and, for a catalog, its plan, or that none does and which plans would\)/,
  /whose program leaves out that stage, or for a catalog the evaluator in it that runs commands, is refused when it is released whoever releases it \(ProgramSkipsBriefChecks\)/,
  /where it answers none a draft carrying checks is refused/,
  /\(BriefChecksUncommanded\)/,
  /the commit the change started from in CHUG_CHANGE_BASE, unset where that is unknown/,
  /runs under sh -eu with the commit/,
  /reads it as \$\{CHUG_CHANGE_BASE-\} and runs everything where that is empty/,
  /a brief naming none takes, on a version 2 catalog, the landing of the finalizer its selection lands with where that finalizer names one, and otherwise its repository's landing default/,
  /for a newly bound repository is a pull request/,
  /`landing`, the mode and target it stored, and its `source`: Brief, Finalizer, Repository, or Default for a brief naming no repository/,
  /never the default branch/,
  /\(ProposalBaseIsHead\)/,
  /A 400 names the rule the brief broke, and for a check its position in `checks`, counted from zero/,
];

test("every tool that takes a brief says on its parameter what the server does with one", () => {
  const taking = briefTakers();

  assert.notEqual(taking.length, 0, "no tool takes a brief");
  for (const { name, description } of taking)
    for (const claim of briefClaims) assert.match(description, claim, name);
});

/** What a release or an update of a draft running less than its plan is answered, and what lets it through. */
const programShortClaims = [
  /runs less than its configuration plans/,
  /an evaluator of a stage it keeps/,
  /skip_planned_evaluations permit, which its administrators hold/,
  /403 ProgramSkipsPlannedEvaluations and nothing is submitted/,
  /`defaults\.program`/,
];

/**
 * What the server does that no answer shows until it is too late to act on:
 * that the refusal ledgers hold none of a command's refusals, that a
 * submission repeated in one turn answers the settled operation, that a
 * project has no lead before a release, who may release a program running
 * less than its plan, that stages run in order and a stage's evaluators side
 * by side, which stage a brief's checks join, what a ticket's run totals sum,
 * and what a binding says of its repository. Each is said in the description
 * of the tool the session reads it from.
 */
test("the descriptions say what the server does where a session reads it", () => {
  const described = (tool) =>
    chuggyProjectTools.find(({ name }) => name === tool).description;
  const ledger = [
    /refusals to dispatch a released ticket/,
    /and nothing else/,
    /read_operation/,
  ];
  const said = {
    read_refusals: ledger,
    read_ticket_refusals: ledger,
    release_draft: [
      /same turn is the same operation/,
      /other than Pending/,
      /revise_draft/,
      ...programShortClaims,
    ],
    update_ticket: programShortClaims,
    revoke_ticket: [/same turn is the same operation/, /other than Pending/],
    read_lead: [
      /None, and `absence\.reason` says why/,
      /`Paused`: [^.]*, so no ticket is picked up automatically; it must be resumed by someone who may, and this reason is answered ahead of the others\./,
      /`NotNeeded`: no refusal stands/,
      /before anything is released/,
      /release a ticket/,
      /`absence\.since` is when that refusal began/,
      /`RunnerOffline`: [^.]*, so the project's runner must be running\./,
      /`HostedRunsNotGranted`: [^.]*, so an admin must grant them\./,
    ],
    initialize_draft: [
      /run in that order/,
      /a failed stage ends evaluation/,
      /`choices\.programStagesMax`/,
      /`commandedCheckStage` is the stage a brief's `checks` join, by its program stage key, counted from one as `defaults\.program` keys are/,
      /`commandedCheckStageNote` says it in words/,
      /`configuration` is answered without its `canonical`; read_configuration answers the document/,
    ],
    read_ticket: [
      /`escalation\.failed`, which read_run_error takes to read the attempt's error text/,
      /`runTotals`, what every run of its executions reported, summed/,
      /`costUsdMicros`, millionths of a dollar at the runtime's list price/,
      /per model in `models`/,
      /A ticket no run has reported for carries none/,
    ],
    read_configuration: [
      /evaluation stages run in the order listed and a failed stage ends evaluation/,
      /the evaluators of one stage run in parallel/,
      /each evaluator of a plan stage names its own workload/,
      /review lenses that should run side by side belong in one stage/,
    ],
    list_repositories: [
      /oldest first/,
      /`repository` is its clone URL/,
      /`landing` is its landing default/,
      /`configured` says whether the project holds configurations for it/,
      /Bootstrapped, the project's bootstrap `revision`/,
      /A retired binding carries `retiredAt`, and a draft write naming it is refused/,
      /`pipelinesWritable` says whether its jobs may write its pipeline definitions, and `workerReach`, present only where the worker app cannot be said to reach it, says why/,
      /A ticket may be filed in any binding not retired, and one holding no configurations releases its tickets under the project's bootstrap\. Each row's `fileable` says whether to file a ticket there: false, with `fileableReason` saying why, where it is retired or carries `workerReach`/,
    ],
    fetch_image: [
      /by the identity a message's images section or a brief names it by/,
      /written to a new file/,
      /that file's path, its media type and its size in bytes/,
      /open the file with Read/,
    ],
  };

  for (const [tool, claims] of Object.entries(said))
    for (const claim of claims) assert.match(described(tool), claim, tool);
});

/** The phase filter takes exact phase names, so the description names them. */
test("list_tickets says which values its phase filter takes", () => {
  const { description } = chuggyProjectTools.find(
    ({ name }) => name === "list_tickets",
  );
  for (const said of [
    /`phase` takes one or more of Pending, Work, Evaluation, Finalization, Done, Escalated and Revoked, matched exactly/,
    /or `NonTerminal` alone/,
    /left out, it lists every phase/,
  ])
    assert.match(description, said);
});

test("list_tickets lists by recent activity on the server's own cursor, and by number unchanged without it", async () => {
  const { api, call } = toolsOf({}, () => ({ status: 200, body: "{}" }));

  await call("list_tickets", {
    order: "RecentActivity",
    cursor: "eyJ0aWNrZXQiOjd9",
    limit: 25,
  });
  await call("list_tickets", { after: 40, limit: 25, phase: ["Done"] });

  assert.deepEqual(
    api.calls.map(({ path }) => path),
    [
      "/api/v1/tenants/vteng/projects/chuggy?limit=25&order=RecentActivity&cursor=eyJ0aWNrZXQiOjd9",
      "/api/v1/tenants/vteng/projects/chuggy?after=40&limit=25&phase=Done",
    ],
  );
  const { description } = chuggyProjectTools.find(
    ({ name }) => name === "list_tickets",
  );
  for (const said of [
    /`order: "RecentActivity"` lists them newest activity first/,
    /answering `nextCursor` for the next page, which `cursor` resumes from/,
    /A page may hold fewer than `limit`, and only `nextAfter`, or `nextCursor`, present says there are more/,
  ])
    assert.match(description, said);
});

/** A first ticket is filed from these descriptions alone, so they open with what one needs. */
test("the draft writes open their brief with the minimum brief and say what authoring is", () => {
  for (const name of ["create_draft", "revise_draft"]) {
    const shape = chuggyProjectTools
      .find((held) => held.name === name)
      .shape(z);
    assert.ok(
      shape.brief.description.startsWith(
        'The minimum brief is {title, intent, links: [], repository: <clone URL from list_repositories>, branch: "refs/heads/<a new branch of your own>"}.\n`brief` is {title?',
      ),
      name,
    );
    assert.match(
      shape.authoring.description ?? "",
      /^`authoring` is \{program, dependencies\}: pass initialize_draft's `defaults` unchanged unless you mean otherwise, and `dependencies` are ticket numbers from its `dependencyCandidates`\.$/,
      name,
    );
  }
});

test("release_draft says releasing starts no work, and who starts it", () => {
  const { description } = chuggyProjectTools.find(
    ({ name }) => name === "release_draft",
  );
  assert.match(
    description,
    /Releasing makes the ticket Pending and starts no work: the project's lead dispatches it when its dependencies are Done, or a person who may dispatch does\./,
  );
});

test("a ticket's landings are described as the route answers them, and read_ticket points at them", () => {
  const described = (tool) =>
    chuggyProjectTools.find(({ name }) => name === tool).description;
  const claims = [
    /the newest one answer holds, oldest first, and `truncated` where the ticket has older ones this answer leaves out/,
    /Each landing carries its `state`/,
    /A Held landing carries `hold`: its `kind`, [^.]*, and `since`, when a hold of that kind began/,
    /An AwaitingMerge landing carries `wait`: its `reason`, [^.]*, and `checkedAt`, when the forge was last heard about its merge/,
    /`proposal` is the pull request [^.]*: its `url`, [^.]*its `mergeability`, and `mergeState`, the forge's own word for that, GitHub's `mergeable_state`/,
    /`conflict` is the paths its newest attempt conflicted on, `truncated` where they were cut/,
  ];
  for (const claim of claims)
    assert.match(described("read_ticket_landings"), claim);
  assert.match(
    described("read_ticket"),
    /Where its work is landing or waits to land, read_ticket_landings says how/,
  );
});

/**
 * A revised draft changes nothing its Pending ticket runs until update_ticket
 * releases it, so revise_draft says so, and update_ticket says whose word it
 * takes, what it is fenced on and the refusals that fence answers.
 */
test("updating a ticket says whose word it takes and what refuses it, and a revision that it waits for one", () => {
  const described = (tool) =>
    chuggyProjectTools.find(({ name }) => name === tool).description;

  for (const claim of [
    /on your owner's word only/,
    /`expectedRevision` is the ticket's `revision` as read_ticket answers it/,
    /\(TicketNotPending\)/,
    /\(TicketRevisionStale\)/,
    /dropping one is never refused/,
    /\(DependenciesRevoked\)/,
    /\(DependencyCycle\)/,
    /same turn is the same operation/,
  ])
    assert.match(described("update_ticket"), claim);
  assert.match(
    described("revise_draft"),
    /A Pending ticket's draft takes a revision too, which its ticket runs only once update_ticket releases it/,
  );
});

/**
 * What a session reading a run is told: that what the run wrote is as
 * untrusted as the run, how its transcript is read on while it is still
 * writing, and that an attempt with no error text has none rather than failing
 * to be read.
 */
test("the run reads say the run's text is untrusted and how each is read", () => {
  const described = (tool) =>
    chuggyProjectTools.find(({ name }) => name === tool).description;
  const said = {
    read_run_transcript: [
      /as untrusted as anything a run wrote/,
      /`elided`, how many of the batches this page was cut from could not be read, so pages cut from the same batches repeat the count/,
      /`complete`, whether the run has ended/,
      /pass its `after` and `entry` back/,
      /the same read again answers what it wrote since/,
    ],
    read_run_error: [
      /as untrusted as anything a run wrote/,
      /\{bytes, content\}, or \{bytes, tail\} with the text's end/,
      /An attempt with none answers that it has none/,
      /`escalation\.failed`/,
      /`error\.bytes`/,
    ],
  };

  for (const [tool, claims] of Object.entries(said))
    for (const claim of claims) assert.match(described(tool), claim, tool);
});

test("two releases in one turn are two operations, and one repeated is one", async () => {
  const { api, call } = toolsOf({}, () => ({ status: 202, body: "{}" }));
  const release = (ticket) =>
    call("release_draft", {
      ticket,
      authoringVersion: 3,
      configurationRevision: "r1",
    });

  await release(4);
  await release(9);
  await release(4);

  const ids = api.calls.map(({ init }) => JSON.parse(init.body).operation);
  const keys = api.calls.map(({ init }) => init.headers["idempotency-key"]);
  assert.notEqual(
    ids[0],
    ids[1],
    "two releases of different drafts in one turn collide on one operation, and the second is an idempotency conflict naming nothing the lead can act on",
  );
  assert.equal(ids[0], ids[2], "one call repeated minted a second operation");
  assert.deepEqual(keys, ids, "the key and the operation are not the same");
});

test("a command's identity is a value the caller cannot have guessed", () => {
  const mutation = {
    mutation: "ReleaseDraft",
    ticket: 4,
    authoringVersion: 3,
    configurationRevision: "r1",
  };

  assert.notEqual(
    chuggyOperationIdentity("turn-1", mutation),
    chuggyOperationIdentity("turn-1", { ...mutation, ticket: 9 }),
  );
  assert.notEqual(
    chuggyOperationIdentity("turn-1", mutation),
    chuggyOperationIdentity("turn-1", { ...mutation, authoringVersion: 4 }),
  );
  assert.notEqual(
    chuggyOperationIdentity("turn-1", mutation),
    chuggyOperationIdentity("turn-2", mutation),
  );
});

test("the same release repeated in one turn is the same operation, and a new turn is a new one", async () => {
  let turn = "turn-1";
  const { api, call } = toolsOf({ turn: () => turn }, () => ({
    status: 202,
    body: "{}",
  }));
  const args = { ticket: 4, authoringVersion: 3, configurationRevision: "r1" };

  await call("release_draft", args);
  await call("release_draft", args);
  turn = "turn-2";
  await call("release_draft", args);

  const ids = api.calls.map(({ init }) => JSON.parse(init.body).operation);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[1], ids[2]);
});

test("a command submitted with no turn claimed is refused rather than minted", async () => {
  const { api, call } = toolsOf({ turn: () => undefined });

  const answer = await call("release_draft", {
    ticket: 4,
    authoringVersion: 3,
    configurationRevision: "r1",
  });

  assert.equal(answer.isError, true);
  assert.match(textOf(answer), /no turn is claimed/);
  assert.equal(api.calls.length, 0);
});

const origination = {
  configurationRevision: "r1",
  configurationDigest: "d1",
  expectedProjectSequence: 12,
  authoring: { dependencies: [] },
  brief: { title: "what the member asked for" },
};

test("an originated draft is filed at the drafts route, fenced and derived from nothing", async () => {
  const filed = JSON.stringify({ ticket: 14, version: 1 });
  const { api, call } = toolsOf({}, () => ({ status: 201, body: filed }));

  const answer = await call("create_draft", origination);

  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].method, "POST");
  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy/drafts",
  );
  assert.equal(
    api.calls[0].init.headers["content-type"],
    "application/vnd.chuggy.v1+json",
  );
  assert.deepEqual(JSON.parse(api.calls[0].init.body), origination);
  assert.equal(textOf(answer), `HTTP 201\n${filed}`);
  assert.ok(answer.isError === undefined);
});

test("an origination the API refuses is relayed unaltered and never asked again", async () => {
  const body = JSON.stringify({ error: "StaleProjectSequence" });
  const { api, call } = toolsOf({}, () => ({ status: 409, body }));

  const answer = await call("create_draft", origination);

  assert.equal(textOf(answer), `HTTP 409\n${body}`);
  assert.equal(answer.isError, true);
  assert.equal(api.calls.length, 1);
});

test("an origination without the fence the route requires never reaches it", async () => {
  const { api, call } = toolsOf();

  for (const missing of [
    "configurationRevision",
    "configurationDigest",
    "expectedProjectSequence",
    "authoring",
    "brief",
  ]) {
    const answer = await call(
      "create_draft",
      Object.fromEntries(
        Object.entries(origination).filter(([field]) => field !== missing),
      ),
    );

    assert.equal(answer.isError, true, missing);
  }
  assert.equal(api.calls.length, 0);
});

/** A catalog selection, which a draft on a catalog carries to the route as it was given. */
const selection = { work: "build-sonnet", evaluation: "standard" };

/**
 * Catches a secret the model read in its shell sent onward by a project tool:
 * in a body, a path, a query or a key the shape lets through, or the
 * operation minted from what was asked rather than from what was sent, so two
 * calls the API sees as one would be two operations.
 */
test("what a project tool sends is scrubbed of the session's secrets, and its operation minted from what is sent", async () => {
  const held = "AKIAIOSFODNN7EXAMPLE-wJalrXUtnFEMI";
  const scrub = credentialScrub([held]);
  const { api, call, context } = toolsOf({ scrub });
  const redacted = scrub(held);

  await call("release_draft", {
    ticket: 4,
    authoringVersion: 3,
    configurationRevision: `r-${held}`,
  });
  await call("release_draft", {
    ticket: 4,
    authoringVersion: 3,
    configurationRevision: `r-${redacted}`,
  });
  await call("read_configuration", { revision: held });
  await call("list_tickets", { phase: [held] });
  await chuggyToolDefinitions(context)
    .find(({ name }) => name === "create_draft")
    .call({ ...origination, brief: { title: "t", [held]: held } });

  assert.equal(api.calls.length, 5);
  for (const { path, init } of api.calls) {
    assert.ok(!path.includes(held), path);
    assert.ok(!String(init?.body ?? "").includes(held), path);
  }
  const [sent, again] = api.calls.map(({ init }) =>
    JSON.parse(init?.body ?? "{}"),
  );
  assert.equal(
    sent.mutation.configurationRevision,
    `r-${redacted}`,
    "the release sent was not the scrubbed one",
  );
  assert.equal(sent.operation, again.operation);
  assert.ok(
    api.calls[2].path.endsWith(
      `/configurations/${encodeURIComponent(redacted)}`,
    ),
  );
  assert.deepEqual(
    new URL(api.calls[3].path, "https://api.test").searchParams.getAll("phase"),
    [redacted],
  );
  assert.deepEqual(JSON.parse(api.calls[4].init.body).brief, {
    title: "t",
    [redacted]: redacted,
  });
});

test("a draft filed or revised with a selection carries it to the route, and one without carries none", async () => {
  const { api, call } = toolsOf();
  const revision = {
    ticket: 4,
    expectedVersion: 2,
    configurationRevision: "r1",
    authoring: { dependencies: [] },
    brief: { title: "t" },
  };

  for (const [tool, args] of [
    ["create_draft", origination],
    ["file_dependent", dependent],
    ["revise_draft", revision],
  ]) {
    await call(tool, { ...args, selection });
    await call(tool, args);
  }

  assert.equal(api.calls.length, 6);
  for (const [index, held] of api.calls.entries()) {
    const body = JSON.parse(held.init.body);
    if (index % 2 === 0) assert.deepEqual(body.selection, selection, held.path);
    else assert.equal("selection" in body, false, held.path);
  }
});

test("a draft's defaults are initialized under the selection it will carry", async () => {
  const { api, call } = toolsOf();

  await call("initialize_draft", { revision: "r1", ...selection });

  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy/draft-initializations/r1?work=build-sonnet&evaluation=standard",
  );
});

/** The selection is explained on its own parameter, which no tool description's cut reaches. */
test("each draft tool's selection parameter says what a selection is", () => {
  for (const name of ["create_draft", "file_dependent", "revise_draft"]) {
    const tool = chuggyProjectTools.find((held) => held.name === name);
    assert.match(tool?.shape(z).selection?.description ?? "", /catalog/u, name);
  }
});

/** What every project tool is driven with where a suite drives them all. */
const projectToolArguments = {
  list_tickets: {},
  read_ticket: { ticket: 7 },
  read_draft: { ticket: 7 },
  list_drafts: {},
  list_configurations: {},
  read_configuration: { revision: "r1" },
  read_decision_log: {},
  read_refusals: {},
  read_ticket_refusals: { ticket: 7 },
  read_ticket_landings: { ticket: 7 },
  read_lead: {},
  read_lead_transcript: {},
  list_executions: {},
  read_execution: { execution: "e-1" },
  read_run_transcript: { execution: "e-1", attempt: "a-1" },
  read_run_error: { execution: "e-1", attempt: "a-1" },
  read_operation: { operation: "o-1" },
  list_threads: {},
  read_thread: { session: "t-1" },
  read_thread_transcript: { session: "t-1" },
  list_repositories: {},
  fetch_image: { artifact: "image/png:ce47" },
  read_docs: {},
  initialize_draft: { revision: "r1" },
  file_dependent: dependent,
  revise_draft: {
    ticket: 4,
    expectedVersion: 2,
    configurationRevision: "r1",
    authoring: { dependencies: [] },
    brief: { title: "t" },
  },
  delete_draft: { ticket: 4, expectedVersion: 2 },
  release_draft: {
    ticket: 4,
    authoringVersion: 2,
    configurationRevision: "r1",
  },
  create_draft: origination,
  revoke_ticket: { ticket: 26 },
  dispatch_ticket: { ticket: 26 },
  update_ticket: {
    ticket: 26,
    expectedRevision: 3,
    authoringVersion: 2,
    configurationRevision: "r1",
  },
};

/**
 * Catches a tool built on a route outside its session's own project, which the
 * API refuses a session bearer however the membership reads: an inventory of
 * every project the principal sees is one.
 */
test("every project tool reaches its own session's project and nothing outside it", async () => {
  const partition = "/api/v1/tenants/vteng/projects/chuggy";
  assert.deepEqual(
    chuggyProjectTools.map(({ name }) => name).sort(),
    Object.keys(projectToolArguments).sort(),
  );
  for (const definition of chuggyProjectTools) {
    const api = apiOf();

    await definition.call(
      chuggyToolContext(task, bearer, {
        request: api.request,
        docsFetch: async () => new globalThis.Response("# docs"),
        turn: () => "turn-1",
      }),
      projectToolArguments[definition.name],
    );

    if (definition.name === "read_docs") {
      assert.equal(api.calls.length, 0, "read_docs asked chuggy's API");
      continue;
    }
    assert.equal(api.calls.length, 1, definition.name);
    const { pathname } = new URL(api.calls[0].path, task.api.url);
    assert.ok(
      pathname === partition || pathname.startsWith(`${partition}/`),
      `${definition.name} reached ${pathname}`,
    );
  }
});

test("origination, revocation, updating and dispatching are registered for a thread's roster and for no lead's", () => {
  const registered = (capabilities) =>
    chuggyToolDefinitions(
      chuggyToolContext(task, bearer, {
        capabilities,
        staging: leadDecisionStaging(),
      }),
    ).map(({ name }) => name);

  assert.deepEqual(registered(["DraftOriginate"]), [
    "create_draft",
    "revoke_ticket",
    "update_ticket",
  ]);
  assert.deepEqual(registered(["TicketDispatch"]), ["dispatch_ticket"]);
  for (const tool of [
    "create_draft",
    "revoke_ticket",
    "update_ticket",
    "dispatch_ticket",
  ]) {
    assert.ok(registered([...threadRoster]).includes(tool), tool);
    assert.ok(
      !registered([...leadRoster]).includes(tool),
      `a lead's roster registered ${tool}`,
    );
  }
});

/**
 * Every project tool through the handler a session is given, which is where a
 * tool that answered without asking stood: a suite that drives the definition
 * passes whatever is between it and the session.
 */
test("every project tool a session holds asks its route, read_docs the docs host, and answers what it was answered", async (t) => {
  const temporary = await temporaryOf(t);
  for (const { name } of chuggyProjectTools) {
    const docs = [];
    const { api, call } = toolsOf(
      {
        imageFile: chuggyToolImageFiles({ TMPDIR: temporary }),
        docsFetch: async (url) => {
          docs.push(String(url));
          return new globalThis.Response("# docs");
        },
      },
      (path) => ({
        status: 200,
        body: path.includes("/artifacts/")
          ? JSON.stringify(pngAnswered)
          : path.endsWith("/error")
            ? JSON.stringify({ read: "Content", content: "x" })
            : path.endsWith("/landings")
              ? JSON.stringify({ landings: [], truncated: false })
              : path.includes("/dispatch-view")
                ? dispatchViewPage([{ ticket: 26, ticketVersion: 41 }])
                : path.endsWith("/repositories")
                  ? JSON.stringify({ repositories: [] })
                  : path.includes("/draft-initializations/")
                    ? JSON.stringify(draftInitialized)
                    : "{}",
      }),
    );

    const answer = await call(name, projectToolArguments[name]);

    const asked = { dispatch_ticket: 2, read_docs: 0 }[name] ?? 1;
    assert.equal(api.calls.length, asked, name);
    assert.equal(docs.length, name === "read_docs" ? 1 : 0, name);
    assert.ok(answer.isError === undefined, name);
  }
});

/** The `limit` one request asked with, or nothing where it asked with none. */
function limitAsked({ path }) {
  const asked = new URL(path, task.api.url).searchParams.get("limit");
  return asked === null ? undefined : Number(asked);
}

/**
 * The executions read at the weight an item ran on a live project, where a
 * page of fifty was refused and the model was left to guess a limit. The
 * route answers as many items as it is asked for and the cursor past them.
 */
test("a page too large is asked for again at half its limit until one fits, and that page is answered", async () => {
  const { api, call } = toolsOf({}, (path) => {
    const items = Array.from({ length: limitAsked({ path }) }, (_, at) => ({
      at,
      held: "x".repeat(1_400),
    }));
    return {
      status: 200,
      body: JSON.stringify({ items, nextCursor: `c-${String(items.length)}` }),
    };
  });

  const answer = await call("list_executions", {
    ticket: 3,
    state: ["Running"],
    cursor: "c-0",
    limit: 50,
  });

  const asked =
    "/api/v1/tenants/vteng/projects/chuggy/executions?ticket=3&state=Running&cursor=c-0&limit=";
  assert.deepEqual(
    api.calls.map(({ path }) => path),
    [`${asked}50`, `${asked}25`, `${asked}12`],
  );
  assert.ok(answer.isError === undefined);
  const page = JSON.parse(textOf(answer).slice("HTTP 200\n".length));
  assert.equal(page.items.length, 12);
  assert.equal(page.nextCursor, "c-12");
});

test("a call that gave no limit asks again from half the largest its shape admits", async () => {
  for (const [name, max] of Object.entries(pageBounds)) {
    const { api, call } = toolsOf({}, (path) => ({
      status: 200,
      body:
        limitAsked({ path }) === undefined
          ? "x".repeat(chuggyToolAnswerBytesMax)
          : "{}",
    }));

    const answer = await call(name, projectToolArguments[name]);

    assert.ok(answer.isError === undefined, name);
    assert.equal(textOf(answer), "HTTP 200\n{}", name);
    assert.deepEqual(
      api.calls.map(limitAsked),
      [undefined, Math.floor(max / 2)],
      name,
    );
  }
});

/**
 * Every paged read against an item too large alone, from the largest page it
 * admits, which is the most one call can ask. Each ask is a read the client may
 * repeat with a wait between, so the waits of every ask are added up here and
 * held under the tool's own timeout: past it, a refusal would reach the model
 * as a timeout that says nothing.
 */
test("an item too large alone is refused once one is asked for, inside what a tool call may wait", async () => {
  for (const [name, max] of Object.entries(pageBounds)) {
    const { api, call } = toolsOf({}, () => ({
      status: 200,
      body: "x".repeat(chuggyToolAnswerBytesMax),
    }));

    const answer = await call(name, {
      ...projectToolArguments[name],
      limit: max,
    });

    assert.equal(answer.isError, true, name);
    assert.match(textOf(answer), /is already asking for one/, name);
    const limits = api.calls.map(limitAsked);
    assert.equal(limits[0], max, name);
    assert.equal(limits.at(-1), 1, name);
    for (const [at, limit] of limits.slice(1).entries())
      assert.equal(limit, Math.floor(limits[at] / 2), name);
    assert.ok(
      limits.length * (chuggyRequestAttemptsMax - 1) * chuggyRequestRetryMs <
        chuggyToolTimeoutMs,
      `${name} can wait out its own timeout`,
    );
  }
});

test("every subset of the capabilities admits its tools and disallows the rest", () => {
  const every = [
    ...sessionBuiltInTools,
    ...allChuggyTools.map((tool) => `${chuggyToolPrefix}${tool}`),
  ];
  for (let subset = 0; subset < 2 ** everyCapability.length; subset += 1) {
    const held = everyCapability.filter(
      (_, index) => ((subset >> index) & 1) === 1,
    );
    const admitted = new Set(
      held.flatMap((name) =>
        sessionCapabilityTools[name].map((tool) =>
          sessionBuiltInTools.includes(tool)
            ? tool
            : `${chuggyToolPrefix}${tool}`,
        ),
      ),
    );

    const { allowedTools, disallowedTools } = sessionAllowedTools(held);

    assert.deepEqual(new Set(allowedTools), admitted, held.join(","));
    assert.deepEqual(
      [...allowedTools, ...disallowedTools].sort(),
      [...every].sort(),
      held.join(","),
    );
  }
});

/**
 * The runtime's own tool-discovery tool is admitted by no capability, and a
 * built-in the roster does not carry is in NEITHER list — governed by
 * `permissionMode: "bypassPermissions"` alone, which is no roster at all. So a
 * roster that merely declines to grant it still offers it, and a lead that
 * reaches for it has the whole decision it was in refused against
 * `toolAllowlist`, which is derived from the roster and cannot name it.
 */
test("the runtime's tool-discovery tool is denied by name to every roster", () => {
  const discovery = "ToolSearch";

  for (const [capability, tools] of Object.entries(sessionCapabilityTools))
    assert.ok(!tools.includes(discovery), `${capability} admits it`);
  for (const held of [[], [...leadRoster], everyCapability]) {
    const { allowedTools, disallowedTools } = sessionAllowedTools(held);

    assert.ok(
      disallowedTools.includes(discovery),
      `${held.join(",")} does not deny it by name`,
    );
    assert.ok(!allowedTools.includes(discovery), `${held.join(",")} allows it`);
  }
});

test("a session with no ProjectRead disallows every chuggy read by name", () => {
  const { allowedTools, disallowedTools } = sessionAllowedTools([
    "RepositoryRead",
    "LeadDecision",
  ]);

  for (const tool of sessionCapabilityTools.ProjectRead) {
    const name = `${chuggyToolPrefix}${tool}`;
    assert.ok(disallowedTools.includes(name), `${name} was not disallowed`);
    assert.ok(!allowedTools.includes(name), `${name} was allowed`);
  }
});

test("a capability this image does not know admits nothing", () => {
  const { allowedTools, disallowedTools } = sessionAllowedTools(["Telepathy"]);

  assert.deepEqual(allowedTools, []);
  assert.equal(
    disallowedTools.length,
    sessionBuiltInTools.length + allChuggyTools.length,
  );
});

// Claude Code cuts an MCP tool's description at this many characters, so a
// clause past it is one the agent never reads.
const toolDescriptionCharsMax = 2048;

test("every tool's description is whole within what Claude Code passes an agent", () => {
  for (const { name, description } of chuggyProjectTools)
    assert.ok(
      description.length <= toolDescriptionCharsMax,
      `${name}: ${String(description.length)}`,
    );
});
