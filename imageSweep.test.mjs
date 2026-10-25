/**
 * An inspection here is docker 28.1's where it says so, copied from a run
 * against a daemon; the containerd store's and podman's are built from the
 * source that answers them, each naming the file and function, since no run
 * of either was seen. A digest no engine printed is a run of one hex digit.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  imageEntriesStale,
  imageName,
  imageSweepRemovals,
  imageUseMarginMs,
  storedImage,
} from "./imageSweep.mjs";

const busybox =
  "sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";
const busyboxConfig =
  "sha256:30ecbe1509090b38ef3260f3609d64d8261230464eaa4d235901db496e9647fb";

/** An image pulled by digest alone, as each engine inspects it. */
const digestOnly = {
  // docker 28.1, its classic store: `docker image inspect`.
  "docker's classic store": {
    Id: busyboxConfig,
    RepoTags: [],
    RepoDigests: [`busybox@${busybox}`],
    Created: "2024-09-26T21:31:42Z",
  },
  // moby's daemon/containerd/image_inspect.go: `ImageService.ImageInspect`
  // answers the pinned digest as the id, and `collectRepoTagsAndDigests`
  // lists the digested name under RepoTags as well as RepoDigests.
  "docker's containerd store": {
    Id: busybox,
    RepoTags: [`busybox@${busybox}`],
    RepoDigests: [`busybox@${busybox}`],
    Created: "2024-09-26T21:31:42Z",
  },
  // containers/container-libs's common/libimage/inspect.go: `Image.Inspect`
  // answers the storage id, which has no algorithm; image.go's `RepoTags`
  // lists only tagged names, and its `RepoDigests` each name with each
  // digest, the platform manifest's among them, by its whole name.
  podman: {
    Id: busyboxConfig.replace("sha256:", ""),
    RepoTags: [],
    RepoDigests: [
      `docker.io/library/busybox@${busybox}`,
      `docker.io/library/busybox@sha256:${"e".repeat(64)}`,
    ],
    Created: "2024-09-26T21:31:42.000000000Z",
  },
};

for (const [engine, inspected] of Object.entries(digestOnly))
  test(`an image pulled by digest alone is untagged, and named by its digest, on ${engine}`, () => {
    const image = storedImage(inspected);
    assert.deepEqual(image.tags, []);
    assert.deepEqual(image.digests[0], {
      name: inspected.RepoDigests[0],
      repository: "docker.io/library/busybox",
      digest: busybox,
    });
    assert.equal(image.createdMs, Date.parse("2024-09-26T21:31:42Z"));
  });

test("a name is read whole, as the engines read one", () => {
  assert.deepEqual(imageName("busybox"), {
    repository: "docker.io/library/busybox",
  });
  assert.deepEqual(imageName("busybox:1.37"), {
    repository: "docker.io/library/busybox",
    tag: "1.37",
  });
  assert.deepEqual(imageName("index.docker.io/kasofsk/worker@sha256:1"), {
    repository: "docker.io/kasofsk/worker",
    digest: "sha256:1",
  });
  assert.deepEqual(imageName("localhost:5000/worker:v1@sha256:1"), {
    repository: "localhost:5000/worker",
    tag: "v1",
    digest: "sha256:1",
  });
  assert.deepEqual(imageName("registry.chuggy.example/chuggy/runtime"), {
    repository: "registry.chuggy.example/chuggy/runtime",
  });
});

const nowMs = Date.parse("2026-10-24T12:00:00Z");
const dayMs = 86_400_000;
const runtime = "registry.chuggy.example/chuggy/runtime";
const sweep = { keptPerRepository: 2, unusedMsMax: 7 * dayMs };
const reclaim = { keptPerRepository: 1, unusedMsMax: "Ignored" };

/**
 * A runtime image of this digest, pulled by digest alone and built `days`
 * before now.
 *
 * @param {string} hex
 * @param {number} days
 */
function runtimeImage(hex, days) {
  return storedImage({
    Id: `sha256:${hex.repeat(64)}`,
    RepoTags: [],
    RepoDigests: [`${runtime}@sha256:${hex.repeat(64)}`],
    Created: new Date(nowMs - days * dayMs).toISOString(),
  });
}

/** @param {string} hex */
const runtimeReference = (hex) => `${runtime}@sha256:${hex.repeat(64)}`;

/**
 * A record begun `days` before now that knows the runtime's repository.
 *
 * @param {Partial<import("./imageRecord.mjs").ImageRecord>} [fields]
 * @returns {import("./imageRecord.mjs").ImageRecord}
 */
function record(fields = {}) {
  return {
    version: 1,
    createdMs: nowMs - 30 * dayMs,
    repositories: { [runtime]: { kinds: ["Runtime"] } },
    images: {},
    holds: {},
    ...fields,
  };
}

/** @param {import("./imageSweep.mjs").ImageRemoval[]} removals */
const removed = (removals) => removals.flatMap(({ references }) => references);

test("a runtime repository no use of which was recorded keeps its two newest images, and the rest go oldest first", () => {
  const images = [
    runtimeImage("1", 40),
    runtimeImage("4", 10),
    runtimeImage("2", 30),
    runtimeImage("5", 5),
    runtimeImage("3", 20),
  ];
  assert.deepEqual(
    removed(imageSweepRemovals(images, record(), nowMs, sweep)),
    ["1", "2", "3"].map(runtimeReference),
  );
});

test("a runtime repository keeps the images most recently used, whenever they were built", () => {
  const images = ["1", "2", "3", "4"].map((hex, index) =>
    runtimeImage(hex, 40 - index),
  );
  const used = record({
    images: {
      [runtimeReference("1")]: { kinds: ["Runtime"], usedMs: nowMs - dayMs },
      [runtimeReference("2")]: {
        kinds: ["Runtime"],
        usedMs: nowMs - 2 * dayMs,
      },
    },
  });
  assert.deepEqual(
    removed(imageSweepRemovals(images, used, nowMs, sweep)),
    ["3", "4"].map(runtimeReference),
  );
});

test("an image with a tag of anyone's stays, and a digested name the containerd store lists among its tags is no tag", () => {
  const images = ["1", "2", "3"].map((hex, index) =>
    runtimeImage(hex, 40 - index),
  );
  const tagged = storedImage({
    Id: `sha256:${"0".repeat(64)}`,
    RepoTags: [`${runtime}:mine`],
    RepoDigests: [runtimeReference("0")],
    Created: new Date(nowMs - 50 * dayMs).toISOString(),
  });
  const containerd = storedImage({
    Id: `sha256:${"9".repeat(64)}`,
    RepoTags: [runtimeReference("9")],
    RepoDigests: [runtimeReference("9")],
    Created: new Date(nowMs - 60 * dayMs).toISOString(),
  });
  assert.deepEqual(
    removed(
      imageSweepRemovals(
        [tagged, containerd, ...images],
        record(),
        nowMs,
        sweep,
      ),
    ),
    [runtimeReference("9"), runtimeReference("1")],
  );
});

test("an image a live hold names stays, and one a hold that ran out names does not", () => {
  const images = ["1", "2", "3"].map((hex, index) =>
    runtimeImage(hex, 40 - index),
  );
  const holding = (untilMs) =>
    record({
      holds: { "chuggy-shame-1": { images: [runtimeReference("1")], untilMs } },
    });
  assert.deepEqual(
    removed(imageSweepRemovals(images, holding(nowMs + 1), nowMs, sweep)),
    [],
  );
  assert.deepEqual(
    removed(imageSweepRemovals(images, holding(nowMs), nowMs, sweep)),
    [runtimeReference("1")],
  );
});

test("an image used within the margin stays", () => {
  const images = ["1", "2", "3"].map((hex, index) =>
    runtimeImage(hex, 40 - index),
  );
  const used = (usedMs) =>
    record({
      images: { [runtimeReference("3")]: { kinds: ["Runtime"], usedMs } },
      createdMs: nowMs - imageUseMarginMs,
    });
  assert.deepEqual(
    removed(
      imageSweepRemovals(images, used(nowMs - imageUseMarginMs + 1), nowMs, {
        ...sweep,
        keptPerRepository: 0,
      }),
    ),
    ["1", "2"].map(runtimeReference),
  );
  assert.deepEqual(
    removed(
      imageSweepRemovals(images, used(nowMs - imageUseMarginMs), nowMs, {
        ...sweep,
        keptPerRepository: 0,
      }),
    ),
    ["1", "2", "3"].map(runtimeReference),
  );
});

const tool = "ghcr.io/owner/tool:1";
const toolId = `sha256:${"7".repeat(64)}`;
const toolImage = storedImage({
  Id: toolId,
  RepoTags: [tool],
  RepoDigests: [`ghcr.io/owner/tool@sha256:${"8".repeat(64)}`],
  Created: new Date(nowMs - 90 * dayMs).toISOString(),
});

/**
 * A record of the job's image, used `days` before now.
 *
 * @param {number} days
 * @param {string} [pulledId]
 */
function jobRecord(days, pulledId = toolId) {
  return record({
    images: {
      [tool]: { kinds: ["Job"], usedMs: nowMs - days * dayMs, pulledId },
    },
  });
}

test("a job's image the runner pulled goes once unused for the retention, and not before", () => {
  assert.deepEqual(
    removed(imageSweepRemovals([toolImage], jobRecord(7), nowMs, sweep)),
    [tool],
  );
  assert.deepEqual(
    removed(imageSweepRemovals([toolImage], jobRecord(6), nowMs, sweep)),
    [],
  );
});

test("a retention of 0 keeps a job's image the runner pulled however long it goes unused", () => {
  assert.deepEqual(
    removed(
      imageSweepRemovals([toolImage], jobRecord(365), nowMs, {
        ...sweep,
        unusedMsMax: 0,
      }),
    ),
    [],
  );
});

test("a job's image the runner pulled stays while it has a tag but the one it was pulled by", () => {
  const retagged = storedImage({
    Id: toolId,
    RepoTags: [tool, "ghcr.io/owner/tool:kept"],
    RepoDigests: [],
  });
  assert.deepEqual(
    removed(imageSweepRemovals([retagged], jobRecord(30), nowMs, sweep)),
    [],
  );
});

test("a job's image pulled by a tag and a digest together goes once unused for the retention, though the containerd store lists that name among its tags", () => {
  // moby's daemon/containerd/image_pull.go: `ImageService.pullTag` names the
  // image by the reference as pulled, and image_inspect.go's
  // `collectRepoTagsAndDigests` lists a digested name under both.
  const pinned = `ghcr.io/owner/tool:1@sha256:${"8".repeat(64)}`;
  const containerd = storedImage({
    Id: `sha256:${"8".repeat(64)}`,
    RepoTags: [pinned],
    RepoDigests: [pinned],
  });
  const used = record({
    images: {
      [pinned]: {
        kinds: ["Job"],
        usedMs: nowMs - 30 * dayMs,
        pulledId: `sha256:${"8".repeat(64)}`,
      },
    },
  });
  assert.deepEqual(
    removed(imageSweepRemovals([containerd], used, nowMs, sweep)),
    [pinned],
  );
});

test("a job's image is matched to its pull by id whether or not its engine prefixes the algorithm", () => {
  const podman = { ...toolImage, id: toolId.replace("sha256:", "") };
  assert.deepEqual(
    removed(imageSweepRemovals([podman], jobRecord(30), nowMs, sweep)),
    [tool],
  );
});

test("a job's image the runner did not pull, or that its name no longer names, stays and is forgotten only when the name moved", () => {
  const unpulled = record({
    images: { [tool]: { kinds: ["Job"], usedMs: nowMs - 30 * dayMs } },
  });
  assert.deepEqual(
    removed(imageSweepRemovals([toolImage], unpulled, nowMs, sweep)),
    [],
  );
  assert.deepEqual(imageEntriesStale([toolImage], unpulled, nowMs), []);
  const moved = jobRecord(30, `sha256:${"6".repeat(64)}`);
  assert.deepEqual(
    removed(imageSweepRemovals([toolImage], moved, nowMs, sweep)),
    [],
  );
  assert.deepEqual(imageEntriesStale([toolImage], moved, nowMs), [tool]);
});

test("an image both rules cover goes only when both let it go", () => {
  const images = ["1", "2", "3"].map((hex, index) =>
    runtimeImage(hex, 40 - index),
  );
  const jobUsed = (days) =>
    record({
      images: {
        [runtimeReference("1")]: {
          kinds: ["Job"],
          usedMs: nowMs - days * dayMs,
          pulledId: `sha256:${"1".repeat(64)}`,
        },
      },
      createdMs: nowMs - dayMs,
    });
  assert.deepEqual(
    removed(imageSweepRemovals(images, jobUsed(3), nowMs, sweep)),
    [],
  );
  assert.deepEqual(
    removed(imageSweepRemovals(images, jobUsed(8), nowMs, sweep)),
    [runtimeReference("1")],
  );
});

test("a reclaim keeps only a runtime repository's newest and ignores the retention, and a hold and the margin still keep theirs", () => {
  const images = [runtimeImage("1", 40), runtimeImage("2", 30), toolImage];
  assert.deepEqual(
    removed(imageSweepRemovals(images, jobRecord(1), nowMs, reclaim)),
    [runtimeReference("1"), tool],
  );
  const held = {
    ...jobRecord(1),
    holds: { "chuggy-shame-1": { images: [tool], untilMs: nowMs + 1 } },
  };
  assert.deepEqual(removed(imageSweepRemovals(images, held, nowMs, reclaim)), [
    runtimeReference("1"),
  ]);
  assert.deepEqual(
    removed(imageSweepRemovals(images, jobRecord(0), nowMs, reclaim)),
    [runtimeReference("1")],
  );
});

test("an entry naming no image here is forgotten, unless it was used since the images were listed", () => {
  const entries = record({
    images: {
      [runtimeReference("1")]: { kinds: ["Runtime"], usedMs: nowMs - 1 },
      [runtimeReference("2")]: { kinds: ["Runtime"], usedMs: nowMs },
      [runtimeReference("3")]: { kinds: ["Runtime"], usedMs: nowMs - 1 },
    },
  });
  assert.deepEqual(imageEntriesStale([runtimeImage("3", 1)], entries, nowMs), [
    runtimeReference("1"),
  ]);
});
