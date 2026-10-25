# worktree-boot

**One line:** `npx worktree-boot my-branch` — git worktree + CoW `node_modules` + shifted `.env` ports in about a second.

## Why

Plain `git worktree add` leaves out gitignored `.env` files, empty `node_modules`, and identical `PORT=3000` values. Parallel dev servers collide. Docker devcontainers isolate but cost RAM and boot time.

`worktree-boot` clones heavy folders using `cp --reflink=auto` on Linux and macOS when the filesystem supports it (falls back to a full recursive copy otherwise). On Windows it always performs a full recursive copy — there is no reflink or junction shortcut today. It copies `.env*`, bumps ports (`3000→3001`, `5173→5174`), and wires `LOCAL_LLM_URL` / `OLLAMA_HOST` for local LLM stacks. Provider API keys are **not** copied unless you pass `--propagate-api-keys` (CLI) or `propagateApiKeys: true` (MCP).

## Install

```bash
npx worktree-boot agent-2 --allow-write   # Node wrapper (vendored TS + MCP bridge)
cargo install --path .                    # native CLI on PATH as `worktree-boot`
```

The core engine is **Rust** (`src/lib.rs`, `src/main.rs`, `src/mcp.rs`). TypeScript under `src/*.ts` is vendored for `npx` fallback and MCP bridge helpers.

## Quick start

```bash
npx worktree-boot agent-2 --allow-write
cd .worktrees/agent-2
npm run dev
```

```bash
npx worktree-boot list
npx worktree-boot teardown agent-2 --allow-write
npx worktree-boot agent-3 --dry-run   # preview paths, clones, and ports without writing
```

## MCP

```bash
npx worktree-boot --mcp --allow-write
```

Add to your agent MCP config with `command: npx` and `args: ["-y", "worktree-boot", "--mcp", "--allow-write"]`.

## Ollama / OpenAI-compatible locals

Each worktree gets offset ports on `OLLAMA_HOST` and `LOCAL_LLM_URL` so you can run several agents against local inference without re-indexing or reinstalling deps.
