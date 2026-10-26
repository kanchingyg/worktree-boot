const PORT_KEYS = new Set(["PORT", "VITE_PORT", "NEXT_PUBLIC_PORT", "DEV_SERVER_PORT"]);
const URL_PORT_RE = /(https?:\/\/(?:127\.0\.0\.1|localhost)):(\d{2,5})/gi;

export function shiftPortNumber(port: number, offset: number): number {
  return port + offset;
}

export function shiftPortsInText(text: string, offset: number): string {
  if (offset === 0) return text;
  let out = text.replace(URL_PORT_RE, (_m, host: string, p: string) => {
    const n = parseInt(p, 10);
    return `${host}:${shiftPortNumber(n, offset)}`;
  });
  out = out
    .split("\n")
    .map((line) => {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) return line;
      const key = m[1];
      const val = m[2].trim();
      if (PORT_KEYS.has(key) && /^\d+$/.test(val)) {
        return `${key}=${shiftPortNumber(parseInt(val, 10), offset)}`;
      }
      if (key === "OLLAMA_HOST" && val.includes(":")) {
        const u = new URL(val.startsWith("http") ? val : `http://${val}`);
        if (u.port) u.port = String(shiftPortNumber(parseInt(u.port, 10), offset));
        return `${key}=${u.host}`;
      }
      return line;
    })
    .join("\n");
  return out;
}

export function buildLocalLlmEnv(
  offset: number,
  base?: { ollamaHost?: string; localLlmUrl?: string },
): Record<string, string> {
  const ollama = base?.ollamaHost ?? process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
  const localUrl =
    base?.localLlmUrl ?? process.env.LOCAL_LLM_URL ?? "http://127.0.0.1:11434/v1";
  const ollamaShifted = shiftPortsInText(`OLLAMA_HOST=${ollama}`, offset).split("=")[1] ?? ollama;
  const localShifted = shiftPortsInText(`X=${localUrl}`, offset).slice(2);
  return {
    OLLAMA_HOST: ollamaShifted,
    LOCAL_LLM_URL: localShifted,
  };
}

export function mergeEnvLines(existing: string, extra: Record<string, string>): string {
  const map = new Map<string, string>();
  for (const line of existing.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) map.set(m[1], m[2]);
  }
  for (const [k, v] of Object.entries(extra)) map.set(k, v);
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}
