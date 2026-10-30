import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { workerPlaneAnswers } from "@chuggy/worker-contract/workerPlane";

import {
  heldCredentials,
  heldCredentialsUnmounted,
} from "./heldCredentials.mjs";
import { overPlane, planeFetch, planes } from "./plane.fixture.mjs";
import { WorkerPlaneRefusal, workerRequest } from "./transport.mjs";

const task = { workerPlane: { url: "http://worker-plane.test:3001" } };
const trackRecord = {
  credential: "track-record",
  variable: "TRACK_RECORD_TOKEN_FILE",
  secret: "track-record-0123456789abcdefghij",
};

/** A plane answering the held credentials route `answer`, every ask of it recorded. */
function heldPlane(answer) {
  const plane = planeFetch(planes.job, () => answer);
  return {
    asked: plane.asked,
    request: overPlane(workerRequest, plane.fetch),
  };
}

/**
 * What one ask, given `granted` and the launcher's `credentialFiles`, kept and
 * wrote; through `write` where a case names it, which `written` then holds
 * nothing of.
 */
async function asked(
  plane,
  granted,
  credentialFiles = {},
  directory = "/m",
  write,
) {
  const kept = [];
  const written = [];
  const held = await heldCredentials({
    task,
    bearer: "capability",
    granted,
    credentialFiles,
    directory,
    keep: (value) => kept.push(value),
    request: plane.request,
    write:
      write ??
      (async (file, content, options) => {
        written.push({ file, content, options });
      }),
  });
  return { held, kept, written };
}

/** Catches a name the launcher mounted asked of the plane, and a name asked twice. */
test("only the granted names the launcher did not mount are asked for", async () => {
  assert.deepEqual(
    heldCredentialsUnmounted(
      ["forge", "claude-code", "track-record", "forge"],
      { "claude-code": "/c" },
    ),
    ["forge", "track-record"],
  );

  const plane = heldPlane({ status: 200, body: { credentials: [] } });
  await asked(plane, ["claude-code", "track-record"], { "claude-code": "/c" });

  assert.deepEqual(
    plane.asked.map(({ route, body }) => ({ route, body })),
    [{ route: "heldCredentials", body: { credentials: ["track-record"] } }],
  );
});

/** Catches a pod every granted name was mounted for asking anyway, as a pod launched with a credential map would. */
test("a pod mounted every granted name asks nothing", async () => {
  const plane = heldPlane({ status: 200, body: { credentials: [] } });

  const { held } = await asked(plane, ["forge"], { forge: "/f" });

  assert.deepEqual(held, []);
  assert.deepEqual(plane.asked, []);
});

/** Catches an empty answer read as a failure. */
test("a plane holding none of those asked is nothing to do", async () => {
  const plane = heldPlane({ status: 200, body: { credentials: [] } });

  assert.deepEqual(await asked(plane, ["track-record"]), {
    held: [],
    kept: [],
    written: [],
  });
});

/**
 * Catches a secret written before it is kept among the attempt's secrets, a
 * file anywhere but the minted directory, or one a user but the pod's reads.
 */
test("a held credential is kept, then written privately under the minted directory", async () => {
  const plane = heldPlane({
    status: 200,
    body: { credentials: [{ ...trackRecord, expiresAtMs: 1 }] },
  });
  const order = [];
  await heldCredentials({
    task,
    bearer: "capability",
    granted: ["track-record"],
    credentialFiles: {},
    directory: "/m",
    keep: () => order.push("kept"),
    request: plane.request,
    write: async () => {
      order.push("written");
    },
  });
  assert.deepEqual(order, ["kept", "written"]);

  const directory = await mkdtemp(join(tmpdir(), "chuggy-held-"));
  try {
    const { held, kept } = await asked(
      plane,
      ["track-record"],
      {},
      directory,
      writeFile,
    );

    const file = join(directory, "held-track-record");
    assert.deepEqual(held, [
      {
        credential: trackRecord.credential,
        variable: trackRecord.variable,
        file,
      },
    ]);
    assert.deepEqual(kept, [trackRecord.secret]);
    assert.equal(await readFile(file, "utf8"), trackRecord.secret);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Catches a refusal read as the plane holding nothing, which runs the job's shells without the credential. */
test("a refusal of the held credentials route fails the ask", async () => {
  for (const status of [400, 401, 409]) {
    const plane = heldPlane({ status });

    await assert.rejects(
      asked(plane, ["track-record"]),
      WorkerPlaneRefusal,
      String(status),
    );
    assert.equal(plane.asked.length, 1, String(status));
  }
});

/** Catches an outage given up on and read as the plane holding nothing. */
test("an outage of the held credentials route is asked again, and one past the retries fails the ask", async () => {
  assert.ok(Object.hasOwn(workerPlaneAnswers.heldCredentials, 503));
  const plane = heldPlane({ status: 503 });

  await assert.rejects(asked(plane, ["track-record"]), /answered 503/u);
  assert.ok(plane.asked.length > 1, String(plane.asked.length));
});

/** Catches an answer the schema refuses, or one serving a name not asked, which would be written and handed on. */
test("an answer this pod cannot read, or one serving a name not asked, fails the ask", async () => {
  const unread = async (credentials) => {
    const plane = { request: async () => ({ json: async () => credentials }) };
    await assert.rejects(asked(plane, ["track-record"]));
  };
  await unread({
    credentials: [{ ...trackRecord, variable: "GIT_TOKEN_FILE" }],
  });
  await unread({ credentials: [{ ...trackRecord, secret: "" }] });
  await unread({ credentials: [{ ...trackRecord, credential: "forge" }] });
  await unread("not an answer");
});

/** Catches a granted name that would write its secret outside the minted directory. */
test("an answer serving a name no file in the minted directory can be named by fails the ask, keeping and writing nothing", async () => {
  const credential = "a/../../x";
  const plane = heldPlane({
    status: 200,
    body: { credentials: [{ ...trackRecord, credential }] },
  });
  const kept = [];
  const written = [];

  await assert.rejects(
    heldCredentials({
      task,
      bearer: "capability",
      granted: [credential],
      credentialFiles: {},
      directory: "/m",
      keep: (value) => kept.push(value),
      request: plane.request,
      write: async (file) => {
        written.push(file);
      },
    }),
    /no file in the minted directory can be named by/u,
  );
  assert.deepEqual(
    plane.asked.map(({ body }) => body),
    [{ credentials: [credential] }],
  );
  assert.deepEqual(kept, []);
  assert.deepEqual(written, []);
});
