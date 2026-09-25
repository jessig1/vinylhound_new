import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";

import {
  EvaluationManifestSchema,
  EvaluationSplitSchema,
  ExpectedOutcomeSchema,
  QualityTagSchema,
  ViewTypeSchema,
  type EvaluationCase,
  type EvaluationManifest,
} from "./manifest.ts";

const SUPPORTED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
]);

const CASE_ID_PATTERN = /^vh-(\d+)$/;

export interface ScaffoldOptions {
  manifestPath: string;
  imageRoot: string;
  datasetId?: string;
}

export interface ScaffoldResult {
  manifest: EvaluationManifest;
  manifestPath: string;
  addedCaseIds: string[];
  unlabeledCaseIds: string[];
}

export async function scaffoldManifest(
  options: ScaffoldOptions,
): Promise<ScaffoldResult> {
  const manifestPath = resolve(options.manifestPath);
  const imageRoot = resolve(options.imageRoot);
  const existing = await readExistingManifest(manifestPath);
  const manifest = existing ?? createBaseManifest(options.datasetId);
  manifest.dataset.imageRoot = toPosixPath(
    relative(dirname(manifestPath), imageRoot) || ".",
  );

  const discovered = await discoverImages(imageRoot);
  const knownImages = new Set(manifest.cases.map((item) => item.image));
  const newImages = discovered.filter((image) => !knownImages.has(image));

  let nextNumber = nextCaseNumber(manifest.cases);
  const addedCaseIds: string[] = [];
  for (const image of newImages) {
    const caseId = `vh-${String(nextNumber).padStart(3, "0")}`;
    nextNumber += 1;
    manifest.cases.push(blankCase(caseId, image));
    addedCaseIds.push(caseId);
  }

  if (manifest.cases.length === 0) {
    throw new Error(
      `No supported images found under ${imageRoot} and no existing cases in the manifest. Add JPEG/PNG/GIF/WebP files under the image root first.`,
    );
  }

  const parsed = EvaluationManifestSchema.parse(manifest);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

  return {
    manifest: parsed,
    manifestPath,
    addedCaseIds,
    unlabeledCaseIds: parsed.cases
      .filter((item) => !isLabeled(item))
      .map((item) => item.caseId),
  };
}

function isLabeled(evaluationCase: EvaluationCase): boolean {
  return (
    evaluationCase.groundTruth.maintainerVerified === true &&
    evaluationCase.consent.allowedForPrivateEvaluation === true &&
    evaluationCase.split !== null &&
    evaluationCase.viewType !== null &&
    evaluationCase.groundTruth.artist !== null &&
    evaluationCase.groundTruth.title !== null &&
    evaluationCase.groundTruth.expectedOutcome !== null
  );
}

async function readExistingManifest(
  manifestPath: string,
): Promise<EvaluationManifest | null> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  return EvaluationManifestSchema.parse(JSON.parse(raw));
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function discoverImages(imageRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(imageRoot, { recursive: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`Image root does not exist: ${imageRoot}`, {
        cause: error,
      });
    }
    throw error;
  }
  return entries
    .filter((entry) => SUPPORTED_EXTENSIONS.has(extname(entry).toLowerCase()))
    .map(toPosixPath)
    .sort();
}

function toPosixPath(value: string): string {
  return value.split("\\").join("/");
}

function nextCaseNumber(cases: readonly EvaluationCase[]): number {
  let highest = 0;
  for (const evaluationCase of cases) {
    const match = CASE_ID_PATTERN.exec(evaluationCase.caseId);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

function blankCase(caseId: string, image: string): EvaluationCase {
  return {
    caseId,
    image,
    viewType: null,
    split: null,
    appSuggestions: {
      chatgptWeb: emptySuggestion(),
      geminiWeb: emptySuggestion(),
    },
    groundTruth: {
      artist: null,
      title: null,
      releaseYear: null,
      label: null,
      catalogNumber: null,
      barcode: null,
      expectedOutcome: null,
      qualityTags: [],
      difficultyNotes: null,
      ambiguityNotes: null,
      maintainerVerified: false,
      verificationNotes: null,
    },
    consent: {
      allowedForPrivateEvaluation: null,
      retentionNotes: null,
    },
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

function createBaseManifest(
  datasetId = "vinylhound-private-eval",
): EvaluationManifest {
  return {
    schemaVersion: 1,
    dataset: {
      id: datasetId,
      version: "0.1.0",
      createdAt: new Date().toISOString().slice(0, 10),
      purpose:
        "Private held-out evaluation of album cover identification against maintainer-verified labels.",
      imageRoot: ".",
      privacy:
        "Consented private images only. Never committed to the public repository.",
      splitPolicy:
        "Assign each case to development or holdout when labeling. Do not tune against holdout cases.",
    },
    allowedValues: {
      viewType: [...ViewTypeSchema.options],
      split: [...EvaluationSplitSchema.options],
      expectedOutcome: [...ExpectedOutcomeSchema.options],
      qualityTags: [...QualityTagSchema.options],
    },
    appInstructions: [],
    cases: [],
  };
}
