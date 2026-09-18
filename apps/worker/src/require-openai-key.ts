/**
 * apps/worker/src/index.ts and lambda.ts are the real production
 * entrypoints: their outbox dispatch publishes analysis jobs into the queue
 * unconditionally, but without a configured key there is no consumer to
 * drain them, so submitted scans would silently stall forever with nothing
 * surfaced anywhere. Refusing to start is the safe failure mode.
 * apps/worker/src/e2e-worker.ts is the entrypoint for running without a key
 * (tests, the P3.5 load benchmark): it injects a synthetic identifier and
 * never reads this at all.
 */
export function requireOpenAiApiKey(
  openaiApiKey: string | undefined,
): asserts openaiApiKey is string {
  if (!openaiApiKey) {
    throw new Error(
      "OPENAI_API_KEY is required to start this worker entrypoint: without it, " +
        "published analysis jobs would have no consumer to drain them and " +
        "submitted scans would silently stall. Use apps/worker/src/e2e-worker.ts " +
        "(no key required) for tests instead.",
    );
  }
}
