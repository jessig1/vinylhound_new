# ADR-0020: Relative imports name `.ts`; the web app builds with Turbopack

- Status: Accepted
- Date: 2026-09-11
- Supersedes: none

## Context

Workspace packages publish raw TypeScript — every `packages/*/package.json`
sets `"exports": "./src/index.ts"` — and `apps/web` consumes that source
directly. Inside those packages, relative imports named the emitted JavaScript
(`import { x } from "./catalog.js"`), which is what `moduleResolution:
NodeNext` requires of the worker's compiled output.

Those two facts conflict inside a bundler. `./catalog.js` does not exist at
build time; only `./catalog.ts` does. webpack bridged the gap with a
`resolve.extensionAlias` hook in `next.config.ts` mapping `.js` → `.ts`.

Next.js 16 makes Turbopack the default bundler, and **Turbopack has no
`extensionAlias` equivalent** — its configuration surface is `resolveAlias`,
`resolveExtensions`, `rules`, and `root`, none of which rewrite an extension on
a relative specifier. Running the app under Turbopack produced a module-not-
found error for essentially every cross-file import in every package. The
project had worked around this by pinning `next dev --webpack` and `next build
--webpack` in `apps/web/package.json`, which left three problems:

1. Next.js errors out on a bare `next dev`, because the config carried a
   `webpack` hook and no `turbopack` config. Anyone not using the npm script
   hit a confusing failure.
2. The pin was undocumented; nothing recorded _why_ removing it would produce
   125 module-not-found errors.
3. It anchored the app to a bundler Next.js is moving away from.

Stripping the extensions was not an option. `tsconfig.worker-runtime.json`
compiles those same packages with `module: NodeNext` and emits JavaScript that
production runs directly (`Dockerfile.worker`), and Node ESM rejects
extensionless relative specifiers.

## Decision

Invert which extension the source names.

**Relative imports in `packages/**` and `apps/worker/**` name the TypeScript
file they actually resolve to** — `./catalog.ts`, not `./catalog.js`. Bundlers
resolve that literally: webpack and Turbopack both do, with no configuration.

**`rewriteRelativeImportExtensions` restores the emitted form.** The root
`tsconfig.json` sets `allowImportingTsExtensions` and
`rewriteRelativeImportExtensions` (TypeScript 5.7+; this repo is on 6.0.3), so
`tsc` rewrites `./catalog.ts` back to `./catalog.js` on emit. The worker's
compiled Node ESM output is byte-for-byte the shape it had before.

Consequently:

- The `webpack(config)` hook is deleted from `next.config.ts`.
- `apps/web`'s `dev` and `build` scripts drop `--webpack` and use Next 16's
  default Turbopack.

`transpilePackages` stays: the packages still ship TypeScript, and Next still
has to compile it.

## Consequences

**Good.** The web app runs on Next's default and supported bundler, and dev
compiles are substantially faster. The configuration is now honest — there is
no bundler-specific resolution shim to understand, and no pinned flag whose
removal breaks the build in a way that takes an afternoon to diagnose. A bare
`next dev` works. One convention now covers every package.

**Costs.** `./foo.ts` in an import reads oddly to anyone expecting the Node ESM
convention, and it is only legal because of two compiler options — a reader who
doesn't know that will think it's a mistake. The build now depends on
`rewriteRelativeImportExtensions` behaving correctly; if that emit ever
regressed, the failure would surface at worker runtime rather than at compile
time, which is why the worker's emitted specifiers were inspected directly
rather than inferred. New code must follow the `.ts` convention, and a stray
`.js` specifier will fail to resolve under Turbopack rather than degrade
quietly.

**Verified.** `lint`, `typecheck`, `test` (122/122), `build` (Next 16.3.4
Turbopack, plus worker and evals via `tsc`), and `test:e2e` (22/23 — the one
failure is the pre-existing `live-camera` flake unrelated to bundling, which
exercises the standalone production output). Both emit paths were inspected
directly and contain only `.js` specifiers with no `.ts` leakage:
`apps/worker/dist` and the in-place output of `tsconfig.worker-runtime.json`.
A Turbopack dev server served real requests end to end — library read,
MusicBrainz catalog search returning live pressing data, and correct 404/503
error mapping — with zero module-not-found errors.

**Not decided here.** Whether packages should eventually ship compiled
JavaScript (`exports: "./dist/index.js"`) instead of raw source. That would
remove the need for both compiler options and for `transpilePackages`, at the
cost of a build step per package and the current ability to consume package
source directly. It remains the cleaner long-term boundary and is worth its own
ADR if package build times or tooling friction ever justify it.
