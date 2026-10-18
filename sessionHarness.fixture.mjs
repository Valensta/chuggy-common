/**
 * The doubles the session suites drive the pod through: a worker plane built
 * from the contract's answer maps and reached through the pod's own transport,
 * a runtime whose messages a case scripts, and the one `sessionMain` call that
 * wires them together.
 *
 * IT IS A MODULE RATHER THAN A COPY BECAUSE THE TAIL KEPT COLLIDING. The pod's
 * suites are appended to, and two of them appended at the same offset twice
 * over; a suite per subject is what stops that, and a suite per subject needs
 * one harness rather than one each.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sessionTaskVariable,
  workerCredentialFilesVariable,
  workerRepositoriesVariable,
  workerWorkspaceVariable,
} from "@chuggy/worker-contract/workerEnvironment";
import { z } from "zod";

import { overPlane, planeFetch, planes } from "./plane.fixture.mjs";
import { sessionMain } from "./session.mjs";
import { sessionRequest, sessionRequestOnce } from "./sessionTransport.mjs";

/**
 * The rosters the session suites open a lead and a thread with. They are cases
 * rather than copies: which roster a session is opened with is the provisioning
 * root's, and `contract.test.mjs` holds the pod over every roster there is.
 */
export const leadRoster = [
  "RepositoryRead",
  "ProjectRead",
  "DraftAuthor",
  "LeadDecision",
];
export const threadRoster = [
  "RepositoryRead",
  "RunCommands",
  "ProjectRead",
  "DraftAuthor",
  "DraftOriginate",
];

/** The rejection frame kasofsk/chuggy#386 reports, as the runtime declares it. */
export const rejection = {
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
};

export const bearerFile = "/var/run/chuggy/session-capability/bearer";
export const credentialFile = "/var/run/chuggy/credentials/claude-code";
export const bearer = "chgs_0123456789abcdef0123456789abcdef";
export const token = "sk-ant-oat01-0123456789abcdefghijklmnop";

export const task = {
  tenant: "vteng",
  project: "chuggy",
  session: "session-1",
  kind: "Lead",
  attempt: "attempt-1",
  generation: 1,
  workerPlane: {
    url: "http://worker-plane.test:3001",
    capabilityFile: bearerFile,
  },
  api: { url: "http://chuggy-api.test:3000" },
  bounds: {
    mailboxPollMs: 1,
    idleMs: 1,
    resultDrainMs: 50,
    loadTimeoutMs: 1_000,
    turnsMax: 200,
    budgetUsd: 5,
  },
};

export const environment = {
  [sessionTaskVariable]: JSON.stringify(task),
  [workerCredentialFilesVariable]: JSON.stringify({
    "claude-code": credentialFile,
  }),
  [workerWorkspaceVariable]: "/workspace",
};

/** The environment of a session placed against a repository the site's map holds. */
export const boundEnvironment = {
  ...environment,
  [sessionTaskVariable]: JSON.stringify({
    ...task,
    repository: { reference: "chuggy" },
  }),
  [workerRepositoriesVariable]: JSON.stringify({ chuggy: { url: "git://x" } }),
};

/** What a plane that mints answers, and what this pod would then present to git. */
export const mintedCredential = {
  username: "x-access-token",
  password: "ghs_0123456789abcdefghijklmnopqrstuvwxyz",
  expiresAtMs: 1_900_000_000_000,
};

/**
 * A question the plane holds for as long as its asker does, ended as `fetch`
 * ends a request that was let go of.
 */
export function heldUntilLetGo(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
}

/**
 * The plane a case drives. `minted` is what the session credential route
 * answers, or what it answers for each repository named, nothing where it
 * mints none; without one the plane mints nothing, which is the deployment
 * every case that is about something else runs under. `refuse(path)` names a
 * status to answer a path with instead, which must be one its route answers.
 * `stopped(turn, signal)` answers the watch on a turn, which without one is
 * held for as long as the turn is watched, as a plane holds it for a turn
 * nobody stopped. `live(post)` answers a post of live events, which without
 * one is taken.
 */
export function planeOf(
  turns,
  facts,
  refuse = () => undefined,
  minted,
  stopped = (_turn, signal) => heldUntilLetGo(signal),
  live = () => ({ status: 204 }),
) {
  const calls = [];
  let claims = 0;
  const answer = (route, { path, method, body }, signal) => {
    const refused = refuse(path.split("?")[0]);
    if (refused !== undefined) {
      calls.push({ path, method });
      return { status: refused };
    }
    calls.push({ path, method, body });
    switch (route) {
      case "facts":
        return { status: 200, body: facts };
      case "credential": {
        const answered =
          typeof minted === "function" ? minted(body.repository) : minted;
        return answered === undefined
          ? { status: 404, body: { reason: "ForgeNotConfigured" } }
          : { status: 200, body: answered };
      }
      case "turn": {
        const turn = turns[claims];
        claims += 1;
        return turn === undefined
          ? { status: 204 }
          : { status: 200, body: turn };
      }
      case "turnStopped":
        return stopped(body.turn, signal);
      case "turnLive":
        return live(body);
      case "storeStreams":
        return { status: 200, body: { streams: [] } };
      case "storePage":
        return { status: 200, body: { batches: [] } };
      default:
        return { status: 204 };
    }
  };
  const plane = planeFetch(planes.session, answer);
  return {
    calls,
    request: overPlane(sessionRequest, plane.fetch),
    requestOnce: overPlane(sessionRequestOnce, plane.fetch),
  };
}

export function queryOf(script) {
  const seen = {};
  return {
    seen,
    query: ({ prompt, options }) => {
      seen.options = options;
      return (async function* messages() {
        let index = 0;
        for await (const asked of prompt) {
          for (const message of script(asked, index, options)) {
            if (typeof message === "function") await message();
            else yield message;
          }
          index += 1;
        }
      })();
    },
  };
}

export const facts = {
  tenant: "vteng",
  project: "chuggy",
  session: "session-1",
  kind: "Lead",
  capabilities: ["RepositoryRead", "RunCommands"],
  credentialSlot: "claude-code",
};

/**
 * The runtime as this pod resolves it, with the suite's own `query`. The other
 * three members are what the in-process server is built from, and `zod` is the
 * real one: a stub shape would prove the tools were registered and nothing about
 * whether their bounds hold.
 */
function sdkOf(query) {
  return {
    query,
    z,
    tool: (name, description, shape, handler) => ({
      name,
      description,
      shape,
      handler,
    }),
    createSdkMcpServer: (options) => options,
  };
}

/**
 * One session run over `services`, launched as a pod is with a minted
 * credential directory of its own, which is removed as the session ends.
 */
export async function run(services) {
  const { query, ...rest } = services;
  const minted = await mkdtemp(join(tmpdir(), "chuggy-session-minted-"));
  try {
    return await sessionMain({
      environment,
      read: async (path) =>
        path === bearerFile ? `${bearer}\n` : `${token}\n`,
      ensureDirectory: async () => undefined,
      warn: () => undefined,
      minted,
      ...(query === undefined ? {} : { sdk: sdkOf(query) }),
      ...rest,
    });
  } finally {
    await rm(minted, { recursive: true, force: true });
  }
}

export const turnOne = {
  turn: "turn-1",
  ordinal: 1,
  inputKind: "UserMessage",
  input: "ask",
};
export const result = (subtype, extra = {}) => ({
  type: "result",
  subtype,
  ...extra,
});
