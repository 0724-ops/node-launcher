/**
 * 项目 ID 白名单。
 * ID 会直接参与文件路径拼接，任何来自外部的字符串（release tag / zip 名 / 用户输入）
 * 都必须先经过这里，避免 path traversal。
 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

/** 把任意字符串清洗成合法 ID；无法得到合法结果时使用 fallback */
export function sanitizeId(raw: unknown, fallback = 'project'): string {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, 64);
  return isValidId(cleaned) ? cleaned : sanitizeId(fallback, 'project');
}

/** 生成一个新的项目 ID */
export function newProjectId(prefix = 'p'): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}
