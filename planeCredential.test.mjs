import assert from "node:assert/strict";
import test from "node:test";

import {
  workerContractHeader,
  workerContractRelease,
} from "@chuggy/worker-contract/workerContract";
import { mintedCredentialDirectory } from "@chuggy/worker-contract/workerEnvironment";
import { workerCredentialAbsentSchema } from "@chuggy/worker-contract/workerPlane";

import { credentialUnreachedCases } from "./credentialUnreached.fixture.mjs";

import {
  planeCredential,
  planeCredentialAnswered,
  planeCredentialUnreachedText,
  sessionCredentialPath,
  workerCredentialPath,
} from "./planeCredential.mjs";
import { sessionRequest } from "./sessionTransport.mjs";

const task = { workerPlane: { url: "http://worker-plane.test:3001" } };
const password = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";
const minted = { username: "x-access-token", password };
const mintedFile = `${mintedCredentialDirectory}/chuggy-git-credential`;

/** One plane answering one thing, recording everything it was asked. */
function planeOf(answer) {
  const asked = [];
  return {
    asked,
    request: async (_task, bearer, path, init, transport) => {
      asked.push({ bearer, path, init, transport });
      return answer;
    },
  };
}

/** Where the password went, instead of the pod's own filesystem. */
function writerOf() {
  const written = [];
  return {
    written,
    write: async (file, content, options) => {
      written.push({ file, content, options });
    },
  };
}

test("an attempt asks for nothing and is answered a credential git reads from a file", async () => {
  const plane = planeOf({ status: 200, ok: true, json: async () => minted });
  const writer = writerOf();

  const credential = await planeCredential({
    task,
    bearer: "capability",
    path: workerCredentialPath,
    request: plane.request,
    write: writer.write,
  });

  assert.equal(plane.asked.length, 1);
  assert.equal(plane.asked[0].path, workerCredentialPath);
  assert.equal(plane.asked[0].bearer, "capability");
  assert.equal(plane.asked[0].init.method, "POST");
  assert.equal(plane.asked[0].init.body, undefined);
  assert.deepEqual(writer.written, [
    {
      file: mintedFile,
      content: password,
      options: { mode: 0o600 },
    },
  ]);
  assert.deepEqual(credential, {
    file: mintedFile,
    username: minted.username,
    password,
  });
});

test("a credential is written under the directory the caller names, where it names one", async () => {
  const plane = planeOf({ status: 200, ok: true, json: async () => minted });
  const writer = writerOf();

  const credential = await planeCredential({
    task,
    bearer: "capability",
    path: sessionCredentialPath,
    repository: "https://github.com/kasofsk/chuggy.git",
    request: plane.request,
    write: writer.write,
    directory: "/minted/session-1",
  });

  assert.deepEqual(
    writer.written.map(({ file }) => file),
    ["/minted/session-1/chuggy-git-credential"],
  );
  assert.equal(credential.file, "/minted/session-1/chuggy-git-credential");
});

test("a not-found is an answer the transport hands back rather than retries", async () => {
  const plane = planeOf({
    status: 404,
    json: async () => ({ reason: "ForgeNotConfigured" }),
  });
  const writer = writerOf();

  const credential = await planeCredential({
    task,
    bearer: "capability",
    path: workerCredentialPath,
    request: plane.request,
    write: writer.write,
  });

  assert.equal(credential, undefined);
  assert.deepEqual(writer.written, []);
  assert.deepEqual(plane.asked[0].transport.settled, [404]);
});

test("a session names its repository and the plane is told nothing else", async () => {
  const plane = planeOf({ status: 200, ok: true, json: async () => minted });
  const writer = writerOf();

  await planeCredential({
    task,
    bearer: "chgs_0123456789abcdef0123456789abcdef",
    path: sessionCredentialPath,
    repository: "https://github.com/kasofsk/chuggy.git",
    request: plane.request,
    write: writer.write,
  });

  assert.equal(plane.asked[0].path, sessionCredentialPath);
  assert.equal(plane.asked[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(plane.asked[0].init.body), {
    repository: "https://github.com/kasofsk/chuggy.git",
  });
});

/**
 * Catches a read of another repository asked without naming it, which the
 * plane answers with the attempt's own credential; or one written where the
 * askpass reads the attempt's own, which its push would then present.
 */
test("an attempt names another repository in its body and is answered what it is minted, written nowhere", async () => {
  const plane = planeOf({ status: 200, ok: true, json: async () => minted });

  const read = await planeCredentialAnswered({
    task,
    bearer: "capability",
    path: workerCredentialPath,
    repository: "https://github.com/kasofsk/chuggy-lib.git",
    request: plane.request,
  });

  assert.deepEqual(read, minted);
  assert.equal(plane.asked[0].path, workerCredentialPath);
  assert.equal(plane.asked[0].init.method, "POST");
  assert.equal(plane.asked[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(plane.asked[0].init.body), {
    repository: "https://github.com/kasofsk/chuggy-lib.git",
  });
});

/**
 * Catches a repository the project does not bind answered with anything at
 * all, which a caller could fall back from to the launcher's mount.
 */
test("another repository the plane mints nothing for is answered nothing", async () => {
  const plane = planeOf({
    status: 404,
    ok: false,
    json: async () => ({ reason: "NotMinted" }),
  });

  assert.equal(
    await planeCredentialAnswered({
      task,
      bearer: "capability",
      path: workerCredentialPath,
      repository: "https://github.com/kasofsk/unbound.git",
      request: plane.request,
    }),
    undefined,
  );
  assert.deepEqual(plane.asked[0].transport.settled, [404]);
});

/**
 * Catches the plane's word on which way its app does not reach a repository
 * dropped, which leaves a person reading the mounted map's refusal instead.
 */
test("a not minted that says which way the app does not reach the repository is answered that, as the contract reads it", async () => {
  for (const { unreached } of credentialUnreachedCases) {
    const body = { reason: "NotMinted", unreached };
    const writer = writerOf();
    for (const path of [workerCredentialPath, sessionCredentialPath]) {
      const asked = {
        task,
        bearer: "capability",
        path,
        repository: unreached.repository,
        request: planeOf({ status: 404, ok: false, json: async () => body })
          .request,
      };

      assert.deepEqual(await planeCredentialAnswered(asked), {
        unreached: workerCredentialAbsentSchema.parse(body).unreached,
      });
      assert.deepEqual(
        await planeCredential({ ...asked, write: writer.write }),
        { unreached },
      );
    }
    assert.deepEqual(writer.written, []);
  }
});

test("a not minted that says no more, or that the contract cannot read, is answered nothing", async () => {
  const [{ unreached }] = credentialUnreachedCases;
  for (const body of [
    { reason: "NotMinted" },
    { reason: "NotMinted", unreached: { ...unreached, reach: "Elsewhere" } },
  ]) {
    assert.equal(
      workerCredentialAbsentSchema.safeParse(body).success,
      body.unreached === undefined,
    );
    assert.equal(
      await planeCredentialAnswered({
        task,
        bearer: "capability",
        path: workerCredentialPath,
        request: planeOf({ status: 404, ok: false, json: async () => body })
          .request,
      }),
      undefined,
    );
  }
});

test("each way the app does not reach a repository is told with its identities and its remedy", () => {
  for (const { unreached, told } of credentialUnreachedCases) {
    const text = planeCredentialUnreachedText(unreached);
    for (const phrase of told) assert.ok(text.includes(phrase), text);
  }
});

/**
 * Catches a field the contract does not name reaching the text, which is where
 * a token in a refusal's body would leak from.
 */
test("the text carries only what the contract names of the answer", () => {
  const [{ unreached }] = credentialUnreachedCases;
  const text = planeCredentialUnreachedText({
    ...unreached,
    token: password,
    authorization: `Bearer ${password}`,
  });

  assert.ok(!text.includes(password), text);
  assert.equal(text, planeCredentialUnreachedText(unreached));
});

/**
 * A fake request takes the fifth argument and ignores it, so only the real
 * transport shows whether naming one field of it unset the rest.
 */
test("a session reaches the plane through the transport it is actually given", async () => {
  const writer = writerOf();
  const answers = [
    new globalThis.Response(JSON.stringify({ reason: "NotMinted" }), {
      status: 404,
      headers: { [workerContractHeader]: workerContractRelease },
    }),
    { status: 200, ok: true, json: async () => minted },
  ];
  const sent = [];
  const restore = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), init });
    return answers[sent.length - 1];
  };
  try {
    const asked = {
      task,
      bearer: "chgs_0123456789abcdef0123456789abcdef",
      path: sessionCredentialPath,
      repository: "https://github.com/kasofsk/chuggy.git",
      request: sessionRequest,
      write: writer.write,
    };

    assert.equal(await planeCredential(asked), undefined);
    const credential = await planeCredential(asked);

    assert.equal(credential.file, mintedFile);
    assert.equal(sent.length, 2);
    assert.equal(
      sent[0].url,
      `http://worker-plane.test:3001${sessionCredentialPath}`,
    );
    assert.equal(
      sent[0].init.headers.authorization,
      "Bearer chgs_0123456789abcdef0123456789abcdef",
    );
  } finally {
    globalThis.fetch = restore;
  }
});

test("every refusal but a not-found is this pod's failure", async () => {
  const writer = writerOf();
  await assert.rejects(
    planeCredential({
      task,
      bearer: "capability",
      path: workerCredentialPath,
      request: planeOf({ status: 401, json: async () => ({}) }).request,
      write: writer.write,
    }),
    /answered 401 for a credential/u,
  );
  assert.deepEqual(writer.written, []);
});

test("an answer carrying no password is refused rather than written out", async () => {
  const writer = writerOf();
  for (const answered of [{}, { username: "x-access-token" }, { password }]) {
    await assert.rejects(
      planeCredential({
        task,
        bearer: "capability",
        path: workerCredentialPath,
        request: planeOf({ status: 200, ok: true, json: async () => answered })
          .request,
        environment: {},
        write: writer.write,
      }),
      /answered a credential it did not mint/u,
    );
  }
  assert.deepEqual(writer.written, []);
});
