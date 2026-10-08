import path from 'path';
import fse from 'fs-extra';

import type {
  AppConfig,
  PackageManager,
  ProjectDetectResult,
  ProjectManifest,
  StartMode,
} from '../../types';
import type { ProjectStore } from '../store/project-store';
import { applyPatch, defaultManifest, type ProjectPatch } from '../store/manifest';
import { newProjectId } from '../util/ids';
import { AppError } from '../util/errors';
import {
  buildScriptCommand,
  detectPackageManager,
  extractEntryFromScript,
  readPackageJson,
} from '../runtime/package-manager';
import { extractArchive, projectCopyFilter } from '../archive/extract';
import { normalizeNodeSpec } from '../runtime/version-spec';
import { projectRootDir, projectWorkDir } from './project-paths';

const ENTRY_CANDIDATES = [
  'server.js',
  'index.js',
  'app.js',
  'main.js',
  'server.mjs',
  'index.mjs',
  'src/index.js',
  'src/server.js',
  'src/index.mjs',
  'src/main.js',
  'dist/index.js',
  'build/index.js',
];

export interface CreateFolderInput {
  folderPath: string;
  mode: 'link' | 'copy';
  name?: string;
}

/**
 * 项目接入与探测。
 * 与旧工程最大的不同：**引用模式**（link）不复制源码，
 * 直接把用户已有目录登记进来——这是通用启动器的核心体验。
 */
export class ProjectService {
  constructor(
    private readonly store: ProjectStore,
    private readonly config: () => Promise<AppConfig>
  ) {}

  async createFromFolder(input: CreateFolderInput): Promise<ProjectManifest> {
    const folder = path.resolve(input.folderPath);
    if (!(await fse.pathExists(folder))) {
      throw new AppError(`目录不存在：${folder}`, 'E_NO_DIR');
    }
    const config = await this.config();
    const id = newProjectId(input.mode === 'link' ? 'link' : 'copy');
    const name = input.name?.trim() || path.basename(folder) || id;

    let rootDir: string;
    if (input.mode === 'link') {
      rootDir = folder;
    } else {
      rootDir = this.store.srcDir(id);
      await fse.ensureDir(rootDir);
      await fse.copy(folder, rootDir, {
        overwrite: false,
        errorOnExist: false,
        filter: projectCopyFilter(folder),
      });
    }

    const manifest = defaultManifest({
      id,
      name,
      rootDir,
      source: input.mode === 'link' ? 'linked' : 'managed',
      defaults: {
        portMode: config.defaultPortMode,
        port: config.defaultPort,
        autoInstallDeps: config.defaultAutoInstallDeps,
      },
    });

    await this.applyDetect(manifest, rootDir);
    return this.store.save(manifest);
  }

  /**
   * 从压缩包导入。
   * `opts.source` 用来区分来源：本地压缩包 = `zip`，从 GitHub Release 下的 = `github`
   * （GitHub 路径同样解压导入，只是 `source` / `desc` / id 前缀不同，便于界面标注与后续更新）。
   */
  async importZip(
    zipPath: string,
    name?: string,
    opts: { source?: 'zip' | 'github'; desc?: string; idPrefix?: string } = {}
  ): Promise<ProjectManifest> {
    if (!(await fse.pathExists(zipPath))) {
      throw new AppError(`文件不存在：${zipPath}`, 'E_NO_FILE');
    }
    const source = opts.source ?? 'zip';
    const config = await this.config();
    const base = path.basename(zipPath, path.extname(zipPath));
    const id = newProjectId(opts.idPrefix ?? source);
    const rootDir = this.store.srcDir(id);
    await fse.ensureDir(rootDir);
    try {
      await extractArchive(zipPath, rootDir);
    } catch (err) {
      await fse.remove(this.store.projectDir(id)).catch(() => {});
      throw err;
    }

    const manifest = defaultManifest({
      id,
      name: name?.trim() || base || id,
      rootDir,
      source,
      desc: opts.desc ?? '压缩包导入',
      defaults: {
        portMode: config.defaultPortMode,
        port: config.defaultPort,
        autoInstallDeps: config.defaultAutoInstallDeps,
      },
    });
    await this.applyDetect(manifest, rootDir);
    return this.store.save(manifest);
  }

  /**
   * 把「引用」的项目迁移为受管副本：
   * 复制源码到 projects/<id>/src（**原目录保留不动**），清单切换为 managed。
   * 与旧启动器「迁移」的区别：旧工程移动目录，这里只复制，避免误删用户源码。
   */
  async adoptLinked(id: string): Promise<ProjectManifest> {
    const manifest = await this.store.get(id);
    if (!manifest) throw new AppError('项目不存在', 'E_NOT_FOUND');
    if (manifest.source !== 'linked') {
      throw new AppError('只有「引用目录」的项目才需要迁移为受管副本', 'E_NOT_LINKED');
    }
    const from = path.resolve(manifest.rootDir);
    if (!(await fse.pathExists(from))) {
      throw new AppError(`原目录不存在：${from}`, 'E_NO_DIR');
    }
    const target = this.store.srcDir(id);
    if (path.resolve(target).startsWith(from + path.sep)) {
      throw new AppError('目标目录位于原目录内部，无法迁移', 'E_BAD_TARGET');
    }

    await fse.ensureDir(target);
    await fse.copy(from, target, {
      overwrite: false,
      errorOnExist: false,
      filter: projectCopyFilter(from),
    });

    manifest.source = 'managed';
    manifest.rootDir = target;
    return this.store.save(manifest);
  }

  async update(id: string, patch: ProjectPatch): Promise<ProjectManifest> {    const current = await this.store.get(id);
    if (!current) throw new AppError('项目不存在', 'E_NOT_FOUND');
    const next = applyPatch(current, patch);
    return this.store.save(next);
  }

  async remove(id: string, deleteFiles: boolean): Promise<void> {
    const manifest = await this.store.get(id);
    if (!manifest) throw new AppError('项目不存在', 'E_NOT_FOUND');
    await this.store.remove(manifest, { deleteFiles });
  }

  /** 探测指定项目的启动配置（编辑弹窗自动预填） */
  async detect(projectId: string): Promise<ProjectDetectResult> {
    const manifest = await this.store.get(projectId);
    if (!manifest) throw new AppError('项目不存在', 'E_NOT_FOUND');
    const root = projectRootDir(this.store, manifest);
    const workDir = projectWorkDir(this.store, manifest);
    return this.detectDir(workDir, root);
  }

  /** 按目录探测出「该怎么启动」 */
  async detectDir(dir: string, rootDir = dir): Promise<ProjectDetectResult> {
    const pkg = await readPackageJson(dir);
    const detected = await detectPackageManager(dir);
    const pm: PackageManager = detected.name;

    const candidates: string[] = [];
    const pushCandidate = (value: string | null): void => {
      if (!value) return;
      const clean = value.replace(/^\.\//, '').trim();
      if (!clean || candidates.includes(clean)) return;
      candidates.push(clean);
    };

    const startScript = pkg.scripts.start ?? null;
    const fromScript = startScript ? extractEntryFromScript(startScript) : null;

    const existing = async (rel: string): Promise<boolean> =>
      fse.pathExists(path.join(dir, rel));

    if (fromScript && (await existing(fromScript))) pushCandidate(fromScript);
    pushCandidate(pkg.main ?? null);
    for (const candidate of ENTRY_CANDIDATES) {
      // eslint-disable-next-line no-await-in-loop
      if (await existing(candidate)) pushCandidate(candidate);
    }

    let suggestedStartMode: StartMode = 'node';
    let suggestedEntry: string | null = null;
    let suggestedCommand: string | null = null;

    if (fromScript && (await existing(fromScript))) {
      suggestedStartMode = 'node';
      suggestedEntry = fromScript;
    } else if (startScript) {
      suggestedStartMode = 'command';
      suggestedCommand = buildScriptCommand(pm, 'start');
    } else if (candidates.length) {
      suggestedStartMode = 'node';
      suggestedEntry = candidates[0];
    } else if (pkg.scripts.dev) {
      suggestedStartMode = 'command';
      suggestedCommand = buildScriptCommand(pm, 'dev');
    }

    const workspaceCandidates: string[] = [];
    for (const pattern of pkg.workspaces) {
      // eslint-disable-next-line no-await-in-loop
      const expanded = await expandWorkspace(pattern, rootDir);
      for (const item of expanded) {
        if (!workspaceCandidates.includes(item)) workspaceCandidates.push(item);
      }
      if (workspaceCandidates.length >= 20) break;
    }

    return {
      rootedAt: dir,
      hasPackageJson: pkg.exists,
      packageName: pkg.name,
      packageManager: pm,
      lockfile: detected.lockfile,
      scripts: pkg.scripts,
      moduleType: pkg.moduleType,
      enginesNode: pkg.enginesNode,
      entryCandidates: candidates,
      suggestedStartMode,
      suggestedEntry,
      suggestedCommand,
      suggestedCwd: path.relative(rootDir, dir) || '',
      workspaceCandidates,
    };
  }

  /** 把探测结果写进清单（仅填充，不覆盖用户已改过的值） */
  private async applyDetect(
    manifest: ProjectManifest,
    rootDir: string
  ): Promise<void> {
    const detected = await this.detectDir(rootDir);
    manifest.startMode = detected.suggestedStartMode;
    if (detected.suggestedStartMode === 'node' && detected.suggestedEntry) {
      manifest.entry = detected.suggestedEntry;
      delete manifest.command;
    } else if (detected.suggestedStartMode === 'command' && detected.suggestedCommand) {
      manifest.command = detected.suggestedCommand;
      delete manifest.entry;
    }
    // engines.node 常见写法是范围（">=22" / "^20.11.0"），必须归一化成主版本号，
    // 否则会被拼进运行时目录名，在 Windows 上产生非法路径。
    if (detected.enginesNode) {
      const normalized = normalizeNodeSpec(detected.enginesNode);
      if (normalized) manifest.nodeVersion = normalized;
    }
    if (!manifest.desc && detected.hasPackageJson && detected.packageName) {
      manifest.desc = detected.packageName;
    }
  }
}

/** 展开 workspaces 里的简单通配（packages/*） */
async function expandWorkspace(pattern: string, rootDir: string): Promise<string[]> {
  const normalized = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized.includes('*')) {
    const candidate = path.join(rootDir, normalized);
    return (await fse.pathExists(path.join(candidate, 'package.json')))
      ? [normalized]
      : [];
  }
  const [head] = normalized.split('*');
  const baseDir = path.join(rootDir, head.replace(/\/+$/, ''));
  const entries = await fse.readdir(baseDir).catch(() => [] as string[]);
  const out: string[] = [];
  for (const entry of entries) {
    const rel = `${head.replace(/\/+$/, '')}/${entry}`;
    // eslint-disable-next-line no-await-in-loop
    if (await fse.pathExists(path.join(rootDir, rel, 'package.json'))) {
      out.push(rel);
    }
  }
  return out;
}
