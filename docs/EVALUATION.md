# Private AI model evaluation

VinylHound's evaluation runner compares album-identification models against the
same private, maintainer-verified image cases. It makes live, billable Responses
API calls only when `--confirm-live` is present. Detailed results remain beside
the private dataset rather than in this repository.

This harness is optional for the current local identification workflow. It is
not called by the web app or worker and does not need to be completed before
manually testing Sol with a small set of known covers. Use it before public
rollout or when optimizing model, image detail, latency, or cost.

## Prerequisites

- Node.js 22 or newer.
- A private manifest matching the schema created for the dataset.
- Every selected case has `viewType`, `split`, verified artist/title,
  `expectedOutcome`, `maintainerVerified: true`, and
  `allowedForPrivateEvaluation: true`.
- `.env` contains a server-only `OPENAI_API_KEY`. Never pass the key on the
  command line or commit it.
- The API project has an appropriate spend limit.

The runner rejects unverified or non-consented selected cases before making any
provider request. Image paths must be relative to the manifest's `imageRoot` and
cannot escape it. Image bytes become request-scoped Base64 data URLs and are not
written to the result file.

## Workflow

Validate the holdout inputs first. This makes no API calls:

```powershell
npm run eval:ai -- --manifest "C:\Users\essig\Desktop\albums\manifest.json" --split holdout --dry-run
```

Run a three-case Terra smoke test before committing to the full comparison:

```powershell
npm run eval:ai -- --manifest "C:\Users\essig\Desktop\albums\manifest.json" --split development --limit 3 --models gpt-5.6-terra --confirm-live
```

Run the default Sol/Terra/Luna comparison on the holdout set. Three repetitions
make latency and output variability more informative, but triple the API calls:

```powershell
npm run eval:ai -- --manifest "C:\Users\essig\Desktop\albums\manifest.json" --split holdout --repetitions 3 --confirm-live
```

The runner prints the planned call count before starting and refuses billable
work without `--confirm-live`. By default it writes a timestamped JSON file to
`results/` beside the manifest. It checkpoints after every attempt, so completed
responses survive an interruption. The result never contains the API key or raw
image bytes.

Use `npm run eval:ai -- --help` for model, case, split, repetition, image-detail,
timeout, and output overrides.

## Sol/Terra vision-detail experiment

The dedicated matrix command holds the dataset, prompt, schema, timeout, and
scoring policy constant while comparing four configurations:

1. Terra + `high` (former production baseline)
2. Terra + `auto`
3. Sol + `high`
4. Sol + `auto`

The current production default is Sol + `high`; the matrix remains available
only for a controlled comparison.

For GPT-5.6, `auto` preserves original image dimensions. That can improve small
visual details, but it can also materially increase input tokens, latency, and
cost. Each result and aggregate is therefore keyed by both `model` and
`imageDetail`; matrix result files use schema version 2.

Do not change the prompt or preprocess images during this experiment. Those are
separate variables for later experiments.

### Iteration 0 — label and validate

Complete the manifest fields required by the readiness gate: `viewType`,
`split`, verified artist/title, `expectedOutcome`, `maintainerVerified: true`,
and `allowedForPrivateEvaluation: true`. Put representative examples in the
development split and reserve a holdout that will not be inspected while tuning.

Then validate the entire matrix without making API calls:

```bash
npm run eval:ai:vision-matrix -- --manifest "/mnt/c/Users/essig/Desktop/albums/manifest.json" --split development --dry-run
```

Confirm that the printed `plannedAttempts` equals `development cases × 4`.

### Iteration 1 — one-case pipeline check

Choose one labeled development case, preferably a known difficult cover, and
make exactly four calls:

```bash
npm run eval:ai:vision-matrix -- --manifest "/mnt/c/Users/essig/Desktop/albums/manifest.json" --split development --cases vh-001 --confirm-live
```

Verify that all four cells complete, the structured-output success rate is
100%, and the result file contains four attempts and four aggregates. This stage
checks access, image transport, model availability, and result checkpointing; it
is too small for a model decision.

### Iteration 2 — small development smoke test

Run three representative development cases once, for 12 calls:

```bash
npm run eval:ai:vision-matrix -- --manifest "/mnt/c/Users/essig/Desktop/albums/manifest.json" --split development --limit 3 --confirm-live
```

Check rank-1 and top-3 accuracy case by case. Stop here if any cell has provider
or schema errors, or if `auto` token use is unexpectedly high. Fix the harness or
dataset before spending on repetitions.

### Iteration 3 — development comparison

Run every development case three times. Three repetitions expose the instability
seen in repeated production scans:

```bash
npm run eval:ai:vision-matrix -- --manifest "/mnt/c/Users/essig/Desktop/albums/manifest.json" --split development --repetitions 3 --confirm-live
```

Select a provisional winner using this order: end-to-end rank-1 accuracy, top-3
recall, schema success, review-routing accuracy, edition false-discovery rate,
then p95 latency and estimated cost. Inspect repeated disagreements rather than
choosing from aggregate accuracy alone. Prompt or preprocessing changes may be
developed after this stage, but require a new versioned experiment.

### Iteration 4 — final holdout

Freeze the candidate configurations and run the untouched holdout once with
three repetitions:

```bash
npm run eval:ai:vision-matrix -- --manifest "/mnt/c/Users/essig/Desktop/albums/manifest.json" --split holdout --repetitions 3 --confirm-live
```

Choose the production configuration from the holdout result using the same
decision order. Record the result path, dataset version, prompt version, winning
cell, metric deltas, and accepted latency/cost tradeoff before changing `.env`.

## Metrics

Each result contains provider output and audit metadata per attempt plus model
aggregates:

- rank-1 normalized artist/title accuracy;
- top-3 normalized artist/title recall;
- structured-output/schema success and normalized error rates;
- edition-field precision, recall, mismatches, and false-discovery rate for
  release year, label, catalog number, and barcode;
- review-routing accuracy plus per-outcome precision and recall;
- p50, p95, and mean end-to-end provider latency;
- input/output/total tokens;
- estimated cost from response usage and the pricing table version recorded in
  the result.

Failed provider calls count against end-to-end rank-1 and top-3 metrics. Separate
"on schema success" metrics show identification quality when a valid structured
response was returned. Edition metrics evaluate the top-ranked candidate. A
wrong non-null edition value counts as both a false positive and a false negative.

Cost is an estimate based on uncached token rates, not an invoice. Prompt caching,
pricing changes, image token accounting, and account terms can make actual billing
different. The runner records the price-table date and rates so old runs remain
interpretable.

## Comparing changes

Keep the dataset version, split, image detail, repetitions, and case selection
fixed when comparing models, prompts, or preprocessing. Do not tune against the
holdout set. Record the aggregate result, configuration, metric deltas, and any
accepted accuracy/cost/latency tradeoff before changing the production default.
