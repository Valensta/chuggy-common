import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";

import { chuggyToolServerName } from "@chuggy/worker-contract/sessionTools";
import { z } from "zod";

import {
  chuggyProjectTools,
  chuggySubmissionRepeatDescription,
} from "./chuggyTools.mjs";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  localToolAskRefusal,
  localToolContext,
  localToolInstructions,
  localToolRepeatDescription,
  localToolRequest,
  localToolServe,
  localToolServed,
  localToolServer,
  localToolSignInFile,
} from "./localTools.mjs";

function signInOf(tokens) {
  const invalidated = [];
  let given = 0;
  return {
    invalidated,
    token: async () => tokens[Math.min(given++, tokens.length - 1)],
    invalidate: (token) => invalidated.push(token),
  };
}

function apiOf(statuses) {
  const calls = [];
  return {
    calls,
    request: async (task, bearer, path, init) => {
      calls.push({ task, bearer, path, init });
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
      return new globalThis.Response(`{"status":${String(status)}}`, {
        status,
      });
    },
  };
}

test("a call goes under the person's token, and a 401 is asked once more under a renewed one", async () => {
  const signIn = signInOf(["first", "second", "third"]);
  const api = apiOf([401, 200]);
  const request = localToolRequest(signIn, api.request);
  const response = await request({}, undefined, "/api/v1/x", {
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    api.calls.map(({ bearer }) => bearer),
    ["first", "second"],
  );
  assert.deepEqual(signIn.invalidated, ["first"]);
  assert.equal(api.calls[1].init.method, "POST");
  assert.ok(api.calls[1].init.signal instanceof globalThis.AbortSignal);
});

test("a second 401 is relayed rather than asked a third time", async () => {
  const signIn = signInOf(["first", "second", "third"]);
  const api = apiOf([401]);
  const response = await localToolRequest(signIn, api.request)(
    {},
    undefined,
    "/api/v1/x",
  );
  assert.equal(response.status, 401);
  assert.equal(api.calls.length, 2);
});

function sdkOf() {
  const registered = [];
  class McpServer {
    constructor(info, options) {
      this.info = info;
      this.options = options;
      this.server = {};
    }
    registerTool(name, config, handler) {
      registered.push({ name, config, handler });
    }
  }
  return { registered, sdk: { McpServer, z } };
}

test("a person's agent is given every project tool and no decision tool, under one project's routes", async () => {
  const signIn = signInOf(["token"]);
  const context = localToolContext({
    site: "https://chuggy.test/console",
    tenant: "vteng",
    project: "chuggy",
    version: "9.9.9",
    signIn,
  });
  const { registered, sdk } = sdkOf();
  const server = localToolServer(context, sdk);
  assert.deepEqual(server.info, {
    name: chuggyToolServerName,
    version: "9.9.9",
  });
  assert.deepEqual(
    registered.map(({ name }) => name),
    chuggyProjectTools.map(({ name }) => name),
  );
  assert.equal(context.task.api.url, "https://chuggy.test");
  assert.equal(context.bearer, undefined);
  const first = context.turn();
  assert.ok(first.length > 0);
  assert.notEqual(context.turn(), first);
});

test("the server tells the agent the docs are behind read_docs, index first", () => {
  const context = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    signIn: signInOf(["token"]),
  });
  const { registered, sdk } = sdkOf();
  const server = localToolServer(context, sdk);
  assert.deepEqual(server.options, { instructions: localToolInstructions });
  assert.match(localToolInstructions, /read_docs/u);
  assert.match(localToolInstructions, /index first/u);
  assert.ok(registered.some(({ name }) => name === "read_docs"));
});

test("the server's instructions name the filing recipe's tools in order, then who starts the work", () => {
  const recipe = [
    "list_repositories",
    "list_configurations",
    "initialize_draft",
    "create_draft",
    "read_draft",
    "release_draft",
    "read_operation",
  ];
  const steps = [...localToolInstructions.matchAll(/^(\d+)\. (\w+)/gmu)];
  assert.deepEqual(
    steps.map(([, number, tool]) => [Number(number), tool]),
    recipe.map((tool, index) => [index + 1, tool]),
  );
  const tools = new Set(chuggyProjectTools.map(({ name }) => name));
  for (const tool of recipe) assert.ok(tools.has(tool), tool);
  assert.match(
    localToolInstructions,
    /Releasing starts nothing: [^.]*lead dispatches it[^.]*, or a person who may dispatch does\.$/u,
  );
});

test("a registered tool reaches its project's route under the person's token", async () => {
  const api = apiOf([200]);
  const context = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    signIn: signInOf(["token"]),
    request: api.request,
  });
  const { registered, sdk } = sdkOf();
  localToolServer(context, sdk);
  const readTicket = registered.find(({ name }) => name === "read_ticket");
  const answer = await readTicket.handler({ ticket: 7 });
  assert.equal(answer.isError, undefined);
  assert.equal(api.calls[0].bearer, "token");
  assert.equal(api.calls[0].task.tenant, "vteng");
  assert.match(
    api.calls[0].path,
    /\/tenants\/vteng\/projects\/chuggy\/tickets\/7$/,
  );
});

test("a submitted command is described as a new operation each call, and every other description is the pod's", () => {
  const context = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    signIn: signInOf(["token"]),
  });
  const { registered, sdk } = sdkOf();
  localToolServer(context, sdk);
  const submissions = [];
  for (const { name, config } of registered) {
    const pod = chuggyProjectTools.find((tool) => tool.name === name);
    assert.ok(!config.description.includes(chuggySubmissionRepeatDescription));
    if (pod.description.includes(chuggySubmissionRepeatDescription)) {
      submissions.push(name);
      assert.ok(config.description.includes(localToolRepeatDescription));
    } else assert.equal(config.description, pod.description);
  }
  assert.deepEqual(submissions.sort(), [
    "dispatch_ticket",
    "release_draft",
    "revoke_ticket",
    "update_ticket",
  ]);
});

test("the end of the agent's input closes the server", async () => {
  const stdin = new EventEmitter();
  const closed = [];
  class McpServer {
    constructor() {
      this.server = {};
    }
    registerTool() {}
    async connect(transport) {
      this.transport = transport;
    }
    async close() {
      closed.push(this.transport);
      this.server.onclose?.();
    }
  }
  class StdioServerTransport {}
  const context = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    signIn: signInOf(["token"]),
  });
  const served = localToolServe(
    context,
    { McpServer, StdioServerTransport, z },
    stdin,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed.length, 0);
  stdin.emit("end");
  await served;
  assert.ok(closed[0] instanceof StdioServerTransport);
});

test("served with the global fetch, a call with no sign-in is answered with a page, and the end of input ends it", async (t) => {
  const signIns = await mkdtemp(join(tmpdir(), "local-tools-"));
  t.after(() => rm(signIns, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const asked = String(url);
    if (asked === "https://chuggy.test/config.json")
      return globalThis.Response.json({
        issuer: "https://auth.test",
        audience: "https://chuggy.test/api",
      });
    if (asked === "https://auth.test/.well-known/openid-configuration")
      return globalThis.Response.json({
        issuer: "https://auth.test",
        authorization_endpoint: "https://auth.test/oauth2/auth",
        token_endpoint: "https://auth.test/oauth2/token",
      });
    return new globalThis.Response("", { status: 404 });
  });
  const stdin = new EventEmitter();
  const handlers = new Map();
  class McpServer {
    constructor() {
      this.server = {};
    }
    registerTool(name, _config, handler) {
      handlers.set(name, handler);
    }
    async connect() {}
    async close() {
      this.server.onclose?.();
    }
  }
  const served = localToolServed(
    {
      site: "https://chuggy.test",
      workspace: "vteng",
      project: "chuggy",
      version: "1",
      signIns,
    },
    { McpServer, StdioServerTransport: class {}, z },
    stdin,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const answer = await handlers.get("read_ticket")({ ticket: 7 });
  assert.equal(answer.isError, true);
  const text = answer.content.map(({ text }) => text).join("");
  assert.match(
    text,
    /not signed in to https:\/\/chuggy\.test: ask the person to open https:\/\/auth\.test\/oauth2\/auth\?/,
  );
  stdin.emit("end");
  await served;
});

test("an ask names a site a credential may be sent to, and a workspace and project", () => {
  const named = { workspace: "vteng", project: "chuggy" };
  assert.match(localToolAskRefusal(named), /need a site/);
  assert.match(
    localToolAskRefusal({ ...named, site: "http://chuggy.test" }),
    /https/,
  );
  assert.match(
    localToolAskRefusal({ ...named, site: "https://me:pw@chuggy.test" }),
    /no credentials/,
  );
  assert.match(
    localToolAskRefusal({ ...named, site: "https://chuggy.test", project: "" }),
    /each be named/,
  );
  assert.equal(
    localToolAskRefusal({ ...named, site: "http://127.0.0.1:8080" }),
    undefined,
  );
});

test("each site's sign-in is a file of its own, named by its origin", () => {
  assert.equal(
    localToolSignInFile("/home/me/sign-ins", "https://chuggy.test/console"),
    "/home/me/sign-ins/https%3A%2F%2Fchuggy.test",
  );
});
