/**
 * The pod held to the contract it imports, from its own side: each status a
 * route it calls may answer is driven through the caller that reads it, the
 * documents it writes are read by the contract's schemas, and the tools it
 * offers are the contract's roster under the contract's capabilities.
 *
 * WHAT A STATUS DOES IS WRITTEN HERE, NOT DERIVED. Each table names what the pod
 * does with every status of every route it calls, and must name exactly the
 * statuses the contract's map does: a status the plane starts answering is a
 * reaction nobody chose until this suite is told it.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test, { mock } from "node:test";
import { URL } from "node:url";

import {
  sessionCapabilities,
  sessionTurnToolNameCharsMax,
  sessionTurnToolsMax,
} from "@chuggy/worker-contract/sessionPlane";
import {
  allChuggyTools,
  builtInToolCapabilities,
  chuggyToolCapabilities,
  chuggyToolNames,
  chuggyToolPrefix,
  chuggyToolRoutes,
  chuggyToolServerName,
} from "@chuggy/worker-contract/sessionTools";
import {
  leadDecisionDocumentSchema,
  resultManifestDocumentSchema,
  resultReportCharsMax,
} from "@chuggy/worker-contract/workerDocuments";
import {
  contractVersionRefusalStatus,
  workerContractHeader,
  workerContractRelease,
} from "@chuggy/worker-contract/workerContract";
import { workerWorkspaceVariable } from "@chuggy/worker-contract/workerEnvironment";
import { workerPlaneAnswers } from "@chuggy/worker-contract/workerPlane";
import {
  poolEnvelopeSchema,
  sessionTaskAnswerSchema,
  workTaskDocumentSchema,
} from "@chuggy/worker-contract/workerTask";
import { z } from "zod";

import {
  chuggyProjectTools,
  chuggyToolContext,
  chuggyToolDefinitions,
  chuggyToolHandler,
  sessionAllowedTools,
  sessionBuiltInTools,
} from "./chuggyTools.mjs";
import { git } from "./checkout.fixture.mjs";
import { claudeAgent } from "./claude.mjs";
import { claudeCredentialVariable } from "./claudeCredential.mjs";
import { codexAgent } from "./codex.mjs";
import {
  envelopeCredentialFiles,
  envelopeLaunch,
  envelopeTask,
  publishWorkerResult,
  workerRun,
  workerTaskCarrier,
  workerWorkspace,
} from "./entrypoint.mjs";
import { envelope, fetchedAnswer, pushed } from "./envelope.fixture.mjs";
import { heartbeatIntervalMilliseconds, keepWorkerLease } from "./lease.mjs";
import { leadDecisionStaging } from "./leadDecision.mjs";
import {
  planeCredential,
  planeCredentialAnswered,
  sessionCredentialPath,
  workerCredentialPath,
} from "./planeCredential.mjs";
import {
  overPlane,
  planeFetch,
  planes,
  refusalBodies,
  routeOf,
  versionRefusal,
} from "./plane.fixture.mjs";
import { runEvidenceRecorder } from "./runEvidence.mjs";
import { sessionLease } from "./session.mjs";
import { sessionLiveSender } from "./sessionLive.mjs";
import { blockStart, messageStart, settled } from "./sessionLive.fixture.mjs";
import {
  bearer,
  facts,
  mintedCredential,
  leadRoster,
  queryOf,
  rejection,
  result,
  run,
  task as sessionTask,
  token,
  turnOne,
} from "./sessionHarness.fixture.mjs";
import { sessionMailbox } from "./sessionMailbox.mjs";
import { sessionStopWatch } from "./sessionStop.mjs";
import { sessionStoreAdapter } from "./sessionStore.mjs";
import { sessionRequest, sessionRequestOnce } from "./sessionTransport.mjs";
import { readTicketImages } from "./ticketImages.mjs";
import { workerRequest } from "./transport.mjs";

const jobTask = {
  taskKind: "Evaluation",
  ticket: 7,
  attempt: "attempt-1",
  workerPlane: { url: "http://worker-plane.test:3001" },
};

/** The repository a job's input bundle names, and the base it pins. */
const repositories = {
  "repository-1": { url: "https://github.com/kasofsk/chuggy.git" },
};
const base = "0".repeat(40);

/** A brief's image as the plane serves it, and the input reference that pins it. */
const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const imagePinned = {
  kind: "ProjectArtifact",
  reference: "image-1",
  digest: createHash("sha256").update(image).digest("hex"),
};

/** What each job route answers when it is not the one a case is about. */
function jobSuccess(route) {
  switch (route) {
    case "task":
      return { status: 200, body: fetchedAnswer };
    case "input":
      return {
        status: 200,
        body: {
          bundle: "bundle-1",
          digest: "0".repeat(64),
          references: [
            { ordinal: 1, kind: "Repository", reference: "repository-1" },
            { ordinal: 2, kind: "TargetCommit", reference: base },
          ],
        },
      };
    case "report":
      return { status: 202, body: { action: "stop" } };
    case "runTurns":
      return { status: 200, body: { turnsRecorded: 1 } };
    case "credential":
      return { status: 200, body: mintedCredential };
    case "inputArtifact":
      return { status: 200, body: image };
    default:
      return { status: 204 };
  }
}

/** What each session route answers when it is not the one a case is about. */
function sessionSuccess(route, nth) {
  switch (route) {
    case "facts":
      return { status: 200, body: facts };
    case "turn":
      return nth === 1 ? { status: 200, body: turnOne } : { status: 204 };
    case "turnStopped":
      return { status: 200, body: { turn: turnOne.turn } };
    case "credential":
      return { status: 200, body: mintedCredential };
    case "storeStreams":
      return { status: 200, body: { streams: [] } };
    case "storePage":
      return { status: 200, body: { batches: [] } };
    default:
      return { status: 204 };
  }
}

/** A run whose one assistant turn reaches every run route the recorder writes. */
async function recorded(request) {
  const recorder = runEvidenceRecorder(jobTask, bearer, (text) => text, {
    request,
    setInterval: () => ({ unref: () => undefined }),
    clearInterval: () => undefined,
    warn: () => undefined,
  });
  const event = {
    type: "assistant",
    message: { model: "claude-test", usage: { input_tokens: 1 } },
  };
  await recorder.record(JSON.stringify(event), event);
  await recorder.finish();
  return recorder;
}

/** A finished evaluation reaching the plane: its diagnostic uploaded and its manifest reported. */
function published(request, verdict = "Pass", summary = "the checks passed") {
  return publishWorkerResult(
    {
      task: jobTask,
      bearer,
      evidence: { finish: async () => undefined },
      scrub: (text) => text,
      stopLease: async () => undefined,
      request,
    },
    {},
    {
      output: { checks: [] },
      result: { verdict, summary },
      diagnosticPath: ".chuggy/check-output.json",
    },
  );
}

/**
 * The caller of each job route, and whether it carried on. Every one reaches
 * the plane through `workerRequest`, the transport a job pod is given.
 */
const jobCallers = {
  task: (request) => envelopeTask(envelope, request),
  input: async (request) => {
    process.env[workerWorkspaceVariable] = "/workspace";
    await workerWorkspace(jobTask, repositories, {}, bearer, () => undefined, {
      request,
      clone: async () => "/workspace/repository",
      write: async () => undefined,
    });
  },
  heartbeat: async (request) => {
    const stop = keepWorkerLease(jobTask, bearer, {
      request,
      setInterval: (beat) => {
        beat();
        return 0;
      },
      clearInterval: () => undefined,
    });
    await stop();
  },
  artifact: published,
  report: published,
  runConfiguration: async (request) => {
    const recorder = await recorded(request);
    await recorder.configuration(Buffer.from("{}"));
  },
  runTranscript: recorded,
  runTurns: recorded,
  runTotals: recorded,
  runEnded: async (request) => {
    const recorder = await recorded(request);
    await recorder.ended();
  },
  inputArtifact: async (request) => {
    const directory = await mkdtemp(join(tmpdir(), "chuggy-contract-images-"));
    try {
      await readTicketImages({
        task: jobTask,
        bearer,
        references: [imagePinned],
        directory,
        request,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  credential: (request) =>
    planeCredential({
      task: jobTask,
      bearer,
      path: workerCredentialPath,
      request,
      write: async () => undefined,
    }),
};

/** A session pod run end to end, carrying on where it exits cleanly. */
function sessionRun(script) {
  return async (request) => {
    const code = await run({ request, query: queryOf(script).query });
    if (code !== 0) throw new Error(`the session exited ${String(code)}`);
  };
}

const answeredTurn = sessionRun(() => [
  { type: "system", subtype: "init", session_id: "runtime-1" },
  result("success", { result: "ok" }),
]);

/** A session's store over `request`, whose wire is what this suite asks about. */
function sessionStoreOver(request) {
  return sessionStoreAdapter(sessionTask, bearer, {
    request,
    scrub: (text) => text,
  });
}

/**
 * One block of a thread's answer reported live, carrying on where the plane
 * took the post. The sender never raises, so what it says when it closes is
 * what tells a post that was taken from one that was not.
 */
async function reportedLive(request) {
  const warned = [];
  let time = 0;
  const sender = sessionLiveSender(sessionTask, bearer, {
    request,
    now: () => time,
    pause: async (milliseconds) => {
      time += milliseconds;
    },
    scrub: (text) => text,
    scrubHead: (text) => text,
    warn: (text) => warned.push(text),
    turnStopped: () => undefined,
  });
  sender.heard("turn-1", messageStart("message-1"));
  sender.heard("turn-1", blockStart(0, { type: "text", text: "kestrel" }));
  await settled();
  sender.close();
  if (warned.length > 0) throw new Error(warned.join(""));
}

/**
 * One turn watched for its member's stop, carrying on where the plane said it
 * was stopped. The watch never raises, so the interrupt it was to make is
 * what tells a stop it heard from a plane it gave up asking.
 */
async function watchedStop(request) {
  let interrupts = 0;
  const watch = sessionStopWatch(sessionTask, bearer, {
    request,
    now: () => 0,
    pause: async () => undefined,
    interrupt: async () => {
      interrupts += 1;
    },
    warn: () => undefined,
  });
  watch.watching(turnOne.turn);
  await settled();
  watch.released();
  if (interrupts !== 1) throw new Error("the watch heard no stop");
}

/** The caller of each session route, reached through `sessionTransport`'s choice for it. */
const sessionCallers = {
  facts: answeredTurn,
  heartbeat: async (request) => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const stop = sessionLease(sessionTask, bearer, request);
      mock.timers.tick(heartbeatIntervalMilliseconds);
      await stop();
    } finally {
      mock.timers.reset();
    }
  },
  reference: answeredTurn,
  turn: async (request) => {
    const turns = sessionMailbox(sessionTask, bearer, {
      request,
      wait: async () => undefined,
    }).turns();
    if ((await turns.next()).done) throw new Error("the mailbox stopped");
  },
  turnAnswer: answeredTurn,
  turnFailure: sessionRun(() => [result("error_during_execution")]),
  turnLive: reportedLive,
  turnStopped: watchedStop,
  held: sessionRun(() => [rejection, result("error_during_execution")]),
  storeStreams: (request) =>
    sessionStoreOver(request).listSubkeys({ sessionId: "runtime-1" }),
  storeBatch: (request) =>
    sessionStoreOver(request).append({ sessionId: "runtime-1" }, [
      { uuid: "a", type: "assistant" },
    ]),
  storePage: (request) =>
    sessionStoreOver(request).load({ sessionId: "runtime-1" }),
  credential: (request) =>
    planeCredential({
      task: sessionTask,
      bearer,
      path: sessionCredentialPath,
      repository: "https://github.com/kasofsk/chuggy.git",
      request,
      write: async () => undefined,
    }),
};

/** The transport a job pod reaches every route through. */
const jobTransport = () => workerRequest;

/** The transport a session reaches each route through: the one that asks once for a live post and for the watch on a turn, which no turn waits for. */
const sessionTransport = (route) =>
  route === "turnLive" || route === "turnStopped"
    ? sessionRequestOnce
    : sessionRequest;

/**
 * What one caller did when `route` gave `answer` once, every other ask
 * answering as it does on success: `reads` where it carried on after one ask,
 * `stops` where it gave up after one, and `retries` where it asked again.
 * `transport(route)` is what the caller reaches the plane through.
 */
async function reaction(wire, success, transport, caller, route, answer) {
  const counts = new Map();
  const plane = planeFetch(wire, (asked) => {
    const nth = (counts.get(asked) ?? 0) + 1;
    counts.set(asked, nth);
    const succeeded = success(asked, nth);
    return asked !== route || nth > 1 || answer.status === succeeded.status
      ? succeeded
      : answer;
  });
  const carried = await caller(overPlane(transport(route), plane.fetch)).then(
    () => true,
    () => false,
  );
  const asks = counts.get(route) ?? 0;
  if (asks === 0) return "unreached";
  if (asks > 1) return "retries";
  return carried ? "reads" : "stops";
}

/** Every status of every job route the pod calls. */
const jobReactions = {
  task: { 200: "reads", 401: "stops", 409: "stops" },
  input: { 200: "reads", 401: "stops", 409: "stops" },
  heartbeat: { 204: "reads", 401: "stops", 409: "stops" },
  artifact: {
    204: "reads",
    400: "stops",
    401: "stops",
    409: "stops",
    413: "stops",
    415: "stops",
    503: "retries",
  },
  report: {
    202: "reads",
    400: "stops",
    401: "stops",
    409: "stops",
    503: "retries",
  },
  runConfiguration: {
    204: "reads",
    400: "reads",
    401: "reads",
    409: "reads",
    413: "reads",
    415: "reads",
    503: "retries",
  },
  runTranscript: {
    204: "reads",
    400: "reads",
    401: "reads",
    409: "reads",
    413: "reads",
    415: "reads",
    503: "retries",
  },
  runTurns: { 200: "reads", 400: "reads", 401: "reads", 409: "reads" },
  runTotals: {
    204: "reads",
    400: "reads",
    401: "reads",
    409: "reads",
    413: "reads",
  },
  runEnded: { 204: "reads", 400: "stops", 401: "stops", 409: "stops" },
  inputArtifact: {
    200: "reads",
    401: "stops",
    404: "stops",
    409: "stops",
    413: "stops",
    503: "retries",
  },
  credential: {
    200: "reads",
    400: "stops",
    401: "stops",
    404: "reads",
    409: "stops",
    503: "retries",
  },
};

/** Every status of every session route the pod calls. */
const sessionReactions = {
  facts: { 200: "reads", 401: "stops", 409: "stops" },
  heartbeat: { 204: "reads", 401: "stops", 409: "stops" },
  reference: { 204: "reads", 400: "stops", 401: "stops", 409: "stops" },
  turn: { 200: "reads", 204: "retries", 401: "stops", 409: "stops" },
  turnAnswer: { 204: "reads", 400: "stops", 401: "stops", 409: "stops" },
  turnFailure: { 204: "reads", 400: "stops", 401: "stops", 409: "stops" },
  turnLive: {
    200: "reads",
    204: "reads",
    400: "stops",
    401: "stops",
    409: "stops",
    503: "retries",
  },
  turnStopped: {
    200: "reads",
    204: "retries",
    400: "stops",
    401: "stops",
    409: "stops",
  },
  held: { 204: "reads", 401: "stops", 409: "stops" },
  storeStreams: {
    200: "reads",
    400: "stops",
    401: "stops",
    409: "stops",
    413: "stops",
  },
  storeBatch: {
    204: "reads",
    400: "stops",
    401: "stops",
    409: "stops",
    413: "stops",
    415: "stops",
    503: "retries",
  },
  storePage: {
    200: "reads",
    400: "stops",
    401: "stops",
    409: "stops",
    503: "retries",
  },
  credential: {
    200: "reads",
    400: "stops",
    401: "stops",
    404: "reads",
    409: "stops",
    503: "retries",
  },
};

/** The body of a status that is neither its route's success nor a refusal: the stopped turn a live post is answered with. */
const sessionBodies = { turnLive: { 200: { turn: turnOne.turn } } };

/** Each way `route` may answer `status`: its success where that is what it is, the body `bodies` names for it, and otherwise once for every refusal the status carries. */
function answersOf(wire, success, bodies, route, status) {
  const schema = wire.answers[route][status];
  if (schema === "empty" || success(route, 1).status === status)
    return [{ status }];
  const named = bodies[route]?.[status];
  if (named !== undefined) return [{ status, body: named }];
  return refusalBodies(schema).map((body) => ({ status, body }));
}

/** Each table's statuses against the map's, and each driven through its caller. */
async function heldToMap(
  wire,
  reactions,
  uncalled,
  callers,
  success,
  transport,
  bodies = {},
) {
  assert.deepEqual(
    [...Object.keys(reactions), ...uncalled].sort(),
    Object.keys(wire.answers).sort(),
    "a route the contract names is neither driven nor named as uncalled",
  );
  for (const [route, statuses] of Object.entries(reactions)) {
    assert.deepEqual(
      Object.keys(statuses),
      Object.keys(wire.answers[route]),
      `${route} answers statuses this suite does not name`,
    );
    for (const [status, expected] of Object.entries(statuses))
      for (const answer of answersOf(
        wire,
        success,
        bodies,
        route,
        Number(status),
      ))
        assert.equal(
          await reaction(
            wire,
            success,
            transport,
            callers[route],
            route,
            answer,
          ),
          expected,
          `${route} answering ${status} ${JSON.stringify(answer.body)}`,
        );
  }
}

test("every status a job route the pod calls may answer is one the pod has a named reaction to", async () => {
  await heldToMap(
    planes.job,
    jobReactions,
    [],
    jobCallers,
    jobSuccess,
    jobTransport,
  );
});

/**
 * Catches a read the pod names of another repository meeting a status of the
 * credential route otherwise than the pod's ask for its own does, or naming
 * it in a body the route's schema refuses.
 */
test("a read of another repository meets every status of the credential route as the pod's own ask does", async () => {
  await heldToMap(
    { ...planes.job, answers: { credential: planes.job.answers.credential } },
    { credential: jobReactions.credential },
    [],
    {
      credential: (request) =>
        planeCredentialAnswered({
          task: jobTask,
          bearer,
          path: workerCredentialPath,
          repository: "https://github.com/kasofsk/chuggy-common.git",
          request,
        }),
    },
    jobSuccess,
    jobTransport,
  );
});

/** The session routes the pool holding a session calls rather than its pod, which `poolSessionPlane.test.mjs` holds to their statuses. */
const poolSessionRoutes = ["ended"];

test("every status a session route the pod calls may answer is one the pod has a named reaction to", async () => {
  await heldToMap(
    planes.session,
    sessionReactions,
    poolSessionRoutes,
    sessionCallers,
    sessionSuccess,
    sessionTransport,
    sessionBodies,
  );
});

/** What a proxy answers in front of a plane it cannot reach: a status of its own, naming no release. */
function proxyAnswered(status) {
  return new globalThis.Response("no plane answered this\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * What one caller did when a proxy answered `route`'s first ask with
 * `status`, and the plane answered every ask after as it does on success:
 * `reaction`'s names for it, the plane's own asks numbered as they reach it.
 */
async function proxyReaction(wire, success, transport, caller, route, status) {
  const asks = new Map();
  const answered = new Map();
  const plane = planeFetch(wire, (asked) => {
    const nth = (answered.get(asked) ?? 0) + 1;
    answered.set(asked, nth);
    return success(asked, nth);
  });
  const fetch = async (url, init = {}) => {
    const asked = routeOf(wire, init.method ?? "GET", new URL(url).pathname);
    asks.set(asked, (asks.get(asked) ?? 0) + 1);
    return asked === route && asks.get(asked) === 1
      ? proxyAnswered(status)
      : plane.fetch(url, init);
  };
  const carried = await caller(overPlane(transport(route), fetch)).then(
    () => true,
    () => false,
  );
  const count = asks.get(route) ?? 0;
  if (count === 0) return "unreached";
  if (count > 1) return "retries";
  return carried ? "reads" : "stops";
}

/**
 * Catches a status read as the plane's that something in front of it gave: a
 * proxy with no plane to reach names no release, and whatever it answers is
 * asked past on every route the pod calls, the statuses that stop the pod
 * among them.
 */
test("a status naming no release is asked again on every route the pod calls", async () => {
  for (const [wire, reactions, callers, success, transport] of [
    [planes.job, jobReactions, jobCallers, jobSuccess, jobTransport],
    [
      planes.session,
      sessionReactions,
      sessionCallers,
      sessionSuccess,
      sessionTransport,
    ],
  ])
    for (const route of Object.keys(reactions))
      for (const status of [400, 401, 403, 404, 409, 413, 429])
        assert.equal(
          await proxyReaction(
            wire,
            success,
            transport,
            callers[route],
            route,
            status,
          ),
          "retries",
          `${route} answered ${String(status)} by a proxy`,
        );
});

/**
 * A plane that serves no version this pod speaks, refusing every call: no
 * route is asked twice, and the first call each kind of pod makes ends it.
 */
test("a plane refusing the pod's release is asked once per route, and the pod stops", async () => {
  for (const [wire, callers, transport, first] of [
    [planes.job, jobCallers, jobTransport, "input"],
    [planes.session, sessionCallers, sessionTransport, "facts"],
  ])
    for (const [route, caller] of Object.entries(callers)) {
      const asked = [];
      const plane = planeFetch(wire, (named) => {
        asked.push(named);
        return { status: contractVersionRefusalStatus, body: versionRefusal };
      });
      const carried = await caller(
        overPlane(transport(route), plane.fetch),
      ).then(
        () => true,
        () => false,
      );
      assert.ok(asked.length > 0, `${route} reached no route`);
      assert.deepEqual(asked, [...new Set(asked)], `${route} asked again`);
      if (route === first) assert.equal(carried, false, `${route} carried on`);
    }
});

/**
 * The task an envelope's pod runs is the document a pushed pod is launched
 * with, less the plane fields no step after admission reads. Catches the
 * answer's kind left on the task, a field the lenient read dropped, and the
 * plane not joined back on.
 */
test("the task an envelope's pod fetches is the pushed document, less what nothing after admission reads", async () => {
  const plane = planeFetch(planes.job, (route) => jobSuccess(route));

  const fetched = await envelopeTask(
    envelope,
    overPlane(workerRequest, plane.fetch),
  );

  assert.deepEqual(
    Object.keys(pushed).sort(),
    Object.keys(workTaskDocumentSchema.shape).sort(),
    "the pushed document leaves a field out, which the read could drop unseen",
  );
  assert.deepEqual(fetched, {
    mode: "Work",
    task: { ...pushed, workerPlane: { url: envelope.callbackUrl } },
  });
  assert.deepEqual(
    plane.asked.map(({ route }) => route),
    ["task"],
  );
});

/** Catches one carrier read as the other, and a launcher's mistake read as whichever it resembles more. */
test("a pushed document and a pool's envelope are told apart, and both at once or neither is refused", () => {
  assert.equal(workerTaskCarrier(pushed), "Document");
  assert.equal(workerTaskCarrier(envelope), "Envelope");
  assert.throws(
    () => workerTaskCarrier({ ...pushed, ...envelope }),
    /a task document and a pool envelope at once/u,
  );
  for (const neither of [{}, { namedByNeither: true }, [], null, "task"])
    assert.throws(
      () => workerTaskCarrier(neither),
      /neither a task document nor a pool envelope/u,
    );
});

/** What makes the carrier decidable by its fields at all. */
test("no field a task document names is one a pool envelope names", () => {
  const documentFields = Object.keys(workTaskDocumentSchema.shape);

  assert.deepEqual(
    Object.keys(poolEnvelopeSchema.shape).filter((field) =>
      documentFields.includes(field),
    ),
    [],
  );
});

/** A session's task as a pod's launcher writes it, less what a pool-held session's answer adds. */
const sessionTaskBare = Object.fromEntries(
  Object.entries(sessionTask).filter(
    ([field]) => !["api", "bounds", "workerPlane"].includes(field),
  ),
);

/**
 * Each way the task route may refuse an envelope's pod, and whether the plane
 * can still take the attempt's end: not where it refuses this pod's release,
 * which it refuses on every route, nor for a session's bearer.
 */
const taskRefusals = [
  {
    what: "a status the task route does not answer, which no plane older than it names",
    status: 404,
    settles: false,
  },
  {
    what: "a plane refusing this pod's release",
    status: contractVersionRefusalStatus,
    body: versionRefusal,
    settles: false,
  },
  {
    what: "an attempt whose task was never recorded",
    status: contractVersionRefusalStatus,
    body: workerPlaneAnswers.task[contractVersionRefusalStatus].parse({
      action: "stop",
      reason: "TaskNotRecorded",
    }),
    settles: true,
  },
  {
    what: "a session's task without the launch facts a pool-held one carries",
    status: 200,
    body: sessionTaskAnswerSchema.parse({
      ...sessionTaskBare,
      capabilities: leadRoster,
      credentialSlot: claudeAgent.credential,
      authority: fetchedAnswer.authority,
    }),
    settles: false,
  },
  {
    what: "a task this pod cannot read",
    status: 200,
    body: { ...fetchedAnswer, authority: null },
    settles: true,
  },
];

/**
 * A plane answering the task route with `refusal`, which its map need not
 * describe, and every other route as it does on success. `routes` is every
 * route asked, in order.
 */
function refusingTask(refusal) {
  const routes = [];
  const plane = planeFetch(planes.job, (route) => jobSuccess(route));
  return {
    routes,
    plane,
    fetch: async (url, init = {}) => {
      const route = routeOf(
        planes.job,
        init.method ?? "GET",
        new URL(url).pathname,
      );
      routes.push(route);
      if (route !== "task") return plane.fetch(url, init);
      return new globalThis.Response(
        refusal.body === undefined ? null : JSON.stringify(refusal.body),
        {
          status: refusal.status,
          headers: { [workerContractHeader]: workerContractRelease },
        },
      );
    },
  };
}

/**
 * Catches a refusal the pod asks again after, and one it leaves for the reaper
 * where the plane could have taken the attempt's end: the task route is asked
 * once, and wherever the plane can end the attempt it is ended as a crashed
 * run's is, with the refusal as its error text.
 */
test("each refusal of an envelope's task ends the attempt at once, where the plane can take its end", async () => {
  for (const refusal of taskRefusals) {
    const asked = refusingTask(refusal);

    const refused = await envelopeTask(
      envelope,
      overPlane(workerRequest, asked.fetch),
    ).then(
      () => undefined,
      (error) => error.message,
    );

    assert.equal(typeof refused, "string", `${refusal.what} was run`);
    assert.deepEqual(
      asked.routes,
      refusal.settles
        ? ["task", "runTotals", "artifact", "runEnded"]
        : ["task"],
      refusal.what,
    );
    if (refusal.settles)
      assert.equal(
        String(
          asked.plane.asked.find(({ route }) => route === "artifact")?.body,
        ),
        `${refused}\n`,
        refusal.what,
      );
  }
});

/**
 * Catches a proxy's 404 read as a plane too old to have the task route, which
 * names no release either: the attempt is left to its lease rather than ended
 * as refused, and its pod gives up only once the plane has been away a lease.
 */
test("an envelope's task route answered only by a proxy is asked until the plane has been away a lease, and ends no attempt", async () => {
  const routes = [];
  const refused = await envelopeTask(
    envelope,
    overPlane(workerRequest, async (url, init = {}) => {
      routes.push(
        routeOf(planes.job, init.method ?? "GET", new URL(url).pathname),
      );
      return proxyAnswered(404);
    }),
  ).then(
    () => undefined,
    (error) => error.message,
  );

  assert.equal(
    refused,
    "worker plane /v1/task answered 404, naming no release",
  );
  assert.ok(routes.length > 1, String(routes.length));
  assert.deepEqual([...new Set(routes)], ["task"]);
});

/**
 * Catches the provider credential put in a slot its agent does not read, and a
 * credential the pool mounted reaching an upload unscrubbed because no agent
 * asked for it. The pod names no kind, whatever the suite's runner names.
 */
test("an envelope's provider credential is its agent's, and is scrubbed as a mounted one is", async (t) => {
  const named = process.env[claudeCredentialVariable];
  delete process.env[claudeCredentialVariable];
  t.after(() => {
    if (named !== undefined) process.env[claudeCredentialVariable] = named;
  });
  const directory = await mkdtemp(join(tmpdir(), "chuggy-envelope-"));
  try {
    const providerCredentialFile = join(directory, "provider-credential");
    await writeFile(providerCredentialFile, `${token}\n`);
    const mounted = { ...envelope, providerCredentialFile };
    for (const agent of [claudeAgent, codexAgent])
      assert.deepEqual(envelopeCredentialFiles(mounted, agent), {
        [agent.credential]: providerCredentialFile,
      });

    for (const agent of [claudeAgent, undefined]) {
      const given = await envelopeLaunch(mounted).given(agent);
      const run = await workerRun({ task: jobTask, ...given, agent });
      run.evidence.stop();

      assert.equal(run.scrub(`saw ${token}`).includes(token), false);
      assert.deepEqual(
        run.agentEnvironment,
        agent === undefined ? {} : agent.prepareCredential(token).environment,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Catches an envelope with no provider credential running its agent on something else, or failing otherwise than a pushed pod with none mounted. */
test("an envelope with no provider credential leaves its agent unmounted, as a pushed pod with none is", async () => {
  const failure = (given) =>
    workerRun({
      task: jobTask,
      bearer: envelope.bearer,
      ...given,
      agent: claudeAgent,
    }).then(
      () => undefined,
      (error) => error.message,
    );

  assert.deepEqual(envelopeCredentialFiles(envelope, claudeAgent), {});
  const enveloped = await failure(
    await envelopeLaunch(envelope).given(claudeAgent),
  );
  assert.equal(enveloped, await failure({ credentialFiles: {}, mounted: [] }));
  assert.match(enveloped, /is not mounted/u);
});

/** The manifest one finished attempt reported, as the plane was offered it. */
async function reportedManifest(publish) {
  const reported = [];
  const plane = planeFetch(planes.job, (route, asked) => {
    if (route === "report") reported.push(asked.body);
    return jobSuccess(route);
  });
  await publish(overPlane(workerRequest, plane.fetch));
  assert.equal(reported.length, 1);
  return reported[0];
}

/**
 * The writer driven, not a document built beside it: an evaluation's manifest
 * with a report at its bound, and a passing work attempt's with the source its
 * push left and the summary an agent's run keeps.
 */
test("the manifest the pod reports is one the contract's manifest schema reads", async () => {
  const evaluation = await reportedManifest((request) =>
    published(request, "Fail", "x".repeat(resultReportCharsMax)),
  );
  resultManifestDocumentSchema.parse(evaluation);
  assert.equal(evaluation.report.length, resultReportCharsMax);

  const work = await reportedManifest((request) =>
    publishWorkerResult(
      {
        task: { ...jobTask, taskKind: "Work" },
        bearer,
        evidence: { finish: async () => undefined },
        scrub: (text) => text,
        stopLease: async () => undefined,
        request,
        held: () => [],
        command: async (executable, args, options) =>
          args[0] === "init"
            ? git(executable, args, {
                ...options,
                env: { PATH: process.env.PATH ?? "", ...options.env },
              })
            : { stdout: `${"a".repeat(40)}\n` },
      },
      {
        repositoryId: "repository-1",
        repository: repositories["repository-1"].url,
        base,
        directory: "/workspace/repository",
        environment: {},
      },
      {
        output: {},
        result: { verdict: "Pass", summary: "done" },
        diagnosticPath: ".chuggy/agent-result.json",
        summaryPath: ".chuggy/outputs/summary.md",
      },
    ),
  );
  resultManifestDocumentSchema.parse(work);
  assert.equal(work.source.repository, "repository-1");
  assert.deepEqual(
    work.diagnostics.map(({ path }) => path),
    [".chuggy/agent-result.json", ".chuggy/outputs/summary.md"],
  );
});

/** An observation offering one ticket to dispatch and one to refuse. */
const observation = JSON.stringify({
  version: 1,
  decision: "decision-1",
  partition: { tenant: "vteng", project: "chuggy" },
  changes: [],
  candidates: [
    { ticket: 4, ticketVersion: 2 },
    { ticket: 5, ticketVersion: 1 },
  ],
  token: {},
  operationalContext: {},
  refusals: [{ ticket: 6, ticketVersion: 1, reason: "later" }],
});

test("the decision every decision tool composes is one the contract's decision schema reads", async () => {
  const staging = leadDecisionStaging();
  staging.reset(observation);
  const call = (name, args) =>
    chuggyToolHandler(
      staging.definitions.find((definition) => definition.name === name),
      z,
    )(args);
  const calls = {
    dispatch: { ticket: 4, expectedTicketVersion: 2 },
    refuse: { ticket: 5, ticketVersion: 1, reason: "later" },
    lift: { ticket: 6 },
    set_attention: { attention: "Attention" },
    set_handoff_note: { note: { carried: "on" } },
    set_planning_intent: { intent: { next: "ticket 7" } },
  };

  assert.deepEqual(Object.keys(calls), [
    ...chuggyToolCapabilities.LeadDecision,
  ]);
  for (const [name, args] of Object.entries(calls)) {
    const answer = await call(name, args);
    assert.notEqual(answer.isError, true, `${name}: ${answer.content[0].text}`);
  }
  leadDecisionDocumentSchema.parse(staging.document());
});

/** Every field a project tool requires, so one argument set drives each tool to its route. */
const everyToolArgument = {
  ticket: 7,
  parent: 7,
  relation: "FollowUp",
  revision: "r-1",
  execution: "e-1",
  attempt: "a-1",
  operation: "o-1",
  session: "s-1",
  artifact: "image/png:a-1",
  expectedVersion: 1,
  expectedRevision: 1,
  authoringVersion: 1,
  configurationRevision: "r-1",
  configurationDigest: "d-1",
  expectedProjectSequence: 1,
  authoring: { dependencies: [7] },
  brief: {},
};

/** The routes of the tools' table one path matches. */
function toolRoutesMatching(pathname) {
  return Object.entries(chuggyToolRoutes)
    .filter(([, pattern]) =>
      new RegExp(`^${pattern.replace(/:[A-Za-z]+/gu, "[^/]+")}$`, "u").test(
        pathname,
      ),
    )
    .map(([name]) => name);
}

test("the pod's tools reach exactly the routes the contract gives them", async () => {
  const reached = new Set();
  for (const definition of chuggyProjectTools) {
    const paths = [];
    const context = chuggyToolContext(
      { tenant: "t-1", project: "p-1", api: { url: "https://api.test" } },
      bearer,
      {
        request: async (_task, _bearer, path) => {
          paths.push(new URL(path, "https://api.test").pathname);
          return { status: 200, text: async () => "{}" };
        },
        turn: () => "turn-1",
      },
    );

    await chuggyToolHandler(
      { ...definition, call: (args) => definition.call(context, args) },
      z,
    )(everyToolArgument);

    assert.equal(paths.length, 1, definition.name);
    const matched = toolRoutesMatching(paths[0]);
    assert.equal(matched.length, 1, `${definition.name} asked ${paths[0]}`);
    reached.add(matched[0]);
  }
  assert.deepEqual([...reached].sort(), Object.keys(chuggyToolRoutes).sort());
});

/** The tool names one roster registers, off the pod's own server definitions. */
function registered(capabilities) {
  return chuggyToolDefinitions(
    chuggyToolContext(sessionTask, bearer, {
      capabilities,
      staging: leadDecisionStaging(),
    }),
  ).map(({ name }) => name);
}

/** Every roster the contract's capabilities make, the empty one included. */
function everyRoster() {
  return Array.from({ length: 2 ** sessionCapabilities.length }, (_, subset) =>
    sessionCapabilities.filter((_, index) => ((subset >> index) & 1) === 1),
  );
}

test("the pod defines every tool the contract rosters, and no other", () => {
  const defined = [
    ...chuggyProjectTools.map(({ name }) => name),
    ...leadDecisionStaging().definitions.map(({ name }) => name),
  ];

  assert.deepEqual([...defined].sort(), [...allChuggyTools].sort());
  assert.deepEqual(
    leadDecisionStaging().definitions.map(({ name }) => name),
    [...chuggyToolCapabilities.LeadDecision],
  );
});

/**
 * Over every roster there is, not the two this installation opens sessions
 * with: what a session is opened with is the provisioning root's, and the pod
 * must be right for whichever it is handed.
 */
test("every roster registers, allows and disallows exactly what the contract's capabilities admit", () => {
  const every = [
    ...sessionBuiltInTools,
    ...allChuggyTools.map((tool) => `${chuggyToolPrefix}${tool}`),
  ];
  for (const roster of everyRoster()) {
    const named = roster.join(",") || "no capability";
    const admitted = new Set([
      ...roster.flatMap((capability) => builtInToolCapabilities[capability]),
      ...chuggyToolNames(roster),
    ]);
    const { allowedTools, disallowedTools } = sessionAllowedTools(roster);

    assert.deepEqual(new Set(allowedTools), admitted, named);
    assert.deepEqual(
      [...allowedTools, ...disallowedTools].sort(),
      [...every].sort(),
      named,
    );
    assert.deepEqual(
      registered(roster)
        .map((tool) => `${chuggyToolPrefix}${tool}`)
        .sort(),
      [...chuggyToolNames(roster)].sort(),
      named,
    );
  }
});

test("every built-in a capability admits is one the pod names, and the runtime names the server's tools by its prefix", () => {
  for (const [capability, tools] of Object.entries(builtInToolCapabilities))
    for (const tool of tools)
      assert.ok(sessionBuiltInTools.includes(tool), `${capability}: ${tool}`);
  assert.equal(chuggyToolPrefix, `mcp__${chuggyToolServerName}__`);
});

test("every tool a session may be offered fits one measured turn's tool list", () => {
  const names = [
    ...sessionBuiltInTools,
    ...allChuggyTools.map((tool) => `${chuggyToolPrefix}${tool}`),
  ];

  assert.ok(
    names.length <= sessionTurnToolsMax,
    `a session may report ${String(names.length)} tools and a turn records ${String(sessionTurnToolsMax)}`,
  );
  for (const name of names)
    assert.ok(
      name.length <= sessionTurnToolNameCharsMax,
      `${name} is longer than a recorded tool name holds`,
    );
});
