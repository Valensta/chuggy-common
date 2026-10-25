/**
 * The watch for a member's stop: first the watch alone, over a plane and a
 * clock each case writes, and then a thread's session holding one, over the
 * suites' plane and a runtime that can be interrupted.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";

import { sessionPlaneRoutes } from "@chuggy/worker-contract/sessionPlane";

import {
  bearer,
  facts,
  heldUntilLetGo,
  planeOf,
  result,
  run,
  task,
  threadRoster,
  turnOne,
} from "./sessionHarness.fixture.mjs";
import {
  messageStart,
  settled,
  streamed,
  textDelta,
  textStart,
} from "./sessionLive.fixture.mjs";
import { sessionStopBounds, sessionStopWatch } from "./sessionStop.mjs";
import { sessionRequestOnce } from "./sessionTransport.mjs";

const stopPath = sessionPlaneRoutes.turnStopped.path;
const pollMs = 1_000;
const watchedTask = {
  ...task,
  bounds: { ...task.bounds, mailboxPollMs: pollMs },
};

/** One answer of the plane's, as the watch reads a response. */
const answered = (status, body) => ({
  status,
  json: async () => body,
  body: { cancel: async () => undefined },
});
const stopped = (turn) => answered(200, { turn });

/**
 * A watch over a plane that gives each question the next of `answers`, and
 * the last of them from then on. An answer is a response, an error to raise,
 * or a function of the question's own signal; `[milliseconds, answer]` is one
 * the plane held for that long before giving.
 */
function watchOver(answers, services = {}) {
  const seen = { asks: [], pauses: [], interrupts: 0, warned: [] };
  let time = 0;
  const watch = sessionStopWatch(watchedTask, bearer, {
    request: async (asked, held, path, init, transport) => {
      seen.asks.push({ asked, held, path, init, transport });
      const next = answers[Math.min(seen.asks.length, answers.length) - 1];
      const [heldMs, answer] = Array.isArray(next) ? next : [0, next];
      time += heldMs;
      const given =
        typeof answer === "function" ? await answer(transport.signal) : answer;
      if (given instanceof Error) throw given;
      return given;
    },
    now: () => time,
    pause: async (milliseconds) => {
      seen.pauses.push(milliseconds);
      time += milliseconds;
    },
    interrupt: async () => {
      seen.interrupts += 1;
    },
    warn: (text) => seen.warned.push(text),
    ...services,
  });
  return { watch, seen };
}

test("a turn the plane says was stopped is interrupted once, and no more is asked of it", async () => {
  const { watch, seen } = watchOver([stopped("turn-1")]);

  watch.watching("turn-1");
  await settled();

  assert.equal(seen.interrupts, 1);
  assert.equal(seen.asks.length, 1);
  assert.deepEqual(seen.warned, ["turn turn-1 was stopped by its member\n"]);
  assert.equal(watch.stopped("turn-1"), true);
  assert.equal(watch.stopped("turn-2"), false);
  assert.equal(watch.stopped(undefined), false);
  const [{ asked, held, path, init, transport }] = seen.asks;
  assert.equal(asked, watchedTask);
  assert.equal(held, bearer);
  assert.equal(path, stopPath);
  assert.equal(init.method, sessionPlaneRoutes.turnStopped.method);
  assert.deepEqual(init.headers, { "content-type": "application/json" });
  assert.deepEqual(JSON.parse(init.body), { turn: "turn-1" });
  assert.equal(transport.deadlineMs, sessionStopBounds.askDeadlineMs);
  assert.equal(transport.signal.aborted, false);
});

test("the deadline one question is asked under is the opener's where it names one", async () => {
  const { watch, seen } = watchOver([stopped("turn-1")], {
    bounds: { askDeadlineMs: 7 },
  });

  watch.watching("turn-1");
  await settled();

  assert.equal(seen.asks[0].transport.deadlineMs, 7);
});

/**
 * The pacing is from the start of one question to the start of the next. A
 * pause after every empty answer would leave a stop unheard for that long
 * after each hold the plane spent, and no pause would ask a plane that holds
 * nothing as fast as it answers.
 */
test("a hold the plane spent is followed at once, and an answer sooner than the mailbox's pause by the rest of it", async () => {
  const { watch, seen } = watchOver([
    [pollMs, answered(204)],
    [25 * pollMs, answered(204)],
    answered(204),
    [pollMs - 400, answered(204)],
    stopped("turn-1"),
  ]);

  watch.watching("turn-1");
  await settled();

  assert.equal(seen.asks.length, 5);
  assert.deepEqual(seen.pauses, [pollMs, 400]);
  assert.equal(seen.interrupts, 1);
});

/**
 * A condition is asked past: a plane that raised or failed. Taken as the
 * plane's decision, one of those would leave every later stop of the session
 * unheard.
 */
test("a plane that could not be asked, or failed, is asked again after the mailbox's pause", async () => {
  for (const failure of [new Error("unreachable"), answered(503)]) {
    const { watch, seen } = watchOver([failure, stopped("turn-1")]);

    watch.watching("turn-1");
    await settled();

    assert.equal(seen.asks.length, 2, String(failure.status));
    assert.deepEqual(seen.pauses, [pollMs], String(failure.status));
    assert.equal(seen.interrupts, 1, String(failure.status));
  }
});

test("a plane that answers anything else is asked nothing more, of that turn or of the next", async () => {
  for (const refusal of [
    answered(400),
    answered(401),
    answered(403),
    answered(404),
    answered(409),
    answered(429),
    stopped("turn-9"),
  ]) {
    const { watch, seen } = watchOver([refusal, stopped("turn-1")]);

    watch.watching("turn-1");
    await settled();
    watch.watching("turn-2");
    await settled();

    assert.equal(seen.asks.length, 1, String(refusal.status));
    assert.equal(seen.interrupts, 0, String(refusal.status));
    assert.deepEqual(seen.pauses, []);
    assert.equal(watch.stopped("turn-1"), false, String(refusal.status));
  }
});

/**
 * The interrupt that would land on the turn after. The answer here is one
 * the plane had already sent when the session let go, so abandoning the
 * question does not unsend it.
 */
test("a turn let go of abandons its question, and a stop read after that interrupts nothing", async () => {
  let give = () => undefined;
  const sent = new Promise((resolve) => {
    give = resolve;
  });
  const { watch, seen } = watchOver([() => sent]);

  watch.watching("turn-1");
  await settled();
  assert.equal(seen.asks[0].transport.signal.aborted, false);
  watch.released();
  assert.equal(seen.asks[0].transport.signal.aborted, true);
  give(stopped("turn-1"));
  await settled();

  assert.equal(seen.interrupts, 0);
  assert.equal(seen.asks.length, 1);
  assert.deepEqual(seen.warned, []);
  assert.equal(watch.stopped("turn-1"), false);
});

test("a turn watched lets go of the one before it, and is the one asked after", async () => {
  const { watch, seen } = watchOver([(signal) => heldUntilLetGo(signal)]);

  watch.watching("turn-1");
  await settled();
  watch.watching("turn-2");
  await settled();

  assert.deepEqual(
    seen.asks.map(({ init, transport }) => [
      JSON.parse(init.body).turn,
      transport.signal.aborted,
    ]),
    [
      ["turn-1", true],
      ["turn-2", false],
    ],
  );
  assert.equal(seen.interrupts, 0);
  watch.released();
});

/**
 * The plane's answer to a live post is the same stop by another road, and
 * sooner where the turn is being written. It interrupts as the watch's own
 * answer does, and lets go of the question the watch still has in flight.
 */
test("a turn told as stopped is interrupted once, and its question is abandoned and not asked again", async () => {
  const { watch, seen } = watchOver([
    (signal) => heldUntilLetGo(signal),
    () => new Promise(() => undefined),
  ]);

  watch.watching("turn-1");
  await settled();
  watch.told("turn-1");
  await settled();

  assert.equal(seen.interrupts, 1);
  assert.deepEqual(seen.warned, ["turn turn-1 was stopped by its member\n"]);
  assert.equal(watch.stopped("turn-1"), true);
  assert.equal(seen.asks.length, 1);
  assert.equal(seen.asks[0].transport.signal.aborted, true);
  assert.deepEqual(seen.pauses, []);
});

test("a stop that arrives by both roads interrupts once, whichever is first", async () => {
  let give = () => undefined;
  const sent = new Promise((resolve) => {
    give = resolve;
  });
  const toldFirst = watchOver([() => sent]);
  toldFirst.watch.watching("turn-1");
  await settled();
  toldFirst.watch.told("turn-1");
  give(stopped("turn-1"));
  await settled();
  toldFirst.watch.told("turn-1");
  await settled();

  const answeredFirst = watchOver([stopped("turn-1")]);
  answeredFirst.watch.watching("turn-1");
  await settled();
  answeredFirst.watch.told("turn-1");
  await settled();

  for (const { seen } of [toldFirst, answeredFirst]) {
    assert.equal(seen.interrupts, 1);
    assert.deepEqual(seen.warned, ["turn turn-1 was stopped by its member\n"]);
    assert.equal(seen.asks.length, 1);
  }
});

/**
 * A post answered late names a turn the session has since let go of. The
 * turn after is the one the runtime would be interrupted in.
 */
test("a turn told as stopped that is not the one held interrupts nothing", async () => {
  const { watch, seen } = watchOver([(signal) => heldUntilLetGo(signal)]);

  watch.told("turn-1");
  watch.watching("turn-1");
  await settled();
  watch.told("turn-0");
  watch.released();
  watch.told("turn-1");
  watch.watching("turn-2");
  await settled();
  watch.told("turn-1");
  await settled();

  assert.equal(seen.interrupts, 0);
  assert.deepEqual(seen.warned, []);
  assert.equal(watch.stopped("turn-1"), false);
  assert.equal(watch.stopped("turn-2"), false);
  watch.released();
});

test("a watch the plane decided against still interrupts a turn told as stopped", async () => {
  const { watch, seen } = watchOver([answered(401)]);

  watch.watching("turn-1");
  await settled();
  watch.watching("turn-2");
  await settled();
  watch.told("turn-2");
  await settled();

  assert.equal(seen.asks.length, 1);
  assert.equal(seen.interrupts, 1);
  assert.equal(watch.stopped("turn-2"), true);
});

test("a runtime that cannot be interrupted is said, and raises into nothing", async () => {
  for (const failure of [new Error("the query is closed"), "closed"]) {
    const { watch, seen } = watchOver([stopped("turn-1")], {
      interrupt: async () => {
        throw failure;
      },
    });

    watch.watching("turn-1");
    await settled();

    assert.deepEqual(seen.warned, [
      "turn turn-1 was stopped by its member\n",
      `the runtime could not be interrupted: ${failure instanceof Error ? failure.message : failure}\n`,
    ]);
    assert.equal(seen.asks.length, 1);
  }
});

test("a turn told as stopped whose interrupt cannot be said raises into nothing", async () => {
  let interrupts = 0;
  const { watch } = watchOver([(signal) => heldUntilLetGo(signal)], {
    interrupt: async () => {
      interrupts += 1;
      throw new Error("the query is closed");
    },
    warn: () => {
      throw new Error("no stderr");
    },
  });

  watch.watching("turn-1");
  await settled();
  watch.told("turn-1");
  await settled();

  assert.equal(interrupts, 0);
  assert.equal(watch.stopped("turn-1"), true);
  watch.released();
});

test("a watch whose own pause fails asks nothing more and raises into nothing", async () => {
  const { watch, seen } = watchOver([answered(204)], {
    pause: async () => {
      throw new Error("no clock");
    },
  });

  watch.watching("turn-1");
  await settled();
  watch.watching("turn-2");
  await settled();

  assert.equal(seen.asks.length, 1);
  assert.equal(seen.interrupts, 0);
});

const threadFacts = {
  ...facts,
  kind: "Thread",
  capabilities: [...threadRoster],
};
const turnTwo = { ...turnOne, turn: "turn-2", ordinal: 2, input: "ask again" };
const init = { type: "system", subtype: "init", session_id: "runtime-1" };
const isStopAsk = ({ path }) => path === stopPath;
const settlementPaths = [
  sessionPlaneRoutes.turnAnswer.path,
  sessionPlaneRoutes.turnFailure.path,
];

/**
 * A runtime a session can interrupt: `script(index, interrupted)` is one
 * turn's messages, and `interrupted` a step that waits for the session's
 * interrupt, as a model that is still writing does.
 */
function interruptible(script) {
  const seen = { interrupts: [] };
  let turn = -1;
  let heard = () => undefined;
  const query = ({ prompt }) => {
    const stream = (async function* messages() {
      for await (const asked of prompt) {
        turn += 1;
        const interrupted = new Promise((resolve) => {
          heard = resolve;
        });
        for (const message of script(turn, () => interrupted, asked)) {
          if (typeof message === "function") await message();
          else yield message;
        }
      }
    })();
    stream.interrupt = async () => {
      seen.interrupts.push(turn);
      heard();
    };
    return stream;
  };
  return { seen, query };
}

/** A thread's session over `plane` and `runtime`, and what it settled each turn as. */
async function threadOver(plane, runtime, services = {}) {
  const warned = [];
  const code = await run({
    request: plane.request,
    requestOnce: plane.requestOnce,
    query: runtime.query,
    warn: (text) => warned.push(text),
    ...services,
  });
  return {
    code,
    warned,
    settlements: plane.calls
      .filter(({ path }) => settlementPaths.includes(path))
      .map(({ path, body }) => [path, body]),
    asked: plane.calls.filter(isStopAsk).map(({ body }) => body?.turn),
  };
}

const stoppedOnce = (stops) => (turn, signal) =>
  stops.includes(turn)
    ? { status: 200, body: { turn } }
    : heldUntilLetGo(signal);

/**
 * The stop end to end on the runner's side. The interrupted turn's failure is
 * posted, because the plane starts the attempt's idle clock on it, and the
 * plane's own suite is what holds that it keeps nothing of it.
 */
test("a thread's turn its member stops is interrupted, settled as the runtime ended it, and the session answers the turn after", async () => {
  const plane = planeOf(
    [turnOne, turnTwo],
    threadFacts,
    undefined,
    undefined,
    stoppedOnce(["turn-1"]),
  );
  const runtime = interruptible((turn, interrupted) =>
    turn === 0
      ? [init, interrupted, result("error_during_execution")]
      : [result("success", { result: "after" })],
  );

  const session = await threadOver(plane, runtime);

  assert.equal(session.code, 0);
  assert.deepEqual(runtime.seen.interrupts, [0]);
  assert.deepEqual(session.settlements, [
    [
      sessionPlaneRoutes.turnFailure.path,
      { turn: "turn-1", failure: "AgentFailed" },
    ],
    [sessionPlaneRoutes.turnAnswer.path, { turn: "turn-2", result: "after" }],
  ]);
  assert.deepEqual(session.asked, ["turn-1", "turn-2"]);
  assert.deepEqual(session.warned, ["turn turn-1 was stopped by its member\n"]);
});

test("a session that is not a thread asks nothing of a stop", async () => {
  for (const kind of [
    facts,
    { ...facts, kind: "Inquiry", capabilities: ["ProjectRead"], forkFrom: "l" },
  ]) {
    const plane = planeOf(
      [turnOne],
      kind,
      undefined,
      undefined,
      stoppedOnce(["turn-1"]),
    );
    const runtime = interruptible(() => [
      init,
      result("success", { result: "ok" }),
    ]);

    const session = await threadOver(plane, runtime);

    assert.equal(session.code, 0, kind.kind);
    assert.deepEqual(session.asked, [], kind.kind);
    assert.deepEqual(runtime.seen.interrupts, [], kind.kind);
  }
});

/**
 * The watch is let go of at the result, not at the settlement behind the
 * drain: a stop the plane answers while the session drains would otherwise
 * interrupt a runtime that holds no turn, or the turn handed over next.
 */
test("a stop the plane answers once the turn's result is read interrupts nothing, and the turn is answered", async () => {
  let give = () => undefined;
  const sent = new Promise((resolve) => {
    give = resolve;
  });
  const plane = planeOf(
    [turnOne, turnTwo],
    threadFacts,
    undefined,
    undefined,
    (turn, signal) =>
      turn === "turn-1"
        ? sent.then(() => ({ status: 200, body: { turn } }))
        : heldUntilLetGo(signal),
  );
  const runtime = interruptible((turn) =>
    turn === 0
      ? [init, result("success", { result: "whole" }), give, settled]
      : [result("success", { result: "after" })],
  );

  const session = await threadOver(plane, runtime);

  assert.equal(session.code, 0);
  assert.deepEqual(runtime.seen.interrupts, []);
  assert.deepEqual(
    session.settlements.map(([, body]) => body.result),
    ["whole", "after"],
  );
  assert.deepEqual(session.warned, []);
});

/** The pauses of a session that are a drain's: the one wait as long as the bound the suites' task names. */
const drains = (pauses) =>
  pauses.filter(
    (milliseconds) =>
      milliseconds > task.bounds.resultDrainMs - 10 &&
      milliseconds <= task.bounds.resultDrainMs,
  ).length;

/**
 * The drain is what a member who stopped a turn would wait out before the
 * turn after began. The second session is the same two turns with neither
 * stopped, which is what shows a drain is counted where there is one.
 */
test("a turn its member stopped is settled at its result, and a turn that ran to its end is still drained past", async () => {
  const session = async (stops, first) => {
    const pauses = [];
    const runtime = interruptible((turn, interrupted) =>
      turn === 0
        ? first(interrupted)
        : [result("success", { result: "after" })],
    );
    const ran = await threadOver(
      planeOf(
        [turnOne, turnTwo],
        threadFacts,
        undefined,
        undefined,
        stoppedOnce(stops),
      ),
      runtime,
      {
        liveBounds: { postGapMsMin: 3 },
        pause: (milliseconds) => {
          pauses.push(milliseconds);
          return wait(milliseconds, undefined, { ref: false });
        },
      },
    );
    return { ...ran, drains: drains(pauses) };
  };

  const stoppedFirst = await session(["turn-1"], (interrupted) => [
    init,
    interrupted,
    result("error_during_execution"),
  ]);
  const neither = await session([], () => [
    init,
    result("success", { result: "whole" }),
  ]);

  assert.equal(stoppedFirst.code, 0);
  assert.deepEqual(
    stoppedFirst.settlements.map(([, body]) => body.turn),
    ["turn-1", "turn-2"],
  );
  assert.equal(stoppedFirst.drains, 1);
  assert.equal(neither.code, 0);
  assert.equal(neither.drains, 2);
});

const mirrorError = {
  type: "system",
  subtype: "mirror_error",
  error: "gave up",
};

/**
 * What a turn wrote is mirrored before its result is handed on, an
 * interrupted turn's too, so a batch of it the store refused is reported
 * ahead of that result. That refusal is still the stopped turn's with no
 * drain behind its result.
 */
test("a store refusal ahead of an interrupted turn's result fails that turn and stops the session before the turn after", async () => {
  const plane = planeOf(
    [turnOne, turnTwo],
    threadFacts,
    undefined,
    undefined,
    stoppedOnce(["turn-1"]),
  );
  const runtime = interruptible((turn, interrupted) =>
    turn === 0
      ? [init, interrupted, mirrorError, result("error_during_execution")]
      : [result("success", { result: "after" })],
  );

  const session = await threadOver(plane, runtime);

  assert.equal(session.code, 1);
  assert.deepEqual(session.settlements, [
    [
      sessionPlaneRoutes.turnFailure.path,
      { turn: "turn-1", failure: "StoreRefused" },
    ],
  ]);
  assert.deepEqual(session.asked, ["turn-1"]);
});

/**
 * What the skipped drain costs, held so that it is not taken for an accident.
 * What the runtime writes on its own clock is mirrored behind a result, the
 * title it gives a session among it, and a refusal of that is reported behind
 * the result: the drain makes it the turn's own, and with no drain it is the
 * next turn's, as a refusal later than the drain is after any turn.
 */
test("a store refusal behind a stopped turn's result is charged to the turn after, which runs to its result and ends the session", async () => {
  const session = async (stops, first) => {
    const ran = [];
    const runtime = interruptible((turn, interrupted) => {
      ran.push(turn);
      return turn === 0
        ? [init, ...first(interrupted), mirrorError]
        : [result("success", { result: "after" })];
    });
    const over = await threadOver(
      planeOf(
        [turnOne, turnTwo],
        threadFacts,
        undefined,
        undefined,
        stoppedOnce(stops),
      ),
      runtime,
    );
    return { code: over.code, ran, settled: over.settlements };
  };

  const stoppedFirst = await session(["turn-1"], (interrupted) => [
    interrupted,
    result("error_during_execution"),
  ]);
  const neither = await session([], () => [
    result("success", { result: "whole" }),
  ]);

  assert.deepEqual(stoppedFirst, {
    code: 1,
    ran: [0, 1],
    settled: [
      [
        sessionPlaneRoutes.turnFailure.path,
        { turn: "turn-1", failure: "AgentFailed" },
      ],
      [
        sessionPlaneRoutes.turnFailure.path,
        { turn: "turn-2", failure: "StoreRefused" },
      ],
    ],
  });
  assert.deepEqual(neither, {
    code: 1,
    ran: [0],
    settled: [
      [
        sessionPlaneRoutes.turnFailure.path,
        { turn: "turn-1", failure: "StoreRefused" },
      ],
    ],
  });
});

/**
 * The stop of a turn that is being written, heard from a post and not from
 * the watch, whose question the plane holds throughout. The turn after is
 * written too and nobody stops it, so its posts are answered as taken.
 */
test("a thread's turn whose live post is answered as stopped is interrupted, and the turn after is answered", async () => {
  const posts = [];
  const plane = planeOf(
    [turnOne, turnTwo],
    threadFacts,
    undefined,
    undefined,
    undefined,
    ({ turn }) => {
      posts.push(turn);
      return turn === "turn-1"
        ? { status: 200, body: { turn } }
        : { status: 204 };
    },
  );
  const written = [
    streamed(messageStart("message-1")),
    streamed(textStart(0)),
    streamed(textDelta(0, "kestrels hover")),
  ];
  const heardWithin = 500;
  const runtime = interruptible((turn, interrupted) =>
    turn === 0
      ? [
          init,
          ...written,
          () => Promise.race([interrupted(), wait(heardWithin)]),
          result("error_during_execution"),
        ]
      : [...written, settled, result("success", { result: "after" })],
  );

  const session = await threadOver(plane, runtime, {
    liveBounds: { postGapMsMin: 0 },
  });

  assert.equal(session.code, 0);
  assert.deepEqual(runtime.seen.interrupts, [0]);
  assert.deepEqual(session.warned, ["turn turn-1 was stopped by its member\n"]);
  assert.deepEqual(session.settlements, [
    [
      sessionPlaneRoutes.turnFailure.path,
      { turn: "turn-1", failure: "AgentFailed" },
    ],
    [sessionPlaneRoutes.turnAnswer.path, { turn: "turn-2", result: "after" }],
  ]);
  assert.equal(posts[0], "turn-1");
  assert.equal(posts.filter((turn) => turn === "turn-1").length, 1);
  assert.ok(posts.includes("turn-2"));
});

/**
 * A session can end with a turn still watched: its runtime died before the
 * turn's result. The question in flight is one the plane would hold, and
 * answer, for a session that is no longer there.
 */
test("a session that ends inside a turn lets go of the turn's watch", async () => {
  const signals = [];
  const plane = planeOf(
    [turnOne],
    threadFacts,
    undefined,
    undefined,
    (_turn, signal) => {
      signals.push(signal);
      return heldUntilLetGo(signal);
    },
  );
  const runtime = interruptible(() => [
    init,
    settled,
    () => {
      throw new Error("the runtime died");
    },
  ]);

  const session = await threadOver(plane, runtime);

  assert.equal(session.code, 1);
  assert.deepEqual(session.warned, ["the runtime died\n"]);
  assert.deepEqual(
    signals.map((signal) => signal.aborted),
    [true],
  );
});

/**
 * The session over a condition a proxy answers: the plane is the suites' own
 * from the second question on, and the first is answered for it through the
 * transport the watch is given by something between the two.
 */
test("one condition answered to the watch leaves the stop of a later turn heard", async () => {
  const plane = planeOf(
    [turnOne, turnTwo],
    threadFacts,
    undefined,
    undefined,
    stoppedOnce(["turn-2"]),
  );
  let conditions = 0;
  const requestOnce = (asked, held, path, init, transport) => {
    if (path !== stopPath || conditions > 0)
      return plane.requestOnce(asked, held, path, init, transport);
    conditions += 1;
    return sessionRequestOnce(asked, held, path, init, {
      ...transport,
      fetch: async () => new globalThis.Response(null, { status: 429 }),
    });
  };
  const heardWithin = 200;
  const runtime = interruptible((turn, interrupted) =>
    turn === 0
      ? [init, settled, settled, result("success", { result: "whole" })]
      : [
          () => Promise.race([interrupted(), wait(heardWithin)]),
          result("error_during_execution"),
        ],
  );

  const session = await threadOver(plane, runtime, { requestOnce });

  assert.equal(conditions, 1);
  assert.deepEqual(runtime.seen.interrupts, [1]);
  assert.deepEqual(session.settlements, [
    [sessionPlaneRoutes.turnAnswer.path, { turn: "turn-1", result: "whole" }],
    [
      sessionPlaneRoutes.turnFailure.path,
      { turn: "turn-2", failure: "AgentFailed" },
    ],
  ]);
  assert.equal(session.code, 0);
});

/**
 * No failure of the watch may fail, delay or fence a turn. Each way the route
 * can fail leaves the session exiting as it did and settling what it settled.
 */
test("a watch that fails, however it fails, leaves the turn answered as it was", async () => {
  const answering = () =>
    interruptible(() => [init, result("success", { result: "ok" })]);
  const healthy = await threadOver(
    planeOf([turnOne], threadFacts),
    answering(),
  );
  const refusing = (status) => ({
    plane: planeOf([turnOne], threadFacts, (path) =>
      path === stopPath ? status : undefined,
    ),
  });
  const through = (requestOnce) => ({
    plane: planeOf([turnOne], threadFacts),
    services: { requestOnce },
  });
  const failures = {
    "a plane that holds nothing": refusing(204),
    "a refused question": refusing(400),
    "a fenced session": refusing(401),
    "a refused release": refusing(409),
    "a transport that raises": through(() => {
      throw new Error("no transport");
    }),
    "an unreachable plane": through(async () => {
      throw new Error("unreachable");
    }),
    "a question never answered": through(() => new Promise(() => undefined)),
  };

  assert.equal(healthy.code, 0);
  assert.deepEqual(healthy.settlements, [
    [sessionPlaneRoutes.turnAnswer.path, { turn: "turn-1", result: "ok" }],
  ]);
  for (const [named, { plane, services }] of Object.entries(failures)) {
    const runtime = answering();

    const failed = await threadOver(plane, runtime, services);

    assert.equal(failed.code, healthy.code, named);
    assert.deepEqual(failed.settlements, healthy.settlements, named);
    assert.deepEqual(runtime.seen.interrupts, [], named);
  }
});
