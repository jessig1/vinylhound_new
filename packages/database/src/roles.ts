import { Client } from "pg";

import type { DatabaseOptions } from "./database.ts";

/**
 * P4.2 Task 7 (ADR-0030): creates (or rotates the password of)
 * `vinylhound_scan_app`/`vinylhound_core_app` before migration 021 grants
 * them their least-privilege schema access. Role name and password are
 * parsed out of `SCAN_DATABASE_URL`/`CORE_DATABASE_URL` -- the URL is the
 * single source of truth, so there is no separate password config var to
 * keep in sync with it. Not done as plain `.sql` in the migration itself:
 * `node-pg-migrate`'s migrations cannot read environment variables, and a
 * literal password baked into a versioned `.sql` file would be a secret
 * committed to the repository.
 *
 * Runs over its own short-lived `pg.Client` (not a `Database`/drizzle
 * handle) against the master credential, since role management is a one-off
 * imperative step, not a query this package otherwise needs to build.
 * Idempotent: safe to run on every deploy, including ones where the
 * password did not change (`ALTER ROLE ... PASSWORD` is unconditional, so a
 * rotated secret takes effect the next time this runs).
 */
export async function ensureDatabaseRoles(
  masterOptions: DatabaseOptions,
  roles: { scanUrl: string; coreUrl: string },
): Promise<void> {
  const client = new Client({
    connectionString: masterOptions.connectionString,
    connectionTimeoutMillis: masterOptions.connectionTimeoutMillis,
    ssl: masterOptions.ssl,
  });
  await client.connect();
  try {
    await ensureRole(client, parseRoleCredentials(roles.scanUrl));
    await ensureRole(client, parseRoleCredentials(roles.coreUrl));
  } finally {
    await client.end();
  }
}

interface RoleCredentials {
  name: string;
  password: string;
}

function parseRoleCredentials(connectionString: string): RoleCredentials {
  const url = new URL(connectionString);
  const name = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(
      `Refusing to use "${name}" as a database role name: it must be a ` +
        "lowercase identifier matching /^[a-z_][a-z0-9_]{0,62}$/.",
    );
  }
  if (!password) {
    throw new Error(`The database URL for role "${name}" has no password.`);
  }
  return { name, password };
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function ensureRole(client: Client, role: RoleCredentials) {
  const identifier = `"${role.name}"`;
  await client.query(`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role.name)}) THEN
        CREATE ROLE ${identifier} LOGIN;
      END IF;
    END
    $do$;
  `);
  await client.query(
    `ALTER ROLE ${identifier} WITH LOGIN PASSWORD ${quoteLiteral(role.password)};`,
  );
}
