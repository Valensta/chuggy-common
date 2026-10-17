/**
 * The `chuggy` tools served to a coding agent on a person's own machine, over
 * stdio, under that person's own sign-in (`./localSignIn.mjs`) rather than a
 * session bearer.
 *
 * THE TOOLS ARE THE POD'S, unchanged: `chuggyProjectTools`, their handler and
 * their bounds, for one site's one project. What differs is only what
 * `chuggyToolContext` is handed. The roster is every project tool and no
 * decision tool, since there is no lead here to decide for, and the API is the
 * control: it authorizes the person's token through their membership as it
 * does the console's.
 *
 * A CALL IS ITS OWN TURN. Nothing over stdio says which turn of a chat a call
 * belongs to, so each submitted command mints its operation from a turn of its
 * own. A command repeated is a second operation, and the API's fences on what
 * the command names are what refuse it.
 *
 * A 401 IS ASKED ONCE MORE. It says the token was what was wrong, and nothing
 * it answered was applied, so the held token is dropped and the call is made
 * again under a renewed one; a second 401 is relayed.
 *
 * The SDK is the caller's, as the pod's own is: this module names
 * `McpServer`, `StdioServerTransport` and `z` and imports none of them.
 */

import { randomUUID } from "node:crypto";
import { URL } from "node:url";

import {
  chuggyToolServerName,
  chuggyToolTimeoutMs,
} from "@chuggy/worker-contract/sessionTools";

import { chuggyRequest } from "./chuggyApi.mjs";
import {
  chuggyToolContext,
  chuggyToolDefinitions,
  chuggyToolHandler,
} from "./chuggyTools.mjs";

/** Every capability whose tools a person's own agent is given. */
export const localToolCapabilities = [
  "ProjectRead",
  "DraftAuthor",
  "DraftOriginate",
];

const localToolUnauthorizedStatus = 401;
const localToolAttemptsMax = 2;

/** A request under the person's current token, made again once on a 401. */
export function localToolRequest(signIn, request = chuggyRequest) {
  return async (task, _bearer, path, init = {}) => {
    const signal = globalThis.AbortSignal.timeout(chuggyToolTimeoutMs);
    for (let attempt = 1; ; attempt += 1) {
      const token = await signIn.token();
      const response = await request(task, token, path, { ...init, signal });
      if (
        response.status !== localToolUnauthorizedStatus ||
        attempt === localToolAttemptsMax
      )
        return response;
      signIn.invalidate(token);
      await response.body?.cancel?.();
    }
  };
}

/**
 * The tools' context for one project: `site` is the origin the console and
 * its API are served at, and `tenant` and `project` are as its routes name
 * them.
 */
export function localToolContext({ site, tenant, project, version, signIn }) {
  return chuggyToolContext(
    { tenant, project, api: { url: new URL(site).origin } },
    undefined,
    {
      capabilities: localToolCapabilities,
      version,
      request: localToolRequest(signIn),
      turn: () => randomUUID(),
    },
  );
}

/** The server, every tool registered and nothing connected. */
export function localToolServer(context, sdk) {
  const server = new sdk.McpServer({
    name: chuggyToolServerName,
    version: context.version,
  });
  for (const definition of chuggyToolDefinitions(context))
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.shape(sdk.z),
      },
      chuggyToolHandler(definition, sdk.z),
    );
  return server;
}

/** Serves the tools on this process's stdio until the transport closes. */
export async function localToolServe(context, sdk) {
  const server = localToolServer(context, sdk);
  const closed = new Promise((resolve) => {
    server.server.onclose = resolve;
  });
  await server.connect(new sdk.StdioServerTransport());
  await closed;
}
