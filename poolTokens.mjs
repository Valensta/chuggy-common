/**
 * The pool loop's token source: the OAuth2 client-credentials grant, held
 * until a refresh margin before its expiry and minted at most once per
 * cooldown. chuggy's `src/adapters/http/clientCredentials.ts` and
 * `src/adapters/http/poolTokens.ts` are the same source in TypeScript.
 *
 * The cooldown is measured from the start of the last attempt on a monotonic
 * clock, so neither a refusal that never stops nor an issuer that never
 * answers turns a loop of reads into a loop of grants; the expiry is the
 * issuer's statement about wall-clock time and is held against one. No
 * message here carries the secret or a token, though every grant carries both.
 *
 * A REFUSAL AN ISSUER ALSO GIVES A LOOKUP IT COULD NOT MAKE IS CONFIRMED. Such
 * a refusal is final only once every grant across the confirmation interval
 * is refused the same way, and is an outage until then: an issuer whose
 * database is away answers as it would for a client deleted, until it is
 * taken out of rotation.
 */

import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { URL, URLSearchParams } from "node:url";
import { TextDecoder } from "node:util";

import { z } from "zod";

import { boundedResponseBytes } from "./boundedResponse.mjs";

/**
 * @typedef {import("./poolLoop.mjs").WorkerPoolTokens} WorkerPoolTokens
 * @typedef {import("./poolLoop.mjs").WorkerPoolTokenAcquired} WorkerPoolTokenAcquired
 *
 * @typedef {object} ClientCredentialsConfig
 * @property {string} tokenUrl
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {readonly string[]} audience
 * @property {readonly string[]} scope
 * @property {number} requestTimeoutMs
 * @property {number} responseBytesMax
 * @property {number} responseReadsMax
 * @property {number} refreshMarginMs how far ahead of expiry a held token stops being handed out
 * @property {number} mintCooldownMs the operator's bound on grant requests, shorter than the margin so a failed refresh is tried again before the token expires
 * @property {number} refusalConfirmMs how long a refusal an issuer also gives a lookup it could not make must persist before it is final
 * @property {typeof fetch} [fetch]
 * @property {() => number} [currentTimeEpochMs]
 * @property {() => number} [monotonicMs]
 *
 * @typedef {object} AccessTokenSource
 * @property {(signal: AbortSignal) => Promise<string>} token
 * @property {(refused: string) => void} invalidate discards nothing once something else is held
 */

const millisecondsPerSecond = 1_000;
const clientCredentialsGrantType = "client_credentials";
const clientCredentialsTokenType = "bearer";

/** RFC 6749 lets an issuer answer more than these, and a client ignores the rest. */
const clientCredentialsGrantSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().int().positive(),
});

/**
 * The codes RFC 6749 §5.2 refuses a grant with. Each is the issuer's word on
 * this client's credential, its registration or the request this client sends,
 * so the same credential presented again is refused again; any other code is
 * read as an outage.
 */
const clientCredentialsRefusalCodes = /** @type {const} */ ([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
]);

/**
 * The codes an issuer refuses with for a client it could not look up, as it
 * does for one it does not have. fosite answers every failed read of its
 * client store `invalid_client`; every other code it decides against the
 * request or the registration that read returned.
 */
const clientCredentialsLookupCodes = new Set(["invalid_client"]);

/** The statuses RFC 6749 §5.2 refuses a grant with: 401 for a client that failed authentication, 400 for the rest. */
const clientCredentialsRefusalStatuses = new Set([400, 401]);

/** RFC 6749 lets a refusal carry more than its code, and a client ignores the rest. */
const clientCredentialsRefusalSchema = z.object({
  error: z.enum(clientCredentialsRefusalCodes),
});

/**
 * @param {ClientCredentialsConfig} config
 * @returns {ClientCredentialsConfig}
 */
function clientCredentialsChecked(config) {
  const url = new URL(config.tokenUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new RangeError("client credentials token URL is not HTTP");
  if (url.username !== "" || url.password !== "")
    throw new RangeError("client credentials token URL carries credentials");
  if (config.clientId.length === 0 || config.clientSecret.length === 0)
    throw new RangeError("client credentials identity or secret is empty");
  for (const [bound, what] of [
    [config.requestTimeoutMs, "request timeout"],
    [config.responseBytesMax, "response byte bound"],
    [config.responseReadsMax, "response read bound"],
    [config.refreshMarginMs, "refresh margin"],
    [config.mintCooldownMs, "mint cooldown"],
    [config.refusalConfirmMs, "refusal confirmation"],
  ])
    if (!Number.isSafeInteger(bound) || bound < 1)
      throw new RangeError(
        `client credentials ${what} must be a positive safe integer`,
      );
  if (config.mintCooldownMs >= config.refreshMarginMs)
    throw new RangeError(
      "client credentials mint cooldown must be shorter than its refresh margin",
    );
  return config;
}

/**
 * Basic authentication, each half percent-encoded so neither can contribute
 * the colon that joins them.
 *
 * @param {ClientCredentialsConfig} config
 */
function clientCredentialsAuthorization(config) {
  const encoded = [config.clientId, config.clientSecret]
    .map((part) => encodeURIComponent(part))
    .join(":");
  return `Basic ${Buffer.from(encoded, "utf8").toString("base64")}`;
}

/**
 * How long a grant is handed out: its lifetime less the margin, or half of it
 * when the margin would leave none, since a hold of nothing is a mint per read.
 *
 * @param {number} lifetimeMs
 * @param {number} refreshMarginMs
 */
function clientCredentialsHoldMs(lifetimeMs, refreshMarginMs) {
  return lifetimeMs > refreshMarginMs
    ? lifetimeMs - refreshMarginMs
    : Math.floor(lifetimeMs / 2);
}

/**
 * The issuer refusing this client, which presenting the credential again will
 * not change; an issuer that could not be reached is an ordinary `Error`.
 */
export class ClientCredentialsRefused extends Error {
  /**
   * @param {number} status
   * @param {string} code
   */
  constructor(status, code) {
    super(`client credentials grant returned ${String(status)} ${code}`);
    this.name = "ClientCredentialsRefused";
    this.status = status;
    this.code = code;
  }
}

/**
 * What a mint raises, a refusal an issuer also gives a lookup it could not
 * make held as an outage until every grant across `confirmMs` has been
 * refused the same way. Any other answer starts the interval again.
 *
 * @param {number} confirmMs
 */
function clientCredentialsRefusals(confirmMs) {
  /** @type {{status: number, code: string, atMonotonicMs: number} | undefined} */
  let first;
  const seconds = (/** @type {number} */ ms) =>
    `${String(Math.floor(ms / millisecondsPerSecond))}s`;
  return {
    granted: () => {
      first = undefined;
    },
    /**
     * @param {unknown} failure
     * @param {number} atMonotonicMs when the mint that failed began
     */
    failed: (failure, atMonotonicMs) => {
      if (
        !(failure instanceof ClientCredentialsRefused) ||
        !clientCredentialsLookupCodes.has(failure.code)
      ) {
        first = undefined;
        return failure;
      }
      if (first?.status !== failure.status || first.code !== failure.code)
        first = { status: failure.status, code: failure.code, atMonotonicMs };
      const heldMs = atMonotonicMs - first.atMonotonicMs;
      return heldMs >= confirmMs
        ? failure
        : new Error(
            `${failure.message}, a refusal being confirmed: ${seconds(heldMs)} of ${seconds(confirmMs)}`,
          );
    },
  };
}

/**
 * An answer's body as JSON, read under the configured bounds.
 *
 * @param {ClientCredentialsConfig} config
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function clientCredentialsAnswer(config, response) {
  const bytes = await boundedResponseBytes(
    response,
    config.responseBytesMax,
    config.responseReadsMax,
  );
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/**
 * The code a failed grant was refused with, or nothing where the answer is no
 * refusal: a proxy in front of an issuer it cannot reach answers a status of
 * its own, never one.
 *
 * @param {ClientCredentialsConfig} config
 * @param {Response} response
 * @returns {Promise<string | undefined>}
 */
async function clientCredentialsRefusalCode(config, response) {
  if (!clientCredentialsRefusalStatuses.has(response.status)) {
    await response.body?.cancel();
    return undefined;
  }
  try {
    const refusal = clientCredentialsRefusalSchema.safeParse(
      await clientCredentialsAnswer(config, response),
    );
    return refusal.success ? refusal.data.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One grant. A grant that cannot outlive the cooldown is refused, because
 * holding it would let the issuer shorten the operator's bound, most of all
 * when the issuer is slowest to answer.
 *
 * @param {ClientCredentialsConfig} config
 * @param {typeof fetch} transport
 * @param {number} atEpochMs
 */
async function clientCredentialsMinted(config, transport, atEpochMs) {
  const form = new URLSearchParams({ grant_type: clientCredentialsGrantType });
  if (config.audience.length > 0)
    form.set("audience", config.audience.join(" "));
  if (config.scope.length > 0) form.set("scope", config.scope.join(" "));
  const response = await transport(new URL(config.tokenUrl), {
    method: "POST",
    headers: {
      authorization: clientCredentialsAuthorization(config),
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    signal: globalThis.AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (response.status !== 200) {
    const code = await clientCredentialsRefusalCode(config, response);
    throw code === undefined
      ? new Error(
          `client credentials grant returned ${String(response.status)}`,
        )
      : new ClientCredentialsRefused(response.status, code);
  }
  const grant = clientCredentialsGrantSchema.parse(
    await clientCredentialsAnswer(config, response),
  );
  if (grant.token_type.toLowerCase() !== clientCredentialsTokenType)
    throw new Error("client credentials grant is not a bearer token");
  const lifetimeMs = grant.expires_in * millisecondsPerSecond;
  if (lifetimeMs <= config.mintCooldownMs)
    throw new RangeError(
      `client credentials grant lives ${String(lifetimeMs)}ms, which this client cannot operate on while keeping a ${String(config.mintCooldownMs)}ms cooldown between grants`,
    );
  if (/[\r\n]/u.test(grant.access_token))
    throw new RangeError(
      "client credentials grant is no bearer token a header can carry",
    );
  return {
    token: grant.access_token,
    replaceAtEpochMs:
      atEpochMs + clientCredentialsHoldMs(lifetimeMs, config.refreshMarginMs),
    expiresAtEpochMs: atEpochMs + lifetimeMs,
  };
}

/** The cooldown's clock when none is supplied: process-relative, so no wall-clock step can make elapsed time negative. */
export function clientCredentialsMonotonicMs() {
  return performance.now();
}

/**
 * Mints on demand and holds the grant until its margin. Callers arriving while
 * a mint is in flight join it, and one arriving inside the cooldown is handed
 * a token still short of its expiry. A failed mint is not held, so the next
 * caller past the cooldown mints again and carries the failure itself, a
 * refusal not yet confirmed as an outage.
 *
 * @param {ClientCredentialsConfig} input
 * @returns {AccessTokenSource}
 */
export function clientCredentialsTokenSource(input) {
  const config = clientCredentialsChecked(input);
  const transport = config.fetch ?? globalThis.fetch;
  const currentTimeEpochMs = config.currentTimeEpochMs ?? Date.now;
  const monotonicMs = config.monotonicMs ?? clientCredentialsMonotonicMs;
  /** @type {{token: string, replaceAtEpochMs: number, expiresAtEpochMs: number} | undefined} */
  let held;
  /** @type {Promise<{token: string}> | undefined} */
  let minting;
  /** @type {number | undefined} */
  let attemptedAtMonotonicMs;
  const refusals = clientCredentialsRefusals(config.refusalConfirmMs);
  const cooling = () =>
    attemptedAtMonotonicMs !== undefined &&
    monotonicMs() - attemptedAtMonotonicMs < config.mintCooldownMs;
  const mint = () => {
    const inFlight = minting;
    if (inFlight !== undefined) return inFlight;
    const attemptedAt = monotonicMs();
    attemptedAtMonotonicMs = attemptedAt;
    return (minting = clientCredentialsMinted(
      config,
      transport,
      currentTimeEpochMs(),
    ).then(
      (granted) => {
        held = granted;
        minting = undefined;
        refusals.granted();
        return granted;
      },
      (failure) => {
        minting = undefined;
        throw refusals.failed(failure, attemptedAt);
      },
    ));
  };
  return {
    token: async (signal) => {
      signal.throwIfAborted();
      const current = held;
      if (
        current !== undefined &&
        currentTimeEpochMs() < current.replaceAtEpochMs
      )
        return current.token;
      if (minting === undefined && cooling()) {
        if (
          current !== undefined &&
          currentTimeEpochMs() < current.expiresAtEpochMs
        )
          return current.token;
        throw new Error("client credentials grant is within its cooldown");
      }
      const granted = await mint();
      signal.throwIfAborted();
      return granted.token;
    },
    invalidate: (refused) => {
      if (held?.token === refused) held = undefined;
    },
  };
}

/**
 * The loop's tokens port over that source. A refusal and an outage stay apart:
 * merged, a pool with a mistyped secret would back off forever, or one behind
 * a restarting issuer would end.
 *
 * @param {ClientCredentialsConfig} config
 * @returns {WorkerPoolTokens}
 */
export function poolClientTokens(config) {
  const source = clientCredentialsTokenSource(config);
  return {
    acquire: async () => {
      try {
        return {
          acquired: "Token",
          token: await source.token(
            globalThis.AbortSignal.timeout(config.requestTimeoutMs),
          ),
        };
      } catch (failure) {
        if (failure instanceof ClientCredentialsRefused)
          return { acquired: "Denied", evidence: failure.message };
        return {
          acquired: "Unavailable",
          evidence:
            failure instanceof Error
              ? failure.message
              : "the issuer could not be reached",
        };
      }
    },
    invalidate: (token) => {
      source.invalidate(token);
    },
  };
}
