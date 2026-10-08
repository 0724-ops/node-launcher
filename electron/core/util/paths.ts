import path from 'path';
import { AppError } from './errors';

/** target 是否位于 root 之内（含 root 自身） */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 在 root 内解析相对路径；一旦逃逸（.. / 绝对路径）立即抛错。
 * 用于入口文件、cwd、.env 等一切来自清单的相对路径。
 */
export function resolveInside(root: string, relative: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, relative ?? '');
  if (!isInside(base, target)) {
    throw new AppError(
      `路径越界：${relative} 不在项目目录内`,
      'E_PATH_ESCAPE'
    );
  }
  return target;
}

/** 项目数据目录下的子路径（projects/<id>/...） */
export function projectDataDir(projectsDir: string, id: string): string {
  return path.join(projectsDir, id);
}
