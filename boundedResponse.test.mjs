import assert from "node:assert/strict";
import test from "node:test";

import { boundedResponseBytes } from "./boundedResponse.mjs";

/** A body yielding `chunks` in order, pulled only when read, counting each pull. */
function streamed(chunks, headers = {}) {
  const pulled = { count: 0 };
  const pending = [...chunks];
  const stream = new globalThis.ReadableStream(
    {
      pull(controller) {
        pulled.count += 1;
        const next = pending.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new Uint8Array(next));
      },
    },
    { highWaterMark: 0 },
  );
  return {
    pulled,
    response: new globalThis.Response(stream, { headers }),
  };
}

test("a declared length past the bound is refused before any of the body is read", async () => {
  const body = streamed([[1]], { "content-length": "5" });
  await assert.rejects(
    boundedResponseBytes(body.response, 4, 10),
    /byte bound/u,
  );
  assert.equal(body.pulled.count, 0);
});

test("a body that declares no length is refused as it passes the byte bound, before its end is read", async () => {
  const readsMax = 1_000;
  // One chunk past the read bound, then the end: a read without either bound
  // fails the reason below rather than filling the machine's memory.
  let sent = 0;
  const long = new globalThis.ReadableStream({
    pull(controller) {
      if (sent > readsMax) controller.close();
      else {
        controller.enqueue(new Uint8Array([1, 2]));
        sent += 1;
      }
    },
  });
  await assert.rejects(
    boundedResponseBytes(new globalThis.Response(long), 4, readsMax),
    /byte bound/u,
  );
});

test("a body of exactly the bound's chunks is read, and one more is refused", async () => {
  const exact = streamed([[1], [], [2]]);
  assert.deepEqual(
    await boundedResponseBytes(exact.response, 10, 3),
    new Uint8Array([1, 2]),
  );
  const over = streamed([[1], [], [2], []]);
  await assert.rejects(
    boundedResponseBytes(over.response, 10, 3),
    /read bound/u,
  );
});

test("an answer with no body is no bytes", async () => {
  assert.deepEqual(
    await boundedResponseBytes(
      new globalThis.Response(null, { status: 204 }),
      1,
      1,
    ),
    new Uint8Array(),
  );
});
