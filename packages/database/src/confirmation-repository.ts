import { createHash } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import type {
  ConfirmScanRequest,
  ConfirmScanResponse,
  ScanConfirmationSummary,
} from "@vinylhound/contracts";
import {
  normalizeOptionalReleaseIdentityPart,
  normalizeReleaseIdentityPart,
} from "@vinylhound/domain";

import type { Database } from "./database.js";
import { DatabaseCommandError } from "./scan-repository.js";
import {
  albums,
  libraryItems,
  releases,
  scanAttempts,
  scanCandidates,
  scanConfirmations,
  scans,
} from "./schema.js";

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
    input.confirmation.list,
    input.confirmation.notes,
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
    if (existingConfirmation) {
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

    const normalizedArtist = normalizeReleaseIdentityPart(
      input.confirmation.artist,
    );
    const normalizedTitle = normalizeReleaseIdentityPart(
      input.confirmation.title,
    );
    const [insertedAlbum] = await transaction
      .insert(albums)
      .values({
        artist: input.confirmation.artist,
        title: input.confirmation.title,
        normalizedArtist,
        normalizedTitle,
      })
      .onConflictDoNothing({
        target: [albums.normalizedArtist, albums.normalizedTitle],
      })
      .returning();
    const album =
      insertedAlbum ??
      (await transaction.query.albums.findFirst({
        where: and(
          eq(albums.normalizedArtist, normalizedArtist),
          eq(albums.normalizedTitle, normalizedTitle),
        ),
      }));
    if (!album) {
      throw new DatabaseCommandError(
        "conflict",
        "The normalized album identity could not be resolved.",
      );
    }

    const identityKey = hashJson([
      normalizedArtist,
      normalizedTitle,
      input.confirmation.releaseYear,
      normalizeOptionalReleaseIdentityPart(input.confirmation.label),
      normalizeOptionalReleaseIdentityPart(input.confirmation.catalogNumber),
      normalizeOptionalReleaseIdentityPart(input.confirmation.barcode),
    ]);
    const [insertedRelease] = await transaction
      .insert(releases)
      .values({
        albumId: album.id,
        identityKey,
        releaseYear: input.confirmation.releaseYear,
        label: input.confirmation.label,
        catalogNumber: input.confirmation.catalogNumber,
        barcode: input.confirmation.barcode,
      })
      .onConflictDoNothing({ target: releases.identityKey })
      .returning();
    const release =
      insertedRelease ??
      (await transaction.query.releases.findFirst({
        where: eq(releases.identityKey, identityKey),
      }));
    if (!release) {
      throw new DatabaseCommandError(
        "conflict",
        "The normalized release identity could not be resolved.",
      );
    }

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

    const [confirmation] = await transaction
      .insert(scanConfirmations)
      .values({
        scanId: scan.id,
        userId: input.userId,
        selectedCandidateId: input.confirmation.selectedCandidateId,
        releaseId: release.id,
        libraryItemId: libraryItem!.id,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        reviewedRelease: {
          artist: input.confirmation.artist,
          title: input.confirmation.title,
          releaseYear: input.confirmation.releaseYear,
          label: input.confirmation.label,
          catalogNumber: input.confirmation.catalogNumber,
          barcode: input.confirmation.barcode,
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
  if (!confirmation) return null;

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
  const libraryItem = await db.query.libraryItems.findFirst({
    where: and(
      eq(libraryItems.id, confirmation.libraryItemId),
      eq(libraryItems.userId, userId),
    ),
  });
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
    },
    confirmedAt: confirmation.confirmedAt.toISOString(),
  };
}

function hashJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
