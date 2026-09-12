import { z } from "zod";

import { LibraryItemResultSchema } from "./library.ts";

export const PLAYLIST_NAME_MAX_LENGTH = 100;
export const MAX_PLAYLISTS_PER_USER = 100;
export const MAX_PLAYLIST_ENTRIES = 500;

export const PlaylistNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(PLAYLIST_NAME_MAX_LENGTH);

/**
 * A playlist is a user-owned, ordered list of saved release references: each
 * entry points at one of the user's own library items, never at a bare
 * release, a catalog result, or anything the user has not saved. Playlists
 * organize music the user already has; streaming playback is out of scope
 * regardless of which discovery provider is configured.
 */
export const CreatePlaylistSchema = z
  .object({
    name: PlaylistNameSchema,
  })
  .strict();

/**
 * Rename and/or reorder. `entryIds` is the complete new order and must name
 * every current entry exactly once — a partial or stale order is rejected
 * rather than guessed at, so two devices editing the same playlist cannot
 * silently drop each other's entries.
 */
export const UpdatePlaylistSchema = z
  .object({
    name: PlaylistNameSchema.optional(),
    entryIds: z
      .array(z.string().uuid())
      .max(MAX_PLAYLIST_ENTRIES)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "entryIds must not repeat an entry.",
      })
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.name === undefined && value.entryIds === undefined) {
      context.addIssue({
        code: "custom",
        message: "Provide a name or an entry order to update.",
      });
    }
  });

export const AddPlaylistEntrySchema = z
  .object({
    libraryItemId: z.string().uuid(),
  })
  .strict();

export const PlaylistSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(PLAYLIST_NAME_MAX_LENGTH),
    entryCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/**
 * `position` orders entries ascending and is unique within a playlist, but
 * is not guaranteed contiguous: removing a record from the library removes
 * its entries without renumbering the rest. A reorder renumbers from 1.
 */
export const PlaylistEntrySchema = z
  .object({
    id: z.string().uuid(),
    position: z.number().int().positive(),
    addedAt: z.string().datetime(),
    item: LibraryItemResultSchema,
  })
  .strict();

export const PlaylistDetailSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(PLAYLIST_NAME_MAX_LENGTH),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    entries: z.array(PlaylistEntrySchema).max(MAX_PLAYLIST_ENTRIES),
  })
  .strict();

export const ListPlaylistsResponseSchema = z
  .object({
    playlists: z.array(PlaylistSummarySchema).max(MAX_PLAYLISTS_PER_USER),
  })
  .strict();

export const GetPlaylistResponseSchema = z
  .object({
    playlist: PlaylistDetailSchema,
  })
  .strict();

export const DeletePlaylistResponseSchema = z
  .object({ id: z.string().uuid() })
  .strict();

export const DeletePlaylistEntryResponseSchema = z
  .object({ id: z.string().uuid() })
  .strict();

export type CreatePlaylist = z.infer<typeof CreatePlaylistSchema>;
export type UpdatePlaylist = z.infer<typeof UpdatePlaylistSchema>;
export type AddPlaylistEntry = z.infer<typeof AddPlaylistEntrySchema>;
export type PlaylistSummary = z.infer<typeof PlaylistSummarySchema>;
export type PlaylistEntry = z.infer<typeof PlaylistEntrySchema>;
export type PlaylistDetail = z.infer<typeof PlaylistDetailSchema>;
export type ListPlaylistsResponse = z.infer<typeof ListPlaylistsResponseSchema>;
export type GetPlaylistResponse = z.infer<typeof GetPlaylistResponseSchema>;
export type DeletePlaylistResponse = z.infer<
  typeof DeletePlaylistResponseSchema
>;
export type DeletePlaylistEntryResponse = z.infer<
  typeof DeletePlaylistEntryResponseSchema
>;
