import { and, desc, eq, sql } from "drizzle-orm";

import {
  SCAN_CONFIRMED_EVENT,
  ScanConfirmedEventSchema,
  type ConfirmScanRequest,
  type ConfirmScanResponse,
  type ConfirmationCompletedEvent,
  type ScanConfirmationSummary,
} from "@vinylhound/contracts";
import type { Database } from "./database.ts";
import { hashJson, serializeCopy } from "./release-resolution.ts";
import { DatabaseCommandError } from "./scan-repository.ts";
import {
  albums,
  libraryCopies,
  libraryItems,
  outboxMessages,
  releases,
  scanAttempts,
  scanCandidates,
  scanConfirmations,
  scans,
} from "./schema.ts";

const SCAN_CONFIRMATION_AGGREGATE_TYPE = "scan_confirmation";

/**
 * The dedupe key for the `scan.confirmed.v1` outbox row and (derived again,
 * identically, by `processScanConfirmation`) the `confirmation_receipts` row
 * it produces. Composed from both the scan and the request's own idempotency
 * key -- not the scan alone -- because ADR-0018 lets one scan be confirmed,
 * completed, its item removed, and reconfirmed more than once over its
 * lifetime; a scan-only key would collide with the first confirmation's
 * still-present outbox/receipt row on the second. Not the raw request key
 * alone either: that is only guaranteed unique per user
 * (`scan_confirmations_user_idempotency_unique`), and these two tables key
 * globally.
 */
export function confirmationEventId(scanId: string, idempotencyKey: string) {
  return `confirmation-${scanId}-${idempotencyKey}`;
}

/**
 * P4.2 Task 3 (ADR-0028, superseding ADR-0005): this transaction records the
 * reviewed confirmation and enqueues a `scan.confirmed.v1` event -- it no
 * longer resolves a release or writes `library_items`/`library_copies`
 * itself. That work happens in a separate "core" transaction
 * (`processScanConfirmation`, `confirmation-processing-repository.ts`), whose
 * result is projected back onto this row by `applyConfirmationCompletion`
 * below once its own `confirmation.completed.v1` event is delivered.
 */
export async function confirmScan(
  db: Database,
  input: {
    userId: string;
    scanId: string;
    idempotencyKey: string;
    confirmation: ConfirmScanRequest;
  },
): Promise<{ record: ConfirmScanResponse; created: boolean }> {
  const requestFingerprint = hashJson([
    input.scanId,
    input.confirmation.selectedCandidateId,
    input.confirmation.artist,
    input.confirmation.title,
    input.confirmation.releaseYear,
    input.confirmation.label,
    input.confirmation.catalogNumber,
    input.confirmation.barcode,
    input.confirmation.releaseDate,
    input.confirmation.country,
    input.confirmation.format,
    input.confirmation.packaging,
    input.confirmation.releaseStatus,
    input.confirmation.catalogReference,
    input.confirmation.list,
    input.confirmation.notes,
    input.confirmation.copy,
  ]);

  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(${input.userId}),
        hashtext(${input.idempotencyKey})
      )`,
    );
    const reusedIdempotencyKey =
      await transaction.query.scanConfirmations.findFirst({
        where: and(
          eq(scanConfirmations.userId, input.userId),
          eq(scanConfirmations.idempotencyKey, input.idempotencyKey),
        ),
      });
    if (reusedIdempotencyKey?.scanId !== undefined) {
      if (reusedIdempotencyKey.scanId !== input.scanId) {
        throw new DatabaseCommandError(
          "conflict",
          "That idempotency key was already used for another scan.",
        );
      }
    }

    const [scan] = await transaction
      .select()
      .from(scans)
      .where(and(eq(scans.id, input.scanId), eq(scans.userId, input.userId)))
      .for("update");
    if (!scan) {
      throw new DatabaseCommandError("not_found", "Scan not found.");
    }

    const existingConfirmation =
      await transaction.query.scanConfirmations.findFirst({
        where: eq(scanConfirmations.scanId, scan.id),
      });
    if (
      existingConfirmation &&
      existingConfirmation.status === "completed" &&
      existingConfirmation.libraryItemId === null
    ) {
      // The saved record this decision produced was removed (ADR-0018), so the
      // decision no longer describes anything in the library and must not block
      // saving the scan again. Replacing it leaves the image/attempt/candidate
      // audit trail untouched; only the superseded review decision is dropped.
      // A `pending` confirmation also has libraryItemId === null, but must
      // never take this branch -- the `status === "completed"` guard above is
      // what tells the two apart.
      await transaction
        .delete(scanConfirmations)
        .where(eq(scanConfirmations.scanId, scan.id));
    } else if (existingConfirmation) {
      if (
        existingConfirmation.idempotencyKey !== input.idempotencyKey ||
        existingConfirmation.requestFingerprint !== requestFingerprint
      ) {
        throw new DatabaseCommandError(
          "conflict",
          "This scan was already confirmed with different data.",
        );
      }
      return {
        record: await readConfirmationResponse(
          transaction,
          input.userId,
          scan.id,
        ),
        created: false,
      };
    }

    if (
      scan.status !== "identified" &&
      scan.status !== "needs_review" &&
      scan.status !== "unresolved"
    ) {
      throw new DatabaseCommandError(
        "invalid_state",
        `A scan in ${scan.status} state cannot be confirmed.`,
      );
    }

    const [latestAttempt] = await transaction
      .select({ id: scanAttempts.id })
      .from(scanAttempts)
      .where(
        and(
          eq(scanAttempts.scanId, scan.id),
          eq(scanAttempts.status, "succeeded"),
        ),
      )
      .orderBy(
        desc(scanAttempts.attemptNumber),
        desc(scanAttempts.deliveryAttempt),
      )
      .limit(1);
    if (!latestAttempt) {
      throw new DatabaseCommandError(
        "invalid_state",
        "The scan has no successful result to review.",
      );
    }

    if (input.confirmation.selectedCandidateId) {
      const candidate = await transaction.query.scanCandidates.findFirst({
        where: and(
          eq(scanCandidates.id, input.confirmation.selectedCandidateId),
          eq(scanCandidates.scanAttemptId, latestAttempt.id),
        ),
      });
      if (!candidate) {
        throw new DatabaseCommandError(
          "invalid_state",
          "The selected candidate does not belong to the latest scan result.",
        );
      }
    }

    const now = new Date();
    const confirmedAt = now.toISOString();
    const reviewedRelease = {
      artist: input.confirmation.artist,
      title: input.confirmation.title,
      releaseYear: input.confirmation.releaseYear,
      label: input.confirmation.label,
      catalogNumber: input.confirmation.catalogNumber,
      barcode: input.confirmation.barcode,
      releaseDate: input.confirmation.releaseDate,
      country: input.confirmation.country,
      format: input.confirmation.format,
      packaging: input.confirmation.packaging,
      releaseStatus: input.confirmation.releaseStatus,
      catalogReference: input.confirmation.catalogReference,
      list: input.confirmation.list,
      notes: input.confirmation.notes,
      copy: input.confirmation.copy,
    };

    const [confirmation] = await transaction
      .insert(scanConfirmations)
      .values({
        scanId: scan.id,
        userId: input.userId,
        selectedCandidateId: input.confirmation.selectedCandidateId,
        releaseId: null,
        libraryItemId: null,
        copyId: null,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        reviewedRelease,
        status: "pending",
        confirmedAt: now,
        completedAt: null,
      })
      .returning();

    const event = ScanConfirmedEventSchema.parse({
      eventVersion: 1,
      scanId: scan.id,
      userId: input.userId,
      selectedCandidateId: input.confirmation.selectedCandidateId,
      ...reviewedRelease,
      idempotencyKey: input.idempotencyKey,
      confirmedAt,
    });

    await transaction.insert(outboxMessages).values({
      topic: SCAN_CONFIRMED_EVENT,
      aggregateType: SCAN_CONFIRMATION_AGGREGATE_TYPE,
      aggregateId: scan.id,
      idempotencyKey: confirmationEventId(scan.id, input.idempotencyKey),
      payload: event,
      correlationId: null,
    });

    return {
      created: true,
      record: {
        scanId: scan.id,
        selectedCandidateId: confirmation!.selectedCandidateId,
        release: null,
        libraryItem: null,
        status: "pending",
        confirmedAt,
        completedAt: null,
      },
    };
  });
}

/**
 * Projects a delivered `confirmation.completed.v1` event onto its
 * `scan_confirmations` row -- "scan consumes completion into a projection"
 * (P4.2 Task 3). Idempotent: a redelivery after the row is already
 * `completed` is a silent no-op, and a missing row (should not happen; see
 * ADR-0028's noted Task 6 gap) is a defensive no-op rather than a throw, since
 * this runs from a queue consumer with no request to fail back to.
 *
 * Returns the confirmation-to-library latency (P4.2 Task 5, ADR-0028): the
 * gap between `confirmedAt` -- set by `confirmScan`'s own transaction, hop
 * 1's write -- and `payload.completedAt` -- set by `processScanConfirmation`
 * the moment `library_items`/`library_copies` became durable, hop 2's write.
 * This is the exact latency Task 5's target bounds, and it already includes
 * both the hop-1 outbox dispatch pickup delay and hop 2's own processing
 * time, not just the projection step running here. Null on the no-op paths
 * above, since there is no completion to measure.
 */
export async function applyConfirmationCompletion(
  db: Database,
  payload: ConfirmationCompletedEvent,
): Promise<{ latencyMs: number } | null> {
  const [updated] = await db
    .update(scanConfirmations)
    .set({
      status: "completed",
      releaseId: payload.releaseId,
      libraryItemId: payload.libraryItemId,
      copyId: payload.copyId,
      completedAt: new Date(payload.completedAt),
    })
    .where(
      and(
        eq(scanConfirmations.scanId, payload.scanId),
        eq(scanConfirmations.idempotencyKey, payload.idempotencyKey),
        eq(scanConfirmations.status, "pending"),
      ),
    )
    .returning({ confirmedAt: scanConfirmations.confirmedAt });

  if (!updated) {
    return null;
  }
  return {
    latencyMs:
      new Date(payload.completedAt).getTime() - updated.confirmedAt.getTime(),
  };
}

export async function getScanConfirmationForUser(
  db: Database,
  input: { userId: string; scanId: string },
): Promise<ScanConfirmationSummary | null> {
  const confirmation = await db.query.scanConfirmations.findFirst({
    where: and(
      eq(scanConfirmations.scanId, input.scanId),
      eq(scanConfirmations.userId, input.userId),
    ),
  });
  // A completed confirmation whose library item was removed (ADR-0018)
  // describes nothing the user still holds, so the scan reads as unconfirmed
  // and reviewable again. A `pending` confirmation also has a null
  // libraryItemId, but must still be reported (its own branch below), not
  // treated as unconfirmed.
  if (
    !confirmation ||
    (confirmation.status === "completed" && confirmation.libraryItemId === null)
  ) {
    return null;
  }

  const response = await readConfirmationResponse(
    db,
    input.userId,
    input.scanId,
  );
  return {
    selectedCandidateId: response.selectedCandidateId,
    release: response.release,
    libraryItem: response.libraryItem,
    status: response.status,
    confirmedAt: response.confirmedAt,
    completedAt: response.completedAt,
  };
}

async function readConfirmationResponse(
  db: Pick<Database, "query">,
  userId: string,
  scanId: string,
): Promise<ConfirmScanResponse> {
  const confirmation = await db.query.scanConfirmations.findFirst({
    where: and(
      eq(scanConfirmations.scanId, scanId),
      eq(scanConfirmations.userId, userId),
    ),
  });
  if (!confirmation) {
    throw new DatabaseCommandError("not_found", "Scan confirmation not found.");
  }

  if (confirmation.status === "pending") {
    return {
      scanId,
      selectedCandidateId: confirmation.selectedCandidateId,
      release: null,
      libraryItem: null,
      status: "pending",
      confirmedAt: confirmation.confirmedAt.toISOString(),
      completedAt: null,
    };
  }

  const release = confirmation.releaseId
    ? await db.query.releases.findFirst({
        where: eq(releases.id, confirmation.releaseId),
      })
    : null;
  const album = release
    ? await db.query.albums.findFirst({ where: eq(albums.id, release.albumId) })
    : null;
  const libraryItem = confirmation.libraryItemId
    ? await db.query.libraryItems.findFirst({
        where: and(
          eq(libraryItems.id, confirmation.libraryItemId),
          eq(libraryItems.userId, userId),
        ),
      })
    : null;
  const copy = confirmation.copyId
    ? await db.query.libraryCopies.findFirst({
        where: and(
          eq(libraryCopies.id, confirmation.copyId),
          eq(libraryCopies.userId, userId),
        ),
      })
    : null;
  if (!release || !album || !libraryItem) {
    throw new DatabaseCommandError(
      "invalid_state",
      "The stored scan confirmation is incomplete.",
    );
  }

  return {
    scanId,
    selectedCandidateId: confirmation.selectedCandidateId,
    release: {
      id: release.id,
      artist: confirmation.reviewedRelease.artist,
      title: confirmation.reviewedRelease.title,
      releaseYear: confirmation.reviewedRelease.releaseYear,
      label: confirmation.reviewedRelease.label,
      catalogNumber: confirmation.reviewedRelease.catalogNumber,
      barcode: confirmation.reviewedRelease.barcode,
      releaseDate: confirmation.reviewedRelease.releaseDate,
      country: confirmation.reviewedRelease.country,
      format: confirmation.reviewedRelease.format,
      packaging: confirmation.reviewedRelease.packaging,
      releaseStatus: confirmation.reviewedRelease.releaseStatus,
      catalogReference: confirmation.reviewedRelease.catalogReference,
    },
    libraryItem: {
      id: libraryItem.id,
      list: libraryItem.list,
      notes: libraryItem.notes,
      copy: copy ? serializeCopy(copy) : null,
    },
    status: "completed",
    confirmedAt: confirmation.confirmedAt.toISOString(),
    completedAt: confirmation.completedAt?.toISOString() ?? null,
  };
}
