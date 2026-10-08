# PLAN：项目列表「母栏（分组）」收纳功能

> 目标版本：**0.0.3**
> 约束：不改动现有实例的 `manifest.json` 结构；母栏数据独立存放于 `groups.json`；全部操作原子化落盘。
>
> **修订 v2**（评审后定稿；逐条理由见 `PLAN-groups-review.md`）。相对 v1 的 5 处硬改动：
>
> 1. **`project:list` 保持不变**（仍返回扁平 `ProjectSummary[]`），分组视图只走 `group:list`。
>    v1 的 §2 与 §6 自相矛盾，而且会波及现有渲染层的全部取数点（`current` / `currentId`、
>    拖拽排序、删除后刷新都按扁平数组消费）。
> 2. **「未分组」在拖拽期间强制显示为投放条**，并给实例行补 `⋯` 菜单「移出母栏 / 移入…」——
>    v1 的「未分组为空即隐藏」会让实例全部入栏后再也拖不出来。
> 3. **栏内顺序的唯一来源是 `config.projectOrder`**；`instanceIds` 只表示归属、顺序无意义。
>    `group:reorder` 的 `order` 是**所有母栏按视图顺序拼接后的完整 id 列表**。
> 4. `writeJsonAtomic` 的临时文件名补随机后缀（v1 未覆盖这个既有全局隐患）。
> 5. `normalizeRepo` 改为**白名单正则**，负例写进测试计划。

---

## 0. 术语

| 术语 | 含义 |
|---|---|
| 母栏 / 分组（group） | 左侧列表的第一级，用来收纳若干实例 |
| 实例（instance） | 现有的「项目」，即 `projects/<id>/manifest.json` 描述的东西 |
| 未分组 | 一个**虚拟**母栏，不存在于 `groups.json`，用于收纳不属于任何母栏的实例 |

> 术语统一：代码与界面一律「母栏 / 实例」。不用「分组」「项目」混指，避免读代码时绕圈。

---

## 1. 数据设计

### 1.1 新文件 `groups.json`

位置：**与 `config.json` 同级**，即 `%APPDATA%\node-launcher\groups.json`。

理由：母栏是**界面组织信息**，不是项目业务数据。放在 `userData` 根目录可以避免两件事——
(a) 用户切换「项目数据目录」时母栏定义被牵连搬迁；
(b) 写入 `projects/` 目录时被 `ProjectStore.list()` 的 `isValidId(entry)` 扫描逻辑误认为项目
（已核实：`electron/core/store/project-store.ts:56`）。
与 `config.json` 里的 `projectOrder` 保持同一层级，语义一致。

**代价要讲清楚**：换「项目数据目录」时母栏定义**不跟着走**。设置里切换 / 迁移目录的提示文案
必须补一句「母栏定义保存在启动器数据目录，不随项目目录迁移」，否则用户会以为母栏丢了。

```json
{
  "schema": 1,
  "groups": [
    {
      "id": "group_lz3k9f2a",
      "name": "卫戍协议",
      "githubRepo": "sganggs/Stronghold-Protocol",
      "instanceIds": ["zip-muxjxkg...", "github-xxx..."],
      "lastSeenTag": "v1.4.2",
      "lastCheckedAt": "2026-10-07T13:00:00.000Z",
      "collapsed": false,
      "createdAt": "2026-10-01T00:00:00.000Z"
    }
  ]
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `schema` | ✅ | 固定 `1`，为将来演进留位 |
| `groups[].id` | ✅ | 白名单格式 `^group_[a-z0-9]{4,32}$`，由 `newGroupId()` 生成 |
| `groups[].name` | ✅ | 母栏名，1–40 字符，去首尾空格 |
| `groups[].githubRepo` | ➖ | `owner/repo` 形式，留空表示未绑定；清洗规则见 §3.1 |
| `groups[].instanceIds` | ✅ | 归属该母栏的实例 id，**顺序无意义**（见 §3.4）；同一 id 全局至多出现在一个母栏 |
| `groups[].lastSeenTag` | ➖ | 最近一次「下载并添加为实例」或「检查更新」看到的 tag，用于版本比较 |
| `groups[].lastCheckedAt` | ➖ | 最近一次检查更新时间 |
| `groups[].collapsed` | ➖ | 折叠状态，持久化，默认 `false` |
| `groups[].createdAt` | ✅ | ISO 时间串 |

**未分组的实例不出现在任何 `instanceIds` 里** —— 这正是需求「实例如果没有出现在任何 instanceIds 中，默认归入未分组」的直接实现，无需额外标记。

### 1.2 兼容性

- `manifest.json` **一个字段都不加、不改**。
- 老版本启动器读到 `groups.json` 会直接忽略（它只读 `projects/*/manifest.json`）。
- `groups.json` 缺失 / 损坏 / 字段类型不对 → 走 `normalizeGroupsFile()` 归一化，**绝不抛错**，最差退化成「全部未分组」。
- 实例被删除后，其 id 残留在 `instanceIds` 里：读路径过滤（只保留真实存在的项目 id），
  **写路径也统一归一化后再落盘**（`GroupsStore.save()` 内做），避免脏 id 越积越多。

### 1.3 原子写

复用 `writeJsonAtomic()`（`electron/core/util/atomic-json.ts`）。所有写操作串行化到一个 Promise 队列，避免并发 IPC 造成丢更新（见 §3.1）。

**前置修复**：`writeJsonAtomic` 现在的临时文件名是 `${file}.${process.pid}.${Date.now()}.tmp`，
同进程同一毫秒内的并发写会命中同一个 tmp 路径（后写覆盖先写，`move` 到的内容可能张冠李戴）。
这是**既有全局隐患**（`config-store` / `project-store` 同样在用），不是本功能引入的，
但本功能会加大并发写的概率，所以先修：临时文件名补随机后缀，并补一条并发写回归测试。

---

## 2. 文件清单

### 新增

| 文件 | 职责 |
|---|---|
| `electron/core/store/groups-store.ts` | `GroupsStore`：加载/归一化/原子保存 `groups.json`，写操作串行化 |
| `electron/core/project/group-logic.ts` | **纯函数**：归一化、增删改、移动实例、按母栏分组排序。全部可单测 |
| `electron/core/net/github-release.ts` | 复用 `github-mirror.ts` 拉 release、挑选 zip 资产、版本比较 |
| `src/components/GroupInfoModal.vue` | 母栏「信息」弹窗：改名、填 GitHub 仓库、检查更新 |
| `tests/group-logic.test.ts` | 纯逻辑单测 |
| `tests/groups-store.test.ts` | 落盘 / 损坏自愈 / 原子性 / 串行化单测 |
| `tests/github-release.test.ts` | 资产挑选与版本比较单测 |

### 修改

| 文件 | 改动 |
|---|---|
| `electron/core/util/atomic-json.ts` | 临时文件名补随机后缀（§1.3） |
| `electron/types/index.ts` | 新增 `ProjectGroup`、`GroupsFile`、`GroupedProjects`、`GroupReleaseCheck`、`ReleaseAssetOption`、`GroupProgress` |
| `src/types.ts` | 同步渲染层子集 |
| `electron/ipc/index.ts` | 新增 `group:*` 系列 handler；**`project:list` 不动**；`project:addZip` 增加可选 `groupId` |
| `electron/preload.ts` | 暴露 `group:*` 接口 |
| `electron/core/project/project-service.ts` | `importZip` 增加 `source` 选项（`'zip'` \| `'github'`） |
| `src/App.vue` | 侧栏改为树形列表：母栏行 + 实例行；新建母栏；拖拽入栏；`⋯` 菜单 |
| `src/styles/global.css` | 树形列表、母栏行、三角按钮、拖拽高亮、投放条、信息按钮样式 |
| `README.md` | 记录母栏用法与 `groups.json` 位置 |

---

## 3. 核心逻辑（`group-logic.ts`，纯函数）

### 3.1 归一化 `normalizeGroupsFile(raw, knownProjectIds, now?)`

- `groups` 非数组 → 返回空。
- 逐条：`id` 不合法（`^group_[a-z0-9]{4,32}$`）→ 丢弃；重复 id → 只保留第一次出现；
  `name` 去空格，空 → 用 `未命名母栏`；`name` 超 40 字 → 截断。
- `instanceIds`：去重、去空、**剔除不在 `knownProjectIds` 里的 id**。
- **跨母栏去重**：若同一 id 出现在多个母栏，只保留**第一次出现**的母栏（按数组顺序），后续母栏里删除它。
- `githubRepo`：走下面的白名单清洗；非法则置空。
- `schema` 强制回 `1`。
- 全程不改动入参，垃圾输入（`null` / 数字 / 嵌套怪东西）不抛错。

**`normalizeRepo()` —— 白名单，不是黑名单**（`githubRepo` 会拼进
`https://api.github.com/repos/<repo>/releases`，见 `github-mirror.ts:80`）：

1. 去首尾空格；空 → `''`。
2. 依次剥掉 `git@github.com:`、`https?://`、可选 `www.`、`github.com/`（均大小写不敏感）。
3. 剥掉结尾的 `.git` 与结尾的 `/`。
4. 按 `/` 切分、丢弃空段；**必须恰好 2 段**，否则 `''`。
5. `owner` 必须匹配 `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`；
   `repo` 必须匹配 `^[A-Za-z0-9._-]{1,100}$`。
6. 任一段若全是点（`^\.+$`）→ `''`。
7. 保留原始大小写返回 `owner/repo`。

必须拒绝：`owner/repo/../../../etc`、`owner/repo?x=1`、`owner/repo#a`、`owner repo`、
`../../x`、`justowner`、`a/b/c`、`owner/..`、`https://github.com/owner/repo/tree/main`。
必须接受：`owner/repo`、`owner/repo.git`、`git@github.com:owner/repo.git`、
`https://www.github.com/owner/repo/`、`github.com/owner/repo`（一律归一成 `owner/repo`）。

### 3.2 增删改

- `createGroup(groups, { id, name, githubRepo, now })` → 追加，id 由调用方注入（便于测试确定性）。
- `updateGroup(groups, id, patch)` → 改名 / 改仓库地址；id 不存在则原样返回新数组。
- `deleteGroup(groups, id)` → 删除母栏，**其下实例自动落回「未分组」**（即从 `instanceIds` 消失），不删项目本身。
- `setGroupCollapsed(groups, id, collapsed)`。

### 3.3 拖拽移动 `moveInstance(groups, instanceId, targetGroupId | null)`

- 先从**所有**母栏的 `instanceIds` 中移除该 id；
- `targetGroupId` 为 `null` / `UNGROUPED_ID` / 不存在的母栏 → 不再加入任何母栏（= 未分组）；
- 否则加入目标母栏（顺序无意义，见 §3.4）。

### 3.4 视图组装 `buildGroupedView(groups, projects, order)`

**顺序的唯一来源是 `config.projectOrder`**：`instanceIds` 只管归属，母栏内部顺序一律由
`applyProjectOrder()` 的结果决定。这样「栏内拖拽换位」不需要同时维护两份顺序，也就不会互相打架。

输出渲染层直接可用的结构：

```ts
interface GroupedProjects {
  groups: Array<{ id, name, githubRepo, collapsed, lastSeenTag, lastCheckedAt, projects: ProjectSummary[] }>;
  ungrouped: ProjectSummary[];   // 未分组母栏（虚拟）
}
```

- 入参 `projects` 是**已富化**的 `ProjectSummary[]`（带 `running` / `phase` / `depsState`），
  不是裸 `manifest`——`depsState` 来自 `installer.quickState()`（文件系统探测），
  重复探测会让开销翻倍。`group:list` 与 `project:list` 复用同一份 summaries。
- 母栏内实例：`applyProjectOrder(projects, order)` 的结果按归属过滤；未在顺序表里的保持原相对次序。
- **未分组固定排在最后**。
- 母栏自身顺序 = `groups.json` 里的数组顺序。
- 同一 id 若意外出现在两个母栏，只在**第一个**母栏里出现（防御性去重）。

---

## 4. GitHub Release 集成（`github-release.ts`）

### 4.1 拉取

复用 `fetchGithubReleases({ repo, mirror, log })`（已实现镜像优先 + 失败回退直连）。
镜像前缀取 `config.githubMirror`，Token 取 `config.githubToken`（后端保留字段，UI 不暴露）。

### 4.2 资产挑选 `pickReleaseAssets(release)`

1. 过滤掉明显的非目标资产：`.tar.gz` / `.tar.xz` / `.deb` / `.rpm` / `.dmg` / `.AppImage` / `.exe` 安装器 / `.msi` / `.blockmap` / `.yml` / `.json` / `.txt` / `.sha256` / `.sig` / `.asc` / `latest*`。
2. 在剩下的 `.zip` 里再分档（GitHub 自动生成的 `Source code (zip)` 也按 zip 参与，但标记为源码包）：
   - **优先档**：文件名含 `win` / `windows` / `x64` / `amd64` 且不含 `linux` / `mac` / `darwin` / `arm`；
   - **可用档**：其余 `.zip`（含 `Source code (zip)`）。
3. 返回值：
   - 优先档恰好 1 个 → `{ auto: asset, options: [...] }`，**直接自动使用**；
   - 优先档 0 个、可用档恰好 1 个 → 自动使用；
   - 其余情况（多个候选）→ `auto: null`，由 UI 弹窗列出候选（名称 + 大小 + 是否源码包）让用户选。

### 4.3 版本比较 `compareVersions(a, b)` / `isNewerTag(latest, current)`

- 去 `v` 前缀，按 `.` 切分，数字段数值比较，非数字段字符串比较。
- 预发布后缀（`-beta.1`）视为**低于**同号正式版。
- 无 `lastSeenTag` 记录时，**不谎报「有新版本」**：返回 `hasUpdate: false` + `firstCheck: true`，UI 文案改为「已记录当前最新版本 vX」并把 tag 写入 `lastSeenTag`。

### 4.4 「下载并添加为实例」流程

```
用户点「下载并添加为实例」
  → 选资产（自动 or 弹窗选择）
  → applyGithubMirror(asset.browserDownloadUrl, config.githubMirror)
  → downloadFile() 到 userData/downloads/<name>     [已有下载器，https 限制 + 重定向上限 + 空闲超时]
  → ProjectService.importZip(zipPath, { name: `${repo} ${tag}`, source: 'github' })
  → GroupsStore: 把新实例 id 追加进该母栏 instanceIds；更新 lastSeenTag / lastCheckedAt
  → 广播 project 列表变化
```

- 进度通过 `broadcast('group:progress', ...)` 推给 UI。
- 下载或解压失败：清理半成品，母栏 `instanceIds` **不变**（不留脏数据）。
- 资产是源码包（`Source code (zip)`）时同样允许，`source` 仍标记为 `github`。
- **二选一**：每次检查更新都新增实例会让 `instanceIds` 越堆越长（v1.4.0 / v1.4.1 / v1.4.2 三个实例并存）。
  本期先实现「**添加为新实例**」（保留多版本并存）；「**更新既有实例**」留到后续版本，
  UI 上明确写「添加为新实例」，不暗示会覆盖。

### 4.5 自动归类

`project:addZip` 增加可选 `groupId` 参数；通过某个母栏发起安装时把新实例 id 追加进该母栏。
用户从侧栏底部「导入」发起的（无母栏上下文）则落入未分组。

v1 里另列的 `project:addGithub` **不再单独实现**：GitHub 路径统一走 `group:addRelease`
（内部重新拉一次 release 列表，按 `tag` + `assetName` 解析出真实下载地址）。
渲染层不传任意 URL，避免把「让主进程下载任意地址」暴露成接口。

---

## 5. UI 设计

### 5.1 侧栏结构

```
┌ 项目                                    N ┐
│ [+ 新建母栏]                               │
├──────────────────────────────────────────┤
│ ▾ 卫戍协议                    2/3  [ⓘ] [⋯] │  ← 母栏行：三角 + 名称 + 运行中/总数 + 悬浮按钮
│    ● 主服              [副本]      [⋯]    │  ← 实例行（现有项目卡片 + 悬浮 ⋯ 菜单）
│    ● 测试服            [副本][缺依赖]      │
│ ▸ 工具集                                   │  ← 折叠态
│ ▾ 未分组                                   │  ← 虚拟母栏，恒在最后
│    ● 散落项目                              │
├──────────────────────────────────────────┤
│ [导入 ▾]                        [设置]     │
└──────────────────────────────────────────┘
```

- 母栏行：左侧三角 `▸/▾` 点击展开收起（**只切换折叠，不改变选中项**），中间母栏名，右侧显示
  「运行中 / 总数」小徽标与信息按钮 `ⓘ`（`hover` 或选中时显示）。
- 实例行沿用现有 `.ver-item` 样式，整体右缩进一级。
- 「未分组」母栏在没有任何未分组实例时**隐藏**（避免空行噪音）；**但拖拽期间强制显示**
  （见 §5.2），否则实例全部入栏后没有任何投放目标。
- 顶部「新建母栏」按钮 → 弹出 `GroupInfoModal` 的新建态。

### 5.2 拖拽（在现有长按拖拽基础上扩展）

现有实现：长按 280ms → 拖动 → 用 `elementFromPoint` 找 `[data-project-id]` → 实时重排数组 → 松手 `project:reorder`。

扩展为**统一的拖拽控制器**，命中目标分三类：

- 命中 `[data-project-id]` → **同一个母栏内换位**；跨栏时按「移动到该实例所在栏并插入其位置」处理。
- 命中 `[data-group-id]`（母栏行或母栏的空态区域）→ **移入该母栏**。
- **投放条**：拖拽期间强制渲染一条细的「未分组」投放条（`data-group-id="__ungrouped__"`），
  松手即消失；折叠的母栏同样可作为投放目标（`elementFromPoint` 命中母栏行即可），
  「拖到折叠的母栏上」直接收进去，符合直觉。
- 拖拽中：目标母栏行高亮描边；源实例行半透明（现有 `drag-source` 样式）。
- 松手：一次性提交 `group:reorder({ order, moves })` —— **`order` 是所有母栏按视图顺序拼接后的
  完整 id 列表**（未分组放最后），`moves` 只列发生跨栏的实例。主进程先应用 `moves` 再归一化
  `order`，原子落盘；失败则整体回滚并重新拉取。**一次手势只发一次请求**。

### 5.3 兜底菜单（长按拖拽之外的出路）

拖拽不是唯一入口：实例行的 `⋯` 菜单提供

- 「移出母栏」（→ 未分组）
- 「移入 ▸ 母栏名」（逐一列出其它母栏）

这不只是照顾不便长按的用户，更是**功能性兜底**：`elementFromPoint` 在极端滚动/缩放下的
命中失败不会再让用户卡死。母栏行的 `⋯` 菜单提供「重命名 / 删除母栏」。

### 5.4 母栏「信息」弹窗（`GroupInfoModal.vue`）

- 母栏名称输入框。
- GitHub 仓库地址输入框（占位符 `owner/repo`，支持粘贴完整 URL，失焦时归一化预览）。
- **「检查更新」按钮**：
  - 未填仓库 → 按钮禁用 + 提示「先填写 GitHub 仓库地址」。
  - 检查中 → 转圈 + 「正在检查…」。
  - 有新版本 → 绿色提示条：`发现新版本 vX.Y.Z（当前 vA.B.C）` + `[下载并添加为实例]` 按钮。
  - 无新版本 → 「已是最新版本 vX.Y.Z」。
  - 首次检查（无 `lastSeenTag`）→ 「已记录当前最新版本 vX.Y.Z，下次可对比」。
  - 出错 → 红色提示条 + 错误原因（镜像失败会显示已回退直连）。
- 多资产时，弹窗内嵌一层资产选择列表（单选 + 大小 + 「源码包」标记）。
- 底部：`[删除母栏]`（危险色，二次确认，说明「栏内实例会回到未分组，不会被删除」）、`[取消]`、`[保存]`。

---

## 6. IPC 接口清单

| 通道 | 参数 | 返回 |
|---|---|---|
| `group:list` | — | `GroupedProjects` |
| `group:create` | `{ name, githubRepo? }` | `GroupedProjects` |
| `group:update` | `id, { name?, githubRepo? }` | `GroupedProjects` |
| `group:remove` | `id` | `GroupedProjects` |
| `group:collapse` | `id, collapsed` | `GroupedProjects` |
| `group:move` | `instanceId, groupId \| null` | `GroupedProjects` |
| `group:reorder` | `{ order, moves }` | `GroupedProjects` |
| `group:checkUpdate` | `id` | `GroupReleaseCheck` |
| `group:addRelease` | `id, { tag, assetName }` | `GroupedProjects` |

- 所有写操作返回**最新的完整视图**，UI 直接替换，避免二次请求产生中间态。
- `project:list` **保持不变**（扁平 `ProjectSummary[]`）；`project:reorder` 也保持不变。
- `project:addZip` 增加可选第二参数 `groupId`（向后兼容）。
- 事件：`group:progress` → `GroupProgress`（下载/解压进度）。
- `group:move` 只服务于 §5.3 的兜底菜单单点操作；拖拽只发 `group:reorder`，避免一次手势两次落盘。

---

## 7. 测试计划

`group-logic.test.ts`（纯函数，重点）：
- 归一化：非法 id / 空名 / 超长名 / 重复 id / 跨母栏重复 / 不存在的项目 id / 非数组输入 / `null` 输入。
- `normalizeRepo`：完整 URL、`owner/repo.git`、SSH 写法、纯 `owner/repo`、
  **以及全部负例**（`../` 穿越、`?`、`#`、空格、三段、单段、`.`/`..`、超长）。
- 增删改：删除母栏后实例回到未分组、改名、改仓库、id 不存在时原样返回且不改入参。
- `moveInstance`：跨栏移动、移入未分组、移入不存在的母栏、重复移动幂等。
- `buildGroupedView`：排序表生效、未分组恒在最后、空母栏仍展示、顺序表含失效 id、
  同一 id 出现在两个母栏时只出现一次。
- 版本比较：`v1.2.10 > v1.2.9`、预发布低于正式、无记录时不谎报更新。

`groups-store.test.ts`（落盘）：
- 首次加载文件不存在 → 返回空结构且**不产生副作用**。
- 损坏 JSON → 自愈为空，不抛错。
- 保存后重新加载一致。
- 并发 20 次 `moveInstance` → 最终状态一致，无丢更新（验证串行化）。
- 写入过程不留下 `.tmp` 残留。
- 写路径会把「已不存在的项目 id」清掉。

`atomic-json.test.ts`（或并入 `util.test.ts`）：
- `Date.now` 打桩成固定值，并发多次写同一文件 → 目标文件内容始终是其中一次的完整结果，
  且**不残留 `.tmp`**（v1 的 `${pid}.${Date.now()}` 命名在此时会互相覆盖）。

`github-release.test.ts`：
- 资产挑选各分支（唯一 win zip / 多个候选 / 只有源码包 / 只有非 zip / 空 assets）。
- 镜像拼接复用既有断言。

回归：现有 **12 个测试文件、140 用例通过 + 1 跳过**（`e2e.test.ts` 需 `NL_E2E=1`）**不得回退**。

---

## 8. 验收标准

1. `npm run verify` → **exit 0**（`tsc` + `vue-tsc` + `vitest` 全绿）。
2. `groups.json` 结构、原子写、损坏自愈均有测试覆盖。
3. `manifest.json` 结构零改动（人工核对确认未新增字段）。
4. 树形列表、折叠、拖拽入栏、**投放条**、**兜底菜单**、母栏信息弹窗、检查更新、
   下载并添加为实例全部实现。
5. `npm run build:win` → exit 0，产物为 0.0.3，包内可核对到新代码。
6. README 增补母栏说明。
7. **现有 140 用例通过 + 1 跳过不得回退**（新增用例另计）。

---

## 9. 已知风险与对策

| 风险 | 对策 |
|---|---|
| 拖拽时母栏折叠、目标区域小 | 母栏行整行 + 其下 8px 间隙都作为放置目标；拖拽中给母栏行加最小高度高亮 |
| **未分组隐藏后没有投放目标** | 拖拽期间强制渲染投放条；`⋯` 菜单「移出母栏」兜底（§5.3） |
| 跨栏排序语义混淆（拖到别栏的某个实例上） | 明确规则：**落到哪个实例上，就进入该实例所在的栏，并插到它的位置** |
| 栏内顺序双份维护打架 | 顺序唯一来源 `config.projectOrder`；`instanceIds` 只管归属（§3.4） |
| 并发 IPC 写 `groups.json` 丢更新 | `GroupsStore` 内部 Promise 串行队列，测试用 20 次并发验证 |
| `writeJsonAtomic` 同毫秒撞临时文件 | 临时文件名补随机后缀 + 并发回归测试（§1.3） |
| 实例被删除后 `instanceIds` 残留 | 读路径过滤 + 写路径统一归一化后落盘；删除项目时顺带从 `groups.json` 移除 |
| `githubRepo` 把怪异字符带进 URL | 白名单正则 + 负例测试（§3.1） |
| 大仓库 release 列表很长 | 只展示最新一条的资产 |
| 镜像不支持 API | 已有回退直连逻辑，日志会说明 |
| 下载的是源码包 | 允许，UI 上明确标注「源码包」，导入后照常探测入口 |
| 用户以为母栏随项目目录迁移 | 设置里切换/迁移目录的文案明确写「母栏定义不随项目目录迁移」（§1.1） |

---

## 10. 实施顺序

1. 类型定义（主进程 + 渲染层）
2. `atomic-json.ts` 临时文件名修复 + 并发回归测试
3. `group-logic.ts` + 单测 ← **先绿**
4. `groups-store.ts` + 单测
5. `github-release.ts` + 单测
6. IPC + preload（`project:list` 不动）
7. `project-service.ts` 的 `importZip(..., { source })`
8. UI：侧栏树形 + 拖拽 + 投放条 + 兜底菜单
9. UI：`GroupInfoModal`
10. CSS
11. README
12. `verify` + `build:win` 打包 0.0.3
