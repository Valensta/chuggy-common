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
 * THE TRANSCRIPT READS ARE ONE OF THE EXCEPTIONS, and `./transcriptPage.mjs`
 * states why: their routes page by batch, a batch is bounded by a line bound or
 * a body bound, and one line is what a whole answer must fit inside. So no page
 * bound a caller could lower makes one of those pages answerable, and a refusal
 * there is a walk that cannot continue. They answer whole entries under the
 * bound and a cursor instead.
 *
 * ANOTHER IS AN ATTEMPT'S ERROR TEXT, ANSWERED BY ITS END where it is larger
 * than one answer. Its route answers it whole, bounded by the largest upload
 * rather than by what one answer holds, and its end is what says why the
 * attempt stopped, so `read_run_error` answers the longest end that fits and
 * the size of the whole.
 *
 * ANOTHER IS A TICKET'S LANDINGS, ANSWERED AS THE NEWEST THAT FIT. Its route
 * answers as many landings as one read does, each bounded by its own fields
 * rather than by what one answer holds, and the newest is what says where the
 * ticket's work stands, so `read_ticket_landings` leaves out the oldest whole
 * landings until the rest fit, and says so in `truncated`. The contract bounds
 * what one landing weighs, and the suite holds the heaviest one inside an
 * answer.
 *
 * TWO ARE ANSWERED RESHAPED, every other field as the route answered it.
 * `list_repositories` adds to each row whether a ticket may be filed in it,
 * read from that row alone, and `initialize_draft` leaves out the
 * configuration's `canonical`, which `read_configuration` answers.
 *
 * THE LAST IS AN IMAGE, ANSWERED AS THE FILE IT WAS WRITTEN TO, never as its
 * bytes. Its route answers them as base64, bounded by the largest upload rather
 * than by what one answer holds, so `fetch_image` writes them to a file of its
 * own and answers where, and the agent's own Read opens it.
 *
 * ONE READ IS NOT THE API'S. `read_docs` reads chuggy's public docs, from a
 * host that is not chuggy's API, so it goes through `context.docsFetch` and
 * carries no bearer and no header of chuggy's.
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
 * WHAT A PROJECT TOOL SENDS IS SCRUBBED. Its arguments are the model's, and the
 * model has read whatever its shell could, so every string of them, a key's
 * included, has the session's secrets replaced before a path, a query or a
 * body is made of it, and a command's operation is minted from what is sent.
 *
 * DERIVED WORK ONLY IS WHAT `DraftAuthor` ADMITS. `file_dependent` files
 * against a parent that already exists and carries it in the draft's
 * dependencies; a roster holding `DraftAuthor` alone cannot originate work.
 * Origination is `create_draft` under `DraftOriginate` alone. Which capability
 * a session is opened with is the provisioning root's, not this image's, so
 * what is true here is the mapping: a roster without `DraftOriginate` cannot
 * reach the tool, and the derived-work rule is that mapping rather than a
 * sentence in a description. `revoke_ticket` and `update_ticket` are under
 * that capability too, which is what keeps them from a roster that does not
 * hold it, and `dispatch_ticket` is under `TicketDispatch` alone.
 * `Prerequisite` is admitted by the schema only so its refusal can name the
 * reason — it would point an existing ticket at the new draft, which is an
 * update of that ticket and not a draft `file_dependent` files.
 *
 * `zod` IS A PEER DEPENDENCY OF THE AGENT SDK, NOT ONE OF ITS DEPENDENCIES, so
 * the shapes are functions of a `z` the caller resolves rather than of an import
 * here, and the image's build probes are what prove the peer is installed and is
 * the one the contract parses with.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { URL, URLSearchParams } from "node:url";
import { TextDecoder } from "node:util";

import { sessionStoreBatchBytesMax } from "@chuggy/worker-contract/sessionPlane";
import {
  agenticRefusalsAnsweredMax,
  allChuggyTools,
  allDependentRelations,
  briefLineCharsMax,
  builtInToolCapabilities,
  chuggyDocsIndex,
  chuggyToolCapabilities,
  chuggyToolDocsResponseBytesMax,
  chuggyToolDispatchViewResponseBytesMax,
  chuggyToolImageResponseBytesMax,
  chuggyToolNames,
  chuggyToolPrefix,
  chuggyToolResponseBytesMax,
  chuggyToolRoutes,
  chuggyToolRunErrorResponseBytesMax,
  chuggyToolRunTranscriptResponseBytesMax,
  chuggyToolServerName,
  chuggyToolTicketLandingsResponseBytesMax,
  chuggyToolTimeoutMs,
  dependentRelationsAdmitted,
  imageMediaTypes,
  nativeHttpMediaType,
  nativeHttpPageItemsMax,
  projectArtifactEncoding,
  selectorHistoryLimitMax,
  threadTurnsAnsweredMax,
  ticketLandingsAnsweredMax,
} from "@chuggy/worker-contract/sessionTools";

import { boundedResponseBytes } from "./boundedResponse.mjs";
import { chuggyBoundedBody, chuggyRequest } from "./chuggyApi.mjs";
import { workerTemporaryFile } from "./checks.mjs";
import { leadDecisionStaging } from "./leadDecision.mjs";
import { ticketImageExtension } from "./ticketImages.mjs";
import { runTranscriptPage, transcriptPageAnswer } from "./transcriptPage.mjs";
import { routeFilled } from "./wire.mjs";

const chuggySelectionDescription = `\`selection\` is for a configuration that is a catalog, one whose read_configuration \`canonical\` has \`version\` 2: {work?, evaluation?, finalization?}, each the name of one of its \`workloads\`, \`plans\` or \`finalizers\` the ticket runs on in place of the catalog's \`defaults\`, and a field left out is that default. A draft on any other configuration carries none.`;

/**
 * What a session is told a brief carries, `brief` being an open object on the
 * wire. An intent is bounded as a whole and by nothing a line at a time, so a
 * session is told what bounds one and nothing about where its lines break. It
 * describes the `brief` parameter rather than each tool, since it is longer
 * than the part of a tool's description Claude Code passes an agent.
 */
const chuggyBriefDescription = `\`brief\` is {title?, intent, links, images?, checks?, repository?, branch?, finalization?}: \`title\` is optional in the contract, so always give one — one short line naming the work, which the console lists tickets by; \`intent\` is what the ticket is for, in your own words — one text bounded only as a whole, with no bound on a line of it or on how many lines it has; \`repository\` is the repository the work happens in, by the clone URL list_repositories answers, which list_configurations reports as an imported configuration's provenance, and a draft carrying none is refused when it is released; \`images\` are this project's images the work is handed, each by the identity fetch_image takes; \`checks\` are command lines added to the first Check stage the configuration runs as commands, each one line of 1 to ${String(briefLineCharsMax)} characters with no tab, line break or other control character in it, and initialize_draft answers that stage as \`commandedCheckStage\`, its program stage key, counted from one, and in words as \`commandedCheckStageNote\` (the same stage and, for a catalog, its plan, or that none does and which plans would), and a draft carrying them whose program leaves out that stage, or for a catalog the evaluator in it that runs commands, is refused when it is released whoever releases it (ProgramSkipsBriefChecks), and where it answers none a draft carrying checks is refused when it is released (BriefChecksUncommanded), and each runs under sh -eu with the commit the change started from in CHUG_CHANGE_BASE, unset where that is unknown, so a check that runs only what changed reads it as \${CHUG_CHANGE_BASE-} and runs everything where that is empty; \`branch\` is the refs/heads/ branch the work happens on, which the repository need not hold yet; \`finalization\` is how the work lands, and a brief naming none takes, on a version 2 catalog, the landing of the finalizer its selection lands with where that finalizer names one, and otherwise its repository's landing default, which for a newly bound repository is a pull request; the write's answer carries \`landing\`, the mode and target it stored, and its \`source\`: Brief, Finalizer, Repository, or Default for a brief naming no repository; a landing by PullRequest or PullRequestMerge opens its pull request from \`branch\` into the finalization's \`target\`, or into the repository's default branch where none is named, so whenever the landing is a pull request \`branch\` is a branch of its own, never the \`target\`, and where no target is named never the default branch; a \`branch\` that is the default branch with no target named is accepted when filed and then held by the finalizer (ProposalBaseIsHead). A 400 names the rule the brief broke, and for a check its position in \`checks\`, counted from zero.`;

/** What a draft's brief is first told: the least a ticket can be filed with, ahead of everything a brief may carry. */
const chuggyDraftBriefDescription = `The minimum brief is {title, intent, links: [], repository: <clone URL from list_repositories>, branch: "refs/heads/<a new branch of your own>"}.
${chuggyBriefDescription}`;

/** What a draft's authoring carries, which initialize_draft answers the defaults of. */
const chuggyAuthoringDescription = `\`authoring\` is {program, dependencies}: pass initialize_draft's \`defaults\` unchanged unless you mean otherwise, and \`dependencies\` are ticket numbers from its \`dependencyCandidates\`.`;

/** What the same call made again within one turn answers, which is that operation as it now stands. */
export const chuggySubmissionRepeatDescription = `The same call again in the same turn is the same operation, answered as it now stands: a \`state\` other than Pending is the outcome it already settled on, not a new attempt.`;

/** What a submitted command answers: the operation, and what the same call made again answers. */
const chuggySubmissionDescription = `Answers the operation's id and its \`state\`; read_operation answers what it did, a refusal's \`code\` included. ${chuggySubmissionRepeatDescription}`;

/** What a release or an update of a draft running less than its plan is answered, which no read shows before it is sent. */
const chuggyProgramShortDescription = `A draft whose program runs less than its configuration plans, leaving out a stage of the selected plan or of a document's \`evaluations\`, or for a catalog an evaluator of a stage it keeps, is released, or its ticket updated to it, only by a caller holding the project's skip_planned_evaluations permit, which its administrators hold; any other caller is answered 403 ProgramSkipsPlannedEvaluations and nothing is submitted, so revise_draft it to run the whole plan, as initialize_draft's \`defaults.program\` does, or ask your owner to have it sent.`;

/** What a new draft is fenced on, which is the project's head and not any one ticket's. */
const chuggyExpectedProjectSequenceDescription = `The \`fence.projectSequence\` initialize_draft answered: the project's journal head, which every command anywhere in the project moves. A stale one is refused (DraftInitializationStale) with the head it is at now as \`currentProjectSequence\`, which the same write may be sent again with; a project that is not active refuses the write at any head (ProjectNotActive), naming its \`lifecycle\`.`;

/** The configuration a new draft is filed against, which initialize_draft answered. */
const chuggyNewDraftConfigurationDescription = {
  configurationRevision:
    "The configuration revision initialize_draft was called on.",
  configurationDigest:
    "The `fence.configurationDigest` initialize_draft answered.",
};

/** What a draft write is fenced on, which is a field of the draft and not of its ticket. */
const chuggyExpectedVersionDescription = `The draft's \`authoringVersion\`, as read_draft answers it or as the write that last changed the draft did; a new draft is at 1. A stale one is refused with the draft's \`currentVersion\`.`;

/** What a refusal ledger holds, which is what an empty one is read against. */
const chuggyRefusalLedgerDescription = `A refusal ledger holds the lead's refusals to dispatch a released ticket and their lifts, and nothing else, so it is empty until the lead refuses one. A refused command is never in it: read_operation answers a refused release, revocation or update, and a refused draft write is answered by that write itself.`;

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
 * entries, and room around it. It is wider than an ordinary read draws because
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
 * cursor and nothing where it takes none. A tool whose cursor depends on the
 * call says which through its `cursorOf(given)`, `undefined` where none moves
 * past one item.
 */
function smallestPageRemedy(definition, fields, given) {
  const { name } = definition;
  if (!(chuggyToolPageArgument in fields))
    return `${name} takes no ${chuggyToolPageArgument}, so this one cannot be answered`;
  const cursor =
    definition.cursorOf === undefined
      ? chuggyToolCursorArguments.find((one) => one in fields)
      : definition.cursorOf(given);
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

/** Whether a composed answer fits what one tool answer may weigh. */
function chuggyToolAnswerFits(text) {
  return chuggyToolAnswerBytes(text) <= chuggyToolAnswerBytesMax;
}

/**
 * One route's body for a read that parses it rather than relaying it, drawn
 * whole under `bytesMax`: its `status` and its `text`, or the answer `refused`
 * in its place. A refusal is relayed as any read's is, and a body past the
 * bound is refused, because a cut one is nothing that parses.
 */
async function drawn(context, path, bytesMax, what) {
  const response = await context.request(context.task, context.bearer, path, {
    method: "GET",
  });
  const { status } = response;
  const { text, cut } = await chuggyBoundedBody(response, bytesMax);
  if (status >= 400)
    return {
      status,
      refused: answered(`HTTP ${String(status)}\n${text}`, true),
    };
  if (cut)
    return {
      status,
      refused: answered(
        `${what} is larger than the ${String(bytesMax)} bytes one read of it draws off the wire, so it cannot be answered.`,
        true,
      ),
    };
  return { status, text };
}

/**
 * One transcript page, cut to the whole entries this answer can carry. The
 * route's own body is parsed rather than relayed, which is what lets the answer
 * be smaller than the batch the route pages by. A route whose page is not
 * entries names its own draw bound and the `pageOf` that makes it entries.
 */
async function readTranscript(
  context,
  path,
  cursor,
  bytesMax = chuggyTranscriptBodyBytesMax,
  pageOf = (page) => page,
) {
  const body = await drawn(context, path, bytesMax, "this transcript page");
  if (body.refused !== undefined) return body.refused;
  let page;
  try {
    page = JSON.parse(body.text);
  } catch {
    return answered(
      "the transcript route answered a body this read could not parse.",
      true,
    );
  }
  return answered(
    transcriptPageAnswer(pageOf(page), cursor, chuggyToolAnswerFits),
  );
}

/** The text an error text route's body carries, or nothing where the body is not one as the route answers one. */
function readRunErrorContent(text) {
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    return undefined;
  }
  return answer?.read === "Content" && typeof answer.content === "string"
    ? answer.content
    : undefined;
}

/**
 * An error text as one answer: whole where it fits, and otherwise the longest
 * end of it that does short of the whole, so an answered end always means some
 * of the text was left out. An end asked for from inside a surrogate pair
 * starts after the pair, so every end starts on a code point and a longer one
 * never weighs less, which is what lets the search find the longest. Every
 * code unit weighs at least a byte, so no end longer than an answer's bytes is
 * weighed.
 */
function readRunErrorAnswer(content) {
  const bytes = Buffer.byteLength(content);
  const whole = JSON.stringify({ bytes, content });
  if (chuggyToolAnswerFits(whole)) return whole;
  const tailFrom = (start) => {
    const unit = content.charCodeAt(start);
    const paired = unit >= 0xdc00 && unit <= 0xdfff;
    return JSON.stringify({
      bytes,
      tail: content.slice(paired ? start + 1 : start),
    });
  };
  let low = Math.max(1, content.length - chuggyToolAnswerBytesMax);
  let high = content.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (chuggyToolAnswerFits(tailFrom(middle))) high = middle;
    else low = middle + 1;
  }
  return tailFrom(low);
}

/**
 * One attempt's error text. An attempt that kept none is answered as one that
 * has none rather than as a failure, because most attempts keep none.
 */
async function readRunError(context, path) {
  const body = await drawn(
    context,
    path,
    chuggyToolRunErrorResponseBytesMax,
    "this error text's answer",
  );
  if (body.status === 404)
    return answered(
      "This attempt has no error text: its worker kept none, or this project has no such attempt.",
    );
  if (body.refused !== undefined) return body.refused;
  const content = readRunErrorContent(body.text);
  if (content === undefined)
    return answered(
      `the error text route answered HTTP ${String(body.status)} with a body that is not one error text as the contract answers it.`,
      true,
    );
  return answered(readRunErrorAnswer(content));
}

/** A landings route's body, or nothing where it is not one as the route answers one. */
function readTicketLandingsBody(text) {
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    return undefined;
  }
  const landings = answer?.landings;
  return Array.isArray(landings) &&
    landings.length <= ticketLandingsAnsweredMax &&
    typeof answer.truncated === "boolean"
    ? answer
    : undefined;
}

/**
 * A ticket's landings as one answer: the newest that fit, oldest first, and
 * `truncated` where the route left older ones out or this answer did. Nothing
 * is answered where the newest alone does not fit, because a landing is never
 * cut.
 */
function readTicketLandingsAnswer(body) {
  const { landings } = body;
  if (landings.length === 0) return JSON.stringify(body);
  for (let kept = landings.length; kept > 0; kept -= 1) {
    const answer = JSON.stringify({
      ...body,
      landings: landings.slice(landings.length - kept),
      truncated: body.truncated || kept < landings.length,
    });
    if (chuggyToolAnswerFits(answer)) return answer;
  }
  return undefined;
}

/** One ticket's landings, newest kept where they are more than one answer holds. */
async function readTicketLandings(context, path) {
  const body = await drawn(
    context,
    path,
    chuggyToolTicketLandingsResponseBytesMax,
    "this ticket's landings",
  );
  if (body.refused !== undefined) return body.refused;
  const landings = readTicketLandingsBody(body.text);
  if (landings === undefined)
    return answered(
      `the landings route answered HTTP ${String(body.status)} with a body that is not a ticket's landings as the contract answers them.`,
      true,
    );
  const answer = readTicketLandingsAnswer(landings);
  return answer === undefined
    ? answerTooLarge(
        "its newest landing is larger alone, so it cannot be answered",
      )
    : answered(answer);
}

/**
 * A read whose route's body is answered as `reshape` makes it, in place of
 * verbatim: `undefined` from `reshape` is a body that is not `what` as the
 * route answers it. A refusal is relayed as any read's is.
 */
async function readReshaped(context, path, what, reshape) {
  const body = await drawn(context, path, chuggyToolResponseBytesMax, what);
  if (body.refused !== undefined) return body.refused;
  let parsed;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    parsed = undefined;
  }
  const reshaped =
    parsed !== null && typeof parsed === "object" ? reshape(parsed) : undefined;
  return reshaped === undefined
    ? answered(
        `the route answered HTTP ${String(body.status)} with a body that is not ${what} as the contract answers it.`,
        true,
      )
    : answered(`HTTP ${String(body.status)}\n${JSON.stringify(reshaped)}`);
}

/** Why a ticket filed in a listed binding would not run, or nothing where it would. */
function listRepositoriesUnfileable({ retiredAt, workerReach }) {
  if (retiredAt !== undefined)
    return `Retired at ${String(retiredAt)}, so a draft naming it is refused.`;
  if (workerReach === undefined) return undefined;
  return workerReach?.reach === "Unknown"
    ? "The forge could not say whether the worker app reaches it (workerReach Unknown), so a ticket in it may stop at its clone."
    : `Not reached by the worker app (workerReach ${String(workerReach?.reach)}), so a ticket in it stops at its clone.`;
}

/** The listing with each row saying whether a ticket may be filed in it, and otherwise as the route answered it. */
function listRepositoriesFileable(body) {
  const { repositories } = body;
  if (
    !Array.isArray(repositories) ||
    !repositories.every((row) => row !== null && typeof row === "object")
  )
    return undefined;
  return {
    ...body,
    repositories: repositories.map((row) => {
      const fileableReason = listRepositoriesUnfileable(row);
      return fileableReason === undefined
        ? { ...row, fileable: true }
        : { ...row, fileable: false, fileableReason };
    }),
  };
}

/** A draft's initialization without its configuration's canonical document, which read_configuration answers. */
function initializeDraftUncanonical(body) {
  const { configuration } = body;
  if (configuration === null || typeof configuration !== "object")
    return undefined;
  return {
    ...body,
    configuration: Object.fromEntries(
      Object.entries(configuration).filter(([key]) => key !== "canonical"),
    ),
  };
}

/**
 * The version `ticket` is dispatched at, as its dispatch view entry names it,
 * or why there is none: the view is being rebuilt, or the ticket is no
 * candidate. A body that is no view as the contract answers one is undefined.
 */
function dispatchTicketVersion(text, ticket) {
  let view;
  try {
    view = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (view?.result === "Reset") return { absent: "Reset" };
  if (view?.result !== "Page" || !Array.isArray(view.candidates))
    return undefined;
  const candidate = view.candidates.find((entry) => entry?.ticket === ticket);
  if (candidate === undefined) return { absent: "NotCandidate" };
  return Number.isSafeInteger(candidate.ticketVersion)
    ? { version: candidate.ticketVersion }
    : undefined;
}

/**
 * One ticket dispatched at the version the dispatch view names for it, so a
 * ticket that is no candidate is answered without anything being submitted.
 * The view is read a page of one, starting just before the ticket.
 */
async function dispatchTicket(context, ticket) {
  const body = await drawn(
    context,
    `${projectPath(context, "dispatchView")}${search({
      after: ticket > 1 ? ticket - 1 : undefined,
      limit: 1,
    })}`,
    chuggyToolDispatchViewResponseBytesMax,
    "this ticket's dispatch view entry",
  );
  if (body.refused !== undefined) return body.refused;
  const found = dispatchTicketVersion(body.text, ticket);
  if (found === undefined)
    return answered(
      `the dispatch view answered HTTP ${String(body.status)} with a body that is not a dispatch view as the contract answers one.`,
      true,
    );
  if (found.absent === "Reset")
    return answered(
      "the project's dispatch view is being rebuilt, so nothing was submitted; call again.",
      true,
    );
  if (found.absent === "NotCandidate")
    return answered(
      `ticket ${String(ticket)} cannot be dispatched now, so nothing was submitted: only a Pending ticket whose dependencies are all Done can be, and read_ticket answers its phase and what it waits on.`,
      true,
    );
  return submit(context, {
    mutation: "ManualDispatch",
    ticket,
    expectedTicketVersion: found.version,
  });
}

/** What names the directory one context's images are written into. */
const chuggyToolImageDirectoryPrefix = "chuggy-tool-images-";

/**
 * Where one context's images are written: each to a new file of its own,
 * readable by this user alone and named for its bytes' format, in a directory
 * made under the temporary directory at the first and written by nothing else.
 */
export function chuggyToolImageFiles(environment = process.env) {
  let directory;
  let written = 0;
  return async (bytes) => {
    directory ??= mkdtemp(
      workerTemporaryFile(chuggyToolImageDirectoryPrefix, environment),
    );
    written += 1;
    const file = resolve(
      await directory,
      `${String(written)}${ticketImageExtension(bytes)}`,
    );
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    return file;
  };
}

/** The image a route's body carries, decoded, or nothing where the body is not one as the route answers one. */
function readImageDecoded(text) {
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    typeof answer?.content !== "string" ||
    !imageMediaTypes.includes(answer.mediaType) ||
    answer.encoding !== projectArtifactEncoding
  )
    return undefined;
  // `Buffer` skips what is not base64 rather than refusing it, so content that
  // is not its own bytes' encoding is not the image the route meant.
  const bytes = Buffer.from(answer.content, projectArtifactEncoding);
  if (bytes.toString(projectArtifactEncoding) !== answer.content)
    return undefined;
  return { mediaType: answer.mediaType, bytes };
}

/**
 * One of the project's images, written to a new file whose path is answered in
 * place of its bytes. A refusal is relayed as any read's is, and an answer past
 * the route's bound or not in its shape is refused with nothing written.
 */
async function readImage(context, path) {
  const body = await drawn(
    context,
    path,
    chuggyToolImageResponseBytesMax,
    "this image's answer",
  );
  if (body.refused !== undefined) return body.refused;
  const image = readImageDecoded(body.text);
  if (image === undefined)
    return answered(
      `the image route answered HTTP ${String(body.status)} with a body that is not one base64 image of a media type the contract admits, so nothing was written.`,
      true,
    );
  const file = await context.imageFile(image.bytes);
  return answered(
    `${image.mediaType}, ${String(image.bytes.byteLength)} bytes, written to ${file}. Open that file with Read to see the image.`,
  );
}

/** The chunks one docs answer may arrive in, which is what ends a body yielding empty chunks forever. */
const chuggyDocsReadsMax = 4_096;

/** The longest docs page URL `read_docs` takes. */
const chuggyDocsPageCharsMax = 2_048;

/** The directory the docs index is in, which every page it lists is under. */
const chuggyDocsDirectory = new URL(".", chuggyDocsIndex);

/** `page` as the URL it names, or nothing where it is not one under the index's own directory. */
function readDocsPage(page) {
  let url;
  try {
    url = new URL(page);
  } catch {
    return undefined;
  }
  return url.origin === chuggyDocsDirectory.origin &&
    url.pathname.startsWith(chuggyDocsDirectory.pathname)
    ? url
    : undefined;
}

/**
 * The docs index, or with `page` one page of the docs, answered verbatim. A
 * URL outside the index's directory is refused before anything is fetched; a
 * redirect is not followed, since it could leave that directory, and is
 * answered as the refusal any other status but a 2xx is. A body past the
 * contract's bound is refused rather than cut.
 */
async function readDocs(context, page) {
  const url =
    page === undefined ? new URL(chuggyDocsIndex) : readDocsPage(page);
  if (url === undefined)
    return answered(
      `${page} is not under ${chuggyDocsDirectory.href}, where the index lists every page, so nothing was fetched.`,
      true,
    );
  const response = await context.docsFetch(url, {
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(chuggyToolTimeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return answered(
      `the docs host answered HTTP ${String(response.status)} for ${url.href}.`,
      true,
    );
  }
  let bytes;
  try {
    bytes = await boundedResponseBytes(
      response,
      chuggyToolDocsResponseBytesMax,
      chuggyDocsReadsMax,
    );
  } catch (failure) {
    if (!(failure instanceof RangeError)) throw failure;
    return answered(
      `${url.href} is larger than the ${String(chuggyToolDocsResponseBytesMax)} bytes one read_docs answer may weigh, so it cannot be answered.`,
      true,
    );
  }
  return answered(new TextDecoder().decode(bytes));
}

function write(context, path, method, body, headers = {}) {
  return relay(
    context,
    path,
    body === undefined
      ? { method, headers }
      : {
          method,
          headers: { "content-type": nativeHttpMediaType, ...headers },
          body: JSON.stringify(body),
        },
  );
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

/**
 * The parameters several tools share, each describing itself, so every tool
 * that takes one publishes the sentence; a tool where one means something
 * else describes it again over this.
 */
const ticket = (z) =>
  z
    .number()
    .int()
    .min(1)
    .describe("A ticket's number, as list_tickets answers it.");
const limit = (z, max) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .describe(
      `The most items this page answers, at most ${String(max)}; left out, the route's own default.`,
    )
    .optional();
const count = (z) => z.number().int().min(0);
/** A draft's authoring version, which a new draft starts at. */
const authoringVersion = (z) => z.number().int().min(1);
const identity = (z) => z.string().min(1).max(256);
const cursor = (z) =>
  identity(z)
    .describe(
      "The `nextCursor` the previous page answered, for the page after it; left out, the first page.",
    )
    .optional();
const revision = (z) =>
  identity(z).describe(
    "A configuration revision, as list_configurations answers it.",
  );
const execution = (z) =>
  identity(z).describe(
    "An execution's id, as list_executions or read_ticket's `escalation.failed` answers it.",
  );
const attempt = (z) =>
  identity(z).describe(
    "One of the execution's attempts by its id, as read_execution or read_ticket's `escalation.failed` answers it.",
  );
const thread = (z) =>
  identity(z).describe("A thread's session, as list_threads answers it.");
/** A transcript read's place, which its answer's `next` carries back. */
const transcriptPlace = (z) => ({
  after: count(z)
    .describe(
      "The `after` of the previous answer's `next`; left out, the first page.",
    )
    .optional(),
  entry: count(z)
    .describe(
      "The `entry` of the previous answer's `next`, how many entries of that page were answered; left out, 0.",
    )
    .optional(),
});
const transcriptStream = (z, read) =>
  identity(z)
    .describe(
      `One of the \`streams\` ${read} answers, by its \`stream\`; left out, the session's own agent's stream.`,
    )
    .optional();
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
      "One page of this project's tickets, ascending by number or by recent activity. Call it to find a ticket and its phase. A page may hold fewer than `limit`, and only `nextAfter`, or `nextCursor`, present says there are more.",
    shape: (z) => ({
      after: ticket(z)
        .describe(
          "The `nextAfter` the previous page answered, for the page after it, ascending by number; left out, the first page.",
        )
        .optional(),
      limit: limit(z, nativeHttpPageItemsMax),
      phase: z
        .array(z.string().min(1))
        .max(16)
        .describe(
          "`phase` takes one or more of Pending, Work, Evaluation, Finalization, Done, Escalated and Revoked, matched exactly, and lists a ticket in any of them, or `NonTerminal` alone; left out, it lists every phase.",
        )
        .optional(),
      order: z
        .enum(["RecentActivity"])
        .describe(
          '`order: "RecentActivity"` lists them newest activity first instead, answering `nextCursor` for the next page, which `cursor` resumes from in that order and `after` does not. Left out, they are listed ascending by number, answering `nextAfter`.',
        )
        .optional(),
      cursor: identity(z)
        .describe(
          'The `nextCursor` the previous page answered under `order: "RecentActivity"`, for the page after it; left out, the first page.',
        )
        .optional(),
    }),
    // An activity cursor is the server's own, so none names a ticket to move past.
    cursorOf: ({ order }) => (order === undefined ? "after" : undefined),
    call: (context, { after, limit: pageLimit, phase, order, cursor }) =>
      read(
        context,
        `${projectPath(context, "project")}${search({ after, limit: pageLimit, phase, order, cursor })}`,
      ),
  },
  {
    name: "read_ticket",
    description:
      "One ticket: its phase, its version, its authoring, its brief and what its runs cost. Call it for where a ticket stands. It carries `runTotals`, what every run of its executions reported, summed: turns, durations, tokens by kind, permission denials and `costUsdMicros`, millionths of a dollar at the runtime's list price, with tokens and cost per model in `models`. A ticket no run has reported for carries none. A ticket waiting because its run stopped at its clone, setup, commit, push or deadline, or because its runner's disk ran low, names that step's label, the execution and the attempt in `escalation.failed`, which read_run_error takes to read the attempt's error text. Where its work is landing or waits to land, read_ticket_landings says how: its hold, its approval, or its pull request and what its merge waits on.",
    shape: (z) => ({ ticket: ticket(z) }),
    call: (context, args) =>
      read(context, projectPath(context, "ticket", { ticket: args.ticket })),
  },
  {
    name: "read_draft",
    description:
      "One draft still open on this project. Call it before revise_draft, whose fence and whole brief it answers.",
    shape: (z) => ({
      ticket: ticket(z).describe(
        "The ticket number the draft holds, as create_draft, file_dependent or list_drafts answers it.",
      ),
    }),
    call: (context, args) =>
      read(context, projectPath(context, "draft", { ticket: args.ticket })),
  },
  {
    name: "list_drafts",
    description:
      "One page of the drafts this project still holds open, ascending by ticket. Call it to find a draft to revise or release.",
    shape: (z) => ({
      limit: limit(z, nativeHttpPageItemsMax),
      cursor: cursor(z),
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
      "One page of this project's configuration revisions, newest first. Call it for the revision a draft is filed against. One imported from a repository carries its configuration's name in `provenance.name`; who does the work under it is read_configuration's to answer.",
    shape: (z) => ({
      cursor: cursor(z),
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
      "One configuration revision's canonical document, as a draft is authored against it. Call it for who does a ticket's work and what evaluates it. `canonical` is the stored document as JSON text, and its `worker.mode` is who does the work of a ticket released against it: the agent, and what that agent is started with, a model where the configuration names one. Its evaluation stages run in the order listed and a failed stage ends evaluation, while the evaluators of one stage run in parallel; in a catalog each evaluator of a plan stage names its own workload, so review lenses that should run side by side belong in one stage.",
    shape: (z) => ({ revision: revision(z) }),
    call: (context, args) =>
      read(
        context,
        projectPath(context, "configuration", { revision: args.revision }),
      ),
  },
  {
    name: "read_decision_log",
    description:
      "One page of this project's past selector decisions, oldest first: what each chose and under which settings. Call it for why a ticket was or was not dispatched.",
    shape: (z) => ({
      after: count(z)
        .describe(
          "The `nextAfter` the previous page answered, for the page after it; left out, the first page.",
        )
        .optional(),
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
    description: `The refusals standing across this project, each a ticket whose latest ledger entry is a refusal, with the ticket version each names. Call it for which released tickets the lead will not dispatch. ${chuggyRefusalLedgerDescription}`,
    shape: (z) => ({ limit: limit(z, agenticRefusalsAnsweredMax) }),
    call: (context, { limit: pageLimit }) =>
      read(
        context,
        `${projectPath(context, "agenticRefusals")}${search({ limit: pageLimit })}`,
      ),
  },
  {
    name: "read_ticket_refusals",
    description: `One ticket's refusal ledger, oldest first: the refusals recorded on it and their lifts. Call it for why the lead has not dispatched it. \`more\` says the ledger holds further entries than one answer carries. ${chuggyRefusalLedgerDescription}`,
    shape: (z) => ({ ticket: ticket(z) }),
    call: (context, args) =>
      read(
        context,
        projectPath(context, "ticketAgenticRefusals", { ticket: args.ticket }),
      ),
  },
  {
    name: "read_ticket_landings",
    description:
      "One ticket's landings, each a finalization of its work into its repository. Call it for how a ticket's work lands and what its merge waits on. It answers the newest one answer holds, oldest first, and `truncated` where the ticket has older ones this answer leaves out. A ticket whose work has not reached landing has none. Answers JSON. Each landing carries its `state`, such as Running, Held, AwaitingApproval, AwaitingMerge, Proposed (its pull request opened for a person to merge), Failed or Landed, its `cycle`, its `attempts`, and its newest `attempt` where it made one: its `outcome`, its `failureKind` where it failed, and the `targetRef` it lands on. A Held landing carries `hold`: its `kind`, what holds it, and `since`, when a hold of that kind began. An AwaitingMerge landing carries `wait`: its `reason`, what the merge waits on, and `checkedAt`, when the forge was last heard about its merge. A Landed one carries `landedCommit`. `proposal` is the pull request it opened, where it opened one: its `url`, its `headRef` and `baseRef`, its `status`, its `mergeability`, and `mergeState`, the forge's own word for that, GitHub's `mergeable_state` such as `blocked`, `behind` or `dirty`. `conflict` is the paths its newest attempt conflicted on, `truncated` where they were cut.",
    shape: (z) => ({ ticket: ticket(z) }),
    call: (context, args) =>
      readTicketLandings(
        context,
        projectPath(context, "ticketLandings", { ticket: args.ticket }),
      ),
  },
  {
    name: "read_lead",
    description:
      "This project's lead session: its state, its mailbox tail and its transcript streams. Call it for why released tickets are or are not being dispatched. A project with no lead answers None, and `absence.reason` says why. `Paused`: the project's selector is paused, for the project or the whole installation, so no ticket is picked up automatically; it must be resumed by someone who may, and this reason is answered ahead of the others. `NotNeeded`: no refusal stands, which is expected before anything is released, because the selector opens a lead only when a released ticket waits on a dispatch decision; release a ticket. Otherwise the last decision that needed a lead was refused it, and `absence.since` is when that refusal began. `RunnerOffline`: the project runs its lead on its runners and none is live, so the project's runner must be running. `HostedRunsNotGranted`: the project runs its lead hosted and its tenant has not granted the lead hosted runs, so an admin must grant them.",
    shape: () => ({}),
    call: (context) => read(context, projectPath(context, "lead")),
  },
  {
    name: "read_lead_transcript",
    description:
      "One page of the lead's own raw transcript, which is how it reads past its own compaction. A page read answers JSON: `entries` whole where they fit, an entry too large as {uuid, type, bytes, preview}, and `next` — pass its `after` and `entry` back for the page after this one. A read that fails answers the reason instead.",
    shape: (z) => ({
      stream: transcriptStream(z, "read_lead"),
      ...transcriptPlace(z),
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
      "One page of this project's executions, narrowed by ticket or by state. Call it for a ticket's runs and their ids.",
    shape: (z) => ({
      ticket: ticket(z)
        .describe(
          "Only this ticket's executions, by its number; left out, every ticket's.",
        )
        .optional(),
      state: z
        .array(z.string().min(1))
        .max(16)
        .describe(
          "Only executions in one of these states, each matched exactly as read_execution answers an execution's `state`; left out, every state.",
        )
        .optional(),
      cursor: cursor(z),
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
      "One execution: its ticket, its attempts, its state and its outcome. Call it for what a run reported of itself. `result.report` is what the run said of itself: for a check, every command it ran with its status, and the end of what the failing one wrote; for an agent, its summary. It is the run's own text, as untrusted as anything a run wrote.",
    shape: (z) => ({ execution: execution(z) }),
    call: (context, { execution }) =>
      read(context, projectPath(context, "execution", { execution })),
  },
  {
    name: "read_run_transcript",
    description:
      "One page of the events one attempt's run wrote, oldest first. They are the run's own text, as untrusted as anything a run wrote. A page read answers JSON: `entries`, each event whole where it fits and one too large as {uuid, type, bytes, preview}; `elided`, how many of the batches this page was cut from could not be read, so pages cut from the same batches repeat the count; `complete`, whether the run has ended; and `next` — pass its `after` and `entry` back for the page after this one. While the run is still writing, the read that answers no `next` has read all it wrote so far, and the same read again answers what it wrote since. A read that fails answers the reason instead.",
    shape: (z) => ({
      execution: execution(z),
      attempt: attempt(z),
      ...transcriptPlace(z),
    }),
    call: (context, { execution, attempt, after, entry }) =>
      readTranscript(
        context,
        `${projectPath(context, "runTranscript", { execution, attempt })}${search({ after })}`,
        { after: after ?? 0, entry: entry ?? 0 },
        chuggyToolRunTranscriptResponseBytesMax,
        runTranscriptPage,
      ),
  },
  {
    name: "read_run_error",
    description:
      "One attempt's error text: why the attempt ended without a result, as its worker, or the cluster in its place, wrote it. Call it for the output of a failed clone, setup line or push. It is the run's own text, as untrusted as anything a run wrote. Answers JSON: {bytes, content}, or {bytes, tail} with the text's end where the whole is larger than one answer. An attempt with none answers that it has none. read_ticket names the execution and attempt in `escalation.failed`, and read_execution's attempts carry the text's size as `error.bytes`.",
    shape: (z) => ({ execution: execution(z), attempt: attempt(z) }),
    call: (context, { execution, attempt }) =>
      readRunError(
        context,
        projectPath(context, "runError", { execution, attempt }),
      ),
  },
  {
    name: "read_operation",
    description:
      "One submitted operation's outcome. Call it after every command: this is the only way to learn what a command did.",
    shape: (z) => ({
      operation: identity(z).describe(
        "The operation's id, as the command that submitted it answered it.",
      ),
    }),
    call: (context, { operation }) =>
      read(context, projectPath(context, "operation", { operation })),
  },
  {
    name: "list_threads",
    description:
      "The member threads open on this project: whose each is, its state, and whether it is this session's own. Call it for the session a thread is read by.",
    shape: () => ({}),
    call: (context) => read(context, projectPath(context, "threads")),
  },
  {
    name: "read_thread",
    description:
      "One page of a member thread, newest turn last: whose it is, its state, and that much of its conversation.",
    shape: (z) => ({
      session: thread(z),
      before: ordinal(z)
        .describe(
          "The `nextBefore` the previous page answered, for the page before it; left out, the newest turns.",
        )
        .optional(),
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
      session: thread(z),
      stream: transcriptStream(z, "read_thread"),
      ...transcriptPlace(z),
    }),
    call: (context, { session, stream, after, entry }) =>
      readTranscript(
        context,
        `${projectPath(context, "threadTranscript", { session })}${search({ stream, after, limit: chuggyTranscriptBatchesRead })}`,
        { after: after ?? 0, entry: entry ?? 0 },
      ),
  },
  {
    name: "list_repositories",
    description:
      "Every repository this project binds, oldest first. Call it for the repository a ticket is filed in. `repository` is its clone URL, which is what a brief's `repository` names; `landing` is its landing default, the mode a ticket in it lands by where neither its brief nor its catalog finalizer names one; `configured` says whether the project holds configurations for it, and `configurationsHeld` what: Imported, with the `count` of names it declared, or Bootstrapped, the project's bootstrap `revision`, which a repository declaring none releases its tickets under. A retired binding carries `retiredAt`, and a draft write naming it is refused. `pipelinesWritable` says whether its jobs may write its pipeline definitions, and `workerReach`, present only where the worker app cannot be said to reach it, says why. A ticket may be filed in any binding not retired, and one holding no configurations releases its tickets under the project's bootstrap. Each row's `fileable` says whether to file a ticket there: false, with `fileableReason` saying why, where it is retired or carries `workerReach`, since a ticket in a repository the worker app does not reach stops at its clone.",
    shape: () => ({}),
    call: (context) =>
      readReshaped(
        context,
        projectPath(context, "projectRepositories"),
        "this project's repositories",
        listRepositoriesFileable,
      ),
  },
  {
    name: "fetch_image",
    description:
      "One of this project's images, written to a new file. Answers that file's path, its media type and its size in bytes; open the file with Read to see the image.",
    shape: (z) => ({
      artifact: identity(z).describe(
        "The image, by the identity a message's images section or a brief names it by.",
      ),
    }),
    call: (context, { artifact }) =>
      readImage(context, projectPath(context, "projectArtifact", { artifact })),
  },
  {
    name: "read_docs",
    description:
      "chuggy's own documentation, as Markdown, verbatim. Call it first with no `page`: that answers the index, which lists each page by its URL. Then call it with `page`, one of those URLs, for that page. A URL outside the index's own directory is refused.",
    shape: (z) => ({
      page: z
        .string()
        .min(1)
        .max(chuggyDocsPageCharsMax)
        .describe(
          "One of the URLs the index lists; left out, the index itself.",
        )
        .optional(),
    }),
    call: (context, { page }) => readDocs(context, page),
  },
  {
    name: "initialize_draft",
    description:
      "The defaults, the dependency candidates and the fence a new draft is filed against, for one configuration revision. Call it before create_draft or file_dependent. A draft's `authoring.program` is its evaluation: stage N runs under the configuration's Nth `evaluations` entry, or its `review` where it lists none, the stages run in that order, and a failed stage ends evaluation. `defaults.program` is the program to start from, and `choices.programStagesMax` is the most stages a program may have against this configuration. For a catalog, stage N runs the selected plan's Nth stage, and `defaults` and `choices` are those of the selection passed. `commandedCheckStage` is the stage a brief's `checks` join, by its program stage key, counted from one as `defaults.program` keys are, and absent where none takes them, and `commandedCheckStageNote` says it in words: the same stage and, for a catalog, the plan and the stage's name, or that none does and which plans would. `configuration` is answered without its `canonical`; read_configuration answers the document.",
    shape: (z) => ({
      revision: revision(z),
      work: identity(z)
        .describe(
          "For a catalog, the `work` the draft will select: the name of one of its `workloads`; left out, the catalog's default.",
        )
        .optional(),
      evaluation: identity(z)
        .describe(
          "For a catalog, the `evaluation` the draft will select: the name of one of its `plans`; left out, the catalog's default.",
        )
        .optional(),
      finalization: identity(z)
        .describe(
          "For a catalog, the `finalization` the draft will select: the name of one of its `finalizers`; left out, the catalog's default.",
        )
        .optional(),
    }),
    call: (context, { revision, work, evaluation, finalization }) =>
      readReshaped(
        context,
        `${projectPath(context, "draftInitialization", { revision })}${search({ work, evaluation, finalization })}`,
        "a draft's initialization",
        initializeDraftUncanonical,
      ),
  },
  {
    name: "file_dependent",
    description:
      "Files a new draft derived from an existing ticket. Call it after initialize_draft, for work that follows from a ticket already filed.",
    shape: (z) => ({
      parent: ticket(z).describe(
        "The ticket the draft follows from, as list_tickets answers it.",
      ),
      relation: z
        .enum(allDependentRelations)
        .describe("`relation` admits FollowUp only."),
      configurationRevision: identity(z).describe(
        chuggyNewDraftConfigurationDescription.configurationRevision,
      ),
      configurationDigest: identity(z).describe(
        chuggyNewDraftConfigurationDescription.configurationDigest,
      ),
      expectedProjectSequence: count(z).describe(
        chuggyExpectedProjectSequenceDescription,
      ),
      authoring: anyObject(z).describe(
        `${chuggyAuthoringDescription} \`authoring.dependencies\` must carry the parent.`,
      ),
      brief: anyObject(z).describe(chuggyBriefDescription),
      selection: anyObject(z).optional().describe(chuggySelectionDescription),
    }),
    call: (context, args) => {
      if (!dependentRelationsAdmitted.includes(args.relation))
        return answered(
          `${args.relation} is not derivable: file_dependent changes no ticket but the draft it files, so ticket ${String(args.parent)} cannot come to depend on that draft here. File a FollowUp instead; a prerequisite of a ticket still in draft is a revise_draft of that draft's dependencies, and of a Pending ticket a revise_draft of its draft's dependencies that update_ticket releases.`,
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
    description:
      "Replaces one open draft's authoring, brief and selection, fenced on `expectedVersion`. A Pending ticket's draft takes a revision too, which its ticket runs only once update_ticket releases it.",
    shape: (z) => ({
      ticket: ticket(z).describe(
        "The ticket number the draft holds, as read_draft answers it.",
      ),
      expectedVersion: authoringVersion(z).describe(
        chuggyExpectedVersionDescription,
      ),
      configurationRevision: identity(z).describe(
        "The configuration revision the revised draft is authored against, as read_draft or list_configurations answers it.",
      ),
      authoring: anyObject(z).describe(chuggyAuthoringDescription),
      brief: anyObject(z).describe(
        `${chuggyDraftBriefDescription} It is replaced whole, so send back the \`repository\` and \`images\` read_draft answered or the revision clears them.`,
      ),
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
    description:
      "Deletes one open draft, fenced on `expectedVersion`. Call it for a draft that will not be released.",
    shape: (z) => ({
      ticket: ticket(z).describe(
        "The ticket number the draft holds, as read_draft answers it.",
      ),
      expectedVersion: authoringVersion(z).describe(
        chuggyExpectedVersionDescription,
      ),
    }),
    call: (context, args) =>
      write(
        context,
        `${projectPath(context, "draft", { ticket: args.ticket })}${search({ expectedVersion: args.expectedVersion })}`,
        "DELETE",
      ),
  },
  {
    name: "release_draft",
    description: `Submits the release of one draft. Releasing makes the ticket Pending and starts no work: the project's lead dispatches it when its dependencies are Done, or a person who may dispatch does. ${chuggySubmissionDescription} A release refused for its brief or its configuration is refused again at that authoring version, so revise_draft the draft and release the \`authoringVersion\` and \`configurationRevision\` the revision answers. ${chuggyProgramShortDescription}`,
    shape: (z) => ({
      ticket: ticket(z).describe(
        "The ticket number the draft holds, as read_draft answers it.",
      ),
      authoringVersion: count(z).describe(
        "The draft's `authoringVersion` to release, as read_draft or the write that last changed the draft answers it.",
      ),
      configurationRevision: identity(z).describe(
        "The draft's `configurationRevision`, as read_draft or the write that last changed the draft answers it.",
      ),
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
    description:
      "Files a new draft for work your owner asked for, derived from nothing. Call it after initialize_draft, whose answer it is fenced on.",
    shape: (z) => ({
      configurationRevision: identity(z).describe(
        chuggyNewDraftConfigurationDescription.configurationRevision,
      ),
      configurationDigest: identity(z).describe(
        chuggyNewDraftConfigurationDescription.configurationDigest,
      ),
      expectedProjectSequence: count(z).describe(
        chuggyExpectedProjectSequenceDescription,
      ),
      authoring: anyObject(z).describe(chuggyAuthoringDescription),
      brief: anyObject(z).describe(chuggyDraftBriefDescription),
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
    description: `Submits the revocation of one ticket, on your owner's word only. Revoking ends the ticket for good: it cancels the work running for it and undoes nothing that already landed. It revokes no other ticket. A ticket depending on a revoked one cannot start, and read_ticket names those dependencies in \`revokedDependencies\`: while it is Pending, an update that drops them (revise_draft, then update_ticket) lets it start, and otherwise it can only be revoked too. ${chuggySubmissionDescription}`,
    shape: (z) => ({ ticket: ticket(z) }),
    call: (context, args) =>
      submit(context, { mutation: "RevokeTicket", ticket: args.ticket }),
  },
  {
    name: "update_ticket",
    description: `Submits the update of one Pending ticket to its draft as revise_draft last left it, on your owner's word only. A ticket no longer Pending is refused (TicketNotPending), and one whose revision moved since it was read is refused (TicketRevisionStale), so read_ticket it again. The draft's dependencies replace the ticket's: dropping one is never refused, and one it adds is refused if it was revoked (DependenciesRevoked) or already waits on this ticket (DependencyCycle). ${chuggySubmissionDescription} ${chuggyProgramShortDescription}`,
    shape: (z) => ({
      ticket: ticket(z),
      expectedRevision: ticket(z).describe(
        "`expectedRevision` is the ticket's `revision` as read_ticket answers it.",
      ),
      authoringVersion: count(z).describe(
        "The draft's `authoringVersion`, as read_draft or the revise_draft that last changed it answers it.",
      ),
      configurationRevision: identity(z).describe(
        "The draft's `configurationRevision`, as read_draft or the revise_draft that last changed it answers it.",
      ),
    }),
    call: (context, args) =>
      submit(context, {
        mutation: "UpdateTicket",
        ticket: args.ticket,
        expectedRevision: args.expectedRevision,
        authoringVersion: args.authoringVersion,
        configurationRevision: args.configurationRevision,
      }),
  },
  {
    name: "dispatch_ticket",
    description: `Submits the dispatch of one released ticket, on your owner's word only, which starts its work now rather than when the lead chooses it. It is your owner's dispatch, so where they may not dispatch in this project the submission is answered 404, though the ticket exists. Only a Pending ticket whose dependencies are all Done can be dispatched, and any other is answered without anything being submitted. A ticket that moved between this tool reading it and submitting is refused (TicketChanged), so call again. ${chuggySubmissionDescription}`,
    shape: (z) => ({ ticket: ticket(z) }),
    call: (context, args) => dispatchTicket(context, args.ticket),
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
    call: (args) => definition.call(context, scrubbedArguments(args, context)),
  }));
  return [...project, ...context.staging.definitions].filter((definition) =>
    admitted.has(definition.name),
  );
}

/** `value` with every string in it, each key included, scrubbed of the session's secrets. */
function scrubbedArguments(value, context) {
  if (typeof value === "string") return context.scrub(value);
  if (Array.isArray(value))
    return value.map((each) => scrubbedArguments(each, context));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, each]) => [
      context.scrub(key),
      scrubbedArguments(each, context),
    ]),
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
      : answerTooLarge(smallestPageRemedy(definition, fields, given));
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

/** What one session's tools are held in: its task, its bearer, this turn's staging, where its images are written, how the public docs are fetched, and the scrub of what they send. */
export function chuggyToolContext(task, bearer, services = {}) {
  return {
    task,
    bearer,
    scrub: services.scrub ?? ((text) => text),
    capabilities: services.capabilities ?? [],
    version: services.version ?? "1",
    request: services.request ?? chuggyRequest,
    turn: services.turn ?? (() => undefined),
    staging: services.staging ?? leadDecisionStaging(),
    imageFile: services.imageFile ?? chuggyToolImageFiles(),
    docsFetch: services.docsFetch ?? globalThis.fetch,
  };
}
