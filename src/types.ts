/** 渲染层用到的共享类型（与主进程 electron/types 对齐的轻量子集） */

export type StartMode = 'node' | 'command';
export type PortMode = 'inject' | 'display' | 'none';
export type AutoInstallDeps = 'ask' | 'always' | 'never';
export type MetricsStrategy = 'auto' | 'reporter' | 'polling';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type LaunchPhase =
  | 'idle'
  | 'preflight'
  | 'spawning'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'restarting'
  | 'failed';
export type DepsState = 'unknown' | 'na' | 'ready' | 'missing' | 'installing' | 'failed';
export type ErrorCategory =
  | 'missing-module'
  | 'missing-relative'
  | 'native-abi'
  | 'build-tool'
  | 'syntax'
  | 'port-in-use'
  | 'permission'
  | 'network'
  | 'command-not-found'
  | 'unknown';

export interface RestartPolicy {
  mode: 'never' | 'on-failure';
  maxRetries: number;
  backoffMs: number;
}

export interface ProjectManifest {
  schema: 1;
  id: string;
  name: string;
  desc?: string;
  tags?: string[];
  source: 'linked' | 'managed' | 'zip' | 'github' | 'git';
  rootDir: string;
  cwd?: string;
  startMode: StartMode;
  entry?: string;
  nodeVersion?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  envFile?: string;
  portMode: PortMode;
  port?: number;
  host?: string;
  readyPattern?: string;
  healthUrl?: string;
  readyTimeoutMs?: number;
  autoInstallDeps: AutoInstallDeps;
  allowInstallScripts: boolean;
  restartPolicy: RestartPolicy;
  stopSignal?: 'SIGTERM' | 'SIGINT';
  stopTimeoutMs?: number;
  singleton: boolean;
  createdAt: string;
  lastStartedAt?: string | null;
  lastExit?: {
    code: number | null;
    signal: string | null;
    at: string;
    category?: ErrorCategory;
  } | null;
}

export interface ProjectSummary extends ProjectManifest {
  running: boolean;
  phase: LaunchPhase;
  depsState: DepsState;
}

export interface LaunchState {
  projectId: string;
  phase: LaunchPhase;
  pid: number | null;
  port: number | null;
  url: string | null;
  startedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  category: ErrorCategory | null;
  message: string;
  restarts: number;
  installAttempted: boolean;
}

export interface MetricsSnapshot {
  projectId: string;
  cpu: number;
  memoryMb: number;
  strategy: 'reporter' | 'polling';
  pidCount: number;
  at: number;
}

export interface DepsStatus {
  projectId: string;
  state: DepsState;
  hasPackageJson: boolean;
  packageManager: PackageManager | null;
  lockfile: string | null;
  nodeModulesExists: boolean;
  nodeModulesSizeBytes: number;
  lastInstallAt: string | null;
  lastError: string | null;
  installLines: number;
}

export interface ProjectDetectResult {
  rootedAt: string;
  hasPackageJson: boolean;
  packageName: string | null;
  packageManager: PackageManager;
  lockfile: string | null;
  scripts: Record<string, string>;
  moduleType: 'module' | 'commonjs' | null;
  enginesNode: string | null;
  entryCandidates: string[];
  suggestedStartMode: StartMode;
  suggestedEntry: string | null;
  suggestedCommand: string | null;
  suggestedCwd: string;
  workspaceCandidates: string[];
}

export interface LogEntry {
  projectId: string | null;
  kind: 'sys' | 'out' | 'err' | 'dep';
  msg: string;
  timestamp: number;
}

export interface AppConfig {
  schema: 1;
  defaultNodeVersion: string;
  nodeDownloadMirror: string;
  npmRegistry: string;
  preferBundledRuntime: boolean;
  defaultAutoInstallDeps: AutoInstallDeps;
  defaultAllowInstallScripts: boolean;
  installTimeoutMs: number;
  defaultPortMode: PortMode;
  defaultPort: number;
  autoPickFreePort: boolean;
  openBrowserOnReady: boolean;
  metricsStrategy: MetricsStrategy;
  metricsMemoryLimit: number;
  logBufferLines: number;
  logToFile: boolean;
  githubMirror: string;
  githubToken: string;
  tunnelUseHttp2: boolean;
  showVirtualIps: boolean;
  projectsRootUser: string;
  projectsRootActive: string;
  projectOrder: string[];
  theme: 'dark' | 'light';
  locale: 'zh-CN' | 'en';
}

export type TunnelStatus = 'stopped' | 'starting' | 'probing' | 'running' | 'error';

export interface TunnelState {
  projectId: string;
  status: TunnelStatus;
  url: string | null;
  message?: string;
}

/* ------------------------------ 项目母栏（分组） ------------------------------ */

/** 母栏：只存归属；栏内顺序统一由 `config.projectOrder` 决定 */
export interface ProjectGroup {
  id: string;
  name: string;
  githubRepo: string;
  instanceIds: string[];
  lastSeenTag: string;
  lastCheckedAt: string;
  collapsed: boolean;
  createdAt: string;
}

export interface GroupedProjects {
  groups: Array<{
    id: string;
    name: string;
    githubRepo: string;
    lastSeenTag: string;
    lastCheckedAt: string;
    collapsed: boolean;
    projects: ProjectSummary[];
  }>;
  ungrouped: ProjectSummary[];
}

export interface ReleaseAssetOption {
  name: string;
  size: number;
  url: string;
  sourceArchive: boolean;
}

/** 某个 release 版本及其可下载资产（供用户任选一个版本安装） */
export interface ReleaseVersionOption {
  tag: string;
  name: string;
  publishedAt: string;
  auto: ReleaseAssetOption | null;
  options: ReleaseAssetOption[];
}

export interface GroupReleaseCheck {
  hasUpdate: boolean;
  firstCheck: boolean;
  latestTag: string;
  currentTag: string;
  releaseName: string;
  releaseBody: string;
  publishedAt: string;
  auto: ReleaseAssetOption | null;
  options: ReleaseAssetOption[];
  /** 全部版本（按版本号降序），用户可任选其一安装 */
  releases: ReleaseVersionOption[];
}

export interface GroupProgress {
  groupId: string;
  phase: 'fetching' | 'downloading' | 'extracting' | 'done' | 'error';
  percent: number;
  message?: string;
}

/** lan = 真实局域网；vpn = ZeroTier/Tailscale 等组网；virtual = 虚拟机/容器网卡 */
export type IpType = 'lan' | 'vpn' | 'virtual';

export interface NetworkInterface {
  iface: string;
  address: string;
  type: IpType;
}

export interface ProjectsRootInfo {
  user: string;
  active: string;
  defaultDir: string;
  currentDir: string;
  prevDir: string;
  changed: boolean;
  prevCount: number;
}

export interface RuntimeInfo {
  version: string;
  abi: string;
  nodePath: string;
  npmCliPath: string;
  corepackPath: string | null;
  dir: string;
  source: 'bundled' | 'downloaded';
}

export interface AppInfo {
  version: string;
  name: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  dataDir: string;
  projectsDir: string;
  isolation: { appId: string; dataDir: string; isolated: boolean; note: string };
}

export interface DepsPrompt {
  projectId: string;
  kind: 'preflight-missing' | 'runtime-missing-module' | 'runtime-native-abi';
  moduleName: string | null;
  message: string;
  detail: string;
  installLabel: string;
}

export interface DepsInstallResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  outputTail: string;
  cancelled: boolean;
  error?: string;
}

export const ERROR_CATEGORY_LABEL: Record<ErrorCategory, string> = {
  'missing-module': '缺少依赖模块',
  'missing-relative': '入口/路径问题',
  'native-abi': '原生模块 ABI 不匹配',
  'build-tool': '需要本机编译环境',
  syntax: '代码或模块格式问题',
  'port-in-use': '端口被占用',
  permission: '权限或文件占用',
  network: '网络不可达',
  'command-not-found': '找不到命令',
  unknown: '未识别的错误',
};

export const PHASE_LABEL: Record<LaunchPhase, string> = {
  idle: '未运行',
  preflight: '准备中',
  spawning: '启动中',
  starting: '等待就绪',
  ready: '运行中',
  stopping: '停止中',
  restarting: '重启中',
  failed: '启动失败',
};
