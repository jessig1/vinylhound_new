import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  coreDatabaseOptionsFromConfig,
  createCoreDatabase,
  createDatabase,
  createScanDatabase,
  databaseOptionsFromConfig,
  scanDatabaseOptionsFromConfig,
} from "./database.ts";

/**
 * P4.2 Task 7 (ADR-0030): proves the scan/core split is a real database
 * privilege boundary, not merely a convention every repository function
 * happens to follow. Every other integration test in this package exercises
 * behavior *through* the two role-scoped connections; this file is the one
 * place that deliberately tries to cross the boundary and asserts Postgres
 * itself refuses it.
 */

const config = {
  DATABASE_URL: process.env.DATABASE_URL!,
  SCAN_DATABASE_URL: process.env.SCAN_DATABASE_URL!,
  CORE_DATABASE_URL: process.env.CORE_DATABASE_URL!,
  DATABASE_MAX_CONNECTIONS: 2,
  DATABASE_CONNECT_TIMEOUT_MS: 5_000,
  DATABASE_SSL_MODE: "disable" as const,
};
if (
  !config.DATABASE_URL ||
  !config.SCAN_DATABASE_URL ||
  !config.CORE_DATABASE_URL
) {
  throw new Error(
    "DATABASE_URL, SCAN_DATABASE_URL, and CORE_DATABASE_URL are required for schema-boundary integration tests.",
  );
}

const master = createDatabase(databaseOptionsFromConfig(config));
const scanDatabase = createScanDatabase(scanDatabaseOptionsFromConfig(config));
const coreDatabase = createCoreDatabase(coreDatabaseOptionsFromConfig(config));

afterAll(async () => {
  await Promise.all([
    master.close(),
    scanDatabase.close(),
    coreDatabase.close(),
  ]);
});

function pgErrorCode(error: unknown): string | undefined {
  // drizzle wraps the underlying `pg` error rather than throwing it
  // directly, so the SQLSTATE lands on `.cause`, not the thrown error
  // itself -- matching how `schema.integration.ts`'s own assertions read it
  // (`{ cause: { code } }`).
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate?.code ?? candidate?.cause?.code;
}

describe("scan/core schema boundary (P4.2 Task 7)", () => {
  it("lets the scan role read its own schema's tables", async () => {
    const rows = await scanDatabase.db.execute(sql`select count(*) from scans`);
    expect(rows.rows).toBeDefined();
  });

  it("lets the core role read its own schema's tables", async () => {
    const rows = await coreDatabase.db.execute(sql`select count(*) from users`);
    expect(rows.rows).toBeDefined();
  });

  it("refuses the scan role permission to read a core table by qualified name", async () => {
    await expect(
      scanDatabase.db.execute(sql`select count(*) from core.users`),
    ).rejects.toSatisfy(
      (error: unknown) => pgErrorCode(error) === "42501",
      "expected SQLSTATE 42501 (insufficient_privilege)",
    );
  });

  it("refuses the core role permission to read a scan table by qualified name", async () => {
    await expect(
      coreDatabase.db.execute(sql`select count(*) from scan.scans`),
    ).rejects.toSatisfy(
      (error: unknown) => pgErrorCode(error) === "42501",
      "expected SQLSTATE 42501 (insufficient_privilege)",
    );
  });

  it("cannot resolve the other schema's table unqualified (search_path never includes it)", async () => {
    // Distinct from the permission-denied assertions above: even setting
    // qualification aside, the connection's own search_path (scan,public /
    // core,public) never names the other schema at all, so an ordinary,
    // unqualified query -- exactly what every repository function emits --
    // fails with "relation does not exist", not just "permission denied".
    await expect(
      scanDatabase.db.execute(sql`select count(*) from users`),
    ).rejects.toSatisfy(
      (error: unknown) => pgErrorCode(error) === "42P01",
      "expected SQLSTATE 42P01 (undefined_table)",
    );
    await expect(
      coreDatabase.db.execute(sql`select count(*) from scans`),
    ).rejects.toSatisfy(
      (error: unknown) => pgErrorCode(error) === "42P01",
      "expected SQLSTATE 42P01 (undefined_table)",
    );
  });

  it("reports the search_path each role actually connects with", async () => {
    const [scanPath] = (await scanDatabase.db.execute(sql`show search_path`))
      .rows as Array<{ search_path: string }>;
    const [corePath] = (await coreDatabase.db.execute(sql`show search_path`))
      .rows as Array<{ search_path: string }>;
    // No space after the comma: DatabaseOptions.searchPath is forwarded
    // verbatim as the connection's startup `options` (`-c
    // search_path=scan,public`), and Postgres echoes it back exactly as set.
    expect(scanPath.search_path).toBe("scan,public");
    expect(corePath.search_path).toBe("core,public");
  });

  it("has no foreign key left crossing the scan/core boundary", async () => {
    // Guards against a future migration reintroducing exactly the trap
    // ADR-0027/ADR-0030 removed: a literal FK from one schema's table into
    // the other's, which Postgres would enforce (referential-integrity
    // checks run with the referenced table's owner rights, not the
    // connecting role's) regardless of either role's own GRANTs.
    const crossing = await master.db.execute(sql`
      select
        con.conname,
        ns_referencing.nspname as referencing_schema,
        cl_referencing.relname as referencing_table,
        ns_referenced.nspname as referenced_schema,
        cl_referenced.relname as referenced_table
      from pg_constraint con
      join pg_class cl_referencing on cl_referencing.oid = con.conrelid
      join pg_namespace ns_referencing on ns_referencing.oid = cl_referencing.relnamespace
      join pg_class cl_referenced on cl_referenced.oid = con.confrelid
      join pg_namespace ns_referenced on ns_referenced.oid = cl_referenced.relnamespace
      where con.contype = 'f'
        and ns_referencing.nspname in ('scan', 'core')
        and ns_referenced.nspname in ('scan', 'core')
        and ns_referencing.nspname <> ns_referenced.nspname
    `);
    expect(crossing.rows).toEqual([]);
  });

  it("keeps every table assigned to exactly the schema ADR-0027/ADR-0030 name", async () => {
    const scanTables = [
      "scans",
      "batches",
      "image_assets",
      "scan_attempts",
      "scan_candidates",
      "scan_confirmations",
      "outbox_messages",
      "account_deletions",
    ];
    const coreTables = [
      "users",
      "albums",
      "releases",
      "catalog_references",
      "library_items",
      "library_copies",
      "playlists",
      "playlist_entries",
      "confirmation_receipts",
    ];
    const rows = (
      await master.db.execute(sql`
        select table_schema, table_name
        from information_schema.tables
        where table_schema in ('scan', 'core')
      `)
    ).rows as Array<{ table_schema: string; table_name: string }>;
    const bySchema = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = bySchema.get(row.table_schema) ?? new Set();
      set.add(row.table_name);
      bySchema.set(row.table_schema, set);
    }
    expect([...(bySchema.get("scan") ?? [])].sort()).toEqual(
      [...scanTables].sort(),
    );
    expect([...(bySchema.get("core") ?? [])].sort()).toEqual(
      [...coreTables].sort(),
    );
  });

  it("lets a scan connection write and read back its own account_deletions tombstone", async () => {
    const userId = randomUUID();
    await scanDatabase.db.execute(
      sql`insert into account_deletions (user_id) values (${userId})`,
    );
    const rows = (
      await scanDatabase.db.execute(
        sql`select user_id from account_deletions where user_id = ${userId}`,
      )
    ).rows as Array<{ user_id: string }>;
    expect(rows).toHaveLength(1);
    await scanDatabase.db.execute(
      sql`delete from account_deletions where user_id = ${userId}`,
    );
  });
});
