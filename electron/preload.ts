import { contextBridge, ipcRenderer } from 'electron';

/**
 * 渲染层唯一的接口面。
 * 原则：只暴露窄接口，不暴露 ipcRenderer 本体。
 */
const api = {
  /* 应用 */
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  openPath: (p: string) => ipcRenderer.invoke('app:openPath', p),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),

  /* 配置 */
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch: unknown) => ipcRenderer.invoke('config:set', patch),

  /* 项目 */
  listProjects: () => ipcRenderer.invoke('project:list'),
  getProject: (id: string) => ipcRenderer.invoke('project:get', id),
  pickFolder: () => ipcRenderer.invoke('project:pickFolder'),
  pickZip: () => ipcRenderer.invoke('project:pickZip'),
  addFolder: (folderPath: string, mode: 'link' | 'copy') =>
    ipcRenderer.invoke('project:addFolder', folderPath, mode),
  addZip: (zipPath: string, groupId?: string) =>
    ipcRenderer.invoke('project:addZip', zipPath, groupId),
  updateProject: (id: string, patch: unknown) =>
    ipcRenderer.invoke('project:update', id, patch),
  adoptProject: (id: string) => ipcRenderer.invoke('project:adopt', id),
  removeProject: (id: string, deleteFiles: boolean) =>
    ipcRenderer.invoke('project:remove', id, deleteFiles),
  openProjectDir: (id: string) => ipcRenderer.invoke('project:openDir', id),
  detectProject: (id: string) => ipcRenderer.invoke('project:detect', id),
  reorderProjects: (ids: string[]) => ipcRenderer.invoke('project:reorder', ids),

  /* 启动 */
  startProject: (id: string, depsAction?: string) =>
    ipcRenderer.invoke('launch:start', id, depsAction),
  stopProject: (id: string) => ipcRenderer.invoke('launch:stop', id),
  stopAll: () => ipcRenderer.invoke('launch:stopAll'),
  getLaunchStates: () => ipcRenderer.invoke('launch:states'),
  resolveDepsPrompt: (id: string, action: string) =>
    ipcRenderer.invoke('launch:resolvePrompt', id, action),

  /* 依赖 */
  getDepsStatus: (id: string) => ipcRenderer.invoke('deps:status', id),
  installDeps: (id: string, opts?: unknown) => ipcRenderer.invoke('deps:install', id, opts),
  cancelDeps: (id: string) => ipcRenderer.invoke('deps:cancel', id),
  cleanDeps: (id: string) => ipcRenderer.invoke('deps:clean', id),

  /* 运行时 */
  listRuntimes: () => ipcRenderer.invoke('runtime:list'),
  ensureRuntime: (version?: string) => ipcRenderer.invoke('runtime:ensure', version),

  /* 母栏（分组） */
  listGroups: () => ipcRenderer.invoke('group:list'),
  createGroup: (input: unknown) => ipcRenderer.invoke('group:create', input),
  updateGroup: (id: string, patch: unknown) => ipcRenderer.invoke('group:update', id, patch),
  removeGroup: (id: string) => ipcRenderer.invoke('group:remove', id),
  collapseGroup: (id: string, collapsed: boolean) =>
    ipcRenderer.invoke('group:collapse', id, collapsed),
  moveToGroup: (instanceId: string, groupId: string | null) =>
    ipcRenderer.invoke('group:move', instanceId, groupId),
  reorderGroups: (payload: unknown) => ipcRenderer.invoke('group:reorder', payload),
  checkGroupUpdate: (id: string) => ipcRenderer.invoke('group:checkUpdate', id),
  addGroupRelease: (id: string, payload: unknown) =>
    ipcRenderer.invoke('group:addRelease', id, payload),

  /* 本机网络地址 */
  getLocalIPs: () => ipcRenderer.invoke('net:getIPs'),

  /* 项目数据目录与迁移 */
  getRootInfo: () => ipcRenderer.invoke('root:info'),
  selectRootDir: () => ipcRenderer.invoke('root:select'),
  migrateProjects: () => ipcRenderer.invoke('root:migrate'),
  resetRootDir: () => ipcRenderer.invoke('root:reset'),

  /* 内网穿透 */
  getTunnelStates: () => ipcRenderer.invoke('tunnel:states'),
  startTunnel: (id: string) => ipcRenderer.invoke('tunnel:start', id),
  stopTunnel: (id: string) => ipcRenderer.invoke('tunnel:stop', id),
  recheckTunnel: (id: string) => ipcRenderer.invoke('tunnel:recheck', id),

  /* 日志 */
  getLogs: (projectId?: string | null) => ipcRenderer.invoke('logs:get', projectId),
  clearLogs: (projectId?: string | null) => ipcRenderer.invoke('logs:clear', projectId),
  exportLogs: (projectId?: string | null) => ipcRenderer.invoke('logs:export', projectId),

  /* 窗口 */
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  /* 事件订阅（返回取消订阅函数） */
  onLog: (cb: (entry: unknown) => void) => subscribe('log:entry', cb),
  onLaunchState: (cb: (state: unknown) => void) => subscribe('launch:state', cb),
  onLaunchPrompt: (cb: (prompt: unknown) => void) => subscribe('launch:prompt', cb),
  onMetrics: (cb: (snapshot: unknown) => void) => subscribe('metrics', cb),
  onDepsProgress: (cb: (progress: unknown) => void) => subscribe('deps:progress', cb),
  onRuntimeProgress: (cb: (progress: unknown) => void) => subscribe('runtime:progress', cb),
  onTunnelState: (cb: (state: unknown) => void) => subscribe('tunnel:state', cb),
  onGroupProgress: (cb: (progress: unknown) => void) => subscribe('group:progress', cb),
};

function subscribe(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_event: unknown, payload: unknown): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', api);

export type LauncherApi = typeof api;
