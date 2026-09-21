import { and, count, eq, isNotNull, sql } from "drizzle-orm";

import type { AccountExportResponse } from "@vinylhound/contracts";

import type { Database } from "./database.ts";
import type { DatabaseTransaction } from "./release-resolution.ts";
import {
  DatabaseCommandError,
  deriveImageObjectKey,
} from "./scan-repository.ts";
import {
  batches,
  imageAssets,
  libraryCopies,
  libraryItems,
  playlistEntries,
  playlists,
  scanAttempts,
  scanConfirmations,
  scans,
  users,
} from "./schema.ts";

export async function getAccountExportForUser(
  db: Database,
  input: { userId: string },
): Promise<AccountExportResponse> {
  const [account] = await db
    .select({ id: users.id, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, input.userId));
  if (!account) {
    throw new DatabaseCommandError("not_found", "Account not found.");
  }

  const [
    userBatches,
    userScans,
    userImages,
    userAttempts,
    userConfirmations,
    userLibraryItems,
    userLibraryCopies,
    userPlaylists,
    userPlaylistEntries,
  ] = await Promise.all([
    db.select().from(batches).where(eq(batches.userId, input.userId)),
    db.select().from(scans).where(eq(scans.userId, input.userId)),
    db
      .select({
        id: imageAssets.id,
        scanId: imageAssets.scanId,
        objectKey: imageAssets.objectKey,
        filename: imageAssets.filename,
        viewType: imageAssets.viewType,
        mimeType: imageAssets.mimeType,
        sizeBytes: imageAssets.sizeBytes,
        checksumSha256: imageAssets.checksumSha256,
        createdAt: imageAssets.createdAt,
        completedAt: imageAssets.completedAt,
        width: imageAssets.width,
        height: imageAssets.height,
      })
      .from(imageAssets)
      .innerJoin(scans, eq(scans.id, imageAssets.scanId))
      .where(eq(scans.userId, input.userId)),
    db
      .select({
        id: scanAttempts.id,
        scanId: scanAttempts.scanId,
        attemptNumber: scanAttempts.attemptNumber,
        status: scanAttempts.status,
        model: scanAttempts.model,
        promptVersion: scanAttempts.promptVersion,
        startedAt: scanAttempts.startedAt,
        completedAt: scanAttempts.completedAt,
        durationMs: scanAttempts.durationMs,
        inputTokens: scanAttempts.inputTokens,
        outputTokens: scanAttempts.outputTokens,
        totalTokens: scanAttempts.totalTokens,
      })
      .from(scanAttempts)
      .innerJoin(scans, eq(scans.id, scanAttempts.scanId))
      .where(eq(scans.userId, input.userId)),
    db
      .select({
        scanId: scanConfirmations.scanId,
        libraryItemId: scanConfirmations.libraryItemId,
        releaseId: scanConfirmations.releaseId,
        status: scanConfirmations.status,
        reviewedRelease: scanConfirmations.reviewedRelease,
        confirmedAt: scanConfirmations.confirmedAt,
        list: libraryItems.list,
      })
      .from(scanConfirmations)
      // Left joined: a confirmation whose saved record was removed (ADR-0018)
      // keeps no library item, and the export still owes the user that
      // decision.
      .leftJoin(
        libraryItems,
        eq(libraryItems.id, scanConfirmations.libraryItemId),
      )
      .where(eq(scanConfirmations.userId, input.userId)),
    db.select().from(libraryItems).where(eq(libraryItems.userId, input.userId)),
    db
      .select()
      .from(libraryCopies)
      .where(eq(libraryCopies.userId, input.userId)),
    db.select().from(playlists).where(eq(playlists.userId, input.userId)),
    db
      .select()
      .from(playlistEntries)
      .where(eq(playlistEntries.userId, input.userId)),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    account: {
      id: account.id,
      createdAt: account.createdAt.toISOString(),
    },
    batches: userBatches.map((batch) => ({
      id: batch.id,
      createdAt: batch.createdAt.toISOString(),
    })),
    scans: userScans.map((scan) => ({
      id: scan.id,
      batchId: scan.batchId,
      source: scan.source,
      status: scan.status,
      createdAt: scan.createdAt.toISOString(),
      updatedAt: scan.updatedAt.toISOString(),
      submittedAt: scan.submittedAt ? scan.submittedAt.toISOString() : null,
      completedAt: scan.completedAt ? scan.completedAt.toISOString() : null,
    })),
    images: userImages.map((image) => ({
      id: image.id,
      scanId: image.scanId,
      objectKey: image.objectKey,
      filename: image.filename,
      viewType: image.viewType,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      checksumSha256: image.checksumSha256,
      createdAt: image.createdAt.toISOString(),
      completedAt: image.completedAt ? image.completedAt.toISOString() : null,
      width: image.width,
      height: image.height,
    })),
    attempts: userAttempts.map((attempt) => ({
      id: attempt.id,
      scanId: attempt.scanId,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      model: attempt.model,
      promptVersion: attempt.promptVersion,
      startedAt: attempt.startedAt.toISOString(),
      completedAt: attempt.completedAt
        ? attempt.completedAt.toISOString()
        : null,
      durationMs: attempt.durationMs,
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      totalTokens: attempt.totalTokens,
    })),
    confirmations: userConfirmations.map((confirmation) => ({
      scanId: confirmation.scanId,
      libraryItemId: confirmation.libraryItemId,
      releaseId: confirmation.releaseId,
      status: confirmation.status,
      artist: confirmation.reviewedRelease.artist,
      title: confirmation.reviewedRelease.title,
      list: confirmation.list,
      confirmedAt: confirmation.confirmedAt.toISOString(),
    })),
    libraryItems: userLibraryItems.map((item) => ({
      id: item.id,
      releaseId: item.releaseId,
      list: item.list,
      notes: item.notes,
      confirmedFromScanId: item.confirmedFromScanId,
      favoritedAt: item.favoritedAt ? item.favoritedAt.toISOString() : null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })),
    libraryCopies: userLibraryCopies.map((copy) => ({
      id: copy.id,
      libraryItemId: copy.libraryItemId,
      releaseId: copy.releaseId,
      mediaCondition: copy.mediaCondition,
      sleeveCondition: copy.sleeveCondition,
      location: copy.location,
      notes: copy.notes,
      acquiredAt: copy.acquiredAt,
      createdAt: copy.createdAt.toISOString(),
      updatedAt: copy.updatedAt.toISOString(),
    })),
    playlists: userPlaylists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      createdAt: playlist.createdAt.toISOString(),
      updatedAt: playlist.updatedAt.toISOString(),
    })),
    playlistEntries: userPlaylistEntries.map((entry) => ({
      id: entry.id,
      playlistId: entry.playlistId,
      libraryItemId: entry.libraryItemId,
      position: entry.position,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

export type DeleteAccountResult = {
  id: string;
  status: "deleted" | "pending";
  objectKeys: string[];
};

async function countPendingConfirmations(
  transaction: DatabaseTransaction,
  userId: string,
): Promise<number> {
  const [row] = await transaction
    .select({ pending: count() })
    .from(scanConfirmations)
    .where(
      and(
        eq(scanConfirmations.userId, userId),
        eq(scanConfirmations.status, "pending"),
      ),
    );
  return row?.pending ?? 0;
}

/**
 * The actual cascading hard delete (ADR-0014's original mechanism,
 * unchanged): shared by `deleteAccount`'s immediate path and
 * `finalizeAccountDeletion`'s background one. Callers are responsible for
 * having already confirmed zero `pending` scan_confirmations remain -- this
 * function does not check.
 */
async function hardDeleteAccount(
  transaction: DatabaseTransaction,
  userId: string,
): Promise<string[]> {
  const imageRows = await transaction
    .select({ id: imageAssets.id, scanId: imageAssets.scanId })
    .from(imageAssets)
    .innerJoin(scans, eq(scans.id, imageAssets.scanId))
    .where(eq(scans.userId, userId));
  // image_assets.objectKey only stores the "original" variant; the
  // analysis/thumbnail copies (ADR-0007) live at deterministically
  // derived keys with no separate row, so every variant must be
  // computed here rather than read from a column.
  const objectKeys = imageRows.flatMap((image) => {
    const lookup = { userId, scanId: image.scanId, imageId: image.id };
    return [
      deriveImageObjectKey(lookup, "original"),
      deriveImageObjectKey(lookup, "analysis"),
      deriveImageObjectKey(lookup, "thumbnail"),
    ];
  });

  // Every remaining scan_confirmations row for this user is `completed` (no
  // `pending` rows survive to this point, per the callers' contract), so
  // release_id is set and the status-consistency check does not block this
  // delete. Deleted directly (not left to the users cascade alone) so the
  // ordering relative to library_items below stays explicit and obvious.
  await transaction
    .delete(scanConfirmations)
    .where(eq(scanConfirmations.userId, userId));

  // playlists and playlist_entries cascade from users (and from
  // library_items), so the account delete needs no extra ordering for them.
  await transaction.delete(users).where(eq(users.id, userId));

  return objectKeys;
}

/**
 * P4.2 Task 6 (new ADR, superseding ADR-0014's deletion mechanism and
 * amending ADR-0028): account deletion is now a durable, drain-then-delete
 * workflow rather than always one synchronous transaction. A `pending`
 * scan_confirmations row means a `scan.confirmed.v1` event may already be
 * in flight (dispatched to the queue before this call); hard-deleting the
 * account underneath it would let hop 2 (`processScanConfirmation`) fail
 * with a foreign-key violation against a since-deleted `users` row instead
 * of a clean, recoverable outcome -- exactly the gap ADR-0028 documented and
 * left open for this task.
 *
 * This always durably records the request first (`deletionRequestedAt`,
 * which also makes `confirmScan` refuse any new confirmation for the
 * account -- see its own row-lock check), then hard-deletes immediately if
 * nothing is in flight: the common case, behaviorally unchanged from the
 * previous always-synchronous version. Otherwise the hard delete is left to
 * the background sweep (`finalizeAccountDeletion`, driven by
 * `listAccountsReadyForDeletion` from `apps/worker/src/index.ts`) once every
 * pending confirmation settles via the existing reconciliation mechanism
 * (P4.2 Task 4). Safe to call more than once: a retried request against an
 * account already marked for deletion re-checks readiness and finalizes
 * immediately if it now can, rather than erroring.
 */
export async function deleteAccount(
  db: Database,
  input: { userId: string },
): Promise<DeleteAccountResult> {
  return db.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: users.id, deletionRequestedAt: users.deletionRequestedAt })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    if (!account) {
      throw new DatabaseCommandError("not_found", "Account not found.");
    }

    if (!account.deletionRequestedAt) {
      await transaction
        .update(users)
        .set({ deletionRequestedAt: new Date() })
        .where(eq(users.id, input.userId));
    }

    const pending = await countPendingConfirmations(transaction, account.id);
    if (pending > 0) {
      return { id: account.id, status: "pending", objectKeys: [] };
    }

    const objectKeys = await hardDeleteAccount(transaction, account.id);
    return { id: account.id, status: "deleted", objectKeys };
  });
}

/**
 * The background half of the durable deletion workflow
 * (`apps/worker/src/index.ts`'s sweep): finalizes one account whose deletion
 * was requested and which now has no `pending` scan_confirmations left,
 * off durable state directly -- the same "queue is a dumb delivery
 * mechanism, the database is authoritative" position ADR-0028's own
 * confirmation-reconciliation sweep already takes. Idempotent: a missing
 * user row (already finalized by a racing caller, e.g. a retried
 * `deleteAccount` call) or one still not ready returns `null` rather than
 * throwing, so a sweep candidate list slightly stale by the time it is
 * processed is harmless.
 */
export async function finalizeAccountDeletion(
  db: Database,
  input: { userId: string },
): Promise<{ id: string; objectKeys: string[] } | null> {
  return db.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    if (!account) {
      return null;
    }

    const pending = await countPendingConfirmations(transaction, account.id);
    if (pending > 0) {
      return null;
    }

    const objectKeys = await hardDeleteAccount(transaction, account.id);
    return { id: account.id, objectKeys };
  });
}

/**
 * Candidates for `finalizeAccountDeletion`'s background sweep: accounts
 * whose deletion was requested and which have drained to zero `pending`
 * scan_confirmations. Same shape as
 * `confirmation-reconciliation-repository.ts`'s `listStalePendingConfirmations`
 * -- no row locking here, since `finalizeAccountDeletion` itself is
 * idempotent and re-checks readiness under its own lock.
 */
export async function listAccountsReadyForDeletion(
  db: Database,
  input: { limit: number },
): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        isNotNull(users.deletionRequestedAt),
        sql`not exists (
          select 1 from ${scanConfirmations}
          where ${scanConfirmations.userId} = ${users.id}
            and ${scanConfirmations.status} = 'pending'
        )`,
      ),
    )
    .limit(input.limit);
  return rows.map((row) => row.id);
}
