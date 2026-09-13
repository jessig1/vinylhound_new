import { describe, expect, it } from "vitest";

import { decodeLibraryCursor, encodeLibraryCursor } from "./library-cursor.ts";
import { DatabaseCommandError } from "./scan-repository.ts";

describe("library cursor", () => {
  it("round-trips a sort key under the sort it was issued for", () => {
    const key = [
      "2026-09-12T10:11:12.123456Z",
      "00000000-0000-4000-8000-000000000001",
    ];
    const cursor = encodeLibraryCursor("recent", key);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLibraryCursor(cursor, "recent")).toEqual(key);
  });

  it("keeps a key exactly, including characters that are not URL-safe", () => {
    const key = ["björk / ¡sugarcubes! 100%_?&=", "début", "id"];
    expect(
      decodeLibraryCursor(encodeLibraryCursor("artist", key), "artist"),
    ).toEqual(key);
  });

  it("rejects a cursor issued under a different sort", () => {
    const cursor = encodeLibraryCursor("artist", ["a", "b", "c"]);
    expect(decodeLibraryCursor(cursor, "artist")).toEqual(["a", "b", "c"]);
    expect(() => decodeLibraryCursor(cursor, "title")).toThrow(
      DatabaseCommandError,
    );
    expect(() =>
      decodeLibraryCursor(encodeLibraryCursor("title", ["a", "b"]), "title"),
    ).toThrow(/could not be read/);
    try {
      decodeLibraryCursor(cursor, "recent");
    } catch (error) {
      expect((error as DatabaseCommandError).code).toBe("invalid_cursor");
    }
  });

  it("rejects cursors it cannot read", () => {
    const malformed = [
      "not base64 json",
      Buffer.from("[]").toString("base64url"),
      Buffer.from(
        JSON.stringify({ v: 2, sort: "recent", key: ["a", "b"] }),
      ).toString("base64url"),
      Buffer.from(
        JSON.stringify({ v: 1, sort: "cost", key: ["a", "b"] }),
      ).toString("base64url"),
      Buffer.from(
        JSON.stringify({ v: 1, sort: "recent", key: ["a"] }),
      ).toString("base64url"),
      // A name-sort key has three parts; two would bind a null id.
      Buffer.from(
        JSON.stringify({ v: 1, sort: "recent", key: ["a", "b", "c"] }),
      ).toString("base64url"),
      Buffer.from(
        JSON.stringify({ v: 1, sort: "recent", key: [1, 2] }),
      ).toString("base64url"),
      Buffer.from(
        JSON.stringify({ v: 1, sort: "recent", key: ["a", "b"], extra: 1 }),
      ).toString("base64url"),
    ];
    for (const cursor of malformed) {
      expect(() => decodeLibraryCursor(cursor, "recent"), cursor).toThrow(
        /could not be read/,
      );
    }
  });
});
