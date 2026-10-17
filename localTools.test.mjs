import assert from "node:assert/strict";
import test from "node:test";

import { chuggyToolServerName } from "@chuggy/worker-contract/sessionTools";
import { z } from "zod";

import { chuggyProjectTools } from "./chuggyTools.mjs";
import {
  localToolContext,
  localToolRequest,
  localToolServer,
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
    constructor(info) {
      this.info = info;
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

test("a registered tool reaches its project's route under the person's token", async () => {
  const api = apiOf([200]);
  const context = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    signIn: signInOf(["token"]),
  });
  context.request = localToolRequest(signInOf(["token"]), api.request);
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
