import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import { sessionStoreBatchBytesMax } from "@chuggy/worker-contract/sessionPlane";
import {
  agenticRefusalsAnsweredMax,
  allChuggyTools,
  chuggyToolPrefix,
  chuggyToolResponseBytesMax,
  chuggyToolTimeoutMs,
  nativeHttpPageItemsMax,
  selectorHistoryLimitMax,
  threadTurnsAnsweredMax,
} from "@chuggy/worker-contract/sessionTools";
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
  chuggyToolServer,
  sessionAllowedTools,
  sessionBuiltInTools,
  sessionCapabilityTools,
} from "./chuggyTools.mjs";
import { leadDecisionStaging } from "./leadDecision.mjs";
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
 * `brief` is an open object on the wire, so a session learns what one carries
 * from the description alone. A tool that takes one and does not name the title
 * is a tool that files untitled tickets.
 */
test("every tool that takes a brief names the title it carries", () => {
  const taking = chuggyToolDefinitions(
    chuggyToolContext(task, bearer, {
      capabilities: everyCapability,
      staging: leadDecisionStaging(),
    }),
  ).filter((definition) => "brief" in definition.shape(z));

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
  const taking = chuggyToolDefinitions(
    chuggyToolContext(task, bearer, {
      capabilities: everyCapability,
      staging: leadDecisionStaging(),
    }),
  ).filter((definition) => "brief" in definition.shape(z));

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
    [
      "read_run_transcript",
      { execution: "e-1", attempt: "a-1" },
      /read_run_transcript takes no limit, so this one cannot be answered\.$/,
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
      ["read_run_transcript", { execution: "e-1", attempt: "a-1", after: 0 }],
      "/executions/e-1/attempts/a-1/transcript?after=0",
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

test("a prerequisite is refused, and the refusal names dependency immutability", async () => {
  const { api, call } = toolsOf();

  const answer = await call("file_dependent", {
    ...dependent,
    relation: "Prerequisite",
  });

  assert.equal(answer.isError, true);
  assert.match(textOf(answer), /dependencies are immutable/);
  assert.match(textOf(answer), /FollowUp/);
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
 * it settles one ticket: the dependents of a revoked ticket wait for ever
 * unless they are revoked too.
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
    /its only exit is to be revoked too/,
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
 * What the server does that no answer shows until it is too late to act on:
 * that a brief's checks need a commanded Check stage, that a proposal's branch
 * is never the default one, that the refusal ledgers hold none of a command's
 * refusals, that a submission repeated in one turn answers the settled
 * operation, that a project has no lead before a release, and that stages run
 * in order. Each is said where the session reads it.
 */
test("the descriptions say what the server does where a session reads it", () => {
  const described = (tool) =>
    chuggyProjectTools.find(({ name }) => name === tool).description;
  const brief = [
    /`commandedCheckStage`, counted from zero/,
    /run only in a program that reaches that stage/,
    /where it answers none a draft carrying checks is refused/,
    /\(BriefChecksUncommanded\)/,
    /the commit the change started from in CHUG_CHANGE_BASE, unset where that is unknown/,
    /a brief naming none takes its repository's landing/,
    /for a newly bound repository is a pull request/,
    /never the default branch/,
    /\(ProposalBaseIsHead\)/,
  ];
  const ledger = [
    /refusals to dispatch a released ticket/,
    /and nothing else/,
    /read_operation/,
  ];
  const said = {
    create_draft: brief,
    file_dependent: brief,
    revise_draft: brief,
    read_refusals: ledger,
    read_ticket_refusals: ledger,
    release_draft: [
      /same turn is the same operation/,
      /other than Pending/,
      /revise_draft/,
    ],
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
  read_lead: {},
  read_lead_transcript: {},
  list_executions: {},
  read_execution: { execution: "e-1" },
  read_run_transcript: { execution: "e-1", attempt: "a-1" },
  read_operation: { operation: "o-1" },
  list_threads: {},
  read_thread: { session: "t-1" },
  read_thread_transcript: { session: "t-1" },
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
        turn: () => "turn-1",
      }),
      projectToolArguments[definition.name],
    );

    assert.equal(api.calls.length, 1, definition.name);
    const { pathname } = new URL(api.calls[0].path, task.api.url);
    assert.ok(
      pathname === partition || pathname.startsWith(`${partition}/`),
      `${definition.name} reached ${pathname}`,
    );
  }
});

test("origination and revocation are registered for a thread's roster and for no lead's", () => {
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
  ]);
  for (const tool of ["create_draft", "revoke_ticket"]) {
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
test("every project tool a session holds asks its route, and answers what the route did", async () => {
  for (const { name } of chuggyProjectTools) {
    const { api, call } = toolsOf();

    const answer = await call(name, projectToolArguments[name]);

    assert.equal(api.calls.length, 1, name);
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
