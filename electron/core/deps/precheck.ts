import path from 'path';
import fse from 'fs-extra';
import type { PackageManager } from '../../types';
import { detectPackageManager } from '../runtime/package-manager';

/** 依赖预检结果（启动前的确定性判断，PLAN §8.1 第一级） */
export interface DepsPrecheckResult {
  dir: string;
  hasPackageJson: boolean;
  packageManager: PackageManager;
  lockfile: string | null;
  nodeModulesExists: boolean;
  /** node_modules 内的条目数（受扫描上限约束） */
  nodeModulesEntries: number;
  nodeModulesSizeBytes: number;
  /** 扫描是否被上限截断（此时体积只是下界） */
  sizeTruncated: boolean;
  /** 是否需要安装依赖 */
  needsInstall: boolean;
}

const MAX_SCAN_FILES = 4000;

async function measureDir(
  dir: string
): Promise<{ size: number; entries: number; truncated: boolean }> {
  let size = 0;
  let entries = 0;
  let truncated = false;
  const stack: string[] = [dir];

  while (stack.length) {
    const current = stack.pop() as string;
    let list: string[];
    try {
      // eslint-disable-next-line no-await-in-loop
      list = await fse.readdir(current);
    } catch {
      continue;
    }
    for (const entry of list) {
      if (entries >= MAX_SCAN_FILES) {
        truncated = true;
        break;
      }
      const full = path.join(current, entry);
      try {
        // eslint-disable-next-line no-await-in-loop
        const stat = await fse.lstat(full);
        entries += 1;
        if (stat.isDirectory()) {
          stack.push(full);
        } else if (stat.isFile()) {
          size += stat.size;
        }
      } catch {
        /* 无法访问的项忽略 */
      }
    }
    if (truncated) break;
  }

  return { size, entries, truncated };
}

/** 预检：判断项目是否已有可用依赖 */
export async function precheckDeps(dir: string): Promise<DepsPrecheckResult> {
  const pkgFile = path.join(dir, 'package.json');
  const hasPackageJson = await fse.pathExists(pkgFile);
  const nodeModulesPath = path.join(dir, 'node_modules');
  const nodeModulesExists = await fse.pathExists(nodeModulesPath);

  let entries = 0;
  let size = 0;
  let truncated = false;
  if (nodeModulesExists) {
    const measured = await measureDir(nodeModulesPath);
    entries = measured.entries;
    size = measured.size;
    truncated = measured.truncated;
  }

  const detected = hasPackageJson
    ? await detectPackageManager(dir)
    : { name: 'npm' as PackageManager, lockfile: null };

  // 没有 package.json → 不是 Node 项目，不参与依赖管理
  const needsInstall = hasPackageJson && !(nodeModulesExists && entries > 0);

  return {
    dir,
    hasPackageJson,
    packageManager: detected.name,
    lockfile: detected.lockfile ?? null,
    nodeModulesExists,
    nodeModulesEntries: entries,
    nodeModulesSizeBytes: size,
    sizeTruncated: truncated,
    needsInstall,
  };
}
