import { app } from 'electron';
import path from 'path';

/**
 * 所有用户数据的落点。
 * 与旧专用启动器天然隔离：Electron 的 userData 取自应用名，
 * 本工程 name=node-launcher → %APPDATA%/node-launcher，互不干扰。
 */
export function getDataDir(): string {
  return app.getPath('userData');
}

/**
 * 受管项目根目录。默认 userData/projects，
 * 但可以在设置里改成任意目录（换目录后的迁移逻辑见 store/projects-root.ts）。
 */
let projectsRootOverride: string | null = null;

export function setProjectsRoot(dir: string): void {
  projectsRootOverride = dir;
}

export function getProjectsDir(): string {
  return projectsRootOverride ?? path.join(getDataDir(), 'projects');
}

/** 按需下载的 Node 运行时缓存 */
export function getRuntimesDir(): string {
  return path.join(getDataDir(), 'runtimes');
}

/** 随安装包内置的 Node 运行时（electron-builder extraResources） */
export function getBundledRuntimesDir(): string {
  const resources = process.resourcesPath || path.join(app.getAppPath(), '..');
  return path.join(resources, 'runtimes');
}

export function getDownloadsDir(): string {
  return path.join(getDataDir(), 'downloads');
}

export function getLogsDir(): string {
  return path.join(getDataDir(), 'logs');
}

/** cloudflared 等外部小工具 */
export function getBinDir(): string {
  return path.join(getDataDir(), 'bin');
}

export function isDevelopment(): boolean {
  return !!process.env.VITE_DEV_SERVER_URL;
}
