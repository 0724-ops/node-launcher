import path from 'path';
import type { AppConfig, WindowBounds } from '../../types';
import { readJsonSafe, writeJsonAtomic } from '../util/atomic-json';

export const CONFIG_SCHEMA_VERSION = 1;

export const CONFIG_DEFAULTS: AppConfig = {
  schema: 1,

  defaultNodeVersion: '22',
  nodeDownloadMirror: 'https://npmmirror.com/mirrors/node/',
  npmRegistry: 'https://registry.npmmirror.com',
  preferBundledRuntime: true,

  defaultAutoInstallDeps: 'ask',
  defaultAllowInstallScripts: false,
  installTimeoutMs: 600000,

  defaultPortMode: 'inject',
  defaultPort: 3000,
  autoPickFreePort: true,
  openBrowserOnReady: false,

  metricsStrategy: 'auto',
  metricsMemoryLimit: 512,
  logBufferLines: 5000,
  logToFile: true,

  githubMirror: '',
  githubToken: '',
  tunnelUseHttp2: true,
  showVirtualIps: true,

  projectsRootUser: '',
  projectsRootActive: '',

  projectOrder: [],

  theme: 'dark',
  locale: 'zh-CN',
};

/** 全局配置存储（userData/config.json），带缓存与原子写 */
export class ConfigStore {
  private cache: AppConfig | null = null;

  constructor(private readonly dataDir: string) {}

  get file(): string {
    return path.join(this.dataDir, 'config.json');
  }

  async load(): Promise<AppConfig> {
    if (this.cache) return this.cache;
    const raw = await readJsonSafe<Partial<AppConfig>>(this.file);
    const merged = { ...CONFIG_DEFAULTS, ...(raw ?? {}), schema: 1 as const };
    this.cache = merged;
    if (!raw) await writeJsonAtomic(this.file, merged);
    return merged;
  }

  async save(patch: Partial<AppConfig>): Promise<AppConfig> {
    const current = await this.load();
    const next: AppConfig = { ...current, ...patch, schema: 1 };
    this.cache = next;
    await writeJsonAtomic(this.file, next);
    return next;
  }

  async saveWindowBounds(bounds: WindowBounds): Promise<void> {
    await this.save({ windowBounds: bounds });
  }

  /** 仅供测试：清空内存缓存 */
  resetCache(): void {
    this.cache = null;
  }
}
