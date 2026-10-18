/**
 * A person's own sign-in to one chuggy site, for the local tool server: the
 * access token every tool call presents, renewed ahead of its expiry, and the
 * sign-in page that starts one when there is none.
 *
 * IT SIGNS IN AS THE SETUP PROGRAM'S CLIENT, the one chuggy's
 * `ui/chuggy-ui/app/core/setupProgram.ts` names: public, returning to a
 * loopback address on any port, under the scopes named here, as the issuer
 * registers it. The authorization code
 * flow with PKCE is the console's, and the site's own `/config.json` names
 * the issuer and the audience, so a site that moves its issuer moves this too.
 *
 * NO SIGN-IN IS STARTED BY A PAGE OPENING ITSELF. A call made with no renewal
 * token, or with one the issuer refused, is answered with the issuer's sign-in
 * address, for the agent to hand the person; the sign-in returns to a page
 * this process holds on `127.0.0.1`, so it is opened on this machine. The
 * page stays answerable until it is answered or its bound passes; a call made
 * meanwhile is answered with the same address. An answer the page reads
 * is one carrying the state this sign-in sent, checked before anything else
 * is read, so nothing else that reaches the port can end it.
 *
 * A TOKEN IS NEVER IN AN ANSWER. Not in an error, not in a page, not in a
 * line written anywhere. A refusal from the issuer is said by its status.
 *
 * Renewals run under the store's lock, one at a time per process. A renewal
 * the issuer refused, as the console reads a refusal, clears the store; any
 * other failure keeps it for the next call. A renewal whose answer is lost
 * after the issuer replaced the token leaves a spent one stored, and the next
 * renewal ends the sign-in: the console has the same exposure.
 */

import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { clearTimeout, setTimeout } from "node:timers";
import { URL, URLSearchParams } from "node:url";

import { chuggyBoundedBody } from "./chuggyApi.mjs";

export const localSignInClientId = "chuggy-setup";
export const localSignInCallbackPath = "/callback";
export const localSignInScopes = ["openid", "offline_access"];
export const localSignInLoopbackHost = "127.0.0.1";

/** How long a sign-in page waits for the person before it closes. */
export const localSignInListenMsMax = 600_000;

/** The bound every request to the site's configuration and to the issuer is sent under. */
export const localSignInFetchTimeoutMs = 15_000;

/** How far ahead of its expiry a held access token is replaced. */
export const localSignInRefreshMarginMs = 60_000;

/** The most one answer from the site's configuration or the issuer is read to. */
export const localSignInAnswerBytesMax = 65_536;

const localSignInConfigurationPath = "/config.json";
const localSignInDiscoveryPath = "/.well-known/openid-configuration";
const localSignInVerifierBytes = 32;
const localSignInStateBytes = 16;
/** The statuses a token request is refused with, as the console's session holder reads them. */
const localSignInRefusalStatuses = new Set([400, 401]);

/** What a call is answered with where the person must sign in first. */
export class LocalSignInNeeded extends Error {
  constructor(site, url) {
    super(
      `not signed in to ${site}: ask the person to open ${url} and sign in, then call the tool again. The page closes once it is answered or after a while unanswered, and a later call opens another.`,
    );
    this.name = "LocalSignInNeeded";
    this.url = url;
  }
}

function localSignInBase64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function localSignInFetch(ports, url, init = {}) {
  const response = await ports.fetch(url, {
    ...init,
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(localSignInFetchTimeoutMs),
    headers: { accept: "application/json", ...init.headers },
  });
  const { text, cut } = await chuggyBoundedBody(
    response,
    localSignInAnswerBytesMax,
  );
  if (cut) throw new Error(`${url} answered more than one answer is read to`);
  let body;
  try {
    body = response.status === 200 ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`${url} answered a body that is not JSON`);
  }
  return { status: response.status, body };
}

function localSignInText(value, what) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${what} is missing`);
  return value;
}

/** The issuer the site names, its endpoints, and the audience its API takes. */
async function localSignInIssuer(ports, site) {
  const configuration = await localSignInFetch(
    ports,
    `${site}${localSignInConfigurationPath}`,
  );
  if (configuration.status !== 200)
    throw new Error(
      `${site} answered ${String(configuration.status)} for its configuration`,
    );
  const issuer = localSignInText(
    configuration.body?.issuer,
    "the site's issuer",
  ).replace(/\/+$/u, "");
  const audience = localSignInText(
    configuration.body?.audience,
    "the site's audience",
  );
  const discovery = await localSignInFetch(
    ports,
    `${issuer}${localSignInDiscoveryPath}`,
  );
  if (discovery.status !== 200)
    throw new Error(
      `the sign-in server answered ${String(discovery.status)} for its discovery document`,
    );
  if (
    localSignInText(discovery.body?.issuer, "the issuer's name").replace(
      /\/+$/u,
      "",
    ) !== issuer
  )
    throw new Error(
      "the sign-in server's discovery document names another issuer",
    );
  return {
    audience,
    authorize: localSignInText(
      discovery.body?.authorization_endpoint,
      "the issuer's authorization endpoint",
    ),
    token: localSignInText(
      discovery.body?.token_endpoint,
      "the issuer's token endpoint",
    ),
  };
}

/** One token request: the tokens issued, or `undefined` where the issuer refused the grant. */
async function localSignInGrant(ports, issuer, fields) {
  const answer = await localSignInFetch(ports, issuer.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...fields,
      client_id: localSignInClientId,
    }).toString(),
  });
  if (localSignInRefusalStatuses.has(answer.status)) return undefined;
  if (answer.status !== 200)
    throw new Error(
      `the sign-in server answered ${String(answer.status)} for a token`,
    );
  const renewal = answer.body?.refresh_token;
  const expiresInSecs = answer.body?.expires_in;
  return {
    access: localSignInText(answer.body?.access_token, "the access token"),
    renewal:
      typeof renewal === "string" && renewal.length > 0 ? renewal : undefined,
    expiresAtMs:
      ports.nowMs() +
      (Number.isInteger(expiresInSecs) && expiresInSecs > 0
        ? expiresInSecs * 1_000
        : 0),
  };
}

function localSignInPage(response, status, text) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${text}\n`);
}

/**
 * The page a sign-in returns to. It answers the one request carrying its state
 * on its own path, and tells everything else there is nothing here. The page
 * ends once that answer is sent or its browser has gone, and not before,
 * since ending it closes every connection it holds.
 */
function localSignInCallback(signIn, page, request, response) {
  const asked = new URL(request.url ?? "/", page.origin);
  if (
    request.method !== "GET" ||
    asked.pathname !== localSignInCallbackPath ||
    asked.searchParams.get("state") !== page.state
  ) {
    localSignInPage(response, 404, "There is nothing here.");
    return;
  }
  if (page.answering) {
    localSignInPage(response, 409, "This sign-in is already being answered.");
    return;
  }
  page.answering = true;
  response.once("close", () => signIn.pageEnded(page));
  const code = asked.searchParams.get("code");
  if (code === null) {
    localSignInPage(
      response,
      200,
      "The sign-in was declined. Ask your agent to try again.",
    );
    return;
  }
  void signIn.pageAnswered(page, code).then(
    () =>
      localSignInPage(
        response,
        200,
        "Signed in. You can close this page and go back to your chat.",
      ),
    (failure) =>
      localSignInPage(
        response,
        502,
        `The sign-in did not complete: ${failure instanceof Error ? failure.message : String(failure)}`,
      ),
  );
}

async function localSignInPageOpened(signIn, issuer) {
  const verifier = localSignInBase64url(
    signIn.ports.randomBytes(localSignInVerifierBytes),
  );
  const page = {
    verifier,
    state: localSignInBase64url(
      signIn.ports.randomBytes(localSignInStateBytes),
    ),
    issuer,
  };
  const server = createServer((request, response) =>
    localSignInCallback(signIn, page, request, response),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, localSignInLoopbackHost, resolve);
  });
  page.server = server;
  page.origin = `http://${localSignInLoopbackHost}:${String(server.address().port)}`;
  page.redirect = `${page.origin}${localSignInCallbackPath}`;
  const authorize = new URL(issuer.authorize);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: localSignInClientId,
    redirect_uri: page.redirect,
    scope: localSignInScopes.join(" "),
    audience: issuer.audience,
    state: page.state,
    code_challenge: localSignInBase64url(
      createHash("sha256").update(verifier).digest(),
    ),
    code_challenge_method: "S256",
  }))
    authorize.searchParams.set(name, value);
  page.url = authorize.toString();
  page.timer = setTimeout(() => signIn.pageEnded(page), localSignInListenMsMax);
  page.timer.unref?.();
  return page;
}

/**
 * The sign-in to `site`, its renewal token kept in `store`
 * (`./localTokenStore.mjs`). `token` answers an access token or raises
 * `LocalSignInNeeded`; `invalidate` drops one the API refused; `close` ends a
 * page still open.
 */
export function localSignIn(site, store, overrides = {}) {
  const ports = {
    fetch: globalThis.fetch,
    nowMs: Date.now,
    randomBytes,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, port]) => port !== undefined),
    ),
  };
  const origin = new URL(site).origin;
  return localSignInHolder(origin, store, ports);
}

/** One renewal under the store's lock, or the sign-in page where there is nothing to renew. */
async function localSignInRenewed(signIn, store) {
  const issuer = await signIn.issuer();
  const issued = await store.locked(async () => {
    const renewal = await store.read();
    if (renewal === undefined) return undefined;
    const granted = await localSignInGrant(signIn.ports, issuer, {
      grant_type: "refresh_token",
      refresh_token: renewal,
    });
    if (granted === undefined) await store.clear();
    else if (granted.renewal !== undefined) await store.write(granted.renewal);
    return granted;
  });
  if (issued !== undefined) return issued;
  signIn.page ??= await localSignInPageOpened(signIn, issuer);
  throw new LocalSignInNeeded(signIn.site, signIn.page.url);
}

function localSignInHolder(site, store, ports) {
  const signIn = {
    site,
    ports,
    known: undefined,
    held: undefined,
    renewing: undefined,
    page: undefined,
    async issuer() {
      signIn.known ??= await localSignInIssuer(ports, site);
      return signIn.known;
    },
    pageEnded(ended) {
      if (ended.ended) return;
      ended.ended = true;
      clearTimeout(ended.timer);
      ended.server.close();
      ended.server.closeAllConnections?.();
      if (signIn.page === ended) signIn.page = undefined;
    },
    async pageAnswered(answered, code) {
      const issued = await localSignInGrant(ports, answered.issuer, {
        grant_type: "authorization_code",
        code,
        redirect_uri: answered.redirect,
        code_verifier: answered.verifier,
      });
      if (issued === undefined)
        throw new Error("the sign-in server refused the code");
      if (issued.renewal !== undefined)
        await store.locked(() => store.write(issued.renewal));
      signIn.held = issued;
    },
  };
  return {
    async token() {
      const held = signIn.held;
      if (
        held !== undefined &&
        held.expiresAtMs - localSignInRefreshMarginMs > ports.nowMs()
      )
        return held.access;
      signIn.renewing ??= localSignInRenewed(signIn, store).finally(() => {
        signIn.renewing = undefined;
      });
      signIn.held = await signIn.renewing;
      return signIn.held.access;
    },
    invalidate(refused) {
      if (signIn.held?.access === refused) signIn.held = undefined;
    },
    close() {
      if (signIn.page !== undefined) signIn.pageEnded(signIn.page);
    },
  };
}
