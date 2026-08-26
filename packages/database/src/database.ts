import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";

export interface DatabaseOptions {
  connectionString: string;
  maxConnections?: number;
}

export function createDatabase(options: DatabaseOptions) {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
  });
  const db = drizzle(pool, { schema });

  return {
    db,
    close: () => pool.end(),
  };
}

export type Database = ReturnType<typeof createDatabase>["db"];
