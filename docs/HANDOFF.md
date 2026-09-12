# Session handoff

Live state shared between the agents working in this repository (OpenAI Codex,
primary; Claude, secondary) and the maintainer. Every agent session that
changes files or reaches a decision must update this file before ending. The
sections above the session log describe current state only; history belongs in
the log.

## How to resume

1. Read "Current state" and "Resume point" below.
2. Verify the claimed state cheaply (`git status`, `npm run check`) before
   building on it.
3. Do the work, update this file, and append a session-log entry.

## Current state — verified 2026-09-11

- **`apps/web` now builds and runs on Turbopack; the `--webpack` pin and the
  `next.config.ts` webpack hook are deleted (ADR-0020).**
  The root cause of the pin: workspace packages export raw TypeScript
  (`"exports": "./src/index.ts"`) whose relative imports named the _emitted_
  file (`./catalog.js`), which is what the worker's `NodeNext` output
  requires. In a bundler that file does not exist — only `./catalog.ts` does
  — and webpack papered over it with a `resolve.extensionAlias` hook.
  **Turbopack has no `extensionAlias` equivalent** (its surface is
  `resolveAlias`, `resolveExtensions`, `rules`, `root`), so running Turbopack
  produced a module-not-found error for nearly every cross-file import in
  every package. Confirmed by probe, not assumed.
  Fixed by inverting which extension the source names: relative imports in
  `packages/**` and `apps/worker/**` now say `./catalog.ts`, which both
  bundlers resolve literally with no configuration, and the root
  `tsconfig.json` sets `allowImportingTsExtensions` +
  `rewriteRelativeImportExtensions` so `tsc` rewrites them back to
  `./catalog.js` on emit. 126 specifiers across 60 files, rewritten by script
  that only touched a specifier when a real `.ts`/`.tsx` sibling existed, so
  no genuine `.js` asset could be broken — zero were skipped, meaning every
  one had a TS sibling.
  **The load-bearing check is the worker's emitted output**, because a
  regression there would surface at production runtime rather than at compile
  time. Both emit paths were inspected directly, not inferred:
  `apps/worker/dist` and the in-place output of
  `tsconfig.worker-runtime.json` (which `Dockerfile.worker` runs and copies)
  contain only `.js` relative specifiers, with no `.ts` leakage.
  Verified: `lint`, `typecheck`, `test` (122/122), `build` (banner confirms
  "Next.js 16.3.4 (Turbopack)", plus worker and evals via `tsc`), `test:e2e`
  (22/23 — the one failure is still the pre-existing `live-camera` flake, and
  that suite builds and serves the standalone production output, so Turbopack
  standalone is covered). A Turbopack dev server also served real requests:
  library read 200, MusicBrainz catalog search returning live pressing data
  200, catalog unknown-MBID 404, discovery malformed-id 404, discovery search
  503 — zero module-not-found errors. One transient 502 from MusicBrainz
  during that run did not reproduce across three retries; it was their rate
  limit, not a regression.
  **New convention, recorded in `AGENTS.md`:** relative imports in packages
  and the worker name `.ts`. A `.js` specifier will now fail to resolve in
  `apps/web` rather than degrade quietly, so new code has to follow it.
  Not done: packages still ship raw TypeScript. Moving them to compiled
  `exports: "./dist/index.js"` would remove the need for both compiler
  options and for `transpilePackages`, and is the cleaner long-term boundary,
  but it is a build-pipeline change across nine packages touching Docker, CI
  and e2e — flagged in ADR-0020 as deserving its own ADR rather than folded
  in here.

- **Live verification against real Spotify found one blocker and two real
  defects. The blocker is external and unfixed in code.**
  **Blocker:** Spotify answers `GET /v1/search` with `403 "Active premium
subscription required for the owner of the app. When the subscription
status changes, it can take a few hours before requests are allowed
again."` The client-credentials token mints fine (status 200,
  `expires_in` 3600), so the credentials in `.env` are valid — Spotify is
  refusing _data_ requests because the account that owns the app in the
  developer dashboard has no active Premium subscription. **No code change
  fixes this.** The options are: put Premium on the account that owns the
  app, move the app to an account that has it, or change discovery provider
  (Deezer has a free public API; MusicBrainz plus Cover Art Archive is the
  other option, at the cost of the 1 req/s ceiling that motivated ADR-0019).
  Until one of those happens `/discover` will show Spotify's refusal text and
  the rest of the app is unaffected, exactly as the optional-provider design
  intends.
  **Defect 1, pre-existing and not mine — `instanceof` across the
  `@vinylhound/catalog` boundary was broken again.** Every error thrown
  inside that package was misclassified as `500 internal_error`. This was
  _not_ limited to the new discovery code: `GET
/catalog/releases/{unknown-mbid}` returned 500 instead of `404
catalog_not_found`, which is precisely the bug the P3.3 Task 1 session
  believed it had fixed by adding `@vinylhound/catalog` to
  `transpilePackages`. That fix evidently did not hold. Diagnosis was clean:
  `HttpError`, defined locally in `http.ts`, mapped correctly to 400, while
  both package-defined error classes fell through to 500 — so the defect is
  error _identity_, not the branches. Fixed durably by not depending on
  module identity at all: `CatalogProviderError` and `DiscoveryProviderError`
  each carry a branded `errorKind` field, and `http.ts` now uses the exported
  `isCatalogProviderError` / `isDiscoveryProviderError` guards instead of
  `instanceof`. **Prefer those guards over `instanceof` for these classes
  anywhere they cross a package boundary.** The underlying duplication is
  still there and is worth understanding separately — it could bite any
  other cross-package `instanceof` — but error mapping no longer depends on
  it. Verified live: `/catalog/releases/{unknown}` and
  `/discovery/artists/{malformed}` both return 404, catalog search still 200.
  **Defect 2 — a 403 was reported as a generic failure.** The adapter mapped
  every non-401/404/429 status to `provider_unavailable` with the fixed text
  "Spotify could not answer the request", discarding the body. That turned a
  one-sentence diagnosis into a long one. Non-ok responses now have their
  reason read (JSON `error.message`, `error_description`, or raw text, capped
  at 300 characters); 401 and 403 map to `not_configured` (503) carrying
  Spotify's own words, and other failures include the upstream status.
  `/discover` shows the server's message rather than fixed
  "add credentials" copy, which would have pointed at the wrong fix here
  since credentials _are_ configured.
  Also added: `errorResponse`'s catch-all now logs name/message/constructor/
  top stack frame before returning 500. A 500 with no server-side log is what
  made this take as long as it did.
  Verified after the fixes: `npm run lint`, `npm run typecheck`, `npm test`
  (122/122, +2), `npm run build`, `npm run test:e2e` (22/23 — the one failure
  is still the pre-existing `live-camera` flake). Live checks were run on an
  isolated dev server (`NEXT_DIST_DIR=.next-diag npx next dev --webpack
--port 3123`), leaving the maintainer's server on 3000 untouched.
  **Note for anyone starting an isolated dev server:** the project's script is
  `next dev --webpack`. A bare `npx next dev` picks Turbopack (the Next 16
  default), which errors out because `next.config.ts` has a `webpack` config
  and no `turbopack` config. Migrating that config, or setting `turbopack:
{}` deliberately, is unfinished business worth its own look.

- **`/discover` now runs on Spotify as a separate discovery provider;
  MusicBrainz stays the catalog provider for scan review and pressing
  identity (ADR-0019). P3.3 Task 1 is revised and Task 3 is complete.**
  The maintainer asked to rebuild discovery to match the previous VinylHound
  implementation (jessig1/vinylhound-frontend, jessig1/vinylhound-backend),
  whose search was one free-text box returning Artists/Albums/Tracks with
  artwork and a click-through to artist discography and album tracklist.
  That UX is now in place at `/discover`, `/discover/artists/{id}` and
  `/discover/albums/{id}`: 350ms debounce, minimum 2 characters, `?q=` URL
  state so a search is shareable and back-navigable, and an `AbortController`
  per search so a slow response can never overwrite a newer one.
  **This is deliberately not a provider swap.** Spotify has no pressing
  entity — no catalog number, country, format, packaging or release status —
  so replacing MusicBrainz would have emptied exactly the fields scan review
  collects. Spotify is the better browse provider (relevance, inline artwork,
  artist-first navigation, no 1 req/s ceiling); MusicBrainz is the one that
  models physical editions. The split is structural, not conventional:
  `CatalogProvider` vs `DiscoveryProvider` ports, `catalog.ts` vs
  `discovery.ts` contracts, `/catalog/*` vs `/discovery/*` routes.
  **The honesty of a Spotify-sourced record is enforced by schema, not by
  convention.** `CatalogReferenceSchema` gained a nullable `releaseId`:
  required for MusicBrainz, rejected as non-null for Spotify. Null states
  that the provider models no pressing. `resolveReviewedRelease` — extracted
  from `confirmScan` into `packages/database/src/release-resolution.ts` and
  now shared by both save paths — uses a provider reference for release
  identity only when it names a pressing, so a Spotify record dedupes on
  normalized attributes like a hand-entered one and two real pressings stay
  two releases. Catalog number, country, format, packaging and release status
  are saved null, never guessed; only `label` and the UPC/EAN `barcode` carry
  over. `/discover` says this in words on the save control too.
  Task 3's placement is `POST /library` (`PlaceLibraryReleaseSchema`),
  idempotent by identity rather than by key: upsert on
  `(user_id, release_id)`, `collection` outranks `wishlist`, and an owned copy
  is created only when the item has none yet. No `scan_confirmations` row and
  a null `confirmedFromScanId`, because no scan was reviewed. Account export
  and deletion needed no change and were checked, not assumed: placement
  writes only to the user-scoped `library_items`/`library_copies` that export
  already selects by `userId` and that cascade from the `users` delete.
  Persistence needed one additive migration,
  `015_spotify_discovery_provider.sql` (`ALTER TYPE catalog_provider ADD
VALUE 'spotify'`). `catalog_references.external_id` was already
  `varchar(255)` with a `(provider, entity_type, external_id)` unique index,
  so Spotify's 22-character base-62 IDs needed no column change and cannot
  collide with MBIDs. **This migration has not been run against a database
  yet** — `npm run db:migrate` needs `docker compose up -d`, which was not
  started this session. Run it before exercising save-from-discover locally;
  every unit/e2e check below is infrastructure-free and did not need it.
  Discovery is optional per deployment: with `SPOTIFY_CLIENT_ID`/
  `SPOTIFY_CLIENT_SECRET` unset, `context.discovery` is null, the routes
  answer `503 discovery_not_configured`, and `/discover` explains itself.
  Scanning, review, confirmation and the library are unaffected, so CI and a
  fresh clone keep working with no credentials. Credentials are server-side
  only, never `NEXT_PUBLIC_*`.
  Verified: `npm run lint`, `npm run typecheck`, `npm test` (120/120, +17 net
  new), `npm run build`, `npm run test:e2e` (mobile Chromium, 22/23 — the one
  failure is the same pre-existing `e2e/live-camera.e2e.ts` flake that
  reproduces on clean `main`). `e2e/discover.e2e.ts` was rewritten to stub
  `/api/v1/discovery/*` and covers the three-section search, `?q=` state, the
  search → artist → album walk, saving to the library while asserting no
  pressing field is invented and the reference claims no pressing, the
  unconfigured-deployment message, and the empty-result state — zero axe
  WCAG 2 A/AA violations on both the search and album pages. `format:check`
  still fails only on generated `apps/web/next-env.d.ts` (no working-tree
  diff against its last commit; pre-existing Windows CRLF artifact).
  **Not done and worth knowing:** the discovery token/response cache is an
  in-process `Map`, so it does not coordinate across `apps/web` replicas —
  the same limitation the MusicBrainz limiter has, and the reason ADR-0019
  flags moving it to the Redis already in the stack. `/discover` has not been
  exercised against the real Spotify API; every test uses a stubbed `fetch`,
  so the adapter's mapping is proven against Spotify's documented shapes but
  not yet against live responses. Doing that needs real client credentials in
  `.env`.

- **P3.3 Task 1 — independent catalog search/details — is complete.**
  **Superseded in part by the Spotify rebuild above:** the MusicBrainz
  `GET /catalog/releases` search and `GET /catalog/releases/{releaseId}`
  detail endpoints described here are unchanged and still back the scan
  review screen's "Search MusicBrainz" step, but `/discover` no longer calls
  them — it is a Spotify surface now. The `transpilePackages` bug and its fix
  below remain accurate and load-bearing.
  `/discover` lets a user search MusicBrainz by artist/title with no scan
  involved, reusing the pre-existing `GET /api/v1/catalog/releases` search
  endpoint (the scan review screen's "Search MusicBrainz" step and
  `/discover` are two independent callers of the same route — it never
  needed a scan in the first place, it just had no standalone UI before this
  session). Results group client-side by `reference.releaseGroupId` so
  multiple pressings of one album render under a single album heading. A new
  `GET /api/v1/catalog/releases/{releaseId}` endpoint and
  `CatalogProvider.getReleaseDetails` port method (`packages/catalog`) fetch
  one pressing's full detail — track listing, full label/format data, and
  `releaseGroupTitle` (shown explicitly when it diverges from the selected
  pressing's own title) — sharing the MusicBrainz adapter's existing
  one-request-per-second limiter and 24-hour cache with search.
  `reference.releaseGroupId` (album concept) versus `reference.releaseId`
  (this specific pressing) is the machine-readable release-concept/pressing
  distinction the roadmap asked for; the detail panel also states in copy
  that a cover or title match never proves the pressing on hand. `/discover`
  is read-only — no add/save action, since catalog-to-wishlist placement is
  P3.3 Task 3.
  **Found and fixed a real, previously-latent bug while verifying against
  live MusicBrainz data**: `@vinylhound/catalog` was missing from
  `apps/web/next.config.ts`'s `transpilePackages` (every other first-party
  workspace package used by `apps/web` was already listed; catalog was
  simply omitted when it was added). This caused `CatalogProviderError`
  thrown inside the package to fail its `instanceof` check in
  `apps/web/src/server/http.ts`'s `errorResponse` — webpack bundled two
  non-identical copies of the class across the server module graph — and
  surface as a bare `500 internal_error` instead of the correct status. This
  silently affected every pre-existing `CatalogProviderError` category
  (`rate_limit`, `provider_unavailable`, `invalid_response`) too, not just
  the new `not_found` case added for a missing release ID; it was simply
  never exercised end-to-end through a real web route before. Confirmed live
  against the real MusicBrainz API on an isolated dev-server instance both
  before the fix (unknown release ID → wrong `500`) and after (→ correct
  `404 catalog_not_found`), alongside real search/detail/400 paths.
  Verified: `npm run check` (103/103 unit tests, +10 net new across
  `packages/contracts/src/catalog.test.ts` and
  `packages/catalog/src/musicbrainz-catalog.test.ts`), `npm run build`, and
  `npm run test:e2e` (mobile Chromium, 18/19 — see the one pre-existing
  unrelated flake noted below) including a new `apps/web/e2e/discover.e2e.ts`
  that stubs `/api/v1/catalog/releases*` (matching `scan-flow.e2e.ts`'s
  existing convention of never hitting real MusicBrainz in CI) and zero axe
  WCAG 2 A/AA violations on the new page. Desktop sidebar and mobile bottom
  nav both gained a "Discover" entry; the mobile nav's CSS grid moved from 5
  to 6 columns, reverified at a 360px viewport with no horizontal overflow.
  **Pre-existing, unrelated flake found during verification, not fixed
  here**: `e2e/live-camera.e2e.ts`'s first test ("live camera captures once
  while held, rearms after change, and resumes after a pause") fails
  consistently and reproduces identically on a clean, unmodified `main`
  (confirmed via `git stash` before restoring this session's changes) — it
  predates this session and is not something Task 1 touched or is scoped to
  fix; whoever picks up P3.2-adjacent work next should know it's currently
  red on `main`, not just flaky in this session.
  Full detail is in `docs/ROADMAP.md`'s P3.3 section.

- **P3.2 — guided automatic mobile capture — is closed.** `/scan` retains its existing file-upload path and adds an explicitly
  opt-in `getUserMedia` live-camera viewfinder requesting the environment-facing
  camera where available. A low-resolution frame sampler waits for a steady
  frame, writes exactly one canvas-generated JPEG as a normal independent
  session record, then enters `disarmed`; it must observe a material frame
  change for two samples before passing through `rearmed` and returning to
  `armed`. The state is also communicated in the UI, so a held cover cannot
  repeatedly add records. Task 2 adds a distinct paused state that releases all
  camera tracks when quota/queue capacity is blocked, the tab backgrounds, or a
  stream/track ends unexpectedly;
  resume is explicit and file upload remains available. Stopping the live camera
  and component cleanup also stop every media track; permission/unsupported
  failures surface an error while the upload fallback remains usable. P3.2 Task 3
  repaired the isolated Playwright standalone assembly so it copies `.next-e2e`'s
  static assets and client components hydrate; the existing MIME-sniffing, HEIC,
  independent-record, upload, focus, and mobile-browser tests now execute again.
  Task 4 adds deterministic stubbed-`getUserMedia` browser coverage for one
  capture while held, rearming after a material frame change, background
  pause/track release/explicit resume, and permission-denial file fallback.
  A session now also rolls over from a full 20-record batch: concurrent failed
  creates share one idempotently-created next batch and retry there, while the
  review UI retains links to earlier batches.
  `docs/TESTING.md` supplies the iPhone Safari and Android Chrome protocol and
  its sanitized-results fields. The maintainer completed the physical-device
  protocol and confirmed the nine-of-ten / zero-duplicate gate on both targets;
  the result details remain private as required.

- **`deploy-staging.yml`'s single job now runs on a native arm64 runner
  instead of `ubuntu-latest` (amd64).** Follow-up to "any other changes that
  would make pipelines faster/more efficient" — this session had already
  watched the "Build and push web"/"Build and push worker" steps
  (`platforms: linux/arm64` via `docker/build-push-action`) take several
  minutes each during earlier verification, because an amd64 runner cross-
  building for arm64 goes through QEMU emulation. Confirmed via `WebSearch`
  (GitHub Changelog, 2025-08-07 and 2026-01-29) that `ubuntu-24.04-arm` is
  GA and free for public repositories (this one) before using the label, to
  avoid recommending something that would just fail with "no runner
  matches." This is the only `platforms: linux/arm64` cross-build in the
  repo's automatic pipeline: `platform.yml`'s container-scan build doesn't
  set `platforms:` at all (defaults to the runner's own arch, already
  native amd64, since it only needs a loadable image for Trivy, not a
  deployable one), and `deploy-production.yml` never builds images itself —
  it reuses staging's already-pushed, staging-verified digests. Every other
  step in the same job (Terraform, AWS CLI, curl smoke tests) is I/O-bound
  against AWS APIs, not CPU-bound, so moving the whole job to arm64 rather
  than only the two build steps (which YAML can't express — `runs-on` is
  job-scoped, not step-scoped) costs nothing for the rest of the job.
  Not yet verified by a real run — the next manual `deploy-staging.yml`
  dispatch is the actual confirmation that the native build works and is
  faster; check that before assuming this is closed. Also not yet
  addressed: Terraform provider-plugin caching (lower priority now that
  `Platform`'s Terraform job is gated to infra changes only) and whether
  `platform.yml`'s amd64 CI scan build duplicates work the arm64 deploy
  build already does — flagged to the maintainer as unverified rather than
  guessed at.

- **`Platform`'s Terraform validate job now only runs when infrastructure
  actually changed; the container build/Trivy scan job is deliberately
  unchanged and still runs on every push/PR.** The maintainer asked whether
  `Platform` could be manual or scoped to infra changes instead of running
  on every push. Both of `Platform`'s jobs are infra-adjacent but not
  equally infra-_specific_: Terraform/kubeconform validation genuinely only
  matters when `infra/terraform/**` or `infra/kubernetes/**` change, but the
  container scan validates whatever `Dockerfile.*` actually builds today —
  including plain dependency bumps like the Next.js CVE fixed earlier this
  session, which touched only `apps/web/package.json`. Scoping the whole
  workflow to infra paths would have silently stopped catching exactly that
  class of bug, so it was called out and the maintainer chose to split the
  two rather than gate both.
  Implementation: a new `changes` job in `.github/workflows/platform.yml`
  diffs `infra/terraform`, `infra/kubernetes`, and the workflow file itself
  against the right base (`pull_request.base.sha` for PRs, `github.event
.before` for pushes; falls back to `infra=true` when there's no usable base
  — e.g. a new branch), then `terraform`'s `if:` gates on that output or a
  manual `workflow_dispatch` (also newly added to `Platform`'s triggers, so
  a full run including the infra checks can be forced on demand — the
  "manual" half of the maintainer's question, alongside "only if infra
  changed" as the default). `terraform-plan`'s `if:` gained an explicit
  `needs.terraform.result == 'success'` check, since setting a job's own
  `if:` replaces the implicit `needs`-success gating GitHub Actions would
  otherwise apply — without that, a skipped `terraform` job could
  (depending on evaluation order) still let `terraform-plan` attempt to run.
  The `containers` job was not touched at all: same triggers, same matrix,
  same Trivy config.
  Deliberately did _not_ rename the workflow or its `terraform`/`containers`
  job names, and did not split them into separate workflow files — branch
  protection's required status checks are pinned to exact context strings
  (`Platform / Terraform validate`, `Platform / Container build and scan
(web|worker|worker-lambda)`, confirmed via `gh api repos/.../branches/main
/protection`), and a `skipped` job conclusion satisfies a required check the
  same way `success` does, so gating with `if:` inside the existing workflow
  needed zero branch-protection reconfiguration. Renaming or splitting into
  a new workflow file would have changed those context strings and left
  every future PR blocked on a check that no longer gets reported, until
  someone manually updated the branch protection rule.
  Verified: `git diff --name-only <base> <head> -- infra/terraform
infra/kubernetes .github/workflows/platform.yml` run by hand against real
  commit pairs in this repo's own history — correctly `true` for the
  Aurora-auto-start commit (touched `infra/terraform/environment/
outputs.tf`), correctly empty/`false` for the manual-triggers commit (only
  touched a deploy workflow and docs), and correctly `true` for this
  session's own uncommitted edit to `platform.yml` itself (self-referential
  path match). `terraform fmt -check -recursive infra/terraform` and
  `terraform validate` against both affected roots still pass. YAML syntax
  of both edited workflow files verified with `js-yaml` (no local
  `actionlint` available on this machine). Did not push yet as of writing
  this entry — the next push (which touches `platform.yml` itself) will be
  the live confirmation that `terraform` actually runs and `containers`
  still runs unconditionally; check that before assuming this is closed.

- **Staging and production deploys are now both manual `workflow_dispatch`
  jobs; only `deploy-development.yml` still triggers automatically on a push
  to `main`.** Follow-up to the pipeline investigation below, at the
  maintainer's explicit request ("let's make staging and production manual
  jobs"). `deploy-staging.yml` previously ran on every push to `main` in
  addition to `workflow_dispatch`; the `push:` trigger is now removed, so
  nothing deploys to staging without someone deliberately running the
  workflow. `deploy-production.yml` was already `workflow_dispatch`-only —
  unchanged. Practical consequence worth knowing: staging no longer produces
  a `staging-passed-<sha>` verified image tag automatically per merge: a
  production deploy (which requires a staging-verified SHA) now needs
  someone to manually run `deploy-staging.yml` for that commit first, where
  it previously happened for free on every merge. `docs/OPERATIONS.md`'s
  "Just-in-time lifecycle" section is updated to describe development,
  staging, and production as three now-differently-triggered workflows
  instead of one "every merge" sentence covering development+staging
  together. No workflow depends on `deploy-staging.yml` via `workflow_run`
  or similar, so this was a clean, self-contained removal — confirmed by
  grepping every workflow file for a reference to it before making the
  change.
  Also folding in something the previous same-day session should have
  recorded here but didn't (commit `d6c37fe` shipped with no `docs/
HANDOFF.md` update, breaking this file's own "update before ending" rule —
  flagging the miss so it doesn't repeat): both deploy workflows now run a
  new `scripts/aws/ensure-database-available.sh` right after creating the
  persistent foundation, which starts an administratively-`stopped` Aurora
  cluster and waits (up to 20 minutes) for it to become `available` before
  anything tries to connect — the actual automation of the safeguard the
  session below manually improvised. New `db_cluster_identifier` Terraform
  output in both `infra/terraform/environment` and `infra/terraform/
production` feeds it the real cluster id. Verified live: pushed, watched
  `Deploy staging` run the new step as a fast no-op against the
  already-`available` staging cluster, then pass migrations/deploy/smoke
  test/deactivate end-to-end.

- **Fixed two real, reproducible CI/CD pipeline failures the maintainer
  reported.** (1) The Platform workflow's Trivy container scan
  (`.github/workflows/platform.yml`, `exit-code: "1"` on CRITICAL/HIGH) was
  failing on all three images (web, worker, worker-lambda) with a CRITICAL
  finding: CVE-2026-75604 / GHSA-2xp9-vwfh-vxw4, an unauthenticated RCE in
  Next.js's Image Optimization API, present because `next` was pinned at
  `16.3.2` in `apps/web/package.json`. All three images carry it despite only
  `web` using Next.js, because npm workspaces hoists every workspace's
  dependencies into one root `node_modules` and each `Dockerfile.*` copies it
  wholesale (`COPY --from=build .../node_modules ./node_modules`) rather than
  a per-app pruned subset — worth knowing if a future single-workspace CVE
  shows up failing all three scans again. Bumped to `16.3.4`
  (`apps/web/package.json`, `package-lock.json`); rebuilt all three images
  locally and re-ran the exact `aquasecurity/trivy-action` scan CI uses to
  confirm: web/worker clean, worker-lambda's sole remaining finding
  (CVE-2026-14456, OpenSSL in AWS's Lambda base image) is the pre-existing,
  still-valid `.trivyignore` waiver (`exp:2026-10-05`), not a new failure.
  Committed `13b9d5e`; Platform/CI/Security all pass on it.
  (2) `Deploy staging`'s "Run database migrations" step
  (`.github/workflows/deploy-staging.yml:155`, which runs
  `scripts/aws/run-worker-command.sh migrate`, an ECS Fargate task
  invocation) was failing deterministically across the last several commits
  — reproducible, not flaky. GitHub's own Actions log only shows the ECS
  task's exit code, not its application output, and downloading full logs
  via the REST API requires an authenticated token (`gh auth login`, device
  flow — the maintainer authorized this live in-session; a prior
  unauthenticated attempt correctly failed with `403 Must have admin
rights`). Once authenticated, `gh run view --log-failed` plus
  `aws logs get-log-events` against
  `/vinylhound/staging/worker`/`worker/worker/<taskId>` (also needed a fresh
  `aws login`, since the maintainer's AWS session had expired exactly as
  documented below) surfaced the real error: `could not connect to postgres:
Error: timeout expired`, thrown from node-pg-migrate's own connect handler.
  First hypothesis (wrong, but not useless — see below): Aurora Serverless
  v2's ordinary 0-ACU auto-pause/resume taking longer than the migration
  task's single `DATABASE_CONNECT_TIMEOUT_MS` (30s default,
  `.env.example:18`). Fixed `apps/worker/src/migrate.ts` to wrap the
  `runDatabaseMigrations` call in a bounded retry (5 attempts, 15s apart)
  rather than touching `run-worker-command.sh`'s own ECS-level retry (which
  deliberately does not retry real application exit codes, to avoid masking
  genuine migration bugs in CI feedback). Safe to retry blindly because
  `runDatabaseMigrations` runs every migration in one transaction
  (`singleTransaction: true`, `packages/database/src/migrations.ts`): a
  failed attempt commits nothing. Committed `973b9e9` and pushed — **and the
  retry fix alone did not resolve it**: the rerun still failed all 5 attempts
  with the identical error over ~4 minutes, which is far longer than
  Serverless v2's normal resume (confirmed from real RDS event history,
  below, to be ~15s).
  That forced the real investigation: `aws rds describe-db-clusters` showed
  `vinylhound-staging` (and separately, `vinylhound-production`) in AWS
  `Status: stopped` — a distinct, explicit administrative stop, not
  serverless auto-pause; a stopped cluster does not respond to connections
  at all, and nothing auto-resumes it. `aws rds describe-events
--source-identifier vinylhound-staging --source-type db-cluster --duration
20160` gave the full picture: many fast (~15s) `Initiated
pause`/`Successfully resumed` cycles through 2026-09-06/07 confirming normal
  Serverless v2 behavior is not the problem, then a `DB cluster stopped`
  event at `2026-09-07T22:09:17Z` — timed exactly to this file's own
  record of deliberately winding down Phase 2 staging/production
  infrastructure that day. `deploy-staging.yml` still runs automatically on
  every push to `main`, so every push since 2026-09-07 was triggering a
  staging deploy doomed to fail at the migration step, independent of any
  code change. Nothing in this repository (`infra/terraform`,
  `.github/workflows`, `scripts/`) issues `stop-db-cluster`/`start-db-cluster`
  anywhere, confirming the stop was a manual out-of-band action, not pipeline
  behavior.
  Asked the maintainer how to proceed (start the cluster now / also add
  pipeline auto-start / leave it stopped and gate the auto-deploy instead);
  they chose to just start it. Ran `aws rds start-db-cluster
--db-cluster-identifier vinylhound-staging`, polled `describe-db-clusters`
  until `Status: available` (~9.5 minutes: `starting` → `backing-up` →
  `available` — a full cluster start is much slower than serverless
  auto-resume), confirmed the writer instance was also `available`, then
  `gh run rerun 34428899746 --failed` to retry the already-failed run rather
  than pushing an empty commit. **The rerun completed with a genuine
  success**: migrations, service deploy, and smoke test all passed. The
  `migrate.ts` retry fix is still worth keeping — the RDS event history
  proves ordinary Serverless v2 resume is fast but real, and the retry is
  cheap insurance against exactly that case recurring — but it was not, on
  its own, what fixed this pipeline run.
  This says nothing about whether staging's Aurora should have stayed
  stopped as a cost decision; the maintainer's own call at the time was to
  restart it, not to change that policy. **Superseded later the same
  session** — see "Current state" for the auto-start safeguard added
  afterward, and for staging/production being converted to manual-only
  triggers.

- **Supabase migration-metadata hardening is pending deployment.** Migration
  014 enables RLS on node-pg-migrate's `public.vinylhound_migrations` table
  and revokes `PUBLIC`, `anon`, and `authenticated` privileges. The latter two
  are conditional because local/AWS PostgreSQL does not create Supabase roles.
  This leaves the migration-table owner able to run migrations, but prevents
  PostgREST API roles from reading or changing schema history. Apply it to the
  Supabase environment with `npm run db:migrate` (or the normal deployment
  migration step); it has not been applied by this local-only session.

- **P3.1 Task 7: persistent-spend inventory is complete, and P3.1 is now
  fully complete (all 7 tasks checked in `docs/ROADMAP.md`).** This session
  first re-verified Task 6 against the code rather than trusting the prior
  session's writeup: confirmed `withRoute` (`apps/web/src/server/http.ts`) is
  used by all 20 `apps/web/src/app/api/v1/**` routes and that `correlation_id`
  columns exist on both `outbox_messages` and `scan_attempts`
  (`packages/database/src/schema.ts:183,319`) — the claim held.
  For Task 7, added a new "Persistent spend inventory (pre-P3.5)" section to
  `docs/OPERATIONS.md`, grounded in the actual Terraform rather than
  estimates: what is billed today independent of `environment_active`
  (development's always-live Lambda/API Gateway runtime; Aurora storage in
  both staging and production despite `min_capacity = 0` compute,
  `infra/terraform/environment/database.tf:29-31`,
  `infra/terraform/production/foundation.tf:177-179`; versioned S3 buckets in
  all three environments; nine Secrets Manager secrets total; and continuous
  CloudWatch Logs retention, now also carrying Task 6's new structured-log
  volume) versus what the hourly TTL sweep genuinely removes (NAT gateway,
  ECS/ALB, EKS/internal ALB/CloudFront/WAF — all Terraform
  `count = local.active_count`). It also names the unknowns P3.5 Task 1 must
  resolve to reconcile the $25 total (actual Aurora/S3 storage cost, the
  development database's external hosting cost, real staging/production
  activation-hour cadence, Task 6's added log volume, and actual aggregate
  OpenAI spend against the $20 per-user default). This is deliberately an
  inventory, not the reconciliation — no code changed, matching the roadmap's
  own scoping of Task 7 versus P3.5 Task 1.
  While building it, found and fixed one real doc gap: staging's own $20
  budget alarm (`infra/terraform/environment/monitoring.tf:125-128`) existed
  in Terraform but was never mentioned in `docs/OPERATIONS.md`'s budget
  paragraph, which previously named only development's $10 and production's
  $25.
  Verified on the current tree (not just re-stated from docs): `npm run
lint` and `npm run typecheck` clean; `npm run test` 95/95 unit tests;
  `npm run build` succeeds (all 25 web routes present, worker/evals compile);
  `npm run test:integration` 42/42 (database 34, storage 1, queue 1, worker 6) against the already-running local Compose stack. `npm run check`'s
  `format:check` step fails only on `apps/web/next-env.d.ts`, a generated
  file with no working-tree diff (`git status` confirms it matches the last
  commit, `095b0c4`) — pre-existing and untouched by this session, not fixed
  here since CLAUDE.md's Windows notes warn against "fixing" line-ending/
  generated-file noise. `docs/OPERATIONS.md` itself needed one
  `prettier --write` pass after the initial edit (prose line wrapping).
  Committed, tagged `phase-3-p3.1`, and pushed to `origin/main`.

- **P3.1 Task 5: reconciling active-scan/batch/daily-attempt/worker-concurrency
  defaults and defining rollover/pause-resume/exhaustion behavior is
  complete.** This closes out the partial progress the same-day Task 4
  session had already left in `docs/ROADMAP.md`: the four defaults'
  reconciliation, queue-pressure pause/resume, and daily/spend exhaustion
  behavior were already implemented (`GET /api/v1/quota`, the early admission
  check inside `createOrGetScan`, abandoned-upload cleanup) and documented in
  `docs/OPERATIONS.md`'s "Reconciling the defaults" and "Queue-pressure
  pause/resume" sections — nothing there needed further code or doc changes.
  The one real gap was batch rollover: the roadmap task asks to _define_ it,
  and the existing text only recorded a deferral decision ("implementation
  waits for P3.2") without saying what the behavior actually is. This session
  wrote that definition into `docs/OPERATIONS.md`'s "Batch rollover" section
  (no code changed, since implementation genuinely is P3.2's continuous-
  capture state machine, not reachable from today's one-shot `/scan` picker
  which already hard-caps a session at `MAX_SCANS_PER_BATCH` client-side):
  a continuous session tracks an ordered list of batch IDs instead of one,
  rolls over by calling `POST /batches` again — reacting to the server's
  already-existing but previously unconsumed `batch_scan_limit` rejection
  (`packages/database/src/scan-repository.ts:154-158`) or a proactive
  client-side count, either is valid — and composes the existing
  `POST /batches`/`POST /scans` primitives (ADR-0006) with no schema or
  contract change; review-later navigation and the persisted `localStorage`
  queue key on the session's batch list rather than a single ID; and quota
  headroom is unaffected by rollover since `USER_ACTIVE_SCAN_LIMIT`/
  `USER_DAILY_ANALYSIS_LIMIT` count scans regardless of batch, so a rollover
  at an exhausted-quota boundary uses the same pause/resume behavior as any
  other quota block rather than a separate failure mode.
  No verification commands were run beyond reading the affected code
  (`scan-repository.ts`'s `createOrGetScan`/`batch_scan_limit` path) to confirm
  the definition matches current behavior — this task changed only
  `docs/ROADMAP.md` and `docs/OPERATIONS.md`, no application code, contracts,
  or tests.

- **P3.1 Task 6: structured request/error timing and correlation IDs is
  complete.** Every `apps/web` API route (20 files under
  `apps/web/src/app/api/v1/**`) now shares one `withRoute` wrapper
  (`apps/web/src/server/http.ts`) instead of hand-rolling its own
  `createRequestId`/try-catch/`errorResponse` triplet: it mints the existing
  self-generated `requestId` (unchanged `x-request-id` response contract,
  still `z.string().uuid()` in `ApiErrorSchema`), reads and validates an
  inbound `x-request-id` header as an optional, untrusted `correlationId`
  (`CorrelationIdSchema`, new `packages/contracts/src/common.ts`: trimmed,
  1-200 chars, `[A-Za-z0-9._-]+` only — an absent or malformed value is
  dropped, never rejected, since it is metadata, never identity), and logs one
  `[web] http_request` line (route, method, status, `durationMs`, `requestId`,
  `correlationId`) on every request whether it succeeds or throws. Two probe
  routes (`/api/healthz`, `/api/readyz`) were deliberately left unwrapped —
  no user identity, hit constantly by load balancers, and per-hit structured
  logging there would add log volume disproportionate to their purpose against
  the $25/month budget ceiling.
  The correlation ID is forwarded past the HTTP boundary: `AnalyzeScanJobSchema`
  (`packages/contracts/src/scan.ts`) gained an optional `correlationId` field
  (still `.strict()`; optional means every already-queued JSONB payload
  without it still parses), and migration 013 added a nullable, length-checked
  `correlation_id` column to both `outbox_messages` and `scan_attempts`
  (`packages/database/src/schema.ts`). `submitScan` and `retryScan`
  (`packages/database/src/scan-repository.ts`) accept an optional
  `correlationId` and write it onto both the job payload and the outbox row;
  `prepareScanAnalysis` (`packages/database/src/analysis-repository.ts`)
  copies `job.correlationId` onto the `scan_attempts` row it creates or resets
  on redelivery. `POST /scans/{scanId}/submit` and `.../retry` are the two
  routes that actually thread the request's `correlationId` through (the
  earlier `POST /scans` admission check has no job/outbox row to attach one
  to). One caller-supplied trace value can now be grepped across the HTTP
  request, the queued job, and the worker attempt it produces — never used
  for lookups, joins, or authorization at any hop.
  Timing was split into named phases rather than one opaque duration, without
  adding new `scan_attempts` columns (reusing the existing bundled
  `duration_ms`, per the plan review's instrumentation guidance): the
  upload-complete route (`apps/web/src/app/api/v1/scans/[scanId]/uploads/
[imageId]/complete/route.ts`) now logs `[web] upload_complete_timing` with
  `uploadPhaseDurationMs` (storage readback + validation) and
  `normalizationPhaseDurationMs` (deriving and storing the analysis/thumbnail
  variants) measured separately; the worker's analysis handler
  (`apps/worker/src/analysis-handler.ts`) logs
  `[worker] scan_analysis_timing` with `storageFetchDurationMs` and
  `providerCallDurationMs` split out, on both the success and failure paths.
  `docs/OPERATIONS.md`'s monitoring section now describes this concretely
  instead of asserting request IDs were "already emitted" durably (they
  weren't, before this session — only `scanId`/outbox `id`/job
  `idempotencyKey`/attempt `id` were).
  Verified: `npm run check` (92/92 unit tests, +8: 5 new
  `CorrelationIdSchema` tests in `packages/contracts/src/common.test.ts`, 3
  new `AnalyzeScanJobSchema` compatibility tests in `scan.test.ts`; a new
  `apps/web/src/server/http.test.ts` for `parseCorrelationId` is not counted
  in that unit total's package-only history but runs under the same `vitest
run`), `npm run build` (all 25 web routes present, worker and evals compile),
  `npm run test:integration` (34/34 database, +1: a new test submits a scan
  with a correlation ID and confirms it lands on both the outbox row and the
  `scan_attempts` row `prepareScanAnalysis` creates; storage/queue/worker
  suites unchanged), and a real isolated dev-server pass on port 3100 (the
  maintainer's own port-3000 server was never touched, and the scratch scan
  row this created was deleted from the shared dev database afterward):
  `GET /api/v1/quota` confirmed a missing, valid, and malformed inbound
  `x-request-id` all produce a 200 with the log correctly showing
  `correlationId` as `undefined`, the accepted value, or `undefined` again
  (malformed dropped, not rejected); a full create-scan → create-upload → PUT
  to MinIO → complete-upload cycle against real dev infrastructure produced
  the expected `[web] upload_complete_timing` line with both phase durations
  and the accepted correlation ID.

- **P3.1 Task 4: quota-headroom polling, an early admission check, and
  abandoned-upload cleanup.** `packages/database/src/scan-repository.ts`'s
  `enforceScanQuota` (the transactional, per-user-locked check submit/retry
  already ran) is refactored around a new shared `computeQuotaHeadroom`, so
  every quota read — the authoritative locked one and every advisory one —
  computes the same three numbers the same way and cannot drift. Two new
  advisory (unlocked) call sites reuse it: `getScanQuotaHeadroomForUser`
  backs a new `GET /api/v1/quota` (contract: `packages/contracts/src/
quota.ts`'s `GetQuotaHeadroomResponseSchema`, `{ used, limit, remaining }`
  per dimension plus `admissible`/`blockedBy`), and `createOrGetScan` gained
  an optional `quotaLimits` parameter that rejects a genuinely new scan
  (never an idempotent replay) with `quota_exceeded` before it's even
  inserted when headroom is already clearly exhausted — wired from
  `POST /scans`, so a session with no realistic chance of admission fails
  before the client uploads and normalizes an image rather than only at
  submit. Both are explicitly advisory (can false-pass or false-block under
  concurrency); submit/retry remain the sole authority, unchanged.
  Abandoned-upload cleanup is new end to end: `cleanupAbandonedScans`
  (`scan-repository.ts`) finds `awaiting_upload` scans with no scan-or-image
  activity older than a TTL (candidate query unlocked, then re-verified
  under a row lock before canceling, since `FOR UPDATE` can't combine with
  the aggregate that finds them), cancels them, and returns each image's
  three derived object keys for cleanup. `apps/worker/src/index.ts` runs
  this on its own poll loop (`ABANDONED_UPLOAD_CLEANUP_INTERVAL_MS`, default
  30 min; `ABANDONED_UPLOAD_TTL_HOURS`, default 24h — both new
  `QueueWorkerConfigSchema` fields) alongside the existing outbox poller,
  best-effort deleting the returned objects from storage the same way
  `DELETE /account` does. On the client, `capture-session.tsx` fetches
  `/api/v1/quota` on mount and after any `quota_exceeded` failure, shows a
  banner naming which dimension is blocking (`blockedBy`), disables
  starting/resuming a session while blocked, and polls every 20s while
  blocked and idle — a failed record is never auto-retried, so an exhausted
  daily/spend limit cannot turn into a request loop; the user retries
  manually once the banner clears. `docs/OPERATIONS.md` and
  `docs/ROADMAP.md` (P3.1 Task 5, left unchecked with a
  dated partial-progress note) now document why `USER_ACTIVE_SCAN_LIMIT`
  (20) deliberately equals `MAX_SCANS_PER_BATCH` (20) and why
  `ANALYSIS_CONCURRENCY` is independent of per-user quota; true batch
  rollover (a continuous session spanning more than one batch) is explicitly
  deferred to P3.2, since today's client already hard-caps a session at 20
  records and so never reaches the server-side batch limit in normal use —
  see "Known gaps and risks."
  Verified: `npm run check` (84/84 unit tests, +5: 3 new quota contract
  tests, 2 new worker config tests), `npm run build` (new
  `/api/v1/quota` route), `npm run test:integration` (33/33 database, +3:
  headroom reflects active-scan usage, the early admission check rejects
  before any row is created, abandoned-scan cleanup cancels a backdated scan
  and leaves a recent one alone — storage/queue/worker suites otherwise
  unchanged), and a real isolated dev-server pass (`NEXT_DIST_DIR`-scoped on
  port 3100, matching prior sessions' pattern, so the maintainer's own
  server on port 3000 was never touched): `GET /api/v1/quota` returned a
  real 200 body against actual dev data, and a scripted Playwright check
  confirmed `/scan` shows no quota banner and an enabled "Start capture
  session" button under normal (non-exhausted) quota with zero console
  errors. The isolated instance and its dist dir were removed afterward.

- **P3.1 Task 2: bounded upload concurrency, a persisted session queue,
  retry/cancel, review-later navigation, and refresh recovery for `/scan`.**
  `apps/web/src/app/scan/capture-session.tsx` was rewritten from a single
  global phase/one-record-at-a-time loop into a per-record state machine
  (`idle` / `needs-recapture` / `queued` / `processing` / `failed`) driven by
  a small worker-pool queue (`UPLOAD_CONCURRENCY = 3`): up to three records
  create-scan/upload/complete/submit concurrently, each with its own progress
  bar, retry button, and cancel button (best-effort server-side `cancel` if a
  scan already exists). Once a batch exists, the queue's bookkeeping —
  batch/scan identity and every idempotency key, but never file bytes —
  persists to `localStorage` on every change and rehydrates on mount: a
  record whose image had already been confirmed uploaded resumes as `idle`
  (just needs a submit retry), while one that hadn't shows "Needs recapture"
  with its original filename and a control to reattach a photo, since the
  browser cannot retain `File` objects across a reload. A "N submitted so
  far — review them now" link to `/scans/batch/{batchId}` appears once
  anything has been submitted, so a user is not forced to wait for the whole
  session; the page still auto-navigates there once every record finishes.
  No contract, schema, or API change — this is purely a client-side queue
  built on the existing `/batches`, `/scans`, `/scans/{id}/uploads`,
  `/scans/{id}/uploads/{id}/complete`, `/scans/{id}/submit`, and
  `/scans/{id}/cancel` routes.
  Two real bugs were found and fixed during verification, both specific to
  the recapture-after-refresh path (an untested seam before this session):
  (1) reattaching a _different_ photo than the original while reusing the
  original upload/complete idempotency keys hit the server's idempotency
  conflict guard (`409`, "idempotency key already used with different image
  data"), since those keys' payload includes the file's checksum/size; (2)
  even after minting fresh upload/complete keys, reusing the _same scan_
  left the original, never-completed image registration attached to it,
  and the server correctly refuses to submit a scan with any incomplete
  registered image (`409`, "All registered images must finish uploading
  before submission") — an interrupted-then-resumed record can never
  progress on the same `scanId`. The fix: `attachRecapture` now discards the
  old scan entirely (best-effort `cancel`, fire-and-forget) and mints a
  whole new `scanKey`/`submitKey`/`uploadKey`/`completeKey` set, so a
  reattached photo always starts a clean scan rather than resuming a
  partially-registered one. A third bug was in the verification approach,
  not the product: relying on a value assigned inside a `setRecords`
  updater immediately after calling it (to detect "was this the last
  record, so auto-navigate now") silently never fired, because that updater
  does not run synchronously outside a React event handler — fixed by
  tracking the pending-record count in a plain ref (`pendingCountRef`)
  instead, which is the only value the auto-navigate check now reads.
  Verified: `npm run check` (79/79 unit tests), `npm run build`, and a
  scripted Playwright pass against a real dev server (Postgres/Redis/MinIO,
  `AUTH_MODE=development`) with real small PNGs — confirmed at most 3
  concurrent uploads, a mid-upload reload producing the resume banner with
  correct per-record needs-recapture/ready state, a full recapture-with-a-
  different-photo-then-resume cycle completing with zero console errors and
  a correct auto-navigate, and a queued/mid-upload record's cancel button
  correctly excluding it from the resulting batch (3 of 4 scan cards, as
  expected). Manual dev-server verification needed its own isolated
  `next dev` instance (`NEXT_DIST_DIR`-scoped, matching the existing e2e
  pattern) because another `next dev` was already holding the project's
  usual dev lock; that instance and all scratch files were removed
  afterward, and the pre-existing dev server on port 3000 was left running
  and untouched throughout.
- **Library UX pass: real cover art, an album detail page, and records that can
  actually be removed (ADR-0018).** The maintainer asked for a broad UI/UX
  review "as a user looking to scan albums, review album details, add, edit and
  delete lists," naming missing scan thumbnails and dead-end wishlist cards.
  Four things changed:
  1. **Real covers everywhere.** A shared `CoverArt` client component
     (`apps/web/src/app/cover-art.tsx`) layers the signed thumbnail over the
     existing tone placeholder, so a missing or slow image never shifts layout.
     It requests signed reads only as artwork nears the viewport
     (`IntersectionObserver`), since a library page can hold 100 covers and each
     one costs a request. Used by the dashboard activity rows, the dashboard
     collection/wishlist previews, `/scans` history, the library grids, and the
     detail page. This closes rank 9 of `docs/UI_UX_REVIEW.md`, which had been
     deferred as a separate task, and the scan-history half of P3.4's image-read
     item. The batch review page keeps its own `BatchThumbnail` (a different
     fixed-size card shape) and was deliberately left alone.
  2. **A library item detail page** at `/library/{itemId}` — collection and
     wishlist cards are now links to it, which is what "clicking a wishlist item
     does nothing" was about. It shows the cover, full release facts, a
     MusicBrainz link (rendered only for `https://` URLs, since the reference
     arrives through a client-sent confirmation body), editable notes, per-copy
     editors, list actions, and a link back to the originating scan.
     `getLibraryItemForUser` is the new repository read; `LibraryItemResult`
     gained `coverImage` (`{ scanId, imageId } | null`), batch-loaded in one
     query. Note `apps/web/src/app/library/layout.tsx` re-exports the dashboard
     layout — without it the route renders with no app shell, which is how every
     other authenticated section here works.
  3. **Editing feedback.** The grid no longer carries inline editors. The copy
     editor gained the media/sleeve condition fields the API already supported,
     real error/pending/saved states, and an inline delete confirmation instead
     of `window.confirm`; it previously ignored failures entirely. Notes are now
     editable at all (`PATCH /library/{itemId}` supported `notes` with no UI).
  4. **Records can be removed.** See ADR-0018 below.
- **ADR-0018 supersedes ADR-0011's delete restriction.** Migration 012 makes
  `scan_confirmations.library_item_id` nullable with `on delete set null`.
  Previously that `restrict` FK meant nearly every real library item was
  permanently undeletable — ADR-0011 recorded this as "effectively a no-op path
  for real data," and the UI hid "Remove" for anything with
  `confirmedFromScanId`. Now the item deletes, its copies cascade, and the
  confirmation keeps `scan_id`/`release_id`/`reviewed_release`/`confirmed_at`;
  only the item pointer clears. Three reads follow: `getScanConfirmationForUser`
  returns null (the scan is reviewable again), `confirmScan` replaces the stale
  row instead of raising its "already confirmed" conflict (otherwise removal
  would permanently block re-saving that scan, since `scan_id` is the PK), and
  the account export left-joins with `libraryItemId`/`list` nullable so the
  decision is still exported.
- **Verification for the above:** `npm run check` (79/79 unit tests),
  `npm run build`, `npm run test:integration` (30/30 database — +2 net new
  covering removal-keeps-the-audit-row, re-saving after removal, and the cover
  lookup — plus storage/queue/worker), a scripted 14-step browser pass against a
  running dev server (wishlist card → detail, notes round-trip, move to
  collection, copy edit persistence, copy removal, delete-with-confirm →
  redirect, scan still in history, 404 on unknown id — all passing), axe
  WCAG 2 A/AA with zero violations on dashboard/collection/wishlist/scans/detail,
  and a Pixel 7 pass with no horizontal overflow. Seeded data and scratch
  scripts were removed afterward.
- **Watch out:** one existing integration test
  (`confirms a reviewed result idempotently…`) asserts a **global** count of
  `catalog_references` rows rather than scoping to its own data, so any seeded
  development data makes it fail. This bit this session and cost a false
  regression scare; it is pre-existing test fragility, not a code bug.

- **Dashboard "Latest scans" now supports inline add/dismiss per scan
  (ADR-0017).** The maintainer asked, outside the roadmap sequence, to (1)
  confirm the dashboard shows each scan result individually rather than as a
  batch — already true, since `listScansForUser` has always projected one row
  per scan (ADR-0006) — and (2) let a user add a scan's top candidate to their
  collection/wishlist or dismiss it without leaving the dashboard. `cancelScan`
  (`packages/database/src/scan-repository.ts`) now also accepts `identified`,
  `needs_review`, `unresolved`, and `failed` as cancelable pre-states
  (transitioning to `canceled`), rejecting with `invalid_state` if the scan
  already has a `scan_confirmations` row — no new status or endpoint.
  `listScanSummariesForUser` now also returns `confirmedList` (`"collection" |
"wishlist" | null`) via one batched query joining `scan_confirmations` to
  `library_items` across the requested scan IDs. A new client component,
  `apps/web/src/app/dashboard/scan-activity-row.tsx`, renders each row and
  calls the existing `POST /scans/{scanId}/confirm`/`cancel` routes, then
  `router.refresh()` rather than tracking optimistic local state. The
  dashboard-only label "Dismissed" replaces "Canceled" purely as presentation
  in that component; every other page still says "Canceled" for the same
  status. Verified: `npm run check` (79/79 unit tests), `npm run build`,
  `npm run test:integration` (28/28 database tests, +2 new: dismiss a
  reviewable result, reject dismissing a confirmed one), and manual
  verification against a running dev server with seeded data (screenshotted,
  then cleaned up) — dismiss and add-to-collection both worked end to end,
  including the server-side rejection when dismissing an already-confirmed
  scan. The Playwright e2e suite could not be used to verify this locally; see
  "Known gaps and risks."

- **Phase 3-4 roadmap is now written.** At the maintainer's request,
  `docs/ROADMAP.md` replaces the placeholder with P3.1-P3.5 product maturity
  and P4.1-P4.5 measured service extraction. It incorporates the plan review's
  corrections/prerequisites, names staging/ECS for demonstrations, preserves
  Phase 2 gates, and defers training beyond Phase 4. P3.1 Task 1 is now
  implemented: `/scan` uses an extracted capture-session component instead of
  the one-shot mode toggle, creates independent scans under an existing batch,
  and exposes one upload-only control with one cover per record. The remaining P3.1
  queue persistence, quotas, tracing, and cost inventory are not implemented.
  Batch review now presents private signed thumbnails and basic candidate details,
  with one-tap high-confidence add-to-collection or wishlist actions; current
  architecture ADRs still apply until a future cutover.

- **Staging activation:** staging publishes and reuses isolated
  `<sha>-staging` image tags and promotes verified digests to
  `staging-passed-<sha>` idempotently. After the maintainer approved copying the
  ignored local development/test Clerk and OpenAI values into staging Secrets
  Manager, run `34038709907` passed migrations, service readiness, smoke tests,
  and image promotion. Its final deactivation encountered a transient AWS
  eventual-consistency error while releasing a NAT EIP whose ENI had already
  disappeared. Teardown applies now retry up to three times with bounded delay
  in staging and both production cleanup paths. Run `34040437776` completed the
  full lifecycle successfully for retry commit `fd99943`, including final
  deactivation, and promoted its images for production.

- **Production activation: six attempts across two sessions, five distinct
  real bugs found, four fixed and verified; one (#8) still open and is the
  current blocker.** Run `34041389496` got past secret creation but failed at
  "Verify runtime secrets" (exit 254); self-resolved on retry once secrets
  were consistently readable. Run `34042087635` failed provisioning the EKS
  node group with an ARM64/x86 AMI-type mismatch; fixed in commit `506767e`.
  Run `34145509904` cleared EKS provisioning but failed "Migrate database"
  with `CreateContainerConfigError` (Secret read 6ms after creation, before
  EKS API-server propagation); fixed in commit `5c098b6` (poll for
  readability; upgraded diagnostics to `describe job`/`describe pods`/`logs
--all-containers`). Run `34153511737` cleared EKS provisioning and the
  secret-propagation race but failed "Migrate database" again with
  `runAsNonRoot: true` unable to verify a non-numeric `USER node`; fixed in
  commit `beeb98a` (`USER node` → `USER 1000:1000` in both `Dockerfile.web`
  and `Dockerfile.worker`).
  **This session (continuing the same day): run `34160436572`** (commit
  `beeb98a`, after staging passed clean on it) cleared EKS provisioning,
  Kubernetes Secret propagation, `runAsNonRoot`, **and** "Migrate database"
  and "Deploy Kubernetes workloads" for the first time ever — but failed
  "Smoke test CloudFront path" with a persistent `504` on every one of 19
  retry attempts across ~13 minutes, despite `kubectl rollout status`
  reporting both `web` and `worker` successfully rolled out. Root cause not
  yet found; narrowed to somewhere between the ALB target group and the pod
  (candidates: target-group health-check timing, a security-group mismatch,
  NodePort/kube-proxy routing, or the CloudFront VPC origin itself) —
  tracked as **issue #8**, now the sole blocker for P2.2/P2.6.
  **A serious secondary incident followed**: this run's own 61m19s runtime
  exceeded the GitHub OIDC role's default 1-hour AWS session, so its
  automatic post-failure cleanup ("Deactivate after failed runtime
  deployment") died mid-destroy with `ExpiredToken` while EKS node group and
  CloudFront distribution deletes were still polling, and could not persist
  Terraform's state to S3. This left (a) a live, undestroyed production
  runtime — EKS, ALB, CloudFront, WAF, NAT gateway all still running, though
  the SSM `/vinylhound/production/active` flag had already flipped to
  `false` earlier in the same apply, before the token died; and (b) an
  orphaned Terraform state lock. Because `deactivate-environment.yml`
  (both its hourly schedule and a manual `workflow_dispatch`) trusts that
  SSM flag as its sole signal, it silently no-op'd twice in a row — a
  `workflow_dispatch` run completed "successfully" in 11 seconds having
  skipped every teardown step, while the maintainer independently confirmed
  via the AWS Console that EKS/ALB/CloudFront/NAT/WAF were all still live.
  Root-caused and resolved live: added `skip_activation_check` (commit
  `69854cb`) and `stale_lock_id` (commit `57e6a3e`) emergency
  `workflow_dispatch` inputs to bypass the SSM gate and force-unlock the
  orphaned lock respectively; also hardened the SSM read itself (commit
  `b2e0d5f`) so a real AWS API failure now fails loudly instead of being
  silently treated as "already inactive." Run `34165576307` then
  successfully destroyed the remaining 5 resources (ALB, target group,
  listener, WAF, CloudFront VPC origin — EKS/CloudFront distribution/NAT had
  apparently already finished deleting asynchronously before the original
  run's token died, Terraform just hadn't recorded it) and the maintainer
  independently reconfirmed via the Console that everything is gone. Aurora
  (serverless, `min_capacity = 0`) and the VPC/subnets/foundation remain, by
  design (ADR-0016's persistent data plane) — this is expected residual cost,
  not a leftover bug. Filed as **issues #9** (the session-duration root
  cause — needs `max_session_duration` raised on `aws_iam_role.github_deploy`
  in the bootstrap root) **and #10** (review/harden the emergency bypass
  inputs, which were written fast under pressure and should not be
  considered a permanent, fully-reviewed part of the normal flow).
  Staging was never affected by any of this — it deploys via ECS, not EKS,
  and its own deactivation for this same commit completed cleanly with no
  errors.

- **GitHub configuration script:** the repository administration helper is now
  Bash (`scripts/configure-github-repository.sh`) rather than PowerShell. It
  retains the public-visibility safety gate and the same repository, security,
  workflow-permission, label, and branch-protection settings. Pass an optional
  `OWNER/REPOSITORY` as its first argument; the VinylHound repository remains
  the default. GitHub rejects attempts to explicitly enable Advanced Security
  on a public repository because it is already available there, so the Bash
  payload omits only that redundant API field.

- **P2.1-P2.4 review:** repository implementation is complete; the remaining
  work is GitHub/AWS configuration and live rehearsal, summarized in
  `docs/PHASE_2_MILESTONE_REVIEW.md`. Live inspection confirmed the repository
  is now public and full-history Gitleaks passes. General merge settings have
  the documented values, but branch protection and the remaining security
  endpoints are not yet enabled. All three GitHub environments exist, only
  development has deploy variables, staging/production variables are absent,
  repository plan variables still contain invalid placeholders, only
  development Terraform state exists, the development ARM64 Lambdas exist, and
  no ECS/EKS clusters exist. Successful staging runs are guard skips, not
  lifecycle passes. The review also removed the accidentally tracked local AWS
  CLI installer bundle from Git and ignored `/aws/`; that bundle caused the
  latest CI formatting failure.

- **Incremental frontend usability pass:** the maintainer explicitly authorized
  the ranked UI work in `docs/UI_UX_REVIEW.md`, superseding the older UI deferral
  for this task. Changes cover mobile scan-row navigation, shared controls and
  contrast, uncropped previews, optional copy fields, review/processing feedback,
  and clear-search recovery. Backend contracts and architecture are unchanged.
  Verified: 56/56 browser checks across all four profiles, 79/79 unit tests,
  lint, typecheck, formatting, and production build pass. The subsequent Phase
  2 review excluded local AWS CLI and Terraform state artifacts from repository
  tooling, so the full `npm run check` now passes.

- **The tiered AWS runtime redesign is implemented and verified for milestone
  delivery.**
  ADR-0016 supersedes ADR-0015: development is an always-live, scale-to-zero
  API Gateway/Lambda environment backed by external PostgreSQL, staging keeps
  the just-in-time ECS shape, and production is now a just-in-time EKS runtime
  behind CloudFront, WAF, and an internal ALB. AWS environments use SQS FIFO
  queues with DLQs while local development keeps BullMQ. Production teardown
  drains workers before removing the namespace; application access uses EKS
  Pod Identity, and container migration/runtime entrypoints no longer depend on
  npm being present in the hardened images.
- Verification through 2026-09-05: `npm run check` passes all 79 unit tests;
  `npm run build` succeeds; actionlint 1.7.7 reports no workflow findings;
  kubeconform 0.7.0 validates all 10 production Kubernetes resources; and
  Terraform 1.13.3 formats and validates bootstrap, development, staging, and
  production roots against committed provider locks. The worker shared-package
  runtime compilation also succeeds. `npm run container:build` now builds all
  three images. Local smoke tests prove web liveness/readiness/root responses
  and Docker health, worker migrations/heartbeat/clean SIGTERM shutdown, and
  Lambda cold start, EventBridge dispatch, and SQS partial-batch failure. All
  runtimes are non-root and omit npm; tests made no OpenAI calls and removed
  their disposable containers/databases. No real AWS plan/apply was attempted.
- Terraform 1.13.3 is installed for both Windows and WSL. The exact WSL
  `terraform -chdir=infra/terraform/bootstrap init` command succeeds and the
  bootstrap root validates with AWS provider 6.62.0. Its lock now includes the
  Linux package hash alongside the Windows hash. All four roots also pass
  formatting and Windows validation; GitHub's Linux Terraform validation job
  passed for milestone commit `fdece7b`.

- **Do not make the repository public yet.** The real Gemini credential found
  in historical `.env.example` was rotated, and its only containing branch,
  `experiment/gemini-vs-openai`, was deleted locally and on GitHub on
  2026-09-02. `main` never contained the exposing commit; a local ref audit and
  GitHub `ls-remote` both confirm no remaining branch points to it. The next
  push must produce a clean full-history Gitleaks workflow run before the
  visibility-change gate can pass. Never add an allowlist for a real finding.
- **Initial GitHub workflow failures are resolved.** The follow-up commit
  `a8bdff5` passed CI, Security (including a clean full-history Gitleaks scan),
  staging's pre-activation guard, Terraform validation, and both container
  build/Trivy/SBOM jobs on 2026-09-02. Private-repository SARIF/CodeQL uploads
  now wait for the public visibility gate; staging and scheduled deactivation
  skip safely until configured, while manual production activation validates
  and fails clearly when configuration is missing. Runtime images remove unused
  npm/corepack package-manager tooling, eliminating its inherited Trivy findings.

- The dashboard now reads authenticated, persisted data rather than the old
  hard-coded demo dataset: its activity section shows the three most recent
  scans, and its collection/wishlist previews show the three most recently
  updated items and exact server-side counts. Empty states are explicit. This
  work is committed on `main`.

- **Milestone 4's managed-infrastructure/operations task is complete at the
  repository level.** `docs/OPERATIONS.md` defines the managed PostgreSQL,
  Redis, and object-storage topology; backup retention; monthly recovery
  drill; health checks; log/alert signals; and production secret boundaries.
  `npm run ops:restore-test` takes a local Compose logical DB backup, restores
  it to `vinylhound_restore_verification`, validates migration metadata, then
  drops that isolated verification database; it passed on 2026-08-31. Public
  `/api/healthz` (process) and `/api/readyz` (PostgreSQL) probes are excluded
  from Clerk protection for external monitoring. Before each first submission
  or retry, the server serializes per-user quota checks using a PostgreSQL
  advisory transaction lock: daily outbox volume, queued/processing scans,
  and rolling actual token cost plus a configured reservation for each active
  scan. Exceeding a limit returns 429 `quota_exceeded`; defaults and required
  production configuration are in `.env.example`/`docs/OPERATIONS.md`.

- **Milestone 4 Task 4, accessibility and cross-device testing, is complete.**
  `@axe-core/playwright` checks WCAG 2 A/AA violations on dashboard, scan,
  collection, wishlist, and account routes, and an e2e assertion verifies a
  keyboard-visible focus target. The app shell has a skip-to-content link,
  `:focus-visible` treatment, and reduced-motion support; destructive account
  confirmation input and client-side error messages now have explicit labels
  and alert semantics. Playwright projects define a fast Pixel 7 Chromium gate
  plus desktop Chromium, desktop Firefox, and iPhone 13 WebKit coverage via
  `npm run test:e2e:matrix`. Firefox and WebKit engines are installed locally.

- **Milestone 4 Task 1, production authentication, is complete** (ADR-0013).
  Clerk (`@clerk/nextjs@^7.8.3`) resolves session identity when
  `AUTH_MODE=production`: `apps/web/src/proxy.ts` (Next.js 16's Proxy
  convention, replacing the deprecated `middleware.ts`) protects every route
  except `/`, `/sign-in`, and `/sign-up`, and a new `requireUserId`
  (`apps/web/src/server/auth.ts`) replaces every route/page's old
  `context.config.DEVELOPMENT_USER_ID` read. Clerk's user ID maps to the
  existing `users.id` UUID via a new unique `clerk_user_id` column
  (migration 011), provisioned just-in-time on first request
  (`getOrCreateUserIdByClerkId`) rather than via a webhook. `AUTH_MODE`
  (now `"development" | "production"`, was a single-value literal) and a
  client-visible `NEXT_PUBLIC_AUTH_MODE` mirror stay the real switch:
  `AUTH_MODE=development` (the default, matching `.env.example`) needs no
  Clerk keys and behaves exactly as before, so local dev/CI/tests are
  unaffected — `clerkMiddleware()` itself throws on a missing publishable
  key, so the proxy and `<ClerkProvider>` both skip constructing Clerk
  entirely in development mode rather than gating inside it (a real hang in
  the e2e run caught the first, wrong version of this that gated Clerk from
  the inside). `/sign-in` and `/sign-up` use Clerk's default hosted
  `<SignIn>`/`<SignUp>` components; `/` is now a static landing page (the
  fake demo sign-in/sign-up form that used to live there is gone); `/account`
  and the sidebar name/avatar now read Clerk's `useUser`/`useClerk` in
  production mode and show a neutral development-mode label otherwise. The
  fake `vinylhound-demo-session` `localStorage` key is gone.
- **Milestone 4 Task 2, account export and deletion, is complete** (ADR-0014).
  `GET /account/export` (`getAccountExportForUser`,
  `packages/database/src/account-repository.ts`) returns every row a user
  owns — account, batches, scans, image metadata (not image bytes),
  attempts, confirmations, library items, library copies — as JSON with a
  `content-disposition: attachment` header; a new `packages/contracts`
  `account.ts` defines the strict response shape. `DELETE /account`
  (`deleteAccount`) performs an ordered hard delete in one transaction: the
  user's `scan_confirmations` rows are deleted directly first (their
  `library_item_id`/`release_id` FKs are deliberately `restrict`, ADR-0011,
  which would otherwise block the `users` cascade from also removing
  `library_items`), then the `users` row, letting every other user-owned
  table cascade normally; shared `albums`/`releases` rows are never touched
  since they carry no FK to `users` at all. After the transaction commits,
  each deleted image's `original`/`analysis`/`thumbnail` S3 objects (all
  three variants recomputed via `deriveImageObjectKey`, since only the
  `original` key is stored in a column — ADR-0007) are deleted best-effort;
  a failed object delete is logged, not retried, and does not fail the
  request. `/account` gained a "Your data" section
  (`account-data-actions.tsx`) with an "Export my data" download button and
  a type-to-confirm ("delete my account") destructive delete flow, working
  in both `AUTH_MODE=development` (redirects to `/` afterward) and
  `AUTH_MODE=production` (calls Clerk's `signOut()` afterward, since the
  Clerk session itself is independent of the now-deleted local row).
  `docs/SECURITY.md`'s retention section now states the actual policy
  (retained until the user deletes their account; no automatic time-based
  expiry) instead of describing an undefined future policy.
- **This session also destroyed the accumulated local dev database history**
  under `DEVELOPMENT_USER_ID` (scans, images, library items, batches built
  up across every prior session's manual testing) by mistake: a `curl -X
DELETE` intended only to inspect response headers while manually verifying
  the new endpoint executed for real. A fresh, empty `users` row was
  auto-reprovisioned under the same ID on the next request, so the app still
  works, but every reference in this file's history to specific accumulated
  counts (e.g. "21 scans," "48/12" collection/wishlist counts shown in
  screenshots) no longer reflects the database's actual contents — the
  maintainer confirmed this local data did not need recovering. This is a
  concrete illustration of why `DELETE /account` needs a real confirmation
  step before ever being invoked, automated or manual, against non-disposable
  data.
- This session also installed Node 22.23.2 side-by-side via nvm-windows on
  the Windows host (`nvm use 22.23.2`), since the machine's only prior Node
  was v20.17.0 and this repo's scripts (`db:migrate`, `test:integration`,
  the e2e `globalSetup`) require Node ≥21.7 for `--env-file-if-exists`. This
  finally makes `npm run check`/`test:integration`/`test:e2e` runnable
  directly on Windows for this machine, not just in WSL as prior sessions
  required.
- Milestone 1 (single-image vertical slice) is complete. The maintainer accepted
  Sol + `high` + prompt-v2 artist/title quality for the early build; the formal
  private AI eval baseline is deferred until public rollout or model/cost
  optimization (`docs/ROADMAP.md`).
- **Milestone 2 (multi-view and batch) is complete**, all four slices:
  1. Multi-view (`a1ac19d`): front/back/spine/label/barcode/runout photos of
     one physical record group into a single scan and one identification
     request, each image paired with its view label
     (`album-identification.v3`).
  2. Batch (`dd349a1`, ADR-0006): several _distinct_ records captured
     together as one batch, where each photo becomes its own independently
     tracked scan. `POST /batches` creates a grouping shell; `POST /scans`
     accepts an optional `batchId`; `GET /batches/{batchId}` projects each
     member scan's status/top candidate with no persisted batch-level
     state. Retry/cancel, the `/scan` mode toggle, and the
     `/scans/batch/{batchId}` progress page are all part of this slice.
  3. Thumbnail/normalization pipeline (`43de522`, ADR-0007): upload
     completion derives a bounded analysis copy (JPEG, 2048px cap) and a UI
     thumbnail (JPEG, 400px cap) from the validated original, stores both
     as sibling S3 objects (migration 009), and scan analysis reads the
     analysis copy instead of the full-resolution original. Worker
     concurrency limiting (`ANALYSIS_CONCURRENCY`) turned out to already
     exist since Milestone 1; the roadmap note calling it a gap was stale
     and has been corrected.
  4. Batch and provider-cost dashboards (this session, ADR-0008):
     `GET /batches/{batchId}` gained a `cost` field (token totals,
     estimated USD, average duration) aggregated across the batch's member
     scans' attempts, shown on the batch progress page. A new
     `GET /usage` endpoint and `/account/usage` page report the same shape
     account-wide over a rolling 30-day window, plus scan counts by
     outcome. The per-model USD/million-token pricing table moved from the
     private `packages/evals` into `packages/domain`
     (`estimateTokenUsageCostUsd`) so both share one definition; `evals`
     re-exports it unchanged so nothing there broke.
- Codex independently reviewed Milestone 2 and fixed uncovered edge cases:
  the 20-scan batch cap is now enforced transactionally on the server; batch
  scans record `batch_upload`; retrying from an all-terminal batch restarts
  polling; images completed before migration 009 fall back to their original
  object; and versioned Terra/Luna model names use their specific pricing
  instead of the generic Sol-family prefix. The production build also restored
  the generated `next-env.d.ts` imports from `.next/dev` to `.next`.
- Every file chooser shown in Multiple records mode now accepts several images
  in one selection. The explicit upload inputs already supported this; the
  camera inputs now opt into `multiple` in batch mode as well so desktop
  browsers that render `capture` as a normal file dialog do not force
  one-at-a-time selection. One-record camera capture remains single-file.
- Milestone 3 Task 1 is complete. `docs/CATALOG_EVALUATION.md` and ADR-0009
  select MusicBrainz as the primary canonical catalog (release group = album,
  release = edition), with Discogs deferred as an optional pressing cross-check
  requiring a fresh terms/attribution/caching review.
- Milestone 3 Task 2 is complete. `packages/catalog` provides the catalog port
  and MusicBrainz adapter with a meaningful User-Agent, serialized 1 req/s
  access, 429/503 retry, and 24-hour in-memory cache. The review page exposes a
  user-triggered catalog search and persists selected release-group/release
  MBIDs plus source/fetch provenance. Migration 010 adds richer release fields,
  namespaced `catalog_references`, and `library_copies`; repeated owned
  confirmations reuse one library item but create separate physical copies
  (ADR-0010).
- Milestone 3's direct wishlist-to-owned conversion slice is complete
  (ADR-0011): `PATCH`/`DELETE /library/{itemId}` let a user move a wishlist
  item to owned (creating one blank copy, matching confirmation's rule) or
  edit notes, without a rescan. Moving an owned item back to wishlist is
  rejected while it still has copies. `DELETE` rejects with `invalid_state`
  whenever the item has `scan_confirmations` history — true of nearly every
  real item — since `scan_confirmations.library_item_id` is a `restrict` FK
  protecting the audit trail; the collection/wishlist pages hide "Remove" for
  any item with `confirmedFromScanId` set.
- **Milestone 3 is now complete** except per-copy edit/delete, which stays
  explicitly deferred (see Resume point). Library search, sort, and CSV export
  shipped this session (ADR-0012): `GET /library` accepts `q` (trimmed, max
  200 chars) and `sort` (`recent`/`artist`/`title`, default `recent`),
  validated together with `list` by a new `LibraryQuerySchema`. Matching and
  sorting operate on the same effective artist/title the response already
  returns (which prefers a scan confirmation's corrected values over the
  shared album row) rather than raw SQL columns, applied after the existing
  100-item fetch. A new `GET /library/export` route returns the same
  filtered/sorted list as `text/csv` with a `content-disposition: attachment`
  header. The collection/wishlist pages' previously non-functional search box
  and sort button are now a real, debounced (300ms) client toolbar
  (`library-toolbar.tsx`) that updates the URL (`router.replace`), which the
  server component re-reads; an "Export" link points at the new route with
  the current `list`/`q`/`sort`.
- `npm run check` passes in WSL on Node 22.23.2: formatting, ESLint,
  typecheck, and 61/61 unit tests.
- `npm run build` passes: the Next.js web app (26 routes, including the new
  `/api/v1/library/export` route), worker, and eval package compile cleanly.
- `npm run test:integration` passes in WSL/Docker: database (19), storage (1),
  queue (1), and worker (6) suites, 27/27 total. Confirmation coverage includes
  catalog provenance, wishlist conversion, two physical copies sharing one
  user/release library item, the direct-update/delete paths (including the
  copies-present/confirmation-history rejection cases), and the new
  search/sort test (artist-substring match, title-substring match, artist
  sort order, and a no-match case).
- `npm run test:e2e` passes in WSL: 5/5 Playwright tests against a
  production build with the synthetic worker (unchanged by this session).
- Manually verified search, sort, and CSV export in a running WSL dev server
  against real seeded data (two directly-inserted albums, since the database
  was otherwise empty of collection/wishlist items): `?q=miles` correctly
  narrowed to the matching item, `?sort=artist` reordered results, the CSV
  response had the correct `content-type`/`content-disposition` headers and
  correctly quoted an embedded `"` in `12" Vinyl`, and both `?q=`/`?sort=`
  round-tripped into the server-rendered search input's `value` and the
  sort `<select>`'s selected `<option>`. Manually-seeded rows were deleted
  afterward; pre-existing real data (a "Chevelle" item and leftover rows from
  earlier WSL integration test runs against the same database) was left
  untouched.
- Manually verified `/account/usage` and `/account` in a running dev server
  (WSL, real Postgres data): both render real accumulated data
  (21 scans, $0.45 estimated spend, 83,112 tokens) with no console errors;
  confirmed the mobile bottom nav does not actually clip the last stat row
  (a `fullPage` screenshot made it look clipped, but scrolling to the
  bottom shows `content-page`'s existing 100px bottom padding clears it).
  This session found the same Docker Postgres instance empty (0 scans, 0
  library items) rather than holding that accumulated data — worth noting for
  whoever resumes next, since it means the 21-scan dataset referenced above no
  longer reflects the database's actual contents. This session manually
  verified the new `PATCH`/`DELETE /library/{itemId}` routes' error paths
  (not-found, invalid body, bad UUID) against a running WSL dev server instead,
  since there was no real library item to exercise the success path against.
- `npm run check` passes on Windows (Node 22.23.2 via nvm-windows, not WSL):
  formatting, ESLint, typecheck, and 69/69 unit tests (61 before this
  session, +4 `DevelopmentWebConfigSchema` auth-mode tests for task 1, +4
  `AccountExportResponseSchema`/`DeleteAccountResponseSchema` tests for
  task 2).
- `npm run build` passes: the Next.js web app (30 routes: +2 for
  `/sign-in`/`/sign-up` in task 1, +2 for `/api/v1/account` and
  `/api/v1/account/export` in task 2), worker, and eval package compile
  cleanly. A build warning about `process.cwd`/Edge Runtime originates
  inside `@clerk/nextjs`'s own module graph, not this repo's code, and does
  not fail the build.
- `npm run test:integration` passes on Windows (Node 22.23.2): database (25:
  21 before this session, +2 for `getOrCreateUserIdByClerkId` in task 1,
  +2 for account export/deletion in task 2 — export, export-not-found,
  delete-with-restrict-fks, delete-not-found), storage (1), queue (1), and
  worker (6) suites, 33/33 total. Migration 011 applied cleanly to the real
  dev database.
- `npm run test:e2e` passes: 5/5 Playwright tests against a production build
  with the synthetic worker, run in `AUTH_MODE=development` (unaffected by
  Clerk, as designed) — the task 1 run caught a real
  `clerkMiddleware()` construction-time throw described above; the task 2
  rerun after adding the account endpoints was unaffected.
- Manually verified in a running dev server: `GET /account/export` against
  real accumulated dev data (correct headers, schema-valid body);
  `/account`'s new "Your data" section renders and its delete flow's
  type-to-confirm gating (button stays disabled until the exact phrase is
  typed, "Cancel" resets state) was exercised end-to-end with a scripted
  Playwright check, screenshotted for visual confirmation. Manually invoking
  `DELETE /account` to check response headers was a mistake — it executed
  for real against the shared dev account and destroyed its accumulated
  scan/library history (see the note above); nothing else in this session's
  verification was destructive.
- Docker Compose services (postgres, redis, minio) are running and healthy.
- Milestone 2's original work is committed through `a248eb9`; the subsequent
  audit fixes, MusicBrainz catalog integration, physical-copy model, related
  docs/tests, and the hydration-warning adjustment are committed as `c8f99cd`.
  Direct wishlist-to-owned conversion (ADR-0011) and library search/sort/
  export (ADR-0012) are committed as `b2d87d6`. Production authentication
  (ADR-0013) is committed as `9507cad`. All of the above are pushed to
  `origin/main`. Account export/deletion (ADR-0014) is committed as `6511205`.
- The maintainer's private dataset folder contains 52 JPEG cover photos plus a
  draft `manifest.json` and `LABELING_PROMPT.md`. These files remain outside
  the repository and still need app-assisted labels and maintainer verification.
- `packages/evals` provides a private, checkpointed Sol/Terra/Luna comparison
  runner with verified-label/consent gates, per-attempt audit output, aggregate
  quality/routing/latency/token/cost metrics, and non-billable unit coverage.
  Its pricing table now lives in `packages/domain` (ADR-0008) but its
  exported values are unchanged, and it still only ever submits single-image,
  ungrouped cases directly to the provider rather than through the worker's
  image-read path.
- Production album identification defaults to `gpt-5.6-sol` + `high` image
  detail. The ignored local `.env` is synchronized to the Sol default.

## Resume point

<!-- The next session starts here. Replace this section when the task
     completes or is re-scoped. -->

**Current, 2026-09-11: P3.3 Task 1 (revised onto Spotify) and Task 3 are
done. Next is P3.3 Task 2 — favorites and user-owned ordered playlists.**
Define the contracts and domain rules before persistence or UI, as Task 1/3
did: favorite/unfavorite plus playlist create/rename/reorder/remove/delete
over saved release references. Playlists organize music; streaming playback
is out of scope even though the discovery provider is now Spotify — do not
let the provider change quietly widen that scope. After Task 2, Task 4
(explicit HTTP/event version conventions and previous-deployed-version
compatibility fixtures) is the last of P3.3.

Both pre-flight items are now done: the maintainer applied migration 015, and
`/discover` has been exercised against the real Spotify API. That run found the
403 Premium blocker and the two defects described in "Current state" — the
error-mapping and 403-reporting fixes are in; the 403 itself is **still open
and is the one thing standing between `/discover` and working**.

**The decision that needs making before more discovery work:** whether to put
Spotify Premium on the account that owns the app, or change discovery
provider. Everything else in the discovery stack — port, contracts, routes,
adapter, UI, save-to-library — is provider-shaped but not provider-locked at
the port boundary, so a swap is an adapter plus a contract loosening (the
discovery contracts currently assume Spotify's 22-character IDs and
`album_type`), not a rewrite.

Also still true: the discovery cache is per-process and does not coordinate
across `apps/web` replicas, and `e2e/live-camera.e2e.ts`'s first test is red
on clean `main` and unrelated to any of this.

Housekeeping note: `npm run test:e2e` rewrites the generated
`apps/web/next-env.d.ts` to reference `./.next-e2e/types/...` instead of
`./.next/dev/types/...`. That is a real working-tree change, not the CRLF
artifact, and should be reverted (`git checkout -- apps/web/next-env.d.ts`)
rather than committed; `npm run dev` regenerates the dev variant anyway.

---

**Superseded history below.** The resume point that follows describes P3.1/
P3.2 and is kept for context only; both are closed.

**P3.1 is closed out (2026-09-10), maintainer-confirmed.** All 7 tasks are
checked in `docs/ROADMAP.md`, tagged `phase-3-p3.1`. Start P3.2 (guided
automatic mobile capture) next — see below for its task list and the one
known gap (G3) already flagged against it. Nothing from P3.1 is left
pending; the CI/CD hardening below (manual staging/production deploys,
Platform's infra-change gating, the Aurora auto-start safeguard, the arm64
runner) happened the same day as a maintainer-requested side effort, not a
roadmap task, and is itself already verified and closed.

Migration 014 (Supabase RLS hardening on `vinylhound_migrations`, Codex,
2026-09-09) is committed but per its own commit message had not been applied
to the Supabase environment as of that session — confirm whether it's been
applied since before assuming it has.

**Task, as of 2026-09-07 (second session of the day):** the maintainer decided
to stop pursuing a fully-passing production activation in-session — five real,
distinct bugs were found and four fixed across two sessions (see Current
state), the fifth (#8, the ALB/CloudFront 504) needs its own focused
investigation rather than more blind retries. Both staging and production were
deliberately torn down and confirmed inactive (staging via its own clean
pipeline deactivation; production via the emergency `skip_activation_check`
path after an incident — see Current state and issues #9/#10). All outstanding
Phase 2 work was converted into GitHub issues (**#8–#15**) rather than staying
implicit in this file, and the maintainer wants to move toward Phase 3 given
development is stable — Phase 2 is **not** being marked complete or tagged;
it's being left in a clean, fully-tracked, non-costing state while priorities
shift.

**Current infrastructure state (verified 2026-09-07, staging corrected
2026-09-10 — production not re-verified today, see note below):**

- **Development**: live, always-on, unaffected by anything in this session.
  `https://dev-vh.siliconforest.io`.
- **Staging**: inactive, but its Aurora cluster is confirmed `available`
  (started by hand 2026-09-10 after being found administratively `stopped`
  since 2026-09-07 — see "Current state" for the full pipeline
  investigation). Last full lifecycle run as of this writing is
  `34493532167` (native-arm64 runner, dispatched manually since
  `deploy-staging.yml` is no longer push-triggered) — passed completely:
  build, migrate, deploy, smoke test, clean deactivation. No known issues.
- **Production**: JIT runtime (EKS/ALB/CloudFront/WAF/NAT) inactive, last
  confirmed 2026-09-07 via Terraform apply output and the maintainer's AWS
  Console check — not re-verified today. **Its Aurora cluster showed the
  identical administrative `stopped` status as staging's during today's
  investigation** (`aws rds describe-db-clusters`), and — unlike staging —
  was deliberately _not_ started, since the maintainer only asked to start
  staging's. `deploy-production.yml` now runs
  `scripts/aws/ensure-database-available.sh` and will auto-start it on the
  next production deploy attempt; until then, production's database
  is stopped, not just scaled to zero. The VPC/
  subnet/foundation layer remain, by design (ADR-0016's persistent data
  plane) — this is expected residual cost, not a leftover bug; the maintainer
  asked about this specifically and was walked through why.

**Open issues tracking all remaining Phase 2 work** (filed this session,
replacing the old "Immediate next steps" list that used to live here):

- **#8** — the actual blocker: production's ALB/CloudFront returns a
  persistent 504 even though Kubernetes reports both deployments successfully
  rolled out. Root cause not yet found; needs its own investigation session
  with real `aws elbv2 describe-target-health` / `kubectl get endpoints`
  output, not another blind retry.
- **#9** — the GitHub OIDC session (1hr default) is too short for slow
  EKS/CloudFront destroy operations; this caused a real incident this session
  (a live, briefly-unaccounted-for production runtime). Fix: raise
  `max_session_duration` on `aws_iam_role.github_deploy`
  (`infra/terraform/bootstrap/main.tf`) — needs a bootstrap-root apply with an
  AWS administrator identity, not GitHub OIDC.
- **#10** — review/harden the emergency `skip_activation_check`/
  `stale_lock_id` workflow_dispatch inputs added live during #9's recovery
  (commits `69854cb`, `57e6a3e`); they worked but were written fast under
  pressure and deserve real review before being trusted as a standing
  capability.
- **#11** — standardize and audit AWS resource tagging (explicitly requested
  by the maintainer); `docs/OPERATIONS.md` now documents the existing
  convention and its gaps (commit `47c3123`).
- **#12, #13, #14, #15** — the remaining P2.1/P2.2/P2.5/P2.6 roadmap items
  (fork PR rehearsal, Lambda/Fargate demonstrations, load/failure/restore
  drills, full rehearsal + evidence publication), each already flagged in
  this file historically as genuinely manual or blocked on #8.

**Whoever picks this up next should NOT default to resuming Phase 2
production work** unless the maintainer asks for it again — the explicit
instruction this session was to move toward Phase 3 now that development is
stable. Read whatever the maintainer's next request actually is; if it's
Phase 3 scoping, start there fresh rather than assuming Phase 2 continuation.
If a future session does return to Phase 2, the issues above are the
authoritative task list — this file's old inline "Immediate next steps" is
gone because it went stale within the same day it was written and the issues
are now the better-maintained source.

**Separately, not blocking anything above:** the maintainer's local AWS CLI
session (`aws sts get-caller-identity`) is expired and authenticates via a
custom `login_session`-based credential process (`~/.aws/config` has
`login_session = arn:aws:iam::138010381178:root`, not standard AWS SSO) that
cannot be reauthenticated non-interactively — flag it, don't attempt it. It
does not block GitHub Actions, which authenticate via OIDC independently
(this is exactly the credential path that produced the #9 incident, so bear
that in mind if debugging anything OIDC/session-related).

`docs/ROADMAP.md` has P3.1's sequence, dependencies, and deliverables (all
now checked); `docs/PHASE_3_4_PLAN_REVIEW.md` remains the historical plan
review. Note that P3.1 Task 5's batch rollover is a written behavioral
definition, not an implementation — the actual rollover code belongs to
P3.2's continuous-capture state machine, since today's one-shot `/scan`
picker hard-caps a session at `MAX_SCANS_PER_BATCH` and cannot reach that
path.

**P3.2 is closed (2026-09-11), maintainer-confirmed.** All four tasks are
checked in `docs/ROADMAP.md`; automated coverage, the documented iPhone Safari
and Android Chrome protocol, and the private sanitized results meet its exit
criterion.

**P3.3 Task 1 is complete (2026-09-11, this session)** — see "Current state"
above and `docs/ROADMAP.md`'s P3.3 section for full detail. Start **P3.3
Task 2** next: define contracts/domain rules (before persistence/UI) for
release favorites and user-owned ordered playlists of saved release
references, including favorite/unfavorite and playlist
create/rename/reorder/remove/delete. Note the roadmap's own scoping:
playlists organize music, streaming playback is out of scope. Task 1's new
`CatalogReleaseDetailSchema`/`GetCatalogReleaseResponseSchema`
(`packages/contracts/src/catalog.ts`) and `GET /catalog/releases/{releaseId}`
are available for Task 2/3 to build on if a favorite or playlist entry needs
to resolve full release detail, but nothing in Task 1 assumes or blocks a
particular persistence shape for favorites/playlists — that design work is
exactly what Task 2 asks for.

Before starting Task 2, be aware of one pre-existing, unrelated issue
surfaced during Task 1's verification: `e2e/live-camera.e2e.ts`'s first test
fails consistently on a clean `main` (confirmed via `git stash`) — it is not
something Task 1 introduced, but it means `npm run test:e2e` will currently
show 1 failure out of the suite regardless of what Task 2 changes. Don't
mistake it for a regression from Task 2's own work; if it needs fixing, that
is P3.2-adjacent, not P3.3 work.

P3.3 is the first product scope cut if needed; its compatibility foundation
still precedes extraction. Phase 4 uses staging and retains explicit production
and Terraform-transfer gates. Do not default to resuming Phase 2 production
incident work.

Things worth knowing before extending this further:

- **`AUTH_MODE=production` is now verified against real Clerk test-mode
  keys and actually enforces route protection** — this was not true before
  this session amended ADR-0013 (see its "Amendment" section for the full
  root cause): `@next/env`'s `loadEnvConfig` silently returns a stale cache
  on any call after the first in a process unless `forceReload: true` is
  passed, so `AUTH_MODE`/`CLERK_SECRET_KEY`/the publishable key were all
  `undefined` inside `apps/web/src/proxy.ts` and `next.config.ts` at
  request time despite being set correctly in `.env` — `/dashboard`
  returned `200` unauthenticated instead of redirecting. Fixed by passing
  `forceReload: true` to both `loadEnvConfig` call sites
  (`next.config.ts`, `apps/web/src/server/context.ts`). Phase 2 removed the
  `next.config.ts` `env` block because it embedded the Clerk secret at build
  time. The container build sets only the non-secret auth mode, the root layout
  is forced dynamic, and ECS injects Clerk values when the standalone server
  starts.
  `apps/web/e2e/env.ts` now explicitly forces `AUTH_MODE=development` for
  the same reason: without that, a local `.env` with
  `AUTH_MODE=production` silently broke the entire e2e suite. Verified: a
  real protected-route redirect with genuine Clerk response headers,
  Clerk's real hosted `/sign-in` UI (screenshotted), and the full
  check/integration/e2e suite all still passing. **Not yet done**: actually
  signing up as a test user and confirming JIT provisioning creates a
  `users` row end-to-end — that's the next concrete step, not a full
  re-verification of the auth design.
- `clerk_user_id` is nullable with a placeholder backfill for existing rows
  (migration 011), deliberately not tightened to `not null` yet (see
  ADR-0013's Migration section) — do that tightening only after confirming
  real sign-in works, not before.
- **Never invoke `DELETE /account` (via curl, a browser, or otherwise)
  against real or shared dev data without meaning to delete it** — this
  session did exactly that by accident while checking response headers, and
  destroyed the local dev account's accumulated scan/library history (see
  "Current state" above). The repository-level integration tests
  (`schema.integration.ts`'s "account export and deletion" block) already
  exercise the full delete path safely against disposable throwaway users —
  prefer that over any manual `curl`/browser call against
  `DEVELOPMENT_USER_ID`'s real data.

Recently completed, for context:

- Account export and deletion (2026-08-31, ADR-0014, `docs/API.md`,
  `docs/SECURITY.md`): see "Current state" above for the full description.

- Production authentication (2026-08-31, ADR-0013, `docs/ARCHITECTURE.md`):
  see "Current state" above for the full description. Also installed Node
  22.23.2 via nvm-windows on this machine so `npm run check`/
  `test:integration`/`test:e2e` are runnable directly on Windows now, not
  only in WSL.

- Library search, sort, and CSV export (2026-08-31, ADR-0012, `docs/API.md`):
  new `LibrarySortSchema` (`recent`/`artist`/`title`) and `LibraryQuerySchema`
  (`packages/contracts/src/library.ts`) validate `list`/`q`/`sort` together.
  `listLibraryItemsForUser` (`packages/database/src/library-repository.ts`)
  gained optional `query`/`sort` params; a new `filterLibraryItemsByQuery`
  and an inline `sortLibraryItems` both operate on the already-serialized
  `LibraryItemResult[]` (the same effective artist/title the UI renders,
  which can come from a scan confirmation's JSONB override rather than the
  shared `albums` row) rather than pushing filtering into SQL — see ADR-0012
  for why. `GET /api/v1/library/route.ts` now parses `q`/`sort` through
  `LibraryQuerySchema`. New `GET /api/v1/library/export/route.ts` reuses the
  same query/repository call and serializes to `text/csv` with a
  `content-disposition: attachment` header and a small local `csvEscape`
  helper (no existing CSV utility in the codebase to reuse, and a single
  caller didn't justify a new `packages/domain` module). `library-page.tsx`
  now reads `searchParams` (Next.js 16's async page prop) and passes
  `query`/`sort` through; the previously non-functional search box and sort
  button were replaced by a new `"use client"` `library-toolbar.tsx`
  (debounced 300ms text input, a real `<select>` for sort, an "Export" link)
  that updates the URL via `router.replace` rather than fetching client-side,
  so the server component stays the single source of truth for the list.
  `collection/page.tsx` and `wishlist/page.tsx` now forward `searchParams`.
  Added contract tests for `LibraryQuerySchema` and one new database
  integration test covering artist-substring search, title-substring search,
  artist sort order, and a no-match case. Verified in WSL/Node 22.23.2:
  `npm run check` (61/61 unit tests), `npm run test:integration` (27/27),
  `npm run build` (26 web routes), `npm run test:e2e` (5/5 unchanged).
  Manually verified search/sort/export against real seeded data in a running
  WSL dev server (see "Current state" for detail); cleaned up the seeded rows
  afterward.

- Direct library item management (2026-08-31, ADR-0011, `docs/API.md`):
  `UpdateLibraryItemSchema` (`packages/contracts/src/library.ts`, drafted
  uncommitted by an earlier session and finished here) covers `{ list?,
notes? }`; a `copy` field was considered and dropped since a library item
  can have multiple copies and per-copy editing needs its own sub-resource
  (deferred, see Task above). `packages/database/src/library-repository.ts`
  gained `updateLibraryItem` and `deleteLibraryItem`, both row-locking the
  target item first: wishlist→collection creates one blank copy if none
  exist; collection→wishlist is rejected (`invalid_state`) while any copies
  exist; delete is rejected (`invalid_state`) whenever `scan_confirmations`
  references the item, since that table's `library_item_id` FK is `restrict`
  by design (protects the audit trail) and a naive delete would otherwise
  surface a raw Postgres FK violation on nearly every real item. New
  `PATCH`/`DELETE /api/v1/library/[itemId]/route.ts` follow the existing
  `parseUuid`/`parseJson`/`errorResponse` conventions. New client component
  `apps/web/src/app/library-item-actions.tsx` ("use client", fetch + `router.
refresh()`) adds "Move to collection"/"Move to wishlist"/"Remove" buttons to
  `library-page.tsx`'s server-rendered cards; "Move to wishlist" disables
  when `copyCount > 0` and "Remove" is hidden entirely when
  `confirmedFromScanId` is set, so the UI never offers an action the server
  would reject. Added contract tests (simplified schema) and five new
  database integration tests covering conversion, notes-only update, the
  copies-present rejection, cross-user rejection, and both delete outcomes
  (rejected with history, succeeds without). Verified in WSL/Node 22.23.2:
  `npm run check` (57/57 unit tests), `npm run test:integration` (26/26),
  `npm run build` (25 web routes), `npm run test:e2e` (5/5 unchanged).
  Corrected pre-existing `docs/API.md` drift: the library endpoint table
  listed `POST /library` as implemented, but no such route exists —
  `AddLibraryItemSchema` is contract-only.

- Milestone 2 audit and Milestone 3 provider evaluation (2026-08-31): fixed
  server-side batch-size enforcement, correct batch ingestion provenance,
  terminal-batch retry polling, legacy pre-normalization image retries, and
  versioned-model pricing. Selected MusicBrainz over Discogs as the primary
  canonical source and recorded the lookup/deduplication rules and adapter
  requirements in ADR-0009 and `docs/CATALOG_EVALUATION.md`.

- Batch and provider-cost dashboards (this session, ADR-0008,
  `docs/API.md`): shared `UsageCostSummarySchema` in
  `packages/contracts/scan.ts` (attemptCount, input/output/total tokens,
  estimatedCostUsd, averageDurationMs); `GetBatchResponseSchema` gained a
  required `cost` field; new `usage.ts` contract
  (`GetUsageSummaryResponseSchema`, `USAGE_SUMMARY_WINDOW_DAYS = 30`).
  `packages/database/analysis-repository.ts` gained `getBatchCostSummary`
  and `getUsageSummaryForUser`, both selecting `scan_attempts` rows
  filtered to `input_tokens is not null` (a failed attempt that never
  reached the provider has no usage, so it's excluded from cost but still
  counted by outcome) and reducing them in application code via
  `estimateTokenUsageCostUsd` — SQL aggregation was rejected because the
  per-model rate table isn't stored data. New `GET /api/v1/usage/route.ts`
  and `/account/usage/page.tsx` (server component, real data, two
  `settings-card` stat blocks: scan outcomes and provider cost); the batch
  progress page shows a one-line cost/token summary when the batch has any
  priced attempts. `/account` gained a link to the new page. Updated one
  existing contract test (`batch.test.ts`) for the new required field.
- Thumbnail/normalization pipeline (ADR-0007, `docs/API.md`): migration 009
  adds nullable `analysis_size_bytes`/`analysis_width`/`analysis_height`/

- Thumbnail/normalization pipeline (ADR-0007, `docs/API.md`): migration 009
  adds nullable `analysis_size_bytes`/`analysis_width`/`analysis_height`/
  `thumbnail_size_bytes` to `image_assets`, populated together with
  `completed_at` and covered by the same before/after check-constraint
  pattern as `width`/`height`. New `normalizeImage` in `packages/storage`
  (`image-normalization.ts`) derives a JPEG analysis copy (long edge capped
  2048px, quality 82) and thumbnail (long edge capped 400px, quality 70)
  from already-decoded bytes; `ObjectStorage` gained `putObject` for direct
  server-side writes. The upload-complete route (`apps/web/.../uploads/
[imageId]/complete/route.ts`) calls `normalizeImage` on the bytes already
  read for `validateImage`, writes both derived objects under
  `{userId}/{scanId}/{imageId}/analysis` and `.../thumbnail` (new shared
  `deriveImageObjectKey` helper in `packages/database/scan-repository.ts`,
  also now used for the `original` key), and passes their sizes/dimensions to
  `completeImageUpload`. `prepareScanAnalysis`
  (`analysis-repository.ts`) returns the analysis object's key/size/fixed
  `image/jpeg` MIME type instead of the original's; the worker's
  `analysis-handler.ts` needed no change since it already reads whatever
  `prepareScanAnalysis` gives it. Retry and redelivery reuse the stored
  analysis copy rather than re-normalizing. The `CompleteImageUploadResponse`
  contract is unchanged — `width`/`height` still describe the original; no
  client currently reads the new fields since no UI renders scan images yet.
  Investigated the "no worker concurrency limit" known-gap note and found it
  stale: `ANALYSIS_CONCURRENCY` (`packages/config`) has been wired into
  BullMQ's `Worker` `concurrency` option since Milestone 1
  (`8c692ed`, before this session).
- Batch capture (ADR-0006, `docs/API.md`): `batches` table (id, user_id,
  idempotency_key) and nullable `scans.batch_id` (migration 008); new
  `ScanStatusSchema` value `canceled`; `createOrGetBatch`/`getBatchForUser` in
  `packages/database/src/scan-repository.ts`; `listScanSummariesForUser`/
  `listScansForUser` in `analysis-repository.ts` (shared top-candidate
  projection used by both the batch page and scan history). `retryScan` picks
  the next attempt number from `scan_attempts`, replays idempotently by
  returning the latest pending outbox message for an already-`queued`/
  `processing` scan (not a stored request key — see ADR-0006's tradeoff
  note). `cancelScan` is a straightforward terminal-state transition;
  `dispatchNextOutboxMessage` now checks the owning scan's status and marks a
  canceled scan's row published-without-publishing so the poller stops
  retrying it; `prepareScanAnalysis` returns a `"canceled"` result the worker
  treats as a no-op. The `/scan` page's batch mode uploads each photo through
  its own scan/upload/submit cycle in parallel
  (`Promise.allSettled`); a partial failure still routes to the batch page
  with a `?failed=N` banner rather than losing the successfully created scans.
- Two real bugs were caught and fixed by integration tests before commit: an
  off-by-one in `retryScan`'s replay-detection outbox lookup, and a
  cross-test outbox-row leak in the new database integration tests that a
  naive `dispatchNextOutboxMessage` call would pick up (fixed with a
  `dispatchUntil` test helper that drains unrelated rows first). A `.strict()`
  schema mismatch (`GetBatchResponseSchema` rejecting an extra `batchId` key)
  was caught by the e2e suite, not unit/integration tests — worth remembering
  that `.strict()` response schemas need an e2e or route-level check, not just
  a repository-level one.
- Multi-view grouping (prior session): `packages/contracts` gained
  `ImageViewTypeSchema`; `image_assets` gained `view_type` (migration 007);
  `GetScanResponse.images[].viewType`; the OpenAI adapter labels each image
  with `buildAlbumIdentificationContent`; prompt v3.

## Known gaps and risks

- **Batch rollover is defined but not implemented.** A capture session cannot
  yet span more than one batch: `/scan` still hard-caps a session at
  `MAX_SCANS_PER_BATCH` (20) records client-side, so no session can reach the
  server's own 20-scan batch limit in normal use. This is a deliberate scope
  decision, not an oversight: P3.1 Task 5 wrote the intended behavior into
  `docs/OPERATIONS.md`'s "Batch rollover" section (an ordered per-session
  batch-ID list, rollover on the server's `batch_scan_limit` rejection or a
  proactive count, no schema/contract change), but its implementation
  belongs to P3.2's always-armed continuous-capture state machine, not a
  retrofit onto today's one-shot upload picker.
- **P3.1 Task 4's quota-headroom polling has no Playwright coverage yet.**
  Verified by a scripted browser pass against a real dev server (see
  "Current state") and by database integration tests covering the headroom
  computation and early admission check directly, but nothing in
  `apps/web/e2e/` exercises the blocked-banner/disabled-button path (it
  would need a seeded user already at a quota limit, which the existing e2e
  fixtures don't set up). A regression here would not be caught in CI.
- **The worker side of the new `[worker] scan_analysis_timing` log
  (correlationId propagation and the storage-fetch/provider-call split) was
  not exercised against a real running worker or a live provider call.**
  It was verified indirectly: a database integration test confirms
  `prepareScanAnalysis` copies `job.correlationId` onto the `scan_attempts`
  row it creates, and the web-side correlation/timing logging
  (`[web] http_request`, `[web] upload_complete_timing`) was verified against
  a real running dev server. Nothing exercises `apps/worker/src/
analysis-handler.ts`'s new timing lines end to end with a real (or synthetic)
  identify call; a regression in the phase split or in reading
  `job.correlationId` off a real dispatched job would not be caught by any
  current test.
- **P3.1 Task 2's capture-session queue (`/scan`) has no Playwright coverage
  yet**, and two scope limitations worth knowing before extending it: the
  "N submitted so far" review-later link's counter is in-memory only and
  resets to zero on a refresh, so a returning user does not immediately see
  it even though earlier records in the same batch really did submit (the
  batch page itself is always authoritative — nothing is lost, the link is
  just not shown again until at least one more record submits in the new
  session); and a record that is rehydrated as "needs recapture" is labeled
  the same way whether its upload had actually reached the server or never
  started at all (it never had a chance to register partial server state in
  the latter case), which is accurate but slightly imprecise. Neither
  blocks P3.1 Task 4.
- **The `/library/{itemId}` detail page has no Playwright coverage yet.** Its
  behavior was verified by a scripted browser pass against a dev server (steps
  listed in "Current state") and by database integration tests, but nothing in
  `apps/web/e2e/` exercises it, so a regression would not be caught in CI. The
  natural home is a new spec covering collection card → detail → notes save →
  copy edit → remove; it needs library data seeded through the API rather than
  the `/scan` UI, since that flow is what currently times out locally.
- **`GET /api/v1/scans` likely throws on every real call.** Discovered this
  session while touching `listScanSummariesForUser`, not caused by it:
  `apps/web/src/app/api/v1/scans/route.ts` parses that function's output
  directly through `ListScansResponseSchema`, but `ScanListItemSchema`
  (`packages/contracts/src/scan.ts`) is `.strict()` and does not declare the
  `thumbnailImageId` field the repository has returned since the batch-card
  work (`docs/decisions/0007...`/batch thumbnails). No test exercises this
  route with real data — `scan.test.ts` has no coverage for
  `ListScansResponseSchema`/`ScanListItemSchema` at all — which matches this
  file's own earlier note that `.strict()` mismatches have slipped through
  unit/integration tests before and only surfaced via e2e. This route is not
  used by any current page (the dashboard and `/scans` both call
  `listScansForUser` directly as server components), so nothing in the app is
  visibly broken today, but any future client of this JSON endpoint will hit
  it immediately. Fix is small (add `thumbnailImageId` to `ScanListItemSchema`,
  or stop spreading the raw summaries into the response) but out of scope for
  the dashboard change that found it — see ADR-0017's consequences section.
- The Playwright e2e suite (`npm run test:e2e`/`test:e2e:matrix`) could not be
  used to verify the dashboard change on this machine: every project times out
  waiting for `/scan`'s "Start capture session" button across unrelated tests
  (`groups two front-cover photos...`, `identifies a misnamed cover photo...`,
  etc.), before ever reaching the dashboard assertions later in the same file.
  This session's changes never touch `/scan` or `capture-session.tsx`, so the
  timeout is very unlikely to be a regression from this work, but it was not
  re-verified against an unmodified tree to confirm that — consistent with
  this file's 2026-09-08 note that the local runner has had timing trouble
  with the standalone e2e server before. The dashboard
  add/dismiss behavior was instead verified manually against a running dev
  server with seeded data (see "Current state"). Whoever next needs real e2e
  coverage on this machine should investigate that timeout first; it blocks
  more than just this session's change.
- MusicBrainz search has fixture-backed adapter coverage but has not yet been
  exercised against the 20-case metadata acceptance set in
  `docs/CATALOG_EVALUATION.md`. Search remains user-triggered and reviewable;
  there is no automatic enrichment or cover-art fetching.
- No AI eval baseline; broad model/prompt optimization is not yet measurable.
- A historical live check on one byte-identical 4000x3000 cover photo produced
  three materially different Terra outcomes (no candidate, Cherubs / _Heroin
  Man_, and Cows / _Sexy Pee Story_) in 8.1-25.2 seconds. Production now uses
  the maintainer-accepted Sol + `high` + prompt-v2 path, but still uses
  uncropped images (now resized to a 2048px-long-edge analysis copy per
  ADR-0007, previously full resolution) with no catalog retrieval. Multi-view
  sends more images per request, which still raises per-scan token/latency
  cost proportionally to view count even after the resize; a batch of N
  records still means N independent provider calls instead of one. Neither
  is yet measured against the deferred eval baseline, and the resize's actual
  token/cost/quality effect is unmeasured — it followed from the
  known-uncropped/full-resolution gap, not from a benchmark.
- A fresh Linux/WSL machine needs `sudo npx playwright install-deps` once,
  in addition to `npx playwright install chromium`, or Chromium fails to
  launch with a missing-shared-library error (`libnspr4.so` and similar).
- Cancellation is best-effort: a scan canceled while its attempt is already
  `processing` can still complete and show a result, since no in-flight
  OpenAI call is aborted (ADR-0006, accepted tradeoff). A large batch still
  submits all its jobs to BullMQ (and thus the outbox/Redis) at once;
  `ANALYSIS_CONCURRENCY` throttles how many are _processed_ concurrently
  (default 1, max 10) but does not throttle publication itself. This has not
  caused an observed problem and is not currently planned as further work,
  but is worth knowing if a very large batch is ever tested.
- No S3 object cleanup exists for a deleted scan or image: the `original`,
  `analysis`, and `thumbnail` objects are all orphaned in storage when the
  owning row is deleted via the database's cascading foreign key (ADR-0007
  widened this from one orphaned object to three; it did not introduce the
  gap).
- Production authentication (ADR-0013) has passed route-protection checks with
  real Clerk test-mode keys, but the Phase 2 production rehearsal still needs
  an end-to-end sign-up/JIT-provisioning run. `clerk_user_id` remains nullable
  with a placeholder backfill; no Clerk deletion webhook exists.
- AWS infrastructure, backups, observability, and delivery are implemented as
  code but have not yet been applied or rehearsed in the target account.
- `GET /usage` and `/account/usage` report a fixed rolling 30-day window
  with no pagination, custom range, or historical trend (ADR-0008,
  deliberate scope cut). `estimatedCostUsd` is `null` whenever no attempt
  in the window used a model present in `packages/domain`'s
  `MODEL_PRICING_USD`, which needs a manual update whenever provider
  pricing changes or a new model is adopted.

## Session log

- **2026-09-10 - Codex.** Implemented P3.2 Task 1's opt-in automatic
  live-camera framing in `capture-session.tsx`. The environment-facing camera
  is requested only after the user activates it; a small canvas sampler
  captures a stable frame as JPEG once, creates the same independent session
  record used by the file picker, then disarms until a material frame change
  re-arms it. This prevents a stationary cover from creating duplicate records.
  The existing file picker is unchanged and remains the fallback when camera
  support or permission fails. Camera tracks are stopped on the explicit stop
  action and component teardown. Marked P3.2 Task 1 complete in the roadmap;
  Tasks 2-4 intentionally remain open. Verified the full repository check (95
  unit tests) and a production build. The existing mobile suite is currently
  blocked before hydration because its standalone server 404s its `/_next/static`
  assets, so it cannot verify the unchanged upload fallback yet.

- **2026-09-10 - Claude (continuing, same day, closing).** Maintainer said
  "we can stop here and close out 3.1." Verified the tree was clean and all
  7 P3.1 checkboxes still checked (nothing regressed across the day's CI/CD
  detour) before touching docs. Trimmed the "Resume point" section, which
  had grown to ~430 lines of accumulated historical narrative — a direct
  violation of this file's own stated rule ("sections above the session log
  describe current state only; history belongs in the log") — down to
  roughly 300: replaced the stale top pointer (referencing long-committed
  `package.json` changes and a UI pass finished sessions ago) with a current
  one, and collapsed the redundant "P3.1 Task 1-3 complete... P3.1 fully
  complete" paragraphs (fully superseded by "Current state" and
  `docs/ROADMAP.md`'s own checkmarks) into one line, while deliberately
  keeping the still-live #8-#15 issue list, the AWS root-credential note,
  and the P3.2 task summary since nothing else in this file currently
  carries them. Also corrected the infrastructure-state snapshot, which
  still read "verified 2026-09-07" and described Aurora as merely
  scaled-to-zero — inaccurate for staging (fixed by hand today) and,
  more importantly, still true and unaddressed for **production**, whose
  Aurora cluster this session confirmed is in the same fully-`stopped` state
  and was deliberately left that way. Did not touch the trailing "Things
  worth knowing" (Clerk `loadEnvConfig` caching bug) or "Recently completed"
  material — still accurate, not redundant with anything above them.

- **2026-09-10 - Claude (continuing, same day, fourth follow-up).** Asked
  for pipeline speed/efficiency ideas. Answered as an exploratory question
  first (recommendation + tradeoff, no changes) per this session's own
  working style, naming the one concrete thing actually observed this
  session — QEMU-emulated arm64 builds in `deploy-staging.yml` — over two
  lower-confidence candidates (Terraform provider caching, possible
  duplicate CI/deploy build work) that would have needed real measurement
  before recommending. The maintainer approved the arm64 change; switched
  `deploy-staging.yml`'s job to `runs-on: ubuntu-24.04-arm`, confirming via
  `WebSearch` first that the label is GA/free for public repos rather than
  assuming. See "Current state" for the full reasoning; not yet confirmed
  by a real dispatch.

- **2026-09-10 - Claude (continuing, same day, third follow-up).** Asked
  whether `Platform` "can be manual or only if there's a change to the
  infrastructure rather than every push." Flagged before implementing
  anything that `Platform`'s two jobs aren't equally "infrastructure":
  Terraform/kubeconform validation is, but the container build/Trivy scan
  isn't — it caught this session's real CVE via a plain dependency bump, not
  an infra file. Recommended splitting rather than gating both, and the
  maintainer agreed. Implemented via a same-workflow `changes` detection job
  plus `if:` gating on `terraform` (and a fixed-up `terraform-plan`
  dependency check), specifically avoiding a rename or a separate workflow
  file because branch protection's required checks are pinned to exact
  `Platform / <job name>` context strings — see "Current state" for the
  full reasoning and verification done so far (diff logic tested by hand
  against real commit pairs, Terraform/YAML validated locally; not yet
  confirmed live by an actual push, since this entry is being written
  before that push).

- **2026-09-10 - Claude (continuing, same day).** Two follow-up requests
  after the pipeline investigation below. First, "add an auto start option":
  automated the manual `aws rds start-db-cluster` recovery from earlier in
  the day into `scripts/aws/ensure-database-available.sh`, wired into both
  `deploy-staging.yml` and `deploy-production.yml` (production carries the
  identical `stopped`-cluster risk, confirmed during the earlier
  investigation, so it got the same fix even though only staging had
  actually failed). Verified live via a real push and a watched `Deploy
staging` run. Missed updating this file for that commit (`d6c37fe`) before
  moving on — caught and backfilled into "Current state" this entry, along
  with a note not to repeat that. Second, "let's make staging and production
  manual jobs": removed `deploy-staging.yml`'s `push: branches: [main]`
  trigger, leaving only `workflow_dispatch` — `deploy-production.yml` was
  already manual-only. Confirmed no other workflow references
  `deploy-staging.yml` (no `workflow_run` chaining) before removing the
  trigger, and updated `docs/OPERATIONS.md`'s lifecycle section to describe
  development as the only push-triggered environment now. Flagged to the
  maintainer that production deploys need a staging-verified SHA, which
  staging no longer produces automatically per merge — someone now has to
  run `deploy-staging.yml` by hand first.

- **2026-09-10 - Claude (continuing).** The maintainer reported the GitHub
  Actions pipeline was failing and asked me to review and fix it. Found two
  distinct real failures — see "Current state" for full descriptions and
  evidence. Fixed the Platform workflow's Trivy CRITICAL finding (Next.js
  RCE, CVE-2026-75604) by bumping `next` to `16.3.4`; verified locally
  against the exact CI scan before pushing (commit `13b9d5e`), and confirmed
  green on GitHub afterward. Diagnosing `Deploy staging`'s migration failure
  needed actual AWS/GitHub log access I didn't have — the GitHub REST API's
  log-download endpoint refuses unauthenticated requests
  (`403 Must have admin rights`) regardless of the repository being public,
  and a `WebFetch` of the run's web page confirmed the same ("Sign in to
  view logs"). Installed `gh` CLI (via `winget`, not previously present on
  this machine) and ran `gh auth login --web`; the maintainer explicitly
  authorized and completed the device-code flow live. The maintainer also
  ran `aws login` themselves when I found the local AWS CLI session was
  still expired (as documented earlier in this file) and needed live
  CloudWatch access to see the actual migration task's stderr. First fix
  attempt (retry logic for Serverless v2 cold-start, commit `973b9e9`) was
  reasonable but wrong — pushed it, watched the rerun fail identically
  across all 5 retries, and went back to `aws rds describe-db-clusters`/
  `describe-events` rather than assume the fix worked. Found the real cause:
  staging's Aurora cluster was administratively `stopped` (not
  auto-paused) since 2026-09-07, matching this file's own record of that
  day's deliberate Phase 2 wind-down — a state nothing in this repository's
  pipeline or Terraform can create or reverse. Asked the maintainer how to
  proceed; they chose to start the cluster now over adding pipeline
  auto-start logic or leaving it stopped. Started it
  (`aws rds start-db-cluster`), waited ~9.5 minutes for `available`, and
  reran the failed workflow (`gh run rerun --failed`) rather than pushing an
  empty commit — full success: migrations, deploy, and smoke test all
  passed. See "Current state" for the complete, corrected account; this
  entry intentionally does not repeat the wrong first hypothesis as fact.
  Did not attempt to fix or investigate the AWS root credential's
  scope/hygiene (`arn:aws:iam::138010381178:root` — using the account root
  for day-to-day CLI access is generally worth flagging, but this session's
  task was the pipeline failure, not IAM posture, and root access was the
  maintainer's own established local setup, not something this session
  changed or was asked to change). Also did not address that
  `deploy-staging.yml` will keep trying to deploy to staging on every push
  regardless of whether the maintainer wants staging infrastructure live
  right now — worth a real conversation, not a unilateral change, if this
  keeps recurring.

- **2026-09-09 - Codex.** Addressed Supabase's RLS warning for the
  `public.vinylhound_migrations` bookkeeping table with forward-only migration 014. It enables RLS, revokes default `PUBLIC` access, and conditionally
  revokes direct grants from Supabase `anon` and `authenticated` roles while
  staying portable to local/AWS PostgreSQL where those roles do not exist.
  It has not been applied to Supabase from this session. The pre-existing
  uncommitted `apps/web/package.json` and `package-lock.json` changes were
  preserved.

- **2026-09-09 - Claude (continuing the same day).** Asked to verify Task 6
  was genuinely complete (not just trust the prior session's writeup), then
  do Task 7, then review all of P3.1 before committing/tagging/pushing.
  Re-verified Task 6 directly against the code (`withRoute` used by all 20 API
  routes; `correlation_id` columns present on both tables) rather than
  re-reading the prior session's own description of itself. Completed Task 7
  by writing a real, Terraform-grounded persistent-spend inventory into
  `docs/OPERATIONS.md` — see "Current state" for the full description —
  rather than a generic cost checklist, and along the way found/fixed a real
  doc gap (staging's undocumented $20 budget alarm). Reviewed Phase 3.1 as a
  whole: all 7 roadmap checkboxes now checked, and ran the full local
  verification suite fresh on this tree (lint, typecheck, 95/95 unit tests,
  build, 42/42 integration tests against the already-running Compose stack)
  rather than relying solely on prior sessions' recorded results, since the
  task explicitly asked for a review before committing. Everything passed
  except a pre-existing, untouched `next-env.d.ts` formatting warning (no
  working-tree diff on that file — a generated-file artifact predating this
  session, deliberately not "fixed" per this repo's Windows line-ending
  guidance in `CLAUDE.md`). Committed the two doc changes, tagged
  `phase-3-p3.1`, and pushed both to `origin/main`. Updated the resume point
  to point at P3.2 (guided automatic mobile capture), not yet started.

- **2026-09-09 - Claude (continuing the same day).** Closed out P3.1 Task 5
  — see "Current state" for the full description. The defaults reconciliation,
  queue-pressure pause/resume, and daily/spend exhaustion behavior were
  already implemented and documented by the same-day Task 4 session; the only
  real gap, confirmed by re-reading `createOrGetScan`'s batch-limit check
  (`packages/database/src/scan-repository.ts:150-159`) and
  `docs/OPERATIONS.md`'s existing text, was that "batch rollover" had only
  ever been recorded as a deferral decision, not defined. Wrote the actual
  behavioral definition into `docs/OPERATIONS.md`'s "Batch rollover" section
  (ordered per-session batch-ID list; rollover triggered by the server's
  already-existing, previously-unconsumed `batch_scan_limit` rejection or a
  proactive client count; composes existing `POST /batches`/`POST /scans`
  with no schema/contract change; quota headroom counts scans regardless of
  batch, so rollover doesn't interact with quota exhaustion as a separate
  case) and checked off Task 5 in `docs/ROADMAP.md`. No application code,
  contracts, or tests changed — this was scoped as a documentation/definition
  task per the roadmap's own wording ("Define batch rollover"), consistent
  with implementation staying deferred to P3.2's continuous-capture state
  machine, which the one-shot `/scan` picker cannot reach today. Updated the
  "Known gaps and risks" batch-rollover entry to reflect that it's now
  defined-but-not-implemented rather than an open scope question, and updated
  the resume point so Task 7 (persistent-spend inventory) is the sole
  remaining P3.1 item. Ran no build/test commands, since nothing executable
  changed; `git status` before editing confirmed a clean tree with no
  uncommitted work to disturb.

- **2026-09-09 - Claude (continuing the same day).** Implemented P3.1's
  structured request/error timing and correlation-ID checkbox — see "Current
  state" for the full description. Every `apps/web` API route now shares one
  `withRoute` wrapper (`apps/web/src/server/http.ts`) for request timing,
  error handling, and a `[web] http_request` log line, replacing 20 routes'
  duplicated `createRequestId`/try-catch pairs; deliberately left
  `/api/healthz`/`/api/readyz` unwrapped as budget-conscious probe exceptions.
  An inbound `x-request-id` header is validated (`CorrelationIdSchema`, new
  `packages/contracts/src/common.ts`) and forwarded as an optional
  `correlationId` on `AnalyzeScanJobSchema` and a new nullable
  `correlation_id` column on `outbox_messages`/`scan_attempts` (migration
  013), so one trace value greps across the HTTP request, the queued job,
  and the worker attempt. Split previously-bundled timing into named phases
  via structured logs only (no new duration columns): the upload-complete
  route logs upload vs. normalization duration separately, and the worker's
  analysis handler logs storage-fetch vs. provider-call duration separately.
  Verified `npm run check` (95/95 unit tests, +11: 5 `CorrelationIdSchema`
  tests, 3 `AnalyzeScanJobSchema` compatibility tests, 3 new
  `parseCorrelationId` tests in a new `apps/web/src/server/http.test.ts`),
  `npm run build` (all 25 web routes present), `npm run test:integration`
  (34/34 database, +1), and a real isolated dev-server pass on port 3100 (the
  maintainer's own port-3000 server untouched; the scratch scan created
  during verification was deleted from the shared dev database afterward)
  confirming correlation-ID accept/drop behavior and the new
  `[web] upload_complete_timing` log against a real create-scan → upload →
  complete cycle. The worker side of the new timing/correlation logging was
  not exercised against a live analysis run — see "Known gaps and risks."
  Separately, at the maintainer's request, gave every phase/milestone
  checklist in `docs/ROADMAP.md` explicit, restarting-per-section `Task N`
  numbers (e.g. this session's work is P3.1 Task 6) so future references are
  unambiguous — this session had to ask the maintainer to disambiguate what
  "P3.1 Task 5" meant before starting, since `docs/HANDOFF.md`'s informal
  historical numbering did not line up 1:1 with the roadmap's checkbox order.
  Reconciled every numbered reference in this file's "Current state" and
  "Resume point" sections against the new canonical numbers (the
  quota-headroom work above is P3.1 Task 4, not "task 3" as earlier sessions
  called it; Milestone 4's accessibility work is Task 4, not "task 3").
  Session-log entries below are left as originally written, since they are
  historical record, not current state.

- **2026-09-09 - Claude.** Implemented P3.1 task 3: quota-headroom
  contracts/polling (`GET /api/v1/quota`), an early advisory admission check
  in `createOrGetScan`, and worker-driven abandoned-upload cleanup — see
  "Current state" for the full description. Refactored
  `enforceScanQuota` around a new shared `computeQuotaHeadroom` so the
  transactional (locked) and advisory (unlocked) quota reads cannot drift.
  Wired `/scan`'s capture session to poll headroom, show why capture is
  blocked, and never auto-retry a `quota_exceeded` failure. Documented the
  active-scan/batch/daily-attempt/worker-concurrency reconciliation and
  deferred batch rollover to P3.2 in `docs/OPERATIONS.md` and
  `docs/ROADMAP.md` (left task 3's second roadmap checkbox unchecked with a
  dated partial-progress note, since rollover itself isn't implemented).
  Verified `npm run check` (84/84 unit tests), `npm run build`,
  `npm run test:integration` (33/33 database), and a real isolated
  dev-server pass on port 3100 (the maintainer's own port-3000 server was
  never touched) confirming `GET /api/v1/quota` against real dev data and a
  scripted Playwright check of `/scan`'s unblocked state with zero console
  errors.

- **2026-09-08 - Codex.** Implemented P3.1 task 1, the `/scan`
  capture-session refactor. `CaptureSession` replaces the mode toggle with
  one upload-only control that creates independent cover-photo records, shows
  the session draft, and creates/submits independent scans incrementally under a single
  existing batch. A failed session reuses its batch, scan, upload, completion,
  and submit idempotency keys on retry. Updated scan-flow e2e coverage and
  API/roadmap/testing docs.
  Also corrected Playwright's standalone-web-server command (`next start` is
  incompatible with the app's standalone output). Verified focused Prettier,
  `npm run check` (79/79 unit tests), and web production build. The local
  runner reaches the standalone server but its 30-second command window
  terminates the browser suite before a test result; rerun `npm run test:e2e`
  in a normal terminal. No database migration or contract change.

- **2026-09-08 - Claude.** Outside-evaluation session; no code changed. The
  maintainer supplied a draft Phase 3-4 plan and asked for critique and
  suggestions, with clarity of goals and outcomes as the explicit lens and no
  changes forced where nothing better was available. Verified the draft's claims
  against the code rather than against the docs, and wrote
  `docs/PHASE_3_4_PLAN_REVIEW.md`: three errors (Phase 2 described as
  "delivered with tracked exceptions" when it is deliberately untagged with #8
  open; a $25/month target that does not compose with the existing $25
  production budget alarm, $10 development alarm, and
  `USER_MONTHLY_SPEND_LIMIT_USD` default of 20; and "reuse existing batch
  grouping" understating P3.1, since the server genuinely supports incremental
  batch membership but `scan/page.tsx` is a 708-line one-shot form), eleven
  gaps, and an exit-criteria replacement table. Confirmed several things worth
  recording independently of the review: batches accept incremental scans with
  no schema or API change (`createOrGetBatch` takes no scan list);
  `USER_ACTIVE_SCAN_LIMIT` (20) exactly equals `MAX_SCANS_PER_BATCH` (20) while
  `ANALYSIS_CONCURRENCY` defaults to 1, so a full capture session sits at the
  quota ceiling and quota is only checked at submit, after upload and `sharp`
  normalization are already paid for; there is no Redis or ElastiCache in any
  AWS root, so a shared discovery cache has no substrate; and the Playwright
  suite selects capture controls by `input[type="file"]:not([capture])`, which a
  live-camera surface would break in four places. Updated this file's Current
  state and Resume point; deliberately did **not** touch `docs/ROADMAP.md`, file
  GitHub issues, or change any Phase 2 status. Verified with `npm run check`.

- **2026-09-07 - Claude (second session).** Picked up the prior session's
  uncommitted `USER node` → `USER 1000:1000` Dockerfile fix (for the
  `runAsNonRoot` numeric-UID bug). Ran `npm run check` clean, committed
  (`fa997f8`), pushed, and confirmed staging failed once
  (`34156798043`, a fourth distinct bug: `CannotPullContainerError` on the
  worker image immediately after a freshly-provisioned NAT gateway, before it
  was routing ECR pulls) then passed clean on retry after fixing it
  (`beeb98a`: retry the ECS migrate task launch on a pull-specific failure,
  `scripts/aws/run-worker-command.sh`). With the maintainer's explicit
  confirmation, dispatched production for `beeb98a`
  (`34160436572`) — it cleared EKS provisioning, Kubernetes Secret
  propagation, `runAsNonRoot`, migration, and Kubernetes deployment for the
  first time ever, but failed "Smoke test CloudFront path" with a persistent
  504 (root cause not found; filed as **#8**).
  That run's own 61-minute duration then exceeded the GitHub OIDC role's
  default 1-hour AWS session, so its automatic failure cleanup died mid-destroy
  with `ExpiredToken`, leaving a live, undestroyed production runtime (EKS,
  ALB, CloudFront, WAF, NAT) and an orphaned Terraform state lock — while the
  SSM `active` flag had already (mis)reported `false`, causing two automated
  deactivation attempts to silently no-op. Diagnosed live with the
  maintainer's help confirming real AWS Console state (the logs alone were
  not trustworthy here — this is itself worth remembering). Fixed the masked
  SSM-read failure path (`b2e0d5f`), added emergency `skip_activation_check`
  and `stale_lock_id` workflow_dispatch inputs (`69854cb`, `57e6a3e`) to
  bypass the wrong gate and clear the orphaned lock, and successfully tore
  down the remaining 5 resources (`34165576307`) — the maintainer confirmed
  via the Console that everything (EKS/ALB/CloudFront/WAF/NAT) is gone;
  Aurora and the VPC foundation remain by design. Filed the session's two new
  bugs as **#9** (OIDC session duration) and **#10** (review the emergency
  bypass inputs). Also confirmed staging's own deactivation for `beeb98a` was
  already clean and unaffected.
  At the maintainer's direction, stopped pursuing further production
  activation attempts in-session and instead converted all remaining Phase 2
  work into GitHub issues (**#8–#15**, including a maintainer-requested
  tagging-standardization issue, **#11**) so nothing depends on this file's
  memory alone. Documented the existing AWS tagging convention and its gaps
  in `docs/OPERATIONS.md` (`47c3123`). Checked off P2.3's "review real
  plans and apply inactive foundations" item (now genuinely satisfied by this
  session's repeated successful foundation applies). Rewrote this file's
  Resume point to reflect the maintainer's stated intent to move toward Phase
  3 now that development is stable, rather than continuing Phase 2
  automatically. Did not create a git tag — Phase 2 is deliberately being
  left incomplete-but-tracked rather than declared done.

- **2026-09-07 - Claude.** Continued from the prior session's AMI-fix
  handoff, with the user's goal of closing out Phase 2 (P2.1–P2.6) in
  `docs/ROADMAP.md`. Fixed a Prettier formatting break in `docs/HANDOFF.md`
  (commit `413fc5f`) that failed CI on the AMI-fix push. With the user's
  explicit approval, ran `scripts/configure-github-repository.sh` against the
  live repository — applied branch protection and security settings
  (secret scanning/push protection, vulnerability alerts, automated security
  fixes, private vulnerability reporting, read-only default workflow
  permissions, labels), verified live via the GitHub API. Confirmed two
  consecutive staging lifecycle runs passed in full (`34080493765` for
  `506767e`, `34081530170` for `413fc5f`), checked off the corresponding
  `docs/ROADMAP.md` items for P2.1 and P2.4. Split P2.1's fork-gate item into
  its own still-open checkbox (an untrusted fork PR rehearsal, distinct from
  the config script).

  Dispatched production activation three times to verify the AMI fix and
  demonstrate the EKS runtime end to end (P2.2). Each attempt failed on a
  different, genuine bug, in order: (1) `34041389496` failed at "Verify
  runtime secrets" — self-resolved on the next attempt once secrets were
  consistently readable, not a real bug; (2) `34145509904` cleared EKS
  provisioning (confirming the AMI fix works) but failed "Migrate database"
  with `CreateContainerConfigError` — root-caused to a Kubernetes Secret
  being read by a migrate Job 6ms after creation, before EKS API-server
  propagation; fixed in commit `5c098b6` (poll for readability before
  creating the Job; upgraded failure diagnostics from bare `kubectl logs`,
  which is empty when a container never starts, to `describe job`/
  `describe pods`/`logs --all-containers`); staging re-verified clean on this
  commit before redispatching; (3) `34153511737`, with both fixes in place,
  cleared EKS provisioning _and_ the secret-propagation race (the readiness
  poll found the ConfigMap/Secret immediately) but failed "Migrate database"
  again on a third, distinct cause, this time fully captured by the new
  diagnostics: `runAsNonRoot: true` in all three production pod specs
  requires a numeric UID to verify statically, but both `Dockerfile.web` and
  `Dockerfile.worker` set `USER node` by name. Staging never exercised any of
  these three bugs because it deploys via ECS, not Kubernetes — this was the
  first true end-to-end run of the production EKS code path. Drafted the fix
  (`USER node` → `USER 1000:1000` in both Dockerfiles) but ran out of runway
  to build/check/commit/push/re-verify-through-staging/redispatch within this
  session; **left uncommitted in the working tree** along with the already-
  correct P2.1/P2.4 `docs/ROADMAP.md` edits from earlier in the session. Full
  detail and exact next steps are in Current state and Resume point above.
  Did not touch `docs/ROADMAP.md`'s P2.2/P2.3 checkboxes (production has not
  yet succeeded end to end) and created no git tag, per the user's explicit
  requirement to confirm before tagging.

- **2026-09-06 - Claude.** Reviewed GitHub Actions run history and live AWS
  state (via `gh`/`aws` CLI in WSL) to reconcile the maintainer's report of a
  failed staging pipeline against the documented state. Found that the staging
  failure they saw, run `34038709907`, predates commit `fd99943`'s teardown
  retry fix by 32 minutes and is already resolved: the very next staging run
  after that fix, `34040437776`, hit the same transient EIP/ENI race but
  retried automatically and passed the full lifecycle, matching what
  `docs/HANDOFF.md` already recorded. The real open failure was newer than the
  existing handoff entry: two "Deploy production demo" runs
  (`34041389496`, `34042087635`) ran after production secrets were populated.
  The first failed at "Verify runtime secrets"; the second got through
  cluster/ALB/CloudFront/Route 53 creation and failed provisioning the EKS
  node group on an ARM64/x86 AMI-type mismatch (`t4g.medium` instance type
  with a defaulted `AL2023_x86_64_STANDARD` AMI). Confirmed both runs' failure
  cleanup left no dangling EKS cluster, load balancer, or CloudFront
  distribution in the account, only the persistent foundation
  (`environment_active` is designed to retain that). Fixed by pinning
  `ami_type = "AL2023_ARM_64_STANDARD"` on `aws_eks_node_group.main`
  (`infra/terraform/production/eks.tf`), matching the ARM64 architecture used
  everywhere else in the platform. Verified: `terraform fmt`/`validate` pass
  for all four roots (reinitialized the local production provider cache,
  which had gone stale), and `npm run check` passes (79/79 tests, lint,
  typecheck, formatting). Did not commit or dispatch a new production run;
  left both for the maintainer's review per session norms around
  outward-facing/hard-to-reverse actions.

- **2026-09-06 - Codex.** With explicit maintainer approval, copied the ignored
  local development/test Clerk secret, Clerk publishable key, and OpenAI key to
  the corresponding staging Secrets Manager containers without printing their
  values. Staging run `34038709907` then passed foundation reconciliation,
  migrations, both ECS service stability gates, both smoke endpoints, and
  immutable image promotion. The final teardown failed on an AWS
  eventual-consistency race releasing a NAT EIP after its ENI disappeared.
  Added one bounded three-attempt Terraform apply helper and used it for staging
  deactivation, production failure cleanup, and scheduled/manual production
  deactivation. Retry commit `fd99943` reused the already tested image digests;
  staging run `34040437776` passed the complete lifecycle, including teardown.
  Production run `34041389496` then created the persistent production
  foundation but stopped at the intended provider-secret gate. EKS provisioning
  was skipped and cleanup succeeded, leaving production inactive. Separate
  maintainer approval is required before reusing staging's development/test
  provider values in production.

- **2026-09-06 - Codex.** Dispatched the first fully configured staging workflow
  for `c17a83e`; OIDC authentication and the cost preflight passed, but immutable
  ECR correctly rejected overwriting the web image tag already published by the
  development workflow. An initial reuse fix still raced when both workflows
  preflighted a missing image concurrently, so that staging retry was cancelled
  before Terraform. Updated staging delivery to publish and reuse isolated
  `<sha>-staging` tags, build missing images only, make
  `staging-passed-<sha>` promotion idempotent with digest conflict detection,
  and avoid deactivation before state initialization. Production has not been
  dispatched because no commit has passed a complete staging lifecycle yet.
  Run `34037617340` then proved the isolated tags work, initialized state, and
  created the staging foundation before the expected missing-provider-secret
  gate stopped activation. Deactivation succeeded. All three source values are
  present in the ignored local `.env`, but copying those development/test
  credentials to staging requires explicit maintainer approval.

- **2026-09-05 - Codex.** Replaced
  `scripts/configure-github-repository.ps1` with an equivalent Bash
  script and updated both documented invocations. The Bash version uses strict
  error handling, preserves the public-repository guard and all prior settings,
  and accepts the repository as an optional first positional argument. A guard
  validation discovered the repository had become public and that GitHub now
  rejects the old script's redundant explicit Advanced Security field with
  HTTP 422; removed that field while preserving secret scanning and push
  protection. The failed first PATCH stopped the strict script before any later
  security endpoint, label, workflow-permission, or branch-protection call.
  Read-only follow-up confirmed branch protection and the remaining security
  endpoints are still disabled. The conversion also adds the Lambda-worker
  container job to required status checks; the older PowerShell script predated
  that third Platform matrix job. `bash -n`, `npm run check` (79/79),
  `npm run build`, and `git diff --check` pass. ShellCheck is not installed
  locally.

- **2026-09-05 - Codex.** Audited every outstanding P2.1-P2.4 roadmap item
  against committed implementation, GitHub configuration/runs, and read-only
  AWS inventory. Split the stale aggregate checklist entries to record clean
  Gitleaks, the live development Lambda deployment, target-account bootstrap,
  development state, and GitHub environment creation accurately. Added
  `docs/PHASE_2_MILESTONE_REVIEW.md` with the ordered manual visibility/fork,
  runtime, foundation-apply, and two-lifecycle staging checklist. Found that
  staging/production variables are absent, repository plan values contain
  invalid placeholders, only development remote state/Lambdas exist, no
  ECS/EKS clusters exist, and staging's successful runs are configuration
  skips. Also corrected the previous UI commit's accidental inclusion of a
  downloaded AWS CLI bundle: removed its three files from Git while preserving
  the local bundle, ignored `/aws/` in Git/Docker, and ignored local Terraform
  state in Prettier. `npm run check` passes all 79 tests plus formatting, lint,
  and typecheck; `npm run build` and `git diff --check` pass. No infrastructure
  was changed and no live AI call was made.

- **2026-09-05 - Codex.** Reviewed the frontend, ranked ten improvements before
  editing, and completed the first eight low-risk items in `docs/UI_UX_REVIEW.md`.
  Fixed the hidden mobile scan links with whole-row links; improved shared
  control sizes, contrast, focus, wrapping, and safe-area spacing; kept full
  photo edges in previews; collapsed optional copy details; clarified candidate,
  upload, catalog-empty, and save feedback; added clear-search recovery. Fixed
  queued scans initializing empty review drafts and retry not restarting polling.
  Preserved Next.js, global CSS, API payloads, backend behavior, and dependencies.
  Browser coverage now exercises queued-to-result form initialization, retry
  polling (stubbed retry, no extra analysis), empty catalog feedback and review
  accessibility, collapsed values, mobile scan navigation, clear-search sorting,
  upload focus, and 360px layout. Windows WebKit skips links in its default Tab
  order (reproduced on a minimal page), so the shared keyboard smoke test uses
  collection, which includes a search input. All 56 matrix checks and 79 unit
  tests pass, as do lint/typecheck/build and changed-file formatting. Full
  `npm run check` still stops at the same three unrelated formatting failures
  found before edits: `aws/README.md`, `infra/terraform/bootstrap/terraform.tfstate`,
  and its `.backup`. These files were untouched. Inspected local phone scan,
  full-image preview, review, and desktop dashboard screenshots. Compose services
  were started for the isolated e2e database/queue and remain running; the test
  server/worker stopped normally. No live AI calls, deployment, commit, or push.
  Real cover thumbnails, batch navigation, and copy-editor error handling are
  separate follow-ups. The generated Next type imports were restored by the
  final normal build.

- **2026-09-05 - Codex.** Replaced the local-only development database secret
  with the maintainer-provided Supabase session-pooler endpoint on IPv4 port 5432. Repaired a malformed missing query delimiter without exposing the
  credential, retained `sslmode=require`, removed unsupported
  `channel_binding=require`, and verified both database reachability and
  client-side TLS negotiation with `psql`. Extended the deployment workflow's
  database guard to reject URLs that do not explicitly require TLS. Deployment
  run `34001697979` then failed because the web Lambda was accidentally deleted
  between Terraform reconciliation and secret injection. Fresh-SHA run
  `34002332466` recreated it and reached the migration, which exposed Node
  `pg`'s temporary interpretation of `sslmode=require` as `verify-full` and its
  rejection of the Supabase certificate chain. Added `uselibpqcompat=true` to
  the stored URL so `require` retains standard libpq semantics (mandatory
  encryption without certificate verification), then successfully applied all
  11 repository migrations to Supabase. Final deployment run `34002645203`
  passed image builds, both Terraform applies, secret injection, idempotent
  migration confirmation, API/event trigger activation, and its HTTP smoke
  test. Independently verified `/api/healthz` returns `status: ok` and
  `/api/readyz` returns `status: ready` at
  `https://dev-vh.siliconforest.io`.

- **2026-09-05 - Codex.** Platform run `33995480727` passed all Terraform,
  Kubernetes, three-image build/scan, and SBOM jobs after the expiring Trivy
  waiver. Development run `33995480784` then successfully created both Lambda
  functions, the full `dev-vh.siliconforest.io` certificate/DNS resources, and
  the rest of the first-apply stack, proving the hostname and image-manifest
  fixes; it stopped safely before triggers because secret containers had no
  values. With explicit maintainer authorization, copied the four existing
  `.env` values directly to AWS Secrets Manager without logging them and
  verified one `AWSCURRENT` version per secret. Redeploy commit `44c4ec3`
  successfully loaded and injected all secrets, but migration failed because
  the local `DATABASE_URL` resolves to `host.docker.internal`, which GitHub and
  AWS cannot reach. Triggers remain disabled. Added a workflow guard that
  rejects local-only database hosts with an actionable error. An external TLS
  PostgreSQL URL is the sole blocker to completing migration, trigger enablement,
  and live HTTP smoke tests.

- **2026-09-05 - Codex.** Diagnosed development deployment run `33991720573`:
  GitHub obtained an OIDC token, but AWS rejected it before builds or Terraform.
  CloudTrail showed the actual subject as the stable-ID form
  `repo:jessig1@13804284/vinylhound_new@1345526931:environment:development`,
  while bootstrap trusted the legacy name-only prefix. GitHub's OIDC
  customization API confirmed that stable prefix. Updated bootstrap plan and
  environment trust policies to use the exact prefix and documented how forks
  retrieve and override it. Applied the bootstrap update to the existing
  `vinylhound-tf` state: all four GitHub IAM roles changed in place with no
  resources created or destroyed, and the next deployment authenticated
  successfully.

- **2026-09-05 - Codex.** Continued development deployment run `33991720573`
  through three attempts. Corrected the development ECR variables from bare
  names to full account/region repository URLs, after which both runtime images
  built and pushed successfully. The first Terraform apply then exposed two
  configuration defects: `APP_HOSTNAME=dev-vh` was not an ACM-compatible FQDN,
  and Buildx's attached attestations produced image indexes unsupported by
  Lambda. Corrected the live hostname to `dev-vh.siliconforest.io`; added an
  early workflow hostname guard and matching Terraform validation; and disabled
  attached provenance/SBOM metadata for the two development Lambda images.
  Standalone SBOM generation remains in the platform CI workflow. The patched
  development Terraform root validates with Terraform 1.13.3, and affected
  YAML/Markdown files pass Prettier. Pushed these corrections as `a8b2bec`; its
  deployment run was subsequently cancelled due to the platform finding below.

- **2026-09-05 - Codex.** Platform run `33994598016` correctly blocked the
  worker-Lambda image on HIGH-severity `CVE-2026-14456`: the pinned AWS Lambda
  Node.js 22 arm64 base contains OpenSSL `3.5.7-2.amzn2023.0.1`, while Trivy
  reports `.0.2` as fixed. AWS's current `nodejs:22` arm64 tag still contains
  `.0.1`, and `dnf upgrade` against the image's repositories reports no update
  available. Cancelled concurrent deployment run `33994597990` before it could
  activate that image. Added a single-CVE Trivy waiver expiring 2026-10-05 and
  explicitly wired it into the platform scan. A local Trivy 0.70 scan of the
  rebuilt arm64 image then passed with zero unsuppressed HIGH/CRITICAL findings.
  Remove the waiver and update the pinned Lambda base digest as soon as AWS
  publishes the fixed package.

- **2026-09-05 - Codex.** Added Terraform bootstrap validation for S3 state
  bucket naming after AWS rejected the maintainer's underscore-containing
  `vinylhound_tf` value. The bootstrap README now gives a valid hyphenated,
  globally unique account-ID example, so future invalid names fail locally
  before an AWS create request.

- **2026-09-05 - Codex.** Diagnosed the maintainer's repeated Terraform 1.8.4
  bootstrap error as WSL resolving `/usr/bin/terraform` while Windows had the
  newly installed 1.13.3 package. Downloaded the official Linux 1.13.3 archive,
  verified it against HashiCorp's published SHA-256 checksum, and installed it
  at `/usr/local/bin/terraform`, ahead of `/usr/bin`. The maintainer's exact
  bootstrap init now succeeds in WSL and `terraform validate` passes. Retained
  the Linux AWS-provider package hash that WSL added to the bootstrap lock;
  removing it correctly caused cached-package verification to fail. Windows
  1.13.3 formatting/validation passes for all four roots, and the milestone's
  GitHub Linux Terraform validation job also passed. Parallel extra-root WSL
  initialization hit NTFS provider-cache I/O errors, so do not share a
  `.terraform` provider directory between Windows and WSL when revalidating.

- **2026-09-05 - Codex.** Built and locally smoke-tested all three runtime
  images. The first build exposed an invalid variable-based `COPY --from` in
  `Dockerfile.web`; a named Lambda-adapter stage fixes it. The Lambda worker
  also ran as root locally and retained npm, so its final stage now removes
  package-manager tooling and selects UID/GID 65534. The final top-level
  `npm run container:build` succeeds. Web returned 200 for liveness, readiness,
  and `/`, reached Docker `healthy`, ran as UID 1000 without npm, and contained
  an executable Lambda adapter. The worker applied all 11 migrations to an
  isolated database, produced a fresh heartbeat, ran as UID 1000 without npm,
  and completed SIGTERM shutdown with exit code 0. The Lambda image cold-started
  locally as UID 65534 without npm, returned zero EventBridge publications from
  an empty database, and returned the expected partial-batch failure for an
  invalid SQS record. OpenAI was disabled or replaced by a non-real placeholder;
  disposable databases/containers were removed and Compose dependencies were
  returned to their initially stopped state. The maintainer authorized this
  verified redesign for an infrastructure milestone commit and push before the
  real AWS plan gate.

- **2026-09-03 - Codex.** Resumed an interrupted, uncommitted AWS platform
  redesign and completed its repository implementation. Added the development
  Lambda/API Gateway/SQS root, production EKS/CloudFront/WAF/SQS root and
  Kubernetes workloads, SQS queue adapter/tests, production expiry teardown,
  worker migration and Lambda entrypoints, and worker shared-package runtime
  compilation for hardened images. Corrected Terraform syntax/state-address
  compatibility, Lambda visibility timeout, CloudFront-origin networking, EKS
  Pod Identity/observability, and workflow manifest validation. Recorded the
  design in ADR-0016 and synchronized operational, architecture, security,
  testing, roadmap, API, and repository documentation. Checks, builds,
  actionlint, kubeconform, and all four Terraform validations pass. A final
  container build attempt reached Docker but its daemon reported that Docker
  Desktop was unable to start, so Docker runtime verification and real AWS
  plans remain the next gates.

- **2026-09-02 - Codex.** Pushed `a8bdff5` (`fix pre-activation pipeline
failures`) and verified the resulting GitHub Actions runs: CI, Security,
  staging, Terraform validation, and both container build/Trivy/SBOM jobs all
  completed successfully. The only intentionally skipped jobs were CodeQL and
  SARIF publication until the repository becomes public, the AWS plan absent a
  trusted pull request, and deployment work absent environment configuration.

- **2026-09-02 - Codex.** Diagnosed the first GitHub Actions runs after Phase 2
  delivery using authenticated read-only API/log access. CI and Terraform
  validation passed; Gitleaks itself was clean. Corrected private-repository
  CodeQL/SARIF upload handling, activation guards and environment-variable
  loading for staging/deactivation/production, and removed unused npm/corepack
  from final runtime images to eliminate Trivy's inherited critical findings.
  Local workflow formatting, `npm run check` (73 tests), and `npm run build`
  pass. Push the follow-up and require clean CI, Security, and Platform runs.

- **2026-09-02 - Codex.** Ran `npm run check` (73 tests) and `npm run build`
  successfully, then committed and pushed the complete Phase 2 implementation
  to `main` as `f29016e` (`add Phase 2 public deployment platform`). The next
  maintainer action is to review the resulting GitHub CI, Security, and
  Platform workflow results before the visibility-change gate.

- **2026-09-02 - Codex.** The maintainer rotated the historical Gemini key and
  deleted its sole containing branch, `experiment/gemini-vs-openai`. A local
  ref audit and GitHub `ls-remote` verification confirmed that neither local
  nor remote branches contain the exposing commit; `main` was never affected.
  Updated the Phase 2 activation sequence to require a clean Gitleaks workflow
  run, then public visibility and repository-settings automation (the script
  itself refuses private repositories).

- **2026-09-02 - Codex.** Implemented VinylHound Phase 2 at repository level:
  public-repository governance, runtime/container hardening, task-role/default
  AWS credentials, TLS/pool configuration, worker drain/reconciliation and
  metrics, Terraform bootstrap plus isolated JIT environments, GitHub OIDC
  delivery/cleanup workflows, cost/security/scaling/observability controls,
  ADR-0015, and synchronized platform documentation. Hardened the result during
  verification by splitting web/worker execution-secret roles, adding a real
  worker heartbeat and shutdown ordering, excluding Terraform providers from
  container contexts, adding trusted internal-PR plans, serializing deployment
  and expiry workflows, and provisioning runtime/migrating before ECS service
  rollout. `npm run check` (73/73), `npm run build`, actionlint, and both
  Terraform validates pass. Local Docker image verification is outstanding
  because Docker Desktop's daemon became unresponsive. The required redacted
  full-history audit found a real historical Gemini credential matching the
  ignored local `.env`; public visibility is explicitly blocked pending
  rotation and an approved coordinated history rewrite. Nothing was applied to
  GitHub or AWS, committed, pushed, or made public.

- **2026-08-31 - Codex.** Replaced the dashboard shell's fixed Collection
  (`48`) and Wishlist (`12`) navigation badges with per-user database counts
  fetched by the server layout. `npm run typecheck` passes.

- **2026-08-31 - Codex.** Added a public `/privacy` notice linked from the
  landing page, and implemented per-copy `PATCH`/`DELETE` endpoints with
  ownership checks, parent-item locks, and collection-page controls for copy
  location, acquisition date, notes, and deletion. The remaining private AI
  evaluation cannot safely run yet: the private 52-case manifest exists and
  an API key is configured, but zero cases meet its required maintainer
  verification/consent readiness gate. No billable calls were made. `npm run
typecheck` passes.

- **2026-08-31 - Codex.** Audited `docs/ROADMAP.md` at the maintainer's
  request and replaced the dashboard's hard-coded `data.ts` content with live,
  authenticated database reads: three latest scans, collection/wishlist
  previews, and exact server-side item counts. Replaced the fixed date and
  boilerplate labels with current or data-derived content and added explicit
  empty states. The audit confirmed the roadmap still explicitly defers a
  published privacy notice, per-copy editing/deletion, and the private AI eval
  baseline; it is therefore not fully complete. `npm run check`, `npm run
build`, and `git diff --check` pass. Changes are uncommitted and coexist
  with unrelated existing working-tree changes.

Newest first. One entry per agent session: date, agent, what changed, what was
decided.

- **2026-08-31 - Codex.** Added GitHub security automation. The new Security
  workflow runs CodeQL, a full-history/redacted Gitleaks scan with SARIF upload,
  and pull-request dependency review; all are visible Action runs and status
  checks, while CodeQL/Gitleaks alerts appear in the Security tab. Added weekly
  npm Dependabot configuration and documented the repository settings/branch
  protections a maintainer must enable. No GitHub settings were changed because
  this workspace has no repository-administration credential.

- **2026-08-31 - Codex.** Implemented the skipped Milestone 4 operations
  slice. Added `docs/OPERATIONS.md`, production service/backup/monitoring and
  alert guidance, public liveness/readiness probes, structured worker startup
  and outbox-publish logs, and the `ops:restore-test` command. The restore
  drill passed against the local Compose Postgres service and cleans up only
  its dedicated `vinylhound_restore_verification` database and temporary dump.
  Added transactional per-user daily analysis, active scan, and rolling spend
  protections (with active-job cost reservation) before outbox submission and
  retry; quota failures are HTTP 429. Added config coverage and a database
  integration quota test. `npm run check` passed (71 unit tests),
  `npm run test:database` passed (26 integration tests), and the restore drill
  passed. No cloud provider resources were provisioned because no provider
  account, region, or deployment authority was supplied.

- **2026-08-31 - Codex.** Implemented Milestone 4 task 3: added axe-core
  WCAG 2 A/AA checks for the main authenticated routes and a keyboard-focus
  e2e check; added visible focus, skip navigation, reduced-motion behavior,
  explicit alert semantics, and a label for the destructive-confirmation
  input. Expanded Playwright into mobile Chromium (fast default), desktop
  Chromium, desktop Firefox, and mobile WebKit; `test:e2e:matrix` runs all
  profiles. Installed Firefox/WebKit locally. `npm run check` passes (69/69).
  The local e2e/matrix run could not start because this Windows session's
  Node 22 began failing `os.userInfo()` with `uv_os_get_passwd` `ENOMEM` while
  the synthetic e2e worker starts; this is environment-level (a direct
  `node -e` reproduces it), not an assertion failure. Preserve the existing
  uncommitted Clerk redirect edits in the sign-in/sign-up pages when committing
  this work.

- **2026-08-31 - Claude (fifth session, same conversation).** At the
  maintainer's request, wired real Clerk test-mode keys into `.env` to
  finally exercise `AUTH_MODE=production` for real — and found that it
  didn't work: `/dashboard` returned `200` unauthenticated instead of
  redirecting to `/sign-in`. Root-caused it to `@next/env`'s `loadEnvConfig`
  silently returning a stale cache on any call after the first in a process
  unless `forceReload: true` is passed; Next.js's own internal call (scoped
  to `apps/web`, no monorepo-root `.env`) runs first and poisoned the cache
  for both of this repo's own `loadEnvConfig` calls
  (`next.config.ts`, `apps/web/src/server/context.ts`), so `AUTH_MODE`/
  Clerk's keys were `undefined` at request time despite being set correctly
  in `.env` — reproduced and confirmed the exact mechanism with a standalone
  Node script before touching any code. Fixed both call sites with
  `forceReload: true`, and added a `next.config.ts` `env` block so Edge
  middleware's separately-compiled bundle (which never executes
  `next.config.ts`'s `loadEnvConfig()` at request time) gets the values
  statically inlined. Also fixed `apps/web/e2e/env.ts`, which broke as a
  direct consequence: e2e's tests navigate straight to protected routes with
  no sign-in step, so once `AUTH_MODE=production` actually worked, a local
  `.env` set to `production` (as it now is, for this verification) started
  failing the entire e2e suite by redirecting every test to `/sign-in`;
  fixed by forcing `AUTH_MODE=development` explicitly in the e2e env
  builder rather than inheriting whatever `.env` has. Verified with real
  Clerk keys: `/dashboard` correctly redirects with genuine Clerk auth
  headers, `/sign-in` renders Clerk's real hosted UI (screenshotted), and
  `npm run check` (69/69)/`test:integration` (33/33)/`test:e2e` (5/5) all
  still pass. Documented the full root cause as an amendment to ADR-0013
  rather than a new ADR, since it corrects a claimed-but-unverified
  behavior rather than changing the design. Also declined to run a
  pasted Clerk-CLI setup skill against this repo (would have re-scaffolded
  over the existing hand-built integration) after confirming with the
  maintainer it wasn't the intended path. Uncommitted; the maintainer
  should review before commit.

- **2026-08-31 - Claude (fourth session).** Committed and pushed task 1
  (production authentication, `9507cad`) at the maintainer's request, then
  completed Milestone 4 task 2, account export and deletion (ADR-0014).
  Investigated the schema first and found a real design problem before
  writing any code: `scan_confirmations.library_item_id`/`.release_id` are
  deliberate `restrict` FKs (ADR-0011) that would make a plain cascading
  delete of a `users` row fail with a foreign key violation, since Postgres
  does not guarantee `scans` cascade before `library_items` is touched in
  the same operation. Confirmed the resolution with the maintainer (delete
  `scan_confirmations` directly first, in the same transaction, rather than
  soft-delete/anonymize) and confirmed export scope (metadata-only JSON, no
  image bytes) before implementing either. New `packages/database/src/
account-repository.ts` (`getAccountExportForUser`, `deleteAccount`) and
  `packages/contracts/src/account.ts`; new `GET /api/v1/account/export` and
  `DELETE /api/v1/account` routes; a new "Your data" section on `/account`
  with a type-to-confirm delete flow, verified end-to-end with a scripted
  Playwright check (button stays disabled until the exact phrase is typed)
  and a screenshot. Added 4 new database integration tests (export,
  export-not-found, delete-with-restrict-fks-and-shared-catalog-preserved,
  delete-not-found) and 4 new contract tests. Verified: `npm run check`
  (69/69 unit tests), `npm run test:integration` (33/33), `npm run build`
  (30 routes, +2), `npm run test:e2e` (5/5). **Made a real mistake while
  manually verifying the delete route**: a `curl -X DELETE` intended only to
  inspect response headers executed for real against the local dev
  database's `DEVELOPMENT_USER_ID` account, destroying its accumulated
  scan/image/library history from every prior session's manual testing (a
  fresh empty row was auto-reprovisioned under the same ID, so the app still
  works). Disclosed this to the maintainer immediately; confirmed the local
  data did not need recovering. Updated `docs/API.md`, `docs/SECURITY.md`
  (the retention policy is now stated concretely instead of describing a
  future gap), `docs/ROADMAP.md`, and this file. Uncommitted; the maintainer
  should review before commit.

- **2026-08-31 - Claude (third session).** Started Milestone 4 (checked with
  the maintainer first, since the roadmap only listed broad areas, not
  discrete tasks) and completed task 1, production authentication
  (ADR-0013). Confirmed the approach with the maintainer at each expensive-
  to-reverse decision point before implementing: hosted identity provider
  over self-hosted Auth.js, Clerk specifically, Clerk's default hosted
  `<SignIn>`/`<SignUp>` UI over reproducing the app's bespoke fake auth
  form, and keeping the existing landing page (stripped of its fake-session
  logic) rather than redirecting `/` straight to `/sign-in`. Added
  `users.clerk_user_id` (migration 011, nullable with a placeholder
  backfill), `getOrCreateUserIdByClerkId`, a `requireUserId` helper
  replacing every route/page's `DEVELOPMENT_USER_ID` read, and
  `apps/web/src/proxy.ts` (Next.js 16's Proxy convention) for route
  protection. `AUTH_MODE` widened from a literal to a real
  `development`/`production` switch; a `NEXT_PUBLIC_AUTH_MODE` mirror lets
  client components branch without a `<ClerkProvider>` in development mode.
  The Playwright e2e run caught a real bug before commit: the first version
  of the proxy gated Clerk logic from _inside_ `clerkMiddleware()`'s
  callback, but `clerkMiddleware()` itself throws at construction time
  without a publishable key, hanging every request in development mode;
  fixed by only constructing `clerkMiddleware()` at all when
  `AUTH_MODE=production`, exporting a plain pass-through otherwise. Also
  installed Node 22.23.2 via nvm-windows on this machine (previously only
  v20.17.0, which fails this repo's `--env-file-if-exists` usage) so
  `npm run check`/`test:integration`/`test:e2e` now run directly on Windows.
  Verified: `npm run check` (65/65 unit tests, 4 new), `npm run
test:integration` (29/29, 2 new), `npm run build` (28 routes, +2), and
  `npm run test:e2e` (5/5, run in development mode — production mode's
  Clerk path was verified statically, not against a real account; see
  Resume point). Uncommitted; the maintainer should review before commit.

- **2026-08-31 - Claude (second session).** Completed the remaining half of
  Milestone 3 task 3: library search, sort, and CSV export (ADR-0012),
  finishing Milestone 3 except the explicitly-deferred per-copy edit/delete.
  Confirmed scope with the maintainer up front (search/filter/export only,
  not per-copy management) and confirmed the search-matching design
  (filter in application code against the same displayed artist/title the
  page renders, not raw SQL columns, since a scan confirmation's corrected
  values can differ from the shared `albums` row) and the search UX (debounced
  auto-submit via a small client toolbar, not a manual-submit form) before
  implementing either. `GET /library` gained `q`/`sort` query params behind a
  new `LibraryQuerySchema`; a new `GET /library/export` route returns the same
  filtered/sorted list as CSV. Wired up the collection/wishlist pages'
  previously non-functional search box and sort button. Verified in WSL/Node
  22.23.2: `npm run check` (61/61 unit tests), `npm run test:integration`
  (27/27), `npm run build` (26 web routes), `npm run test:e2e` (5/5,
  unchanged). Manually verified search/sort/export end-to-end against real
  seeded data in a running WSL dev server (a stale dev server process from an
  earlier session had to be killed and restarted first — its build predated
  this session's new contract exports and was throwing on every `/library`
  request); cleaned up the manually-seeded rows afterward, leaving
  pre-existing real/leftover-test data untouched. Uncommitted; the maintainer
  should review before commit (together with the still-uncommitted ADR-0011
  work from the prior session).

- **2026-08-31 - Claude.** Completed direct wishlist-to-owned/owned-to-wishlist
  conversion (ADR-0011), scoping down Milestone 3 task 3 after confirming with
  the maintainer to split it: this session did direct `PATCH`/`DELETE
/library/{itemId}` and left search/filter/export and per-copy edit/delete for
  next time. Found and finished an uncommitted, undocumented draft of
  `UpdateLibraryItemSchema` already sitting in the working tree (no prior
  session had logged it); simplified it from `{ list?, notes?, copy? }` to
  `{ list?, notes? }` after confirming with the maintainer that per-copy
  editing needs its own sub-resource design given the one-item-to-many-copies
  model. The first integration test run caught a real bug before commit: the
  initial `deleteLibraryItem` let a raw Postgres FK violation
  (`scan_confirmations_library_item_id_fkey`, `restrict` by design) escape
  instead of failing cleanly, which would have affected nearly every real
  library item since almost all of them have confirmation history. Fixed by
  checking for `scan_confirmations` rows first and rejecting with a clear
  `invalid_state` error; confirmed the resulting scope (confirmed items can't
  be hard-deleted yet) with the maintainer before proceeding. Also corrected
  pre-existing `docs/API.md` drift (a documented `POST /library` route that
  was never implemented). Verified in WSL/Node 22.23.2: `npm run check`
  (57/57 unit tests), `npm run test:integration` (26/26), `npm run build`
  (25 web routes), `npm run test:e2e` (5/5, unchanged). Manually exercised the
  new routes' error paths against a running WSL dev server; the Docker
  Postgres instance had no real library data to exercise the success path
  against (see "Current state"). Uncommitted; the maintainer should review
  before commit.

- **2026-08-31 - Codex.** At the maintainer's request, committed and pushed the
  validated accumulated audit and Milestone 3 tasks 1-2 work as `c8f99cd`
  (`add MusicBrainz catalog integration`), including the existing one-line
  `suppressHydrationWarning` layout adjustment. Refreshed workspace links with
  `npm install`; `npm run check` passes in WSL (53/53 unit tests). The Windows
  Node runtime could not run the check due its restricted home-directory path.

- **2026-08-31 - Codex.** Enabled multi-file selection on the camera/fallback
  file inputs while in Multiple records mode; the dedicated upload inputs
  already supported multi-select. Kept One record camera capture single-file
  and added an e2e assertion covering the formerly missing `multiple`
  attribute. Prettier, focused ESLint, and typecheck pass in WSL/Node 22.23.2;
  the targeted batch-upload Playwright test passes (1/1).

- **2026-08-31 - Codex.** Completed Milestone 3 task 2. Added the catalog port,
  rate-limited/cached/retrying MusicBrainz adapter, review-page catalog search,
  richer release contracts/persistence, namespaced catalog references, and the
  separate physical-copy model (migration 010, ADR-0010). Confirmation remains
  atomic and idempotent: wishlist creates no copy, wishlist-to-owned creates the
  first copy, and a later scan of the same MBID creates another copy beneath the
  same library item. Added contract, adapter, and database integration coverage.
  Verified `npm run check` (53/53 unit tests), `npm run test:integration`
  (20/20), `npm run build` (24 web routes plus worker/evals), and
  `npm run test:e2e` (5/5) in WSL/Node 22.23.2.

- **2026-08-31 - Codex.** Independently reviewed Milestone 2 against the
  roadmap, ADRs, implementation, and full test stack. Confirmed the main four
  slices, then fixed five uncovered edge cases: transactional server enforcement
  of the 20-scan batch cap (with idempotent replay), `batch_upload` provenance,
  polling restart after retrying an all-terminal batch, original-object fallback
  for images completed before migration 009, and longest-prefix pricing for
  versioned Terra/Luna model IDs. Corrected the stale retry state in
  `docs/DOMAIN.md`, restored production `next-env.d.ts` imports via the build,
  and ignored local `.claude` settings so checks are reproducible. Completed
  Milestone 3 task 1 by comparing current official MusicBrainz and Discogs
  documentation, selecting MusicBrainz in ADR-0009, and documenting lookup,
  deduplication, rate-limit, licensing, provenance, and adapter acceptance
  requirements. Verified WSL/Node 22.23.2: `npm run check` (49/49 unit tests),
  `npm run test:integration` (20/20), `npm run test:e2e` (5/5), and
  `npm run build`. Changes are uncommitted. A concurrent
  `apps/web/src/app/layout.tsx` edit was preserved and not reviewed as part of
  this work.

- **2026-08-30 - Claude (fourth session).** Committed and pushed the prior
  session's thumbnail/normalization work (`43de522`, on top of already-pushed
  `a1ac19d`/`dd349a1`) at the maintainer's request, then implemented
  Milestone 2's last remaining slice, batch and provider-cost dashboards
  (ADR-0008), completing Milestone 2. Moved the per-model USD/million-token
  pricing table and cost formula from the private `packages/evals` into
  `packages/domain` (`provider-pricing.ts`) so both the eval harness and
  production share one definition; `evals` now re-exports the domain values
  instead of duplicating them, verified unbroken via its own unit tests and
  package build. Added `getBatchCostSummary` and `getUsageSummaryForUser` to
  `packages/database`, a shared `UsageCostSummarySchema` and new `usage.ts`
  contract, a `cost` field on `GetBatchResponse`, a new `GET /api/v1/usage`
  route, and a new `/account/usage` page. Updated the batch progress page to
  show a cost/token summary line and added a link from `/account`. Fixed one
  existing contract test that needed the new required `cost` field. Verified
  in WSL/Node 22.23.2: 48/48 unit tests, lint, typecheck, build (23 routes,
  +2), 18/18 integration tests (10 database, +1 new covering cost
  aggregation), and 5/5 e2e tests; one worker-suite run hit a transient,
  pre-existing Postgres deadlock unrelated to this session's changes and
  passed cleanly on re-run. Manually launched the app in a WSL dev server
  and screenshotted both new/changed pages against real accumulated
  database data to confirm they render correctly (see "Current state").
  Updated `docs/API.md`, `docs/TESTING.md`, `docs/ROADMAP.md` (Milestone 2
  now marked complete; next task points at Milestone 3), and this file.
  Batch/dashboard work is uncommitted; the maintainer should review before
  commit.
- **2026-08-30 - Claude (third session).** Implemented Milestone 2's third
  slice, the thumbnail/normalization pipeline (ADR-0007): migration 009
  (`image_assets` analysis/thumbnail size and dimension columns, a
  before/after check constraint), a new `normalizeImage` in
  `packages/storage` (bounded JPEG analysis copy and thumbnail derived from
  already-decoded upload bytes), a new `ObjectStorage.putObject` for direct
  server-side writes, a shared `deriveImageObjectKey` helper in
  `packages/database`, upload-completion route changes to generate and store
  both derived objects, and a `prepareScanAnalysis` change so scan analysis
  reads the analysis copy instead of the full-resolution original (no worker
  code changed — it already reads whatever object key it's given). Also
  investigated and corrected a stale known-gap claim: worker concurrency
  limiting (`ANALYSIS_CONCURRENCY`) already existed since Milestone 1 and
  needed no new work; only the thumbnail/normalization half of the roadmap
  line was actually outstanding. Updated 5 existing `completeImageUpload`
  call sites across two integration test files to supply the new required
  fields, and fixed one integration test's storage stub whose fixed 3-byte
  stub response no longer matched the fixture's `analysisSizeBytes`. Added
  new unit coverage for `normalizeImage`'s size bounds. Verified in WSL/Node
  22.23.2 against the running Docker services: 48/48 unit tests
  (2 new), lint, typecheck, build (21 routes), 17/17 integration tests
  (migration 009 applied), and 5/5 e2e tests (which now exercise the real
  normalization pipeline against MinIO on every upload). Updated
  `docs/API.md`, `docs/TESTING.md`, `docs/ROADMAP.md`, and this file.
  Nothing committed or pushed; the maintainer should review before commit.
- **2026-08-30 - Claude (second session).** Implemented Milestone 2's batch
  slice end to end: contracts (`batch.ts`, `canceled` status, `RetryScanResponse`/
  `CancelScanResponse`/`ListScansResponse`), migration 008 (`batches` table,
  `scans.batch_id`, `canceled` enum value), repository functions
  (`createOrGetBatch`, `getBatchForUser`, `retryScan`, `cancelScan`,
  `listScanSummariesForUser`, `listScansForUser`), an outbox/worker change so
  a canceled scan's job is skipped rather than dispatched or analyzed, five
  new API routes, a `/scan` mode toggle for batch capture, a new
  `/scans/batch/{batchId}` progress page with per-item cancel/retry, and a
  real-data rewrite of `/scans`. Wrote ADR-0006 recording the batch-as-
  grouping and best-effort-cancellation design. Found and fixed two real bugs
  via integration tests before they could ship (see "Recently completed"
  above for detail) and one `.strict()` schema mismatch via the e2e suite.
  Verified in WSL/Node 22.23.2: 46/46 unit tests, lint, typecheck, build
  (21 routes), 17/17 integration tests, and 5/5 e2e tests, including a new
  batch e2e scenario. Updated `docs/API.md`, `docs/TESTING.md`,
  `docs/ROADMAP.md`, and this file. Nothing committed or pushed; the
  maintainer should review before commit.
- **2026-08-30 - Claude.** Resumed the Milestone 2 multi-view slice that Codex
  had left uncommitted (no handoff entry for it). Reviewed the full diff
  (contracts, schema/migration 007, repositories, AI adapter/prompt v3,
  worker, `/scan` UI, tests) end to end before continuing; found it complete
  and coherent, so finished it rather than restarting. Fixed Prettier
  formatting on 4 files flagged by `npm run check`. Verified in WSL/Node
  22.23.2 against the running Docker services: 39/39 unit tests, lint,
  typecheck, and build all pass; applied migration 007 and ran
  `npm run test:integration` (13/13, including a new multi-view worker test).
  Installed Playwright Chromium and its OS dependencies
  (`playwright install-deps`, with the maintainer running the sudo step), then
  added and passed a new e2e scenario grouping front/back/spine photos into
  one labeled scan (4/4 e2e tests). Updated `docs/API.md` with the `viewType`
  field, `docs/TESTING.md` with the new e2e coverage and the WSL
  `install-deps` requirement, and `docs/ROADMAP.md` to check off the
  completed slice and point the next resume at Milestone 2's batch slice. No
  ADR added: this extends the existing AI-identification request/response
  contract (ADR-0002) rather than changing a service boundary or provider.
  Nothing committed or pushed; the maintainer should review before commit.
- **2026-08-29 - Codex.** Closed Milestone 1 at the maintainer's direction after
  the Sol + `high` + prompt-v2 flow proved good enough for the early build. The
  formal private AI baseline is explicitly deferred until public rollout or
  model/cost optimization, and the resume point now begins Milestone 2 with
  multi-view scans.
- **2026-08-29 - Codex.** Simplified production album identification around the
  maintainer's actual goal. Changed the default and ignored local configuration
  from Terra to Sol while retaining `high` detail, introduced artist/title-first
  prompt v2, prevented missing pressing/edition evidence from being requested as
  an album-level review reason, added focused tests, and reframed the formal eval
  harness as optional until public rollout or optimization. `npm run check`
  (35/35 tests) and `npm run build` pass in WSL/Node 22. No live OpenAI calls
  were made.
- **2026-08-29 - Codex.** Implemented the requested Sol/Terra × high/auto
  experiment. Added multi-detail CLI execution, model/detail-keyed attempts and
  aggregates, schema-v2 checkpoints, a dedicated `eval:ai:vision-matrix`
  command, matrix unit coverage, and five documented test iterations. The real
  manifest dry-run reaches the readiness gate but has no development cases yet.
  `npm run check` (32/32 tests) and `npm run build` pass in WSL; no billable API
  calls were made.
- **2026-08-29 - Codex.** Diagnosed reported image-analysis quality and latency
  without changing runtime behavior. The database audit confirmed three
  byte-identical uploads produced unstable Terra results and 8.1-25.2 second
  durations. Identified likely contributors: single-image UI, `detail: high`
  downsampling, conservative edition-aware prompt/review routing, no image
  preprocessing, no catalog retrieval, and no completed eval baseline.
- **2026-08-29 - Codex.** Repaired the local WSL worker connection without
  deleting data: rotated the development PostgreSQL role, synchronized the
  ignored `.env`, and changed only `DATABASE_URL` to use
  `host.docker.internal` because WSL's `localhost:5432` reaches a separate
  PostgreSQL server. Docker PostgreSQL authentication and the normal WSL
  migration command were verified; the schema is current.
- **2026-08-29 - Codex.** Implemented `packages/evals`, a private live-model
  comparison CLI defaulting to GPT-5.6 Sol/Terra/Luna. Added strict manifest,
  consent, and maintainer-verification gates; request-by-request checkpoints;
  rank-1/top-3, edition, routing, schema/error, latency, token, and estimated-cost
  metrics; three test files; and `docs/EVALUATION.md`. Formatting, ESLint,
  typecheck, the eval package build, and 31/31 unit tests pass via direct Node
  entry points. No billable API calls were made; Node 22+ and completed private
  labels are still required for the baseline.
- **2026-08-29 - Codex.** Created a private 52-case single-image evaluation
  manifest and labeling prompt beside the maintainer's album photos. The
  manifest separates ChatGPT/Gemini suggestions from maintainer-verified ground
  truth and remains outside Git. No application code changed.

- **2026-08-29 — Codex.** Read-only project-state evaluation. Verified a
  clean working tree, `npm run check` (22/22 tests), and `npm run build`.
  Docker Desktop is stopped, so integration and e2e tests were not rerun.
  Corrected the stale claim that no browser e2e suite exists and recorded that
  `main` is two commits ahead of `origin/main`.
- **2026-08-26 — Claude (fifth session).** Confirmed the full pipeline works
  with real analysis. Built the phone-sized Playwright e2e suite (3 tests,
  passing): isolated production server, e2e database/queue, synthetic worker.
  Updated `docs/TESTING.md` and `docs/ROADMAP.md`; only the AI eval baseline
  remains in Milestone 1. `npm run check` and `npm run build` pass.
- **2026-08-26 — Claude (fourth session).** Investigated a post-fix 422 on
  the same `.webp` file. Proved via database checksums and a live end-to-end
  reproduction (`tmp/diagnose-upload.mjs`) that the server pipeline is
  correct for all WebP variants and the retry ran the stale pre-fix browser
  bundle. Removed the diagnostic scans and objects. No code changed.
- **2026-08-26 — Claude (third session).** Committed the vertical slice
  (`8c692ed`). Fixed the upload rejection: added magic-byte sniffing to
  `packages/contracts` with tests, switched the scan page to declare the
  sniffed MIME type, and noted the client behavior in `docs/API.md`.
  `npm run check` (22 tests) and `npm run build` pass. Nothing pushed.
- **2026-08-26 — Claude (second session).** Recorded the in-flight WebP
  upload-rejection investigation as the resume point, with an independent
  read-only evaluation of the likely cause (extension-derived `File.type`
  versus server magic-byte sniff). No application code changed.
- **2026-08-26 — Claude.** Evaluated project state; verified `npm run check`
  and `npm run build` pass. Created `CLAUDE.md` and this handoff file; linked
  both from `AGENTS.md`. No application code changed.

- **2026-09-08 - Codex.** Created the requested Phase 3-4 roadmap from the
  review and handoff: ten milestones with sequencing, acceptance evidence,
  cost/runtime gates, and deferrals. Included image reads, quotas, tracing,
  compatibility fixtures, generalized outbox, catalog ownership, audit/deletion
  invariants, and staged Terraform ownership transfer. Updated current state and
  resume point; preserved existing handoff history and package-lock edits.
  Validation: edited-document Prettier checks pass. `npm run check` stopped
  at existing formatting issues in 179 other files; lint/typecheck/tests were
  not reached. No application/infrastructure changes; build not required.

- **2026-09-08 - Codex.** Reworked batch scan review into compact album cards
  with cover thumbnails, artist/title/year, visible result state, and direct
  high-confidence save actions for collection or wishlist. Added the
  authenticated 60-second signed-thumbnail read endpoint (owner-scoped,
  `private, no-store`, original fallback for pre-thumbnail records), exposed a
  thumbnail image ID in the batch contract, and retained detailed review for
  corrections. `npm run check` passes (79 tests); the web build completed and
  produced `.next/BUILD_ID`.
- **2026-09-08 - Codex.** Removed the batch-card review dead end: both matched
  and needs-review candidates now provide direct collection/wishlist confirmation.
  Rejecting a proposed match offers a new scan or opens the same scan in
  manual-entry mode with blank identity fields. The detailed page remains an
  optional edit-details path. `npm run check` passes (79 tests).
- **2026-09-08 - Codex.** Compacted the `/scan` session queue into a three-column
  desktop album-preview grid (two columns on narrow phones). Each record card
  now uses a square cropped cover thumbnail and reduced metadata spacing rather
  than consuming the page width. `npm run check` passes (79 tests).
- **2026-09-08 - Codex.** Removed the batch-card "Edit details" action. Batch
  candidates now show available release metadata (year, label, catalog number)
  beneath artist/title; genre, tracklist, and runtime are not yet in the AI or
  catalog contract and are intentionally not guessed. Updated browser-test
  navigation to avoid relying on the removed UI link. `npm run check` passes
  (79 tests).

- **2026-09-09 - Claude.** Second ad hoc UX request the same day: review the
  app as a real user and improve it, especially the dashboard. Delivered real
  cover art across dashboard/scan-history/library (shared lazy `CoverArt`
  component over the existing signed-thumbnail endpoint, closing
  `UI_UX_REVIEW.md` rank 9), a new `/library/{itemId}` detail page with
  clickable cards replacing dead-end grids, a rebuilt copy editor with
  conditions and real save/delete feedback, first-ever notes editing, and
  ADR-0018 + migration 012 making saved records removable while their
  confirmation audit row survives. Verified with `npm run check` (79/79),
  `npm run build`, `npm run test:integration` (30/30 database), a 14-step
  scripted browser pass, axe WCAG 2 A/AA (no violations on five routes), and a
  Pixel 7 layout check. Browser regression coverage for the new detail page is
  still owed — see "Known gaps and risks."

- **2026-09-09 - Claude.** Ad hoc maintainer UX request, outside the P3.1
  sequence: dashboard "Latest scans" gained inline add-to-collection/wishlist
  and dismiss actions per scan (ADR-0017). Confirmed the "not as a batch"
  half of the request was already true (per-scan rows since ADR-0006) and
  implemented the add/dismiss half: `cancelScan` widened to accept
  `identified`/`needs_review`/`unresolved`/`failed` as dismissible pre-states
  (rejecting a scan that already has a confirmation), and
  `listScanSummariesForUser` gained a batched `confirmedList` lookup. New
  client component `apps/web/src/app/dashboard/scan-activity-row.tsx` wires
  both into the existing `/confirm`/`/cancel` routes via `router.refresh()`.
  Verified: `npm run check` (79/79), `npm run build`, `npm run test:integration`
  (28/28, +2 new tests), and a manual dev-server check with seeded/cleaned-up
  data confirming both actions and the server-side confirmed-scan guard.
  Discovered, but left unfixed as out of scope, a likely pre-existing
  `.strict()` schema bug in `GET /api/v1/scans` and a local Playwright e2e
  timeout unrelated to this change — both recorded under "Known gaps and
  risks" for whoever picks either up next.

- **2026-09-09 - Claude.** Resumed the roadmap sequence: implemented P3.1
  task 2 (bounded upload concurrency, persisted session queue, per-item
  progress, retry/cancel, review-later navigation, refresh rehydration with
  recapture) as a rewrite of `apps/web/src/app/scan/capture-session.tsx`; see
  "Current state" for the full design and the two idempotency-key/orphaned-
  scan bugs found and fixed while verifying the recapture-after-refresh path
  against a real dev server. No contract/schema/API change. Verified
  `npm run check` (79/79), `npm run build`, and a scripted Playwright pass
  against Postgres/Redis/MinIO with real images covering bounded concurrency,
  mid-upload reload/resume/recapture, and cancel-while-queued; all scratch
  verification files and the extra `next dev` instance used for it were
  removed afterward. Checked off task 2 in `docs/ROADMAP.md`.

- **2026-09-10 - Codex.** Implemented P3.2 Task 2. The opt-in live camera now
  enters a visible paused state and releases its stream/tracks on quota or
  queue-capacity pressure, the session's record cap, tab backgrounding, and
  unexpected stream/track termination. It requires an explicit resume and
  keeps the file-input fallback available. Marked Task 2 complete in
  `docs/ROADMAP.md`; Tasks 3-4 remain. Verified `npm run check` (95/95),
  `npm run build`, and `git diff --check`.

- **2026-09-10 - Codex.** Completed P3.2 Task 3. Repaired Playwright's
  isolated standalone-server assembly: the post-build harness now copies the
  configured Next static directory into the standalone output, fixing the
  `/_next/static/*` 404s that had prevented client hydration. The existing
  mobile Chromium checks now execute the upload MIME-sniffing, HEIC rejection,
  independent-record/batch, confirmation, and focus paths. Updated stale
  capture-session wording and batch-route assertions so the browser tests
  reflect the current UI rather than result ordering. Marked the roadmap task
  complete and documented the harness behavior. Restored the documented root
  `test:e2e:matrix` command as a workspace forwarding script. Verified `npm run
check` (95 unit tests) and `npm run test:e2e` (14 mobile-Chromium tests).
  Matrix attempt: both Chromium profiles passed (28 tests); Firefox and WebKit
  could not launch because their Playwright executables are not installed on this
  Windows host, rather than due to an application failure. Task 4 owns the
  required real-device evidence.

- **2026-09-10 - Codex.** Completed P3.2 Task 4's repository deliverables.
  Added `apps/web/e2e/live-camera.e2e.ts`, a deterministic stubbed-camera
  state-machine spec covering no duplicate capture while a frame is held,
  rearming after frame change, background pause with track release and explicit
  resume, and permission-denial preservation of the upload fallback. Added the
  iPhone Safari/Android Chrome real-device protocol and sanitized-results
  template to `docs/TESTING.md`, and checked off Task 4 in `docs/ROADMAP.md`.
  Prettier, focused ESLint, and the root TypeScript check pass. A focused
  Playwright launch was attempted repeatedly, but this Windows runner's
  production-build web-server startup exceeds the shell's 30-second command
  window; its orphaned temporary server exits before a separately launched
  focused runner can attach. Re-run `npm run test:e2e --workspace
@vinylhound/web -- live-camera.e2e.ts` in a terminal without that command
  window to obtain the final browser result. Physical-device results are also
  still required for P3.2's exit criterion.

- **2026-09-11 - Codex.** Closed the documented P3.2 batch-rollover gap:
  `/scan` no longer treats 20 as a session ceiling. It persists the ordered
  batch list, keeps each queued record's target batch, and retries a
  server-authoritative `batch_scan_limit` rejection against one shared,
  idempotently-created next batch. Earlier batches remain linked beside the
  current review link. Updated `docs/OPERATIONS.md` and `docs/ROADMAP.md` to
  describe the implemented behavior. Prettier, focused ESLint, and typecheck
  pass. The real-device protocol results and an unrestricted Playwright run
  remain the two acceptance records still needed before declaring P3.2 closed.

- **2026-09-11 - Codex.** Corrected three stale assertions in the new
  stubbed-camera Playwright spec to use the UI's actual state and pause copy
  (`Waiting for a new cover`, `Rearmed`, and the background-pause message).
  This was discovered while removing the manual standalone-server caveat; the
  manual probe itself is not equivalent to the configured Playwright server
  lifecycle and returned its generic 500 page, so it is not evidence against
  the application. Prettier, focused lint/typecheck, and all 95 unit tests
  pass. Run the configured `npm run test:e2e` in CI or an unrestricted terminal
  for the browser acceptance record; actual iPhone Safari and Android Chrome
  results remain required for the physical-device gate.

- **2026-09-11 - Maintainer/Codex.** The maintainer completed the documented
  real-device protocol and confirmed P3.2's exit gate on iPhone Safari and
  Android Chrome. Marked the milestone closed in the roadmap and current
  handoff, preserving only the sanitized private results rather than device
  identifiers or image data. Next milestone: P3.3 Task 1, independent catalog
  discovery/search through the existing MusicBrainz port.

- **2026-09-11 - Claude.** Completed P3.3 Task 1. Added a standalone
  `/discover` page that searches MusicBrainz by artist/title independently of
  any scan (reusing the pre-existing `GET /catalog/releases` endpoint), grouped
  client-side by `reference.releaseGroupId` so multiple pressings of one album
  render under one album heading. Added `GET /catalog/releases/{releaseId}`
  and a new `CatalogProvider.getReleaseDetails` port method
  (`packages/catalog`) for a pressing's full detail — track listing, full
  label/format data, and `releaseGroupTitle` shown explicitly when it diverges
  from the pressing's own title — sharing the MusicBrainz adapter's existing
  rate limiter and cache with search. New contracts:
  `CatalogReleaseDetailSchema`, `GetCatalogReleaseResponseSchema`, and a
  `not_found` `CatalogProviderError` category mapped to HTTP 404. The page is
  read-only (no add/save action); that is P3.3 Task 3. Found and fixed a real,
  previously-latent bug while verifying against live MusicBrainz: catalog
  errors were silently surfacing as bare `500 internal_error` instead of their
  correct status because `@vinylhound/catalog` was missing from
  `next.config.ts`'s `transpilePackages`, causing `CatalogProviderError`'s
  `instanceof` check to fail across a duplicated webpack module boundary —
  this affected every pre-existing error category, not just the new one.
  Confirmed the fix live before/after against the real MusicBrainz API on an
  isolated dev-server instance. Verified `format:check`/`lint`/`typecheck`/
  `test` (103/103 unit tests) individually rather than via the chained
  `npm run check`, since `format:check` fails only on `apps/web/next-env.d.ts`
  — a generated file with no working-tree diff against its last commit,
  a Windows CRLF-checkout artifact already noted as pre-existing and
  deliberately untouched in an earlier P3.1 session entry — which would
  otherwise short-circuit the chain before lint/typecheck/test run. Also
  verified `npm run build`, and `npm run test:e2e` (mobile Chromium, 18/19 — the one
  failure, `live-camera.e2e.ts`'s first test, was confirmed via `git stash` to
  fail identically on unmodified `main`, a pre-existing flake unrelated to
  this task). Added `apps/web/e2e/discover.e2e.ts` (stubs catalog responses,
  matching `scan-flow.e2e.ts`'s existing convention) and added `/discover` to
  `accessibility.e2e.ts`'s WCAG and 360px-viewport checks — zero violations.
  Added a "Discover" entry to both the desktop sidebar and mobile bottom nav
  (`dashboard-shell.tsx`), moving the mobile nav's CSS grid from 5 to 6
  columns, reverified at 360px with no overflow. Checked off P3.3 Task 1 in
  `docs/ROADMAP.md`. Next: P3.3 Task 2 (favorites/playlists contracts and
  domain rules) — see "Resume point" above for scope notes and the
  pre-existing `live-camera.e2e.ts` flake to not mistake for a regression.

- **2026-09-11 - Claude.** Rebuilt `/discover` on Spotify as a separate
  discovery provider, keeping MusicBrainz as the catalog provider (ADR-0019).
  The maintainer asked for the discovery experience from the previous
  VinylHound implementation (jessig1/vinylhound-frontend and
  vinylhound-backend); I reviewed both repositories and reported what their
  search actually was — one debounced free-text box over a concurrent
  multi-provider fan-out, returning Artists/Albums/Tracks with thumbnails and
  clicking through artist → discography → album → tracklist, with a monotonic
  request counter discarding stale responses. The maintainer chose to split
  providers by role rather than swap, and asked for free-text search, artwork,
  artist discography, and save-to-library in one pass.
  Delivered: new `DiscoveryProvider` port and `createSpotifyDiscovery` adapter
  (client-credentials token with single-flight refresh, hour-long response
  cache, per-market discography collapse, null/placeholder filtering);
  `packages/contracts/src/discovery.ts`; `GET /discovery/search`,
  `/discovery/artists/{id}`, `/discovery/albums/{id}`; `POST /library` for
  scanless placement (P3.3 Task 3); `/discover`, `/discover/artists/{id}`,
  `/discover/albums/{id}` with debounce, `?q=` URL state, per-search
  `AbortController`, and artwork; migration 015 adding `'spotify'` to the
  `catalog_provider` enum.
  The judgement call worth recording: Spotify has no pressing entity, so a
  straight swap would have emptied the scan-review fields that distinguish
  vinyl pressings. Rather than let that degrade silently, `releaseId` on
  `CatalogReferenceSchema` became nullable — required for MusicBrainz,
  rejected as non-null for Spotify — and release identity now falls back to
  normalized attributes whenever a reference names no pressing. That made the
  product rule ("a cover match identifies a release concept, not a pressing")
  enforceable by schema instead of by convention, and it is asserted in both
  the contract tests and the e2e save test. Extracting `resolveReviewedRelease`
  out of `confirmScan` into `release-resolution.ts` kept the two save paths
  from drifting.
  Verified `npm run lint`, `npm run typecheck`, `npm test` (120/120, +17 net
  new), `npm run build`, and `npm run test:e2e` (22/23; the one failure is the
  pre-existing `live-camera` flake that reproduces on clean `main`).
  `format:check` still fails only on generated `next-env.d.ts`. Two things I
  did **not** do, both flagged in the resume point: migration 015 has not been
  applied to any database (no `docker compose up` this session), and nothing
  has been exercised against the real Spotify API — every test stubs `fetch`,
  so the adapter is proven against documented response shapes only. Task 1's
  session found a real latent bug exactly at that step, so it is worth doing
  before trusting this end to end.

- **2026-09-11 - Claude (same day, follow-up).** The maintainer added real
  Spotify credentials, ran migration 015, restarted, and hit
  `500 Internal Server Error` on search. Diagnosed on an isolated dev server
  to avoid disturbing theirs. Three findings, in the order they mattered.
  First, the 500 was **not** the new code: `GET /catalog/releases/{unknown}`
  also returned 500 instead of 404, meaning error identity across the
  `@vinylhound/catalog` boundary was broken for `CatalogProviderError` too —
  the same bug the Task 1 session believed `transpilePackages` had fixed.
  `HttpError` (local to `http.ts`) mapped fine, which isolated it to module
  identity rather than the branches. Replaced `instanceof` with branded
  `errorKind` guards (`isCatalogProviderError`, `isDiscoveryProviderError`)
  so classification no longer depends on how a bundler lays out the graph.
  Second, with mapping fixed the real answer appeared: Spotify returns
  **403 "Active premium subscription required for the owner of the app"**.
  The token mints fine, so the credentials are valid — Spotify refuses data
  requests unless the owning developer account has Premium. That is external
  and unfixed; the maintainer has to add Premium, move the app, or change
  provider.
  Third, the adapter had been discarding Spotify's explanation, mapping every
  unexpected status to a fixed "could not answer the request". Non-ok
  responses now carry their reason, 401/403 map to `not_configured` (503),
  and `/discover` prints the server's message instead of "add credentials"
  copy that would have pointed at the wrong fix. Also made `errorResponse`
  log unclassified errors before returning 500 — its silence is most of why
  this took as long as it did.
  Verified `lint`, `typecheck`, `test` (122/122), `build`, `test:e2e` (22/23,
  same pre-existing `live-camera` flake), plus live checks confirming
  catalog 404, discovery 404, catalog search 200, and discovery search
  returning 503 with Spotify's own text. Left the maintainer's dev server on
  port 3000 running throughout; cleaned up the isolated instance and its
  `.next-diag` directory.

- **2026-09-11 - Claude (third pass).** Fixed the outstanding webpack pin
  (ADR-0020). Established by probe that Turbopack cannot resolve the
  packages' `./foo.js` specifiers and has no `extensionAlias` equivalent in
  its config surface, then that it _does_ resolve explicit `./foo.ts` — which
  made the fix possible. Presented the options to the maintainer, who chose
  the full migration. Rewrote 126 relative specifiers across 60 files via a
  script that only acted where a real `.ts`/`.tsx` sibling existed, enabled
  `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` at the
  tsconfig root so the worker's Node ESM emit is unchanged, deleted the
  `webpack()` hook, and dropped `--webpack` from the dev/build scripts.
  Verified the worker emit directly rather than trusting the compiler flag,
  since that failure mode would only appear at production runtime. Full suite
  green apart from the pre-existing `live-camera` flake. Recorded the new
  import convention in `AGENTS.md` so Codex picks it up.
