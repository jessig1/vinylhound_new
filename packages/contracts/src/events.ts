import { ANALYZE_SCAN_JOB, ANALYZE_SCAN_JOB_CONTRACT } from "./scan.ts";
import type { EventContract } from "./versioning.ts";

/**
 * Every versioned event/job payload this codebase produces or consumes, keyed
 * by topic. A new topic or a new version of an existing one is registered
 * here; the compatibility suite in `src/compatibility/` walks this registry
 * to find each topic's frozen fixtures and its consumer schema (ADR-0022).
 *
 * Two versions of one topic coexist during a transition: the consumer keeps
 * both registered until no producer of the older version can still be
 * deployed or rolled back to, and only then is the older entry removed.
 */
export const EVENT_CONTRACTS = {
  [ANALYZE_SCAN_JOB]: ANALYZE_SCAN_JOB_CONTRACT,
} as const satisfies Record<string, EventContract>;

export type EventTopic = keyof typeof EVENT_CONTRACTS;

export function getEventContract(topic: string): EventContract | undefined {
  return Object.hasOwn(EVENT_CONTRACTS, topic)
    ? EVENT_CONTRACTS[topic as EventTopic]
    : undefined;
}
