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
 * the command names are what refuse it, so the pod's description of a repeat
 * is replaced with that.
 *
 * A 401 IS ASKED ONCE MORE. It says the token was what was wrong, and nothing
 * it answered was applied, so the held token is dropped and the call is made
 * again under a renewed one; a second 401 is relayed.
 *
 * The SDK is the caller's, as the pod's own is: this module names
 * `McpServer`, `StdioServerTransport` and `z` and imports none of them.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { URL } from "node:url";

import {
  chuggyToolServerName,
  chuggyToolTimeoutMs,
} from "@chuggy/worker-contract/sessionTools";

import { chuggyRequest } from "./chuggyApi.mjs";
import {
  chuggySubmissionRepeatDescription,
  chuggyToolContext,
  chuggyToolDefinitions,
  chuggyToolHandler,
} from "./chuggyTools.mjs";
import { localSignIn } from "./localSignIn.mjs";
import { localTokenStore } from "./localTokenStore.mjs";
import { registerEndpointRefusal } from "./register.mjs";

/** Every capability whose tools a person's own agent is given. */
export const localToolCapabilities = [
  "ProjectRead",
  "DraftAuthor",
  "DraftOriginate",
  "TicketDispatch",
];

/** What a submitted command made again answers here, where every call is a turn of its own. */
export const localToolRepeatDescription = `The same call again is a new operation, submitted again: where the first already landed, the API refuses the second for what it names, so read_operation the first's id to learn what it did before calling again.`;

/** What the server tells an agent before it lists the tools. */
export const localToolInstructions = `The chuggy docs are behind read_docs: call it with no page for the index first, then with a page the index lists.
To file a ticket:
1. list_repositories: a repository that is configured and \`fileable\`.
2. list_configurations: the newest revision for that repository.
3. initialize_draft on that revision: the fence and the defaults.
4. create_draft: the minimum brief, and \`authoring\` from the defaults.
5. read_draft: the draft as filed.
6. release_draft.
7. read_operation: every command is submitted, and this is how its outcome is read.
Releasing starts nothing: the ticket waits Pending until the project's lead dispatches it, once its dependencies are Done, or a person who may dispatch does.`;

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
export function localToolContext({
  site,
  tenant,
  project,
  version,
  signIn,
  request = chuggyRequest,
}) {
  return chuggyToolContext(
    { tenant, project, api: { url: new URL(site).origin } },
    undefined,
    {
      capabilities: localToolCapabilities,
      version,
      request: localToolRequest(signIn, request),
      turn: () => randomUUID(),
    },
  );
}

/** The server, its instructions given, every tool registered and nothing connected. */
export function localToolServer(context, sdk) {
  const server = new sdk.McpServer(
    { name: chuggyToolServerName, version: context.version },
    { instructions: localToolInstructions },
  );
  for (const definition of chuggyToolDefinitions(context))
    server.registerTool(
      definition.name,
      {
        description: definition.description.replace(
          chuggySubmissionRepeatDescription,
          localToolRepeatDescription,
        ),
        inputSchema: definition.shape(sdk.z),
      },
      chuggyToolHandler(definition, sdk.z),
    );
  return server;
}

/**
 * Serves the tools on stdio until the transport closes, which the SDK's own
 * does on a read that fails and not on the end of its input, so the end of
 * `stdin` closes it too.
 */
export async function localToolServe(context, sdk, stdin = process.stdin) {
  const server = localToolServer(context, sdk);
  const closed = new Promise((resolve) => {
    server.server.onclose = resolve;
  });
  await server.connect(new sdk.StdioServerTransport());
  const ended = () => void server.close();
  stdin.once("end", ended);
  stdin.once("close", ended);
  await closed;
}

/**
 * Why an ask for one project's tools cannot be served, or nothing: the site is
 * one this machine sends a credential to, and the workspace and project are
 * each named.
 */
export function localToolAskRefusal({ site, workspace, project }) {
  if (site === undefined || workspace === undefined || project === undefined)
    return "the tools need a site, a workspace and a project";
  let url;
  try {
    url = new URL(site);
  } catch {
    return `the site ${site} is not a URL`;
  }
  const refused = registerEndpointRefusal(url);
  if (refused !== undefined) return `the site ${refused}`;
  if (url.username !== "" || url.password !== "")
    return "the site must carry no credentials";
  if (workspace === "" || project === "")
    return "the workspace and the project must each be named";
  return undefined;
}

/** The file in `directory` one site's renewal token is kept in. */
export function localToolSignInFile(directory, site) {
  return join(directory, encodeURIComponent(new URL(site).origin));
}

/**
 * One project's tools served on stdio under the sign-in kept in `signIns`,
 * until the agent closes stdio. The ask is `localToolAskRefusal`'s to check
 * first; a `fetch` not given is the global one.
 */
export async function localToolServed(asked, sdk, stdin = process.stdin) {
  const { site, workspace, project, version, signIns, fetch } = asked;
  const signIn = localSignIn(
    site,
    localTokenStore(localToolSignInFile(signIns, site)),
    { fetch },
  );
  try {
    await localToolServe(
      localToolContext({ site, tenant: workspace, project, version, signIn }),
      sdk,
      stdin,
    );
  } finally {
    signIn.close();
  }
}
