/**
 * What a runner serves, in the forms this machine keys what it keeps by: the
 * label its containers carry, and a digest naming its runtime directory and
 * its containers. A pool is named by its tenant, project and name; a personal
 * runner by its tenant and the member it serves.
 * Each form is injective across both kinds, so two runners never share one
 * whatever their names hold: a pool's label has three names and a personal
 * runner's two, and a pool's digest is of a list of names where a personal
 * runner's leads with a list of its own. A job's project has a label and a
 * digest of its own, of its tenant and project alone: a pool's job is in the
 * pool's project, and a personal runner, serving no one project, has each job
 * in the project its assignment names, in its own tenant. So a pool's job and
 * a personal runner's in one project are keyed alike.
 */

import { createHash } from "node:crypto";

/**
 * @typedef {object} DedicatedPoolIdentity
 * @property {undefined} [kind] a pool's file names none
 * @property {string} tenant
 * @property {string} project
 * @property {string} pool
 *
 * @typedef {object} PersonalRunnerIdentity
 * @property {"Personal"} kind
 * @property {string} tenant
 * @property {string} owner the principal of the member it serves
 *
 * @typedef {DedicatedPoolIdentity | PersonalRunnerIdentity} PoolIdentity
 */

/** How much of a digest a name carries. */
export const poolIdentityDigestChars = 20;

/**
 * @param {PoolIdentity} identity
 * @returns {identity is PersonalRunnerIdentity}
 */
export function poolIdentityPersonal(identity) {
  return identity.kind === "Personal";
}

/**
 * The names that key the identity, in order: three of a pool's, two of a
 * personal runner's.
 *
 * @param {PoolIdentity} identity
 * @returns {string[]}
 */
export function poolIdentityNames(identity) {
  return poolIdentityPersonal(identity)
    ? [identity.tenant, identity.owner]
    : [identity.tenant, identity.project, identity.pool];
}

/**
 * @param {PoolIdentity} one
 * @param {PoolIdentity} other
 */
export function poolIdentitySame(one, other) {
  const names = poolIdentityNames(other);
  return (
    poolIdentityPersonal(one) === poolIdentityPersonal(other) &&
    poolIdentityNames(one).every((name, index) => name === names[index])
  );
}

/**
 * The pool label's value: the names joined by `/`, a `%` or `/` inside a name
 * percent-encoded. A name holding neither is written as itself.
 *
 * @param {PoolIdentity} identity
 */
export function poolLabelValue(identity) {
  return poolLabelValueJoined(poolIdentityNames(identity));
}

/** @param {readonly string[]} names */
function poolLabelValueJoined(names) {
  return names
    .map((name) => name.replaceAll("%", "%25").replaceAll("/", "%2F"))
    .join("/");
}

/**
 * A digest of the identity and of whatever else is named with it, as hex.
 *
 * @param {PoolIdentity} identity
 * @param {...string} more
 */
export function poolIdentityDigest(identity, ...more) {
  const names = poolIdentityNames(identity);
  return poolIdentityDigestHex([
    ...(poolIdentityPersonal(identity) ? [names] : names),
    ...more,
  ]);
}

/** @param {readonly (string | readonly string[])[]} keyed */
function poolIdentityDigestHex(keyed) {
  return createHash("sha256")
    .update(JSON.stringify(keyed), "utf8")
    .digest("hex")
    .slice(0, poolIdentityDigestChars);
}

/**
 * The tenant and project a job is in: a pool's own, whatever its assignment
 * names, and a personal runner's tenant with the project the assignment
 * names, or none where it names none.
 *
 * @param {PoolIdentity} identity
 * @param {string} [assigned] the project the job's assignment names
 */
function poolProjectNames(identity, assigned) {
  if (!poolIdentityPersonal(identity))
    return [identity.tenant, identity.project];
  return assigned === undefined ? undefined : [identity.tenant, assigned];
}

/**
 * The project label's value of the project a job is in, written as
 * `poolLabelValue` writes a pool's, of its tenant and project.
 *
 * @param {PoolIdentity} identity
 * @param {string} [assigned] the project the job's assignment names
 */
export function poolProjectLabelValue(identity, assigned) {
  const names = poolProjectNames(identity, assigned);
  return names === undefined ? undefined : poolLabelValueJoined(names);
}

/**
 * A digest of the project a job is in, as long as `poolIdentityDigest`'s.
 *
 * @param {PoolIdentity} identity
 * @param {string} [assigned] the project the job's assignment names
 */
export function poolProjectDigest(identity, assigned) {
  const names = poolProjectNames(identity, assigned);
  return names === undefined ? undefined : poolIdentityDigestHex(names);
}
