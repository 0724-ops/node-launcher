import fse from 'fs-extra';
import { resolveInside } from './paths';

/** 解析 .env 文本：忽略空行与注释，支持引号包裹 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 读取并解析 .env（不存在时返回空对象） */
export async function loadEnvFile(
  workDir: string,
  envFile: string
): Promise<Record<string, string>> {
  const file = resolveInside(workDir, envFile);
  if (!(await fse.pathExists(file))) return {};
  const text = await fse.readFile(file, 'utf8');
  return parseEnvFile(text);
}
