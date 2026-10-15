import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { resultReportCharsMax } from "@chuggy/worker-contract/workerDocuments";
import { workerPlaneAnswers } from "@chuggy/worker-contract/workerPlane";

import { planeFetch, planes } from "./plane.fixture.mjs";
import {
  checkedPoolJobPlaneClientSettings,
  poolJobEndedText,
  poolJobPlaneClient,
  poolJobRefusedText,
} from "./poolJobPlane.mjs";

const settings = { timeoutMs: 1_000 };
const bearer = "0123456789abcdef".repeat(4);

/** A workload that ended unreported, as a backend names it. */
const ended = {
  kind: "Job",
  job: {
    assignment: "assignment-one",
    callbackUrl: "https://worker-plane.invalid/v1/ticket-execution",
    bearer,
  },
  why: "its container exited with status 1",
};

/**
 * A job plane answering `ending` to the end and `left` to the error text,
 * recording each request as the contract reads it and the bearer it came under.
 */
function jobPlane(ending, left = 204) {
  const plane = planeFetch(planes.job, (route) => ({
    status: route === "runEnded" ? ending : left,
  }));
  const authorized = [];
  return {
    asked: plane.asked,
    authorized,
    fetch: async (url, init) => {
      authorized.push(init.headers.authorization);
      return plane.fetch(url, init);
    },
  };
}

test("an ended workload's attempt is left its reason, then ended as a failed run under its own bearer", async () => {
  const plane = jobPlane(204);
  const answered = await poolJobPlaneClient(settings, plane.fetch).end(ended);

  assert.equal(answered, "Ended");
  assert.deepEqual(
    plane.asked.map(({ route, path }) => [route, path]),
    [
      ["artifact", "/v1/artifacts/.chuggy/worker-error.txt"],
      ["runEnded", "/v1/run/ended"],
    ],
  );
  assert.equal(
    Buffer.from(plane.asked[0].body).toString("utf8"),
    "Worker exited before reporting: its container exited with status 1\n",
  );
  assert.deepEqual(plane.asked[1].body, { evidence: "RunFailed" });
  assert.deepEqual(plane.authorized, [`Bearer ${bearer}`, `Bearer ${bearer}`]);
});

test("an attempt the plane will not end is refused, and one it could not be asked about is unavailable", async () => {
  const refusals = Object.keys(workerPlaneAnswers.runEnded)
    .map(Number)
    .filter((status) => status !== 204);
  assert.ok(refusals.length > 0);
  for (const status of refusals)
    assert.equal(
      await poolJobPlaneClient(settings, jobPlane(status).fetch).end(ended),
      "Refused",
      String(status),
    );
  assert.equal(
    await poolJobPlaneClient(
      settings,
      async () => new globalThis.Response(null, { status: 503 }),
    ).end(ended),
    "Unavailable",
  );
  assert.equal(
    await poolJobPlaneClient(settings, async () => {
      throw new TypeError("fetch failed");
    }).end(ended),
    "Unavailable",
  );
});

test("the end is asked for even where the reason could not be left", async () => {
  const plane = jobPlane(204);
  const answered = await poolJobPlaneClient(settings, async (url, init) => {
    if (init.method === "PUT") throw new TypeError("fetch failed");
    return plane.fetch(url, init);
  }).end(ended);

  assert.equal(answered, "Ended");
  assert.deepEqual(
    plane.asked.map(({ route }) => route),
    ["runEnded"],
  );
});

test("a plane that never answers is given up on at the timeout", async () => {
  const answered = await poolJobPlaneClient(
    { timeoutMs: 10 },
    (_url, init) =>
      new Promise((_answered, failed) => {
        init.signal?.addEventListener("abort", () =>
          failed(init.signal.reason),
        );
      }),
  ).end(ended);

  assert.equal(answered, "Unavailable");
});

test("the reason is one printable line, scrubbed of the bearer and no longer than a report", () => {
  const text = poolJobEndedText({
    ...ended,
    why: `exited\nholding ${bearer}\u001b[31m ${"x".repeat(resultReportCharsMax)}`,
  });

  assert.match(text, /^Worker exited before reporting: exited holding /u);
  assert.ok(!text.includes(bearer));
  assert.ok(!text.includes("\u001b"));
  assert.equal(text.indexOf("\n"), text.length - 1);
  assert.equal(text.length, resultReportCharsMax + 1);
});

test("a refused job's attempt is left the refusal's own words under its bearer, and is not ended, whatever the plane answers", async () => {
  const refused = {
    ...ended,
    why: "The image this job names has no git on its PATH.",
    refusal: { fault: "ImageLacksGit" },
  };
  for (const left of [204, 409, 503]) {
    const plane = jobPlane(204, left);
    assert.equal(
      await poolJobPlaneClient(settings, plane.fetch).left(refused),
      undefined,
    );
    assert.deepEqual(
      plane.asked.map(({ route, path }) => [route, path]),
      [["artifact", "/v1/artifacts/.chuggy/worker-error.txt"]],
    );
    assert.equal(
      Buffer.from(plane.asked[0].body).toString("utf8"),
      "The image this job names has no git on its PATH.\n",
    );
    assert.deepEqual(plane.authorized, [`Bearer ${bearer}`]);
  }
  await poolJobPlaneClient(settings, async () => {
    throw new TypeError("fetch failed");
  }).left(refused);
});

test("a refusal's words are one printable line, scrubbed of the bearer and no longer than a report", () => {
  const text = poolJobRefusedText({
    ...ended,
    why: `refused\nholding ${bearer}\u001b[31m ${"x".repeat(resultReportCharsMax)}`,
  });

  assert.match(text, /^refused holding /u);
  assert.ok(!text.includes(bearer));
  assert.ok(!text.includes("\u001b"));
  assert.equal(text.indexOf("\n"), text.length - 1);
  assert.equal(text.length, resultReportCharsMax + 1);
});

test("a timeout that is not a positive whole number is refused", () => {
  for (const timeoutMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])
    assert.throws(
      () => checkedPoolJobPlaneClientSettings({ timeoutMs }),
      /pool job plane timeout must be a positive integer/u,
    );
});
