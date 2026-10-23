/**
 * What a job's setup lines pass on to the lines after them, to its agent's
 * shells and to its commands: the variables each line writes to the file
 * `workerSetupEnvironmentVariable` names, in the two forms GitHub Actions
 * reads its `GITHUB_ENV` file in.
 *
 * EACH LINE IS HANDED A FILE OF ITS OWN, empty, in a directory the core makes
 * for the job's setup and removes once it ends. A line that exits cleanly has
 * its file read, and what it set is laid over what the lines before it set, a
 * later value winning; a line that fails fails the setup step unread.
 *
 * A LINE OF THE FILE IS `NAME=value` OR `NAME<<DELIMITER`, whichever separator
 * comes first in it. The first form's value is the rest of the line; the
 * second's is every line up to one that is the delimiter alone, joined by line
 * feeds. Lines end at a line feed, a carriage return before one is dropped,
 * and an empty line outside a value is skipped.
 *
 * A NAME IS CHUGGY'S OR THE PROJECT'S, and setup may set only the project's.
 * chuggy's are every name under its own prefixes, every name a workload's
 * environment may not name, and the variables git reads the attempt's
 * configuration entries from. A line setting one, like a line neither form
 * reads, fails the setup step rather than being skipped, because a setup that
 * passes has nowhere to report what it skipped. Every other name is the
 * project's, `PATH` and the variables an image steers a process by among them,
 * because nothing but the project's own shells is handed what setup passes:
 * the core's own processes, the agent's own process, and the git the core runs
 * to commit and push and every hook that git runs are started without it.
 *
 * NOTHING SETUP PASSES IS HELD AS A SECRET, so the credential scrub does not
 * take it out of what the attempt uploads.
 *
 * WHAT SETUP PASSES IS BOUNDED BY THE ARGUMENT CODEX IS HANDED IT IN. Codex is
 * told every variable its shell is handed in one argument of TOML
 * (`codexShellArguments`), and a process is refused an argument over Linux's
 * own bound on one, so what setup passes weighs no more than that argument
 * leaves it, at the heaviest TOML can spell a byte.
 */

import { Buffer } from "node:buffer";
import { constants, mkdtemp, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import {
  workerGitVariable,
  workerSetupEnvironmentVariable,
  workerTemporaryFile,
} from "./checks.mjs";
import { reservedJobVariables } from "./job.mjs";

/**
 * The page `MAX_ARG_STRLEN` is taken at: the smallest Linux has, so the limit
 * is the least any Linux kernel holds an argument to.
 */
export const setupEnvironmentArgumentPageBytes = 4096;

/**
 * The bytes one argument of a process may hold on Linux, its terminating NUL
 * among them: the kernel's `MAX_ARG_STRLEN`, which is pages of it. The suite
 * asks the kernel where the page is this one.
 */
export const setupEnvironmentArgumentBytesMax =
  32 * setupEnvironmentArgumentPageBytes;

/** What that argument leaves the variables chuggy hands Codex's shell itself and the image's, which setup's may not take. */
const setupEnvironmentArgumentRoomBytes = 16_384;

/**
 * What one byte of a variable can cost in that argument: a control character,
 * which TOML spells as a `\u` escape. Not measured here: the suite builds the
 * heaviest variables setup may pass and weighs them.
 */
const setupEnvironmentEscapeBytesMax = 6;

/**
 * The bytes what setup passes may weigh, each variable weighed as the UTF-8 of
 * its `NAME=value`: what the argument leaves, at the heaviest any byte of it
 * can be spelled. One line's file is read to one byte past it.
 */
export const setupEnvironmentBytesMax = Math.floor(
  (setupEnvironmentArgumentBytesMax - setupEnvironmentArgumentRoomBytes) /
    setupEnvironmentEscapeBytesMax,
);

/** What a POSIX shell takes as a variable's name. */
const setupEnvironmentName = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** The prefixes of every name chuggy sets in a job, or will. */
const setupEnvironmentChuggyPrefixes = ["CHUG_", "CHUGGY_"];

/** How a refusal names the file, which is where every one of them is found. */
const setupEnvironmentFileNamed = `the file ${workerSetupEnvironmentVariable} named`;

/** How a refusal names line `index` of the file, counted from one. */
function setupEnvironmentLineNamed(index) {
  return `line ${String(index + 1)} of ${setupEnvironmentFileNamed}`;
}

/** Whether `name` is chuggy's, which setup may not set. */
function setupEnvironmentReadNameChuggy(name) {
  return (
    setupEnvironmentChuggyPrefixes.some((prefix) => name.startsWith(prefix)) ||
    reservedJobVariables.includes(name) ||
    workerGitVariable(name)
  );
}

/** `name` as line `index` sets it, refused where setup may not set it; the refusal never names a value. */
function setupEnvironmentReadName(name, index) {
  if (!setupEnvironmentName.test(name))
    throw new Error(
      `${setupEnvironmentLineNamed(index)} sets a name that is not letters, digits and _ starting with no digit`,
    );
  if (setupEnvironmentReadNameChuggy(name))
    throw new Error(
      `${setupEnvironmentLineNamed(index)} sets ${name}, which is chuggy's`,
    );
  return name;
}

/**
 * Each `[name, value]` `text`, one line's file, sets, in the order it sets
 * them. Refused, naming the file's line and never a value, where a line is
 * neither form, its delimiter is empty or never closes it, or a name is not
 * one setup may set.
 */
export function setupEnvironmentRead(text) {
  const lines = text.split("\n").map((line) => line.replace(/\r$/u, ""));
  const variables = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length === 0) continue;
    const equals = line.indexOf("=");
    const heredoc = line.indexOf("<<");
    if (equals === -1 && heredoc === -1)
      throw new Error(
        `${setupEnvironmentLineNamed(index)} is neither NAME=value nor NAME<<DELIMITER`,
      );
    if (equals !== -1 && (heredoc === -1 || equals < heredoc)) {
      const name = setupEnvironmentReadName(line.slice(0, equals), index);
      variables.push([name, line.slice(equals + 1)]);
      continue;
    }
    const name = setupEnvironmentReadName(line.slice(0, heredoc), index);
    const delimiter = line.slice(heredoc + 2);
    if (delimiter.length === 0)
      throw new Error(`${setupEnvironmentLineNamed(index)} has no delimiter`);
    const end = lines.indexOf(delimiter, index + 1);
    if (end === -1)
      throw new Error(
        `${setupEnvironmentLineNamed(index)} opens a value its delimiter never closes`,
      );
    variables.push([name, lines.slice(index + 1, end).join("\n")]);
    index = end;
  }
  return variables;
}

/** What one variable weighs against `setupEnvironmentBytesMax`. */
function setupEnvironmentMergedWeight([name, value]) {
  return Buffer.byteLength(`${name}=${value}`);
}

/**
 * `passed`, what the lines before set, with `variables` laid over it, a later
 * value winning. Refused where the whole weighs more than
 * `setupEnvironmentBytesMax`.
 */
export function setupEnvironmentMerged(passed, variables) {
  const merged = new Map([...Object.entries(passed), ...variables]);
  const weight = [...merged].reduce(
    (total, variable) => total + setupEnvironmentMergedWeight(variable),
    0,
  );
  if (weight > setupEnvironmentBytesMax)
    throw new Error(
      `what setup passed on weighs ${String(weight)} bytes as NAME=value, over the ${String(setupEnvironmentBytesMax)} it may`,
    );
  return Object.fromEntries(merged);
}

/** `bytes`, one line's file, as text; refused where it is not UTF-8 or holds a NUL, which no variable can. */
function setupEnvironmentWrittenDecoded(bytes) {
  if (bytes.includes(0))
    throw new Error(`${setupEnvironmentFileNamed} holds a NUL byte`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (failure) {
    throw new Error(`${setupEnvironmentFileNamed} is not UTF-8`, {
      cause: failure,
    });
  }
}

/** A directory of the job's own, under the temporary directory, for each of its setup lines' files. */
export function setupEnvironmentDirectory(environment = process.env) {
  return mkdtemp(workerTemporaryFile("chuggy-setup-environment-", environment));
}

/** The empty file in `directory` the setup line at `index` is handed, made for it alone. */
export async function setupEnvironmentFile(directory, index) {
  const file = join(directory, String(index + 1));
  await writeFile(file, "", { flag: "wx", mode: 0o600 });
  return file;
}

/**
 * The opened `file`, refused where it is gone or no longer a regular file: a
 * link is not followed, and a pipe is opened without waiting for a writer.
 */
async function setupEnvironmentWrittenOpened(file) {
  const gone = () =>
    new Error(`${setupEnvironmentFileNamed} is gone or no longer a file`);
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (failure) {
    if (failure?.code === "ENOENT" || failure?.code === "ELOOP") throw gone();
    throw failure;
  }
  if ((await handle.stat()).isFile()) return handle;
  await handle.close();
  throw gone();
}

/**
 * Each `[name, value]` the line handed `file` set, read once the line has
 * exited. Refused where the file holds more than `setupEnvironmentBytesMax`
 * bytes, and read no further than one byte past them.
 */
export async function setupEnvironmentWritten(file) {
  const handle = await setupEnvironmentWrittenOpened(file);
  const bytes = Buffer.alloc(setupEnvironmentBytesMax + 1);
  let read = 0;
  try {
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        read,
        bytes.length - read,
        read,
      );
      if (bytesRead === 0) break;
      read += bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (read > setupEnvironmentBytesMax)
    throw new Error(
      `${setupEnvironmentFileNamed} holds more than the ${String(setupEnvironmentBytesMax)} bytes setup may pass on`,
    );
  return setupEnvironmentRead(
    setupEnvironmentWrittenDecoded(bytes.subarray(0, read)),
  );
}
