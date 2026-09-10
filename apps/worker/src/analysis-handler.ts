import { AlbumIdentificationError, type AlbumIdentifier } from "@vinylhound/ai";
import {
  MAX_IMAGE_SIZE_BYTES,
  type AnalyzeScanJob,
} from "@vinylhound/contracts";
import {
  completeScanAnalysis,
  failScanAnalysis,
  prepareScanAnalysis,
  type Database,
} from "@vinylhound/database";
import { determineReviewOutcome } from "@vinylhound/domain";
import {
  StoredObjectNotFoundError,
  StoredObjectTooLargeError,
  type ObjectStorage,
} from "@vinylhound/storage";

export interface AnalyzeScanDelivery {
  jobId: string;
  deliveryAttempt: number;
  maxAttempts: number;
}

export interface ScanAnalysisHandlerOptions {
  database: Database;
  storage: ObjectStorage;
  identifier: AlbumIdentifier;
  configuredModel: string;
  promptVersion: string;
}

export function createScanAnalysisHandler(options: ScanAnalysisHandlerOptions) {
  return async (job: AnalyzeScanJob, delivery: AnalyzeScanDelivery) => {
    const prepared = await prepareScanAnalysis(options.database, {
      job,
      deliveryAttempt: delivery.deliveryAttempt,
      model: options.configuredModel,
      promptVersion: options.promptVersion,
    });
    if (
      prepared.status === "already_succeeded" ||
      prepared.status === "canceled"
    ) {
      return;
    }

    const startedAt = Date.now();
    let storageFetchDurationMs: number | null = null;
    let providerCallDurationMs: number | null = null;
    let response;
    try {
      const storageFetchStartedAt = Date.now();
      const images = await Promise.all(
        prepared.images.map(async (image) => {
          const stored = await options.storage.readObject(
            image.objectKey,
            MAX_IMAGE_SIZE_BYTES,
          );
          if (
            stored.contentType !== image.mimeType ||
            stored.sizeBytes !== image.sizeBytes
          ) {
            throw new AlbumIdentificationError(
              "invalid_image",
              false,
              "A stored image no longer matches its validated metadata.",
            );
          }
          return {
            url: `data:${image.mimeType};base64,${Buffer.from(stored.bytes).toString("base64")}`,
            viewType: image.viewType,
          };
        }),
      );
      storageFetchDurationMs = Date.now() - storageFetchStartedAt;

      const providerCallStartedAt = Date.now();
      response = await options.identifier.identify({
        scanId: job.scanId,
        images,
      });
      providerCallDurationMs = Date.now() - providerCallStartedAt;
    } catch (error) {
      const normalized = normalizeAnalysisError(error);
      const shouldRetry =
        normalized.retryable && delivery.deliveryAttempt < delivery.maxAttempts;
      const durationMs = Date.now() - startedAt;
      await failScanAnalysis(options.database, {
        scanId: job.scanId,
        attemptId: prepared.attemptId,
        category: normalized.category,
        message: normalized.message,
        durationMs,
        terminal: !shouldRetry,
      });
      console.info("[worker] scan_analysis_timing", {
        scanId: job.scanId,
        attemptId: prepared.attemptId,
        correlationId: job.correlationId,
        outcome: "failed",
        storageFetchDurationMs,
        providerCallDurationMs,
        durationMs,
      });
      if (shouldRetry) {
        throw normalized;
      }
      return;
    }

    const candidates = [...response.identification.candidates].sort(
      (left, right) => right.confidence - left.confidence,
    );
    const identification = {
      ...response.identification,
      candidates,
    };
    const outcome = determineReviewOutcome(
      candidates,
      identification.needsReviewReasons,
    );
    const durationMs = Date.now() - startedAt;
    await completeScanAnalysis(options.database, {
      scanId: job.scanId,
      attemptId: prepared.attemptId,
      identification,
      outcome,
      metadata: response.metadata,
      durationMs,
    });
    console.info("[worker] scan_analysis_timing", {
      scanId: job.scanId,
      attemptId: prepared.attemptId,
      correlationId: job.correlationId,
      outcome: outcome.status,
      storageFetchDurationMs,
      providerCallDurationMs,
      durationMs,
    });
  };
}

function normalizeAnalysisError(error: unknown): AlbumIdentificationError {
  if (error instanceof AlbumIdentificationError) {
    return error;
  }
  if (
    error instanceof StoredObjectNotFoundError ||
    error instanceof StoredObjectTooLargeError
  ) {
    return new AlbumIdentificationError(
      "invalid_image",
      false,
      "A validated scan image is no longer available for analysis.",
    );
  }
  return new AlbumIdentificationError(
    "unknown",
    false,
    "The scan analysis failed unexpectedly.",
  );
}
