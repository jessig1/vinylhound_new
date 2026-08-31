import { and, desc, eq, inArray } from "drizzle-orm";

import type { GetLibraryResponse, LibraryList } from "@vinylhound/contracts";

import type { Database } from "./database.js";
import {
  albums,
  libraryCopies,
  libraryItems,
  releases,
  scanConfirmations,
} from "./schema.js";

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
      releaseDate: releases.releaseDate,
      country: releases.country,
      format: releases.format,
      packaging: releases.packaging,
      releaseStatus: releases.releaseStatus,
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

  const itemIds = rows.map((row) => row.id);
  const copies = itemIds.length
    ? await db
        .select()
        .from(libraryCopies)
        .where(
          and(
            eq(libraryCopies.userId, input.userId),
            inArray(libraryCopies.libraryItemId, itemIds),
          ),
        )
        .orderBy(libraryCopies.createdAt)
    : [];
  const copiesByItem = new Map<string, typeof copies>();
  for (const copy of copies) {
    const itemCopies = copiesByItem.get(copy.libraryItemId) ?? [];
    itemCopies.push(copy);
    copiesByItem.set(copy.libraryItemId, itemCopies);
  }

  return {
    list: input.list,
    items: rows.map((row) => {
      const reviewed = row.reviewedRelease;
      const catalogReference = reviewed?.catalogReference ?? null;
      const itemCopies = copiesByItem.get(row.id) ?? [];
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
          releaseDate: reviewed?.releaseDate ?? row.releaseDate,
          country: reviewed?.country ?? row.country,
          format: reviewed?.format ?? row.format,
          packaging: reviewed?.packaging ?? row.packaging,
          releaseStatus: reviewed?.releaseStatus ?? row.releaseStatus,
          catalogReference,
        },
        copyCount: itemCopies.length,
        copies: itemCopies.map((copy) => ({
          id: copy.id,
          mediaCondition: copy.mediaCondition,
          sleeveCondition: copy.sleeveCondition,
          location: copy.location,
          notes: copy.notes,
          acquiredAt: copy.acquiredAt,
          createdAt: copy.createdAt.toISOString(),
          updatedAt: copy.updatedAt.toISOString(),
        })),
        confirmedFromScanId: row.confirmedFromScanId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
  };
}
