/**
 * `./chatIsolation.test.mjs` run as root holding only the capabilities a
 * supervisor's container is given, `chatSupervisorCapabilities`, with none
 * to gain: what that suite proves of two sessions holds of a supervisor
 * with no more, and one with a capability fewer fails it. A suite run where
 * root's capabilities cannot be dropped proves none of it, and is skipped
 * saying so.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { chatSupervisorCapabilities } from "./chatHost.mjs";

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));

/** Each capability the container names, by its number in the kernel's sets. */
const capabilityBits = {
  CHOWN: 0,
  DAC_OVERRIDE: 1,
  FOWNER: 3,
  FSETID: 4,
  SETGID: 6,
  SETUID: 7,
  SETPCAP: 8,
};

/** Why this machine cannot answer the suite's question, or nothing where it can. */
const skipped =
  process.platform !== "linux"
    ? `capabilities are a Linux container's, and this is ${process.platform}`
    : process.getuid?.() !== 0
      ? "only root holds the capabilities to drop"
      : await run("setpriv", ["--version"]).then(
          () => false,
          () => "setpriv, which drops them, is not on this machine",
        );

/** The longest the isolation suite may take, under any set. */
const suiteMs = 10 * 60 * 1000;

/** This process's environment less the runner's mark of a suite it started, under which a run reports to it rather than printing. */
const suiteEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT"),
);

/** `command` run as root holding `capabilities` and none to gain. */
function heldOnly(capabilities, command) {
  const named = capabilities.map((name) => `+${name.toLowerCase()}`);
  return run(
    "setpriv",
    [
      `--bounding-set=-all${named.length === 0 ? "" : `,${named.join(",")}`}`,
      "--inh-caps=-all",
      "--no-new-privs",
      "--",
      ...command,
    ],
    {
      cwd: here,
      env: suiteEnvironment,
      timeout: suiteMs,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

/** The isolation suite's TAP under `capabilities`, whether it passed or not. */
function isolationUnder(capabilities) {
  return heldOnly(capabilities, [
    process.execPath,
    "--test",
    "--test-reporter=tap",
    join(here, "chatIsolation.test.mjs"),
  ]).then(
    ({ stdout }) => ({ passed: true, tap: stdout }),
    (failure) => ({ passed: false, tap: String(failure.stdout ?? "") }),
  );
}

test(
  "a process held to the container's set holds those capabilities alone, and can gain none",
  { skip: skipped },
  async () => {
    const { stdout } = await heldOnly(chatSupervisorCapabilities, [
      "grep",
      "-E",
      "^(CapEff|CapPrm|CapBnd|NoNewPrivs):",
      "/proc/self/status",
    ]);
    const mask = chatSupervisorCapabilities
      .map((name) => 1n << BigInt(capabilityBits[name]))
      .reduce((all, bit) => all | bit, 0n)
      .toString(16)
      .padStart(16, "0");
    assert.deepEqual(stdout.trim().split("\n").sort(), [
      `CapBnd:\t${mask}`,
      `CapEff:\t${mask}`,
      `CapPrm:\t${mask}`,
      "NoNewPrivs:\t1",
    ]);
  },
);

test(
  "two sessions are isolated by a supervisor holding the container's capabilities alone",
  { skip: skipped },
  async () => {
    const { passed, tap } = await isolationUnder(chatSupervisorCapabilities);
    assert.match(tap, /^# skipped 0$/mu, tap);
    assert.match(tap, /^# fail 0$/mu, tap);
    assert.ok(passed, tap);
  },
);

/** Catches a set this suite passes under whatever it holds, which would prove nothing of it. */
test(
  "a supervisor that cannot keep a mirror's group on what is made in it fails the isolation suite",
  { skip: skipped },
  async () => {
    const { passed, tap } = await isolationUnder(
      chatSupervisorCapabilities.filter((name) => name !== "FSETID"),
    );
    assert.equal(passed, false, tap);
    assert.match(
      tap,
      /^not ok 2 - a later session reads what its mirror fetched since, through its group$/mu,
      tap,
    );
  },
);
