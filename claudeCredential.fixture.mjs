/**
 * The variables that decide which credential Claude Code runs on and where it
 * sends it, written out from Claude Code's own lists at the version chuggy
 * pins rather than read from `claudeCredential.mjs`, so a name that module
 * drops is a stray value a suite finds left in force.
 */

// jscpd:ignore-start: these lists repeat the module's on purpose, so a name it drops is one they still hold
/** Every variable Claude Code chooses a provider, a credential or an endpoint by, whatever the kind. */
export const decidingVariables = [
  "CHUG_WORKER_CLAUDE_CREDENTIAL",
  // The credentials, and the file a host may name more in.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  // The providers' selectors and the names they are addressed by.
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
  // The switches that skip a provider's own authentication.
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  // The endpoints, and the headers and socket a request is sent with.
  "ANTHROPIC_BASE_URL",
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "CLAUDE_CODE_ARTIFACTS_API_BASE_URL",
  "CLAUDE_CODE_ARTIFACTS_API_TOKEN",
  "CLAUDE_CODE_ARTIFACT_ASSET_BASE_URL",
  "CLAUDE_CODE_ARTIFACT_LIVE_BASE_URL",
  "CLAUDE_CODE_ARTIFACT_SYNC_BASE_URL",
  "CLAUDE_CODE_ARTIFACT_VIEWER_BASE_URL",
  "CLAUDE_CODE_MEMORY_API_BASE_URL",
  "CLAUDE_CODE_MEMORY_API_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_UNIX_SOCKET",
];

/** The variables a cloud provider's own client reads, which decide only where that provider is the kind. */
export const providerDecidingVariables = {
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
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_EC2_METADATA_SERVICE_ENDPOINT",
    "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_BEDROCK",
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
    "AWS_ENDPOINT_URL_STS",
    "AWS_ENDPOINT_URL_SSO",
    "AWS_ENDPOINT_URL_SSO_OIDC",
  ],
  Vertex: [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
    "GCLOUD_PROJECT",
  ],
};

// jscpd:ignore-end

/** The variables that decide where `kind` is named. */
export function decidingFor(kind) {
  return [...decidingVariables, ...(providerDecidingVariables[kind] ?? [])];
}

/** What a stray value of `name` reads as. */
export const strayValue = (name) => `stray-value-of-${name}`;

/**
 * An environment holding a stray value of every variable that decides, a
 * provider's own included, but the one naming the kind, whose value is a
 * setting rather than a stray.
 */
export const strayEnvironment = Object.fromEntries(
  [...decidingVariables, ...Object.values(providerDecidingVariables).flat()]
    .filter((name) => name !== "CHUG_WORKER_CLAUDE_CREDENTIAL")
    .map((name) => [name, strayValue(name)]),
);

/** Each name in `environment` whose stray value is still there, of those that decide where `kind` is named. */
export function strayLeftFor(kind, environment) {
  return decidingFor(kind).filter(
    (name) => environment[name] === strayValue(name),
  );
}
