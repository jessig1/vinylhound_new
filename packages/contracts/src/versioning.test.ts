import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { EVENT_CONTRACTS, getEventContract } from "./events.ts";
import {
  ANALYZE_SCAN_JOB,
  ANALYZE_SCAN_JOB_CONTRACT,
  AnalyzeScanJobSchema,
  type AnalyzeScanJob,
} from "./scan.ts";
import {
  API_BASE_PATH,
  API_VERSION,
  defineEventContract,
  formatEventTopic,
  parseEventTopic,
} from "./versioning.ts";

const job: AnalyzeScanJob = {
  jobVersion: 1,
  scanId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  attemptNumber: 1,
  imageIds: ["00000000-0000-4000-8000-000000000003"],
  requestedAt: "2026-01-01T00:00:00.000Z",
};

describe("API_VERSION", () => {
  it("is the path prefix every route is served under", () => {
    expect(API_BASE_PATH).toBe(`/api/${API_VERSION}`);
    expect(API_VERSION).toBe("v1");
  });
});

describe("parseEventTopic", () => {
  it("splits <aggregate>.<action>.v<N> and reads the integer version", () => {
    expect(parseEventTopic("scan.analyze.v1")).toEqual({
      aggregate: "scan",
      action: "analyze",
      version: 1,
    });
    expect(parseEventTopic("library_item.placed.v12").version).toBe(12);
  });

  it.each([
    "scan.analyze",
    "scan.analyze.v0",
    "scan.analyze.v1.2",
    "Scan.analyze.v1",
    "scan.analyze.1",
    "scan-analyze.v1",
    "",
  ])("rejects %j", (topic) => {
    expect(() => parseEventTopic(topic)).toThrow(/must match/);
  });

  it("round-trips through formatEventTopic", () => {
    const parts = parseEventTopic(ANALYZE_SCAN_JOB);
    expect(formatEventTopic(parts)).toBe(ANALYZE_SCAN_JOB);
    expect(() =>
      formatEventTopic({ aggregate: "Scan", action: "analyze", version: 1 }),
    ).toThrow();
  });
});

describe("defineEventContract", () => {
  const schema = z
    .object({ eventVersion: z.literal(2), id: z.string() })
    .strict();

  it("derives the version from the topic and exposes strict and tolerant schemas", () => {
    const contract = defineEventContract({
      topic: "thing.happened.v2",
      versionField: "eventVersion",
      schema,
    });
    expect(contract).toMatchObject({
      aggregate: "thing",
      action: "happened",
      version: 2,
      versionField: "eventVersion",
    });
    expect(contract.producerSchema).toBe(schema);

    const extended = { eventVersion: 2, id: "a", addedLater: true };
    expect(contract.producerSchema.safeParse(extended).success).toBe(false);
    expect(contract.consumerSchema.parse(extended)).toEqual({
      eventVersion: 2,
      id: "a",
    });
  });

  it("refuses a payload version that disagrees with the topic", () => {
    expect(() =>
      defineEventContract({
        topic: "thing.happened.v3",
        versionField: "eventVersion",
        schema,
      }),
    ).toThrow(/z\.literal\(3\)/);
  });

  it("refuses a version field that is not a single literal", () => {
    expect(() =>
      defineEventContract({
        topic: "thing.happened.v2",
        versionField: "eventVersion",
        schema: z.object({ eventVersion: z.number() }).strict(),
      }),
    ).toThrow(/z\.literal\(2\)/);
    expect(() =>
      defineEventContract({
        topic: "thing.happened.v2",
        versionField: "eventVersion",
        schema: z.object({ eventVersion: z.literal([2, 3]) }).strict(),
      }),
    ).toThrow(/z\.literal\(2\)/);
  });

  it("keeps refinements on the consumer schema, only unknown keys are dropped", () => {
    const contract = defineEventContract({
      topic: "thing.happened.v1",
      versionField: "v",
      schema: z
        .object({ v: z.literal(1), n: z.number() })
        .strict()
        .refine((value) => value.n > 0, { message: "n must be positive" }),
    });
    expect(() => contract.consumerSchema.parse({ v: 1, n: 0 })).toThrow(
      /positive/,
    );
  });
});

describe("scan.analyze.v1", () => {
  it("is registered with a version that matches its jobVersion literal", () => {
    expect(getEventContract(ANALYZE_SCAN_JOB)).toBe(ANALYZE_SCAN_JOB_CONTRACT);
    expect(ANALYZE_SCAN_JOB_CONTRACT.version).toBe(1);
    expect(ANALYZE_SCAN_JOB_CONTRACT.producerSchema).toBe(AnalyzeScanJobSchema);
    expect(AnalyzeScanJobSchema.parse(job).jobVersion).toBe(
      ANALYZE_SCAN_JOB_CONTRACT.version,
    );
  });

  it("consumes a payload extended by a newer producer, dropping what it does not know", () => {
    const fromNextVersion = { ...job, traceBaggage: { hop: 1 } };
    expect(() => AnalyzeScanJobSchema.parse(fromNextVersion)).toThrow();
    expect(
      ANALYZE_SCAN_JOB_CONTRACT.consumerSchema.parse(fromNextVersion),
    ).toEqual(job);
  });

  it("still rejects a known field with an invalid value on the consumer side", () => {
    expect(() =>
      ANALYZE_SCAN_JOB_CONTRACT.consumerSchema.parse({
        ...job,
        correlationId: "",
      }),
    ).toThrow();
    expect(() =>
      ANALYZE_SCAN_JOB_CONTRACT.consumerSchema.parse({ ...job, jobVersion: 2 }),
    ).toThrow();
  });

  it("infers the same payload type for producers and consumers", () => {
    expectTypeOf(
      ANALYZE_SCAN_JOB_CONTRACT.consumerSchema.parse(job),
    ).toEqualTypeOf<AnalyzeScanJob>();
  });

  it("is the only registered topic today", () => {
    expect(Object.keys(EVENT_CONTRACTS)).toEqual([ANALYZE_SCAN_JOB]);
    expect(getEventContract("scan.analyze.v2")).toBeUndefined();
  });
});
