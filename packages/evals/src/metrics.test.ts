import { describe, expect, it } from "vitest";

import type {
  AlbumCandidate,
  AlbumIdentification,
} from "@vinylhound/contracts";

import {
  aggregateConfigurationAttempts,
  estimateAttemptCost,
  scoreIdentification,
  type SuccessfulAttempt,
} from "./metrics.js";
import { evaluationCase } from "./test-fixture.js";

describe("evaluation scoring", () => {
  it("normalizes artist/title and finds the expected album in the top three", () => {
    const result = scoreIdentification(
      evaluationCase(),
      identification([
        candidate("John Coltrane", "Blue Train", 0.96),
        candidate("MILES  DAVIS", "Kind-of-Blue", 0.8),
      ]),
    );

    expect(result.score).toMatchObject({
      rank1Match: false,
      top3Match: true,
    });
  });

  it("counts unsupported edition facts as false positives", () => {
    const testCase = evaluationCase({
      groundTruth: {
        ...evaluationCase().groundTruth,
        releaseYear: null,
        label: null,
      },
    });
    const result = scoreIdentification(
      testCase,
      identification([candidate("Miles Davis", "Kind of Blue", 0.97)]),
    );

    expect(result.score.edition.releaseYear).toBe("fp");
    expect(result.score.edition.label).toBe("fp");
    expect(result.score.edition.catalogNumber).toBe("tn");
  });

  it("scores the domain review policy against the expected route", () => {
    const result = scoreIdentification(
      evaluationCase(),
      identification([candidate("Miles Davis", "Kind of Blue", 0.7)]),
    );

    expect(result.score).toMatchObject({
      predictedOutcome: "needs_review",
      expectedOutcome: "identify",
      routingMatch: false,
    });
  });

  it("aggregates accuracy, latency, tokens, cost, and edition precision", () => {
    const successful = successAttempt();
    const aggregate = aggregateConfigurationAttempts("gpt-5.6-terra", "high", [
      successful,
      {
        status: "failed",
        caseId: "vh-002",
        split: "holdout",
        repetition: 1,
        configuredModel: "gpt-5.6-terra",
        imageDetail: "high",
        durationMs: 200,
        error: {
          category: "timeout",
          retryable: true,
          message: "Timed out",
        },
      },
    ]);

    expect(aggregate).toMatchObject({
      attempts: 2,
      schemaSuccessRate: 0.5,
      rank1AccuracyEndToEnd: 0.5,
      rank1AccuracyOnSchemaSuccess: 1,
      top3RecallEndToEnd: 0.5,
      routingAccuracyOnSchemaSuccess: 1,
      latencyMs: { p50: 100, p95: 200, mean: 150 },
      tokens: { inputTotal: 1000, outputTotal: 100, total: 1100 },
      errors: { total: 1, rate: 0.5, transient: 1, terminal: 0 },
    });
    expect(aggregate.estimatedCostUsd).toBeCloseTo(0.0032);
  });

  it("estimates cost using the configured model's token rates", () => {
    expect(
      estimateAttemptCost("gpt-5.6-sol", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
      }),
    ).toBe(24);
    expect(
      estimateAttemptCost("unpriced-model", {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      }),
    ).toBeNull();
  });
});

function candidate(
  artist: string,
  title: string,
  confidence: number,
): AlbumCandidate {
  return {
    artist,
    title,
    releaseYear: 1959,
    label: "Columbia",
    catalogNumber: null,
    barcode: null,
    confidence,
    evidence: ["Visible cover evidence"],
    warnings: [],
  };
}

function identification(candidates: AlbumCandidate[]): AlbumIdentification {
  return { candidates, observations: [], needsReviewReasons: [] };
}

function successAttempt(): SuccessfulAttempt {
  const scored = scoreIdentification(
    evaluationCase(),
    identification([candidate("Miles Davis", "Kind of Blue", 0.97)]),
  );
  return {
    status: "succeeded",
    caseId: "vh-001",
    split: "holdout",
    repetition: 1,
    configuredModel: "gpt-5.6-terra",
    imageDetail: "high",
    resolvedModel: "gpt-5.6-terra",
    promptVersion: "album-identification.v1",
    providerResponseId: "resp_test",
    durationMs: 100,
    usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    estimatedCostUsd: 0.0032,
    identification: identification([
      candidate("Miles Davis", "Kind of Blue", 0.97),
    ]),
    reviewOutcome: scored.reviewOutcome,
    score: scored.score,
  };
}
