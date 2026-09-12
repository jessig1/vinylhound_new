import { describe, expect, it } from "vitest";

import {
  AccountExportResponseSchema,
  DeleteAccountResponseSchema,
} from "./account.ts";

describe("AccountExportResponseSchema", () => {
  it("accepts an export with no data beyond the account itself", () => {
    expect(
      AccountExportResponseSchema.parse({
        exportedAt: "2026-08-31T00:00:00.000Z",
        account: {
          id: "00000000-0000-4000-8000-000000000001",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        batches: [],
        scans: [],
        images: [],
        attempts: [],
        confirmations: [],
        libraryItems: [],
        libraryCopies: [],
      }),
    ).toMatchObject({
      account: { id: "00000000-0000-4000-8000-000000000001" },
    });
  });

  it("accepts a populated scan and confirmation", () => {
    const parsed = AccountExportResponseSchema.parse({
      exportedAt: "2026-08-31T00:00:00.000Z",
      account: {
        id: "00000000-0000-4000-8000-000000000001",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      batches: [],
      scans: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          batchId: null,
          source: "single_upload",
          status: "identified",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          submittedAt: "2026-08-01T00:00:00.000Z",
          completedAt: "2026-08-01T00:00:01.000Z",
        },
      ],
      images: [],
      attempts: [],
      confirmations: [
        {
          scanId: "00000000-0000-4000-8000-000000000002",
          libraryItemId: "00000000-0000-4000-8000-000000000003",
          releaseId: "00000000-0000-4000-8000-000000000004",
          artist: "Miles Davis",
          title: "Kind of Blue",
          list: "collection",
          confirmedAt: "2026-08-01T00:00:02.000Z",
        },
      ],
      libraryItems: [],
      libraryCopies: [],
    });

    expect(parsed.confirmations[0]).toMatchObject({ artist: "Miles Davis" });
  });

  it("rejects an export with an unknown extra field", () => {
    const result = AccountExportResponseSchema.safeParse({
      exportedAt: "2026-08-31T00:00:00.000Z",
      account: {
        id: "00000000-0000-4000-8000-000000000001",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      batches: [],
      scans: [],
      images: [],
      attempts: [],
      confirmations: [],
      libraryItems: [],
      libraryCopies: [],
      extra: "not allowed",
    });

    expect(result.success).toBe(false);
  });
});

describe("DeleteAccountResponseSchema", () => {
  it("accepts a deleted account id", () => {
    expect(
      DeleteAccountResponseSchema.parse({
        id: "00000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({ id: "00000000-0000-4000-8000-000000000001" });
  });
});
