import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { CatalogReferenceSchema } from "./catalog.ts";
import { loadContractFixtures } from "./compatibility/fixtures.ts";
import { GetScanResponseSchema, type GetScanResponse } from "./scan.ts";
import { parseResponse, tolerant } from "./tolerant.ts";

const scanFixture = loadContractFixtures().find(
  (fixture) =>
    fixture.kind === "response" && fixture.contract === "GetScanResponseSchema",
)!;
const scan = scanFixture.value as GetScanResponse;

describe("tolerant", () => {
  it("strips unknown keys at every depth of a real response", () => {
    const fromNextVersion = {
      ...scan,
      pressing: "unknown",
      images: scan.images.map((image) => ({ ...image, sizeBytes: 1 })),
      attempt: {
        ...scan.attempt!,
        usage: { ...scan.attempt!.usage!, cachedTokens: 0 },
      },
      candidates: scan.candidates.map((candidate) => ({
        ...candidate,
        releaseGroupId: "x",
      })),
    };
    expect(GetScanResponseSchema.safeParse(fromNextVersion).success).toBe(
      false,
    );
    expect(parseResponse(GetScanResponseSchema, fromNextVersion)).toEqual(scan);
  });

  it("still validates every field it knows exactly as the strict schema does", () => {
    const reader = tolerant(GetScanResponseSchema);
    expect(() => reader.parse({ ...scan, status: "done" })).toThrow();
    expect(() => reader.parse({ ...scan, scanId: "not-a-uuid" })).toThrow();
    expect(() =>
      reader.parse({
        ...scan,
        candidates: [{ ...scan.candidates[0]!, confidence: 1.5 }],
      }),
    ).toThrow();
    expect(() => reader.parse({ ...scan, images: undefined })).toThrow();
  });

  it("keeps refinements — a Spotify reference still cannot claim a pressing", () => {
    const reader = tolerant(CatalogReferenceSchema);
    const spotify = {
      provider: "spotify",
      releaseGroupId: "4sb0eMpDn3upAFfyi4q2rw",
      releaseId: null,
      sourceUrl: "https://open.spotify.com/album/4sb0eMpDn3upAFfyi4q2rw",
      fetchedAt: "2026-09-12T09:30:00.000Z",
    };
    expect(reader.parse({ ...spotify, popularity: 70 })).toEqual(spotify);
    expect(() =>
      reader.parse({ ...spotify, releaseId: "4sb0eMpDn3upAFfyi4q2rw" }),
    ).toThrow(/pressing/);
  });

  it("does not mutate the strict schema and memoizes the reader", () => {
    const reader = tolerant(GetScanResponseSchema);
    expect(reader).not.toBe(GetScanResponseSchema);
    expect(tolerant(GetScanResponseSchema)).toBe(reader);
    expect(
      GetScanResponseSchema.safeParse({ ...scan, pressing: "unknown" }).success,
    ).toBe(false);
  });

  it("walks arrays, wrappers, records, unions, tuples, pipes and lazies", () => {
    const item = z.object({ id: z.number() }).strict();
    const schema = z
      .object({
        list: z.array(item),
        maybe: item.nullable(),
        given: item.optional().default({ id: 0 }),
        byKey: z.record(z.string(), item),
        either: z.union([item, z.literal("none")]),
        pair: z.tuple([item, z.string()]),
        piped: item.transform((value) => value.id),
        nested: z.lazy(() => item),
        ro: item.readonly(),
      })
      .strict();
    const value = {
      list: [{ id: 1, extra: true }],
      maybe: { id: 2, extra: true },
      given: { id: 3, extra: true },
      byKey: { a: { id: 4, extra: true } },
      either: { id: 5, extra: true },
      pair: [{ id: 6, extra: true }, "x"],
      piped: { id: 7, extra: true },
      nested: { id: 8, extra: true },
      ro: { id: 9, extra: true },
      extra: true,
    };
    expect(schema.safeParse(value).success).toBe(false);
    expect(tolerant(schema).parse(value)).toEqual({
      list: [{ id: 1 }],
      maybe: { id: 2 },
      given: { id: 3 },
      byKey: { a: { id: 4 } },
      either: { id: 5 },
      pair: [{ id: 6 }, "x"],
      piped: 7,
      nested: { id: 8 },
      ro: { id: 9 },
    });
  });

  it("returns a leaf schema unchanged", () => {
    const leaf = z.string().min(1);
    expect(tolerant(leaf)).toBe(leaf);
  });

  it("infers the strict schema's output type", () => {
    expectTypeOf(
      parseResponse(GetScanResponseSchema, scan),
    ).toEqualTypeOf<GetScanResponse>();
  });
});
