/**
 * The reads every git a job runs makes of the other repositories its project
 * binds: a credential git asks this pod's own process for, and the
 * configuration that sends git to ask.
 *
 * GIT ASKS THROUGH ITS OWN CACHE CLIENT. Every git the attempt runs once its
 * workspace is cloned is configured to ask `git credential-cache` at a socket
 * in the minted directory, naming the path of the repository it reaches, for
 * any remote on the forge the job's own repository is bound at. This process
 * serves that socket and asks the plane under the bearer it alone holds, so
 * nothing git runs holds the bearer. A job whose repository is named by no
 * HTTP URL has no forge, and configures nothing.
 *
 * ONLY ANOTHER REPOSITORY IS ASKED FOR HERE. The plane answers the job's own
 * repository with the job's own credential, a work attempt's push among it, so
 * that name is never asked for: git reaches the job's own repository with the
 * askpass its clone and its push present, and with nothing anywhere else. Any
 * other the plane mints a read where the project binds it and nothing where it
 * does not, and nothing is answered nothing: git goes on to whatever else it
 * holds, and the launcher's mount is never presented to another repository.
 *
 * A REPOSITORY IS ASKED FOR BY ITS CLONE URL, which is what a binding is named
 * by: the forge's origin, the path git names, and `.git` where that path ends
 * without it.
 *
 * WHAT GIT HANDS BACK IS NEVER KEPT. The configuration first clears every
 * helper the image or the workspace names for the forge, so the cache client
 * is the only one git asks, and the only one git hands a credential that
 * worked, the job's own at its push among them. A store or an erase is read
 * and dropped, so no token rests in any file, and every answer is the plane's.
 * The plane answers a token only while it is still usable, so one that
 * expired is minted again the next time git asks.
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
 * What one request is answered: for a `get` naming another repository on the
 * forge, the credential the plane minted for it, and otherwise nothing.
 */
async function projectReadsAnswer(read, fields) {
  if (fields.get("action") !== "get") return "";
  const repository = projectReadsRepository(read.forge, fields);
  if (repository === undefined || repository === read.repositoryId) return "";
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
 * to them. `mint(repository)` is the plane's answer for another repository,
 * nothing where it mints none; `keep` holds each password answered, once.
 * `close` drops every client and removes the socket.
 */
export async function projectReadsServed({
  repositoryId,
  directory,
  mint,
  keep,
  warn = (text) => process.stderr.write(`${text}\n`),
}) {
  const forge = projectReadsForge(repositoryId);
  if (forge === undefined) return { git: [], close: async () => undefined };
  const held = new Set();
  const read = {
    forge,
    repositoryId,
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
