import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";

import {
  registerEndpointRefusal,
  registerPoolDirectory,
  registerPoolFileName,
  registerPoolFileWritten,
  registerPoolNameDefault,
  registerRedeemed,
  registerAskedChecked,
  registerRequest,
} from "./register.mjs";
import {
  answeringFetch,
  registeredFixture as registered,
  registeredPersonalFixture as personal,
} from "./register.fixture.mjs";
import { poolCredentials } from "./poolCredentials.mjs";

/** The longest name a runner's service manager might take in a service's name. */
const nameCharsMax = 200;

const request = {
  api: new URL("https://chuggy.example"),
  token: "registration-token-fixture",
  pool: "shame",
  capability: "Platform:Linux:Amd64",
};

/** @type {import("./register.mjs").RegisterRequest} */
const personalRequest = {
  kind: "Personal",
  api: new URL("https://chuggy.example"),
  token: "registration-token-fixture",
  capability: "Platform:Linux:Amd64",
};

/** @param {import("node:test").TestContext} t */
async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-register-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a redemption is posted to chuggy's registrations as its native media type, declaring this machine's platform", async () => {
  const { fetch, requests } = answeringFetch(201, registered);
  assert.deepEqual(await registerRedeemed(request, fetch), registered);
  assert.equal(requests.length, 1);
  const [{ url, init }] = requests;
  assert.equal(url, "https://chuggy.example/api/v1/worker-pool-registrations");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.deepEqual(init.headers, {
    "content-type": "application/vnd.chuggy.v1+json",
    accept: "application/vnd.chuggy.v1+json",
  });
  assert.deepEqual(JSON.parse(String(init.body)), {
    token: "registration-token-fixture",
    pool: "shame",
    capabilities: ["Platform:Linux:Amd64"],
  });
});

test("each refusal chuggy answers is one line, naming nothing it was sent", async () => {
  const answers = [
    [
      404,
      { error: { code: "NotFound", message: "Resource not found." } },
      "the registration token is unknown, spent or expired; mint another in chuggy's console",
    ],
    [
      403,
      { error: { code: "CapabilityNotPermitted", message: "no" } },
      "the registration token does not permit Platform:Linux:Amd64; mint one that does",
    ],
    [
      400,
      {
        error: {
          code: "InvalidRequest",
          message: "pool: Too big\n\u001b[31mred",
        },
      },
      "chuggy refused the registration as malformed: pool: Too big [31mred",
    ],
    [400, "not json", "chuggy refused the registration as malformed"],
    [
      503,
      { error: { code: "AuthorityUnavailable", message: "later" } },
      "chuggy could not answer the registration; run register again",
    ],
    [
      500,
      "",
      "chuggy failed the registration with HTTP 500; run register again",
    ],
    [415, "", "chuggy answered the registration with HTTP 415"],
  ];
  for (const [status, body, line] of answers)
    await assert.rejects(
      registerRedeemed(request, answeringFetch(status, body).fetch),
      (failure) => {
        assert.equal(/** @type {Error} */ (failure).message, line);
        return true;
      },
    );
});

test("a 201 whose body is no pool file for the pool asked for is refused, naming no value in it", async () => {
  const refused = [
    [{ ...registered, extra: 1 }, /Unrecognized key/u],
    [{ ...registered, clientSecret: "" }, /clientSecret /u],
    [
      { ...registered, tokenUrl: "http://auth.chuggy.example/t" },
      /tokenUrl is not an https URL/u,
    ],
    [{ ...registered, planeUrl: "not a url" }, /planeUrl is not an https URL/u],
    [
      {
        ...registered,
        tokenUrl: "https://op:pw-fixture@auth.chuggy.example/t",
      },
      /tokenUrl is not an https URL.*carrying no credentials/u,
    ],
    [
      { ...registered, planeUrl: "https://op@chuggy-pool.chuggy.example/" },
      /planeUrl is not an https URL.*carrying no credentials/u,
    ],
    [
      {
        ...registered,
        planeUrl: "https://:pw-fixture@chuggy-pool.chuggy.example/",
      },
      /planeUrl is not an https URL.*carrying no credentials/u,
    ],
    [{ ...registered, registryHost: "Registry/x" }, /registryHost /u],
    [{ ...registered, tenant: "" }, /tenant /u],
    [{ ...registered, pool: "other" }, /for another pool or capability/u],
    [
      { ...registered, capabilities: ["Platform:Linux:Arm64"] },
      /for another pool or capability/u,
    ],
    [
      { ...registered, capabilities: ["Platform:Linux:Amd64", "gpu"] },
      /for another pool or capability/u,
    ],
    ["{", /with no JSON/u],
  ];
  for (const [body, why] of refused)
    await assert.rejects(
      registerRedeemed(request, answeringFetch(201, body).fetch),
      (failure) => {
        const { message } = /** @type {Error} */ (failure);
        assert.match(message, why, message);
        assert.match(message, /the token is spent, so mint another$/u);
        assert.ok(!message.includes("pool-client-secret-fixture"), message);
        assert.ok(!message.includes("pw-fixture"), message);
        return true;
      },
      JSON.stringify(body),
    );
});

test("an answer past chuggy's body bound is refused rather than read", async () => {
  const body = JSON.stringify({
    ...registered,
    audience: "a".repeat(64 * 1024),
  });
  await assert.rejects(
    registerRedeemed(request, answeringFetch(201, body).fetch),
    /did not answer the registration whole, and the token is spent: HTTP response exceeds its byte bound/u,
  );
});

test("a chuggy that could not be reached is named, with why", async () => {
  /** @type {typeof globalThis.fetch} */
  const fetch = async () => {
    throw new TypeError("fetch failed", {
      cause: new Error("connect ECONNREFUSED 127.0.0.1:443"),
    });
  };
  await assert.rejects(
    registerRedeemed(request, fetch),
    /^Error: chuggy at https:\/\/chuggy\.example did not answer the registration: connect ECONNREFUSED 127\.0\.0\.1:443$/u,
  );
});

test("what the operator asked wrongly is refused before anything is redeemed", () => {
  const machine = { hostname: "shame", arch: "x64" };
  const asked = {
    api: "https://chuggy.example",
    token: "registration-token-fixture",
    pool: undefined,
  };
  const refusals = [
    [{ ...asked, api: undefined }, machine, /needs --api and --token/u],
    [{ ...asked, token: undefined }, machine, /needs --api and --token/u],
    [{ ...asked, api: "chuggy.example" }, machine, /is not a URL/u],
    [{ ...asked, api: "http://chuggy.example" }, machine, /must be https/u],
    [
      { ...asked, api: "https://chuggy.example/api" },
      machine,
      /is not an origin/u,
    ],
    [
      { ...asked, api: "https://op:pw@chuggy.example" },
      machine,
      /is not an origin/u,
    ],
    [
      { ...asked, api: "https://chuggy.example/?x=1" },
      machine,
      /is not an origin/u,
    ],
    [{ ...asked, token: "" }, machine, /--token is not a registration token/u],
    [
      { ...asked, token: "t".repeat(257) },
      machine,
      /--token is not a registration token/u,
    ],
    [asked, { ...machine, arch: "ia32" }, /this machine is ia32/u],
    [asked, { ...machine, hostname: "---" }, /hostname makes no pool name/u],
    [{ ...asked, pool: "Shame" }, machine, /--pool Shame is not a pool name/u],
    [{ ...asked, pool: "a/b" }, machine, /is not a pool name/u],
    [{ ...asked, pool: "-a" }, machine, /is not a pool name/u],
    [
      { ...asked, pool: "a".repeat(64) },
      machine,
      /is not a pool name: at most 63/u,
    ],
  ];
  for (const [refusedAsk, refusedMachine, why] of refusals) {
    const answer = registerRequest(refusedAsk, refusedMachine);
    assert.ok("refused" in answer, JSON.stringify(refusedAsk));
    assert.match(answer.refused, why);
    assert.ok(!answer.refused.includes("registration-token-fixture"));
  }
});

test("a request declares this machine's platform and names the pool for its hostname unless asked", () => {
  const asked = { api: "https://chuggy.example/", token: "t", pool: undefined };
  assert.deepEqual(registerRequest(asked, { hostname: "shame", arch: "x64" }), {
    request: {
      api: new URL("https://chuggy.example"),
      token: "t",
      pool: "shame",
      capability: "Platform:Linux:Amd64",
    },
  });
  const arm = registerRequest(
    { ...asked, api: "http://localhost:8080", pool: "geoff-laptop" },
    { hostname: "shame", arch: "arm64" },
  );
  assert.ok("request" in arm);
  assert.equal(arm.request.pool, "geoff-laptop");
  assert.equal(arm.request.capability, "Platform:Linux:Arm64");
});

test("the ask is checked apart from the platform, and a wrong ask is refused before an unknown platform is", () => {
  const asked = { api: "https://chuggy.example/", token: "t", pool: undefined };
  assert.deepEqual(registerAskedChecked(asked, "Shame.lan"), {
    checked: {
      api: new URL("https://chuggy.example"),
      token: "t",
      pool: "shame",
    },
  });
  assert.deepEqual(registerAskedChecked({ ...asked, pool: "Shame" }, "x"), {
    refused:
      "--pool Shame is not a pool name: at most 63 lowercase letters, digits and hyphens, beginning and ending with a letter or digit",
  });
  assert.deepEqual(registerAskedChecked({ ...asked, token: "" }, "x"), {
    refused: "--token is not a registration token",
  });
  const answer = registerRequest(
    { ...asked, token: undefined },
    { hostname: "shame", arch: "ia32" },
  );
  assert.deepEqual(answer, { refused: "register needs --api and --token" });
});

test("a hostname makes a pool name of its first label, lowercase, other characters hyphens", () => {
  for (const [hostname, name] of [
    ["shame", "shame"],
    ["Shame.lan", "shame"],
    ["geoff_Laptop.example.com", "geoff-laptop"],
    ["-x-", "x"],
    [`${"a".repeat(62)}_b`, `${"a".repeat(62)}`],
    ["", undefined],
    ["___", undefined],
  ])
    assert.equal(registerPoolNameDefault(hostname), name, hostname);
});

test("only https, or http on this machine's loopback, is sent a credential", () => {
  for (const url of [
    "https://chuggy.example",
    "http://localhost:8080",
    "http://127.0.0.1",
    "http://127.1.2.3:9",
    "http://[::1]:8080",
  ])
    assert.equal(registerEndpointRefusal(new URL(url)), undefined, url);
  for (const url of [
    "http://chuggy.example",
    "http://10.0.0.1",
    "http://localhost.example.com",
    "ftp://localhost",
  ])
    assert.match(
      registerEndpointRefusal(new URL(url)) ?? "",
      /must be https/u,
      url,
    );
});

test("a pool file's name tells apart tenants and projects a hyphen would join alike", () => {
  const one = registerPoolFileName(
    {
      tenant: "a-b",
      project: "c",
      pool: "shame",
    },
    nameCharsMax,
  );
  const other = registerPoolFileName(
    {
      tenant: "a",
      project: "b-c",
      pool: "shame",
    },
    nameCharsMax,
  );
  assert.equal(one, "a-b.c.shame.json");
  assert.equal(other, "a.b-c.shame.json");
  assert.equal(
    registerPoolFileName(
      { tenant: "vteng", project: "chuggy", pool: "shame" },
      nameCharsMax,
    ),
    "vteng.chuggy.shame.json",
  );
});

test("a pool file's name carries no byte a path or a unit name reads specially", () => {
  assert.equal(
    registerPoolFileName(
      { tenant: "../x", project: "a.b_c", pool: "é" },
      nameCharsMax,
    ),
    "_2e_2e_2fx.a_2eb_5fc._c3_a9.json",
  );
  assert.notEqual(
    registerPoolFileName(
      { tenant: "a.b", project: "c", pool: "p" },
      nameCharsMax,
    ),
    registerPoolFileName(
      { tenant: "a", project: "b.c", pool: "p" },
      nameCharsMax,
    ),
  );
});

test("a bound on a pool file's name that is no count of characters is refused", () => {
  for (const bound of [0, Number.NaN, 1.5, /** @type {any} */ (undefined)])
    assert.throws(
      () => registerPoolFileName(registered, bound),
      RangeError,
      String(bound),
    );
});

test("names longer than a runner's service can be named for make a digest instead", () => {
  const long = {
    tenant: "t",
    project: "p".repeat(nameCharsMax),
    pool: "shame",
  };
  const name = registerPoolFileName(long, nameCharsMax);
  assert.match(name, /^pool-[0-9a-f]{20}\.json$/u);
  assert.notEqual(
    name,
    registerPoolFileName({ ...long, pool: "other" }, nameCharsMax),
  );
  const tenant = "t".repeat(
    nameCharsMax - "p".length - "shame".length - "..".length,
  );
  assert.equal(
    registerPoolFileName({ tenant, project: "p", pool: "shame" }, nameCharsMax),
    `${tenant}.p.shame.json`,
  );
  assert.match(
    registerPoolFileName(
      { tenant: `${tenant}t`, project: "p", pool: "shame" },
      nameCharsMax,
    ),
    /^pool-[0-9a-f]{20}\.json$/u,
  );
});

test("the pool file is written owner-only and whole, and read back by the core", async (t) => {
  const directory = join(await scratch(t), "chuggy", "pools");
  await registerPoolDirectory(directory);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const { file, replaced } = await registerPoolFileWritten(
    directory,
    registered,
    nameCharsMax,
  );
  assert.equal(file, join(directory, "newtenant.arbbot.shame.json"));
  assert.equal(replaced, false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), registered);
  assert.deepEqual(await poolCredentials(file), registered);
  assert.deepEqual(await readdir(directory), ["newtenant.arbbot.shame.json"]);
});

test("registering a pool again replaces its file, and no other pool's", async (t) => {
  const directory = await scratch(t);
  await registerPoolFileWritten(directory, registered, nameCharsMax);
  const other = { ...registered, project: "chuggy" };
  await registerPoolFileWritten(directory, other, nameCharsMax);
  const again = { ...registered, clientId: "chuggy-pool-client-2" };
  const { file, replaced } = await registerPoolFileWritten(
    directory,
    again,
    nameCharsMax,
  );
  assert.equal(replaced, true);
  assert.equal(
    JSON.parse(await readFile(file, "utf8")).clientId,
    "chuggy-pool-client-2",
  );
  assert.deepEqual((await readdir(directory)).sort(), [
    "newtenant.arbbot.shame.json",
    "newtenant.chuggy.shame.json",
  ]);
});

test("a pools directory anyone else can enter, or you cannot write, is made owner-only and writable", async (t) => {
  for (const mode of [0o755, 0o500]) {
    const directory = await scratch(t);
    await chmod(directory, mode);
    await registerPoolDirectory(directory);
    assert.equal((await stat(directory)).mode & 0o777, 0o700, mode.toString(8));
  }
});

test("a pools directory a file stands in the way of is refused, saying no token was spent", async (t) => {
  const directory = join(await scratch(t), "pools");
  await writeFile(directory, "");
  await assert.rejects(
    registerPoolDirectory(directory),
    new RegExp(
      `^Error: ${directory} cannot be made a directory only you can write, so no token was spent: EEXIST`,
      "u",
    ),
  );
});

test(
  "a pools directory another user owns is refused, saying no token was spent",
  { skip: process.getuid?.() === 0 && "root may make any directory its own" },
  async (t) => {
    const directory = join(await scratch(t), "pools");
    await symlink("/", directory);
    await assert.rejects(
      registerPoolDirectory(directory),
      new RegExp(
        `^Error: ${directory} cannot be made a directory only you can write, so no token was spent: EPERM`,
        "u",
      ),
    );
  },
);

test("a pool file that cannot be renamed into place leaves no temporary file behind", async (t) => {
  const directory = await scratch(t);
  const blocking = join(directory, "newtenant.arbbot.shame.json");
  await mkdir(blocking);
  await writeFile(join(blocking, "kept"), "");
  await assert.rejects(
    registerPoolFileWritten(directory, registered, nameCharsMax),
  );
  assert.deepEqual(await readdir(directory), ["newtenant.arbbot.shame.json"]);
});

test("a personal redemption is posted to chuggy's personal registrations, naming no pool", async () => {
  const { fetch, requests } = answeringFetch(201, personal);
  assert.deepEqual(await registerRedeemed(personalRequest, fetch), personal);
  assert.equal(requests.length, 1);
  const [{ url, init }] = requests;
  assert.equal(
    url,
    "https://chuggy.example/api/v1/personal-runner-registrations",
  );
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.deepEqual(init.headers, {
    "content-type": "application/vnd.chuggy.v1+json",
    accept: "application/vnd.chuggy.v1+json",
  });
  assert.deepEqual(JSON.parse(String(init.body)), {
    token: "registration-token-fixture",
    capabilities: ["Platform:Linux:Amd64"],
  });
});

test("a 201 whose body is no personal runner's file for the capability asked for is refused, naming no value in it", async () => {
  const { kind, ...kindless } = personal;
  assert.equal(kind, "Personal");
  const refused = [
    [registered, /Unrecognized key/u],
    [kindless, /kind /u],
    [{ ...personal, kind: "Dedicated" }, /kind /u],
    [{ ...personal, project: "arbbot" }, /Unrecognized key/u],
    [{ ...personal, owner: "" }, /owner /u],
    [{ ...personal, owner: "o".repeat(257) }, /owner /u],
    [{ ...personal, tenant: "" }, /tenant /u],
    [{ ...personal, clientSecret: "" }, /clientSecret /u],
    [
      { ...personal, planeUrl: "http://chuggy-pool.chuggy.example/" },
      /planeUrl is not an https URL/u,
    ],
    [
      { ...personal, capabilities: ["Platform:Linux:Arm64"] },
      /for another pool or capability/u,
    ],
  ];
  for (const [body, why] of refused)
    await assert.rejects(
      registerRedeemed(personalRequest, answeringFetch(201, body).fetch),
      (failure) => {
        const { message } = /** @type {Error} */ (failure);
        assert.match(message, why, message);
        assert.match(message, /the token is spent, so mint another$/u);
        assert.ok(!message.includes("client-secret-fixture"), message);
        return true;
      },
      JSON.stringify(body),
    );
});

test("a pool's redemption answered with a personal runner's file is refused", async () => {
  await assert.rejects(
    registerRedeemed(request, answeringFetch(201, personal).fetch),
    /no pool file this runner reads \(.*Unrecognized key.*\); the token is spent, so mint another$/u,
  );
});

test("a personal registration that lost a race is told to run again, its token unspent; a pool's is answered as any status", async () => {
  const conflict = {
    error: { code: "RegistrationConflict", message: "try again" },
  };
  await assert.rejects(
    registerRedeemed(personalRequest, answeringFetch(409, conflict).fetch),
    /^Error: chuggy registered this member's runner again meanwhile, and the token is not spent; run register again$/u,
  );
  await assert.rejects(
    registerRedeemed(request, answeringFetch(409, conflict).fetch),
    /^Error: chuggy answered the registration with HTTP 409$/u,
  );
  await assert.rejects(
    registerRedeemed(personalRequest, answeringFetch(404, "").fetch),
    /^Error: the registration token is unknown, spent or expired/u,
  );
});

test("a personal ask names no pool, and is checked as a pool's is otherwise", () => {
  const asked = {
    api: "https://chuggy.example/",
    token: "t",
    pool: undefined,
    personal: true,
  };
  assert.deepEqual(registerAskedChecked(asked, "---"), {
    checked: {
      kind: "Personal",
      api: new URL("https://chuggy.example"),
      token: "t",
    },
  });
  assert.deepEqual(registerRequest(asked, { hostname: "---", arch: "arm64" }), {
    request: {
      kind: "Personal",
      api: new URL("https://chuggy.example"),
      token: "t",
      capability: "Platform:Linux:Arm64",
    },
  });
  for (const [refusedAsk, why] of [
    [{ ...asked, pool: "shame" }, /^--pool names a pool, .*without --pool$/u],
    [{ ...asked, token: "" }, /^--token is not a registration token$/u],
    [
      { ...asked, token: "t".repeat(257) },
      /^--token is not a registration token$/u,
    ],
    [{ ...asked, api: "http://chuggy.example" }, /must be https/u],
    [{ ...asked, token: undefined }, /needs --api and --token/u],
  ]) {
    const answer = registerAskedChecked(refusedAsk, "shame");
    assert.ok("refused" in answer, JSON.stringify(refusedAsk));
    assert.match(answer.refused, why);
  }
  assert.deepEqual(registerRequest(asked, { hostname: "x", arch: "ia32" }), {
    refused: "this machine is ia32, and a pool runs Linux on x64 or arm64",
  });
});

test("a personal runner's file is named by its tenant and owner, two parts where a pool's has three", () => {
  assert.equal(
    registerPoolFileName(personal, nameCharsMax),
    "newtenant.28_3ahttps_3a_2f_2fauth_2echuggy_2eexample_2f0f3c9a52-member.json",
  );
  const one = {
    kind: /** @type {const} */ ("Personal"),
    tenant: "a",
    owner: "b",
  };
  assert.equal(registerPoolFileName(one, nameCharsMax), "a.b.json");
  assert.notEqual(
    registerPoolFileName(one, nameCharsMax),
    registerPoolFileName({ ...one, owner: "c" }, nameCharsMax),
  );
  assert.notEqual(
    registerPoolFileName({ ...one, tenant: "a.b", owner: "c" }, nameCharsMax),
    registerPoolFileName(
      { tenant: "a", project: "b", pool: "c" },
      nameCharsMax,
    ),
  );
});

test("a personal runner's names too long for a service make a digest of their own kind", () => {
  const long = { ...personal, owner: "o".repeat(nameCharsMax) };
  const name = registerPoolFileName(long, nameCharsMax);
  assert.match(name, /^personal-[0-9a-f]{20}\.json$/u);
  assert.notEqual(
    name,
    registerPoolFileName({ ...long, tenant: "other" }, nameCharsMax),
  );
});

test("a personal runner's file is written owner-only beside a pool's of its tenant, read back by the core, and replaced by registering again", async (t) => {
  const directory = await scratch(t);
  await registerPoolFileWritten(directory, registered, nameCharsMax);
  const { file, replaced } = await registerPoolFileWritten(
    directory,
    personal,
    nameCharsMax,
  );
  assert.equal(replaced, false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await poolCredentials(file), personal);
  const again = await registerPoolFileWritten(
    directory,
    { ...personal, clientId: "chuggy-personal-client-2" },
    nameCharsMax,
  );
  assert.equal(again.file, file);
  assert.equal(again.replaced, true);
  assert.equal(
    (await poolCredentials(file)).clientId,
    "chuggy-personal-client-2",
  );
  assert.equal((await readdir(directory)).length, 2);
});
