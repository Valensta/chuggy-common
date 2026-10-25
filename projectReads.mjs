/**
 * The reads every git a job runs, or a session's shell does, makes of the
 * repositories its project binds, its own among them: a credential git asks
 * this pod's own process for, and the configuration that sends git to ask.
 *
 * GIT ASKS THROUGH ITS OWN CACHE CLIENT. Every git the attempt runs once its
 * workspace is cloned, but its push, is configured to ask `git
 * credential-cache` at a socket in the minted directory, naming the path of
 * the repository it reaches, for any remote on the forge the job's own
 * repository is bound at. This process serves that socket and asks the plane
 * under the bearer it alone holds, so nothing git runs holds the bearer. A job
 * whose repository is named by no HTTP URL has no forge, and configures
 * nothing.
 *
 * A GIT TOO OLD TO READ THAT CONFIGURATION IS WARNED OF, once, on this
 * process's stderr: every read is then absent, and nothing else would say so.
 * The job runs on without them.
 *
 * EVERY ANSWER IS A READ. The plane mints a read of the job's own repository
 * where it is named, and of any other where the project binds it, and nothing
 * where it does not; where it mints nothing the cache client answers git
 * nothing, git goes on to whatever else it holds, and outside the push the
 * attempt hands it nothing more. The push asks for the job's own repository
 * by no name, which a work attempt is minted the write for, and presents it
 * through its askpass alone, from a repository of the core's own that is
 * handed none of these entries, asks no helper and runs no hook
 * (`source.mjs`).
 *
 * A REPOSITORY IS ASKED FOR BY ITS CLONE URL, which is what a binding is named
 * by: the forge's origin, the path git names, and `.git` where that path ends
 * without it.
 *
 * WHAT GIT HANDS BACK IS NEVER KEPT. The configuration first clears every
 * helper the image or the workspace names for the forge, so the cache client
 * is the only one git asks, and the only one git hands a credential that
 * worked; the push asks no helper at all, so its credential is handed to
 * nothing. A store or an erase is read and dropped, so no token rests in
 * any file, and every answer is the plane's. The plane answers a token only
 * while it is still usable, so one that expired is minted again the next time
 * git asks.
 *
 * AN SSH ADDRESS ON THE FORGE IS FETCHED OVER HTTPS, so a submodule written as
 * `git@github.com:owner/name.git` reaches the same repository with the same
 * credential, and one its project does not bind fails as any remote git cannot
 * read does.
 *
 * EVERY PASSWORD ANSWERED IS HELD, so the push refuses a commit carrying it and
 * every upload scrubs it.
 */

import { createServer } from "node:net";
import { join } from "node:path";
import { URL } from "node:url";

/** The socket git's cache client asks at, in the directory it is served under. */
const projectReadsSocketName = "chuggy-git-reads.sock";

/** The most of one request that is read, past which its client is dropped unanswered. */
const projectReadsRequestCharsMax = 65_536;

/** The most clients the socket holds at once. */
const projectReadsClientsMax = 64;

/** What a repository's clone URL ends in. */
const projectReadsCloneSuffix = ".git";

/** The schemes a forge is reached by, over which git's credential protocol is the same. */
const projectReadsSchemes = ["https:", "http:"];

/** The first git release, as its major and minor, that reads `GIT_CONFIG_COUNT`'s entries from its environment. */
const projectReadsGitFirst = [2, 31];

/** That release as a person reads it. */
const projectReadsGitFirstText = projectReadsGitFirst.join(".");

/**
 * The version `git --version` printed, where it names one older than
 * `projectReadsGitFirst`; nothing where it is that release or later, or names
 * no version that can be read.
 */
export function projectReadsGitTooOld(printed) {
  const match = /^git version ((\d+)\.(\d+)\S*)/u.exec(printed.trim());
  if (match === null) return undefined;
  const [major, minor] = [Number(match[2]), Number(match[3])];
  const [firstMajor, firstMinor] = projectReadsGitFirst;
  return major < firstMajor || (major === firstMajor && minor < firstMinor)
    ? match[1]
    : undefined;
}

/** The warning a job whose git is `version` is given. */
export function projectReadsGitWarning(version) {
  return `this image's git ${version} predates GIT_CONFIG_COUNT, so reads of the project's repositories, its own included, and ssh submodule URLs are not available to it; use an image with git ${projectReadsGitFirstText} or later`;
}

/** Warns, by `warn`, where the git `gitVersion` answers for is too old to read the configuration; nothing where it cannot be asked. */
async function projectReadsGitChecked(gitVersion, warn) {
  const asked = gitVersion();
  let printed;
  try {
    printed = await asked;
  } catch {
    return;
  }
  const version = projectReadsGitTooOld(printed);
  if (version !== undefined) warn(projectReadsGitWarning(version));
}

/**
 * The forge `repositoryId` is bound at, its origin and its host name, or
 * nothing where it names no HTTP remote, or names one with a credential in it.
 */
export function projectReadsForge(repositoryId) {
  let url;
  try {
    url = new URL(repositoryId);
  } catch {
    return undefined;
  }
  if (!projectReadsSchemes.includes(url.protocol)) return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  return { origin: url.origin, hostname: url.hostname };
}

/** `text` as one POSIX shell word, which is how git reads a helper's arguments. */
function projectReadsShellWord(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The entries every git the attempt runs is handed: on `forge` alone, the
 * cache client at `socket` as the only helper, told each repository's path;
 * and each of the forge's ssh addresses read as its HTTP one.
 */
export function projectReadsConfiguration(forge, socket) {
  return [
    [`credential.${forge.origin}.helper`, ""],
    [
      `credential.${forge.origin}.helper`,
      `cache --socket ${projectReadsShellWord(socket)}`,
    ],
    [`credential.${forge.origin}.useHttpPath`, "true"],
    [`url.${forge.origin}/.insteadOf`, `git@${forge.hostname}:`],
    [`url.${forge.origin}/.insteadOf`, `ssh://git@${forge.hostname}/`],
  ];
}

/** Each `key=value` line of one request, the first of a key being the one read. */
export function projectReadsFields(text) {
  const fields = new Map();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    const key = line.slice(0, at);
    if (at > 0 && !fields.has(key)) fields.set(key, line.slice(at + 1));
  }
  return fields;
}

/** The clone URL of the repository a request's fields name on `forge`, or nothing where they name none there. */
export function projectReadsRepository(forge, fields) {
  const path = fields.get("path")?.replace(/\/+$/u, "") ?? "";
  if (`${fields.get("protocol")}://${fields.get("host")}` !== forge.origin)
    return undefined;
  if (path.length === 0) return undefined;
  return `${forge.origin}/${path.endsWith(projectReadsCloneSuffix) ? path : `${path}${projectReadsCloneSuffix}`}`;
}

/** Whether a value can stand in a line of git's credential protocol. */
function projectReadsLine(value) {
  return !/[\n\0]/u.test(value);
}

/**
 * What one request is answered: for a `get` naming a repository on the forge,
 * the credential the plane minted for it, and otherwise nothing.
 */
async function projectReadsAnswer(read, fields) {
  if (fields.get("action") !== "get") return "";
  const repository = projectReadsRepository(read.forge, fields);
  if (repository === undefined) return "";
  let minted;
  try {
    minted = await read.mint(repository);
  } catch (error) {
    read.warn(`a read of ${repository} could not be minted: ${error.message}`);
    return "";
  }
  if (minted === undefined) return "";
  if (!projectReadsLine(minted.username) || !projectReadsLine(minted.password))
    return "";
  read.keep(minted.password);
  return `username=${minted.username}\npassword=${minted.password}\n`;
}

/** One client of the socket: its whole request read, then answered and ended. */
function projectReadsClient(read, clients, client) {
  clients.add(client);
  client.on("close", () => clients.delete(client));
  client.on("error", () => client.destroy());
  client.setEncoding("utf8");
  let request = "";
  client.on("data", (chunk) => {
    request += chunk;
    if (request.length > projectReadsRequestCharsMax) client.destroy();
  });
  client.on("end", () => {
    void projectReadsAnswer(read, projectReadsFields(request)).then((text) =>
      client.end(text),
    );
  });
}

/** `server` listening at `socket`, or the reason it could not. */
function projectReadsListening(server, socket) {
  return new Promise((listening, refused) => {
    server.once("error", refused);
    server.listen(socket, () => {
      server.off("error", refused);
      listening(undefined);
    });
  });
}

/**
 * The reads served under `directory` for a job whose own repository is
 * `repositoryId`, and `git`, the entries that send every git the attempt runs
 * to them. `mint(repository)` is the plane's answer for a repository on the
 * forge, nothing where it mints none; `keep` holds each password answered,
 * once; `gitVersion` answers what the job's git prints for `git --version`.
 * `close` drops every client and removes the socket.
 */
export async function projectReadsServed({
  repositoryId,
  directory,
  mint,
  keep,
  gitVersion,
  warn = (text) => process.stderr.write(`${text}\n`),
}) {
  const forge = projectReadsForge(repositoryId);
  if (forge === undefined) return { git: [], close: async () => undefined };
  await projectReadsGitChecked(gitVersion, warn);
  const held = new Set();
  const read = {
    forge,
    mint,
    warn,
    keep: (password) => {
      if (held.has(password)) return;
      held.add(password);
      keep(password);
    },
  };
  const clients = new Set();
  const server = createServer({ allowHalfOpen: true }, (client) =>
    projectReadsClient(read, clients, client),
  );
  server.maxConnections = projectReadsClientsMax;
  const socket = join(directory, projectReadsSocketName);
  await projectReadsListening(server, socket);
  server.on("error", (error) =>
    warn(`the reads at ${socket} failed: ${error.message}`),
  );
  return {
    git: projectReadsConfiguration(forge, socket),
    close: () =>
      new Promise((closed) => {
        for (const client of clients) client.destroy();
        server.close(() => closed(undefined));
      }),
  };
}
