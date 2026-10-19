/**
 * Which credential a runner's Claude Code runs on, and what each kind sets of
 * Claude Code's environment: a subscription's token from `claude setup-token`,
 * an Anthropic API key, Amazon Bedrock, Google Cloud's Vertex AI or Microsoft
 * Foundry.
 *
 * ONE FILE IS THE SECRET, WHATEVER THE KIND. It is handed a workload where a
 * token file always was, mounted at the envelope's `providerCredentialFile` or
 * named there on a host, so no envelope changes with the kind.
 *
 * THE KIND REACHES THE CORE IN `claudeCredentialVariable`, which carries the
 * kind's settings and no secret. A runner names it; chuggy's own pools name
 * none, and a core told none runs Claude Code as it always has: on the file as
 * a subscription's token, over its environment untouched.
 *
 * A KIND NAMED IS THE ONLY ONE IN FORCE. Claude Code takes the first credential
 * it finds of a cloud provider's, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
 * and `CLAUDE_CODE_OAUTH_TOKEN`, so a variable a runner's environment left in
 * would outrank the kind named or be outranked by it. Every variable Claude
 * Code chooses a provider or a credential by is withheld, and the kind's own
 * are set. The names are Claude Code's own lists at the version chuggy pins;
 * a provider a later version adds is one more to withhold.
 *
 * `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` IS SET BESIDE EVERY KIND. It is
 * Claude Code's own for a host that embeds it and routes its provider, and
 * with it Claude Code ignores the provider, endpoint and credential variables a
 * settings file names, so a checkout's `.claude/settings.json` cannot send the
 * credential elsewhere. It also lifts the telemetry Claude Code otherwise
 * turns off for a cloud provider, which `DISABLE_TELEMETRY` turns off again.
 *
 * EVERY SECRET A FILE HOLDS IS SCRUBBED, each value as it is written, since a
 * scrub matches text exactly: a key a JSON document escapes is held line by
 * line and as the file writes it.
 *
 * A REFUSAL NAMES THE FILE AND WHAT IT LACKS, never a value, nor a parser's
 * message, which quotes what it could not read.
 */

import { z } from "zod";

/** What names the kind of Claude credential a workload's file is, and its settings. */
export const claudeCredentialVariable = "CHUG_WORKER_CLAUDE_CREDENTIAL";

/**
 * Every variable Claude Code chooses a provider or a credential by: the
 * credentials, the providers' selectors and the names they are addressed by,
 * and the switches that skip a provider's own authentication.
 */
export const claudeCredentialVariables = [
  claudeCredentialVariable,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_GOOGLE_CLOUD_PROJECT",
  "ANTHROPIC_GOOGLE_CLOUD_LOCATION",
  "ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID",
  "CLOUD_ML_REGION",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
];

/**
 * The variables a cloud provider's own client reads its credential and its
 * place by, which are a project's as much as Claude Code's, so they are
 * withheld only where that provider is the kind named.
 */
const claudeCredentialSharedVariables = {
  Bedrock: [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
  ],
  Vertex: ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"],
};

/**
 * The variables withheld from Claude Code beside `claudeCredentialVariables`
 * where `kind` is named, which a runner's environment may not set then.
 *
 * @param {string} kind
 * @returns {readonly string[]}
 */
export function claudeCredentialProviderVariables(kind) {
  return Object.hasOwn(claudeCredentialSharedVariables, kind)
    ? claudeCredentialSharedVariables[kind]
    : [];
}

/** A setting's schema, its message naming what it is when it is missing or malformed. */
function claudeCredentialName(what) {
  return z
    .string({
      error: (issue) =>
        issue.input === undefined ? `is required: ${what}` : `is not ${what}`,
    })
    .max(128, `is not ${what}`)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u, `is not ${what}`);
}

/** A file's schema, whose path is the runner's to judge. */
function claudeCredentialPath(what) {
  return z
    .string({
      error: (issue) =>
        issue.input === undefined ? `is required: ${what}` : `is not a path`,
    })
    .min(1, "is not a path");
}

const region = claudeCredentialName("the region the provider is called in");
const profile = claudeCredentialName("a profile of the credentials file");
const kindRefused = {
  error: (issue) =>
    issue.code === "invalid_union"
      ? "names no kind of Claude credential: Subscription, ApiKey, Bedrock, Vertex or Foundry"
      : undefined,
};

/**
 * What `claudeCredentialVariable` carries: the kind, and whatever names where
 * its provider is. A Bedrock setting naming a profile reads that profile's
 * keys from its file, and one naming none is a Bedrock API key.
 */
export const claudeCredentialSettingSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("Subscription") }),
    z.strictObject({ kind: z.literal("ApiKey") }),
    z.strictObject({
      kind: z.literal("Bedrock"),
      region,
      profile: profile.optional(),
    }),
    z.strictObject({
      kind: z.literal("Vertex"),
      region,
      project: claudeCredentialName("the Google Cloud project"),
    }),
    z.strictObject({
      kind: z.literal("Foundry"),
      resource: claudeCredentialName("the Foundry resource's name"),
    }),
  ],
  kindRefused,
);

/**
 * A runner's Claude credential as its configuration names it: a setting and
 * the one file that is its secret. A Bedrock credential is a Bedrock API key
 * or an AWS credentials file and the profile of it to read, `default` where
 * it names none.
 */
export const claudeCredentialSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("Subscription"),
      tokenFile: claudeCredentialPath(
        "the file `claude setup-token`'s output is saved in",
      ),
    }),
    z.strictObject({
      kind: z.literal("ApiKey"),
      apiKeyFile: claudeCredentialPath("the file the API key is saved in"),
    }),
    z
      .strictObject({
        kind: z.literal("Bedrock"),
        region,
        apiKeyFile: claudeCredentialPath("a file").optional(),
        credentialsFile: claudeCredentialPath("a file").optional(),
        profile: profile.optional(),
      })
      .superRefine((credential, context) => {
        if (
          (credential.apiKeyFile === undefined) ===
          (credential.credentialsFile === undefined)
        )
          context.addIssue({
            code: "custom",
            message:
              "names one of apiKeyFile, a Bedrock API key's file, and credentialsFile, an AWS credentials file",
          });
        if (
          credential.profile !== undefined &&
          credential.credentialsFile === undefined
        )
          context.addIssue({
            code: "custom",
            path: ["profile"],
            message: "is a profile of credentialsFile, which is not named",
          });
      }),
    z.strictObject({
      kind: z.literal("Vertex"),
      region,
      project: claudeCredentialName("the Google Cloud project"),
      credentialsFile: claudeCredentialPath(
        "the file a service account's key is saved in",
      ),
    }),
    z.strictObject({
      kind: z.literal("Foundry"),
      resource: claudeCredentialName("the Foundry resource's name"),
      apiKeyFile: claudeCredentialPath("the file the API key is saved in"),
    }),
  ],
  kindRefused,
);

/**
 * @typedef {z.infer<typeof claudeCredentialSettingSchema>} ClaudeCredentialSetting
 * @typedef {z.infer<typeof claudeCredentialSchema>} ClaudeCredential
 */

/**
 * The file a credential's secret is in.
 *
 * @param {ClaudeCredential} credential
 * @returns {string}
 */
export function claudeCredentialFile(credential) {
  switch (credential.kind) {
    case "Subscription":
      return credential.tokenFile;
    case "Bedrock":
    case "Vertex":
      return credential.credentialsFile ?? credential.apiKeyFile;
    default:
      return credential.apiKeyFile;
  }
}

/**
 * A credential's setting, which is all of it but its file.
 *
 * @param {ClaudeCredential} credential
 * @returns {ClaudeCredentialSetting}
 */
export function claudeCredentialSetting(credential) {
  switch (credential.kind) {
    case "Bedrock":
      return credential.credentialsFile === undefined
        ? { kind: "Bedrock", region: credential.region }
        : {
            kind: "Bedrock",
            region: credential.region,
            profile: credential.profile ?? "default",
          };
    case "Vertex":
      return {
        kind: "Vertex",
        region: credential.region,
        project: credential.project,
      };
    case "Foundry":
      return { kind: "Foundry", resource: credential.resource };
    default:
      return { kind: credential.kind };
  }
}

/**
 * What a setting's file is called and how one is made, which every refusal of
 * it names.
 *
 * @param {ClaudeCredentialSetting} setting
 * @returns {{label: string, remedy: string}}
 */
export function claudeCredentialDescribed(setting) {
  switch (setting.kind) {
    case "Subscription":
      return {
        label: "Claude token file",
        remedy: "save `claude setup-token`'s output there, alone",
      };
    case "ApiKey":
      return {
        label: "Anthropic API key file",
        remedy: "save a key from the Claude Console there, alone",
      };
    case "Bedrock":
      return setting.profile === undefined
        ? {
            label: "Bedrock API key file",
            remedy: "save a Bedrock API key there, alone",
          }
        : {
            label: "AWS credentials file",
            remedy: `give its [${setting.profile}] profile an access key's aws_access_key_id and aws_secret_access_key`,
          };
    case "Vertex":
      return {
        label: "Google service account key file",
        remedy:
          "save the JSON key Google Cloud made for a service account there",
      };
    default:
      return {
        label: "Foundry API key file",
        remedy: "save a key of the Foundry resource there, alone",
      };
  }
}

/**
 * The variable a workload is told a runner's setting in, or nothing where the
 * runner names none; a setting this core could not read back is refused.
 *
 * @param {ClaudeCredentialSetting | undefined} setting
 * @returns {Record<string, string>}
 */
export function claudeCredentialCarried(setting) {
  if (setting === undefined) return {};
  const checked = claudeCredentialSettingSchema.safeParse(setting);
  if (!checked.success)
    throw new RangeError(
      `the Claude credential's setting cannot be carried: ${checked.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`.trim())
        .join(", ")}`,
    );
  return { [claudeCredentialVariable]: JSON.stringify(checked.data) };
}

/**
 * The setting a workload's environment names, or nothing where it names none.
 * One this core cannot read is refused rather than read as no kind at all.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @returns {ClaudeCredentialSetting | undefined}
 */
export function claudeCredentialNamed(environment) {
  const carried = environment[claudeCredentialVariable];
  if (carried === undefined) return undefined;
  let document;
  try {
    document = JSON.parse(carried);
  } catch {
    document = undefined;
  }
  const setting = claudeCredentialSettingSchema.safeParse(document);
  if (!setting.success)
    throw new Error(
      `${claudeCredentialVariable} names a Claude credential this core cannot read`,
    );
  return setting.data;
}

/** The keys an AWS credentials file holds an access key under. */
const awsKeyNames = [
  "aws_access_key_id",
  "aws_secret_access_key",
  "aws_session_token",
  "aws_security_token",
];

/**
 * Each profile of an AWS credentials file and its keys, read as the AWS
 * clients read one: `[name]` heads a profile, `key = value` sets a key in it,
 * and a line beginning `#` or `;` is a comment.
 *
 * @param {string} text
 * @returns {Map<string, Map<string, string>>}
 */
function awsProfiles(text) {
  const profiles = new Map();
  let current;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[\s*(.*?)\s*\]$/u.exec(line);
    if (section !== null) {
      current = profiles.get(section[1]) ?? new Map();
      profiles.set(section[1], current);
      continue;
    }
    const equals = line.indexOf("=");
    if (current !== undefined && equals > 0)
      current.set(
        line.slice(0, equals).trim().toLowerCase(),
        line.slice(equals + 1).trim(),
      );
  }
  return profiles;
}

/**
 * A service account's key as Google Cloud writes one, or why the text is not
 * one.
 *
 * @param {string} text
 * @returns {{privateKey: string, privateKeyId: string | undefined} | "NotJson" | "NotServiceAccount" | "NoPrivateKey"}
 */
function googleServiceAccountKey(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return "NotJson";
  }
  if (document?.type !== "service_account") return "NotServiceAccount";
  if (typeof document.private_key !== "string" || document.private_key === "")
    return "NoPrivateKey";
  return {
    privateKey: document.private_key,
    privateKeyId:
      typeof document.private_key_id === "string"
        ? document.private_key_id
        : undefined,
  };
}

/** Whether a setting's file is one value alone rather than a document. */
function claudeCredentialSingle(setting) {
  return (
    setting.kind !== "Vertex" &&
    !(setting.kind === "Bedrock" && setting.profile !== undefined)
  );
}

/**
 * Why a setting's file, read as `text`, is not a credential of its kind, or
 * nothing. It names `file` and what the file lacks, and never what it holds.
 *
 * @param {ClaudeCredentialSetting} setting
 * @param {string} text the file's contents, trimmed
 * @param {string} file where the file is, which the refusal names
 * @returns {string | undefined}
 */
export function claudeCredentialRefusal(setting, text, file) {
  const { label, remedy } = claudeCredentialDescribed(setting);
  if (text === "") return `the ${label} ${file} is empty; ${remedy}`;
  if (claudeCredentialSingle(setting))
    return /[\r\n]/u.test(text)
      ? `the ${label} ${file} holds more than one line; ${remedy}`
      : undefined;
  if (setting.kind === "Vertex") {
    const key = googleServiceAccountKey(text);
    if (key === "NotJson") return `the ${label} ${file} is not JSON; ${remedy}`;
    if (key === "NotServiceAccount")
      return `the ${label} ${file} is not a service account's key; ${remedy}`;
    if (key === "NoPrivateKey")
      return `the ${label} ${file} holds no private_key; ${remedy}`;
    return undefined;
  }
  const keys = awsProfiles(text).get(setting.profile);
  if (keys === undefined)
    return `the ${label} ${file} has no [${setting.profile}] profile; name the profile its keys are under, or ${remedy}`;
  const missing = awsKeyNames
    .slice(0, 2)
    .find((name) => (keys.get(name) ?? "") === "");
  return missing === undefined
    ? undefined
    : `the ${label} ${file} gives its [${setting.profile}] profile no ${missing}; ${remedy}`;
}

/**
 * Every secret a setting's file holds, each as it would be written: the value
 * of a file that is one; each key of every profile of an AWS credentials file;
 * and a service account's private key, whole, as its JSON writes it, line by
 * line, and its ID.
 *
 * @param {ClaudeCredentialSetting} setting
 * @param {string} text the file's contents, trimmed
 * @returns {string[]}
 */
export function claudeCredentialSecrets(setting, text) {
  if (claudeCredentialSingle(setting)) return [text];
  if (setting.kind === "Vertex") {
    const key = googleServiceAccountKey(text);
    if (typeof key === "string") return [];
    return [
      key.privateKey,
      JSON.stringify(key.privateKey).slice(1, -1),
      ...key.privateKey
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("-----")),
      ...(key.privateKeyId === undefined ? [] : [key.privateKeyId]),
    ];
  }
  return [...awsProfiles(text).values()].flatMap((keys) =>
    awsKeyNames.flatMap((name) => {
      const value = keys.get(name);
      return value === undefined || value === "" ? [] : [value];
    }),
  );
}

/**
 * The variables a setting sets of Claude Code's environment, its file read as
 * `text` at `path`: its provider's selector and where the provider is, and the
 * secret where Claude Code reads it, which is the value of a file that is one
 * and the file's path where the provider's client reads a document.
 *
 * @param {ClaudeCredentialSetting} setting
 * @param {string} text
 * @param {string} path
 * @returns {Record<string, string>}
 */
export function claudeCredentialEnvironment(setting, text, path) {
  switch (setting.kind) {
    case "Subscription":
      return { CLAUDE_CODE_OAUTH_TOKEN: text };
    case "ApiKey":
      return { ANTHROPIC_API_KEY: text };
    case "Bedrock":
      return {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: setting.region,
        ...(setting.profile === undefined
          ? { AWS_BEARER_TOKEN_BEDROCK: text }
          : {
              AWS_SHARED_CREDENTIALS_FILE: path,
              AWS_PROFILE: setting.profile,
            }),
        DISABLE_TELEMETRY: "1",
      };
    case "Vertex":
      return {
        CLAUDE_CODE_USE_VERTEX: "1",
        CLOUD_ML_REGION: setting.region,
        ANTHROPIC_VERTEX_PROJECT_ID: setting.project,
        GOOGLE_APPLICATION_CREDENTIALS: path,
        DISABLE_TELEMETRY: "1",
      };
    default:
      return {
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_FOUNDRY_RESOURCE: setting.resource,
        ANTHROPIC_FOUNDRY_API_KEY: text,
        DISABLE_TELEMETRY: "1",
      };
  }
}
