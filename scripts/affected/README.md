# Affected-workspace build/test selection (P3.5 Task 5)

Scopes `npm test`/`npm run build` to only the workspaces a change could
plausibly break, instead of always running every workspace in the monorepo.
Conservatively falls back to the existing full command whenever it cannot
prove a change is safely scoped — the worst case is identical to today's
behavior, never less coverage.

## Why a custom script rather than Nx/Turborepo

This is a plain `npm` workspaces monorepo with no existing task-graph tool.
Adopting Nx or Turborepo would add a second build-orchestration layer, its own
cache/remote-cache decisions, and a new config surface across every
`package.json`, for a repository of eleven workspaces with a shallow,
easy-to-enumerate dependency graph (see `workspace-graph.ts`). A ~250-line
script that reads `package.json` `dependencies` and `git diff` gets the same
affected-selection property — dependency closure plus a conservative
fallback — without that adoption cost, and it is trivial to unit test in
isolation (`select-affected.test.ts`, `workspace-graph.test.ts`), which a
config-driven tool's black-box selection logic would not be. Revisit this
decision if the workspace count or dependency graph grows enough that
hand-rolled traversal stops being the simpler option, or if remote caching
across CI runners becomes worth its own cost.

## What it does

1. Resolves a base commit: an explicit `--base <ref>`, else `origin/main`,
   else `HEAD~1` — preferring the merge-base with `HEAD` when history allows
   it, matching `packages/contracts/scripts/check-compatibility.ts`'s already-
   proven approach in this repo's CI (shallow checkouts have no merge-base to
   find, so it falls back to the base commit itself).
2. Lists every file that differs from that base in the current working tree
   (covers committed history since the base, plus anything staged, unstaged,
   or untracked locally — so a local run reflects real edits, not just the
   last commit).
3. Classifies each changed path: inside a known `apps/*`/`packages/*`
   workspace, inside an explicit safe-ignore list (`docs/`, `infra/`, `aws/`,
   `.claude/`, top-level community-health files — none of which can affect
   build or test outcomes), or unrecognized. Any unrecognized path — a root
   config file, a Dockerfile, a CI workflow, a new top-level directory —
   forces a full fallback. **Unknown always means "run everything," never
   "assume it's safe."**
4. Builds the internal (`@vinylhound/*`) dependency graph from each
   workspace's own `package.json` (read fresh every run, so it can't go
   stale) and closes the directly-changed workspaces over their transitive
   dependents: a change to `packages/contracts` affects everything that
   depends on it, directly or through another package.
5. Runs the scoped command — `vitest run <affected dirs with test files>` for
   `--mode test`, `npm run build --workspace <name> --if-present` for each
   affected workspace with a `build` script for `--mode build` — or execs the
   existing full `npm test`/`npm run build` unchanged when step 3 forced a
   fallback.

## Running it

```
npm run test:affected [-- --base <ref>] [-- --dry-run]
npm run build:affected [-- --base <ref>] [-- --dry-run]
```

`--dry-run` prints the resolved base, changed-file count, and the
selection/fallback decision without executing anything — useful for checking
what a change would trigger before running it for real.

Local `npm run check`/`npm run build` (documented in `AGENTS.md`) are
unchanged and remain the full, authoritative commands to run before handing
off a change; `test:affected`/`build:affected` are an additional, faster path
CI uses, not a replacement for the full local check.

## What is not affected-scoped

`format:check`, `lint`, and `typecheck` stay full-repo in both CI and locally.
Prettier/ESLint are already a single fast pass over the whole tree, and
TypeScript is compiled as one project (`tsconfig.json`, no project
references) rather than per-workspace, so there is no cheaper subset to
select without restructuring the compiler setup — a larger, separate decision
this task does not make.
