---
name: worktree-boot
description: Spin up parallel git worktrees with CoW node_modules, copied env files, and shifted ports.
---

# worktree-boot

Use when you need a second agent on the same repo without `npm install` or port collisions.

## CLI

```bash
npx worktree-boot feat-agent-2
npx worktree-boot list
npx worktree-boot teardown feat-agent-2 --allow-write
```

## MCP (Cursor, Claude Code, Pi, OMP, Hermes)

```json
{
  "mcpServers": {
    "worktree-boot": {
      "command": "npx",
      "args": ["-y", "worktree-boot", "--mcp", "--allow-write"]
    }
  }
}
```

Tools: `boot_worktree`, `list_worktrees`, `teardown_worktree` (destructive; needs `--allow-write`).

## Local models

Boot copies `.env*` and shifts `PORT`, `OLLAMA_HOST`, and `LOCAL_LLM_URL` so multiple Ollama/vLLM agents can run in parallel.
