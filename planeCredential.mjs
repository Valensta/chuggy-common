/**
 * The git credentials this pod asks the worker plane for, each minted for one
 * repository at the moment it is needed.
 *
 * THE PLANE DECIDES AND THE POD ASKS. A pod may ask for a read of any
 * repository its project binds, and never for more. An attempt naming no
 * repository is answered for its own: the plane reads it off the attempt's own
 * row and mints the least the recorded task kind needs, a work attempt's push
 * among it. An attempt naming its own repository is minted a read of it, and
 * one naming any other is minted a read only where its project binds that
 * repository. A session names its repository, because a site may have placed
 * it against a mirror of the binding, and the plane holds that name to the
 * project's own bindings.
 *
 * NOT FOUND IS THE LAUNCHER'S CREDENTIAL FOR ITS OWN REPOSITORY, AND NO
 * CREDENTIAL FOR ANY OTHER. A deployment holding no app key, and a repository
 * no claim of this tenant's covers, both answer not found; an attempt then
 * resolves what its launcher mounted for the repository it works in, which is
 * what it did before this plane minted anything, and holds nothing for one it
 * named. A not found that says which way the plane's app does not reach the
 * repository is answered as that, so the pod says it before it tries the
 * mount: a person reading a missing mapping would not look at the app's
 * installation. Any other refusal or outage reaches the caller as the transport
 * reports one, because a credential the plane meant to mint and could not is
 * no reason to reach a remote with something else.
 *
 * THE PASSWORD IS WRITTEN AND NEVER PASSED. git reads the attempt's own
 * through the askpass script, which reads a file, so the value reaches no
 * argument list and no child's environment. The file is rewritten in place
 * when the attempt asks again, as its push does.
 *
 * THE TOKEN NEVER RESTS ON A NODE'S DISK. It is written under
 * `mintedCredentialDirectory`, which every pod document mounts a memory-backed
 * volume at, rather than under `TMPDIR`: a container's own writable layer is
 * node-local disk, while every credential the launcher mounts is already tmpfs.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  sessionPlaneAnswers,
  sessionPlaneRoutes,
} from "@chuggy/worker-contract/sessionPlane";
import { mintedCredentialDirectory } from "@chuggy/worker-contract/workerEnvironment";
import {
  workerCredentialAbsentSchema,
  workerCredentialUnreachedSchema,
  workerPlaneAnswers,
  workerPlaneRoutes,
} from "@chuggy/worker-contract/workerPlane";

import { workerRequest } from "./transport.mjs";
import { answeredWith } from "./wire.mjs";

/** The route an attempt bearer asks its own credential through. */
export const workerCredentialPath = workerPlaneRoutes.credential.path;

/** The route a session bearer asks a repository's credential through. */
export const sessionCredentialPath = sessionPlaneRoutes.credential.path;

/** What each of those routes answers for a repository it mints nothing for. */
const notMintedStatuses = new Map([
  [
    workerCredentialPath,
    answeredWith(workerPlaneAnswers.credential, workerCredentialAbsentSchema),
  ],
  [
    sessionCredentialPath,
    answeredWith(sessionPlaneAnswers.credential, workerCredentialAbsentSchema),
  ],
]);

/** The file the minted password stands in, which only this pod can read. */
const planeCredentialFileName = "chuggy-git-credential";

/** What the file is created with, so nothing outside this pod's user reads it. */
const planeCredentialFileMode = 0o600;

/** @param {unknown} minted */
function planeCredentialChecked(minted) {
  const answered = /** @type {{username?: unknown, password?: unknown}} */ (
    minted
  );
  if (
    typeof answered?.username !== "string" ||
    answered.username.length === 0 ||
    typeof answered.password !== "string" ||
    answered.password.length === 0
  )
    throw new Error("the worker plane answered a credential it did not mint");
  return { username: answered.username, password: answered.password };
}

/**
 * What a not found carries of which way the app does not reach the
 * repository, where it carries any.
 */
async function planeCredentialUnreached(response) {
  const body = await response.json().catch(() => undefined);
  const absent = workerCredentialAbsentSchema.safeParse(body);
  return absent.success ? absent.data.unreached : undefined;
}

/**
 * What a person reads of `unreached`: the repository, the app, the
 * installation where there is one, and what the operator does about it. Each
 * is an identity and never a credential.
 */
export function planeCredentialUnreachedText(unreached) {
  const parsed = workerCredentialUnreachedSchema.parse(unreached);
  const { repository, app } = parsed;
  const minted = `the worker plane mints no credential for ${repository}`;
  switch (parsed.reach) {
    case "Unselected":
      return `${minted}: the ${app} app's installation ${parsed.installation} does not select it; add it to that installation's repository selection`;
    case "Refused":
      return `${minted}: the forge refused the ${app} app's installation ${parsed.installation}, for its key, a suspension or a permission not accepted; go to the ${app} app's installation page`;
    case "Unclaimed":
      return `${minted}: no installation of the ${app} app is claimed on its owner; install the ${app} app there`;
    default:
      throw new Error(
        `no text for a repository unreached as ${String(parsed.reach)}`,
      );
  }
}

/**
 * The username and password the plane minted at `path` for `repository`;
 * `{unreached}` where it mints none and says which way its app does not reach
 * it; or nothing where it mints none and says no more. An attempt names no
 * `repository` for what its task kind needs of its own. `request` is the seam
 * each mode reaches the plane through.
 */
export async function planeCredentialAnswered({
  task,
  bearer,
  path,
  repository,
  request = workerRequest,
}) {
  const notMinted = notMintedStatuses.get(path);
  if (notMinted === undefined)
    throw new Error(`${path} is not a route a credential is minted through`);
  const response = await request(
    task,
    bearer,
    path,
    repository === undefined
      ? { method: "POST" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repository }),
        },
    { settled: notMinted },
  );
  if (notMinted.includes(response.status)) {
    const unreached = await planeCredentialUnreached(response);
    return unreached === undefined ? undefined : { unreached };
  }
  if (!response.ok)
    throw new Error(
      `the worker plane answered ${String(response.status)} for a credential`,
    );
  return planeCredentialChecked(await response.json());
}

/**
 * The credential the plane minted for this pod, written where the askpass
 * reads it, with the username the askpass answers beside it; `{unreached}`
 * where the plane says which way its app does not reach the repository; or
 * nothing where it mints none and the pod falls back to what its launcher
 * mounted. The caller presents it with `workerCredentialEnvironment` for the
 * URL it reaches, which is the host the askpass answers. `directory` is where
 * the file is written, the contract's minted directory where it names none;
 * `write` is the seam a suite reads the password back from.
 */
export async function planeCredential({
  write = writeFile,
  directory = mintedCredentialDirectory,
  ...asked
}) {
  const minted = await planeCredentialAnswered(asked);
  if (minted === undefined || minted.unreached !== undefined) return minted;
  const file = join(directory, planeCredentialFileName);
  await write(file, minted.password, { mode: planeCredentialFileMode });
  return { file, username: minted.username, password: minted.password };
}
