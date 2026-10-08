/**
 * Node 版本约束解析。
 *
 * 起因（真实故障）：package.json 的 `engines.node` 常写成 `>=22`、`^20.11.0`、`22.x`，
 * 早期实现把它原样存进 manifest.nodeVersion，随后又拿它去拼目录名：
 *   runtimes\.tmp->=22-1791344059070
 * `>` 在 Windows 上是保留字符 → 路径非法 → 启动时报
 * 「Path contains invalid characters」。
 *
 * 因此：**任何来自外部的版本字符串都必须先过这里**，
 * 永远不要把它直接拼进路径。
 */

/** 取主版本号（第一个数字），取不到返回 null */
export function majorOf(spec: string): string | null {
  const m = String(spec ?? '').match(/(\d+)/);
  return m ? m[1] : null;
}

/**
 * 规范化为可直接使用的版本约束：
 *   "22" | "v22" | ">=22" | "^22.1.0" | "22.x" | "~20"  → "22" / "20"
 *   "22.11.0"                                            → "22.11.0"（完整版本原样保留）
 *   无法识别                                              → null
 */
export function normalizeNodeSpec(spec: string): string | null {
  const raw = String(spec ?? '').trim();
  if (!raw) return null;

  // 完整版本（可带 v 前缀）
  const full = raw.match(/^v?(\d+)\.(\d+)\.(\d+)$/i);
  if (full) return `${full[1]}.${full[2]}.${full[3]}`;

  // 其余一律退化成主版本号
  return majorOf(raw);
}

/** 版本约束是否匹配某个已安装的具体版本 */
export function specMatchesVersion(version: string, spec: string): boolean {
  const v = String(version ?? '').replace(/^v/i, '').trim();
  const s = normalizeNodeSpec(spec);
  if (!v || !s) return false;
  if (s.split('.').length === 3) return v === s;
  return v.split('.')[0] === s;
}

/** 具体版本号是否合法（可安全用于目录名） */
export function isConcreteVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(String(version ?? '').trim());
}

/** 把任意字符串清洗成安全的路径片段（兜底防线，正常路径不该走到这里） */
export function safeSegment(input: string): string {
  return String(input ?? '').replace(/[^0-9A-Za-z._-]/g, '_');
}
