/**
 * 全局共享类型（主进程 / preload / 渲染进程共用）。
 * 任何跨进程的数据结构都在这里定义，避免各处各写一份。
 */

/* ============================ 枚举 ============================ */

/** 启动模式：node=直启入口文件；command=自定义命令行（走 shell） */
export type StartMode = 'node' | 'command';
/** 端口策略：inject=注入 PORT/HOST 并预检；display=只展示；none=不管理 */
export type PortMode = 'inject' | 'display' | 'none';
/** 项目来源 */
export type SourceKind = 'linked' | 'managed' | 'zip' | 'github' | 'git';
/** 依赖自动安装策略 */
export type AutoInstallDeps = 'ask' | 'always' | 'never';
/** 崩溃重启策略 */
export type RestartMode = 'never' | 'on-failure';
/** 性能采集策略 */
export type MetricsStrategy = 'auto' | 'reporter' | 'polling';
/** 包管理器 */
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export const PACKAGE_MANAGERS: PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

/** 日志类别 */
export type LogKind = 'sys' | 'out' | 'err' | 'dep';

/** 启动阶段 */
export type LaunchPhase =
  | 'idle'
  | 'preflight'
  | 'spawning'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'restarting'
  | 'failed';

/** 依赖状态 */
export type DepsState =
  | 'unknown'
  | 'na'
  | 'ready'
  | 'missing'
  | 'installing'
  | 'failed';

/** 启动失败分类（决定是否可自动安装依赖，见 PLAN §8.1） */
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

/* ============================ 项目清单 ============================ */

export interface RestartPolicy {
  mode: RestartMode;
  maxRetries: number;
  backoffMs: number;
}

export interface ProjectManifest {
  schema: 1;
  /** 严格白名单 ID：^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ */
  id: string;
  name: string;
  desc?: string;
  tags?: string[];

  source: SourceKind;
  /** managed/zip/github/git → 项目自有目录；linked → 用户原目录（绝对路径） */
  rootDir: string;
  /** 相对 rootDir 的工作目录（monorepo 子包），空=rootDir */
  cwd?: string;

  startMode: StartMode;
  /** node 模式：相对 cwd 的入口文件 */
  entry?: string;
  /** 运行时 Node 版本（如 "22"），空=默认运行时 */
  nodeVersion?: string;
  /** command 模式：整条命令行 */
  command?: string;

  /** 仅 node 模式有效；command 模式的参数写进 command */
  args?: string[];
  env?: Record<string, string>;
  /** 相对 cwd 的 .env 文件 */
  envFile?: string;

  portMode: PortMode;
  port?: number;
  host?: string;

  /** stdout/stderr 正则，命中即视为就绪 */
  readyPattern?: string;
  /** 支持 {PORT}/{HOST} 占位符；轮询 2xx/3xx 视为就绪 */
  healthUrl?: string;
  readyTimeoutMs?: number;

  autoInstallDeps: AutoInstallDeps;
  /** 是否允许依赖安装执行 postinstall 等脚本，默认 false */
  allowInstallScripts: boolean;

  restartPolicy: RestartPolicy;
  stopSignal?: 'SIGTERM' | 'SIGINT';
  stopTimeoutMs?: number;

  /** 同一项目是否只允许一个实例 */
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

/** 列表用：清单 + 运行时状态 */
export interface ProjectSummary extends ProjectManifest {
  running: boolean;
  phase: LaunchPhase;
  depsState: DepsState;
}

/* ============================ 全局配置 ============================ */

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface AppConfig {
  schema: 1;

  /* 运行时 */
  defaultNodeVersion: string;
  nodeDownloadMirror: string;
  npmRegistry: string;
  preferBundledRuntime: boolean;

  /* 依赖 */
  defaultAutoInstallDeps: AutoInstallDeps;
  defaultAllowInstallScripts: boolean;
  installTimeoutMs: number;

  /* 启动 */
  defaultPortMode: PortMode;
  defaultPort: number;
  autoPickFreePort: boolean;
  openBrowserOnReady: boolean;

  /* 观测 */
  metricsStrategy: MetricsStrategy;
  metricsMemoryLimit: number;
  logBufferLines: number;
  logToFile: boolean;

  /* 网络 */
  githubMirror: string;
  githubToken: string;
  tunnelUseHttp2: boolean;
  showVirtualIps: boolean;

  /* 数据目录（换目录后可把旧目录里的项目迁移过来，逻辑同旧启动器） */
  projectsRootUser: string;
  projectsRootActive: string;

  /* 界面：项目列表顺序（拖拽排序，存 id 数组） */
  projectOrder: string[];

  /* 界面 */
  theme: 'dark' | 'light';
  locale: 'zh-CN' | 'en';
  windowBounds?: WindowBounds;
}

/* ============================ 项目母栏（分组） ============================ */

/**
 * 母栏（分组）：界面组织信息，**不是**项目业务数据。
 * 只存「哪些实例属于我」，栏内顺序一律由 `config.projectOrder` 决定（单一顺序来源）。
 */
export interface ProjectGroup {
  /** 白名单格式 group_[a-z0-9]{4,32} */
  id: string;
  name: string;
  /** `owner/repo`；空串表示未绑定仓库 */
  githubRepo: string;
  /** 归属本母栏的实例 id（顺序无意义，见上方说明） */
  instanceIds: string[];
  /** 最近一次检查更新 / 安装看到的 release tag */
  lastSeenTag: string;
  lastCheckedAt: string;
  collapsed: boolean;
  createdAt: string;
}

export interface GroupsFile {
  schema: 1;
  groups: ProjectGroup[];
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
  /** 未分组：虚拟母栏，恒排在最后 */
  ungrouped: ProjectSummary[];
}

export interface ReleaseAssetOption {
  name: string;
  size: number;
  url: string;
  /** GitHub 自动生成的源码包（`Source code (zip)`） */
  sourceArchive: boolean;
}

/** 某个 release 版本及其可下载资产（供用户任选一个版本安装） */
export interface ReleaseVersionOption {
  tag: string;
  name: string;
  publishedAt: string;
  /** 能唯一确定资产时给出；多个候选为 null，由 UI 让用户选 */
  auto: ReleaseAssetOption | null;
  options: ReleaseAssetOption[];
}

export interface GroupReleaseCheck {
  hasUpdate: boolean;
  /** 首次检查（没有 lastSeenTag）：只记录，不谎报「有新版本」 */
  firstCheck: boolean;
  latestTag: string;
  currentTag: string;
  releaseName: string;
  releaseBody: string;
  publishedAt: string;
  /** 能唯一确定资产时给出；多个候选为 null，由 UI 让用户选 */
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

/* ============================ 本机网络 ============================ */

/** lan = 真实局域网；vpn = ZeroTier/Tailscale 等组网；virtual = 虚拟机/容器网卡 */
export type IpType = 'lan' | 'vpn' | 'virtual';

export interface NetworkInterface {
  /** 网卡名，如「以太网」「WLAN」 */
  iface: string;
  address: string;
  type: IpType;
}

/* ============================ 运行时 ============================ */

export interface RuntimeInfo {
  version: string;
  abi: string;
  nodePath: string;
  /** npm-cli.js 的绝对路径（用 node 直接调用，绝不走 .cmd） */
  npmCliPath: string;
  /** corepack 可执行文件（可能不存在） */
  corepackPath: string | null;
  /** 需要前置到子进程 PATH 的目录 */
  dir: string;
  source: 'bundled' | 'downloaded';
}

export interface RuntimeProgress {
  phase: 'checking' | 'downloading' | 'extracting' | 'verifying' | 'ready';
  percent: number;
  downloaded?: number;
  total?: number;
  message?: string;
}

/* ============================ 启动 ============================ */

export interface LaunchState {
  projectId: string;
  phase: LaunchPhase;
  pid: number | null;
  port: number | null;
  url: string | null;
  startedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  /** 失败分类；决定 UI 展示哪种诊断卡 */
  category: ErrorCategory | null;
  message: string;
  restarts: number;
  /** 本次启动是否已经自动尝试过安装依赖（防死循环） */
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

/* ============================ 依赖 ============================ */

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
  /** 安装输出累计行数，用于 UI 进度提示 */
  installLines: number;
}

/* ============================ 项目探测（编辑弹窗自动预填） ============================ */

export interface ProjectDetectResult {
  rootedAt: string;
  hasPackageJson: boolean;
  packageName: string | null;
  packageManager: PackageManager;
  lockfile: string | null;
  scripts: Record<string, string>;
  moduleType: 'module' | 'commonjs' | null;
  enginesNode: string | null;
  /** 探测到的入口候选（相对 cwd） */
  entryCandidates: string[];
  suggestedStartMode: StartMode;
  suggestedEntry: string | null;
  suggestedCommand: string | null;
  suggestedCwd: string;
  /** monorepo 子包候选（相对 rootDir） */
  workspaceCandidates: string[];
}

/* ============================ 日志与事件 ============================ */

export interface LogEntry {
  projectId: string | null;
  kind: LogKind;
  msg: string;
  timestamp: number;
}

/* ============================ 内网穿透 ============================ */

export type TunnelStatus = 'stopped' | 'starting' | 'probing' | 'running' | 'error';

export interface TunnelState {
  projectId: string;
  status: TunnelStatus;
  /** 公网地址，形如 https://xxxx.trycloudflare.com */
  url: string | null;
  message?: string;
}

/* ============================ 数据目录迁移 ============================ */

export interface ProjectsRootInfo {
  /** 用户配置的根目录（原始值，空 = 默认） */
  user: string;
  /** 上一次生效的根目录 */
  active: string;
  /** 默认根目录 */
  defaultDir: string;
  /** 当前实际使用的目录 */
  currentDir: string;
  /** 上一次生效的实际目录（迁移来源） */
  prevDir: string;
  /** 当前目录与旧目录不一致 → 存在待迁移数据 */
  changed: boolean;
  /** 旧目录里的项目数量 */
  prevCount: number;
}

/* ============================ 应用信息 ============================ */

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
  /** 与旧启动器隔离的自检结果 */
  isolation: {
    appId: string;
    dataDir: string;
    isolated: boolean;
    note: string;
  };
}
