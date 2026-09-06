import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";

export interface DatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  connectionTimeoutMillis?: number;
  ssl?: false | { rejectUnauthorized: boolean; ca?: string };
}

export function createDatabase(options: DatabaseOptions) {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 30_000,
    ssl: options.ssl,
  });
  const db = drizzle(pool, { schema });

  return {
    db,
    close: () => pool.end(),
  };
}

export type Database = ReturnType<typeof createDatabase>["db"];

export function databaseOptionsFromConfig(config: {
  DATABASE_URL: string;
  DATABASE_MAX_CONNECTIONS: number;
  DATABASE_CONNECT_TIMEOUT_MS: number;
  DATABASE_SSL_MODE: "disable" | "require" | "verify-full";
  DATABASE_SSL_CA_BASE64?: string;
}): DatabaseOptions {
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
    connectionString: config.DATABASE_URL,
    maxConnections: config.DATABASE_MAX_CONNECTIONS,
    connectionTimeoutMillis: config.DATABASE_CONNECT_TIMEOUT_MS,
    ssl,
  };
}
