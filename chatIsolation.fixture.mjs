/**
 * What the isolation suite starts in place of the core, as a session's user:
 * it says who it is, leaves a process running in the background, and once the
 * suite writes what to probe into its workspace, tries each and says how each
 * went, the bearer it was handed as its digest, since what it says is
 * scrubbed of the bearer itself. It ends at its channel's end, as a session
 * does, unless the probe asks it not to.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import process from "node:process";

const workspace = process.env["CHUG_WORKER_WORKSPACE"] ?? "";
const channel = new Socket({ fd: 3, readable: true, writable: false });
let envelope = "";
let ignoringStop = false;
channel.on("data", (chunk) => {
  envelope += chunk;
});
channel.on("end", () => {
  if (!ignoringStop) process.exit(0);
  globalThis.setInterval(() => undefined, 1_000);
});

const background = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
background.unref();

/** How `step` went: `ok`, or the code it failed with. */
function went(step) {
  try {
    step();
    return "ok";
  } catch (failure) {
    return failure?.code ?? String(failure?.status ?? failure);
  }
}

const status = readFileSync("/proc/self/status", "utf8");
const limits = readFileSync("/proc/self/limits", "utf8");
process.stdout.write(
  `${JSON.stringify({
    hello: {
      pid: process.pid,
      background: background.pid,
      uid: process.getuid(),
      gid: process.getgid(),
      groups: process.getgroups(),
      capabilities: /^CapEff:\s+(\S+)$/mu.exec(status)?.[1],
      noNewPrivileges: /^NoNewPrivs:\s+(\S+)$/mu.exec(status)?.[1],
      processesMax: /^Max processes\s+(\d+)/mu.exec(limits)?.[1],
      variables: Object.keys(process.env).sort(),
    },
  })}\n`,
);

/** Each probe `targets` names, tried as this session's user. */
function probed(targets) {
  writeFileSync(join(workspace, "made"), "x");
  let tree;
  try {
    tree = execFileSync(
      "git",
      ["-C", join(workspace, "repository"), "log", "-1", "--format=%H"],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim();
  } catch (failure) {
    tree = String(failure?.status);
  }
  return {
    bearer: createHash("sha256")
      .update(JSON.parse(envelope).bearer)
      .digest("hex"),
    tree,
    made: statSync(join(workspace, "made")).mode & 0o777,
    sessions: went(() => readdirSync(targets.sessions)),
    otherWorkspace: went(() => readdirSync(targets.otherWorkspace)),
    otherMinted: went(() => readdirSync(targets.otherMinted)),
    otherSignal: went(() => process.kill(targets.otherPid, 0)),
    mirrorWrite: went(() =>
      writeFileSync(join(targets.mirror, "objects", "planted"), "x"),
    ),
    mirrorConfig: went(() =>
      writeFileSync(join(targets.mirror, "config"), "x", { flag: "a" }),
    ),
    otherMirror: went(() => readdirSync(targets.otherMirror)),
    credential: went(() => readFileSync(targets.credential)),
    ...scattered(targets),
  };
}

/**
 * What `targets` asks to be left behind in the places every user writes,
 * each file under its own directory there too, and System V IPC objects;
 * a deep tree there no other user may enter; and whether what it asks to be
 * looked for is there.
 */
function scattered(targets) {
  const said = {};
  if (targets.scatter !== undefined) {
    for (const path of targets.scatter) {
      writeFileSync(path, "left");
      mkdirSync(`${path}.d`);
      writeFileSync(join(`${path}.d`, "inner"), "left");
    }
    said.scattered = went(() => {
      execFileSync("ipcmk", ["--shmem", "4096"], { stdio: "ignore" });
      execFileSync("ipcmk", ["--queue"], { stdio: "ignore" });
    });
  }
  if (targets.privateTree !== undefined) {
    mkdirSync(targets.privateTree, { mode: 0o700 });
    let deeper = targets.privateTree;
    for (let depth = 0; depth < 64; depth += 1) {
      deeper = join(deeper, "d");
      mkdirSync(deeper);
      writeFileSync(join(deeper, "f"), "x");
    }
  }
  if (targets.seek !== undefined)
    said.found = targets.seek.flatMap((path) =>
      [path, `${path}.d`].filter((each) => existsSync(each)),
    );
  return said;
}

const asked = join(workspace, "probe.json");
const waiting = globalThis.setInterval(() => {
  if (!existsSync(asked)) return;
  globalThis.clearInterval(waiting);
  const targets = JSON.parse(readFileSync(asked, "utf8"));
  ignoringStop = targets.ignoreStop === true;
  process.stdout.write(`${JSON.stringify({ probed: probed(targets) })}\n`);
}, 50);
