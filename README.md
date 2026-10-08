# Node Launcher

通用 Node 项目启动器（Windows）。把一个窗口用来完成任意本地 Node 项目（以及任意非 Node 程序）的
**接入 → 配置 → 依赖准备 → 启动 → 观测 → 停止 → 排障**。



## 特性

- **两种启动模式**
  - `Node 直启`：用内置/下载的真实 Node 运行入口文件，参数逐个传递、不经 shell，最安全。
  - `自定义命令`：整条命令行交给 shell（`cmd /d /s /c`），支持 `&&`、管道、环境变量。
  - 打开编辑弹窗会自动探测并预填入口 / 脚本命令 / 工作目录（支持 monorepo 子包）。
- **依赖自动准备**
  - 启动前确定性预检：有 `package.json` 但没有 `node_modules` → 询问后安装。
  - 启动失败精确分类：只对「裸包缺失」提示安装，相对路径 / 原生模块 ABI / 编译环境 / 端口占用等
    一律不误装，并给出针对性建议。一次启动最多自动安装一次（防死循环）。
  - **默认 `--ignore-scripts`**：不执行项目自带的 postinstall，需要原生编译时由用户显式允许。
- **项目接入**
  - `导入`（侧栏左下角）：复制目录导入、从压缩包导入（均落在启动器管理的项目目录里）。
  - `引用目录`（设置 → 引用目录）：直接登记已有目录，**不复制源码**；删除项目时只移除登记。
    需要纳入启动器管理时，可对某个引用项目执行「迁移为受管副本」（复制源码，原目录保留）。
- **数据目录可迁移**（逻辑与旧专用启动器一致）：设置 → 项目数据目录可改到任意位置；
  换目录后若旧目录里还有项目，会出现「检测到旧目录中还有 N 个项目，是否迁移过来？」，
  一键把内容搬到新目录（同名项跳过，绝不覆盖）。
- **列表拖拽排序**：长按侧栏里的项目条目即可上下拖动调整顺序（拖动时实时预览，松手才落盘），
  顺序保存在 `config.json` 的 `projectOrder` 里，重启后保持；新项目自动排在末尾。
- **母栏（分组）**：侧栏支持把实例收进「母栏」，用来归置同一来源的多个实例。
  - 「＋ 新建母栏」建栏；点母栏名左侧三角折叠/展开（折叠状态会记住），栏名右侧显示「运行中/总数」。
  - **拖拽归入**：长按实例拖到母栏行上即可收进去，拖到别的实例上则插入它的位置（连母栏一起换）。
    拖拽期间会临时露出「未分组」投放条——否则实例全部入栏后就没地方可拖回去了。
  - **兜底菜单**：实例行悬浮出现 `⋯`，可「移出母栏 / 移入某母栏」；母栏行的 `⋯` 可重命名、删除。
    删除母栏只解散分组，**栏内实例回到「未分组」，项目本身不会被删**。
  - **检查更新**（可选）：给母栏绑定一个 GitHub 仓库（`owner/repo`，支持粘贴完整地址），
    在母栏信息里「检查更新」→ 显示最新 release 与当前记录版本；可挑一个 zip 资产
    「下载并添加为实例」，作为**新实例**加进本母栏（不覆盖已有实例）。首次检查只记录版本，不谎报更新。
  - 母栏定义存在 `%APPDATA%\node-launcher\groups.json`，与 `config.json` 同级；
    `manifest.json` 结构**零改动**，母栏顺序也复用同一份 `projectOrder`。
- **内网穿透**：一键把本地端口暴露成 `https://xxx.trycloudflare.com`（Cloudflare Tunnel /
  cloudflared，方案与旧启动器相同）。首次使用自动下载 cloudflared 到数据目录，支持
  HTTP2/TCP 与 QUIC/UDP 切换；项目停止时自动断开。地址分配后会**持续验证公网可达（最长 40 秒）**，
  确认后才显示「已连接公网」；用尽窗口仍不确定时可点「重新检测」再跑一轮。
- **访问地址（本机 + 局域网）**：项目就绪后显示地址区，**不只给 `http://localhost:<port>`**：
  始终显示本机地址，另有局域网地址时给出「局域网 N 个 ▾」按钮，展开可见每块网卡的地址
  （逻辑同旧启动器，但默认收起，地址再长也只占一行）。整行/地址点击即复制。
  网卡会分档标注：真实局域网、`VPN`（ZeroTier / Tailscale 等组网）、`虚拟`（Hyper-V / WSL /
  Docker / VMware 等，通常只有本机能访问，排最后）；`169.254.*` 这类失效自动地址直接过滤掉。
  是否显示 `VPN` / `虚拟` 地址可在「设置」里开关。若项目绑定的是 `127.0.0.1`，展开时会明确提示
  「只有本机能访问」，避免把连不上的地址复制给别人。
- **GitHub 加速**：可配置镜像前缀（默认 `https://gh-proxy.com/`），拼接规则与旧启动器一致
  （前缀 + 原始 GitHub 地址），用于 cloudflared 等外部工具下载；拉取 API 失败会自动回退直连。
- **运行可观测**：实时日志（分类标签、落盘、导出）、CPU/内存（子进程上报或**进程树**轮询）、
  真实监听端口探测、就绪判定（日志正则 / 健康检查 URL / TCP 探测）。
- **稳健停止**：优雅停止 → 超时强杀进程树（Windows `taskkill /T /F`），退出时统一收尾，不留孤儿。
- **不污染用户环境**：不写系统 PATH、不写注册表、不装全局包；运行时目录只前置给被启动的子进程。

## 与其它启动器的隔离

| 维度 | 本应用 | 说明 |
| --- | --- | --- |
| appId | `com.nodelauncher.desktop` | 与旧专用启动器不同 → 不同升级 GUID / 卸载项 |
| 数据目录 | `%APPDATA%\node-launcher` | 显式钉死（不随 productName 变化），与 `stronghold-launcher` 无关 |
| 默认安装目录 / 快捷方式 | `Node Launcher` | 不覆盖旧启动器的安装与快捷方式 |
| 单实例锁 | 基于本应用 userData | 两个启动器可各自运行、同时各跑自己的项目 |
| 端口 | 默认 3000，可改，占用时自动切换 | 与其它程序冲突时不会互相阻断 |
| 开发端口 | Vite `5174` | 旧工程用 5173，二者可同时调试 |

设置弹窗底部会显示应用标识、实际数据目录与运行版本，便于排查「两个启动器是否互相影响」。

## 快速开始

前置：Windows 10/11 x64。**不需要预装 Node.js**（启动器自带/按需下载运行时）。

```powershell
# 1) 准备开发工具链（本机没有全局 Node 时）
powershell -ExecutionPolicy Bypass -File scripts/setup-toolchain.ps1

# 2) 安装依赖
.tools\node\npm.cmd install

# 3) 开发调试（两个终端）
.tools\node\npm.cmd run dev          # 终端 A：Vite 开发服务器（5174）
$env:VITE_DEV_SERVER_URL='http://localhost:5174'
.tools\node\npm.cmd run dev:electron # 终端 B：编译主进程并启动 Electron

# 4) 质量校验 / 打包
.tools\node\npm.cmd run verify       # tsc + vue-tsc + vitest
.tools\node\npm.cmd run build:win    # 产物在 release/
```

## 脚本

| 脚本 | 作用 |
| --- | --- |
| `build:electron` | 编译主进程 TypeScript → `dist-electron/` |
| `typecheck` | `vue-tsc --noEmit` 校验渲染层 |
| `test` | vitest 单元/集成测试（默认跳过需要真实子进程的 e2e） |
| `verify` | 上面三步串行 |
| `dev` / `dev:electron` | 开发调试 |
| `build:win` | 生产打包（NSIS） |

端到端冒烟（真实 Node 进程、真实 spawn、HTTP 探活）：

```powershell
$env:NL_E2E='1'; .tools\node\npm.cmd run test
```

## 数据目录

```
%APPDATA%\node-launcher\
├── config.json                     # 全局配置（数据目录、镜像、穿透协议…）
├── groups.json                     # 母栏（分组）定义：哪个实例属于哪个母栏
├── projects/                       # 受管项目根目录（可在「设置 → 项目数据目录」里改）
│   └── <id>/{manifest.json,src/,.launcher/}
├── runtimes/node-<ver>-<platform>-<arch>/   # 按需下载的 Node
├── bin/cloudflared.exe             # 内网穿透组件（首次启用穿透时下载）
├── logs/<projectId|__app__>/<date>.log
└── downloads/
```

引用模式（linked）的项目，源码始终留在用户自己的目录里，启动器只保存一条登记。
`projects/` 只是**受管**项目的默认落点；换到别的盘/目录后，旧目录里的项目可以一键迁移过来。

> `groups.json` 与 `config.json` 同级，**不随「项目数据目录」迁移**：母栏属于界面组织信息，
> 不是项目业务数据。换数据目录后母栏定义仍保留，指向的仍是同一批项目 id。

## 常见问题

**安装包双击报 `NSIS Error: Error writing temporary file. Make sure your temp folder is valid.`**

这是 NSIS 自身的限制：安装器启动时要把插件解到 `%TEMP%\ns*.tmp`，写不进去就报这个错，与本应用无关
（本安装包的执行级别是 `asInvoker`，不要求管理员；对照的旧安装包同样如此）。常见原因与处理：

1. 启动该 exe 的进程继承了失效 / 被限制的 `%TEMP%`（例如从受限环境启动）。先关掉全部
   安装器窗口与资源管理器，重新登录（或重启 `explorer.exe`）刷新环境变量后重试。
2. `%TEMP%` 指向的目录不存在或不可写：在「系统属性 → 环境变量」里把 `TEMP`/`TMP` 指回
   `%USERPROFILE%\AppData\Local\Temp` 并确认目录存在。
3. 清理 `%TEMP%` 下残留的 `ns*.tmp` 目录后重试。
4. 应急：直接用免安装形态 `release\win-unpacked\Node Launcher.exe`（或 zip 包解压即用），
   完全不经过系统临时目录。

**内网穿透：地址出来了，但打开报错 / 等一会儿又好了**

这是 Cloudflare quick tunnel 的固有行为，不是启动器误判：**打印出地址 ≠ 公网已经可用**。
刚分配地址的头几秒，边缘/DNS 还在生效，首次请求常返回 502 / 1033。启动器现在的处理是：

- 只在 cloudflared 输出地址后进入「正在验证公网可达…」，**反复请求公网地址直到不再返回
  502/503/504/530 才显示「已连接公网」**（界面上不会再谎报成功）；
- 建立前还会检查本地端口是否真的在监听（没监听必然 502），日志里会给出提示；
- 自动验证超时（40 秒）不会直接判失败，而是提示「若首次打开失败，请等几秒重试」，
  并给出「重新检测」按钮——不必拆掉隧道就能再跑一轮检测。

仍然打不开时按这三条查：

1. 项目是否**真的在监听**被穿透的那个端口（看项目详情页的端口/PID，或日志）。
2. 项目是否**校验 Host**：例如 Vite 需要 `server.allowedHosts: ['.trycloudflare.com']`，
   否则会返回「Blocked request. This host is not allowed.」——这是项目侧配置，不是启动器问题。
3. 穿透回源是 HTTP（`http://127.0.0.1:<port>`），页面里若有硬编码 `https://localhost` 的请求，
   浏览器会按混合内容拦截。



**母栏「检查更新」失败 / 一直失败**

弹窗里会直接显示失败原因，常见三种：

1. **国内直连 `api.github.com` 超时**：先在「设置 → GitHub 加速」里填镜像前缀（默认
   `https://gh-proxy.com/`）。镜像拉取 API 失败时会自动回退直连，日志里（底部日志面板）
   会写明「镜像加速失败（…），回退直连 GitHub」。
2. **仓库地址写错**：只接受 `owner/repo`；粘贴完整 URL、`git@github.com:owner/repo.git`
   都可以，保存时会自动归一化，其它形式会被忽略（弹窗里会提示）。
3. **仓库没有 release**：报「仓库没有任何 release」。注意 release 里必须有 `.zip` 资产，
   只有安装器（`.exe`/`.msi`）或源码 `tar.gz` 的话没有可添加的资产。

另外：检查更新只读取 release 列表，**不会**自动下载；点「下载并添加为实例」才会下载并解压导入。

**局域网地址连不上 / 只能本机打开**

先看项目详情页地址区展开后的提示。三种常见情况：

1. **项目绑定了 `127.0.0.1`（或 `localhost`）**：只有本机能访问，把编辑弹窗里的 `HOST` 改成
   `0.0.0.0` 重新启动后，局域网地址才可用（启动器发现这种情况会直接提示）。
2. **Windows 防火墙**拦截了该端口：首次在公用网络下监听会弹窗询问，选「专用网络」并允许；
   已拒绝过的可在「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」里放行。
3. **复制到的是虚拟网卡地址**：地址区里标 `VPN` / `虚拟` 的那些（ZeroTier、Tailscale、
   Hyper-V、WSL、VMware、Docker）通常只在对应虚拟网络内可达，别把 `172.x` / `100.x` 的地址
   发给同 Wi-Fi 的人；同 Wi-Fi 联机应该用「本机」以外的、不带标记的那条 `192.168.x` / `10.x`。
   在「设置」里可以关掉 `VPN` / `虚拟` 地址的显示，只留真实局域网。

**启动项目报 `Path contains invalid characters: …\runtimes\.tmp->=22-…`**

项目的 `package.json` 写了 `engines.node: ">=22"` 这类范围约束，早期版本把它原样当成 Node 版本
又拼进了运行时目录名，`>` 在 Windows 上是保留字符。现在所有版本字符串都会先归一化成主版本号
（`>=22` → `22`，`^20.11.0` → `20`，`22.11.0` 保留），无法识别时给出明确提示而不是拼出非法路径；
编辑弹窗里的「Node 版本」也只接受主版本号或完整版本。

## 目录结构

```
electron/
├── main.ts / preload.ts            # 生命周期、窗口、唯一接口面
├── ipc/index.ts                    # 服务装配 + IPC 注册
├── core/
│   ├── store/                      # 配置、母栏定义、清单、受管数据目录与迁移（原子写、容错归一化、校验）
│   ├── runtime/                    # Node 运行时供给、版本约束归一化、包管理器探测
│   ├── launch/                     # 启动流水线、spawn 计划、就绪、指标、进程树
│   ├── deps/                       # 依赖预检、错误分类、安装器
│   ├── project/                    # 项目接入与探测、母栏纯逻辑（group-logic）
│   ├── tunnel/                     # 内网穿透（cloudflared）
│   ├── download/ archive/ net/     # 下载器、解压、GitHub 镜像加速 / release 解析、本机网卡地址枚举
│   ├── log/ util/                  # 日志、原子 JSON 写、错误、ID、路径
│   └── app-paths.ts
src/                                # Vue 3 界面（App.vue + components/）
tests/                              # vitest：清单/版本约束/分类/计划/流水线/数据迁移/母栏/网卡分档/e2e
```

## 尚未实现（后续里程碑）

- 从 **git 仓库**直接安装项目（GitHub **Release** 已经能用：见「母栏 → 检查更新 → 下载并添加为实例」）。
- 母栏的「**更新既有实例**」（当前每次都是添加为新实例，便于多版本并存）。
- 托盘图标、系统通知、开机自启、多语言（i18n）、启动器自更新接线。
- 随安装包内置 Node 运行时：`resources/runtimes/` 已预留放置约定（见该目录 README），
  默认为空，运行时按需下载到 `%APPDATA%\node-launcher\runtimes\`。

## 打包产物

```powershell
.tools\node\npm.cmd run build:win
# release\Node Launcher Setup 0.0.3.exe   （NSIS 安装包，约 82 MB）
# release\win-unpacked\                   （免安装目录形态）
# release\Node Launcher-0.0.3-win.zip     （免安装压缩包，不经过 %TEMP%）
# release\previous-0.0.2\                 （历次产物归档，避免与当前版本混淆）
```

安装包与旧专用启动器互不覆盖：`appId` 为 `com.nodelauncher.desktop`，默认安装目录与快捷方式名
均为 `Node Launcher`。zip 目标是为「`%TEMP%` 不可用 / 不想装」的场景准备的（见常见问题）。

## 许可证

GPL-3.0
