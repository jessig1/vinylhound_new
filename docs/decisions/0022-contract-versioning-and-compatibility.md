# ADR-0022: Contract versions travel on the wire; compatibility is proved by frozen fixtures

- Status: Accepted
- Date: 2026-09-12
- Supersedes: none
- Builds on: [ADR-0004](0004-transactional-outbox-and-bullmq.md),
  [ADR-0016](0016-tiered-aws-runtime-and-sqs.md),
  [ADR-0019](0019-spotify-discovery-provider.md)

## Context

Roadmap P3.3 Task 4 asks for explicit HTTP and event version conventions,
previous-deployed-version compatibility fixtures in `packages/contracts`, and
a CI compatibility check — the foundation Phase 4 needs before it extracts
services and introduces versioned confirmation events (P4.2), and the thing
`docs/OPERATIONS.md` already assumes when it says a rollback "redeploys
previous ECR digests and never reverses a migration".

What existed: one precedent, the job topic `scan.analyze.v1` with
`jobVersion: z.literal(1)` in its payload; HTTP versioning by the `/api/v1`
path alone; and schema unit tests. What did not exist: any statement of what
a version promises, any sample of what a previous deployment actually sent,
and any check that ran against a previous version. Every `package.json` says
`0.1.0`, which is consumed by path and never bumped, so there is no semver to
lean on either.

Three facts about this deployment shape decide the design:

1. **Event consumers keep running the previous version.** Web writes the
   outbox row; the worker dispatches it and later consumes the job. During a
   deploy the two roll independently, after a rollback the worker is older
   than the payloads in the queue, and a backlog can hold payloads from any
   recent version. Every one of the six places that read a stored or delivered
   payload parsed it with the strict schema — so when `correlationId` was
   added (`66f0a78`, 2026-09-09), a worker still on the previous version would
   have failed every job the new web enqueued. That was not caught because
   nothing tested the direction.
2. **The browser bundle deploys with its server.** The only HTTP client is
   the app's own JavaScript. A stale client exists only in a tab opened before
   the deploy, and a reload replaces it. The browser parsed seventeen
   responses with strict schemas, so an added response field broke such a
   tab until it reloaded — the same tolerance problem as the worker's, one
   level deeper, since `GetScanResponse` nests objects four levels down and
   Zod's `.strip()` only reaches the top.
3. **Deployments are commits.** There are no release numbers. "The previous
   deployed version" is the previous commit on `main` (or, for a pull request,
   its base), and git has that commit's contracts.

## Decision

### Version identifiers are explicit, per family, and carried on the wire

- **HTTP:** `API_VERSION = "v1"`, served under `API_BASE_PATH = "/api/v1"`.
  A second major version would be a second path prefix served alongside the
  first, never a change in place.
- **Events and jobs:** topics are `<aggregate>.<action>.v<N>` (parsed and
  validated by `parseEventTopic`), and the payload carries the same `N` as a
  single `z.literal` in a named field (`jobVersion` for `scan.analyze.v1`).
  `defineEventContract` refuses a topic and payload that disagree.
  `EVENT_CONTRACTS` registers every topic; a new version of a topic is a new
  entry, and the consumer keeps both registered until no producer of the
  older one can still be deployed or rolled back to.
- **Workspace versions mean nothing.** `0.1.0` is not a compatibility
  identifier and is not bumped for contract changes.

### Producers are strict; consumers are tolerant

`tolerant(schema)` in `@vinylhound/contracts` is the reader: the same schema
with every object at every depth cloned into strip mode, refinements and
every known-field rule intact, memoized per schema and never mutating the
original. It walks objects, arrays, wrappers (optional, nullable, default,
readonly, catch), unions, intersections, records, maps, sets, tuples, pipes
and lazies; a leaf is returned as is.

Each event contract exposes `producerSchema` (the strict schema, so an
undeclared field can never leave the process) and `consumerSchema`
(`tolerant(producerSchema)`). The four producer sites — building the outbox
payload and publishing to BullMQ or SQS — validate strictly. The six reader
sites — replay lookups, the outbox dispatcher, the republish scan, the SQS
message parser and the BullMQ worker — use `consumerSchema`.

The browser reads every response through `parseResponse(schema, json)`,
which is `tolerant(schema).parse`. The server keeps validating what it emits
with the strict schema, so a response is exactly its contract on the way out
and read leniently on the way in. Requests stay strict on the server: a body
with a field the server does not know is a `400`, which is the right answer
for a server.

The consequence is the rule for changing a payload within a version: **a new
field must be optional, and only advisory data qualifies**, because a reader
on the previous version drops what it does not know, and the outbox
dispatcher re-publishes what it parsed. Anything a consumer must not lose is
a new topic version. A removed or retyped field is always a new version.

### HTTP compatibility within `v1`

- A request body may gain optional fields. A new required field, a removed
  field, or a retyped field is a break for every client that predates it.
- A response body may gain fields; a tab opened before the deploy drops what
  it does not know and carries on. A removed, renamed or retyped field is a
  break for such tabs until they reload. That is not a new major version on
  its own; the fixtures make the change visible so the cost is chosen, not
  stumbled into.
- Error bodies (`ApiErrorSchema`) may gain codes; a code is never reused with
  a different meaning.

### Fixtures are the definition of "compatible", and they are frozen

`packages/contracts/fixtures/` holds wire samples that deployed versions
actually sent or accepted — `http/v1/requests/<Schema>/`,
`http/v1/responses/<Schema>/`, `events/<topic>/` — each with the commit that
introduced the shape in its `origin`. The initial set was reconstructed from
git history: the original single-scan request before batches, the upload
request before view types, the confirm body before pressing fields, the job
payload before correlation IDs, the library update before favorites, and a
current sample of every response the browser reads, every
mutating request body, and both catalog reads plus the usage summary.

A fixture's `value` is never edited. A shape that stops being supported is
deleted in the change that ends its support, with the decision cited.

### Two checks, two directions

- **Backward — `npm test`** (`src/compatibility/compatibility.test.ts`):
  this tree's contracts accept every fixture; responses round-trip
  unchanged; event fixtures pass both producer and consumer schemas; every
  registered topic and every browser-parsed response has at least one
  fixture.
- **Forward — `npm run check:contracts`** (`scripts/check-compatibility.ts`,
  its own CI step): extracts the base commit's `packages/contracts/src` from
  git into `node_modules/.cache`, imports it, and asks it to accept this
  tree's fixtures using the reader that version actually applied — the
  topic's `consumerSchema` for events, its `tolerant()` for responses when it
  exports one, the strict schema for requests. Event rejections fail the
  build. HTTP rejections are reported with the consequence spelled out; with
  tolerant browsers a response rejection can only be a removed, renamed or
  retyped field. An in-place edit to a fixture fails the build; deletions are
  listed.

Running the forward check against the first vertical slice (`8c692ed`)
reports exactly the six response and request shapes that were stale-tab
breaks when they shipped, which is the evidence the report is measuring the
right thing.

## Consequences

**Good.** The tolerant readers close two real gaps: the next optional field
on `scan.analyze.v1` will not fail jobs on a worker that has not been
deployed yet or has been rolled back, and the next response field will not
break a tab that was open across the deploy. Phase 4's versioned
confirmation event gets its topic grammar, its registry, its
producer/consumer split and its fixture directory for free, instead of
inventing them mid-extraction. A contract change now has to touch a fixture
to be incompatible, and a reviewer sees which shape it stops supporting.

**Costs.** Fixtures are hand-written samples, so they only cover the shapes
someone thought to freeze; the suite's required-fixture lists (registered
topics, browser-parsed responses) are the floor, not the ceiling. The forward
check needs git and a reachable base, so it is a CI step rather than part of
`npm run check`; locally it defaults to `origin/main`. The extracted previous
source resolves `zod` from the current tree, so a zod major upgrade would need
the base's contracts to still load under it (or the check to be skipped for
that one change).

**Costs, continued.** `tolerant()` reaches into `_zod.def` to clone; that
is Zod 4's documented internals surface (`schema.clone(def)`), but a Zod
major upgrade must re-run `tolerant.test.ts`, which walks every node kind
the contracts use plus a lazy (whose def caches its resolved inner schema, the
one non-obvious case).

**Not decided here.** Whether the
`persisted` family (JSON columns other than the outbox payload) needs its own
fixtures — today the only such column typed by a contract is the outbox
payload, already covered as an event. What the P4.2 outbox generalisation
stores in its topic/version columns — `parseEventTopic` makes the version
derivable from the topic string, so a separate column is optional.
