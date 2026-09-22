import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.ts";

export interface DatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  connectionTimeoutMillis?: number;
  ssl?: false | { rejectUnauthorized: boolean; ca?: string };
  /**
   * Forwarded as the connection's startup `options` parameter (P4.2 Task 7,
   * ADR-0030), e.g. `"-c search_path=scan,public"`. Deterministic per-pool
   * name resolution for `scan`/`core`'s unqualified, schema-less `pgTable`
   * declarations -- chosen over relying on `ALTER ROLE ... SET search_path`
   * alone because that only takes effect for a *new* connection: a pooled
   * connection opened before a role's search_path changes keeps its old
   * value for its lifetime, which matters during production's rolling
   * deploys where old and new pods run against the same database.
   */
  searchPath?: string;
}

export function createDatabase(options: DatabaseOptions) {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 30_000,
    ssl: options.ssl,
    options: options.searchPath
      ? `-c search_path=${options.searchPath}`
      : undefined,
  });
  const db = drizzle(pool, { schema });

  return {
    db,
    close: () => pool.end(),
  };
}

export type Database = ReturnType<typeof createDatabase>["db"];

/**
 * Brands (P4.2 Task 7, ADR-0030) so the compiler enforces which of scan's or
 * core's tables a function may touch, instead of every repository function
 * silently accepting an opaque `Database` regardless of which role opened
 * it. A `ScanDatabase` is only ever produced by `createScanDatabase`; a
 * `CoreDatabase` only by `createCoreDatabase`. Neither is assignable to the
 * other, so passing the wrong handle to a repository function is a compile
 * error, not a runtime `insufficient_privilege` surprise -- though the
 * privilege boundary is still enforced for real by the database GRANTs
 * (migration 021), since branded types alone would not stop a raw `sql`
 * escape hatch from crossing the boundary.
 */
declare const scanDatabaseBrand: unique symbol;
declare const coreDatabaseBrand: unique symbol;
export type ScanDatabase = Database & { readonly [scanDatabaseBrand]: true };
export type CoreDatabase = Database & { readonly [coreDatabaseBrand]: true };

/**
 * Plain aliases, not branded: drizzle's `.transaction()` callback parameter
 * type does not carry the outer handle's brand, so these exist only to
 * document, at a glance, which schema's tables a function opening or
 * receiving a transaction is expected to touch. The real enforcement point
 * is always the `ScanDatabase`/`CoreDatabase` handle the transaction was
 * opened from -- a function cannot open a `ScanTransaction` without already
 * holding a `ScanDatabase`.
 */
export type ScanTransaction = Parameters<
  Parameters<ScanDatabase["transaction"]>[0]
>[0];
export type CoreTransaction = Parameters<
  Parameters<CoreDatabase["transaction"]>[0]
>[0];

function databaseOptions(
  connectionString: string,
  config: {
    DATABASE_MAX_CONNECTIONS: number;
    DATABASE_CONNECT_TIMEOUT_MS: number;
    DATABASE_SSL_MODE: "disable" | "require" | "verify-full";
    DATABASE_SSL_CA_BASE64?: string;
  },
  searchPath?: string,
): DatabaseOptions {
  const ssl =
    config.DATABASE_SSL_MODE === "disable"
      ? false
      : {
          rejectUnauthorized: config.DATABASE_SSL_MODE === "verify-full",
          ca: config.DATABASE_SSL_CA_BASE64
            ? Buffer.from(config.DATABASE_SSL_CA_BASE64, "base64").toString(
                "utf8",
              )
            : undefined,
        };

  return {
    connectionString,
    maxConnections: config.DATABASE_MAX_CONNECTIONS,
    connectionTimeoutMillis: config.DATABASE_CONNECT_TIMEOUT_MS,
    ssl,
    searchPath,
  };
}

/** The master/migration connection: unrestricted, sees both schemas. */
export function databaseOptionsFromConfig(config: {
  DATABASE_URL: string;
  DATABASE_MAX_CONNECTIONS: number;
  DATABASE_CONNECT_TIMEOUT_MS: number;
  DATABASE_SSL_MODE: "disable" | "require" | "verify-full";
  DATABASE_SSL_CA_BASE64?: string;
}): DatabaseOptions {
  return databaseOptions(config.DATABASE_URL, config, "scan,core,public");
}

export function scanDatabaseOptionsFromConfig(config: {
  SCAN_DATABASE_URL: string;
  DATABASE_MAX_CONNECTIONS: number;
  DATABASE_CONNECT_TIMEOUT_MS: number;
  DATABASE_SSL_MODE: "disable" | "require" | "verify-full";
  DATABASE_SSL_CA_BASE64?: string;
}): DatabaseOptions {
  return databaseOptions(config.SCAN_DATABASE_URL, config, "scan,public");
}

export function coreDatabaseOptionsFromConfig(config: {
  CORE_DATABASE_URL: string;
  DATABASE_MAX_CONNECTIONS: number;
  DATABASE_CONNECT_TIMEOUT_MS: number;
  DATABASE_SSL_MODE: "disable" | "require" | "verify-full";
  DATABASE_SSL_CA_BASE64?: string;
}): DatabaseOptions {
  return databaseOptions(config.CORE_DATABASE_URL, config, "core,public");
}

export function createScanDatabase(options: DatabaseOptions) {
  const created = createDatabase(options);
  return { db: created.db as ScanDatabase, close: created.close };
}

export function createCoreDatabase(options: DatabaseOptions) {
  const created = createDatabase(options);
  return { db: created.db as CoreDatabase, close: created.close };
}
