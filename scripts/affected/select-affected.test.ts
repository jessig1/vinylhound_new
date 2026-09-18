import { describe, expect, it } from "vitest";

import { selectAffected } from "./select-affected.ts";
import type { Workspace, WorkspaceGraph } from "./workspace-graph.ts";

// Mirrors the real repo's shape closely enough to exercise every rule:
// contracts <- domain, catalog <- (nothing else); domain <- database <- worker;
// worker and web both depend on contracts directly too.
function testGraph(): WorkspaceGraph {
  const workspaces: Workspace[] = [
    {
      name: "@vinylhound/contracts",
      dir: "packages/contracts",
      internalDependencies: [],
      hasBuildScript: false,
    },
    {
      name: "@vinylhound/domain",
      dir: "packages/domain",
      internalDependencies: ["@vinylhound/contracts"],
      hasBuildScript: false,
    },
    {
      name: "@vinylhound/catalog",
      dir: "packages/catalog",
      internalDependencies: ["@vinylhound/contracts"],
      hasBuildScript: false,
    },
    {
      name: "@vinylhound/database",
      dir: "packages/database",
      internalDependencies: ["@vinylhound/contracts", "@vinylhound/domain"],
      hasBuildScript: false,
    },
    {
      name: "@vinylhound/worker",
      dir: "apps/worker",
      internalDependencies: ["@vinylhound/contracts", "@vinylhound/database"],
      hasBuildScript: true,
    },
    {
      name: "@vinylhound/web",
      dir: "apps/web",
      internalDependencies: ["@vinylhound/contracts", "@vinylhound/catalog"],
      hasBuildScript: true,
    },
  ];

  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const byDir = new Map(workspaces.map((w) => [w.dir, w]));
  const dependents = new Map<string, string[]>();
  for (const w of workspaces) dependents.set(w.name, []);
  for (const w of workspaces) {
    for (const dep of w.internalDependencies) dependents.get(dep)?.push(w.name);
  }

  return { workspaces, byName, byDir, dependents };
}

describe("selectAffected", () => {
  it("scopes to a single leaf workspace with no dependents", () => {
    const result = selectAffected(["packages/catalog/src/x.ts"], testGraph());

    expect(result.fallbackFull).toBe(false);
    expect(result.changedWorkspaces).toEqual(["@vinylhound/catalog"]);
    // catalog has no dependents in this graph beyond web (which depends on it directly).
    expect(result.affectedWorkspaces.sort()).toEqual(
      ["@vinylhound/catalog", "@vinylhound/web"].sort(),
    );
  });

  it("closes over the full dependent chain for a widely-depended-on package", () => {
    const result = selectAffected(
      ["packages/contracts/src/scan.ts"],
      testGraph(),
    );

    expect(result.fallbackFull).toBe(false);
    expect(result.affectedWorkspaces.sort()).toEqual(
      [
        "@vinylhound/contracts",
        "@vinylhound/domain",
        "@vinylhound/catalog",
        "@vinylhound/database",
        "@vinylhound/worker",
        "@vinylhound/web",
      ].sort(),
    );
  });

  it("ignores documentation and infra-only changes", () => {
    const result = selectAffected(
      [
        "docs/ROADMAP.md",
        "infra/terraform/development/main.tf",
        ".claude/settings.json",
      ],
      testGraph(),
    );

    expect(result.fallbackFull).toBe(false);
    expect(result.changedWorkspaces).toEqual([]);
    expect(result.affectedWorkspaces).toEqual([]);
  });

  it("falls back to a full check for a root config file", () => {
    const result = selectAffected(
      ["package.json", "packages/catalog/src/x.ts"],
      testGraph(),
    );

    expect(result.fallbackFull).toBe(true);
  });

  it("falls back to a full check for an unrecognized top-level path", () => {
    const result = selectAffected(["Dockerfile.web"], testGraph());

    expect(result.fallbackFull).toBe(true);
  });

  it("falls back to a full check for a path under an unknown workspace-shaped directory", () => {
    // apps/new-service doesn't exist in the graph (not yet a registered workspace).
    const result = selectAffected(
      ["apps/new-service/src/index.ts"],
      testGraph(),
    );

    expect(result.fallbackFull).toBe(true);
  });

  it("reports nothing affected when every changed file is ignored", () => {
    const result = selectAffected(["README.md"], testGraph());

    expect(result.fallbackFull).toBe(false);
    expect(result.affectedWorkspaces).toEqual([]);
  });

  it("combines multiple directly-changed workspaces into one closure", () => {
    const result = selectAffected(
      ["packages/domain/src/a.ts", "packages/database/src/b.ts"],
      testGraph(),
    );

    expect(result.fallbackFull).toBe(false);
    expect(result.changedWorkspaces.sort()).toEqual(
      ["@vinylhound/domain", "@vinylhound/database"].sort(),
    );
    expect(result.affectedWorkspaces.sort()).toEqual(
      [
        "@vinylhound/domain",
        "@vinylhound/database",
        "@vinylhound/worker",
      ].sort(),
    );
  });
});
