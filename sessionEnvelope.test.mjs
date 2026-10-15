import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";

import {
  sessionConfigDirectoryVariable,
  workerCredentialFilesVariable,
  workerTaskVariable,
} from "@chuggy/worker-contract/workerEnvironment";
import { poolEnvelopeSchema } from "@chuggy/worker-contract/workerTask";

import { workerImageVariable } from "./checks.mjs";
import { poolHeldSessionAnswer as answer } from "./envelope.fixture.mjs";
import { overPlane, planeFetch, planes } from "./plane.fixture.mjs";
import { sessionEnvelopeServices } from "./session.mjs";
import {
  facts,
  leadRoster,
  queryOf,
  result,
  run,
  token,
  turnOne,
} from "./sessionHarness.fixture.mjs";
import { sessionRequest } from "./sessionTransport.mjs";

/** A pool's envelope for a session it holds, every field of it distinct from what a pod is launched with. */
const envelope = poolEnvelopeSchema.parse({
  callbackUrl: "http://pool-plane.test:3002",
  bearer: "chgs_fedcba9876543210fedcba9876543210",
  workspace: "/pool/workspace",
  timeoutSecsMax: 1_800,
  outputBytesMax: 4_096,
  providerCredentialFile: "/pool/credentials/claude-code",
});

/** The runner's own environment, which the envelope reached the pod through. */
const site = {
  [workerTaskVariable]: JSON.stringify(envelope),
  SITE_VARIABLE: "set by the runner",
};

/**
 * A session plane at whatever origin the pod reaches it, recording each call's
 * origin and bearer, and handing over one turn.
 */
function sessionPlane() {
  const reached = [];
  let claims = 0;
  const plane = planeFetch(planes.session, (route) => {
    switch (route) {
      case "facts":
        return { status: 200, body: { ...facts, capabilities: leadRoster } };
      case "turn":
        claims += 1;
        return claims === 1 ? { status: 200, body: turnOne } : { status: 204 };
      case "credential":
        return { status: 404, body: { reason: "ForgeNotConfigured" } };
      case "storeStreams":
        return { status: 200, body: { streams: [] } };
      default:
        return { status: 204 };
    }
  });
  return {
    reached,
    request: overPlane(sessionRequest, async (url, init) => {
      reached.push({
        origin: new URL(url).origin,
        authorization: init.headers.authorization,
      });
      return plane.fetch(url, init);
    }),
  };
}

/** The envelope's session run to its end, with what it read, reached and was opened with. */
async function envelopeRun(launched = answer) {
  const plane = sessionPlane();
  const reads = [];
  const api = [];
  const warned = [];
  const { seen, query } = queryOf((_asked, _index, options) => [
    async () => {
      await options.mcpServers.chuggy.tools
        .find((tool) => tool.name === "read_ticket")
        .handler({ ticket: 4 });
    },
    result("success", { result: "read" }),
  ]);
  const code = await run({
    ...sessionEnvelopeServices(envelope, launched, site),
    read: async (path) => {
      reads.push(path);
      return `${token}\n`;
    },
    warn: (text) => warned.push(text),
    request: plane.request,
    query,
    chuggyRequest: async (task, bearer, path) => {
      api.push({ url: task.api.url, bearer, path });
      return { status: 200, text: async () => "{}" };
    },
  });
  return { code, reached: plane.reached, reads, api, warned, seen };
}

/**
 * Catches an envelope's session reaching any plane but the envelope's, under
 * any bearer but the envelope's, reading its token from any file but the one
 * the pool mounted, or opened with any model, bound or API but the answer's.
 */
test("an envelope's session runs on the envelope's plane, bearer and credential file, and the answer's model, bounds and API", async () => {
  const ran = await envelopeRun();

  assert.equal(ran.code, 0, ran.warned.join(""));
  assert.ok(ran.reached.length > 0);
  assert.deepEqual(
    [...new Set(ran.reached.map((call) => JSON.stringify(call)))],
    [
      JSON.stringify({
        origin: envelope.callbackUrl,
        authorization: `Bearer ${envelope.bearer}`,
      }),
    ],
  );
  assert.deepEqual(ran.reads, [envelope.providerCredentialFile]);
  const { options } = ran.seen;
  assert.equal(options.model, answer.model);
  assert.equal(options.maxTurns, answer.bounds.turnsMax);
  assert.equal(options.maxBudgetUsd, answer.bounds.budgetUsd);
  assert.equal(options.loadTimeoutMs, answer.bounds.loadTimeoutMs);
  assert.equal(options.cwd, envelope.workspace);
  assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, token);
  assert.deepEqual(ran.api, [
    {
      url: answer.api.url,
      bearer: envelope.bearer,
      path: "/api/v1/tenants/vteng/projects/chuggy/tickets/4",
    },
  ]);
});

/** Catches the envelope, and with it the bearer, reaching the runtime and every command its tools run. */
test("an envelope's session leaves the envelope out of the runtime's environment, and keeps the runner's own", async () => {
  const { options } = (await envelopeRun()).seen;

  assert.ok(!(workerTaskVariable in options.env));
  assert.ok(
    !Object.values(options.env).some((value) =>
      String(value).includes(envelope.bearer),
    ),
    "the bearer reached the runtime's environment",
  );
  assert.equal(options.env.SITE_VARIABLE, site.SITE_VARIABLE);
  assert.equal(
    options.env[sessionConfigDirectoryVariable],
    join(envelope.workspace, ".claude"),
  );
});

/** Catches the pool's credential file mounted under any slot but the one the plane's task names. */
test("an envelope's credential file is mounted in the slot the plane's task names", () => {
  const { environment } = sessionEnvelopeServices(
    envelope,
    { ...answer, credentialSlot: "pool-slot" },
    site,
  );

  assert.deepEqual(JSON.parse(environment[workerCredentialFilesVariable]), {
    "pool-slot": envelope.providerCredentialFile,
  });
});

/**
 * Catches a session's runtime, which is chuggy's own process and no project's
 * shell, handed back what `check.sh` moved aside to keep it unsteered.
 */
test("an envelope's session runtime is not handed what check.sh moved aside", () => {
  const kept = workerImageVariable("LD_PRELOAD");
  const { environment } = sessionEnvelopeServices(envelope, answer, {
    ...site,
    [kept]: "/image/preload.so",
  });

  assert.equal(environment.LD_PRELOAD, undefined);
  assert.equal(environment[kept], "/image/preload.so");
});

/** Catches a bound the plane answered unchecked, which the contract reads as any number at all. */
test("an envelope's session with a bound that is not positive is refused, naming the plane's task", async () => {
  const ran = await envelopeRun({
    ...answer,
    bounds: { ...answer.bounds, idleMs: 0 },
  });

  assert.equal(ran.code, 1);
  assert.deepEqual(ran.reached, []);
  assert.match(
    ran.warned.join(""),
    /^the worker plane's session task needs a positive idleMs and carries 0$/mu,
  );
});
