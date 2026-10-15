import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { workerImageEnvironment } from "./checks.mjs";
import { coreRuntime } from "./coreRuntime.mjs";
import { agentResult, agentResultSchema } from "./result.mjs";

/**
 * What every Claude Code run here is started with beside its credential. A run
 * is headless, so it ends with the agent's last reply, and Claude Code kills a
 * command it moved to the background once the run ends, without the agent ever
 * seeing it finish. So no command is moved there: a long one is waited for,
 * up to the Bash tool's timeout. Nor does it update itself: a run's Claude Code
 * is the one its runtime ships, and an image need not set the variable that
 * says so.
 */
export const claudeEnvironment = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  DISABLE_AUTOUPDATER: "1",
};

const reservedClaudeArguments = [
  "-p",
  "--print",
  "--output-format",
  "--input-format",
  "--json-schema",
  "--permission-mode",
  "--dangerously-skip-permissions",
  "--mcp-config",
  "--strict-mcp-config",
  "--cwd",
  "--add-dir",
  "--worktree",
  "--resume",
  "--continue",
];

function configuredArguments(task) {
  const args = task.worker?.mode?.arguments ?? task.worker?.arguments ?? [];
  for (const argument of args) {
    if (
      reservedClaudeArguments.some(
        (reserved) =>
          argument === reserved || argument.startsWith(`${reserved}=`),
      )
    )
      throw new Error(
        `worker configuration reserves Claude argument ${argument}`,
      );
  }
  return args;
}

export function claudeInvocation(task) {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(agentResultSchema),
    "--permission-mode",
    "bypassPermissions",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    ...configuredArguments(task),
    task.briefing.text,
  ];
}

/** `text` as one POSIX shell word, whatever quotes it holds. */
function claudeShellWord(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The lines Claude Code runs before each command of its Bash tool, in that
 * command's own shell: each variable a job's `check.sh` moved aside, back under
 * its own name as a check stage's shells are handed it. Claude Code's own
 * process runs without them.
 */
export function claudeShellScript(environment) {
  return Object.entries(workerImageEnvironment(environment))
    .map(([name, value]) => `export ${name}=${claudeShellWord(value)}\n`)
    .join("");
}

/**
 * Those lines, written where Claude Code is told to read them by
 * `CLAUDE_ENV_FILE`: under the image's HOME, which a job's check found this
 * user can write.
 */
export async function prepareClaudeShell(
  environment,
  file = join(homedir(), ".chuggy-claude-shell.sh"),
) {
  await writeFile(file, claudeShellScript(environment), {
    flag: "wx",
    mode: 0o600,
  });
  return { environment: { CLAUDE_ENV_FILE: file }, arguments: [] };
}

export function claudeResult(events) {
  const output = events.findLast(
    (event) =>
      event?.type === "result" && event.structured_output !== undefined,
  );
  const result = agentResult(output?.structured_output, "Claude Code");
  return { output, result };
}

export const claudeAgent = {
  name: "Claude",
  runtime: "Claude Code",
  executable: coreRuntime.claude,
  credential: "claude-code",
  invocation: claudeInvocation,
  result: claudeResult,
  prepareCredential: (token) => ({
    environment: { ...claudeEnvironment, CLAUDE_CODE_OAUTH_TOKEN: token },
    secrets: [token],
  }),
  prepareShell: prepareClaudeShell,
  configurationEvent: (event) =>
    event?.type === "system" && event.subtype === "init",
  resultEvent: (event) => event?.type === "result",
  observed: (event) => (event?.type === "result" ? event : undefined),
};
