import assert from "node:assert/strict";
import test from "node:test";

import {
  dockerContextArgv,
  dockerInfoArgv,
  forcedRemoveArgv,
  imageInspectArgv,
  ownerVolumeCreateArgv,
  ownerVolumesOpenArgv,
  podmanRemoteArgv,
  podmanSocketArgv,
  podmanVersionArgv,
  poolPullArgv,
  inspectArgv,
  killArgv,
  listArgv,
  logsArgv,
  networkCreateArgv,
  networkInspectArgv,
  pullArgv,
  removeArgv,
  runArgv,
  runtimeFillArgv,
  runtimeVolumeCreateArgv,
  volumeInspectArgv,
  volumeListArgv,
  volumeRemoveArgv,
  workloadMountTargets,
} from "./engineArgv.mjs";

const image = `registry.chuggy.example/worker@sha256:${"a".repeat(64)}`;

const job = {
  name: "chuggy-shame-0123456789abcdef0123",
  pool: "vteng/chuggy/shame",
  assignment: "asg-1",
  kind: /** @type {const} */ ("Job"),
  deadlineEpochSecs: 1_800_003_600,
  envFile: "/run/user/1000/chuggy-runner/job-x/env",
  cpuMillis: 1500,
  memoryMib: 4096,
  tokenFile: "/home/op/.config/chuggy-runner/claude-token",
  network: "chuggy-jobs",
  image,
};

/** Everything before the user mapping, the same for both engines. */
const runHead = [
  "run",
  "-d",
  "--pull=never",
  "--name",
  "chuggy-shame-0123456789abcdef0123",
  "--label",
  "io.chuggy.pool=vteng/chuggy/shame",
  "--label",
  "io.chuggy.assignment=asg-1",
  "--label",
  "io.chuggy.kind=Job",
  "--label",
  "io.chuggy.deadline=1800003600",
  "--env-file",
  "/run/user/1000/chuggy-runner/job-x/env",
  "--user",
  "1000:1000",
];

/** Everything after it, up to the minted tmpfs. */
const runLimits = [
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "4096",
  "--cpus",
  "1.5",
  "--memory",
  "4096m",
  "--mount",
  "type=bind,source=/home/op/.config/chuggy-runner/claude-token,target=/var/run/chuggy/credentials/claude-code,readonly",
  "--tmpfs",
];

/** Everything after the minted tmpfs. */
const runTail = ["--volume", "/workspace", "--network", "chuggy-jobs", image];

test("docker runs a job as the image's user, with nothing mapped", () => {
  assert.deepEqual(runArgv("docker", job), [
    ...runHead,
    ...runLimits,
    "/var/run/chuggy/minted:rw,nosuid,nodev,noexec,size=1m,uid=1000,gid=1000,mode=0700",
    ...runTail,
  ]);
});

test("podman runs a job as the image's user, mapped onto the one running podman", () => {
  assert.deepEqual(runArgv("podman", job), [
    ...runHead,
    "--userns=keep-id:uid=1000,gid=1000",
    ...runLimits,
    "/var/run/chuggy/minted:rw,nosuid,nodev,noexec,size=1m,mode=0700,U",
    ...runTail,
  ]);
});

/**
 * Checks that a job handed this machine's engine through `socket` is run as
 * one handed none, and as one whose `engineSocket` is unset, with the socket
 * mounted read-only after the token file's mount and then `group`.
 *
 * @param {import("./engineArgv.mjs").EngineName} engine
 * @param {import("./engineArgv.mjs").EngineSocket} socket
 * @param {string[]} group
 */
function assertHandedEngineSocket(engine, socket, group) {
  const plain = runArgv(engine, job);
  assert.deepEqual(runArgv(engine, { ...job, engineSocket: undefined }), plain);
  const tmpfs = plain.indexOf("--tmpfs");
  assert.deepEqual(runArgv(engine, { ...job, engineSocket: socket }), [
    ...plain.slice(0, tmpfs),
    "--mount",
    `type=bind,source=${socket.path},target=/var/run/docker.sock,readonly`,
    ...group,
    ...plain.slice(tmpfs),
  ]);
}

test("docker mounts a job's engine socket read-only where docker's clients look, and adds the job to the socket's group", () => {
  assertHandedEngineSocket(
    "docker",
    { path: "/var/run/docker.sock", gid: 125 },
    ["--group-add", "125"],
  );
});

test("docker adds a job to no group for a socket of root's group", () => {
  assertHandedEngineSocket(
    "docker",
    { path: "/var/run/docker.sock", gid: 0 },
    [],
  );
});

test("docker adds a job to root's group for a socket its runner says is reached only through it, as Docker Desktop's is", () => {
  assertHandedEngineSocket(
    "docker",
    { path: "/var/run/docker.sock", gid: 0, rootGroup: true },
    ["--group-add", "0"],
  );
});

test("podman mounts a job's engine socket read-only where docker's clients look, and adds the job to no group, since keep-id makes the job's user the socket's owner", () => {
  assertHandedEngineSocket(
    "podman",
    { path: "/run/user/1000/podman/podman.sock", gid: 1000 },
    [],
  );
});

const ownerVolumes = [
  { source: "/srv/chuggy-cache", target: "/cache/shared", readonly: true },
  { source: "cargo", target: "/cache/cargo", readonly: false },
  { source: "npm-cache", target: "/cache/npm", readonly: true },
  { source: "/srv/scratch", target: "/cache/scratch", readonly: false },
];

test("a job mounts its owner's directories bound and named volumes uncopied, read-only where marked, after the engine's socket, on either engine", () => {
  for (const engine of /** @type {const} */ (["docker", "podman"])) {
    const socket = { path: "/var/run/docker.sock", gid: 0 };
    const plain = runArgv(engine, { ...job, engineSocket: socket });
    assert.deepEqual(
      runArgv(engine, { ...job, engineSocket: socket, volumes: [] }),
      plain,
    );
    const tmpfs = plain.indexOf("--tmpfs");
    assert.deepEqual(
      runArgv(engine, { ...job, engineSocket: socket, volumes: ownerVolumes }),
      [
        ...plain.slice(0, tmpfs),
        "--mount",
        "type=bind,source=/srv/chuggy-cache,target=/cache/shared,readonly",
        "--volume",
        "cargo:/cache/cargo:nocopy",
        "--volume",
        "npm-cache:/cache/npm:ro,nocopy",
        "--mount",
        "type=bind,source=/srv/scratch,target=/cache/scratch",
        ...plain.slice(tmpfs),
      ],
    );
  }
});

/**
 * Where each mount of an argv is in the container: a `--mount`'s target, a
 * `--volume`'s path, and a `--tmpfs`'s.
 *
 * @param {string[]} argv
 */
function mountTargets(argv) {
  return argv.flatMap((value, index) => {
    const flag = argv[index - 1];
    if (flag === "--mount")
      return value
        .split(",")
        .flatMap((field) =>
          field.startsWith("target=") ? [field.slice("target=".length)] : [],
        );
    if (flag === "--volume")
      return [value.startsWith("/") ? value : value.split(":")[1]];
    if (flag === "--tmpfs") return [value.split(":")[0]];
    return [];
  });
}

test("every path a workload's container mounts, given all it can be, is among the targets runArgv names as its own", () => {
  for (const engine of /** @type {const} */ (["docker", "podman"])) {
    const targets = mountTargets(
      runArgv(engine, {
        ...job,
        runtime: volumes,
        engineSocket: { path: "/var/run/docker.sock", gid: 125 },
      }),
    );
    assert.deepEqual([...targets].sort(), [...workloadMountTargets].sort());
  }
});

test("an owner's volume is made labelled as one, and podman is told the owner to give it, so that no mount gives it another while it is empty", () => {
  assert.deepEqual(ownerVolumeCreateArgv("docker", "cargo"), [
    "volume",
    "create",
    "--label",
    "io.chuggy.owner-volume",
    "cargo",
  ]);
  assert.deepEqual(ownerVolumeCreateArgv("podman", "cargo"), [
    "volume",
    "create",
    "--label",
    "io.chuggy.owner-volume",
    "--opt",
    "o=uid=0,gid=0",
    "cargo",
  ]);
});

test("owner volumes are opened to the job's user by the runtime image's own node, as root holding only the capability chown takes, each mounted uncopied under chuggy's run directory, in the job's user namespace on podman", () => {
  /** @type {[import("./engineArgv.mjs").EngineName, string[]][]} */
  const userns = [
    ["docker", []],
    ["podman", ["--userns=keep-id:uid=1000,gid=1000"]],
  ];
  for (const [engine, mapped] of userns)
    assert.deepEqual(
      ownerVolumesOpenArgv(engine, ["cargo", "npm-cache"], runtime),
      [
        "run",
        "--rm",
        "--pull=never",
        "--user",
        "0:0",
        ...mapped,
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--security-opt",
        "no-new-privileges",
        "--network",
        "none",
        "--volume",
        "cargo:/var/run/chuggy/volumes/cargo:nocopy",
        "--volume",
        "npm-cache:/var/run/chuggy/volumes/npm-cache:nocopy",
        "--entrypoint",
        "/opt/chuggy/bin/node",
        runtime,
        "--eval",
        'for (const path of process.argv.slice(1)) require("node:fs").chownSync(path, 1000, 1000)',
        "/var/run/chuggy/volumes/cargo",
        "/var/run/chuggy/volumes/npm-cache",
      ],
    );
});

const runtime = `registry.chuggy.example/runtime@sha256:${"b".repeat(64)}`;
const volumes = {
  volume: "chuggy-shame-0123456789abcdef0123-0a1b2c3d-runtime",
  workspace: "chuggy-shame-0123456789abcdef0123-0a1b2c3d-workspace",
  fill: "chuggy-shame-0123456789abcdef0123-0a1b2c3d-fill",
};

test("a job given runtime volumes is labelled with them, mounts each uncopied, the runtime read-only, and starts the runtime's check through the image's shell; podman's workspace is chowned to the job's user", () => {
  /** @type {[import("./engineArgv.mjs").EngineName, string][]} */
  const workspaces = [
    ["docker", "nocopy"],
    ["podman", "nocopy,U"],
  ];
  for (const [engine, options] of workspaces) {
    const plain = runArgv(engine, job);
    const through = runArgv(engine, { ...job, runtime: volumes });
    const labels = plain.indexOf("--env-file");
    const workspace = plain.indexOf("/workspace");
    assert.deepEqual(through, [
      ...plain.slice(0, labels),
      "--label",
      `io.chuggy.runtime=${volumes.volume}`,
      "--label",
      `io.chuggy.workspace=${volumes.workspace}`,
      ...plain.slice(labels, workspace),
      `${volumes.workspace}:/workspace:${options}`,
      "--volume",
      `${volumes.volume}:/opt/chuggy:ro,nocopy`,
      "--entrypoint",
      "/bin/sh",
      ...plain.slice(workspace + 1),
      "/opt/chuggy/check.sh",
    ]);
  }
});

test("a runtime volume is made labelled by its pool, assignment and fill, filled by that named container with the runtime image's own copy, whose node opens the workspace as a root holding nothing, and removed by name", () => {
  assert.deepEqual(
    runtimeVolumeCreateArgv(
      volumes.volume,
      "vteng/chuggy/shame",
      "asg-1",
      volumes.fill,
    ),
    [
      "volume",
      "create",
      "--label",
      "io.chuggy.pool=vteng/chuggy/shame",
      "--label",
      "io.chuggy.assignment=asg-1",
      "--label",
      `io.chuggy.fill=${volumes.fill}`,
      volumes.volume,
    ],
  );
  assert.deepEqual(runtimeFillArgv(volumes, runtime), [
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
    `${volumes.volume}:/opt/chuggy`,
    "--volume",
    `${volumes.workspace}:/workspace:nocopy`,
    "--entrypoint",
    "/opt/chuggy/bin/node",
    runtime,
    "--eval",
    'require("node:fs").chmodSync(process.argv[1], 0o777)',
    "/workspace",
  ]);
  assert.deepEqual(volumeRemoveArgv(volumes.volume), [
    "volume",
    "rm",
    volumes.volume,
  ]);
});

test("a pool's volumes are listed by its label and inspected by name, and a fill is removed running or not", () => {
  assert.deepEqual(volumeListArgv("vteng/chuggy/shame"), [
    "volume",
    "ls",
    "--quiet",
    "--filter",
    "label=io.chuggy.pool=vteng/chuggy/shame",
  ]);
  assert.deepEqual(volumeInspectArgv([volumes.volume, volumes.workspace]), [
    "volume",
    "inspect",
    volumes.volume,
    volumes.workspace,
  ]);
  assert.deepEqual(forcedRemoveArgv(volumes.fill), [
    "rm",
    "--force",
    volumes.fill,
  ]);
});

test("each engine is told the minted tmpfs's owner in the words it accepts, and never the other's", () => {
  /** @param {"docker" | "podman"} engine */
  const options = (engine) => {
    const argv = runArgv(engine, job);
    return argv[argv.indexOf("--tmpfs") + 1].split(":")[1].split(",");
  };
  assert.ok(options("docker").includes("uid=1000"));
  assert.ok(options("docker").includes("gid=1000"));
  assert.ok(!options("docker").includes("U"));
  assert.ok(options("podman").includes("U"));
  assert.ok(!options("podman").some((option) => /^[ug]id=/u.test(option)));
});

test("a pull of the pool's registry reads its credential from DOCKER_CONFIG, told docker's endpoint, or from podman's --authfile, and any other pull is the engine's own", () => {
  assert.deepEqual(
    poolPullArgv(
      "docker",
      image,
      "/run/user/1000/chuggy-runner/pull-x",
      "unix:///run/user/1000/docker.sock",
    ),
    {
      argv: ["pull", "--quiet", image],
      environment: {
        DOCKER_CONFIG: "/run/user/1000/chuggy-runner/pull-x",
        DOCKER_HOST: "unix:///run/user/1000/docker.sock",
        DOCKER_AUTH_CONFIG: "",
      },
    },
  );
  assert.throws(
    () => poolPullArgv("docker", image, "/run/user/1000/chuggy-runner/pull-x"),
    /a docker pull under the pool's token needs the endpoint its context names/u,
  );
  assert.deepEqual(
    poolPullArgv("podman", image, "/run/user/1000/chuggy-runner/pull-x"),
    {
      argv: [
        "pull",
        "--quiet",
        "--authfile",
        "/run/user/1000/chuggy-runner/pull-x/config.json",
        image,
      ],
      environment: {},
    },
  );
  assert.deepEqual(pullArgv("ghcr.io/someone/private:1"), [
    "pull",
    "--quiet",
    "ghcr.io/someone/private:1",
  ]);
});

test("every other call is handed to either engine as this argv", () => {
  assert.deepEqual(
    [
      imageInspectArgv(image),
      listArgv("vteng/chuggy/shame"),
      listArgv("vteng/chuggy/shame", "asg-1"),
      inspectArgv(["c1", "c2"]),
      killArgv("c1"),
      logsArgv("c1"),
      removeArgv("c1"),
      networkInspectArgv("chuggy-jobs"),
      networkCreateArgv("chuggy-jobs"),
      dockerInfoArgv(),
      dockerContextArgv(),
      podmanVersionArgv(),
      podmanRemoteArgv(),
      podmanSocketArgv(),
    ],
    [
      ["image", "inspect", "--format", "{{.Id}}", image],
      [
        "ps",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        "label=io.chuggy.pool=vteng/chuggy/shame",
      ],
      [
        "ps",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        "label=io.chuggy.pool=vteng/chuggy/shame",
        "--filter",
        "label=io.chuggy.assignment=asg-1",
      ],
      ["container", "inspect", "c1", "c2"],
      ["kill", "c1"],
      ["logs", "c1"],
      ["rm", "-v", "c1"],
      ["network", "inspect", "chuggy-jobs"],
      ["network", "create", "chuggy-jobs"],
      ["info", "--format", "{{json .SecurityOptions}}"],
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      ["version", "--format", "{{.Client.Version}}"],
      ["info", "--format", "{{.Host.ServiceIsRemote}}"],
      [
        "info",
        "--format",
        "{{.Host.RemoteSocket.Path}} {{.Host.RemoteSocket.Exists}}",
      ],
    ],
  );
});
