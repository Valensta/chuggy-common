/**
 * A real checkout and the bare remote its attempt pushes to, for the suites
 * whose question is git's answer rather than a stub's.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

export const git = promisify(execFile);
export const author = [
  "-c",
  "user.email=suite@chuggy.invalid",
  "-c",
  "user.name=s",
];

/** A checkout with a commit already in it, and the bare remote its attempt pushes to. */
async function checkoutWithRemote(root) {
  const remote = join(root, "remote.git");
  const directory = join(root, "checkout");
  await git("git", ["init", "--bare", remote]);
  await git("git", ["init", directory]);
  await writeFile(join(directory, "README.md"), "# what the ticket found\n");
  await git("git", ["add", "README.md"], { cwd: directory });
  await git("git", [...author, "commit", "-m", "before"], { cwd: directory });
  return { remote, directory, base: await headOf(directory) };
}

/** `body` run against a fresh checkout and its remote, both removed after. */
export async function inCheckout(body) {
  const root = await mkdtemp(join(tmpdir(), "chuggy-source-"));
  try {
    await body(await checkoutWithRemote(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Every ref a remote holds, which is none where nothing reached it. */
export async function remoteRefs(remote) {
  const { stdout } = await git("git", ["for-each-ref"], { cwd: remote });
  return stdout;
}

export async function headOf(directory) {
  const { stdout } = await git("git", ["rev-parse", "HEAD"], {
    cwd: directory,
  });
  return stdout.trim();
}

/**
 * What a record of one program's environment names: the image's value of a
 * variable `check.sh` moves aside, the name `check.sh` keeps that value under,
 * and the task document.
 */
const recordedNames = ["NODE_PATH", "CHUG_IMAGE_NODE_PATH", "CHUG_WORKER_TASK"];

/** What a pod whose image set `NODE_PATH` holds once `check.sh` has run. */
const podHolding = {
  CHUG_IMAGE_NODE_PATH: "/the/image/node_modules",
  CHUG_WORKER_TASK: "the task document",
};

/** A record's names as the image's own programs are handed them. */
export const handedAsTheImage = ["/the/image/node_modules", "unset", "unset"];

/** A shell line appending `label` and the value of each recorded name to `log`. */
function recordsHanded(label, log) {
  const fields = recordedNames.map((name) => `"\${${name}-unset}"`).join(" ");
  return `printf '%s\\t%s\\t%s\\t%s\\n' ${label} ${fields} >> '${log}'`;
}

/**
 * A `git` that records what it was handed and then runs git itself, and
 * `hooks`, a hooks directory whose pre-commit and pre-push record the same.
 * `start` leaves the pod as a job's `check.sh` does where its image set
 * `NODE_PATH`, with that `git` first on its path, until `t` ends; `records` is
 * each record so far, a label and the values `handedAsTheImage` names.
 */
export async function recordingGit(t) {
  const root = await mkdtemp(join(tmpdir(), "chuggy-recording-git-"));
  const log = join(root, "handed");
  const { stdout: execPath } = await git("git", ["--exec-path"]);
  const bin = join(root, "bin");
  const hooks = join(root, "hooks");
  await Promise.all([mkdir(bin), mkdir(hooks)]);
  await writeFile(
    join(bin, "git"),
    [
      "#!/bin/sh",
      'verb=$1; [ "$verb" = --no-replace-objects ] && verb=$2',
      recordsHanded('"git $verb"', log),
      `exec '${join(execPath.trim(), "git")}' "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  for (const hook of ["pre-commit", "pre-push"])
    await writeFile(
      join(hooks, hook),
      ["#!/bin/sh", recordsHanded(hook, log), ""].join("\n"),
      { mode: 0o755 },
    );
  const held = { ...podHolding, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const saved = Object.fromEntries(
    [...Object.keys(held), "NODE_PATH"].map((name) => [
      name,
      process.env[name],
    ]),
  );
  t.after(async () => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await rm(root, { recursive: true, force: true });
  });
  return {
    hooks,
    start: () => {
      Object.assign(process.env, held);
      delete process.env.NODE_PATH;
    },
    records: async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => line.split("\t")),
  };
}
