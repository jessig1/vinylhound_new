import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Workspace {
  /** Package name, e.g. "@vinylhound/contracts". */
  name: string;
  /** Directory relative to the repository root, e.g. "packages/contracts". */
  dir: string;
  /** Internal (@vinylhound/*) package names this workspace depends on. */
  internalDependencies: string[];
  hasBuildScript: boolean;
}

export interface WorkspaceGraph {
  workspaces: Workspace[];
  byName: Map<string, Workspace>;
  /** dir -> workspace, for classifying a changed file path. */
  byDir: Map<string, Workspace>;
  /** package name -> package names that depend on it (direct + nothing computed yet). */
  dependents: Map<string, string[]>;
}

const WORKSPACE_ROOTS = ["apps", "packages"];

function readPackageJson(dir: string): {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
} {
  const raw = readFileSync(join(dir, "package.json"), "utf8");
  return JSON.parse(raw);
}

/**
 * Discovers every `apps/*` and `packages/*` workspace and builds the internal
 * (`@vinylhound/*`) dependency graph from each package.json's declared
 * dependencies. Only internal edges matter for affected-workspace selection;
 * third-party dependency changes arrive as lockfile/root changes, which the
 * caller treats as a full-fallback trigger.
 */
export function buildWorkspaceGraph(repoRoot: string): WorkspaceGraph {
  const workspaces: Workspace[] = [];

  for (const root of WORKSPACE_ROOTS) {
    const rootPath = join(repoRoot, root);
    if (!existsSync(rootPath)) continue;
    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${root}/${entry.name}`;
      const packageJsonPath = join(repoRoot, dir, "package.json");
      if (!existsSync(packageJsonPath)) continue;
      const pkg = readPackageJson(join(repoRoot, dir));
      if (!pkg.name) continue;

      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const internalDependencies = Object.keys(deps).filter((name) =>
        name.startsWith("@vinylhound/"),
      );

      workspaces.push({
        name: pkg.name,
        dir,
        internalDependencies,
        hasBuildScript: typeof pkg.scripts?.build === "string",
      });
    }
  }

  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const byDir = new Map(workspaces.map((w) => [w.dir, w]));

  const dependents = new Map<string, string[]>();
  for (const workspace of workspaces) dependents.set(workspace.name, []);
  for (const workspace of workspaces) {
    for (const dep of workspace.internalDependencies) {
      const existing = dependents.get(dep);
      if (existing) existing.push(workspace.name);
    }
  }

  return { workspaces, byName, byDir, dependents };
}

/**
 * Expands a set of directly-changed workspace names into the full dependency
 * closure: every workspace that depends on a changed one, transitively, since
 * a change to a dependency can break any consumer.
 */
export function closeOverDependents(
  changed: ReadonlySet<string>,
  graph: WorkspaceGraph,
): Set<string> {
  const affected = new Set<string>(changed);
  const queue = [...changed];

  while (queue.length > 0) {
    const name = queue.pop();
    if (!name) continue;
    for (const dependent of graph.dependents.get(name) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }

  return affected;
}
