/**
 * The container engine's CLI, run with `execFile` or `spawn` and never a
 * shell. An answer is the exit code and both streams; only an abort rejects,
 * since the caller is the one who asked for it. A call that could not start,
 * or that ran past its cap, is answered as `failed`, which `engineErrors.mjs`
 * reads as an unreachable engine.
 */

import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";

/**
 * @typedef {object} EngineAnswer
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {"Unstarted" | "Interrupted"} [failed]
 *
 * @typedef {object} EngineCall
 * @property {Readonly<Record<string, string>>} [environment] added to this process's own
 * @property {AbortSignal} [signal] which replaces the call cap, for a call bounded by a deadline of its own
 * @property {AbortSignal} [cut] which ends a call sooner than the call cap, which still holds
 *
 * @typedef {EngineAnswer & {tail: Buffer, cut: boolean, lines: number}} EngineTail
 * what a call printed on both streams, as it arrived: only its last bytes in
 * `tail`, whether more came before them in `cut`, and how many lines it
 * printed in all; the answer's `stderr` is the end of its own
 *
 * @typedef {object} Engine
 * @property {(argv: readonly string[], call?: EngineCall) => Promise<EngineAnswer>} exec
 * @property {(argv: readonly string[], bytesMax: number) => Promise<EngineTail>} execTail both streams, for output of any length, of which the last `bytesMax` bytes are kept
 */

/** Far above an inspection of every container one pool could hold. */
const engineAnswerBytesMax = 16 * 1024 * 1024;

/** Far above the line a failed call's stderr ends with. */
const engineTailStderrBytesMax = 64 * 1024;

/**
 * The last `bytesMax` bytes of what is added to it, however much is.
 *
 * @param {number} bytesMax
 */
function tailKept(bytesMax) {
  /** @type {Buffer[]} */
  const chunks = [];
  let length = 0;
  let seen = 0;
  let lines = 0;
  return {
    /** @param {Buffer} chunk */
    add: (chunk) => {
      chunks.push(chunk);
      length += chunk.length;
      seen += chunk.length;
      for (
        let at = chunk.indexOf(10);
        at !== -1;
        at = chunk.indexOf(10, at + 1)
      )
        lines += 1;
      while (chunks.length > 1 && length - chunks[0].length >= bytesMax)
        length -= /** @type {Buffer} */ (chunks.shift()).length;
    },
    done: () => {
      const whole = Buffer.concat(chunks);
      return {
        tail: whole.subarray(Math.max(0, whole.length - bytesMax)),
        cut: seen > bytesMax,
        lines,
      };
    },
  };
}

/**
 * @param {Error & {code?: unknown, killed?: boolean}} error
 * @param {string} stdout
 * @param {string} stderr
 * @returns {EngineAnswer}
 */
function engineAnswered(error, stdout, stderr) {
  if (typeof error.code === "number")
    return { code: error.code, stdout, stderr };
  return {
    code: -1,
    stdout,
    stderr: `${stderr}${error.message}`,
    failed: error.killed === true ? "Interrupted" : "Unstarted",
  };
}

/**
 * @param {string} binary
 * @param {number} callTimeoutMs the cap on a call with no signal of its own, which guards a hung engine and not a slow one
 * @returns {Engine}
 */
export function containerEngine(binary, callTimeoutMs) {
  return {
    exec: (argv, call = {}) =>
      new Promise((resolve, reject) => {
        execFile(
          binary,
          argv,
          {
            env: { ...process.env, ...call.environment },
            signal: call.signal ?? call.cut,
            timeout: call.signal === undefined ? callTimeoutMs : 0,
            maxBuffer: engineAnswerBytesMax,
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (error === null) resolve({ code: 0, stdout, stderr });
            else if (error.name === "AbortError") reject(error);
            else resolve(engineAnswered(error, stdout, stderr));
          },
        );
      }),
    execTail: (argv, bytesMax) =>
      new Promise((resolve) => {
        const kept = tailKept(bytesMax);
        const stderr = tailKept(engineTailStderrBytesMax);
        const child = spawn(binary, argv, {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: callTimeoutMs,
        });
        child.stdout.on("data", kept.add);
        child.stderr.on("data", (chunk) => {
          kept.add(chunk);
          stderr.add(chunk);
        });
        child.once("error", (error) =>
          resolve({ ...engineAnswered(error, "", ""), ...kept.done() }),
        );
        child.once("close", (code, signal) =>
          resolve({
            ...(code === null
              ? {
                  code: -1,
                  stdout: "",
                  stderr: `stopped by ${String(signal)}`,
                  failed: /** @type {const} */ ("Interrupted"),
                }
              : {
                  code,
                  stdout: "",
                  stderr: stderr.done().tail.toString("utf8"),
                }),
            ...kept.done(),
          }),
        );
      }),
  };
}
