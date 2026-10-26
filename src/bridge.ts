import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
export const DEFAULT_N_CTX = 4096;
export const TRUNCATION_MARKER = "[...TRUNCATED BY WORKTREE-BOOT CONTEXT GUARD...]";

let allowWrite = false;
let dryRun = false;
export function setGuards(opts: { allowWrite?: boolean; dryRun?: boolean }): void {
  if (opts.allowWrite !== undefined) allowWrite = Boolean(opts.allowWrite);
  if (opts.dryRun !== undefined) dryRun = Boolean(opts.dryRun);
}
export function canonicalizeJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalizeJson(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`).join(",")}}`;
}

const loopState = { lastHash: "", repeatCount: 0 };
export function resetLoopBreaker(): void {
  loopState.lastHash = "";
  loopState.repeatCount = 0;
}
export function checkLoopBreaker(toolName: string, args: unknown): string | null {
  const h = createHash("sha256")
    .update(`${toolName}:${canonicalizeJson(args)}`)
    .digest("hex");
  if (h === loopState.lastHash) loopState.repeatCount++;
  else {
    loopState.lastHash = h;
    loopState.repeatCount = 1;
  }
  if (loopState.repeatCount >= 3) {
    return "LOOP_BREAKER: Identical tool call repeated 2 times consecutively. Stop calling tools and return your final synthesis.";
  }
  return null;
}
export type WorktreeToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  mutates?: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolHandlerContext) => unknown | Promise<unknown>;
};
export type ToolHandlerContext = {
  dryRun: boolean;
  allowWrite: boolean;
  nCtx: number;
};
export function guardMutatingTool(tool: WorktreeToolDef): { blocked: boolean; reason?: string } {
  if (!tool.mutates && !tool.annotations?.destructiveHint) return { blocked: false };
  if (dryRun) return { blocked: false };
  if (!allowWrite) {
    return { blocked: true, reason: "Read-only mode: pass --allow-write to enable mutating tools." };
  }
  return { blocked: false };
}

const WIN_DRIVE_RE = /^([A-Za-z]):\\(.*)$/;
const WSL_RE = /^\/mnt\/([a-z])\/(.*)$/i;
export function windowsToWsl(p: string): string {
  const m = p.match(WIN_DRIVE_RE);
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}
export function wslToWindows(p: string): string {
  const m = p.match(WSL_RE);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
}
export function normalizePathsDeep(value: unknown, toWsl: boolean): unknown {
  if (typeof value === "string") {
    if (toWsl && WIN_DRIVE_RE.test(value)) return windowsToWsl(value);
    if (!toWsl && WSL_RE.test(value)) return wslToWindows(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => normalizePathsDeep(v, toWsl));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizePathsDeep(v, toWsl);
    return out;
  }
  return value;
}

const SECRET_RE = /(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[\w-]{8,}/gi;
export function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, (m) => m.split(/[:=]/)[0] + "=[REDACTED]");
}

let stdoutHijacked = false;
let jsonRpcWrite: ((line: string) => boolean) | null = null;
export function hijackStdoutForMcp(): void {
  if (stdoutHijacked) return;
  stdoutHijacked = true;
  const native = process.stdout.write.bind(process.stdout);
  jsonRpcWrite = (line: string) => native(line);
  process.stdout.write = ((chunk, ...args: unknown[]) => {
    const str = typeof chunk === "string" ? chunk : Buffer.from(chunk as Buffer).toString();
    if (jsonRpcWrite && str.trim().startsWith("{") && str.includes('"jsonrpc"')) {
      return native(chunk as string | Uint8Array, ...(args as []));
    }
    process.stderr.write(str);
    return true;
  }) as typeof process.stdout.write;
}
export const jsonRpcFrameLog: string[] = [];
export function writeJsonRpcFrame(obj: Record<string, unknown>): void {
  const line = JSON.stringify(obj) + "\n";
  jsonRpcFrameLog.push(line);
  if (jsonRpcWrite) jsonRpcWrite(line);
  else process.stdout.write(line);
}
export function headTailTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head - TRUNCATION_MARKER.length;
  return text.slice(0, head) + TRUNCATION_MARKER + text.slice(-tail);
}
export function truncateToolOutput(text: string, nCtx: number): string {
  const budget = Math.max(512, Math.floor(nCtx * 0.35));
  return headTailTruncate(text, budget);
}
export function buildRecencyAnchor(tools: { name: string; description: string }[]): string {
  const lines = tools.map((t) => `- ${t.name}: ${t.description.split(".")[0]}`);
  return `[AVAILABLE TOOLS - ANCHORED FOR RECENCY]\n${lines.join("\n")}\n`;
}

type ModelsResponse = { data?: { max_model_len?: number }[] };
export async function probeNCtx(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ nCtx: number }> {
  const base = baseUrl.replace(/\/$/, "");
  try {
    const models = await fetchImpl(`${base}/v1/models`);
    if (models.ok) {
      const j = (await models.json()) as ModelsResponse;
      const n = j.data?.[0]?.max_model_len;
      if (n && n > 0) return { nCtx: n };
    }
  } catch {
    /* fallback */
  }
  return { nCtx: DEFAULT_N_CTX };
}
export type ReasoningState = { inToolLoop: boolean };
export function createReasoningState(): ReasoningState {
  return { inToolLoop: false };
}
export type ChatMessage = { role: string; content?: string; reasoning_content?: string };
export function applyReasoningContentPolicy(
  messages: ChatMessage[],
  state: ReasoningState,
  newUserTurn: boolean,
): ChatMessage[] {
  if (newUserTurn) state.inToolLoop = false;
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    if (state.inToolLoop) return m;
    const { reasoning_content: _r, ...rest } = m;
    return rest;
  });
}
export function stripRedactedThinking(text: string): string {
  const open = "<" + "redacted_thinking" + ">";
  const close = "</" + "redacted_thinking" + ">";
  let out = text;
  for (;;) {
    const start = out.toLowerCase().indexOf(open);
    if (start < 0) break;
    const end = out.toLowerCase().indexOf(close, start);
    if (end < 0) break;
    out = out.slice(0, start) + out.slice(end + close.length);
  }
  return out.trim();
}
export const EMBED_LOCK = ".worktree-boot-embed-lock.json";
export const KNOWN_DIMENSIONS = [384, 768, 1024, 1536, 2560, 3072, 4096];
export type EmbedLock = { provider: string; model: string; dimension: number };
export function readEmbedLock(repoRoot: string): EmbedLock | null {
  const p = join(repoRoot, EMBED_LOCK);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as EmbedLock;
}
export function writeEmbedLock(repoRoot: string, lock: EmbedLock): void {
  writeFileSync(join(repoRoot, EMBED_LOCK), JSON.stringify(lock, null, 2));
}
export function assertDimensionFingerprint(lock: EmbedLock | null, dim: number): void {
  if (!lock) return;
  if (lock.dimension !== dim) {
    throw new Error(`Dimension fingerprint mismatch: lock expects ${lock.dimension}, got ${dim}`);
  }
}
export function formatToolResult(result: unknown, nCtx: number): string {
  const raw = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  const anchored = buildRecencyAnchor([]);
  return redactSecrets(truncateToolOutput(raw + "\n" + anchored, nCtx));
}
export type McpServerOptions = {
  allowWrite?: boolean;
  dryRun?: boolean;
  pathToWsl?: boolean;
  nCtx?: number;
};
export type McpDispatchContext = {
  meta: { name: string; version: string };
  tools: WorktreeToolDef[];
  toWsl: boolean;
  nCtx: number;
};
export type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
};
export function startMcpServer(
  meta: { name: string; version: string },
  tools: WorktreeToolDef[],
  options?: McpServerOptions,
): void {
  hijackStdoutForMcp();
  if (options?.allowWrite) setGuards({ allowWrite: true });
  if (options?.dryRun) setGuards({ dryRun: true });
  const toWsl = options?.pathToWsl ?? process.env.WORKTREE_BOOT_PATH_WSL === "1";
  const nCtx = options?.nCtx ?? DEFAULT_N_CTX;
  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  let buffer = "";
  stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      dispatchMcpMessage(msg, { meta, tools, toWsl, nCtx });
    }
  });
}
export function dispatchMcpMessage(msg: JsonRpcMessage, ctx: McpDispatchContext): void {
  const { id, method, params } = msg;
  const { meta, tools, toWsl, nCtx } = ctx;
  if (method === "initialize") {
    writeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: meta.name, version: meta.version },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    writeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      result: {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      },
    });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name ?? "";
    const args = normalizePathsDeep(params?.arguments ?? {}, toWsl) as Record<string, unknown>;
    const tool = tools.find((t) => t.name === name);
    const loopErr = checkLoopBreaker(name, args);
    if (loopErr) {
      writeJsonRpcFrame({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: loopErr }], isError: true },
      });
      return;
    }
    if (tool) {
      const guard = guardMutatingTool(tool);
      if (guard.blocked) {
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: guard.reason ?? "blocked" }],
            isError: true,
          },
        });
        return;
      }
    }
    const ctxTools: ToolHandlerContext = { dryRun, allowWrite, nCtx };
    void (async () => {
      try {
        let result: unknown;
        if (tool) result = await tool.handler(args, ctxTools);
        else result = { ok: false, error: `unknown tool ${name}` };
        const text = formatToolResult(result, nCtx);
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: normalizePathsDeep(text, !toWsl) }],
          },
        });
      } catch (e) {
        const errText = redactSecrets(e instanceof Error ? e.message : String(e));
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: errText }], isError: true },
        });
      }
    })();
    return;
  }
  if (id !== undefined) {
    writeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}
