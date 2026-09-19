import { describe, expect, it } from "vitest";

import {
  ServiceAuthError,
  formatServiceAuthHeader,
  parseServiceAuthHeader,
  signServiceRequest,
  verifyServiceRequest,
} from "./index.ts";

const SECRET = "correct-horse-battery-staple-correct-horse";
const USER_ID = "11111111-1111-4111-8111-111111111111";

describe("service-auth", () => {
  it("round-trips a valid token", () => {
    const token = signServiceRequest(SECRET, { userId: USER_ID });
    expect(verifyServiceRequest(SECRET, token)).toEqual({ userId: USER_ID });
  });

  it("formats and parses the Authorization header", () => {
    const token = signServiceRequest(SECRET, { userId: USER_ID });
    expect(parseServiceAuthHeader(formatServiceAuthHeader(token))).toBe(token);
  });

  it("rejects a missing token", () => {
    expect(() => verifyServiceRequest(SECRET, null)).toThrow(ServiceAuthError);
    try {
      verifyServiceRequest(SECRET, undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceAuthError);
      expect((error as ServiceAuthError).reason).toBe("missing");
    }
  });

  it("rejects a malformed token", () => {
    for (const malformed of ["not-a-token", "one.two.three", "."]) {
      try {
        verifyServiceRequest(SECRET, malformed);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceAuthError);
        expect((error as ServiceAuthError).reason).toBe("malformed");
      }
    }
  });

  it("rejects a token signed with a different secret", () => {
    const token = signServiceRequest("a-different-secret-entirely-here", {
      userId: USER_ID,
    });
    try {
      verifyServiceRequest(SECRET, token);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceAuthError);
      expect((error as ServiceAuthError).reason).toBe("invalid_signature");
    }
  });

  it("rejects a token whose payload was tampered with after signing", () => {
    const token = signServiceRequest(SECRET, { userId: USER_ID });
    const [, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        sub: "attacker-controlled-user-id",
        iat: 0,
        exp: 9_999_999_999,
      }),
    ).toString("base64url");
    try {
      verifyServiceRequest(SECRET, `${tamperedPayload}.${signature}`);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceAuthError);
      expect((error as ServiceAuthError).reason).toBe("invalid_signature");
    }
  });

  it("rejects an expired token", () => {
    let clock = Date.parse("2026-09-18T12:00:00.000Z");
    const token = signServiceRequest(
      SECRET,
      { userId: USER_ID },
      { now: () => clock, ttlSeconds: 30 },
    );
    clock += 31_000;
    try {
      verifyServiceRequest(SECRET, token, { now: () => clock });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceAuthError);
      expect((error as ServiceAuthError).reason).toBe("expired");
    }
  });

  it("accepts a token right at its expiry boundary", () => {
    let clock = Date.parse("2026-09-18T12:00:00.000Z");
    const token = signServiceRequest(
      SECRET,
      { userId: USER_ID },
      { now: () => clock, ttlSeconds: 30 },
    );
    clock += 30_000;
    expect(verifyServiceRequest(SECRET, token, { now: () => clock })).toEqual({
      userId: USER_ID,
    });
  });
});
