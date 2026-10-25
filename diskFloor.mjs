/**
 * The floor of free disk a container backend keeps where its engine stores
 * images, containers and volumes, held on each `held` as a kubelet holds a
 * node's disk pressure. Under it, what a reclaim may remove goes first, at
 * most once a `diskReclaimIntervalMs`, and no job is taken while still under.
 * Under half of it a reclaim is made every pass, and one running job is
 * stopped a pass only after a reclaim that began, where the disk is still
 * under half. Each measurement, reclaim and ranking is given
 * `diskFloorCallsMsMax`. A measurement that is unknown holds no floor.
 */

import { z } from "zod";

/**
 * @typedef {{free: number, where: string} | {unknown: string}} DiskFree the bytes free where the engine stores what it holds, the lowest of its filesystems, or why that is unknown
 *
 * @typedef {object} DiskFloor
 * @property {number} bytesMin
 * @property {() => Promise<DiskFree>} measured the runner's own measurement
 * @property {"Over" | "Under" | "Unknown"} said what was last logged of it, `Over` before anything was
 * @property {number | undefined} reclaimedMs when the last reclaim began its turn
 * @property {Set<string>} kept the images, by id, a reclaim has logged keeping since the disk went under
 * @property {boolean} jobsTaken
 *
 * @typedef {object} DiskFloorPorts what holding the floor reaches of its backend
 * @property {(ms: number, signal: AbortSignal) => Promise<void>} sleep
 * @property {() => number} nowMs
 * @property {(line: string) => void} log
 * @property {(signal: AbortSignal, made: import("./imageCleanup.mjs").ImageReclaim) => Promise<unknown>} reclaimed
 * @property {(why: string) => Promise<void>} killed stops one running job, which ends with `why`
 */

/** The longest a pass waits on one measurement, reclaim or ranking of what jobs hold. */
export const diskFloorCallsMsMax = 30_000;

/** The least time between two reclaims of a backend under its floor but over half of it. */
export const diskReclaimIntervalMs = 60_000;

/**
 * Bytes as a count of GiB to one place, which a whole count shows bare.
 *
 * @param {number} bytes
 */
export function diskGib(bytes) {
  return (bytes / 2 ** 30).toFixed(1).replace(/\.0$/u, "");
}

/**
 * What `work` answers, or nothing once `diskFloorCallsMsMax` has passed, when
 * the signal it was handed aborts; one that throws answers nothing too.
 *
 * @template T
 * @param {Pick<DiskFloorPorts, "sleep">} ports
 * @param {(signal: AbortSignal) => Promise<T>} work
 * @returns {Promise<T | undefined>}
 */
export async function diskFloorCapped(ports, work) {
  const cap = new globalThis.AbortController();
  const done = new globalThis.AbortController();
  const passed = ports.sleep(diskFloorCallsMsMax, done.signal).then(
    () => {
      cap.abort();
    },
    () => undefined,
  );
  try {
    return await Promise.race([
      work(cap.signal).catch(() => undefined),
      passed.then(() => undefined),
    ]);
  } finally {
    done.abort();
  }
}

/**
 * The runner's measurement, one that throws answering why.
 *
 * @param {DiskFloor} floor
 * @returns {Promise<DiskFree>}
 */
async function diskAnswered(floor) {
  try {
    return await floor.measured();
  } catch (error) {
    return { unknown: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * @param {DiskFloor} floor
 * @param {DiskFloorPorts} ports
 * @returns {Promise<DiskFree>}
 */
async function diskMeasured(floor, ports) {
  return (
    (await diskFloorCapped(ports, () => diskAnswered(floor))) ?? {
      unknown: "its measurement did not answer in time",
    }
  );
}

/**
 * @param {DiskFloor} floor
 * @param {{free: number, where: string}} measured
 */
function diskLine(floor, measured) {
  return `this runner's disk has ${diskGib(measured.free)} GiB free at ${measured.where}`;
}

/**
 * Logs what the floor now is where it differs from what was last logged.
 *
 * @param {DiskFloor} floor
 * @param {DiskFloorPorts} ports
 * @param {DiskFree} measured
 * @param {"Over" | "Under"} [now] whether it is under, where it is known
 */
function diskSaid(floor, ports, measured, now) {
  const was = floor.said;
  if ("unknown" in measured) {
    if (was !== "Unknown")
      ports.log(
        `this runner's free disk could not be measured, so it holds no floor: ${measured.unknown}`,
      );
    floor.said = "Unknown";
    return;
  }
  if (now === was) return;
  floor.said = now;
  const min = `its floor of ${diskGib(floor.bytesMin)} GiB`;
  if (now === "Under") {
    floor.kept.clear();
    ports.log(
      `${diskLine(floor, measured)}, under ${min}: it takes no job until it is over`,
    );
  } else
    ports.log(
      `${diskLine(floor, measured)}, over ${min}${was === "Under" ? ": it takes jobs again" : ""}`,
    );
}

/**
 * Holds the floor for one pass: measures, and where under it reclaims until
 * the disk is over the floor it was found under, half the floor's where it
 * was under that. Under half, the reclaim is made every pass; over half, only
 * where none began its turn inside the interval. A reclaim that began, and a
 * fresh measurement then still under half, has one job stopped; one that
 * could not begin before its cap stops none. Whether jobs are taken is what
 * the last measurement found.
 *
 * @param {DiskFloor} floor
 * @param {DiskFloorPorts} ports
 */
export async function diskFloorHeld(floor, ports) {
  const found = await diskMeasured(floor, ports);
  if ("unknown" in found || found.free >= floor.bytesMin) {
    diskSaid(floor, ports, found, "Over");
    floor.jobsTaken = true;
    return;
  }
  diskSaid(floor, ports, found, "Under");
  const hard = Math.floor(floor.bytesMin / 2);
  const underHalf = found.free < hard;
  const target = underHalf ? hard : floor.bytesMin;
  let now = found;
  let begun = false;
  if (
    underHalf ||
    floor.reclaimedMs === undefined ||
    ports.nowMs() - floor.reclaimedMs >= diskReclaimIntervalMs
  ) {
    await diskFloorCapped(ports, (signal) =>
      ports.reclaimed(signal, {
        enough: async () => {
          const measured = await diskAnswered(floor);
          return !("unknown" in measured) && measured.free >= target;
        },
        said: floor.kept,
        begun: () => {
          begun = true;
          floor.reclaimedMs = ports.nowMs();
        },
      }),
    );
    now = await diskMeasured(floor, ports);
  }
  if ("unknown" in now) {
    diskSaid(floor, ports, now);
    floor.jobsTaken = true;
    return;
  }
  if (begun && now.free < hard)
    await ports.killed(
      `its container was killed because this runner's disk had ${diskGib(now.free)} GiB free at ${now.where}, under half its floor of ${diskGib(floor.bytesMin)} GiB. Free space on this runner, then resume the ticket`,
    );
  floor.jobsTaken = now.free >= floor.bytesMin;
  diskSaid(floor, ports, now, floor.jobsTaken ? "Over" : "Under");
}

/**
 * A floor of `bytesMin` over what `measured` answers, or none where either is
 * absent or the minimum is 0.
 *
 * @param {number | undefined} bytesMin
 * @param {(() => Promise<DiskFree>) | undefined} measured
 * @returns {DiskFloor | undefined}
 */
export function diskFloor(bytesMin, measured) {
  if (measured === undefined || bytesMin === undefined || bytesMin === 0)
    return undefined;
  return {
    bytesMin,
    measured,
    said: "Over",
    reclaimedMs: undefined,
    kept: new Set(),
    jobsTaken: true,
  };
}

/** The units docker's sizes are counted in, each a thousand of the one before. */
const decimalUnits = ["B", "kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

/**
 * The bytes a size docker printed counts, which its `units.HumanSize` writes
 * as `%.4g` of decimal units, or nothing for one it did not.
 *
 * @param {string} size
 */
export function dockerSizeBytes(size) {
  const match = /^(\d+(?:\.\d+)?)([kMGTPEZY]?B)$/u.exec(size);
  if (match === null) return undefined;
  return (
    Number(match[1]) *
    1000 ** decimalUnits.indexOf(/** @type {string} */ (match[2]))
  );
}

const dockerDiskUsageSchema = z.object({
  Containers: z.array(z.object({ ID: z.string(), Size: z.string() })),
  Volumes: z.array(z.object({ Name: z.string(), Size: z.string() })),
});

/**
 * What docker's verbose `system df` says each container and volume holds, by
 * container id and volume name, a size it did not print counted as none; or
 * nothing for an answer of another shape.
 *
 * @param {string} stdout
 * @returns {{containers: Map<string, number>, volumes: Map<string, number>} | undefined}
 */
export function dockerDiskUsage(stdout) {
  let parsed;
  try {
    parsed = dockerDiskUsageSchema.safeParse(JSON.parse(stdout));
  } catch {
    return undefined;
  }
  if (!parsed.success) return undefined;
  return {
    containers: new Map(
      parsed.data.Containers.map(({ ID, Size }) => [
        ID,
        dockerSizeBytes(Size) ?? 0,
      ]),
    ),
    volumes: new Map(
      parsed.data.Volumes.map(({ Name, Size }) => [
        Name,
        dockerSizeBytes(Size) ?? 0,
      ]),
    ),
  };
}
