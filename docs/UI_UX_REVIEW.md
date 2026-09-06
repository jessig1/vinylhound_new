# Incremental frontend usability review

Reviewed 2026-09-05 at the maintainer's request. Scope: the existing Next.js
frontend and global CSS, with priority on phone capture and confirmation.
No framework, dependency, backend, API, persistence, or service-boundary changes.

## Ranked recommendations

Ranking considers user impact first, then effort and regression risk. The first
eight items were selected before implementation; the remaining two need separate
work. Effort and risk are relative to this repository.

| Rank | Improvement                                                 | Impact | Effort     | Risk   | Decision      |
| ---- | ----------------------------------------------------------- | ------ | ---------- | ------ | ------------- |
| 1    | Make scan rows tappable and keyboard accessible             | High   | Low        | Low    | Implement     |
| 2    | Collapse optional copy details during confirmation          | High   | Low        | Low    | Implement     |
| 3    | Expose upload-control focus and enlarge tap targets         | High   | Low        | Low    | Implement     |
| 4    | Improve readable text, contrast, sizing, and wrapping       | High   | Low        | Low    | Implement     |
| 5    | Preserve full photo edges and enlarge a single preview      | High   | Low        | Low    | Implement     |
| 6    | Clarify scan-mode spacing, selection, and primary actions   | High   | Low        | Low    | Implement     |
| 7    | Clarify processing, catalog-search, and save feedback       | Medium | Low–medium | Low    | Implement     |
| 8    | Provide a clear-search action for empty results             | Medium | Low        | Low    | Implement     |
| 9    | Display real cover thumbnails in library and review screens | High   | Medium     | Medium | Separate task |
| 10   | Add persistent batch actions and next-review navigation     | Medium | Medium     | Medium | Separate task |

## Implemented behavior

- Dashboard and history scan rows are single links. The former mobile rule hid
  the only link, making individual scans inaccessible. Status and title now fit
  on separate rows on phones, with an inset keyboard focus outline.
- Optional physical-copy fields use a native details disclosure. Suggested
  release fields remain visible for review; artist and title are identified as
  required, and all other fields as optional. Collapsing retains entered values.
- Shared controls have larger targets, inputs and selects use consistent fonts,
  file-input focus is visible on its label, and navigation exposes the current
  page. Phone content includes bottom safe-area spacing.
- Darker primary controls and accent text improve contrast while preserving the
  existing orange palette, paper surfaces, typefaces, and page organization.
  Supporting text is larger; candidate titles wrap instead of being truncated.
- Upload previews contain the entire image, including narrow spines. A single
  photo spans the preview grid and has a bounded width. Scan modes have separation
  from the upload card and a warning that switching clears selected photos.
- Upload phases have a live status message and semantic progress values.
  Candidates expose selection and the selected AI match has a visible label.
  Catalog results use a two-column card suited to their actual content, with
  explicit searching and no-results messages. Manual entry focuses Artist;
  successful confirmation focuses the saved album heading and uses concise copy.
- Results arriving through polling initialize the form only once they are ready.
  Previously the queued response initialized an empty draft permanently until
  refresh. A successful retry restarts polling, and connection
  errors are surfaced while processing. Requests and payloads are unchanged.
- Empty search results offer Clear search, retaining the current sort.

## Follow-up boundaries

Real cover art requires reviewing the existing signed-image lifecycle and
fallbacks. Batch navigation needs its own interaction design, especially around
failed uploads and partially reviewed batches. Neither belongs in this CSS and
presentation pass. The copy editor's existing save/delete error feedback and
preserving local edits across refreshes also warrant separate work.

Validation results are recorded in [HANDOFF.md](HANDOFF.md). Browser regression
coverage includes form initialization without refresh, collapsed copy values,
phone scan-row navigation, clear-search sort preservation, file-control focus,
and narrow-screen overflow, alongside the existing accessibility/upload suite.
