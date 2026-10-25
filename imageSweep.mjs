/**
 * Which of this machine's images a runner removes, decided from the engine's
 * inspection of them and the runner's record of what it used, with nothing
 * here calling either.
 *
 * AN IMAGE IS NAMED AS ITS ENGINE NAMES IT. Docker names one familiarly, as
 * `busybox@sha256:…`, and podman by its whole name, as
 * `docker.io/library/busybox@sha256:…`; both are read here as the one
 * repository, the way the engines' own reference parsing reads them. A tag is
 * a name with a tag and no digest: docker's containerd store lists an image
 * pulled by digest alone under `RepoTags` too, by that digested name, and
 * such a name is no tag.
 *
 * TWO RULES REMOVE AN IMAGE, and an image either covers goes only when every
 * rule covering it lets it go:
 * - an image of a repository chuggy's runtime or sessions came from, untagged,
 *   once it is not among that repository's most recently used, the image's own
 *   creation breaking a tie, so that images the record never saw used keep
 *   their newest;
 * - an image a job ran in that the runner pulled itself, once it has gone
 *   unused for the retention, where there is one.
 *
 * NOTHING ELSE IS EVER REMOVED, and neither rule removes an image with a tag
 * of anyone's, one a placement in flight holds, or one used within
 * `imageUseMarginMs`. A reclaim keeps fewer and ignores the retention; it is
 * held to the same guards.
 */

/**
 * @typedef {"Job" | "Runtime" | "Session"} ImageUseKind
 *
 * @typedef {object} ImageName a reference read as its parts, its repository whole
 * @property {string} repository as `docker.io/library/busybox`
 * @property {string} [tag]
 * @property {string} [digest]
 *
 * @typedef {object} StoredImage an image of this machine's engine, as an inspection described it
 * @property {string} id as the engine listed it, which an inspection takes back
 * @property {number} createdMs when it was built, or 0 where its engine does not say
 * @property {string[]} tags each `repository:tag`, its repository whole
 * @property {{name: string, repository: string, digest: string}[]} digests each as the engine printed it, which a removal names it by, and read
 *
 * @typedef {import("./imageRecord.mjs").ImageRecord} ImageRecord
 *
 * @typedef {object} ImageSweepPolicy
 * @property {number} keptPerRepository how many of a runtime or session repository's untagged images stay
 * @property {number | "Ignored"} unusedMsMax how long a job's image the runner pulled may go unused, 0 keeping them; a reclaim ignores it
 *
 * @typedef {object} ImageRemoval
 * @property {StoredImage} image
 * @property {string[]} references what it is removed by, each a name of it this runner may remove
 * @property {string[]} forgotten the record's entries that name it
 * @property {number | undefined} usedMs when the record last saw it used
 */

/** How recently used an image must not be for either rule to remove it. */
export const imageUseMarginMs = 600_000;

/** The registry an engine reads a name without one as. */
const defaultDomain = "docker.io";

/**
 * A name's repository whole, as the engines' reference parsing completes it:
 * a first component naming no registry is docker's, and a repository of
 * docker's with no namespace is its library's.
 *
 * @param {string} repository
 */
function wholeRepository(repository) {
  const slash = repository.indexOf("/");
  const first = slash === -1 ? "" : repository.slice(0, slash);
  const registry =
    first.includes(".") || first.includes(":") || first === "localhost";
  const domain = registry ? first : defaultDomain;
  const path = registry ? repository.slice(slash + 1) : repository;
  const canonical = domain === "index.docker.io" ? defaultDomain : domain;
  return canonical === defaultDomain && !path.includes("/")
    ? `${canonical}/library/${path}`
    : `${canonical}/${path}`;
}

/**
 * @param {string} name
 * @returns {ImageName}
 */
export function imageName(name) {
  const at = name.indexOf("@");
  const named = at === -1 ? name : name.slice(0, at);
  const colon = named.lastIndexOf(":");
  const tagged = colon > named.lastIndexOf("/");
  return {
    repository: wholeRepository(tagged ? named.slice(0, colon) : named),
    ...(tagged ? { tag: named.slice(colon + 1) } : {}),
    ...(at === -1 ? {} : { digest: name.slice(at + 1) }),
  };
}

/**
 * An image's id without the algorithm docker prefixes it with and podman
 * does not.
 *
 * @param {string} id
 */
export function imageIdOf(id) {
  return id.replace(/^sha256:/u, "");
}

/**
 * @typedef {object} InspectedImage
 * @property {string} Id
 * @property {string[] | null} [RepoTags]
 * @property {string[] | null} [RepoDigests]
 * @property {string | null} [Created]
 */

/**
 * An inspected image as these rules read it.
 *
 * @param {InspectedImage} inspected
 * @returns {StoredImage}
 */
export function storedImage(inspected) {
  const created = Date.parse(inspected.Created ?? "");
  return {
    id: inspected.Id,
    createdMs: Number.isFinite(created) ? created : 0,
    tags: (inspected.RepoTags ?? []).flatMap((name) => {
      const read = imageName(name);
      return read.tag === undefined || read.digest !== undefined
        ? []
        : [`${read.repository}:${read.tag}`];
    }),
    digests: (inspected.RepoDigests ?? []).flatMap((name) => {
      const { repository, digest } = imageName(name);
      return digest === undefined ? [] : [{ name, repository, digest }];
    }),
  };
}

/**
 * Whether a reference names this image: by digest where it has one, else by
 * its tag.
 *
 * @param {string} reference
 * @param {StoredImage} image
 */
export function imageNamedBy(reference, image) {
  const { repository, tag, digest } = imageName(reference);
  if (digest !== undefined)
    return image.digests.some(
      (named) => named.repository === repository && named.digest === digest,
    );
  return image.tags.includes(`${repository}:${tag ?? "latest"}`);
}

/**
 * The tags of an image that are not the name a job's image the runner pulled
 * was pulled by.
 *
 * @param {StoredImage} image
 * @param {readonly string[]} pulledBy
 */
function othersTags(image, pulledBy) {
  const own = new Set(
    pulledBy.flatMap((reference) => {
      const { repository, tag, digest } = imageName(reference);
      return digest === undefined ? [`${repository}:${tag ?? "latest"}`] : [];
    }),
  );
  return image.tags.filter((tag) => !own.has(tag));
}

/**
 * What the record says of an image: the entries naming it, when it was last
 * used, the job references it was pulled by, and whether a hold names it.
 *
 * @param {StoredImage} image
 * @param {ImageRecord} record
 * @param {number} nowMs
 */
function imageRecorded(image, record, nowMs) {
  const id = imageIdOf(image.id);
  const entries = Object.entries(record.images).filter(([reference]) =>
    imageNamedBy(reference, image),
  );
  const used = entries.map(([, entry]) => entry.usedMs);
  const pulled = entries.filter(
    ([, entry]) =>
      entry.kinds.includes("Job") &&
      entry.pulledId !== undefined &&
      imageIdOf(entry.pulledId) === id,
  );
  return {
    entries: entries.map(([reference]) => reference),
    usedMs: used.length === 0 ? undefined : Math.max(...used),
    pulledBy: pulled.map(([reference]) => reference),
    pulledUsedMs: Math.max(0, ...pulled.map(([, entry]) => entry.usedMs)),
    held: Object.values(record.holds).some(
      (hold) =>
        hold.untilMs > nowMs &&
        hold.images.some((reference) => imageNamedBy(reference, image)),
    ),
  };
}

/**
 * @typedef {ReturnType<typeof imageRecorded> & {image: StoredImage}} RecordedImage
 */

/**
 * The repositories chuggy's runtime or sessions came from that an image is
 * an untagged one of, and the names it has there.
 *
 * @param {RecordedImage} recorded
 * @param {ImageRecord} record
 */
function siteNames(recorded, record) {
  if (othersTags(recorded.image, recorded.pulledBy).length > 0) return [];
  return recorded.image.digests.filter((named) =>
    Object.hasOwn(record.repositories, named.repository),
  );
}

/**
 * The images each runtime or session repository keeps: its most recently
 * used untagged ones, an image the record never saw used counted as used
 * when the record began, and the newer image first between two used alike.
 *
 * @param {readonly RecordedImage[]} recorded
 * @param {ImageRecord} record
 * @param {number} kept
 */
function siteKept(recorded, record, kept) {
  /** @type {Map<string, RecordedImage[]>} */
  const byRepository = new Map();
  for (const image of recorded)
    for (const { repository } of siteNames(image, record))
      byRepository.set(repository, [
        ...(byRepository.get(repository) ?? []),
        image,
      ]);
  /** @param {RecordedImage} image */
  const usedMs = (image) => image.usedMs ?? record.createdMs;
  return new Set(
    [...byRepository.values()].flatMap((images) =>
      images
        .toSorted(
          (a, b) =>
            usedMs(b) - usedMs(a) || b.image.createdMs - a.image.createdMs,
        )
        .slice(0, kept)
        .map(({ image }) => image.id),
    ),
  );
}

/**
 * Whether the job rule lets a job's image the runner pulled go.
 *
 * @param {RecordedImage} recorded
 * @param {ImageSweepPolicy} policy
 * @param {number} nowMs
 */
function jobImageUnused(recorded, policy, nowMs) {
  if (policy.unusedMsMax === "Ignored") return true;
  return (
    policy.unusedMsMax > 0 &&
    nowMs - recorded.pulledUsedMs >= policy.unusedMsMax
  );
}

/**
 * What an image is removed by, or nothing where it stays.
 *
 * @param {RecordedImage} recorded
 * @param {ImageRecord} record
 * @param {ReadonlySet<string>} kept
 * @param {ImageSweepPolicy} policy
 * @param {number} nowMs
 * @returns {ImageRemoval | undefined}
 */
function imageRemoval(recorded, record, kept, policy, nowMs) {
  const { image, pulledBy, usedMs } = recorded;
  if (othersTags(image, pulledBy).length > 0 || recorded.held) return undefined;
  if (usedMs !== undefined && nowMs - usedMs < imageUseMarginMs)
    return undefined;
  const site = siteNames(recorded, record);
  if (site.length === 0 && pulledBy.length === 0) return undefined;
  if (site.length > 0 && kept.has(image.id)) return undefined;
  if (pulledBy.length > 0 && !jobImageUnused(recorded, policy, nowMs))
    return undefined;
  return {
    image,
    references: [...new Set([...site.map(({ name }) => name), ...pulledBy])],
    forgotten: recorded.entries,
    usedMs,
  };
}

/**
 * Every image these rules remove, oldest use first: an image the record never
 * saw used counted as used when the record began, and the older image first
 * between two used alike.
 *
 * @param {readonly StoredImage[]} images
 * @param {ImageRecord} record
 * @param {number} nowMs
 * @param {ImageSweepPolicy} policy
 * @returns {ImageRemoval[]}
 */
export function imageSweepRemovals(images, record, nowMs, policy) {
  const recorded = images.map((image) => ({
    image,
    ...imageRecorded(image, record, nowMs),
  }));
  const kept = siteKept(recorded, record, policy.keptPerRepository);
  return recorded
    .flatMap((image) => imageRemoval(image, record, kept, policy, nowMs) ?? [])
    .toSorted(
      (a, b) =>
        (a.usedMs ?? record.createdMs) - (b.usedMs ?? record.createdMs) ||
        a.image.createdMs - b.image.createdMs,
    );
}

/**
 * The record's entries naming no image here, or a job's image the runner
 * pulled under a name that now names another: each forgotten unless used
 * since `listedMs`, when the images were listed, since a pull after that is
 * not among them.
 *
 * @param {readonly StoredImage[]} images
 * @param {ImageRecord} record
 * @param {number} listedMs
 * @returns {string[]}
 */
export function imageEntriesStale(images, record, listedMs) {
  return Object.entries(record.images).flatMap(([reference, entry]) => {
    if (entry.usedMs >= listedMs) return [];
    const named = images.filter((image) => imageNamedBy(reference, image));
    if (named.length === 0) return [reference];
    const pulled = entry.pulledId;
    return pulled !== undefined &&
      !named.some((image) => imageIdOf(image.id) === imageIdOf(pulled))
      ? [reference]
      : [];
  });
}
