/**
 * The two things `CHUG_WORKER_TASK` may carry, as the suites hold them against
 * each other: the document a pushed pod is launched with, the answer the task
 * route gives for the same attempt, and a pool's envelope naming the same
 * plane; and the answer that route gives a pool-held session's pod instead.
 * The documents and the answers are read under the contract's schemas; that a
 * launcher writes such a document, and the route answers it, is the server's
 * suites' to hold.
 */

import {
  poolEnvelopeSchema,
  sessionTaskAnswerSchema,
  workTaskAnswerSchema,
  workTaskDocumentSchema,
} from "@chuggy/worker-contract/workerTask";

/** A work task as a launcher writes it into a pushed pod, naming every field the document does. */
export const pushed = workTaskDocumentSchema.strict().parse({
  tenant: "tenant-1",
  project: "project-1",
  execution: "execution-1",
  attempt: "attempt-1",
  generation: 4,
  ticket: 7,
  task: 3,
  taskKind: "Work",
  stage: 2,
  sourceRequest: "7:0:ExecuteTask",
  inputBundle: "7:0:InputBundle",
  inputBundleDigest: "c".repeat(64),
  configurationRevision: "revision-1",
  configurationDigest: "configuration-digest",
  profile: { profile: "standard", runtimeVersion: "1" },
  requirementIdentity: "requirement-1",
  requirementDigest: "requirement-digest",
  briefing: {
    templateVersion: 6,
    purpose: "Work",
    text: "## Your role\nImplement one task on this ticket.",
  },
  authority: {
    tools: ["editor"],
    credentials: ["forge"],
    network: true,
    filesystem: "WriteWorkspace",
    mayCompleteTask: false,
  },
  worker: {
    mode: { type: "SingleAgent", agent: "Claude", arguments: [] },
    setup: [],
    files: [],
  },
  workerPlane: {
    url: "http://worker-plane.test:3001",
    capabilityFile: "/run/worker-plane.test/bearer",
    capability: "capability-1",
    manifest: "manifest-1",
  },
});

/** What the task route answers for the attempt `pushed` was written for. */
export const fetchedAnswer = workTaskAnswerSchema
  .strict()
  .parse(
    Object.fromEntries([
      ["kind", workTaskAnswerSchema.shape.kind.value],
      ...Object.entries(pushed).filter(([field]) => field !== "workerPlane"),
    ]),
  );

/** What a pool's envelope reads as, naming the plane `pushed` names. */
export const envelope = poolEnvelopeSchema.parse({
  callbackUrl: pushed.workerPlane.url,
  bearer: "0123456789abcdef".repeat(4),
  workspace: "/pool/workspace",
  timeoutSecsMax: 1_800,
  outputBytesMax: 4_096,
});

/** What the task route answers a pool-held lead's pod: its task, with the site's API, bounds and model beside it. */
export const poolHeldSessionAnswer = sessionTaskAnswerSchema.parse({
  tenant: "vteng",
  project: "chuggy",
  session: "session-1",
  kind: "Lead",
  attempt: "attempt-1",
  generation: 1,
  capabilities: [
    "RepositoryRead",
    "ProjectRead",
    "DraftAuthor",
    "LeadDecision",
  ],
  credentialSlot: "claude-code",
  authority: {
    tools: [],
    credentials: [],
    network: true,
    filesystem: "ReadWorkspace",
    mayCompleteTask: false,
  },
  api: { url: "http://chuggy-api.pool.test:3000" },
  bounds: {
    mailboxPollMs: 1,
    idleMs: 1,
    resultDrainMs: 50,
    loadTimeoutMs: 2_000,
    turnsMax: 30,
    budgetUsd: 3,
  },
  model: "pool-model",
});

/** What the task route answers a member's own thread on their chat host: their reserved partition, `MemberRead` alone, and no repository. */
export const memberSessionAnswer = sessionTaskAnswerSchema.parse({
  ...poolHeldSessionAnswer,
  project: `@member-${"a".repeat(64)}`,
  kind: "Thread",
  capabilities: ["MemberRead"],
});
