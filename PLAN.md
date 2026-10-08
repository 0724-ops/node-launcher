# node launcher — 通用 Node 项目启动器 · 实施方案

- 文档版本：v1.0（已批准，实施中）
- 日期：2026-10-07
- 依据：对 `stronghold-launcher/` 全量通读 + 本机实测（Node/Electron ABI、打包产物、工具链）
- 状态：M0–M4 已实施并通过校验；详见 §14 实施记录。

---

## 1. 目标与非目标

### 1.1 目标

做一个独立的跨平台桌面启动器，用一个窗口完成任意本地 Node 项目（以及任意非 Node 程序）的
**接入 → 配置 → 依赖准备 → 启动 → 观测 → 停止 → 排障** 闭环：

- 不要求用户预装 Node.js / npm（运行时由启动器提供）。
- 项目来源：引用本机已有目录（不复制）、复制导入目录、导入 zip、从 GitHub Release 安装、git clone（M6）。
- 每个项目独立配置：启动模式、工作目录、参数、环境变量、端口策略、就绪判定、崩溃重启、依赖策略。
- 运行可观测：实时日志（可落盘/搜索/导出）、CPU/内存（进程树聚合）、真实监听端口、健康状态。
- 缺依赖可自助恢复：启动前确定性预检 + 启动失败精确识别 + 一键安装（默认先询问、默认不跑安装脚本）。

### 1.2 非目标（明确不做）

- 不做云部署、容器编排、集群/多机守护。
- 不做账号体系、插件市场、在线共享。
- 不做「任意语言运行时管理」：除 Node 外，其他语言交给「自定义命令」由用户自己保证环境。
- 不修改用户全局环境（不写系统 PATH、不写注册表、不装全局包）。

### 1.3 与旧工程的关系

`stronghold-launcher/` 只作为**只读参考资料**保留，不继承其代码、包名、数据目录与用户数据。
新项目是全新工程，版本从 **0.0.1** 开始，**不做任何旧数据迁移**。

---

## 2. 已确认决策

| 编号 | 决策项 | 结论 |
| --- | --- | --- |
| D1 | 项目目录 | 新工程位于工作区根 `node-launcher/`；`stronghold-launcher/` 保持不动，仅作参考（备选：放 `app/` 子目录，见 §13） |
| D2 | Node 运行时 | **混合**：随包内置优先，缺失时按需下载到用户数据目录 |
| D3 | 依赖自动安装 | **先询问**；安装默认 `--ignore-scripts`；需要原生编译时用户显式勾选 |
| D4 | 版本与兼容 | 独立项目，从 0.0.1 起；无历史数据迁移 |
| D5 | 启动模式 | 两种：`node`（直启入口文件）与 `command`（自定义命令行）；**不新增第三种模式**，用「从 package.json 选择脚本」下拉覆盖 `npm run xxx` 场景 |

### 2.1 关键实测事实（决定 D2 的技术前提）

| 事实 | 数据 | 影响 |
| --- | --- | --- |
| 旧工程运行时是 Electron 自身 | `spawn(process.execPath)` + `ELECTRON_RUN_AS_NODE=1` | 无 npm 可用 |
| Electron 36.9.5 内置 Node | **v22.19.0，NODE_MODULE_VERSION=135** | 与真 Node ABI 不一致 |
| 真 Node v22.23.3 | **NODE_MODULE_VERSION=127** | npm 装出的原生模块（`sqlite3`/`sharp`/`bcrypt` 等）在 Electron-as-node 下必然报 ABI 不匹配 |
| 旧工程打包白名单 | 仅 `dist-electron/`、`dist/`、`package.json` | 仓库里的 `.tools/node22` 是开发缓存，**不进安装包** |
| 本机无全局 Node/npm | `Get-Command node` 失败 | 新工程的开发工具链需自带（见 §3.3） |

> 结论：新工程的**运行进程用真 Node**（不是 Electron-as-node），Electron 只做主进程/界面。
> 这同时解决了「原生模块 ABI」和「没有 npm」两个问题。

---

## 3. 技术栈与工程骨架

### 3.1 技术栈（沿用旧工程已验证的组合，降低风险）

Electron 36 + TypeScript 5.7 + Vue 3.5 + Vite 6 + electron-builder 25；新增 **vitest**（单测）、
**electron-updater**（启动器自更新，旧工程只在依赖里躺着没接线）。

不引入 zod 等运行时校验库：清单字段少，手写校验 + 单测更可控。

### 3.2 目录结构（新工程，工作区根）

```
node-launcher/
├── package.json                 # name: node-launcher, version: 0.0.1
├── tsconfig.json / tsconfig.node.json
├── vite.config.ts
├── electron-builder.yml
├── index.html
├── PLAN.md                      # 本文件
├── .gitignore                   # 忽略 .tools/ dist/ dist-electron/ release/ node_modules/
├── build/                       # 图标等 buildResources
├── resources/                   # 内置资源（留空则运行时改为下载）
│   └── runtimes/                # 可选：随包内置的 Node（见 §5）
├── scripts/
│   ├── setup-toolchain.ps1      # 开发机拉取 Node（本机无全局 node）
│   └── fetch-node.mjs           # 供 §5 复用的下载/校验逻辑原型
├── electron/
│   ├── main.ts                  # 生命周期、窗口、单实例锁
│   ├── preload.ts               # contextBridge（窄接口）
│   ├── ipc/
│   │   ├── index.ts             # 注册入口
│   │   ├── project.ts           # 项目 CRUD / 导入 / 目录选择
│   │   ├── launch.ts            # 启动/停止/状态/端口
│   │   ├── deps.ts              # 依赖检查/安装/取消
│   │   ├── runtime.ts           # 运行时与包管理器信息/下载进度
│   │   └── tools.ts             # 打开目录/外链/日志导出
│   ├── core/
│   │   ├── store/
│   │   │   ├── config-store.ts      # 全局配置（含 schema 版本与逐版本迁移）
│   │   │   └── project-store.ts     # 清单读写、原子写、扫描
│   │   ├── runtime/
│   │   │   ├── node-provider.ts     # ensureRuntime()：内置→缓存→下载
│   │   │   ├── package-manager.ts    # lockfile/packageManager 探测与调用
│   │   │   └── registry.ts          # npm registry / node 镜像 / GitHub 镜像
│   │   ├── launch/
│   │   │   ├── launch-pipeline.ts   # 状态机（预检→spawn→就绪→结束）
│   │   │   ├── spawn-plan.ts        # 纯函数：清单 → 命令行/env/cwd/shell
│   │   │   ├── placeholders.ts      # {PORT} {HOST} {CWD} {ENTRY} {NODE}
│   │   │   ├── readiness.ts         # readyPattern / healthUrl / 真实端口探测
│   │   │   ├── metrics.ts           # reporter 注入 + 进程树轮询
│   │   │   └── process-tree.ts      # 进程树枚举与杀树
│   │   ├── deps/
│   │   │   ├── precheck.ts          # 确定性预检（package.json / node_modules / lockfile）
│   │   │   ├── classify-error.ts    # 纯函数：日志 → 错误类别 → 建议动作
│   │   │   └── installer.ts         # 安装执行、进度、取消、互斥
│   │   ├── sources/                 # M6：GitHub repo / zip URL / git clone
│   │   ├── download/                # 重写后的下载器（超时/重定向/校验/断点）
│   │   ├── archive/                 # 解压（zip-slip、符号链接、单层提升）
│   │   ├── tunnel/                  # cloudflared（沿用旧逻辑，改为通用目标端口）
│   │   ├── net/                     # 网卡枚举、端口工具
│   │   └── log/                     # 日志缓冲（上限）+ 落盘 + 导出 + 脱敏
│   ├── reporter/metrics-reporter.cjs # 注入到被测 Node 进程
│   └── types/                       # 共享类型（manifest/config/事件）
└── src/
    ├── main.ts
    ├── App.vue
    ├── components/                  # ProjectList / DetailCard / LogPanel / MetricsPanel
    │   ├── modals/EditProject.vue   # ★ 需求 A 的主战场
    │   ├── modals/DepsDialog.vue    # ★ 需求 B 的主战场
    │   └── modals/Settings.vue
    └── composables/                 # useProjects / useLaunch / useLogs / useDeps
```

### 3.3 开发工具链（本机无全局 Node）

- `scripts/setup-toolchain.ps1`：检测 `.tools/node/`，缺失则从镜像下载 Node 22 LTS 解压（可离线复用
  现有 `stronghold-launcher/.tools/node22/`，或复制一份到新工程 `.tools/`，`.tools/` 进 `.gitignore`）。
- 所有 npm 脚本通过 `node.exe` 绝对路径调用，避免依赖 PATH。

---

## 4. 数据模型

### 4.1 目录布局（用户数据目录 = `%APPDATA%/node-launcher`）

```
config.json                     # 全局配置
projects/<id>/manifest.json     # 每个项目一份清单（项目本体不放在这里，见 rootDir）
projects/<id>/.launcher/        # 安装日志、上次启动快照（不进项目目录）
runtimes/node-<ver>-<platform>-<arch>/   # 按需下载的 Node
runtimes/index.json             # 已就绪运行时登记（版本、ABI、来源、校验和）
bin/cloudflared(.exe)
downloads/                      # 临时下载
logs/<projectId>/<timestamp>.log
```

### 4.2 ProjectManifest v1

```ts
type SourceKind = 'linked' | 'managed' | 'github' | 'zip' | 'git';
type StartMode  = 'node' | 'command';
type PortMode   = 'inject' | 'display' | 'none';   // inject=注入并预检; display=只展示不注入; none=不管理

interface ProjectManifest {
  schema: 1;
  id: string;                 // ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$  严格白名单
  name: string;
  desc?: string;
  tags?: string[];

  source: SourceKind;
  rootDir: string;            // managed/zip/github → projects/<id>/src；linked → 用户原目录（绝对路径）
  cwd?: string;               // 相对 rootDir 的工作目录（monorepo 子包）

  startMode: StartMode;
  entry?: string;             // node 模式：相对 cwd 的入口文件
  nodeVersion?: string;       // 形如 "22" / "22.23.3"，空=默认运行时
  command?: string;           // command 模式：整条命令行

  args?: string[];            // 仅 node 模式；command 模式的参数写进 command
  env?: Record<string, string>;
  envFile?: string;           // 相对 cwd 的 .env，先加载再被 env 覆盖

  portMode: PortMode;
  port?: number;              // portMode != none 时有效
  host?: string;              // 默认 0.0.0.0；portMode=inject 时注入 HOST

  readyPattern?: string;      // stdout/stderr 正则（命中=就绪）
  healthUrl?: string;         // 支持 {PORT}/{HOST}；轮询 2xx/3xx=就绪
  readyTimeoutMs?: number;    // 默认 60000

  autoInstallDeps: 'ask' | 'always' | 'never';   // 默认 'ask'
  allowInstallScripts: boolean;                  // 默认 false → --ignore-scripts

  restartPolicy: { mode: 'never' | 'on-failure'; maxRetries: number; backoffMs: number };
  stopSignal?: 'SIGTERM' | 'SIGINT';
  stopTimeoutMs?: number;                        // 默认 8000

  singleton: boolean;         // 同项目是否只允许一个实例
  createdAt: string;
  lastStartedAt?: string | null;
  lastExit?: { code: number | null; signal: string | null; at: string; category?: string };
}
```

兼容性说明：本工程无历史数据，仍需**读取时容错**（未知字段保留、缺失字段用默认值、非法清单隔离到
「损坏」分组而不是静默丢弃），避免用户手改清单后整个列表消失。

### 4.3 AppConfig v1

```ts
interface AppConfig {
  schema: 1;
  // 运行时
  defaultNodeVersion: string;        // 默认 "22"
  nodeDownloadMirror: string;        // 默认 https://npmmirror.com/mirrors/node/
  npmRegistry: string;               // 默认 https://registry.npmmirror.com
  preferBundledRuntime: boolean;     // true
  // 依赖
  defaultAutoInstallDeps: 'ask' | 'always' | 'never';
  defaultAllowInstallScripts: boolean;   // false
  installTimeoutMs: number;              // 默认 600000
  // 启动
  defaultPortMode: PortMode;             // inject
  autoPickFreePort: boolean;             // true
  openBrowserOnReady: boolean;           // false（旧工程"不自动开浏览器"的理念保留为默认关）
  // 观测
  metricsStrategy: 'auto' | 'reporter' | 'polling';
  logBufferLines: number;                // 默认 5000
  logToFile: boolean;                    // true
  // 网络
  githubMirror: string;
  githubToken: string;
  tunnelUseHttp2: boolean;
  showVirtualIps: boolean;
  // 界面
  theme: 'dark' | 'light';
  locale: 'zh-CN' | 'en';
  windowBounds?: { x: number; y: number; width: number; height: number; maximized: boolean };
}
```

---

## 5. 运行时与包管理器供给

### 5.1 NodeRuntimeProvider

```ts
interface ResolvedRuntime {
  version: string;          // 22.23.3
  abi: string;              // 127
  nodePath: string;         // .../node.exe
  npmCliPath: string;       // .../lib/node_modules/npm/bin/npm-cli.js
  dir: string;              // 加入子进程 PATH 的目录
  source: 'bundled' | 'downloaded';
}
ensureRuntime(spec?: string, onProgress?: (p: Progress) => void): Promise<ResolvedRuntime>
```

解析顺序：
1. `resources/runtimes/node-<ver>-<platform>-<arch>/`（随包内置，D2 首选）
2. `userData/runtimes/...` 缓存（校验 `node -v` 与 ABI 与 `index.json` 一致，不一致视为损坏并重下）
3. 下载：`nodeDownloadMirror` + `v<ver>/node-v<ver>-<platform>-<arch>.zip|tar.xz`，校验 SHA-256，
   解压到临时目录后原子重命名；下载复用 §9 的重写下载器（超时/重定向上限/进度/取消）。

平台矩阵：win-x64、linux-x64、darwin-x64、darwin-arm64（win-arm64 视需要）。

### 5.2 包管理器探测与调用

优先级：`packageManager` 字段 → lockfile → 默认 npm。

| 探测到 | 使用 | 调用方式 |
| --- | --- | --- |
| `package-lock.json` / 无 | npm | `node <runtime>/npm-cli.js …` |
| `pnpm-lock.yaml` / `pnpm@x` | pnpm | `corepack pnpm …`（corepack 随 Node 22 附带） |
| `yarn.lock` / `yarn@x` | yarn | `corepack yarn …` |
| `bun.lockb` | bun | 需用户自备 bun；未找到则提示并回退 npm |

**统一不经过 `.cmd`/`.bat`**：Windows 上 `spawn('npm.cmd')`（无 shell）自 CVE-2024-27980 起会 EINVAL，
因此一律用 `node.exe + <cli.js>` 或 `corepack.cmd` 经 shell 调用，并在实现里单测覆盖。

环境注入策略：子进程 `PATH` 前置 `runtime.dir`，使项目内 `node`/`npm`/`npx` 直接可用；不写系统 PATH。

---

## 6. 启动流水线

### 6.1 状态机

```
idle → preflight → spawning → starting → ready → stopping → idle
                        ↘ failed(category) ↗        ↘ restarting（策略允许时）
```

对外事件：`launch:state`、`log:entry`、`metrics`、`port:detected`、`deps:state`。
IPC 只暴露 `start/stop/status`，状态变化一律由事件推送（旧工程 `server:start` 里顺手挂监听的做法不再沿用）。

### 6.2 spawn 规则（两模式对照）

| | node 模式 | command 模式 |
| --- | --- | --- |
| 可执行文件 | `<runtime>/node(.exe)` | Windows `cmd.exe /d /s /c "<命令>"`；POSIX `/bin/sh -c "<命令>"` |
| 参数 | `[entry, ...args]`（逐个传，**无 shell**） | 整条命令行交给 shell，**不再追加 args** |
| shell | `false` | `true`（由 shell 负责引号/管道/`&&`） |
| `ELECTRON_RUN_AS_NODE` | 不注入（用真 Node，无需该变量） | **必须从继承环境中删除** |
| `PATH` | 前置 `runtime.dir` | 同左（让 `npm start`/`node x.js` 用我们的运行时） |
| 占位符 | `args` + `entry` | 整条 `command` |
| 指标 | reporter 注入（`NODE_OPTIONS=--require`）+ 进程树兜底 | 优先 reporter（Node 子进程会继承 `NODE_OPTIONS`）；否则进程树轮询 |

通用：`cwd = resolve(rootDir, cwd ?? '.')`；`windowsHide: true`；`detached: true`（POSIX，便于杀整组）；
`stdio` 按是否用 reporter 决定是否加 `ipc`。

### 6.3 端口策略

- `inject`：预检 `isPortAvailable`（仅作提示，**不作为唯一判据**）+ 占用时按 `autoPickFreePort` 自动改端口；
  注入 `PORT`/`HOST`；`{PORT}` 占位符生效。
- `display`：不注入、不预检，仅用于拼接「打开地址」；真实端口来自就绪探测。
- `none`：不涉及端口，界面隐藏地址区（适合非网络程序、CLI 工具）。

真实端口探测顺序：`healthUrl` → 子进程监听端口扫描（`netstat`/`lsof` 等价实现，Windows 用
`GetExtendedTcpTable` 或 `netstat -ano` 解析 → 匹配进程树）→ `readyPattern` 捕获组（如 `:(\d+)`）。

### 6.4 指标

- 优先：`NODE_OPTIONS=--require <reporter.cjs>`，3s 上报（沿用旧工程方案，但改为在真 Node 上运行）。
- 兜底：对 **进程树所有 PID** 轮询 `pidusage`（数组入参）求和，2s 间隔，连续 3 次失败熔断。
- 必须聚合子进程：`npm start` 的真实服务是孙子进程，只 poll 根 PID 会得到错误数据。

### 6.5 停止与重启

- 优雅：`SIGTERM`/`SIGINT` → 等 `stopTimeoutMs` → 强制杀树（Windows `taskkill /T /F`；POSIX `kill(-pgid)`）。
- 重启：仅 `on-failure` 且非用户主动停止时触发，指数退避、`maxRetries` 上限，`failed` 后不再自动重试。
- 应用退出：`before-quit` 统一停所有实例（先优雅后强制），保证不留孤儿。

---

## 7. 需求 A：编辑弹窗增加「启动模式」

### 7.1 交互设计

「编辑项目」弹窗顶部加分段控件：

```
[ Node 直启 ]  [ 自定义命令 ]
```

- **Node 直启**：入口文件（带「自动探测」按钮 + 文件选择器）、Node 版本、附加参数。
- **自定义命令**：单行/多行命令行输入框；右侧「从 package.json 选脚本」下拉
  （读出 `scripts.*`，选中即填入 `npm run <script>` / `pnpm <script>` / `yarn <script>`，按 §5.2 判定）；
  下方显示实际将执行的 shell 与提示「支持管道、&&、环境变量；不经过 node 参数校验」。
- 两模式共用：工作目录（相对项目根，带目录选择）、环境变量、端口策略、就绪判定、重启策略。
- 底部固定一行**预览**：`将执行：… | cwd=… | shell=是/否 | PORT=…`
- 打开弹窗时自动预填：`startMode`（有 `scripts.start` 且有 lockfile → command + `npm start`，否则 node）、
  `entry`（`scripts.start` 里的 `node <file>` → `<file>`；否则 `pkg.main`；否则 `server.js/index.js/app.js/main.js`）、
  `cwd`（检测 monorepo 子包）、端口策略默认值。
- 切换模式时清空并隐藏无关字段（保存时也清掉），避免清单里留下互相矛盾的配置。

### 7.2 校验与安全

- `command` 非空、长度 ≤ 2000、不含 NUL。
- `entry` 必须解析到 `rootDir` 内（`path.resolve` 后做包含判断），拒绝 `..` 逃逸。
- 首词 ENOENT 时给出可操作提示：「找不到命令 `x`：检查 PATH，或改用 Node 直启」。
- **信任边界**：`command` 只接受用户在 UI 中的输入；来自 zip/GitHub 清单里的 `command` 不静默生效
  （导入时置空并标记「需确认」）。自定义命令的项目在列表/详情页显示醒目标记，启动日志必须打印真实命令行。
- 不再需要「恢复默认」以外的隐藏魔法；`/`、`&&`、引号等一律按所选 shell 的真实语义执行（不做事后解析）。

### 7.3 验收标准

1. 新建/导入一个普通 Node 项目，打开编辑弹窗时 `entry`/`command` 已被正确预填。
2. 用 Node 直启跑通一个有 `server.js` 的项目；用自定义命令跑通 `npm run dev`（含 `&&` 与管道）。
3. `{PORT}` 在两模式下都能正确替换；`command` 模式下 `args` 字段不可见且保存后清单中不存在。
4. 命令写错（如 `npxx start`）时界面给出明确错误，不出现无信息的 `spawn EINVAL`/`ENOENT`。
5. 单测覆盖：`spawn-plan`（两模式 × 有无 shell × 占位符）、`placeholders`、`detectStartConfig`。

---

## 8. 需求 B：缺依赖的自动安装

### 8.1 两级触发（不做"只靠猜"）

**第一级 · 启动前确定性预检**（`deps/precheck.ts`）：

| 条件 | 结论 | UI |
| --- | --- | --- |
| 无 `package.json` | 非 Node 项目 | 不提示依赖，直接启动 |
| 有 `package.json` + `node_modules` 存在且非空 | 已就绪 | 直接启动，详情页显示依赖状态 |
| 有 `package.json` + 无/空 `node_modules` | 缺依赖 | 弹确认：「该项目尚未安装依赖」→[安装依赖并启动] [直接启动] [取消]（记住本次选择，不重复打扰） |

**第二级 · 运行后精确识别**（`deps/classify-error.ts`，纯函数、可单测）：

仅在**进程退出码 ≠ 0**，或**超过 `readyTimeoutMs` 未就绪且进程已退出**时判定——绝不对仍在运行
进程的第一条 stderr 反应（热重载服务会打印无害警告）。

| 类别 | 匹配（示例正则） | 动作 | 用户文案 |
| --- | --- | --- | --- |
| `missing-module` | `Cannot find module '([^']+)'`、`Cannot find package '([^']+)'`、`ERR_MODULE_NOT_FOUND` | **可安装** | 「缺少依赖 `x`，是否安装？」 |
| `missing-relative` | 上述但目标以 `./ ../ /` 或 `node:` 开头，或等于自身包名 | 不可安装 | 「入口/路径问题，不是缺依赖」 |
| `native-abi` | `NODE_MODULE_VERSION`、`wasm`、`invalid ELF`、`.node` 加载失败 | 不可安装 | 「原生模块与运行时 ABI 不匹配 → 用内置 Node 重装依赖」 |
| `build-tool` | `node-gyp`、`gyp ERR!`、`MSBuild`、`python` 缺失 | 不可安装 | 「需要本机编译环境」+ 文档链接 |
| `syntax` / `config` | `SyntaxError`、`ERR_INVALID_ARG_TYPE`、缺环境变量 | 不可安装 | 回显关键行 |
| `port-in-use` | `EADDRINUSE` | 不可安装 | 「端口被占用」+[换端口重试] |
| `permission` | `EACCES`、`EPERM`、`EBUSY` | 不可安装 | 「无写权限/文件被占用」 |
| `network` | `ENOTFOUND`、`ETIMEDOUT`、`ECONNREFUSED` | 不可安装 | 「网络不可达，检查代理/镜像」 |

循环保护：**一次启动最多自动安装一次**；第二次仍以同样特征失败 → 进入 `failed(diagnostic)`，
展示诊断卡（原始日志高亮 + 已尝试动作 + 建议），不再重试。

### 8.2 安装执行（`deps/installer.ts`）

- 命令：
  - 有 lockfile → `npm ci`（失败回退 `npm install`）；无 lockfile → `npm install`。
  - 包管理器按 §5.2；registry 取 `config.npmRegistry`；附加 `--no-audit --no-fund`。
  - **默认追加 `--ignore-scripts`**（D3）；仅当项目清单 `allowInstallScripts=true` 时去掉。
- 进程：`node.exe <npm-cli.js> …`，`cwd = rootDir/cwd`，`PATH` 前置 runtime；不使用 shell。
- 观测：stdout/stderr 全量进日志面板（另存 `projects/<id>/.launcher/install-<ts>.log`）；
  超时 `installTimeoutMs`；可取消（杀进程树）；**全局互斥**——安装期间禁止启动/开穿透。
- 磁盘与权限前置检查：可用空间 < 500MB、目录不可写、网络盘 → 提前给出明确错误。

### 8.3 安全策略（重点）

- 版本内容常来自 GitHub 压缩包或他人整合包 = **不可信输入**；`postinstall` 等于任意代码执行。
- 因此：首次对某项目安装时给一次性确认弹窗，明确写「将执行该项目的安装脚本」；默认**不执行**安装脚本；
  勾选「允许执行安装脚本（用于原生模块编译）」才去掉 `--ignore-scripts`，该选择按项目记忆并在详情页可见可改。
- 安装脚本被跳过导致后续失败（native-abi）时，诊断卡直接给出「允许安装脚本后重装」的一键动作。
- 对 `source=linked`（引用用户自己的仓库）的项目，写入 `node_modules` 视为**修改用户仓库**，必须显式同意。

### 8.4 状态与手动入口

- 状态机：`unknown → ready | missing → installing(progress) → ready | failed`，与启动状态机解耦但联动。
- 详情页常驻「依赖」区块：`package.json` 有/无、包管理器、lockfile、`node_modules` 体积与文件数、
  上次安装时间、[安装] [重装] [清理 node_modules] 按钮。
- 自动逻辑只是便利，能力不藏在自动逻辑里——任何自动行为都能手动重放、也能关闭（`autoInstallDeps`）。

### 8.5 验收标准

1. fixture `missing-dep`（`require('express')` 但未安装）：Node 直启 → 识别 → 询问 → 安装 → 自动重试成功。
2. fixture `relative-import-missing`：确认**不会**触发安装，而是提示路径问题。
3. fixture `native-abi`：装完仍失败时给出 ABI 提示，且**不进入第二次安装循环**。
4. 缺 `package.json` 的项目（纯脚本目录）不出现任何依赖提示。
5. 取消安装能杀掉 npm 及其子进程（任务管理器无残留）；安装中启动/穿透按钮禁用。
6. 默认 `--ignore-scripts`：对带 `postinstall` 的 fixture，标记文件不生成；勾选允许后生成。
7. 单测覆盖 `classify-error` 的每条规则与负例（确保不误装）。

---

## 9. 安全与健壮性基线

必须在新工程一开始就做到（旧工程的这些问题不再复制）：

1. **路径穿越**：一切由外部数据推导的路径（项目 `id`、release tag、zip 内条目）都必须白名单化 +
   `path.resolve` 后校验位于允许根目录内。
2. **命令执行**：node 模式无 shell；command 模式显式 shell 且仅来自用户输入（§7.2）。
3. **下载器**：强制 https（或显式允许的镜像）、重定向次数上限、连接/总时长超时、`content-length` 校验、
   可选 SHA-256 校验、失败清理半成品（旧下载器这三项都缺）。
4. **解压**：拒绝绝对路径与 `..`（zip-slip）、拒绝符号链接外指、限制单文件与总大小。
5. **外链**：`openExternal` 仅允许 `http/https` 协议。
6. **日志脱敏**：`*TOKEN*`、`*SECRET*`、`*KEY*`、`PASSWORD` 等字段值打码后再入面板与文件。
7. **清单/配置写入**：临时文件 + 原子 rename，避免断电产生半截 JSON；损坏清单隔离不静默丢弃。
8. **单实例**：`app.requestSingleInstanceLock()`，第二次启动聚焦已有窗口。

---

## 10. 里程碑与验收

| 里程碑 | 交付物 | 验收 |
| --- | --- | --- |
| **M0** 骨架 | 工程脚手架、配置/清单存储、IPC 骨架、日志面板可跑、vitest 通路 | `build:electron` + `vue-tsc` + `vitest` 全绿；能空跑打开窗口 |
| **M1** 运行时供给（D2） | `node-provider`、`package-manager`、`registry`、下载器重写、设置项 | 无网络（内置）与有网络（下载）两条路径都能拿到可用真 Node；`node -v`/ABI 校验通过 |
| **M2** 接入 + 启动流水线 | 引用/复制/zip 导入、清单 v1、状态机、就绪探测、停止/杀树、日志落盘 | 3 个 fixture（正常/启动慢/启动即崩）状态与日志正确；无孤儿进程 |
| **M3** 需求 A | 编辑弹窗启动模式、自动预填、脚本下拉、预览、校验 | §7.3 全部通过 |
| **M4** 需求 B | 预检、错误分类、安装器、依赖区块、安全默认 | §8.5 全部通过 |
| **M5** 运行态体验 | 进程树指标、真实端口、打开地址/浏览器、崩溃重启、多实例 | 多实例并行互不干扰；崩溃退避重启次数正确 |
| **M6** 通用化外围 | 多来源（GitHub repo/zip URL/git clone）、托盘/通知/开机自启、i18n、自更新接线、CI | 至少两条不同来源安装成功；`electron-updater` 真接线并有拒绝降级 |

每个里程碑结束时：跑 `build:electron` + `vue-tsc --noEmit` + `vitest`，并做一次手工冒烟（记录在
`docs/smoke.md`）。改动合并前由我做一次完整 diff 复核（本工程不使用并行写同一文件的协作方式）。

---

## 11. 测试策略

- **纯函数单测（vitest）**：`spawn-plan`、`placeholders`、`classify-error`、`detectStartConfig`、
  清单校验、路径包含判断、lockfile 探测、就绪探测解析、日志脱敏。
- **主进程集成测试**：用 `fixtures/` 下的假项目（正常/缺依赖/相对导入缺失/原生 ABI/启动慢/崩溃/占端口）
  驱动启动流水线，断言状态序列与最终类别；不启动 Electron 窗口。
- **手工验收**：界面交互、托盘、通知、三平台打包；写成清单逐条勾。
- **不引入**：UI 快照测试（收益低，维护贵）。

---

## 12. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 内置 Node 让安装包变大（约 +30MB 压缩/+80MB 解压/平台） | 分发成本 | 首版只内置 win-x64；其他平台走按需下载；设置里可切换「优先内置/优先下载」 |
| corepack 在 Node 25 起被移除 | pnpm/yarn 调用方式失效 | 锁 Node 22 LTS；`package-manager` 抽象成可替换实现，预留"下载独立 pnpm 二进制"分支 |
| 缺依赖形态识别不全 | 自动安装不触发或误触发 | 分类表 + 明确"不做自动"的类别；提供手动安装入口兜底；单测覆盖负例 |
| 自定义命令不可控（用户自己写错） | 体验问题 | 预览 + 首词校验 + 明确错误文案 + 日志打印真实命令行 |
| 本机无全局 Node | 开发受阻 | §3.3 工具链脚本 + `.tools/`（gitignore） |
| 三平台打包/运行时资源 | 工作量 | M1 先 win-x64，mac/linux 在 M6 统一处理 |

---

## 13. 待你确认

1. **D1 目录**：确认新工程直接放工作区根 `node-launcher/`（`stronghold-launcher/` 仅作参考），
   还是放到 `app/` 子目录？（影响本文件所有路径）
2. **产品标识**：`name=node-launcher`、`productName=Node Launcher`、`appId=com.nodelauncher.desktop`
   是否可用？（appId 一旦发布不好改）
3. **平台范围**：首版是否只做 Windows？决定 M1 内置运行时的体积与下载逻辑要覆盖几个平台。
4. **仓库**：是否需要我初始化 git 仓库并写 `.gitignore` / 首个 commit？（当前工作区不是 git 仓库）
5. **GPL-3.0 或其它许可证**：旧工程是 GPL-3.0，新工程是否沿用？

确认后我把本文件转成 v1.0 基线，并按 M0 → M1 开始实施。

---

## 14. 实施记录（2026-10-07）

### 14.1 已确认的决策（本轮用户答复）

| 编号 | 结论 |
| --- | --- |
| D1 | 新工程位于工作区根；`stronghold-launcher/` 仅作只读参考 |
| D2 | 混合：内置优先 + 按需下载（首版只做 Windows x64，`resources/runtimes/` 暂空 → 实际走下载） |
| D3 | 先询问 + 默认 `--ignore-scripts` |
| D4 | 独立项目，0.0.1，无历史数据迁移 |
| D6 | **与旧专用启动器共存隔离**：独立 appId / 数据目录 / 安装目录 / 快捷方式 / 单实例锁 |

### 14.2 已完成（M0–M4 + M5 部分）

| 里程碑 | 状态 | 落点 |
| --- | --- | --- |
| M0 骨架 | ✅ | `package.json` / `tsconfig*` / `vite.config.ts` / `vitest.config.ts` / `electron-builder.yml` / `scripts/setup-toolchain.ps1` |
| M0 存储层 | ✅ | `core/store/{config-store,project-store,manifest}.ts`（原子写、容错归一化、保存前校验） |
| M0 主进程 | ✅ | `main.ts`（钉死 userData、单实例锁、退出收尾）、`preload.ts`（窄接口）、`ipc/index.ts` |
| M1 运行时 | ✅ | `core/runtime/node-provider.ts`（内置→缓存→下载 + `node -p` 校验 ABI）、`core/download/downloader.ts`（https 强制/重定向上限/超时/sha256）、`core/runtime/package-manager.ts` |
| M2 流水线 | ✅ | `core/launch/{launch-manager,spawn-plan,readiness,metrics,process-tree,placeholders,metrics-reporter}`、`core/net/ports.ts` |
| M3 启动模式 | ✅ | `src/components/EditProjectModal.vue`（分段控件 + 脚本下拉 + 自动预填 + 实时预览 + 交叉校验） |
| M4 依赖 | ✅ | `core/deps/{precheck,classify-error,installer}.ts`、`src/components/DepsPromptModal.vue`、依赖区块 |
| M5 运行态 | ✅ | 进程树指标 / 真实端口探测 / 就绪判定 / 日志落盘与导出 / 崩溃重启 / 打开浏览器 / 多实例（每项目一实例） |
| M6 外围 | ❌（按需） | GitHub/git 来源、托盘、通知、开机自启、i18n、自更新接线 |
| 交付物 | ✅ | `npm run build:win` 产出 `release/Node Launcher Setup 0.0.1.exe` |

### 14.3 验证证据

- `tsc -p tsconfig.node.json` → **exit 0**；`vue-tsc --noEmit` → **exit 0**；
  `vite build` → 20 modules，`dist/` 产物正常。
- `vitest run` → **exit 0，8 个文件 92 个用例全部通过**：清单归一化/校验、路径穿越拦截、脱敏、
  spawn 计划（两模式 × 占位符 × PATH/环境注入）、错误分类 18 例（含全部「不误装」负例）、
  包管理器与安装命令构造、依赖预检、进程树与端口解析、运行时候选目录名解析、
  **启动流水线状态机 7 例**（假 spawn 驱动：预检询问 / 安装后继续 / 运行期缺包仅重试一次 /
  相对路径不误装 / never 策略 / 停止 / 自定义命令）、
  **项目接入 11 例**（引用不复制源码、复制导入排除 node_modules 与 .git、monorepo 子包、
  `cwd` 解析、zip 导入与单层提升、模式切换清理字段、引用项目删除不碰用户目录、损坏清单容错、配置存储）。
  连跑两轮均为 92/92 通过（修掉了测试并行共用临时目录导致的偶发失败，见 14.5）。
- 端到端（`NL_E2E=1`，真实子进程）：链接真实项目 → 运行时解析（真 Node、ABI 校验）→ 真实 spawn →
  就绪探测 → `fetch` 探活返回 `ok` → 停止后端口不再响应。**通过**。
- **打包链路**：`electron-builder --win` → exit 0，产出 `release/Node Launcher Setup 0.0.1.exe`（82.4 MB）。
  产物内部核对：
  - `resources/app.asar` 2.66 MB，含 `fs-extra` / `extract-zip` / `pidusage` / `electron-updater`
    （生产依赖已打包），**不含** `node_modules/electron` 等开发依赖；
  - `resources/app.asar.unpacked/dist-electron/core/launch/metrics-reporter.js` 存在 → `asarUnpack` 生效；
  - `resources/runtimes/` 随包携带 → `extraResources` 生效；
  - `Node Launcher.exe` 元数据 `ProductName=Node Launcher`、`FileVersion=0.0.1`。
- **共存隔离核对**：`appId` 为 `com.nodelauncher.desktop`（旧工程为 `com.sganggs.stronghold-launcher`）
  → 升级 GUID / 卸载项 / 默认安装目录 / 快捷方式均不同；`userData` 在 `main.ts` 中显式钉死为
  `%APPDATA%\node-launcher`，单实例锁基于该目录，与旧启动器互不干扰。

### 14.4 环境限制（与本工程无关）

- 本机 DSH 沙箱禁止管道 stdio 的 spawn，故 `vitest` / `vite build` / `electron-builder` 在此环境
  需一次性提权；用户在普通终端执行 `npm run verify` / `npm run build:win` 不受影响。
- 宿主环境继承了 `ELECTRON_RUN_AS_NODE=1`，且沙箱下 `electron.exe` 即使 `--version` 也返回
  `STATUS_BREAKPOINT`（参考工程的 Electron 同样如此），因此**GUI 无法在本环境冒烟**；
  已用真实子进程端到端测试覆盖主进程链路，并用打包产物核对覆盖分发形态。
  **界面首启仍需在普通桌面环境执行一次**：`npm run dev`。

### 14.5 本轮修复的缺陷

| 缺陷 | 影响 | 处理 |
| --- | --- | --- |
| `build/icon.ico` 与 `resources/runtimes/` 缺失 | `npm run build:win` 必然失败 | 新增 `scripts/make-icon.py` 生成多尺寸图标；补充 `resources/runtimes/README.md` 放置约定 |
| 运行时目录名匹配写成固定前缀 | 内置/已下载运行时可能永远识别不到 | 抽出纯函数 `parseRuntimeDirName` 并补单测 |
| 日志配置未在启动时生效 | 用户改过的日志行数/落盘开关需再次保存才生效 | `main.ts` 启动时读取配置并应用 |
| 测试并行共用临时目录 | 偶发假失败（先结束的文件删掉别人的目录） | 按 worker pid 分目录隔离，连跑两轮验证 |

---

## 15. 第二轮迭代（用户反馈）

### 15.1 反馈与处理

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 设置 / 编辑页面很长、看不到后面的内容 | 弹窗容器改为 `flex` 居中 + `max-height: calc(100vh - 48px)`，`modal-body` 成为唯一滚动区（原 `grid` + `max-height:100%` 在 auto 行上会退化成 `none`，弹窗被撑出视口且遮罩不滚动） |
| 2 | 侧栏「引用目录 / 复制 / 压缩包 / 设置」四个按钮太挤 | 侧栏只留「导入 ▾（复制目录 / 从压缩包）」+「设置」；「引用目录」移入设置弹窗，并列出引用项目、支持「迁移为受管副本」 |
| 3 | 希望保留旧启动器的**数据目录迁移** | 照搬旧逻辑：`projectsRootUser` / `projectsRootActive` 两个字段、`resolveMigrationSource`、`version:rootInfo/migrate/resetRootDir` → `root:info/select/migrate/reset`，UI 文案一致（「检测到旧目录中还有 N 个项目，是否迁移过来？」/「立即迁移」/「恢复默认」） |
| 4 | 希望保留旧启动器的**内网穿透** | `core/tunnel/tunnel-manager.ts` 移植 Cloudflare Tunnel 方案（`cloudflared tunnel --url http://127.0.0.1:<port>`、HTTP2/TCP 与 QUIC/UDP 切换、`taskkill /T /F` 收尾）；按项目维度管理，项目停止/失败/退出时自动断开 |
| 5 | 希望保留旧启动器的 **git 镜像加速** | `core/net/github-mirror.ts` 移植 `applyGithubMirror` + release 列表拉取（镜像失败回退直连）；接入 cloudflared 下载；设置里新增镜像前缀与 Token 输入 |
| 6 | 启动失败 `Path contains invalid characters: …\runtimes\.tmp->=22-…` | 见 15.2：`engines.node` 的范围写法被原样拼进目录名 |
| 7 | 安装包报 `NSIS Error: Error writing temporary file`（管理员身份可运行） | 见 15.4：安装包本身为 `asInvoker`、无问题；`%TEMP%` 不可写导致 NSIS 插件解包失败。已加 `zip` 免安装目标作为旁路，并已实际打包验证 |

### 15.2 `>=22` 非法路径（真实故障根因）

链路：`package.json` 的 `engines.node: ">=22"` → `applyDetect` 原样写入 `manifest.nodeVersion`
→ `ensureRuntime('>=22')` → `resolveVersion` 匹配不到候选、回退时把 `">=22"` 原样返回
→ `runtimes/.tmp-${version}-${Date.now()}` 里出现 `>`，Windows 保留字符 → 路径非法。

修复（三层，任何一层单独都能挡住）：

1. 新增纯函数模块 `core/runtime/version-spec.ts`：`normalizeNodeSpec`（`>=22`→`22`、`^20.11.0`→`20`、
   `22.11.0` 保留、识别不了返回 `null`）、`specMatchesVersion`、`isConcreteVersion`、`safeSegment`。
2. `ensureRuntime` / `resolveVersion` 只用归一化后的值；解析不出具体版本时抛
   「无法识别的 Node 版本「X」，请填写主版本号（如 22）」——**绝不**把外部字符串拼进路径；
   `downloadAndExtract` 的临时目录名再经 `safeSegment` 兜底。
3. 写入侧同样收敛：`applyDetect` 归一化 `engines.node`、`normalizeManifest` 归一化历史清单
   （老数据打开即自愈）、编辑弹窗只接受主版本号或完整版本。

### 15.3 验证证据（本轮实测）

- `tsc -p tsconfig.node.json` → **exit 0**；`vue-tsc --noEmit` → **exit 0**。
- `vitest run` → **exit 0**：10 个文件通过 + 1 个文件跳过（e2e 需 `NL_E2E=1`），
  **114 用例通过 + 1 跳过**。新增 3 个文件 23 个用例：
  - `version-spec.test.ts`（10）：归一化/匹配/`safeSegment` 回归、
    `resolveVersion('>=22')` 在打桩索引下解析为具体版本 `22.11.0`（可安全用于目录名）、
    索引失败回退 `22.23.3`、`ensureRuntime('latest')` 明确报错。
  - `projects-root.test.ts`（8）：默认/自定义/`projects` 同名目录解析（不套娃）、项目计数、
    `migrateContents` 同名跳过与同目录返回 0、换目录时旧目录为空的来源保留规则、`buildRootInfo`、
    `ProjectStore.setRoot`。
  - `tunnel-github.test.ts`（5）：镜像前缀拼接（补斜杠 / 不二次拼接 / 空值直连）、
    cloudflared 资产名、`trycloudflare` 公网地址解析。
- 新增 IPC：`root:info/select/migrate/reset`、`project:adopt`、`tunnel:states/start/stop`
  与 `tunnel:state` 事件；`createServices()` 改为 async（先解析受管项目目录再装配）。

### 15.4 安装包 NSIS 报错（结论）

- 本安装包 PE 清单为 `requestedExecutionLevel level="asInvoker"`，**不要求管理员**；
  对照的旧安装包（`卫戍协议启动器 Setup 0.2.3.exe`，同机可正常安装）同为 `asInvoker`。
- 报错来自 NSIS 自身：安装器启动时要把插件解到 `%TEMP%\ns*.tmp`，写不进去即报
  「Error writing temporary file. Make sure your temp folder is valid.」。
  实测线索：本机 `%TEMP%` 正常可写（`mkdir`/写文件/删除均成功）、C 盘剩余 46.9 GB、
  注册表 `TEMP`/`TMP` 指向存在且 ACL 正常；`%TEMP%` 下还留有 9/28、9/29、10/4 三个 `ns*.tmp`
  → 说明此前 NSIS 安装器在该目录工作正常。以管理员身份运行成功，说明差异在**启动进程的环境/令牌**，
  而不是安装包内容。
- 旁路：`electron-builder.yml` 增加 `zip` 目标（解压即用，不经过 `%TEMP%`）；
  `release\win-unpacked\` 也可直接运行。

### 15.5 打包复验（第二轮产物）

`npm run build:win` → **exit 0**（`tsc` → `vue-tsc` → `vite build` 20 modules → `electron-builder`），
产出并逐项核对：

| 产物 | 大小 | 核对结果 |
| --- | --- | --- |
| `release/Node Launcher Setup 0.0.1.exe` | 82.46 MB | PE 清单仍为 `requestedExecutionLevel level="asInvoker"`；SHA256 `DDBC1244…1A211E` |
| `release/Node Launcher-0.0.1-win.zip` | 112.68 MB | 81 个条目，顶层即应用文件（`Node Launcher.exe` 在根，解压即用）；SHA256 `C9B65B7E…7F581C` |
| `release/win-unpacked/` | — | 免安装目录形态 |

- zip 内 `Node Launcher.exe` 与 `win-unpacked/Node Launcher.exe` **SHA256 完全一致**
  （`9881A204…CBF370`），说明 zip 与目录形态同源同内容。
- `resources/app.asar`（2.73 MB，508 个条目）经 `@electron/asar list` 核对：
  含 `dist-electron/main.js`、`preload.js`、`dist/index.html`，以及本轮新增的
  `core/tunnel/tunnel-manager.js`、`core/net/github-mirror.js`、`core/runtime/version-spec.js`、
  `core/store/projects-root.js`；生产依赖 `fs-extra` / `extract-zip` / `pidusage` / `electron-updater`
  及其传递依赖齐全，**开发依赖 `electron` / `vite` / `vitest` / `typescript` / `electron-builder` 均未混入**。
- `resources/app.asar.unpacked/dist-electron/core/launch/metrics-reporter.js` 与
  `resources/runtimes/README.md` 随包携带（`asarUnpack` / `extraResources` 生效）。
- exe 元数据：`ProductName=Node Launcher`、`FileVersion=0.0.1`、`ProductVersion=0.0.1.0`。
- 未签名（`no signing info identified, signing is skipped`）——本机无代码签名证书，
  首次运行会触发 SmartScreen 提示，属预期。

---

## 16. 第三轮迭代（去冗杂 + 内网穿透修正）

### 16.1 去冗杂

| 项 | 处理 |
| --- | --- |
| 设置里「数据目录与应用标识均独立，可与其它启动器（如卫戍协议启动器）在同一设备共存」 | 界面不再渲染该句与「已隔离 / 需确认」徽标；底部信息块收敛为「运行环境」一行（应用标识 · 数据目录 + 版本号）。主进程的 `isolation` 字段保留（程序化自检仍可用），但文案里不再出现其它产品名 |
| 设置里的「GitHub Token（可选）」 | 移除输入项。当前版本只做导入，不会调用 GitHub API；配置字段与 `fetchGithubReleases(token)` 能力保留，等接入 GitHub 项目源时直接可用，无需迁移配置 |

### 16.2 内网穿透「显示成功却打不开」

用户的现象：每次都显示连接成功、也打印了地址，但打开网址有时报错、等一会儿又好。

根因**不在我们**：Cloudflare quick tunnel **打印出地址 ≠ 公网可用**——刚分配地址的头几秒
边缘/DNS 尚未生效，首次请求常见 502 / 1033；回源侧（`127.0.0.1:<port>`）没监听同样 502。
原实现把「解析到地址」直接当成 `running`，界面上等于谎报成功。

修正后的状态机：`stopped → starting → probing → running`（另有 `error`）：

1. 启动前**回源预检**：`probeTcp(port, '127.0.0.1')`，未监听时在日志里明确提示（没监听必然 502）。
2. 解析到地址后**不置 running**，先进 `probing`（保留已分配地址供用户先试），并轮询公网地址：
   每 2s 一次、最多 20 次；`isTunnelReachableStatus` 把 502/503/504/530 视为「回源未就绪」，
   其余状态码（含 401/404）视为请求已打到源站 → 置 `running`。
3. 轮询超时不判失败，而是置 `running` 并附提示「若首次打开失败，请等几秒重试」
   （边缘可能刚生效，避免把可用隧道误判为错误）。
4. 停止 / 进程退出 / 地址变更都会取消轮询，避免残留定时器。

界面：`probing` 显示「地址已分配，正在验证公网可达…」，`running` 才显示「已连接公网」；
两种状态都属于「进行中」，按钮显示为「断开穿透」。

### 16.3 验证与产物（第三轮）

- `npm run verify` → **exit 0**：`tsc` / `vue-tsc` 0 错，**117 用例通过 + 1 跳过**（10 个文件通过、
  e2e 跳过）。`tests/tunnel-github.test.ts` 增至 8 例，新增：
  - `isTunnelReachableStatus` 判定表（502/503/504/530 vs 200/301/302/401/403/404）；
  - **状态机回归**（注入假 cloudflared 进程 + 打桩探测）：地址分配后必须先是 `probing` 且保留地址，
    探测返回可达后才 `running`；持续不可达时保持 `probing` 并给出说明。
    假进程 `pid=0`，确保不会对真实 PID 执行 `taskkill`。
- `npm run build:win` → **exit 0**，产物重建并核对：
  - `release/Node Launcher Setup 0.0.1.exe` 82.46 MB，SHA256 `46F79F7E…80DDF8`；
  - `release/Node Launcher-0.0.1-win.zip` 112.68 MB，SHA256 `839D8211…CA80044`；
  - zip 内 `resources/app.asar` 与 `win-unpacked/resources/app.asar` SHA256 一致（`A5135697…BD23CC`）；
  - asar 内为**新**渲染产物 `dist/assets/index-BCMpGPC3.js`（旧为 `index-BSTpYQxI.js`）与
    `dist-electron/core/tunnel/tunnel-manager.js`；
  - 以 Node 读取打包后的 bundle 校验文案（避免 PowerShell 传中文的编码坑）：
    「运行环境」= true、「GitHub Token」= false、「共存隔离自检」= false、
    「正在验证公网可达」= true；主进程 `ipc/index.js` 中不出现「卫戍」。

### 16.4 仍属预期 / 非本项目缺陷

- quick tunnel 首次访问的 502/1033 是 Cloudflare 侧行为，已用「验证通过才报成功 + 超时提示」兜住。
- 项目侧若校验 Host（如 Vite 的 `server.allowedHosts`）或页面里硬编码 `https://localhost`，
  仍会打不开——属于被启动项目的配置，已写入 README 常见问题。

---

## 17. 第四轮迭代（拖拽排序 + 穿透检测窗口，发 0.0.2）

### 17.1 项目列表拖拽排序

能做到，且不需要引入任何拖拽库。实现要点：

- **顺序的落点**：`config.json` 的 `projectOrder: string[]`（只存 id 数组）。
  没有写进项目清单是有意的：顺序只影响界面展示，不属于项目业务数据；
  删项目、换数据目录迁移都不会牵连清单，失效 id 自动忽略；新项目自动排在末尾。
- **纯函数**（`core/project/project-order.ts`，可单测）：
  - `applyProjectOrder(items, order)`：按顺序表排列；未列出的项保持原有相对次序并排在后面；
    排序稳定，不改动入参数组。
  - `normalizeProjectOrder(knownIds, incoming)`：丢弃未知 / 重复 / 空白 id，再把
    「存在但没列进去」的项目补到末尾——保证拖拽结果永远是一个合法全序。
- **交互**（`src/App.vue`，Pointer Events）：
  - `pointerdown` 起 280ms 长按计时；期间移动超过 6px 视为滚动/点击，取消长按
    （不影响侧栏滚动，也不会误触）。
  - 长按成立后进入拖动：拖动中用 `elementFromPoint` 找目标项并**实时重排本地数组做预览**，
    松手才 `project:reorder` 落盘；拖起的元素 `pointer-events: none`，避免自己挡住命中测试。
  - 拖动结束后 250ms 内吞掉浏览器补发的 `click`，防止误切换选中项；落盘失败会回滚（重新拉取列表）。
  - 列表上方有「长按项目可拖动排序」提示（项目数 > 1 时显示）。

### 17.2 公网可达性检测窗口：20 → 40 秒

先澄清一处误读：原实现的 `20` 是**次数**不是秒数（间隔 2 秒），实际已经是约 40 秒。
本次把它写成显式语义，避免以后再猜：

```ts
export const PROBE_WINDOW_MS = 40000;                                   // 验证窗口
export const PROBE_INTERVAL_MS = 2000;                                  // 探测间隔
export const PROBE_MAX_ATTEMPTS = Math.ceil(PROBE_WINDOW_MS / 2000);    // 次数由窗口推导
```

另外新增**手动「重新检测」**（`tunnel:recheck` → `TunnelManager.recheck`）：窗口用尽后
状态是 `running` + 提示（不判失败），用户点一下即可再跑一轮 40 秒，不必拆掉隧道重连。
提示文案也会显示「最多 40 秒，已检测 N 次」。

### 17.3 验证与产物（0.0.2）

- `npm run verify` → **exit 0**：`tsc` / `vue-tsc` 0 错，**127 用例通过 + 1 跳过**
  （11 个文件通过、e2e 跳过）。本轮新增：
  - `tests/project-order.test.ts`（8 例）：空顺序表、全量排序、部分覆盖时的稳定次序、
    失效 id、不改动入参；归一化的过滤与补齐规则。
  - `tests/tunnel-github.test.ts` 增至 10 例：新增「验证窗口 ≥ 40 秒且次数由窗口推导」、
    「recheck 重新进入 probing 并能在可达后置 running」「无地址时 recheck 报错」。
- `npm run build:win` → **exit 0**，产出 `0.0.2`：
  - `release/Node Launcher Setup 0.0.2.exe` 82.46 MB，SHA256 `395BD99F…54C5AF`；
  - `release/Node Launcher-0.0.2-win.zip` 112.68 MB，SHA256 `895C3C74…391F53`；
  - exe 元数据 `FileVersion=0.0.2`、`ProductVersion=0.0.2.0`；
  - asar 内为**新**渲染产物 `dist/assets/index-UBzt6qaJ.js`（上一版为 `index-BCMpGPC3.js`）
    与新增的 `dist-electron/core/project/project-order.js`。
  - 0.0.1 的三个产物移入 `release/previous-0.0.1/`，避免与当前版本混淆。

### 17.4 过程中修掉的工程问题

- `.tools/node`（开发工具链 junction）的目标 `stronghold-launcher/.tools/node22/…` 已不存在
  → 校验/打包直接失败（`npm.cmd` 找不到）。已把 junction 重指到仍然存在的
  `D:\a1937\Documents\DSH Desktop\stronghold-launcher - 2\stronghold-launcher\.tools\node22\node-v22.23.3-win-x64`
  （Node v22.23.3 已验证），工程恢复可构建。
  注意：**这是一条指向工作区外部的依赖**，若那个目录被删，需要跑
  `powershell -ExecutionPolicy Bypass -File scripts/setup-toolchain.ps1` 重新获取（需联网）。
- 该修复需要创建目录联接（junction），在工作区沙箱下会被拒绝，属环境限制而非工程问题。

---

## 18. 第五轮迭代（访问地址区紧凑化 + 局域网地址，参考工程改址）

### 18.1 反馈与处理

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 原参考工程已迁移到 `D:\Files\备份\stronghold-launcher` | 见 18.2：重指 `.tools/node` 目录联接，并把工具链脚本改成能安全处理「断链」 |
| 2 | 「显示地址」这块占地偏大，能否优化 | 见 18.3：地址区改为**常量高度**（折叠态恒为一行），长地址单行省略，穿透区去掉冗余行 |
| 3 | 不能只显示 `http://localhost:3300`，要照旧启动器的逻辑来 | 见 18.4：新增本机网卡枚举，展示局域网 / VPN / 虚拟网卡地址（分档标注 + 可开关） |

### 18.2 工具链改址（`.tools/node`）

上一轮把 `.tools/node` 指向了 `stronghold-launcher - 2\…`；参考工程搬到 `D:\Files\备份\stronghold-launcher`
后，旧目标仍在（未损坏），但已不是「参考工程」的位置。本轮：

- 用 `rmdir` 摘掉旧链接（**不用** `Remove-Item -Recurse`，避免顺链删掉目标里的真实文件），
  重建到 `D:\Files\备份\stronghold-launcher\.tools\node22\node-v22.23.3-win-x64`；
  核验：`node -v` = v22.23.3、`node_modules/npm/bin/npm-cli.js` 存在、旧目标文件完好。链接重建
  在 workspace-write 沙箱下被拒绝（`Access is denied`），属环境限制，一次性提权后完成。
- `scripts/setup-toolchain.ps1` 加固：
  - 新增 `Remove-NodeTarget`：目标若为链接（`LinkType`）走 `cmd /c rmdir`，否则才 `Remove-Item -Recurse`。
    这样「链接已断」的现场也能安全重建，不会顺链误删。
  - 新增 `-SourceDir`：把已有的 Node 解压目录直接链接成 `.tools/node`，**免联网**准备工具链。
- 仍未消除「指向工作区外部」这个结构性依赖（可供选择的彻底方案是自包含复制一份 Node 到
  `.tools/node`，约百兆，等确认）。

### 18.3 访问地址区紧凑化

原实现是一行 `info-box`：`http://localhost:<port>` + 「打开」「复制」两个文字按钮；
加入局域网地址后若照旧启动器逐行列全，卡片会被撑很高。处理：

- **折叠**：折叠态恒为一行 —— `本机 <地址> [局域网 N ▾] [↗] [⧉]`，与地址数量无关；
  展开才显示每块网卡的地址。
- **单行省略**：所有地址（含穿透的 `trycloudflare` 长地址）`white-space: nowrap` +
  `text-overflow: ellipsis`，`title` 给全文，点击即复制。原来是直接换行，窄窗口下会到 2–3 行。
- **图标按钮**：`↗`（打开）/ `⧉`（复制）改为近正方形的 `.btn.sym`（`min-width: 24px`），
  文案移入 `title`；穿透区的「打开 / 复制地址」同样处理。
- **删冗余行**：穿透状态为 `running` 时不再额外渲染「已确认公网可达。」——标题旁已有「已连接公网」。
- 结果：默认态**高度不随地址数量增长**，且比原来（一行地址 + 一行按钮 + 三行穿透说明）更矮。

### 18.4 局域网 / 组网地址（不再只有 localhost）

新增 `core/net/network-utils.ts`（纯函数 + 单一副作用入口）：

- `classifyIface(name)` / `classifyIp(addr, iface)` / `collectLocalIPs(nets)` / `compareAddresses` / `getLocalIPs()`。
- **分档**：`lan`（真实局域网）、`vpn`（ZeroTier / Tailscale）、`virtual`（Hyper-V / WSL / Docker /
  VMware / VirtualBox 等）。**网卡名优先于网段**判断。
- **比旧启动器更保守的地方**（旧实现只按网段）：旧版把 `172.16/12` 一律当「VPN 联机」地址展示，
  而这段正是 Hyper-V / WSL / Docker 的默认网段 —— 用户复制过去必然连不上。现在这类归到
  `virtual` 并排到最后；`169.254.*`（没拿到 DHCP 的自动地址）直接过滤；同地址去重。
- IPC `net:getIPs` + preload `getLocalIPs`；`showVirtualIps` 字段（旧工程遗留、一直没人用）接上界面开关。
- 界面：展开列表里每条显示「网卡名 / VPN / 虚拟」标签 + 地址；**若项目绑定的是回环地址
  （`127.0.0.1` / `localhost` / `::1`），明确提示「只有本机能访问，要改 HOST 为 0.0.0.0」**
  ——这是旧启动器没有、但用户最容易踩的坑。
- 网卡地址在启动时就绪时再刷一次（VPN 网卡可能是启动后才出现的）。

### 18.5 验证（本轮）

- `npm run verify` → **exit 0**：`tsc` / `vue-tsc` 0 错，**140 用例通过 + 1 跳过**
  （12 个文件通过、e2e 跳过）。新增 `tests/network-utils.test.ts`（13 例）：
  - 网卡名识别（Tailscale / ZeroTier / vEthernet / VMware / VirtualBox vs 普通「以太网 / WLAN」）；
  - 网段判定与边界（`26.*`、`100.64/10` 内外、`172.16/12` 内外）；
  - 网卡名优先于网段；
  - `collectLocalIPs`：只取非内部 IPv4、剔除回环与链路本地、按地址去重、类型分档与排序、
    兼容 `family` 写成数字 `4`、空输入不抛错；
  - `compareAddresses` 按数值而非字符串排序（`192.168.1.9` < `192.168.1.10`）。
- 过程中被测试抓到一处**真缺陷**：`collectLocalIPs` 只认 `family === 'IPv4'`，
  但我按「兼容数字 4」写了用例 —— 是代码没实现而非用例写错，已补上容忍分支
  （否则该用例是空转的假保险）。

### 18.6 评审：`PLAN-groups.md`（母栏 / 分组，0.0.3）

用户同时提交了分组功能的计划书。已逐条对照现有代码核实，结论写入
`PLAN-groups-review.md`：**方向正确、可以按它做**，但需先钉死 5 条——

1. `project:list` 改不改（§2 与 §6 自相矛盾）：**保持不变**，分组视图只走 `group:list`。
2. 拖拽落盘语义：`config.projectOrder` 是扁平全局表，`group:reorder` 的 `order` 必须是
   **所有母栏拼接后的完整 id 列表**，否则会被 `normalizeProjectOrder` 静默挪到末尾。
3. 「未分组」隐藏后没有投放目标 → 实例无法移出母栏：拖拽期间强制渲染投放条 + 右键菜单兜底。
4. `writeJsonAtomic` 临时文件名 `${pid}.${Date.now()}` 同毫秒会撞车（既有全局隐患），加自增序号。
5. `normalizeRepo` 必须写白名单正则（`githubRepo` 会拼进 `api.github.com/repos/<repo>/releases`）。

---

## 19. 第六轮迭代（母栏/分组功能落地，发 0.0.3）

按 `PLAN-groups.md`（**修订 v2**）实施。计划书已按上一轮评审的 5 条硬改动改好并定稿；
实施中发现并修掉的问题、以及与原计划不同的取舍记录如下。

### 19.1 与原计划的差异（都是评审结论的落地）

| 项 | 计划 v1 | 实际实现 |
| --- | --- | --- |
| `project:list` | 「改为返回带分组信息的数据」 | **保持不变**（扁平 `ProjectSummary[]`）；分组视图只走 `group:list`。两个通道共用同一个 `listSummaries()`，`depsState` 只探测一次 |
| 栏内顺序 | `instanceIds` 顺序隐含有效 | **顺序唯一来源是 `config.projectOrder`**；`instanceIds` 只管归属。栏内拖拽换位不需要同时维护两份顺序 |
| 移出母栏 | 只能拖到「未分组」行 | 「未分组」为空时**拖拽期间强制渲染投放条**；另有实例行 `⋯` 菜单「移出母栏 / 移入…」兜底 |
| `project:addGithub` | 新增一个通道 | **不再单独实现**：GitHub 路径统一走 `group:addRelease`（内部按 `tag`+`assetName` 重新解析真实下载地址），渲染层不传任意 URL |
| 下载后 | 未说明 | 解压导入成功即删除下载的 zip（已进项目目录，留着只占空间）；失败路径同样清理 |
| 更新既有实例 | 未提 | **本期不做**，UI 明确写「作为新实例加进本母栏，不会覆盖已有的实例」，避免暗示会覆盖 |

### 19.2 实施中发现并修掉的缺陷（都是测试/复核抓出来的）

| 缺陷 | 怎么发现的 | 处理 |
| --- | --- | --- |
| `flattenedOrder()` 用了渲染行 | 自查折叠分支 | 折叠母栏里的实例不在渲染行里，提交的 `order` 会缺 id → 被 `normalizeProjectOrder` 判为「未列出」补到末尾，**静默打乱折叠栏顺序**。改为直接读 `groupView`（含折叠栏） |
| `fse.move(overwrite)` 并发写同一个目标会 `EPERM` | `atomic-json` 并发回归测试实测复现 | 唯一临时名只解决「撞名」，不解决「删目标 + 改名」被并发交错。给 `writeJsonAtomic`/`writeTextAtomic` 加**按目标路径的串行队列**（顺带保护了没有队列的 `ConfigStore`） |
| `Source code (tar.gz)` 没被排除 | `github-release` 单测 | GitHub 源码包名**括号里没有前导点**（`(tar.gz)` 而非 `.tar.gz`），后缀正则永远匹配不到；改为把括号内那段当扩展名再判一次（`(zip)` 保留、`(tar.gz)` 排除） |
| 子代理声称已处理的边界其实没实现 | 同上 | 子代理在交付说明里写「已对去掉尾部 `)` 的名字各判一次」，实际那条路径匹配不到任何东西。**结论：子代理的自述必须由测试验证，不能采信** |
| `net:getIPs` 的 `family` 兼容分支缺失 | `network-utils` 单测（上一轮） | 用例写了「兼容数字 4」，代码只认 `'IPv4'`；已补分支，否则该用例是空转 |
| `registerIpcHandlers` 没解构 `groupsStore` | `tsc` | 补上 |

### 19.3 验证证据

- `npm run verify` → **exit 0**：`tsc` / `vue-tsc` 0 错，**199 用例通过 + 1 跳过**
  （16 个文件通过、e2e 跳过）。本轮新增 4 个测试文件：
  - `tests/group-logic.test.ts`（27）：id 白名单、`normalizeRepo` 全量接受 + 拒绝清单
    （`../` 穿越、`?`、`#`、空格、三段、单点段…）、归一化的垃圾输入自愈、
    **跨母栏去重先到先得**、输入不被改动、`moveInstance` 的 null/UNGROUPED_ID/未知栏/幂等、
    `buildGroupedView` 的排序表与未分组恒在最后。
  - `tests/groups-store.test.ts`（8）：缺文件不产生副作用、损坏自愈、保存读回一致、
    **20 次并发 moveInstance 不丢更新**、并发建两栏不互相覆盖、单次失败不卡死队列、
    写路径清理失效项目 id、不残留 `.tmp`。
  - `tests/github-release.test.ts`（20）：源码包识别、资产分档（唯一 win zip 自动 /
    多候选让用户选 / 只有源码包 / 只有安装器）、版本比较（`v1.2.10 > v1.2.9`、预发布低于正式）、
    首次检查不谎报更新、未排序列表取最新、`resolveAsset` 命中与缺失。
  - `tests/atomic-json.test.ts`（4）：**把 `Date.now` 钉死在同一毫秒**再并发写同一文件，
    断言结果是某一次的完整内容且不残留 `.tmp`。
- `npm run build:win` → **exit 0**，产出 `0.0.3`：

| 产物 | 大小 | SHA256 |
| --- | --- | --- |
| `release/Node Launcher Setup 0.0.3.exe` | 82.48 MB | `74078B7D…C8F9EDEF` |
| `release/Node Launcher-0.0.3-win.zip` | 112.70 MB | `E41D373B…BF41ED26` |

  - exe 元数据 `FileVersion=0.0.3`、`ProductVersion=0.0.3.0`、`ProductName=Node Launcher`；
  - `release/previous-0.0.2/` 归档上一版三个产物；
  - asar（518 条目）核对：新增 `core/project/group-logic.js`、`core/store/groups-store.js`、
    `core/net/github-release.js`、`core/net/network-utils.js`、`core/util/atomic-json.js`；
    渲染产物为 `dist/assets/index-iGvx-Qqb.js` + `index-C5bw5hSY.css`；
    生产依赖 `fs-extra`/`extract-zip`/`pidusage`/`electron-updater` 齐全，**开发依赖 0 混入**；
  - 用 Node 读打包后内容校验文案（避免 PowerShell 传中文的编码坑）：
    主进程含 `group:reorder`/`group:addRelease`/`net:getIPs` 且**不含「卫戍」**；
    渲染 bundle 含「新建母栏 / 未分组 / 移出母栏 / 下载并添加为实例 / 局域网」。

### 19.4 仍待用户验证（本环境做不了的部分）

界面无法在此环境冒烟（宿主继承 `ELECTRON_RUN_AS_NODE=1`，`electron.exe` 连 `--version`
都返回 `STATUS_BREAKPOINT`），所以下列交互需要在真实桌面上过一遍：
长按拖入母栏 / 拖到折叠母栏上 / 展开与折叠是否记住 / `⋯` 菜单移出移入 /
检查更新与「下载并添加为实例」（此环境无外网，镜像与直连均未实测）。

