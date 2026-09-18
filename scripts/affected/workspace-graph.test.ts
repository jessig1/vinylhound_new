import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildWorkspaceGraph,
  closeOverDependents,
  type WorkspaceGraph,
} from "./workspace-graph.ts";

function dependentsGraph(dependents: [string, string[]][]): WorkspaceGraph {
  return {
    workspaces: [],
    byName: new Map(),
    byDir: new Map(),
    dependents: new Map(dependents),
  };
}

function writeWorkspace(
  repoRoot: string,
  dir: string,
  name: string,
  dependencies: Record<string, string> = {},
  scripts: Record<string, string> = {},
) {
  const absDir = join(repoRoot, dir);
  mkdirSync(absDir, { recursive: true });
  writeFileSync(
    join(absDir, "package.json"),
    JSON.stringify({ name, dependencies, scripts }),
  );
}

describe("buildWorkspaceGraph", () => {
  it("discovers apps/* and packages/* workspaces and their internal deps", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "affected-graph-"));
    try {
      writeWorkspace(repoRoot, "packages/contracts", "@vinylhound/contracts");
      writeWorkspace(repoRoot, "packages/domain", "@vinylhound/domain", {
        "@vinylhound/contracts": "0.1.0",
      });
      writeWorkspace(
        repoRoot,
        "apps/web",
        "@vinylhound/web",
        { "@vinylhound/domain": "0.1.0", next: "16.0.0" },
        { build: "next build" },
      );

      const graph = buildWorkspaceGraph(repoRoot);

      expect(graph.workspaces.map((w) => w.name).sort()).toEqual([
        "@vinylhound/contracts",
        "@vinylhound/domain",
        "@vinylhound/web",
      ]);
      expect(graph.byDir.get("apps/web")?.hasBuildScript).toBe(true);
      expect(
        graph.byName.get("@vinylhound/domain")?.internalDependencies,
      ).toEqual(["@vinylhound/contracts"]);
      // Third-party deps (e.g. "next") never appear as internal edges.
      expect(graph.byName.get("@vinylhound/web")?.internalDependencies).toEqual(
        ["@vinylhound/domain"],
      );
      expect(graph.dependents.get("@vinylhound/contracts")).toEqual([
        "@vinylhound/domain",
      ]);
      expect(graph.dependents.get("@vinylhound/domain")).toEqual([
        "@vinylhound/web",
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("skips directories with no package.json", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "affected-graph-"));
    try {
      mkdirSync(join(repoRoot, "packages", "empty-dir"), { recursive: true });
      writeWorkspace(repoRoot, "packages/contracts", "@vinylhound/contracts");

      const graph = buildWorkspaceGraph(repoRoot);

      expect(graph.workspaces).toHaveLength(1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("closeOverDependents", () => {
  it("returns only the changed set when nothing depends on it", () => {
    const graph = dependentsGraph([
      ["a", []],
      ["b", []],
    ]);

    expect(closeOverDependents(new Set(["a"]), graph)).toEqual(new Set(["a"]));
  });

  it("closes transitively over the dependent chain", () => {
    // contracts <- domain <- database <- worker
    const graph = dependentsGraph([
      ["contracts", ["domain"]],
      ["domain", ["database"]],
      ["database", ["worker"]],
      ["worker", []],
    ]);

    const affected = closeOverDependents(new Set(["contracts"]), graph);

    expect([...affected].sort()).toEqual([
      "contracts",
      "database",
      "domain",
      "worker",
    ]);
  });

  it("does not revisit a workspace reachable through two paths", () => {
    // both "a" and "b" depend on "shared"; both "web" depends on "a" and "b".
    const graph = dependentsGraph([
      ["shared", ["a", "b"]],
      ["a", ["web"]],
      ["b", ["web"]],
      ["web", []],
    ]);

    const affected = closeOverDependents(new Set(["shared"]), graph);

    expect([...affected].sort()).toEqual(["a", "b", "shared", "web"]);
  });
});
