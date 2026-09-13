# Contract compatibility fixtures

Frozen wire samples that a deployed version of VinylHound actually sent or
accepted (ADR-0022). They are the executable definition of "compatible with
the previous deployed version": `npm test` proves this tree's contracts still
accept every file here, and `npm run check:contracts` proves the previous
version's consumers accept this tree's event payloads and that no file here
was edited in place.

## Layout

```
http/<apiVersion>/requests/<SchemaName>/<case>.json    a body a client sent
http/<apiVersion>/responses/<SchemaName>/<case>.json   a body the server emitted
events/<topic>/<case>.json                             a payload a producer enqueued
```

`<SchemaName>` is the export name in `@vinylhound/contracts`; `<topic>` is a
key of `EVENT_CONTRACTS`. Every segment is read by the loader
(`src/compatibility/fixtures.ts`), so a file anywhere else fails the suite.

## File shape

```json
{
  "frozenAt": "2026-09-12",
  "origin": "Which deployed version sent this, from which commit, and why it must stay accepted.",
  "value": {}
}
```

`origin` is for the person who sees the fixture fail: cite the commit that
introduced the shape and the one (if any) that changed it, so they can judge
whether a queue backlog, an outbox row, a stale tab, or a rolled-back replica
can still send it.

## Rules

- **Never edit `value` in place.** A fixture records history. A new shape gets
  a new file; a shape that is no longer supported is deleted in the same
  change that ends its support, with the decision cited (roadmap or ADR). CI
  fails on an in-place modification and lists deletions for review.
- **Add a fixture when you change a contract.** Freeze the pre-change shape
  if no file covers it yet (that is what the previous deployed version still
  sends), and add the new shape. `compatibility.test.ts` requires at least one
  fixture per registered event topic and per response the browser reads.
- **Responses must round-trip.** A response fixture is exactly what the
  server emits, so `parse(value)` must deep-equal `value`. Request fixtures
  may omit fields that defaults fill in — that is often the point of them.
- **Event fixtures must be producible and consumable** by this version: they
  pass the strict producer schema and the tolerant consumer schema.

## What the checks cover, and what they do not

| Direction                                        | Family              | Where             | Enforced |
| ------------------------------------------------ | ------------------- | ----------------- | -------- |
| This tree accepts what a previous version sent   | all                 | `npm test`        | yes      |
| Previous consumer accepts what this tree sends   | events              | `check:contracts` | yes      |
| Previous server/browser accepts this tree's HTTP | requests, responses | `check:contracts` | reported |

HTTP forward compatibility is reported rather than enforced because the
browser bundle deploys with its server: the previous client survives only in
tabs opened before the deploy, and a reload clears it. Responses are judged
by the reader that version's browser used (`tolerant()` where it exports
one), so an added field is fine and only a removed, renamed or retyped one is
reported; requests are judged strictly, as the server reads them. Event
consumers (the worker, the outbox dispatcher) genuinely keep running the
previous version during a deploy, after a rollback, and while draining a
backlog, so that direction fails the build.
