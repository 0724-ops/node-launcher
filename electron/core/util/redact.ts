/** 敏感字段名（用于日志脱敏） */
const SECRET_KEY =
  /(token|secret|passwd|password|api[_-]?key|apikey|credential|authorization|private[_-]?key)/i;

/** 命中脱敏的赋值形式：KEY=VALUE / KEY: VALUE / "KEY": "VALUE" */
const ASSIGN_RE = /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*[:=]\s*)(["']?)([^\s"',;]+)\4/g;

/** 把日志里的密钥类字段打成 ***，避免安装/启动日志泄露 token */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text.replace(
    ASSIGN_RE,
    (match, q1: string, key: string, sep: string, q2: string, value: string) => {
      if (!SECRET_KEY.test(key)) return match;
      return `${q1}${key}${q1}${sep}${q2}***${q2}`;
    }
  );
  // Authorization: Bearer xxx / token xxx
  out = out.replace(
    /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    (_m, kw: string) => `${kw} ***`
  );
  return out;
}

/** 环境变量表脱敏（用于写入清单快照或日志） */
export function redactEnv(
  env: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    out[k] = SECRET_KEY.test(k) ? '***' : v;
  }
  return out;
}
