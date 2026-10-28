/**
 * The running service's door for the CLI on the same machine: a Unix socket
 * in the runner's runtime directory, which only its owner can enter, with one
 * JSON line asked and one answered. What only the service knows is what it is
 * still placing, or a chat host's status, and a stop asked here is the stop
 * the plane asks for, so a placement still pulling is cancelled rather than
 * started afterwards.
 */

import { rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

import { workerPoolAssignmentIdentitySchema } from "@chuggy/worker-contract/workerPool";
import { z } from "zod";

/**
 * @typedef {z.infer<typeof controlRequestSchema>} ControlRequest
 *
 * @typedef {object} ControlBackend what of a runner's backend the door reaches
 * @property {() => readonly unknown[]} inFlight what it is still placing
 * @property {(assignment: string) => Promise<unknown>} stop
 * @property {() => unknown} [chatStatus] a chat host's status, which a runner's backend has none of
 */

/** Far above the longest request, a stop naming the longest assignment. */
const controlLineCharsMax = 4096;

const controlRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("status") }),
  z.strictObject({ op: z.literal("chatStatus") }),
  z.strictObject({
    op: z.literal("stop"),
    assignment: workerPoolAssignmentIdentitySchema,
  }),
]);

/** @param {string} runtimeDir */
export function controlSocketPath(runtimeDir) {
  return join(runtimeDir, "control.sock");
}

/**
 * @param {ControlBackend} backend
 * @param {string} line
 */
async function controlAnswer(backend, line) {
  let request;
  try {
    request = controlRequestSchema.parse(JSON.parse(line));
  } catch {
    return { refused: "not a request this service answers" };
  }
  if (request.op === "status") return { inFlight: backend.inFlight() };
  if (request.op === "chatStatus")
    return backend.chatStatus === undefined
      ? { refused: "this service is no chat host's" }
      : { chatStatus: backend.chatStatus() };
  return backend.stop(request.assignment);
}

/**
 * Reads one line off a socket, refusing one past the bound.
 *
 * @param {import("node:net").Socket} socket
 * @returns {Promise<string>}
 */
function controlLine(socket) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline >= 0) resolve(buffered.slice(0, newline));
      else if (buffered.length > controlLineCharsMax)
        reject(new RangeError("the line is longer than any this door reads"));
    });
    socket.once("end", () =>
      reject(new Error("the line ended before its newline")),
    );
    socket.once("error", reject);
  });
}

/**
 * Whether a service already answers at `path`: one that does is refused, and
 * a socket file nobody answers is what a stopped service left behind.
 *
 * @param {string} path
 */
async function controlSocketFreed(path) {
  const answering = await new Promise((resolve) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
  if (answering)
    throw new Error(`a runner's service already answers at ${path}`);
  await rm(path, { force: true });
}

/**
 * @param {string} path
 * @param {ControlBackend} backend
 * @returns {Promise<import("node:net").Server>}
 */
export async function controlServer(path, backend) {
  await controlSocketFreed(path);
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    controlLine(socket)
      .then((line) => controlAnswer(backend, line))
      .then(
        (answer) => socket.end(`${JSON.stringify(answer)}\n`),
        () => socket.destroy(),
      );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve(undefined));
  });
  return server;
}

/**
 * Asks the service at `path`, answering nothing when no service is there.
 *
 * @param {string} path
 * @param {ControlRequest} request
 * @returns {Promise<unknown>}
 */
export function controlAsked(path, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("error", (error) => {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") resolve(undefined);
      else reject(error);
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
      controlLine(socket).then((line) => {
        socket.destroy();
        resolve(JSON.parse(line));
      }, reject);
    });
  });
}
