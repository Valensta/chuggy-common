/**
 * A container engine held in memory, answering the runner's argv with the
 * words docker 28 prints. A pull waits on whatever the suite hands it, so a
 * suite decides how long one takes and how it ends, and so does a `run --rm`,
 * which is how chuggy's runtime is copied into a volume.
 */

import { readFileSync, writeSync } from "node:fs";
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
 * @property {string[]} [volumes] each `--volume` it was run with
 * @property {string[]} [command] what it was run with after its image
 * @property {string} [entrypoint]
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
    images: new Set(),
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
 * @param {FakeEngineState} state
 * @param {FakeCall} call
 */
function run(state, call) {
  const { argv } = call;
  const { image, command } = runImage(argv);
  if (argv.includes("--rm"))
    return state.images.has(image)
      ? state.fill(
          image,
          namedVolumes(flagValues(argv, "--volume"), true),
          call,
        )
      : failed(
          `docker: Error response from daemon: No such image: ${image}`,
          125,
        );
  const [name] = flagValues(argv, "--name");
  call.envFile = readFileSync(flagValues(argv, "--env-file")[0], "utf8");
  const existing = state.containers.get(name);
  if (existing !== undefined)
    return failed(
      `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${existing.id}". You have to remove (or rename) that container to be able to reuse that name.`,
      125,
    );
  const labels = Object.fromEntries(
    flagValues(argv, "--label").map((label) => {
      const equals = label.indexOf("=");
      return [label.slice(0, equals), label.slice(equals + 1)];
    }),
  );
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
            State: { Status: container.status, ExitCode: container.exitCode },
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
 * `volume create`, which answers a name already made as made, and `volume rm`,
 * which refuses one a container mounts.
 *
 * @param {FakeEngineState} state
 * @param {FakeCall} call
 */
function volumed(state, call) {
  const { argv } = call;
  const name = argv.at(-1) ?? "";
  if (argv[1] === "create") {
    if (!state.volumes.has(name))
      state.volumes.set(name, {
        labels: Object.fromEntries(
          flagValues(argv, "--label").map((label) => label.split("=")),
        ),
      });
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
  if (verb === "image")
    return state.images.has(last)
      ? answered("sha256:1\n")
      : failed(`Error response from daemon: No such image: ${last}`);
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
    const wanted = flagValues(call.argv, "--filter").map((filter) => {
      const [key, ...value] = filter.replace(/^label=/u, "").split("=");
      return [key, value.join("=")];
    });
    return answered(
      [...state.containers.values()]
        .filter((container) =>
          wanted.every(([key, value]) => container.labels[key] === value),
        )
        .map((container) => `${container.id}\n`)
        .join(""),
    );
  }
  if (verb === "container") return inspected(state, call.argv.slice(2));
  if (verb === "kill") return killed(state, last);
  if (verb === "rm")
    return changed(state, last, (container) => {
      state.containers.delete(container.name);
    });
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
    execToFd: async (argv, fd) => {
      state.calls.push({ argv: [...argv], environment: {} });
      const reference = argv.at(-1) ?? "";
      const container = found(state, reference);
      if (state.unreachable) return failed(unreachable);
      if (state.logsFail || container === undefined) return missing(reference);
      writeSync(fd, `the log of ${container.name}\n`);
      return answered();
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
