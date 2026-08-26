import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AlbumIdentificationError, type AlbumIdentifier } from "@vinylhound/ai";
import {
  GetScanResponseSchema,
  type AlbumIdentification,
} from "@vinylhound/contracts";
import {
  completeImageUpload,
  createDatabase,
  createOrGetImageUpload,
  createOrGetScan,
  getScanForUser,
  submitScan,
  users,
} from "@vinylhound/database";
import type { ObjectStorage } from "@vinylhound/storage";

import { createScanAnalysisHandler } from "./analysis-handler.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for worker integration tests.");
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

const storage: ObjectStorage = {
  async readObject() {
    return {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg",
      sizeBytes: 3,
    };
  },
  async createSignedUpload() {
    throw new Error("Not used by scan analysis tests.");
  },
  async createSignedReadUrl() {
    throw new Error("Not used by scan analysis tests.");
  },
  async deleteObject() {},
};

function identification(
  overrides: Partial<AlbumIdentification> = {},
): AlbumIdentification {
  return {
    candidates: [
      {
        artist: "Miles Davis",
        title: "Kind of Blue",
        releaseYear: 1959,
        label: "Columbia",
        catalogNumber: null,
        barcode: null,
        confidence: 0.98,
        evidence: ["Artist and title are visible."],
        warnings: [],
      },
    ],
    observations: ["Blue cover treatment."],
    needsReviewReasons: [],
    ...overrides,
  };
}

function successfulIdentifier(
  result = identification(),
  onIdentify?: () => void,
): AlbumIdentifier {
  return {
    async identify() {
      onIdentify?.();
      return {
        identification: result,
        metadata: {
          provider: "openai",
          model: "integration-model-2026-08-25",
          promptVersion: "album-identification.integration.v1",
          providerResponseId: `response-${randomUUID()}`,
          usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
        },
      };
    },
  };
}

async function createQueuedScan() {
  const scan = await createOrGetScan(database.db, {
    userId,
    source: "single_upload",
    idempotencyKey: `worker-scan-${randomUUID()}`,
  });
  const upload = await createOrGetImageUpload(database.db, {
    userId,
    scanId: scan.record.id,
    idempotencyKey: `worker-upload-${randomUUID()}`,
    filename: "front.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 3,
    checksumSha256: "d".repeat(64),
    maxImages: 12,
  });
  await completeImageUpload(database.db, {
    userId,
    scanId: scan.record.id,
    imageId: upload.record.id,
    width: 800,
    height: 800,
  });
  return submitScan(database.db, {
    userId,
    scanId: scan.record.id,
    idempotencyKey: `worker-submit-${randomUUID()}`,
  });
}

function handler(identifier: AlbumIdentifier) {
  return createScanAnalysisHandler({
    database: database.db,
    storage,
    identifier,
    configuredModel: "integration-model",
    promptVersion: "album-identification.integration.v1",
  });
}

describe("scan analysis handler", () => {
  it("persists a successful result and skips succeeded redelivery", async () => {
    const submitted = await createQueuedScan();
    let identifyCalls = 0;
    const analyze = handler(
      successfulIdentifier(identification(), () => {
        identifyCalls += 1;
      }),
    );
    const delivery = {
      jobId: submitted.jobId,
      deliveryAttempt: 1,
      maxAttempts: 5,
    };

    await analyze(submitted.job, delivery);
    await analyze(submitted.job, delivery);

    const status = await getScanForUser(database.db, {
      userId,
      scanId: submitted.record.id,
    });
    expect(() => GetScanResponseSchema.parse(status)).not.toThrow();
    expect(identifyCalls).toBe(1);
    expect(status).toMatchObject({
      status: "identified",
      attempt: {
        status: "succeeded",
        deliveryAttempt: 1,
        outcomeReason: "high_confidence_clear_lead",
        usage: { totalTokens: 125 },
      },
      candidates: [{ rank: 1, artist: "Miles Davis", title: "Kind of Blue" }],
    });
  });

  it("routes explicit uncertainty to user review", async () => {
    const submitted = await createQueuedScan();
    const analyze = handler(
      successfulIdentifier(
        identification({
          needsReviewReasons: [
            "A front cover cannot establish the specific pressing.",
          ],
        }),
      ),
    );

    await analyze(submitted.job, {
      jobId: submitted.jobId,
      deliveryAttempt: 1,
      maxAttempts: 5,
    });

    const status = await getScanForUser(database.db, {
      userId,
      scanId: submitted.record.id,
    });
    expect(status.status).toBe("needs_review");
    expect(status.attempt?.outcomeReason).toBe("provider_review_reason");
  });

  it("records transient deliveries and succeeds on retry", async () => {
    const submitted = await createQueuedScan();
    let calls = 0;
    const identifier: AlbumIdentifier = {
      async identify() {
        calls += 1;
        if (calls === 1) {
          throw new AlbumIdentificationError(
            "rate_limit",
            true,
            "The image analysis provider is temporarily rate limited.",
          );
        }
        return successfulIdentifier().identify({
          scanId: submitted.record.id,
          imageUrls: ["data:image/jpeg;base64,AQID"],
        });
      },
    };
    const analyze = handler(identifier);

    await expect(
      analyze(submitted.job, {
        jobId: submitted.jobId,
        deliveryAttempt: 1,
        maxAttempts: 2,
      }),
    ).rejects.toMatchObject({ category: "rate_limit", retryable: true });
    expect(
      (
        await getScanForUser(database.db, {
          userId,
          scanId: submitted.record.id,
        })
      ).status,
    ).toBe("queued");

    await analyze(submitted.job, {
      jobId: submitted.jobId,
      deliveryAttempt: 2,
      maxAttempts: 2,
    });
    const status = await getScanForUser(database.db, {
      userId,
      scanId: submitted.record.id,
    });
    expect(status.status).toBe("identified");
    expect(status.attempt?.deliveryAttempt).toBe(2);
  });

  it("makes a terminal provider error visible without retrying", async () => {
    const submitted = await createQueuedScan();
    const analyze = handler({
      async identify() {
        throw new AlbumIdentificationError(
          "refusal",
          false,
          "The image analysis request was refused.",
        );
      },
    });

    await analyze(submitted.job, {
      jobId: submitted.jobId,
      deliveryAttempt: 1,
      maxAttempts: 5,
    });
    const status = await getScanForUser(database.db, {
      userId,
      scanId: submitted.record.id,
    });
    expect(status).toMatchObject({
      status: "failed",
      attempt: {
        status: "failed",
        error: {
          category: "refusal",
          message: "The image analysis request was refused.",
        },
      },
      candidates: [],
    });
  });
});
