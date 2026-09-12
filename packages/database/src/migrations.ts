import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";

import type { DatabaseOptions } from "./database.ts";

export async function runDatabaseMigrations(options: DatabaseOptions) {
  return runner({
    databaseUrl: {
      connectionString: options.connectionString,
      connectionTimeoutMillis: options.connectionTimeoutMillis,
      ssl: options.ssl,
    },
    direction: "up",
    dir: fileURLToPath(new URL("../migrations", import.meta.url)),
    migrationsTable: "vinylhound_migrations",
    singleTransaction: true,
  });
}
