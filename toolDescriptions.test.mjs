/**
 * Every chuggy tool as an MCP client lists it: a description that opens with
 * one short sentence, and a description on every parameter. Both servers are
 * listed through the MCP SDK's own client, so what is held is the JSON schema
 * the SDK publishes and not the zod shape it is converted from.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allChuggyTools } from "@chuggy/worker-contract/sessionTools";
import { z } from "zod";

import {
  chuggyProjectTools,
  chuggyToolContext,
  chuggyToolServer,
  sessionCapabilityTools,
} from "./chuggyTools.mjs";
import { leadDecisionStaging } from "./leadDecision.mjs";
import { localToolContext, localToolServer } from "./localTools.mjs";

/** The longest a description's opening sentence may be, which is what an agent reads a tool list by. */
const toolDescriptionOpeningCharsMax = 160;

/** The tools a connected server lists, as a client is answered them. */
async function listed(server) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "toolDescriptions", version: "1" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

/**
 * The pod's server over every capability. The agent SDK's
 * `createSdkMcpServer` registers each of its `tool`s on an `McpServer`, and
 * this does the same, since the agent SDK is not this repository's to carry.
 */
function podServer() {
  return chuggyToolServer(
    chuggyToolContext({ tenant: "t", project: "p" }, "bearer", {
      capabilities: Object.keys(sessionCapabilityTools),
      staging: leadDecisionStaging(),
    }),
    {
      z,
      tool: (name, description, inputSchema, handler) => ({
        name,
        description,
        inputSchema,
        handler,
      }),
      createSdkMcpServer: ({ name, version, tools }) => {
        const server = new McpServer({ name, version });
        for (const { name: tool, handler, ...config } of tools)
          server.registerTool(tool, config, handler);
        return server;
      },
    },
  );
}

function localServer() {
  return localToolServer(
    localToolContext({
      site: "https://chuggy.example",
      tenant: "t",
      project: "p",
      version: "1",
      signIn: { token: async () => "token", invalidate() {} },
    }),
    { McpServer, z },
  );
}

/** What a listed tool is found wanting in, nothing where it is in shape. */
function toolDescriptionFaults({ name, description, inputSchema }) {
  const faults = [];
  const [opening] = /^.*?\.(?=\s|$)/su.exec(description ?? "") ?? [];
  if (opening === undefined) faults.push(`${name} opens with no sentence`);
  else if (opening.length > toolDescriptionOpeningCharsMax)
    faults.push(
      `${name} opens with ${String(opening.length)} characters: ${opening}`,
    );
  for (const [parameter, schema] of Object.entries(
    inputSchema.properties ?? {},
  ))
    if (typeof schema.description !== "string" || schema.description === "")
      faults.push(`${name}.${parameter} has no description`);
  return faults;
}

for (const [server, built, roster] of [
  ["the pod's server", podServer, allChuggyTools],
  ["the local server", localServer, chuggyProjectTools.map(({ name }) => name)],
])
  test(`${server} lists every tool opening with a short sentence and every parameter described`, async () => {
    const tools = await listed(built());

    assert.deepEqual(tools.map(({ name }) => name).sort(), [...roster].sort());
    assert.deepEqual(tools.flatMap(toolDescriptionFaults), []);
  });

test("a tool listed with an undescribed parameter or a long opening is found wanting", async () => {
  const server = new McpServer({ name: "wanting", version: "1" });
  server.registerTool(
    "undescribed",
    { description: "Short.", inputSchema: { ticket: z.number() } },
    () => ({ content: [] }),
  );
  server.registerTool(
    "long",
    {
      description: `${"a".repeat(toolDescriptionOpeningCharsMax)}. Then more.`,
      inputSchema: { ticket: z.number().describe("A ticket.") },
    },
    () => ({ content: [] }),
  );
  server.registerTool("none", { description: "" }, () => ({ content: [] }));

  const faults = (await listed(server)).flatMap(toolDescriptionFaults);

  assert.equal(faults.length, 3);
  assert.match(faults[0], /^undescribed\.ticket has no description$/u);
  assert.ok(
    faults[1].startsWith(
      `long opens with ${String(toolDescriptionOpeningCharsMax + 1)} characters`,
    ),
  );
  assert.match(faults[2], /^none opens with no sentence$/u);
});
