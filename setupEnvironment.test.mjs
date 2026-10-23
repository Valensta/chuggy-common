/**
 * What a job's setup lines pass on, read from the files they wrote: the two
 * forms, the names setup may not set, and the bound, weighed in the argument
 * Codex is handed it in.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  workerChangeBaseVariable,
  workerImageSteeringVariables,
  workerImageVariable,
  workerJobEnvironment,
  workerJobVariables,
  workerSetupEnvironmentVariable,
  workerShellEnvironment,
} from "./checks.mjs";
import { codexShellArguments } from "./codex.mjs";
import { reservedJobVariables } from "./job.mjs";
import { projectReadsConfiguration } from "./projectReads.mjs";
import {
  setupEnvironmentArgumentBytesMax,
  setupEnvironmentArgumentPageBytes,
  setupEnvironmentBytesMax,
  setupEnvironmentDirectory,
  setupEnvironmentFile,
  setupEnvironmentMerged,
  setupEnvironmentRead,
  setupEnvironmentWritten,
} from "./setupEnvironment.mjs";

/** The value every refusal below is checked never to name. */
const secretValue = "the value no refusal may print";

/** `body` handed a fresh directory of setup files, removed after. */
async function inSetupDirectory(body) {
  const directory = await setupEnvironmentDirectory({ TMPDIR: tmpdir() });
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** What `text` written as one line's file reads as. */
function readWritten(text) {
  return inSetupDirectory(async (directory) => {
    const file = await setupEnvironmentFile(directory, 0);
    await writeFile(file, text);
    return setupEnvironmentWritten(file);
  });
}

/**
 * Catches either form misread: a value cut at a separator it holds, a
 * delimiter matched inside a line, a line feed or carriage return kept or
 * lost, or an empty line taken as a refusal or as a value's end.
 */
test("a file is read in both forms, whichever separator comes first deciding", () => {
  assert.deepEqual(
    setupEnvironmentRead(
      [
        "PLAIN=one",
        "",
        "EQUALS=a=b<<c",
        "EMPTY=",
        "LINES<<EOF",
        "first",
        "",
        "EOF2",
        "last=<<",
        "EOF",
        "HEREDOC<<EOF=x",
        "EOF=x",
        "NONE<<EOF",
        "EOF",
        "CRLF=ends\r",
        "",
      ].join("\n"),
    ),
    [
      ["PLAIN", "one"],
      ["EQUALS", "a=b<<c"],
      ["EMPTY", ""],
      ["LINES", "first\n\nEOF2\nlast=<<"],
      ["HEREDOC", ""],
      ["NONE", ""],
      ["CRLF", "ends"],
    ],
  );
  assert.deepEqual(setupEnvironmentRead("A<<E\r\nx\r\ny\r\nE\r\n"), [
    ["A", "x\ny"],
  ]);
  assert.deepEqual(setupEnvironmentRead("CR=in\rside"), [["CR", "in\rside"]]);
  assert.deepEqual(setupEnvironmentRead(""), []);
});

/** Catches a later value losing to an earlier one, within one file or across lines. */
test("where a name is set twice the later value wins", () => {
  const passed = setupEnvironmentMerged(
    { PATH: "/first", KEPT: "kept" },
    setupEnvironmentRead("PATH=/second\nPATH=/third\nADDED=added\n"),
  );

  assert.deepEqual(passed, { PATH: "/third", KEPT: "kept", ADDED: "added" });
});

/** Every line setup may not write, beside the reason it is refused for. */
const refusedLines = [
  [`${secretValue}`, /line 1 .* is neither NAME=value nor NAME<<DELIMITER/u],
  [`=${secretValue}`, /line 1 .* sets a name that is not letters/u],
  [`1A=${secretValue}`, /sets a name that is not letters/u],
  [`A-B=${secretValue}`, /sets a name that is not letters/u],
  [`export A=${secretValue}`, /sets a name that is not letters/u],
  [`A <<EOF\n${secretValue}\nEOF`, /sets a name that is not letters/u],
  [`A<<\n${secretValue}`, /line 1 .* has no delimiter/u],
  [`OK=1\nA<<EOF\n${secretValue}\nEOF \n`, /line 2 .* never closes/u],
  [`A<<EOF\n${secretValue}`, /never closes/u],
];

/**
 * Catches a line neither form reads, a name a shell would not take as one, or
 * a delimiter that never closes being skipped, or read as something; and any
 * refusal printing a value, which nothing scrubs.
 */
test("a line neither form reads, or a name no shell takes, is refused without its value", () => {
  for (const [text, reason] of refusedLines)
    assert.throws(
      () => setupEnvironmentRead(text),
      (failure) =>
        reason.test(failure.message) && !failure.message.includes(secretValue),
      text,
    );
});

/** Every name of chuggy's the suite knows of, which setup may not set. */
const chuggyNames = [
  workerSetupEnvironmentVariable,
  workerChangeBaseVariable,
  ...Object.values(workerJobVariables),
  ...reservedJobVariables,
  ...workerImageSteeringVariables.map(workerImageVariable),
  "CHUG_ANYTHING",
  "CHUGGY_ANYTHING",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_12",
];

/**
 * Catches a name of chuggy's passed on, which would shadow one chuggy sets,
 * or skipped rather than refused, which leaves a setup that passed with
 * nowhere to say it; and the refusal printing the value.
 */
test("every name of chuggy's is refused in either form, by name and never by value", () => {
  for (const name of chuggyNames)
    for (const text of [
      `${name}=${secretValue}`,
      `${name}<<EOF\n${secretValue}\nEOF`,
    ])
      assert.throws(
        () => setupEnvironmentRead(`PATH=/bin\n${text}`),
        (failure) =>
          failure.message.includes(`line 2 `) &&
          failure.message.includes(`sets ${name}, which is chuggy's`) &&
          !failure.message.includes(secretValue),
        text,
      );
});

/**
 * Catches a refusal reaching past chuggy's own names into the project's: the
 * variables an image steers a process by, the ones git reads beyond the
 * attempt's entries, a name chuggy's prefix is only part of, and a name that
 * is a property of every object.
 */
test("every other name a shell takes is the project's to set", () => {
  const names = [
    "PATH",
    "HOME",
    ...workerImageSteeringVariables,
    "LD_ANYTHING",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_PARAMETERS",
    "CHUG",
    "CHUGGERNAUT_HOME",
    "chug_lower",
    "_",
    "__proto__",
    "A1_",
  ];
  const text = names.map((name) => `${name}=${name}'s`).join("\n");

  const passed = setupEnvironmentMerged({}, setupEnvironmentRead(text));

  assert.deepEqual(Object.keys(passed), names);
  for (const name of names) assert.equal(passed[name], `${name}'s`);
});

/** A variable whose `NAME=value` weighs `bytes`, its value the character TOML spells heaviest. */
function heaviestVariable(bytes) {
  return ["A", "\u0001".repeat(bytes - "A=".length)];
}

/**
 * Catches the bound applied to anything but the whole of what setup passes:
 * one line's variables at it are taken, one more byte across two lines is
 * refused, and a value replaced by a later one weighs only once.
 */
test("what setup passes is refused past its bound, weighed once a later value has replaced an earlier", () => {
  const [name, value] = heaviestVariable(setupEnvironmentBytesMax);
  assert.deepEqual(setupEnvironmentMerged({}, [[name, value]]), {
    [name]: value,
  });
  assert.deepEqual(
    setupEnvironmentMerged({ [name]: value }, [[name, value.slice(1)]]),
    { [name]: value.slice(1) },
  );
  assert.throws(
    () => setupEnvironmentMerged({ [name]: value.slice(1) }, [["B", ""]]),
    (failure) =>
      failure.message.includes(String(setupEnvironmentBytesMax)) &&
      !failure.message.includes(value),
  );
});

/** The pod and the attempt a job's shells are handed the most for, beside what setup passed. */
function shellsBeside(setupEnvironment) {
  return workerShellEnvironment(
    {
      PATH: "/bin",
      [workerImageVariable("NODE_OPTIONS")]: "--max-old-space-size=4096",
    },
    {
      setupEnvironment,
      changeBase: "a".repeat(64),
      job: workerJobEnvironment(
        {
          tenant: "t".repeat(64),
          project: "p".repeat(64),
          ticket: 2 ** 31,
          attempt: "a".repeat(64),
          taskKind: "Evaluation",
          stage: 99,
        },
        `https://forge.test/${"r".repeat(512)}.git`,
      ),
      git: projectReadsConfiguration(
        { origin: "https://forge.test", hostname: "forge.test" },
        join(tmpdir(), "s".repeat(128)),
      ),
    },
  );
}

/** A shell that exits cleanly, started with `argument` as one of its arguments. */
function spawnedWith(argument) {
  return spawnSync("/bin/sh", ["-c", "exit 0", "sh", argument]);
}

/**
 * Catches a bound that lets what setup passes overflow the one argument Codex
 * is told its shell in, which would leave Codex unstarted with an error naming
 * nothing setup did: the heaviest set at the bound, beside a job's own, fits,
 * and so does an argument one byte under the limit the bound is taken from.
 */
test("the heaviest set setup may pass fits the one argument Codex is handed its shell in", () => {
  const [name, value] = heaviestVariable(setupEnvironmentBytesMax);
  const [, argument] = codexShellArguments(shellsBeside({ [name]: value }));

  assert.ok(
    Buffer.byteLength(argument) < setupEnvironmentArgumentBytesMax,
    String(Buffer.byteLength(argument)),
  );
  assert.equal(spawnedWith(argument).status, 0);
  assert.equal(
    spawnedWith("x".repeat(setupEnvironmentArgumentBytesMax - 1)).status,
    0,
  );
});

/**
 * Catches a limit taken as larger than the kernel's. Only Linux bounds one
 * argument, at a size that grows with its page, so the kernel is asked only
 * where the page is the one the limit is stated for.
 */
test(
  "the kernel refuses an argument at the limit the bound is taken from",
  {
    skip:
      (process.platform !== "linux" ||
        spawnSync("getconf", ["PAGESIZE"], {
          encoding: "utf8",
        }).stdout.trim() !== String(setupEnvironmentArgumentPageBytes)) &&
      "only Linux at that page bounds one argument there",
  },
  () => {
    assert.equal(
      spawnedWith("x".repeat(setupEnvironmentArgumentBytesMax)).error?.code,
      "E2BIG",
    );
  },
);

/**
 * Catches a file read past the bound, which leaves one line able to fill the
 * core's memory, or one at it refused.
 */
test("a file is read to one byte past the bound, and refused there", async () => {
  const [name, value] = heaviestVariable(setupEnvironmentBytesMax);

  assert.deepEqual(await readWritten(`${name}=${value}`), [[name, value]]);
  await assert.rejects(
    readWritten(`${name}=${value}\n`),
    (failure) =>
      failure.message.includes(String(setupEnvironmentBytesMax)) &&
      !failure.message.includes(value),
  );
});

/** Catches bytes no variable can carry passed on, or turned into ones the line did not write. */
test("a file holding a NUL or what is not UTF-8 is refused", async () => {
  await assert.rejects(
    readWritten(Buffer.from(`A=${secretValue}\0`)),
    /holds a NUL byte/u,
  );
  await assert.rejects(
    readWritten(Buffer.from([0x41, 0x3d, 0xc3, 0x28])),
    /is not UTF-8/u,
  );
  assert.deepEqual(await readWritten("A=café \u{1F600}"), [
    ["A", "café \u{1F600}"],
  ]);
});

/**
 * Catches the file a line left in its place read through: a link followed to
 * whatever it names, a pipe waited on for a writer that never comes, and a
 * file removed read as one that set nothing.
 */
test("a file a line replaced, or removed, is refused rather than followed", async () => {
  await inSetupDirectory(async (directory) => {
    const target = join(directory, "elsewhere");
    await writeFile(target, `A=${secretValue}`);
    const linked = await setupEnvironmentFile(directory, 0);
    await rm(linked);
    await symlink(target, linked);
    await assert.rejects(setupEnvironmentWritten(linked), /no longer a file/u);

    const piped = await setupEnvironmentFile(directory, 1);
    await rm(piped);
    assert.equal(spawnSync("mkfifo", [piped]).status, 0);
    await assert.rejects(setupEnvironmentWritten(piped), /no longer a file/u);

    const removed = await setupEnvironmentFile(directory, 2);
    await rm(removed);
    await assert.rejects(setupEnvironmentWritten(removed), /is gone/u);
  });
});

/**
 * Catches a line handed a file another line was, or one that already holds
 * what something else wrote, or one another user can read.
 */
test("each line's file is its own, empty and the job's user's alone", async () => {
  await inSetupDirectory(async (directory) => {
    const first = await setupEnvironmentFile(directory, 0);
    const second = await setupEnvironmentFile(directory, 1);

    assert.notEqual(first, second);
    assert.deepEqual(await setupEnvironmentWritten(second), []);
    assert.equal((await stat(first)).mode & 0o777, 0o600);
    await assert.rejects(setupEnvironmentFile(directory, 0), {
      code: "EEXIST",
    });
  });
});

/** Catches the directory made anywhere but the temporary directory the job's environment names. */
test("a job's setup files are made under its temporary directory", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "chuggy-temporary-"));
  try {
    const directory = await setupEnvironmentDirectory({ TMPDIR: temporary });
    assert.ok(
      directory.startsWith(join(temporary, "chuggy-setup-environment-")),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
