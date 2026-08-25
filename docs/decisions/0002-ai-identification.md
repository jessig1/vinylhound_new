# ADR-0002: AI output is structured, auditable, and reviewable

- Status: accepted
- Date: 2026-08-24

## Context

Vision models can recognize many album covers but may confuse similar artwork or invent pressing facts. Free-form text would be difficult to validate or safely persist, and provider/model choices will change.

## Decision

Call the OpenAI Responses API only through an `AlbumIdentifier` port. Require Structured Outputs validated by a shared schema. Persist immutable attempt metadata (model, prompt version, provider response ID, timing/usage/error) and ranked evidence-bearing candidates. Apply a separate domain review policy and require confirmation before modifying a library.

## Consequences

- Provider output shape is reliable, but factual truth still requires evaluation/review.
- Model/prompt changes are measurable and reversible.
- The provider can be replaced without changing core domain behavior.
- Additional storage and UI states are required for evidence, uncertainty, retries, and correction.
