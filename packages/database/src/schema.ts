import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const ingestionSourceEnum = pgEnum("ingestion_source", [
  "camera",
  "single_upload",
  "batch_upload",
]);

export const scanStatusEnum = pgEnum("scan_status", [
  "awaiting_upload",
  "queued",
  "processing",
  "identified",
  "needs_review",
  "unresolved",
  "failed",
  "canceled",
]);

export const imageMimeTypeEnum = pgEnum("image_mime_type", [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export const imageViewTypeEnum = pgEnum("image_view_type", [
  "front",
  "back",
  "spine",
  "label",
  "barcode",
  "runout",
  "other",
]);

export const scanAttemptStatusEnum = pgEnum("scan_attempt_status", [
  "processing",
  "succeeded",
  "failed",
]);

export const providerErrorCategoryEnum = pgEnum("provider_error_category", [
  "timeout",
  "rate_limit",
  "provider_unavailable",
  "invalid_image",
  "refusal",
  "schema_invalid",
  "unknown",
]);

export const libraryListEnum = pgEnum("library_list", [
  "collection",
  "wishlist",
]);

export const catalogProviderEnum = pgEnum("catalog_provider", ["musicbrainz"]);
export const catalogEntityTypeEnum = pgEnum("catalog_entity_type", [
  "album",
  "release",
]);
export const recordConditionEnum = pgEnum("record_condition", [
  "mint",
  "near_mint",
  "very_good_plus",
  "very_good",
  "good_plus",
  "good",
  "fair",
  "poor",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const batches = pgTable(
  "batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("batches_user_id_idempotency_key_unique").on(
      table.userId,
      table.idempotencyKey,
    ),
    check(
      "batches_idempotency_key_length_check",
      sql`char_length(${table.idempotencyKey}) between 1 and 255`,
    ),
  ],
);

export const scans = pgTable(
  "scans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").references(() => batches.id, {
      onDelete: "cascade",
    }),
    source: ingestionSourceEnum("source").notNull(),
    status: scanStatusEnum("status").default("awaiting_upload").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    submitIdempotencyKey: text("submit_idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("scans_user_id_idempotency_key_unique").on(
      table.userId,
      table.idempotencyKey,
    ),
    index("scans_user_id_status_created_at_idx").on(
      table.userId,
      table.status,
      table.createdAt,
    ),
    index("scans_batch_id_idx").on(table.batchId),
    check(
      "scans_idempotency_key_length_check",
      sql`char_length(${table.idempotencyKey}) between 1 and 255`,
    ),
    check(
      "scans_submit_idempotency_key_length_check",
      sql`${table.submitIdempotencyKey} is null or char_length(${table.submitIdempotencyKey}) between 1 and 255`,
    ),
  ],
);

export const outboxMessages = pgTable(
  "outbox_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    topic: text("topic").notNull(),
    aggregateId: uuid("aggregate_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").notNull(),
    publishAttempts: integer("publish_attempts").default(0).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("outbox_messages_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    uniqueIndex("outbox_messages_topic_aggregate_attempt_unique").on(
      table.topic,
      table.aggregateId,
      table.attemptNumber,
    ),
    index("outbox_messages_pending_idx")
      .on(table.availableAt, table.createdAt)
      .where(sql`${table.publishedAt} is null`),
    check(
      "outbox_messages_topic_check",
      sql`${table.topic} = 'scan.analyze.v1'`,
    ),
    check(
      "outbox_messages_idempotency_key_length_check",
      sql`char_length(${table.idempotencyKey}) between 1 and 255`,
    ),
    check(
      "outbox_messages_publish_attempts_check",
      sql`${table.publishAttempts} >= 0`,
    ),
    check(
      "outbox_messages_attempt_number_check",
      sql`${table.attemptNumber} > 0`,
    ),
  ],
);

export const imageAssets = pgTable(
  "image_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    objectKey: text("object_key").notNull(),
    filename: varchar("filename", { length: 255 }).notNull(),
    viewType: imageViewTypeEnum("view_type").notNull(),
    mimeType: imageMimeTypeEnum("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    checksumSha256: char("checksum_sha256", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    width: integer("width"),
    height: integer("height"),
    analysisSizeBytes: bigint("analysis_size_bytes", { mode: "number" }),
    analysisWidth: integer("analysis_width"),
    analysisHeight: integer("analysis_height"),
    thumbnailSizeBytes: bigint("thumbnail_size_bytes", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("image_assets_object_key_unique").on(table.objectKey),
    uniqueIndex("image_assets_scan_id_idempotency_key_unique").on(
      table.scanId,
      table.idempotencyKey,
    ),
    index("image_assets_scan_id_idx").on(table.scanId),
    index("image_assets_scan_id_view_type_idx").on(
      table.scanId,
      table.viewType,
    ),
    check(
      "image_assets_idempotency_key_length_check",
      sql`char_length(${table.idempotencyKey}) between 1 and 255`,
    ),
    check(
      "image_assets_object_key_check",
      sql`char_length(${table.objectKey}) > 0`,
    ),
    check("image_assets_size_bytes_check", sql`${table.sizeBytes} > 0`),
    check(
      "image_assets_checksum_sha256_check",
      sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "image_assets_dimensions_check",
      sql`(
          ${table.completedAt} is null
          and ${table.width} is null
          and ${table.height} is null
        ) or (
          ${table.completedAt} is not null
          and ${table.width} > 0
          and ${table.height} > 0
        )`,
    ),
    check(
      "image_assets_analysis_check",
      sql`(
          ${table.completedAt} is null
          and ${table.analysisSizeBytes} is null
          and ${table.analysisWidth} is null
          and ${table.analysisHeight} is null
          and ${table.thumbnailSizeBytes} is null
        ) or (
          ${table.completedAt} is not null
          and ${table.analysisSizeBytes} > 0
          and ${table.analysisWidth} > 0
          and ${table.analysisHeight} > 0
          and ${table.thumbnailSizeBytes} > 0
        )`,
    ),
  ],
);

export const scanAttempts = pgTable(
  "scan_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    deliveryAttempt: integer("delivery_attempt").default(1).notNull(),
    status: scanAttemptStatusEnum("status").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    providerResponseId: text("provider_response_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    durationMs: integer("duration_ms"),
    errorCategory: providerErrorCategoryEnum("error_category"),
    errorMessage: text("error_message"),
    observations: jsonb("observations").$type<string[]>().default([]).notNull(),
    needsReviewReasons: jsonb("needs_review_reasons")
      .$type<string[]>()
      .default([])
      .notNull(),
    outcomeReason: text("outcome_reason"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("scan_attempts_scan_delivery_attempt_unique").on(
      table.scanId,
      table.attemptNumber,
      table.deliveryAttempt,
    ),
    index("scan_attempts_scan_id_started_at_idx").on(
      table.scanId,
      table.startedAt,
    ),
    check(
      "scan_attempts_attempt_number_check",
      sql`${table.attemptNumber} > 0`,
    ),
    check(
      "scan_attempts_delivery_attempt_check",
      sql`${table.deliveryAttempt} > 0`,
    ),
    check("scan_attempts_model_check", sql`char_length(${table.model}) > 0`),
    check(
      "scan_attempts_prompt_version_check",
      sql`char_length(${table.promptVersion}) > 0`,
    ),
    check(
      "scan_attempts_token_usage_check",
      sql`(${table.inputTokens} is null or ${table.inputTokens} >= 0)
        and (${table.outputTokens} is null or ${table.outputTokens} >= 0)
        and (${table.totalTokens} is null or ${table.totalTokens} >= 0)`,
    ),
    check(
      "scan_attempts_terminal_fields_check",
      sql`(
          ${table.status} = 'processing'
          and ${table.completedAt} is null
          and ${table.durationMs} is null
          and ${table.errorCategory} is null
        ) or (
          ${table.status} = 'succeeded'
          and ${table.completedAt} is not null
          and ${table.durationMs} >= 0
          and ${table.providerResponseId} is not null
          and ${table.errorCategory} is null
        ) or (
          ${table.status} = 'failed'
          and ${table.completedAt} is not null
          and ${table.durationMs} >= 0
          and ${table.errorCategory} is not null
      )`,
    ),
    check(
      "scan_attempts_result_arrays_check",
      sql`jsonb_typeof(${table.observations}) = 'array'
        and jsonb_typeof(${table.needsReviewReasons}) = 'array'`,
    ),
    check(
      "scan_attempts_outcome_reason_check",
      sql`${table.outcomeReason} is null or ${table.outcomeReason} in (
        'no_candidates',
        'provider_review_reason',
        'low_confidence',
        'ambiguous_candidates',
        'high_confidence_clear_lead'
      )`,
    ),
  ],
);

export const scanCandidates = pgTable(
  "scan_candidates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scanAttemptId: uuid("scan_attempt_id")
      .notNull()
      .references(() => scanAttempts.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    artist: text("artist").notNull(),
    title: text("title").notNull(),
    releaseYear: integer("release_year"),
    label: text("label"),
    catalogNumber: text("catalog_number"),
    barcode: text("barcode"),
    confidence: real("confidence").notNull(),
    evidence: jsonb("evidence").$type<string[]>().default([]).notNull(),
    warnings: jsonb("warnings").$type<string[]>().default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("scan_candidates_attempt_rank_unique").on(
      table.scanAttemptId,
      table.rank,
    ),
    index("scan_candidates_attempt_idx").on(table.scanAttemptId),
    check("scan_candidates_rank_check", sql`${table.rank} > 0`),
    check(
      "scan_candidates_confidence_check",
      sql`${table.confidence} between 0 and 1`,
    ),
    check(
      "scan_candidates_artist_title_check",
      sql`char_length(${table.artist}) > 0 and char_length(${table.title}) > 0`,
    ),
    check(
      "scan_candidates_result_arrays_check",
      sql`jsonb_typeof(${table.evidence}) = 'array'
        and jsonb_typeof(${table.warnings}) = 'array'`,
    ),
  ],
);

export const catalogReferences = pgTable(
  "catalog_references",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: catalogProviderEnum("provider").notNull(),
    entityType: catalogEntityTypeEnum("entity_type").notNull(),
    externalId: varchar("external_id", { length: 255 }).notNull(),
    albumId: uuid("album_id").references(() => albums.id, {
      onDelete: "cascade",
    }),
    releaseId: uuid("release_id").references(() => releases.id, {
      onDelete: "cascade",
    }),
    sourceUrl: text("source_url").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("catalog_references_external_identity_unique").on(
      table.provider,
      table.entityType,
      table.externalId,
    ),
    index("catalog_references_album_id_idx").on(table.albumId),
    index("catalog_references_release_id_idx").on(table.releaseId),
    check(
      "catalog_references_owner_check",
      sql`(${table.entityType} = 'album'::catalog_entity_type and ${table.albumId} is not null and ${table.releaseId} is null)
        or (${table.entityType} = 'release'::catalog_entity_type and ${table.releaseId} is not null and ${table.albumId} is null)`,
    ),
  ],
);

export const albums = pgTable(
  "albums",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    artist: varchar("artist", { length: 255 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    normalizedArtist: varchar("normalized_artist", { length: 255 }).notNull(),
    normalizedTitle: varchar("normalized_title", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("albums_normalized_identity_unique").on(
      table.normalizedArtist,
      table.normalizedTitle,
    ),
  ],
);

export const releases = pgTable(
  "releases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    albumId: uuid("album_id")
      .notNull()
      .references(() => albums.id, { onDelete: "cascade" }),
    identityKey: char("identity_key", { length: 64 }).notNull(),
    releaseYear: integer("release_year"),
    releaseDate: varchar("release_date", { length: 10 }),
    country: varchar("country", { length: 10 }),
    format: varchar("format", { length: 255 }),
    packaging: varchar("packaging", { length: 255 }),
    releaseStatus: varchar("release_status", { length: 100 }),
    label: varchar("label", { length: 255 }),
    catalogNumber: varchar("catalog_number", { length: 255 }),
    barcode: varchar("barcode", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("releases_identity_key_unique").on(table.identityKey),
    index("releases_album_id_idx").on(table.albumId),
    check(
      "releases_year_check",
      sql`${table.releaseYear} is null or ${table.releaseYear} between 1900 and 2200`,
    ),
    check(
      "releases_identity_key_check",
      sql`${table.identityKey} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const libraryItems = pgTable(
  "library_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    list: libraryListEnum("list").notNull(),
    notes: text("notes"),
    confirmedFromScanId: uuid("confirmed_from_scan_id").references(
      () => scans.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("library_items_user_release_unique").on(
      table.userId,
      table.releaseId,
    ),
    index("library_items_user_list_created_idx").on(
      table.userId,
      table.list,
      table.createdAt,
    ),
    check(
      "library_items_notes_length_check",
      sql`${table.notes} is null or char_length(${table.notes}) <= 2000`,
    ),
  ],
);

export const libraryCopies = pgTable(
  "library_copies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    libraryItemId: uuid("library_item_id")
      .notNull()
      .references(() => libraryItems.id, { onDelete: "cascade" }),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    confirmedFromScanId: uuid("confirmed_from_scan_id").references(
      () => scans.id,
      { onDelete: "set null" },
    ),
    mediaCondition: recordConditionEnum("media_condition"),
    sleeveCondition: recordConditionEnum("sleeve_condition"),
    location: varchar("location", { length: 255 }),
    notes: text("notes"),
    acquiredAt: date("acquired_at", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("library_copies_library_item_created_idx").on(
      table.libraryItemId,
      table.createdAt,
    ),
    index("library_copies_release_id_idx").on(table.releaseId),
    check(
      "library_copies_notes_length_check",
      sql`${table.notes} is null or char_length(${table.notes}) <= 2000`,
    ),
  ],
);

export const scanConfirmations = pgTable(
  "scan_confirmations",
  {
    scanId: uuid("scan_id")
      .primaryKey()
      .references(() => scans.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    selectedCandidateId: uuid("selected_candidate_id").references(
      () => scanCandidates.id,
      { onDelete: "set null" },
    ),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "restrict" }),
    libraryItemId: uuid("library_item_id")
      .notNull()
      .references(() => libraryItems.id, { onDelete: "restrict" }),
    copyId: uuid("copy_id").references(() => libraryCopies.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: char("request_fingerprint", { length: 64 }).notNull(),
    reviewedRelease: jsonb("reviewed_release")
      .$type<{
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
        catalogReference: {
          provider: "musicbrainz";
          releaseGroupId: string;
          releaseId: string;
          sourceUrl: string;
          fetchedAt: string;
        } | null;
      }>()
      .notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("scan_confirmations_user_idempotency_unique").on(
      table.userId,
      table.idempotencyKey,
    ),
    check(
      "scan_confirmations_idempotency_key_length_check",
      sql`char_length(${table.idempotencyKey}) between 1 and 255`,
    ),
    check(
      "scan_confirmations_request_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "scan_confirmations_reviewed_release_check",
      sql`jsonb_typeof(${table.reviewedRelease}) = 'object'`,
    ),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type BatchRow = typeof batches.$inferSelect;
export type NewBatchRow = typeof batches.$inferInsert;
export type ScanRow = typeof scans.$inferSelect;
export type NewScanRow = typeof scans.$inferInsert;
export type ImageAssetRow = typeof imageAssets.$inferSelect;
export type NewImageAssetRow = typeof imageAssets.$inferInsert;
export type ScanAttemptRow = typeof scanAttempts.$inferSelect;
export type NewScanAttemptRow = typeof scanAttempts.$inferInsert;
export type OutboxMessageRow = typeof outboxMessages.$inferSelect;
export type NewOutboxMessageRow = typeof outboxMessages.$inferInsert;
export type ScanCandidateRow = typeof scanCandidates.$inferSelect;
export type NewScanCandidateRow = typeof scanCandidates.$inferInsert;
export type AlbumRow = typeof albums.$inferSelect;
export type ReleaseRow = typeof releases.$inferSelect;
export type LibraryItemRow = typeof libraryItems.$inferSelect;
export type LibraryCopyRow = typeof libraryCopies.$inferSelect;
export type CatalogReferenceRow = typeof catalogReferences.$inferSelect;
export type ScanConfirmationRow = typeof scanConfirmations.$inferSelect;
