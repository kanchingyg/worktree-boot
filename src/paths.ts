import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const BRANCH_SAFE_RE = /[^a-zA-Z0-9._-]/g;

export function sanitizeBranch(branch: string): string {
  if (!branch || branch === "." || branch === "..") {
    throw new Error("Invalid branch name");
  }
  if (branch.includes("..") || branch.includes("/") || branch.includes("\\")) {
    throw new Error("Invalid branch name: path traversal characters not allowed");
  }
  const sanitized = branch.replace(BRANCH_SAFE_RE, "-");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error("Invalid branch name");
  }
  return sanitized;
}

function resolvedWorktreesRoot(repoRoot: string): string {
  return resolve(repoRoot, ".worktrees");
}

export function worktreePath(repoRoot: string, branch: string): string {
  const safe = sanitizeBranch(branch);
  const base = resolvedWorktreesRoot(repoRoot);
  const wtPath = resolve(base, safe);
  const rel = relative(base, wtPath);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new Error("Worktree path escapes .worktrees directory");
  }
  return wtPath;
}

export function assertWorktreePathContained(repoRoot: string, wtPath: string): string {
  const base = resolvedWorktreesRoot(repoRoot);
  mkdirSync(base, { recursive: true });
  const realBase = realpathSync(base);
  const candidate = resolve(wtPath);
  const realWt = existsSync(candidate) ? realpathSync(candidate) : candidate;
  const rel = relative(realBase, realWt);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..") || isAbsolute(rel)) {
    throw new Error("Worktree path escapes .worktrees directory");
  }
  return realWt;
}
