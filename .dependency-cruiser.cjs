// The harness's boundary: what a module at this repository's root may import.
//
// Every module here, its suites and fixtures included, runs in an image beside
// whatever that image installs globally and nothing else: the shipped set in
// the worker, the suites in the stage that runs them. So a module here reaches
// Node's own modules, its neighbours at the root, and the packages an image
// installs, by name.
//
// Every rule below is proved to bite against a fixture tree carrying its
// violation, in `.chug/tasks/check-boundaries.test.sh`. A boundary rule that
// has never rejected anything is an unverified control.

/** A module of the harness: any `.mjs` at the root. */
const harness = "^[^/]+\\.mjs$";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "harness-reaches-only-the-contract",
      comment:
        "A module here reaches Node's own modules, its neighbours, the " +
        "contract and the packages an image installs globally beside it, " +
        "and nothing else: a module it reached anywhere else is one no " +
        "image holds. The packages are named rather than node_modules as a " +
        "whole, because a devDependency resolves in every suite here and in " +
        "no pod. Not reachability: the `to` is everything but the exits, so " +
        "a relay is caught at its first edge.",
      severity: "error",
      from: { path: harness },
      to: {
        path: "^(?![^/]+\\.mjs$)",
        pathNot:
          "(^|/)node_modules/(@chuggy/worker-contract|zod|@anthropic-ai/claude-agent-sdk|@modelcontextprotocol/sdk|@anthropic-ai/claude-code|@openai/codex)/",
        dependencyTypesNot: ["core"],
      },
    },
    {
      name: "harness-names-packages-by-name",
      comment:
        "An image installs the contract and its neighbours globally and " +
        "copies this repository's modules somewhere else, so a relative " +
        "path into node_modules/ resolves in this checkout and nowhere a pod " +
        "runs.",
      severity: "error",
      from: { path: harness },
      to: {
        path: "(^|/)node_modules/",
        dependencyTypes: ["local"],
      },
    },
    {
      name: "harness-resolves-every-import",
      comment:
        "An import the resolver cannot follow is an edge dropped from the " +
        "graph, and the rules above then judge the harness without it: a " +
        "contract missing from node_modules/ would drop every contract " +
        "import at once. So an unresolved import is itself a finding.",
      severity: "error",
      from: { path: harness },
      to: { couldNotResolve: true },
    },
    {
      name: "no-circular-dependency",
      comment: "A cycle makes the order the modules load in unanswerable.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphan-module",
      comment:
        "A module nothing reaches and that reaches nothing is dead, or a " +
        "boundary nobody crossed; either way it is not what the tree claims " +
        "to hold.",
      severity: "error",
      from: { orphan: true },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default"],
      // An imported module whose extension is not listed is a leaf the cruise
      // does not follow.
      extensions: [".mjs", ".js"],
    },
  },
};
