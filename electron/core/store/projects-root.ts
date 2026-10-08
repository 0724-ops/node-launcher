import path from 'path';
import fse from 'fs-extra';

import type { AppConfig, ProjectsRootInfo } from '../../types';
import { readJsonSafe } from '../util/atomic-json';

/**
 * 受管项目根目录（默认 userData/projects）与「换目录 → 迁移旧数据」逻辑。
 *
 * 这一套完全照搬旧专用启动器的做法，语义一致：
 *   - projectsRootUser   用户当前选择的根目录（空 = 默认），改完立即生效；
 *   - projectsRootActive 上一次生效的根目录，作为迁移来源；
 *   - 换目录时若「即将离开的旧目录」里还有项目，就把它记为迁移来源；
 *   - 迁移 = 把旧目录下的内容移动到新目录（同名跳过，绝不覆盖）。
 */

/** 默认受管项目目录 */
export function defaultProjectsRoot(dataDir: string): string {
  return path.join(dataDir, 'projects');
}

/**
 * 把「项目根目录」解析成实际使用的目录。
 * 与旧启动器一致：若目录本身就叫 projects，就直接用它，绝不拼成 projects/projects。
 */
export function resolveProjectsRoot(dataDir: string, user?: string): string {
  const base = (user ?? '').trim();
  if (!base) return defaultProjectsRoot(dataDir);
  const resolved = path.resolve(base);
  return path.basename(resolved).toLowerCase() === 'projects'
    ? resolved
    : path.join(resolved, 'projects');
}

/** 统计目录下有多少个项目（以 manifest.json 为准），不创建目录 */
export async function countProjectsIn(dir: string): Promise<number> {
  const entries = await fse.readdir(dir).catch(() => [] as string[]);
  let count = 0;
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop
    const manifest = await readJsonSafe<unknown>(path.join(dir, entry, 'manifest.json'));
    if (manifest) count += 1;
  }
  return count;
}

/**
 * 切换目录时计算迁移来源（照搬旧启动器的 resolveMigrationSource）：
 * 旧目录里还有项目才把它记为迁移源；旧目录为空则保留既有来源，
 * 避免把真正存放数据的目录丢掉。
 */
export async function migrationSourcePatch(
  dataDir: string,
  config: Pick<AppConfig, 'projectsRootUser' | 'projectsRootActive'>,
  newUser: string
): Promise<Partial<Pick<AppConfig, 'projectsRootUser' | 'projectsRootActive'>>> {
  const oldUser = (config.projectsRootUser ?? '').trim();
  if (oldUser === (newUser ?? '').trim()) return {};

  const oldCount = await countProjectsIn(resolveProjectsRoot(dataDir, oldUser));
  return oldCount > 0 ? { projectsRootActive: oldUser } : {};
}

/** 当前 / 旧 目录信息（渲染进程用于迁移引导） */
export async function buildRootInfo(
  dataDir: string,
  config: Pick<AppConfig, 'projectsRootUser' | 'projectsRootActive'>
): Promise<ProjectsRootInfo> {
  const user = (config.projectsRootUser ?? '').trim();
  const active = (config.projectsRootActive ?? '').trim();
  const currentDir = resolveProjectsRoot(dataDir, user);
  const prevDir = resolveProjectsRoot(dataDir, active);
  const changed = path.resolve(currentDir) !== path.resolve(prevDir);
  return {
    user,
    active,
    defaultDir: defaultProjectsRoot(dataDir),
    currentDir,
    prevDir,
    changed,
    prevCount: changed ? await countProjectsIn(prevDir) : 0,
  };
}

/** 把 source 下的所有内容移动到 target（同名项跳过，避免覆盖）；返回移动数量 */
export async function migrateContents(source: string, target: string): Promise<number> {
  if (path.resolve(source) === path.resolve(target)) return 0;
  await fse.ensureDir(source);
  await fse.ensureDir(target);

  const entries = await fse.readdir(source);
  let moved = 0;
  for (const entry of entries) {
    const from = path.join(source, entry);
    const to = path.join(target, entry);
    // eslint-disable-next-line no-await-in-loop
    if (await fse.pathExists(to)) continue;
    // 跨盘符时 fs.move 会自动降级为「复制 + 删除」
    // eslint-disable-next-line no-await-in-loop
    await fse.move(from, to, { overwrite: false });
    moved += 1;
  }
  return moved;
}
