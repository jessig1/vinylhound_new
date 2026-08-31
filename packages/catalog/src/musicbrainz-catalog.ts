import { z } from "zod";

import {
  CatalogReleaseCandidateSchema,
  type CatalogReleaseCandidate,
} from "@vinylhound/contracts";

import {
  CatalogProviderError,
  type CatalogProvider,
  type SearchCatalogReleasesInput,
} from "./catalog-provider.js";

const ArtistCreditSchema = z
  .object({
    name: z.string().min(1),
    joinphrase: z.string().optional(),
  })
  .passthrough();

const MusicBrainzReleaseSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1),
    score: z.number().int().min(0).max(100).optional(),
    date: z.string().optional(),
    country: z.string().optional(),
    barcode: z.string().nullable().optional(),
    packaging: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    "artist-credit": z.array(ArtistCreditSchema).min(1),
    "release-group": z.object({ id: z.string().uuid() }).passthrough(),
    "label-info": z
      .array(
        z
          .object({
            "catalog-number": z.string().nullable().optional(),
            label: z
              .object({ name: z.string().min(1) })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    media: z
      .array(
        z.object({ format: z.string().nullable().optional() }).passthrough(),
      )
      .optional(),
  })
  .passthrough();

const MusicBrainzSearchResponseSchema = z
  .object({ releases: z.array(MusicBrainzReleaseSchema) })
  .passthrough();

export interface MusicBrainzCatalogOptions {
  userAgent: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  minimumRequestIntervalMs?: number;
  cacheTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function createMusicBrainzCatalog(
  options: MusicBrainzCatalogOptions,
): CatalogProvider {
  const baseUrl = options.baseUrl ?? "https://musicbrainz.org/ws/2";
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const limiter = createRequestLimiter(
    options.minimumRequestIntervalMs ?? 1_000,
    now,
    sleep,
  );
  const cache = new Map<
    string,
    { expiresAt: number; value: CatalogReleaseCandidate[] }
  >();

  return {
    async searchReleases(input) {
      const normalizedInput = normalizeInput(input);
      const cacheKey = JSON.stringify(normalizedInput);
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > now()) return cached.value;

      const query = [
        `artist:${quoteLucene(normalizedInput.artist)}`,
        `release:${quoteLucene(normalizedInput.title)}`,
        "format:vinyl",
      ].join(" AND ");
      const url = new URL(`${baseUrl.replace(/\/$/, "")}/release`);
      url.searchParams.set("query", query);
      url.searchParams.set("limit", String(normalizedInput.limit));
      url.searchParams.set("fmt", "json");

      const payload = await requestJsonWithRetry({
        url,
        userAgent: options.userAgent,
        request,
        limiter,
        sleep,
        timeoutMs: options.timeoutMs ?? 10_000,
      });
      const parsed = MusicBrainzSearchResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new CatalogProviderError(
          "invalid_response",
          false,
          "The catalog response did not match the expected schema.",
        );
      }

      const fetchedAt = new Date(now()).toISOString();
      const results = parsed.data.releases.flatMap((release) => {
        const candidate = toCandidate(release, fetchedAt);
        return candidate ? [candidate] : [];
      });
      cache.set(cacheKey, {
        expiresAt: now() + (options.cacheTtlMs ?? 24 * 60 * 60 * 1_000),
        value: results,
      });
      return results;
    },
  };
}

function normalizeInput(input: SearchCatalogReleasesInput) {
  const artist = input.artist.trim();
  const title = input.title.trim();
  if (!artist || !title) {
    throw new TypeError("Artist and title are required for catalog search.");
  }
  return {
    artist,
    title,
    limit: Math.min(Math.max(input.limit ?? 10, 1), 25),
  };
}

function quoteLucene(value: string) {
  return `"${value.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, "\\$&")}"`;
}

function toCandidate(
  release: z.infer<typeof MusicBrainzReleaseSchema>,
  fetchedAt: string,
): CatalogReleaseCandidate | null {
  const labels = (release["label-info"] ?? [])
    .flatMap((entry) =>
      entry.label
        ? [
            {
              name: entry.label.name,
              catalogNumber: entry["catalog-number"] ?? null,
            },
          ]
        : [],
    )
    .slice(0, 20);
  const formats = [
    ...new Set(
      (release.media ?? []).flatMap((medium) =>
        medium.format ? [medium.format] : [],
      ),
    ),
  ].slice(0, 20);
  const candidate = CatalogReleaseCandidateSchema.safeParse({
    reference: {
      provider: "musicbrainz",
      releaseGroupId: release["release-group"].id,
      releaseId: release.id,
      sourceUrl: `https://musicbrainz.org/release/${release.id}`,
      fetchedAt,
    },
    artist: release["artist-credit"]
      .map((credit) => `${credit.name}${credit.joinphrase ?? ""}`)
      .join(""),
    title: release.title,
    releaseDate: release.date ?? null,
    country: release.country ?? null,
    labels,
    barcode: release.barcode || null,
    formats,
    packaging: release.packaging ?? null,
    status: release.status ?? null,
    score: release.score ?? 0,
  });
  return candidate.success ? candidate.data : null;
}

async function requestJsonWithRetry(input: {
  url: URL;
  userAgent: string;
  request: typeof fetch;
  limiter: ReturnType<typeof createRequestLimiter>;
  sleep: (milliseconds: number) => Promise<void>;
  timeoutMs: number;
}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response: Response;
    try {
      response = await input.limiter.run(() =>
        input.request(input.url, {
          headers: {
            accept: "application/json",
            "user-agent": input.userAgent,
          },
          signal: AbortSignal.timeout(input.timeoutMs),
        }),
      );
    } catch {
      if (attempt < 3) {
        await input.sleep(2 ** (attempt - 1) * 1_000);
        continue;
      }
      throw new CatalogProviderError(
        "provider_unavailable",
        true,
        "The catalog provider is temporarily unavailable.",
      );
    }

    if (response.ok) return response.json() as Promise<unknown>;
    if ((response.status === 429 || response.status === 503) && attempt < 3) {
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      await input.sleep(
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1_000
          : 2 ** (attempt - 1) * 1_000,
      );
      continue;
    }
    throw new CatalogProviderError(
      response.status === 429 ? "rate_limit" : "provider_unavailable",
      response.status === 429 || response.status >= 500,
      response.status === 429
        ? "The catalog provider is temporarily rate limited."
        : "The catalog provider could not complete the request.",
    );
  }
  throw new CatalogProviderError(
    "provider_unavailable",
    true,
    "The catalog provider is temporarily unavailable.",
  );
}

function createRequestLimiter(
  intervalMs: number,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
) {
  let nextAvailableAt = 0;
  let tail = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(async () => {
        const delay = Math.max(0, nextAvailableAt - now());
        if (delay > 0) await sleep(delay);
        const value = await task();
        nextAvailableAt = now() + intervalMs;
        return value;
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
