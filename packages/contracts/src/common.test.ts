import { describe, expect, it } from "vitest";

import { CORRELATION_ID_MAX_LENGTH, CorrelationIdSchema } from "./common.ts";

describe("CorrelationIdSchema", () => {
  it("accepts a bounded alphanumeric identifier", () => {
    expect(CorrelationIdSchema.parse("abc-123_XYZ.789")).toBe(
      "abc-123_XYZ.789",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(CorrelationIdSchema.parse("  trace-1  ")).toBe("trace-1");
  });

  it("rejects an empty value", () => {
    expect(() => CorrelationIdSchema.parse("")).toThrow();
    expect(() => CorrelationIdSchema.parse("   ")).toThrow();
  });

  it("rejects a value beyond the maximum length", () => {
    expect(() =>
      CorrelationIdSchema.parse("a".repeat(CORRELATION_ID_MAX_LENGTH + 1)),
    ).toThrow();
    expect(
      CorrelationIdSchema.parse("a".repeat(CORRELATION_ID_MAX_LENGTH)),
    ).toHaveLength(CORRELATION_ID_MAX_LENGTH);
  });

  it("rejects characters outside the allowed set, such as an attempted header/log injection", () => {
    expect(() => CorrelationIdSchema.parse("trace\n1")).toThrow();
    expect(() => CorrelationIdSchema.parse("trace 1")).toThrow();
    expect(() => CorrelationIdSchema.parse("trace,1")).toThrow();
  });
});
