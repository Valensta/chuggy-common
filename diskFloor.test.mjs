/**
 * docker's verbose `system df` here is docker 28.1's, its entries cut from a
 * run against a daemon to the fields read and one of each kind.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diskGib, dockerDiskUsage, dockerSizeBytes } from "./diskFloor.mjs";

test("a size docker prints is read in its decimal units, and one it did not print is none", () => {
  assert.deepEqual(
    ["0B", "68B", "29.09kB", "98.28MB", "7.22GB", "1.5TB", "2PB"].map(
      dockerSizeBytes,
    ),
    [0, 68, 29_090, 98_280_000, 7_220_000_000, 1_500_000_000_000, 2e15],
  );
  for (const size of ["N/A", "", "1e+03MB", "12 MB", "1.5GiB", "-1B"])
    assert.equal(dockerSizeBytes(size), undefined, size);
});

test("docker's disk usage is read by container id and volume name, and an answer of another shape is none", () => {
  const usage = dockerDiskUsage(
    JSON.stringify({
      Images: [],
      Containers: [
        {
          ID: "b65ba8fa007b7df473863df7084d45a88c541bd4d6b9dd007393384fd8ecc6ba",
          Names: "b-floor-pg",
          Size: "68B",
          State: "running",
        },
      ],
      Volumes: [
        {
          Driver: "local",
          Links: "0",
          Name: "f09db8433f4afc966e0056b05d1e31bd696198977bbe70f6cc5b1a1acb28c751",
          Size: "121.3MB",
        },
        { Name: "elsewhere", Size: "N/A" },
      ],
      BuildCache: [],
    }),
  );
  assert.deepEqual(usage, {
    containers: new Map([
      ["b65ba8fa007b7df473863df7084d45a88c541bd4d6b9dd007393384fd8ecc6ba", 68],
    ]),
    volumes: new Map([
      [
        "f09db8433f4afc966e0056b05d1e31bd696198977bbe70f6cc5b1a1acb28c751",
        121_300_000,
      ],
      ["elsewhere", 0],
    ]),
  });
  for (const stdout of ["", "{", "[]", JSON.stringify({ Containers: [] })])
    assert.equal(dockerDiskUsage(stdout), undefined, stdout);
});

test("free bytes are said in GiB to one place, a whole count bare", () => {
  assert.deepEqual(
    [20 * 2 ** 30, 8.25 * 2 ** 30, 0, 2 ** 30 / 2].map(diskGib),
    ["20", "8.3", "0", "0.5"],
  );
});
