import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers";
import { URL, URLSearchParams } from "node:url";

import {
  LocalSignInNeeded,
  localSignIn,
  localSignInClientId,
  localSignInRefreshMarginMs,
} from "./localSignIn.mjs";

const site = "https://chuggy.test";
const issuer = "https://auth.test";
const audience = "https://chuggy.test/api";

function storeOf(renewal) {
  const store = { renewal, locks: 0 };
  return Object.assign(store, {
    read: async () => store.renewal,
    write: async (token) => {
      store.renewal = token;
    },
    clear: async () => {
      store.renewal = undefined;
    },
    locked: async (renewalRun) => {
      store.locks += 1;
      return renewalRun();
    },
  });
}

/** A site and issuer answering as the real ones do; `grant` answers each token request. */
function serversOf(grant) {
  const grants = [];
  const fetch = async (url, init) => {
    const asked = String(url);
    if (asked === `${site}/config.json`)
      return globalThis.Response.json({
        issuer,
        audience,
        clientId: "chuggy-ui",
      });
    if (asked === `${issuer}/.well-known/openid-configuration`)
      return globalThis.Response.json({
        issuer: `${issuer}/`,
        authorization_endpoint: `${issuer}/oauth2/auth`,
        token_endpoint: `${issuer}/oauth2/token`,
      });
    if (asked === `${issuer}/oauth2/token` && init?.method === "POST") {
      const fields = Object.fromEntries(new URLSearchParams(init.body));
      grants.push(fields);
      const { status = 200, body } = await grant(fields, grants.length);
      return globalThis.Response.json(body ?? {}, { status });
    }
    return new globalThis.Response("", { status: 404 });
  };
  return { fetch, grants };
}

function issued(n, expiresInSecs = 3_600) {
  return {
    body: {
      access_token: `access-${String(n)}`,
      refresh_token: `renewal-${String(n)}`,
      expires_in: expiresInSecs,
    },
  };
}

async function signInNeeded(signIn) {
  try {
    await signIn.token();
  } catch (failure) {
    assert.ok(failure instanceof LocalSignInNeeded, String(failure));
    return failure;
  }
  assert.fail("a call with nothing to renew was not asked to sign in");
}

test("with nothing to renew, a call is answered with a sign-in page, and the page's answer signs in", async (t) => {
  const { fetch, grants } = serversOf((_fields, n) => issued(n));
  const store = storeOf(undefined);
  const signIn = localSignIn(site, store, { fetch });
  t.after(() => signIn.close());

  const needed = await signInNeeded(signIn);
  const authorize = new URL(needed.url);
  const query = authorize.searchParams;
  assert.equal(authorize.origin + authorize.pathname, `${issuer}/oauth2/auth`);
  assert.equal(query.get("client_id"), localSignInClientId);
  assert.equal(query.get("audience"), audience);
  assert.equal(query.get("code_challenge_method"), "S256");
  assert.equal(query.get("scope"), "openid offline_access");
  const redirect = new URL(query.get("redirect_uri"));
  assert.equal(redirect.hostname, "127.0.0.1");
  assert.equal(redirect.pathname, "/callback");
  assert.equal((await signInNeeded(signIn)).url, needed.url);

  const stranger = await globalThis.fetch(`${redirect}?code=c&state=guessed`);
  assert.equal(stranger.status, 404);
  assert.equal(grants.length, 0);

  const answered = await globalThis.fetch(
    `${redirect}?code=the-code&state=${query.get("state")}`,
  );
  assert.equal(answered.status, 200);
  assert.match(await answered.text(), /Signed in/);
  const [exchange] = grants;
  assert.equal(exchange.grant_type, "authorization_code");
  assert.equal(exchange.code, "the-code");
  assert.equal(exchange.redirect_uri, redirect.toString());
  assert.equal(exchange.client_id, localSignInClientId);
  assert.equal(
    createHash("sha256").update(exchange.code_verifier).digest("base64url"),
    query.get("code_challenge"),
  );
  assert.equal(store.renewal, "renewal-1");
  assert.equal(await signIn.token(), "access-1");
});

test("a declined sign-in is said on the page, which then closes, and the next call opens another", async (t) => {
  const { fetch, grants } = serversOf((_fields, n) => issued(n));
  const signIn = localSignIn(site, storeOf(undefined), { fetch });
  t.after(() => signIn.close());
  const needed = await signInNeeded(signIn);
  const query = new URL(needed.url).searchParams;
  const declined = await globalThis.fetch(
    `${query.get("redirect_uri")}?error=access_denied&state=${query.get("state")}`,
  );
  assert.equal(declined.status, 200);
  assert.match(await declined.text(), /declined/);
  assert.equal(grants.length, 0);
  await assert.rejects(globalThis.fetch(query.get("redirect_uri")));
  assert.notEqual((await signInNeeded(signIn)).url, needed.url);
});

test("a page whose browser left before its answer ends, and the next call opens another", async (t) => {
  let granting;
  const granted = new Promise((resolve) => {
    granting = resolve;
  });
  let release;
  const { fetch } = serversOf(() => {
    granting();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const signIn = localSignIn(site, storeOf(undefined), { fetch });
  t.after(() => signIn.close());
  const needed = await signInNeeded(signIn);
  const query = new URL(needed.url).searchParams;
  const leaving = new globalThis.AbortController();
  const answering = globalThis.fetch(
    `${query.get("redirect_uri")}?code=the-code&state=${query.get("state")}`,
    { signal: leaving.signal },
  );
  await granted;
  leaving.abort();
  await assert.rejects(answering);
  await new Promise((resolve) => setTimeout(resolve, 100));
  release({ status: 400, body: { error: "invalid_grant" } });
  for (let looks = 0; looks < 100; looks += 1) {
    if ((await signInNeeded(signIn)).url !== needed.url) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the page stayed open after its browser left");
});

test("a code the issuer refuses is said on the page by what failed, and nothing is stored", async (t) => {
  const { fetch } = serversOf(() => ({
    status: 400,
    body: { error: "invalid_grant" },
  }));
  const store = storeOf(undefined);
  const signIn = localSignIn(site, store, { fetch });
  t.after(() => signIn.close());
  const query = new URL((await signInNeeded(signIn)).url).searchParams;
  const answered = await globalThis.fetch(
    `${query.get("redirect_uri")}?code=the-code&state=${query.get("state")}`,
  );
  assert.equal(answered.status, 502);
  const page = await answered.text();
  assert.match(page, /refused the code/);
  assert.doesNotMatch(page, /the-code|invalid_grant/);
  assert.equal(store.renewal, undefined);
});

test("an authorization endpoint's own query is kept beside the sign-in's", async (t) => {
  const { fetch: served } = serversOf((_fields, n) => issued(n));
  const fetch = async (url, init) =>
    String(url) === `${issuer}/.well-known/openid-configuration`
      ? globalThis.Response.json({
          issuer,
          authorization_endpoint: `${issuer}/oauth2/auth?tenant=one`,
          token_endpoint: `${issuer}/oauth2/token`,
        })
      : served(url, init);
  const signIn = localSignIn(site, storeOf(undefined), { fetch });
  t.after(() => signIn.close());
  const query = new URL((await signInNeeded(signIn)).url).searchParams;
  assert.equal(query.get("tenant"), "one");
  assert.equal(query.get("client_id"), localSignInClientId);
});

test("a held token is renewed ahead of its expiry, and the renewal replaces the stored one", async () => {
  let nowMs = 1_000_000;
  const { fetch, grants } = serversOf((_fields, n) => issued(n, 120));
  const store = storeOf("renewal-0");
  const signIn = localSignIn(site, store, { fetch, nowMs: () => nowMs });

  assert.equal(await signIn.token(), "access-1");
  assert.equal(await signIn.token(), "access-1");
  assert.equal(grants.length, 1);
  assert.equal(grants[0].refresh_token, "renewal-0");
  nowMs += 120_000 - localSignInRefreshMarginMs;
  assert.equal(await signIn.token(), "access-2");
  assert.equal(grants[1].refresh_token, "renewal-1");
  assert.equal(store.renewal, "renewal-2");
  assert.equal(store.locks, 2);
});

test("calls made together renew once", async () => {
  const { fetch, grants } = serversOf((_fields, n) => issued(n));
  const signIn = localSignIn(site, storeOf("renewal-0"), { fetch });
  const tokens = await Promise.all([signIn.token(), signIn.token()]);
  assert.deepEqual(tokens, ["access-1", "access-1"]);
  assert.equal(grants.length, 1);
});

test("a token the API refused is dropped and the next call renews", async () => {
  const { fetch, grants } = serversOf((_fields, n) => issued(n));
  const signIn = localSignIn(site, storeOf("renewal-0"), { fetch });
  const refused = await signIn.token();
  signIn.invalidate("some-other-token");
  assert.equal(await signIn.token(), refused);
  signIn.invalidate(refused);
  assert.equal(await signIn.token(), "access-2");
  assert.equal(grants.length, 2);
});

test("a renewal the issuer refuses is forgotten, and the call is asked to sign in", async (t) => {
  const { fetch } = serversOf(() => ({
    status: 400,
    body: { error: "invalid_grant" },
  }));
  const store = storeOf("renewal-spent");
  const signIn = localSignIn(site, store, { fetch });
  t.after(() => signIn.close());
  await signInNeeded(signIn);
  assert.equal(store.renewal, undefined);
});

test("an issuer that fails or limits renewals keeps the stored renewal and says so by status", async () => {
  for (const status of [503, 429, 403]) {
    const { fetch } = serversOf(() => ({ status }));
    const store = storeOf("renewal-0");
    const signIn = localSignIn(site, store, { fetch });
    await assert.rejects(
      signIn.token(),
      new RegExp(`answered ${String(status)} for a token`, "u"),
    );
    assert.equal(store.renewal, "renewal-0");
  }
});
