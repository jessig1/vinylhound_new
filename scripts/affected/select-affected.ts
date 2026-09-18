import { closeOverDependents, type WorkspaceGraph } from "./workspace-graph.ts";

export interface SelectionResult {
  /** True when a changed path could not be safely scoped; caller must run everything. */
  fallbackFull: boolean;
  reason: string;
  /** Workspaces containing a directly changed file. */
  changedWorkspaces: string[];
  /** `changedWorkspaces` closed over transitive dependents; empty when `fallbackFull`. */
  affectedWorkspaces: string[];
}

/**
 * Paths that can never change build or test outcomes: documentation,
 * Terraform/AWS operational scripts, agent-session scaffolding, and
 * top-level community-health files. Anything else outside a known
 * `apps/*`/`packages/*` workspace (root config, Dockerfiles, CI workflows,
 * unrecognized top-level scripts) is treated as affecting everything —
 * the conservative default is "don't know" means "run it all".
 */
const IGNORED_PREFIXES = [
  "docs/",
  "infra/",
  "aws/",
  ".claude/",
  ".github/ISSUE_TEMPLATE/",
];

const IGNORED_FILES = new Set([
  "README.md",
  "LICENSE",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  ".editorconfig",
  ".gitignore",
  ".dockerignore",
  ".prettierignore",
  ".trivyignore",
]);

function isIgnored(path: string): boolean {
  if (IGNORED_FILES.has(path)) return true;
  return IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function matchWorkspace(path: string, graph: WorkspaceGraph) {
  for (const workspace of graph.workspaces) {
    if (path === workspace.dir || path.startsWith(`${workspace.dir}/`)) {
      return workspace;
    }
  }
  return undefined;
}

export function selectAffected(
  changedFiles: readonly string[],
  graph: WorkspaceGraph,
): SelectionResult {
  const changedWorkspaceNames = new Set<string>();

  for (const rawPath of changedFiles) {
    const path = rawPath.replaceAll("\\", "/");
    if (isIgnored(path)) continue;

    const workspace = matchWorkspace(path, graph);
    if (workspace) {
      changedWorkspaceNames.add(workspace.name);
      continue;
    }

    return {
      fallbackFull: true,
      reason: `"${path}" is outside every known workspace and outside the safe-ignore list.`,
      changedWorkspaces: [],
      affectedWorkspaces: [],
    };
  }

  const affected = closeOverDependents(changedWorkspaceNames, graph);

  return {
    fallbackFull: false,
    reason:
      changedWorkspaceNames.size === 0
        ? "No changed file maps to a workspace."
        : `${changedWorkspaceNames.size} workspace(s) changed directly, closed over their dependents.`,
    changedWorkspaces: [...changedWorkspaceNames].sort(),
    affectedWorkspaces: [...affected].sort(),
  };
}
