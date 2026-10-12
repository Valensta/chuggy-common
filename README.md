# chuggy-common

The worker core of [chuggy](https://github.com/kasofsk/chuggy): the harness that runs a ticket's work or a session inside a worker, and speaks the worker contract to chuggy's planes.

chuggy's worker image and the local companions consume it by commit. Nothing publishes it; `package.json`'s `files` is the set they copy.

```sh
npm ci
just check
```

`CLAUDE.md` holds the conventions. MIT licensed.

## The pool loop

A worker pool outside the cluster runs `poolLoop.mjs` over a backend of its own, which places, stops and lists its work, jobs and sessions each against its own ceiling, and names the work that ended of itself. `poolTokens.mjs` turns the pool's client credential into a token, `poolPlane.mjs` polls and settles over HTTP, `poolJobPlane.mjs` ends the attempt of a job that ended without reporting, `poolSessionPlane.mjs` tells a session's plane that its container ended, `register.mjs` redeems a registration token for the pool file and `poolCredentials.mjs` reads it, `poolRunner.mjs` composes them beside the runner's backend and passes until the plane denies the pool, and `control.mjs` is the running service's socket for the runner's own CLI. `poolIdentity.mjs` names what a runner keeps per pool. `containerBackend.mjs` is a backend over docker or podman on the runner's machine, a container per assignment, reaching the engine through `engine.mjs` and `engineArgv.mjs`; whether a job can be handed the Claude token file is the runner's to say. chuggy keeps its own TypeScript copy of the loop beside its Kubernetes backend; the contract's schemas are what hold the two copies to one wire.

## A personal runner

A member's personal runner is a pool file of kind `Personal`: it names its tenant and the member it serves, and no project or pool. It runs only that member's work, in the projects they allowlist for it in chuggy, and each assignment and session carries its own project, so nothing in the loop is fixed to one. A tenant administrator grants the member the right to register one; the member mints a personal registration token for the tenant through chuggy's API, `POST /api/v1/tenants/:tenant/personal-runner-registration-tokens`, and `register.mjs` redeems it when the ask is `personal`, which names no pool. A member has one runner per tenant, so registering again replaces it. `poolIdentity.mjs` keys a personal runner by tenant and owner, in forms no pool's can take.
