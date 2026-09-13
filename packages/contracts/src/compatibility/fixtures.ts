import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/**
 * Frozen wire samples under `packages/contracts/fixtures/` (ADR-0022).
 *
 * Layout, with every segment load-bearing:
 *
 *   http/<apiVersion>/requests/<SchemaName>/<case>.json
 *   http/<apiVersion>/responses/<SchemaName>/<case>.json
 *   events/<topic>/<case>.json
 *
 * `<SchemaName>` is the export name in `@vinylhound/contracts`; `<topic>` is
 * a key of `EVENT_CONTRACTS`. A fixture's `value` is what a deployed version
 * actually sent or accepted, and it is never edited in place: a shape that
 * stops being supported is deleted (with the decision recorded), and a new
 * shape gets a new file. `scripts/check-compatibility.ts` enforces the
 * in-place rule against git; `compatibility.test.ts` proves the current
 * contracts still accept every file present.
 */
export const FIXTURES_ROOT = fileURLToPath(
  new URL("../../fixtures/", import.meta.url),
);

export type FixtureKind = "request" | "response" | "event";

export interface ContractFixture {
  /** Path relative to the fixtures root, always with forward slashes. */
  path: string;
  kind: FixtureKind;
  /** Requests/responses: the exported schema name. Events: the topic. */
  contract: string;
  /** Only for HTTP fixtures: the `/api/<version>` the sample belongs to. */
  apiVersion: string | null;
  frozenAt: string;
  origin: string;
  value: unknown;
}

const FixtureFileSchema = z
  .object({
    frozenAt: z.iso.date(),
    origin: z.string().trim().min(1),
    value: z.unknown(),
  })
  .strict();

const HTTP_KINDS: Record<string, FixtureKind> = {
  requests: "request",
  responses: "response",
};

export function loadContractFixtures(
  root: string = FIXTURES_ROOT,
): ContractFixture[] {
  const fixtures: ContractFixture[] = [];
  for (const relativePath of walk(root)) {
    const segments = relativePath.split("/");
    const located = locate(segments);
    if (located === null) {
      throw new Error(
        `Fixture "${relativePath}" is not under http/<version>/{requests,responses}/<Schema>/ or events/<topic>/.`,
      );
    }
    const raw: unknown = JSON.parse(
      readFileSync(join(root, relativePath), "utf8"),
    );
    const parsed = FixtureFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Fixture "${relativePath}" must be { frozenAt, origin, value }: ${z.prettifyError(parsed.error)}`,
      );
    }
    fixtures.push({ path: relativePath, ...located, ...parsed.data });
  }
  return fixtures.sort((a, b) => a.path.localeCompare(b.path));
}

function locate(
  segments: string[],
): Pick<ContractFixture, "kind" | "contract" | "apiVersion"> | null {
  const [family] = segments;
  if (family === "http" && segments.length === 5) {
    const kind = HTTP_KINDS[segments[2]!];
    return kind
      ? { kind, contract: segments[3]!, apiVersion: segments[1]! }
      : null;
  }
  if (family === "events" && segments.length === 3) {
    return { kind: "event", contract: segments[1]!, apiVersion: null };
  }
  return null;
}

function* walk(root: string, prefix = ""): Generator<string> {
  for (const entry of readdirSync(join(root, prefix)).sort()) {
    const relativePath = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(join(root, relativePath)).isDirectory()) {
      yield* walk(root, relativePath);
    } else if (entry.endsWith(".json")) {
      yield relativePath;
    }
  }
}

/** The slice of a Zod schema the checks need — any version's schema has it. */
export interface Parser {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean; error?: unknown };
}

function isParser(candidate: unknown): candidate is Parser {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { safeParse?: unknown }).safeParse === "function"
  );
}

/**
 * Finds the parser a fixture must satisfy in a `@vinylhound/contracts` module
 * namespace — the current one, or a previous version's extracted source — as
 * the reader that version actually applied on the wire. Requests resolve to
 * the named export, strict, because the server reads them strictly. Responses
 * resolve to that version's `tolerant()` reader when it exports one, because
 * that is what its browser used (versions before it read strictly, and are
 * judged that way). Events resolve to the topic's consumer schema. Returns
 * `null` when the namespace does not know the contract, so the caller can
 * report "new in this version" instead of failing.
 */
export function resolveFixtureParser(
  contracts: Record<string, unknown>,
  fixture: ContractFixture,
): Parser | null {
  if (fixture.kind === "event") {
    const registry = contracts.EVENT_CONTRACTS;
    if (
      typeof registry !== "object" ||
      registry === null ||
      !Object.hasOwn(registry, fixture.contract)
    ) {
      return null;
    }
    const contract = (registry as Record<string, { consumerSchema?: unknown }>)[
      fixture.contract
    ];
    return isParser(contract?.consumerSchema) ? contract.consumerSchema : null;
  }
  const schema = contracts[fixture.contract];
  if (!isParser(schema)) {
    return null;
  }
  if (fixture.kind === "response" && typeof contracts.tolerant === "function") {
    const reader: unknown = (contracts.tolerant as (s: unknown) => unknown)(
      schema,
    );
    return isParser(reader) ? reader : schema;
  }
  return schema;
}
