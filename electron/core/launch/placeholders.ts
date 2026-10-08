/**
 * 启动占位符：{PORT} {HOST} {CWD} {ENTRY} {NODE}
 * 只做纯文本替换，未知占位符原样保留（避免误伤用户命令里的花括号）。
 */
export interface PlaceholderValues {
  PORT?: number | string | null;
  HOST?: string | null;
  CWD?: string | null;
  ENTRY?: string | null;
  NODE?: string | null;
}

export const PLACEHOLDER_NAMES = ['PORT', 'HOST', 'CWD', 'ENTRY', 'NODE'] as const;

export function substitutePlaceholders(
  text: string,
  values: PlaceholderValues
): string {
  if (!text) return text;
  return text.replace(/\{(PORT|HOST|CWD|ENTRY|NODE)\}/g, (match, name: string) => {
    const value = values[name as keyof PlaceholderValues];
    if (value === undefined || value === null) return match;
    return String(value);
  });
}

/** 命令行里是否用到了占位符（UI 提示用） */
export function usesPlaceholder(text: string, name: string): boolean {
  return new RegExp(`\\{${name}\\}`).test(text ?? '');
}
