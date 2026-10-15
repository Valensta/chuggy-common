import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  workerInputReferencesMax,
  workerPlaneInputArtifactBytesMax,
} from "@chuggy/worker-contract/workerPlane";

import { overPlane, planeFetch, planes } from "./plane.fixture.mjs";
import {
  readTicketImages,
  ticketImageExtension,
  ticketImageReferences,
  ticketImagesBriefed,
} from "./ticketImages.mjs";
import { workerRequest } from "./transport.mjs";

/** An image's opening bytes in each format the plane admits, and bytes in none. */
const formatted = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]),
  jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 3]),
  gif: Buffer.from("GIF89a\u0004", "latin1"),
  webp: Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "latin1"),
  none: Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVEfmt ", "latin1"),
};

const task = { workerPlane: { url: "http://worker-plane.test" } };
const bearer = "the attempt's bearer";

/** `bytes` as the bundle pins them. */
function pinned(reference, bytes) {
  return {
    kind: "ProjectArtifact",
    reference,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** A plane serving each of `served`, by identity, on the route a brief's image is read from. */
function imagePlane(served) {
  const asked = [];
  const plane = planeFetch(planes.job, (route, request) => {
    asked.push({ route, path: request.path });
    const identity = request.path.slice("/v1/input/artifacts/".length);
    return { status: 200, body: served[identity] };
  });
  return {
    asked,
    request: overPlane(workerRequest, async (url, init) => {
      assert.equal(init.headers.authorization, `Bearer ${bearer}`);
      return plane.fetch(url, init);
    }),
  };
}

async function directoryFor(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-ticket-images-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Catches an image read from anywhere but its own route, without the
 * attempt's bearer, or into a file whose name hides what it is from an
 * agent's reader of images; or one readable by another user.
 */
test("each image a bundle pins is read with the attempt's bearer into a file named for its format", async (t) => {
  const directory = await directoryFor(t);
  const cases = [
    ["image/png:one", formatted.png, "1.png"],
    ["image/jpeg:two", formatted.jpg, "2.jpg"],
    ["image/gif:three", formatted.gif, "3.gif"],
    ["image/webp:four", formatted.webp, "4.webp"],
    ["image/png:five", formatted.none, "5"],
  ];
  const { asked, request } = imagePlane(
    Object.fromEntries(cases.map(([identity, bytes]) => [identity, bytes])),
  );

  const images = await readTicketImages({
    task,
    bearer,
    references: cases.map(([identity, bytes]) => pinned(identity, bytes)),
    directory,
    request,
  });

  assert.deepEqual(
    asked.map(({ path }) => path),
    cases.map(([identity]) => `/v1/input/artifacts/${identity}`),
  );
  assert.deepEqual(
    images,
    cases.map(([identity, , name]) => ({
      identity,
      file: join(directory, name),
    })),
  );
  for (const [at, { file }] of images.entries()) {
    assert.deepEqual(await readFile(file), cases[at][1]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

/** Catches an image kept although its bytes are not the ones its bundle pinned. */
test("an image whose bytes are not the ones its bundle pinned is refused and kept nowhere", async (t) => {
  const directory = await directoryFor(t);
  const { request } = imagePlane({ "image/png:one": formatted.png });

  await assert.rejects(
    readTicketImages({
      task,
      bearer,
      references: [pinned("image/png:one", formatted.jpg)],
      directory,
      request,
    }),
    /^Error: the image image\/png:one is not the one the input bundle pinned$/u,
  );
  assert.deepEqual(await readdir(directory), []);
});

/** Catches an image read past what the plane serves one as. */
test("an image past what the plane serves one as is refused", async (t) => {
  const directory = await directoryFor(t);
  const large = Buffer.alloc(workerPlaneInputArtifactBytesMax + 1);
  const { request } = imagePlane({ "image/png:large": large });

  await assert.rejects(
    readTicketImages({
      task,
      bearer,
      references: [{ kind: "ProjectArtifact", reference: "image/png:large" }],
      directory,
      request,
    }),
    /exceeds its byte bound/u,
  );
  assert.deepEqual(await readdir(directory), []);
});

/** Catches a file something else left taken for this run's image. */
test("an image is never written over a file already there", async (t) => {
  const directory = await directoryFor(t);
  await writeFile(join(directory, "1.png"), "left by another run");
  const { request } = imagePlane({ "image/png:one": formatted.png });

  await assert.rejects(
    readTicketImages({
      task,
      bearer,
      references: [pinned("image/png:one", formatted.png)],
      directory,
      request,
    }),
    /EEXIST/u,
  );
  assert.equal(
    await readFile(join(directory, "1.png"), "utf8"),
    "left by another run",
  );
});

/** Catches a format told from too little of its opening, or from the wrong place in it. */
test("an image's format is told by the whole of its opening", () => {
  assert.equal(ticketImageExtension(formatted.png.subarray(0, 7)), "");
  assert.equal(ticketImageExtension(formatted.none), "");
  assert.equal(ticketImageExtension(Buffer.from("GIF87a", "latin1")), ".gif");
  assert.equal(ticketImageExtension(new Uint8Array()), "");
});

/** Catches an image the bundle pins left out, one it does not taken for one, or their order lost. */
test("the images an input bundle pins are its project artifacts, in its order", () => {
  const input = {
    references: [
      { kind: "Repository", reference: "repository-1" },
      { kind: "ProjectArtifact", reference: "image/png:two" },
      { kind: "TargetCommit", reference: "0".repeat(40) },
      { kind: "ProjectArtifact", reference: "image/gif:one" },
    ],
  };

  assert.deepEqual(
    ticketImageReferences(input).map(({ reference }) => reference),
    ["image/png:two", "image/gif:one"],
  );
  assert.deepEqual(ticketImageReferences({ references: [] }), []);
});

/** Catches more images read than a bundle holds references. */
test("a bundle pinning more images than it holds references is refused", () => {
  const references = Array.from(
    { length: workerInputReferencesMax + 1 },
    (_, at) => ({
      kind: "ProjectArtifact",
      reference: `image/png:${String(at)}`,
    }),
  );

  assert.throws(() => ticketImageReferences({ references }), /more images/u);
});

/** Catches an agent told nothing of where its images are, or a briefing changed where there are none. */
test("a briefing ends naming the file each image was read into", () => {
  const briefed = {
    briefing: { text: "## Your role\nWork.", templateVersion: 6 },
    ticket: 7,
  };

  assert.equal(ticketImagesBriefed(briefed, []), briefed);
  assert.deepEqual(
    ticketImagesBriefed(briefed, [
      { identity: "image/png:one", file: "/tmp/images/1.png" },
      { identity: "image/gif:two", file: "/tmp/images/2.gif" },
    ]),
    {
      ticket: 7,
      briefing: {
        templateVersion: 6,
        text: [
          "## Your role",
          "Work.",
          "",
          "## Images for this ticket, as files",
          "Each image this briefing names is already read into a file, since this run holds no bearer to read it from the plane with; open the file instead.",
          "- image/png:one: /tmp/images/1.png",
          "- image/gif:two: /tmp/images/2.gif",
        ].join("\n"),
      },
    },
  );
});
