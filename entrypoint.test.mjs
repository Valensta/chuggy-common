import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { TextDecoder } from "node:util";

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
  workerPlaneUploadBytesMax,
} from "@chuggy/worker-contract/workerPlane";
import { workTaskAnswerSchema } from "@chuggy/worker-contract/workerTask";

import {
  git,
  handedAsTheImage,
  inCheckout,
  recordingGit,
  remoteRefs,
  setupPassedVariable,
} from "./checkout.fixture.mjs";
import {
  workerAgentEnvironment,
  workerChangeBaseVariable,
  workerCheckCommands,
  workerEnvironmentWithout,
  workerImageVariable,
  workerJobVariables,
  workerSetupEnvironmentVariable,
  workerSummaryCharsMax,
} from "./checks.mjs";
import {
  claudeAgent,
  claudeEnvironment,
  prepareClaudeShell,
} from "./claude.mjs";
import { claudeCredentialVariable } from "./claudeCredential.mjs";
import {
  decidingFor,
  strayEnvironment,
  strayLeftFor,
} from "./claudeCredential.fixture.mjs";
import { pausedClock } from "./clock.fixture.mjs";
import {
  cloneRepository,
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
  workerWorkspace,
} from "./entrypoint.mjs";
import {
  envelope,
  fetchedAnswer,
  poolHeldSessionAnswer,
} from "./envelope.fixture.mjs";
import {
  forgeGitIsolated,
  forgeServed,
  forgeServices,
} from "./gitForge.fixture.mjs";
import { keepWorkerLease } from "./lease.mjs";
import { overPlane, planeFetch, planes } from "./plane.fixture.mjs";
import { agentResultSchema } from "./result.mjs";
import { workerCredentialPath } from "./planeCredential.mjs";
import { gitRemotePauseMs, gitRemoteTriesMax } from "./gitRemote.mjs";
import {
  RunStepFailure,
  credentialScrub,
  runCloneFailed,
  runEvidenceRecorder,
  runPushFailed,
  runSetupFailed,
} from "./runEvidence.mjs";
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
 * and what the pod is authorized to mount if it does not; `named` is the
 * repository each ask named, nothing where it named none.
 */
function askedFor(answer, credentials = ["forge"]) {
  const kept = [];
  const written = [];
  const paths = [];
  const named = [];
  return {
    kept,
    written,
    paths,
    named,
    asked: {
      task: { ...task, authority: { credentials } },
      bearer: "capability",
      repositories,
      credentialFiles,
      repositoryId: "repository-1",
      keepSecret: (secret) => kept.push(secret),
      request: async (_task, _bearer, path, init) => {
        paths.push(path);
        named.push(
          init?.body === undefined
            ? undefined
            : JSON.parse(init.body).repository,
        );
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

/** The directory this suite and the core it holds to are in. */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * One pod launched as the image launches it, which is the only way into the
 * environment `main` reads: it is not exported, and nothing imports it.
 * `minted`, where given, is the directory it finds in place of the contract's
 * minted credential directory, which no machine a suite runs on mounts; and
 * `core` the directory its modules are run from.
 */
function launched(environment, minted, core = here) {
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
      [...redirected, join(core, "entrypoint.mjs")],
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
 * crashed run's report, as its clone step's, when there is none.
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
    assert.deepEqual(plane.requests.at(-1)?.body, {
      evidence: runCloneFailed,
    });
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
 * A job its runner started on its host mints into its own directory, so one
 * there runs on as a pod with the contract's directory mounted does, and one
 * missing is named where the core looked. Catches a host job checked at the
 * contract's path, which no host has.
 */
test("a job run on its runner's host finds its minted credential directory in its own", async () => {
  const plane = await commandedPlane();
  const directory = await mkdtemp(join(tmpdir(), "chuggy-host-job-"));
  try {
    const job = {
      [workerTaskVariable]: JSON.stringify({
        ...envelope,
        callbackUrl: plane.url,
      }),
      CHUGGY_HOST_JOB: directory,
    };
    const missing = await launched(job);
    assert.equal(missing.code, 1);
    assert.ok(
      missing.stderr.includes(
        `the minted credential directory ${join(directory, "minted")} does not exist`,
      ),
      missing.stderr,
    );

    plane.asked.splice(0);
    await mkdir(join(directory, "minted"));
    const ran = await launched(job);
    assert.equal(ran.code, 1);
    assert.match(
      ran.stderr,
      /^no repository configuration for repository-1$/mu,
    );
    assert.deepEqual(
      plane.asked.map(({ route }) => route),
      ["task", "input", "credential", "runTotals", "artifact", "runEnded"],
    );
  } finally {
    await plane.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/** Catches a session run on a host, which its pinned image says it never is. */
test("a session's envelope on its runner's host is refused before the session opens", async () => {
  const plane = await servedPlane(
    (route) =>
      route === "task"
        ? { status: 200, body: poolHeldSessionAnswer }
        : { status: 200, body: facts },
    poolHeldSessionWire,
  );
  const directory = await mkdtemp(join(tmpdir(), "chuggy-host-job-"));
  try {
    const ran = await launched({
      [workerTaskVariable]: JSON.stringify({
        ...envelope,
        callbackUrl: plane.url,
      }),
      CHUGGY_HOST_JOB: directory,
    });
    assert.equal(ran.code, 1);
    assert.match(
      ran.stderr,
      /^a session runs in a container, never on its runner's host$/mu,
    );
    assert.deepEqual(
      plane.asked.map(({ route }) => route),
      ["task"],
    );
  } finally {
    await plane.close();
    await rm(directory, { recursive: true, force: true });
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
      (failure) =>
        failure instanceof RunStepFailure &&
        failure.evidence === runCloneFailed &&
        failure.message === "cloned",
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

/** How a setup line names the file it passes variables on in. */
const setupFile = `"$${workerSetupEnvironmentVariable}"`;

/**
 * Catches what a setup line writes to its file not reaching the lines after
 * it, or reaching them as written rather than as the later value; a line
 * handed a file an earlier line wrote to; and the files left behind.
 */
test("a setup line passes on what it writes to its file to the lines after it", async () => {
  await inCheckout(async ({ directory }) => {
    const files = join(directory, "files");
    const recordsFile = `printf "%s\\n" ${setupFile} >> '${files}'`;

    const passed = await prepareWorker(
      {
        worker: {
          setup: [
            `printf 'FIRST=one\\nLINES<<EOF\\ntwo\\nlines\\nEOF\\n' >> ${setupFile}; ${recordsFile}`,
            `echo FIRST=again >> ${setupFile}; ${recordsFile}`,
            `printf "%s|%s|%s" "$FIRST" "$LINES" "$(wc -c < ${setupFile} | tr -d ' ')" > seen; ${recordsFile}`,
          ],
        },
      },
      directory,
    );

    assert.deepEqual(passed, { FIRST: "again", LINES: "two\nlines" });
    assert.equal(
      await readFile(join(directory, "seen"), "utf8"),
      "again|two\nlines|0",
    );
    const handed = (await readFile(files, "utf8")).trim().split("\n");
    assert.equal(new Set(handed).size, 3);
    for (const file of handed)
      await assert.rejects(stat(file), { code: "ENOENT" }, file);
  });
});

/**
 * Catches a line passing on a name of chuggy's ending the run as anything but
 * the setup step, carrying on to the lines after it, or printing the value it
 * set, which nothing scrubs; and its file left behind.
 */
test("a setup line that passes on a name of chuggy's fails the setup step, naming the line and the name and never the value", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const temporary = await mkdtemp(join(tmpdir(), "chuggy-temporary-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  podHolds(t, { TMPDIR: temporary });
  const setup = `printf '${workerJobVariables.stage}=%s%s\\n' hid den >> ${setupFile}`;

  const failed = await prepareWorker(
    { worker: { setup: ["true", setup, "touch after"] } },
    directory,
  ).catch((failure) => failure);

  assert.ok(failed instanceof RunStepFailure);
  assert.equal(failed.evidence, runSetupFailed);
  assert.equal(
    failed.message.split("\n")[0],
    `${setup} passed on what setup may not`,
  );
  assert.match(
    failed.message,
    new RegExp(`sets ${workerJobVariables.stage}, which is chuggy's`, "u"),
  );
  assert.ok(!failed.message.includes("hidden"));
  await assert.rejects(readFile(join(directory, "after")), {
    code: "ENOENT",
  });
  assert.deepEqual(await readdir(temporary), []);
});

/**
 * Catches a failing setup line ending the run as anything but the setup step,
 * or named by anything but the line itself: its text leads with the line and
 * how it exited, and what it wrote follows.
 */
test("a setup line that fails fails the setup step, named by the line and its exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-setup-"));
  try {
    const setup = "echo the lockfile is stale >&2; exit 3";
    const failed = await prepareWorker(
      { worker: { setup: ["true", setup, "touch after"] } },
      directory,
    ).catch((failure) => failure);

    assert.ok(failed instanceof RunStepFailure);
    assert.equal(failed.evidence, runSetupFailed);
    assert.equal(failed.message.split("\n")[0], `${setup} exited 3`);
    assert.match(failed.message, /the lockfile is stale/u);
    await assert.rejects(readFile(join(directory, "after")), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a file setup cannot write fails the setup step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-setup-"));
  try {
    await writeFile(join(directory, "CLAUDE.md"), "the repository's own\n");
    const failed = await prepareWorker(
      { worker: { files: [{ path: "CLAUDE.md", content: "provisioned\n" }] } },
      directory,
    ).catch((failure) => failure);

    assert.equal(failed.evidence, runSetupFailed);
    assert.match(failed.message, /EEXIST/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * A clone through a stand-in git: each clone fails in turn as `clones` says,
 * after leaving the directory it was cloning into, and then succeeds. What the
 * clone answered or threw, and each git asked with whether its directory was
 * there.
 */
async function clonedThrough(clones) {
  const workspace = await mkdtemp(join(tmpdir(), "chuggy-clone-"));
  const asked = [];
  const pauses = [];
  let tries = 0;
  try {
    const outcome = await cloneRepository(
      "https://git.test/rig.git",
      "0".repeat(40),
      workspace,
      {},
      {
        run: async (_executable, args, options) => {
          const into = args[0] === "clone" ? args.at(-1) : options.cwd;
          const there = await stat(into).then(
            () => true,
            () => false,
          );
          asked.push({ verb: args[0], there });
          if (args[0] !== "clone") return { stdout: "" };
          tries += 1;
          await mkdir(into, { recursive: true });
          await writeFile(join(into, "partial"), "");
          if (clones[tries - 1] !== undefined) throw clones[tries - 1];
          return { stdout: "" };
        },
        pause: async (ms) => {
          pauses.push(ms);
        },
      },
    ).catch((failure) => failure);
    return { outcome, asked, pauses };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** A git child that failed, writing `stderr`, as `execFile` rejects with it. */
function gitFailed(stderr) {
  return Object.assign(new Error(`Command failed: git clone\n${stderr}`), {
    code: 128,
    stderr,
  });
}

/**
 * Catches a clone tried again over what the failed one left, which git
 * refuses, and a checkout tried more than once.
 */
test("a clone the forge failed is tried again from an empty directory, and checked out once", async () => {
  const { outcome, asked, pauses } = await clonedThrough([
    gitFailed(
      "fatal: unable to access 'https://git.test/rig.git/': The requested URL returned error: 503\n",
    ),
  ]);

  assert.equal(typeof outcome, "string");
  assert.deepEqual(asked, [
    { verb: "clone", there: false },
    { verb: "clone", there: false },
    { verb: "checkout", there: true },
  ]);
  assert.deepEqual(pauses, [gitRemotePauseMs]);
});

test("a clone the forge refused is tried once", async () => {
  const refused = gitFailed(
    "remote: Repository not found.\nfatal: unable to access 'https://git.test/rig.git/': The requested URL returned error: 404\n",
  );
  const { outcome, asked } = await clonedThrough([refused]);

  assert.equal(outcome, refused);
  assert.deepEqual(
    asked.map(({ verb }) => verb),
    ["clone"],
  );
});

test("a clone the forge never answers is tried to the bound and checked out never", async () => {
  const failures = Array.from({ length: gitRemoteTriesMax }, () =>
    gitFailed(
      "fatal: unable to access 'https://git.test/rig.git/': Could not resolve host: git.test\n",
    ),
  );
  const { outcome, asked } = await clonedThrough(failures);

  assert.equal(outcome, failures.at(-1));
  assert.deepEqual(
    asked.map(({ verb }) => verb),
    Array.from({ length: gitRemoteTriesMax }, () => "clone"),
  );
});

/** A shell line that prints what its stage told it of the change's base, or `unset`. */
const printsChangeBase = `printf "%s" "\${${workerChangeBaseVariable}-unset}"`;

/**
 * One commanded attempt at `answered` run whole in a real checkout, over a
 * plane answering its input as the repository, the checkout's own commit, and
 * whatever `references` names given that commit; and what `prints` printed in
 * its setup line, run after the lines `setUpFirst`, and in its command, which
 * then fails, so nothing is pushed. The pod holds a base of its own
 * throughout, which no run may pass on.
 */
async function attemptPrinted(
  answered,
  prints,
  references = () => [],
  setUpFirst = [],
) {
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
                ...answered,
                worker: {
                  mode: {
                    type: "Commands",
                    commands: [`${prints} > told; false`],
                  },
                  setup: [...setUpFirst, `${prints} > set-up`],
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

/** What a commanded evaluation's setup line and command were told of the change's base. */
function evaluationPrinted(references) {
  return attemptPrinted(
    { ...fetchedAnswer, taskKind: "Evaluation" },
    printsChangeBase,
    references,
  );
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

/** A shell line that prints what its job was told of which job it is in, each `unset` where nothing was. */
const printsJob = `printf "%s|" ${Object.values(workerJobVariables)
  .map((name) => `"\${${name}-unset}"`)
  .join(" ")}`;

/** A work task as the task route answers one, which numbers no stage. */
const workAnswered = Object.fromEntries(
  Object.entries(fetchedAnswer).filter(([field]) => field !== "stage"),
);

/**
 * Catches a job's setup lines or its commands not told which job they are in,
 * told it as the pod held it, or told a stage other than the key a
 * configuration names it by: a work task's, and an evaluation's counted from
 * one where its document counts from zero; or told the mirror a site clones
 * the repository from rather than the repository its bundle names.
 */
test("a job's setup lines and commands are told which job they are in", async (t) => {
  podHolds(t, {
    ...Object.fromEntries(
      Object.values(workerJobVariables).map((name) => [name, "the pod's"]),
    ),
    [workerRepositoriesVariable]: JSON.stringify({
      "repository-1": { url: "https://mirror.test/repository-1.git" },
    }),
  });
  const told = (stage) => ({
    printed: `tenant-1|project-1|repository-1|7|attempt-1|${stage}|`,
    setUp: `tenant-1|project-1|repository-1|7|attempt-1|${stage}|`,
  });

  assert.deepEqual(await attemptPrinted(workAnswered, printsJob), told("Work"));
  assert.deepEqual(
    await attemptPrinted(
      { ...workAnswered, taskKind: "Evaluation", stage: 1 },
      printsJob,
    ),
    told("Evaluation:2"),
  );
});

/**
 * Catches what a job's setup passed on not reaching its commands, and the
 * file a setup line passes variables on in reaching them, where a command
 * writing to it would be writing to what nothing reads.
 */
test("what a job's setup passes on reaches its commands, and its setup file does not", async () => {
  const prints = `printf "%s|%s" "\${PASSED-unset}" "\${${workerSetupEnvironmentVariable}:+set}"`;

  assert.deepEqual(
    await attemptPrinted(workAnswered, prints, () => [], [
      `echo PASSED=on >> ${setupFile}`,
    ]),
    { printed: "on|", setUp: "on|set" },
  );
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

/** Catches a workspace that drops the images its bundle pins, or names some where it pins none. */
test("a workspace carries the images its bundle pins, and none where it pins none", async () => {
  const pinning = await workspaceNaming(() => [
    briefImage.reference,
    { ordinal: 4, kind: "ProjectArtifact", reference: "image/gif:two" },
  ]);
  const pinningNone = await workspaceNaming(() => []);

  assert.deepEqual(pinning.images, [
    briefImage.reference,
    { ordinal: 4, kind: "ProjectArtifact", reference: "image/gif:two" },
  ]);
  assert.ok(!Object.hasOwn(pinningNone, "images"));
});

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

test("a run stopped at a step ends under that step's label", async () => {
  const { calls, request } = planeCalls();
  const evidence = evidenceFor(request);
  evidence.observed({ type: "result", subtype: "error_max_turns" });

  await reportWorkerFailure(
    { task, bearer: "bearer", evidence, request, step: runPushFailed },
    "the push failed",
  );

  assert.equal(calls.at(-1).path, "/v1/run/ended");
  assert.equal(JSON.parse(calls.at(-1).init.body).evidence, runPushFailed);
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

/** The error text one failure report uploads, as the bytes the plane is sent. */
async function uploadedError(message, scrub) {
  const { calls, request } = planeCalls();
  await reportWorkerFailure(
    {
      task,
      bearer: "bearer",
      evidence: evidenceFor(request),
      request,
      ...(scrub === undefined ? {} : { scrub }),
    },
    message,
  );
  const uploaded = calls.find(({ path }) =>
    path.endsWith("/.chuggy/worker-error.txt"),
  );
  return Buffer.from(uploaded.init.body);
}

/** The count an error text cut to fit says was dropped before its end, and that end. */
function droppedBefore(uploaded) {
  const text = uploaded.toString("utf8");
  const [first, ...rest] = text.split("\n");
  const dropped =
    /^The first (\d+) bytes of this error text were dropped; what follows is its end\.$/u.exec(
      first,
    );
  assert.ok(dropped !== null, first.slice(0, 200));
  return { dropped: Number(dropped[1]), end: rest.join("\n") };
}

test("an error text within the upload bound is uploaded whole", async () => {
  const message = "x".repeat(workerPlaneUploadBytesMax - 1);

  const uploaded = await uploadedError(message);

  assert.equal(uploaded.toString("utf8"), `${message}\n`);
});

test("an error text past the upload bound keeps its end, after a first line saying how many bytes before it were dropped", async () => {
  const message = `${"head ".repeat(1_000_000)}the line that says why`;
  const whole = Buffer.byteLength(`${message}\n`);
  assert.ok(whole > workerPlaneUploadBytesMax);

  const uploaded = await uploadedError(message);

  assert.ok(uploaded.byteLength <= workerPlaneUploadBytesMax);
  const { dropped, end } = droppedBefore(uploaded);
  assert.ok(end.endsWith("the line that says why\n"));
  assert.equal(dropped + Buffer.byteLength(end), whole);
  assert.ok(`${message}\n`.endsWith(end));
});

test("an error text is scrubbed whole before it is cut, so a secret the cut falls inside is never half kept", async () => {
  const held = `chuggy-held-${"0123456789abcdef".repeat(64)}`;
  const kept = workerPlaneUploadBytesMax - held.length / 2;
  const message = `${"x".repeat(100_000)}${held}${"y".repeat(kept)}`;
  const cut = Buffer.byteLength(`${message}\n`) - workerPlaneUploadBytesMax;
  assert.ok(cut > 100_000 && cut < 100_000 + held.length);

  const uploaded = (
    await uploadedError(message, credentialScrub([held]))
  ).toString("utf8");

  for (let at = 0; at + 16 <= held.length; at += 16)
    assert.ok(
      !uploaded.includes(held.slice(at, at + 16)),
      `the secret's bytes at ${String(at)} were uploaded`,
    );
});

test("an error text is cut where a character starts, so what is uploaded is UTF-8", async () => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let pad = 0; pad < 4; pad += 1) {
    const message = `${"x".repeat(pad)}${"\u{1F600}".repeat(workerPlaneUploadBytesMax / 4 + 1_000)}`;

    const uploaded = await uploadedError(message);

    assert.ok(uploaded.byteLength <= workerPlaneUploadBytesMax, String(pad));
    const { dropped, end } = droppedBefore(uploaded);
    assert.doesNotThrow(() => decoder.decode(uploaded), String(pad));
    assert.equal(
      dropped + Buffer.byteLength(end),
      Buffer.byteLength(`${message}\n`),
      String(pad),
    );
  }
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
 * writes the one result event Claude Code ends with, its shell prepared with
 * nothing: Claude's own would write under this machine's HOME.
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
      prepareShell: async () => ({ environment: {}, arguments: [] }),
      invocation: () => ["-c", 'printf "%s\\n" "$1"', "agent", ended],
    },
  });
}

/**
 * Sets each of `variables` in this process's environment until `t` ends, and
 * unsets each whose value is `undefined`.
 */
function podHolds(t, variables) {
  const saved = Object.fromEntries(
    Object.keys(variables).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(variables))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
}

/**
 * Catches an agent started without what its shell was prepared with, with a
 * name `check.sh` kept the image's value under, with the task document, the
 * change base or a job's identity the pod inherited, any of which would reach
 * the agent's shell; or its shell prepared without the image's value or the
 * attempt's own base.
 */
test("an agent is started as a check stage's shells inherit, and its shell prepared with the rest", async (t) => {
  const kept = workerImageVariable("NODE_PATH");
  podHolds(t, {
    [kept]: "/image/node_modules",
    [workerTaskVariable]: "the task document",
    [workerChangeBaseVariable]: "e".repeat(40),
    [workerJobVariables.stage]: "the pod's",
  });
  const changeBase = "a".repeat(40);
  const preparedWith = [];
  const reads = [
    kept,
    workerTaskVariable,
    workerChangeBaseVariable,
    workerJobVariables.stage,
  ]
    .map((name) => `\${${name}-dropped}`)
    .join(" ");
  const ended = `printf '{"type":"result","structured_output":{"verdict":"Pass","summary":"%s %s %s"}}\\n' "$CHUG_SUITE_SHELL" "$1" "${reads}"`;

  const run = await runWorkerTask({
    task,
    directory: process.cwd(),
    changeBase,
    agentEnvironment: {},
    evidence: { observed: () => undefined, record: () => undefined },
    agent: {
      ...claudeAgent,
      executable: "/bin/sh",
      prepareShell: async (handed) => {
        preparedWith.push(handed);
        return {
          environment: { CHUG_SUITE_SHELL: "prepared" },
          arguments: ["argued"],
        };
      },
      invocation: (_, prepared) => [
        "-c",
        ended,
        "agent",
        ...prepared.shellArguments,
      ],
    },
  });

  assert.equal(
    run.result.summary,
    "prepared argued dropped dropped dropped dropped",
  );
  assert.deepEqual(preparedWith, [
    {
      NODE_PATH: "/image/node_modules",
      [workerChangeBaseVariable]: changeBase,
    },
  ]);
});

/** Catches an agent's shell handed a change base where the attempt knows none. */
test("an agent's shell is handed no change base where the attempt knows none", async (t) => {
  podHolds(t, { [workerChangeBaseVariable]: "e".repeat(40) });
  const preparedWith = [];
  const ended = JSON.stringify({
    type: "result",
    structured_output: { verdict: "Pass", summary: "ended" },
  });

  await runWorkerTask({
    task,
    directory: process.cwd(),
    agentEnvironment: {},
    evidence: { observed: () => undefined, record: () => undefined },
    agent: {
      ...claudeAgent,
      executable: "/bin/sh",
      prepareShell: async (handed) => {
        preparedWith.push(handed);
        return { environment: {}, arguments: [] };
      },
      invocation: () => ["-c", 'printf "%s\\n" "$1"', "agent", ended],
    },
  });

  assert.equal(preparedWith.length, 1);
  assert.ok(!Object.hasOwn(preparedWith[0], workerChangeBaseVariable));
});

/**
 * Catches what the job's setup passed on not reaching the agent's shell, or
 * losing there to the image's value it replaces; and reaching the agent's own
 * process, which is chuggy's runtime and not the project's shell.
 */
test("an agent's shell is handed what the job's setup passed on, and the agent's own process is not", async (t) => {
  podHolds(t, { [workerImageVariable("NODE_PATH")]: "/image/node_modules" });
  const preparedWith = [];
  const ended = `printf '{"type":"result","structured_output":{"verdict":"Pass","summary":"%s %s"}}\\n' "\${PASSED-dropped}" "\${NODE_PATH-dropped}"`;

  const run = await runWorkerTask({
    task,
    directory: process.cwd(),
    setupEnvironment: { PASSED: "on", NODE_PATH: "/setup/node_modules" },
    agentEnvironment: {},
    evidence: { observed: () => undefined, record: () => undefined },
    agent: {
      ...claudeAgent,
      executable: "/bin/sh",
      prepareShell: async (handed) => {
        preparedWith.push(handed);
        return { environment: {}, arguments: [] };
      },
      invocation: () => ["-c", ended],
    },
  });

  assert.equal(run.result.summary, "dropped dropped");
  assert.deepEqual(preparedWith, [
    { NODE_PATH: "/setup/node_modules", PASSED: "on" },
  ]);
});

/**
 * Catches an agent's process started without what the agent adds to its
 * environment, or the agent asked what to add on less than the whole of it:
 * the pod's, its credential's and its shell's.
 */
test("an agent's process is started with what the agent adds to the whole of its environment", async (t) => {
  podHolds(t, { CHUG_SUITE_POD: "pod" });
  const preparedWith = [];
  const ended = `printf '{"type":"result","structured_output":{"verdict":"Pass","summary":"%s"}}\\n' "$CHUG_SUITE_ADDED"`;

  const run = await runWorkerTask({
    task,
    directory: process.cwd(),
    agentEnvironment: { CHUG_SUITE_CREDENTIAL: "credential" },
    evidence: { observed: () => undefined, record: () => undefined },
    agent: {
      ...claudeAgent,
      executable: "/bin/sh",
      prepareShell: async () => ({
        environment: { CHUG_SUITE_SHELL: "shell" },
        arguments: [],
      }),
      prepareEnvironment: async (environment) => {
        preparedWith.push(environment);
        return { CHUG_SUITE_ADDED: "added" };
      },
      invocation: () => ["-c", ended],
    },
  });

  assert.equal(run.result.summary, "added");
  assert.equal(preparedWith.length, 1);
  assert.equal(preparedWith[0].CHUG_SUITE_POD, "pod");
  assert.equal(preparedWith[0].CHUG_SUITE_CREDENTIAL, "credential");
  assert.equal(preparedWith[0].CHUG_SUITE_SHELL, "shell");
  assert.ok(!Object.hasOwn(process.env, "CHUG_SUITE_ADDED"));
});

/** An image as a brief carries it: its bytes, and the reference its bundle pins it under. */
const briefImage = {
  bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]),
  reference: {
    ordinal: 3,
    kind: "ProjectArtifact",
    reference: "image/png:one",
  },
};

/**
 * A stand-in agent ending its run with a failing verdict, so a work attempt it
 * runs pushes nothing, and every task it was started on.
 */
function briefedAgent() {
  const started = [];
  const ended = JSON.stringify({
    type: "result",
    structured_output: { verdict: "Fail", summary: "ended" },
  });
  return {
    started,
    agent: {
      ...claudeAgent,
      executable: "/bin/sh",
      prepareShell: async () => ({ environment: {}, arguments: [] }),
      invocation: (begun) => {
        started.push(begun);
        return ["-c", 'printf "%s\\n" "$1"', "agent", ended];
      },
    },
  };
}

/** The file a briefing names for `identity`, from the section its images end it with. */
function briefedFile(text, identity) {
  const line = text
    .split("\n")
    .find((candidate) => candidate.startsWith(`- ${identity}: `));
  return line?.slice(`- ${identity}: `.length);
}

/**
 * Catches an agent started on a briefing that names images it cannot read:
 * none read before it starts, read without the attempt's bearer, kept outside
 * the temporary directory, or its briefing not told where.
 */
test("an agent is started on its briefing told where each image was read to", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "chuggy-temporary-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  podHolds(t, { TMPDIR: temporary });
  const read = [];
  const plane = planeFetch(planes.job, (route, request) => {
    read.push(request.path);
    return { status: 200, body: briefImage.bytes };
  });
  const { started, agent } = briefedAgent();
  const briefed = { ...task, briefing: { text: "## Your role\nWork." } };

  await runWorkerTask({
    task: briefed,
    bearer: "the attempt's bearer",
    images: [briefImage.reference],
    request: overPlane(workerRequest, async (url, init) => {
      assert.equal(init.headers.authorization, "Bearer the attempt's bearer");
      return plane.fetch(url, init);
    }),
    directory: process.cwd(),
    agentEnvironment: {},
    evidence: { observed: () => undefined, record: () => undefined },
    agent,
  });

  assert.deepEqual(read, ["/v1/input/artifacts/image/png:one"]);
  const [{ briefing }] = started;
  assert.ok(briefing.text.startsWith("## Your role\nWork.\n\n"));
  const file = briefedFile(briefing.text, "image/png:one");
  assert.equal(dirname(dirname(file)), temporary);
  assert.match(file, /\/chuggy-ticket-images-[^/]+\/1\.png$/u);
  assert.deepEqual(await readFile(file), briefImage.bytes);
});

/** Catches a briefing changed, or a directory made, where the bundle pins no image. */
test("an agent whose bundle pins no image is started on its briefing as written", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "chuggy-temporary-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  podHolds(t, { TMPDIR: temporary });
  const { started, agent } = briefedAgent();
  const briefed = { ...task, briefing: { text: "## Your role\nWork." } };

  await runWorkerTask({
    task: briefed,
    bearer: "the attempt's bearer",
    directory: process.cwd(),
    agentEnvironment: {},
    evidence: { observed: () => undefined, record: () => undefined },
    agent,
  });

  assert.equal(started[0], briefed);
  assert.deepEqual(await readdir(temporary), []);
});

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
  assert.equal(
    resolved.environment.CHUG_WORKER_GIT_CREDENTIAL_HOST,
    "github.com",
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

/**
 * Catches the clone asking for what the task kind needs, which for a work
 * attempt is the write, where a read of its own repository is all it needs;
 * and the push asking for that read, which no forge takes a push with.
 */
test("the clone asks for a read of its own repository by name, and the push takes a fresh mint naming none", async () => {
  const later = "ghs_zyxwvutsrqponmlkjihgfedcba9876543210";
  let mints = 0;
  const { asked, kept, named } = askedFor(() => {
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
  assert.deepEqual(named, [asked.repositoryId, undefined]);
  assert.equal(refreshed.CHUG_WORKER_GIT_CREDENTIAL_USERNAME, minted.username);
  assert.equal(refreshed.CHUG_WORKER_GIT_CREDENTIAL_HOST, "github.com");
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
 * recorder but for the `init` that makes the repository the push is made
 * from: what the push would have run, and what the report carried.
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
        if (args[0] === "init")
          return git(executable, args, {
            ...options,
            env: { PATH: process.env.PATH ?? "", ...options.env },
          });
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

/** The one git invocation of a verb the attempt made, past any `-c` entries before it, and a legible miss where it made none. */
function gitRun(runs, verb) {
  const ran = runs.find(
    ({ args }) =>
      args.find((arg, index) => arg !== "-c" && args[index - 1] !== "-c") ===
      verb,
  );
  assert.ok(ran, `the attempt ran no git ${verb}`);
  return ran;
}

/** Asserts the push was handed every variable `credential` holds, as it holds them. */
function assertPushedUnder(push, credential) {
  for (const [name, value] of Object.entries(credential))
    assert.equal(push.options.env[name], value, name);
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

  assertPushedUnder(gitRun(runs, "push"), pushCredential);
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
  assert.deepEqual(push.args.slice(-3), [
    "push",
    repositories["repository-1"].url,
    `${workCommit}:${ticketBranch(workAttempt)}`,
  ]);
  assertPushedUnder(push, pushCredential);
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

/**
 * A stand-in for Claude Code that writes its process's whole environment to
 * `dump` and fails with `summary` read from the variable it names, so nothing
 * is pushed and the plane is told what it printed.
 */
function environmentDumpingAgent(dump, summary) {
  const script = [
    `const { writeFileSync } = await import("node:fs");`,
    `writeFileSync(process.argv[1], JSON.stringify(process.env));`,
    `const summary = String(process.env[process.argv[2]]);`,
    `console.log(JSON.stringify({ type: "result", structured_output: { verdict: "Fail", summary } }));`,
  ].join("\n");
  return {
    ...claudeAgent,
    executable: process.execPath,
    prepareShell: async () => ({ environment: {}, arguments: [] }),
    invocation: () => ["--input-type=module", "--eval", script, dump, summary],
  };
}

/**
 * One agent work attempt launched from an envelope mounting `credential` as
 * its Claude credential file, the pod holding `holds`: the environment its
 * agent was started with, as the agent read it, and everything the plane was
 * sent, as text.
 */
async function credentialAttempt(t, credential, holds, summary) {
  const root = await suiteDirectory(t, "chuggy-credential-attempt-");
  const providerCredentialFile = join(root, "claude-code");
  await writeFile(providerCredentialFile, credential);
  const temporary = join(root, "temporary");
  await mkdir(temporary);
  podHolds(t, { ...holds, TMPDIR: temporary });
  const plane = await servedPlane((route) => {
    switch (route) {
      case "task":
        return {
          status: 200,
          body: workTaskAnswerSchema.parse({
            ...fetchedAnswer,
            authority: {
              ...fetchedAnswer.authority,
              credentials: ["forge", claudeAgent.credential],
            },
          }),
        };
      case "input":
        return inputAnswer("repository-1", "0".repeat(40));
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
  t.after(() => plane.close());
  const served = {
    ...envelope,
    callbackUrl: plane.url,
    providerCredentialFile,
  };
  const { task: answered } = await envelopeTask(served);
  const dump = join(root, "agent.json");
  await inCheckout(({ directory }) =>
    workerAttempt(envelopeLaunch(served, answered), {
      minted: root,
      write: async () => undefined,
      clone: async () => directory,
      agent: environmentDumpingAgent(dump, summary),
    }),
  );
  return {
    providerCredentialFile,
    environment: JSON.parse(await readFile(dump, "utf8")),
    sent: plane.requests
      .map(({ body }) =>
        Buffer.isBuffer(body) ? body.toString("utf8") : JSON.stringify(body),
      )
      .join("\n"),
    reported: plane.requests.some(({ route }) => route === "report"),
  };
}

/**
 * Catches a site pool's agent, whose runner names no kind of credential,
 * started on anything but the environment every agent was before a kind
 * could be named: the pod's, a subscription's token and the run's switches
 * over it, and its shell's, nothing the pod holds withheld beyond what it
 * always was.
 */
test("an agent whose runner names no kind of credential is started as every agent was before one could be named", async (t) => {
  const run = await credentialAttempt(
    t,
    `${secret}\n`,
    { ...strayEnvironment, [claudeCredentialVariable]: undefined },
    "CLAUDE_CODE_OAUTH_TOKEN",
  );

  assert.deepEqual(run.environment, {
    ...workerAgentEnvironment(process.env),
    ...claudeEnvironment,
    CLAUDE_CODE_OAUTH_TOKEN: secret,
  });
  for (const [name, value] of Object.entries(strayEnvironment))
    if (name !== "CLAUDE_CODE_OAUTH_TOKEN")
      assert.equal(run.environment[name], value, name);
  assert.ok(run.reported);
  assert.ok(!run.sent.includes(secret));
});

/**
 * Catches a credential the runner's environment left reaching an agent whose
 * runner named its kind, a variable that kind is read by left out, or one of
 * the secrets its file holds sent to the plane: an AWS key is in the mounted
 * file but is not the file, so only reading the file finds it.
 */
test("an agent whose runner names its kind is started on that credential alone, and every secret of its file is scrubbed", async (t) => {
  const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const run = await credentialAttempt(
    t,
    `[chuggy]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = ${awsSecret}\n`,
    {
      ...strayEnvironment,
      [claudeCredentialVariable]: JSON.stringify({
        kind: "Bedrock",
        region: "us-west-2",
        profile: "chuggy",
      }),
      CHUG_SUITE_PROBE: awsSecret,
    },
    "CHUG_SUITE_PROBE",
  );

  const expected = {
    ...workerEnvironmentWithout(
      workerAgentEnvironment(process.env),
      decidingFor("Bedrock"),
    ),
    ...claudeEnvironment,
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: "us-west-2",
    AWS_SHARED_CREDENTIALS_FILE: run.providerCredentialFile,
    AWS_PROFILE: "chuggy",
    DISABLE_TELEMETRY: "1",
  };
  assert.deepEqual(run.environment, expected);
  assert.deepEqual(strayLeftFor("Bedrock", run.environment), []);
  assert.ok(!Object.hasOwn(run.environment, claudeCredentialVariable));
  assert.ok(run.reported);
  assert.ok(!run.sent.includes(awsSecret));
  assert.ok(run.sent.includes("[redacted credential]"));
});

/**
 * A plane serving one commanded work attempt that passes, its setup lines
 * installing `hooks` as the clone's hooks and then passing on
 * `setupPassedVariable`, which its command passes only where it is handed,
 * its block provisioning a file, and its input pinning `base` of `remote` as
 * where it starts and where its change started.
 */
function hookedPlane(remote, base, hooks) {
  return servedPlane((route) => {
    switch (route) {
      case "task":
        return {
          status: 200,
          body: workTaskAnswerSchema.parse({
            ...fetchedAnswer,
            worker: {
              mode: {
                type: "Commands",
                commands: [`[ "$${setupPassedVariable}" = on ]`],
              },
              setup: [
                `git config core.hooksPath '${hooks}'`,
                `echo ${setupPassedVariable}=on >> ${setupFile}`,
              ],
              files: [{ path: ".provisioned", content: "set up\n" }],
            },
          }),
        };
      case "input": {
        const input = inputAnswer(remote, base);
        input.body.references.push({
          ordinal: 3,
          kind: "ChangeBase",
          reference: base,
        });
        return input;
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
}

/**
 * A project's setup may install hooks, as husky does on `npm ci`, and an
 * image's git and those hooks may need a value `check.sh` moved aside. Catches
 * any git a work attempt runs itself, from its clone to its push, or a hook
 * one of them runs, handed the core's own environment: without that value,
 * with what the project's setup passed on in its place, or with the task
 * document, which carries the attempt's bearer; and a push that runs a hook
 * the setup installed.
 */
test("a work attempt's git, from its clone to its push, and the hooks its setup installs are handed the image's environment, nothing its setup passed on and no task document, and its push runs none", async (t) => {
  await inCheckout(async ({ remote, directory, base }) => {
    await git("git", ["push", remote, `${base}:refs/heads/main`], {
      cwd: directory,
    });
    const recording = await recordingGit(t);
    const root = await mkdtemp(join(tmpdir(), "chuggy-attempt-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const plane = await hookedPlane(remote, base, recording.hooks);
    t.after(() => plane.close());
    const served = {
      ...envelope,
      callbackUrl: plane.url,
      workspace: join(root, "workspace"),
    };
    const { task: answered } = await envelopeTask(served);
    recording.start();

    await workerAttempt(envelopeLaunch(served, answered), {
      minted: root,
      write: async () => undefined,
    });

    const records = await recording.records();
    for (const [label, ...handed] of records)
      assert.deepEqual(handed, handedAsTheImage, label);
    const labels = records.map(([label]) => label);
    for (const expected of [
      "git clone",
      "git checkout",
      "git cat-file",
      "git rev-parse",
      "git status",
      "git commit",
      "pre-commit",
      "git rev-list",
      "git init",
      "git push",
    ])
      assert.ok(labels.includes(expected), `${expected} was never recorded`);
    assert.ok(
      !labels.includes("pre-push"),
      "the push ran the hook setup installed",
    );
    assert.notEqual(await remoteRefs(remote), "");
    assert.ok(plane.asked.some(({ route }) => route === "report"));
  });
});

/** A plane serving one attempt `answer` as its task, an input bundle pinning `briefImage`, and that image. */
function imagePlane(answer, remote, base) {
  return servedPlane((route) => {
    switch (route) {
      case "task":
        return answer;
      case "input": {
        const input = inputAnswer(remote, base);
        input.body.references.push(briefImage.reference);
        return input;
      }
      case "inputArtifact":
        return { status: 200, body: briefImage.bytes };
      case "credential":
        return {
          status: 200,
          body: { ...minted, expiresAtMs: 1_900_000_000_000 },
        };
      case "runTurns":
        return { status: 200, body: { turnsRecorded: 0 } };
      case "report":
        return { status: 202, body: { action: "stop" } };
      default:
        return { status: 204 };
    }
  });
}

/**
 * One attempt from an envelope over `plane`, in a temporary directory of its
 * own, its agent `agent` and its credential mounted.
 */
async function imageAttempt(t, plane, directory, agent) {
  const root = await mkdtemp(join(tmpdir(), "chuggy-attempt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const temporary = join(root, "temporary");
  await mkdir(temporary);
  podHolds(t, { TMPDIR: temporary });
  const providerCredentialFile = join(root, "claude-code");
  await writeFile(providerCredentialFile, `${secret}\n`);
  const served = {
    ...envelope,
    callbackUrl: plane.url,
    providerCredentialFile,
  };
  const { task: answered } = await envelopeTask(served);
  await workerAttempt(envelopeLaunch(served, answered), {
    minted: root,
    write: async () => undefined,
    clone: async () => directory,
    ...(agent === undefined ? {} : { agent }),
  });
  return temporary;
}

/**
 * Catches an attempt that starts its agent without reading the images its
 * bundle pins, or reads them without its own bearer: the wiring from the
 * workspace to the agent's run.
 */
test("an agent's attempt reads the images its bundle pins with its bearer before the agent starts", async (t) => {
  await inCheckout(async ({ remote, directory, base }) => {
    const plane = await imagePlane(
      {
        status: 200,
        body: workTaskAnswerSchema.parse({
          ...fetchedAnswer,
          authority: {
            ...fetchedAnswer.authority,
            credentials: ["forge", claudeAgent.credential],
          },
        }),
      },
      remote,
      base,
    );
    t.after(() => plane.close());
    const { started, agent } = briefedAgent();

    const temporary = await imageAttempt(t, plane, directory, agent);

    const reads = plane.asked.filter(({ route }) => route === "inputArtifact");
    assert.deepEqual(reads, [
      { route: "inputArtifact", authorization: `Bearer ${envelope.bearer}` },
    ]);
    const file = briefedFile(started[0].briefing.text, "image/png:one");
    assert.equal(dirname(dirname(file)), temporary);
    assert.deepEqual(await readFile(file), briefImage.bytes);
  });
});

/**
 * Catches an agent's shell not told which job it is in, or told it as the pod
 * held it: what its checks read is what a check stage's would.
 */
test("an agent's shell is told which job it is in", async (t) => {
  podHolds(t, { [workerJobVariables.project]: "the pod's" });
  await inCheckout(async ({ remote, directory, base }) => {
    const plane = await imagePlane(
      {
        status: 200,
        body: workTaskAnswerSchema.parse({
          ...workAnswered,
          taskKind: "Evaluation",
          stage: 0,
          authority: {
            ...fetchedAnswer.authority,
            credentials: ["forge", claudeAgent.credential],
          },
        }),
      },
      remote,
      base,
    );
    t.after(() => plane.close());
    const preparedWith = [];
    const { agent } = briefedAgent();

    await imageAttempt(t, plane, directory, {
      ...agent,
      prepareShell: async (handed) => {
        preparedWith.push(handed);
        return { environment: {}, arguments: [] };
      },
    });

    assert.equal(preparedWith.length, 1);
    assert.deepEqual(
      Object.fromEntries(
        Object.values(workerJobVariables).map((name) => [
          name,
          preparedWith[0][name],
        ]),
      ),
      {
        CHUG_TENANT: "tenant-1",
        CHUG_PROJECT: "project-1",
        CHUG_REPOSITORY: remote,
        CHUG_TICKET: "7",
        CHUG_ATTEMPT: "attempt-1",
        CHUG_STAGE: "Evaluation:1",
      },
    );
  });
});

/** Catches a check stage reading images nothing in it is briefed with. */
test("a commanded attempt never reads the images its bundle pins", async (t) => {
  await inCheckout(async ({ remote, directory, base }) => {
    const plane = await imagePlane(commandedTask(["true"]), remote, base);
    t.after(() => plane.close());

    await imageAttempt(t, plane, directory);

    assert.ok(plane.asked.some(({ route }) => route === "report"));
    assert.ok(!plane.asked.some(({ route }) => route === "inputArtifact"));
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

/**
 * The repositories a project binds on the suite's forge: the job's own, one
 * its own names as a submodule, and one the project does not bind. The job's
 * own is named with the word git's username prompt begins with, which the
 * askpass must not read a password prompt naming it as.
 */
const projectRepositories = {
  own: "org/UsernameTools.git",
  lib: "org/lib.git",
  unbound: "org/unbound.git",
};

/** The credential the plane mints the job's own repository where the pod names none, which is a work attempt's push. */
const ownCredential = {
  username: "x-access-token",
  password: "ghs_ownWrite0123456789abcdefghijklmnop",
};

/**
 * A forge holding a project's repositories: its own names the library as a
 * submodule at the forge's ssh address, and the one the project does not
 * bind accepts the job's own credential, so a fallback to it would succeed.
 */
async function projectForge(t) {
  const forge = await forgeServed(t, Object.values(projectRepositories));
  const libHead = await forge.seed(projectRepositories.lib, {
    "lib.txt": "the library\n",
  });
  await forge.seed(projectRepositories.unbound, { "x.txt": "unbound\n" });
  const base = await forge.seed(
    projectRepositories.own,
    {
      "README.md": "# own\n",
      ".gitmodules": `[submodule "lib"]\n\tpath = lib\n\turl = git@127.0.0.1:${projectRepositories.lib}\n`,
    },
    { lib: libHead },
  );
  forge.accept(projectRepositories.own, ownCredential.password);
  forge.accept(projectRepositories.unbound, ownCredential.password);
  return { forge, base };
}

/**
 * A plane serving `answer` as one attempt's task, its input the forge's own
 * repository at `base`. It mints the job's own credential where the pod names
 * no repository; a fresh read of the job's own repository at every ask naming
 * it, which from then on is the only one the forge accepts to read it, leaving
 * the job's own credential the only one that pushes it; a fresh read of the
 * library at every ask naming it, which from then on is the only one the forge
 * accepts for it; and nothing for any other. `reads` is every read of the
 * library it minted and `ownReads` every read of the job's own, in order.
 */
async function readsPlane(forge, answer, base) {
  const reads = [];
  const ownReads = [];
  const expiresAtMs = 1_900_000_000_000;
  const plane = await servedPlane((route, request) => {
    switch (route) {
      case "task":
        return answer;
      case "input":
        return inputAnswer(forge.url(projectRepositories.own), base);
      case "credential": {
        const named = request.body?.repository;
        if (named === undefined)
          return { status: 200, body: { ...ownCredential, expiresAtMs } };
        if (named === forge.url(projectRepositories.own)) {
          const password = `ghs_readOfOwn${String(ownReads.length).padStart(24, "0")}`;
          ownReads.push(password);
          forge.acceptRead(projectRepositories.own, password);
          return {
            status: 200,
            body: { username: "x-access-token", password, expiresAtMs },
          };
        }
        if (named !== forge.url(projectRepositories.lib))
          return { status: 404, body: { reason: "NotMinted" } };
        const password = `ghs_readOfLib${String(reads.length).padStart(24, "0")}`;
        reads.push(password);
        forge.accept(projectRepositories.lib, password);
        return {
          status: 200,
          body: { username: "x-access-token", password, expiresAtMs },
        };
      }
      case "runTurns":
        return { status: 200, body: { turnsRecorded: 0 } };
      case "report":
        return { status: 202, body: { action: "stop" } };
      default:
        return { status: 204 };
    }
  });
  return { ...plane, reads, ownReads };
}

/** Every repository a credential request named, the job's own named by nothing. */
function credentialAsks(plane) {
  return plane.requests
    .filter(({ route }) => route === "credential")
    .map(({ body }) => body?.repository);
}

/** The passwords each repository on the forge was presented, for `service` alone where it names one. */
function presentedTo(forge, name, service) {
  return forge.presented
    .filter(
      (presented) =>
        presented.repository === name &&
        (service === undefined || presented.service === service),
    )
    .map(({ password }) => password);
}

/**
 * The `node_modules` this suite's own imports resolve from: the checkout's, or
 * the runtime's above it where an image runs the suites.
 */
function resolvingModules() {
  const entry = fileURLToPath(
    import.meta.resolve("@chuggy/worker-contract/workerEnvironment"),
  );
  const contract = join("node_modules", "@chuggy", "worker-contract");
  return join(entry.slice(0, entry.lastIndexOf(contract)), "node_modules");
}

/**
 * A copy of the shipped set under `root`, its askpass executable as an image
 * installs it, reading the packages it imports from where this suite does.
 */
async function shippedCore(root) {
  const core = join(root, "core");
  await mkdir(core);
  const { files } = JSON.parse(
    await readFile(join(here, "package.json"), "utf8"),
  );
  for (const file of [...files, "package.json"])
    await copyFile(join(here, file), join(core, file));
  await chmod(join(core, "git-askpass.sh"), 0o555);
  await symlink(resolvingModules(), join(core, "node_modules"));
  return core;
}

/** A directory of the suite's own until `t` ends. */
async function suiteDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A pre-commit and a pre-push under `hooks` that each read `lib`, writing what it read under `dumps`. */
async function libReadingHooks(hooks, dumps, lib) {
  await mkdir(hooks);
  for (const hook of ["pre-commit", "pre-push"]) {
    await writeFile(
      join(hooks, hook),
      `#!/bin/sh\ngit ls-remote --exit-code '${lib}' main > '${dumps}/${hook}'\n`,
    );
    await chmod(join(hooks, hook), 0o755);
  }
}

/**
 * The commanded work task a launched attempt reads its project's repositories
 * in: a setup line cloning the library and fetching its own repository, checks
 * fetching its own repository, updating its own submodules and failing to read
 * the repository the project does not bind, and the hooks under `hooks`
 * installed. Its setup line and its checks each write their environment under
 * `dumps`.
 */
function projectReadingTask(forge, dumps, hooks) {
  const lib = forge.url(projectRepositories.lib);
  return {
    status: 200,
    body: workTaskAnswerSchema.parse({
      ...fetchedAnswer,
      worker: {
        mode: {
          type: "Commands",
          commands: [
            "git fetch --quiet origin",
            "git submodule update --init --recursive",
            "test -f lib/lib.txt",
            `! git ls-remote '${forge.url(projectRepositories.unbound)}'`,
            `env > '${dumps}/check.env'`,
          ],
        },
        setup: [
          `git clone --quiet '${lib}' '${dumps}/lib-by-setup'`,
          "git fetch --quiet origin",
          `env > '${dumps}/setup.env'`,
          `git config core.hooksPath '${hooks}'`,
        ],
        files: [],
      },
    }),
  };
}

/**
 * Catches a read kept and presented again after the plane minted another; any
 * credential presented to a repository the plane minted nothing for; the job's
 * own credential presented anywhere but its own push, or anything else
 * presented to that push; and the plane asked for the job's own credential
 * more than once, or before any read of the job's own repository it served.
 */
function assertReadsOnly(forge, plane) {
  const own = projectRepositories.own;
  assert.ok(plane.reads.length >= 2, "the library was never minted again");
  assert.deepEqual(
    [...new Set(presentedTo(forge, projectRepositories.lib))],
    plane.reads,
  );
  assert.ok(plane.ownReads.length >= 3, "its own was read only by its clone");
  assert.deepEqual(
    [...new Set(presentedTo(forge, own, forgeServices.read))],
    plane.ownReads,
  );
  assert.deepEqual(
    [...new Set(presentedTo(forge, own, forgeServices.write))],
    [ownCredential.password],
  );
  assert.deepEqual(presentedTo(forge, projectRepositories.unbound), []);
  const asks = credentialAsks(plane);
  assert.ok(asks.includes(forge.url(projectRepositories.unbound)));
  assert.equal(asks.filter((named) => named === undefined).length, 1);
  assert.ok(
    asks.indexOf(undefined) > asks.lastIndexOf(forge.url(own)),
    "the job's own credential was asked for before a read of its own",
  );
}

/**
 * A work attempt launched as a pool launches its pod reads its project's
 * repositories from a setup line and from its checks, its own and a submodule
 * written at the forge's ssh address among them, and others from the hook its
 * commit runs; and pushes its own with what the plane mints for its task kind,
 * running no hook. Catches a git the attempt runs that cannot reach a
 * repository its project binds, what `assertReadsOnly` catches, the bearer
 * reaching a setup line's or a check's environment, and a push that runs the
 * hook the setup installed for it.
 */
test("a launched work attempt reads every repository its project binds and pushes only its own", async (t) => {
  const { forge, base } = await projectForge(t);
  const root = await suiteDirectory(t, "chuggy-reads-attempt-");
  const dumps = join(root, "dumps");
  const hooks = join(root, "hooks");
  await mkdir(dumps);
  await libReadingHooks(hooks, dumps, forge.url(projectRepositories.lib));
  const plane = await readsPlane(
    forge,
    projectReadingTask(forge, dumps, hooks),
    base,
  );
  t.after(() => plane.close());
  const served = {
    ...envelope,
    callbackUrl: plane.url,
    workspace: join(root, "workspace"),
  };

  const ran = await launched(
    {
      [workerTaskVariable]: JSON.stringify(served),
      HOME: root,
      ...forgeGitIsolated,
    },
    root,
    await shippedCore(root),
  );

  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(
    await readFile(join(dumps, "lib-by-setup", "lib.txt"), "utf8"),
    "the library\n",
  );
  assert.match(
    await readFile(join(dumps, "pre-commit"), "utf8"),
    /^[0-9a-f]{40}\trefs\/heads\/main$/mu,
  );
  await assert.rejects(readFile(join(dumps, "pre-push")), { code: "ENOENT" });
  assert.match(
    await remoteRefs(forge.bare(projectRepositories.own)),
    new RegExp(`\t${ticketBranch(fetchedAnswer)}$`, "mu"),
  );
  assertReadsOnly(forge, plane);
  for (const dump of ["setup.env", "check.env"]) {
    const text = await readFile(join(dumps, dump), "utf8");
    assert.ok(!text.includes(served.bearer), `${dump} holds the bearer`);
    assert.match(text, /^GIT_CONFIG_COUNT=5$/mu, dump);
  }
});

/**
 * Catches a read the attempt was minted for another repository left out of
 * what its push is checked for: a check that writes one into the work has it
 * committed, and the push refuses it by kind, never printing it.
 */
test("a work attempt whose commit carries a read of another repository pushes nothing", async (t) => {
  podHolds(t, forgeGitIsolated);
  const { forge, base } = await projectForge(t);
  const root = await suiteDirectory(t, "chuggy-reads-leak-");
  const lib = forge.url(projectRepositories.lib);
  const plane = await readsPlane(
    forge,
    commandedTask([
      `printf 'url=%s\\n\\n' '${lib}' | git credential fill | sed -n 's/^password=//p' > leaked`,
    ]),
    base,
  );
  t.after(() => plane.close());
  const workspace = await ownCheckout(forge, root);
  const served = { ...envelope, callbackUrl: plane.url };
  const { task: answered } = await envelopeTask(served);

  const failed = await workerAttempt(envelopeLaunch(served, answered), {
    minted: root,
    write: async () => undefined,
    clone: async () => workspace,
  }).then(
    () => new Error("pushed"),
    (error) => error,
  );

  assert.equal(plane.reads.length, 1);
  assert.equal(
    (await readFile(join(workspace, "leaked"), "utf8")).trim(),
    plane.reads[0],
  );
  assert.match(
    failed.message,
    /^commit [0-9a-f]{40} carries a read the plane minted for a repository in a file, so the attempt pushes nothing$/u,
  );
  assert.ok(!failed.message.includes(plane.reads[0]));
  assert.doesNotMatch(
    await remoteRefs(forge.bare(projectRepositories.own)),
    /ticket/u,
  );
  assert.ok(!plane.asked.some(({ route }) => route === "report"));
});

/** An agent's command that clones the library and fails to read the repository the project does not bind, writing `outcome` where both went as they should. */
const libReadingLine = `git clone --quiet "$1" "$3/lib-by-agent" && ! git ls-remote "$2" 2>/dev/null && echo read > "$3/outcome"`;

/** An agent's command that fetches its own repository and then writes the password git's helpers answer for it to `own-password`. */
const ownReadingLine = `git fetch --quiet "$4" && printf 'url=%s\\n\\n' "$4" | git credential fill | sed -n 's/^password=//p' > "$3/own-password"`;

/**
 * A stand-in for Claude Code under `root` whose one command is `line`, given
 * the library, the repository the project does not bind, `root` and the job's
 * own repository as its arguments, in a shell that first sources what Claude
 * Code's Bash tool does. It writes its process's environment and its shell's
 * under `root`, and fails, so nothing is pushed.
 */
function readingAgent(root, forge, line) {
  const script = [
    `env > "$3/agent.env"`,
    `. "$CLAUDE_ENV_FILE"`,
    `env > "$3/shell.env"`,
    line,
    `printf '{"type":"result","structured_output":{"verdict":"Fail","summary":"read"}}\\n'`,
  ].join("\n");
  return {
    ...claudeAgent,
    executable: "/bin/sh",
    prepareShell: (handed) =>
      prepareClaudeShell(handed, join(root, "claude-shell.sh")),
    invocation: () => [
      "-c",
      script,
      "agent",
      forge.url(projectRepositories.lib),
      forge.url(projectRepositories.unbound),
      root,
      forge.url(projectRepositories.own),
    ],
  };
}

/** A checkout of the forge's own repository under `root`, which an in-process attempt's clone stands in with. */
async function ownCheckout(forge, root) {
  const workspace = join(root, "workspace");
  await git("git", [
    "clone",
    "--quiet",
    forge.bare(projectRepositories.own),
    workspace,
  ]);
  return workspace;
}

/**
 * One work attempt run in this process over the project's forge, its agent
 * the stand-in running `line` and its clone a checkout of the job's own
 * repository; `write` is handed every password the attempt writes where git's
 * askpass reads it.
 */
async function agentReadingAttempt(t, prefix, line, write) {
  const { forge, base } = await projectForge(t);
  const root = await suiteDirectory(t, prefix);
  const temporary = join(root, "temporary");
  await mkdir(temporary);
  const providerCredentialFile = join(root, "claude-code");
  await writeFile(providerCredentialFile, `${secret}\n`);
  const plane = await readsPlane(
    forge,
    {
      status: 200,
      body: workTaskAnswerSchema.parse({
        ...fetchedAnswer,
        authority: {
          ...fetchedAnswer.authority,
          credentials: ["forge", claudeAgent.credential],
        },
      }),
    },
    base,
  );
  t.after(() => plane.close());
  const served = {
    ...envelope,
    callbackUrl: plane.url,
    providerCredentialFile,
  };
  podHolds(t, {
    ...forgeGitIsolated,
    TMPDIR: temporary,
    [workerTaskVariable]: JSON.stringify(served),
  });
  const workspace = await ownCheckout(forge, root);
  const { task: answered } = await envelopeTask(served);

  await workerAttempt(envelopeLaunch(served, answered), {
    minted: root,
    write,
    clone: async () => workspace,
    agent: readingAgent(root, forge, line),
  });
  return { forge, root, plane, served };
}

/**
 * An agent's shell reaches the project's other repositories as a check's
 * does, through what Claude Code's Bash tool sources before each command.
 * Catches an agent's git left without the attempt's configuration, or the
 * agent's process or its shell holding the bearer.
 */
test("an agent's shell reads another repository its project binds, and holds no bearer", async (t) => {
  const { forge, root, plane, served } = await agentReadingAttempt(
    t,
    "chuggy-reads-agent-",
    libReadingLine,
    async () => undefined,
  );

  assert.equal(await readFile(join(root, "outcome"), "utf8"), "read\n");
  assert.deepEqual(
    [...new Set(presentedTo(forge, projectRepositories.lib))],
    plane.reads,
  );
  assert.deepEqual(presentedTo(forge, projectRepositories.unbound), []);
  for (const dump of ["agent.env", "shell.env"]) {
    const text = await readFile(join(root, dump), "utf8");
    assert.ok(!text.includes(served.bearer), `${dump} holds the bearer`);
  }
});

/**
 * An agent's shell reaches the job's own repository as it reaches any other,
 * and git is handed only a read of it until the harness's push, which comes
 * after the agent has exited and which this attempt, failed, never makes.
 * Catches the clone minted what the task kind needs and left where the
 * askpass reads it, an agent's git answered anything but a read of its own
 * repository, and the job's own credential asked for by an attempt that does
 * not push.
 */
test("an agent's git is handed only a read of its own repository, and the clone leaves no write credential on disk", async (t) => {
  const written = [];
  const { forge, root, plane } = await agentReadingAttempt(
    t,
    "chuggy-reads-own-",
    ownReadingLine,
    async (_file, password) => {
      written.push(password);
    },
  );

  const answered = (await readFile(join(root, "own-password"), "utf8")).trim();
  assert.ok(plane.ownReads.includes(answered), "git was answered no read");
  assert.ok(written.length > 0, "the clone wrote nothing");
  for (const password of written)
    assert.ok(plane.ownReads.includes(password), "a write was written");
  const fetched = presentedTo(forge, projectRepositories.own);
  assert.ok(fetched.length > 0, "the agent never fetched its own");
  for (const password of fetched)
    assert.ok(plane.ownReads.includes(password), "a write was presented");
  assert.ok(!credentialAsks(plane).includes(undefined));
});
