import { and, count, eq, inArray, isNotNull } from "drizzle-orm";

import type { AccountExportResponse, LibraryList } from "@vinylhound/contracts";

import type { CoreDatabase, ScanDatabase } from "./database.ts";
import {
  DatabaseCommandError,
  deriveImageObjectKey,
} from "./scan-repository.ts";
import {
  accountDeletions,
  batches,
  imageAssets,
  libraryCopies,
  libraryItems,
  outboxMessages,
  playlistEntries,
  playlists,
  scanAttempts,
  scanConfirmations,
  scans,
  users,
} from "./schema.ts";

export async function getAccountExportForUser(
  scanDb: ScanDatabase,
  coreDb: CoreDatabase,
  input: { userId: string },
): Promise<AccountExportResponse> {
  const [account] = await coreDb
    .select({ id: users.id, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, input.userId));
  if (!account) {
    throw new DatabaseCommandError("not_found", "Account not found.");
  }

  const [userBatches, userScans, userImages, userAttempts, confirmationRows] =
    await Promise.all([
      scanDb.select().from(batches).where(eq(batches.userId, input.userId)),
      scanDb.select().from(scans).where(eq(scans.userId, input.userId)),
      scanDb
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
      scanDb
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
      // P4.2 Task 7 (ADR-0030): was a leftJoin into core.library_items for
      // `list`; scan and core are separate connections now, so `list` is
      // resolved below from a second, core-side query instead.
      scanDb
        .select({
          scanId: scanConfirmations.scanId,
          libraryItemId: scanConfirmations.libraryItemId,
          releaseId: scanConfirmations.releaseId,
          status: scanConfirmations.status,
          reviewedRelease: scanConfirmations.reviewedRelease,
          confirmedAt: scanConfirmations.confirmedAt,
        })
        .from(scanConfirmations)
        .where(eq(scanConfirmations.userId, input.userId)),
    ]);

  const [
    userLibraryItems,
    userLibraryCopies,
    userPlaylists,
    userPlaylistEntries,
  ] = await Promise.all([
    coreDb
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.userId, input.userId)),
    coreDb
      .select()
      .from(libraryCopies)
      .where(eq(libraryCopies.userId, input.userId)),
    coreDb.select().from(playlists).where(eq(playlists.userId, input.userId)),
    coreDb
      .select()
      .from(playlistEntries)
      .where(eq(playlistEntries.userId, input.userId)),
  ]);

  const referencedLibraryItemIds = confirmationRows
    .map((row) => row.libraryItemId)
    .filter((id): id is string => id !== null);
  const listByLibraryItemId = new Map<string, LibraryList>();
  if (referencedLibraryItemIds.length) {
    const items = await coreDb
      .select({ id: libraryItems.id, list: libraryItems.list })
      .from(libraryItems)
      .where(inArray(libraryItems.id, referencedLibraryItemIds));
    for (const item of items) {
      listByLibraryItemId.set(item.id, item.list);
    }
  }
  const userConfirmations = confirmationRows.map((row) => ({
    ...row,
    // A confirmation whose saved record was removed (ADR-0018), including
    // the "removed but not yet nulled" window P4.2 Task 7 introduced (see
    // `confirmation-repository.ts`'s `isLibraryItemRemoved`), reads as no
    // list here -- the export still owes the user that decision either way.
    list: row.libraryItemId
      ? (listByLibraryItemId.get(row.libraryItemId) ?? null)
      : null,
  }));

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

/**
 * Durably records that `userId` requested deletion (idempotent: leaves an
 * already-set `deletionRequestedAt` alone). The `FOR UPDATE` lock no longer
 * serializes against `confirmScan` the way it did before P4.2 Task 7 --
 * `confirmScan` reads scan's own `account_deletions` tombstone instead of
 * this table at all now (ADR-0030) -- it only still guards against two
 * concurrent `DELETE /api/v1/account` calls racing each other harmlessly.
 */
async function markAccountDeletionRequested(
  coreDb: CoreDatabase,
  userId: string,
): Promise<{ id: string }> {
  return coreDb.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: users.id, deletionRequestedAt: users.deletionRequestedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!account) {
      throw new DatabaseCommandError("not_found", "Account not found.");
    }
    if (!account.deletionRequestedAt) {
      await transaction
        .update(users)
        .set({ deletionRequestedAt: new Date() })
        .where(eq(users.id, userId));
    }
    return { id: account.id };
  });
}

/**
 * Step 1 of the two-phase, scan-first delete (P4.2 Task 7, ADR-0030,
 * superseding the single-transaction `hardDeleteAccount` this ADR replaced
 * -- see the ADR for the full design and the race it closes). Locks every
 * existing scan row for the user first: this is what serializes against a
 * concurrent `confirmScan` for one of those scans -- `confirmScan` locks
 * that one scan row `FOR UPDATE` before inserting its `pending` confirmation
 * (`confirmation-repository.ts`), so this blanket lock either waits behind
 * it and then observes the committed `pending` row in the recheck below, or
 * wins the race and the blocked `confirmScan` call later finds the scan
 * gone (`not_found`) once this transaction commits. Either outcome is safe;
 * neither can leave a `pending` confirmation's data half-deleted.
 *
 * Not ready (returns `{ ready: false }`) while any `scan_confirmations` row
 * for the user is still `pending`: a `scan.confirmed.v1` event dispatched
 * before this call started may still be in flight to
 * `processScanConfirmation`, and deleting this user's scan data out from
 * under it would not stop that event from arriving -- it would just make
 * the confirmation impossible to ever complete or reconcile. Idempotent and
 * safe to call again once ready: a second call finds nothing left to delete.
 */
async function deleteScanDataForUser(
  scanDb: ScanDatabase,
  userId: string,
): Promise<{ ready: boolean; objectKeys: string[] }> {
  return scanDb.transaction(async (transaction) => {
    const lockedScans = await transaction
      .select({ id: scans.id })
      .from(scans)
      .where(eq(scans.userId, userId))
      .for("update");

    const [pendingRow] = await transaction
      .select({ pending: count() })
      .from(scanConfirmations)
      .where(
        and(
          eq(scanConfirmations.userId, userId),
          eq(scanConfirmations.status, "pending"),
        ),
      );
    if ((pendingRow?.pending ?? 0) > 0) {
      return { ready: false, objectKeys: [] };
    }

    // image_assets.objectKey only stores the "original" variant; the
    // analysis/thumbnail copies (ADR-0007) live at deterministically
    // derived keys with no separate row, so every variant must be
    // computed here rather than read from a column.
    const imageRows = await transaction
      .select({ id: imageAssets.id, scanId: imageAssets.scanId })
      .from(imageAssets)
      .innerJoin(scans, eq(scans.id, imageAssets.scanId))
      .where(eq(scans.userId, userId));
    const objectKeys = imageRows.flatMap((image) => {
      const lookup = { userId, scanId: image.scanId, imageId: image.id };
      return [
        deriveImageObjectKey(lookup, "original"),
        deriveImageObjectKey(lookup, "analysis"),
        deriveImageObjectKey(lookup, "thumbnail"),
      ];
    });

    const scanIds = lockedScans.map((scan) => scan.id);
    if (scanIds.length) {
      // A real, pre-existing bug found while building this (independent of
      // the physical split): outbox_messages has had no FK to scans since
      // migration 018, so an already-delivered or still-undelivered
      // scan.analyze.v1/scan.confirmed.v1 row naming one of these scans
      // would otherwise survive this delete and, if undelivered, fail
      // forever once dispatched against a scan that no longer exists. None
      // can be for a `scan.confirmed.v1` event still awaiting processing --
      // the pending-count check above already rules that out -- so this is
      // pure cleanup, not a second safety gate.
      await transaction
        .delete(outboxMessages)
        .where(inArray(outboxMessages.aggregateId, scanIds));
    }
    // Deleted directly, ahead of `scans` (whose cascade would remove it
    // anyway), for the same explicitness the original single-transaction
    // delete used.
    await transaction
      .delete(scanConfirmations)
      .where(eq(scanConfirmations.userId, userId));
    await transaction.delete(scans).where(eq(scans.userId, userId));
    await transaction.delete(batches).where(eq(batches.userId, userId));

    return { ready: true, objectKeys };
  });
}

/**
 * Step 2: deletes `core.users`, cascading `library_items`/`library_copies`/
 * `playlists`/`playlist_entries`/`confirmation_receipts` within `core`
 * (unaffected by Task 7 -- none of those FKs crossed the boundary). Callers
 * must only call this once {@link deleteScanDataForUser} has returned
 * `{ ready: true }` for the same user: once that is true, no scan exists to
 * confirm for this user (they were just deleted), so a new `pending`
 * confirmation is provably impossible from this point on and no further
 * locking or rechecking is needed here.
 */
async function deleteCoreDataForUser(
  coreDb: CoreDatabase,
  userId: string,
): Promise<{ id: string } | null> {
  const [deleted] = await coreDb
    .delete(users)
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return deleted ?? null;
}

async function bestEffortClearAccountDeletionTombstone(
  scanDb: ScanDatabase,
  userId: string,
): Promise<void> {
  try {
    await scanDb
      .delete(accountDeletions)
      .where(eq(accountDeletions.userId, userId));
  } catch {
    // Best-effort cleanup: the account is already gone from `core` by the
    // time this runs, so a stray tombstone row is inert, not unsafe -- Clerk
    // JIT provisioning always mints a fresh `users.id` for the same external
    // identity, never this exact deleted one.
  }
}

/**
 * P4.2 Task 7 (ADR-0030, superseding ADR-0014's original mechanism and
 * ADR-0029's single-transaction version): account deletion is a durable,
 * drain-then-delete workflow across two connections, never one transaction
 * spanning both -- see the ADR for the full design. Always durably records
 * the request first (`deletionRequestedAt` on `core.users`, and a tombstone
 * row in `scan.account_deletions` that `confirmScan` checks in place of the
 * old cross-schema `users` read), then attempts the two-phase hard delete
 * immediately: the common case, behaviorally unchanged from before for every
 * existing caller and test when nothing is in flight. Otherwise the hard
 * delete is left to the background sweep (`finalizeAccountDeletion`, driven
 * by `listAccountsPendingDeletion` from `apps/worker/src/index.ts`) once
 * every pending confirmation settles via the existing reconciliation
 * mechanism (P4.2 Task 4). Safe to call more than once.
 */
export async function deleteAccount(
  scanDb: ScanDatabase,
  coreDb: CoreDatabase,
  input: { userId: string },
): Promise<DeleteAccountResult> {
  // Written before `core.users` is marked, deliberately: the fail-safe
  // direction is "confirmations are refused slightly before the account is
  // actually being deleted," never the reverse.
  await scanDb
    .insert(accountDeletions)
    .values({ userId: input.userId })
    .onConflictDoNothing();

  const account = await markAccountDeletionRequested(coreDb, input.userId);

  const finalized = await finalizeAccountDeletion(scanDb, coreDb, {
    userId: account.id,
  });
  if (finalized) {
    return {
      id: account.id,
      status: "deleted",
      objectKeys: finalized.objectKeys,
    };
  }
  return { id: account.id, status: "pending", objectKeys: [] };
}

/**
 * The background half of the durable deletion workflow
 * (`apps/worker/src/index.ts`'s sweep): finalizes one account whose deletion
 * was requested and which now has no `pending` scan_confirmations left, off
 * durable state directly. Idempotent: a missing user row (already finalized
 * by a racing caller, e.g. a retried `deleteAccount` call) or one still not
 * ready returns `null` rather than throwing, so a sweep candidate list
 * slightly stale by the time it is processed is harmless.
 */
export async function finalizeAccountDeletion(
  scanDb: ScanDatabase,
  coreDb: CoreDatabase,
  input: { userId: string },
): Promise<{ id: string; objectKeys: string[] } | null> {
  const scanResult = await deleteScanDataForUser(scanDb, input.userId);
  if (!scanResult.ready) {
    return null;
  }
  const deleted = await deleteCoreDataForUser(coreDb, input.userId);
  if (!deleted) {
    // Already finalized by a racing caller; the scan-side delete above was
    // itself idempotent, so nothing was lost by running it again.
    return null;
  }
  await bestEffortClearAccountDeletionTombstone(scanDb, input.userId);
  return { id: deleted.id, objectKeys: scanResult.objectKeys };
}

/**
 * Candidates for {@link finalizeAccountDeletion}'s background sweep:
 * accounts whose deletion was requested. P4.2 Task 7 (ADR-0030): was a
 * single query with a cross-schema `NOT EXISTS` against
 * `scan.scan_confirmations`; readiness (zero `pending` confirmations) is now
 * re-evaluated inside `deleteScanDataForUser` itself, under its own lock, so
 * this only needs to name the candidates -- a slightly wider set than before
 * (it no longer pre-filters the not-yet-ready ones), which is fine since
 * `finalizeAccountDeletion` is idempotent and a not-ready candidate simply
 * returns `null`.
 */
export async function listAccountsPendingDeletion(
  coreDb: CoreDatabase,
  input: { limit: number },
): Promise<string[]> {
  const rows = await coreDb
    .select({ id: users.id })
    .from(users)
    .where(isNotNull(users.deletionRequestedAt))
    .limit(input.limit);
  return rows.map((row) => row.id);
}
