/**
 * Every call the runner makes to its container engine, as the argv it hands
 * the engine's CLI. Nothing here runs anything.
 */

import { isAbsolute, join } from "node:path";

import {
  mintedCredentialDirectory,
  workerJobCommand,
  workerRuntimeDirectory,
} from "@chuggy/worker-contract/workerEnvironment";

import {
  jobEngineSocket,
  jobGid,
  jobPidsMax,
  jobProviderCredentialFile,
  jobRunDirectory,
  jobUid,
  jobWorkspace,
} from "./job.mjs";

/**
 * @typedef {"docker" | "podman"} EngineName
 * @typedef {import("./poolLoop.mjs").WorkerPoolWorkloadKind} WorkerPoolWorkloadKind
 *
 * @typedef {object} WorkloadContainer
 * @property {string} name
 * @property {string} pool the pool label's value
 * @property {string} assignment
 * @property {WorkerPoolWorkloadKind} kind
 * @property {number} deadlineEpochSecs
 * @property {string} envFile
 * @property {number} cpuMillis
 * @property {number} memoryMib
 * @property {string} tokenFile
 * @property {string} network
 * @property {string} image
 * @property {RuntimeVolumes} [runtime] the volumes of a job started through chuggy's runtime in place of its image's entrypoint; none, and the image's own entrypoint runs
 * @property {EngineSocket} [engineSocket] this machine's engine, handed to the workload through its socket; none, and it is handed nothing of the engine
 * @property {readonly OwnerVolume[]} [volumes] what the runner's owner mounts into the workload; none, and nothing is
 *
 * @typedef {object} OwnerVolume a named volume or a directory of this machine that a runner's owner mounts into each job
 * @property {string} source the volume's name, or the directory's absolute path, which no name can be
 * @property {string} target where the job's container has it
 * @property {boolean} readonly
 *
 * @typedef {object} EngineSocket this machine's container engine, as a workload is handed it
 * @property {string} path the socket's path on this machine
 * @property {number} gid the socket's group on this machine, which a docker workload is added to unless it is root's and a podman one never is
 * @property {true} [rootGroup] the socket is reached only through root's group, as Docker Desktop's is in its VM, so a docker workload is added to that group too; a runner says so only where every workload it hands the engine already holds root on the engine's machine
 *
 * @typedef {object} RuntimeVolumes a job's own volumes where it starts through chuggy's runtime
 * @property {string} volume the one holding its copy of the runtime
 * @property {string} workspace the one its workspace is, which every user can write
 * @property {string} fill the name of the container that fills them
 */

/** The labels a workload's container carries, which is how `held` finds it again. */
export const poolLabel = "io.chuggy.pool";
export const assignmentLabel = "io.chuggy.assignment";
export const kindLabel = "io.chuggy.kind";
export const deadlineLabel = "io.chuggy.deadline";
/** The labels of a job's container started through chuggy's runtime, whose values name its `RuntimeVolumes`. */
export const runtimeLabel = "io.chuggy.runtime";
export const workspaceLabel = "io.chuggy.workspace";
/** The label of each of a job's `RuntimeVolumes`, naming the container that fills them. */
export const fillLabel = "io.chuggy.fill";
/**
 * The label of a named volume a runner made for its owner. Such a volume
 * carries no pool's label, so no sweep of a pool's volumes lists it.
 */
export const ownerVolumeLabel = "io.chuggy.owner-volume";

/**
 * Every path `runArgv` mounts in a workload's container, whichever of them a
 * workload is given.
 */
export const workloadMountTargets = [
  jobProviderCredentialFile,
  jobEngineSocket,
  mintedCredentialDirectory,
  jobWorkspace,
  workerRuntimeDirectory,
];

/**
 * Whether a bind mount's `source=` can name this absolute path: one with no
 * comma, which would end it, and no line break.
 *
 * @param {string} path
 */
export function bindMountNameable(path) {
  return !/[,\r\n]/u.test(path);
}

/**
 * Whether an owner volume's source is a directory of this machine rather than
 * a named volume: an absolute path, which no volume's name can be.
 *
 * @param {string} source
 */
export function ownerVolumeDirectory(source) {
  return isAbsolute(source);
}

/**
 * What the container that fills a job's runtime volume runs with the
 * runtime's own node: its workspace volume opened to every user, as a
 * cluster's emptyDir is, since the job's user owns nothing an engine makes.
 */
const workspaceOpened = `require("node:fs").chmodSync(process.argv[1], 0o777)`;

/**
 * What the container that opens owner volumes runs with the runtime's own
 * node: each path it is given handed to the job's user.
 */
const ownerVolumesOpened = `for (const path of process.argv.slice(1)) require("node:fs").chownSync(path, ${String(jobUid)}, ${String(jobGid)})`;

/** The file the pool's credential is written to, in the directory made for it. */
export const registryAuthFile = "config.json";

/** @param {string} image */
export function imageInspectArgv(image) {
  return ["image", "inspect", "--format", "{{.Id}}", image];
}

/**
 * A pull as the engine's own configuration makes it, under whatever logins,
 * credential helpers and endpoint the runner's user and environment give it.
 *
 * @param {string} image
 */
export function pullArgv(image) {
  return ["pull", "--quiet", image];
}

/**
 * A pull of the pool's registry, and the variables its engine is run with,
 * under the pool's token: docker reads it from `DOCKER_CONFIG`, podman from
 * `--authfile`, unless a credential helper its `registries.conf` names first
 * answers for the host. A fresh `DOCKER_CONFIG` holds no CLI context either, so
 * docker is also told the endpoint its context resolved to, or the pull would
 * reach another daemon than every other call. `DOCKER_AUTH_CONFIG`, a login
 * docker takes from the environment over any file's, is emptied, which docker
 * reads as unset.
 *
 * @param {EngineName} engine
 * @param {string} image
 * @param {string} authDirectory
 * @param {string | undefined} dockerHost the endpoint `dockerContextArgv` answered; docker's alone
 * @returns {{argv: string[], environment: Record<string, string>}}
 */
export function poolPullArgv(engine, image, authDirectory, dockerHost) {
  if (engine === "docker") {
    if (dockerHost === undefined)
      throw new RangeError(
        "a docker pull under the pool's token needs the endpoint its context names",
      );
    return {
      argv: pullArgv(image),
      environment: {
        DOCKER_CONFIG: authDirectory,
        DOCKER_HOST: dockerHost,
        DOCKER_AUTH_CONFIG: "",
      },
    };
  }
  return {
    argv: [
      "pull",
      "--quiet",
      "--authfile",
      join(authDirectory, registryAuthFile),
      image,
    ],
    environment: {},
  };
}

/** Podman's own version. */
export function podmanVersionArgv() {
  return ["version", "--format", "{{.Client.Version}}"];
}

/**
 * Whether podman is a remote client, whose service may be on another machine
 * and mounts a container's paths from there.
 */
export function podmanRemoteArgv() {
  return ["info", "--format", "{{.Host.ServiceIsRemote}}"];
}

/** Where podman's API socket is on this machine, and whether it is there. */
export function podmanSocketArgv() {
  return [
    "info",
    "--format",
    "{{.Host.RemoteSocket.Path}} {{.Host.RemoteSocket.Exists}}",
  ];
}

/** Docker's security options, which name a daemon running rootless. */
export function dockerInfoArgv() {
  return ["info", "--format", "{{json .SecurityOptions}}"];
}

/** The endpoint docker's CLI reaches, by `DOCKER_HOST` or its current context. */
export function dockerContextArgv() {
  return ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"];
}

/**
 * The minted directory's tmpfs, owned by the image's user. Docker takes the
 * owner as `uid`/`gid` and rejects `U`; rootless podman rejects `uid`/`gid`
 * and takes `U`, which chowns the mount to the container's user.
 *
 * @param {EngineName} engine
 */
export function mintedTmpfs(engine) {
  const owner =
    engine === "docker"
      ? `uid=${String(jobUid)},gid=${String(jobGid)},mode=0700`
      : "mode=0700,U";
  return `${mintedCredentialDirectory}:rw,nosuid,nodev,noexec,size=1m,${owner}`;
}

/**
 * What a workload handed this machine's engine is run with: the engine's
 * socket, mounted read-only where docker's clients look for one, and on docker
 * the socket's group, without which the image's user cannot reach it. No
 * workload is added to root's group, so a socket of root's group adds none,
 * unless the runner says the socket is reached only through it.
 * Podman's workload needs no group, since keep-id maps the user running
 * podman, who owns its socket, onto the image's user.
 *
 * @param {EngineName} engine
 * @param {EngineSocket | undefined} socket
 */
function runArgvEngineSocket(engine, socket) {
  if (socket === undefined) return [];
  return [
    "--mount",
    `type=bind,source=${socket.path},target=${jobEngineSocket},readonly`,
    ...(engine === "docker" && (socket.gid !== 0 || socket.rootGroup === true)
      ? ["--group-add", String(socket.gid)]
      : []),
  ];
}

/**
 * What a job is run with of its owner's volumes. A directory is bind
 * mounted, which refuses one that is not there where `--volume` would make
 * it. A named volume is mounted uncopied: into an empty volume mounted over a
 * directory its image holds, an engine otherwise copies what that directory
 * holds and its owner and mode, which would undo the volume's opening and
 * seed a volume every job here shares from whichever image mounted it first.
 *
 * @param {readonly OwnerVolume[]} volumes
 */
function runArgvOwnerVolumes(volumes) {
  return volumes.flatMap(({ source, target, readonly }) =>
    ownerVolumeDirectory(source)
      ? [
          "--mount",
          `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`,
        ]
      : [
          "--volume",
          `${source}:${target}:${readonly ? "ro,nocopy" : "nocopy"}`,
        ],
  );
}

/**
 * The user namespace a container of the job's user runs in: on podman,
 * keep-id's, which maps the user running podman onto it; docker maps none.
 *
 * @param {EngineName} engine
 */
function jobUsernsArgv(engine) {
  return engine === "podman"
    ? [`--userns=keep-id:uid=${String(jobUid)},gid=${String(jobGid)}`]
    : [];
}

/**
 * One workload's container, a job's and a session's alike but for the kind
 * it is labelled with. The mounts and the security options are the rig's pod
 * in container terms: the image's user, no capabilities, no privilege
 * escalation, the engine's default seccomp profile, the minted credential in
 * memory the image's user owns, and the workspace in a volume of its own. A
 * workload handed this machine's engine is also run with its socket, as
 * `runArgvEngineSocket` says, and one given its owner's volumes with those, as
 * `runArgvOwnerVolumes` says.
 *
 * A JOB GIVEN RUNTIME VOLUMES STARTS THROUGH THEM, as the cluster starts one:
 * the runtime's mounted read-only at `workerRuntimeDirectory`, the workspace's
 * in place of an anonymous one, and the contract's
 * `workerJobCommand` in place of the image's entrypoint. Neither mount copies
 * the job's image into its volume, which an engine otherwise does into an
 * empty one, so a runtime left unfilled starts nothing of the image's own and
 * the workspace is the empty one its job is given on a cluster. Podman's
 * workspace mount also takes `U`, which chowns the volume to the job's user:
 * podman gives an empty volume the owner and mode of the directory the image
 * holds where it is mounted, which for a workspace the image's root owns
 * would undo the fill's opening of it.
 *
 * @param {EngineName} engine
 * @param {WorkloadContainer} workload
 */
export function runArgv(engine, workload) {
  const [entrypoint, ...command] = workerJobCommand;
  const { runtime } = workload;
  return [
    "run",
    "-d",
    "--pull=never",
    "--name",
    workload.name,
    "--label",
    `${poolLabel}=${workload.pool}`,
    "--label",
    `${assignmentLabel}=${workload.assignment}`,
    "--label",
    `${kindLabel}=${workload.kind}`,
    "--label",
    `${deadlineLabel}=${String(workload.deadlineEpochSecs)}`,
    ...(runtime === undefined
      ? []
      : [
          "--label",
          `${runtimeLabel}=${runtime.volume}`,
          "--label",
          `${workspaceLabel}=${runtime.workspace}`,
        ]),
    "--env-file",
    workload.envFile,
    "--user",
    `${String(jobUid)}:${String(jobGid)}`,
    ...jobUsernsArgv(engine),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(jobPidsMax),
    "--cpus",
    String(workload.cpuMillis / 1000),
    "--memory",
    `${String(workload.memoryMib)}m`,
    "--mount",
    `type=bind,source=${workload.tokenFile},target=${jobProviderCredentialFile},readonly`,
    ...runArgvEngineSocket(engine, workload.engineSocket),
    ...runArgvOwnerVolumes(workload.volumes ?? []),
    "--tmpfs",
    mintedTmpfs(engine),
    "--volume",
    ...(runtime === undefined
      ? [jobWorkspace]
      : [
          `${runtime.workspace}:${jobWorkspace}:${engine === "podman" ? "nocopy,U" : "nocopy"}`,
          "--volume",
          `${runtime.volume}:${workerRuntimeDirectory}:ro,nocopy`,
          "--entrypoint",
          entrypoint,
        ]),
    "--network",
    workload.network,
    workload.image,
    ...(runtime === undefined ? [] : command),
  ];
}

/**
 * One of a job's `RuntimeVolumes`, labelled with the pool and the assignment
 * it was made for and the container that fills it, so that what a runner
 * leaves can be found and removed.
 *
 * @param {string} volume
 * @param {string} pool the pool label's value
 * @param {string} assignment
 * @param {string} fill
 */
export function runtimeVolumeCreateArgv(volume, pool, assignment, fill) {
  return [
    "volume",
    "create",
    "--label",
    `${poolLabel}=${pool}`,
    "--label",
    `${assignmentLabel}=${assignment}`,
    "--label",
    `${fillLabel}=${fill}`,
    volume,
  ];
}

/**
 * The container that fills a job's `RuntimeVolumes`, named by their `fill`
 * and labelled with nothing, so no listing of a pool's containers finds it:
 * the runtime image with the empty runtime volume mounted over its own
 * `workerRuntimeDirectory`, which the engine fills from the image before
 * anything runs, as it fills any empty volume mounted over a directory an
 * image holds, and the workspace volume mounted uncopied. What it runs is
 * the copy's own node, from the volume, so a runtime left unfilled fails the
 * fill, and what that node does is open the workspace, which only the
 * volume's owner may. That owner is the engine's root, so this container runs
 * as root, with no capability, no privilege escalation and no network.
 *
 * @param {RuntimeVolumes} volumes
 * @param {string} runtime the runtime image
 */
export function runtimeFillArgv(volumes, runtime) {
  return [
    "run",
    "--rm",
    "--pull=never",
    "--name",
    volumes.fill,
    "--user",
    "0:0",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    "none",
    "--volume",
    `${volumes.volume}:${workerRuntimeDirectory}`,
    "--volume",
    `${volumes.workspace}:${jobWorkspace}:nocopy`,
    "--entrypoint",
    `${workerRuntimeDirectory}/bin/node`,
    runtime,
    "--eval",
    workspaceOpened,
    jobWorkspace,
  ];
}

/**
 * A named volume this runner makes for its owner, labelled as one. Podman is
 * also told to give it the owner it would anyway, which is what stops podman,
 * at each mount while the volume is empty and whether or not the mount
 * copies, giving it the mounting container's user and then the owner and mode
 * of the directory that container's image holds there. Docker does neither to
 * a volume mounted uncopied.
 *
 * @param {EngineName} engine
 * @param {string} volume
 */
export function ownerVolumeCreateArgv(engine, volume) {
  return [
    "volume",
    "create",
    "--label",
    ownerVolumeLabel,
    ...(engine === "podman" ? ["--opt", "o=uid=0,gid=0"] : []),
    volume,
  ];
}

/**
 * Where the container opening owner volumes mounts each: in chuggy's own run
 * directory, which no owner's target can be, so none hides what the runtime's
 * node needs.
 *
 * @param {string} volume
 */
function ownerVolumesOpenArgvMount(volume) {
  return join(jobRunDirectory, "volumes", volume);
}

/**
 * The container that opens named volumes this runner made for its owner to
 * the job's user, labelled with nothing, so no listing of a pool's containers
 * finds it: the runtime image, whose own node gives each volume's root to the
 * job's uid and gid. It runs as root with the one capability that takes, no
 * privilege escalation and no network, and in the job's user namespace, so
 * the owner it gives is the one the job runs as on either engine.
 *
 * @param {EngineName} engine
 * @param {readonly string[]} volumes
 * @param {string} runtime the runtime image
 */
export function ownerVolumesOpenArgv(engine, volumes, runtime) {
  return [
    "run",
    "--rm",
    "--pull=never",
    "--user",
    "0:0",
    ...jobUsernsArgv(engine),
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--security-opt",
    "no-new-privileges",
    "--network",
    "none",
    ...volumes.flatMap((volume) => [
      "--volume",
      `${volume}:${ownerVolumesOpenArgvMount(volume)}:nocopy`,
    ]),
    "--entrypoint",
    `${workerRuntimeDirectory}/bin/node`,
    runtime,
    "--eval",
    ownerVolumesOpened,
    ...volumes.map(ownerVolumesOpenArgvMount),
  ];
}

/** @param {string} volume */
export function volumeRemoveArgv(volume) {
  return ["volume", "rm", volume];
}

/**
 * A pool's volumes, by name.
 *
 * @param {string} pool the pool label's value
 */
export function volumeListArgv(pool) {
  return ["volume", "ls", "--quiet", "--filter", `label=${poolLabel}=${pool}`];
}

/** @param {readonly string[]} volumes */
export function volumeInspectArgv(volumes) {
  return ["volume", "inspect", ...volumes];
}

/**
 * A pool's containers, or the one of them an assignment runs as.
 *
 * @param {string} pool the pool label's value
 * @param {string} [assignment]
 */
export function listArgv(pool, assignment) {
  return [
    "ps",
    "--all",
    "--quiet",
    "--no-trunc",
    "--filter",
    `label=${poolLabel}=${pool}`,
    ...(assignment === undefined
      ? []
      : ["--filter", `label=${assignmentLabel}=${assignment}`]),
  ];
}

/** @param {readonly string[]} containers */
export function inspectArgv(containers) {
  return ["container", "inspect", ...containers];
}

/** @param {string} container */
export function killArgv(container) {
  return ["kill", container];
}

/** @param {string} container */
export function logsArgv(container) {
  return ["logs", container];
}

/**
 * A removal, with the container's anonymous volumes: the workspace goes with
 * the workload.
 *
 * @param {string} container
 */
export function removeArgv(container) {
  return ["rm", "-v", container];
}

/**
 * A removal of a container whether or not it is running, which kills it first.
 *
 * @param {string} container
 */
export function forcedRemoveArgv(container) {
  return ["rm", "--force", container];
}

/** @param {string} network */
export function networkInspectArgv(network) {
  return ["network", "inspect", network];
}

/** @param {string} network */
export function networkCreateArgv(network) {
  return ["network", "create", network];
}
