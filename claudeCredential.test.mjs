import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeCredentialCarried,
  claudeCredentialEnvironment,
  claudeCredentialFile,
  claudeCredentialNamed,
  claudeCredentialProviderVariables,
  claudeCredentialRefusal,
  claudeCredentialSchema,
  claudeCredentialSecrets,
  claudeCredentialSetting,
  claudeCredentialVariable,
  claudeCredentialVariables,
} from "./claudeCredential.mjs";
import {
  decidingFor,
  providerDecidingVariables,
} from "./claudeCredential.fixture.mjs";
import { credentialScrub } from "./runEvidence.mjs";

/** AWS's own documented example keys, which no account holds. */
const awsKeyId = "AKIAIOSFODNN7EXAMPLE";
const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const awsOtherSecret = "je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY";
const awsSessionToken = "FwoGZXIvYXdzEXAMPLESESSIONTOKENxyz0123456789";

const awsCredentials = [
  "# the owner's own keys",
  "[default]",
  `aws_access_key_id = ${awsKeyId}`,
  `aws_secret_access_key = ${awsOtherSecret}`,
  "",
  "[chuggy]",
  `aws_access_key_id=${awsKeyId}`,
  `aws_secret_access_key=${awsSecret}`,
  `aws_session_token = ${awsSessionToken}`,
].join("\n");

/** A key's PEM body of letters no key holds, its armour built so no scanner reads it as one. */
const pemLines = [
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCexampleexample",
  "bodyLineTwoOfAKeyNobodyHoldsSoItIsSafeToCommitInASuiteOfThisTree0",
  "bodyLineThreeIsShortButStillLong",
];
const armour = (edge) => `-----${edge} ${["PRIVATE", "KEY"].join(" ")}-----`;
const privateKey = [armour("BEGIN"), ...pemLines, armour("END"), ""].join("\n");
const privateKeyId = "0123456789abcdef0123456789abcdef01234567";
const serviceAccountKey = JSON.stringify({
  type: "service_account",
  project_id: "example-project",
  private_key_id: privateKeyId,
  private_key: privateKey,
  client_email: "chuggy@example-project.iam.gserviceaccount.com",
});

const apiKey = "sk-ant-api03-exampleexampleexampleexample";

/** Each kind as a runner's configuration names it, its setting, and its file. */
const configured = [
  {
    credential: { kind: "Subscription", tokenFile: "/owner/claude-token" },
    setting: { kind: "Subscription" },
    file: "/owner/claude-token",
  },
  {
    credential: { kind: "ApiKey", apiKeyFile: "/owner/anthropic-key" },
    setting: { kind: "ApiKey" },
    file: "/owner/anthropic-key",
  },
  {
    credential: {
      kind: "Bedrock",
      region: "us-west-2",
      apiKeyFile: "/owner/bedrock-key",
    },
    setting: { kind: "Bedrock", region: "us-west-2" },
    file: "/owner/bedrock-key",
  },
  {
    credential: {
      kind: "Bedrock",
      region: "us-west-2",
      credentialsFile: "/owner/aws-credentials",
    },
    setting: { kind: "Bedrock", region: "us-west-2", profile: "default" },
    file: "/owner/aws-credentials",
  },
  {
    credential: {
      kind: "Bedrock",
      region: "eu-central-1",
      credentialsFile: "/owner/aws-credentials",
      profile: "chuggy",
    },
    setting: { kind: "Bedrock", region: "eu-central-1", profile: "chuggy" },
    file: "/owner/aws-credentials",
  },
  {
    credential: {
      kind: "Vertex",
      region: "us-east5",
      project: "example-project",
      credentialsFile: "/owner/service-account.json",
    },
    setting: { kind: "Vertex", region: "us-east5", project: "example-project" },
    file: "/owner/service-account.json",
  },
  {
    credential: {
      kind: "Foundry",
      resource: "example-resource",
      apiKeyFile: "/owner/foundry-key",
    },
    setting: { kind: "Foundry", resource: "example-resource" },
    file: "/owner/foundry-key",
  },
];

/** The issues a configuration is refused with, as a runner prints them. */
function refusals(credential) {
  const parsed = claudeCredentialSchema.safeParse(credential);
  assert.ok(!parsed.success, `${JSON.stringify(credential)} was accepted`);
  return parsed.error.issues.map((issue) =>
    `${issue.path.join(".")} ${issue.message}`.trim(),
  );
}

/** Catches a kind read as another's setting, or its secret looked for in the wrong file. */
test("a runner's Claude credential is its kind's setting and one file", () => {
  for (const { credential, setting, file } of configured) {
    const parsed = claudeCredentialSchema.parse(credential);
    assert.deepEqual(claudeCredentialSetting(parsed), setting, credential.kind);
    assert.equal(claudeCredentialFile(parsed), file, credential.kind);
    assert.deepEqual(
      claudeCredentialNamed({
        [claudeCredentialVariable]: JSON.stringify(setting),
      }),
      setting,
    );
  }
});

/** Catches a credential missing what its kind needs being accepted, or refused without naming it. */
test("a credential missing what its kind needs is refused, naming what is missing", () => {
  assert.deepEqual(refusals({ kind: "Bedrock", apiKeyFile: "/key" }), [
    "region is required: the region the provider is called in",
  ]);
  assert.deepEqual(
    refusals({ kind: "Vertex", region: "us-east5", credentialsFile: "/key" }),
    ["project is required: the Google Cloud project"],
  );
  assert.deepEqual(refusals({ kind: "Foundry", apiKeyFile: "/key" }), [
    "resource is required: the Foundry resource's name",
  ]);
  assert.deepEqual(refusals({ kind: "ApiKey" }), [
    "apiKeyFile is required: the file the API key is saved in",
  ]);
  assert.deepEqual(refusals({ kind: "Bedrock", region: "us-west-2" }), [
    "names one of apiKeyFile, a Bedrock API key's file, and credentialsFile, an AWS credentials file",
  ]);
  assert.deepEqual(
    refusals({
      kind: "Bedrock",
      region: "us-west-2",
      apiKeyFile: "/key",
      profile: "chuggy",
    }),
    ["profile is a profile of credentialsFile, which is not named"],
  );
  assert.deepEqual(
    refusals({ kind: "Bedrock", region: "us west 2", apiKeyFile: "/key" }),
    ["region is not the region the provider is called in"],
  );
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"])
    assert.deepEqual(
      refusals({
        kind: "Bedrock",
        region: "us-west-2",
        credentialsFile: "/aws",
        profile: name,
      }),
      [
        "profile is a name every JavaScript object has, under which the AWS client finds no profile",
      ],
      name,
    );
  for (const kind of ["Login", undefined])
    assert.deepEqual(refusals({ kind, tokenFile: "/token" }), [
      "kind names no kind of Claude credential: Subscription, ApiKey, Bedrock, Vertex or Foundry",
    ]);
});

/** Catches a setting this core cannot read being run as no kind at all, which is a subscription's. */
test("a setting this core cannot read is refused, never read as none", () => {
  assert.equal(claudeCredentialNamed({}), undefined);
  for (const carried of [
    "{not json",
    JSON.stringify({ kind: "Login" }),
    JSON.stringify({ kind: "ApiKey", apiKeyFile: "/key" }),
  ])
    assert.throws(
      () => claudeCredentialNamed({ [claudeCredentialVariable]: carried }),
      {
        message: `${claudeCredentialVariable} names a Claude credential this core cannot read`,
      },
    );
});

/** Catches a runner telling a workload a setting that core would refuse, or telling it one where it named none. */
test("a runner's setting is carried as it is, none is carried as nothing, and one unreadable is refused", () => {
  assert.deepEqual(claudeCredentialCarried(undefined), {});
  assert.deepEqual(
    claudeCredentialCarried({ kind: "Vertex", region: "global", project: "p" }),
    {
      [claudeCredentialVariable]:
        '{"kind":"Vertex","region":"global","project":"p"}',
    },
  );
  assert.throws(
    () =>
      claudeCredentialCarried(
        /** @type {any} */ ({ kind: "Bedrock", region: "us west" }),
      ),
    RangeError,
  );
});

/** Catches a file of the wrong shape reaching Claude Code, which would then fail with nothing to say why. */
test("each kind's file is refused for what it lacks, naming the file and how to make one", () => {
  const cases = [
    [{ kind: "ApiKey" }, "", /^the Anthropic API key file \/f is empty; /u],
    [
      { kind: "ApiKey" },
      `${apiKey}\nsecond line`,
      /^the Anthropic API key file \/f holds more than one line; save a key from the Claude Console there, alone$/u,
    ],
    [
      { kind: "Subscription" },
      "a\nb",
      /^the Claude token file \/f holds more than one line; save `claude setup-token`'s output there, alone$/u,
    ],
    [
      { kind: "Bedrock", region: "us-west-2", profile: "missing" },
      awsCredentials,
      /^the AWS credentials file \/f has no \[missing\] profile; /u,
    ],
    [
      { kind: "Bedrock", region: "us-west-2", profile: "chuggy" },
      `[chuggy]\naws_access_key_id = ${awsKeyId}\n`,
      /^the AWS credentials file \/f gives its \[chuggy\] profile no aws_secret_access_key; /u,
    ],
    [
      { kind: "Vertex", region: "us-east5", project: "p" },
      `{"private_key": "${pemLines[0]}`,
      /^the Google service account key file \/f is not JSON; /u,
    ],
    [
      { kind: "Vertex", region: "us-east5", project: "p" },
      JSON.stringify({ type: "authorized_user", refresh_token: awsSecret }),
      /^the Google service account key file \/f is not a service account's key; /u,
    ],
    [
      { kind: "Vertex", region: "us-east5", project: "p" },
      JSON.stringify({ type: "service_account" }),
      /^the Google service account key file \/f holds no private_key; /u,
    ],
  ];
  for (const [setting, text, refused] of cases)
    assert.match(
      claudeCredentialRefusal(/** @type {any} */ (setting), text, "/f") ?? "",
      refused,
      JSON.stringify(setting),
    );
});

/** Catches a refusal quoting the file it refused, whose contents are the secret. */
test("no refusal of a file holds any of what the file holds", () => {
  const files = [
    [{ kind: "ApiKey" }, `${apiKey}\n${apiKey}`],
    [{ kind: "Bedrock", region: "r", profile: "absent" }, awsCredentials],
    [
      { kind: "Bedrock", region: "r", profile: "chuggy" },
      `[chuggy]\naws_session_token = ${awsSessionToken}`,
    ],
    [{ kind: "Vertex", region: "r", project: "p" }, `${serviceAccountKey}}`],
    [
      { kind: "Vertex", region: "r", project: "p" },
      JSON.stringify({ type: "external_account", secret: awsSecret }),
    ],
  ];
  for (const [setting, text] of files) {
    const refused = claudeCredentialRefusal(
      /** @type {any} */ (setting),
      text,
      "/f",
    );
    assert.ok(refused !== undefined, JSON.stringify(setting));
    for (const secret of [apiKey, awsKeyId, awsSecret, awsSessionToken])
      assert.ok(!refused.includes(secret), refused);
    for (const line of pemLines) assert.ok(!refused.includes(line), refused);
  }
});

/** Catches a key of one profile, or a session token, left out of what the scrub replaces. */
test("every key of every profile of an AWS credentials file is a secret", () => {
  const setting = { kind: "Bedrock", region: "us-west-2", profile: "chuggy" };
  assert.equal(
    claudeCredentialRefusal(setting, awsCredentials, "/f"),
    undefined,
  );
  assert.deepEqual(
    claudeCredentialSecrets(setting, awsCredentials).toSorted(),
    [awsKeyId, awsOtherSecret, awsKeyId, awsSecret, awsSessionToken].toSorted(),
  );
});

/**
 * Catches an AWS credentials file read otherwise than Claude Code's AWS client
 * reads it: a comment after a value kept in the value, so the secret the
 * client uses is never scrubbed; a key whose name is not in lower case
 * accepted, though the client finds no key there and falls through to
 * whatever else the machine holds; or a key indented under one with no value
 * read as the profile's own, which the client reads as that key's.
 */
test("an AWS credentials file is read as Claude Code's AWS client reads it", () => {
  const setting = { kind: "Bedrock", region: "us-west-2", profile: "chuggy" };
  const commented = [
    "[chuggy]",
    `aws_access_key_id = ${awsKeyId} ; the owner's`,
    `aws_secret_access_key = ${awsSecret} # rotated 2026-10`,
    `aws_session_token = ${awsSessionToken}#not-a-comment`,
  ].join("\n");
  assert.equal(claudeCredentialRefusal(setting, commented, "/f"), undefined);
  assert.deepEqual(
    claudeCredentialSecrets(setting, commented).toSorted(),
    [awsKeyId, awsSecret, `${awsSessionToken}#not-a-comment`].toSorted(),
  );
  assert.equal(
    credentialScrub(claudeCredentialSecrets(setting, commented))(
      `printed ${awsSecret}`,
    ),
    "printed [redacted credential]",
  );

  const upper = `[chuggy]\nAWS_ACCESS_KEY_ID = ${awsKeyId}\nAWS_SECRET_ACCESS_KEY = ${awsSecret}`;
  assert.equal(
    claudeCredentialRefusal(setting, upper, "/f"),
    "the AWS credentials file /f gives its [chuggy] profile no aws_access_key_id; give its [chuggy] profile an access key's aws_access_key_id and aws_secret_access_key",
  );
  assert.deepEqual(
    claudeCredentialSecrets(setting, upper).toSorted(),
    [awsKeyId, awsSecret].toSorted(),
  );

  const nested = `[chuggy]\naws_access_key_id = ${awsKeyId}\nservice =\n  aws_secret_access_key = ${awsSecret}`;
  assert.match(
    claudeCredentialRefusal(setting, nested, "/f") ?? "",
    /gives its \[chuggy\] profile no aws_secret_access_key; /u,
  );
  assert.ok(claudeCredentialSecrets(setting, nested).includes(awsSecret));
  assert.equal(
    claudeCredentialRefusal(
      setting,
      `[chuggy]\nservice =\n  region = us-west-2\naws_access_key_id = ${awsKeyId}\naws_secret_access_key = ${awsSecret}`,
      "/f",
    ),
    undefined,
  );
});

/**
 * Catches a profile looked for otherwise than Claude Code's host-managed AWS
 * client looks: it reads the file as its config file too, where
 * `[profile name]` and `[profile.name]` are the profile `name`, and merges
 * that reading's keys under the credentials file's, so it authenticates by
 * profiles the core would refuse; and a heading of another type, or a
 * spaced one, read as the profile it does not name.
 */
test("an AWS profile is found where Claude Code's host-managed client finds it", () => {
  const setting = { kind: "Bedrock", region: "us-west-2", profile: "chuggy" };
  for (const [profile, text] of [
    [
      "chuggy",
      `[profile chuggy]\naws_access_key_id = ${awsKeyId}\naws_secret_access_key = ${awsSecret}`,
    ],
    [
      "chuggy",
      `[profile.chuggy]\naws_access_key_id = ${awsKeyId}\naws_secret_access_key = ${awsSecret}`,
    ],
    [
      "chuggy",
      `[chuggy]\naws_access_key_id = ${awsKeyId}\n[profile chuggy]\naws_secret_access_key = ${awsSecret}`,
    ],
    [
      "profile.chuggy",
      `[profile chuggy]\naws_access_key_id = ${awsKeyId}\naws_secret_access_key = ${awsSecret}`,
    ],
  ])
    assert.equal(
      claudeCredentialRefusal({ ...setting, profile }, text, "/f"),
      undefined,
      `${profile} in ${text
        .split("\n")
        .filter((line) => line.startsWith("["))
        .join(" ")}`,
    );
  for (const heading of [
    "[ chuggy ]",
    "[sso-session chuggy]",
    "[other chuggy]",
    "[__proto__]\n[chuggy]",
  ])
    assert.match(
      claudeCredentialRefusal(
        setting,
        `${heading}\naws_access_key_id = ${awsKeyId}\naws_secret_access_key = ${awsSecret}`,
        "/f",
      ) ?? "",
      /^the AWS credentials file \/f has no \[chuggy\] profile; /u,
      heading,
    );
});

/**
 * Catches a service account's key surviving a scrub where it is printed as the
 * file writes it, as JSON escapes it, or as its PEM, whole or a line at a time.
 */
test("a service account's private key is scrubbed as its file, its JSON and its PEM print it", () => {
  const setting = { kind: "Vertex", region: "us-east5", project: "p" };
  assert.equal(
    claudeCredentialRefusal(setting, serviceAccountKey, "/f"),
    undefined,
  );
  const scrub = credentialScrub(
    claudeCredentialSecrets(setting, serviceAccountKey),
  );
  const printed = [
    serviceAccountKey,
    JSON.stringify(JSON.stringify(JSON.parse(serviceAccountKey))),
    privateKey,
    pemLines[1],
    `a line of output naming ${privateKeyId} and nothing else`,
  ];
  for (const text of printed) {
    const scrubbed = scrub(text);
    for (const line of pemLines) assert.ok(!scrubbed.includes(line), text);
    assert.ok(!scrubbed.includes(privateKeyId), text);
  }
});

/** Catches a kind whose secret Claude Code is not told where to find, or told under another kind's name. */
test("each kind sets its provider's selector, where it is, and its secret where Claude Code reads it", () => {
  const environment = (setting, text = apiKey) =>
    claudeCredentialEnvironment(/** @type {any} */ (setting), text, "/mounted");
  assert.deepEqual(environment({ kind: "Subscription" }), {
    CLAUDE_CODE_OAUTH_TOKEN: apiKey,
  });
  assert.deepEqual(environment({ kind: "ApiKey" }), {
    ANTHROPIC_API_KEY: apiKey,
  });
  assert.deepEqual(environment({ kind: "Bedrock", region: "us-west-2" }), {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: "us-west-2",
    AWS_BEARER_TOKEN_BEDROCK: apiKey,
    DISABLE_TELEMETRY: "1",
  });
  assert.deepEqual(
    environment(
      { kind: "Bedrock", region: "us-west-2", profile: "chuggy" },
      awsCredentials,
    ),
    {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-west-2",
      AWS_SHARED_CREDENTIALS_FILE: "/mounted",
      AWS_PROFILE: "chuggy",
      DISABLE_TELEMETRY: "1",
    },
  );
  assert.deepEqual(
    environment(
      { kind: "Vertex", region: "us-east5", project: "example-project" },
      serviceAccountKey,
    ),
    {
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "us-east5",
      ANTHROPIC_VERTEX_PROJECT_ID: "example-project",
      GOOGLE_APPLICATION_CREDENTIALS: "/mounted",
      DISABLE_TELEMETRY: "1",
    },
  );
  assert.deepEqual(environment({ kind: "Foundry", resource: "example" }), {
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ANTHROPIC_FOUNDRY_RESOURCE: "example",
    ANTHROPIC_FOUNDRY_API_KEY: apiKey,
    DISABLE_TELEMETRY: "1",
  });
});

/**
 * Catches a variable that decides which credential Claude Code runs on, or
 * where it sends it, left out of what a named kind withholds: a credential, a
 * selector, a switch, a base URL, a header or a socket the runner's
 * environment named would then be in force beside the kind. The names are the
 * fixture's, written out apart from this module's.
 */
test("a kind named withholds every variable that decides, and a cloud provider's own only where it is the kind", () => {
  for (const { setting } of configured) {
    const withheld = [
      ...claudeCredentialVariables,
      ...claudeCredentialProviderVariables(setting.kind),
    ];
    assert.deepEqual(
      decidingFor(setting.kind).filter((name) => !withheld.includes(name)),
      [],
      setting.kind,
    );
    for (const [provider, names] of Object.entries(providerDecidingVariables))
      if (provider !== setting.kind)
        assert.deepEqual(
          names.filter((name) => withheld.includes(name)),
          [],
          `${setting.kind} withholds ${provider}'s`,
        );
  }
});
