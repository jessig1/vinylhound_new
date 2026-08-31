import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, isNull, lte, sql } from "drizzle-orm";

import {
  ANALYZE_SCAN_JOB,
  AnalyzeScanJobSchema,
  RETRYABLE_SCAN_STATUSES,
  MAX_SCANS_PER_BATCH,
  type AnalyzeScanJob,
  type ImageMimeType,
  type ImageViewType,
  type IngestionSource,
} from "@vinylhound/contracts";

import type { Database } from "./database.js";
import {
  batches,
  imageAssets,
  outboxMessages,
  scanAttempts,
  scans,
  users,
} from "./schema.js";

export type DatabaseCommandErrorCode =
  | "batch_scan_limit"
  | "conflict"
  | "invalid_state"
  | "not_found"
  | "scan_image_limit";

export class DatabaseCommandError extends Error {
  constructor(
    readonly code: DatabaseCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DatabaseCommandError";
  }
}

export async function ensureDevelopmentUser(db: Database, userId: string) {
  await db.insert(users).values({ id: userId }).onConflictDoNothing();
}

export async function getOrCreateUserIdByClerkId(
  db: Database,
  clerkUserId: string,
): Promise<string> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);
  if (existing[0]) {
    return existing[0].id;
  }

  await db
    .insert(users)
    .values({ clerkUserId })
    .onConflictDoNothing({ target: users.clerkUserId });

  const row = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);
  if (!row[0]) {
    throw new DatabaseCommandError(
      "conflict",
      "Failed to resolve or provision a user for the authenticated identity.",
    );
  }
  return row[0].id;
}

export type ImageObjectVariant = "original" | "analysis" | "thumbnail";

export function deriveImageObjectKey(
  input: { userId: string; scanId: string; imageId: string },
  variant: ImageObjectVariant,
): string {
  return `${input.userId}/${input.scanId}/${input.imageId}/${variant}`;
}

export async function createOrGetScan(
  db: Database,
  input: {
    userId: string;
    source: IngestionSource;
    idempotencyKey: string;
    batchId?: string;
  },
) {
  return db.transaction(async (transaction) => {
    if (input.batchId) {
      const [batch] = await transaction
        .select({ id: batches.id })
        .from(batches)
        .where(
          and(eq(batches.id, input.batchId), eq(batches.userId, input.userId)),
        )
        .for("update");
      if (!batch) {
        throw new DatabaseCommandError("not_found", "Batch not found.");
      }

      const existing = await transaction.query.scans.findFirst({
        where: and(
          eq(scans.userId, input.userId),
          eq(scans.idempotencyKey, input.idempotencyKey),
        ),
      });
      if (existing) {
        if (
          existing.source !== input.source ||
          existing.batchId !== input.batchId
        ) {
          throw new DatabaseCommandError(
            "conflict",
            "That idempotency key was already used with different scan data.",
          );
        }
        return { record: existing, created: false } as const;
      }

      const [{ value: batchScanCount }] = await transaction
        .select({ value: count() })
        .from(scans)
        .where(eq(scans.batchId, input.batchId));
      if (batchScanCount >= MAX_SCANS_PER_BATCH) {
        throw new DatabaseCommandError(
          "batch_scan_limit",
          `A batch cannot contain more than ${MAX_SCANS_PER_BATCH} scans.`,
        );
      }
    }

    const [created] = await transaction
      .insert(scans)
      .values({
        userId: input.userId,
        source: input.source,
        idempotencyKey: input.idempotencyKey,
        batchId: input.batchId ?? null,
      })
      .onConflictDoNothing({
        target: [scans.userId, scans.idempotencyKey],
      })
      .returning();

    if (created) {
      return { record: created, created: true } as const;
    }

    const existing = await transaction.query.scans.findFirst({
      where: and(
        eq(scans.userId, input.userId),
        eq(scans.idempotencyKey, input.idempotencyKey),
      ),
    });

    if (!existing) {
      throw new DatabaseCommandError(
        "conflict",
        "The scan idempotency key could not be resolved.",
      );
    }
    if (
      existing.source !== input.source ||
      existing.batchId !== (input.batchId ?? null)
    ) {
      throw new DatabaseCommandError(
        "conflict",
        "That idempotency key was already used with different scan data.",
      );
    }

    return { record: existing, created: false } as const;
  });
}

export interface CreateImageUploadInput {
  userId: string;
  scanId: string;
  idempotencyKey: string;
  filename: string;
  viewType?: ImageViewType;
  mimeType: ImageMimeType;
  sizeBytes: number;
  checksumSha256: string;
  maxImages: number;
}

export async function createOrGetImageUpload(
  db: Database,
  input: CreateImageUploadInput,
) {
  return db.transaction(async (transaction) => {
    const viewType = input.viewType ?? "front";
    const [scan] = await transaction
      .select({ id: scans.id, status: scans.status })
      .from(scans)
      .where(and(eq(scans.id, input.scanId), eq(scans.userId, input.userId)))
      .for("update");

    if (!scan) {
      throw new DatabaseCommandError("not_found", "Scan not found.");
    }
    if (scan.status !== "awaiting_upload") {
      throw new DatabaseCommandError(
        "invalid_state",
        "Images can only be added while a scan is awaiting upload.",
      );
    }

    const existing = await transaction.query.imageAssets.findFirst({
      where: and(
        eq(imageAssets.scanId, input.scanId),
        eq(imageAssets.idempotencyKey, input.idempotencyKey),
      ),
    });

    if (existing) {
      if (
        existing.filename !== input.filename ||
        existing.viewType !== viewType ||
        existing.mimeType !== input.mimeType ||
        existing.sizeBytes !== input.sizeBytes ||
        existing.checksumSha256 !== input.checksumSha256
      ) {
        throw new DatabaseCommandError(
          "conflict",
          "That idempotency key was already used with different image data.",
        );
      }
      return { record: existing, created: false } as const;
    }

    const [{ value: imageCount }] = await transaction
      .select({ value: count() })
      .from(imageAssets)
      .where(eq(imageAssets.scanId, input.scanId));

    if (imageCount >= input.maxImages) {
      throw new DatabaseCommandError(
        "scan_image_limit",
        `A scan cannot contain more than ${input.maxImages} images.`,
      );
    }

    const imageId = randomUUID();
    const [record] = await transaction
      .insert(imageAssets)
      .values({
        id: imageId,
        scanId: input.scanId,
        idempotencyKey: input.idempotencyKey,
        objectKey: deriveImageObjectKey(
          { userId: input.userId, scanId: input.scanId, imageId },
          "original",
        ),
        filename: input.filename,
        viewType,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        checksumSha256: input.checksumSha256,
      })
      .returning();

    return { record: record!, created: true } as const;
  });
}

export async function getImageUploadForUser(
  db: Database,
  input: { userId: string; scanId: string; imageId: string },
) {
  const [result] = await db
    .select({ image: imageAssets })
    .from(imageAssets)
    .innerJoin(scans, eq(scans.id, imageAssets.scanId))
    .where(
      and(
        eq(imageAssets.id, input.imageId),
        eq(imageAssets.scanId, input.scanId),
        eq(scans.userId, input.userId),
      ),
    );

  if (!result) {
    throw new DatabaseCommandError("not_found", "Image upload not found.");
  }
  return result.image;
}

export async function completeImageUpload(
  db: Database,
  input: {
    userId: string;
    scanId: string;
    imageId: string;
    width: number;
    height: number;
    analysisSizeBytes: number;
    analysisWidth: number;
    analysisHeight: number;
    thumbnailSizeBytes: number;
  },
) {
  const existing = await getImageUploadForUser(db, input);
  if (existing.completedAt) {
    return existing;
  }

  const [completed] = await db
    .update(imageAssets)
    .set({
      completedAt: new Date(),
      width: input.width,
      height: input.height,
      analysisSizeBytes: input.analysisSizeBytes,
      analysisWidth: input.analysisWidth,
      analysisHeight: input.analysisHeight,
      thumbnailSizeBytes: input.thumbnailSizeBytes,
    })
    .where(
      and(
        eq(imageAssets.id, input.imageId),
        eq(imageAssets.scanId, input.scanId),
      ),
    )
    .returning();

  return completed!;
}

const INITIAL_SCAN_ATTEMPT = 1;

function analyzeScanJobId(scanId: string, attemptNumber: number) {
  return `scan-${scanId}-attempt-${attemptNumber}`;
}

export async function submitScan(
  db: Database,
  input: { userId: string; scanId: string; idempotencyKey: string },
) {
  return db.transaction(async (transaction) => {
    const [scan] = await transaction
      .select()
      .from(scans)
      .where(and(eq(scans.id, input.scanId), eq(scans.userId, input.userId)))
      .for("update");

    if (!scan) {
      throw new DatabaseCommandError("not_found", "Scan not found.");
    }

    if (scan.submitIdempotencyKey !== null) {
      if (scan.submitIdempotencyKey !== input.idempotencyKey) {
        throw new DatabaseCommandError(
          "conflict",
          "That scan was already submitted with a different idempotency key.",
        );
      }

      const existing = await transaction.query.outboxMessages.findFirst({
        where: and(
          eq(outboxMessages.aggregateId, scan.id),
          eq(outboxMessages.topic, ANALYZE_SCAN_JOB),
          eq(outboxMessages.attemptNumber, INITIAL_SCAN_ATTEMPT),
        ),
      });
      if (!existing) {
        throw new DatabaseCommandError(
          "invalid_state",
          "The submitted scan is missing its durable queue message.",
        );
      }

      return {
        record: scan,
        job: AnalyzeScanJobSchema.parse(existing.payload),
        jobId: existing.idempotencyKey,
        created: false,
      } as const;
    }

    if (scan.status !== "awaiting_upload") {
      throw new DatabaseCommandError(
        "invalid_state",
        "Only a scan awaiting upload can be submitted.",
      );
    }

    const images = await transaction
      .select({ id: imageAssets.id, completedAt: imageAssets.completedAt })
      .from(imageAssets)
      .where(eq(imageAssets.scanId, scan.id))
      .orderBy(asc(imageAssets.createdAt), asc(imageAssets.id));

    if (images.length === 0) {
      throw new DatabaseCommandError(
        "invalid_state",
        "Upload and complete at least one image before submitting the scan.",
      );
    }
    if (images.some((image) => image.completedAt === null)) {
      throw new DatabaseCommandError(
        "invalid_state",
        "All registered images must finish uploading before submission.",
      );
    }

    const submittedAt = new Date();
    const job = AnalyzeScanJobSchema.parse({
      jobVersion: 1,
      scanId: scan.id,
      userId: scan.userId,
      attemptNumber: INITIAL_SCAN_ATTEMPT,
      imageIds: images.map((image) => image.id),
      requestedAt: submittedAt.toISOString(),
    });
    const jobId = analyzeScanJobId(scan.id, INITIAL_SCAN_ATTEMPT);

    await transaction.insert(outboxMessages).values({
      topic: ANALYZE_SCAN_JOB,
      aggregateId: scan.id,
      attemptNumber: INITIAL_SCAN_ATTEMPT,
      idempotencyKey: jobId,
      payload: job,
    });

    const [updated] = await transaction
      .update(scans)
      .set({
        status: "queued",
        submitIdempotencyKey: input.idempotencyKey,
        submittedAt,
        updatedAt: submittedAt,
      })
      .where(eq(scans.id, scan.id))
      .returning();

    return { record: updated!, job, jobId, created: true } as const;
  });
}

export async function retryScan(
  db: Database,
  input: { userId: string; scanId: string },
) {
  return db.transaction(async (transaction) => {
    const [scan] = await transaction
      .select()
      .from(scans)
      .where(and(eq(scans.id, input.scanId), eq(scans.userId, input.userId)))
      .for("update");

    if (!scan) {
      throw new DatabaseCommandError("not_found", "Scan not found.");
    }

    const retryableStatuses: readonly string[] = RETRYABLE_SCAN_STATUSES;
    if (!retryableStatuses.includes(scan.status)) {
      if (scan.status === "queued" || scan.status === "processing") {
        const [latestOutboxMessage] = await transaction
          .select()
          .from(outboxMessages)
          .where(
            and(
              eq(outboxMessages.aggregateId, scan.id),
              eq(outboxMessages.topic, ANALYZE_SCAN_JOB),
            ),
          )
          .orderBy(desc(outboxMessages.attemptNumber))
          .limit(1);
        if (latestOutboxMessage) {
          return {
            record: scan,
            job: AnalyzeScanJobSchema.parse(latestOutboxMessage.payload),
            jobId: latestOutboxMessage.idempotencyKey,
            created: false,
          } as const;
        }
      }
      throw new DatabaseCommandError(
        "invalid_state",
        `A scan in ${scan.status} state cannot be retried.`,
      );
    }

    const [latestAttempt] = await transaction
      .select({ attemptNumber: scanAttempts.attemptNumber })
      .from(scanAttempts)
      .where(eq(scanAttempts.scanId, scan.id))
      .orderBy(desc(scanAttempts.attemptNumber))
      .limit(1);
    const nextAttemptNumber = (latestAttempt?.attemptNumber ?? 0) + 1;

    const images = await transaction
      .select({ id: imageAssets.id, completedAt: imageAssets.completedAt })
      .from(imageAssets)
      .where(eq(imageAssets.scanId, scan.id))
      .orderBy(asc(imageAssets.createdAt), asc(imageAssets.id));
    if (images.length === 0 || images.some((image) => !image.completedAt)) {
      throw new DatabaseCommandError(
        "invalid_state",
        "The scan is missing completed images to retry.",
      );
    }

    const requestedAt = new Date();
    const job = AnalyzeScanJobSchema.parse({
      jobVersion: 1,
      scanId: scan.id,
      userId: scan.userId,
      attemptNumber: nextAttemptNumber,
      imageIds: images.map((image) => image.id),
      requestedAt: requestedAt.toISOString(),
    });
    const jobId = analyzeScanJobId(scan.id, nextAttemptNumber);

    await transaction.insert(outboxMessages).values({
      topic: ANALYZE_SCAN_JOB,
      aggregateId: scan.id,
      attemptNumber: nextAttemptNumber,
      idempotencyKey: jobId,
      payload: job,
    });

    const [updated] = await transaction
      .update(scans)
      .set({
        status: "queued",
        updatedAt: requestedAt,
        completedAt: null,
      })
      .where(eq(scans.id, scan.id))
      .returning();

    return { record: updated!, job, jobId, created: true } as const;
  });
}

export async function cancelScan(
  db: Database,
  input: { userId: string; scanId: string },
) {
  return db.transaction(async (transaction) => {
    const [scan] = await transaction
      .select()
      .from(scans)
      .where(and(eq(scans.id, input.scanId), eq(scans.userId, input.userId)))
      .for("update");

    if (!scan) {
      throw new DatabaseCommandError("not_found", "Scan not found.");
    }
    if (scan.status === "canceled") {
      return { record: scan, created: false } as const;
    }
    if (
      scan.status !== "awaiting_upload" &&
      scan.status !== "queued" &&
      scan.status !== "processing"
    ) {
      throw new DatabaseCommandError(
        "invalid_state",
        `A scan in ${scan.status} state cannot be canceled.`,
      );
    }

    const canceledAt = new Date();
    const [updated] = await transaction
      .update(scans)
      .set({
        status: "canceled",
        updatedAt: canceledAt,
        completedAt: canceledAt,
      })
      .where(eq(scans.id, scan.id))
      .returning();

    return { record: updated!, created: true } as const;
  });
}

export async function createOrGetBatch(
  db: Database,
  input: { userId: string; idempotencyKey: string },
) {
  const [created] = await db
    .insert(batches)
    .values(input)
    .onConflictDoNothing({
      target: [batches.userId, batches.idempotencyKey],
    })
    .returning();

  if (created) {
    return { record: created, created: true } as const;
  }

  const existing = await db.query.batches.findFirst({
    where: and(
      eq(batches.userId, input.userId),
      eq(batches.idempotencyKey, input.idempotencyKey),
    ),
  });
  if (!existing) {
    throw new DatabaseCommandError(
      "conflict",
      "The batch idempotency key could not be resolved.",
    );
  }

  return { record: existing, created: false } as const;
}

export async function getBatchForUser(
  db: Database,
  input: { userId: string; batchId: string },
) {
  const batch = await db.query.batches.findFirst({
    where: and(eq(batches.id, input.batchId), eq(batches.userId, input.userId)),
  });
  if (!batch) {
    throw new DatabaseCommandError("not_found", "Batch not found.");
  }

  const batchScans = await db
    .select({ id: scans.id })
    .from(scans)
    .where(eq(scans.batchId, batch.id))
    .orderBy(asc(scans.createdAt), asc(scans.id));

  return { batch, scanIds: batchScans.map((scan) => scan.id) };
}

export type OutboxDispatchResult =
  | { status: "idle" }
  | { status: "published"; messageId: string; jobId: string }
  | { status: "deferred"; messageId: string; jobId: string }
  | { status: "canceled"; messageId: string; jobId: string };

export async function dispatchNextOutboxMessage(
  db: Database,
  publish: (job: AnalyzeScanJob, idempotencyKey: string) => Promise<void>,
  now = new Date(),
): Promise<OutboxDispatchResult> {
  return db.transaction(async (transaction) => {
    const [message] = await transaction
      .select()
      .from(outboxMessages)
      .where(
        and(
          isNull(outboxMessages.publishedAt),
          lte(outboxMessages.availableAt, now),
        ),
      )
      .orderBy(asc(outboxMessages.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!message) {
      return { status: "idle" };
    }

    const [owningScan] = await transaction
      .select({ status: scans.status })
      .from(scans)
      .where(eq(scans.id, message.aggregateId));
    if (owningScan?.status === "canceled") {
      await transaction
        .update(outboxMessages)
        .set({
          publishAttempts: sql`${outboxMessages.publishAttempts} + 1`,
          publishedAt: now,
          lastError: "Skipped: the owning scan was canceled.",
        })
        .where(eq(outboxMessages.id, message.id));
      return {
        status: "canceled",
        messageId: message.id,
        jobId: message.idempotencyKey,
      };
    }

    const nextAttempt = message.publishAttempts + 1;
    try {
      const job = AnalyzeScanJobSchema.parse(message.payload);
      await publish(job, message.idempotencyKey);
    } catch {
      const delayMs = Math.min(2 ** Math.min(nextAttempt, 6) * 1_000, 60_000);
      await transaction
        .update(outboxMessages)
        .set({
          publishAttempts: sql`${outboxMessages.publishAttempts} + 1`,
          availableAt: new Date(now.getTime() + delayMs),
          lastError: "Queue publication failed.",
        })
        .where(eq(outboxMessages.id, message.id));
      return {
        status: "deferred",
        messageId: message.id,
        jobId: message.idempotencyKey,
      };
    }

    await transaction
      .update(outboxMessages)
      .set({
        publishAttempts: sql`${outboxMessages.publishAttempts} + 1`,
        publishedAt: now,
        lastError: null,
      })
      .where(eq(outboxMessages.id, message.id));

    return {
      status: "published",
      messageId: message.id,
      jobId: message.idempotencyKey,
    };
  });
}
