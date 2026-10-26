import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  hijackStdoutForMcp,
  jsonRpcFrameLog,
  dispatchMcpMessage,
  setGuards,
  resetLoopBreaker,
  checkLoopBreaker,
  guardMutatingTool,
  windowsToWsl,
  wslToWindows,
  headTailTruncate,
  applyReasoningContentPolicy,
  createReasoningState,
  stripRedactedThinking,
  assertDimensionFingerprint,
  redactSecrets,
} from "../src/bridge.js";
import { shiftPortsInText, buildLocalLlmEnv } from "../src/env-port-shifter.js";
import {
  bootWorktree,
  listWorktrees,
  sanitizeBranch,
  worktreePath,
  worktreeTools,
} from "../src/cli.js";
import { assertWorktreePathContained } from "../src/paths.js";

function initRepo(dir: string): void {
  execSync("git init -b main", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@example.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, ".env"), "PORT=3000\nAPI_URL=http://localhost:3000/api\n");
  mkdirSync(join(dir, "node_modules", "demo-pkg"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "demo-pkg", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.env\n");
  execSync("git add README.md .gitignore", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
}

describe("boot_worktree", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "wtb-"));
    initRepo(repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("does not propagate API keys unless opted in", () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-secret-key-12345678";
    try {
      const res = bootWorktree("feat-no-keys", { portOffset: 2, repoRoot: repo });
      const env = readFileSync(join(res.path, ".env"), "utf8");
      expect(env).not.toMatch(/OPENAI_API_KEY/);
      const withKeys = bootWorktree("feat-keys", {
        portOffset: 3,
        repoRoot: repo,
        propagateApiKeys: true,
      });
      const env2 = readFileSync(join(withKeys.path, ".env"), "utf8");
      expect(env2).toMatch(/OPENAI_API_KEY=sk-test-secret-key-12345678/);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  it("creates worktree with shifted env and node_modules in under 200ms", () => {
    const t0 = performance.now();
    const res = bootWorktree("feat-1", { portOffset: 1, repoRoot: repo });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(existsSync(join(res.path, "node_modules", "demo-pkg", "index.js"))).toBe(true);
    const env = readFileSync(join(res.path, ".env"), "utf8");
    expect(env).toMatch(/PORT=3001/);
    expect(env).toMatch(/localhost:3001/);
    expect(res.ports.app).toBe(3001);
  });
});

describe("env and local LLM", () => {
  it("shifts vite and ollama ports", () => {
    const text = "PORT=3000\nVITE_PORT=5173\nOLLAMA_HOST=127.0.0.1:11434\n";
    const out = shiftPortsInText(text, 1);
    expect(out).toContain("PORT=3001");
    expect(out).toContain("VITE_PORT=5174");
    expect(out).toContain("11435");
    const llm = buildLocalLlmEnv(2);
    expect(llm.LOCAL_LLM_URL).toContain("11436");
  });
});

describe("MCP bridge", () => {
  beforeEach(() => {
    jsonRpcFrameLog.length = 0;
    resetLoopBreaker();
    setGuards({ allowWrite: false, dryRun: false });
    hijackStdoutForMcp();
  });

  it("handshake initialize and tools/list", () => {
    const tools = worktreeTools();
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { meta: { name: "worktree-boot", version: "0.1.0" }, tools, toWsl: false, nCtx: 4096 },
    );
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { meta: { name: "worktree-boot", version: "0.1.0" }, tools, toWsl: false, nCtx: 4096 },
    );
    const init = JSON.parse(jsonRpcFrameLog[0]);
    expect(init.result.serverInfo.name).toBe("worktree-boot");
    const list = JSON.parse(jsonRpcFrameLog[1]);
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("boot_worktree");
  });

  it("blocks destructive teardown without allow-write", () => {
    const tool = worktreeTools().find((t) => t.name === "teardown_worktree")!;
    const guard = guardMutatingTool(tool);
    expect(guard.blocked).toBe(true);
  });

  it("loop breaker trips on triple identical calls", () => {
    expect(checkLoopBreaker("boot_worktree", { branch: "x" })).toBeNull();
    expect(checkLoopBreaker("boot_worktree", { branch: "x" })).toBeNull();
    expect(checkLoopBreaker("boot_worktree", { branch: "x" })).toContain("LOOP_BREAKER");
  });

  it("normalizes windows and wsl paths", () => {
    expect(windowsToWsl("D:\\proj\\app")).toBe("/mnt/d/proj/app");
    expect(wslToWindows("/mnt/d/proj/app")).toBe("D:\\proj\\app");
  });

  it("redacts secrets and truncates long output", () => {
    const red = redactSecrets("api_key=supersecret12345678");
    expect(red).toContain("[REDACTED]");
    const long = "x".repeat(5000);
    expect(headTailTruncate(long, 200).length).toBeLessThan(5000);
  });

  it("reasoning_content policy strips on new user turn", () => {
    const state = createReasoningState();
    state.inToolLoop = true;
    const msgs = applyReasoningContentPolicy(
      [{ role: "assistant", content: "ok", reasoning_content: "think" }],
      state,
      true,
    );
    expect(msgs[0].reasoning_content).toBeUndefined();
  });

  it("strips redacted thinking before tool parse", () => {
    const tag = "redacted_thinking";
    const raw = `<${tag}>plan</${tag}><tool_call>{}</tool_call>`;
    expect(stripRedactedThinking(raw)).toBe("<tool_call>{}</tool_call>");
  });

  it("embedding fingerprint mismatch throws", () => {
    expect(() =>
      assertDimensionFingerprint({ provider: "x", model: "y", dimension: 1024 }, 768),
    ).toThrow(/mismatch/);
  });
});

describe("path containment", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "wtb-path-"));
    initRepo(repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("rejects traversal branch names", () => {
    expect(() => sanitizeBranch("../../../evil")).toThrow(/not allowed/);
    expect(() => sanitizeBranch("..")).toThrow(/Invalid branch/);
    expect(() => sanitizeBranch("feat/evil")).toThrow(/not allowed/);
    expect(() => worktreePath(repo, "../../../evil")).toThrow();
  });

  it("keeps resolved worktree path under .worktrees", () => {
    const res = bootWorktree("safe-branch", { portOffset: 1, repoRoot: repo });
    const contained = assertWorktreePathContained(repo, res.path);
    expect(contained).toBe(res.path);
    expect(res.path.replace(/\\/g, "/")).toContain("/.worktrees/safe-branch");
  });
});

describe("list_worktrees", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "wtb-list-"));
    initRepo(repo);
    bootWorktree("feat-a", { portOffset: 1, repoRoot: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("lists boot worktrees with ports", () => {
    const list = listWorktrees(repo);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].port).toBe(3001);
  });
});
