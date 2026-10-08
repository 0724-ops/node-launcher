import path from 'path';
import fse from 'fs-extra';
import type { ErrorCategory, ProjectManifest } from '../../types';
import { readJsonSafe, writeJsonAtomic } from '../util/atomic-json';
import { isValidId } from '../util/ids';
import { isInside } from '../util/paths';
import { normalizeManifest, validateManifest } from './manifest';

/**
 * 项目清单持久化：userData/projects/<id>/manifest.json
 * 项目本体（源码）不在这个目录里：managed 项目位于 projects/<id>/src，
 * linked 项目直接指向用户自己的目录。
 */
export class ProjectStore {
  constructor(private projectsDir: string) {}

  get dir(): string {
    return this.projectsDir;
  }

  /** 切换受管项目根目录（设置里换目录 / 迁移后调用） */
  setRoot(dir: string): void {
    this.projectsDir = dir;
  }

  projectDir(id: string): string {
    if (!isValidId(id)) throw new Error(`非法项目 ID: ${id}`);
    const dir = path.join(this.projectsDir, id);
    if (!isInside(this.projectsDir, dir)) throw new Error('项目路径越界');
    return dir;
  }

  /** managed 项目的源码目录 */
  srcDir(id: string): string {
    return path.join(this.projectDir(id), 'src');
  }

  manifestPath(id: string): string {
    return path.join(this.projectDir(id), 'manifest.json');
  }

  /** 项目私有数据（安装日志、启动快照），不污染用户的项目目录 */
  privateDir(id: string): string {
    return path.join(this.projectDir(id), '.launcher');
  }

  async init(): Promise<void> {
    await fse.ensureDir(this.projectsDir);
  }

  async list(): Promise<ProjectManifest[]> {
    await this.init();
    const entries = await fse.readdir(this.projectsDir).catch(() => [] as string[]);
    const out: ProjectManifest[] = [];
    for (const entry of entries) {
      if (!isValidId(entry)) continue;
      const raw = await readJsonSafe<unknown>(this.manifestPath(entry));
      if (!raw) continue;
      const manifest = normalizeManifest(raw, entry);
      if (manifest) out.push(manifest);
    }
    return out.sort((a, b) => {
      const at = Date.parse(a.lastStartedAt ?? a.createdAt) || 0;
      const bt = Date.parse(b.lastStartedAt ?? b.createdAt) || 0;
      if (bt !== at) return bt - at;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }

  async get(id: string): Promise<ProjectManifest | null> {
    if (!isValidId(id)) return null;
    const raw = await readJsonSafe<unknown>(this.manifestPath(id));
    if (!raw) return null;
    return normalizeManifest(raw, id);
  }

  async save(manifest: ProjectManifest): Promise<ProjectManifest> {
    const normalized = normalizeManifest(manifest, manifest.id);
    if (!normalized) throw new Error('清单归一化失败');
    const errors = validateManifest(normalized);
    if (errors.length) throw new Error(errors.join('；'));
    await fse.ensureDir(this.projectDir(normalized.id));
    await writeJsonAtomic(this.manifestPath(normalized.id), normalized);
    return normalized;
  }

  async exists(id: string): Promise<boolean> {
    if (!isValidId(id)) return false;
    return fse.pathExists(this.manifestPath(id));
  }

  /** 删除项目记录；deleteFiles=true 时连同项目自有目录一起删除（linked 的外部目录永不删除） */
  async remove(
    manifest: ProjectManifest,
    opts: { deleteFiles: boolean }
  ): Promise<void> {
    const dir = this.projectDir(manifest.id);
    if (opts.deleteFiles && manifest.source !== 'linked') {
      await fse.remove(dir);
      return;
    }
    // 只删清单，保留 .launcher 与源码目录（linked 尤其如此）
    await fse.remove(this.manifestPath(manifest.id));
  }

  async ensurePrivateDir(id: string): Promise<string> {
    const dir = this.privateDir(id);
    await fse.ensureDir(dir);
    return dir;
  }

  async privatePath(id: string, file: string): Promise<string> {
    const dir = await this.ensurePrivateDir(id);
    const target = path.join(dir, file);
    if (!isInside(dir, target)) throw new Error('私有数据路径越界');
    return target;
  }

  /** 记录上次退出信息（启动流水线结束时调用） */
  async recordExit(
    id: string,
    exit: { code: number | null; signal: string | null; category?: ErrorCategory }
  ): Promise<void> {
    const manifest = await this.get(id);
    if (!manifest) return;
    manifest.lastExit = {
      code: exit.code,
      signal: exit.signal,
      at: new Date().toISOString(),
      category: exit.category,
    };
    await this.save(manifest);
  }

  async recordStarted(id: string): Promise<void> {
    const manifest = await this.get(id);
    if (!manifest) return;
    manifest.lastStartedAt = new Date().toISOString();
    await this.save(manifest);
  }
}
