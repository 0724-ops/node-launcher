import { BrowserWindow, app } from 'electron';
import path from 'path';
import fse from 'fs-extra';
import { createServices, registerIpcHandlers, type IpcContext } from './ipc';

/**
 * 主进程入口。
 * 隔离说明：本应用 name=node-launcher，userData / 安装目录 / 快捷方式 / appId
 * 均与旧专用启动器不同，可在同一台设备共存且互不干扰。
 */

let mainWindow: BrowserWindow | null = null;
let ctx: IpcContext | null = null;
let isQuitting = false;

/**
 * 固定用户数据目录。
 * Electron 默认取 productName（"Node Launcher"）作为目录名，在不同的打包/开发环境下
 * 可能有差异；这里显式钉死为 %APPDATA%/node-launcher，保证：
 *   1) 与旧专用启动器（%APPDATA%/stronghold-launcher）彻底隔离；
 *   2) 单实例锁、配置、项目、运行时缓存都落在同一个独立目录里。
 *
 * 注意：app.setPath 要求目录已存在，否则会抛错，因此先创建。
 */
const userDataDir = path.join(app.getPath('appData'), 'node-launcher');
try {
  fse.ensureDirSync(userDataDir);
} catch {
  /* 目录创建失败时回退到 Electron 默认位置 */
}
app.setPath('userData', userDataDir);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例（本应用自己的单实例锁，不影响其它启动器）
  app.quit();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0f12',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  ctx = await createServices();
  registerIpcHandlers(ctx);

  // 记录数据目录，便于排查「两个启动器是否互相影响」
  const config = await ctx.configStore.load();
  ctx.logService.setOptions({
    maxLinesPerProject: config.logBufferLines,
    logToFile: config.logToFile,
  });
  ctx.logService.push(null, 'sys', `数据目录: ${app.getPath('userData')}`);
  ctx.logService.push(null, 'sys', `Node Launcher v${app.getVersion()} 已启动`);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (isQuitting || !ctx) return;
  const running = ctx.launcher.runningProjectIds();
  const installing = running.length;
  const tunneling = ctx.tunnel.runningProjectIds();
  if (running.length === 0 && !installing && tunneling.length === 0) return;

  event.preventDefault();
  isQuitting = true;
  ctx.logService.push(null, 'sys', '正在停止所有运行中的项目…');
  void (async () => {
    for (const id of running) {
      ctx?.installer.cancel(id);
    }
    try {
      await ctx?.tunnel.stopAll();
    } catch {
      /* ignore */
    }
    try {
      await ctx?.launcher.stopAll();
    } catch {
      /* ignore */
    }
    // 给 taskkill 一点时间落地
    await new Promise((resolve) => setTimeout(resolve, 700));
    app.exit(0);
  })();
});

/** 窗口尺寸持久化（尽力而为，失败不影响启动） */
app.on('ready', () => {
  try {
    const dir = app.getPath('userData');
    void fse.ensureDir(dir);
  } catch {
    /* ignore */
  }
});
