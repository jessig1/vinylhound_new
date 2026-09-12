import { describe, expect, it } from "vitest";

import { resolveFavoritedAt } from "./favorites.ts";

describe("favorite resolution", () => {
  const first = new Date("2026-09-01T00:00:00.000Z");
  const later = new Date("2026-09-12T00:00:00.000Z");

  it("stamps the first favorite with the current time", () => {
    expect(resolveFavoritedAt(null, true, later)).toEqual(later);
  });

  it("keeps the original moment when a favorite is repeated", () => {
    expect(resolveFavoritedAt(first, true, later)).toEqual(first);
  });

  it("clears the favorite and treats a repeated clear as a no-op", () => {
    expect(resolveFavoritedAt(first, false, later)).toBeNull();
    expect(resolveFavoritedAt(null, false, later)).toBeNull();
  });
});
