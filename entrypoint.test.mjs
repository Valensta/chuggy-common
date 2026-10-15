import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

import {
  sessionTaskVariable,
  workerCredentialFilesVariable,
  workerRepositoriesVariable,
  workerTaskVariable,
  workerWorkspaceVariable,
} from "@chuggy/worker-contract/workerEnvironment";
import { resultReportCharsMax } from "@chuggy/worker-contract/workerDocuments";
import {
  runConfigurationBytesMax,
  workerPlaneBytesMediaType,
} from "@chuggy/worker-contract/workerPlane";
import { workTaskAnswerSchema } from "@chuggy/worker-contract/workerTask";

import { git, inCheckout, remoteRefs } from "./checkout.fixture.mjs";
import {
  workerChangeBaseVariable,
  workerCheckCommands,
  workerSummaryCharsMax,
} from "./checks.mjs";
import { claudeAgent } from "./claude.mjs";
import { pausedClock } from "./clock.fixture.mjs";
import {
  envelopeLaunch,
  envelopeTask,
  prepareWorker,
  publishWorkerResult,
  reportWorkerFailure,
  runWorkerTask,
  workerAttempt,
  workerCredential,
  workerMintedWritable,
  workerMode,
  workerRun,
  workerTemporaryFile,
  workerWorkspace,
} from "./entrypoint.mjs";
import {
  envelope,
  fetchedAnswer,
  poolHeldSessionAnswer,
} from "./envelope.fixture.mjs";
import { keepWorkerLease } from "./lease.mjs";
import { planeFetch, planes } from "./plane.fixture.mjs";
import { agentResultSchema } from "./result.mjs";
import { workerCredentialPath } from "./planeCredential.mjs";
import { credentialScrub, runEvidenceRecorder } from "./runEvidence.mjs";
import { facts } from "./sessionHarness.fixture.mjs";
import { commitAndPushSource, ticketBranch } from "./source.mjs";
import { workerPlaneAwayMillisecondsMax, workerRequest } from "./transport.mjs";

const task = { workerPlane: { url: "http://worker-plane.test:3001" } };
const secret = "sk-ant-oat01-0123456789abcdefghijklmnop";
const minted = {
  username: "x-access-token",
  password: "ghs_0123456789abcdefghijklmnopqrstuvwxyz",
};

/** The repository this attempt was placed against, as the launcher configured it. */
const repositories = {
  "repository-1": {
    url: "https://github.com/kasofsk/chuggy.git",
    credential: "forge",
    credentialUsername: "x-access-token",
  },
};
const credentialFiles = { forge: "/var/run/chuggy/credentials/forge" };

/** The kind a minted credential is held as, and a refused push names it by. */
const mintedKind = "the git credential the plane minted";

/**
 * One attempt asking the plane for its credential, with what the plane answers
 * and what the pod is authorized to mount if it does not.
 */
function askedFor(answer, credentials = ["forge"]) {
  const kept = [];
  const written = [];
  const paths = [];
  return {
    kept,
    written,
    paths,
    asked: {
      task: { ...task, authority: { credentials } },
      bearer: "capability",
      repositories,
      credentialFiles,
      repositoryId: "repository-1",
      keepSecret: (secret) => kept.push(secret),
      request: async (_task, _bearer, path) => {
        paths.push(path);
        return typeof answer === "function" ? answer() : answer;
      },
      write: async (file, content) => written.push({ file, content }),
    },
  };
}

function published(calls, request, scrub, run) {
  return publishWorkerResult(
    {
      task: { ...task, taskKind: "Evaluation" },
      bearer: "bearer",
      evidence: evidenceFor(request),
      scrub,
      stopLease: async () => calls.push({ path: "lease/stopped" }),
      request,
    },
    {},
    run ?? {
      output: {
        type: "result",
        structured_output: { summary: `saw ${secret}` },
      },
      result: { verdict: "Pass", summary: `the run saw ${secret}` },
      diagnosticPath: ".chuggy/agent-result.json",
    },
  );
}

function planeCalls() {
  const calls = [];
  return {
    calls,
    request: async (_task, _bearer, path, init) => {
      calls.push({ path, init });
      return { ok: true, status: 204 };
    },
  };
}

function evidenceFor(request) {
  return runEvidenceRecorder(task, "bearer", (text) => text, {
    request,
    setInterval: () => ({ unref: () => undefined }),
    clearInterval: () => undefined,
    warn: () => undefined,
  });
}

test("exactly one task document is what a pod may be launched with", () => {
  assert.equal(workerMode({ [workerTaskVariable]: "{}" }), "Work");
  assert.equal(workerMode({ [sessionTaskVariable]: "{}" }), "Session");
  assert.throws(
    () =>
      workerMode({ [workerTaskVariable]: "{}", [sessionTaskVariable]: "{}" }),
    /never both/u,
  );
  assert.throws(() => workerMode({}), /needs one of/u);
  assert.throws(
    () => workerMode({ [workerTaskVariable]: "", [sessionTaskVariable]: "" }),
    /needs one of/u,
  );
});

/**
 * One pod launched as the image launches it, which is the only way into the
 * environment `main` reads: it is not exported, and nothing imports it.
 * `minted`, where given, is the directory it finds in place of the contract's
 * minted credential directory, which no machine a suite runs on mounts.
 */
function launched(environment, minted) {
  const here = dirname(fileURLToPath(import.meta.url));
  const redirected =
    minted === undefined
      ? []
      : [
          "--import",
          pathToFileURL(join(here, "mintedDirectory.fixture.mjs")).href,
        ];
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...redirected, join(here, "entrypoint.mjs")],
      {
        env: {
          PATH: process.env["PATH"] ?? "",
          ...(minted === undefined
            ? {}
            : { CHUG_SUITE_MINTED_DIRECTORY: minted }),
          ...environment,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stderr });
    });
  });
}

/**
 * A work task the scheduler placed with commands rather than an agent, whose
 * authority names no credential because no agent asks for one.
 */
function commandedWorkTask(authority = {}) {
  return JSON.stringify({
    taskKind: "Work",
    worker: { mode: { type: "Commands", commands: ["true"] } },
    authority: {
      network: true,
      filesystem: "WriteWorkspace",
      credentials: [],
      ...authority,
    },
  });
}

/** The refusal a pod launched without its credential map ends with. */
const credentialFilesMissing = new RegExp(
  `^${workerCredentialFilesVariable} is required$`,
  "mu",
);

test("a pod placed with an empty repository map is given an empty one", async () => {
  const ran = await launched({
    [workerTaskVariable]: commandedWorkTask(),
    [workerRepositoriesVariable]: "",
  });

  assert.equal(ran.code, 1);
  assert.match(
    ran.stderr,
    credentialFilesMissing,
    "the map stood empty and the launch went on to the next variable",
  );
});

/** Catches the pod reading its repository map under a name its launcher does not write. */
test("a pod placed with a repository map that is not one is refused", async () => {
  const ran = await launched({
    [workerTaskVariable]: commandedWorkTask(),
    [workerRepositoriesVariable]: "[]",
  });

  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /worker repositories must be an object/u);
});

/**
 * Admission reads the carrier, not the kind: a commanded work task mounts no
 * agent credential, so demanding one — as a pod that built an agent for every
 * Work task would — stops the launch before the variable below is ever read.
 */
test("a commanded work task is admitted with no agent credential mounted", async () => {
  const ran = await launched({ [workerTaskVariable]: commandedWorkTask() });

  assert.match(
    ran.stderr,
    credentialFilesMissing,
    "a commanded work task asked for something an agent's credential answers",
  );
});

/**
 * Catches the core writing a file of its own outside the temporary directory
 * the image names, which is the only one its check found it can write.
 */
test("an agent's task keeps its result schema in the image's temporary directory", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "chuggy-temporary-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const ran = await launched({
    TMPDIR: temporary,
    [workerTaskVariable]: JSON.stringify({
      taskKind: "Work",
      worker: { mode: { type: "SingleAgent", agent: "Claude" } },
      authority: {
        network: true,
        filesystem: "WriteWorkspace",
        credentials: [claudeAgent.credential],
      },
    }),
  });

  assert.match(ran.stderr, credentialFilesMissing);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(temporary, "chuggy-agent-result-schema.json"),
        "utf8",
      ),
    ),
    agentResultSchema,
  );
});

/** Where a job keeps its own files is the temporary directory as `check.sh` names it. */
test("an unnamed or empty TMPDIR keeps a job's files in /tmp", () => {
  assert.equal(
    workerTemporaryFile("kept", { TMPDIR: "/image/temporary" }),
    "/image/temporary/kept",
  );
  for (const environment of [{}, { TMPDIR: "" }])
    assert.equal(workerTemporaryFile("kept", environment), "/tmp/kept");
});

/** Both halves of what a commanded work task must be granted before it runs. */
test("a commanded work task without network or workspace write is refused", async () => {
  const launches = [
    await launched({
      [workerTaskVariable]: commandedWorkTask({ network: false }),
    }),
    await launched({
      [workerTaskVariable]: commandedWorkTask({ filesystem: "ReadOnly" }),
    }),
  ];

  for (const ran of launches) {
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /requires network and workspace write authority/u);
  }
});

/**
 * A worker plane a launched pod reaches over HTTP, answering through the
 * contract's own tables: `answer(route)` is what each route answers, `asked`
 * is every route in order with the bearer it was asked under, and `requests`
 * is each one as the plane read it, its body included. `wire` is the job
 * plane's unless a case names another.
 */
async function servedPlane(answer, wire = planes.job) {
  const plane = planeFetch(wire, answer);
  const asked = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let answered;
    try {
      answered = await plane.fetch(
        new URL(request.url ?? "/", "http://worker-plane.test"),
        {
          method: request.method,
          headers: request.headers,
          ...(body.length === 0
            ? {}
            : {
                body:
                  request.headers["content-type"] === workerPlaneBytesMediaType
                    ? body
                    : body.toString("utf8"),
              }),
        },
      );
      asked.push({
        route: plane.asked.at(-1)?.route,
        authorization: request.headers.authorization,
      });
    } catch {
      answered = new globalThis.Response(null, { status: 400 });
    }
    response.writeHead(answered.status, Object.fromEntries(answered.headers));
    response.end(Buffer.from(await answered.arrayBuffer()));
  });
  await new Promise((listening) => {
    server.listen(0, "127.0.0.1", () => listening(undefined));
  });
  return {
    url: `http://127.0.0.1:${String(server.address().port)}`,
    asked,
    requests: plane.asked,
    close: () => new Promise((closed) => server.close(() => closed(undefined))),
  };
}

/** A work task whose worker runs `commands`. */
function commandedTask(commands) {
  return {
    status: 200,
    body: workTaskAnswerSchema.parse({
      ...fetchedAnswer,
      worker: { mode: { type: "Commands", commands }, setup: [], files: [] },
    }),
  };
}

/** The input bundle one attempt is placed with: a repository and the commit it starts from. */
function inputAnswer(repository, base) {
  return {
    status: 200,
    body: {
      bundle: "bundle-1",
      digest: "0".repeat(64),
      references: [
        { ordinal: 1, kind: "Repository", reference: repository },
        { ordinal: 2, kind: "TargetCommit", reference: base },
      ],
    },
  };
}

/** A plane serving an envelope's pod one commanded work task, and minting nothing for its repository. */
function commandedPlane() {
  return servedPlane((route) => {
    switch (route) {
      case "task":
        return commandedTask(["true"]);
      case "input":
        return inputAnswer("repository-1", "0".repeat(40));
      case "credential":
        return { status: 404 };
      default:
        return { status: 204 };
    }
  });
}

/**
 * A pod launched as a pool launches it: an envelope, carrying a field a later
 * release might add, and no credential map. Catches an envelope read as a
 * document, a pod that fetched its task anywhere but the envelope's plane or
 * under anything but its bearer, and an attempt that did not run on from
 * there as a pushed one does, to the credential its repository needs and the
 * crashed run's report when there is none.
 */
test("a pod launched with an envelope fetches its task and runs it under the envelope's bearer", async () => {
  const plane = await commandedPlane();
  const minted = await mkdtemp(join(tmpdir(), "chuggy-minted-"));
  try {
    const ran = await launched(
      {
        [workerTaskVariable]: JSON.stringify({
          ...envelope,
          callbackUrl: plane.url,
          namedByALaterRelease: true,
        }),
      },
      minted,
    );

    assert.equal(ran.code, 1);
    assert.match(
      ran.stderr,
      /^no repository configuration for repository-1$/mu,
    );
    assert.deepEqual(
      plane.asked,
      ["task", "input", "credential", "runTotals", "artifact", "runEnded"].map(
        (route) => ({ route, authorization: `Bearer ${envelope.bearer}` }),
      ),
    );
  } finally {
    await plane.close();
    await rm(minted, { recursive: true, force: true });
  }
});

/** The routes a pool-held session's pod reaches: the task route its envelope's bearer asks first, and then the session plane's. */
const poolHeldSessionWire = {
  ...planes.session,
  routes: { task: planes.job.routes.task, ...planes.session.routes },
  answers: { task: planes.job.answers.task, ...planes.session.answers },
};

/**
 * Catches an envelope's pod that refuses a pool-held session's task, runs it
 * as work, or runs it anywhere but on the envelope's plane under its bearer
 * with the credential the pool mounted. The credential is missing, so the
 * session stops at its token, before any runtime is opened.
 */
test("a pod launched with an envelope whose task is a pool-held session runs that session", async () => {
  const plane = await servedPlane(
    (route) =>
      route === "task"
        ? { status: 200, body: poolHeldSessionAnswer }
        : { status: 200, body: facts },
    poolHeldSessionWire,
  );
  const root = await mkdtemp(join(tmpdir(), "chuggy-pool-session-"));
  const providerCredentialFile = join(root, "claude-code");
  try {
    const ran = await launched({
      [workerTaskVariable]: JSON.stringify({
        ...envelope,
        callbackUrl: plane.url,
        workspace: root,
        providerCredentialFile,
      }),
    });

    assert.equal(ran.code, 1);
    assert.ok(ran.stderr.includes(providerCredentialFile), ran.stderr);
    assert.ok(!ran.stderr.includes(envelope.bearer));
    assert.deepEqual(
      plane.asked,
      ["task", "facts"].map((route) => ({
        route,
        authorization: `Bearer ${envelope.bearer}`,
      })),
    );
  } finally {
    await plane.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A launcher that forgot the minted credential directory is told so, and the
 * attempt ends as a crashed run's does before any of its work: no input read,
 * no credential asked for. Catches a check made after the work began, or one
 * whose refusal leaves the attempt to its lease.
 */
test("a pod launched without its minted credential directory ends the attempt before any work", async () => {
  const plane = await commandedPlane();
  const root = await mkdtemp(join(tmpdir(), "chuggy-minted-"));
  const missing = join(root, "missing");
  try {
    const ran = await launched(
      {
        [workerTaskVariable]: JSON.stringify({
          ...envelope,
          callbackUrl: plane.url,
        }),
      },
      missing,
    );

    assert.equal(ran.code, 1);
    assert.ok(
      ran.stderr
        .split("\n")
        .includes(
          `the minted credential directory ${missing} does not exist; a pod is launched with it mounted writable`,
        ),
      ran.stderr,
    );
    assert.deepEqual(
      plane.asked.map(({ route }) => route),
      ["task", "runTotals", "artifact", "runEnded"],
    );
  } finally {
    await plane.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A task whose configuration names no worker is refused before the pod reads
 * anything else, and the attempt still ends then, under the envelope's bearer
 * and with the refusal as its error text. Catches a pod that holds no bearer
 * until after admission, and one that ends a run it never began without
 * posting the end.
 */
test("an envelope's task refused at admission ends its attempt with the refusal", async () => {
  const unworked = Object.fromEntries(
    Object.entries(fetchedAnswer).filter(([field]) => field !== "worker"),
  );
  const plane = await servedPlane((route) =>
    route === "task" ? { status: 200, body: unworked } : { status: 204 },
  );
  try {
    const ran = await launched({
      [workerTaskVariable]: JSON.stringify({
        ...envelope,
        callbackUrl: plane.url,
      }),
    });

    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /^worker mode is not SingleAgent$/mu);
    assert.deepEqual(
      plane.asked,
      ["task", "runTotals", "artifact", "runEnded"].map((route) => ({
        route,
        authorization: `Bearer ${envelope.bearer}`,
      })),
    );
    const uploaded = plane.requests.find(({ route }) => route === "artifact");
    assert.equal(uploaded.path, "/v1/artifacts/.chuggy/worker-error.txt");
    assert.equal(
      Buffer.from(uploaded.body).toString("utf8"),
      "worker mode is not SingleAgent\n",
    );
  } finally {
    await plane.close();
  }
});

test("a minted credential directory that is missing is refused, naming it", async () => {
  const root = await mkdtemp(join(tmpdir(), "chuggy-minted-"));
  try {
    const missing = join(root, "missing");

    await assert.rejects(workerMintedWritable(missing), {
      message: `the minted credential directory ${missing} does not exist; a pod is launched with it mounted writable`,
    });
    await workerMintedWritable(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A read-only mount, and a file standing where the directory should, which the
 * pod could write and search were it a directory.
 */
test("a minted credential directory the pod cannot write to is refused, naming it", async () => {
  const root = await mkdtemp(join(tmpdir(), "chuggy-minted-"));
  try {
    const readOnly = join(root, "read-only");
    const file = join(root, "file");
    await mkdir(readOnly, { mode: 0o500 });
    await writeFile(file, "", { mode: 0o700 });

    for (const directory of [readOnly, file])
      await assert.rejects(workerMintedWritable(directory), {
        message: `the minted credential directory ${directory} is not writable; a pod is launched with it mounted writable`,
      });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Catches an envelope's pod cloning into the directory the image names rather
 * than the one its pool mounted, whether the launch or the attempt drops it.
 */
test("an envelope's pod clones into the workspace its envelope names", async () => {
  process.env[workerWorkspaceVariable] = "/not-the-envelopes";
  const plane = await servedPlane((route) => {
    switch (route) {
      case "task":
        return commandedTask(["true"]);
      case "input":
        return inputAnswer("repository-1", "0".repeat(40));
      case "credential":
        return {
          status: 200,
          body: { ...minted, expiresAtMs: 1_900_000_000_000 },
        };
      default:
        return { status: 204 };
    }
  });
  const cloned = [];
  const mintedDirectory = await mkdtemp(join(tmpdir(), "chuggy-minted-"));
  try {
    const served = { ...envelope, callbackUrl: plane.url };
    const { task } = await envelopeTask(served);
    await assert.rejects(
      workerAttempt(envelopeLaunch(served, task), {
        minted: mintedDirectory,
        write: async () => undefined,
        clone: async (_repository, _base, into) => {
          cloned.push(into);
          throw new Error("cloned");
        },
      }),
      /^Error: cloned$/u,
    );
  } finally {
    await plane.close();
    await rm(mintedDirectory, { recursive: true, force: true });
  }

  assert.deepEqual(cloned, [envelope.workspace]);
});

/**
 * The setup lines of a block are narrowed with its commands. Catches the
 * document reaching the shell that runs in the workspace just before them,
 * which could leave it in a file for the commands to read.
 */
test("a setup line sees the pod's environment but not the task document", async () => {
  const site = "set by the site";
  Object.assign(process.env, {
    [workerTaskVariable]: "{}",
    [sessionTaskVariable]: "{}",
    SITE_VARIABLE: site,
  });
  try {
    await inCheckout(async ({ directory }) => {
      const setup =
        `printf "%s|%s|%s" "\${${workerTaskVariable}-unset}" ` +
        `"\${${sessionTaskVariable}-unset}" "\${SITE_VARIABLE-unset}" > inherited`;

      await prepareWorker({ worker: { setup: [setup] } }, directory);

      assert.equal(
        await readFile(join(directory, "inherited"), "utf8"),
        `unset|unset|${site}`,
      );
    });
  } finally {
    for (const name of [
      workerTaskVariable,
      sessionTaskVariable,
      "SITE_VARIABLE",
    ])
      delete process.env[name];
  }
});

/** A shell line that prints what its stage told it of the change's base, or `unset`. */
const printsChangeBase = `printf "%s" "\${${workerChangeBaseVariable}-unset}"`;

/**
 * One commanded evaluation run whole in a real checkout, over a plane answering
 * its input as the repository, the checkout's own commit, and whatever
 * `references` names given that commit; and what its setup line and its
 * command each printed. The pod holds a base of its own throughout, which no
 * run may pass on.
 */
async function evaluationPrinted(references) {
  let printed;
  let setUp;
  process.env[workerChangeBaseVariable] = "f".repeat(40);
  try {
    await inCheckout(async ({ directory, base }) => {
      const plane = await servedPlane((route) => {
        switch (route) {
          case "task":
            return {
              status: 200,
              body: workTaskAnswerSchema.parse({
                ...fetchedAnswer,
                taskKind: "Evaluation",
                worker: {
                  mode: {
                    type: "Commands",
                    commands: [`${printsChangeBase} > told`],
                  },
                  setup: [`${printsChangeBase} > set-up`],
                  files: [],
                },
              }),
            };
          case "input": {
            const placed = inputAnswer("repository-1", base);
            placed.body.references.push(...references(base));
            return placed;
          }
          case "credential":
            return {
              status: 200,
              body: { ...minted, expiresAtMs: 1_900_000_000_000 },
            };
          case "report":
            return { status: 202, body: { action: "stop" } };
          default:
            return { status: 204 };
        }
      });
      const mintedDirectory = await mkdtemp(join(tmpdir(), "chuggy-minted-"));
      try {
        const served = { ...envelope, callbackUrl: plane.url };
        const { task } = await envelopeTask(served);
        await workerAttempt(envelopeLaunch(served, task), {
          minted: mintedDirectory,
          write: async () => undefined,
          clone: async () => directory,
        });
        printed = await readFile(join(directory, "told"), "utf8");
        setUp = await readFile(join(directory, "set-up"), "utf8");
      } finally {
        await plane.close();
        await rm(mintedDirectory, { recursive: true, force: true });
      }
    });
  } finally {
    delete process.env[workerChangeBaseVariable];
  }
  return { printed, setUp };
}

/**
 * Catches the base the bundle pinned not reaching a check stage's commands or
 * the setup lines of its block, or reaching them as anything but the commit
 * itself.
 */
test("a check stage's shells are told the commit its input names the change started from", async () => {
  let pinned;

  const told = await evaluationPrinted((base) => {
    pinned = base;
    return [{ ordinal: 3, kind: "ChangeBase", reference: base }];
  });

  assert.deepEqual(told, { printed: pinned, setUp: pinned });
});

/**
 * Catches a stage told a base its bundle never named, which a check would
 * narrow to; unset, it runs everything.
 */
test("a check stage whose input names no base leaves the variable unset", async () => {
  const told = await evaluationPrinted(() => []);

  assert.deepEqual(told, { printed: "unset", setUp: "unset" });
});

/**
 * Catches a base the clone does not hold being passed on, which leaves the
 * check's own diff to fail, and one that is not a full hash, which names
 * whatever git resolves it to rather than the commit the bundle pinned.
 */
test("a base the clone cannot hold as that very commit leaves the variable unset", async () => {
  for (const named of [() => "e".repeat(40), (base) => base.slice(0, 12)]) {
    const { printed } = await evaluationPrinted((base) => [
      { ordinal: 3, kind: "ChangeBase", reference: named(base) },
    ]);

    assert.equal(printed, "unset");
  }
});

/**
 * One workspace over a real checkout, its input naming the checkout's own
 * commit as where the attempt starts and whatever `references` adds.
 */
async function workspaceNaming(references) {
  let workspace;
  await inCheckout(async ({ directory, base }) => {
    workspace = await workerWorkspace(
      { ...task, authority: { credentials: ["forge"] } },
      repositories,
      credentialFiles,
      "capability",
      () => undefined,
      {
        request: async (_task, _bearer, path) =>
          path === "/v1/input"
            ? {
                ok: true,
                status: 200,
                json: async () => ({
                  references: [
                    { kind: "Repository", reference: "repository-1" },
                    { kind: "TargetCommit", reference: base },
                    ...references(base),
                  ],
                }),
              }
            : { status: 404, json: async () => ({ reason: "NotMinted" }) },
        clone: async () => directory,
        workspace: "/workspace",
      },
    );
  });
  return workspace;
}

test("a bundle naming two bases is refused rather than either taken", async () => {
  await assert.rejects(
    workspaceNaming((base) => [
      { kind: "ChangeBase", reference: base },
      { kind: "ChangeBase", reference: "e".repeat(40) },
    ]),
    /input bundle must carry at most one ChangeBase/u,
  );
});

/**
 * Driven against a real checkout, because what `git add --all` takes is git's
 * answer. Catches a lockfile `uv sync` writes, or a build directory, reaching
 * the attempt's commit as if the agent had made it: a review held to the
 * ticket's scope then fails every attempt for a file nothing asked for.
 *
 * Each leftover lists the files of the agent's that a pattern wider than it
 * would swallow, and must itself stay out of both the status and the commit,
 * so every escape, the anchor and the skipped name each stand between some
 * file and where it belongs. The provisioned path is spelled as a
 * configuration may spell it, and a file the agent adds under a directory
 * setup made goes with that directory.
 */
test("what setup leaves untracked is excluded, and the work is not", async () => {
  const leftovers = {
    "uv.lock": ["lib/uv.lock"],
    "a*b": ["axb"],
    "q?": ["qz"],
    "x[a]": ["xa"],
    "b\\x": ["bx"],
    "trail ": ["trail"],
    "y  ": ["y "],
    "stamp\r": ["stamp", "stampx"],
    "#hash": [],
    "!bang": [],
    "build dir/out": [],
  };
  const unheld = { "a\nsrc": ["lib/src/new.py"] };
  const swallowed = ["build dir/agent.txt"];
  const created = (name) => `printf x > "$(printf '%s' '${name}')"`;
  await inCheckout(async ({ remote, directory, base }) => {
    const worker = {
      files: [{ path: "./provided/brief.md", content: "given\n" }],
      setup: [
        "mkdir 'build dir'",
        ...Object.keys({ ...leftovers, ...unheld }).map(created),
        "printf more >> README.md",
      ],
    };

    await prepareWorker({ worker }, directory);
    const { stdout: seen } = await git(
      "git",
      ["status", "--porcelain", "-z", "--untracked-files=all"],
      { cwd: directory },
    );
    const agents = [
      ...Object.values({ ...leftovers, ...unheld }).flat(),
      "provided/notes.md",
    ];
    for (const path of [...agents, ...swallowed]) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), "the agent's\n");
    }
    const source = await commitAndPushSource({
      task: { ticket: 9, attempt: "opaque", worker },
      repositoryId: "chuggy",
      repository: remote,
      base,
      directory,
      command: git,
      environment: process.env,
      secrets: [],
    });

    assert.deepEqual(
      seen.split("\0").filter(Boolean).sort(),
      [
        " M README.md",
        ...Object.keys(unheld).map((name) => `?? ${name}`),
      ].sort(),
    );
    const { stdout: changed } = await git(
      "git",
      ["diff", "--name-only", "-z", base, source.commit],
      { cwd: directory },
    );
    assert.deepEqual(
      changed.split("\0").filter(Boolean).sort(),
      ["README.md", ...agents, ...Object.keys(unheld)].sort(),
    );
  });
});

test("a run that died posts its figures and ends the attempt", async () => {
  const { calls, request } = planeCalls();
  const evidence = evidenceFor(request);
  evidence.observed({
    type: "result",
    subtype: "error_max_turns",
    num_turns: 3,
    total_cost_usd: 0.25,
  });

  await reportWorkerFailure(
    { task, bearer: "bearer", evidence, request },
    "Claude Code exited 1",
  );

  assert.deepEqual(
    calls.map(({ path }) => path),
    [
      "/v1/run/totals",
      "/v1/artifacts/.chuggy/worker-error.txt",
      "/v1/run/ended",
    ],
  );
  assert.equal(JSON.parse(calls[0].init.body).costUsdMicros, 250_000);
  assert.equal(JSON.parse(calls[0].init.body).turns, 3);
  assert.equal(
    JSON.parse(calls.at(-1).init.body).evidence,
    "RunTurnsExhausted",
  );
});

test("a run that died reports no verdict of its own", async () => {
  const { calls, request } = planeCalls();

  await reportWorkerFailure(
    { task, bearer: "bearer", evidence: evidenceFor(request), request },
    "worker failed",
  );

  assert.ok(!calls.some(({ path }) => path === "/v1/report"));
  assert.ok(
    !calls.some(({ init }) => String(init.body ?? "").includes('"Fail"')),
  );
});

test("an error text that cannot be uploaded still ends the attempt", async () => {
  const calls = [];
  const request = async (_task, _bearer, path, init) => {
    calls.push({ path, init });
    if (path.startsWith("/v1/artifacts/")) throw new Error("plane refused");
    return { ok: true, status: 204 };
  };

  await reportWorkerFailure(
    { task, bearer: "bearer", evidence: evidenceFor(request), request },
    "worker failed",
  );

  assert.equal(calls.at(-1).path, "/v1/run/ended");
});

test("the run's totals reach the plane before the report that settles the task", async () => {
  const { calls, request } = planeCalls();

  await published(calls, request, (text) => text);

  const paths = calls.map(({ path }) => path);
  assert.ok(paths.includes("/v1/run/totals"));
  assert.ok(paths.includes("/v1/report"));
  assert.ok(
    paths.indexOf("/v1/run/totals") < paths.indexOf("/v1/report"),
    `totals must precede the report, got ${paths.join(" ")}`,
  );
});

/**
 * One evaluation's run over the job plane's own tables, on a clock its
 * transport's pauses move, with the plane unreachable from `leave()` for
 * `awayMilliseconds`. `beat` and `flush` are the lease's and the recorder's
 * intervals, each a tick the case takes itself.
 */
function runOverAbsentPlane(awayMilliseconds) {
  const clock = pausedClock();
  const ticks = {};
  const warned = [];
  let left = Infinity;
  const plane = planeFetch(planes.job, (route) =>
    route === "runTurns"
      ? { status: 200, body: { turnsRecorded: 0 } }
      : { status: route === "report" ? 202 : 204 },
  );
  const request = (asked, bearer, path, init) =>
    workerRequest(asked, bearer, path, init, {
      fetch: async (url, sent) => {
        if (clock.now() >= left && clock.now() < left + awayMilliseconds)
          throw new TypeError("fetch failed");
        return plane.fetch(url, sent);
      },
      wait: clock.wait,
      now: clock.now,
    });
  const interval = (name) => (tick) => {
    ticks[name] = tick;
    return { unref: () => undefined };
  };
  const context = {
    task: { ...task, taskKind: "Evaluation" },
    bearer: "bearer",
    scrub: (text) => text,
    request,
    stopLease: keepWorkerLease(task, "bearer", {
      request,
      setInterval: interval("beat"),
      clearInterval: () => undefined,
    }),
    evidence: runEvidenceRecorder(task, "bearer", (text) => text, {
      request,
      setInterval: interval("flush"),
      clearInterval: () => undefined,
      warn: (text) => warned.push(text),
    }),
  };
  return {
    context,
    plane,
    warned,
    beat: () => ticks.beat(),
    flush: () => ticks.flush(),
    leave: () => {
      left = clock.now();
    },
    returned: () => clock.now() >= left + awayMilliseconds,
  };
}

/**
 * A plane away for less than a lease, across a heartbeat and a transcript
 * flush both asked while it was away. Catches a transport that gives up on
 * either while the lease still runs, which costs the run its report or the
 * rest of its transcript, and a recorder that drops what the agent wrote
 * while a flush waited.
 */
test("a run outlasts a plane away for less than a lease, and its report and whole transcript arrive", async () => {
  const awayMilliseconds = 120_000;
  assert.ok(awayMilliseconds < workerPlaneAwayMillisecondsMax);
  const run = runOverAbsentPlane(awayMilliseconds);
  const lines = Array.from({ length: 6 }, (_, turn) =>
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-test", usage: { input_tokens: turn + 1 } },
    }),
  );
  const write = (written) =>
    run.context.evidence.record(written, JSON.parse(written));

  lines.slice(0, 2).forEach(write);
  await run.flush();
  run.leave();
  lines.slice(2, 4).forEach(write);
  run.beat();
  const flushed = run.flush();
  lines.slice(4).forEach(write);
  await flushed;
  assert.ok(run.returned(), "the flush ended before the plane was back");
  await publishWorkerResult(
    run.context,
    {},
    {
      output: { checks: [] },
      result: { verdict: "Pass", summary: "the checks passed" },
      diagnosticPath: ".chuggy/check-output.json",
    },
  );

  const asked = (route) =>
    run.plane.asked.filter((request) => request.route === route);
  assert.deepEqual(run.warned, []);
  assert.equal(asked("heartbeat").length, 1);
  assert.equal(asked("report").length, 1);
  assert.equal(asked("report")[0].body.verdict, "Pass");
  assert.deepEqual(
    asked("runTranscript").map(({ path }) => path),
    asked("runTranscript").map(
      (_, sent) => `/v1/run/transcript/${String(sent + 1)}`,
    ),
  );
  assert.equal(
    asked("runTranscript")
      .map(({ body }) => Buffer.from(body).toString("utf8"))
      .join(""),
    lines.map((line) => `${line}\n`).join(""),
  );
  assert.deepEqual(
    asked("runTurns").flatMap(({ body }) =>
      body.turns.map(({ ordinal }) => ordinal),
    ),
    lines.map((_, turn) => turn + 1),
  );
});

test("the report summary and the diagnostic artifact are scrubbed", async () => {
  const { calls, request } = planeCalls();

  await published(calls, request, credentialScrub([secret]));

  const summary = JSON.parse(
    calls.find(({ path }) => path === "/v1/report").init.body,
  ).report;
  const diagnostic = calls
    .find(({ path }) => path.endsWith("agent-result.json"))
    .init.body.toString("utf8");
  assert.ok(!summary.includes(secret));
  assert.ok(summary.includes("[redacted credential]"));
  assert.ok(!diagnostic.includes(secret));
  assert.ok(diagnostic.includes("[redacted credential]"));
});

/** The report the plane was sent for an agent that finished with this summary. */
async function reportFor(summary, scrub = (text) => text) {
  const { calls, request } = planeCalls();
  await published(calls, request, scrub, {
    output: { type: "result", structured_output: { summary } },
    result: { verdict: "Pass", summary },
    diagnosticPath: ".chuggy/agent-result.json",
  });
  return JSON.parse(calls.find(({ path }) => path === "/v1/report").init.body)
    .report;
}

test("an agent's summary is reported well formed and without control characters", async () => {
  const escape = String.fromCodePoint(0x1b);
  const report = await reportFor(
    `${escape}[31mred${escape}[0m bell\u0007 del\u007f csi\u009b lone\ud800 end`,
  );

  assert.ok(report.isWellFormed(), JSON.stringify(report));
  assert.ok(!/\p{Cc}/u.test(report), JSON.stringify(report));
  assert.match(report, /red bell del csi lone\uFFFD end/u);
});

test("an agent's summary with nothing printable is reported as such", async () => {
  const report = await reportFor("\u0007\u009b \n\t");

  assert.equal(report, "the agent's summary held no printable text");
});

test("an agent's summary is scrubbed before its lines are joined", async () => {
  const spanning = "-----BEGIN KEY-----\nabcdefghijklmnop\n-----END KEY-----";
  const report = await reportFor(
    `the key was ${spanning}`,
    credentialScrub([spanning]),
  );

  assert.ok(!report.includes("abcdefghijklmnop"), report);
  assert.ok(report.includes("[redacted credential]"), report);
});

test("an agent's summary stays within a report when its scrub lengthens it", async () => {
  const short = "0123456789abcdef";
  const summary = short
    .repeat(Math.ceil(resultReportCharsMax / short.length))
    .slice(0, resultReportCharsMax);
  const report = await reportFor(summary, credentialScrub([short]));

  assert.ok(report.length <= resultReportCharsMax, String(report.length));
  assert.ok(report.startsWith("[redacted credential]"), report.slice(0, 40));
});

test("an agent's summary is cut to a report on a code point", async () => {
  const short = "0123456789abcdef";
  const redacted = "[redacted credential]";
  const filler = "x".repeat(resultReportCharsMax - redacted.length - 1);
  const report = await reportFor(
    `${short}${filler}\u{1F600}\u{1F600}`,
    credentialScrub([short]),
  );

  assert.ok(report.isWellFormed(), JSON.stringify(report.slice(-4)));
  assert.equal(report.length, resultReportCharsMax - 1);
});

/**
 * The run an agent's process leaves, the agent stood in for by a shell that
 * writes the one result event Claude Code ends with.
 */
function agentRun(summary, verdict = "Pass") {
  const ended = JSON.stringify({
    type: "result",
    structured_output: { verdict, summary },
  });
  return runWorkerTask({
    task,
    directory: process.cwd(),
    agentEnvironment: {},
    evidence: { observed: () => undefined, record: () => undefined },
    agent: {
      ...claudeAgent,
      executable: "/bin/sh",
      invocation: () => ["-c", 'printf "%s\\n" "$1"', "agent", ended],
    },
  });
}

/** Each artifact a finished run uploaded, in the order it was sent. */
function uploadedArtifacts(calls) {
  const route = "/v1/artifacts/";
  return calls
    .filter(({ path }) => path.startsWith(route))
    .map(({ path, init }) => ({
      path: path.slice(route.length),
      bytes: init.body.byteLength,
      text: init.body.toString("utf8"),
    }));
}

/** The summary a finished run kept as an output, or nothing where it kept none. */
function keptSummary(calls) {
  return uploadedArtifacts(calls).find(
    ({ path }) => path === ".chuggy/outputs/summary.md",
  );
}

/**
 * Catches a summary that reaches the plane only as the report's one line, which
 * is how a list of findings arrives as a paragraph.
 */
test("an agent's run keeps its summary as written beside its result", async () => {
  const summary = "Two findings:\n\n- `a.mjs` drops the lease\n- no retry\n";
  const { calls, request } = planeCalls();

  await published(calls, request, (text) => text, await agentRun(summary));

  const uploaded = uploadedArtifacts(calls);
  const sized = ({ path, bytes }) => ({ path, bytes });
  assert.deepEqual(
    uploaded.map(({ path }) => path),
    [".chuggy/agent-result.json", ".chuggy/outputs/summary.md"],
  );
  assert.equal(uploaded[1].text, summary);
  assert.deepEqual(
    JSON.parse(reportedBody(calls)).diagnostics.map(sized),
    uploaded.map(sized),
  );
});

/** Catches a summary kept for a pass alone, when a failed review's findings are what its reader came for. */
test("a failing agent's summary is kept as a passing one's is", async () => {
  const summary = "Fails:\n\n1. the lease is dropped\n";
  const { calls, request } = planeCalls();

  await published(
    calls,
    request,
    (text) => text,
    await agentRun(summary, "Fail"),
  );

  assert.equal(keptSummary(calls)?.text, summary);
  assert.equal(JSON.parse(reportedBody(calls)).verdict, "Fail");
});

test("an agent's summary is kept scrubbed, a credential spanning its lines included", async () => {
  const spanning = "-----BEGIN KEY-----\nabcdefghijklmnop\n-----END KEY-----";
  const { calls, request } = planeCalls();

  await published(
    calls,
    request,
    credentialScrub([secret, spanning]),
    await agentRun(`saw ${secret}\n\nand the key\n${spanning}\n`),
  );

  assert.equal(
    keptSummary(calls)?.text,
    "saw [redacted credential]\n\nand the key\n[redacted credential]\n",
  );
});

/**
 * A summary longer than one argument to the stand-in holds, so it is put on a
 * run the stand-in left. Catches a cut made before the scrub, which the
 * redaction then lengthens past the bound, and one that splits the astral
 * character across it.
 */
test("an agent's summary past what an output holds is kept cut on a code point", async () => {
  const short = "0123456789abcdef";
  const redacted = "[redacted credential]";
  const filler = "\u20ac".repeat(workerSummaryCharsMax - redacted.length - 1);
  const run = await agentRun("a summary the stand-in can carry");
  const { calls, request } = planeCalls();

  await published(calls, request, credentialScrub([short]), {
    ...run,
    result: { ...run.result, summary: `${short}${filler}\u{1F600}\u{1F600}` },
  });

  const kept = keptSummary(calls);
  assert.equal(kept?.text, `${redacted}${filler}`);
  assert.ok(kept.bytes <= runConfigurationBytesMax, String(kept.bytes));
});

test("an agent's summary with nothing printable is kept nowhere", async () => {
  const { calls, request } = planeCalls();

  await published(
    calls,
    request,
    (text) => text,
    await agentRun("\u0007\u009b \n\t"),
  );

  assert.deepEqual(
    uploadedArtifacts(calls).map(({ path }) => path),
    [".chuggy/agent-result.json"],
  );
  assert.equal(JSON.parse(reportedBody(calls)).diagnostics.length, 1);
});

/** Catches a report that lists a summary the plane never took. */
test("a summary the plane refuses fails the run before any report", async () => {
  const calls = [];
  const request = async (_task, _bearer, path, init) => {
    calls.push({ path, init });
    if (path.endsWith("summary.md")) throw new Error("plane refused");
    return { ok: true, status: 204 };
  };

  await assert.rejects(
    published(calls, request, (text) => text, await agentRun("done")),
    /plane refused/u,
  );

  assert.ok(!calls.some(({ path }) => path === "/v1/report"));
});

test("a task carrying commands runs them and never reaches for an agent", async () => {
  const context = {
    directory: process.cwd(),
    get agent() {
      throw new Error("the agent was consulted for a check stage");
    },
  };

  const run = await runWorkerTask(context, ["exit 2"]);

  assert.equal(run.diagnosticPath, ".chuggy/check-output.json");
  assert.equal(run.result.verdict, "Fail");
  assert.equal(run.result.summary, "exit 2 exited 2");
});

/**
 * The carrier is the mode and never the kind. Catches a commanded run resolved
 * from `taskKind`, which would send a work task to an agent that refuses it and
 * leave an evaluation the only thing commands can run.
 */
test("a work task's commands are what runs it, and no agent is asked for", async () => {
  const commanded = {
    ...task,
    taskKind: "Work",
    worker: { mode: { type: "Commands", commands: ["exit 0"] } },
  };
  const commands = workerCheckCommands(commanded);

  const run = await runWorkerTask(
    {
      task: commanded,
      directory: process.cwd(),
      get agent() {
        throw new Error("a commanded work task reached for an agent");
      },
    },
    commands,
  );

  assert.deepEqual(commands, ["exit 0"]);
  assert.equal(run.result.verdict, "Pass");
  assert.equal(run.diagnosticPath, ".chuggy/check-output.json");
});

test("a check stage's report is scrubbed with the context's own scrub before it is measured", async () => {
  const context = {
    directory: process.cwd(),
    scrub: credentialScrub([secret]),
    get agent() {
      throw new Error("the agent was consulted for a check stage");
    },
  };

  const run = await runWorkerTask(context, [`echo ${secret}; exit 1`]);

  assert.equal(run.result.verdict, "Fail");
  assert.ok(!run.result.summary.includes(secret), run.result.summary);
  assert.ok(run.result.summary.includes("[redacted credential]"));
});

test("a check stage's captured output is the run's own diagnostic artifact", async () => {
  const { calls, request } = planeCalls();

  await published(calls, request, credentialScrub([secret]), {
    output: {
      checks: [{ command: ".chug/tasks/ci.sh", exitStatus: 2, output: secret }],
    },
    result: { verdict: "Fail", summary: ".chug/tasks/ci.sh exited 2" },
    diagnosticPath: ".chuggy/check-output.json",
  });

  const uploaded = calls.find(({ path }) => path.endsWith("check-output.json"));
  assert.ok(uploaded, calls.map(({ path }) => path).join(" "));
  const body = uploaded.init.body.toString("utf8");
  assert.ok(!body.includes(secret));
  assert.ok(body.includes(".chug/tasks/ci.sh"));
  assert.equal(
    JSON.parse(calls.find(({ path }) => path === "/v1/report").init.body)
      .report,
    ".chug/tasks/ci.sh exited 2",
  );
});

test("a check stage keeps no summary beside its captured output", async () => {
  const { calls, request } = planeCalls();
  const run = await runWorkerTask({ directory: process.cwd() }, ["exit 0"]);

  await published(calls, request, (text) => text, run);

  assert.deepEqual(
    uploadedArtifacts(calls).map(({ path }) => path),
    [".chuggy/check-output.json"],
  );
  assert.equal(JSON.parse(reportedBody(calls)).diagnostics.length, 1);
});

test("the failure text a crashed run uploads is scrubbed", async () => {
  const { calls, request } = planeCalls();

  await reportWorkerFailure(
    {
      task,
      bearer: "bearer",
      evidence: evidenceFor(request),
      request,
      scrub: credentialScrub([secret]),
    },
    `Claude Code exited 1 with ${secret}`,
  );

  const uploaded = calls
    .find(({ path }) => path.endsWith("worker-error.txt"))
    .init.body.toString("utf8");
  assert.ok(!uploaded.includes(secret));
  assert.ok(uploaded.includes("[redacted credential]"));
});

test("a minted credential is what git is given, and the mount is never read", async () => {
  const { asked, kept, written, paths } = askedFor(
    { status: 200, ok: true, json: async () => minted },
    [],
  );

  const resolved = await workerCredential(asked);

  assert.deepEqual(paths, [workerCredentialPath]);
  assert.equal(resolved.repository, repositories["repository-1"].url);
  assert.equal(
    resolved.environment.CHUG_WORKER_GIT_CREDENTIAL_FILE,
    written[0].file,
  );
  assert.equal(written[0].content, minted.password);
  assert.equal(
    resolved.environment.CHUG_WORKER_GIT_CREDENTIAL_USERNAME,
    minted.username,
  );
  assert.notEqual(
    resolved.environment.CHUG_WORKER_GIT_CREDENTIAL_FILE,
    credentialFiles.forge,
  );
  assert.deepEqual(kept, [{ kind: mintedKind, value: minted.password }]);
});

test("a minted repository the site names no map for is cloned at its own id", async () => {
  const { asked } = askedFor(
    { status: 200, ok: true, json: async () => minted },
    [],
  );

  const resolved = await workerCredential({
    ...asked,
    repositories: {},
    repositoryId: "https://github.com/kasofsk/chuggy.git",
  });

  assert.equal(resolved.repository, "https://github.com/kasofsk/chuggy.git");
});

test("a mounted repository the site names no map for is still refused", async () => {
  const { asked } = askedFor({
    status: 404,
    json: async () => ({ reason: "ForgeNotConfigured" }),
  });

  await assert.rejects(
    workerCredential({
      ...asked,
      repositories: {},
      repositoryId: "https://github.com/kasofsk/chuggy.git",
    }),
    /no repository configuration for https:\/\/github.com\/kasofsk\/chuggy.git/u,
  );
});

test("a plane that mints nothing leaves the launcher's mount answering", async () => {
  const { asked, kept, written } = askedFor({
    status: 404,
    json: async () => ({ reason: "ForgeNotConfigured" }),
  });

  const resolved = await workerCredential(asked);

  assert.equal(resolved.repository, repositories["repository-1"].url);
  assert.equal(
    resolved.environment.CHUG_WORKER_GIT_CREDENTIAL_FILE,
    credentialFiles.forge,
  );
  assert.equal(resolved.refresh, undefined);
  assert.deepEqual(written, []);
  assert.deepEqual(kept, []);
});

test("the mounted credential is still one the attempt's authority grants", async () => {
  const { asked } = askedFor(
    { status: 404, json: async () => ({ reason: "ForgeNotConfigured" }) },
    ["claude-code"],
  );

  await assert.rejects(
    workerCredential(asked),
    /worker authority does not grant forge/u,
  );
});

test("the push takes a fresh mint rather than the one the clone used", async () => {
  const later = "ghs_zyxwvutsrqponmlkjihgfedcba9876543210";
  let mints = 0;
  const { asked, kept } = askedFor(() => {
    mints += 1;
    return {
      status: 200,
      ok: true,
      json: async () => (mints === 1 ? minted : { ...minted, password: later }),
    };
  });

  const resolved = await workerCredential(asked);
  const refreshed = await resolved.refresh();

  assert.equal(mints, 2);
  assert.equal(refreshed.CHUG_WORKER_GIT_CREDENTIAL_USERNAME, minted.username);
  assert.deepEqual(kept, [
    { kind: mintedKind, value: minted.password },
    { kind: mintedKind, value: later },
  ]);
});

test("an outage at the clone fails the attempt rather than falling back", async () => {
  const { asked, written } = askedFor({
    status: 503,
    json: async () => ({ action: "retry" }),
  });

  await assert.rejects(
    workerCredential(asked),
    /answered 503 for a credential/u,
  );
  assert.deepEqual(written, []);
});

/**
 * One attempt's workspace, over a plane answering the input bundle and then the
 * mint. `clone` stands in for git, the directory it would have made being all
 * the workspace carries of it.
 */
function workspaceFrom(mint) {
  const asks = [];
  return workerWorkspace(
    { ...task, authority: { credentials: ["forge"] } },
    repositories,
    credentialFiles,
    "capability",
    () => undefined,
    {
      request: async (_task, _bearer, path) => {
        asks.push(path);
        if (path !== "/v1/input") return mint;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            references: [
              { kind: "Repository", reference: "repository-1" },
              { kind: "TargetCommit", reference: "0".repeat(40) },
            ],
          }),
        };
      },
      clone: async () => "/workspace/repository",
      write: async () => undefined,
    },
  );
}

test("a workspace the plane minted for carries the refresh its push takes", async () => {
  process.env[workerWorkspaceVariable] = "/workspace";

  const workspace = await workspaceFrom({
    status: 200,
    ok: true,
    json: async () => minted,
  });

  assert.equal(typeof workspace.refresh, "function");
  assert.equal(
    workspace.environment.CHUG_WORKER_GIT_CREDENTIAL_USERNAME,
    minted.username,
  );
});

test("a workspace the launcher's mount answered carries no refresh", async () => {
  process.env[workerWorkspaceVariable] = "/workspace";

  const workspace = await workspaceFrom({
    status: 404,
    json: async () => ({ reason: "ForgeNotConfigured" }),
  });

  assert.equal(workspace.refresh, undefined);
  assert.equal(
    workspace.environment.CHUG_WORKER_GIT_CREDENTIAL_FILE,
    credentialFiles.forge,
  );
});

/** The attempt every work case below publishes, and the branch its push names. */
const workAttempt = { taskKind: "Work", ticket: 7, attempt: "attempt-1" };
const workCommit = "a".repeat(40);
const pushCredential = { CHUG_WORKER_GIT_CREDENTIAL_FILE: "/minted/at-push" };

/** The two carriers a work attempt can have run under. */
const commandedWorker = {
  mode: { type: "Commands", commands: [".chug/tasks/ci.sh"] },
};
const agentWorker = {
  mode: { type: "SingleAgent", agent: "Claude", arguments: [] },
};

/**
 * One finished work attempt reaching the plane, with git stood in for by a
 * recorder: what the push would have run, and what the report carried.
 */
async function workPublished(worker, run) {
  const runs = [];
  const { calls, request } = planeCalls();
  await publishWorkerResult(
    {
      task: { ...task, ...workAttempt, worker },
      bearer: "bearer",
      evidence: evidenceFor(request),
      scrub: (text) => text,
      stopLease: async () => calls.push({ path: "lease/stopped" }),
      request,
      held: () => [],
      command: async (executable, args, options) => {
        runs.push({ executable, args, options });
        return { stdout: `${workCommit}\n` };
      },
    },
    {
      repositoryId: "repository-1",
      repository: repositories["repository-1"].url,
      base: "0".repeat(40),
      directory: "/workspace/repository",
      environment: { CHUG_WORKER_GIT_CREDENTIAL_FILE: "/minted/at-clone" },
      refresh: async () => pushCredential,
    },
    run,
  );
  return { runs, reported: JSON.parse(reportedBody(calls)) };
}

function reportedBody(calls) {
  return calls.find(({ path }) => path === "/v1/report").init.body;
}

/** The one git invocation of a verb the attempt made, and a legible miss where it made none. */
function gitRun(runs, verb) {
  const ran = runs.find(({ args }) => args[0] === verb);
  assert.ok(ran, `the attempt ran no git ${verb}`);
  return ran;
}

/** What a commanded stage hands the publisher, its exit status being its verdict. */
function commandedRun(exitStatus) {
  return {
    output: { checks: [{ command: ".chug/tasks/ci.sh", exitStatus }] },
    result: {
      verdict: exitStatus === 0 ? "Pass" : "Fail",
      summary: `.chug/tasks/ci.sh exited ${String(exitStatus)}`,
    },
    diagnosticPath: ".chuggy/check-output.json",
  };
}

test("a passing work attempt pushes under the credential its workspace refreshes", async () => {
  const { runs } = await workPublished(agentWorker, {
    output: { type: "result", structured_output: { summary: "done" } },
    result: { verdict: "Pass", summary: "the attempt passed" },
    diagnosticPath: ".chuggy/agent-result.json",
  });

  assert.deepEqual(gitRun(runs, "push").options.env, pushCredential);
});

/**
 * A commanded work attempt leaves the same candidate an agent's would. Catches a
 * push keyed on what ran rather than on the task's kind and verdict, and a
 * commit that stopped being `--allow-empty` or stopped naming the attempt.
 */
test("a passing commanded work attempt commits and pushes what it declares", async () => {
  const { runs, reported } = await workPublished(
    commandedWorker,
    commandedRun(0),
  );

  assert.deepEqual(gitRun(runs, "commit").args, [
    "commit",
    "--allow-empty",
    "-m",
    "ticket 7 attempt attempt-1",
  ]);
  const push = gitRun(runs, "push");
  assert.deepEqual(push.args, [
    "push",
    repositories["repository-1"].url,
    `${workCommit}:${ticketBranch(workAttempt)}`,
  ]);
  assert.deepEqual(push.options.env, pushCredential);
  assert.deepEqual(reported.source, {
    repository: "repository-1",
    ref: ticketBranch(workAttempt),
    commit: workCommit,
    base: "0".repeat(40),
  });
});

/**
 * The commands' exit status is the work's success, and a failed one leaves
 * nothing behind. Catches a push that stopped reading the verdict: the plane
 * refuses a source on a Fail, so the attempt would crash rather than fail.
 */
test("a failing commanded work attempt pushes nothing and declares no source", async () => {
  const { runs, reported } = await workPublished(
    commandedWorker,
    commandedRun(1),
  );

  assert.deepEqual(runs, []);
  assert.equal(reported.verdict, "Fail");
  assert.equal(reported.source, undefined);
});

/**
 * A passing work attempt published from a real checkout under `run`'s secrets,
 * what its push was refused with, and every call the plane saw.
 */
async function passedFrom({ remote, directory, base }, run, bearer) {
  const { calls, request } = planeCalls();
  const refused = await publishWorkerResult(
    {
      task: { ...task, ...workAttempt, worker: {} },
      bearer,
      evidence: evidenceFor(request),
      scrub: run.scrub,
      held: run.held,
      stopLease: async () => undefined,
      request,
    },
    {
      repositoryId: "repository-1",
      repository: remote,
      base,
      directory,
      environment: process.env,
    },
    {
      output: {},
      result: { verdict: "Pass", summary: "done" },
      diagnosticPath: ".chuggy/agent-result.json",
    },
  ).then(
    () => new Error("pushed"),
    (error) => error,
  );
  return { refused, calls };
}

/**
 * Each kind of secret a work attempt holds is one its push is checked for, and
 * the kind is what the refusal names: the agent's credential, the bearer, what
 * the launcher mounted and what the plane minted. Catches a secret the run's
 * scrub holds and its push is never checked for, a refusal that prints the
 * value it found, and a refused push reported as the attempt's source.
 */
test("a passing work attempt pushes no commit carrying any secret it holds", async () => {
  const root = await mkdtemp(join(tmpdir(), "chuggy-held-"));
  try {
    const bearer = "bearer-0123456789abcdefghijklmn";
    const forge = "forge-0123456789abcdefghijklmno";
    const agentFile = join(root, "claude-code");
    const forgeFile = join(root, "forge");
    await writeFile(agentFile, `${secret}\n`);
    await writeFile(forgeFile, `${forge}\n`);
    const run = await workerRun({
      task,
      bearer,
      credentialFiles: { "claude-code": agentFile },
      mounted: [agentFile, forgeFile],
      agent: claudeAgent,
    });
    run.evidence.stop();
    const { asked } = askedFor(
      { status: 200, ok: true, json: async () => minted },
      [],
    );
    await workerCredential({ ...asked, keepSecret: run.keepSecret });
    const expected = [
      { kind: "the Claude Code credential", value: secret },
      { kind: "the attempt's bearer", value: bearer },
      { kind: "a credential the launcher mounted", value: forge },
      { kind: mintedKind, value: minted.password },
    ];
    assert.deepEqual(run.held(), expected);

    for (const held of expected)
      await inCheckout(async (checkout) => {
        await writeFile(join(checkout.directory, "leaked"), held.value);

        const { refused, calls } = await passedFrom(checkout, run, bearer);

        assert.match(
          refused.message,
          new RegExp(
            `^commit [0-9a-f]{40} carries ${held.kind} in a file, so the attempt pushes nothing$`,
            "u",
          ),
        );
        assert.ok(!refused.message.includes(held.value));
        assert.equal(await remoteRefs(checkout.remote), "");
        assert.ok(!calls.some(({ path }) => path === "/v1/report"));
      });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The push a whole attempt makes is checked against what that attempt holds.
 * A commanded work attempt, launched from an envelope mounting the Claude
 * credential, copies that credential into its checkout: its commit is refused,
 * the attempt fails, and neither the remote nor the report hears of it.
 * Catches an attempt handing its push anything but the run's own secrets.
 */
test("a work attempt whose commit carries its Claude credential fails and pushes nothing", async () => {
  await inCheckout(async ({ remote, directory, base }) => {
    const root = await mkdtemp(join(tmpdir(), "chuggy-attempt-"));
    const providerCredentialFile = join(root, "claude-code");
    await writeFile(providerCredentialFile, `${secret}\n`);
    const plane = await servedPlane((route) => {
      switch (route) {
        case "task":
          return commandedTask([`cp ${providerCredentialFile} leaked`]);
        case "input":
          return inputAnswer(remote, base);
        case "credential":
          return {
            status: 200,
            body: { ...minted, expiresAtMs: 1_900_000_000_000 },
          };
        default:
          return { status: 204 };
      }
    });
    try {
      const served = {
        ...envelope,
        callbackUrl: plane.url,
        providerCredentialFile,
      };
      const { task } = await envelopeTask(served);
      const failed = await workerAttempt(envelopeLaunch(served, task), {
        minted: root,
        write: async () => undefined,
        clone: async () => directory,
      }).then(
        () => new Error("pushed"),
        (error) => error,
      );

      assert.match(
        failed.message,
        /^commit [0-9a-f]{40} carries a credential the launcher mounted in a file, so the attempt pushes nothing$/u,
      );
      assert.ok(!failed.message.includes(secret));
      assert.equal(await remoteRefs(remote), "");
      assert.ok(!plane.asked.some(({ route }) => route === "report"));
    } finally {
      await plane.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("a plane that stops minting mid-attempt fails it rather than pushing with a mount", async () => {
  let mints = 0;
  const { asked } = askedFor(() => {
    mints += 1;
    return mints === 1
      ? { status: 200, ok: true, json: async () => minted }
      : { status: 404, json: async () => ({ reason: "NotMinted" }) };
  });

  const resolved = await workerCredential(asked);

  await assert.rejects(resolved.refresh(), /mints no credential to push with/u);
});
