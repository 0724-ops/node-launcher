import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import path from 'path';
import fse from 'fs-extra';

import type {
  AppConfig,
  AppInfo,
  DepsStatus,
  GroupedProjects,
  GroupProgress,
  GroupReleaseCheck,
  LaunchState,
  LogEntry,
  MetricsSnapshot,
  NetworkInterface,
  ProjectDetectResult,
  ProjectGroup,
  ProjectManifest,
  ProjectSummary,
  ProjectsRootInfo,
  RuntimeInfo,
  RuntimeProgress,
  TunnelState,
} from '../types';
import type { DepsPrompt, DepsPromptAction, DepsInstallResult } from '../core/deps/deps-types';
import * as appPaths from '../core/app-paths';
import { ConfigStore } from '../core/store/config-store';
import { ProjectStore } from '../core/store/project-store';
import { GroupsStore } from '../core/store/groups-store';
import {
  buildRootInfo,
  migrateContents,
  migrationSourcePatch,
  resolveProjectsRoot,
} from '../core/store/projects-root';
import { LogService } from '../core/log/log-service';
import { NodeRuntimeProvider } from '../core/runtime/node-provider';
import { DepsInstaller } from '../core/deps/installer';
import { LaunchManager } from '../core/launch/launch-manager';
import { ProjectService } from '../core/project/project-service';
import { applyProjectOrder, normalizeProjectOrder } from '../core/project/project-order';
import {
  buildGroupedView,
  createGroup,
  deleteGroup,
  moveInstance,
  newGroupId,
  setGroupCollapsed,
  updateGroup,
} from '../core/project/group-logic';
import { applyGithubMirror } from '../core/net/github-mirror';
import { fetchReleaseCheck, isSourceArchive, resolveAsset } from '../core/net/github-release';
import { downloadFile } from '../core/download/downloader';
import { projectWorkDir } from '../core/project/project-paths';
import { getLocalIPs } from '../core/net/network-utils';
import { TunnelManager } from '../core/tunnel/tunnel-manager';
import { toMessage } from '../core/util/errors';
import type { ProjectPatch } from '../core/store/manifest';

const APP_ID = 'com.nodelauncher.desktop';

export interface IpcContext {
  configStore: ConfigStore;
  projectStore: ProjectStore;
  groupsStore: GroupsStore;
  logService: LogService;
  provider: NodeRuntimeProvider;
  installer: DepsInstaller;
  projects: ProjectService;
  launcher: LaunchManager;
  tunnel: TunnelManager;
  getWindow: () => BrowserWindow | null;
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

export async function createServices(): Promise<IpcContext> {
  const dataDir = appPaths.getDataDir();
  const configStore = new ConfigStore(dataDir);
  const initialConfig = await configStore.load();

  // 受管项目目录可以由用户在设置里改（改完立即生效），这里先按配置解析一次
  const projectsRoot = resolveProjectsRoot(dataDir, initialConfig.projectsRootUser);
  appPaths.setProjectsRoot(projectsRoot);
  const projectStore = new ProjectStore(projectsRoot);
  await projectStore.init();

  // 母栏定义与 config.json 同级，不放进 projects/（那个目录会被当成项目候选扫描）
  const groupsStore = new GroupsStore(dataDir);

  const logService = new LogService({
    maxLinesPerProject: 5000,
    logToFile: true,
    logDir: appPaths.getLogsDir(),
  });

  const provider = new NodeRuntimeProvider({
    bundledDir: appPaths.getBundledRuntimesDir(),
    runtimesDir: appPaths.getRuntimesDir(),
    platform: process.platform,
    arch: process.arch,
    getConfig: async () => {
      const cfg = await configStore.load();
      return {
        defaultNodeVersion: cfg.defaultNodeVersion,
        nodeDownloadMirror: cfg.nodeDownloadMirror,
        preferBundledRuntime: cfg.preferBundledRuntime,
      };
    },
    log: (msg) => logService.push(null, 'sys', msg),
    onProgress: (progress) => broadcast('runtime:progress', progress),
  });

  const installer = new DepsInstaller({
    store: projectStore,
    config: () => configStore.load(),
    log: (projectId, kind, msg) => logService.push(projectId, kind, msg),
    onProgress: (p) => broadcast('deps:progress', p),
  });

  const projects = new ProjectService(projectStore, () => configStore.load());

  const tunnel = new TunnelManager({
    binDir: appPaths.getBinDir(),
    getConfig: () => configStore.load(),
    log: (projectId, kind, msg) => logService.push(projectId, kind, msg),
    onState: (state) => broadcast('tunnel:state', state),
  });

  let context: IpcContext;
  const launcher = new LaunchManager({
    store: projectStore,
    provider,
    config: () => configStore.load(),
    depsService: installer,
    log: (projectId, kind, msg) => logService.push(projectId, kind, msg),
    onState: (state) => {
      broadcast('launch:state', state);
      // 生命周期联动：项目停止/失败后不再需要穿透（照搬旧启动器的做法）
      if ((state.phase === 'idle' || state.phase === 'failed') && tunnel.isRunning(state.projectId)) {
        void tunnel
          .stop(state.projectId)
          .then(() => logService.push(state.projectId, 'sys', '项目已停止，内网穿透已自动断开'))
          .catch(() => {});
      }
    },
    onMetrics: (snapshot) => broadcast('metrics', snapshot),
    onPrompt: (prompt) => broadcast('launch:prompt', prompt),
    reporterPath: resolveReporterPath(),
  });

  context = {
    configStore,
    projectStore,
    groupsStore,
    logService,
    provider,
    installer,
    projects,
    launcher,
    tunnel,
    getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
  };
  return context;
}

/** 打包后 metrics-reporter.js 位于 app.asar.unpacked */
function resolveReporterPath(): string {
  const packed = path.join(__dirname, '..', 'core', 'launch', 'metrics-reporter.js');
  const unpacked = packed.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`
  );
  return fse.existsSync(unpacked) ? unpacked : packed;
}

function appInfo(): AppInfo {
  const dataDir = appPaths.getDataDir();
  const base = path.basename(dataDir).toLowerCase();
  const isolated = base === 'node-launcher' && !base.includes('stronghold');
  return {
    version: app.getVersion(),
    name: app.getName(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    dataDir,
    projectsDir: appPaths.getProjectsDir(),
    isolation: {
      appId: APP_ID,
      dataDir,
      isolated,
      note: isolated ? '' : `数据目录为 ${dataDir}，请确认与其它程序不冲突。`,
    },
  };
}

export function registerIpcHandlers(ctx: IpcContext): void {
  const {
    configStore,
    projectStore,
    groupsStore,
    logService,
    provider,
    installer,
    projects,
    launcher,
    tunnel,
  } = ctx;

  const dataDir = appPaths.getDataDir();

  /** 把配置里的受管项目目录落到运行时（改完立即生效） */
  const applyProjectsRoot = async (cfg: AppConfig): Promise<string> => {
    const root = resolveProjectsRoot(dataDir, cfg.projectsRootUser);
    appPaths.setProjectsRoot(root);
    projectStore.setRoot(root);
    await projectStore.init();
    return root;
  };

  logService.attach((entry: LogEntry) => broadcast('log:entry', entry));

  /* ---------------- 应用 ---------------- */
  ipcMain.handle('app:info', () => appInfo());
  ipcMain.handle('app:openPath', async (_, target: string) => {
    if (!target) return;
    await shell.openPath(target);
  });
  ipcMain.handle('app:openExternal', async (_, url: string) => {
    if (!/^https?:\/\//i.test(String(url ?? ''))) {
      throw new Error('仅允许打开 http/https 链接');
    }
    await shell.openExternal(url);
  });

  /* ---------------- 本机网络 ---------------- */
  // 只读：给「访问地址」展示局域网 / 组网地址用（旧启动器的 net:getIPs）
  ipcMain.handle('net:getIPs', (): NetworkInterface[] => getLocalIPs());

  /* ---------------- 配置 ---------------- */
  ipcMain.handle('config:get', () => configStore.load());
  ipcMain.handle('config:set', async (_, patch: Partial<AppConfig>) => {
    const current = await configStore.load();
    let next: Partial<AppConfig> = patch;

    // 切换项目数据目录时，把仍存有项目的旧目录记为迁移来源（照搬旧启动器逻辑）
    if (typeof patch.projectsRootUser === 'string') {
      const extra = await migrationSourcePatch(dataDir, current, patch.projectsRootUser);
      next = { ...patch, ...extra };
    }

    const saved = await configStore.save(next);

    if (typeof patch.projectsRootUser === 'string') {
      const root = await applyProjectsRoot(saved);
      logService.push(null, 'sys', `项目数据目录已切换为 ${root}`);
    }

    logService.setOptions({
      maxLinesPerProject: saved.logBufferLines,
      logToFile: saved.logToFile,
    });
    return saved;
  });

  /* ---------------- 项目数据目录 / 迁移 ---------------- */
  ipcMain.handle('root:info', async (): Promise<ProjectsRootInfo> => {
    const cfg = await configStore.load();
    return buildRootInfo(dataDir, cfg);
  });

  ipcMain.handle('root:select', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择项目数据目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('root:migrate', async () => {
    if (launcher.runningProjectIds().length > 0) {
      throw new Error('请先停止所有运行中的项目再迁移');
    }
    const cfg = await configStore.load();
    const info = await buildRootInfo(dataDir, cfg);
    if (!info.changed) throw new Error('当前目录与旧目录相同，无需迁移');

    // 旧目录 → 当前目录
    const moved = await migrateContents(info.prevDir, info.currentDir);
    // 迁移完成后，旧目录同步为当前选择
    const saved = await configStore.save({ projectsRootActive: cfg.projectsRootUser ?? '' });
    await applyProjectsRoot(saved);
    logService.push(null, 'sys', `已迁移 ${moved} 个项目到 ${info.currentDir}`);
    return { moved, target: info.currentDir };
  });

  ipcMain.handle('root:reset', async () => {
    // 仅回到默认目录；把仍存有项目的目录记为迁移来源，以便默认目录为空时仍可引导迁移回旧数据
    const cfg = await configStore.load();
    const extra = await migrationSourcePatch(dataDir, cfg, '');
    const saved = await configStore.save({ projectsRootUser: '', ...extra });
    const root = await applyProjectsRoot(saved);
    return { dir: root };
  });

  /* ---------------- 项目 ---------------- */

  /**
   * 已富化的项目列表：`project:list` 与 `group:list` 共用。
   * `depsState` 是文件系统探测，两个通道各算一遍会让开销翻倍，所以只在这里算一次。
   */
  const listSummaries = async (): Promise<ProjectSummary[]> => {
    const config = await configStore.load();
    // 用户拖拽过的顺序优先；没排进顺序表的新项目自动落在后面
    const manifests = applyProjectOrder(await projectStore.list(), config.projectOrder ?? []);
    const summaries: ProjectSummary[] = [];
    for (const manifest of manifests) {
      const state = launcher.getState(manifest.id);
      summaries.push({
        ...manifest,
        running: launcher.isRunning(manifest.id),
        phase: state?.phase ?? 'idle',
        depsState: await installer.quickState(manifest.id),
      });
    }
    return summaries;
  };

  // 注意：分组视图**不改变**这个通道的返回结构（渲染层按扁平数组消费它）
  ipcMain.handle('project:list', (): Promise<ProjectSummary[]> => listSummaries());

  /** 保存拖拽后的项目顺序（只存 id 数组；非法 / 失效 id 自动丢弃） */
  ipcMain.handle('project:reorder', async (_, ids: string[]) => {
    const manifests = await projectStore.list();
    const order = normalizeProjectOrder(
      manifests.map((m) => m.id),
      Array.isArray(ids) ? ids : []
    );
    await configStore.save({ projectOrder: order });
    return order;
  });

  ipcMain.handle('project:get', (_, id: string) => projectStore.get(id));

  ipcMain.handle('project:pickFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择项目目录',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('project:pickZip', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择压缩包',
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle(
    'project:addFolder',
    async (_, folderPath: string, mode: 'link' | 'copy') => {
      const manifest = await projects.createFromFolder({ folderPath, mode });
      logService.push(manifest.id, 'sys', `已添加项目「${manifest.name}」（${mode === 'link' ? '引用原目录' : '复制导入'}）`);
      return manifest;
    }
  );

  ipcMain.handle('project:addZip', async (_, zipPath: string, groupId?: string) => {
    logService.push(null, 'sys', `正在解压导入 ${path.basename(zipPath)}…`);
    const manifest = await projects.importZip(zipPath);
    logService.push(manifest.id, 'sys', `导入完成：${manifest.name}`);
    // 通过某个母栏发起导入时自动归类（从侧栏「导入」发起的没有上下文，落入未分组）
    if (groupId) {
      await groupsStore.mutate(await knownProjectIds(), (groups) =>
        moveInstance(groups, manifest.id, groupId)
      );
    }
    return manifest;
  });

  ipcMain.handle('project:update', (_, id: string, patch: ProjectPatch) =>
    projects.update(id, patch)
  );

  ipcMain.handle('project:adopt', async (_, id: string) => {
    if (launcher.isRunning(id)) throw new Error('项目正在运行，请先停止');
    if (installer.isInstalling(id)) throw new Error('正在安装依赖，请稍候');
    const manifest = await projects.adoptLinked(id);
    logService.push(id, 'sys', `已把引用目录迁移为受管副本：${manifest.rootDir}`);
    return manifest;
  });

  ipcMain.handle('project:remove', async (_, id: string, deleteFiles: boolean) => {
    if (launcher.isRunning(id)) throw new Error('项目正在运行，请先停止');
    if (installer.isInstalling(id)) throw new Error('正在安装依赖，请稍候');
    if (tunnel.isRunning(id)) await tunnel.stop(id);
    await projects.remove(id, deleteFiles);
    logService.clear(id);
  });

  ipcMain.handle('project:openDir', async (_, id: string) => {
    const manifest = await projectStore.get(id);
    if (!manifest) throw new Error('项目不存在');
    const dir =
      manifest.source === 'linked'
        ? manifest.rootDir
        : projectStore.srcDir(manifest.id);
    await shell.openPath(dir);
  });

  ipcMain.handle('project:detect', (_, id: string): Promise<ProjectDetectResult> =>
    projects.detect(id)
  );

  /* ---------------- 母栏（分组） ---------------- */

  /** 现存项目 id：母栏归一化的白名单，不存在的 id 会被丢掉 */
  const knownProjectIds = async (): Promise<string[]> =>
    (await projectStore.list()).map((manifest) => manifest.id);

  const buildGroupView = async (): Promise<GroupedProjects> => {
    const config = await configStore.load();
    const [list, groups] = await Promise.all([
      listSummaries(),
      groupsStore.load(await knownProjectIds()),
    ]);
    return buildGroupedView(groups, list, config.projectOrder ?? []);
  };

  ipcMain.handle('group:list', (): Promise<GroupedProjects> => buildGroupView());

  /** 写操作的统一入口：串行落盘 → 返回最新完整视图（UI 直接替换，不产生中间态） */
  const mutateGroups = async (
    fn: (groups: ProjectGroup[]) => ProjectGroup[]
  ): Promise<GroupedProjects> => {
    await groupsStore.mutate(await knownProjectIds(), fn);
    return buildGroupView();
  };

  ipcMain.handle('group:create', (_, input: { name?: string; githubRepo?: string }) =>
    mutateGroups((groups) =>
      createGroup(groups, {
        id: newGroupId(),
        name: String(input?.name ?? ''),
        githubRepo: input?.githubRepo,
      })
    )
  );

  ipcMain.handle(
    'group:update',
    (_, id: string, patch: { name?: string; githubRepo?: string }) =>
      mutateGroups((groups) => updateGroup(groups, id, patch ?? {}))
  );

  ipcMain.handle('group:remove', (_, id: string) => {
    logService.push(null, 'sys', '已删除母栏：栏内实例回到未分组，项目本身未删除');
    return mutateGroups((groups) => deleteGroup(groups, id));
  });

  ipcMain.handle('group:collapse', (_, id: string, collapsed: boolean) =>
    mutateGroups((groups) => setGroupCollapsed(groups, id, collapsed))
  );

  // 兜底菜单的单点移动（拖拽不走这里，避免一次手势两次落盘）
  ipcMain.handle('group:move', (_, instanceId: string, groupId: string | null) =>
    mutateGroups((groups) => moveInstance(groups, instanceId, groupId))
  );

  /**
   * 拖拽落盘：一次手势只发一次请求。
   * `order` 必须是**所有母栏按视图顺序拼接后的完整 id 列表**（未分组放最后）——
   * 只提交部分 id 会让其余项目被 normalizeProjectOrder 判为「未列出」而挪到末尾。
   */
  ipcMain.handle(
    'group:reorder',
    async (
      _,
      payload: { order?: string[]; moves?: Array<{ instanceId?: string; groupId?: string | null }> }
    ): Promise<GroupedProjects> => {
      const ids = await knownProjectIds();
      const moves = Array.isArray(payload?.moves) ? payload.moves : [];
      if (moves.length) {
        await groupsStore.mutate(ids, (groups) =>
          moves.reduce(
            (acc, move) => moveInstance(acc, String(move?.instanceId ?? ''), move?.groupId ?? null),
            groups
          )
        );
      }
      const order = normalizeProjectOrder(ids, Array.isArray(payload?.order) ? payload.order : []);
      await configStore.save({ projectOrder: order });
      return buildGroupView();
    }
  );

  ipcMain.handle('group:checkUpdate', async (_, id: string): Promise<GroupReleaseCheck> => {
    const ids = await knownProjectIds();
    const group = (await groupsStore.load(ids)).find((item) => item.id === id);
    if (!group) throw new Error('母栏不存在');
    if (!group.githubRepo) throw new Error('先在母栏信息里填写 GitHub 仓库地址');

    const config = await configStore.load();
    const check = await fetchReleaseCheck({
      repo: group.githubRepo,
      token: config.githubToken,
      currentTag: group.lastSeenTag,
      log: (msg) => logService.push(null, 'sys', `[${group.name}] ${msg}`),
    });

    // 无论有没有新版本都把最新 tag 记下来：首次检查只记录，不谎报「有新版本」
    await groupsStore.mutate(ids, (groups) =>
      groups.map((item) =>
        item.id === id
          ? { ...item, lastSeenTag: check.latestTag, lastCheckedAt: new Date().toISOString() }
          : item
      )
    );
    return check;
  });

  ipcMain.handle(
    'group:addRelease',
    async (
      _,
      id: string,
      payload: { tag?: string; assetName?: string }
    ): Promise<GroupedProjects> => {
      const ids = await knownProjectIds();
      const group = (await groupsStore.load(ids)).find((item) => item.id === id);
      if (!group) throw new Error('母栏不存在');
      if (!group.githubRepo) throw new Error('先在母栏信息里填写 GitHub 仓库地址');
      const assetName = String(payload?.assetName ?? '').trim();
      if (!assetName) throw new Error('没有选择要下载的资产');

      const config = await configStore.load();
      const log = (msg: string): void => logService.push(null, 'sys', `[${group.name}] ${msg}`);
      const progress = (p: {
        phase: GroupProgress['phase'];
        percent: number;
        message?: string;
      }): void => {
        broadcast('group:progress', { groupId: id, ...p });
      };

      progress({ phase: 'fetching', percent: 0, message: '正在解析 release 资产…' });
      const { release, asset } = await resolveAsset({
        repo: group.githubRepo,
        token: config.githubToken,
        tag: payload?.tag,
        assetName,
        log,
      });

      // 资产名来自远端：先收敛成安全文件名再落盘（绝不让远端字符串拼出路径）
      const safeName = asset.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120) || 'release.zip';
      const zipPath = path.join(dataDir, 'downloads', `${Date.now()}-${safeName}`);
      const direct = asset.browserDownloadUrl;
      const url = applyGithubMirror(direct, config.githubMirror);

      const fetchAsset = async (target: string): Promise<void> => {
        await downloadFile({
          url: target,
          dest: zipPath,
          // 只在用户自己配了 http 镜像时放开限制，与设置里的说明一致
          allowInsecure: /^http:\/\//i.test(target),
          onProgress: (p) =>
            progress({
              phase: 'downloading',
              percent: p.percent,
              message: `正在下载 ${asset.name}（${p.percent}%）`,
            }),
        });
      };

      try {
        try {
          await fetchAsset(url);
        } catch (err) {
          // 镜像是第三方代理，挂了不能连累用户；回退直连 GitHub
          if (url === direct) throw err;
          log(`镜像下载失败（${toMessage(err)}），回退直连 GitHub`);
          await fetchAsset(direct);
        }
      } catch (err) {
        const message = toMessage(err);
        log(`下载失败：${message}`);
        progress({ phase: 'error', percent: 0, message });
        throw err;
      }

      progress({ phase: 'extracting', percent: 100, message: '正在解压导入…' });
      const manifest = await projects
        .importZip(zipPath, `${group.name} ${release.tagName}`, {
          source: 'github',
          idPrefix: 'github',
          desc: `来自 ${group.githubRepo} ${release.tagName}${
            isSourceArchive(asset.name) ? '（源码包）' : ''
          }`,
        })
        .catch((err) => {
          const message = toMessage(err);
          progress({ phase: 'error', percent: 0, message });
          throw err;
        })
        .finally(() => fse.remove(zipPath).catch(() => {}));
      // 上面已经解压进项目目录，压缩包留着只是占空间

      // 导入产生了新项目：白名单要重新取一次，否则新 id 会被归一化当成「不存在的项目」丢掉
      const freshIds = await knownProjectIds();
      await groupsStore.mutate(freshIds, (groups) =>
        groups.map((item) =>
          item.id === id
            ? {
                ...item,
                instanceIds: [...new Set([...item.instanceIds, manifest.id])],
                lastSeenTag: release.tagName,
                lastCheckedAt: new Date().toISOString(),
              }
            : item
        )
      );

      log(`已添加为实例：${manifest.name}`);
      progress({ phase: 'done', percent: 100, message: `已添加「${manifest.name}」` });
      return buildGroupView();
    }
  );

  /* ---------------- 启动 ---------------- */
  ipcMain.handle('launch:start', (_, id: string, depsAction?: DepsPromptAction) => {
    launcher.start(id, { depsAction });
    return true;
  });

  ipcMain.handle('launch:stop', async (_, id: string) => {
    await launcher.stop(id);
    return true;
  });

  ipcMain.handle('launch:stopAll', async () => {
    await launcher.stopAll();
    return true;
  });

  ipcMain.handle('launch:states', (): LaunchState[] => launcher.getStates());

  ipcMain.handle(
    'launch:resolvePrompt',
    (_, projectId: string, action: DepsPromptAction) => launcher.resolvePrompt(projectId, action)
  );

  /* ---------------- 依赖 ---------------- */
  ipcMain.handle('deps:status', (_, id: string): Promise<DepsStatus> => installer.status(id));

  ipcMain.handle(
    'deps:install',
    async (
      _,
      id: string,
      opts: { allowScripts?: boolean; action?: DepsPromptAction } = {}
    ): Promise<DepsInstallResult> => {
      const manifest = await projectStore.get(id);
      if (!manifest) throw new Error('项目不存在');
      if (launcher.isRunning(id)) throw new Error('项目正在运行，请先停止再安装依赖');
      const runtime = await provider.ensureRuntime(manifest.nodeVersion);
      const workDir = projectWorkDir(projectStore, manifest);
      const allowScripts =
        opts.allowScripts ?? (opts.action === 'install-allow-scripts' || manifest.allowInstallScripts);
      return installer.install({
        projectId: id,
        manifest,
        workDir,
        runtime,
        allowScripts,
        reason: 'manual',
      });
    }
  );

  ipcMain.handle('deps:cancel', (_, id: string) => {
    installer.cancel(id);
    return true;
  });

  ipcMain.handle('deps:clean', async (_, id: string) => {
    if (launcher.isRunning(id)) throw new Error('项目正在运行，请先停止');
    await installer.clean(id);
    return true;
  });

  /* ---------------- 运行时 ---------------- */
  ipcMain.handle('runtime:list', (): Promise<RuntimeInfo[]> => provider.listInstalled());
  ipcMain.handle('runtime:ensure', (_, version?: string): Promise<RuntimeInfo> =>
    provider.ensureRuntime(version)
  );

  /* ---------------- 日志 ---------------- */
  ipcMain.handle('logs:get', (_, projectId?: string | null) => logService.get(projectId));
  ipcMain.handle('logs:clear', (_, projectId?: string | null) => {
    logService.clear(projectId);
    return true;
  });
  ipcMain.handle('logs:export', async (_, projectId?: string | null) => {
    const result = await dialog.showSaveDialog({
      title: '导出日志',
      defaultPath: `node-launcher-${projectId ?? 'all'}-${Date.now()}.log`,
      filters: [{ name: '日志文件', extensions: ['log', 'txt'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fse.writeFile(result.filePath, logService.exportText(projectId), 'utf8');
    return result.filePath;
  });

  /* ---------------- 内网穿透（Cloudflare Tunnel） ---------------- */
  ipcMain.handle('tunnel:states', (): TunnelState[] => tunnel.getStates());

  ipcMain.handle('tunnel:start', async (_, id: string): Promise<TunnelState> => {
    const manifest = await projectStore.get(id);
    if (!manifest) throw new Error('项目不存在');
    if (!launcher.isRunning(id)) throw new Error('请先启动项目，再开启内网穿透');
    const port = launcher.getState(id)?.port ?? manifest.port ?? 0;
    if (!port) throw new Error('当前项目没有可用端口，无法建立穿透');
    return tunnel.start(id, port);
  });

  ipcMain.handle('tunnel:stop', async (_, id: string) => {
    await tunnel.stop(id);
    return true;
  });

  ipcMain.handle('tunnel:recheck', (_, id: string): TunnelState => tunnel.recheck(id));

  /* ---------------- 窗口 ---------------- */
  ipcMain.on('window:minimize', () => ctx.getWindow()?.minimize());
  ipcMain.on('window:maximize', () => {
    const win = ctx.getWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', () => ctx.getWindow()?.close());

  /* ---------------- 兜底：未捕获异常也进日志 ---------------- */
  process.on('uncaughtException', (err) => {
    logService.push(null, 'err', `未捕获异常: ${toMessage(err)}`);
  });
}
