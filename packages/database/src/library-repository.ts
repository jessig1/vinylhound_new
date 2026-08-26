import { and, desc, eq } from "drizzle-orm";

import type { GetLibraryResponse, LibraryList } from "@vinylhound/contracts";

import type { Database } from "./database.js";
import { albums, libraryItems, releases, scanConfirmations } from "./schema.js";

export async function listLibraryItemsForUser(
  db: Database,
  input: { userId: string; list: LibraryList },
): Promise<GetLibraryResponse> {
  const rows = await db
    .select({
      id: libraryItems.id,
      list: libraryItems.list,
      notes: libraryItems.notes,
      confirmedFromScanId: libraryItems.confirmedFromScanId,
      createdAt: libraryItems.createdAt,
      updatedAt: libraryItems.updatedAt,
      releaseId: releases.id,
      artist: albums.artist,
      title: albums.title,
      releaseYear: releases.releaseYear,
      label: releases.label,
      catalogNumber: releases.catalogNumber,
      barcode: releases.barcode,
      reviewedRelease: scanConfirmations.reviewedRelease,
    })
    .from(libraryItems)
    .innerJoin(releases, eq(releases.id, libraryItems.releaseId))
    .innerJoin(albums, eq(albums.id, releases.albumId))
    .leftJoin(
      scanConfirmations,
      eq(scanConfirmations.scanId, libraryItems.confirmedFromScanId),
    )
    .where(
      and(
        eq(libraryItems.userId, input.userId),
        eq(libraryItems.list, input.list),
      ),
    )
    .orderBy(desc(libraryItems.updatedAt))
    .limit(100);

  return {
    list: input.list,
    items: rows.map((row) => {
      const reviewed = row.reviewedRelease;
      return {
        id: row.id,
        list: row.list,
        notes: row.notes,
        release: {
          id: row.releaseId,
          artist: reviewed ? reviewed.artist : row.artist,
          title: reviewed ? reviewed.title : row.title,
          releaseYear: reviewed ? reviewed.releaseYear : row.releaseYear,
          label: reviewed ? reviewed.label : row.label,
          catalogNumber: reviewed ? reviewed.catalogNumber : row.catalogNumber,
          barcode: reviewed ? reviewed.barcode : row.barcode,
        },
        confirmedFromScanId: row.confirmedFromScanId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
  };
}
