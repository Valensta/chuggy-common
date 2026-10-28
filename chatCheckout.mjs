/**
 * The tree a chat supervisor's session reads, made from a mirror the
 * supervisor keeps of each repository rather than cloned whole for each
 * session.
 *
 * A MIRROR IS THE SUPERVISOR'S AND A SESSION ONLY READS IT. Each is a bare
 * repository under `root`, named for its remote's URL, owned by the supervisor
 * and by a group of its own, which may read it and nothing else may; only the
 * supervisor fetches into it, under a credential the plane minted for the
 * attempt the session is, and a session is handed the group of the one mirror
 * its tree borrows from. So a session reads no mirror its project does not
 * bind, and writes none. Git's own shared-repository mode keeps every file a
 * fetch adds readable by that group and by no one else.
 *
 * A SESSION'S TREE IS A SHARED CLONE OF ITS MIRROR, at the remote's own default
 * branch as `./sessionCheckout.mjs`'s is, made by the supervisor and handed to
 * the session's user. Its objects stay in the mirror, read through git's
 * alternates, and its `origin` is the remote rather than the mirror, so a
 * fetch the session makes goes where its own would.
 *
 * WHAT A SESSION IS TOLD IS WHAT `sessionCheckout` TELLS ONE. A site that never
 * gave the session a repository it can reach is a refusal carrying its reason;
 * a mirror or clone that did not finish is no tree, and the session reads the
 * project through the API instead. The resolution and the failure are that
 * module's, reused.
 *
 * Every git call the supervisor makes outside a session's tree runs in the
 * mirrors' directory, so the repository it finds itself in is never the one
 * the supervisor happened to be started in.
 *
 * A MIRROR IS PRUNED ONLY WHEN NOTHING BORROWS FROM IT. A clone's objects that
 * no ref of its mirror still reaches would go with a prune, so `pruned` is for
 * a supervisor that holds no session's tree at all.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, chown, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { jobRepositoryDirectory } from "./job.mjs";
import { planeCredentialUnreachedText } from "./planeCredential.mjs";
import { credentialScrub } from "./runEvidence.mjs";
import {
  sessionCheckoutFailed,
  sessionCheckoutGit,
  sessionCheckoutTimeoutMs,
  sessionRemote,
} from "./sessionCheckout.mjs";

const executeFile = promisify(execFile);

/** Where a supervisor keeps its mirrors, unless it is told otherwise. */
export const chatMirrorsDirectory = "/var/lib/chuggy/mirrors";

/** The first group a mirror is given. */
export const chatMirrorGroupFirst = 30_000;

/** How many groups follow it, which is how many repositories a supervisor mirrors. */
export const chatMirrorGroupCount = 1_024;

/** What the mirrors' directory is made with: entered by anyone, listed by its owner alone. */
const chatMirrorsMode = 0o711;

/** What a mirror is made with: its owner's, read by its group, its group kept by what is made in it. */
const chatMirrorMode = 0o2750;

/** What a mirror's name ends in, and nothing else in the mirrors' directory does. */
const chatMirrorSuffix = ".git";

/** What git makes each file of a mirror with. */
const chatMirrorShared = "0640";

/** The mirror's own name for the remote's default branch, from `ls-remote --symref`. */
const chatMirrorHeadPattern = /^ref: (refs\/heads\/\S+)\tHEAD$/mu;

/**
 * A supervisor's mirrors under `root`, the groups those already there were
 * given read back from them. `owner` is the user each is made for; `own` the
 * seam that hands a path to a user and group, and `run` the one every git
 * call goes through.
 */
export async function chatMirrorsOpened({
  root = chatMirrorsDirectory,
  groupFirst = chatMirrorGroupFirst,
  groupCount = chatMirrorGroupCount,
  owner = 0,
  own = chown,
  run = sessionCheckoutGit,
} = {}) {
  await mkdir(root, { recursive: true, mode: chatMirrorsMode });
  await chmod(root, chatMirrorsMode);
  const groups = new Map();
  for (const name of await readdir(root))
    if (name.endsWith(chatMirrorSuffix))
      groups.set(join(root, name), (await stat(join(root, name))).gid);
  const queues = new Map();
  const mirrors = { root, groupFirst, groupCount, owner, own, run, groups };
  return {
    /**
     * The mirror of `repository`, brought up to its remote under
     * `environment` once every fetch into it asked before has ended; one
     * `signal` cancels stops waiting for them, and the next waits for both.
     */
    updated: (repository, environment, signal) => {
      const path = join(
        root,
        `${chatMirrorName(repository)}${chatMirrorSuffix}`,
      );
      const group = chatMirrorGroup(mirrors, path);
      const before = queues.get(path) ?? Promise.resolve();
      const queued = chatAbortable(signal, before).then(() =>
        chatMirrorFetched(mirrors, { path, group }, repository, {
          env: environment,
          signal,
        }),
      );
      queues.set(path, Promise.allSettled([before, queued]));
      return queued.then(() => ({ path, group }));
    },
    /** Every mirror with what no ref reaches dropped, for a supervisor holding no session's tree. */
    pruned: async () => {
      for (const path of groups.keys())
        await run(["--git-dir", path, "gc", "--prune=now", "--quiet"], {
          cwd: root,
          timeout: sessionCheckoutTimeoutMs,
        });
    },
  };
}

/** A mirror's name: the remote's URL, hashed, so no URL is a path. */
function chatMirrorName(repository) {
  return createHash("sha256").update(repository).digest("hex");
}

/** The group `path` has, or the lowest one no mirror has yet, refused where none is left. */
function chatMirrorGroup(mirrors, path) {
  const had = mirrors.groups.get(path);
  if (had !== undefined) return had;
  const taken = new Set(mirrors.groups.values());
  for (let offset = 0; offset < mirrors.groupCount; offset += 1) {
    const group = mirrors.groupFirst + offset;
    if (!taken.has(group)) {
      mirrors.groups.set(path, group);
      return group;
    }
  }
  throw new Error("every group a mirror may have is taken");
}

/** The mirror at `path` made where it is not, or was left half-made, and fetched from `repository`. */
async function chatMirrorFetched(mirrors, { path, group }, repository, call) {
  const { run, owner, own, root } = mirrors;
  const options = { ...call, cwd: root, timeout: sessionCheckoutTimeoutMs };
  if (!(await chatMirrorMade(path))) {
    await mkdir(path, { recursive: true, mode: chatMirrorMode });
    await own(path, owner, group);
    await chmod(path, chatMirrorMode);
    await run(
      ["init", "--bare", `--shared=${chatMirrorShared}`, path],
      options,
    );
    await run(["--git-dir", path, "config", "gc.auto", "0"], options);
  }
  const { stdout } = await run(
    ["ls-remote", "--symref", repository, "HEAD"],
    options,
  );
  await run(
    [
      "--git-dir",
      path,
      "fetch",
      "--prune",
      "--no-tags",
      repository,
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
    ],
    options,
  );
  const head = chatMirrorHeadPattern.exec(stdout)?.[1];
  if (head !== undefined)
    await run(["--git-dir", path, "symbolic-ref", "HEAD", head], options);
}

/** Whether a mirror's repository is already at `path`. */
async function chatMirrorMade(path) {
  try {
    return (await stat(join(path, "HEAD"))).isFile();
  } catch {
    return false;
  }
}

/**
 * What `pending` settles with, or the reason `signal` gives once it is
 * aborted, whichever is first; `pending` itself is left to settle unread.
 */
export function chatAbortable(signal, pending) {
  if (signal === undefined) return pending;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
}

/**
 * The tree one session reads, made under `workspace` for `user`, a user and
 * group — or nothing, or the refusal, as `sessionCheckout` answers — and the
 * group of the mirror it borrows from, which the session is to be given.
 *
 * `mint` is the plane's answer for the session's repository; `repositories`,
 * `credentialFiles` and `environment` what the site's map resolves it with.
 * `handOver` gives a tree to a user and its group; `signal` cancels, and a
 * checkout it cancels while the plane is asked raises its reason.
 */
export async function chatCheckout(task, bearer, workspace, services) {
  const { mint, mirrors, signal, log, user } = services;
  const { run = sessionCheckoutGit, handOver = chatCheckoutHandedOver } =
    services;
  if (task.repository === undefined) return { checkout: undefined };
  const reference = task.repository.reference;
  const minted = await chatAbortable(signal, mint(reference));
  const scrub = credentialScrub([bearer, minted?.password ?? ""]);
  const remote =
    minted?.unreached === undefined
      ? sessionRemote(
          task,
          services.repositories,
          services.credentialFiles,
          reference,
          minted,
          services.environment,
        )
      : { refused: planeCredentialUnreachedText(minted.unreached) };
  if (remote.refused !== undefined)
    return { checkout: { refused: scrub(remote.refused) } };
  const { repository, environment } = remote;
  const directory = jobRepositoryDirectory(workspace);
  const options = { signal, timeout: sessionCheckoutTimeoutMs };
  try {
    const mirror = await mirrors.updated(repository, environment, signal);
    await run(["clone", "--shared", "--quiet", mirror.path, directory], {
      ...options,
      cwd: dirname(mirror.path),
    });
    await run(["remote", "set-url", "origin", repository], {
      ...options,
      cwd: directory,
    });
    const { stdout } = await run(["rev-parse", "HEAD"], {
      ...options,
      cwd: directory,
    });
    await handOver(directory, user);
    const commit = stdout.trim();
    log(`session checkout ${reference} at ${commit}\n`);
    return { checkout: { directory, commit }, group: mirror.group };
  } catch (failure) {
    await sessionCheckoutFailed(reference, failure, directory, { log, scrub });
    return { checkout: undefined };
  }
}

/** A tree given whole to `user`'s user and group, each link itself rather than what it names. */
async function chatCheckoutHandedOver(directory, user) {
  await executeFile("chown", [
    "-R",
    "-h",
    `${String(user.uid)}:${String(user.gid)}`,
    directory,
  ]);
}
