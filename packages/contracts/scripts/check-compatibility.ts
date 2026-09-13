/**
 * Contract compatibility against the previous deployed version (ADR-0022).
 *
 * `npm run check:contracts [-- --base <ref>]`
 *
 * Two checks that need git, complementing `compatibility.test.ts` (which
 * runs under `npm test` and covers the backward direction — this tree's
 * contracts accepting every frozen fixture):
 *
 * 1. Frozen fixtures are never edited in place. A modified file under
 *    `packages/contracts/fixtures/` relative to the base fails the run;
 *    deletions are allowed but listed, since a deleted fixture is a
 *    compatibility decision that must be recorded.
 * 2. Forward compatibility: the base version's contracts are extracted from
 *    git and asked to accept this tree's fixtures. For event payloads this is
 *    enforced — a worker still running the previous version (rollback,
 *    deploy order, a queue backlog) must be able to consume what this version
 *    enqueues. For HTTP fixtures the result is reported only: the browser
 *    bundle deploys with its server, so the previous client persists just in
 *    tabs loaded before the deploy, and a reload clears it. Responses are
 *    judged by the reader that version's browser used — `tolerant()` where
 *    it exports one — so only a removed, renamed or retyped field shows up;
 *    requests are judged strictly, as the server reads them.
 *
 * The base defaults to `CONTRACTS_BASE_REF`, then `origin/main`, then
 * `HEAD~1`. CI passes the pull request's base or the pushed-over commit and
 * fetches it first. The base's source is imported from `node_modules/.cache`,
 * where every tool already looks away, and resolves `zod` from this tree.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  loadContractFixtures,
  resolveFixtureParser,
  type ContractFixture,
} from "../src/compatibility/fixtures.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CONTRACTS_SRC = "packages/contracts/src";
const FIXTURES_DIR = "packages/contracts/fixtures";
const EXTRACT_DIR = join(
  REPO_ROOT,
  "node_modules/.cache/vinylhound/contracts-previous",
);

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(...args: string[]): string | null {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

function readBaseArgument(): string | null {
  const index = process.argv.indexOf("--base");
  if (index !== -1) {
    const value = process.argv[index + 1];
    if (!value) {
      throw new Error("--base needs a ref.");
    }
    return value;
  }
  return process.env.CONTRACTS_BASE_REF?.trim() || null;
}

function resolveBase(): { requested: string; commit: string } {
  const explicit = readBaseArgument();
  const candidates = explicit ? [explicit] : ["origin/main", "HEAD~1"];
  for (const candidate of candidates) {
    const commit = tryGit("rev-parse", "--verify", `${candidate}^{commit}`);
    if (commit) {
      // Compare against the fork point when history allows it, so a branch
      // is judged by its own changes rather than by what main gained since.
      // A shallow CI fetch has no common ancestor and falls back to the base.
      const mergeBase = tryGit("merge-base", commit, "HEAD");
      return { requested: candidate, commit: mergeBase ?? commit };
    }
  }
  throw new Error(
    `Could not resolve a base commit from ${candidates.join(", ")}. Pass --base <ref> or set CONTRACTS_BASE_REF.`,
  );
}

function checkFixturesFrozen(base: string): {
  modified: string[];
  deleted: string[];
} {
  const list = (filter: string) =>
    (
      tryGit(
        "diff",
        "--name-only",
        "--no-renames",
        `--diff-filter=${filter}`,
        base,
        "--",
        FIXTURES_DIR,
      ) ?? ""
    )
      .split("\n")
      .filter(Boolean);
  return { modified: list("M"), deleted: list("D") };
}

function extractPreviousContracts(base: string): string | null {
  const listing = tryGit(
    "ls-tree",
    "-r",
    "--name-only",
    base,
    "--",
    CONTRACTS_SRC,
  );
  if (!listing) {
    return null;
  }
  rmSync(EXTRACT_DIR, { recursive: true, force: true });
  mkdirSync(EXTRACT_DIR, { recursive: true });
  for (const path of listing.split("\n").filter(Boolean)) {
    if (!path.endsWith(".ts") || path.endsWith(".test.ts")) {
      continue;
    }
    const target = join(EXTRACT_DIR, path.slice(CONTRACTS_SRC.length + 1));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git("show", `${base}:${path}`));
  }
  return EXTRACT_DIR;
}

interface ForwardResult {
  fixture: ContractFixture;
  outcome: "accepted" | "unknown" | "rejected";
  detail?: string;
}

function checkForward(
  previous: Record<string, unknown>,
  fixtures: ContractFixture[],
): ForwardResult[] {
  return fixtures.map((fixture) => {
    const parser = resolveFixtureParser(previous, fixture);
    if (parser === null) {
      return { fixture, outcome: "unknown" };
    }
    const result = parser.safeParse(fixture.value);
    if (result.success) {
      return { fixture, outcome: "accepted" };
    }
    const detail =
      result.error instanceof z.ZodError
        ? z.prettifyError(result.error)
        : String(result.error);
    return { fixture, outcome: "rejected", detail };
  });
}

async function main() {
  const base = resolveBase();
  const shortBase = git("rev-parse", "--short", base.commit);
  const subject = tryGit("log", "-1", "--format=%s", base.commit) ?? "";
  console.log(
    `Contract compatibility against ${base.requested} (${shortBase} ${subject})`,
  );

  let failed = false;

  const frozen = checkFixturesFrozen(base.commit);
  if (frozen.modified.length > 0) {
    failed = true;
    console.error(
      `\nFrozen fixtures were edited in place (${frozen.modified.length}). A fixture records what a deployed version sent; add a new file for a new shape, or delete this one with the decision recorded:`,
    );
    for (const path of frozen.modified) {
      console.error(`  M ${path}`);
    }
  }
  if (frozen.deleted.length > 0) {
    console.warn(
      `\nFixtures deleted since the base (${frozen.deleted.length}) — each ends support for a shape a deployed version sent; cite the ADR or roadmap decision in the change:`,
    );
    for (const path of frozen.deleted) {
      console.warn(`  D ${path}`);
    }
  }

  const fixtures = loadContractFixtures();
  const extracted = extractPreviousContracts(base.commit);
  if (extracted === null) {
    console.warn(
      `\n${CONTRACTS_SRC} does not exist at ${shortBase}; forward check skipped.`,
    );
  } else {
    try {
      const previous = (await import(
        pathToFileURL(join(extracted, "index.ts")).href
      )) as Record<string, unknown>;
      const results = checkForward(previous, fixtures);
      const eventsSupported = "EVENT_CONTRACTS" in previous;

      const byKind = (kind: ContractFixture["kind"]) =>
        results.filter((r) => r.fixture.kind === kind);
      const summarize = (label: string, rows: ForwardResult[]) => {
        const count = (outcome: ForwardResult["outcome"]) =>
          rows.filter((r) => r.outcome === outcome).length;
        console.log(
          `  ${label}: ${count("accepted")} accepted by the previous version, ${count("rejected")} rejected, ${count("unknown")} new in this version`,
        );
      };

      console.log(
        `\nForward check — ${shortBase}'s contracts reading this tree's fixtures:`,
      );
      summarize("events   ", byKind("event"));
      summarize("requests ", byKind("request"));
      summarize("responses", byKind("response"));

      if (!eventsSupported) {
        console.warn(
          `  note: ${shortBase} predates the event registry, so event fixtures count as new; the previous strict consumer would reject any unknown field.`,
        );
      }

      const rejectedEvents = byKind("event").filter(
        (r) => r.outcome === "rejected",
      );
      if (rejectedEvents.length > 0) {
        failed = true;
        console.error(
          `\nEvent payloads the previous version's consumer rejects (${rejectedEvents.length}). A worker still on ${shortBase} — after a rollback, during a deploy, or draining a backlog — would fail these jobs. Add the field as optional to an existing version or register a new topic version:`,
        );
        for (const { fixture, detail } of rejectedEvents) {
          console.error(
            `  ✖ ${fixture.path}\n    ${detail?.replace(/\n/g, "\n    ")}`,
          );
        }
      }

      const rejectedHttp = results.filter(
        (r) => r.fixture.kind !== "event" && r.outcome === "rejected",
      );
      if (rejectedHttp.length > 0) {
        console.warn(
          `\nHTTP shapes the previous version rejects (${rejectedHttp.length}). Reported, not enforced: for a response, a browser tab loaded before this deploy cannot read it until it reloads (its reader tolerates added fields, so this is a removed, renamed or retyped one); for a request, a replica still on ${shortBase} rejects it during a rolling deploy:`,
        );
        for (const { fixture, detail } of rejectedHttp) {
          console.warn(
            `  ! ${fixture.path}\n    ${detail?.replace(/\n/g, "\n    ")}`,
          );
        }
      }
    } finally {
      rmSync(EXTRACT_DIR, { recursive: true, force: true });
    }
  }

  if (failed) {
    console.error("\nContract compatibility check failed.");
    process.exit(1);
  }
  console.log("\nContract compatibility check passed.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
