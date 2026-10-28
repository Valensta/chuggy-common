import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  poolIdentityDigest,
  poolIdentitySame,
  poolLabelValue,
  poolProjectDigest,
  poolProjectLabelValue,
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

test("a pool's project is labelled and digested by its tenant and project alone, whatever its pool", () => {
  assert.equal(poolProjectLabelValue(shame), "vteng/chuggy");
  assert.equal(
    poolProjectLabelValue({ ...shame, pool: "other" }),
    poolProjectLabelValue(shame),
  );
  assert.equal(
    poolProjectDigest({ ...shame, pool: "other" }),
    poolProjectDigest(shame),
  );
  assert.match(poolProjectDigest(shame) ?? "", /^[0-9a-f]{20}$/u);
});

test("no two projects share a project label or digest, whatever their names hold", () => {
  const projects = [
    { tenant: "a/b", project: "c", pool: "p" },
    { tenant: "a", project: "b/c", pool: "p" },
    { tenant: "a.b", project: "c", pool: "p" },
    { tenant: "a", project: "b.c", pool: "p" },
    { tenant: "a-b", project: "c", pool: "p" },
    { tenant: "a", project: "b-c", pool: "p" },
  ];
  for (const named of [poolProjectLabelValue, poolProjectDigest]) {
    const values = projects.map(named);
    assert.equal(new Set(values).size, projects.length, String(values));
  }
});

test("a project's digest is the one the volumes already made for it are named by", () => {
  assert.equal(poolProjectDigest(shame), "4c98dbae06cb18f9a603");
});

test("a pool's job is in its pool's project, whatever its assignment names", () => {
  assert.equal(poolProjectLabelValue(shame, "other"), "vteng/chuggy");
  assert.equal(poolProjectDigest(shame, "other"), poolProjectDigest(shame));
});

test("a personal runner's job is in the project its assignment names, in its tenant, keyed as a pool's job there is, and in none where it names none", () => {
  assert.equal(poolProjectLabelValue(geoff, "chuggy"), "vteng/chuggy");
  assert.equal(poolProjectDigest(geoff, "chuggy"), poolProjectDigest(shame));
  assert.notEqual(
    poolProjectDigest(geoff, "other"),
    poolProjectDigest(geoff, "chuggy"),
  );
  assert.notEqual(
    poolProjectDigest({ ...geoff, tenant: "newtenant" }, "chuggy"),
    poolProjectDigest(geoff, "chuggy"),
  );
  assert.equal(poolProjectLabelValue(geoff), undefined);
  assert.equal(poolProjectDigest(geoff), undefined);
});

/** The digest each identity was keyed by before a chat host was one, of `keyed`. */
function digestOf(keyed) {
  return createHash("sha256")
    .update(JSON.stringify(keyed), "utf8")
    .digest("hex")
    .slice(0, 20);
}

/** @type {import("./poolIdentity.mjs").ChatHostIdentity} */
const geoffsHost = {
  kind: "ChatHost",
  tenant: geoff.tenant,
  owner: geoff.owner,
};

test("a personal runner's label and digest are the ones it always had, so a runner finds what it ran before", () => {
  assert.equal(
    poolLabelValue(geoff),
    `vteng/${geoff.owner.replaceAll("/", "%2F")}`,
  );
  assert.equal(
    poolIdentityDigest(geoff, "asg-1"),
    digestOf([["vteng", geoff.owner], "asg-1"]),
  );
  assert.equal(poolIdentityDigest(geoff), digestOf([["vteng", geoff.owner]]));
});

test("a chat host is labelled by its tenant and owner then chat and host, four names, never its member's runner's or a pool's", () => {
  assert.equal(
    poolLabelValue(geoffsHost),
    `vteng/${geoff.owner.replaceAll("/", "%2F")}/chat/host`,
  );
  const host = { ...geoffsHost, tenant: "a", owner: "b" };
  assert.notEqual(
    poolLabelValue(host),
    poolLabelValue({ ...geoff, tenant: "a", owner: "b" }),
  );
  assert.notEqual(
    poolLabelValue(host),
    poolLabelValue({ tenant: "a", project: "b", pool: "chat/host" }),
  );
});

test("a chat host's digest is never its member's runner's or a pool's, whatever is named with it", () => {
  const host = { ...geoffsHost, tenant: "a", owner: "b" };
  const runner = { ...geoff, tenant: "a", owner: "b" };
  assert.match(poolIdentityDigest(host), /^[0-9a-f]{20}$/u);
  for (const more of [[], ["chat", "host"], ["asg-1"]]) {
    assert.notEqual(
      poolIdentityDigest(host, ...more),
      poolIdentityDigest(runner, ...more),
    );
    assert.notEqual(
      poolIdentityDigest(host, ...more),
      poolIdentityDigest(runner, "chat", "host", ...more),
    );
  }
  assert.notEqual(
    poolIdentityDigest(host, "asg-1"),
    poolIdentityDigest({ tenant: "a", project: "b", pool: "chat" }, "host"),
  );
  assert.notEqual(
    poolIdentityDigest(host),
    poolIdentityDigest({ ...host, owner: "c" }),
  );
});

test("a chat host is the same host only in its tenant and owner, and never its member's runner", () => {
  assert.ok(poolIdentitySame(geoffsHost, { ...geoffsHost }));
  assert.ok(!poolIdentitySame(geoffsHost, { ...geoffsHost, owner: "other" }));
  assert.ok(!poolIdentitySame(geoffsHost, geoff));
  assert.ok(!poolIdentitySame(geoff, geoffsHost));
});

test("a chat host's job is in the project its assignment names, keyed as its member's runner's there", () => {
  assert.equal(poolProjectLabelValue(geoffsHost, "chuggy"), "vteng/chuggy");
  assert.equal(
    poolProjectDigest(geoffsHost, "chuggy"),
    poolProjectDigest(geoff, "chuggy"),
  );
  assert.equal(poolProjectDigest(geoffsHost), undefined);
});
