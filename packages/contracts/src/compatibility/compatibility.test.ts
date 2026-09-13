import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as contracts from "../index.ts";
import { EVENT_CONTRACTS } from "../events.ts";
import { API_VERSION } from "../versioning.ts";
import {
  loadContractFixtures,
  resolveFixtureParser,
  type ContractFixture,
} from "./fixtures.ts";

/**
 * Backward compatibility (ADR-0022): every frozen wire sample a deployed
 * version produced or accepted must still be accepted by the contracts in
 * this tree. A failure here means a change broke a shape that a queued job,
 * an outbox row, a stale browser tab, or a rolled-back replica can still
 * send — either add the missing tolerance, or delete the fixture with the
 * decision recorded. The forward direction (previous consumers accepting
 * current payloads) is `npm run check:contracts`, which needs git.
 */

/**
 * Responses the browser bundle reads (`grep -r "parseResponse(" apps/web/src/
 * app`). The browser reads through the tolerant reader, so an added field is
 * harmless; a removed, renamed or retyped field still breaks any tab loaded
 * before the deploy until it reloads, so each must have a frozen sample that
 * makes such a change explicit.
 */
const BROWSER_PARSED_RESPONSES = [
  "CancelScanResponseSchema",
  "CompleteImageUploadResponseSchema",
  "ConfirmScanResponseSchema",
  "CreateBatchResponseSchema",
  "CreateScanResponseSchema",
  "DiscoveryAlbumDetailResponseSchema",
  "DiscoveryArtistDetailResponseSchema",
  "DiscoverySearchResponseSchema",
  "GetBatchResponseSchema",
  "GetFavoritesResponseSchema",
  "GetLibraryResponseSchema",
  "GetQuotaHeadroomResponseSchema",
  "GetScanResponseSchema",
  "PlaceLibraryReleaseResponseSchema",
  "RetryScanResponseSchema",
  "SearchCatalogReleasesResponseSchema",
  "SignedImageReadSchema",
  "SignedUploadSchema",
  "SubmitScanResponseSchema",
] as const;

const fixtures = loadContractFixtures();

function describeFailure(fixture: ContractFixture, error: unknown) {
  const detail =
    error instanceof z.ZodError ? z.prettifyError(error) : String(error);
  return `${fixture.path} (frozen ${fixture.frozenAt}: ${fixture.origin})\n${detail}`;
}

describe("contract fixtures", () => {
  it("exist for every registered event topic", () => {
    for (const topic of Object.keys(EVENT_CONTRACTS)) {
      expect(
        fixtures.filter((f) => f.kind === "event" && f.contract === topic),
        `no fixture under events/${topic}/`,
      ).not.toHaveLength(0);
    }
  });

  it("exist for every response the browser parses strictly", () => {
    for (const schema of BROWSER_PARSED_RESPONSES) {
      expect(
        fixtures.filter((f) => f.kind === "response" && f.contract === schema),
        `no fixture under http/${API_VERSION}/responses/${schema}/`,
      ).not.toHaveLength(0);
    }
  });

  it("only describe the HTTP version this tree serves", () => {
    for (const fixture of fixtures) {
      if (fixture.kind !== "event") {
        expect(fixture.apiVersion, fixture.path).toBe(API_VERSION);
      }
    }
  });

  it("only name topics the event registry knows", () => {
    for (const fixture of fixtures) {
      if (fixture.kind === "event") {
        expect(Object.keys(EVENT_CONTRACTS), fixture.path).toContain(
          fixture.contract,
        );
      }
    }
  });
});

describe.each(fixtures)("$path", (fixture) => {
  const parser = resolveFixtureParser(contracts, fixture);

  it("names a contract this tree exports", () => {
    expect(parser, `${fixture.contract} is not exported`).not.toBeNull();
  });

  it("is still accepted", () => {
    const result = parser!.safeParse(fixture.value);
    expect(result.success, describeFailure(fixture, result.error)).toBe(true);
  });

  if (fixture.kind === "response") {
    it("is exactly what the server emits, not a shape defaults rescue", () => {
      // A response leaves the server already parsed by its strict schema, so
      // a faithful sample round-trips unchanged through that strict schema —
      // not the tolerant reader, which would quietly drop a stray key.
      // Request fixtures may omit fields that defaults fill in, and are exempt.
      const strict = (contracts as Record<string, unknown>)[fixture.contract];
      expect(
        (strict as { parse(v: unknown): unknown }).parse(fixture.value),
      ).toEqual(fixture.value);
    });
  }

  if (fixture.kind === "event") {
    it("could be produced by this version as well as consumed", () => {
      const contract =
        EVENT_CONTRACTS[fixture.contract as keyof typeof EVENT_CONTRACTS];
      expect(contract.producerSchema.parse(fixture.value)).toEqual(
        fixture.value,
      );
    });
  }
});
