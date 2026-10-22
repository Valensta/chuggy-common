/**
 * A forge a suite's git reaches over HTTP, as a pod's reaches GitHub: bare
 * repositories under a directory of its own, served by git's own
 * `http-backend`, each refusing every request that presents no password it
 * was told to accept for the service the request names, and every credential
 * presented to it recorded with that service.
 */

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";

import { author, git, headOf } from "./checkout.fixture.mjs";

/** What every git a suite runs against the forge is handed, so no file of this machine's configures it. */
export const forgeGitIsolated = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/** The repository a request's path names, and the rest of that path. */
function forgeRequested(pathname) {
  const match = /^\/(.+?\.git)(\/.*)$/u.exec(pathname);
  return match === null ? undefined : { name: match[1], rest: match[2] };
}

/** The services git reaches a repository through: a fetch's, and a push's. */
export const forgeServices = {
  read: "git-upload-pack",
  write: "git-receive-pack",
};

/** The service a request is for, named by its query where it asks for the refs and by its path where it sends a pack. */
function forgeService(url, requested) {
  return url.searchParams.get("service") ?? requested.rest.slice(1);
}

/** The username and password a request presents, or nothing where it presents none. */
function forgePresented(authorization) {
  const match = /^Basic (.+)$/u.exec(authorization ?? "");
  if (match === null) return undefined;
  const text = Buffer.from(match[1], "base64").toString("utf8");
  const at = text.indexOf(":");
  return { username: text.slice(0, at), password: text.slice(at + 1) };
}

/** A CGI response's header block read off `output`, and the body after it. */
function forgeCgiAnswer(output) {
  const end = output.indexOf("\r\n\r\n");
  const headers = output.subarray(0, end).toString("utf8").split("\r\n");
  let status = 200;
  const named = {};
  for (const line of headers) {
    const at = line.indexOf(":");
    const name = line.slice(0, at);
    const value = line.slice(at + 1).trim();
    if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
    else named[name] = value;
  }
  return { status, headers: named, body: output.subarray(end + 4) };
}

/** One request answered by `git http-backend` for the repository it names. */
async function forgeBackend(root, request, requested, presented) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const url = new URL(request.url ?? "/", "http://forge.invalid");
  const child = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH ?? "",
      ...forgeGitIsolated,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${requested.name}${requested.rest}`,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method ?? "GET",
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(body.length),
      HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
      HTTP_GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
      ...(presented === undefined ? {} : { REMOTE_USER: presented.username }),
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(body);
  const output = [];
  for await (const chunk of child.stdout) output.push(chunk);
  await new Promise((exited) => child.on("close", exited));
  return forgeCgiAnswer(Buffer.concat(output));
}

/**
 * A forge served until `t` ends, holding each of `names`: `url(name)` is the
 * repository's clone URL and `bare(name)` the directory it is kept in;
 * `accept(name, password)` makes that password the only one that reads or
 * pushes it from then on, and `acceptRead(name, password)` the only one that
 * reads it, leaving what pushes it as it was; `seed(name, files, gitlinks)`
 * makes a commit of those files and those submodule commits its `main`; and
 * `presented` is every credential any request presented, in order, with the
 * service it asked for.
 */
export async function forgeServed(t, names) {
  const root = await mkdtemp(join(tmpdir(), "chuggy-forge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const accepted = new Map(names.map((name) => [name, new Map()]));
  for (const name of names)
    await git("git", ["init", "--bare", "--initial-branch=main", name], {
      cwd: root,
    });
  const presented = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://forge.invalid");
    const requested = forgeRequested(url.pathname);
    if (requested === undefined || !accepted.has(requested.name)) {
      response.writeHead(404).end();
      return;
    }
    const service = forgeService(url, requested);
    const credential = forgePresented(request.headers.authorization);
    if (credential !== undefined)
      presented.push({ repository: requested.name, service, ...credential });
    if (
      credential === undefined ||
      accepted.get(requested.name).get(service) !== credential.password
    ) {
      response
        .writeHead(401, { "www-authenticate": 'Basic realm="forge"' })
        .end();
      return;
    }
    void forgeBackend(root, request, requested, credential).then((answer) =>
      response.writeHead(answer.status, answer.headers).end(answer.body),
    );
  });
  await new Promise((listening) => {
    server.listen(0, "127.0.0.1", () => listening(undefined));
  });
  t.after(
    () =>
      new Promise((closed) => {
        server.closeAllConnections();
        server.close(() => closed(undefined));
      }),
  );
  const origin = `http://127.0.0.1:${String(server.address().port)}`;
  return {
    origin,
    presented,
    url: (name) => `${origin}/${name}`,
    bare: (name) => join(root, name),
    accept: (name, password) =>
      accepted.set(
        name,
        new Map(Object.values(forgeServices).map((named) => [named, password])),
      ),
    acceptRead: (name, password) =>
      accepted.get(name).set(forgeServices.read, password),
    seed: (name, files, gitlinks = {}) =>
      forgeSeeded(join(root, name), files, gitlinks),
  };
}

/** A commit of `files` and `gitlinks` pushed as the `main` of the bare repository at `bare`, and its id. */
async function forgeSeeded(bare, files, gitlinks) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-forge-seed-"));
  try {
    await git("git", ["init", "--initial-branch=main", directory]);
    for (const [path, content] of Object.entries(files))
      await writeFile(join(directory, path), content);
    await git("git", ["add", "--all"], { cwd: directory });
    for (const [path, commit] of Object.entries(gitlinks))
      await git(
        "git",
        ["update-index", "--add", "--cacheinfo", `160000,${commit},${path}`],
        { cwd: directory },
      );
    await git("git", [...author, "commit", "-m", "seeded"], { cwd: directory });
    await git("git", ["push", bare, "main"], { cwd: directory });
    return await headOf(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
