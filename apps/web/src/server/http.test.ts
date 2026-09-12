import { describe, expect, it } from "vitest";

import { parseCorrelationId } from "./http.ts";

function requestWithHeader(value: string | null) {
  const headers = new Headers();
  if (value !== null) {
    headers.set("x-request-id", value);
  }
  return new Request("https://example.test/api/v1/scans", { headers });
}

describe("parseCorrelationId", () => {
  it("returns undefined when the caller sent no header", () => {
    expect(parseCorrelationId(requestWithHeader(null))).toBeUndefined();
  });

  it("accepts a well-formed inbound trace value", () => {
    expect(parseCorrelationId(requestWithHeader("trace-123"))).toBe(
      "trace-123",
    );
  });

  it("drops a malformed value instead of rejecting the request", () => {
    expect(
      parseCorrelationId(requestWithHeader("has a space")),
    ).toBeUndefined();
    expect(parseCorrelationId(requestWithHeader(""))).toBeUndefined();
  });
});
