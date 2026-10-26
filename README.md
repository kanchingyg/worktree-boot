# worktree-boot

[![ci](https://github.com/kanchingyg/worktree-boot/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/worktree-boot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/worktree-boot/latest?label=npm)](https://www.npmjs.com/package/worktree-boot)
[![JSR](https://jsr.io/badges/@kanchingyg/worktree-boot)](https://jsr.io/@kanchingyg/worktree-boot)
[![JSR Score](https://jsr.io/badges/@kanchingyg/worktree-boot/score)](https://jsr.io/@kanchingyg/worktree-boot/score)
[![Rust](https://img.shields.io/badge/engine-Rust_%2B_TypeScript-dea584)](https://github.com/kanchingyg/worktree-boot)
[![license](https://img.shields.io/github/license/kanchingyg/worktree-boot)](https://github.com/kanchingyg/worktree-boot/blob/HEAD/LICENSE)

**One line:** `npx worktree-boot my-branch` (or `bunx worktree-boot my-branch`): `git worktree` + copy-on-write `node_modules` + shifted `.env` ports in about a second.

## Why

Plain `git worktree add` leaves out gitignored `.env` files, starts with an empty `node_modules`, and keeps identical `PORT=3000` values so parallel dev servers collide. Docker devcontainers isolate ports but cost gigabytes of RAM and slow boot times.

`worktree-boot` clones heavy folders using `cp --reflink=auto` on Linux and macOS when the filesystem supports it (falling back to a recursive copy otherwise, and using recursive copy on Windows). It copies `.env*`, shifts ports (`3000 -> 3001`, `5173 -> 5174`), and wires `LOCAL_LLM_URL` / `OLLAMA_HOST` for local LLM stacks. Provider API keys are **not** copied unless you pass `--propagate-api-keys` (CLI) or `propagateApiKeys: true` (MCP).

## Install

[Bun](https://bun.sh) / [npm](https://www.npmjs.com/package/worktree-boot):

```bash
bunx worktree-boot agent-2 --allow-write
npx worktree-boot agent-2 --allow-write

# or install in your project / globally
bun add -d worktree-boot
npm i -D worktree-boot
```

[JSR](https://jsr.io/@kanchingyg/worktree-boot):

```bash
bunx jsr add @kanchingyg/worktree-boot
npx jsr add @kanchingyg/worktree-boot
```

[Cargo (Rust native binary)](https://github.com/kanchingyg/worktree-boot):

```bash
cargo install --git https://github.com/kanchingyg/worktree-boot
```

The core engine is **Rust** (`src/lib.rs`, `src/main.rs`, `src/mcp.rs`). TypeScript under `src/*.ts` is included for `npx` / `bunx` / JSR usage and MCP bridge helpers.

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
bunx worktree-boot --mcp --allow-write
```

Add to your agent MCP config with `command: npx` and `args: ["-y", "worktree-boot", "--mcp", "--allow-write"]`.

## Ollama / OpenAI-compatible locals

Each worktree gets offset ports on `OLLAMA_HOST` and `LOCAL_LLM_URL` so you can run several coding agents against local inference without re-indexing or reinstalling dependencies.

## MCP Tools Reference

| Tool | Mutates | Description |
| --- | --- | --- |
| `create_worktree` | `true` | Create a git worktree, reflink-clone `node_modules`, copy `.env*` without cloud API keys by default, and shift dev ports (requires `--allow-write`). |
| `list_worktrees` | `false` | List active worktrees managed under `.worktrees/` and their assigned port offsets. |
| `teardown_worktree` | `true` | Remove a managed worktree directory and prune its git worktree metadata (requires `--allow-write`). |

## Editor and Agent Integration

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "worktree-boot": {
      "command": "npx",
      "args": ["-y", "worktree-boot", "--mcp"]
    }
  }
}
```

### Claude Code CLI

```bash
claude mcp add worktree-boot -- npx -y worktree-boot --mcp
```

### Programmatic Usage (JSR / TypeScript)

```ts
import * as bridge from "jsr:@kanchingyg/worktree-boot/bridge";
```

## Runtime Safety and Guardrails

- **Stdio frame isolation**: When `--mcp` is active, `hijackStdoutForMcp()` redirects accidental `console.log` calls to `stderr` so JSON-RPC 2.0 frames on `stdout` never corrupt.
- **Read-only by default**: Mutating tools (`mutates: true`) are blocked in `--dry-run` mode and require explicit `--allow-write` authorization.
- **Loop breaker**: Repeated identical `(toolName, args)` invocations are hashed with SHA-256 and halted after 3 consecutive repeats to prevent runaway agent loops.
- **Context budget truncation**: Tool outputs are middle-truncated (`60%` head / `40%` tail) scaled to the probed local model `n_ctx` (Ollama `/api/show`, llama.cpp `/props`, vLLM `/v1/models`).
- **Secret redaction and path normalization**: AWS keys (`AKIA*`, `ASIA*`), bearer tokens, and `sk-*` keys are scrubbed before returning tool output, and Windows drive paths (`C:\...`) translate cleanly to `/mnt/c/...` when WSL mode is enabled.

## License

[MIT](./LICENSE)
