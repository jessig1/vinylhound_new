import { describe, expect, it } from "vitest";

import { MAX_LIBRARY_COPIES_PER_ITEM } from "@vinylhound/contracts";

import { resolveCopyAddition } from "./library-copies.ts";

describe("copy addition", () => {
  it("allows a collection record to take a first, second, or hundredth copy", () => {
    expect(resolveCopyAddition("collection", 0)).toEqual({ status: "allowed" });
    expect(resolveCopyAddition("collection", 1)).toEqual({ status: "allowed" });
    expect(
      resolveCopyAddition("collection", MAX_LIBRARY_COPIES_PER_ITEM - 1),
    ).toEqual({ status: "allowed" });
  });

  it("rejects a copy on a wishlist record whatever its count", () => {
    expect(resolveCopyAddition("wishlist", 0)).toEqual({
      status: "rejected",
      reason: "wishlist",
    });
  });

  it("rejects a copy past the per-record cap", () => {
    expect(
      resolveCopyAddition("collection", MAX_LIBRARY_COPIES_PER_ITEM),
    ).toEqual({ status: "rejected", reason: "capacity" });
  });
});
