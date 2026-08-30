import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "./database.js";
import { getScanForUser } from "./analysis-repository.js";
import { confirmScan } from "./confirmation-repository.js";
import { listLibraryItemsForUser } from "./library-repository.js";
import {
  completeImageUpload,
  createOrGetImageUpload,
  createOrGetScan,
  dispatchNextOutboxMessage,
  submitScan,
} from "./scan-repository.js";
import {
  albums,
  imageAssets,
  libraryItems,
  outboxMessages,
  scanAttempts,
  scanCandidates,
  scanConfirmations,
  scans,
  users,
} from "./schema.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required for database integration tests.");
}

const database = createDatabase({ connectionString, maxConnections: 2 });
const userId = randomUUID();

beforeAll(async () => {
  await database.db.insert(users).values({ id: userId });
});

afterAll(async () => {
  await database.db.delete(users).where(eq(users.id, userId));
  await database.close();
});

describe("initial scan persistence schema", () => {
  it("replays idempotent scan and upload commands without duplicate rows", async () => {
    const scanInput = {
      userId,
      source: "single_upload" as const,
      idempotencyKey: `repository-scan-${randomUUID()}`,
    };
    const createdScan = await createOrGetScan(database.db, scanInput);
    const replayedScan = await createOrGetScan(database.db, scanInput);

    expect(createdScan.created).toBe(true);
    expect(replayedScan.created).toBe(false);
    expect(replayedScan.record.id).toBe(createdScan.record.id);

    const uploadInput = {
      userId,
      scanId: createdScan.record.id,
      idempotencyKey: `repository-upload-${randomUUID()}`,
      filename: "front.png",
      mimeType: "image/png" as const,
      sizeBytes: 512,
      checksumSha256: "b".repeat(64),
      maxImages: 12,
    };
    const createdUpload = await createOrGetImageUpload(
      database.db,
      uploadInput,
    );
    const replayedUpload = await createOrGetImageUpload(
      database.db,
      uploadInput,
    );

    expect(createdUpload.created).toBe(true);
    expect(replayedUpload.created).toBe(false);
    expect(replayedUpload.record.id).toBe(createdUpload.record.id);
  });

  it("stores a scan, completed image, and attempt audit row", async () => {
    const [scan] = await database.db
      .insert(scans)
      .values({
        userId,
        source: "camera",
        idempotencyKey: `scan-${randomUUID()}`,
      })
      .returning();

    expect(scan?.status).toBe("awaiting_upload");

    await database.db.insert(imageAssets).values({
      scanId: scan!.id,
      idempotencyKey: `image-${randomUUID()}`,
      objectKey: `${userId}/${scan!.id}/${randomUUID()}`,
      filename: "front-cover.jpg",
      viewType: "front",
      mimeType: "image/jpeg",
      sizeBytes: 1_024,
      checksumSha256: "a".repeat(64),
      completedAt: new Date(),
      width: 800,
      height: 800,
    });

    await database.db.insert(scanAttempts).values({
      scanId: scan!.id,
      attemptNumber: 1,
      status: "succeeded",
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
      providerResponseId: `response-${randomUUID()}`,
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      durationMs: 42,
      completedAt: new Date(),
    });

    const stored = await database.db.query.scans.findFirst({
      where: eq(scans.id, scan!.id),
    });

    expect(stored).toMatchObject({
      id: scan!.id,
      userId,
      source: "camera",
      status: "awaiting_upload",
    });
  });

  it("submits atomically, replays safely, and dispatches the outbox", async () => {
    const scan = await createOrGetScan(database.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `submit-scan-${randomUUID()}`,
    });
    const upload = await createOrGetImageUpload(database.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `submit-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1_024,
      checksumSha256: "c".repeat(64),
      maxImages: 12,
    });
    await completeImageUpload(database.db, {
      userId,
      scanId: scan.record.id,
      imageId: upload.record.id,
      width: 800,
      height: 800,
    });

    const idempotencyKey = `submit-${randomUUID()}`;
    const submitted = await submitScan(database.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey,
    });
    const replayed = await submitScan(database.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey,
    });

    expect(submitted.created).toBe(true);
    expect(submitted.record.status).toBe("queued");
    expect(submitted.job).toMatchObject({
      scanId: scan.record.id,
      userId,
      attemptNumber: 1,
      imageIds: [upload.record.id],
    });
    expect(replayed).toMatchObject({
      created: false,
      jobId: submitted.jobId,
    });

    const storedMessages = await database.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.aggregateId, scan.record.id));
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0]).toMatchObject({
      publishAttempts: 0,
      publishedAt: null,
      idempotencyKey: submitted.jobId,
    });

    const firstDispatchAt = new Date(Date.now() + 1_000);
    const deferred = await dispatchNextOutboxMessage(
      database.db,
      async () => {
        throw new Error("synthetic Redis outage");
      },
      firstDispatchAt,
    );
    expect(deferred).toMatchObject({
      status: "deferred",
      jobId: submitted.jobId,
    });

    const publishedJobs: Array<{ jobId: string; scanId: string }> = [];
    const published = await dispatchNextOutboxMessage(
      database.db,
      async (job, jobId) => {
        publishedJobs.push({ jobId, scanId: job.scanId });
      },
      new Date(firstDispatchAt.getTime() + 3_000),
    );
    expect(published).toMatchObject({
      status: "published",
      jobId: submitted.jobId,
    });
    expect(publishedJobs).toEqual([
      { jobId: submitted.jobId, scanId: scan.record.id },
    ]);

    const [publishedMessage] = await database.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.aggregateId, scan.record.id));
    expect(publishedMessage).toMatchObject({
      publishAttempts: 2,
      lastError: null,
    });
    expect(publishedMessage?.publishedAt).toBeInstanceOf(Date);
  });

  it("enforces per-user idempotency keys", async () => {
    const idempotencyKey = `duplicate-${randomUUID()}`;
    await database.db.insert(scans).values({
      userId,
      source: "single_upload",
      idempotencyKey,
    });

    await expect(
      database.db.insert(scans).values({
        userId,
        source: "single_upload",
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("rejects malformed checksums and invalid attempt numbers", async () => {
    const [scan] = await database.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        idempotencyKey: `constraints-${randomUUID()}`,
      })
      .returning();

    await expect(
      database.db.insert(imageAssets).values({
        scanId: scan!.id,
        idempotencyKey: `bad-image-${randomUUID()}`,
        objectKey: `${userId}/${scan!.id}/${randomUUID()}`,
        filename: "bad.jpg",
        viewType: "front",
        mimeType: "image/jpeg",
        sizeBytes: 50,
        checksumSha256: "not-a-sha-256-checksum".padEnd(64, "x"),
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    await expect(
      database.db.insert(scanAttempts).values({
        scanId: scan!.id,
        attemptNumber: 0,
        status: "processing",
        model: "integration-test-model",
        promptVersion: "integration-test.v1",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("confirms a reviewed result idempotently and converts a wishlist item", async () => {
    const [scan] = await database.db
      .insert(scans)
      .values({
        userId,
        source: "camera",
        status: "needs_review",
        idempotencyKey: `confirm-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    const [attempt] = await database.db
      .insert(scanAttempts)
      .values({
        scanId: scan!.id,
        attemptNumber: 1,
        status: "succeeded",
        model: "integration-test-model",
        promptVersion: "integration-test.v1",
        providerResponseId: `response-${randomUUID()}`,
        durationMs: 25,
        completedAt: new Date(),
      })
      .returning();
    const [candidate] = await database.db
      .insert(scanCandidates)
      .values({
        scanAttemptId: attempt!.id,
        rank: 1,
        artist: "Miles Davis",
        title: "Kind of Blue",
        releaseYear: 1959,
        label: "Columbia",
        catalogNumber: "CS 8163",
        barcode: null,
        confidence: 0.89,
        evidence: ["Artist and title are visible."],
        warnings: ["Pressing is not established from the cover."],
      })
      .returning();

    const idempotencyKey = `confirm-${randomUUID()}`;
    const confirmation = {
      userId,
      scanId: scan!.id,
      idempotencyKey,
      confirmation: {
        selectedCandidateId: candidate!.id,
        artist: "Miles Davis",
        title: "Kind of Blue",
        releaseYear: 1959,
        label: "Columbia",
        catalogNumber: "CS 8163",
        barcode: null,
        list: "wishlist" as const,
        notes: null,
      },
    };
    const created = await confirmScan(database.db, confirmation);
    const replayed = await confirmScan(database.db, confirmation);

    expect(created.created).toBe(true);
    expect(replayed.created).toBe(false);
    expect(replayed.record).toEqual(created.record);
    expect(created.record).toMatchObject({
      scanId: scan!.id,
      selectedCandidateId: candidate!.id,
      libraryItem: { list: "wishlist" },
      release: { artist: "Miles Davis", title: "Kind of Blue" },
    });

    const [secondScan] = await database.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `confirm-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await database.db.insert(scanAttempts).values({
      scanId: secondScan!.id,
      attemptNumber: 1,
      status: "succeeded",
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
      providerResponseId: `response-${randomUUID()}`,
      durationMs: 20,
      completedAt: new Date(),
    });
    const converted = await confirmScan(database.db, {
      ...confirmation,
      scanId: secondScan!.id,
      idempotencyKey: `confirm-${randomUUID()}`,
      confirmation: {
        ...confirmation.confirmation,
        selectedCandidateId: null,
        artist: "MILES DAVIS",
        list: "collection",
      },
    });

    expect(converted.record.release.id).toBe(created.record.release.id);
    expect(converted.record.release.artist).toBe("MILES DAVIS");
    expect(converted.record.libraryItem).toMatchObject({
      id: created.record.libraryItem.id,
      list: "collection",
    });
    await expect(
      getScanForUser(database.db, { userId, scanId: secondScan!.id }),
    ).resolves.toMatchObject({
      confirmation: {
        release: { artist: "MILES DAVIS", title: "Kind of Blue" },
        libraryItem: { list: "collection" },
      },
    });
    await expect(
      listLibraryItemsForUser(database.db, { userId, list: "collection" }),
    ).resolves.toMatchObject({
      list: "collection",
      items: [
        {
          id: created.record.libraryItem.id,
          release: { artist: "MILES DAVIS", title: "Kind of Blue" },
        },
      ],
    });
    expect(
      await database.db
        .select()
        .from(albums)
        .where(
          and(
            eq(albums.normalizedArtist, "miles davis"),
            eq(albums.normalizedTitle, "kind of blue"),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(libraryItems)
        .where(eq(libraryItems.userId, userId)),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(scanConfirmations)
        .where(eq(scanConfirmations.userId, userId)),
    ).toHaveLength(2);

    await expect(
      confirmScan(database.db, {
        ...confirmation,
        confirmation: {
          ...confirmation.confirmation,
          title: "Different title",
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
