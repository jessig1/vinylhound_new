# Product definition

## Problem

Record collectors often encounter an album away from a desktop catalog. Typing small or stylized cover text is slow, and front-cover recognition does not always reveal the exact edition. VinylHound should make capture effortless while remaining honest about uncertainty.

## Primary user

The initial user is a collector using a phone at home, in a record store, or at a sale. The architecture should support multiple accounts later without making the personal version cumbersome.

## MVP scope

- Capture a cover with a phone camera.
- Upload one image, several views of one record, or a batch of records.
- Identify likely artist and album title with AI-generated evidence and confidence.
- Show a review screen where the user can select, edit, retry, or mark unresolved.
- Add a confirmed release to either collection or wishlist.
- Browse, search, move, and remove library items.
- Retain scan status and enough metadata to debug failures and evaluate model changes.

## Explicit non-goals for MVP

- Valuation, marketplace sales, or inventory accounting.
- Automatic claim of an exact pressing from a front cover alone.
- Public social profiles or shared collections.
- Offline AI analysis.
- Training or fine-tuning a model before prompt/model baselines are evaluated.

## Key user stories and acceptance criteria

### Capture one album

As a collector, I can take or choose a photo, see upload progress, and receive a result without keeping the page open. The scan survives refreshes and exposes queued, processing, review, resolved, or failed states.

### Capture several views

As a collector, I can group front, back, spine, and label images into one scan. All images are analyzed as one evidence set, and the app explains which details support the proposed match.

### Batch upload

As a collector, I can select multiple images, group them into album scans, and see independent progress and retry controls. One failed item does not fail the entire batch.

### Confirm and organize

As a collector, I can correct artist/title details before adding the release to collection or wishlist. Repeating the same confirmation request does not create duplicates.

## Product success signals

- Confirmation rate without edits for the representative eval set.
- Review/correction rate segmented by image quality and view type.
- Time from upload completion to a reviewable result.
- Cost and token usage per successfully confirmed scan.
- Batch completion and retry success rates.

## Open product questions

- Should one physical copy be modeled separately from the canonical release from day one?
- Which external music catalog should enrich and de-duplicate confirmed candidates?
- How long should original photos be retained after confirmation?
- Which fields matter most for personal collection tracking: condition, purchase price, location, or notes?
