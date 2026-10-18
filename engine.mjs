/**
 * The container engine's CLI, run with `execFile` or `spawn` and never a
 * shell. An answer is the exit code and both streams; only an abort rejects,
 * since the caller is the one who asked for it. A call that could not start,
 * or that ran past its cap, is answered as `failed`, which `engineErrors.mjs`
 * reads as an unreachable engine. On Windows each call's console window is
 * hidden, since a runner with no console of its own would otherwise open one
 * for every call.
 */

import { execFile, spawn } from "node:child_process";
import { writeSync } from "node:fs";

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
 *
 * @typedef {object} Engine
 * @property {(argv: readonly string[], call?: EngineCall) => Promise<EngineAnswer>} exec
 * @property {(argv: readonly string[], fd: number) => Promise<EngineAnswer>} execToFd both streams into `fd`, for output of any length
 */

/** Far above an inspection of every container one pool could hold. */
const engineAnswerBytesMax = 16 * 1024 * 1024;

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
            signal: call.signal,
            timeout: call.signal === undefined ? callTimeoutMs : 0,
            maxBuffer: engineAnswerBytesMax,
            encoding: "utf8",
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (error === null) resolve({ code: 0, stdout, stderr });
            else if (error.name === "AbortError") reject(error);
            else resolve(engineAnswered(error, stdout, stderr));
          },
        );
      }),
    execToFd: (argv, fd) =>
      new Promise((resolve) => {
        // Piped and written here rather than handed `fd`: libuv opens a
        // child no console only where none of its outputs is a handle it
        // inherits, and a runner on no console would otherwise open one.
        const child = spawn(binary, argv, {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: callTimeoutMs,
          windowsHide: true,
        });
        // A write that fails, as on a full disk, ends the copy and not this
        // process: the output is the call's, and the call is answered as is.
        let writing = true;
        for (const stream of [child.stdout, child.stderr])
          stream.on("data", (chunk) => {
            if (!writing) return;
            try {
              writeSync(fd, chunk);
            } catch {
              writing = false;
            }
          });
        child.once("error", (error) => resolve(engineAnswered(error, "", "")));
        child.once("close", (code, signal) =>
          resolve(
            code === null
              ? {
                  code: -1,
                  stdout: "",
                  stderr: `stopped by ${String(signal)}`,
                  failed: "Interrupted",
                }
              : { code, stdout: "", stderr: "" },
          ),
        );
      }),
  };
}
