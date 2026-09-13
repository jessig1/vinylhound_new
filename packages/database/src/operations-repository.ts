import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

import {
  ANALYZE_SCAN_JOB_CONTRACT,
  type AnalyzeScanJob,
} from "@vinylhound/contracts";

import type { Database } from "./database.ts";
import { outboxMessages, scans } from "./schema.ts";

export async function getOperationalDrainState(db: Database) {
  const [scanState] = await db
    .select({
      activeScans: sql<number>`count(*) filter (where ${scans.status} in ('queued', 'processing'))::int`,
    })
    .from(scans);
  const [outboxState] = await db
    .select({ pendingOutbox: sql<number>`count(*)::int` })
    .from(outboxMessages)
    .where(isNull(outboxMessages.publishedAt));

  return {
    activeScans: scanState?.activeScans ?? 0,
    pendingOutbox: outboxState?.pendingOutbox ?? 0,
  };
}

export async function listRepublishableAnalysisJobs(
  db: Database,
  limit = 100,
): Promise<Array<{ job: AnalyzeScanJob; idempotencyKey: string }>> {
  const rows = await db
    .select({
      payload: outboxMessages.payload,
      idempotencyKey: outboxMessages.idempotencyKey,
    })
    .from(outboxMessages)
    .innerJoin(scans, eq(scans.id, outboxMessages.aggregateId))
    .where(
      and(
        isNotNull(outboxMessages.publishedAt),
        or(eq(scans.status, "queued"), eq(scans.status, "processing")),
      ),
    )
    .limit(limit);

  return rows.map((row) => ({
    job: ANALYZE_SCAN_JOB_CONTRACT.consumerSchema.parse(row.payload),
    idempotencyKey: row.idempotencyKey,
  }));
}
