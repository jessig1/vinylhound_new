export interface BoundedCacheOptions {
  maxEntries: number;
  ttlMs: number;
  now: () => number;
}

export interface BoundedCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

/**
 * A capacity- and TTL-bounded cache for the provider adapters, which run as
 * long-lived singletons per process (`apps/discovery`, or the in-process
 * fallback) with no background sweep. Eviction is least-recently-used,
 * tracked purely through `Map` insertion order: a hit re-inserts the key so
 * it moves to the end, and a `set` past `maxEntries` drops the first
 * (oldest/least-recently-used) key. Expired entries are dropped lazily on
 * access rather than on a timer, since nothing here needs one.
 */
export function createBoundedCache<T>(
  options: BoundedCacheOptions,
): BoundedCache<T> {
  const { maxEntries, ttlMs, now } = options;
  const entries = new Map<string, { expiresAt: number; value: T }>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { expiresAt: now() + ttlMs, value });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}
