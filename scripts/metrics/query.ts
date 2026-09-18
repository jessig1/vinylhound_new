import { Client } from "pg";

export interface AttemptRow {
  model: string;
  status: "processing" | "succeeded" | "failed";
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  startedAt: string;
  completedAt: string | null;
  /**
   * When the outbox row analysis was dispatched from can still be matched
   * (same scan, same attempt number, the `scan.analyze.v1` topic), this is
   * `outbox_messages.created_at` — the moment the job was enqueued. Older
   * attempts, or ones whose outbox row has since been reaped, come back
   * null; queue age and end-to-end latency are then left unmeasured for
   * that attempt rather than guessed at.
   */
  enqueuedAt: string | null;
}

/**
 * Reads every persisted analysis attempt with its matching enqueue time, if
 * still available. `scan_attempts` never records when its job was enqueued
 * (only `started_at`, set on worker pickup), so queue age and end-to-end
 * latency come from joining `outbox_messages` on the same scan/attempt
 * number — the two tables already carry everything needed; no schema change.
 */
export async function readAttempts(databaseUrl: string): Promise<AttemptRow[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{
      model: string;
      status: "processing" | "succeeded" | "failed";
      input_tokens: number | null;
      output_tokens: number | null;
      duration_ms: number | null;
      started_at: string;
      completed_at: string | null;
      enqueued_at: string | null;
    }>(
      `select
         sa.model,
         sa.status,
         sa.input_tokens,
         sa.output_tokens,
         sa.duration_ms,
         sa.started_at,
         sa.completed_at,
         om.created_at as enqueued_at
       from scan_attempts sa
       left join outbox_messages om
         on om.aggregate_id = sa.scan_id
         and om.attempt_number = sa.attempt_number
         and om.topic = 'scan.analyze.v1'
       order by sa.started_at`,
    );
    return result.rows.map((row) => ({
      model: row.model,
      status: row.status,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      durationMs: row.duration_ms,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      enqueuedAt: row.enqueued_at,
    }));
  } finally {
    await client.end();
  }
}
