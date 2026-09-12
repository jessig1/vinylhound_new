import { and, desc, eq, sql } from "drizzle-orm";

import type {
  ConfirmScanRequest,
  ConfirmScanResponse,
  ScanConfirmationSummary,
} from "@vinylhound/contracts";
import type { Database } from "./database.ts";
import {
  hashJson,
  resolveReviewedRelease,
  serializeCopy,
} from "./release-resolution.ts";
import { DatabaseCommandError } from "./scan-repository.ts";
import {
  albums,
  libraryCopies,
  libraryItems,
  releases,
  scanAttempts,
  scanCandidates,
  scanConfirmations,
  scans,
} from "./schema.ts";

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
    if (existingConfirmation && existingConfirmation.libraryItemId === null) {
      // The saved record this decision produced was removed (ADR-0018), so the
      // decision no longer describes anything in the library and must not block
      // saving the scan again. Replacing it leaves the image/attempt/candidate
      // audit trail untouched; only the superseded review decision is dropped.
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

    const catalogReference = input.confirmation.catalogReference;
    const { release } = await resolveReviewedRelease(transaction, {
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
      catalogReference,
    });

    const now = new Date();
    const [libraryItem] = await transaction
      .insert(libraryItems)
      .values({
        userId: input.userId,
        releaseId: release.id,
        list: input.confirmation.list,
        notes: input.confirmation.notes,
        confirmedFromScanId: scan.id,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [libraryItems.userId, libraryItems.releaseId],
        set: {
          list: sql`case
            when ${libraryItems.list} = 'collection'::library_list
              or excluded.list = 'collection'::library_list
            then 'collection'::library_list
            else 'wishlist'::library_list
          end`,
          notes: input.confirmation.notes,
          confirmedFromScanId: scan.id,
          updatedAt: now,
        },
      })
      .returning();

    const [copy] =
      input.confirmation.list === "collection"
        ? await transaction
            .insert(libraryCopies)
            .values({
              userId: input.userId,
              libraryItemId: libraryItem!.id,
              releaseId: release.id,
              confirmedFromScanId: scan.id,
              mediaCondition: input.confirmation.copy?.mediaCondition ?? null,
              sleeveCondition: input.confirmation.copy?.sleeveCondition ?? null,
              location: input.confirmation.copy?.location ?? null,
              notes: input.confirmation.copy?.notes ?? null,
              acquiredAt: input.confirmation.copy?.acquiredAt ?? null,
              updatedAt: now,
            })
            .returning()
        : [undefined];

    const [confirmation] = await transaction
      .insert(scanConfirmations)
      .values({
        scanId: scan.id,
        userId: input.userId,
        selectedCandidateId: input.confirmation.selectedCandidateId,
        releaseId: release.id,
        libraryItemId: libraryItem!.id,
        copyId: copy?.id,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        reviewedRelease: {
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
          catalogReference,
        },
        confirmedAt: now,
      })
      .returning();

    return {
      created: true,
      record: {
        scanId: scan.id,
        selectedCandidateId: confirmation!.selectedCandidateId,
        release: {
          id: release.id,
          ...confirmation!.reviewedRelease,
        },
        libraryItem: {
          id: libraryItem!.id,
          list: libraryItem!.list,
          notes: libraryItem!.notes,
          copy: copy ? serializeCopy(copy) : null,
        },
        confirmedAt: confirmation!.confirmedAt.toISOString(),
      },
    };
  });
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
  // A confirmation whose library item was removed (ADR-0018) describes nothing
  // the user still holds, so the scan reads as unconfirmed and reviewable again.
  if (!confirmation || confirmation.libraryItemId === null) return null;

  const response = await readConfirmationResponse(
    db,
    input.userId,
    input.scanId,
  );
  return {
    selectedCandidateId: response.selectedCandidateId,
    release: response.release,
    libraryItem: response.libraryItem,
    confirmedAt: response.confirmedAt,
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
  const release = await db.query.releases.findFirst({
    where: eq(releases.id, confirmation.releaseId),
  });
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
      ...confirmation.reviewedRelease,
    },
    libraryItem: {
      id: libraryItem.id,
      list: libraryItem.list,
      notes: libraryItem.notes,
      copy: copy ? serializeCopy(copy) : null,
    },
    confirmedAt: confirmation.confirmedAt.toISOString(),
  };
}
