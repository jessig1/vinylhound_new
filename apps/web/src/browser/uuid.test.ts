import { webcrypto } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createUuid } from "./uuid";

afterEach(() => vi.unstubAllGlobals());

describe("createUuid", () => {
  it("uses the native method with its Crypto receiver when available", () => {
    const native = vi.fn(function (this: unknown) {
      expect(this).toBe(browserCrypto);
      return "a51b64cc-2ff3-4cbd-9852-df1d443d75cf";
    });
    const browserCrypto = { randomUUID: native };
    vi.stubGlobal("crypto", browserCrypto);

    expect(createUuid()).toBe("a51b64cc-2ff3-4cbd-9852-df1d443d75cf");
    expect(native).toHaveBeenCalledOnce();
  });

  it("preserves random bytes while setting UUID version and variant", () => {
    const browserCrypto = {
      getRandomValues(array: Uint8Array) {
        expect(this).toBe(browserCrypto);
        return array.fill(0xff);
      },
    };
    vi.stubGlobal("crypto", browserCrypto);

    expect(createUuid()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("draws fresh secure entropy for every fallback ID", () => {
    const randomBytes = vi.fn(webcrypto.getRandomValues.bind(webcrypto));
    vi.stubGlobal("crypto", { getRandomValues: randomBytes });

    const ids = Array.from({ length: 32 }, () => createUuid());
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(randomBytes).toHaveBeenCalledTimes(ids.length);
  });
});
