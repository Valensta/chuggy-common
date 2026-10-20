import assert from "node:assert/strict";
import test from "node:test";

import {
  assignmentOutcomeSchema,
  workerPoolEvidenceCharsMax,
} from "@chuggy/worker-contract/workerPool";

import {
  workerPoolClientPass,
  workerPoolClientRun,
  workerPoolUpdateBackoffMs,
  workerPoolUpdating,
} from "./poolLoop.mjs";

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
  for (const name of ["concurrencyMax", "outageBackoffMs", "passesMax"])
    for (const refused of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])
      await assert.rejects(
        workerPoolClientRun(
          client({ settings: { ...settings, [name]: refused } }),
          async () => undefined,
        ),
        new RegExp(`${name} must be a positive safe integer`, "u"),
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

/**
 * A run's update over an updater that refuses and answers as told, installing
 * whatever it is asked to otherwise, on a clock the case moves.
 *
 * @param {{on?: boolean, refusal?: (release: object) => string | undefined, update?: (release: {version: string}) => Promise<object>}} [answers]
 */
function updatingOf(answers = {}) {
  const asked = { refusal: [], update: [] };
  const log = [];
  const clock = { nowMs: 0 };
  const updater = {
    runner,
    refusal: async (release) => {
      asked.refusal.push(release.version);
      return answers.refusal?.(release);
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
 * A plane naming `release` on every poll while `pin.release` is set, recording
 * the held and the room each poll asks.
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

const updateSettings = { ...settings, concurrencyMax: 3, sessionsMax: 1 };

test("a release above the runner's own is installed once nothing held ends with the process, and the pass after ends the run for the restart", async () => {
  const run = updatingOf();
  const pin = { release: pinned };
  const { plane, polls } = pinning(pin);
  const pooled = client({ plane, settings: updateSettings });
  assert.equal(
    (await workerPoolClientPass(pooled, run.updating)).passed,
    "Reconciled",
  );
  assert.deepEqual(run.asked, { refusal: ["0.14.1"], update: [] });
  assert.equal(
    (await workerPoolClientPass(pooled, run.updating)).passed,
    "Reconciled",
  );
  assert.deepEqual(run.asked.update, ["0.14.1"]);
  assert.deepEqual(await workerPoolClientPass(pooled, run.updating), {
    passed: "Updated",
    version: "0.14.1",
  });
  assert.deepEqual(
    polls.map(({ room }) => room),
    [
      [3, 1],
      [0, 0],
    ],
  );
  assert.deepEqual(run.log, [
    "chuggy-linux 0.14.1 is out, and this pool takes no new work until it has updated",
    "updating to chuggy-linux 0.14.1",
    "chuggy-linux 0.14.1 is installed, and this runner ends to start on it",
  ]);
});

test("a workload that would end with the process is drained first, with no room asked, and one that outlives it holds nothing back", async () => {
  const run = updatingOf();
  const { plane, polls } = pinning({ release: pinned });
  let held = [
    { assignment: "host-1", kind: "Job" },
    { assignment: "container-1", kind: "Job", outlivesRunner: true },
  ];
  const pooled = client({
    plane,
    settings: updateSettings,
    backend: { ...idle, held: async () => held },
  });
  for (let pass = 0; pass < 3; pass += 1)
    assert.equal(
      (await workerPoolClientPass(pooled, run.updating)).passed,
      "Reconciled",
    );
  assert.deepEqual(run.asked, { refusal: ["0.14.1"], update: [] });
  assert.deepEqual(run.log, [
    "chuggy-linux 0.14.1 is out, and this pool takes no new work until it has updated",
  ]);
  held = [held[1]];
  await workerPoolClientPass(pooled, run.updating);
  assert.deepEqual(run.asked.update, ["0.14.1"]);
  assert.equal(
    (await workerPoolClientPass(pooled, run.updating)).passed,
    "Updated",
  );
  assert.deepEqual(
    polls.map(({ room }) => room),
    [
      [1, 1],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
  );
  assert.ok(polls.every((poll) => poll.held.includes("container-1")));
});

test("an offer past no room while the pool drains is settled unavailable and never placed", async () => {
  const run = updatingOf();
  const { plane, posted } = pinning({ release: pinned }, [assignment("x")]);
  const placer = placing(holding("Job", "host-1"));
  const pooled = client({
    plane,
    settings: updateSettings,
    backend: placer.backend,
  });
  await workerPoolClientPass(pooled, run.updating);
  assert.equal(placer.counted.placed, 1);
  await workerPoolClientPass(pooled, run.updating);
  assert.equal(placer.counted.placed, 1);
  assert.deepEqual(posted, ["Accepted", "Unavailable"]);
});

test("an install in flight leaves the passes renewing what is held with no room asked, and the run ends at the first pass after it answers", async () => {
  let answer;
  const run = updatingOf({
    update: () =>
      new Promise((settle) => {
        answer = settle;
      }),
  });
  const pin = { release: pinned };
  const { plane, polls } = pinning(pin);
  const pooled = client({
    plane,
    settings: updateSettings,
    backend: {
      ...idle,
      held: async () => [
        { assignment: "container-1", kind: "Job", outlivesRunner: true },
      ],
    },
  });
  for (let pass = 0; pass < 3; pass += 1)
    assert.equal(
      (await workerPoolClientPass(pooled, run.updating)).passed,
      "Reconciled",
    );
  pin.release = { ...pinned, version: "0.14.2" };
  assert.equal(
    (await workerPoolClientPass(pooled, run.updating)).passed,
    "Reconciled",
  );
  assert.deepEqual(run.asked, { refusal: ["0.14.1"], update: ["0.14.1"] });
  answer({ updated: "AlreadyInstalled", version: "0.14.2" });
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

test("a failed update is logged once, the pool takes work again, and the release is not tried again before the backoff", async () => {
  const run = updatingOf({
    update: async () => ({
      updated: "Failed",
      reason: "its download answered 404",
    }),
  });
  const { plane, polls } = pinning({ release: pinned });
  const pooled = client({ plane, settings: updateSettings });
  for (let pass = 0; pass < 4; pass += 1)
    await workerPoolClientPass(pooled, run.updating);
  assert.deepEqual(run.asked, { refusal: ["0.14.1"], update: ["0.14.1"] });
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
      `did not update to chuggy-linux 0.14.1: its download answered 404; the next try is in ${String(workerPoolUpdateBackoffMs / 60_000)} minutes`,
    ],
  );
  run.clock.nowMs = workerPoolUpdateBackoffMs - 1;
  await workerPoolClientPass(pooled, run.updating);
  assert.equal(run.asked.refusal.length, 1);
  run.clock.nowMs = workerPoolUpdateBackoffMs;
  await workerPoolClientPass(pooled, run.updating);
  await workerPoolClientPass(pooled, run.updating);
  assert.deepEqual(run.asked.update, ["0.14.1", "0.14.1"]);
});

test("an update that throws is a failed one", async () => {
  const run = updatingOf({
    update: async () => {
      throw new Error("the disk is full");
    },
  });
  const pooled = client({
    plane: pinning({ release: pinned }).plane,
    settings: updateSettings,
  });
  for (let pass = 0; pass < 3; pass += 1)
    assert.equal(
      (await workerPoolClientPass(pooled, run.updating)).passed,
      "Reconciled",
    );
  assert.ok(
    run.log.includes(
      `did not update to chuggy-linux 0.14.1: the disk is full; the next try is in ${String(workerPoolUpdateBackoffMs / 60_000)} minutes`,
    ),
  );
});

test("a release the updater refuses is logged and never drains the pool", async () => {
  const run = updatingOf({
    refusal: () => "this runner cannot write /usr/lib/node_modules",
  });
  const { plane, polls } = pinning({ release: pinned });
  const pooled = client({ plane, settings: updateSettings });
  for (let pass = 0; pass < 3; pass += 1)
    await workerPoolClientPass(pooled, run.updating);
  assert.deepEqual(run.asked, { refusal: ["0.14.1"], update: [] });
  assert.ok(polls.every(({ room }) => room[0] === 3));
  assert.deepEqual(run.log, [
    `did not update to chuggy-linux 0.14.1: this runner cannot write /usr/lib/node_modules; the next try is in ${String(workerPoolUpdateBackoffMs / 60_000)} minutes`,
  ]);
});

test("a runner that does not update says once per release that one is out, and asks for work as before", async () => {
  const run = updatingOf({ on: false });
  const pin = { release: pinned };
  const { plane, polls } = pinning(pin);
  const pooled = client({ plane, settings: updateSettings });
  for (let pass = 0; pass < 3; pass += 1)
    await workerPoolClientPass(pooled, run.updating);
  pin.release = { ...pinned, version: "0.14.2" };
  for (let pass = 0; pass < 2; pass += 1)
    await workerPoolClientPass(pooled, run.updating);
  assert.deepEqual(run.asked, { refusal: [], update: [] });
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
    backend: { ...idle, held: async () => holding("Job", "host-1") },
  });
  await workerPoolClientPass(pooled, run.updating);
  assert.deepEqual(run.asked.refusal, []);
  pin.release = pinned;
  await workerPoolClientPass(pooled, run.updating);
  await workerPoolClientPass(pooled, run.updating);
  pin.release = undefined;
  await workerPoolClientPass(pooled, run.updating);
  await workerPoolClientPass(pooled, run.updating);
  assert.deepEqual(
    polls.map(({ room }) => room),
    [
      [2, 1],
      [2, 1],
      [0, 0],
      [0, 0],
      [2, 1],
    ],
  );
  assert.deepEqual(run.asked.update, []);
});
