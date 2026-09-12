import type {
  EvaluationCase,
  EvaluationManifest,
  RunnableEvaluationCase,
} from "./manifest.ts";

export function evaluationCase(
  overrides: Partial<EvaluationCase> = {},
): RunnableEvaluationCase {
  const base: EvaluationCase = {
    caseId: "vh-001",
    image: "cover.jpg",
    viewType: "front",
    split: "holdout",
    appSuggestions: {
      chatgptWeb: emptySuggestion(),
      geminiWeb: emptySuggestion(),
    },
    groundTruth: {
      artist: "Miles Davis",
      title: "Kind of Blue",
      releaseYear: 1959,
      label: "Columbia",
      catalogNumber: null,
      barcode: null,
      expectedOutcome: "identify",
      qualityTags: [],
      difficultyNotes: null,
      ambiguityNotes: null,
      maintainerVerified: true,
      verificationNotes: null,
    },
    consent: {
      allowedForPrivateEvaluation: true,
      retentionNotes: "Private local evaluation only",
    },
  };
  return { ...base, ...overrides } as RunnableEvaluationCase;
}

export function evaluationManifest(
  cases: EvaluationCase[] = [evaluationCase()],
): EvaluationManifest {
  return {
    schemaVersion: 1,
    dataset: {
      id: "test-dataset",
      version: "1.0.0",
      createdAt: "2026-08-29",
      purpose: "Unit test",
      imageRoot: ".",
      privacy: "Private",
      splitPolicy: "Holdout",
    },
    allowedValues: {
      viewType: ["front"],
      split: ["development", "holdout"],
      expectedOutcome: ["identify", "needs_review", "unresolved"],
      qualityTags: [],
    },
    appInstructions: [],
    cases,
  };
}

function emptySuggestion() {
  return {
    artist: null,
    title: null,
    releaseYear: null,
    label: null,
    catalogNumber: null,
    barcode: null,
    visibleEvidence: [],
    qualityObservations: [],
    needsReviewReasons: [],
  };
}
