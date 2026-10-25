import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { platform } from "node:os";
import { KNOWN_DIMENSIONS, readEmbedLock } from "./bridge.js";

const COW_TARGETS = ["node_modules", ".next", ".turbo", ".cache"];

export function validateEmbeddingDimension(dim: number): void {
  if (dim < 384 || dim > 4096) {
    throw new Error(`Embedding dimension ${dim} outside supported range 384-4096`);
  }
  if (!KNOWN_DIMENSIONS.includes(dim)) {
    throw new Error(`Embedding dimension ${dim} not in fingerprint set`);
  }
}

export function readLanceDimensionHint(repoRoot: string): number | null {
  const lock = readEmbedLock(repoRoot);
  if (lock) {
    validateEmbeddingDimension(lock.dimension);
    return lock.dimension;
  }
  const meta = join(repoRoot, ".kilocode", "embeddings-meta.json");
  if (!existsSync(meta)) return null;
  try {
    const j = JSON.parse(readFileSync(meta, "utf8")) as { dimension?: number };
    if (typeof j.dimension === "number") {
      validateEmbeddingDimension(j.dimension);
      return j.dimension;
    }
  } catch {
    return null;
  }
  return null;
}

function tryReflinkCopy(src: string, dest: string): boolean {
  if (platform() === "win32") return false;
  const result = spawnSync("cp", ["--reflink=auto", "-r", src, dest], {
    stdio: "pipe",
    shell: false,
  });
  return result.status === 0;
}

export function cowCopyPath(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dirname(dest), { recursive: true });
  if (tryReflinkCopy(src, dest)) return;
  cpSync(src, dest, { recursive: true, force: true, errorOnExist: false });
}

export type CloneCowOpts = { dryRun?: boolean };

export function cloneCowArtifacts(
  repoRoot: string,
  worktreeRoot: string,
  opts?: CloneCowOpts,
) {
  const cloned: string[] = [];
  const embedLock = readEmbedLock(repoRoot);
  if (opts?.dryRun) {
    for (const name of COW_TARGETS) {
      if (existsSync(join(repoRoot, name))) cloned.push(name);
    }
    const lance = join(repoRoot, ".kilocode", "lancedb");
    if (existsSync(lance)) cloned.push(".kilocode/lancedb");
    return { cloned, embedLock };
  }
  for (const name of COW_TARGETS) {
    const src = join(repoRoot, name);
    if (!existsSync(src)) continue;
    cowCopyPath(src, join(worktreeRoot, name));
    cloned.push(name);
  }
  const lanceSrc = join(repoRoot, ".kilocode", "lancedb");
  if (existsSync(lanceSrc)) {
    const dim = readLanceDimensionHint(repoRoot);
    if (dim) validateEmbeddingDimension(dim);
    cowCopyPath(lanceSrc, join(worktreeRoot, ".kilocode", "lancedb"));
    cloned.push(".kilocode/lancedb");
  }
  for (const ent of readdirSync(repoRoot)) {
    if (!ent.endsWith(".db") && !ent.endsWith(".sqlite")) continue;
    const src = join(repoRoot, ent);
    if (!statSync(src).isFile()) continue;
    cowCopyPath(src, join(worktreeRoot, ent));
    cloned.push(ent);
  }
  return { cloned, embedLock };
}

export function copyIgnoredEnvFiles(
  repoRoot: string,
  worktreeRoot: string,
  opts?: CloneCowOpts,
): string[] {
  const copied: string[] = [];
  for (const ent of readdirSync(repoRoot)) {
    if (!ent.startsWith(".env")) continue;
    const src = join(repoRoot, ent);
    if (!statSync(src).isFile()) continue;
    copied.push(ent);
    if (!opts?.dryRun) {
      cowCopyPath(src, join(worktreeRoot, ent));
    }
  }
  return copied;
}
