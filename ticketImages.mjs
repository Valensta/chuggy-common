/**
 * The images a ticket's brief carries, read for its agent before the agent
 * starts.
 *
 * THE AGENT IS NOT HANDED THE BEARER. The plane serves a brief's image only to
 * the attempt's own bearer, and the agent's shell runs the project's code, so
 * the agent's environment carries no bearer and its briefing names nowhere one
 * is kept. Nothing here keeps the bearer from a process of this user's that
 * goes looking for it. Each image its input bundle pins is read here instead,
 * held to the digest the bundle pinned it under, and written to a file of its
 * own, so the agent opens a file where it would otherwise need an HTTP client;
 * its briefing is told which file holds which image.
 *
 * A FILE IS NAMED FOR WHAT ITS BYTES ARE, so an agent's reader of images takes
 * it for one. The identity the plane names an image by is opaque here, so the
 * format is read from the bytes and never from the identity.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  workerInputReferencesMax,
  workerPlaneInputArtifactBytesMax,
  workerPlaneRoutes,
} from "@chuggy/worker-contract/workerPlane";

import { boundedResponseBytes } from "./boundedResponse.mjs";
import { workerRequest } from "./transport.mjs";
import { routePath } from "./wire.mjs";

/** The input reference a brief's image is pinned under. */
const ticketImageKind = "ProjectArtifact";

/** The chunks one image's answer may arrive in. */
const ticketImageReadsMax = 4_096;

/** `bytes` opens with `opening`, each of its members a byte or a character. */
function opensWith(bytes, opening, offset = 0) {
  return [...opening].every(
    (expected, at) =>
      bytes[offset + at] ===
      (typeof expected === "number" ? expected : expected.charCodeAt(0)),
  );
}

/** Each format the plane admits an image in, by the bytes it opens with. */
const ticketImageFormats = [
  {
    extension: ".png",
    opens: (bytes) =>
      opensWith(bytes, [0x89, ..."PNG", 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { extension: ".jpg", opens: (bytes) => opensWith(bytes, [0xff, 0xd8, 0xff]) },
  {
    extension: ".gif",
    opens: (bytes) => opensWith(bytes, "GIF87a") || opensWith(bytes, "GIF89a"),
  },
  {
    extension: ".webp",
    opens: (bytes) => opensWith(bytes, "RIFF") && opensWith(bytes, "WEBP", 8),
  },
];

/** The extension a file of `bytes` is named with: its format's, or none where it is none the plane admits. */
export function ticketImageExtension(bytes) {
  return ticketImageFormats.find(({ opens }) => opens(bytes))?.extension ?? "";
}

/** The images an attempt's input bundle pins, in the order it pins them. */
export function ticketImageReferences(input) {
  const images = input.references.filter(
    (reference) => reference.kind === ticketImageKind,
  );
  if (images.length > workerInputReferencesMax)
    throw new Error(
      `input bundle pins more images than a bundle holds references`,
    );
  return images;
}

/**
 * Each image `references` names, read from the plane with `bearer` and written
 * into `directory`, which no other run writes: its identity and its file. An
 * image whose bytes are not the ones its bundle pinned is refused, as is one
 * past what the plane serves.
 */
export async function readTicketImages({
  task,
  bearer,
  references,
  directory,
  request = workerRequest,
}) {
  const images = [];
  for (const [at, { reference, digest }] of references.entries()) {
    const response = await request(
      task,
      bearer,
      routePath(workerPlaneRoutes.inputArtifact, reference),
    );
    const bytes = await boundedResponseBytes(
      response,
      workerPlaneInputArtifactBytesMax,
      ticketImageReadsMax,
    );
    if (
      digest !== undefined &&
      createHash("sha256").update(bytes).digest("hex") !== digest
    )
      throw new Error(
        `the image ${reference} is not the one the input bundle pinned`,
      );
    const file = join(
      directory,
      `${String(at + 1)}${ticketImageExtension(bytes)}`,
    );
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    images.push({ identity: reference, file });
  }
  return images;
}

/**
 * `task` as its agent is handed it: its briefing ending in a section naming the
 * file each image was read into, or as it was where there is no image.
 */
export function ticketImagesBriefed(task, images) {
  if (images.length === 0) return task;
  const section = [
    "## Images for this ticket, as files",
    "Each image this briefing names is already read into a file, since this run is not handed the bearer to read it from the plane with; open the file instead.",
    ...images.map(({ identity, file }) => `- ${identity}: ${file}`),
  ].join("\n");
  return {
    ...task,
    briefing: {
      ...task.briefing,
      text: `${task.briefing.text}\n\n${section}`,
    },
  };
}
