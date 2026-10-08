import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fse from 'fs-extra';
import type { RuntimeInfo } from '../../types';
import { AppError, toMessage } from '../util/errors';
import {
  isConcreteVersion,
  normalizeNodeSpec,
  safeSegment,
  specMatchesVersion,
} from './version-spec';

const execFileAsync = promisify(execFile);

/** 运行时目录命名约定：node-<version>-<platform>-<arch> */
export function runtimeDirName(
  version: string,
  platform: NodeJS.Platform,
  arch: string
): string {
  return `node-${version}-${platform}-${arch}`;
}

/**
 * 解析约定目录名，返回其中的版本号；不符合约定时返回 null。
 * 独立成纯函数，避免「前缀匹配」写错导致内置运行时永远识别不到。
 */
export function parseRuntimeDirName(
  entry: string,
  platform: NodeJS.Platform,
  arch: string
): string | null {
  const prefix = 'node-';
  const suffix = `-${platform}-${arch}`;
  if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) return null;
  const version = entry.slice(prefix.length, entry.length - suffix.length);
  return /^\d+\.\d+\.\d+/.test(version) ? version : null;
}

export interface RuntimeProviderDeps {
  /** 随包内置目录（resources/runtimes，可为空） */
  bundledDir: string;
  /** 按需下载缓存目录（userData/runtimes） */
  runtimesDir: string;
  platform: NodeJS.Platform;
  arch: string;
  /** 从配置读取，允许随时变化 */
  getConfig: () => Promise<{
    defaultNodeVersion: string;
    nodeDownloadMirror: string;
    preferBundledRuntime: boolean;
  }>;
  log?: (msg: string) => void;
  onProgress?: (progress: {
    phase: 'checking' | 'downloading' | 'extracting' | 'verifying' | 'ready';
    percent: number;
    downloaded?: number;
    total?: number;
    message?: string;
  }) => void;
  download?: typeof import('../download/downloader').downloadFile;
}

const FALLBACK_VERSIONS: Record<string, string> = {
  // 无法访问 index.json 时使用的已知可用版本
  '22': '22.23.3',
};

interface NodeDistEntry {
  version: string;
  files: string[];
}

/**
 * Node 运行时供给（PLAN §5）：
 *   内置 → 本地缓存 → 按需下载（带进度与校验）
 * 运行进程一律使用真 Node，而不是 Electron-as-node（ABI 不一致 + 无 npm）。
 */
export class NodeRuntimeProvider {
  private reported = new Set<string>();

  constructor(private readonly deps: RuntimeProviderDeps) {}

  private log(msg: string): void {
    if (!this.reported.has(msg)) {
      this.reported.add(msg);
      this.deps.log?.(msg);
    }
  }

  /** 已就绪的运行时列表（内置 + 缓存） */
  async listInstalled(): Promise<RuntimeInfo[]> {
    const found: RuntimeInfo[] = [];
    for (const [dir, source] of [
      [this.deps.bundledDir, 'bundled'] as const,
      [this.deps.runtimesDir, 'downloaded'] as const,
    ]) {
      const entries = await fse.readdir(dir).catch(() => [] as string[]);
      for (const entry of entries) {
        if (!parseRuntimeDirName(entry, this.deps.platform, this.deps.arch)) continue;
        const info = await this.inspect(path.join(dir, entry), source);
        if (info) found.push(info);
      }
    }
    return found.sort((a, b) => compareVersions(b.version, a.version));
  }

  /** 保证存在满足 spec 的运行时；spec 可为 "22" 或 "22.23.3"，空则用配置默认值 */
  async ensureRuntime(spec?: string): Promise<RuntimeInfo> {
    const config = await this.deps.getConfig();
    const raw = (spec ?? '').trim() || (config.defaultNodeVersion ?? '').trim() || '22';
    // engines.node 那种 ">=22" / "^20.11.0" 在这里被归一化；
    // 归一化失败就明确报错，绝不把带 <>:|?* 的字符串拿去拼路径。
    const wanted = normalizeNodeSpec(raw);
    if (!wanted) {
      throw new AppError(
        `无法识别的 Node 版本「${raw}」，请填写主版本号（如 22）或完整版本（如 22.11.0）`,
        'E_NODE_SPEC'
      );
    }

    this.deps.onProgress?.({ phase: 'checking', percent: 0, message: '正在检查 Node 运行时…' });

    const installed = await this.listInstalled();
    const match = pickBestMatch(installed, wanted, config.preferBundledRuntime);
    if (match) {
      this.log(`使用${match.source === 'bundled' ? '内置' : '已缓存'} Node 运行时 v${match.version}`);
      this.deps.onProgress?.({ phase: 'ready', percent: 100, message: `Node v${match.version} 就绪` });
      return match;
    }

    const concrete = await this.resolveVersion(wanted, config.nodeDownloadMirror);
    const targetDir = path.join(
      this.deps.runtimesDir,
      runtimeDirName(concrete, this.deps.platform, this.deps.arch)
    );

    const existing = await this.inspect(targetDir, 'downloaded');
    if (existing) return existing;

    this.log(`正在下载 Node v${concrete}（首次使用需要，请耐心等待）…`);
    await this.downloadAndExtract(concrete, targetDir, config.nodeDownloadMirror);

    const info = await this.inspect(targetDir, 'downloaded');
    if (!info) throw new Error(`Node 运行时安装失败：${targetDir}`);
    this.deps.onProgress?.({ phase: 'ready', percent: 100, message: `Node v${concrete} 就绪` });
    return info;
  }

  /** 解析约束 → 具体版本号；任何情况下返回值都可安全用作目录名 */
  async resolveVersion(spec: string, mirror: string): Promise<string> {
    const normalized = normalizeNodeSpec(spec);
    if (normalized && isConcreteVersion(normalized)) return normalized;
    if (!normalized) {
      throw new AppError(`无法识别的 Node 版本「${spec}」`, 'E_NODE_SPEC');
    }

    let resolved: string | null = null;
    try {
      const index = await this.fetchIndex(mirror);
      const candidates = index
        .map((e) => e.version.replace(/^v/, ''))
        .filter((v) => v.split('.')[0] === normalized)
        .sort(compareVersions);
      if (candidates.length) resolved = candidates[candidates.length - 1];
    } catch (err) {
      this.log(`获取 Node 版本列表失败（${toMessage(err)}），使用内置回退版本`);
    }
    if (!resolved) resolved = FALLBACK_VERSIONS[normalized] ?? null;

    if (!resolved || !isConcreteVersion(resolved)) {
      throw new AppError(
        `无法解析 Node 版本「${spec}」，请把版本改成主版本号（如 22）后重试`,
        'E_NODE_SPEC'
      );
    }
    return resolved;
  }

  private async fetchIndex(mirror: string): Promise<NodeDistEntry[]> {
    const base = mirror.endsWith('/') ? mirror : `${mirror}/`;
    const url = `${base}index.json`;
    const res = await fetch(url, { headers: { 'User-Agent': 'node-launcher' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as NodeDistEntry[];
    if (!Array.isArray(data)) throw new Error('版本索引格式异常');
    return data;
  }

  private assetName(version: string): string {
    const { platform, arch } = this.deps;
    if (platform === 'win32') return `node-v${version}-win-${arch}.zip`;
    if (platform === 'darwin') return `node-v${version}-darwin-${arch}.tar.gz`;
    return `node-v${version}-linux-${arch}.tar.xz`;
  }

  private async downloadAndExtract(
    version: string,
    targetDir: string,
    mirror: string
  ): Promise<void> {
    const base = mirror.endsWith('/') ? mirror : `${mirror}/`;
    const asset = this.assetName(version);
    const url = `${base}v${version}/${asset}`;
    const tmpDir = path.join(
      this.deps.runtimesDir,
      safeSegment(`.tmp-${version}-${Date.now()}`)
    );
    const archivePath = path.join(tmpDir, asset);

    await fse.ensureDir(tmpDir);
    try {
      await this.doDownload(url, archivePath, mirror);
      this.deps.onProgress?.({ phase: 'extracting', percent: 100, message: '正在解压 Node…' });
      await this.extract(archivePath, tmpDir);
      const inner = await this.findInnerDir(tmpDir);
      if (!inner) throw new Error('解压后未找到 Node 目录');
      await fse.remove(targetDir).catch(() => {});
      await fse.move(inner, targetDir, { overwrite: true });
    } finally {
      await fse.remove(tmpDir).catch(() => {});
    }
  }

  private async doDownload(url: string, dest: string, mirror: string): Promise<void> {
    const download =
      this.deps.download ?? (await import('../download/downloader')).downloadFile;
    await download({
      url,
      dest,
      allowInsecure: mirror.startsWith('http://'),
      onProgress: (p) =>
        this.deps.onProgress?.({
          phase: 'downloading',
          percent: p.percent,
          downloaded: p.downloaded,
          total: p.total,
          message: '正在下载 Node 运行时…',
        }),
    });
  }

  private async extract(archivePath: string, dir: string): Promise<void> {
    if (archivePath.endsWith('.zip')) {
      const extractZip = (await import('extract-zip')).default;
      await extractZip(archivePath, { dir: path.resolve(dir) });
      return;
    }
    // tar.gz / tar.xz：优先调用系统 tar（Windows 10+ 自带）
    await execFileAsync('tar', ['-xf', archivePath, '-C', dir], { timeout: 300000 });
  }

  private async findInnerDir(root: string): Promise<string | null> {
    const entries = await fse.readdir(root).catch(() => [] as string[]);
    for (const entry of entries) {
      const full = path.join(root, entry);
      if (!(await fse.stat(full)).isDirectory()) continue;
      const hasNode =
        (await fse.pathExists(path.join(full, 'node.exe'))) ||
        (await fse.pathExists(path.join(full, 'bin', 'node')));
      if (hasNode) return full;
    }
    return null;
  }

  /** 校验目录里的 Node 是否可用，并读出 ABI */
  async inspect(dir: string, source: 'bundled' | 'downloaded'): Promise<RuntimeInfo | null> {
    const nodePath =
      this.deps.platform === 'win32'
        ? path.join(dir, 'node.exe')
        : path.join(dir, 'bin', 'node');
    if (!(await fse.pathExists(nodePath))) return null;

    try {
      const { stdout } = await execFileAsync(nodePath, ['-p', 'process.version + "|" + process.versions.modules'], {
        timeout: 15000,
      });
      const [version, abi] = stdout.trim().split('|');
      if (!version) return null;

      const npmRel =
        this.deps.platform === 'win32'
          ? path.join('node_modules', 'npm', 'bin', 'npm-cli.js')
          : path.join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      const npmCliPath = path.join(dir, npmRel);

      const corepackRel =
        this.deps.platform === 'win32'
          ? path.join('node_modules', 'corepack', 'dist', 'corepack.js')
          : path.join('lib', 'node_modules', 'corepack', 'dist', 'corepack.js');
      const corepackJs = path.join(dir, corepackRel);

      const info: RuntimeInfo = {
        version: version.replace(/^v/, ''),
        abi: abi ?? '',
        nodePath,
        npmCliPath: (await fse.pathExists(npmCliPath)) ? npmCliPath : '',
        corepackPath: (await fse.pathExists(corepackJs)) ? corepackJs : null,
        dir: this.deps.platform === 'win32' ? dir : path.join(dir, 'bin'),
        source,
      };
      return info;
    } catch (err) {
      this.log(`Node 运行时不可用（${dir}）：${toMessage(err)}`);
      return null;
    }
  }
}

/** 版本号比较（1.2.10 > 1.2.9） */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** spec "22" 匹配 22.x.y；preferBundled 时优先取内置运行时 */
export function pickBestMatch(
  installed: RuntimeInfo[],
  spec: string,
  preferBundled: boolean
): RuntimeInfo | null {
  // 归一化后再匹配：">=22" 这类约束同样能命中已缓存的 22.x
  const normalized = normalizeNodeSpec(spec);
  if (!normalized) return null;
  const exact = installed.filter((r) => specMatchesVersion(r.version, normalized));
  if (!exact.length) return null;
  const sorted = [...exact].sort((a, b) => compareVersions(b.version, a.version));
  if (preferBundled) {
    const bundled = sorted.filter((r) => r.source === 'bundled');
    if (bundled.length) return bundled[0];
  }
  return sorted[0];
}
