import { eq } from "drizzle-orm";

import type { CoreDatabase } from "./database.ts";
import { DatabaseCommandError } from "./scan-repository.ts";
import { users } from "./schema.ts";

/**
 * P4.2 Task 7 (ADR-0030): relocated from `scan-repository.ts`, where it
 * lived only because scan endpoints happen to be the first authenticated
 * request in a session -- `users` is core-owned (ADR-0027), and this file's
 * two functions are the only place scan-side code used to write it directly.
 */
export async function ensureDevelopmentUser(db: CoreDatabase, userId: string) {
  await db.insert(users).values({ id: userId }).onConflictDoNothing();
}

export async function getOrCreateUserIdByClerkId(
  db: CoreDatabase,
  clerkUserId: string,
): Promise<string> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);
  if (existing[0]) {
    return existing[0].id;
  }

  await db
    .insert(users)
    .values({ clerkUserId })
    .onConflictDoNothing({ target: users.clerkUserId });

  const row = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);
  if (!row[0]) {
    throw new DatabaseCommandError(
      "conflict",
      "Failed to resolve or provision a user for the authenticated identity.",
    );
  }
  return row[0].id;
}
