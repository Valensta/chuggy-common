import assert from "node:assert/strict";
import test from "node:test";

import {
  workerContractHeader,
  workerContractRelease,
} from "@chuggy/worker-contract/workerContract";
import {
  assignmentOutcomeSchema,
  workerPoolEvidenceCharsMax,
  workerRunnerPollWaitHeader,
} from "@chuggy/worker-contract/workerPool";

import {
  workerPoolClaimWaitMs,
  workerPoolClientPass,
  workerPoolClientRun,
  workerPoolUpdateBackoffMs,
  workerPoolUpdating,
} from "./poolLoop.mjs";
import { poolPlaneClient } from "./poolPlane.mjs";

const settings = { concurrencyMax: 1, outageBackoffMs: 1, passesMax: 1 };

function assignment(named) {
  return {
    assignment: named,
    capabilities: [],
    cpuMillis: 500,
    memoryMib: 512,
    deadlineSecs: 60,
    callbackUrl: "https://plane.invalid/v1/ticket-execution",
    bearer: `bearer-${named}`,
  };
}

/** The workloads a backend holds, each named and of `kind`. */
function holding(kind, ...named) {
  return named.map((assignment) => ({ assignment, kind }));
}

/** A session the plane offers, which always names its image. */
function sessionOffer(named) {
  return { ...assignment(named), image: "registry.invalid/session:1" };
}

/** A backend holding nothing and placing everything, which every case narrows from. */
const idle = {
  place: async () => ({ placed: "Placed" }),
  stop: async () => ({ stopped: "Stopped" }),
  held: async () => [],
  ended: async () => [],
};

/** What a poll answers when it offers `assignments` and `sessions` and asks for `stop`. */
function reconciled(assignments = [], stop = [], sessions = []) {
  return { polled: "Reconciled", assignments, sessions, stop };
}

/** A plane with nothing to say, answered by the poll that says so. */
const quiet = {
  poll: async () => reconciled(),
  settle: async () => "Settled",
};

/** A plane offering `offered` on every poll and recording each outcome it is told. */
function offering(offered, settled = "Settled") {
  const posted = [];
  return {
    posted,
    plane: {
      poll: async () => reconciled(offered),
      settle: async (_token, _assignment, outcome) => {
        posted.push(outcome.outcome);
        return settled;
      },
    },
  };
}

function client(parts) {
  return {
    tokens: {
      acquire: async () =>
        parts.token ?? { acquired: "Token", token: "pool-token" },
      invalidate: () => undefined,
    },
    plane: quiet,
    jobs: { end: async () => "Ended" },
    sessions: { end: async () => "Ended" },
    backend: idle,
    settings,
    ...parts,
  };
}

/** A tokens port minting a fresh token per acquire and recording what it is told to discard. */
function counting() {
  const minted = [];
  const invalidated = [];
  return {
    minted,
    invalidated,
    tokens: {
      acquire: async () => {
        const token = `pool-token-${String(minted.length + 1)}`;
        minted.push(token);
        return { acquired: "Token", token };
      },
      invalidate: (token) => {
        invalidated.push(token);
      },
    },
  };
}

/** A backend placing everything, counting each placement. */
function placing(held = []) {
  const counted = { placed: 0 };
  return {
    counted,
    backend: {
      ...idle,
      held: async () => held,
      place: async () => {
        counted.placed += 1;
        return { placed: "Placed" };
      },
    },
  };
}

test("what the pool holds is read from the backend rather than remembered", async () => {
  const sent = [];
  const passed = await workerPoolClientPass(
    client({
      backend: {
        ...idle,
        held: async () => [
          ...holding("Job", "running-one"),
          ...holding("Session", "session-one"),
        ],
      },
      plane: {
        ...quiet,
        poll: async (_token, held) => {
          sent.push([...held]);
          return reconciled();
        },
      },
    }),
  );
  assert.deepEqual(sent, [["running-one", "session-one"]]);
  assert.equal(passed.passed, "Reconciled");
});

/**
 * Each refusal is matched whole, so it names the entry by its keys and prints
 * nothing it holds: a backend's record of an attempt carries that attempt's
 * bearer.
 */
test("a backend holding a workload by name alone, or as no kind the loop knows, fails the pass before it polls", async () => {
  const bearer = "chgb_0123456789abcdef0123456789abcdef";
  for (const [held, refusal] of [
    [[bearer], "an entry of type string, which names no assignment"],
    [[null], "an entry of type null, which names no assignment"],
    [[{ kind: "Job" }], "an entry keyed kind, which names no assignment"],
    [
      [{ ...holding("Job", "")[0], bearer }],
      "an entry keyed assignment, bearer, kind, which names no assignment",
    ],
    [
      [{ ...holding("job", "running-one")[0], bearer }],
      "an entry keyed assignment, bearer, kind, whose kind is no workload's",
    ],
    [
      [...holding("Session", "session-one"), { assignment: "running-one" }],
      "an entry keyed assignment, whose kind is no workload's",
    ],
  ]) {
    const polled = [];
    const told = [];
    await assert.rejects(
      workerPoolClientPass(
        client({
          backend: {
            ...idle,
            held: async () => held,
            ended: async () => [
              { kind: "Job", job: assignment("crashed"), why: "exited" },
            ],
          },
          jobs: { end: async (ended) => told.push(ended) },
          plane: {
            ...quiet,
            poll: async (...asked) => {
              polled.push(asked);
              return reconciled([assignment("offered")]);
            },
          },
        }),
      ),
      { name: "TypeError", message: `a backend held ${refusal}` },
    );
    assert.deepEqual([polled, told], [[], []]);
  }
});

test("a poll asks for the room left under the ceiling, and none at it", async () => {
  const asked = [];
  const plane = {
    ...quiet,
    poll: async (_token, _held, wanted) => {
      asked.push(wanted);
      return reconciled();
    },
  };
  for (const [concurrencyMax, held] of [
    [3, ["one"]],
    [3, ["one", "two", "three"]],
    [1, ["one", "two"]],
  ])
    await workerPoolClientPass(
      client({
        settings: { ...settings, concurrencyMax },
        backend: { ...idle, held: async () => holding("Job", ...held) },
        plane,
      }),
    );
  assert.deepEqual(asked, [2, 0, 0]);
});

test("a pool at its own ceiling polls for none, and places nothing it is offered anyway", async () => {
  const asked = [];
  const placer = placing(holding("Job", "running-one"));
  const offer = offering([assignment("offered")]);
  const passed = await workerPoolClientPass(
    client({
      backend: placer.backend,
      plane: {
        ...offer.plane,
        poll: async (token, held, wanted) => {
          asked.push(wanted);
          return offer.plane.poll(token, held, wanted);
        },
      },
    }),
  );
  assert.deepEqual(asked, [0]);
  assert.equal(placer.counted.placed, 0);
  assert.deepEqual(offer.posted, ["Unavailable"]);
  assert.deepEqual(passed, {
    passed: "Reconciled",
    placed: 0,
    stopped: 0,
    refused: 0,
    ended: 0,
  });
});

test("a stopped assignment frees the room the same pass places into", async () => {
  const stopped = [];
  const passed = await workerPoolClientPass(
    client({
      backend: {
        ...idle,
        held: async () => holding("Job", "going"),
        stop: async (named) => {
          stopped.push(named);
          return { stopped: "Stopped" };
        },
      },
      plane: {
        ...quiet,
        poll: async () => reconciled([assignment("offered")], ["going"]),
      },
    }),
  );
  assert.deepEqual(stopped, ["going"]);
  assert.deepEqual(passed, {
    passed: "Reconciled",
    placed: 1,
    stopped: 1,
    refused: 0,
    ended: 0,
  });
});

/** A backend holding `held` and recording each placement with the kind it was placed as. */
function placingKinds(held) {
  const placed = [];
  return {
    placed,
    backend: {
      ...idle,
      held: async () => held,
      place: async (offered, kind) => {
        placed.push([offered.assignment, kind]);
        return { placed: "Placed" };
      },
    },
  };
}

/** A plane offering `jobs` and `sessions` once, recording each poll's two rooms and each settlement. */
function offeringKinds(jobs, sessions, stop = []) {
  const rooms = [];
  const posted = [];
  return {
    rooms,
    posted,
    plane: {
      poll: async (_token, _held, wanted, wantedSessions) => {
        rooms.push({ wanted, wantedSessions });
        return reconciled(jobs, stop, sessions);
      },
      settle: async (_token, named, outcome) => {
        posted.push([named, outcome.outcome]);
        return "Settled";
      },
    },
  };
}

test("each kind's room is asked against its own ceiling, whatever the other kind holds", async () => {
  const rooms = [];
  for (const held of [
    [...holding("Job", "j1"), ...holding("Session", "s1", "s2")],
    holding("Job", "j1", "j2", "j3"),
    holding("Session", "s1", "s2", "s3"),
  ]) {
    const offer = offeringKinds([], []);
    await workerPoolClientPass(
      client({
        settings: { ...settings, concurrencyMax: 3, sessionsMax: 2 },
        backend: { ...idle, held: async () => held },
        plane: offer.plane,
      }),
    );
    rooms.push(...offer.rooms);
  }
  assert.deepEqual(rooms, [
    { wanted: 2, wantedSessions: 0 },
    { wanted: 0, wantedSessions: 2 },
    { wanted: 3, wantedSessions: 0 },
  ]);
});

test("sessions are placed as sessions against their own ceiling, and a full job ceiling takes none of their room", async () => {
  const placer = placingKinds(holding("Job", "running"));
  const offer = offeringKinds(
    [assignment("job")],
    ["one", "two", "three"].map(sessionOffer),
  );
  const passed = await workerPoolClientPass(
    client({
      settings: { ...settings, concurrencyMax: 1, sessionsMax: 2 },
      backend: placer.backend,
      plane: offer.plane,
    }),
  );
  assert.deepEqual(offer.rooms, [{ wanted: 0, wantedSessions: 2 }]);
  assert.deepEqual(placer.placed, [
    ["one", "Session"],
    ["two", "Session"],
  ]);
  assert.deepEqual(offer.posted, [
    ["job", "Unavailable"],
    ["one", "Accepted"],
    ["two", "Accepted"],
    ["three", "Unavailable"],
  ]);
  assert.equal(passed.placed, 2);
});

test("a pool whose job ceiling is 0 asks for no job and places none it is offered, while it takes sessions", async () => {
  const placer = placingKinds([]);
  const offer = offeringKinds([assignment("job")], [sessionOffer("session")]);
  await workerPoolClientPass(
    client({
      settings: { ...settings, concurrencyMax: 0, sessionsMax: 1 },
      backend: placer.backend,
      plane: offer.plane,
    }),
  );
  assert.deepEqual(offer.rooms, [{ wanted: 0, wantedSessions: 1 }]);
  assert.deepEqual(placer.placed, [["session", "Session"]]);
  assert.deepEqual(offer.posted, [
    ["job", "Unavailable"],
    ["session", "Accepted"],
  ]);
});

test("a backend that takes no job is asked for none after its read and places none it is offered, while it takes sessions, and is asked again once it takes them", async () => {
  const placer = placingKinds([]);
  const offer = offeringKinds([assignment("job")], [sessionOffer("session")]);
  const read = { taken: true };
  const backend = {
    ...placer.backend,
    held: async () => {
      read.taken = !read.taken;
      return [];
    },
    jobsTaken: () => read.taken,
  };
  const pooled = client({
    settings: { ...settings, sessionsMax: 1 },
    backend,
    plane: offer.plane,
  });
  await workerPoolClientPass(pooled);
  await workerPoolClientPass(pooled);
  assert.deepEqual(offer.rooms, [
    { wanted: 0, wantedSessions: 1 },
    { wanted: 1, wantedSessions: 1 },
  ]);
  assert.deepEqual(placer.placed, [
    ["session", "Session"],
    ["job", "Job"],
    ["session", "Session"],
  ]);
  assert.deepEqual(offer.posted.slice(0, 2), [
    ["job", "Unavailable"],
    ["session", "Accepted"],
  ]);
});

/**
 * A pool whose backend keeps a budget and a claim, and whose plane claims by
 * room unless told not to, every call it makes recorded in order: each read
 * answering the next of `reads`, the last one again once they run out, and
 * each poll the next of `answers`.
 *
 * @param {{reads?: {held?: object[], room?: object, taken?: boolean}[], answers?: object[], busy?: boolean, byRoom?: boolean, place?: () => Promise<object>}} [scenario]
 */
function claimingRoom(scenario = {}) {
  const reads = scenario.reads ?? [{}];
  const answers = [...(scenario.answers ?? [])];
  const events = [];
  const takenAsked = [];
  let read = -1;
  const now = () => reads[Math.min(read, reads.length - 1)];
  const backend = {
    ...idle,
    held: async () => {
      read += 1;
      events.push("held");
      return now().held ?? [];
    },
    jobsTaken: (byRoom) => {
      takenAsked.push(byRoom);
      return now().taken ?? true;
    },
    memoryRoom: () => now().room ?? { roomMib: 4096, ceilingMib: 12288 },
    place: async (offered) => {
      events.push(`place ${offered.assignment}`);
      return scenario.place === undefined
        ? { placed: "Placed" }
        : scenario.place();
    },
    claimed: async () => {
      events.push(scenario.busy === true ? "claim busy" : "claim");
      return scenario.busy === true
        ? undefined
        : async () => {
            events.push("release");
          };
    },
  };
  const plane = {
    claimsByRoom: () => scenario.byRoom ?? true,
    poll: async (_token, _held, wanted, wantedSessions, terms) => {
      events.push({ poll: [wanted, wantedSessions], terms });
      return answers.shift() ?? reconciled();
    },
    settle: async (_token, named, outcome) => {
      events.push(`settle ${named} ${outcome.outcome}`);
      return "Settled";
    },
  };
  return {
    events,
    takenAsked,
    pooled: client({
      settings: { ...settings, concurrencyMax: 2, sessionsMax: 1 },
      backend,
      plane,
    }),
  };
}

/** A reconciliation saying whether a job waits that fits the poll's room. */
const waiting = (jobsWaiting) => ({ ...reconciled(), jobsWaiting });

const room = { roomMib: 4096, ceilingMib: 12288 };

test("against a plane that claims by room, a pool asks for no job naming its room, and one told a job waits takes the claim, reads again, asks at once for what that read has room for, places it and lets the claim go", async () => {
  const { events, takenAsked, pooled } = claimingRoom({
    reads: [{}, { room: { roomMib: 3072, ceilingMib: 12288 } }],
    answers: [waiting(true), reconciled([assignment("job")])],
  });
  const passed = await workerPoolClientPass(pooled);
  assert.deepEqual(events, [
    "held",
    { poll: [0, 1], terms: { memory: room } },
    "claim",
    "held",
    {
      poll: [2, 0],
      terms: { memory: { roomMib: 3072, ceilingMib: 12288 }, waitSecs: 0 },
    },
    "place job",
    "settle job Accepted",
    "release",
  ]);
  assert.deepEqual(takenAsked, [true, true]);
  assert.deepEqual(passed, {
    passed: "Reconciled",
    placed: 1,
    stopped: 0,
    refused: 0,
    ended: 0,
  });
});

test("a pool told no job waits takes no claim", async () => {
  const { events, pooled } = claimingRoom({ answers: [waiting(false)] });
  await workerPoolClientPass(pooled);
  assert.deepEqual(events, ["held", { poll: [0, 1], terms: { memory: room } }]);
});

test("a pool that finds the claim held asks for no more, and its run waits before it polls again", async () => {
  const { events, pooled } = claimingRoom({
    busy: true,
    answers: [waiting(true), waiting(true), waiting(true)],
  });
  assert.deepEqual(await workerPoolClientPass(pooled), {
    passed: "Reconciled",
    placed: 0,
    stopped: 0,
    refused: 0,
    ended: 0,
    claim: "Busy",
  });
  assert.deepEqual(events, [
    "held",
    { poll: [0, 1], terms: { memory: room } },
    "claim busy",
  ]);
  const slept = [];
  await workerPoolClientRun(
    { ...pooled, settings: { ...pooled.settings, passesMax: 2 } },
    async (ms) => {
      slept.push(ms);
    },
  );
  assert.deepEqual(slept, [workerPoolClaimWaitMs, workerPoolClaimWaitMs]);
});

test("a claim whose read leaves no room under the ceiling, or takes no job, asks for nothing, lets the claim go and is empty", async () => {
  for (const second of [
    { held: holding("Job", "one", "two") },
    { taken: false },
  ]) {
    const { events, pooled } = claimingRoom({
      reads: [{}, second],
      answers: [waiting(true)],
    });
    assert.equal((await workerPoolClientPass(pooled)).claim, "Empty");
    assert.deepEqual(events, [
      "held",
      { poll: [0, 1], terms: { memory: room } },
      "claim",
      "held",
      "release",
    ]);
  }
});

test("a claim given no job, or only jobs it refuses, is empty, and its run waits before it polls again", async () => {
  const { events, pooled } = claimingRoom({
    answers: [
      waiting(true),
      waiting(true),
      waiting(true),
      reconciled([assignment("job")]),
    ],
    place: async () => ({ placed: "Refused", evidence: "too large" }),
  });
  assert.deepEqual(await workerPoolClientPass(pooled), {
    passed: "Reconciled",
    placed: 0,
    stopped: 0,
    refused: 0,
    ended: 0,
    claim: "Empty",
  });
  assert.equal(events.at(-1), "release");
  const slept = [];
  await workerPoolClientRun(
    { ...pooled, settings: { ...pooled.settings, passesMax: 1 } },
    async (ms) => {
      slept.push(ms);
    },
  );
  assert.deepEqual(slept, [workerPoolClaimWaitMs]);
  assert.ok(events.includes("settle job Refused"));
});

test("a claim whose poll is not reconciled ends the pass, and lets the claim go", async () => {
  const { events, pooled } = claimingRoom({
    answers: [
      waiting(true),
      { polled: "Unavailable", evidence: "the plane could not be reached" },
    ],
  });
  assert.deepEqual(await workerPoolClientPass(pooled), {
    passed: "Unavailable",
    evidence: "the plane could not be reached",
  });
  assert.equal(events.at(-1), "release");
});

test("the claim goes only once each job placed under it has been answered, which is once it holds its memory", async () => {
  let answer;
  const placedAnswered = new Promise((resolve) => {
    answer = resolve;
  });
  const { events, pooled } = claimingRoom({
    answers: [waiting(true), reconciled([assignment("job")])],
    place: () => placedAnswered,
  });
  const passing = workerPoolClientPass(pooled);
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  assert.equal(events.at(-1), "place job");
  answer({ placed: "Placed" });
  await passing;
  assert.deepEqual(events.slice(-3), [
    "place job",
    "settle job Accepted",
    "release",
  ]);
});

test("against a plane that does not claim by room, or with a backend keeping no claim, a pool asks for jobs as it always has, naming its room, and takes no claim", async () => {
  const old = claimingRoom({
    byRoom: false,
    answers: [waiting(true)],
  });
  await workerPoolClientPass(old.pooled);
  assert.deepEqual(old.events, [
    "held",
    { poll: [2, 1], terms: { memory: room } },
  ]);
  assert.deepEqual(old.takenAsked, [false]);

  const unclaimed = claimingRoom({ answers: [waiting(true)] });
  await workerPoolClientPass({
    ...unclaimed.pooled,
    backend: { ...unclaimed.pooled.backend, claimed: undefined },
  });
  assert.deepEqual(unclaimed.events, [
    "held",
    { poll: [2, 1], terms: { memory: room } },
  ]);
  assert.deepEqual(unclaimed.takenAsked, [false]);
});

/** What a plane sends for `reconciliation`: every field but `polled`. */
function answerBody(reconciliation) {
  const body = { ...reconciliation };
  delete body.polled;
  return body;
}

/**
 * A plane client as a runner builds one, answered by a plane naming
 * `release`: each poll with the next of `answers`, nothing waiting once they
 * run out, and each settlement as taken. Each poll's `wanted` and the wait it
 * names are recorded.
 *
 * @param {string} release
 * @param {object[]} answers
 */
function planeNaming(release, answers) {
  const polls = [];
  const plane = poolPlaneClient(
    {
      baseUrl: "https://pool-plane.invalid",
      pollTimeoutMs: 1_000,
      settleTimeoutMs: 1_000,
    },
    async (url, init) => {
      const headers = { [workerContractHeader]: release };
      if (init.method !== "GET")
        return new globalThis.Response(null, { status: 204, headers });
      polls.push([
        new globalThis.URL(String(url)).searchParams.get("wanted"),
        init.headers[workerRunnerPollWaitHeader],
      ]);
      const answer = answers.shift() ?? reconciled();
      return new globalThis.Response(JSON.stringify(answerBody(answer)), {
        status: 200,
        headers,
      });
    },
  );
  return { plane, polls };
}

test("a pool keeping a claim asks a plane that has not yet said whether it claims by room for no job, to be answered at once, and claims under the claim what it then says waits", async () => {
  const { events, pooled } = claimingRoom();
  const { plane, polls } = planeNaming(workerContractRelease, [
    waiting(true),
    { ...reconciled([assignment("job")]), jobsWaiting: false },
  ]);
  const fresh = { ...pooled, plane };
  assert.equal((await workerPoolClientPass(fresh)).placed, 1);
  await workerPoolClientPass(fresh);
  assert.deepEqual(polls, [
    ["0", "0"],
    ["2", "0"],
    ["0", undefined],
  ]);
  assert.deepEqual(events, [
    "held",
    "claim",
    "held",
    "place job",
    "release",
    "held",
  ]);
});

test("a pool keeping a claim whose first answer shows the plane does not claim by room asks it for jobs by count in the same pass, as such a plane's gate allows, and takes no claim", async () => {
  const { events, takenAsked, pooled } = claimingRoom();
  const { plane, polls } = planeNaming("1.20.0", [
    reconciled(),
    reconciled([assignment("job")]),
  ]);
  const fresh = { ...pooled, plane };
  assert.equal((await workerPoolClientPass(fresh)).placed, 1);
  await workerPoolClientPass(fresh);
  assert.deepEqual(polls, [
    ["0", "0"],
    ["2", undefined],
    ["2", undefined],
  ]);
  assert.deepEqual(events, ["held", "held", "place job", "held"]);
  assert.deepEqual(takenAsked, [true, false, false]);

  const gated = claimingRoom({ reads: [{}, { taken: false }] });
  const old = planeNaming("1.20.0", []);
  await workerPoolClientPass({ ...gated.pooled, plane: old.plane });
  assert.deepEqual(old.polls, [["0", "0"]]);
});

test("a draining pool told a job waits takes no claim, and one finding the plane does not claim by room asks it for no job", async () => {
  const draining = {
    draining: () => true,
    restart: () => undefined,
    named: async () => {},
  };
  const { events, pooled } = claimingRoom({ answers: [waiting(true)] });
  await workerPoolClientPass(pooled, draining);
  assert.deepEqual(events, [
    "held",
    { poll: [0, 0], terms: { memory: { roomMib: 0, ceilingMib: 12288 } } },
  ]);

  const unknown = claimingRoom();
  const old = planeNaming("1.20.0", []);
  await workerPoolClientPass({ ...unknown.pooled, plane: old.plane }, draining);
  assert.deepEqual(old.polls, [["0", "0"]]);
});

test("a pool that takes no job, or holds its ceiling of jobs, names an empty room beside its ceiling, and a backend keeping no budget names neither", async () => {
  for (const read of [
    { taken: false },
    { held: holding("Job", "one", "two") },
  ]) {
    const { events, pooled } = claimingRoom({ reads: [read] });
    await workerPoolClientPass(pooled);
    assert.deepEqual(events[1], {
      poll: [0, 1],
      terms: { memory: { roomMib: 0, ceilingMib: 12288 } },
    });
  }
  const { events, pooled } = claimingRoom();
  await workerPoolClientPass({
    ...pooled,
    backend: { ...pooled.backend, memoryRoom: undefined },
  });
  assert.deepEqual(events[1], { poll: [0, 1], terms: {} });
});

test("a pool that names no session ceiling asks for none and places none it is offered", async () => {
  const placer = placingKinds([]);
  const offer = offeringKinds([assignment("job")], [sessionOffer("session")]);
  await workerPoolClientPass(
    client({ backend: placer.backend, plane: offer.plane }),
  );
  assert.deepEqual(offer.rooms, [{ wanted: 1, wantedSessions: 0 }]);
  assert.deepEqual(placer.placed, [["job", "Job"]]);
  assert.deepEqual(offer.posted, [
    ["job", "Accepted"],
    ["session", "Unavailable"],
  ]);
});

test("a stopped session frees a session's room this pass, and never a job's", async () => {
  const placer = placingKinds([
    ...holding("Job", "job-running"),
    ...holding("Session", "session-going"),
  ]);
  const offer = offeringKinds(
    [assignment("job")],
    [sessionOffer("session")],
    ["session-going"],
  );
  await workerPoolClientPass(
    client({
      settings: { ...settings, concurrencyMax: 1, sessionsMax: 1 },
      backend: placer.backend,
      plane: offer.plane,
    }),
  );
  assert.deepEqual(placer.placed, [["session", "Session"]]);
  assert.deepEqual(offer.posted, [
    ["job", "Unavailable"],
    ["session", "Accepted"],
  ]);
});

test("an ended session is told to the session plane and an ended job to the job plane, each once", async () => {
  const jobEnd = {
    kind: "Job",
    job: assignment("job"),
    why: "its container exited with status 1",
  };
  const sessionEnd = {
    kind: "Session",
    session: assignment("session"),
    phase: "Succeeded",
  };
  const told = [];
  const passed = await workerPoolClientPass(
    client({
      backend: { ...idle, ended: async () => [jobEnd, sessionEnd] },
      jobs: {
        end: async (ended) => {
          told.push(["jobs", ended]);
          return "Ended";
        },
      },
      sessions: {
        end: async (ended) => {
          told.push(["sessions", ended]);
          return "Refused";
        },
      },
    }),
  );
  assert.deepEqual(told, [
    ["jobs", jobEnd],
    ["sessions", sessionEnd],
  ]);
  assert.equal(passed.ended, 1);
});

test("a backend ending a workload of no kind the loop knows fails the pass before it is told anywhere, naming none of it", async () => {
  for (const [ended, refusal] of [
    [{ job: assignment("crashed"), why: "exited" }, "an entry keyed job, why"],
    [
      { kind: "chgb_0123456789abcdef0123456789abcdef", why: "exited" },
      "an entry keyed kind, why",
    ],
  ]) {
    const told = [];
    const telling = { end: async (end) => told.push(end) };
    await assert.rejects(
      workerPoolClientPass(
        client({
          backend: { ...idle, ended: async () => [ended] },
          jobs: telling,
          sessions: telling,
        }),
      ),
      {
        name: "TypeError",
        message: `a backend ended ${refusal}, whose kind is no workload's`,
      },
    );
    assert.deepEqual(told, []);
  }
});

test("a pool with a session ceiling and no session plane to end one on is refused before it acts", async () => {
  const source = counting();
  await assert.rejects(
    workerPoolClientPass(
      client({
        tokens: source.tokens,
        sessions: undefined,
        settings: { ...settings, sessionsMax: 1 },
      }),
    ),
    /sessionsMax is above zero with no session plane to end a session on/u,
  );
  assert.deepEqual(source.minted, []);
  for (const taken of [{}, { sessionsMax: 0 }])
    assert.equal(
      (
        await workerPoolClientPass(
          client({ sessions: undefined, settings: { ...settings, ...taken } }),
        )
      ).passed,
      "Reconciled",
    );
});

test("a workload that ended unreported has its attempt ended, each one once, counting the ends taken", async () => {
  const workloads = ["crashed", "reported"].map((named) => ({
    kind: "Job",
    job: assignment(named),
    why: `the ${named} container exited`,
  }));
  const asked = [];
  const passed = await workerPoolClientPass(
    client({
      backend: { ...idle, ended: async () => workloads },
      jobs: {
        end: async (workload) => {
          asked.push(workload);
          return workload.job.assignment === "crashed" ? "Ended" : "Refused";
        },
      },
    }),
  );
  assert.deepEqual(asked, workloads);
  assert.deepEqual(passed, {
    passed: "Reconciled",
    placed: 0,
    stopped: 0,
    refused: 0,
    ended: 1,
  });
});

/**
 * A pool whose backend names `workloads` ended, recording in order what the
 * job plane is asked and what the pool plane is told, which answers `settled`.
 */
function refusing(workloads, settled = "Settled") {
  const asked = [];
  const source = counting();
  const running = client({
    tokens: source.tokens,
    backend: { ...idle, ended: async () => workloads },
    jobs: {
      end: async (workload) => {
        asked.push(["end", workload.job.assignment]);
        return "Ended";
      },
      left: async (workload) => {
        asked.push(["left", workload.job.assignment]);
      },
    },
    plane: {
      ...quiet,
      settle: async (token, named, outcome) => {
        asked.push(["settle", token, named, outcome]);
        return settled;
      },
    },
  });
  return { asked, source, running };
}

test("a job the backend refused is left its words, then settled Refused under the pass's token with its fault, and counted once the plane takes it", async () => {
  const { asked, running } = refusing([
    {
      kind: "Job",
      job: assignment("no-git"),
      why: "The image this job names has no git on its PATH.",
      refusal: { fault: "ImageLacksGit" },
    },
    {
      kind: "Job",
      job: assignment("no-shell"),
      why: "The image this job names has no executable /bin/sh.",
      refusal: { fault: "ImageLacksShell" },
    },
    { kind: "Job", job: assignment("exited"), why: "its container exited" },
  ]);
  const passed = await workerPoolClientPass(running);
  assert.deepEqual(asked, [
    ["left", "no-git"],
    [
      "settle",
      "pool-token-1",
      "no-git",
      {
        outcome: "Refused",
        evidence: "The image this job names has no git on its PATH.",
        fault: "ImageLacksGit",
      },
    ],
    ["left", "no-shell"],
    [
      "settle",
      "pool-token-1",
      "no-shell",
      {
        outcome: "Refused",
        evidence: "The image this job names has no executable /bin/sh.",
        fault: "ImageLacksShell",
      },
    ],
    ["end", "exited"],
  ]);
  assert.equal(passed.passed === "Reconciled" && passed.ended, 3);
});

test("a refusal's evidence is cut, by whole characters, to what a settlement carries", async () => {
  const { asked, running } = refusing([
    {
      kind: "Job",
      job: assignment("long"),
      why: "\u{1F433}".repeat(workerPoolEvidenceCharsMax),
      refusal: { fault: "ImageUnpullable" },
    },
  ]);
  await workerPoolClientPass(running);
  const [, , , outcome] = asked[1];
  assert.equal(outcome.evidence.length, workerPoolEvidenceCharsMax);
  assert.ok(assignmentOutcomeSchema.safeParse(outcome).success);
  assert.ok(outcome.evidence.isWellFormed());
});

test("a refusal settled under a stale token invalidates it, and one the plane did not take is not counted", async () => {
  const refused = [
    {
      kind: "Job",
      job: assignment("refused"),
      why: "refused",
      refusal: { fault: "ImageLacksShell" },
    },
  ];
  for (const settled of ["Stale", "Lost", "Denied", "Unavailable"]) {
    const { source, running } = refusing(refused, settled);
    const passed = await workerPoolClientPass(running);
    assert.equal(passed.passed === "Reconciled" && passed.ended, 0, settled);
    assert.deepEqual(
      source.invalidated,
      settled === "Stale" ? ["pool-token-1"] : [],
      settled,
    );
  }
});

test("an ended workload found by this pass's read is ended before the poll waits", async () => {
  const order = [];
  await workerPoolClientPass(
    client({
      backend: {
        ...idle,
        held: async () => {
          order.push("held");
          return [];
        },
        ended: async () => [
          {
            kind: "Job",
            job: assignment("crashed"),
            why: "the container exited",
          },
        ],
      },
      jobs: {
        end: async () => {
          order.push("end");
          return "Ended";
        },
      },
      plane: {
        ...quiet,
        poll: async () => {
          order.push("poll");
          return reconciled();
        },
      },
    }),
  );
  assert.deepEqual(order, ["held", "end", "poll"]);
});

test("a fabric that could not take a stop places nothing further this pass", async () => {
  const placer = placing(holding("Job", "going"));
  const passed = await workerPoolClientPass(
    client({
      backend: {
        ...placer.backend,
        stop: async () => ({
          stopped: "Unavailable",
          evidence: "the fabric could not be reached",
        }),
      },
      plane: {
        ...quiet,
        poll: async () => reconciled([assignment("offered")], ["going"]),
      },
    }),
  );
  assert.equal(placer.counted.placed, 0);
  assert.deepEqual(passed, {
    passed: "Unavailable",
    evidence: "the fabric could not be reached",
  });
});

test("a fabric that refused a stop ends the run rather than renewing that lease", async () => {
  let polled = 0;
  const passed = await workerPoolClientRun(
    client({
      settings: { ...settings, passesMax: 5 },
      backend: {
        ...idle,
        held: async () => holding("Job", "going"),
        stop: async () => ({
          stopped: "Refused",
          evidence: "the fabric refused to stop this workload",
        }),
      },
      plane: {
        ...quiet,
        poll: async () => {
          polled += 1;
          return reconciled([], ["going"]);
        },
      },
    }),
    async () => undefined,
  );
  assert.equal(polled, 1);
  assert.deepEqual(passed, {
    passed: "Denied",
    evidence: "the fabric refused to stop this workload",
  });
});

test("a placement the plane never acknowledged is still placed", async () => {
  const placer = placing();
  const passed = await workerPoolClientPass(
    client({
      backend: placer.backend,
      plane: offering([assignment("offered")], "Unavailable").plane,
    }),
  );
  assert.equal(placer.counted.placed, 1);
  assert.deepEqual(passed, {
    passed: "Reconciled",
    placed: 1,
    stopped: 0,
    refused: 0,
    ended: 0,
  });
});

test("a refused placement is reported as evidence rather than as unavailable", async () => {
  const offer = offering([assignment("offered")]);
  const passed = await workerPoolClientPass(
    client({
      backend: {
        ...idle,
        place: async () => ({
          placed: "Refused",
          evidence: "the cluster refused this workload",
        }),
      },
      plane: offer.plane,
    }),
  );
  assert.deepEqual(offer.posted, ["Refused"]);
  assert.deepEqual(passed, {
    passed: "Reconciled",
    placed: 0,
    stopped: 0,
    refused: 1,
    ended: 0,
  });
});

test("a backend answering no placement the loop knows fails the pass before it settles", async () => {
  const offer = offering([assignment("offered")]);
  await assert.rejects(
    workerPoolClientPass(
      client({
        backend: { ...idle, place: async () => ({ placed: "Placd" }) },
        plane: offer.plane,
      }),
    ),
    /Placd, which is no placement/u,
  );
  assert.deepEqual(offer.posted, []);
});

test("a token is acquired every pass and nothing is discarded unasked", async () => {
  const source = counting();
  await workerPoolClientRun(
    client({ settings: { ...settings, passesMax: 3 }, tokens: source.tokens }),
    async () => undefined,
  );
  assert.equal(source.minted.length, 3);
  assert.deepEqual(source.invalidated, []);
});

test("a token the poll was refused with is invalidated, and the next pass acquires again", async () => {
  const source = counting();
  const polledWith = [];
  const running = client({
    tokens: source.tokens,
    plane: {
      ...quiet,
      poll: async (token) => {
        polledWith.push(token);
        return polledWith.length === 1 ? { polled: "Stale" } : reconciled();
      },
    },
  });
  const first = await workerPoolClientPass(running);
  assert.equal(first.passed, "Unavailable");
  assert.deepEqual(source.invalidated, ["pool-token-1"]);
  const second = await workerPoolClientPass(running);
  assert.equal(second.passed, "Reconciled");
  assert.deepEqual(polledWith, ["pool-token-1", "pool-token-2"]);
});

test("a token a settlement was refused with is invalidated, and the next pass acquires again", async () => {
  const source = counting();
  const polledWith = [];
  const running = client({
    tokens: source.tokens,
    plane: {
      poll: async (token) => {
        polledWith.push(token);
        return reconciled([assignment("offered")]);
      },
      settle: async () => "Stale",
    },
  });
  const passed = await workerPoolClientPass(running);
  assert.equal(passed.passed, "Reconciled");
  assert.deepEqual(source.invalidated, ["pool-token-1"]);
  await workerPoolClientPass(running);
  assert.deepEqual(polledWith, ["pool-token-1", "pool-token-2"]);
});

test("a pool the plane serves no registration for stops rather than retrying", async () => {
  let polled = 0;
  const passed = await workerPoolClientRun(
    client({
      settings: { ...settings, passesMax: 5 },
      plane: {
        ...quiet,
        poll: async () => {
          polled += 1;
          return {
            polled: "Denied",
            evidence: "the plane serves no such pool",
          };
        },
      },
    }),
    async () => undefined,
  );
  assert.equal(polled, 1);
  assert.equal(passed.passed, "Denied");
});

test("an issuer that refused the grant stops the run and one that faltered does not", async () => {
  const denied = await workerPoolClientRun(
    client({
      token: { acquired: "Denied", evidence: "the issuer refused this pool" },
    }),
    async () => undefined,
  );
  assert.equal(denied.passed, "Denied");
  const waited = [];
  const outage = await workerPoolClientRun(
    client({
      settings: { ...settings, outageBackoffMs: 7, passesMax: 2 },
      token: { acquired: "Unavailable", evidence: "the issuer is unreachable" },
    }),
    async (ms) => {
      waited.push(ms);
    },
  );
  assert.equal(outage.passed, "Unavailable");
  assert.deepEqual(waited, [7, 7]);
});

test("a run refuses a bound that is not a positive whole number", async () => {
  for (const name of ["outageBackoffMs", "passesMax"])
    for (const refused of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])
      await assert.rejects(
        workerPoolClientRun(
          client({ settings: { ...settings, [name]: refused } }),
          async () => undefined,
        ),
        new RegExp(`${name} must be a positive safe integer`, "u"),
      );
});

test("a run refuses a job ceiling that is not a whole number of zero or more", async () => {
  for (const refused of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])
    await assert.rejects(
      workerPoolClientRun(
        client({
          settings: { ...settings, concurrencyMax: refused, sessionsMax: 1 },
        }),
        async () => undefined,
      ),
      /concurrencyMax must be a safe integer of zero or more$/u,
    );
});

test("a run takes a job ceiling of 0 beside a session ceiling, and refuses one beside none", async () => {
  assert.equal(
    (
      await workerPoolClientRun(
        client({
          settings: { ...settings, concurrencyMax: 0, sessionsMax: 1 },
        }),
        async () => undefined,
      )
    ).passed,
    "Reconciled",
  );
  for (const none of [{}, { sessionsMax: 0 }])
    await assert.rejects(
      workerPoolClientRun(
        client({ settings: { ...settings, concurrencyMax: 0, ...none } }),
        async () => undefined,
      ),
      /concurrencyMax is 0 and sessionsMax is 0 or absent, so the pool would take no work/u,
    );
});

test("a run refuses a session ceiling that is not a whole number of zero or more, and takes none or zero", async () => {
  for (const refused of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])
    await assert.rejects(
      workerPoolClientRun(
        client({ settings: { ...settings, sessionsMax: refused } }),
        async () => undefined,
      ),
      /sessionsMax must be a safe integer of zero or more, or absent/u,
    );
  for (const taken of [{}, { sessionsMax: 0 }])
    assert.equal(
      (
        await workerPoolClientRun(
          client({ settings: { ...settings, ...taken } }),
          async () => undefined,
        )
      ).passed,
      "Reconciled",
    );
});

/** The runner a run updates, and the release chuggy pins above it. */
const runner = { package: "chuggy-linux", version: "0.14.0" };
const pinned = {
  package: "chuggy-linux",
  version: "0.14.1",
  url: "https://github.com/kasofsk/chuggy-linux/releases/download/v0.14.1/chuggy-linux-0.14.1.tgz",
  integrity: `sha512-${"A".repeat(86)}==`,
};

/** The minutes a failed update's log line says the next try is in. */
const backoffMinutes = String(workerPoolUpdateBackoffMs / 60_000);

/**
 * A promise and what settles it, for a proof or an install a case finishes
 * when it chooses.
 */
function deferred() {
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * A run's update over an updater that refuses, proves and installs as told,
 * proving and installing whatever it is asked to otherwise, on a clock the
 * case moves.
 *
 * @param {{on?: boolean, refusal?: (release: object) => string | undefined, prove?: (release: object) => Promise<object>, update?: (release: {version: string}) => Promise<object>}} [answers]
 */
function updatingOf(answers = {}) {
  const asked = { refusal: [], prove: [], update: [] };
  const log = [];
  const clock = { nowMs: 0 };
  const updater = {
    runner,
    refusal: async (release) => {
      asked.refusal.push(release.version);
      return answers.refusal?.(release);
    },
    prove: async (release) => {
      asked.prove.push(release.version);
      return answers.prove === undefined
        ? { proved: "Proved" }
        : answers.prove(release);
    },
    update: async (release) => {
      asked.update.push(release.version);
      return answers.update === undefined
        ? { updated: "Installed", version: release.version }
        : answers.update(release);
    },
  };
  const updating = workerPoolUpdating(
    { on: answers.on ?? true, updater },
    { log: (line) => log.push(line), nowMs: () => clock.nowMs },
  );
  return { asked, log, clock, updating };
}

/**
 * A plane naming `pin.release` on every poll while it is set, recording the
 * held and the room each poll asks.
 *
 * @param {{release?: object}} pin
 * @param {object[]} [offered]
 */
function pinning(pin, offered = []) {
  const polls = [];
  const posted = [];
  return {
    polls,
    posted,
    plane: {
      poll: async (_token, held, wanted, wantedSessions) => {
        polls.push({ held: [...held], room: [wanted, wantedSessions] });
        return {
          ...reconciled(offered),
          ...(pin.release === undefined ? {} : { release: pin.release }),
        };
      },
      settle: async (_token, _assignment, outcome) => {
        posted.push(outcome.outcome);
        return "Settled";
      },
    },
  };
}

/**
 * Makes `count` passes, each reconciled.
 *
 * @param {object} pooled
 * @param {object} updating
 * @param {number} count
 */
async function passes(pooled, updating, count) {
  for (let pass = 0; pass < count; pass += 1)
    assert.equal(
      (await workerPoolClientPass(pooled, updating)).passed,
      "Reconciled",
    );
}

const updateSettings = { ...settings, concurrencyMax: 3, sessionsMax: 1 };

/** A host job, which ends with the runner's process, and a container, which outlives it. */
const hostJob = { assignment: "host-1", kind: "Job" };
const container = {
  assignment: "container-1",
  kind: "Job",
  outlivesRunner: true,
};

test("a release above the runner's own is installed at once, unproved, where nothing held ends with the process, and the pass after ends the run", async () => {
  const run = updatingOf();
  const { plane, polls } = pinning({ release: pinned });
  const pooled = client({ plane, settings: updateSettings });
  await passes(pooled, run.updating, 1);
  assert.deepEqual(run.asked, { refusal: ["0.14.1"], prove: [], update: [] });
  await passes(pooled, run.updating, 1);
  assert.deepEqual(run.asked.update, ["0.14.1"]);
  assert.deepEqual(await workerPoolClientPass(pooled, run.updating), {
    passed: "Updated",
    version: "0.14.1",
  });
  assert.deepEqual(run.asked.prove, []);
  assert.deepEqual(
    polls.map(({ room }) => room),
    [
      [3, 1],
      [0, 0],
    ],
  );
  assert.deepEqual(run.log, [
    "updating to chuggy-linux 0.14.1",
    "chuggy-linux 0.14.1 is installed, and this runner ends to start on it",
  ]);
});

test("where a workload would end with the process, the release is proved while the pool takes work, then drained for, then installed once that workload has ended", async () => {
  const run = updatingOf();
  const { plane, polls } = pinning({ release: pinned });
  let held = [hostJob, container];
  const pooled = client({
    plane,
    settings: updateSettings,
    backend: { ...idle, held: async () => held },
  });
  await passes(pooled, run.updating, 4);
  assert.deepEqual(run.asked, {
    refusal: ["0.14.1"],
    prove: ["0.14.1"],
    update: [],
  });
  assert.deepEqual(run.log, [
    "proving chuggy-linux 0.14.1 before this pool stops taking work for it",
    "chuggy-linux 0.14.1 is proved, and this pool takes no new work until it has updated",
  ]);
  held = [container];
  await passes(pooled, run.updating, 1);
  assert.deepEqual(run.asked.update, ["0.14.1"]);
  assert.equal(
    (await workerPoolClientPass(pooled, run.updating)).passed,
    "Updated",
  );
  assert.deepEqual(
    polls.map(({ room }) => room),
    [
      [1, 1],
      [1, 1],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
  );
  assert.ok(polls.every((poll) => poll.held.includes("container-1")));
});

test("a release that fails its proof never drains the pool, is logged once, and is not proved again before the backoff", async () => {
  const run = updatingOf({
    prove: async () => ({
      proved: "Failed",
      reason: "it needs Node >=99, and this runner's Node is 24.1.0",
    }),
  });
  const { plane, polls } = pinning({ release: pinned });
  const pooled = client({
    plane,
    settings: updateSettings,
    backend: { ...idle, held: async () => [hostJob] },
  });
  await passes(pooled, run.updating, 4);
  assert.deepEqual(run.asked, {
    refusal: ["0.14.1"],
    prove: ["0.14.1"],
    update: [],
  });
  assert.deepEqual(run.log, [
    "proving chuggy-linux 0.14.1 before this pool stops taking work for it",
    `did not update to chuggy-linux 0.14.1: it needs Node >=99, and this runner's Node is 24.1.0; the next try is in ${backoffMinutes} minutes`,
  ]);
  run.clock.nowMs = workerPoolUpdateBackoffMs - 1;
  await passes(pooled, run.updating, 1);
  assert.equal(run.asked.refusal.length, 1);
  run.clock.nowMs = workerPoolUpdateBackoffMs;
  await passes(pooled, run.updating, 2);
  assert.deepEqual(run.asked.prove, ["0.14.1", "0.14.1"]);
  assert.deepEqual(run.asked.update, []);
  assert.ok(polls.every(({ room }) => room[0] === 2 && room[1] === 1));
});

test("a proof that throws is a failed one, and drains nothing", async () => {
  const run = updatingOf({
    prove: async () => {
      throw new Error("the disk is full");
    },
  });
  const { plane, polls } = pinning({ release: pinned });
  const pooled = client({
    plane,
    settings: updateSettings,
    backend: { ...idle, held: async () => [hostJob] },
  });
  await passes(pooled, run.updating, 3);
  assert.ok(
    run.log.includes(
      `did not update to chuggy-linux 0.14.1: the disk is full; the next try is in ${backoffMinutes} minutes`,
    ),
  );
  assert.ok(polls.every(({ room }) => room[0] === 2));
});

test("nothing a poll names moves a proof begun, and a proved release a poll names no longer is not drained for", async () => {
  const proof = deferred();
  const run = updatingOf({ prove: () => proof.promise });
  const pin = { release: pinned };
  const { plane, polls } = pinning(pin);
  const pooled = client({
    plane,
    settings: updateSettings,
    backend: { ...idle, held: async () => [hostJob] },
  });
  await passes(pooled, run.updating, 2);
  pin.release = { ...pinned, version: "0.14.2" };
  await passes(pooled, run.updating, 2);
  assert.deepEqual(run.asked, {
    refusal: ["0.14.1"],
    prove: ["0.14.1"],
    update: [],
  });
  pin.release = undefined;
  proof.settle({ proved: "Proved" });
  await passes(pooled, run.updating, 3);
  assert.deepEqual(run.asked.update, []);
  assert.ok(polls.every(({ room }) => room[0] === 2));
});

test("an offer past no room while the pool drains is settled unavailable and never placed", async () => {
  const run = updatingOf({ update: () => deferred().promise });
  const { plane, posted } = pinning({ release: pinned }, [assignment("x")]);
  const placer = placing();
  const pooled = client({
    plane,
    settings: updateSettings,
    backend: placer.backend,
  });
  await passes(pooled, run.updating, 2);
  assert.equal(placer.counted.placed, 1);
  assert.deepEqual(posted, ["Accepted", "Unavailable"]);
});

test("an install in flight leaves the passes renewing what is held with no room asked, and the run ends at the first pass after it answers", async () => {
  const install = deferred();
  const run = updatingOf({ update: () => install.promise });
  const pin = { release: pinned };
  const { plane, polls } = pinning(pin);
  const pooled = client({
    plane,
    settings: updateSettings,
    backend: { ...idle, held: async () => [container] },
  });
  await passes(pooled, run.updating, 3);
  pin.release = { ...pinned, version: "0.14.2" };
  await passes(pooled, run.updating, 1);
  assert.deepEqual(run.asked, {
    refusal: ["0.14.1"],
    prove: [],
    update: ["0.14.1"],
  });
  install.settle({ updated: "AlreadyInstalled", version: "0.14.2" });
  assert.deepEqual(await workerPoolClientPass(pooled, run.updating), {
    passed: "Updated",
    version: "0.14.2",
  });
  assert.deepEqual(
    polls.map(({ room, held }) => [room, held]),
    [
      [[2, 1], ["container-1"]],
      [[0, 0], ["container-1"]],
      [[0, 0], ["container-1"]],
      [[0, 0], ["container-1"]],
    ],
  );
});

test("a failed install is logged once, the pool takes work again, and the release is not tried again before the backoff", async () => {
  const run = updatingOf({
    update: async () => ({
      updated: "Failed",
      reason: "npm could not install it: EACCES",
    }),
  });
  const { plane, polls } = pinning({ release: pinned });
  const pooled = client({ plane, settings: updateSettings });
  await passes(pooled, run.updating, 4);
  assert.deepEqual(run.asked, {
    refusal: ["0.14.1"],
    prove: [],
    update: ["0.14.1"],
  });
  assert.deepEqual(
    polls.map(({ room }) => room),
    [
      [3, 1],
      [0, 0],
      [3, 1],
      [3, 1],
    ],
  );
  assert.deepEqual(
    run.log.filter((line) => line.startsWith("did not update")),
    [
      `did not update to chuggy-linux 0.14.1: npm could not install it: EACCES; the next try is in ${backoffMinutes} minutes`,
    ],
  );
  run.clock.nowMs = workerPoolUpdateBackoffMs - 1;
  await passes(pooled, run.updating, 1);
  assert.equal(run.asked.refusal.length, 1);
  run.clock.nowMs = workerPoolUpdateBackoffMs;
  await passes(pooled, run.updating, 2);
  assert.deepEqual(run.asked.update, ["0.14.1", "0.14.1"]);
});

test("an install that throws is a failed one", async () => {
  const run = updatingOf({
    update: async () => {
      throw new Error("the disk is full");
    },
  });
  const pooled = client({
    plane: pinning({ release: pinned }).plane,
    settings: updateSettings,
  });
  await passes(pooled, run.updating, 3);
  assert.ok(
    run.log.includes(
      `did not update to chuggy-linux 0.14.1: the disk is full; the next try is in ${backoffMinutes} minutes`,
    ),
  );
});

test("a release the updater refuses is logged and never proved, installed or drained for", async () => {
  const run = updatingOf({
    refusal: () => "this runner cannot write /usr/lib/node_modules",
  });
  const { plane, polls } = pinning({ release: pinned });
  const pooled = client({ plane, settings: updateSettings });
  await passes(pooled, run.updating, 3);
  assert.deepEqual(run.asked, { refusal: ["0.14.1"], prove: [], update: [] });
  assert.ok(polls.every(({ room }) => room[0] === 3));
  assert.deepEqual(run.log, [
    `did not update to chuggy-linux 0.14.1: this runner cannot write /usr/lib/node_modules; the next try is in ${backoffMinutes} minutes`,
  ]);
});

test("a runner that does not update says once per release that one is out, and asks for work as before", async () => {
  const run = updatingOf({ on: false });
  const pin = { release: pinned };
  const { plane, polls } = pinning(pin);
  const pooled = client({ plane, settings: updateSettings });
  await passes(pooled, run.updating, 3);
  pin.release = { ...pinned, version: "0.14.2" };
  await passes(pooled, run.updating, 2);
  assert.deepEqual(run.asked, { refusal: [], prove: [], update: [] });
  assert.ok(polls.every(({ room }) => room[0] === 3));
  assert.deepEqual(run.log, [
    "chuggy-linux 0.14.1 is out, and this runner, 0.14.0, does not update itself",
    "chuggy-linux 0.14.2 is out, and this runner, 0.14.0, does not update itself",
  ]);
});

test("a release at or below the runner's own is no update, and one the poll stops naming is no longer drained for", async () => {
  const run = updatingOf();
  const pin = { release: { ...pinned, version: "0.14.0" } };
  const { plane, polls } = pinning(pin);
  const pooled = client({
    plane,
    settings: updateSettings,
    backend: { ...idle, held: async () => [hostJob] },
  });
  await passes(pooled, run.updating, 1);
  assert.deepEqual(run.asked.refusal, []);
  pin.release = pinned;
  await passes(pooled, run.updating, 3);
  pin.release = undefined;
  await passes(pooled, run.updating, 2);
  assert.deepEqual(
    polls.map(({ room }) => room),
    [
      [2, 1],
      [2, 1],
      [2, 1],
      [0, 0],
      [0, 0],
      [2, 1],
    ],
  );
  assert.deepEqual(run.asked.update, []);
});
