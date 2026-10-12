/**
 * What chuggy answers a pool's or a personal redemption with, and a fetch
 * that answers with it, for a suite that registers without the network.
 */

/** The pool file chuggy answers a redemption for pool `shame` on an x64 machine with. */
export const registeredFixture = {
  tenant: "newtenant",
  project: "arbbot",
  pool: "shame",
  capabilities: ["Platform:Linux:Amd64"],
  tokenUrl: "https://auth.chuggy.example/oauth2/token",
  audience: "https://chuggy.example/api",
  planeUrl: "https://chuggy-pool.chuggy.example/",
  registryHost: "chuggy-registry.chuggy.example",
  clientId: "chuggy-pool-client",
  clientSecret: "pool-client-secret-fixture",
};

/** The file chuggy answers a personal redemption on an x64 machine with: a pool's, less its project and pool, naming its member. */
export const registeredPersonalFixture = {
  kind: "Personal",
  tenant: "newtenant",
  owner: "28:https://auth.chuggy.example/0f3c9a52-member",
  capabilities: ["Platform:Linux:Amd64"],
  tokenUrl: "https://auth.chuggy.example/oauth2/token",
  audience: "https://chuggy.example/api",
  planeUrl: "https://chuggy-pool.chuggy.example/",
  registryHost: "chuggy-registry.chuggy.example",
  clientId: "chuggy-personal-client",
  clientSecret: "personal-client-secret-fixture",
};

/**
 * A fetch answering every request with one response, and the requests it saw.
 *
 * @param {number} status
 * @param {unknown} body a document, or the text itself
 */
export function answeringFetch(status, body) {
  /** @type {Array<{url: string, init: RequestInit}>} */
  const requests = [];
  /** @type {typeof globalThis.fetch} */
  const fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return new globalThis.Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status },
    );
  };
  return { fetch, requests };
}
