/**
 * A container engine held in memory, answering the runner's argv with the
 * words docker 28 prints. A pull waits on whatever the suite hands it, so a
 * suite decides how long one takes and how it ends, and so does a `run --rm`,
 * which is how chuggy's runtime is copied into a volume: its container holds
 * the volumes it mounts until then, and goes once it has answered.
 *
 * AN IMAGE IS EACH NAME OF IT IN `images`, by the id `imageIds` gives that
 * name, or one of its own digest. An inspection lists a name with a digest
 * among an image's `RepoDigests` and any other among its `RepoTags`, as docker
 * 28 does, and a removal of the last name of an image a container was run
 * from is refused in docker 28's words, as its classic store refuses it once
 * every other name is gone.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname } from "node:path";

/**
 * @typedef {import("./engine.mjs").EngineAnswer} EngineAnswer
 *
 * @typedef {object} FakeContainer
 * @property {string} id
 * @property {string} name
 * @property {Record<string, string>} labels
 * @property {string} status
 * @property {string} image
 * @property {string[]} [env] each `NAME=value`, as an inspection lists them
 * @property {number} [exitCode]
 * @property {string} [startedAt] when it started, which an inspection answers as docker's zero time where none
 * @property {string[]} [volumes] each `--volume` it was run with
 * @property {string[]} [command] what it was run with after its image
 * @property {string} [entrypoint]
 * @property {string} [log] what `logs` prints of it, which is a line naming it where none
 *
 * @typedef {object} FakeVolume
 * @property {Record<string, string>} labels
 * @property {string} [filledFrom] the image a `run --rm` filled it from
 *
 * @typedef {object} FakeCall
 * @property {string[]} argv
 * @property {Record<string, string>} environment
 * @property {string} [envFile] the env file's text as `run` found it
 * @property {string} [authFile] the pull credential's text as `pull` found it
 * @property {string} [authDirectory] the directory it was found in
 *
 * @typedef {ReturnType<typeof fakeEngineState>} FakeEngineState
 */

const unreachable =
  "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";

/**
 * @param {string} stderr
 * @returns {EngineAnswer}
 */
const failed = (stderr, code = 1) => ({
  code,
  stdout: "",
  stderr: `${stderr}\n`,
});

/**
 * @param {string} stdout
 * @returns {EngineAnswer}
 */
const answered = (stdout = "") => ({ code: 0, stdout, stderr: "" });

/** The variable an image sets, which an inspection lists beside the env file's. */
const imagePath = "PATH=/usr/local/bin:/usr/bin:/bin";

/** What a container a kill ended exits with, as a shell reports a death by signal. */
const killedExitCode = 128 + constants.signals.SIGKILL;

/** @param {string} reference */
const missing = (reference) =>
  failed(`Error response from daemon: No such container: ${reference}`);

/**
 * @param {string[]} argv
 * @param {string} flag
 */
function flagValues(argv, flag) {
  return argv.flatMap((value, index) =>
    index > 0 && argv[index - 1] === flag ? [value] : [],
  );
}

/**
 * The labels an argv sets, each `key=value` or a bare key, which the engine
 * gives an empty value.
 *
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function labelsSet(argv) {
  return Object.fromEntries(
    flagValues(argv, "--label").map((label) => {
      const equals = label.indexOf("=");
      return equals === -1
        ? [label, ""]
        : [label.slice(0, equals), label.slice(equals + 1)];
    }),
  );
}

/**
 * The flags of `run` that take no value of their own.
 */
const runSwitches = new Set(["-d", "--rm"]);

/**
 * A `run`'s image and what follows it, read past its flags as the engine
 * reads them.
 *
 * @param {string[]} argv
 */
function runImage(argv) {
  let index = 1;
  while (index < argv.length && argv[index].startsWith("-"))
    index += runSwitches.has(argv[index]) || argv[index].includes("=") ? 1 : 2;
  return { image: argv[index] ?? "", command: argv.slice(index + 1) };
}

/**
 * The named volumes among `--volume` values, by name, or only those an engine
 * copies an image into.
 *
 * @param {string[]} mounts
 */
function namedVolumes(mounts, copied = false) {
  return mounts.flatMap((volume) => {
    const [name, , options = ""] = volume.split(":");
    return volume.includes(":") &&
      !name.startsWith("/") &&
      !(copied && options.split(",").includes("nocopy"))
      ? [name]
      : [];
  });
}

/**
 * What docker 28 prints of a `run` whose entrypoint is not in its image, and
 * the status its CLI answers it with.
 *
 * @param {string} entrypoint
 */
export function unstartedEntrypoint(entrypoint) {
  return failed(
    `docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "${entrypoint}": stat ${entrypoint}: no such file or directory: unknown`,
    127,
  );
}

/**
 * What `logs` prints of a container, from its last `--tail` lines, kept as
 * `execTail` keeps it.
 *
 * @param {FakeContainer} container
 * @param {string[]} argv
 * @param {number} bytesMax
 */
function logTail(container, argv, bytesMax) {
  const [tail] = flagValues(argv, "--tail");
  const lines = (container.log ?? `the log of ${container.name}\n`)
    .split(/(?<=\n)/u)
    .slice(-Number(tail ?? Infinity));
  const printed = Buffer.from(lines.join(""));
  return {
    tail: printed.subarray(Math.max(0, printed.length - bytesMax)),
    cut: printed.length > bytesMax,
    lines: lines.filter((line) => line.endsWith("\n")).length,
  };
}

/** @param {AbortSignal | undefined} signal */
function aborted(signal) {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
}

function fakeEngineState() {
  const state = {
    /** @type {Map<string, FakeContainer>} */
    containers: new Map(),
    /** @type {Set<string>} each name of every image */
    images: new Set(),
    /**
     * The id of the image a name names, where it is not one of its own.
     *
     * @type {Map<string, string>}
     */
    imageIds: new Map(),
    /**
     * When an image was built, by its id, where it is not the start of 2026.
     *
     * @type {Map<string, string>}
     */
    imageCreated: new Map(),
    networks: new Set(),
    /** @type {Map<string, FakeVolume>} */
    volumes: new Map(),
    /**
     * The images with no `/bin/sh`, whose container a `run` through it
     * creates and never starts.
     *
     * @type {Set<string>}
     */
    shellless: new Set(),
    /** @type {FakeCall[]} */
    calls: [],
    unreachable: false,
    logsFail: false,
    /**
     * What a `logs` that fails prints on stderr, where not the words of a
     * container that is not there.
     *
     * @type {string | undefined}
     */
    logsStderr: /** @type {string | undefined} */ (undefined),
    /** Whether a kill runs past the engine's cap, which the engine answers as interrupted. */
    killInterrupted: false,
    /** Whether a run runs past the engine's cap after its container started, which the engine answers as interrupted. */
    runInterrupted: false,
    /** What podman's `version` answers. */
    podmanVersion: "5.8.7",
    /**
     * What podman's `info` answers of whether its service is remote, or
     * nothing when that `info` fails.
     *
     * @type {string | undefined}
     */
    podmanServiceRemote: /** @type {string | undefined} */ ("false"),
    /** What docker's `info` names its security options; rootless adds `name=rootless`. */
    securityOptions: ["name=apparmor", "name=seccomp,profile=builtin"],
    /**
     * The endpoint docker's current context names, or none when its context
     * cannot be read.
     *
     * @type {string | undefined}
     */
    contextHost: "unix:///var/run/docker.sock",
    nextId: 1,
    /**
     * An answer a suite gives a call in the engine's place, or nothing to
     * leave the call to the engine.
     *
     * @type {(call: FakeCall) => EngineAnswer | Promise<EngineAnswer> | undefined}
     */
    intercept: () => undefined,
    /**
     * How a pull ends; the default finds the image.
     *
     * @type {(image: string, call: FakeCall) => EngineAnswer | Promise<EngineAnswer>}
     */
    pull: (image) => {
      state.images.add(image);
      return answered();
    },
    /**
     * How a `run --rm` that fills a volume ends; the default copies the image
     * into each volume it mounts but uncopied, as an engine copies into an
     * empty one.
     *
     * @type {(image: string, volumes: string[], call: FakeCall) => EngineAnswer | Promise<EngineAnswer>}
     */
    fill: (image, volumes) => {
      for (const name of volumes) {
        const volume = state.volumes.get(name);
        if (volume !== undefined) volume.filledFrom = image;
      }
      return answered("v24.0.0\n");
    },
  };
  return state;
}

/**
 * @param {FakeEngineState} state
 * @param {string} reference a name or an id
 */
function found(state, reference) {
  return (
    state.containers.get(reference) ??
    [...state.containers.values()].find(
      (container) => container.id === reference,
    )
  );
}

/**
 * A `run --rm`, whose container holds the volumes it mounts until the suite's
 * `fill` has answered, and is removed then, as the engine removes one run so.
 *
 * @param {FakeEngineState} state
 * @param {FakeCall} call
 * @param {string} image
 */
function filled(state, call, image) {
  if (!state.images.has(image))
    return failed(
      `docker: Error response from daemon: No such image: ${image}`,
      125,
    );
  const id = `c${String(state.nextId++).padStart(63, "0")}`;
  const [name = id] = flagValues(call.argv, "--name");
  const volumes = flagValues(call.argv, "--volume");
  /** @type {FakeContainer} */
  const container = { id, name, labels: {}, status: "running", image, volumes };
  state.containers.set(name, container);
  return Promise.resolve(
    state.fill(image, namedVolumes(volumes, true), call),
  ).finally(() => {
    if (state.containers.get(name) === container) state.containers.delete(name);
  });
}

/**
 * @param {FakeEngineState} state
 * @param {FakeCall} call
 */
function run(state, call) {
  const { argv } = call;
  const { image, command } = runImage(argv);
  if (argv.includes("--rm")) return filled(state, call, image);
  const [name] = flagValues(argv, "--name");
  call.envFile = readFileSync(flagValues(argv, "--env-file")[0], "utf8");
  const existing = state.containers.get(name);
  if (existing !== undefined)
    return failed(
      `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${existing.id}". You have to remove (or rename) that container to be able to reuse that name.`,
      125,
    );
  const labels = labelsSet(argv);
  const id = `c${String(state.nextId++).padStart(63, "0")}`;
  const env = [
    imagePath,
    ...call.envFile.split("\n").filter((line) => line.length > 0),
  ];
  const [entrypoint] = flagValues(argv, "--entrypoint");
  const unstarted = entrypoint === "/bin/sh" && state.shellless.has(image);
  state.containers.set(name, {
    id,
    name,
    labels,
    status: unstarted ? "created" : "running",
    image,
    env,
    exitCode: unstarted ? 127 : 0,
    volumes: flagValues(argv, "--volume"),
    command,
    entrypoint,
  });
  if (unstarted)
    return { ...unstartedEntrypoint(entrypoint), stdout: `${id}\n` };
  if (state.runInterrupted)
    return { code: -1, stdout: "", stderr: "", failed: "Interrupted" };
  return answered(`${id}\n`);
}

/**
 * @param {FakeEngineState} state
 * @param {string[]} references
 */
function inspected(state, references) {
  const matched = references.map((reference) => found(state, reference));
  const absent = references.filter((_, index) => matched[index] === undefined);
  const document = matched.flatMap((container) =>
    container === undefined
      ? []
      : [
          {
            Id: container.id,
            Name: `/${container.name}`,
            Config: { Labels: container.labels, Env: container.env ?? null },
            State: {
              Status: container.status,
              ExitCode: container.exitCode,
              StartedAt: container.startedAt ?? "0001-01-01T00:00:00Z",
            },
          },
        ],
  );
  const stdout = `${JSON.stringify(document)}\n`;
  return absent.length === 0
    ? answered(stdout)
    : { ...missing(absent[0]), stdout };
}

/**
 * @param {FakeEngineState} state
 * @param {FakeCall} call
 */
function pulled(state, call) {
  const auth =
    flagValues(call.argv, "--authfile")[0] ??
    (call.environment.DOCKER_CONFIG === undefined
      ? undefined
      : `${call.environment.DOCKER_CONFIG}/config.json`);
  if (auth !== undefined) {
    call.authFile = readFileSync(auth, "utf8");
    call.authDirectory = dirname(auth);
  }
  return state.pull(call.argv.at(-1) ?? "", call);
}

/**
 * @param {FakeEngineState} state
 * @param {string} reference
 * @param {(container: FakeContainer) => void} change
 */
function changed(state, reference, change) {
  const container = found(state, reference);
  if (container === undefined) return missing(reference);
  change(container);
  return answered(`${reference}\n`);
}

/**
 * @param {FakeEngineState} state
 * @param {string} reference
 * @returns {EngineAnswer}
 */
function killed(state, reference) {
  if (state.killInterrupted)
    return { code: -1, stdout: "", stderr: "", failed: "Interrupted" };
  const container = found(state, reference);
  if (container !== undefined && container.status !== "running")
    return failed(
      `Error response from daemon: cannot kill container: ${reference}: container ${container.id} is not running`,
    );
  return changed(state, reference, (running) => {
    running.status = "exited";
    running.exitCode = killedExitCode;
  });
}

/**
 * @param {FakeEngineState} state
 * @param {string} network
 * @param {string} verb
 */
function networked(state, network, verb) {
  if (verb === "create") {
    state.networks.add(network);
    return answered("n1\n");
  }
  return state.networks.has(network)
    ? answered("[]\n")
    : failed(`Error response from daemon: network ${network} not found`);
}

/**
 * The labels a listing's `--filter`s ask for, as key and value.
 *
 * @param {string[]} argv
 */
function labelFilters(argv) {
  return flagValues(argv, "--filter")
    .filter((filter) => filter.startsWith("label="))
    .map((filter) => {
      const [key, ...value] = filter.replace(/^label=/u, "").split("=");
      return [key, value.join("=")];
    });
}

/**
 * Whether a container passes a listing's `ancestor` filters: run from the
 * image each names, by its id or one of its names.
 *
 * @param {FakeEngineState} state
 * @param {FakeContainer} container
 * @param {string[]} argv
 */
function ancestorsMatched(state, container, argv) {
  const id = fakeImageId(state, container.image);
  return flagValues(argv, "--filter")
    .filter((filter) => filter.startsWith("ancestor="))
    .every((filter) => {
      const named = filter.slice("ancestor=".length);
      return named === id || fakeImageId(state, named) === id;
    });
}

/**
 * A `volume inspect`, which answers `null` for the labels of a volume made
 * with none, as docker does.
 *
 * @param {FakeEngineState} state
 * @param {string[]} names
 */
function volumesInspected(state, names) {
  const absent = names.find((name) => !state.volumes.has(name));
  const stdout = `${JSON.stringify(
    names.flatMap((name) => {
      const volume = state.volumes.get(name);
      return volume === undefined
        ? []
        : [
            {
              Driver: "local",
              Labels:
                Object.keys(volume.labels).length === 0 ? null : volume.labels,
              Name: name,
            },
          ];
    }),
  )}\n`;
  return absent === undefined
    ? answered(stdout)
    : {
        ...failed(`Error response from daemon: get ${absent}: no such volume`),
        stdout,
      };
}

/**
 * `volume ls` and `volume inspect`; `volume create`, which answers a name
 * already made as made; and `volume rm`, which refuses one a container mounts.
 *
 * @param {FakeEngineState} state
 * @param {FakeCall} call
 */
function volumed(state, call) {
  const { argv } = call;
  const name = argv.at(-1) ?? "";
  if (argv[1] === "ls") {
    const wanted = labelFilters(argv);
    return answered(
      [...state.volumes]
        .filter(([, volume]) =>
          wanted.every(([key, value]) => volume.labels[key] === value),
        )
        .map(([listed]) => `${listed}\n`)
        .join(""),
    );
  }
  if (argv[1] === "inspect") return volumesInspected(state, argv.slice(2));
  if (argv[1] === "create") {
    if (!state.volumes.has(name))
      state.volumes.set(name, { labels: labelsSet(argv) });
    return answered(`${name}\n`);
  }
  if (!state.volumes.has(name))
    return failed(`Error response from daemon: get ${name}: no such volume`);
  const user = [...state.containers.values()].find((container) =>
    namedVolumes(container.volumes ?? []).includes(name),
  );
  if (user !== undefined)
    return failed(
      `Error response from daemon: remove ${name}: volume is in use - [${user.id}]`,
    );
  state.volumes.delete(name);
  return answered(`${name}\n`);
}

/**
 * The id of the image a name names.
 *
 * @param {FakeEngineState} state
 * @param {string} name
 */
export function fakeImageId(state, name) {
  return (
    state.imageIds.get(name) ??
    `sha256:${createHash("sha256").update(name).digest("hex")}`
  );
}

/**
 * The names of the image of this id.
 *
 * @param {FakeEngineState} state
 * @param {string} id
 */
function imageNames(state, id) {
  return [...state.images].filter((name) => fakeImageId(state, name) === id);
}

/**
 * An image's inspection, as docker 28 answers one without `--format`.
 *
 * @param {FakeEngineState} state
 * @param {string} id
 */
function imageInspected(state, id) {
  const names = imageNames(state, id);
  return {
    Id: id,
    RepoTags: names.filter((name) => !name.includes("@")),
    RepoDigests: names.filter((name) => name.includes("@")),
    Created: state.imageCreated.get(id) ?? "2026-01-01T00:00:00Z",
  };
}

/**
 * A removal of one name of an image, which docker refuses where it is the
 * image's last and a container was run from the image.
 *
 * @param {FakeEngineState} state
 * @param {string} name
 */
function imageRemoved(state, name) {
  if (!state.images.has(name))
    return failed(`Error response from daemon: No such image: ${name}`);
  const id = fakeImageId(state, name);
  const user = [...state.containers.values()].find(
    (container) => fakeImageId(state, container.image) === id,
  );
  if (user !== undefined && imageNames(state, id).length === 1)
    return failed(
      `Error response from daemon: conflict: unable to remove repository reference "${name}" (must force) - container ${user.id.slice(0, 12)} is using its referenced image ${id.replace("sha256:", "").slice(0, 12)}`,
    );
  state.images.delete(name);
  return answered(
    `Untagged: ${name}\n${imageNames(state, id).length === 0 ? `Deleted: ${id}\n` : ""}`,
  );
}

/**
 * `image inspect`, by `--format {{.Id}}` of one name or whole by ids, `image
 * ls` and `image rm`.
 *
 * @param {FakeEngineState} state
 * @param {FakeCall} call
 */
function imaged(state, call) {
  const [, verb, ...rest] = call.argv;
  if (verb === "ls")
    return answered(
      [...new Set([...state.images].map((name) => fakeImageId(state, name)))]
        .map((id) => `${id}\n`)
        .join(""),
    );
  if (verb === "rm") return imageRemoved(state, rest.at(-1) ?? "");
  if (rest[0] === "--format") {
    const name = rest.at(-1) ?? "";
    return state.images.has(name)
      ? answered(`${fakeImageId(state, name)}\n`)
      : failed(`Error response from daemon: No such image: ${name}`);
  }
  const absent = rest.find((id) => imageNames(state, id).length === 0);
  const stdout = `${JSON.stringify(
    rest
      .filter((id) => id !== absent && imageNames(state, id).length > 0)
      .map((id) => imageInspected(state, id)),
  )}\n`;
  return absent === undefined
    ? answered(stdout)
    : {
        ...failed(`Error response from daemon: No such image: ${absent}`),
        stdout,
      };
}

/**
 * @param {FakeEngineState} state
 * @param {FakeCall} call
 * @returns {EngineAnswer | Promise<EngineAnswer>}
 */
function answer(state, call) {
  const [verb, second] = call.argv;
  const last = call.argv.at(-1) ?? "";
  if (state.unreachable) return failed(unreachable);
  const intercepted = state.intercept(call);
  if (intercepted !== undefined) return intercepted;
  if (verb === "image") return imaged(state, call);
  if (verb === "pull") return pulled(state, call);
  if (verb === "version") return answered(`${state.podmanVersion}\n`);
  if (verb === "info" && call.argv[2] === "{{.Host.ServiceIsRemote}}")
    return state.podmanServiceRemote === undefined
      ? failed("Error: cannot connect to Podman")
      : answered(`${state.podmanServiceRemote}\n`);
  if (verb === "info")
    return answered(`${JSON.stringify(state.securityOptions)}\n`);
  if (verb === "context")
    return state.contextHost === undefined
      ? failed('context "default": context not found')
      : answered(`${state.contextHost}\n`);
  if (verb === "run") return run(state, call);
  if (verb === "ps") {
    const wanted = labelFilters(call.argv);
    return answered(
      [...state.containers.values()]
        .filter(
          (container) =>
            wanted.every(([key, value]) => container.labels[key] === value) &&
            ancestorsMatched(state, container, call.argv),
        )
        .map((container) => `${container.id}\n`)
        .join(""),
    );
  }
  if (verb === "container") return inspected(state, call.argv.slice(2));
  if (verb === "kill") return killed(state, last);
  if (verb === "rm") {
    const removed = changed(state, last, (container) => {
      state.containers.delete(container.name);
    });
    return call.argv.includes("--force") ? { ...removed, code: 0 } : removed;
  }
  if (verb === "network") return networked(state, last, second);
  if (verb === "volume") return volumed(state, call);
  return failed(`unknown command: ${call.argv.join(" ")}`);
}

export function fakeEngine() {
  const state = fakeEngineState();
  /** @type {import("./engine.mjs").Engine} */
  const engine = {
    exec: async (argv, engineCall = {}) => {
      /** @type {FakeCall} */
      const call = {
        argv: [...argv],
        environment: { ...engineCall.environment },
      };
      state.calls.push(call);
      engineCall.signal?.throwIfAborted();
      return Promise.race([answer(state, call), aborted(engineCall.signal)]);
    },
    execTail: async (argv, bytesMax) => {
      state.calls.push({ argv: [...argv], environment: {} });
      const reference = argv.at(-1) ?? "";
      const container = found(state, reference);
      const none = { tail: Buffer.alloc(0), cut: false, lines: 0 };
      if (state.unreachable) return { ...failed(unreachable), ...none };
      if (state.logsFail && state.logsStderr !== undefined)
        return { ...failed(state.logsStderr), ...none };
      if (state.logsFail || container === undefined)
        return { ...missing(reference), ...none };
      return { ...answered(), ...logTail(container, argv, bytesMax) };
    },
  };
  return { engine, state };
}

/**
 * A promise and the hand that settles it, for a pull a suite ends by hand.
 *
 * @template T
 */
export function deferred() {
  /** @type {(value: T) => void} */
  let resolve = () => undefined;
  /** @type {Promise<T>} */
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
