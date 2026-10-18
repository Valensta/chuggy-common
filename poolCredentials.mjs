/**
 * The file a pool's registration writes: who the pool is, where its issuer,
 * plane and image registry are, and its client credential. A personal
 * runner's is a pool's with the project and pool taken out and the member it
 * serves put in, told apart by its `kind`. Its `host`, the one thing in it
 * chuggy did not answer, is the operator's: a job that pins no image runs on
 * the machine itself. It is refused unless only its owner can read or write
 * it, by the mode bits unless the runner says how its platform tells, and no
 * refusal carries the file's text, because the secret is in it.
 */

import { open } from "node:fs/promises";

import { workerPoolRegistrationSchema } from "@chuggy/worker-contract/workerPool";
import { z } from "zod";

/**
 * @typedef {import("./poolIdentity.mjs").PoolIdentity} PoolIdentity
 *
 * @typedef {object} PoolEndpoints
 * @property {string[]} capabilities
 * @property {string} tokenUrl
 * @property {string} audience
 * @property {string} planeUrl
 * @property {string} [registryHost] the one registry the pool presents its
 *   token to when it pulls
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {true} [host] a job that pins no image runs on the machine itself
 *
 * @typedef {PoolIdentity & PoolEndpoints} PoolCredentials
 *
 * @callback PoolCredentialsSharedRefusal why someone besides its owner can open
 *   `file`, said after its name, or nothing where no one can
 * @param {string} file
 * @param {import("node:fs").Stats} stats
 * @returns {Promise<string | undefined> | string | undefined}
 */

/** Far above what a registration writes, so a file past it is not one. */
const poolCredentialsBytesMax = 64 * 1024;

/** The permission bits a group or anyone else would read or write by. */
const poolCredentialsSharedModeBits = 0o077;

/**
 * The mode bits' answer. A platform whose mode bits do not say who may open a
 * file, as Windows' do not, is answered by its runner's own.
 *
 * @type {PoolCredentialsSharedRefusal}
 */
export function poolCredentialsModeRefusal(file, stats) {
  return (stats.mode & poolCredentialsSharedModeBits) === 0
    ? undefined
    : `is mode ${(stats.mode & 0o777).toString(8)}; only its owner may read or write it (chmod 600)`;
}

const poolCredentialsTextSchema = z.string().min(1);

const poolCredentialsSchema = z.strictObject({
  tenant: poolCredentialsTextSchema,
  project: poolCredentialsTextSchema,
  pool: workerPoolRegistrationSchema.shape.pool,
  capabilities: workerPoolRegistrationSchema.shape.capabilities,
  tokenUrl: poolCredentialsTextSchema,
  audience: poolCredentialsTextSchema,
  planeUrl: poolCredentialsTextSchema,
  registryHost: z
    .string()
    .regex(
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?$/u,
    )
    .optional(),
  clientId: poolCredentialsTextSchema,
  clientSecret: poolCredentialsTextSchema,
  host: z.literal(true).optional(),
});

const personalRunnerCredentialsSchema = poolCredentialsSchema
  .omit({ project: true, pool: true })
  .extend({ kind: z.literal("Personal"), owner: poolCredentialsTextSchema });

/**
 * The credentials at `file`, checked and read through one handle so the file
 * checked is the file read. A syntax error's own message quotes the text, so
 * only the fact of it is reported; zod's issue messages name a path and a
 * type, never the value.
 *
 * @param {string} file
 * @param {PoolCredentialsSharedRefusal} [sharedRefusal]
 * @returns {Promise<PoolCredentials>}
 */
export async function poolCredentials(
  file,
  sharedRefusal = poolCredentialsModeRefusal,
) {
  const handle = await open(file, "r");
  let text;
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      throw new Error(`pool credentials ${file} is not a file`);
    const shared = await sharedRefusal(file, stats);
    if (shared !== undefined)
      throw new Error(`pool credentials ${file} ${shared}`);
    if (stats.size > poolCredentialsBytesMax)
      throw new Error(`pool credentials ${file} is larger than a registration`);
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(`pool credentials ${file} is not JSON`);
  }
  const parsed = (
    document?.kind === "Personal"
      ? personalRunnerCredentialsSchema
      : poolCredentialsSchema
  ).safeParse(document);
  if (!parsed.success)
    throw new Error(
      `pool credentials ${file}: ${parsed.error.issues
        .map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join(".")} ${issue.message}`
            : issue.message,
        )
        .join("; ")}`,
    );
  return parsed.data;
}
