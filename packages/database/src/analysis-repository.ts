import { and, asc, desc, eq } from "drizzle-orm";

import type {
  AlbumIdentification,
  AnalyzeScanJob,
  GetScanResponse,
  ProviderErrorCategory,
  ReviewOutcomeReason,
} from "@vinylhound/contracts";

import type { Database } from "./database.js";
import { getScanConfirmationForUser } from "./confirmation-repository.js";
import { DatabaseCommandError } from "./scan-repository.js";
import { imageAssets, scanAttempts, scanCandidates, scans } from "./schema.js";

export interface PrepareScanAnalysisInput {
  job: AnalyzeScanJob;
  deliveryAttempt: number;
  model: string;
  promptVersion: string;
}

export type PrepareScanAnalysisResult =
  | { status: "already_succeeded" }
  | {
      status: "ready";
      attemptId: string;
      images: Array<{
        id: string;
        objectKey: string;
        viewType:
          "front" | "back" | "spine" | "label" | "barcode" | "runout" | "other";
        mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
        sizeBytes: number;
      }>;
    };

export async function prepareScanAnalysis(
  db: Database,
  input: PrepareScanAnalysisInput,
): Promise<PrepareScanAnalysisResult> {
  return db.transaction(async (transaction) => {
    const [scan] = await transaction
      .select()
      .from(scans)
      .where(
        and(eq(scans.id, input.job.scanId), eq(scans.userId, input.job.userId)),
      )
      .for("update");

    if (!scan) {
      throw new DatabaseCommandError("not_found", "Scan not found.");
    }

    const succeeded = await transaction.query.scanAttempts.findFirst({
      where: and(
        eq(scanAttempts.scanId, scan.id),
        eq(scanAttempts.attemptNumber, input.job.attemptNumber),
        eq(scanAttempts.status, "succeeded"),
      ),
    });
    if (succeeded) {
      return { status: "already_succeeded" };
    }

    if (scan.status !== "queued" && scan.status !== "processing") {
      throw new DatabaseCommandError(
        "invalid_state",
        `A scan in ${scan.status} state cannot start analysis.`,
      );
    }

    const storedImages = await transaction
      .select({
        id: imageAssets.id,
        objectKey: imageAssets.objectKey,
        viewType: imageAssets.viewType,
        mimeType: imageAssets.mimeType,
        sizeBytes: imageAssets.sizeBytes,
        completedAt: imageAssets.completedAt,
      })
      .from(imageAssets)
      .where(eq(imageAssets.scanId, scan.id));
    const imagesById = new Map(storedImages.map((image) => [image.id, image]));
    const requestedImages = input.job.imageIds.map((imageId) =>
      imagesById.get(imageId),
    );

    if (
      storedImages.length !== input.job.imageIds.length ||
      storedImages.some((image) => !input.job.imageIds.includes(image.id)) ||
      requestedImages.some(
        (image) => image === undefined || image.completedAt === null,
      )
    ) {
      throw new DatabaseCommandError(
        "invalid_state",
        "The queued image set no longer matches the completed scan images.",
      );
    }

    const existing = await transaction.query.scanAttempts.findFirst({
      where: and(
        eq(scanAttempts.scanId, scan.id),
        eq(scanAttempts.attemptNumber, input.job.attemptNumber),
        eq(scanAttempts.deliveryAttempt, input.deliveryAttempt),
      ),
    });
    const startedAt = new Date();
    let attemptId: string;

    if (existing) {
      if (existing.status === "succeeded") {
        return { status: "already_succeeded" };
      }
      attemptId = existing.id;
      await transaction
        .update(scanAttempts)
        .set({
          status: "processing",
          model: input.model,
          promptVersion: input.promptVersion,
          providerResponseId: null,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          durationMs: null,
          errorCategory: null,
          errorMessage: null,
          observations: [],
          needsReviewReasons: [],
          outcomeReason: null,
          startedAt,
          completedAt: null,
        })
        .where(eq(scanAttempts.id, existing.id));
    } else {
      const [created] = await transaction
        .insert(scanAttempts)
        .values({
          scanId: scan.id,
          attemptNumber: input.job.attemptNumber,
          deliveryAttempt: input.deliveryAttempt,
          status: "processing",
          model: input.model,
          promptVersion: input.promptVersion,
          startedAt,
        })
        .returning({ id: scanAttempts.id });
      attemptId = created!.id;
    }

    await transaction
      .update(scans)
      .set({ status: "processing", updatedAt: startedAt, completedAt: null })
      .where(eq(scans.id, scan.id));

    return {
      status: "ready",
      attemptId,
      images: requestedImages.map((image) => ({
        id: image!.id,
        objectKey: image!.objectKey,
        viewType: image!.viewType,
        mimeType: image!.mimeType,
        sizeBytes: image!.sizeBytes,
      })),
    };
  });
}

export interface CompleteScanAnalysisInput {
  scanId: string;
  attemptId: string;
  identification: AlbumIdentification;
  outcome: {
    status: "identified" | "needs_review" | "unresolved";
    reason: ReviewOutcomeReason;
  };
  metadata: {
    model: string;
    promptVersion: string;
    providerResponseId: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    } | null;
  };
  durationMs: number;
}

export async function completeScanAnalysis(
  db: Database,
  input: CompleteScanAnalysisInput,
) {
  return db.transaction(async (transaction) => {
    const [attempt] = await transaction
      .select()
      .from(scanAttempts)
      .where(
        and(
          eq(scanAttempts.id, input.attemptId),
          eq(scanAttempts.scanId, input.scanId),
        ),
      )
      .for("update");
    if (!attempt) {
      throw new DatabaseCommandError("not_found", "Scan attempt not found.");
    }
    if (attempt.status === "succeeded") {
      return;
    }
    if (attempt.status !== "processing") {
      throw new DatabaseCommandError(
        "invalid_state",
        "Only a processing scan attempt can succeed.",
      );
    }

    const rankedCandidates = [...input.identification.candidates].sort(
      (left, right) => right.confidence - left.confidence,
    );
    if (rankedCandidates.length > 0) {
      await transaction.insert(scanCandidates).values(
        rankedCandidates.map((candidate, index) => ({
          scanAttemptId: attempt.id,
          rank: index + 1,
          ...candidate,
        })),
      );
    }

    const completedAt = new Date();
    await transaction
      .update(scanAttempts)
      .set({
        status: "succeeded",
        model: input.metadata.model,
        promptVersion: input.metadata.promptVersion,
        providerResponseId: input.metadata.providerResponseId,
        inputTokens: input.metadata.usage?.inputTokens ?? null,
        outputTokens: input.metadata.usage?.outputTokens ?? null,
        totalTokens: input.metadata.usage?.totalTokens ?? null,
        durationMs: input.durationMs,
        observations: input.identification.observations,
        needsReviewReasons: input.identification.needsReviewReasons,
        outcomeReason: input.outcome.reason,
        completedAt,
      })
      .where(eq(scanAttempts.id, attempt.id));
    await transaction
      .update(scans)
      .set({
        status: input.outcome.status,
        updatedAt: completedAt,
        completedAt,
      })
      .where(eq(scans.id, input.scanId));
  });
}

export async function failScanAnalysis(
  db: Database,
  input: {
    scanId: string;
    attemptId: string;
    category: ProviderErrorCategory;
    message: string;
    durationMs: number;
    terminal: boolean;
  },
) {
  return db.transaction(async (transaction) => {
    const [attempt] = await transaction
      .select()
      .from(scanAttempts)
      .where(
        and(
          eq(scanAttempts.id, input.attemptId),
          eq(scanAttempts.scanId, input.scanId),
        ),
      )
      .for("update");
    if (!attempt || attempt.status === "succeeded") {
      return;
    }

    const completedAt = new Date();
    await transaction
      .update(scanAttempts)
      .set({
        status: "failed",
        durationMs: input.durationMs,
        errorCategory: input.category,
        errorMessage: input.message,
        completedAt,
      })
      .where(eq(scanAttempts.id, attempt.id));
    await transaction
      .update(scans)
      .set({
        status: input.terminal ? "failed" : "queued",
        updatedAt: completedAt,
        completedAt: input.terminal ? completedAt : null,
      })
      .where(eq(scans.id, input.scanId));
  });
}

export async function getScanForUser(
  db: Database,
  input: { userId: string; scanId: string },
): Promise<GetScanResponse> {
  const scan = await db.query.scans.findFirst({
    where: and(eq(scans.id, input.scanId), eq(scans.userId, input.userId)),
  });
  if (!scan) {
    throw new DatabaseCommandError("not_found", "Scan not found.");
  }

  const [attempt] = await db
    .select()
    .from(scanAttempts)
    .where(eq(scanAttempts.scanId, scan.id))
    .orderBy(
      desc(scanAttempts.attemptNumber),
      desc(scanAttempts.deliveryAttempt),
    )
    .limit(1);
  const candidates = attempt
    ? await db
        .select()
        .from(scanCandidates)
        .where(eq(scanCandidates.scanAttemptId, attempt.id))
        .orderBy(asc(scanCandidates.rank))
    : [];
  const images = await db
    .select({
      id: imageAssets.id,
      filename: imageAssets.filename,
      viewType: imageAssets.viewType,
      mimeType: imageAssets.mimeType,
    })
    .from(imageAssets)
    .where(eq(imageAssets.scanId, scan.id))
    .orderBy(asc(imageAssets.createdAt), asc(imageAssets.id));
  const confirmation = await getScanConfirmationForUser(db, input);

  return {
    scanId: scan.id,
    source: scan.source,
    status: scan.status,
    createdAt: scan.createdAt.toISOString(),
    submittedAt: scan.submittedAt?.toISOString() ?? null,
    completedAt: scan.completedAt?.toISOString() ?? null,
    images,
    attempt: attempt
      ? {
          attemptNumber: attempt.attemptNumber,
          deliveryAttempt: attempt.deliveryAttempt,
          status: attempt.status,
          model: attempt.model,
          promptVersion: attempt.promptVersion,
          startedAt: attempt.startedAt.toISOString(),
          completedAt: attempt.completedAt?.toISOString() ?? null,
          durationMs: attempt.durationMs,
          usage:
            attempt.inputTokens !== null &&
            attempt.outputTokens !== null &&
            attempt.totalTokens !== null
              ? {
                  inputTokens: attempt.inputTokens,
                  outputTokens: attempt.outputTokens,
                  totalTokens: attempt.totalTokens,
                }
              : null,
          error:
            attempt.errorCategory && attempt.errorMessage
              ? {
                  category: attempt.errorCategory,
                  message: attempt.errorMessage,
                }
              : null,
          observations: attempt.observations,
          needsReviewReasons: attempt.needsReviewReasons,
          outcomeReason: attempt.outcomeReason as ReviewOutcomeReason | null,
        }
      : null,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      rank: candidate.rank,
      artist: candidate.artist,
      title: candidate.title,
      releaseYear: candidate.releaseYear,
      label: candidate.label,
      catalogNumber: candidate.catalogNumber,
      barcode: candidate.barcode,
      confidence: candidate.confidence,
      evidence: candidate.evidence,
      warnings: candidate.warnings,
    })),
    confirmation,
  };
}
