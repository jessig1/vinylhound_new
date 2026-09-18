import { describe, expect, it } from "vitest";

import { requireOpenAiApiKey } from "./require-openai-key.ts";

describe("requireOpenAiApiKey", () => {
  it("throws when the key is undefined", () => {
    expect(() => requireOpenAiApiKey(undefined)).toThrow(/OPENAI_API_KEY/);
  });

  it("throws when the key is an empty string", () => {
    expect(() => requireOpenAiApiKey("")).toThrow(/OPENAI_API_KEY/);
  });

  it("does not throw for a configured key", () => {
    expect(() => requireOpenAiApiKey("sk-test")).not.toThrow();
  });
});
