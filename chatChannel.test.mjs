import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";
import test from "node:test";

import { chatProtocolFrameBytesMax } from "@chuggy/worker-contract/chatHost";

import {
  chatChannelLine,
  chatChannelOpened,
  chatCheckoutCarried,
  chatCheckoutRead,
  chatLineReader,
} from "./chatChannel.mjs";

const envelope = {
  callbackUrl: "http://pool-plane.test:3002",
  bearer: "chgs_fedcba9876543210fedcba9876543210",
  timeoutSecsMax: 1_800,
  outputBytesMax: 4_096,
  providerCredentialFile: "/minted/session-1/claude-code",
};

/** Every line a reader of `bytesMax` hands on of `chunks`, and how many it dropped. */
function readOf(bytesMax, chunks) {
  const lines = [];
  let dropped = 0;
  const reader = chatLineReader(bytesMax, {
    line: (bytes) => lines.push(bytes.toString("utf8")),
    overlong: () => {
      dropped += 1;
    },
  });
  for (const chunk of chunks) reader.push(Buffer.from(chunk));
  reader.end();
  return { lines, dropped };
}

test("a line is handed on whole however its chunks cut it", () => {
  assert.deepEqual(readOf(8, ["ab", "c\nde", "f\n\ngh"]), {
    lines: ["abc", "def", "", "gh"],
    dropped: 0,
  });
});

/** Catches a reader that splits first and bounds after, holding a line it has not seen the end of whole. */
test("a line longer than the bound is dropped as it arrives, and the next is read", () => {
  assert.deepEqual(readOf(4, ["abc", "de", "fghij", "k\nok\n"]), {
    lines: ["ok"],
    dropped: 1,
  });
  assert.deepEqual(readOf(4, ["abcd\nabcde\n"]), {
    lines: ["abcd"],
    dropped: 1,
  });
});

test("an envelope is written as one line and one longer than a frame is refused", () => {
  const line = chatChannelLine(envelope);
  assert.ok(line.endsWith("\n"));
  assert.deepEqual(JSON.parse(line), envelope);
  assert.throws(
    () =>
      chatChannelLine({
        ...envelope,
        providerCredentialFile: "x".repeat(chatProtocolFrameBytesMax),
      }),
    RangeError,
  );
});

test("a checkout crosses as `sessionCheckout` answers one", () => {
  for (const checkout of [
    { directory: "/sessions/session-1/repository", commit: "abc" },
    { refused: "session checkout cannot resolve chuggy" },
  ])
    assert.deepEqual(chatCheckoutRead(chatCheckoutCarried(checkout)), checkout);
  assert.equal(chatCheckoutRead(chatCheckoutCarried(undefined)), undefined);
  assert.throws(() => chatCheckoutRead("{"), /cannot read/u);
  assert.throws(() => chatCheckoutRead('{"directory":""}'), /cannot read/u);
});

test("the channel's envelope is read, and its end then stops the session", async () => {
  const input = new PassThrough();
  const channel = chatChannelOpened(input);

  input.write(chatChannelLine(envelope));
  assert.deepEqual(await channel.envelope, envelope);
  assert.equal(channel.stopped.aborted, false);

  input.end();
  await new Promise((resolve) =>
    channel.stopped.addEventListener("abort", resolve),
  );
  channel.close();
});

/** Catches a supervisor saying more than its envelope being followed rather than taken as the stop. */
test("anything after the envelope stops the session, in its chunk or after it", async () => {
  for (const after of ["x", "more\n"]) {
    const input = new PassThrough();
    const channel = chatChannelOpened(input);
    input.write(`${chatChannelLine(envelope)}${after}`);
    assert.deepEqual(await channel.envelope, envelope);
    assert.equal(channel.stopped.aborted, true, after);
    channel.close();
  }
  const input = new PassThrough();
  const channel = chatChannelOpened(input);
  input.write(chatChannelLine(envelope));
  await channel.envelope;
  input.write("x");
  await new Promise((resolve) => globalThis.setImmediate(resolve));
  assert.equal(channel.stopped.aborted, true);
  channel.close();
});

test("a channel that ends, overruns a frame or says something else first carries no envelope", async () => {
  const cases = [
    [[], /no envelope/u],
    [["x".repeat(chatProtocolFrameBytesMax + 1)], /longer than a frame/u],
    [["{}\n"], /cannot read/u],
    [[Buffer.from([0xff, 0x0a])], /cannot read/u],
  ];
  for (const [chunks, refusal] of cases) {
    const input = new PassThrough();
    const channel = chatChannelOpened(input);
    for (const chunk of chunks) input.write(chunk);
    input.end();
    await assert.rejects(channel.envelope, refusal);
    channel.close();
  }
});
