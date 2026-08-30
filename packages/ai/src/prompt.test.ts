import { describe, expect, it } from "vitest";

import {
  ALBUM_IDENTIFICATION_INSTRUCTIONS,
  ALBUM_IDENTIFICATION_PROMPT_VERSION,
} from "./prompt.js";

describe("album identification prompt", () => {
  it("prioritizes a best-effort artist/title result", () => {
    expect(ALBUM_IDENTIFICATION_PROMPT_VERSION).toBe("album-identification.v2");
    expect(ALBUM_IDENTIFICATION_INSTRUCTIONS).toContain(
      "always return the strongest artist/title candidate",
    );
    expect(ALBUM_IDENTIFICATION_INSTRUCTIONS).toContain(
      "Return no candidates only when artist and title cannot be reasonably inferred",
    );
  });

  it("does not turn missing edition facts into album review reasons", () => {
    expect(ALBUM_IDENTIFICATION_INSTRUCTIONS).toContain(
      "Never add a review reason solely because the pressing, edition",
    );
    expect(ALBUM_IDENTIFICATION_INSTRUCTIONS).toContain(
      "Put edition uncertainty in candidate warnings instead",
    );
  });
});
