import path from 'path';
import fse from 'fs-extra';
import extract from 'extract-zip';

/** 解压 zip 到目标目录（extract-zip 内置 zip-slip 防护） */
export async function extractArchive(
  zipPath: string,
  targetDir: string
): Promise<void> {
  await fse.ensureDir(targetDir);
  await extract(zipPath, { dir: path.resolve(targetDir) });
  await hoistSingleDir(targetDir);
}

/**
 * 若解压结果被单层目录包裹（GitHub 打的包通常是 repo-tag/），把内容提升一层。
 * 忽略 __MACOSX 等噪声条目。
 */
export async function hoistSingleDir(targetDir: string): Promise<void> {
  const entries = (await fse.readdir(targetDir)).filter(
    (e) => e !== '__MACOSX' && !e.startsWith('.')
  );
  if (entries.length !== 1) return;

  const single = path.join(targetDir, entries[0]);
  const stat = await fse.stat(single).catch(() => null);
  if (!stat?.isDirectory()) return;

  const tmp = `${targetDir}__hoist_${Date.now()}`;
  await fse.move(single, tmp);
  // 目录里可能还有 __MACOSX 之类的残留，直接清掉
  const leftovers = await fse.readdir(targetDir);
  for (const entry of leftovers) {
    if (entry !== entries[0]) await fse.remove(path.join(targetDir, entry));
  }
  await fse.remove(path.join(targetDir, entries[0]));
  await fse.move(tmp, targetDir, { overwrite: true });
}

/** 复制项目目录：排除体积巨大且可再生的目录 */
export function projectCopyFilter(src: string): (source: string) => boolean {
  const skip = new Set(['node_modules', '.git', '.cache', '.tools', '.venv', '__pycache__']);
  const root = path.resolve(src);
  return (source: string): boolean => {
    const rel = path.relative(root, source);
    if (!rel) return true;
    return !rel.split(path.sep).some((part) => skip.has(part));
  };
}
