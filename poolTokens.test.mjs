import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { URL, URLSearchParams } from "node:url";

import { workerPoolClientPass, workerPoolClientRun } from "./poolLoop.mjs";
import { poolPlaneClient } from "./poolPlane.mjs";
import { poolRunnerLoop } from "./poolRunner.mjs";
import {
  clientCredentialsMonotonicMs,
  clientCredentialsTokenSource,
  poolClientTokens,
} from "./poolTokens.mjs";

const tokenUrl = "https://auth.example/oauth2/token";
const secret = "s3cret-that-never-reaches-a-message";

/** A configuration every case narrows from, its clocks and transport left to each. */
function credentials(overrides = {}) {
  return {
    tokenUrl,
    clientId: "selector",
    clientSecret: secret,
    audience: [],
    scope: [],
    requestTimeoutMs: 1_000,
    responseBytesMax: 10_000,
    responseReadsMax: 100,
    refreshMarginMs: 1_000,
    mintCooldownMs: 500,
    refusalConfirmMs: 60_000,
    ...overrides,
  };
}

function grantResponse(token, expiresInSeconds, overrides = {}) {
  const body = JSON.stringify({
    access_token: token,
    token_type: "bearer",
    expires_in: expiresInSeconds,
    scope: "",
    ...overrides,
  });
  return new globalThis.Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body, "utf8")),
    },
  });
}

function failing(status) {
  return new globalThis.Response("{}", { status });
}

/** A refusal as Hydra words one. */
function refusal(status, error) {
  return new globalThis.Response(
    JSON.stringify({
      error,
      error_description: "Client authentication failed.",
    }),
    { status, headers: { "content-type": "application/json;charset=UTF-8" } },
  );
}

/** What traefik answers in place of a service with no endpoint ready. */
function proxyNotFound() {
  return new globalThis.Response("404 page not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** An issuer recording each grant request and answering the attempt's number with `response`. */
function mintingTransport(minted, response) {
  return async (input, init) => {
    assert.ok(input instanceof URL);
    assert.equal(input.href, tokenUrl);
    assert.equal(init.method, "POST");
    assert.equal(typeof init.body, "string");
    minted.push({
      authorization: new globalThis.Headers(init.headers).get("authorization"),
      form: new URLSearchParams(init.body),
    });
    return response(minted.length);
  };
}

/**
 * A configuration whose issuer numbers the tokens it grants, or fails every
 * attempt after the first when `grantsOnce`, and whose clocks move only when a
 * case moves them.
 */
function driven({
  refreshMarginMs,
  mintCooldownMs,
  expiresInSeconds,
  grantsOnce = false,
}) {
  const minted = [];
  let nowEpochMs = 1_000_000;
  let elapsedMs = 0;
  return {
    minted,
    config: credentials({
      refreshMarginMs,
      mintCooldownMs,
      fetch: mintingTransport(minted, (attempt) =>
        grantsOnce && attempt > 1
          ? failing(503)
          : grantResponse(`token-${String(attempt)}`, expiresInSeconds),
      ),
      currentTimeEpochMs: () => nowEpochMs,
      monotonicMs: () => elapsedMs,
    }),
    advance: (milliseconds) => {
      nowEpochMs += milliseconds;
      elapsedMs += milliseconds;
    },
    stepClockBack: (milliseconds) => {
      nowEpochMs -= milliseconds;
      elapsedMs += 1;
    },
  };
}

/** The common shape: a margin of a minute, a cooldown of five seconds, a grant of fifteen minutes. */
function drivenSource(grantsOnce = false) {
  const issuer = driven({
    refreshMarginMs: 60_000,
    mintCooldownMs: 5_000,
    expiresInSeconds: 900,
    grantsOnce,
  });
  return { ...issuer, source: clientCredentialsTokenSource(issuer.config) };
}

/** A source whose issuer fails every attempt, on a cooldown clock the case moves. */
function failingSource(status, overrides = {}) {
  const minted = [];
  const clock = { elapsedMs: 0 };
  const source = clientCredentialsTokenSource(
    credentials({
      fetch: mintingTransport(minted, () => failing(status)),
      monotonicMs: () => clock.elapsedMs,
      ...overrides,
    }),
  );
  return { minted, clock, source };
}

const bounded = () => globalThis.AbortSignal.timeout(1_000);

test("the grant is minted with basic authentication, audience and scope", async () => {
  const minted = [];
  const source = clientCredentialsTokenSource(
    credentials({
      audience: ["https://chuggy.example/api"],
      scope: ["offline"],
      fetch: mintingTransport(minted, () => grantResponse("first", 900)),
    }),
  );
  assert.equal(await source.token(bounded()), "first");
  assert.equal(minted.length, 1);
  assert.equal(
    minted[0].authorization,
    `Basic ${Buffer.from(`selector:${secret}`, "utf8").toString("base64")}`,
  );
  assert.equal(minted[0].form.get("grant_type"), "client_credentials");
  assert.equal(minted[0].form.get("audience"), "https://chuggy.example/api");
  assert.equal(minted[0].form.get("scope"), "offline");
});

test("a held grant is replaced once its refresh margin is reached", async () => {
  const issuer = drivenSource();
  assert.equal(await issuer.source.token(bounded()), "token-1");
  issuer.advance(839_000);
  assert.equal(await issuer.source.token(bounded()), "token-1");
  assert.equal(issuer.minted.length, 1);
  issuer.advance(2_000);
  assert.equal(await issuer.source.token(bounded()), "token-2");
  assert.equal(issuer.minted.length, 2);
});

test("a grant shorter than its margin is still held for part of its life", async () => {
  const issuer = driven({
    refreshMarginMs: 600_000,
    mintCooldownMs: 500,
    expiresInSeconds: 10,
  });
  const source = clientCredentialsTokenSource(issuer.config);
  assert.equal(await source.token(bounded()), "token-1");
  issuer.advance(4_000);
  assert.equal(await source.token(bounded()), "token-1");
  issuer.advance(2_000);
  assert.equal(await source.token(bounded()), "token-2");
  assert.equal(issuer.minted.length, 2);
});

test("callers waiting on a replacement share the mint in flight", async () => {
  const issuer = drivenSource();
  const waiting = [1, 2, 3].map(() => issuer.source.token(bounded()));
  assert.deepEqual(await Promise.all(waiting), [
    "token-1",
    "token-1",
    "token-1",
  ]);
  assert.equal(issuer.minted.length, 1);
});

test("a caller already gone never starts a mint", async () => {
  const issuer = drivenSource();
  await assert.rejects(
    issuer.source.token(
      globalThis.AbortSignal.abort(new Error("the caller is gone")),
    ),
    /the caller is gone/u,
  );
  assert.equal(issuer.minted.length, 0);
});

test("a refused mint is not held and the next caller mints again", async () => {
  const minted = [];
  let elapsedMs = 0;
  const source = clientCredentialsTokenSource(
    credentials({
      fetch: mintingTransport(minted, (attempt) =>
        attempt === 1
          ? refusal(401, "invalid_client")
          : grantResponse("recovered", 900),
      ),
      monotonicMs: () => elapsedMs,
    }),
  );
  await assert.rejects(source.token(bounded()), /returned 401/u);
  elapsedMs += 500;
  assert.equal(await source.token(bounded()), "recovered");
  assert.equal(minted.length, 2);
});

test("a grant this client cannot bound or present is refused", async () => {
  for (const [response, expected] of [
    [
      new globalThis.Response(
        JSON.stringify({ access_token: "t", expires_in: 900 }),
      ),
      /token_type|invalid/iu,
    ],
    [grantResponse("t", 900, { token_type: "mac" }), /not a bearer token/u],
    [grantResponse("t", 0), /expires_in|greater/u],
    [grantResponse("token\r\nx-injected: yes", 900), /a header can carry/u],
    [grantResponse("token\n", 900), /a header can carry/u],
  ]) {
    const source = clientCredentialsTokenSource(
      credentials({ fetch: async () => response }),
    );
    await assert.rejects(source.token(bounded()), expected);
  }
});

test("a response longer than the byte bound is refused before it is parsed", async () => {
  const source = clientCredentialsTokenSource(
    credentials({
      responseBytesMax: 1,
      fetch: async () => grantResponse("token", 900),
    }),
  );
  await assert.rejects(source.token(bounded()), /byte bound/u);
});

test("a grant response of empty chunks is refused at the configured read bound, before its end is read", async () => {
  const readsMax = 3;
  // One chunk past the read bound, then the end: a read without the bound
  // fails on the empty grant rather than reading forever.
  let pulled = 0;
  const stream = new globalThis.ReadableStream(
    {
      pull(controller) {
        pulled += 1;
        if (pulled > readsMax + 1) controller.close();
        else controller.enqueue(new Uint8Array());
      },
    },
    { highWaterMark: 0 },
  );
  const source = clientCredentialsTokenSource(
    credentials({
      responseReadsMax: readsMax,
      fetch: async () => new globalThis.Response(stream),
    }),
  );
  await assert.rejects(source.token(bounded()), /read bound/u);
  assert.equal(pulled, readsMax + 1);
});

test("an invalidated token is minted again, and only that one", async () => {
  const issuer = drivenSource();
  assert.equal(await issuer.source.token(bounded()), "token-1");
  issuer.advance(5_000);
  issuer.source.invalidate("token-1");
  assert.equal(await issuer.source.token(bounded()), "token-2");
  assert.equal(issuer.minted.length, 2);
  issuer.source.invalidate("token-1");
  issuer.source.invalidate("token-1");
  assert.equal(await issuer.source.token(bounded()), "token-2");
  assert.equal(issuer.minted.length, 2);
});

test("invalidating before anything is held mints nothing", async () => {
  const issuer = drivenSource();
  issuer.source.invalidate("never-granted");
  assert.equal(issuer.minted.length, 0);
  assert.equal(await issuer.source.token(bounded()), "token-1");
  assert.equal(issuer.minted.length, 1);
});

test("a token endpoint that never answers is asked once per cooldown", async () => {
  const failed = failingSource(503, {
    refreshMarginMs: 60_000,
    mintCooldownMs: 5_000,
  });
  for (let attempt = 0; attempt < 20; attempt += 1)
    await assert.rejects(failed.source.token(bounded()));
  assert.equal(failed.minted.length, 1);
  failed.clock.elapsedMs += 5_000;
  await assert.rejects(failed.source.token(bounded()));
  assert.equal(failed.minted.length, 2);
});

test("a wall clock stepping backwards does not strand a refused token", async () => {
  const issuer = drivenSource();
  assert.equal(await issuer.source.token(bounded()), "token-1");
  issuer.advance(5_000);
  issuer.stepClockBack(7_200_000);
  issuer.source.invalidate("token-1");
  assert.equal(await issuer.source.token(bounded()), "token-2");
  assert.equal(issuer.minted.length, 2);
});

test("a cooldown as long as the refresh margin is refused, not accepted quietly", () => {
  for (const mintCooldownMs of [60_000, 60_001])
    assert.throws(
      () =>
        clientCredentialsTokenSource(
          credentials({ refreshMarginMs: 60_000, mintCooldownMs }),
        ),
      /shorter than its refresh margin/u,
    );
});

test("a bound that is not a positive safe integer is refused", () => {
  for (const [name, what] of [
    ["requestTimeoutMs", "request timeout"],
    ["responseBytesMax", "response byte bound"],
    ["responseReadsMax", "response read bound"],
    ["refreshMarginMs", "refresh margin"],
    ["mintCooldownMs", "mint cooldown"],
    ["refusalConfirmMs", "refusal confirmation"],
  ])
    for (const refused of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])
      assert.throws(
        () => clientCredentialsTokenSource(credentials({ [name]: refused })),
        new RegExp(`${what} must be a positive safe integer`, "u"),
        `${name} ${String(refused)}`,
      );
});

test("a token URL that is no web address or carries a credential, and an empty identity, are refused", () => {
  for (const [overrides, expected] of [
    [{ tokenUrl: "ftp://auth.example/token" }, /is not HTTP/u],
    [{ tokenUrl: "https://a:b@auth.example/token" }, /carries credentials/u],
    [{ clientId: "" }, /identity or secret is empty/u],
    [{ clientSecret: "" }, /identity or secret is empty/u],
  ])
    assert.throws(
      () => clientCredentialsTokenSource(credentials(overrides)),
      expected,
    );
});

test("a token still held is presented through a cooldown rather than refused", async () => {
  const issuer = drivenSource(true);
  assert.equal(await issuer.source.token(bounded()), "token-1");
  issuer.advance(841_000);
  await assert.rejects(issuer.source.token(bounded()), /returned 503/u);
  issuer.advance(1_000);
  assert.equal(await issuer.source.token(bounded()), "token-1");
  assert.equal(issuer.minted.length, 2);
  issuer.advance(5_000);
  await assert.rejects(issuer.source.token(bounded()), /returned 503/u);
  assert.equal(issuer.minted.length, 3);
});

test("a caller's deadline does not cancel the mint the others wait on", async () => {
  let grants = 0;
  let granted;
  const source = clientCredentialsTokenSource(
    credentials({
      requestTimeoutMs: 5_000,
      fetch: (_input, init) =>
        new Promise((resolve, reject) => {
          grants += 1;
          granted = resolve;
          init.signal.addEventListener(
            "abort",
            () => {
              reject(new Error("the mint was cancelled"));
            },
            { once: true },
          );
        }),
    }),
  );
  const leaving = new globalThis.AbortController();
  const left = source.token(leaving.signal);
  const waiting = source.token(globalThis.AbortSignal.timeout(5_000));
  leaving.abort(new Error("the first caller is gone"));
  granted(grantResponse("token-1", 900));
  assert.equal(await waiting, "token-1");
  await assert.rejects(left, /the first caller is gone/u);
  assert.equal(grants, 1);
});

test("the cooldown clock a deployment gets advances and is not the wall clock", async () => {
  const started = clientCredentialsMonotonicMs();
  await wait(20);
  const ended = clientCredentialsMonotonicMs();
  assert.ok(ended - started >= 10, "it advances with real time");
  assert.ok(
    ended < globalThis.performance.timeOrigin,
    "it counts from this process, not from the epoch",
  );
});

test("a source given no clock still enforces and then lifts its cooldown", async () => {
  const minted = [];
  const source = clientCredentialsTokenSource(
    credentials({
      refreshMarginMs: 400,
      mintCooldownMs: 200,
      fetch: mintingTransport(minted, () => failing(503)),
    }),
  );
  await assert.rejects(source.token(bounded()), /returned 503/u);
  await assert.rejects(source.token(bounded()), /within its cooldown/u);
  assert.equal(minted.length, 1);
  await wait(250);
  await assert.rejects(source.token(bounded()), /returned 503/u);
  assert.equal(minted.length, 2);
});

test("a held token past its expiry is not presented through a cooldown", async () => {
  const issuer = drivenSource(true);
  assert.equal(await issuer.source.token(bounded()), "token-1");
  issuer.advance(900_001);
  await assert.rejects(issuer.source.token(bounded()), /returned 503/u);
  issuer.advance(1_000);
  await assert.rejects(issuer.source.token(bounded()), /within its cooldown/u);
  assert.equal(issuer.minted.length, 2);
});

/** The binding and not the function: a source given no clock must reach for the monotonic one. */
test("a source given no clock does not measure its cooldown on the wall clock", async () => {
  const minted = [];
  const served = Date.now;
  let wallOffsetMs = 0;
  Date.now = () => served() + wallOffsetMs;
  try {
    const source = clientCredentialsTokenSource(
      credentials({
        refreshMarginMs: 400,
        mintCooldownMs: 200,
        fetch: mintingTransport(minted, () => failing(503)),
      }),
    );
    await assert.rejects(source.token(bounded()), /returned 503/u);
    wallOffsetMs = -3_600_000;
    await wait(250);
    await assert.rejects(source.token(bounded()), /returned 503/u);
    assert.equal(minted.length, 2);
  } finally {
    Date.now = served;
  }
});

/** The issuer takes longer to answer than the life it grants, which would turn a grant-derived bound into a mint per read. */
test("a grant too short-lived to keep a cooldown around is refused, once per cooldown", async () => {
  const minted = [];
  let nowEpochMs = 1_000_000;
  let elapsedMs = 0;
  const granting = mintingTransport(minted, () => grantResponse("token", 5));
  const source = clientCredentialsTokenSource(
    credentials({
      requestTimeoutMs: 10_000,
      refreshMarginMs: 60_000,
      mintCooldownMs: 59_000,
      fetch: (input, init) => {
        nowEpochMs += 6_000;
        elapsedMs += 6_000;
        return granting(input, init);
      },
      currentTimeEpochMs: () => nowEpochMs,
      monotonicMs: () => elapsedMs,
    }),
  );
  const answers = [];
  for (let read = 0; read < 100; read += 1)
    await source.token(bounded()).then(
      () => answers.push("granted"),
      (failure) => answers.push(failure.message),
    );
  assert.equal(minted.length, 1, "one grant, however many reads");
  assert.ok(!answers.includes("granted"));
  assert.match(answers[0], /lives 5000ms/u);
  assert.match(answers[0], /59000ms cooldown/u);
  assert.match(answers[99], /within its cooldown/u);
});

/** A grant that succeeded says nothing about how long to wait after the attempt that did not. */
test("a failure after a success still waits the whole configured cooldown", async () => {
  const issuer = drivenSource(true);
  assert.equal(await issuer.source.token(bounded()), "token-1");
  issuer.advance(841_000);
  await assert.rejects(issuer.source.token(bounded()), /returned 503/u);
  issuer.advance(4_000);
  assert.equal(await issuer.source.token(bounded()), "token-1");
  assert.equal(issuer.minted.length, 2, "the failed attempt is still cooling");
  issuer.advance(1_001);
  await assert.rejects(issuer.source.token(bounded()), /returned 503/u);
  assert.equal(issuer.minted.length, 3);
});

test("a failed attempt still waits the whole configured cooldown", async () => {
  const failed = failingSource(503, {
    refreshMarginMs: 60_000,
    mintCooldownMs: 59_000,
  });
  await assert.rejects(failed.source.token(bounded()), /returned 503/u);
  failed.clock.elapsedMs += 58_000;
  await assert.rejects(failed.source.token(bounded()), /within its cooldown/u);
  assert.equal(failed.minted.length, 1);
  failed.clock.elapsedMs += 1_000;
  await assert.rejects(failed.source.token(bounded()), /returned 503/u);
  assert.equal(failed.minted.length, 2);
});

test("a proxy's plain-text 404 from the token URL is an outage", async () => {
  assert.deepEqual(
    await poolClientTokens(
      credentials({ fetch: async () => proxyNotFound() }),
    ).acquire(),
    {
      acquired: "Unavailable",
      evidence: "client credentials grant returned 404",
    },
  );
});

test("Hydra's 401 invalid_client is an outage while it is confirmed, naming its code", async () => {
  assert.deepEqual(
    await poolClientTokens(
      credentials({ fetch: async () => refusal(401, "invalid_client") }),
    ).acquire(),
    {
      acquired: "Unavailable",
      evidence:
        "client credentials grant returned 401 invalid_client, a refusal being confirmed: 0s of 60s",
    },
  );
});

test("a grant the issuer refused is a denial, one a failed lookup also gives is confirmed first, and everything else is an outage, neither naming the secret", async () => {
  const oversized = JSON.stringify({
    error: "invalid_client",
    error_description: "x".repeat(10_000),
  });
  for (const [answer, expected] of [
    ...[
      "invalid_request",
      "invalid_grant",
      "unauthorized_client",
      "unsupported_grant_type",
      "invalid_scope",
    ].map((code) => [async () => refusal(400, code), "Denied"]),
    [async () => refusal(400, "invalid_client"), "Unavailable"],
    [async () => refusal(403, "invalid_client"), "Unavailable"],
    [async () => refusal(404, "invalid_client"), "Unavailable"],
    [async () => refusal(401, "server_error"), "Unavailable"],
    [async () => refusal(400, "temporarily_unavailable"), "Unavailable"],
    [async () => failing(400), "Unavailable"],
    [async () => failing(401), "Unavailable"],
    [
      async () =>
        new globalThis.Response(JSON.stringify("invalid_client"), {
          status: 401,
        }),
      "Unavailable",
    ],
    [
      async () => new globalThis.Response(oversized, { status: 401 }),
      "Unavailable",
    ],
    [async () => failing(500), "Unavailable"],
    [async () => failing(503), "Unavailable"],
    [
      async () =>
        new globalThis.Response(JSON.stringify({ expires_in: 60 }), {
          status: 200,
        }),
      "Unavailable",
    ],
    [
      async () => {
        throw new Error("connection refused");
      },
      "Unavailable",
    ],
  ]) {
    const acquired = await poolClientTokens(
      credentials({ fetch: answer }),
    ).acquire();
    assert.equal(acquired.acquired, expected, String(answer));
    assert.ok(!acquired.evidence.includes(secret), acquired.evidence);
  }
});

test("a granted token is handed over with the audience the pool was registered for", async () => {
  const minted = [];
  const acquired = await poolClientTokens(
    credentials({
      audience: ["https://api.invalid"],
      fetch: mintingTransport(minted, () => grantResponse("minted", 3_600)),
    }),
  ).acquire();
  assert.deepEqual(acquired, { acquired: "Token", token: "minted" });
  assert.equal(minted[0].form.get("audience"), "https://api.invalid");
  assert.equal(minted[0].form.get("grant_type"), "client_credentials");
});

test("a token the plane refused is minted again on the next acquire", async () => {
  const issuer = drivenSource();
  const tokens = poolClientTokens(issuer.config);
  assert.deepEqual(await tokens.acquire(), {
    acquired: "Token",
    token: "token-1",
  });
  assert.equal((await tokens.acquire()).token, "token-1");
  issuer.advance(5_000);
  tokens.invalidate("token-1");
  assert.equal((await tokens.acquire()).token, "token-2");
  assert.equal(issuer.minted.length, 2);
});

/** The plane a pool polls, answering every request with `status` and counting them. */
function planeAnswering(status, presented = []) {
  return poolPlaneClient(
    {
      baseUrl: "https://pool-plane.invalid",
      pollTimeoutMs: 1_000,
      settleTimeoutMs: 1_000,
    },
    async (_input, init) => {
      presented.push(init.headers.authorization);
      return new globalThis.Response(
        status === 200
          ? JSON.stringify({ assignments: [], sessions: [], stop: [] })
          : "{}",
        { status },
      );
    },
  );
}

/** A pool over `issuer`'s tokens and `plane`, holding nothing and placing everything. */
function pool(issuer, plane, passesMax = 1) {
  return {
    tokens: poolClientTokens(issuer.config),
    plane,
    jobs: { end: async () => "Ended" },
    backend: {
      place: async () => ({ placed: "Placed" }),
      stop: async () => ({ stopped: "Stopped" }),
      held: async () => [],
      ended: async () => [],
    },
    settings: { concurrencyMax: 1, outageBackoffMs: 1, passesMax },
  };
}

test("the loop presents the replacement token, not the first one", async () => {
  const issuer = drivenSource();
  const presented = [];
  const running = pool(issuer, planeAnswering(200, presented));
  await workerPoolClientPass(running);
  issuer.advance(841_000);
  await workerPoolClientPass(running);
  assert.deepEqual(presented, ["Bearer token-1", "Bearer token-2"]);
});

test("a plane that refuses every token costs one grant per cooldown, not one per pass", async () => {
  const issuer = drivenSource();
  const presented = [];
  const running = pool(issuer, planeAnswering(401, presented), 20);
  const passed = await workerPoolClientRun(running, async () => undefined);
  assert.equal(passed.passed, "Unavailable");
  assert.equal(presented.length, 1);
  assert.equal(issuer.minted.length, 1);
  issuer.advance(5_000);
  await workerPoolClientPass(running);
  assert.equal(issuer.minted.length, 2);
});

/**
 * A pool over an issuer answering each grant from `issued` in turn, the last
 * from then on, and a plane answering every poll empty, on clocks that move
 * only by what `sleep` moves them.
 *
 * @param {Array<() => Response>} issued
 */
function issuedPool(issued, plane = planeAnswering(200)) {
  const minted = [];
  const clock = { nowEpochMs: 1_000_000, elapsedMs: 0 };
  const config = credentials({
    refreshMarginMs: 60_000,
    mintCooldownMs: 5_000,
    fetch: mintingTransport(minted, (attempt) =>
      issued[Math.min(attempt, issued.length) - 1](),
    ),
    currentTimeEpochMs: () => clock.nowEpochMs,
    monotonicMs: () => clock.elapsedMs,
  });
  return {
    minted,
    running: pool({ config }, plane, 10),
    sleep: (milliseconds) => async () => {
      clock.nowEpochMs += milliseconds;
      clock.elapsedMs += milliseconds;
    },
  };
}

test("a run backs off through a proxy's 404 in front of the issuer and of the plane, and ends on the issuer refusing its client", async () => {
  const polled = [];
  const plane = poolPlaneClient(
    {
      baseUrl: "https://pool-plane.invalid",
      pollTimeoutMs: 1_000,
      settleTimeoutMs: 1_000,
    },
    async (input) => {
      polled.push(String(input));
      return proxyNotFound();
    },
  );
  const issuer = issuedPool(
    [
      proxyNotFound,
      () => grantResponse("token-1", 900),
      () => refusal(401, "invalid_client"),
    ],
    plane,
  );
  let slept = 0;
  const passed = await workerPoolClientRun(issuer.running, async () => {
    slept += 1;
    await issuer.sleep(841_000)();
  });
  assert.deepEqual(passed, {
    passed: "Denied",
    evidence: "client credentials grant returned 401 invalid_client",
  });
  assert.equal(slept, 3);
  assert.equal(issuer.minted.length, 4);
  assert.equal(polled.length, 1);
});

test("an invalid_client the issuer gives once and then grants past keeps the run going", async () => {
  const issuer = issuedPool([
    () => refusal(401, "invalid_client"),
    () => grantResponse("token-1", 900),
  ]);
  const passed = await workerPoolClientRun(issuer.running, issuer.sleep(5_000));
  assert.equal(passed.passed, "Reconciled");
  assert.equal(issuer.minted.length, 2);
});

/**
 * Each grant is a pass and a back-off apart. The refusal is confirmed by the
 * first grant at least the interval after the first refused, and by no
 * earlier one.
 */
test("an invalid_client the issuer gives every grant across the interval ends the run, logged as being confirmed until then", async () => {
  const issuer = issuedPool([() => refusal(401, "invalid_client")]);
  const log = [];
  const passed = await poolRunnerLoop(issuer.running, {
    sleep: issuer.sleep(30_000),
    log: (line) => log.push(line),
  });
  assert.deepEqual(passed, {
    passed: "Denied",
    evidence: "client credentials grant returned 401 invalid_client",
  });
  assert.deepEqual(log, [
    "outage: client credentials grant returned 401 invalid_client, a refusal being confirmed: 0s of 60s",
    "outage: client credentials grant returned 401 invalid_client, a refusal being confirmed: 30s of 60s",
    "the plane denied this pool: client credentials grant returned 401 invalid_client",
  ]);
  assert.equal(issuer.minted.length, 3);
});

/**
 * Each pass is longer apart than the interval, so a refusal carried across
 * the answer between would be final at the third pass rather than the fourth.
 */
test("a refusal any other answer breaks is confirmed afresh from the next", async () => {
  for (const [broken, between] of [
    [() => grantResponse("token-1", 61), "Reconciled"],
    [proxyNotFound, "Unavailable"],
    [() => refusal(400, "invalid_client"), "Unavailable"],
  ]) {
    const issuer = issuedPool([
      () => refusal(401, "invalid_client"),
      broken,
      () => refusal(401, "invalid_client"),
    ]);
    const passes = [];
    for (let pass = 0; pass < 4; pass += 1) {
      passes.push((await workerPoolClientPass(issuer.running)).passed);
      await issuer.sleep(70_000)();
    }
    assert.deepEqual(
      passes,
      ["Unavailable", between, "Unavailable", "Denied"],
      String(broken),
    );
    assert.equal(issuer.minted.length, 4);
  }
});
