import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { resultManifestSchemaVersion } from "@chuggy/worker-contract/workerDocuments";

import { workerStageEnvironment } from "./checks.mjs";

/** Longer than any header `git cat-file --batch` writes: a name, a type and a size. */
const sourceObjectHeaderBytesMax = 256;

/** How much of a git child's standard error a failed secret check reports. */
const sourceCheckStderrCharsMax = 4_096;

/** Where in a commit each kind of object holds what it carries. */
const sourceObjectPlaces = new Map([
  ["commit", "its message"],
  ["tree", "a path"],
  ["blob", "a file"],
]);

export function ticketBranch(task) {
  const attempt = createHash("sha256").update(task.attempt).digest("hex");
  return `refs/heads/chuggy/tickets/${String(task.ticket)}/attempts/${attempt}`;
}

export function resultDocument(manifest) {
  return { version: resultManifestSchemaVersion, ...manifest };
}

/** One `git cat-file --batch` header, or a refusal where git could not read the object. */
function sourceObjectHeader(line) {
  const [name, type, size] = line.split(" ");
  const bytes = Number(size);
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error(`git could not read ${name} to check the push for secrets`);
  return { name, type, remaining: bytes, tail: Buffer.alloc(0) };
}

/**
 * A reader over `git cat-file --batch` output, fed its chunks in order, that
 * answers the first held secret an object carries: its kind, the commit that
 * first reaches the object, and where in that commit it sits. Objects arrive
 * in commit order, each commit before the trees and blobs it is the first to
 * reference. Each chunk is searched with the tail of the object's previous
 * one, so a secret split between two chunks is still found.
 */
export function sourceSecretReader(secrets) {
  const needles = secrets.map(({ kind, value }) => {
    if (typeof value !== "string" || value.length === 0)
      throw new Error(`${kind} is no value a push can be checked for`);
    return { kind, bytes: Buffer.from(value, "utf8") };
  });
  const tailBytes = Math.max(
    0,
    ...needles.map(({ bytes }) => bytes.length - 1),
  );
  let pending = Buffer.alloc(0);
  let object;
  let commit;
  return {
    read(chunk) {
      let rest = chunk;
      while (rest.length > 0) {
        if (object === undefined) {
          const end = rest.indexOf(0x0a);
          const header = Buffer.concat([
            pending,
            end === -1 ? rest : rest.subarray(0, end),
          ]);
          if (header.length > sourceObjectHeaderBytesMax)
            throw new Error("git cat-file wrote a header no object has");
          if (end === -1) {
            pending = header;
            return undefined;
          }
          pending = Buffer.alloc(0);
          rest = rest.subarray(end + 1);
          object = sourceObjectHeader(header.toString("latin1"));
          if (object.type === "commit") commit = object.name;
        } else if (object.remaining > 0) {
          const taken = rest.subarray(0, object.remaining);
          rest = rest.subarray(taken.length);
          object.remaining -= taken.length;
          const window = Buffer.concat([object.tail, taken]);
          const found = needles.find(({ bytes }) => window.includes(bytes));
          if (found !== undefined)
            return {
              kind: found.kind,
              commit,
              place: sourceObjectPlaces.get(object.type) ?? object.type,
            };
          object.tail = window.subarray(
            window.length - Math.min(tailBytes, window.length),
          );
        } else {
          if (rest[0] !== 0x0a)
            throw new Error("git cat-file wrote an object past its size");
          rest = rest.subarray(1);
          object = undefined;
        }
      }
      return undefined;
    },
    end() {
      if (object !== undefined || pending.length > 0)
        throw new Error("git cat-file stopped inside an object");
    },
  };
}

/** How one git child exited, with the head of what it wrote to standard error. */
function sourceGitExited(child) {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => {
    stderr += text.slice(0, sourceCheckStderrCharsMax - stderr.length);
  });
  return new Promise((resolve) => {
    child.once("error", (error) =>
      resolve({ code: null, stderr: error.message }),
    );
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

/**
 * The first held secret any object the push adds carries, or nothing: every
 * object reachable from `head` and not from `base`, which the remote already
 * has, read raw. So a commit's message, a tree's names and a file's bytes are
 * all searched, and a secret one commit adds and a later one removes is still
 * found. Replacement refs are ignored, as the push ignores them, so what is
 * read is what would be sent.
 */
async function sourceSecretCarried(directory, base, head, secrets) {
  const git = (args, input) =>
    spawn("git", ["--no-replace-objects", ...args], {
      cwd: directory,
      env: workerStageEnvironment(process.env),
      stdio: [input, "pipe", "pipe"],
    });
  const listing = git(
    [
      "rev-list",
      "--objects",
      "--no-object-names",
      "--in-commit-order",
      "--reverse",
      head,
      `^${base}`,
    ],
    "ignore",
  );
  const reading = git(["cat-file", "--batch", "--buffer"], "pipe");
  const exited = Promise.all([listing, reading].map(sourceGitExited));
  reading.stdin.on("error", () => undefined);
  listing.stdout.pipe(reading.stdin);
  const reader = sourceSecretReader(secrets);
  let found;
  let whole = false;
  try {
    for await (const chunk of reading.stdout) {
      found = reader.read(chunk);
      if (found !== undefined) break;
    }
    whole = found === undefined;
  } finally {
    if (!whole) for (const child of [listing, reading]) child.kill();
  }
  const [listed, read] = await exited;
  if (found !== undefined) return found;
  for (const [verb, exit] of [
    ["rev-list", listed],
    ["cat-file", read],
  ])
    if (exit.code !== 0)
      throw new Error(
        `git ${verb} exited ${String(exit.code)} checking the push for secrets: ${exit.stderr}`,
      );
  reader.end();
  return undefined;
}

/**
 * The branch one passing work attempt leaves behind.
 *
 * NOTHING HELD IS PUSHED. `secrets` is every `{ kind, value }` the pod scrubs
 * from what it uploads, and a commit carrying one of them is refused before the
 * remote is reached, naming its kind and the commit and never its value. The
 * push names the commit that was checked rather than `HEAD`, so nothing
 * committed after the check is sent. The credential the push then takes is
 * minted after every commit it sends, so none can carry it and it is not
 * looked for.
 *
 * GIT IS THE IMAGE'S. Every call before the push, and every hook a project's
 * setup installed that one of them runs, is handed what the image's own
 * programs are, and the push is handed the credential's environment, which
 * is that and its askpass.
 *
 * THE PUSH ASKS FOR ITS CREDENTIAL AGAIN. `refresh` is present where the plane
 * minted the one the clone used: a minted token expires, an attempt may outlive
 * one, and the push is the last thing it does — so the credential is taken
 * immediately before it rather than carried from the clone. Where the launcher
 * mounted the credential there is nothing to refresh, and the clone's own
 * environment is what pushes.
 */
export async function commitAndPushSource({
  task,
  repositoryId,
  repository,
  base,
  directory,
  command,
  environment,
  refresh,
  secrets,
}) {
  if (!Array.isArray(secrets))
    throw new Error("a push is checked against the secrets the pod holds");
  const local = { cwd: directory, env: workerStageEnvironment(process.env) };
  await command("git", ["config", "user.name", "Chuggy Worker"], local);
  await command(
    "git",
    ["config", "user.email", "worker@chuggy.invalid"],
    local,
  );
  await command("git", ["add", "--all"], local);
  const provisioned = (task.worker?.files ?? []).map((file) => file.path);
  if (provisioned.length > 0) {
    await command("git", ["reset", "--", ...provisioned], local);
  }
  await command(
    "git",
    [
      "commit",
      "--allow-empty",
      "-m",
      `ticket ${String(task.ticket)} attempt ${task.attempt}`,
    ],
    local,
  );
  const { stdout } = await command("git", ["rev-parse", "HEAD"], local);
  const commit = stdout.trim();
  const carried =
    secrets.length === 0
      ? undefined
      : await sourceSecretCarried(directory, base, commit, secrets);
  if (carried !== undefined)
    throw new Error(
      `commit ${carried.commit} carries ${carried.kind} in ${carried.place}, so the attempt pushes nothing`,
    );
  const ref = ticketBranch(task);
  await command("git", ["push", repository, `${commit}:${ref}`], {
    cwd: directory,
    env: refresh === undefined ? environment : await refresh(),
  });
  return { repository: repositoryId, ref, commit, base };
}
