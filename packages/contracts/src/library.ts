import { z } from "zod";

export const LibraryListSchema = z.enum(["collection", "wishlist"]);
export type LibraryList = z.infer<typeof LibraryListSchema>;

export const AddLibraryItemSchema = z
  .object({
    releaseId: z.string().uuid(),
    list: LibraryListSchema,
    notes: z.string().trim().max(2_000).nullable(),
  })
  .strict();

export type AddLibraryItem = z.infer<typeof AddLibraryItemSchema>;
