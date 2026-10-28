/**
 * What a chat supervisor and one session it runs say to each other, and the
 * lines every reader of theirs takes text in.
 *
 * THE SESSION'S ENVELOPE CROSSES ON A PIPE, NEVER IN THE ENVIRONMENT. The
 * supervisor writes it as one line of JSON on the session's descriptor
 * `chatChannelDescriptor` and writes nothing after it, so the bearer it carries
 * is in no variable a process of the session's user can read off another. The
 * end of that pipe is the supervisor's stop: the session ends as a plane's stop
 * ends one, and so does a session whose supervisor died. Anything else read
 * after the envelope is a supervisor this session cannot follow, and ends it
 * the same way.
 *
 * WHAT THE SESSION IS GIVEN BESIDE IT IS IN ITS ENVIRONMENT, and none of it is
 * a secret: which descriptor the channel is, the directory its credentials are
 * minted to, and the checkout the supervisor made, as `sessionCheckout`
 * answers one, which the session takes in place of making its own.
 *
 * A LINE IS BOUNDED BEFORE IT IS KEPT. A reader keeps at most its bound of a
 * line it has not seen the end of, so a writer that never ends one costs it
 * that bound and no more.
 */

import { Buffer } from "node:buffer";

import {
  chatHostSessionEnvelopeSchema,
  chatProtocolFrameBytesMax,
} from "@chuggy/worker-contract/chatHost";
import { z } from "zod";

/** The descriptor a session reads its channel on. */
export const chatChannelDescriptor = 3;

/** The variable naming that descriptor, which is what starts the core as a supervisor's session. */
export const chatChannelVariable = "CHUG_CHAT_SESSION_CHANNEL";

/** The variable naming the directory a session's credentials are minted to, its own. */
export const chatMintedVariable = "CHUG_CHAT_SESSION_MINTED";

/** The variable carrying the checkout the supervisor made for a session. */
export const chatCheckoutVariable = "CHUG_CHAT_SESSION_CHECKOUT";

/** A checkout as `sessionCheckout` answers one: a tree, the refusal of one, or none. */
const chatCheckoutSchema = z.union([
  z.strictObject({ directory: z.string().min(1), commit: z.string() }),
  z.strictObject({ refused: z.string() }),
  z.strictObject({}),
]);

/**
 * A reader of lines of at most `bytesMax` bytes, their newline left out, from
 * chunks pushed to it: `line` is handed each, and `overlong` is told of each
 * longer one, of which nothing is kept or handed on.
 *
 * @param {number} bytesMax
 * @param {{line: (bytes: Buffer) => void, overlong: () => void}} heard
 */
export function chatLineReader(bytesMax, heard) {
  let held = [];
  let heldBytes = 0;
  let dropping = false;
  const keep = (piece) => {
    if (dropping) return;
    if (heldBytes + piece.length > bytesMax) {
      dropping = true;
      held = [];
      heldBytes = 0;
      heard.overlong();
      return;
    }
    if (piece.length > 0) held.push(Buffer.from(piece));
    heldBytes += piece.length;
  };
  return {
    /** @param {Buffer} chunk */
    push(chunk) {
      let start = 0;
      for (;;) {
        const at = chunk.indexOf(0x0a, start);
        keep(chunk.subarray(start, at === -1 ? chunk.length : at));
        if (at === -1) return;
        if (!dropping) heard.line(Buffer.concat(held));
        held = [];
        heldBytes = 0;
        dropping = false;
        start = at + 1;
      }
    },
    /** Hands on what is left of a last line its writer never ended, where it fits. */
    end() {
      if (!dropping && heldBytes > 0) heard.line(Buffer.concat(held));
      held = [];
      heldBytes = 0;
    },
  };
}

/** UTF-8 text refused, as a frame is, where it is not text at all. */
export function chatLineText(bytes) {
  return new globalThis.TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The envelope as the supervisor writes it on the channel, refused where it is longer than a frame may be. */
export function chatChannelLine(envelope) {
  const line = JSON.stringify(chatHostSessionEnvelopeSchema.parse(envelope));
  if (Buffer.byteLength(line) > chatProtocolFrameBytesMax)
    throw new RangeError("a session's envelope is longer than a frame");
  return `${line}\n`;
}

/** A checkout as the session's environment carries it. */
export function chatCheckoutCarried(checkout) {
  return JSON.stringify(chatCheckoutSchema.parse(checkout ?? {}));
}

/** The checkout the session's environment carries, as `sessionCheckout` answers one. */
export function chatCheckoutRead(value) {
  let document;
  try {
    document = JSON.parse(value);
  } catch {
    document = undefined;
  }
  const checkout = chatCheckoutSchema.safeParse(document);
  if (!checkout.success)
    throw new Error(
      `${chatCheckoutVariable} carries a checkout this core cannot read`,
    );
  return Object.keys(checkout.data).length === 0 ? undefined : checkout.data;
}

/** A line's JSON, or nothing where it is not text or not JSON. */
function chatChannelJson(bytes) {
  try {
    return JSON.parse(chatLineText(bytes));
  } catch {
    return undefined;
  }
}

/**
 * The session's end of its channel, read from `input`: the envelope, refused
 * where the channel ends or says anything else first, and `stopped`, which is
 * aborted once anything follows it, the channel's end included. `close` lets
 * go of the channel.
 *
 * @param {import("node:stream").Readable} input
 */
export function chatChannelOpened(input) {
  const stop = new globalThis.AbortController();
  let answer;
  const envelope = new Promise((resolve, reject) => {
    answer = { resolve, reject };
  });
  let read = false;
  const heard = (failure) => {
    if (read) stop.abort();
    else answer.reject(new Error(failure));
    read = true;
  };
  const lines = chatLineReader(chatProtocolFrameBytesMax, {
    line: (bytes) => {
      if (read) return heard("");
      const parsed = chatHostSessionEnvelopeSchema.safeParse(
        chatChannelJson(bytes),
      );
      if (!parsed.success)
        return heard("the supervisor wrote an envelope this core cannot read");
      read = true;
      answer.resolve(parsed.data);
    },
    overlong: () =>
      heard("the supervisor wrote an envelope longer than a frame"),
  });
  input.on("data", (chunk) => {
    if (read) return stop.abort();
    const at = chunk.indexOf(0x0a);
    lines.push(chunk);
    if (read && at !== -1 && at < chunk.length - 1) stop.abort();
  });
  input.once("end", () => heard("the supervisor wrote no envelope"));
  input.once("error", () => heard("the supervisor's channel failed"));
  return {
    envelope,
    stopped: stop.signal,
    close: () => input.destroy(),
  };
}
