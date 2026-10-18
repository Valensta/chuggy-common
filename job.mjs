/**
 * What every workload is given, a job and a session alike, whichever engine
 * runs it: the envelope it is launched with in place of a task document, the
 * user it runs as, and the paths its image reads. The core fetches its task
 * through the envelope and learns there which kind it runs. The envelope is
 * checked against the contract's own schema, so no workload starts with one
 * its core would refuse, and is read back from a container under the same
 * schema. A job its runner hands this machine's container engine is also
 * given the engine's socket, and told where it is.
 *
 * A JOB RUN ON ITS RUNNER'S HOST HAS A DIRECTORY WHERE A CONTAINER HAS MOUNTS.
 * Its workspace, its home and the directory credentials are minted to are each
 * in it, and the core is told it under `hostJobVariable`, which is how the
 * core knows it runs on a host: there its agents are the ones on its PATH,
 * since a host carries no runtime tree of chuggy's.
 */

import { dirname, join, relative } from "node:path";

import {
  mintedCredentialDirectory,
  workerRepositoryDirectory,
  workerTaskVariable,
  workerWorkspaceDirectory,
  workerWorkspaceVariable,
} from "@chuggy/worker-contract/workerEnvironment";
import { poolEnvelopeSchema } from "@chuggy/worker-contract/workerTask";

import { workerJobVariables } from "./checks.mjs";
import { hostJobVariable } from "./coreRuntime.mjs";

/**
 * @typedef {import("@chuggy/worker-contract/workerPool").WorkerPoolAssignment} WorkerPoolAssignment
 *
 * @typedef {object} JobBounds
 * @property {number} timeoutSecsMax the longest this pool lets the workload run
 * @property {number} outputBytesMax
 */

/** The worker image's own user, which every mount a workload reads is shaped for. */
export const jobUid = 1000;
export const jobGid = 1000;

/** A bound on a workload's processes, so a fork loop in agent-run code stops at its own container. */
export const jobPidsMax = 4096;

/** An anonymous volume of the workload's own container. */
export const jobWorkspace = workerWorkspaceDirectory;

/**
 * Where a workload's checkout is in the workspace it works in: where the
 * contract puts it in a container's, and at the same place in the directory a
 * job on its runner's host is given.
 *
 * @param {string} workspace
 */
export function jobRepositoryDirectory(workspace) {
  return join(
    workspace,
    relative(workerWorkspaceDirectory, workerRepositoryDirectory),
  );
}

/**
 * Chuggy's own directory in a workload's container, which the credentials it
 * mints and the token file it mounts are in.
 */
export const jobRunDirectory = dirname(mintedCredentialDirectory);

/** Where the Claude token file is mounted, read-only. */
export const jobProviderCredentialFile = join(
  jobRunDirectory,
  "credentials",
  "claude-code",
);

/**
 * Where a job run on its runner's host keeps what a container would mount,
 * each in its directory.
 *
 * @param {string} directory
 */
export function jobHostPlaces(directory) {
  return {
    workspace: join(directory, "workspace"),
    home: join(directory, "home"),
    minted: join(directory, "minted"),
  };
}

/**
 * Where a job handed this machine's container engine finds its socket, which
 * is where docker's clients and testcontainers look for one.
 */
export const jobEngineSocket = "/var/run/docker.sock";

/**
 * What a job handed this machine's container engine is told of it: the
 * socket docker's clients reach it at, and for testcontainers the socket's
 * path on this machine, which the reaper container it starts beside the job
 * mounts the socket from. A port podman publishes is reached from a job only
 * at `host.containers.internal`, so on podman testcontainers is told to reach
 * what it starts there.
 *
 * @param {import("./engineArgv.mjs").EngineName} engine
 * @param {string} socketPath the socket's path on this machine
 * @returns {Record<string, string>}
 */
export function jobEngineSocketEnvironment(engine, socketPath) {
  return {
    DOCKER_HOST: `unix://${jobEngineSocket}`,
    TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE: socketPath,
    ...(engine === "podman"
      ? { TESTCONTAINERS_HOST_OVERRIDE: "host.containers.internal" }
      : {}),
  };
}

/**
 * The variables `jobEngineSocketEnvironment` sets on either engine, which a
 * workload's environment may not name while its runner hands jobs the engine.
 */
export const jobEngineSocketVariables = [
  "DOCKER_HOST",
  "TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE",
  "TESTCONTAINERS_HOST_OVERRIDE",
];

/**
 * The variables a workload's environment may not name: the envelope, the one
 * the core sets from the mounted token, which a value here would shadow, the
 * workspace a job started through chuggy's runtime is checked at, which a
 * value here would move off the one its envelope names, and those the core
 * tells a job's shells which job they are in by, over any value here.
 */
export const reservedJobVariables = [
  workerTaskVariable,
  "CLAUDE_CODE_OAUTH_TOKEN",
  workerWorkspaceVariable,
  hostJobVariable,
  ...Object.values(workerJobVariables),
];

/**
 * The envelope as the text `CHUG_WORKER_TASK` carries. A refusal names the
 * fields that failed and never their values, because the bearer is one.
 *
 * @param {WorkerPoolAssignment} assignment
 * @param {JobBounds} bounds
 * @param {{workspace: string, providerCredentialFile: string}} [places] where the workload finds them; a container's mounts where absent
 * @returns {string}
 */
export function jobEnvelope(
  assignment,
  bounds,
  places = {
    workspace: jobWorkspace,
    providerCredentialFile: jobProviderCredentialFile,
  },
) {
  const envelope = poolEnvelopeSchema.safeParse({
    callbackUrl: assignment.callbackUrl,
    bearer: assignment.bearer,
    workspace: places.workspace,
    timeoutSecsMax: bounds.timeoutSecsMax,
    outputBytesMax: bounds.outputBytesMax,
    providerCredentialFile: places.providerCredentialFile,
  });
  if (!envelope.success)
    throw new RangeError(
      `the assignment makes no envelope its container can read: ${envelope.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")}`,
    );
  return JSON.stringify(envelope.data);
}

/**
 * The attempt a workload was launched for, read back from the envelope among
 * its container's variables, or nothing where none there can be read.
 *
 * @param {readonly string[]} variables each `NAME=value`, as an engine's inspection lists them
 * @returns {{callbackUrl: string, bearer: string} | undefined}
 */
export function jobEnvironmentAttempt(variables) {
  const prefix = `${workerTaskVariable}=`;
  const carried = variables.find((variable) => variable.startsWith(prefix));
  if (carried === undefined) return undefined;
  let document;
  try {
    document = JSON.parse(carried.slice(prefix.length));
  } catch {
    return undefined;
  }
  const envelope = poolEnvelopeSchema.safeParse(document);
  if (!envelope.success) return undefined;
  return {
    callbackUrl: envelope.data.callbackUrl,
    bearer: envelope.data.bearer,
  };
}

/**
 * The env file a workload's container is run with: the envelope, then the
 * runner's environment. An env file carries one variable a line with its value
 * taken verbatim, so a value that would break a line is refused rather than
 * split.
 *
 * @param {string} envelope
 * @param {Readonly<Record<string, string>>} environment
 * @returns {string}
 */
export function jobEnvironmentFile(envelope, environment) {
  const lines = [
    [workerTaskVariable, envelope],
    ...Object.entries(environment),
  ];
  return lines
    .map(([name, value]) => {
      if (/[\r\n]/u.test(value))
        throw new RangeError(`${name} cannot be carried by an env file`);
      return `${name}=${value}\n`;
    })
    .join("");
}
