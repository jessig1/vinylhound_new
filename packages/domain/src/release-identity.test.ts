import { describe, expect, it } from "vitest";

import {
  normalizeOptionalReleaseIdentityPart,
  normalizeReleaseIdentityPart,
} from "./release-identity.js";

describe("release identity normalization", () => {
  it("normalizes case, compatibility characters, punctuation, and whitespace", () => {
    expect(normalizeReleaseIdentityPart("  Björk — Debut (1993)  ")).toBe(
      "björk debut 1993",
    );
    expect(normalizeReleaseIdentityPart("ＡＢＢＥＹ  ROAD")).toBe("abbey road");
  });

  it("preserves absent optional facts", () => {
    expect(normalizeOptionalReleaseIdentityPart(null)).toBeNull();
  });
});
