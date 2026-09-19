import { describe, expect, it } from "vitest";

import { signServiceRequest } from "@vinylhound/service-auth";
import {
  CatalogProviderError,
  DiscoveryProviderError,
} from "@vinylhound/catalog";

import { HttpError, errorResponse, requireServiceUserId } from "./http.ts";

const SECRET = "correct-horse-battery-staple-correct-horse";
const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function requestWithAuth(authorization: string | null) {
  const headers = new Headers();
  if (authorization !== null) headers.set("authorization", authorization);
  return new Request("http://discovery.internal/internal/v1/catalog/releases", {
    headers,
  });
}

describe("requireServiceUserId", () => {
  it("accepts a valid Bearer token and returns its userId", () => {
    const token = signServiceRequest(SECRET, { userId });
    const request = requestWithAuth(`Bearer ${token}`);
    expect(requireServiceUserId(request, SECRET)).toBe(userId);
  });

  it("rejects a missing Authorization header", () => {
    const request = requestWithAuth(null);
    expect(() => requireServiceUserId(request, SECRET)).toThrow(HttpError);
  });

  it("rejects a token signed with the wrong secret", () => {
    const token = signServiceRequest("a-different-secret-entirely", {
      userId,
    });
    const request = requestWithAuth(`Bearer ${token}`);
    try {
      requireServiceUserId(request, SECRET);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(401);
    }
  });

  it("rejects a header with no Bearer prefix", () => {
    const token = signServiceRequest(SECRET, { userId });
    const request = requestWithAuth(token);
    expect(() => requireServiceUserId(request, SECRET)).toThrow(HttpError);
  });
});

describe("errorResponse", () => {
  it("maps an HttpError to its own status and code", async () => {
    const response = errorResponse(
      new HttpError(400, "invalid_request", "bad"),
      "11111111-1111-4111-8111-111111111111",
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("maps a CatalogProviderError to catalog_<category> with the shared status", async () => {
    const response = errorResponse(
      new CatalogProviderError("rate_limit", true, "slow down"),
      "22222222-2222-4222-8222-222222222222",
    );
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("catalog_rate_limit");
  });

  it("maps a DiscoveryProviderError to discovery_<category> with the shared status", async () => {
    const response = errorResponse(
      new DiscoveryProviderError("not_configured", false, "no spotify"),
      "33333333-3333-4333-8333-333333333333",
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("discovery_not_configured");
  });

  it("maps an unknown error to a generic 500", async () => {
    const response = errorResponse(
      new Error("boom"),
      "44444444-4444-4444-8444-444444444444",
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal_error");
  });
});
