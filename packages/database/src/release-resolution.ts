import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { CatalogReference } from "@vinylhound/contracts";
import {
  normalizeOptionalReleaseIdentityPart,
  normalizeReleaseIdentityPart,
} from "@vinylhound/domain";

import type { Database } from "./database.ts";
import { DatabaseCommandError } from "./scan-repository.ts";
import { albums, catalogReferences, releases } from "./schema.ts";
import type { libraryCopies } from "./schema.ts";

export type DatabaseTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/**
 * The reviewed release attributes that decide album and release identity,
 * shared by both routes into the library: confirming a scan, and placing a
 * catalog result from `/discover` with no scan.
 */
export interface ReviewedReleaseIdentity {
  artist: string;
  title: string;
  releaseYear: number | null;
  label: string | null;
  catalogNumber: string | null;
  barcode: string | null;
  releaseDate: string | null;
  country: string | null;
  format: string | null;
  packaging: string | null;
  releaseStatus: string | null;
  catalogReference: CatalogReference | null;
}

/**
 * Where a provider's album concept lives on the public web. The release-level
 * URL travels on the reference itself, but the album-level one is derived,
 * because a search result names the pressing it matched rather than the album
 * page above it.
 */
export function albumSourceUrl(reference: CatalogReference) {
  return reference.provider === "musicbrainz"
    ? `https://musicbrainz.org/release-group/${reference.releaseGroupId}`
    : `https://open.spotify.com/album/${reference.releaseGroupId}`;
}

export function hashJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Resolves a reviewed release onto the shared `albums`/`releases` rows,
 * writing any catalog references the provider can actually support, and
 * returns the rows the caller should attach a library item to.
 *
 * Must be called inside a transaction: it takes an advisory lock on the
 * provider's album concept so two concurrent saves of the same album cannot
 * race each other into duplicate rows.
 */
export async function resolveReviewedRelease(
  transaction: DatabaseTransaction,
  reviewed: ReviewedReleaseIdentity,
) {
  const catalogReference = reviewed.catalogReference;

  if (catalogReference) {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(${catalogReference.provider}),
        hashtext(${catalogReference.releaseGroupId})
      )`,
    );
  }

  const normalizedArtist = normalizeReleaseIdentityPart(reviewed.artist);
  const normalizedTitle = normalizeReleaseIdentityPart(reviewed.title);

  const existingAlbumReference = catalogReference
    ? await transaction.query.catalogReferences.findFirst({
        where: and(
          eq(catalogReferences.provider, catalogReference.provider),
          eq(catalogReferences.entityType, "album"),
          eq(catalogReferences.externalId, catalogReference.releaseGroupId),
        ),
      })
    : null;
  const referencedAlbum = existingAlbumReference?.albumId
    ? await transaction.query.albums.findFirst({
        where: eq(albums.id, existingAlbumReference.albumId),
      })
    : null;
  const [insertedAlbum] = referencedAlbum
    ? [referencedAlbum]
    : await transaction
        .insert(albums)
        .values({
          artist: reviewed.artist,
          title: reviewed.title,
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

  if (catalogReference && !existingAlbumReference) {
    await transaction
      .insert(catalogReferences)
      .values({
        provider: catalogReference.provider,
        entityType: "album",
        externalId: catalogReference.releaseGroupId,
        albumId: album.id,
        sourceUrl: albumSourceUrl(catalogReference),
        fetchedAt: new Date(catalogReference.fetchedAt),
      })
      .onConflictDoNothing({
        target: [
          catalogReferences.provider,
          catalogReferences.entityType,
          catalogReferences.externalId,
        ],
      });
  }

  const existingReleaseReference = catalogReference?.releaseId
    ? await transaction.query.catalogReferences.findFirst({
        where: and(
          eq(catalogReferences.provider, catalogReference.provider),
          eq(catalogReferences.entityType, "release"),
          eq(catalogReferences.externalId, catalogReference.releaseId),
        ),
      })
    : null;
  const referencedRelease = existingReleaseReference?.releaseId
    ? await transaction.query.releases.findFirst({
        where: eq(releases.id, existingReleaseReference.releaseId),
      })
    : null;
  if (referencedRelease && referencedRelease.albumId !== album.id) {
    throw new DatabaseCommandError(
      "conflict",
      "The catalog release is already linked to a different album.",
    );
  }

  // A provider reference pins release identity only when it names a pressing.
  // A Spotify reference names an album concept, so identity falls back to the
  // reviewed attributes exactly as a hand-entered record does — two different
  // pressings of one album stay two different releases.
  const identityKey = catalogReference?.releaseId
    ? hashJson([catalogReference.provider, catalogReference.releaseId])
    : hashJson([
        normalizedArtist,
        normalizedTitle,
        reviewed.releaseYear,
        normalizeOptionalReleaseIdentityPart(reviewed.label),
        normalizeOptionalReleaseIdentityPart(reviewed.catalogNumber),
        normalizeOptionalReleaseIdentityPart(reviewed.barcode),
        normalizeOptionalReleaseIdentityPart(reviewed.releaseDate),
        normalizeOptionalReleaseIdentityPart(reviewed.country),
        normalizeOptionalReleaseIdentityPart(reviewed.format),
      ]);

  const [insertedRelease] = referencedRelease
    ? [referencedRelease]
    : await transaction
        .insert(releases)
        .values({
          albumId: album.id,
          identityKey,
          releaseYear: reviewed.releaseYear,
          releaseDate: reviewed.releaseDate,
          country: reviewed.country,
          format: reviewed.format,
          packaging: reviewed.packaging,
          releaseStatus: reviewed.releaseStatus,
          label: reviewed.label,
          catalogNumber: reviewed.catalogNumber,
          barcode: reviewed.barcode,
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

  if (catalogReference?.releaseId && !existingReleaseReference) {
    await transaction
      .insert(catalogReferences)
      .values({
        provider: catalogReference.provider,
        entityType: "release",
        externalId: catalogReference.releaseId,
        releaseId: release.id,
        sourceUrl: catalogReference.sourceUrl,
        fetchedAt: new Date(catalogReference.fetchedAt),
      })
      .onConflictDoNothing({
        target: [
          catalogReferences.provider,
          catalogReferences.entityType,
          catalogReferences.externalId,
        ],
      });
  }

  return { album, release };
}

export function serializeCopy(copy: typeof libraryCopies.$inferSelect) {
  return {
    id: copy.id,
    mediaCondition: copy.mediaCondition,
    sleeveCondition: copy.sleeveCondition,
    location: copy.location,
    notes: copy.notes,
    acquiredAt: copy.acquiredAt,
    createdAt: copy.createdAt.toISOString(),
    updatedAt: copy.updatedAt.toISOString(),
  };
}
