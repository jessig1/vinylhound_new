import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  AlbumIdentificationError,
  ALBUM_IDENTIFICATION_PROMPT_VERSION,
  createOpenAIAlbumIdentifier,
  type AlbumIdentifier,
} from "@vinylhound/ai";
import {
  detectImageMimeType,
  IMAGE_SNIFF_BYTE_LENGTH,
  MAX_IMAGE_SIZE_BYTES,
} from "@vinylhound/contracts";

import {
  EvaluationManifestSchema,
  selectRunnableCases,
  type EvaluationManifest,
  type EvaluationSplit,
  type RunnableEvaluationCase,
} from "./manifest.ts";
import {
  aggregateConfigurationAttempts,
  estimateAttemptCost,
  MODEL_PRICING_AS_OF,
  MODEL_PRICING_USD,
  scoreIdentification,
  type EvaluationAttempt,
  type EvaluationImageDetail,
} from "./metrics.ts";

export const DEFAULT_EVALUATION_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;
export const DEFAULT_EVALUATION_IMAGE_DETAILS = ["high"] as const;

export interface EvaluationRunOptions {
  manifestPath: string;
  outputPath: string;
  apiKey: string;
  models: readonly string[];
  imageDetails: readonly EvaluationImageDetail[];
  timeoutMs: number;
  split: EvaluationSplit | "all";
  caseIds?: readonly string[];
  limit?: number;
  repetitions: number;
  onProgress?: (progress: EvaluationProgress) => void;
  createIdentifier?: (
    model: string,
    imageDetail: EvaluationImageDetail,
  ) => AlbumIdentifier;
}

export interface EvaluationProgress {
  completed: number;
  total: number;
  attempt: EvaluationAttempt;
  outputPath: string;
}

export interface EvaluationRunFile {
  schemaVersion: 2;
  runId: string;
  status: "running" | "completed";
  startedAt: string;
  finishedAt: string | null;
  dataset: EvaluationManifest["dataset"];
  configuration: {
    models: readonly string[];
    imageDetails: readonly EvaluationImageDetail[];
    split: EvaluationSplit | "all";
    caseIds: readonly string[] | null;
    repetitions: number;
    caseCount: number;
    plannedAttempts: number;
    promptVersion: string;
    pricing: {
      currency: "USD";
      asOf: string;
      ratesPerMillionTokens: typeof MODEL_PRICING_USD;
      caveat: string;
    };
  };
  attempts: EvaluationAttempt[];
  aggregates: ReturnType<typeof aggregateConfigurationAttempts>[];
}

export async function loadEvaluationManifest(
  manifestPath: string,
): Promise<EvaluationManifest> {
  const raw = await readFile(manifestPath, "utf8");
  return EvaluationManifestSchema.parse(JSON.parse(raw));
}

export async function validateEvaluationInputs(options: {
  manifestPath: string;
  split: EvaluationSplit | "all";
  caseIds?: readonly string[];
  limit?: number;
}) {
  const manifestPath = resolve(options.manifestPath);
  const manifest = await loadEvaluationManifest(manifestPath);
  const cases = selectRunnableCases(manifest, options);
  const imageRoot = resolve(dirname(manifestPath), manifest.dataset.imageRoot);

  for (const evaluationCase of cases) {
    const imagePath = resolvePrivateImagePath(imageRoot, evaluationCase.image);
    const bytes = await readFile(imagePath);
    validateImageBytes(evaluationCase, bytes);
  }

  return { manifest, cases, imageRoot, manifestPath };
}

export async function runEvaluation(
  options: EvaluationRunOptions,
): Promise<EvaluationRunFile> {
  const { manifest, cases, imageRoot } =
    await validateEvaluationInputs(options);
  const outputPath = resolve(options.outputPath);
  const plannedAttempts =
    cases.length *
    options.models.length *
    options.imageDetails.length *
    options.repetitions;
  const runFile: EvaluationRunFile = {
    schemaVersion: 2,
    runId: randomUUID(),
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    dataset: manifest.dataset,
    configuration: {
      models: options.models,
      imageDetails: options.imageDetails,
      split: options.split,
      caseIds: options.caseIds ?? null,
      repetitions: options.repetitions,
      caseCount: cases.length,
      plannedAttempts,
      promptVersion: ALBUM_IDENTIFICATION_PROMPT_VERSION,
      pricing: {
        currency: "USD",
        asOf: MODEL_PRICING_AS_OF,
        ratesPerMillionTokens: MODEL_PRICING_USD,
        caveat:
          "Estimate uses uncached text-token rates and response usage. Actual billing may differ because of caching, pricing changes, or account terms.",
      },
    },
    attempts: [],
    aggregates: [],
  };

  await checkpoint(outputPath, runFile);

  const createIdentifier =
    options.createIdentifier ??
    ((model: string, imageDetail: EvaluationImageDetail) =>
      createOpenAIAlbumIdentifier({
        apiKey: options.apiKey,
        model,
        imageDetail,
        timeoutMs: options.timeoutMs,
      }));

  for (const model of options.models) {
    for (const imageDetail of options.imageDetails) {
      const identifier = createIdentifier(model, imageDetail);
      for (const evaluationCase of cases) {
        const imagePath = resolvePrivateImagePath(
          imageRoot,
          evaluationCase.image,
        );
        const dataUrl = await imageDataUrl(evaluationCase, imagePath);
        for (
          let repetition = 1;
          repetition <= options.repetitions;
          repetition++
        ) {
          const attempt = await evaluateAttempt({
            identifier,
            model,
            imageDetail,
            evaluationCase,
            dataUrl,
            repetition,
          });
          runFile.attempts.push(attempt);
          runFile.aggregates = aggregateConfigurations(
            options.models,
            options.imageDetails,
            runFile.attempts,
          );
          await checkpoint(outputPath, runFile);
          options.onProgress?.({
            completed: runFile.attempts.length,
            total: plannedAttempts,
            attempt,
            outputPath,
          });
        }
      }
    }
  }

  runFile.status = "completed";
  runFile.finishedAt = new Date().toISOString();
  runFile.aggregates = aggregateConfigurations(
    options.models,
    options.imageDetails,
    runFile.attempts,
  );
  await checkpoint(outputPath, runFile);
  return runFile;
}

async function evaluateAttempt(options: {
  identifier: AlbumIdentifier;
  model: string;
  imageDetail: EvaluationImageDetail;
  evaluationCase: RunnableEvaluationCase;
  dataUrl: string;
  repetition: number;
}): Promise<EvaluationAttempt> {
  const startedAt = performance.now();
  try {
    const response = await options.identifier.identify({
      scanId: options.evaluationCase.caseId,
      images: [
        {
          url: options.dataUrl,
          viewType: options.evaluationCase.viewType,
        },
      ],
    });
    const durationMs = performance.now() - startedAt;
    const { score, reviewOutcome } = scoreIdentification(
      options.evaluationCase,
      response.identification,
    );
    return {
      status: "succeeded",
      caseId: options.evaluationCase.caseId,
      split: options.evaluationCase.split,
      repetition: options.repetition,
      configuredModel: options.model,
      imageDetail: options.imageDetail,
      resolvedModel: response.metadata.model,
      promptVersion: response.metadata.promptVersion,
      providerResponseId: response.metadata.providerResponseId,
      durationMs,
      usage: response.metadata.usage,
      estimatedCostUsd: estimateAttemptCost(
        options.model,
        response.metadata.usage,
      ),
      identification: response.identification,
      reviewOutcome,
      score,
    };
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    if (error instanceof AlbumIdentificationError) {
      return {
        status: "failed",
        caseId: options.evaluationCase.caseId,
        split: options.evaluationCase.split,
        repetition: options.repetition,
        configuredModel: options.model,
        imageDetail: options.imageDetail,
        durationMs,
        error: {
          category: error.category,
          retryable: error.retryable,
          message: error.message,
        },
      };
    }
    return {
      status: "failed",
      caseId: options.evaluationCase.caseId,
      split: options.evaluationCase.split,
      repetition: options.repetition,
      configuredModel: options.model,
      imageDetail: options.imageDetail,
      durationMs,
      error: {
        category: "local_error",
        retryable: false,
        message: error instanceof Error ? error.message : "Unknown local error",
      },
    };
  }
}

function aggregateConfigurations(
  models: readonly string[],
  imageDetails: readonly EvaluationImageDetail[],
  attempts: readonly EvaluationAttempt[],
) {
  return models.flatMap((model) =>
    imageDetails.map((imageDetail) =>
      aggregateConfigurationAttempts(model, imageDetail, attempts),
    ),
  );
}

async function imageDataUrl(
  evaluationCase: RunnableEvaluationCase,
  imagePath: string,
): Promise<string> {
  const bytes = await readFile(imagePath);
  const mimeType = validateImageBytes(evaluationCase, bytes);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function validateImageBytes(
  evaluationCase: RunnableEvaluationCase,
  bytes: Buffer,
): string {
  if (bytes.byteLength > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(
      `${evaluationCase.caseId}: image exceeds ${MAX_IMAGE_SIZE_BYTES} bytes`,
    );
  }
  const detected = detectImageMimeType(
    bytes.subarray(0, IMAGE_SNIFF_BYTE_LENGTH),
  );
  if (detected.kind !== "supported") {
    throw new Error(
      `${evaluationCase.caseId}: image is not a supported JPEG, PNG, WebP, or GIF`,
    );
  }
  return detected.mimeType;
}

function resolvePrivateImagePath(imageRoot: string, image: string): string {
  if (isAbsolute(image)) {
    throw new Error(`Manifest image paths must be relative: ${image}`);
  }
  const imagePath = resolve(imageRoot, image);
  const relativePath = relative(imageRoot, imagePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Manifest image path escapes imageRoot: ${image}`);
  }
  return imagePath;
}

async function checkpoint(
  outputPath: string,
  runFile: EvaluationRunFile,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(runFile, null, 2)}\n`, "utf8");
}
