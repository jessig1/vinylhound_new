import { eq } from "drizzle-orm";

import type { AccountExportResponse } from "@vinylhound/contracts";

import type { Database } from "./database.ts";
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

export async function deleteAccount(
  db: Database,
  input: { userId: string },
): Promise<{ id: string; objectKeys: string[] }> {
  return db.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    if (!account) {
      throw new DatabaseCommandError("not_found", "Account not found.");
    }

    const imageRows = await transaction
      .select({ id: imageAssets.id, scanId: imageAssets.scanId })
      .from(imageAssets)
      .innerJoin(scans, eq(scans.id, imageAssets.scanId))
      .where(eq(scans.userId, input.userId));
    // image_assets.objectKey only stores the "original" variant; the
    // analysis/thumbnail copies (ADR-0007) live at deterministically
    // derived keys with no separate row, so every variant must be
    // computed here rather than read from a column.
    const objectKeys = imageRows.flatMap((image) => {
      const lookup = {
        userId: input.userId,
        scanId: image.scanId,
        imageId: image.id,
      };
      return [
        deriveImageObjectKey(lookup, "original"),
        deriveImageObjectKey(lookup, "analysis"),
        deriveImageObjectKey(lookup, "thumbnail"),
      ];
    });

    // scan_confirmations.release_id is a deliberate `restrict` FK protecting
    // shared catalog rows, so a whole-account delete removes confirmations
    // directly first rather than relying on the users cascade alone.
    // (library_item_id clears itself since ADR-0018, but the explicit delete
    // keeps this ordering obvious.)
    await transaction
      .delete(scanConfirmations)
      .where(eq(scanConfirmations.userId, input.userId));

    // playlists and playlist_entries cascade from users (and from
    // library_items), so the account delete needs no extra ordering for them.
    await transaction.delete(users).where(eq(users.id, input.userId));

    return {
      id: account.id,
      objectKeys,
    };
  });
}
