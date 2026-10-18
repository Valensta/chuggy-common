import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

/** The directory this suite and the core it holds to are in. */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * What these modules derive of a job's container paths when loaded on a
 * runner under Windows' path rules.
 */
async function underWindowsPaths() {
  const probe = `
    const job = await import(${JSON.stringify(pathToFileURL(join(here, "job.mjs")).href)});
    const argv = await import(${JSON.stringify(pathToFileURL(join(here, "engineArgv.mjs")).href)});
    const path = await import("node:path");
    console.log(JSON.stringify({
      sep: path.sep,
      jobRunDirectory: job.jobRunDirectory,
      jobProviderCredentialFile: job.jobProviderCredentialFile,
      ownerVolumesOpenArgv: argv.ownerVolumesOpenArgv("docker", ["cargo"], "runtime@sha256:${"a".repeat(64)}"),
    }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import",
    pathToFileURL(join(here, "windowsPath.fixture.mjs")).href,
    "--input-type=module",
    "--eval",
    probe,
  ]);
  return JSON.parse(stdout);
}

test("a job's container paths are posix on a runner under Windows' path rules", async () => {
  const derived = await underWindowsPaths();
  assert.equal(derived.sep, "\\");
  assert.equal(derived.jobRunDirectory, "/var/run/chuggy");
  assert.equal(
    derived.jobProviderCredentialFile,
    "/var/run/chuggy/credentials/claude-code",
  );
  assert.ok(
    derived.ownerVolumesOpenArgv.includes("/var/run/chuggy/volumes/cargo"),
    derived.ownerVolumesOpenArgv.join(" "),
  );
  for (const arg of derived.ownerVolumesOpenArgv)
    assert.ok(!arg.includes("\\"), arg);
});
