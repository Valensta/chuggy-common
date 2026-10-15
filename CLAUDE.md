# chuggy-common — working notes

The worker core of chuggy: the harness a worker pod runs, and that the local companions run too. chuggy's worker image and the companions consume it by commit; nothing publishes it.

## Where the knowledge is

- **Each gate's own header.** Every script in `.chug/tasks/` opens by stating the rule it enforces, and its sibling `*.test.sh` proves the rule bites. The rule and its enforcement are the same file.
- **chuggy's review brief**, [`review-change.md`](https://github.com/kasofsk/chuggy/blob/main/.chug/tasks/review-change.md). Its house rules and standing commitments bind here, for the rules no script can decide.
- **The contract is chuggy's.** `@chuggy/worker-contract` is locked to a GitHub release asset by URL and integrity. A change here that needs the contract to be different is a chuggy change and a release first, then a lock bump here.

## Layout

Every module sits at the root. `package.json`'s `files` is the shipped set: the modules, `git-askpass.sh`, `check.sh` and the build probes. Suites are `*.test.mjs` and fixtures `*.fixture.*`, and neither ships.

## Checks

```sh
just check          # every gate and the gates' own suites
```

A fresh clone needs two things once, and neither can set itself:

```sh
npm ci              # the locked contract release and the toolchain the gates run
just hooks          # git config core.hooksPath .githooks
```

A gate exits 0 clean, 1 on a finding, **2 when it could not run** — and 2 is not a pass. `check-source` runs the suites only when `check-contract` finds the locked release installed; an `npm link` to a local chuggy is a could-not-run, never a green run. The hook runs the gates without the shell suites; `--no-verify` bypasses every gate at once.

## Conventions that bite if you miss them

- **Nothing reviews its own work.** A change is reviewed by a fresh reviewer, a session that did not author it, under chuggy's review brief.
- **Docs are concise, correct, consistent and extremely minimal, and a comment is a doc.**
- **A doc that says a path, gate, command or constant exists is making a factual claim, and that claim is checked or it is marked.** A markdown line naming something this tree does not have carries a marker: `<!-- intent -->` designed but not built, `<!-- runtime -->` correctly absent from git, `<!-- absent -->` named because it does not exist. `check-paths` still resolves and prints a marked line. A path of chuggy's is named as chuggy's; `check-paths` cannot see another repository's paths, so the reviewer holds that.
- **No comment states a quantity a reader has to trust.** A figure is one the code or a suite derives, never one copied into prose.
- **A rule needs a failure it can prevent here.** Before adding one, name the thing that goes wrong in this tree without it.
- **Don't run destructive commands** without asking first.
