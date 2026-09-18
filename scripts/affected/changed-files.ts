import { execFileSync } from "node:child_process";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Resolves the base commit to diff against, mirroring
 * `packages/contracts/scripts/check-compatibility.ts`'s proven approach so
 * this tool behaves the same way in the same CI environment: try an explicit
 * override, then `origin/main`, then `HEAD~1`; prefer the merge-base with
 * HEAD when history allows it (so a branch is judged by its own changes), and
 * fall back to the candidate commit itself when a shallow CI checkout has no
 * common ancestor to compute. Returns null if nothing resolves, which the
 * caller must treat as "no known base" and fall back to a full check.
 */
export function resolveBaseRef(
  repoRoot: string,
  override?: string,
): string | null {
  const candidates = override ? [override] : ["origin/main", "HEAD~1"];

  for (const candidate of candidates) {
    const commit = tryGit(
      ["rev-parse", "--verify", `${candidate}^{commit}`],
      repoRoot,
    );
    if (!commit) continue;
    const mergeBase = tryGit(["merge-base", commit, "HEAD"], repoRoot);
    return mergeBase ?? commit;
  }

  return null;
}

/**
 * Lists every file that differs from `baseRef`'s tree in the current working
 * tree (covers committed history since the base, plus anything staged or
 * unstaged locally), plus any untracked file, so a local run reflects changes
 * not yet committed. Paths are repo-root-relative with `/` separators.
 */
export function listChangedFiles(repoRoot: string, baseRef: string): string[] {
  const files = new Set<string>();

  const diff = git(["diff", "--name-only", baseRef, "--", "."], repoRoot);
  for (const line of diff.split("\n")) {
    if (line.trim()) files.add(line.trim());
  }

  const status = git(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repoRoot,
  );
  for (const line of status.split("\n")) {
    if (!line.startsWith("??")) continue;
    const path = line.slice(3).trim();
    if (path) files.add(path);
  }

  return [...files];
}
