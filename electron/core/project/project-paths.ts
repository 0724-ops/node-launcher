import path from 'path';
import type { ProjectManifest } from '../../types';
import type { ProjectStore } from '../store/project-store';

/**
 * 项目源码目录：
 *  - linked：用户自己的目录（绝不复制、绝不擅自改动结构）
 *  - 其他：启动器管理的 projects/<id>/src
 */
export function projectRootDir(
  store: ProjectStore,
  manifest: ProjectManifest
): string {
  if (manifest.source === 'linked') return path.resolve(manifest.rootDir);
  return store.srcDir(manifest.id);
}

/** 依赖安装/启动命令的工作目录 */
export function projectWorkDir(
  store: ProjectStore,
  manifest: ProjectManifest
): string {
  const root = projectRootDir(store, manifest);
  const rel = (manifest.cwd ?? '').trim();
  if (!rel) return root;
  const resolved = path.resolve(root, rel);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    return base;
  }
  return resolved;
}

/** 项目私有数据目录（安装日志等），不污染用户目录 */
export function projectPrivateDir(
  store: ProjectStore,
  manifest: ProjectManifest
): string {
  return path.join(store.projectDir(manifest.id), '.launcher');
}
