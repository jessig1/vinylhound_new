import { z } from "zod";

const NullableTextSchema = z.string().trim().min(1).nullable();
const NullableYearSchema = z.number().int().min(1900).max(2200).nullable();

export const EvaluationSplitSchema = z.enum(["development", "holdout"]);
export const ExpectedOutcomeSchema = z.enum([
  "identify",
  "needs_review",
  "unresolved",
]);
export const ViewTypeSchema = z.enum([
  "front",
  "back",
  "spine",
  "label",
  "barcode",
  "runout",
  "other",
]);
export const QualityTagSchema = z.enum([
  "glare",
  "crop",
  "blur",
  "handwriting",
  "protective_sleeve",
  "low_light",
  "damaged",
  "text_free",
  "instruction_bearing",
  "other",
]);

const EditionFieldsShape = {
  artist: NullableTextSchema,
  title: NullableTextSchema,
  releaseYear: NullableYearSchema,
  label: NullableTextSchema,
  catalogNumber: NullableTextSchema,
  barcode: NullableTextSchema,
};

const AppSuggestionSchema = z
  .object({
    ...EditionFieldsShape,
    visibleEvidence: z.array(z.string().trim().min(1)),
    qualityObservations: z.array(z.string().trim().min(1)),
    needsReviewReasons: z.array(z.string().trim().min(1)),
  })
  .strict();

const GroundTruthSchema = z
  .object({
    ...EditionFieldsShape,
    expectedOutcome: ExpectedOutcomeSchema.nullable(),
    qualityTags: z.array(QualityTagSchema),
    difficultyNotes: NullableTextSchema,
    ambiguityNotes: NullableTextSchema,
    maintainerVerified: z.boolean(),
    verificationNotes: NullableTextSchema,
  })
  .strict();

export const EvaluationCaseSchema = z
  .object({
    caseId: z.string().trim().min(1),
    image: z.string().trim().min(1),
    viewType: ViewTypeSchema.nullable(),
    split: EvaluationSplitSchema.nullable(),
    appSuggestions: z
      .object({
        chatgptWeb: AppSuggestionSchema,
        geminiWeb: AppSuggestionSchema,
      })
      .strict(),
    groundTruth: GroundTruthSchema,
    consent: z
      .object({
        allowedForPrivateEvaluation: z.boolean().nullable(),
        retentionNotes: NullableTextSchema,
      })
      .strict(),
  })
  .strict();

export const EvaluationManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    dataset: z
      .object({
        id: z.string().trim().min(1),
        version: z.string().trim().min(1),
        createdAt: z.string().trim().min(1),
        purpose: z.string().trim().min(1),
        imageRoot: z.string().trim().min(1),
        privacy: z.string().trim().min(1),
        splitPolicy: z.string().trim().min(1),
      })
      .strict(),
    allowedValues: z
      .object({
        viewType: z.array(z.string()),
        split: z.array(z.string()),
        expectedOutcome: z.array(z.string()),
        qualityTags: z.array(z.string()),
      })
      .strict(),
    appInstructions: z.array(z.string()),
    cases: z.array(EvaluationCaseSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const [index, evaluationCase] of manifest.cases.entries()) {
      if (seen.has(evaluationCase.caseId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate caseId: ${evaluationCase.caseId}`,
          path: ["cases", index, "caseId"],
        });
      }
      seen.add(evaluationCase.caseId);
    }
  });

export type EvaluationManifest = z.infer<typeof EvaluationManifestSchema>;
export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>;
export type ExpectedOutcome = z.infer<typeof ExpectedOutcomeSchema>;
export type EvaluationSplit = z.infer<typeof EvaluationSplitSchema>;

export interface RunnableEvaluationCase extends EvaluationCase {
  viewType: z.infer<typeof ViewTypeSchema>;
  split: EvaluationSplit;
  groundTruth: EvaluationCase["groundTruth"] & {
    artist: string;
    title: string;
    expectedOutcome: ExpectedOutcome;
    maintainerVerified: true;
  };
  consent: EvaluationCase["consent"] & {
    allowedForPrivateEvaluation: true;
  };
}

export interface SelectCasesOptions {
  split: EvaluationSplit | "all";
  caseIds?: readonly string[];
  limit?: number;
}

export function selectRunnableCases(
  manifest: EvaluationManifest,
  options: SelectCasesOptions,
): RunnableEvaluationCase[] {
  const requestedIds = options.caseIds ? new Set(options.caseIds) : undefined;
  if (requestedIds) {
    const knownIds = new Set(manifest.cases.map((item) => item.caseId));
    const unknown = [...requestedIds].filter((id) => !knownIds.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown case IDs: ${unknown.join(", ")}`);
    }
  }

  const selected = manifest.cases.filter(
    (item) =>
      (options.split === "all" || item.split === options.split) &&
      (!requestedIds || requestedIds.has(item.caseId)),
  );
  const limited = options.limit ? selected.slice(0, options.limit) : selected;

  if (limited.length === 0) {
    throw new Error(
      `No cases matched split=${options.split}${requestedIds ? " and the requested case IDs" : ""}.`,
    );
  }

  const readinessErrors = limited.flatMap(caseReadinessErrors);
  if (readinessErrors.length > 0) {
    throw new Error(
      `Selected cases are not ready for a live evaluation:\n- ${readinessErrors.join("\n- ")}`,
    );
  }

  return limited as RunnableEvaluationCase[];
}

function caseReadinessErrors(evaluationCase: EvaluationCase): string[] {
  const errors: string[] = [];
  if (!evaluationCase.split)
    errors.push(`${evaluationCase.caseId}: split missing`);
  if (!evaluationCase.viewType)
    errors.push(`${evaluationCase.caseId}: viewType missing`);
  if (evaluationCase.consent.allowedForPrivateEvaluation !== true) {
    errors.push(
      `${evaluationCase.caseId}: private-evaluation consent not confirmed`,
    );
  }
  if (evaluationCase.groundTruth.maintainerVerified !== true) {
    errors.push(
      `${evaluationCase.caseId}: ground truth not maintainer-verified`,
    );
  }
  if (!evaluationCase.groundTruth.artist) {
    errors.push(`${evaluationCase.caseId}: groundTruth.artist missing`);
  }
  if (!evaluationCase.groundTruth.title) {
    errors.push(`${evaluationCase.caseId}: groundTruth.title missing`);
  }
  if (!evaluationCase.groundTruth.expectedOutcome) {
    errors.push(`${evaluationCase.caseId}: expectedOutcome missing`);
  }
  return errors;
}
