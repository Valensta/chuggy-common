import { coreRuntime } from "./coreRuntime.mjs";
import { agentResult } from "./result.mjs";
import { execFile } from "node:child_process";
import { access, constants, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

const reservedCodexArguments = [
  "exec",
  "--json",
  "--output-schema",
  "--output-last-message",
  "--cd",
  "-C",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--model",
  "-m",
  "--config",
  "-c",
  "--profile",
  "-p",
  "--oss",
  "--local-provider",
  "--sandbox",
  "-s",
  "--dangerously-bypass-approvals-and-sandbox",
  "--skip-git-repo-check",
  "--resume",
  "--",
];

const reservedCodexShortArguments = ["-m", "-c", "-p", "-s", "-C"];

function configuredArguments(task) {
  const args = task.worker?.mode?.arguments ?? [];
  for (const argument of args) {
    if (
      reservedCodexArguments.some(
        (reserved) =>
          argument === reserved || argument.startsWith(`${reserved}=`),
      ) ||
      reservedCodexShortArguments.some(
        (reserved) =>
          argument.startsWith(reserved) && argument.length > reserved.length,
      )
    )
      throw new Error(
        `worker configuration reserves Codex argument ${argument}`,
      );
  }
  return args;
}

/**
 * `text` as a TOML basic string, which is how a `--config` value is read. A
 * backslash, a quote and every control character are escaped, so no character
 * TOML refuses in one is left in it.
 */
function codexTomlString(text) {
  return `"${text.replace(/[\\"\p{Cc}]/gu, (character) =>
    character === "\\" || character === '"'
      ? `\\${character}`
      : `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
  )}"`;
}

/**
 * The override of Codex's `shell_environment_policy` that hands the shell Codex
 * runs each command in each variable of `handed` as it is, which is what a
 * check stage's shells are handed beyond what Codex's own process runs with.
 */
export function codexShellArguments(handed) {
  const set = Object.entries(handed).map(
    ([name, value]) => `${name} = ${codexTomlString(value)}`,
  );
  return ["--config", `shell_environment_policy.set={${set.join(", ")}}`];
}

/** What a Codex run's shell is handed, which is given by arguments alone. */
export async function prepareCodexShell(handed) {
  return { environment: {}, arguments: codexShellArguments(handed) };
}

/**
 * The argv of one run. `run` names the result schema's file and the arguments
 * the run's shell was prepared with. The briefing comes after `--`, so it is
 * the prompt whatever precedes it: an option a worker configures may take
 * every word after it, as `--image` does, and would otherwise take the
 * briefing as one of its values.
 */
export function codexInvocation(task, run) {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--model",
    task.worker.mode.model,
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-schema",
    run.resultSchema,
    ...run.shellArguments,
    ...configuredArguments(task),
    "--",
    task.briefing.text,
  ];
}

export async function codexConfiguration(
  task,
  environment,
  execute = executeFile,
) {
  const { stdout } = await execute(coreRuntime.codex, ["--version"], {
    env: environment,
    maxBuffer: 4096,
  });
  const version = stdout.trim();
  if (version.length === 0)
    throw new Error("Codex reported no runtime version");
  return {
    agent: "Codex",
    codexVersion: version,
    model: task.worker.mode.model,
    userConfig: "Ignored",
    projectRules: "Ignored",
  };
}

function codexMessage(event) {
  if (event?.type !== "item.completed" || event.item?.type !== "agent_message")
    return undefined;
  return event.item.text;
}

export function codexResult(events) {
  const output = events.findLast((event) => codexMessage(event) !== undefined);
  const text = codexMessage(output);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Codex returned no structured verdict");
  }
  return { output, result: agentResult(parsed, "Codex") };
}

/**
 * The credential a Codex run reads, written to a Codex home of its own under
 * the image's HOME, which is the directory a job's check has found writable.
 */
export async function prepareCodexCredential(
  auth,
  home = join(homedir(), ".chuggy-codex-home"),
) {
  let document;
  try {
    document = JSON.parse(auth);
  } catch {
    throw new Error("Codex OAuth credential is not an auth.json document");
  }
  if (document === null || typeof document !== "object")
    throw new Error("Codex OAuth credential is not an auth.json document");
  await mkdir(home, { recursive: false });
  await writeFile(`${home}/auth.json`, `${auth}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const tokens = [
    ...Object.values(document.tokens ?? {}),
    document.OPENAI_API_KEY,
  ].filter((value) => typeof value === "string");
  return {
    environment: { CODEX_HOME: home },
    secrets: [auth, ...tokens],
  };
}

/**
 * The variables Codex finds the CAs it verifies a peer with by: its own, and
 * the two TLS libraries read, any of which an image whose peers a private CA
 * signs may already set.
 */
const codexCertificateVariables = [
  "CODEX_CA_CERTIFICATE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/**
 * What a Codex run's own process is started with beside `environment`: the CA
 * bundle at `certificates`, where that file is there and `environment` names
 * no bundle of its own. Codex verifies a peer against the image's CA store,
 * which an image without ca-certificates does not have, and trusts the bundle
 * beside that store rather than in its place. The variable is one no other
 * program reads, so git and every program the project runs keep whatever
 * store the image has. A core with no bundle gives none.
 */
export async function prepareCodexEnvironment(
  environment,
  certificates = coreRuntime.certificates,
) {
  if (
    certificates === undefined ||
    codexCertificateVariables.some((name) => Object.hasOwn(environment, name))
  )
    return {};
  const shipped = await access(certificates, constants.R_OK).then(
    () => true,
    () => false,
  );
  return shipped ? { CODEX_CA_CERTIFICATE: certificates } : {};
}

function codexObserved(event) {
  if (event?.type !== "turn.completed") return undefined;
  return {
    usage: {
      input_tokens: event.usage?.input_tokens,
      output_tokens: event.usage?.output_tokens,
      cache_read_input_tokens: event.usage?.cached_input_tokens,
    },
    num_turns: 1,
  };
}

export const codexAgent = {
  name: "Codex",
  runtime: "Codex",
  executable: coreRuntime.codex,
  credential: "codex-auth",
  invocation: codexInvocation,
  result: codexResult,
  prepareCredential: (auth) => prepareCodexCredential(auth),
  prepareShell: prepareCodexShell,
  prepareEnvironment: prepareCodexEnvironment,
  configuration: codexConfiguration,
  configurationEvent: () => false,
  resultEvent: (event) => codexMessage(event) !== undefined,
  observed: codexObserved,
};
