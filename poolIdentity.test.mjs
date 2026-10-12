import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  poolIdentityDigest,
  poolIdentitySame,
  poolLabelValue,
} from "./poolIdentity.mjs";

const shame = { tenant: "vteng", project: "chuggy", pool: "shame" };

/** @type {import("./poolIdentity.mjs").PersonalRunnerIdentity} */
const geoff = {
  kind: "Personal",
  tenant: "vteng",
  owner: "28:https://auth.chuggy.example/geoff",
};

test("a pool whose names hold no '%' or '/' is labelled as it always was", () => {
  assert.equal(poolLabelValue(shame), "vteng/chuggy/shame");
  assert.equal(
    poolLabelValue({
      tenant: "new-tenant",
      project: "arb-bot",
      pool: "sh.a_me",
    }),
    "new-tenant/arb-bot/sh.a_me",
  );
});

test("a '/' or '%' inside a name is encoded, so no two pools share a label", () => {
  const labels = [
    { tenant: "a/b", project: "c", pool: "p" },
    { tenant: "a", project: "b/c", pool: "p" },
    { tenant: "a%2Fb", project: "c", pool: "p" },
  ].map(poolLabelValue);
  assert.deepEqual(labels, ["a%2Fb/c/p", "a/b%2Fc/p", "a%252Fb/c/p"]);
});

test("a digest is fixed in length and tells apart names a separator would join alike", () => {
  const one = poolIdentityDigest({ tenant: "a-b", project: "c", pool: "p" });
  const other = poolIdentityDigest({ tenant: "a", project: "b-c", pool: "p" });
  assert.match(one, /^[0-9a-f]{20}$/u);
  assert.notEqual(one, other);
  assert.notEqual(
    poolIdentityDigest(shame),
    poolIdentityDigest(shame, "asg-1"),
  );
  assert.equal(
    poolIdentityDigest(shame, "asg-1"),
    poolIdentityDigest({ ...shame }, "asg-1"),
  );
});

test("a pool is the same pool only in all three names", () => {
  assert.ok(poolIdentitySame(shame, { ...shame }));
  for (const differs of [
    { ...shame, tenant: "newtenant" },
    { ...shame, project: "arbbot" },
    { ...shame, pool: "other" },
  ])
    assert.ok(!poolIdentitySame(shame, differs), JSON.stringify(differs));
});

test("a pool's digest is the one it always was, so a runner finds what it ran before", () => {
  const before = createHash("sha256")
    .update(JSON.stringify(["vteng", "chuggy", "shame", "asg-1"]), "utf8")
    .digest("hex")
    .slice(0, 20);
  assert.equal(poolIdentityDigest(shame, "asg-1"), before);
});

test("a personal runner is labelled by its tenant and owner, two names where a pool has three", () => {
  assert.equal(
    poolLabelValue(geoff),
    "vteng/28:https:%2F%2Fauth.chuggy.example%2Fgeoff",
  );
  assert.equal(
    poolLabelValue({ ...geoff, tenant: "a", owner: "b%" }),
    "a/b%25",
  );
  assert.notEqual(
    poolLabelValue({ ...geoff, tenant: "a", owner: "b/c" }),
    poolLabelValue({ tenant: "a", project: "b", pool: "c" }),
  );
});

test("a personal runner's digest is never a pool's, whatever is named with it", () => {
  const personal = { ...geoff, tenant: "a", owner: "b" };
  const pool = { tenant: "a", project: "b", pool: "c" };
  assert.match(poolIdentityDigest(personal), /^[0-9a-f]{20}$/u);
  assert.notEqual(poolIdentityDigest(personal, "c"), poolIdentityDigest(pool));
  assert.notEqual(
    poolIdentityDigest(personal, "c", "asg-1"),
    poolIdentityDigest(pool, "asg-1"),
  );
  assert.notEqual(
    poolIdentityDigest(personal),
    poolIdentityDigest({ ...personal, owner: "c" }),
  );
});

test("a personal runner is the same runner only in its tenant and owner, and never a pool", () => {
  assert.ok(poolIdentitySame(geoff, { ...geoff }));
  for (const differs of [
    { ...geoff, tenant: "newtenant" },
    { ...geoff, owner: "28:https://auth.chuggy.example/other" },
  ])
    assert.ok(!poolIdentitySame(geoff, differs), JSON.stringify(differs));
  const pool = { tenant: "vteng", project: geoff.owner, pool: "shame" };
  assert.ok(!poolIdentitySame(geoff, pool));
  assert.ok(!poolIdentitySame(pool, geoff));
});
