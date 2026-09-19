import { describe, expect, it } from "vitest";

import { createBoundedCache } from "./bounded-cache.ts";

describe("createBoundedCache", () => {
  it("returns a stored value before it expires", () => {
    let clock = 0;
    const cache = createBoundedCache<string>({
      maxEntries: 10,
      ttlMs: 1_000,
      now: () => clock,
    });

    cache.set("a", "value-a");
    clock = 999;

    expect(cache.get("a")).toBe("value-a");
  });

  it("drops a value once its TTL has elapsed", () => {
    let clock = 0;
    const cache = createBoundedCache<string>({
      maxEntries: 10,
      ttlMs: 1_000,
      now: () => clock,
    });

    cache.set("a", "value-a");
    clock = 1_000;

    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts the least-recently-used entry once maxEntries is exceeded", () => {
    const cache = createBoundedCache<string>({
      maxEntries: 2,
      ttlMs: 1_000,
      now: () => 0,
    });

    cache.set("a", "value-a");
    cache.set("b", "value-b");
    cache.set("c", "value-c");

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("value-b");
    expect(cache.get("c")).toBe("value-c");
  });

  it("a get touches an entry, protecting it from eviction over an older, unread one", () => {
    const cache = createBoundedCache<string>({
      maxEntries: 2,
      ttlMs: 1_000,
      now: () => 0,
    });

    cache.set("a", "value-a");
    cache.set("b", "value-b");
    cache.get("a");
    cache.set("c", "value-c");

    expect(cache.get("a")).toBe("value-a");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("value-c");
  });

  it("re-setting an existing key refreshes its recency, protecting it over an older key", () => {
    const cache = createBoundedCache<string>({
      maxEntries: 2,
      ttlMs: 1_000,
      now: () => 0,
    });

    cache.set("a", "value-a");
    cache.set("b", "value-b");
    cache.set("a", "value-a2");
    cache.set("c", "value-c");

    expect(cache.get("a")).toBe("value-a2");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("value-c");
  });
});
