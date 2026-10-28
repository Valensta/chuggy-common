import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import test from "node:test";

import { controlAsked, controlServer, controlSocketPath } from "./control.mjs";
import { controlServed, inFlightFixture } from "./control.fixture.mjs";

/**
 * A directory for a socket, under /tmp rather than TMPDIR, which could be
 * long enough to put the socket's path past the length one may have.
 *
 * @param {import("node:test").TestContext} t
 */
async function socketDirectory(t) {
  const directory = await mkdtemp("/tmp/chuggy-control-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** @param {import("node:test").TestContext} t */
async function served(t) {
  const path = controlSocketPath(await socketDirectory(t));
  return { path, ...(await controlServed(t, path)) };
}

test("the service answers what it is placing", async (t) => {
  const { path } = await served(t);
  assert.deepEqual(await controlAsked(path, { op: "status" }), {
    inFlight: [inFlightFixture],
  });
});

test("a runner's service, which is no chat host, refuses a chat host's status", async (t) => {
  const { path } = await served(t);
  assert.deepEqual(await controlAsked(path, { op: "chatStatus" }), {
    refused: "this service is no chat host's",
  });
});

test("a stop asked of the service is its backend's stop", async (t) => {
  const { path, stopped } = await served(t);
  assert.deepEqual(
    await controlAsked(path, { op: "stop", assignment: "asg-1" }),
    { stopped: "Stopped" },
  );
  assert.deepEqual(stopped, ["asg-1"]);
});

test("a line that is no request is refused", async (t) => {
  const { path, stopped } = await served(t);
  const answer = await new Promise((resolve) => {
    const socket = createConnection(path, () =>
      socket.write('{"op":"stop"}\n'),
    );
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("end", () => resolve(JSON.parse(text)));
  });
  assert.deepEqual(answer, { refused: "not a request this service answers" });
  assert.deepEqual(stopped, []);
});

test("nothing answers where no service is", async (t) => {
  const directory = await socketDirectory(t);
  assert.equal(
    await controlAsked(controlSocketPath(directory), { op: "status" }),
    undefined,
  );
});

test("a second service is refused where one answers, and a dead one's socket is replaced", async (t) => {
  const { path, backend } = await served(t);
  await assert.rejects(
    controlServer(path, backend),
    /a runner's service already answers at/u,
  );

  const directory = await socketDirectory(t);
  const stale = controlSocketPath(directory);
  await writeFile(stale, "");
  const server = await controlServer(stale, backend);
  t.after(() => server.close());
  assert.deepEqual(
    await controlAsked(stale, { op: "stop", assignment: "asg-2" }),
    { stopped: "Stopped" },
  );
});
