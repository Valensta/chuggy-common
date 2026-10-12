/**
 * What a runner serves, in the forms this machine keys what it keeps by: the
 * label its containers carry, and a digest naming its runtime directory and
 * its containers. A pool is named by its tenant, project and name; a personal
 * runner by its tenant and the member it serves, one per member per tenant.
 * Each form is injective across both kinds, so two runners never share one
 * whatever their names hold: a pool's label has three names and a personal
 * runner's two, and a pool's digest is of a list of names where a personal
 * runner's leads with a list of its own.
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
const poolIdentityDigestChars = 20;

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
  return poolIdentityNames(identity)
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
  return createHash("sha256")
    .update(
      JSON.stringify([
        ...(poolIdentityPersonal(identity) ? [names] : names),
        ...more,
      ]),
      "utf8",
    )
    .digest("hex")
    .slice(0, poolIdentityDigestChars);
}
