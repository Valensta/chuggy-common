import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { poolCredentials } from "./poolCredentials.mjs";

const secret = "pool-secret-that-never-reaches-a-message";

const registration = {
  tenant: "vteng",
  project: "chuggy",
  pool: "shame",
  capabilities: ["Platform:Linux:Amd64"],
  tokenUrl: "https://auth.invalid/oauth2/token",
  audience: "https://chuggy.invalid/api",
  planeUrl: "https://chuggy-pool.invalid/",
  clientId: "chuggy-pool-one",
  clientSecret: secret,
};

/** A personal runner's file: a pool's less its project and pool, naming its member. */
const personal = {
  kind: "Personal",
  tenant: registration.tenant,
  owner: "28:https://auth.invalid/oauth2/geoff",
  capabilities: registration.capabilities,
  tokenUrl: registration.tokenUrl,
  audience: registration.audience,
  planeUrl: registration.planeUrl,
  clientId: registration.clientId,
  clientSecret: secret,
};

/** A file holding `text` at `mode` in a directory of its own, removed after `read`. */
async function written(text, mode, read) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-pool-credentials-"));
  try {
    const file = join(directory, "pool.json");
    await writeFile(file, text);
    await chmod(file, mode);
    return await read(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The refusal reading `text` at `mode` came to, which must not carry the secret. */
async function refusal(text, mode = 0o600) {
  const refused = await written(text, mode, (file) =>
    poolCredentials(file).then(
      () => assert.fail("the file was read"),
      (failure) => failure,
    ),
  );
  assert.ok(!String(refused.message).includes(secret), refused.message);
  assert.equal(refused.cause, undefined);
  return refused.message;
}

test("a registration's file only its owner can open is read back whole", async () => {
  for (const mode of [0o600, 0o400])
    assert.deepEqual(
      await written(JSON.stringify(registration), mode, poolCredentials),
      registration,
    );
});

test("a registration naming its registry host, with or without a port, is read back whole", async () => {
  for (const registryHost of [
    "chuggy-registry.invalid",
    "localhost:5000",
    "localhost:30500",
    "10.43.129.13:5000",
    "registry.us-east-1.invalid:443",
  ]) {
    const named = { ...registration, registryHost };
    assert.deepEqual(
      await written(JSON.stringify(named), 0o600, poolCredentials),
      named,
    );
  }
});

test("a registry host that is not exactly a lowercase host and port is refused by name", async () => {
  for (const registryHost of [
    "https://chuggy-registry.invalid",
    "chuggy-registry.invalid/v2",
    "Chuggy-Registry.invalid",
    "chuggy..invalid",
    "chuggy-.invalid",
    "-chuggy.invalid",
    "chuggy.-invalid",
    "chuggy.invalid-",
    "chuggy.registry..invalid",
    "chuggy_registry.invalid",
    "localhost:",
    "localhost:http",
    "localhost:123456",
    "",
  ])
    assert.match(
      await refusal(JSON.stringify({ ...registration, registryHost })),
      /registryHost/u,
    );
});

test("a file a group or anyone else can open is refused, naming its mode", async () => {
  for (const mode of [0o640, 0o620, 0o610, 0o604, 0o602, 0o601, 0o644])
    assert.match(
      await refusal(JSON.stringify(registration), mode),
      new RegExp(`is mode ${mode.toString(8)};`, "u"),
    );
});

test("a file that is not JSON is refused without quoting it", async () => {
  assert.match(
    await refusal(`{"clientSecret": ${secret}}`),
    /pool\.json is not JSON$/u,
  );
});

test("a file missing a member, holding one more, or with one of the wrong kind is refused by name", async () => {
  const { clientSecret, ...unnamed } = registration;
  assert.equal(clientSecret, secret);
  for (const [document, named] of [
    [unnamed, /clientSecret/u],
    [{ ...registration, extra: secret }, /extra/u],
    [{ ...registration, capabilities: [`bad ${secret}`] }, /capabilities\.0/u],
    [{ ...registration, clientSecret: 7 }, /clientSecret/u],
    [{ ...registration, clientId: "" }, /clientId/u],
  ])
    assert.match(await refusal(JSON.stringify(document)), named);
});

test("a file larger than any registration is refused unread", async () => {
  assert.match(
    await refusal(
      JSON.stringify({ ...registration, pad: secret.repeat(4_096) }),
    ),
    /larger than a registration/u,
  );
});

test("a path that is no file is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-pool-credentials-"));
  try {
    const inner = join(directory, "pool.json");
    await mkdir(inner, { mode: 0o700 });
    await assert.rejects(poolCredentials(inner), /is not a file/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a personal runner's file is read back whole", async () => {
  assert.deepEqual(
    await written(JSON.stringify(personal), 0o600, poolCredentials),
    personal,
  );
});

test("a personal runner's file naming a project or pool, or no member, or a pool's naming a kind, is refused by name", async () => {
  const { owner, ...ownerless } = personal;
  assert.match(owner, /geoff$/u);
  for (const [document, named] of [
    [{ ...personal, project: "chuggy" }, /project/u],
    [{ ...personal, pool: "shame" }, /pool/u],
    [ownerless, /owner/u],
    [{ ...personal, owner: "" }, /owner/u],
    [{ ...personal, kind: "personal" }, /project.*pool|pool.*project/u],
    [{ ...registration, kind: "Personal" }, /project/u],
    [{ ...registration, kind: "Dedicated" }, /kind/u],
  ])
    assert.match(await refusal(JSON.stringify(document)), named);
});
