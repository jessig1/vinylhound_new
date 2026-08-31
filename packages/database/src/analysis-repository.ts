import { and, asc, desc, eq, gte, isNotNull, lt } from "drizzle-orm";

import type {
  AlbumIdentification,
  AnalyzeScanJob,
  GetScanResponse,
  ProviderErrorCategory,
  ReviewOutcomeReason,
} from "@vinylhound/contracts";
import { estimateTokenUsageCostUsd } from "@vinylhound/domain";

import type { Database } from "./database.js";
import { getScanConfirmationForUser } from "./confirmation-repository.js";
import {
  DatabaseCommandError,
  deriveImageObjectKey,
} from "./scan-repository.js";
import { imageAssets, scanAttempts, scanCandidates, scans } from "./schema.js";

export interface PrepareScanAnalysisInput {
  job: AnalyzeScanJob;
  deliveryAttempt: number;
  model: string;
  promptVersion: string;
}

export type PrepareScanAnalysisResult =
  | { status: "already_succeeded" }
  | { status: "canceled" }
  | {
      status: "ready";
      attemptId: string;
      images: Array<{
        id: string;
        objectKey: string;
        viewType:
          "front" | "back" | "spine" | "label" | "barcode" | "runout" | "other";
        mimeType: "image/jpeg";
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

    if (scan.status === "canceled") {
      return { status: "canceled" };
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
        analysisSizeBytes: imageAssets.analysisSizeBytes,
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
        objectKey: deriveImageObjectKey(
          { userId: scan.userId, scanId: scan.id, imageId: image!.id },
          "analysis",
        ),
        viewType: image!.viewType,
        mimeType: "image/jpeg" as const,
        sizeBytes: image!.analysisSizeBytes!,
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
    batchId: scan.batchId,
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
    candidates: candidates.map(toCandidateResult),
    confirmation,
  };
}

function toCandidateResult(candidate: typeof scanCandidates.$inferSelect) {
  return {
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
  };
}

async function getTopCandidateForScan(db: Database, scanId: string) {
  const [attempt] = await db
    .select({ id: scanAttempts.id })
    .from(scanAttempts)
    .where(
      and(
        eq(scanAttempts.scanId, scanId),
        eq(scanAttempts.status, "succeeded"),
      ),
    )
    .orderBy(
      desc(scanAttempts.attemptNumber),
      desc(scanAttempts.deliveryAttempt),
    )
    .limit(1);
  if (!attempt) {
    return null;
  }

  const [candidate] = await db
    .select()
    .from(scanCandidates)
    .where(eq(scanCandidates.scanAttemptId, attempt.id))
    .orderBy(asc(scanCandidates.rank))
    .limit(1);
  return candidate ? toCandidateResult(candidate) : null;
}

export async function listScanSummariesForUser(
  db: Database,
  input: { userId: string; scanIds: readonly string[] },
) {
  const summaries = await Promise.all(
    input.scanIds.map(async (scanId) => {
      const scan = await db.query.scans.findFirst({
        where: and(eq(scans.id, scanId), eq(scans.userId, input.userId)),
      });
      if (!scan) {
        throw new DatabaseCommandError("not_found", "Scan not found.");
      }
      return {
        scanId: scan.id,
        batchId: scan.batchId,
        status: scan.status,
        createdAt: scan.createdAt.toISOString(),
        completedAt: scan.completedAt?.toISOString() ?? null,
        topCandidate: await getTopCandidateForScan(db, scan.id),
      };
    }),
  );
  return summaries;
}

export async function listScansForUser(
  db: Database,
  input: { userId: string; limit: number; before?: Date },
) {
  const rows = await db
    .select({ id: scans.id, createdAt: scans.createdAt })
    .from(scans)
    .where(
      input.before
        ? and(eq(scans.userId, input.userId), lt(scans.createdAt, input.before))
        : eq(scans.userId, input.userId),
    )
    .orderBy(desc(scans.createdAt), desc(scans.id))
    .limit(input.limit);

  const summaries = await listScanSummariesForUser(db, {
    userId: input.userId,
    scanIds: rows.map((row) => row.id),
  });
  const last = rows.at(-1);
  return {
    summaries,
    nextCursor: rows.length === input.limit && last ? last.createdAt : null,
  };
}

export interface UsageCostSummary {
  attemptCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  averageDurationMs: number | null;
}

function summarizeAttemptUsage(
  attempts: readonly {
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    durationMs: number | null;
  }[],
): UsageCostSummary {
  const priced = attempts.flatMap((attempt) => {
    const cost = estimateTokenUsageCostUsd(attempt.model, {
      inputTokens: attempt.inputTokens!,
      outputTokens: attempt.outputTokens!,
    });
    return cost === null ? [] : [cost];
  });
  const durations = attempts.flatMap((attempt) =>
    attempt.durationMs === null ? [] : [attempt.durationMs],
  );

  return {
    attemptCount: attempts.length,
    totalInputTokens: sumOrZero(attempts.map((a) => a.inputTokens)),
    totalOutputTokens: sumOrZero(attempts.map((a) => a.outputTokens)),
    totalTokens: sumOrZero(attempts.map((a) => a.totalTokens)),
    estimatedCostUsd: priced.length > 0 ? sumOrZero(priced) : null,
    averageDurationMs:
      durations.length > 0
        ? Math.round(sumOrZero(durations) / durations.length)
        : null,
  };
}

function sumOrZero(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

export async function getBatchCostSummary(
  db: Database,
  input: { batchId: string; scanIds: readonly string[] },
): Promise<UsageCostSummary> {
  if (input.scanIds.length === 0) {
    return summarizeAttemptUsage([]);
  }
  const attempts = await db
    .select({
      model: scanAttempts.model,
      inputTokens: scanAttempts.inputTokens,
      outputTokens: scanAttempts.outputTokens,
      totalTokens: scanAttempts.totalTokens,
      durationMs: scanAttempts.durationMs,
    })
    .from(scanAttempts)
    .innerJoin(scans, eq(scans.id, scanAttempts.scanId))
    .where(
      and(
        eq(scans.batchId, input.batchId),
        isNotNull(scanAttempts.inputTokens),
      ),
    );
  return summarizeAttemptUsage(attempts);
}

export interface UsageSummaryOutcomeCounts {
  identified: number;
  needsReview: number;
  unresolved: number;
  failed: number;
  canceled: number;
  inProgress: number;
}

export interface UsageSummary {
  scanCount: number;
  outcomes: UsageSummaryOutcomeCounts;
  cost: UsageCostSummary;
}

export async function getUsageSummaryForUser(
  db: Database,
  input: { userId: string; since: Date },
): Promise<UsageSummary> {
  const scanRows = await db
    .select({ status: scans.status })
    .from(scans)
    .where(
      and(eq(scans.userId, input.userId), gte(scans.createdAt, input.since)),
    );

  const outcomes: UsageSummaryOutcomeCounts = {
    identified: 0,
    needsReview: 0,
    unresolved: 0,
    failed: 0,
    canceled: 0,
    inProgress: 0,
  };
  for (const scan of scanRows) {
    switch (scan.status) {
      case "identified":
        outcomes.identified += 1;
        break;
      case "needs_review":
        outcomes.needsReview += 1;
        break;
      case "unresolved":
        outcomes.unresolved += 1;
        break;
      case "failed":
        outcomes.failed += 1;
        break;
      case "canceled":
        outcomes.canceled += 1;
        break;
      default:
        outcomes.inProgress += 1;
        break;
    }
  }

  const attempts = await db
    .select({
      model: scanAttempts.model,
      inputTokens: scanAttempts.inputTokens,
      outputTokens: scanAttempts.outputTokens,
      totalTokens: scanAttempts.totalTokens,
      durationMs: scanAttempts.durationMs,
    })
    .from(scanAttempts)
    .innerJoin(scans, eq(scans.id, scanAttempts.scanId))
    .where(
      and(
        eq(scans.userId, input.userId),
        gte(scans.createdAt, input.since),
        isNotNull(scanAttempts.inputTokens),
      ),
    );

  return {
    scanCount: scanRows.length,
    outcomes,
    cost: summarizeAttemptUsage(attempts),
  };
}
