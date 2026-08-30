import type {
  AlbumCandidate,
  AlbumIdentification,
  ProviderErrorCategory,
} from "@vinylhound/contracts";
import {
  determineReviewOutcome,
  normalizeOptionalReleaseIdentityPart,
  normalizeReleaseIdentityPart,
  type ReviewOutcome,
} from "@vinylhound/domain";

import type { ExpectedOutcome, RunnableEvaluationCase } from "./manifest.js";

const editionFields = [
  "releaseYear",
  "label",
  "catalogNumber",
  "barcode",
] as const;

type EditionField = (typeof editionFields)[number];
export type EditionFieldResult = "tp" | "tn" | "fp" | "fn" | "mismatch";

export interface AttemptScore {
  rank1Match: boolean;
  top3Match: boolean;
  predictedOutcome: ExpectedOutcome;
  expectedOutcome: ExpectedOutcome;
  routingMatch: boolean;
  edition: Record<EditionField, EditionFieldResult>;
}

export interface SuccessfulAttempt {
  status: "succeeded";
  caseId: string;
  split: "development" | "holdout";
  repetition: number;
  configuredModel: string;
  imageDetail: EvaluationImageDetail;
  resolvedModel: string;
  promptVersion: string;
  providerResponseId: string;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
  estimatedCostUsd: number | null;
  identification: AlbumIdentification;
  reviewOutcome: ReviewOutcome;
  score: AttemptScore;
}

export interface FailedAttempt {
  status: "failed";
  caseId: string;
  split: "development" | "holdout";
  repetition: number;
  configuredModel: string;
  imageDetail: EvaluationImageDetail;
  durationMs: number;
  error: {
    category: ProviderErrorCategory | "local_error";
    retryable: boolean;
    message: string;
  };
}

export type EvaluationAttempt = SuccessfulAttempt | FailedAttempt;
export type EvaluationImageDetail = "low" | "high" | "auto";

export interface ModelPricing {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export const MODEL_PRICING_USD: Readonly<Record<string, ModelPricing>> = {
  "gpt-5.6-sol": {
    inputUsdPerMillionTokens: 4,
    outputUsdPerMillionTokens: 20,
  },
  "gpt-5.6": {
    inputUsdPerMillionTokens: 4,
    outputUsdPerMillionTokens: 20,
  },
  "gpt-5.6-terra": {
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 12,
  },
  "gpt-5.6-luna": {
    inputUsdPerMillionTokens: 0.2,
    outputUsdPerMillionTokens: 1.2,
  },
};

export const MODEL_PRICING_AS_OF = "2026-08-29";

export function scoreIdentification(
  evaluationCase: RunnableEvaluationCase,
  identification: AlbumIdentification,
): { score: AttemptScore; reviewOutcome: ReviewOutcome } {
  const candidates = [...identification.candidates].sort(
    (left, right) => right.confidence - left.confidence,
  );
  const reviewOutcome = determineReviewOutcome(
    candidates,
    identification.needsReviewReasons,
  );
  const predictedOutcome = mapReviewOutcome(reviewOutcome);
  const expectedOutcome = evaluationCase.groundTruth.expectedOutcome;

  return {
    reviewOutcome,
    score: {
      rank1Match: candidates[0]
        ? albumMatches(evaluationCase, candidates[0])
        : false,
      top3Match: candidates
        .slice(0, 3)
        .some((candidate) => albumMatches(evaluationCase, candidate)),
      predictedOutcome,
      expectedOutcome,
      routingMatch: predictedOutcome === expectedOutcome,
      edition: scoreEditionFields(evaluationCase, candidates[0]),
    },
  };
}

export function estimateAttemptCost(
  model: string,
  usage: SuccessfulAttempt["usage"],
): number | null {
  if (!usage) return null;
  const pricing = pricingForModel(model);
  if (!pricing) return null;
  return (
    (usage.inputTokens * pricing.inputUsdPerMillionTokens +
      usage.outputTokens * pricing.outputUsdPerMillionTokens) /
    1_000_000
  );
}

export function aggregateConfigurationAttempts(
  model: string,
  imageDetail: EvaluationImageDetail,
  attempts: readonly EvaluationAttempt[],
) {
  const modelAttempts = attempts.filter(
    (attempt) =>
      attempt.configuredModel === model && attempt.imageDetail === imageDetail,
  );
  const succeeded = modelAttempts.filter(
    (attempt): attempt is SuccessfulAttempt => attempt.status === "succeeded",
  );
  const failed = modelAttempts.filter(
    (attempt): attempt is FailedAttempt => attempt.status === "failed",
  );
  const total = modelAttempts.length;
  const rank1Matches = succeeded.filter(
    (attempt) => attempt.score.rank1Match,
  ).length;
  const top3Matches = succeeded.filter(
    (attempt) => attempt.score.top3Match,
  ).length;
  const routingMatches = succeeded.filter(
    (attempt) => attempt.score.routingMatch,
  ).length;
  const latencies = modelAttempts.map((attempt) => attempt.durationMs);
  const usageRows = succeeded.flatMap((attempt) =>
    attempt.usage ? [attempt.usage] : [],
  );
  const knownCosts = succeeded.flatMap((attempt) =>
    attempt.estimatedCostUsd === null ? [] : [attempt.estimatedCostUsd],
  );

  return {
    model,
    imageDetail,
    attempts: total,
    schemaSuccesses: succeeded.length,
    schemaSuccessRate: ratio(succeeded.length, total),
    rank1Matches,
    rank1AccuracyEndToEnd: ratio(rank1Matches, total),
    rank1AccuracyOnSchemaSuccess: ratio(rank1Matches, succeeded.length),
    top3Matches,
    top3RecallEndToEnd: ratio(top3Matches, total),
    top3RecallOnSchemaSuccess: ratio(top3Matches, succeeded.length),
    routingMatches,
    routingAccuracyOnSchemaSuccess: ratio(routingMatches, succeeded.length),
    routingByOutcome: routingMetrics(succeeded),
    editionFields: editionMetrics(succeeded),
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      mean: mean(latencies),
    },
    tokens: {
      inputTotal: sum(usageRows.map((usage) => usage.inputTokens)),
      outputTotal: sum(usageRows.map((usage) => usage.outputTokens)),
      total: sum(usageRows.map((usage) => usage.totalTokens)),
      meanPerSuccessfulAttempt: mean(
        usageRows.map((usage) => usage.totalTokens),
      ),
    },
    estimatedCostUsd: knownCosts.length > 0 ? sum(knownCosts) : null,
    errors: errorMetrics(failed, total),
  };
}

function albumMatches(
  evaluationCase: RunnableEvaluationCase,
  candidate: AlbumCandidate,
): boolean {
  return (
    normalizeReleaseIdentityPart(candidate.artist) ===
      normalizeReleaseIdentityPart(evaluationCase.groundTruth.artist) &&
    normalizeReleaseIdentityPart(candidate.title) ===
      normalizeReleaseIdentityPart(evaluationCase.groundTruth.title)
  );
}

function scoreEditionFields(
  evaluationCase: RunnableEvaluationCase,
  candidate: AlbumCandidate | undefined,
): Record<EditionField, EditionFieldResult> {
  return Object.fromEntries(
    editionFields.map((field) => {
      const expected = evaluationCase.groundTruth[field];
      const predicted = candidate?.[field] ?? null;
      return [field, editionResult(field, expected, predicted)];
    }),
  ) as Record<EditionField, EditionFieldResult>;
}

function editionResult(
  field: EditionField,
  expected: string | number | null,
  predicted: string | number | null,
): EditionFieldResult {
  if (expected === null && predicted === null) return "tn";
  if (expected === null) return "fp";
  if (predicted === null) return "fn";
  if (editionValuesMatch(field, expected, predicted)) return "tp";
  return "mismatch";
}

function editionValuesMatch(
  field: EditionField,
  expected: string | number,
  predicted: string | number,
): boolean {
  if (field === "releaseYear") return expected === predicted;
  return (
    normalizeOptionalReleaseIdentityPart(String(expected)) ===
    normalizeOptionalReleaseIdentityPart(String(predicted))
  );
}

function mapReviewOutcome(outcome: ReviewOutcome): ExpectedOutcome {
  if (outcome.status === "identified") return "identify";
  return outcome.status;
}

function routingMetrics(attempts: readonly SuccessfulAttempt[]) {
  return Object.fromEntries(
    (["identify", "needs_review", "unresolved"] as const).map((outcome) => {
      const tp = attempts.filter(
        (attempt) =>
          attempt.score.expectedOutcome === outcome &&
          attempt.score.predictedOutcome === outcome,
      ).length;
      const predicted = attempts.filter(
        (attempt) => attempt.score.predictedOutcome === outcome,
      ).length;
      const expected = attempts.filter(
        (attempt) => attempt.score.expectedOutcome === outcome,
      ).length;
      return [
        outcome,
        {
          truePositives: tp,
          precision: ratio(tp, predicted),
          recall: ratio(tp, expected),
        },
      ];
    }),
  );
}

function editionMetrics(attempts: readonly SuccessfulAttempt[]) {
  return Object.fromEntries(
    editionFields.map((field) => {
      const results = attempts.map((attempt) => attempt.score.edition[field]);
      const tp = count(results, "tp");
      const fp = count(results, "fp") + count(results, "mismatch");
      const fn = count(results, "fn") + count(results, "mismatch");
      const tn = count(results, "tn");
      return [
        field,
        {
          truePositives: tp,
          trueNegatives: tn,
          falsePositives: fp,
          falseNegatives: fn,
          mismatches: count(results, "mismatch"),
          precision: ratio(tp, tp + fp),
          recall: ratio(tp, tp + fn),
          falseDiscoveryRate: ratio(fp, tp + fp),
        },
      ];
    }),
  );
}

function errorMetrics(failed: readonly FailedAttempt[], total: number) {
  const byCategory = Object.fromEntries(
    [...new Set(failed.map((attempt) => attempt.error.category))].map(
      (category) => {
        const categoryCount = failed.filter(
          (attempt) => attempt.error.category === category,
        ).length;
        return [
          category,
          { count: categoryCount, rate: ratio(categoryCount, total) },
        ];
      },
    ),
  );
  const transient = failed.filter((attempt) => attempt.error.retryable).length;
  return {
    total: failed.length,
    rate: ratio(failed.length, total),
    transient,
    terminal: failed.length - transient,
    byCategory,
  };
}

function pricingForModel(model: string): ModelPricing | undefined {
  const exact = MODEL_PRICING_USD[model];
  if (exact) return exact;
  return Object.entries(MODEL_PRICING_USD).find(([prefix]) =>
    model.startsWith(`${prefix}-`),
  )?.[1];
}

function percentile(
  values: readonly number[],
  quantile: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? null;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function count<T>(values: readonly T[], target: T): number {
  return values.filter((value) => value === target).length;
}
