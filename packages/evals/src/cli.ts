import { resolve } from "node:path";

import { z } from "zod";

import {
  DEFAULT_EVALUATION_IMAGE_DETAILS,
  DEFAULT_EVALUATION_MODELS,
  runEvaluation,
  validateEvaluationInputs,
} from "./runner.ts";
import type { EvaluationImageDetail } from "./metrics.ts";

interface CliOptions {
  manifestPath: string;
  outputPath?: string;
  models: string[];
  split: "development" | "holdout" | "all";
  caseIds?: string[];
  limit?: number;
  repetitions: number;
  imageDetails: EvaluationImageDetail[];
  timeoutMs: number;
  dryRun: boolean;
  confirmLive: boolean;
}

const usage = `
VinylHound private AI model evaluation

Usage:
  npm run eval:ai -- --manifest <path> [options]

Required:
  --manifest <path>          Private manifest.json path

Selection:
  --models <id,id,...>       Models to compare (default: Sol, Terra, Luna)
  --split <name>             development, holdout, or all (default: holdout)
  --cases <id,id,...>        Run only specific case IDs
  --limit <count>            Limit selected cases (useful for a smoke test)
  --repetitions <count>      Repeats per model/case (default: 1)

Provider:
  --detail <level>           One detail level: low, high, or auto
  --details <level,...>      Detail levels to compare (default: OPENAI_IMAGE_DETAIL/high)
  --timeout-ms <number>      Per-request timeout (default: OPENAI_TIMEOUT_MS/120000)

Output and safety:
  --output <path>            Result JSON path (default: <dataset>/results/<run>.json)
  --dry-run                  Validate manifest/images and show planned call count
  --confirm-live             Required for billable API calls
  --help                     Show this help

Examples:
  npm run eval:ai -- --manifest C:\\private\\albums\\manifest.json --dry-run
  npm run eval:ai -- --manifest C:\\private\\albums\\manifest.json --split development --limit 3 --models gpt-5.6-terra --confirm-live
  npm run eval:ai -- --manifest C:\\private\\albums\\manifest.json --split development --limit 3 --models gpt-5.6-terra,gpt-5.6-sol --details high,auto --confirm-live
  npm run eval:ai -- --manifest C:\\private\\albums\\manifest.json --split holdout --repetitions 3 --confirm-live
`.trim();

async function main() {
  const options = parseArguments(process.argv.slice(2));
  assertNodeVersion();
  const validated = await validateEvaluationInputs({
    manifestPath: options.manifestPath,
    split: options.split,
    caseIds: options.caseIds,
    limit: options.limit,
  });
  const plannedAttempts =
    validated.cases.length *
    options.models.length *
    options.imageDetails.length *
    options.repetitions;

  console.info("Evaluation input validated", {
    dataset: validated.manifest.dataset.id,
    version: validated.manifest.dataset.version,
    split: options.split,
    cases: validated.cases.length,
    models: options.models,
    imageDetails: options.imageDetails,
    repetitions: options.repetitions,
    plannedAttempts,
  });

  if (options.dryRun) {
    console.info("Dry run complete; no API calls were made.");
    return;
  }
  if (!options.confirmLive) {
    throw new Error(
      `Refusing ${plannedAttempts} billable API calls without --confirm-live. Run with --dry-run first.`,
    );
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing or blank in the environment.");
  }

  const outputPath =
    options.outputPath ??
    defaultOutputPath(
      options.manifestPath,
      validated.manifest.dataset.id,
      options.split,
    );
  const result = await runEvaluation({
    manifestPath: options.manifestPath,
    outputPath,
    apiKey,
    models: options.models,
    imageDetails: options.imageDetails,
    timeoutMs: options.timeoutMs,
    split: options.split,
    caseIds: options.caseIds,
    limit: options.limit,
    repetitions: options.repetitions,
    onProgress: ({ completed, total, attempt }) => {
      const outcome =
        attempt.status === "succeeded"
          ? `rank1=${attempt.score.rank1Match ? "yes" : "no"} top3=${attempt.score.top3Match ? "yes" : "no"}`
          : `error=${attempt.error.category}`;
      console.info(
        `[${completed}/${total}] ${attempt.configuredModel} detail=${attempt.imageDetail} ${attempt.caseId} repetition=${attempt.repetition} ${outcome} latencyMs=${Math.round(attempt.durationMs)}`,
      );
    },
  });

  console.table(
    result.aggregates.map((aggregate) => ({
      model: aggregate.model,
      detail: aggregate.imageDetail,
      attempts: aggregate.attempts,
      schemaSuccess: percent(aggregate.schemaSuccessRate),
      rank1: percent(aggregate.rank1AccuracyEndToEnd),
      top3: percent(aggregate.top3RecallEndToEnd),
      routing: percent(aggregate.routingAccuracyOnSchemaSuccess),
      p50Ms: round(aggregate.latencyMs.p50),
      p95Ms: round(aggregate.latencyMs.p95),
      tokens: aggregate.tokens.total,
      estimatedCostUsd:
        aggregate.estimatedCostUsd === null
          ? "n/a"
          : aggregate.estimatedCostUsd.toFixed(4),
      errors: aggregate.errors.total,
    })),
  );
  console.info(`Detailed private results: ${resolve(outputPath)}`);
}

function parseArguments(args: readonly string[]): CliOptions {
  if (args.includes("--help")) {
    console.info(usage);
    process.exit(0);
  }

  let manifestPath: string | undefined;
  let outputPath: string | undefined;
  let models: string[] = [...DEFAULT_EVALUATION_MODELS];
  let split: CliOptions["split"] = "holdout";
  let caseIds: string[] | undefined;
  let limit: number | undefined;
  let repetitions = 1;
  let imageDetails: EvaluationImageDetail[] = process.env.OPENAI_IMAGE_DETAIL
    ? [parseImageDetail(process.env.OPENAI_IMAGE_DETAIL)]
    : [...DEFAULT_EVALUATION_IMAGE_DETAILS];
  let detailOptionSeen = false;
  let timeoutMs = positiveInteger(
    process.env.OPENAI_TIMEOUT_MS ?? "120000",
    "OPENAI_TIMEOUT_MS",
  );
  let dryRun = false;
  let confirmLive = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const takeValue = () => {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value.`);
      return value;
    };

    switch (argument) {
      case "--manifest":
        manifestPath = takeValue();
        break;
      case "--output":
        outputPath = takeValue();
        break;
      case "--models":
        models = commaSeparated(takeValue(), "--models");
        break;
      case "--split":
        split = z.enum(["development", "holdout", "all"]).parse(takeValue());
        break;
      case "--cases":
        caseIds = commaSeparated(takeValue(), "--cases");
        break;
      case "--limit":
        limit = positiveInteger(takeValue(), "--limit");
        break;
      case "--repetitions":
        repetitions = positiveInteger(takeValue(), "--repetitions");
        break;
      case "--detail":
        if (detailOptionSeen) {
          throw new Error("Use only one of --detail or --details.");
        }
        imageDetails = [parseImageDetail(takeValue())];
        detailOptionSeen = true;
        break;
      case "--details":
        if (detailOptionSeen) {
          throw new Error("Use only one of --detail or --details.");
        }
        imageDetails = commaSeparated(takeValue(), "--details").map(
          parseImageDetail,
        );
        detailOptionSeen = true;
        break;
      case "--timeout-ms":
        timeoutMs = positiveInteger(takeValue(), "--timeout-ms");
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--confirm-live":
        confirmLive = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}\n\n${usage}`);
    }
  }

  if (!manifestPath) {
    throw new Error(`--manifest is required.\n\n${usage}`);
  }
  return {
    manifestPath,
    outputPath,
    models,
    split,
    caseIds,
    limit,
    repetitions,
    imageDetails,
    timeoutMs,
    dryRun,
    confirmLive,
  };
}

function defaultOutputPath(
  manifestPath: string,
  datasetId: string,
  split: CliOptions["split"],
): string {
  const safeDatasetId = datasetId.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(
    manifestPath,
    "..",
    "results",
    `${safeDatasetId}-${split}-${timestamp}.json`,
  );
}

function commaSeparated(value: string, label: string): string[] {
  const values = [
    ...new Set(value.split(",").map((item) => item.trim())),
  ].filter(Boolean);
  if (values.length === 0) throw new Error(`${label} cannot be empty.`);
  return values;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseImageDetail(value: string): EvaluationImageDetail {
  return z.enum(["low", "high", "auto"]).parse(value);
}

function assertNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    throw new Error(
      `Node.js 22 or newer is required; current version is ${process.versions.node}.`,
    );
  }
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function round(value: number | null): number | string {
  return value === null ? "n/a" : Math.round(value);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Evaluation failed.");
  process.exitCode = 1;
});
