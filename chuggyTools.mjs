/**
 * The one `chuggy` MCP server a session pod serves in-process, and the capability
 * roster that decides which of its tools a session is given at all.
 *
 * TWO CHANNELS, TOLD APART BY WHAT THEY WRITE. A project tool is a command a
 * console user has: it goes over HTTP to the API under the pod's own session
 * bearer, the API resolves that bearer to the session's principal and authorizes
 * it through the project membership exactly as it authorizes a human's, and the
 * operation row records which session issued it. The API also confines that
 * bearer to its own session's tenant and project, whatever else the membership
 * reaches, so every project tool's route is one of that project's. A decision
 * tool (`./leadDecision.mjs`) writes nothing at all.
 *
 * A ROSTER IS NOT A CONTROL. `allowedTools` and `disallowedTools` are enforced
 * by the agent runtime inside the pod, and the pod is the thing being
 * controlled. The controls that are not the pod's are the membership, enforced
 * by the database when it authorizes a project access, the API's confinement
 * of the bearer to its own project, and the decision controls the selector
 * applies to a finished turn — and the last is post-hoc: the tool has already
 * run and its command has already landed, and what the selector refuses is the
 * decision that used it. A control described as stronger than it is, is worse
 * than none.
 *
 * A READ ANSWERS ONE PAGE, WHOLE OR NOT AT ALL. Nothing here walks a
 * collection: the caller's page bound and cursor go through, the route's own
 * body comes back verbatim as JSON text, and the cursor is in the answer for
 * the model to ask again with. A tool that walked would spend the turn's whole
 * token budget on a project's history. A page too large to answer is never
 * cut: a cut JSON document is a page nothing can parse and nothing can resume
 * from.
 *
 * A PAGE TOO LARGE IS ASKED FOR AGAIN, SMALLER. A `limit` is a ceiling, and
 * the route's page carries the cursor that continues it, so a smaller page
 * from the same place answers the question that was asked, where a refusal
 * leaves the model to guess a limit with a second call. The handler halves the
 * limit until a page fits or the page is one item, which is what bounds the
 * requests one call makes. It is not a walk: the place never moves and one
 * page is what is answered. The refusal is left for where nothing smaller can
 * be asked for, which is a tool with no limit and an item too large alone.
 *
 * THE TRANSCRIPT READS ARE THE ONE EXCEPTION, and `./transcriptPage.mjs` states
 * why: their route pages by store batch, a batch is bounded by the store's own
 * line bound, and one line is what a whole answer must fit inside. So no page
 * bound a caller could lower makes one of those pages answerable, and a refusal
 * there is a walk that cannot continue. They answer whole entries under the
 * bound and a cursor instead.
 *
 * AN ANSWER IS BOUNDED BY WHAT THE TRANSCRIPT HOLDS, and that is a much tighter
 * bound than the body drawn off the wire. Every answer becomes one `tool_result`
 * entry, `./sessionStore.mjs` mirrors an entry as one line it never splits, and
 * a line over `sessionStoreBatchBytesMax` is a body the plane refuses. The store
 * clips such a line rather than post it, and that is the bound of last resort:
 * the bound here stays because an answer the model can ask again for in pages is
 * a better answer than one the store cut to fit.
 *
 * THE ENTRY CARRIES THE ANSWER TWICE. The line is the on-disk transcript
 * format, and it holds the text in the message's `tool_result` block and again
 * in the entry's own `toolUseResult`. So the bound is what is left of the line
 * after the fixed envelope, divided by the copies — and an answer is weighed as
 * the entry escapes it rather than as it reads, because escaping is what the
 * line is charged for. The entry's shape is the runtime's and this image never
 * composes one, so the suite holds the bound against a captured entry.
 *
 * A WRITE RELAYS THE API'S OUTCOME UNALTERED — the status and the error body, as
 * text. No retry, no repair, no hiding a 409. A tool that decided what a refusal
 * meant would be deciding something the API decided.
 *
 * DERIVED WORK ONLY IS WHAT `DraftAuthor` ADMITS. `file_dependent` files
 * against a parent that already exists and carries it in the draft's
 * dependencies; a roster holding `DraftAuthor` alone cannot originate work.
 * Origination is `create_draft` under `DraftOriginate` alone. Which capability
 * a session is opened with is the provisioning root's, not this image's, so
 * what is true here is the mapping: a roster without `DraftOriginate` cannot
 * reach the tool, and the derived-work rule is that mapping rather than a
 * sentence in a description. `revoke_ticket` is under that capability too,
 * which is what keeps it from a roster that does not hold it.
 * `Prerequisite` is admitted by the schema only so its refusal can name the
 * reason — a released ticket's dependencies are immutable in chuggy's
 * `model/domain.qnt`, which names re-authoring machinery as deliberately absent.
 *
 * `zod` IS A PEER DEPENDENCY OF THE AGENT SDK, NOT ONE OF ITS DEPENDENCIES, so
 * the shapes are functions of a `z` the caller resolves rather than of an import
 * here, and the image's build probes are what prove the peer is installed and is
 * the one the contract parses with.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { URLSearchParams } from "node:url";

import { sessionStoreBatchBytesMax } from "@chuggy/worker-contract/sessionPlane";
import {
  agenticRefusalsAnsweredMax,
  allChuggyTools,
  allDependentRelations,
  builtInToolCapabilities,
  chuggyToolCapabilities,
  chuggyToolNames,
  chuggyToolPrefix,
  chuggyToolResponseBytesMax,
  chuggyToolRoutes,
  chuggyToolServerName,
  chuggyToolTimeoutMs,
  dependentRelationsAdmitted,
  nativeHttpMediaType,
  nativeHttpPageItemsMax,
  selectorHistoryLimitMax,
  threadTurnsAnsweredMax,
} from "@chuggy/worker-contract/sessionTools";

import { chuggyBoundedBody, chuggyRequest } from "./chuggyApi.mjs";
import { leadDecisionStaging } from "./leadDecision.mjs";
import { transcriptPageAnswer } from "./transcriptPage.mjs";
import { routeFilled } from "./wire.mjs";

/**
 * What a session is told a brief carries, `brief` being an open object on the
 * wire. An intent is bounded as a whole and by nothing a line at a time, so a
 * session is told what bounds one and nothing about where its lines break.
 */
const chuggySelectionDescription = `\`selection\` is for a configuration that is a catalog, one whose read_configuration \`canonical\` has \`version\` 2: {work?, evaluation?, finalization?}, each the name of one of its \`workloads\`, \`plans\` or \`finalizers\` the ticket runs on in place of the catalog's \`defaults\`, and a field left out is that default. A draft on any other configuration carries none.`;

const chuggyBriefDescription = `\`brief\` is {title?, intent, links, checks?, repository?, branch?, finalization?}: \`title\` is optional in the contract, so always give one — one short line naming the work, which the console lists tickets by; \`intent\` is what the ticket is for, in your own words — one text bounded only as a whole, with no bound on a line of it or on how many lines it has; \`repository\` is the repository the work happens in, which list_configurations reports as an imported configuration's provenance, and a draft carrying none is refused when it is released; \`checks\` are command lines added to the first Check stage the configuration runs as commands, which initialize_draft answers as \`commandedCheckStage\`, counted from zero, so they run only in a program that reaches that stage, and where it answers none a draft carrying checks is refused when it is released (BriefChecksUncommanded), and each runs under sh -eu with the commit the change started from in CHUG_CHANGE_BASE, unset where that is unknown, so a check that runs only what changed reads it as \${CHUG_CHANGE_BASE-} and runs everything where that is empty; \`branch\` is the refs/heads/ branch the work happens on, which the repository need not hold yet; \`finalization\` is how the work lands, and a brief naming none takes its repository's landing, which for a newly bound repository is a pull request; a landing by PullRequest or PullRequestMerge opens its pull request from \`branch\` into the finalization's \`target\`, or into the repository's default branch where none is named, so whenever the landing is a pull request \`branch\` is a branch of its own, never the \`target\`, and where no target is named never the default branch; a \`branch\` that is the default branch with no target named is accepted when filed and then held by the finalizer (ProposalBaseIsHead). A 400 names the rule the brief broke.`;

/** What the same call made again within one turn answers, which is that operation as it now stands. */
export const chuggySubmissionRepeatDescription = `The same call again in the same turn is the same operation, answered as it now stands: a \`state\` other than Pending is the outcome it already settled on, not a new attempt.`;

/** What a submitted command answers: the operation, and what the same call made again answers. */
const chuggySubmissionDescription = `Answers the operation's id and its \`state\`; read_operation answers what it did, a refusal's \`code\` included. ${chuggySubmissionRepeatDescription}`;

/** What a refusal ledger holds, which is what an empty one is read against. */
const chuggyRefusalLedgerDescription = `A refusal ledger holds the lead's refusals to dispatch a released ticket and their lifts, and nothing else, so it is empty until the lead refuses one. A refused command is never in it: read_operation answers a refused release or revocation, and a refused draft write is answered by that write itself.`;

/**
 * How many times the entry the runtime mirrors carries one answer's text. The
 * entry is the on-disk transcript line, and it holds the answer twice: in the
 * `tool_result` block of the message, and again in the entry's own
 * `toolUseResult`. `toolAnswerEntry.fixture.json` is a captured one, and the
 * suite reads the count off it rather than off this line.
 */
export const chuggyToolAnswerCopiesInEntry = 2;

/**
 * What the runtime writes in that entry beside the copies: the call's id, the
 * entry's own uuids, its timestamp, and the session, version, branch and
 * working directory it names. The image never composes that entry, so the
 * reserve is wider than the captured one by more than the whole of it.
 */
export const chuggyToolAnswerEnvelopeBytesMax = 4_096;

/** What one tool answer may weigh, so the entry it becomes is one line of one batch. */
export const chuggyToolAnswerBytesMax = Math.floor(
  (sessionStoreBatchBytesMax - chuggyToolAnswerEnvelopeBytesMax - 1) /
    chuggyToolAnswerCopiesInEntry,
);

/** The argument a paged tool's shape declares, and the only page bound a model can lower. */
export const chuggyToolPageArgument = "limit";

/** The smallest page there is, past which nothing smaller is left to ask for. */
export const chuggyToolPageItemsMin = 1;

/** The cursors a tool's shape declares, in the order a refusal offers them. */
export const chuggyToolCursorArguments = ["after", "before", "cursor"];

/** How many store batches one transcript read asks for, which is what its answers are cut from. */
export const chuggyTranscriptBatchesRead = 1;

/**
 * What one transcript page may weigh off the wire: that batch re-emitted as
 * entries, and room around it. It is wider than any other read draws because
 * the pod holds this one only long enough to cut it into answers.
 */
export const chuggyTranscriptBodyBytesMax = 4 * sessionStoreBatchBytesMax;

/** What one answer's text weighs as the entry escapes it, which is what the line is charged. */
export function chuggyToolAnswerBytes(text) {
  return Buffer.byteLength(JSON.stringify(text));
}

/**
 * The agent runtime's built-in tools as the pinned CLI names them. A tool a
 * later runtime adds is not in `disallowedTools` until this roster carries it,
 * which is the one thing this file cannot check for itself.
 */
export const sessionBuiltInTools = [
  "Bash",
  "BashOutput",
  "Edit",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillShell",
  "NotebookEdit",
  "Read",
  "SlashCommand",
  "Task",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Write",
];

/**
 * Which capability admits which tool, the runtime's own and the chuggy server's
 * alike. A capability this image does not know admits nothing.
 */
export const sessionCapabilityTools = Object.fromEntries(
  Object.entries(chuggyToolCapabilities).map(([capability, tools]) => [
    capability,
    [...builtInToolCapabilities[capability], ...tools],
  ]),
);

/** The capabilities of a roster this image knows, so one a newer plane names is ignored rather than raised on. */
function knownCapabilities(capabilities) {
  return (capabilities ?? []).filter((held) =>
    Object.hasOwn(sessionCapabilityTools, held),
  );
}

/**
 * What the session may reach for and what it may not, over the whole roster of
 * built-ins and chuggy tools alike, so absence is enforced rather than merely
 * not granted. AN MCP NAME IN NEITHER LIST IS GOVERNED BY `permissionMode`
 * ALONE, which under `bypassPermissions` is no roster at all: naming both lists
 * over both halves is what makes the roster mean anything inside the pod.
 */
export function sessionAllowedTools(capabilities) {
  const admitted = new Set(
    (capabilities ?? []).flatMap((held) => sessionCapabilityTools[held] ?? []),
  );
  const every = [
    ...sessionBuiltInTools,
    ...allChuggyTools.map((tool) => `${chuggyToolPrefix}${tool}`),
  ];
  const held = new Set([
    ...sessionBuiltInTools.filter((tool) => admitted.has(tool)),
    ...chuggyToolNames(knownCapabilities(capabilities)),
  ]);
  return {
    allowedTools: every.filter((tool) => held.has(tool)),
    disallowedTools: every.filter((tool) => !held.has(tool)),
  };
}

/** One of the tools' routes for this session's own project, `values` filling the rest of its pattern. */
function projectPath(context, route, values = {}) {
  return routeFilled(chuggyToolRoutes[route], {
    tenant: context.task.tenant,
    project: context.task.project,
    ...values,
  });
}

/** A query string built from the fields a caller actually gave, or nothing. */
function search(fields) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value])
      query.append(name, String(one));
  }
  const text = query.toString();
  return text.length === 0 ? "" : `?${text}`;
}

function answered(text, isError) {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

/** What an answer too large to store is refused with, ending in why nothing smaller came. */
function answerTooLarge(remedy) {
  return answered(
    `this answer is larger than the ${String(chuggyToolAnswerBytesMax)} bytes one tool answer holds in the transcript; ${remedy}.`,
    true,
  );
}

/**
 * How the refusal ends once nothing smaller is left to ask for: the tool has no
 * page bound, or its page of a single item is still too large. It says what
 * the caller can do, which is move past that item where the tool takes a
 * cursor and nothing where it takes none.
 */
function smallestPageRemedy(name, fields) {
  if (!(chuggyToolPageArgument in fields))
    return `${name} takes no ${chuggyToolPageArgument}, so this one cannot be answered`;
  const cursor = chuggyToolCursorArguments.find((one) => one in fields);
  return cursor === undefined
    ? `${name} is already asking for one, so this one cannot be answered`
    : `${name} is already asking for one; move past it with ${cursor}`;
}

/**
 * One route's answer as the model reads it: its status, and its body verbatim.
 * A body larger than this draws is cut here and weighed by the handler, which
 * asks for less or refuses: the cut text is never answered, because a cut JSON
 * document is a page nothing can parse and nothing can resume from.
 */
async function relay(context, path, init) {
  const response = await context.request(
    context.task,
    context.bearer,
    path,
    init,
  );
  const { text } = await chuggyBoundedBody(
    response,
    chuggyToolResponseBytesMax,
  );
  return answered(
    `HTTP ${String(response.status)}\n${text}`,
    response.status >= 400,
  );
}

function read(context, path) {
  return relay(context, path, { method: "GET" });
}

/**
 * One transcript page, cut to the whole entries this answer can carry. The
 * route's own body is parsed rather than relayed, which is what lets the answer
 * be smaller than the batch the route pages by.
 */
async function readTranscript(context, path, cursor) {
  const response = await context.request(context.task, context.bearer, path, {
    method: "GET",
  });
  const { text, cut } = await chuggyBoundedBody(
    response,
    chuggyTranscriptBodyBytesMax,
  );
  if (response.status >= 400)
    return answered(`HTTP ${String(response.status)}\n${text}`, true);
  if (cut)
    return answered(
      `this transcript page is larger than the ${String(chuggyTranscriptBodyBytesMax)} bytes one read draws off the wire, so it cannot be answered.`,
      true,
    );
  let page;
  try {
    page = JSON.parse(text);
  } catch {
    return answered(
      "the transcript route answered a body this read could not parse.",
      true,
    );
  }
  return answered(
    transcriptPageAnswer(
      page,
      cursor,
      (composed) => chuggyToolAnswerBytes(composed) <= chuggyToolAnswerBytesMax,
    ),
  );
}

function write(context, path, method, body, headers = {}) {
  return relay(context, path, {
    method,
    headers: { "content-type": nativeHttpMediaType, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * The identity a submitted command carries, minted from the turn and the command
 * itself, so a tool call the model repeats within one turn is the same operation
 * replayed rather than a second one accepted.
 */
export function chuggyOperationIdentity(turn, mutation) {
  return `session-${createHash("sha256")
    .update(`${turn}\u0000${JSON.stringify(mutation)}`)
    .digest("hex")}`;
}

function claimedTurn(context) {
  const turn = context.turn();
  if (typeof turn !== "string" || turn.length === 0)
    throw new Error("no turn is claimed, so no command may be submitted");
  return turn;
}

/** One command submitted as an operation, keyed by the identity its turn and itself mint. */
function submit(context, mutation) {
  const operation = chuggyOperationIdentity(claimedTurn(context), mutation);
  return write(
    context,
    projectPath(context, "operations"),
    "POST",
    { operation, mutation },
    { "idempotency-key": operation },
  );
}

const ticket = (z) => z.number().int().min(1);
const limit = (z, max) => z.number().int().min(1).max(max).optional();
const count = (z) => z.number().int().min(0);
const identity = (z) => z.string().min(1).max(256);
/** A position in a mailbox, which is counted from one and never from zero. */
const ordinal = (z) => z.number().int().min(1);
/**
 * A JSON object this tool passes through and the API's own schema is the
 * authority on. IT IS `looseObject` AND NOT `record`: the runtime converts a
 * shape to JSON schema when it lists its tools, its converter throws on a zod
 * record, and a server whose listing throws reports itself connected and offers
 * the model no tools at all. `./toolProbe.mjs` is what holds that shut at
 * build time.
 */
const anyObject = (z) => z.looseObject({});

/**
 * Every project tool: its name, the shape its input is checked against at the
 * boundary, and the one route it reaches. It is a value rather than a function
 * because it is a roster, and a roster read twice must read the same both
 * times; it is exported so a suite can drive every tool's route, whatever
 * roster a session holds.
 */
export const chuggyProjectTools = [
  {
    name: "list_tickets",
    description:
      "One page of this project's tickets, ascending by number. Answers `nextAfter` for the next page; `after` resumes from it.",
    shape: (z) => ({
      after: ticket(z).optional(),
      limit: limit(z, nativeHttpPageItemsMax),
      phase: z.array(z.string().min(1)).max(16).optional(),
    }),
    call: (context, { after, limit: pageLimit, phase }) =>
      read(
        context,
        `${projectPath(context, "project")}${search({ after, limit: pageLimit, phase })}`,
      ),
  },
  {
    name: "read_ticket",
    description:
      "One ticket: its phase, its version, its authoring and its brief.",
    shape: (z) => ({ ticket: ticket(z) }),
    call: (context, args) =>
      read(context, projectPath(context, "ticket", { ticket: args.ticket })),
  },
  {
    name: "read_draft",
    description:
      "One draft still open on this project, by the ticket number it holds.",
    shape: (z) => ({ ticket: ticket(z) }),
    call: (context, args) =>
      read(context, projectPath(context, "draft", { ticket: args.ticket })),
  },
  {
    name: "list_drafts",
    description:
      "One page of the drafts this project still holds open, ascending by ticket.",
    shape: (z) => ({
      limit: limit(z, nativeHttpPageItemsMax),
      cursor: identity(z).optional(),
    }),
    call: (context, { cursor, limit: pageLimit }) =>
      read(
        context,
        `${projectPath(context, "drafts")}${search({ cursor, limit: pageLimit })}`,
      ),
  },
  {
    name: "list_configurations",
    description:
      "One page of this project's configuration revisions, newest first, with the cursor for the next. One imported from a repository carries its configuration's name in `provenance.name`; who does the work under it is read_configuration's to answer.",
    shape: (z) => ({
      cursor: identity(z).optional(),
      limit: limit(z, nativeHttpPageItemsMax),
    }),
    call: (context, { cursor, limit: pageLimit }) =>
      read(
        context,
        `${projectPath(context, "configurations")}${search({ cursor, limit: pageLimit })}`,
      ),
  },
  {
    name: "read_configuration",
    description:
      "One configuration revision, canonical, as a draft is authored against it. `canonical` is the stored document as JSON text, and its `worker.mode` is who does the work of a ticket released against it: the agent, and what that agent is started with, a model where the configuration names one.",
    shape: (z) => ({ revision: identity(z) }),
    call: (context, { revision }) =>
      read(context, projectPath(context, "configuration", { revision })),
  },
  {
    name: "read_decision_log",
    description:
      "One page of this project's past selector decisions, oldest first: what each chose and under which settings. Answers `nextAfter` for the next page; `after` resumes from it.",
    shape: (z) => ({
      after: count(z).optional(),
      limit: limit(z, selectorHistoryLimitMax),
    }),
    call: (context, { after, limit: pageLimit }) =>
      read(
        context,
        `${projectPath(context, "selectorHistory")}${search({ after, limit: pageLimit })}`,
      ),
  },
  {
    name: "read_refusals",
    description: `The refusals standing across this project, each a ticket whose latest ledger entry is a refusal, with the ticket version each names. ${chuggyRefusalLedgerDescription}`,
    shape: (z) => ({ limit: limit(z, agenticRefusalsAnsweredMax) }),
    call: (context, { limit: pageLimit }) =>
      read(
        context,
        `${projectPath(context, "agenticRefusals")}${search({ limit: pageLimit })}`,
      ),
  },
  {
    name: "read_ticket_refusals",
    description: `One ticket's refusal ledger, oldest first: the refusals recorded on it and their lifts. \`more\` says the ledger holds further entries than one answer carries. ${chuggyRefusalLedgerDescription}`,
    shape: (z) => ({ ticket: ticket(z) }),
    call: (context, args) =>
      read(
        context,
        projectPath(context, "ticketAgenticRefusals", { ticket: args.ticket }),
      ),
  },
  {
    name: "read_lead",
    description:
      "This project's lead session: its state, its mailbox tail and its transcript streams. A project with no lead answers None, and `absence.reason` says why. `Paused`: the project's selector is paused, for the project or the whole installation, so no ticket is picked up automatically; it must be resumed by someone who may, and this reason is answered ahead of the others. `NotNeeded`: no refusal stands, which is expected before anything is released, because the selector opens a lead only when a released ticket waits on a dispatch decision; release a ticket. Otherwise the last decision that needed a lead was refused it, and `absence.since` is when that refusal began. `RunnerOffline`: the project runs its lead on its runners and none is live, so the project's runner must be running. `HostedRunsNotGranted`: the project runs its lead hosted and its tenant has not granted the lead hosted runs, so an admin must grant them.",
    shape: () => ({}),
    call: (context) => read(context, projectPath(context, "lead")),
  },
  {
    name: "read_lead_transcript",
    description:
      "One page of the lead's own raw transcript, which is how it reads past its own compaction. A page read answers JSON: `entries` whole where they fit, an entry too large as {uuid, type, bytes, preview}, and `next` — pass its `after` and `entry` back for the page after this one. A read that fails answers the reason instead.",
    shape: (z) => ({
      stream: identity(z).optional(),
      after: count(z).optional(),
      entry: count(z).optional(),
    }),
    call: (context, { stream, after, entry }) =>
      readTranscript(
        context,
        `${projectPath(context, "leadTranscript")}${search({ stream, after, limit: chuggyTranscriptBatchesRead })}`,
        { after: after ?? 0, entry: entry ?? 0 },
      ),
  },
  {
    name: "list_executions",
    description:
      "One page of this project's executions, narrowed by ticket or by state.",
    shape: (z) => ({
      ticket: ticket(z).optional(),
      state: z.array(z.string().min(1)).max(16).optional(),
      cursor: identity(z).optional(),
      limit: limit(z, nativeHttpPageItemsMax),
    }),
    call: (context, { ticket: onTicket, state, cursor, limit: pageLimit }) =>
      read(
        context,
        `${projectPath(context, "executions")}${search({ ticket: onTicket, state, cursor, limit: pageLimit })}`,
      ),
  },
  {
    name: "read_execution",
    description:
      "One execution: its ticket, its attempts, its state and its outcome.",
    shape: (z) => ({ execution: identity(z) }),
    call: (context, { execution }) =>
      read(context, projectPath(context, "execution", { execution })),
  },
  {
    name: "read_run_transcript",
    description:
      "One page of one attempt's run transcript, from the batch after the one named.",
    shape: (z) => ({
      execution: identity(z),
      attempt: identity(z),
      after: count(z).optional(),
    }),
    call: (context, { execution, attempt, after }) =>
      read(
        context,
        `${projectPath(context, "runTranscript", { execution, attempt })}${search({ after })}`,
      ),
  },
  {
    name: "read_operation",
    description:
      "One submitted operation's outcome. This is the only way to learn what a command did.",
    shape: (z) => ({ operation: identity(z) }),
    call: (context, { operation }) =>
      read(context, projectPath(context, "operation", { operation })),
  },
  {
    name: "list_threads",
    description:
      "The member threads open on this project: whose each is, its state, and whether it is this session's own.",
    shape: () => ({}),
    call: (context) => read(context, projectPath(context, "threads")),
  },
  {
    name: "read_thread",
    description:
      "One page of a member thread, newest turn last: whose it is, its state, and that much of its conversation. Answers `nextBefore` for the page before this one; `before` resumes from it.",
    shape: (z) => ({
      session: identity(z),
      before: ordinal(z).optional(),
      limit: limit(z, threadTurnsAnsweredMax),
    }),
    call: (context, { session, before, limit: pageLimit }) =>
      read(
        context,
        `${projectPath(context, "thread", { session })}${search({ before, limit: pageLimit })}`,
      ),
  },
  {
    name: "read_thread_transcript",
    description:
      "One page of a thread's own raw transcript, which is how it reads past its own compaction. A page read answers JSON: `entries` whole where they fit, an entry too large as {uuid, type, bytes, preview}, and `next` — pass its `after` and `entry` back for the page after this one. A read that fails answers the reason instead.",
    shape: (z) => ({
      session: identity(z),
      stream: identity(z).optional(),
      after: count(z).optional(),
      entry: count(z).optional(),
    }),
    call: (context, { session, stream, after, entry }) =>
      readTranscript(
        context,
        `${projectPath(context, "threadTranscript", { session })}${search({ stream, after, limit: chuggyTranscriptBatchesRead })}`,
        { after: after ?? 0, entry: entry ?? 0 },
      ),
  },
  {
    name: "initialize_draft",
    description:
      "The defaults, the dependency candidates and the fence a new draft is filed against, for one configuration revision. A draft's `authoring.program` is its evaluation: stage N runs under the configuration's Nth `evaluations` entry, or its `review` where it lists none, the stages run in that order, and a failed stage ends evaluation. `defaults.program` is the program to start from, and `choices.programStagesMax` is the most stages a program may have against this configuration. For a catalog, pass the `work`, `evaluation` and `finalization` the draft will select: stage N then runs the selected plan's Nth stage, and `defaults` and `choices` are those of that selection.",
    shape: (z) => ({
      revision: identity(z),
      work: identity(z).optional(),
      evaluation: identity(z).optional(),
      finalization: identity(z).optional(),
    }),
    call: (context, { revision, work, evaluation, finalization }) =>
      read(
        context,
        `${projectPath(context, "draftInitialization", { revision })}${search({ work, evaluation, finalization })}`,
      ),
  },
  {
    name: "file_dependent",
    description: `Files a new draft derived from an existing ticket. \`relation\` admits FollowUp only, and \`authoring.dependencies\` must carry the parent. The fence comes from initialize_draft. ${chuggyBriefDescription}`,
    shape: (z) => ({
      parent: ticket(z),
      relation: z.enum(allDependentRelations),
      configurationRevision: identity(z),
      configurationDigest: identity(z),
      expectedProjectSequence: count(z),
      authoring: anyObject(z),
      brief: anyObject(z),
      selection: anyObject(z).optional().describe(chuggySelectionDescription),
    }),
    call: (context, args) => {
      if (!dependentRelationsAdmitted.includes(args.relation))
        return answered(
          `${args.relation} is not derivable: a released ticket's dependencies are immutable in this machine, so ticket ${String(args.parent)} cannot come to depend on a new one. File a FollowUp instead; a prerequisite of a ticket still in draft is a revise_draft of that draft's dependencies.`,
          true,
        );
      const dependencies = args.authoring?.dependencies;
      if (!Array.isArray(dependencies) || !dependencies.includes(args.parent))
        return answered(
          `a dependent must carry its parent: authoring.dependencies does not name ticket ${String(args.parent)}.`,
          true,
        );
      return write(context, projectPath(context, "drafts"), "POST", {
        configurationRevision: args.configurationRevision,
        configurationDigest: args.configurationDigest,
        expectedProjectSequence: args.expectedProjectSequence,
        authoring: args.authoring,
        brief: args.brief,
        selection: args.selection,
      });
    },
  },
  {
    name: "revise_draft",
    description: `Replaces one open draft's authoring, brief and selection, fenced on the version read. ${chuggyBriefDescription} The brief is replaced whole, so send back the \`repository\` read_draft answered or the revision clears it.`,
    shape: (z) => ({
      ticket: ticket(z),
      expectedVersion: count(z),
      configurationRevision: identity(z),
      authoring: anyObject(z),
      brief: anyObject(z),
      selection: anyObject(z)
        .optional()
        .describe(
          `${chuggySelectionDescription} It is replaced whole, so send back the \`selection\` read_draft answered or the revision clears it.`,
        ),
    }),
    call: (context, args) =>
      write(
        context,
        projectPath(context, "draft", { ticket: args.ticket }),
        "PUT",
        {
          expectedVersion: args.expectedVersion,
          configurationRevision: args.configurationRevision,
          authoring: args.authoring,
          brief: args.brief,
          selection: args.selection,
        },
      ),
  },
  {
    name: "delete_draft",
    description: "Deletes one open draft, fenced on the version read.",
    shape: (z) => ({ ticket: ticket(z), expectedVersion: count(z) }),
    call: (context, args) =>
      write(
        context,
        `${projectPath(context, "draft", { ticket: args.ticket })}${search({ expectedVersion: args.expectedVersion })}`,
        "DELETE",
      ),
  },
  {
    name: "release_draft",
    description: `Submits the release of one draft. ${chuggySubmissionDescription} A release refused for its brief or its configuration is refused again at that authoring version, so revise_draft the draft and release the \`authoringVersion\` and \`configurationRevision\` the revision answers.`,
    shape: (z) => ({
      ticket: ticket(z),
      authoringVersion: count(z),
      configurationRevision: identity(z),
    }),
    call: (context, args) =>
      submit(context, {
        mutation: "ReleaseDraft",
        ticket: args.ticket,
        authoringVersion: args.authoringVersion,
        configurationRevision: args.configurationRevision,
      }),
  },
  {
    name: "create_draft",
    description: `Files a new draft for work your owner asked for, derived from nothing. The fence comes from initialize_draft. ${chuggyBriefDescription}`,
    shape: (z) => ({
      configurationRevision: identity(z),
      configurationDigest: identity(z),
      expectedProjectSequence: count(z),
      authoring: anyObject(z),
      brief: anyObject(z),
      selection: anyObject(z).optional().describe(chuggySelectionDescription),
    }),
    call: (context, args) =>
      write(context, projectPath(context, "drafts"), "POST", {
        configurationRevision: args.configurationRevision,
        configurationDigest: args.configurationDigest,
        expectedProjectSequence: args.expectedProjectSequence,
        authoring: args.authoring,
        brief: args.brief,
        selection: args.selection,
      }),
  },
  {
    name: "revoke_ticket",
    description: `Submits the revocation of one ticket, on your owner's word only. Revoking ends the ticket for good: it cancels the work running for it and undoes nothing that already landed. It revokes no other ticket. A ticket depending on a revoked one can never start, read_ticket names those dependencies in \`revokedDependencies\`, and its only exit is to be revoked too. ${chuggySubmissionDescription}`,
    shape: (z) => ({ ticket: ticket(z) }),
    call: (context, args) =>
      submit(context, { mutation: "RevokeTicket", ticket: args.ticket }),
  },
];

/**
 * Every tool this session holds, project and decision alike, filtered by the
 * capability roster its row carries. A tool the roster does not admit is not
 * registered at all, so the runtime's own tool list is the proof rather than
 * this source.
 */
export function chuggyToolDefinitions(context) {
  const admitted = new Set(
    (context.capabilities ?? []).flatMap(
      (held) => sessionCapabilityTools[held] ?? [],
    ),
  );
  const project = chuggyProjectTools.map((definition) => ({
    ...definition,
    call: (args) => definition.call(context, args),
  }));
  return [...project, ...context.staging.definitions].filter((definition) =>
    admitted.has(definition.name),
  );
}

/** Whether the entry an answer becomes fits one of the store's lines. */
function storable(answer) {
  const text = (answer.content ?? [])
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("");
  return chuggyToolAnswerBytes(text) <= chuggyToolAnswerBytesMax;
}

/** A raise as the text the model reads. */
function raised(failure) {
  return answered(
    failure instanceof Error ? failure.message : String(failure),
    true,
  );
}

/**
 * One tool's handler: its input checked against its own shape, then the call,
 * with every raise answered as text the model reads rather than thrown into the
 * runtime.
 *
 * THE CHECK IS HERE AND NOT ONLY IN THE RUNTIME. The shape is what the runtime
 * publishes and what it validates against, but a bound enforced only by the
 * thing being controlled is a bound this tree does not count; parsing here is
 * what makes the bound a property a suite can drive.
 *
 * A DECISION TOOL ANSWERS TEXT AND THE PROTOCOL ANSWERS AN OBJECT, so text is
 * wrapped here rather than at each call. A bare string reaches the model as an
 * invalid tool result naming a type mismatch — and it reaches it after the
 * call's side effect is staged, so the lead is told its dispatch errored by the
 * very call that staged it, and may dispatch again or report a failure that did
 * not happen.
 *
 * AND IT IS WHERE AN ANSWER IS WEIGHED, because it is the one boundary every
 * tool's answer crosses and the one place the tool that produced it is known.
 * Every answer goes through the weighing, a raise included: a raise the model
 * reads is an answer like any other, and the header would otherwise claim a
 * property the code does not hold. Refusing here is what keeps the answer the
 * model reads and the line the store writes the same thing.
 *
 * SO IT IS WHERE A PAGE TOO LARGE IS ASKED FOR AGAIN, at half the limit each
 * time, down to one item. A call that gave no limit starts from the largest
 * its shape admits, the route's own default being the route's to know.
 */
export function chuggyToolHandler(definition, z) {
  // The shape the model is given is also what says whether this tool pages,
  // what it is paged by and how large a page it admits: a roster stating that
  // beside it would be a second answer to a question the shape answers, and
  // the two would part.
  const fields = definition.shape(z);
  const shape = z.object(fields);
  const pageItemsMax = fields[chuggyToolPageArgument]?.unwrap().maxValue;
  const asked = async (given) => {
    try {
      const answer = await definition.call(given);
      return typeof answer === "string" ? answered(answer) : answer;
    } catch (failure) {
      return raised(failure);
    }
  };
  const { name } = definition;
  return async (args) => {
    let given;
    try {
      given = shape.parse(args ?? {});
    } catch (failure) {
      const refused = raised(failure);
      return storable(refused)
        ? refused
        : answerTooLarge(`${name} refused its arguments and asked for nothing`);
    }
    let answer = await asked(given);
    let page = given[chuggyToolPageArgument] ?? pageItemsMax;
    while (!storable(answer) && page > chuggyToolPageItemsMin) {
      page = Math.floor(page / 2);
      answer = await asked({ ...given, [chuggyToolPageArgument]: page });
    }
    return storable(answer)
      ? answer
      : answerTooLarge(smallestPageRemedy(name, fields));
  };
}

/**
 * The in-process server the query is opened with. `timeout` is not optional: a
 * tool call is otherwise effectively unbounded, and an unbounded one is a turn
 * that never reaches its deadline.
 */
export function chuggyToolServer(context, sdk) {
  return sdk.createSdkMcpServer({
    name: chuggyToolServerName,
    version: context.version,
    timeout: chuggyToolTimeoutMs,
    tools: chuggyToolDefinitions(context).map((definition) =>
      sdk.tool(
        definition.name,
        definition.description,
        definition.shape(sdk.z),
        chuggyToolHandler(definition, sdk.z),
      ),
    ),
  });
}

/** What one session's tools are held in: its task, its bearer, and this turn's staging. */
export function chuggyToolContext(task, bearer, services = {}) {
  return {
    task,
    bearer,
    capabilities: services.capabilities ?? [],
    version: services.version ?? "1",
    request: services.request ?? chuggyRequest,
    turn: services.turn ?? (() => undefined),
    staging: services.staging ?? leadDecisionStaging(),
  };
}
