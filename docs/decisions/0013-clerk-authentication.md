# ADR-0013: Clerk provides production authentication

- Status: accepted
- Date: 2026-08-31

## Context

Every persisted row has been user-scoped since Milestone 1
(`docs/ARCHITECTURE.md`'s "Authentication assumption"), but identity itself
has only ever been a single hardcoded development user:
`packages/config`'s `DEVELOPMENT_USER_ID` (default
`00000000-0000-4000-8000-000000000001`), read directly by every API route
(`context.config.DEVELOPMENT_USER_ID`) and silently upserted by
`ensureDevelopmentUser`. `AUTH_MODE: z.literal("development")` in
`DevelopmentWebConfigSchema` already anticipated other modes without
implementing any. `docs/API.md` has stated since Milestone 1 that
"authenticated user identity comes from the server session, never a request
body" — session-based auth was always the intended shape, just not built.
The `/account` page is a client-only fake: name/email live in
`localStorage` under a `vinylhound-demo-session` key, disconnected from the
database `users` table entirely.

Milestone 4 requires real production authentication before public rollout
(`docs/ROADMAP.md`). The maintainer chose a hosted identity provider over
self-hosting session/credential logic (Auth.js) to avoid owning
password storage, MFA, and session security directly, and chose Clerk
specifically for its Next.js App Router-native middleware and component
library, which fits the existing Next.js 16 App Router structure with the
least new plumbing.

Two integration questions needed resolving: how Clerk's identity maps onto
the existing `users` table (every user-owned table has a `uuid` FK to
`users.id`, and Clerk's user IDs are not UUIDs), and how a local `users` row
gets created for a Clerk identity that has never made a request before.

## Decision

**Identity mapping.** `users` keeps its own `id uuid primary key` so every
existing foreign key (`scans.user_id`, `batches.user_id`,
`library_items.user_id`, etc.) is untouched. A new column,
`users.clerk_user_id text not null unique`, stores Clerk's `user_...` ID.
Every request resolves the local UUID by looking up `clerk_user_id`, never
by trusting a client-supplied UUID.

**Provisioning.** New identities are provisioned just-in-time on first
request rather than via a Clerk webhook: `requireUserId` looks up
`clerk_user_id`, and on miss inserts a new `users` row
(`onConflictDoNothing` + re-select, matching `ensureDevelopmentUser`'s
existing pattern) rather than requiring a separate webhook endpoint,
signing secret, and delivery-failure handling for what is a rare,
low-stakes event (a Clerk account with no local row yet). A webhook can be
added later for cases JIT can't cover (e.g. reacting to account deletion
in Clerk itself), but nothing in this slice depends on one existing.

**Request identity resolution.** A single `requireUserId(request):
Promise<string>` helper (`apps/web/src/server/auth.ts`) replaces every
route's `context.config.DEVELOPMENT_USER_ID` read. In `AUTH_MODE:
"production"` it calls Clerk's server SDK (`auth()` from `@clerk/nextjs/server`)
to read the verified session, 401s via `HttpError` if there is none, and
resolves/provisions the local UUID. In `AUTH_MODE: "development"` (the
default, matching today's `.env.example`) it returns
`DEVELOPMENT_USER_ID` and calls the existing `ensureDevelopmentUser`,
unchanged — so local dev, CI, and `npm run test:integration` need no Clerk
account or keys, matching `AGENTS.md`'s existing pattern of keeping
`OPENAI_API_KEY` empty for tests. `ServerConfigSchema`/
`DevelopmentWebConfigSchema` gain `AUTH_MODE: z.enum(["development",
"production"])` (was a single-value literal) and optional
`CLERK_SECRET_KEY`/`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (the exact env var
names Clerk's SDK reads directly from `process.env`), required only when
`AUTH_MODE` is `"production"` (enforced with `.superRefine`, not made
unconditionally required, so the development schema stays satisfiable with
today's `.env.example`). A client-visible `NEXT_PUBLIC_AUTH_MODE` mirrors
`AUTH_MODE` (kept in sync by the same `.superRefine`) since Next.js only
inlines literally-referenced `NEXT_PUBLIC_*` vars into client bundles, and
client components (the sidebar name/avatar, the account page) need to know
the mode to decide whether to call Clerk's hooks at all.

**Page/route protection.** `apps/web/src/proxy.ts` (Next.js 16's Proxy file
convention, formerly `middleware.ts`) uses `clerkMiddleware` to protect
everything except `/`, `/sign-in`, and `/sign-up`, redirecting
unauthenticated browser requests to `/sign-in` and returning 401 JSON for
unauthenticated API requests — but only when `AUTH_MODE=production`.
`clerkMiddleware()` itself throws immediately if no publishable key is
configured, so in `AUTH_MODE=development` the proxy never constructs it at
all and exports a plain pass-through instead (confirmed by a real hang in
the Playwright e2e run: `clerkMiddleware()`'s construction-time throw
crashed every request before any request-level `AUTH_MODE` check could
run). `<ClerkProvider>` wraps `RootLayout` under the same
`AUTH_MODE=production` guard, for the same reason. `/sign-in` and
`/sign-up` use Clerk's default hosted
`<SignIn>`/`<SignUp>` components (not custom-themed, to keep this slice to
identity/session wiring rather than visual design work); `/` becomes a
static landing page linking to both. The fake `/account` localStorage
session is replaced by a real profile view backed by Clerk's `useUser`, with
"sign out" calling Clerk's `useClerk().signOut()` instead of clearing
`localStorage`; both `/account` and the sidebar name/avatar
(`dashboard-shell.tsx`) branch on `NEXT_PUBLIC_AUTH_MODE` to show a
neutral development-mode label instead of calling Clerk hooks when no
`<ClerkProvider>` is mounted.

**Migration.** A new migration adds `clerk_user_id` as nullable initially,
backfills the existing development user's row with a clearly-marked
placeholder value, then a follow-up migration (once the maintainer has
signed in for real at least once) tightens it to `not null unique`. Existing
user-owned data is not otherwise touched — the row `id` a real signed-in
maintainer ends up provisioned under will differ from
`DEVELOPMENT_USER_ID`, so today's local data will not automatically appear
under the maintainer's real Clerk identity. That data migration (assigning
existing rows to a real identity, if wanted) is out of scope for this ADR
and left for the maintainer to decide when switching a given environment to
`AUTH_MODE=production`.

## Consequences

- Password storage, MFA, session cookie security, and OAuth provider
  integration are Clerk's responsibility, not ours — smaller surface for
  VinylHound to secure directly, at the cost of a new external dependency
  and vendor lock-in for identity. `CLERK_SECRET_KEY` is a new secret that
  must never reach the client, alongside the existing `OPENAI_API_KEY`/S3
  credential rules in `AGENTS.md`.
- `AUTH_MODE` stays a real switch, not a placeholder: development/CI/test
  environments never need Clerk keys or network access to run, matching
  existing test-environment guidance.
- JIT provisioning means a Clerk identity that signs in but never completes
  any mutating request still gets a `users` row on its first `requireUserId`
  call (including a read-only `GET`), which is fine since `users` has no
  other required fields yet — this is a strictly smaller surface than a
  webhook race.
- Every route file's identity line becomes `const userId = await
requireUserId(request)` instead of `context.config.DEVELOPMENT_USER_ID`;
  this is a mechanical, wide-but-shallow diff across roughly a dozen route
  files and does not change any route's request/response contract.
- No account deletion/export or privacy/retention policy is implemented by
  this slice — ADR scope is authentication/session identity only. Those
  remain separate, explicitly-listed Milestone 4 items.
- Local development data created under `DEVELOPMENT_USER_ID` is not
  reachable from a real Clerk-authenticated session without a manual data
  migration the maintainer performs deliberately per environment.
