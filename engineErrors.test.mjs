/**
 * Every stderr in `printed`, and each a pull test lists as refused, is what
 * docker 28.1, docker 29.1 on Windows or podman 5.8 printed for the failure it
 * is filed under, copied from a run of each against a daemon, and a local
 * registry that challenged for credentials. The rest are built on what those engines print, and crun's
 * on the formats of its own source.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  engineCommandUnstarted,
  engineFailure,
  engineFailureLine,
  enginePullRefused,
} from "./engineErrors.mjs";

const digest = `sha256:${"0".repeat(64)}`;

const printed = {
  Unreachable: [
    "Cannot connect to the Docker daemon at unix:///nonexistent/docker.sock. Is the docker daemon running?",
    'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.49/containers/json": dial unix /var/run/docker.sock: connect: permission denied',
    "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
    'Cannot connect to Podman. Please verify your connection to the Linux system using `podman system connection list`, or try `podman machine init` and `podman machine start` to manage a new Linux VM\nError: unable to connect to Podman socket: Get "http://d/v5.8.7/libpod/_ping": dial unix /nonexistent/podman.sock: connect: no such file or directory: unix:///nonexistent/podman.sock',
  ],
  NoSuchContainer: [
    "Error response from daemon: No such container: chuggy-linux-probe-absent",
    "Error response from daemon: cannot kill container: chuggy-linux-probe-absent: No such container: chuggy-linux-probe-absent",
    'Error: no such container "chuggy-linux-probe-absent"',
    'Error: no container with ID or name "chuggy-linux-probe-absent" found: no such container',
    'Error: no container with name or ID "chuggy-linux-probe-absent" found: no such container',
  ],
  NoSuchVolume: [
    "Error response from daemon: get chuggy-linux-probe-absent: no such volume",
  ],
  NameConflict: [
    'docker: Error response from daemon: Conflict. The container name "/chuggy-linux-probe-conflict" is already in use by container "fe97585ba1aa2ae3c309f0851f48ff35ac3ca7f3e3d17bcb7c504e2ae5691c31". You have to remove (or rename) that container to be able to reuse that name.\n\nRun \'docker run --help\' for more information',
    'Error: creating container storage: the container name "chuggy-linux-probe-conflict" is already in use by ab5a3a462f4584914e637e786a3d38444bb903d3a94af0c392460ecfa3a8f330. You have to remove that container to be able to reuse that name: that name is already in use, or use --replace to instruct Podman to do so.',
  ],
  Unauthorized: [
    "Error response from daemon: unauthorized: unauthorized",
    `Error response from daemon: Get "http://localhost:5999/v2/chuggy/worker/manifests/${digest}": no basic auth credentials`,
    `Trying to pull localhost:5999/chuggy/worker@${digest}...\nError: unable to copy from source docker://localhost:5999/chuggy/worker@${digest}: initializing source docker://localhost:5999/chuggy/worker@${digest}: reading manifest ${digest} in localhost:5999/chuggy/worker: authentication required`,
  ],
  NotFound: [
    "Error response from daemon: No such image: chuggy-linux-probe-absent:1",
    "Error: chuggy-linux-probe-absent:1: image not known",
    "Error response from daemon: manifest for busybox:chuggy-linux-probe-absent not found: manifest unknown: manifest unknown",
    "Trying to pull docker.io/library/busybox:chuggy-linux-probe-absent...\nError: unable to copy from source docker://busybox:chuggy-linux-probe-absent: initializing source docker://busybox:chuggy-linux-probe-absent: reading manifest chuggy-linux-probe-absent in docker.io/library/busybox: manifest unknown",
    "Error response from daemon: network chuggy-linux-probe-absent not found",
    "Error: network chuggy-linux-probe-absent: unable to find network with name or ID chuggy-linux-probe-absent: network not found",
    `docker: Error response from daemon: No such image: chuggy.invalid/absent@${digest}\n\nRun 'docker run --help' for more information`,
  ],
  Other: [
    `Error response from daemon: Get "https://ghcr.io/v2/kasofsk/chuggy-linux-probe-absent/manifests/${digest}": denied: denied`,
  ],
};

for (const [failure, stderrs] of Object.entries(printed))
  test(`what the engines print for ${failure} is read as ${failure}`, () => {
    for (const stderr of stderrs)
      assert.equal(
        engineFailure({ code: 1, stdout: "", stderr: `${stderr}\n` }),
        failure,
        stderr,
      );
  });

test("an engine that did not start or did not answer is unreachable whatever it printed", () => {
  for (const failed of /** @type {const} */ (["Unstarted", "Interrupted"]))
    assert.equal(
      engineFailure({
        code: -1,
        stdout: "",
        stderr: "No such container: x",
        failed,
      }),
      "Unreachable",
    );
});

test("the line logged is the first naming an error, bounded", () => {
  const podman = printed.Unauthorized[2];
  assert.match(
    engineFailureLine({ code: 125, stdout: "", stderr: podman }),
    /^Error: unable to copy from source /u,
  );
  const long = engineFailureLine({ code: 125, stdout: "", stderr: podman });
  assert.ok(long.length <= 301 && long.endsWith("…"), long);
  assert.equal(
    engineFailureLine({ code: 1, stdout: "", stderr: "\n  quiet failure  \n" }),
    "quiet failure",
  );
  assert.equal(
    engineFailureLine({ code: 7, stdout: "", stderr: "" }),
    "exit 7",
  );
});

/** A failed pull's answer, as the engine gives it. */
const pullAnswer = (/** @type {string} */ stderr) => ({
  code: 1,
  stdout: "",
  stderr: `${stderr}\n`,
});

test("a pull the registry refused the image to, or whose reference names none, is refused for good, and one that can pass is not", () => {
  const refused = [
    ...printed.Unauthorized,
    "Error response from daemon: manifest for busybox:chuggy-c6-probe-absent not found: manifest unknown: manifest unknown",
    printed.NotFound[3],
    "Error response from daemon: pull access denied for kasofsk/chuggy-c6-probe-absent, repository does not exist or may require 'docker login': denied: requested access to the resource is denied",
    ...printed.Other,
    "invalid reference format: repository name (Case) must be lowercase",
  ];
  const passing = [
    'Error response from daemon: Get "https://nosuch.invalid/v2/": dial tcp: lookup nosuch.invalid on 127.0.0.53:53: no such host',
    'Error response from daemon: Get "http://localhost:5999/v2/": dial tcp 127.0.0.1:5999: connect: connection refused',
    'Error response from daemon: Get "https://denied.example/v2/": dial tcp: lookup denied.example on 127.0.0.53:53: no such host',
    'Error response from daemon: Get "https://registry.forbidden/v2/": dial tcp: lookup registry.forbidden on 127.0.0.53:53: no such host',
    'Error response from daemon: Get "https://registry.example/v2/forbidden/manifests/1": net/http: TLS handshake timeout',
  ];
  for (const stderr of refused)
    assert.ok(enginePullRefused(pullAnswer(stderr)), stderr);
  for (const stderr of [...passing, ...printed.Unreachable])
    assert.ok(!enginePullRefused(pullAnswer(stderr)), stderr);
  assert.ok(
    !enginePullRefused({
      ...pullAnswer(printed.Unauthorized[0]),
      code: -1,
      failed: "Interrupted",
    }),
  );
});

for (const [cause, stderr] of [
  [
    "a file the engine's user may not open",
    `Error: copying system image from manifest list: writing blob: adding layer with blob "${digest}": creating read-only layer: mkdir /home/chuggy/.local/share/containers/storage/overlay/l: permission denied`,
  ],
  [
    "a credential helper its PATH lacks",
    'error getting credentials - err: exec: "docker-credential-secretservice": executable file not found in $PATH, out: ``',
  ],
])
  test(`a pull that failed on ${cause} is not refused, though its words hold a refusal's`, () => {
    assert.ok(!enginePullRefused(pullAnswer(stderr)), stderr);
  });

test("a run whose command could not be started is read so only where the engine names that command", () => {
  const runc = (/** @type {string} */ cause) =>
    `docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: ${cause}: unknown`;
  const crun = (/** @type {string} */ cause) =>
    `Error: crun: ${cause}: OCI runtime attempted to invoke a command that was not found`;
  /** @type {[number, string][]} */
  const unstarted = [
    [127, runc('exec: "/bin/sh": stat /bin/sh: no such file or directory')],
    [126, runc('exec: "/bin/sh": permission denied')],
    [127, crun("executable file `/bin/sh` not found")],
    [126, crun("the path `/bin/sh` exists but it is not executable")],
  ];
  /** @type {[number, string][]} */
  const otherwise = [
    [
      127,
      runc(
        'error mounting "/opt/chuggy" to rootfs at "/opt/chuggy": no such file or directory',
      ),
    ],
    [127, runc('exec: "/bin/bash": stat /bin/bash: no such file or directory')],
    [126, crun("executable file `/bin/shell` not found")],
    [125, runc('exec: "/bin/sh": stat /bin/sh: no such file or directory')],
    [1, crun("executable file `/bin/sh` not found")],
  ];
  for (const [code, stderr] of unstarted)
    assert.ok(
      engineCommandUnstarted({ code, stdout: "", stderr }, "/bin/sh"),
      stderr,
    );
  for (const [code, stderr] of otherwise)
    assert.ok(
      !engineCommandUnstarted({ code, stdout: "", stderr }, "/bin/sh"),
      `${String(code)} ${stderr}`,
    );
});
