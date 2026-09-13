import type { z } from "zod";

import { tolerant } from "./tolerant.ts";

/**
 * Version conventions for everything that crosses a process or network
 * boundary (ADR-0022).
 *
 * Compatibility is declared per contract family by an identifier that
 * travels on the wire: the `/api/v1` path prefix for HTTP, and the `.v1`
 * suffix of an event topic plus a literal version field inside its payload
 * for queue/outbox messages. The workspace `version` fields (`0.1.0` in
 * every `package.json`) are not compatibility identifiers — every workspace
 * is consumed by path and deployed as one image per commit, so that number
 * never changes when a contract does and must not be read as a promise.
 */

/** The HTTP surface version. Every route lives under `API_BASE_PATH`. */
export const API_VERSION = "v1" as const;
export const API_BASE_PATH = `/api/${API_VERSION}` as const;

/**
 * `<aggregate>.<action>.v<N>` — lower-case snake segments and a positive
 * integer version. The version is a single integer, never semver: a bump
 * means "a consumer of the previous version cannot process this payload",
 * nothing finer.
 */
export const EVENT_TOPIC_PATTERN =
  /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\.v([1-9][0-9]*)$/;

export interface EventTopicParts {
  aggregate: string;
  action: string;
  version: number;
}

export function parseEventTopic(topic: string): EventTopicParts {
  const match = EVENT_TOPIC_PATTERN.exec(topic);
  if (!match) {
    throw new Error(
      `Event topic "${topic}" must match <aggregate>.<action>.v<N>.`,
    );
  }
  return {
    aggregate: match[1]!,
    action: match[2]!,
    version: Number(match[3]),
  };
}

export function formatEventTopic(parts: EventTopicParts): string {
  const topic = `${parts.aggregate}.${parts.action}.v${parts.version}`;
  // Round-trip through the parser so a malformed part cannot produce a
  // topic that the parser would later reject.
  parseEventTopic(topic);
  return topic;
}

type AnyObjectSchema = z.ZodObject<z.ZodRawShape, z.core.$ZodObjectConfig>;

/**
 * One versioned event or job payload contract.
 *
 * `producerSchema` is strict: a producer validates with it before a payload
 * leaves the process, so an undeclared field can never reach the wire by
 * accident. `consumerSchema` is the tolerant reader of the same schema
 * (`tolerant()` — unknown keys stripped at every depth), so a consumer built
 * from the previous deployed version keeps accepting a payload that a newer
 * producer extended with an optional field. That is
 * what lets a field be added within a version: it must be optional, and a
 * consumer that does not know it may drop it in transit (the outbox
 * dispatcher re-publishes what it parsed), so only advisory data qualifies.
 * Anything a consumer must not lose needs a new version.
 */
export interface EventContract<
  Topic extends string = string,
  Schema extends AnyObjectSchema = AnyObjectSchema,
> {
  readonly topic: Topic;
  readonly aggregate: string;
  readonly action: string;
  readonly version: number;
  /** The payload field carrying the literal version, e.g. `jobVersion`. */
  readonly versionField: string;
  readonly producerSchema: Schema;
  readonly consumerSchema: Schema;
}

export function defineEventContract<
  Topic extends string,
  Schema extends AnyObjectSchema,
>(definition: {
  topic: Topic;
  versionField: keyof Schema["shape"] & string;
  schema: Schema;
}): EventContract<Topic, Schema> {
  const { topic, versionField, schema } = definition;
  const parts = parseEventTopic(topic);
  const field = schema.shape[versionField];
  const literal =
    field !== undefined && field._zod.def.type === "literal"
      ? [...(field as z.ZodLiteral).values]
      : null;
  // The topic and the payload must agree on the version, and the payload
  // must state it as a single literal: a consumer routes on the topic and
  // then trusts the field, so any disagreement would be a silent lie.
  if (
    literal === null ||
    literal.length !== 1 ||
    literal[0] !== parts.version
  ) {
    throw new Error(
      `Event contract "${topic}" must carry z.literal(${parts.version}) in "${versionField}".`,
    );
  }
  return {
    topic,
    aggregate: parts.aggregate,
    action: parts.action,
    version: parts.version,
    versionField,
    producerSchema: schema,
    consumerSchema: tolerant(schema),
  };
}
