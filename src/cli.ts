#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setGuards, startMcpServer, type WorktreeToolDef } from "./bridge.js";
import { buildLocalLlmEnv, mergeEnvLines, shiftPortsInText } from "./env-port-shifter.js";
import { assertWorktreePathContained, sanitizeBranch, worktreePath } from "./paths.js";
import { cloneCowArtifacts, copyIgnoredEnvFiles } from "./worktree-cow.js";

const VERSION = "0.1.1";

const PROPAGATE_KEYS = [
  "DEEPSEEK_API_KEY",
  "DASHSCOPE_API_KEY",
  "SILICONFLOW_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENAI_API_KEY",
] as const;

export type BootWorktreeOpts = {
  repoRoot?: string;
  portOffset?: number;
  dryRun?: boolean;
  propagateApiKeys?: boolean;
};

export type TeardownWorktreeOpts = {
  repoRoot?: string;
  confirm?: boolean;
  dryRun?: boolean;
};

export { sanitizeBranch, worktreePath };

export function gitRoot(cwd = process.cwd()): string {
  return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8" }).trim();
}

export function listWorktrees(repoRoot: string) {
  const out = execSync("git worktree list --porcelain", { cwd: repoRoot, encoding: "utf8" });
  const entries: { branch: string; path: string; port?: number }[] = [];
  let path = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9).trim();
    if (line.startsWith("branch ") && path.includes(".worktrees")) {
      const branch = line.replace("branch refs/heads/", "").trim();
      let port: number | undefined;
      const envPath = join(path, ".env");
      if (existsSync(envPath)) {
        const m = readFileSync(envPath, "utf8").match(/^PORT=(\d+)/m);
        if (m) port = parseInt(m[1], 10);
      }
      entries.push({ branch, path, port });
    }
  }
  return entries;
}

export function defaultPortOffset(repoRoot: string): number {
  return listWorktrees(repoRoot).length + 1;
}

export function bootWorktree(branch: string, opts?: BootWorktreeOpts) {
  const repoRoot = opts?.repoRoot ?? gitRoot();
  const portOffset = opts?.portOffset ?? defaultPortOffset(repoRoot);
  const wtPath = worktreePath(repoRoot, branch);
  const cloned: string[] = [];
  const envFiles: string[] = [];

  if (opts?.dryRun) {
    const cow = cloneCowArtifacts(repoRoot, wtPath, { dryRun: true });
    return {
      branch: sanitizeBranch(branch),
      path: wtPath,
      portOffset,
      ports: { app: 3000 + portOffset, vite: 5173 + portOffset },
      cloned: cow.cloned,
      envFiles: copyIgnoredEnvFiles(repoRoot, wtPath, { dryRun: true }),
    };
  }

  execSync(`git worktree add "${wtPath}" -b "${sanitizeBranch(branch)}"`, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const containedPath = assertWorktreePathContained(repoRoot, wtPath);

  const cow = cloneCowArtifacts(repoRoot, containedPath);
  cloned.push(...cow.cloned);
  envFiles.push(...copyIgnoredEnvFiles(repoRoot, containedPath));
  for (const ent of envFiles) {
    const p = join(containedPath, ent);
    if (!existsSync(p)) continue;
    const shifted = shiftPortsInText(readFileSync(p, "utf8"), portOffset);
    const extras = buildLocalLlmEnv(portOffset);
    if (opts?.propagateApiKeys) {
      for (const k of PROPAGATE_KEYS) {
        if (process.env[k]) extras[k] = process.env[k]!;
      }
    }
    writeFileSync(p, mergeEnvLines(shifted, extras));
  }
  return {
    branch: sanitizeBranch(branch),
    path: containedPath,
    portOffset,
    ports: { app: 3000 + portOffset, vite: 5173 + portOffset },
    cloned,
    envFiles,
  };
}

export function teardownWorktree(branch: string, opts?: TeardownWorktreeOpts) {
  if (!opts?.confirm) {
    throw new Error("teardown_worktree requires confirm: true");
  }
  const repoRoot = opts?.repoRoot ?? gitRoot();
  const wtPath = worktreePath(repoRoot, branch);
  if (opts?.dryRun) return { removed: wtPath };
  try {
    execSync(`git worktree remove "${wtPath}" --force`, { cwd: repoRoot, stdio: "pipe" });
  } catch {
    if (existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true });
  }
  return { removed: wtPath };
}

export function worktreeTools(): WorktreeToolDef[] {
  return [
    {
      name: "boot_worktree",
      description: "Create isolated git worktree with CoW deps and ports.",
      inputSchema: {
        type: "object",
        properties: {
          branch: { type: "string" },
          portOffset: { type: "number" },
          propagateApiKeys: {
            type: "boolean",
            description: "When true, copy provider API keys from the parent process env into the worktree .env",
          },
        },
        required: ["branch"],
        additionalProperties: false,
      },
      annotations: { destructiveHint: true },
      mutates: true,
      handler: (args, ctx) =>
        bootWorktree(String(args.branch), {
          portOffset: typeof args.portOffset === "number" ? args.portOffset : undefined,
          propagateApiKeys: Boolean(args.propagateApiKeys),
          dryRun: ctx.dryRun,
        }),
    },
    {
      name: "list_worktrees",
      description: "List active boot worktrees and assigned ports.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      handler: () => ({ worktrees: listWorktrees(gitRoot()) }),
    },
    {
      name: "teardown_worktree",
      description: "Remove a boot worktree and clean its directory.",
      inputSchema: {
        type: "object",
        properties: {
          branch: { type: "string" },
          confirm: { type: "boolean" },
        },
        required: ["branch", "confirm"],
        additionalProperties: false,
      },
      annotations: { destructiveHint: true },
      mutates: true,
      handler: (args, ctx) =>
        teardownWorktree(String(args.branch), {
          confirm: Boolean(args.confirm),
          dryRun: ctx.dryRun,
        }),
    },
  ];
}

function printHelp(): void {
  process.stderr.write(
    "worktree-boot <branch> [--allow-write] [--dry-run] [--propagate-api-keys] | list | teardown <branch> | --mcp [--allow-write] [--dry-run]\n",
  );
}

function cliGuardsFromArgv(argv: string[]): { allowWrite: boolean; dryRun: boolean } {
  const dryRun = argv.includes("--dry-run");
  const allowWrite = argv.includes("--allow-write");
  setGuards({ allowWrite, dryRun });
  return { allowWrite, dryRun };
}

function requireWriteOrDryRun(allowWrite: boolean, dryRun: boolean, action: string): number | null {
  if (!allowWrite && !dryRun) {
    process.stderr.write(`Pass --allow-write or --dry-run to ${action}.\n`);
    return 1;
  }
  return null;
}

function runCli(argv: string[]): number {
  if (argv.includes("--mcp")) {
    const { allowWrite, dryRun } = cliGuardsFromArgv(argv);
    startMcpServer({ name: "worktree-boot", version: VERSION }, worktreeTools(), {
      allowWrite,
      dryRun,
    });
    return 0;
  }

  const { allowWrite, dryRun } = cliGuardsFromArgv(argv);
  const propagateApiKeys = argv.includes("--propagate-api-keys");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const cmd = positional[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    printHelp();
    return 2;
  }
  if (cmd === "list") {
    process.stdout.write(JSON.stringify(listWorktrees(gitRoot()), null, 2) + "\n");
    return 0;
  }
  if (cmd === "teardown") {
    const branch = positional[1];
    if (!branch) return 2;
    const gate = requireWriteOrDryRun(allowWrite, dryRun, "teardown");
    if (gate !== null) return gate;
    process.stdout.write(
      JSON.stringify(teardownWorktree(branch, { confirm: true, dryRun }), null, 2) + "\n",
    );
    return 0;
  }
  const gate = requireWriteOrDryRun(allowWrite, dryRun, "boot a worktree");
  if (gate !== null) return gate;
  process.stdout.write(
    JSON.stringify(
      bootWorktree(cmd, { dryRun, propagateApiKeys }),
      null,
      2,
    ) + "\n",
  );
  return 0;
}

const isMain =
  process.argv[1]?.includes("cli") || process.argv[1]?.endsWith("worktree-boot");
if (isMain && !process.env.VITEST) {
  process.exit(runCli(process.argv.slice(2)));
}
