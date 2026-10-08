# 评审：`PLAN-groups.md`（项目列表「母栏 / 分组」收纳）

> 评审方式：把计划书逐条对照**当前代码**核实（不是只读文字）。
> 结论：**方案方向正确、可以按它做**，但有 **2 处自相矛盾**、**3 处会直接出 bug 的缺口**，
> 以及几处可以更省的取舍。下面按「必须改 / 值得改 / 已核实 / 落地顺序」四段给结论与补丁。

---

## 1. 总评

先给结论，再说理由：

| 维度 | 评价 |
| --- | --- |
| 数据设计（`groups.json` 独立、放 userData 根） | ✅ **对**，理由经核实成立（见 §3.1） |
| 「`manifest.json` 零改动」的约束 | ✅ 对，也是这版最值得保留的决定 |
| 纯函数 / 单测 / 原子写 / 串行化 | ✅ 工程习惯与现有代码一致（`atomic-json.ts`、`project-order.ts` 都这么写） |
| `project:list` 的处理 | ❌ **自相矛盾**，会波及现有渲染层（§2.1） |
| 拖拽后 `projectOrder` 的落盘语义 | ⚠️ **未定义**，会静默打乱跨母栏顺序（§2.2） |
| 把实例移出母栏的路径 | ❌ **缺失**，全部实例都入栏后无法解除（§2.3） |
| `writeJsonAtomic` 的并发安全 | ⚠️ 临时文件名会撞车，计划没提（§2.4） |
| `normalizeRepo` 的清洗 | ⚠️ 只写「非法则置空」，没写白名单，输入会拼进 URL（§2.5） |
| 「下载并添加为实例」的长期形态 | ⚠️ 每次更新都堆一个实例，建议补「更新既有实例」（§3.2） |
| 术语与按钮命名 | ⚠️ 「项目」既指实例又要当母栏名，建议统一 |

**建议：先按 §2 的 5 条打补丁再动手**，其余可按 §3 的意见在实现中顺手消化。

---

## 2. 必须改（5 条）

### 2.1 §2 与 §6 冲突：`project:list` 到底改不改？

- §2（修改清单）写：「`project:list` 改为返回带分组信息的数据」。
- §6（IPC 清单）又列出独立的 `group:list` → `GroupedProjects`。

两者只能留一个，而且**保留扁平 `project:list` 更稳**：现有渲染层把它当扁平数组直接用
（`refreshProjects()` 里 `projects.value = await api.listProjects()`，随后 `currentId` 重选、
`current` 查找、拖拽排序、删除后刷新全依赖它）。把它改成树形结构等于同时改「取数协议 + 所有消费点」。

**补丁**：

| 通道 | 改为 |
| --- | --- |
| `project:list` | **保持不变**，仍返回扁平 `ProjectSummary[]` |
| `group:list` | 唯一的分组视图入口，内部自己去 `project:list` 的同一份数据组装 |
| `group:*` 写操作 | 统一返回最新 `GroupedProjects`（这点计划里是对的） |

### 2.2 拖拽落盘语义未定义：`projectOrder` 是**扁平全局表**

现有 `project:reorder` 的实现是：

```ts
const order = normalizeProjectOrder(manifests.map(m => m.id), ids); // 传进来的必须覆盖全部 id
```

也就是**谁调用谁负责给出完整 id 列表**；没列出的 id 会被判为「未列出」补到末尾。
分组后如果 UI 只提交「当前母栏内的顺序」，其它母栏的实例会被静默挪到全局末尾，
用户看到的跨母栏次序就乱了——而且不报错，很难查。

**补丁**：在 §3.4 / §5.2 / §6 明确写一句——

> `group:reorder` 的 `order` 是**所有母栏按视图顺序拼接后的完整 id 列表**（未分组放最后），
> 主进程照旧过 `normalizeProjectOrder` 校验。

测试补一条回归：*只提交部分 id → 其余项目保持原相对次序且不被挪位*。

### 2.3 没有「移出母栏」的路径（§5.1 与 §5.2 互相打架）

- §5.1：「未分组」母栏在没有任何未分组实例时**隐藏**（理由正当，防空行噪音）。
- §5.2：移入未分组靠拖到 `data-group-id="__ungrouped__"`。

推论：当所有实例都已经在某个母栏里时，**未分组行根本不存在，也就没有任何放置目标**，
实例再也拖不出去。长按拖拽还是唯一入口（没有别的菜单），等于死路。

**补丁（两条都做）**：

1. **拖拽期间强制显示投放条**：拖动开始后渲染一条 28px 的虚线「未分组」投放条
   （`data-group-id="__ungrouped__"`），松手即消失——折叠母栏同理，`elementFromPoint`
   命中母栏行即可投放。
2. **兜底菜单**：实例行的 `⋯`（或右键）菜单加「移出母栏 / 移动到…」。这同时照顾了
   不便长按的用户，也让「拖拽」只管排序这一件事。

### 2.4 `writeJsonAtomic` 同毫秒会撞临时文件（计划未覆盖的既有隐患）

现实现（`electron/core/util/atomic-json.ts:20`）：

```ts
const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
```

同进程同一毫秒内的两次写 → **同一个 tmp 路径**，后写覆盖先写，`move` 到的内容可能张冠李戴。

§1.3 用 Promise 串行队列挡 `groups.json`，对本功能够用；但这是**全局**隐患：
`ConfigStore.save` / `ProjectStore` 也在用同一个函数。

**补丁**：加自增序号（或随机后缀）

```ts
let seq = 0;
const tmp = `${file}.${process.pid}.${Date.now()}.${(seq = (seq + 1) % 1e6)}.tmp`;
```

并在 `groups-store.test.ts` 加一条：**同一毫秒内发起多次写 → 目标文件内容始终是其中一次的完整结果，且不残留 `.tmp`**。

### 2.5 `normalizeRepo` 必须是白名单，不能只写「非法则置空」

`githubRepo` 会直接进 URL：

- `github-mirror.ts:80` → `https://api.github.com/repos/${repo}/releases`
- 再经 `applyGithubMirror` 拼镜像前缀

只做「去 `.git`、支持 SSH 写法」而不限定字符集，`../`、`?`、`#`、空格、`@` 都可能进 URL。

**补丁**：

```ts
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
// 显式拒绝 . 与 .. 段；拒绝含 ? # % \ 空白 的输入
```

`§7` 测试计划补负例：`owner/repo/../../../etc`、`owner/repo?x=1`、`owner/repo#a`、
`owner repo`、`../../x`、单段名、超长名、`owner/..`。

---

## 3. 值得改（取舍建议，不强求）

### 3.1 §1.1 的「放 userData 根」理由——核实通过，但要注意双刃剑

- `ProjectStore.list()` 确实用 `isValidId(entry)` 过滤目录（`project-store.ts:56`），
  把 `groups.json` 放进 `projects/` 会被当成一次无效目录扫描 → 计划拒绝的理由**成立**。
- 但「换项目数据目录时母栏定义不跟着走」是**双刃剑**：用户大概率会以为「换目录 = 整包搬家」，
  搬完发现母栏没了会以为数据丢了。
  **建议**：设置里切换 / 迁移目录的提示文案补一句「母栏定义保存在启动器数据目录，
  不随项目目录迁移」，并在迁移完成后的 toast 里也点一句。

### 3.2 「下载并添加为实例」会一直堆实例

每检查一次更新就新增一个实例，`instanceIds` 越拉越长（v1.4.0 / v1.4.1 / v1.4.2 三个实例并存）。
需求原文确实是这么写的，所以不算错，但建议 §4.4 补一句二选一：

- **添加为新实例**（现状，保留多版本并存）；
- **更新既有实例**（对 `manifest` 里记录了同一 `githubRepo` 的实例做覆盖式更新）。

否则「检查更新」在用户心里等于「又装了一个」。

### 3.3 `group:move` 与 `group:reorder` 重叠

一次拖拽同时产生「排序 + 移动」，两个通道 = 两次落盘 + 两次广播 + 两个中间态。
建议：**只保留 `group:reorder({order, moves})`**；`group:move` 仅用于右键菜单的单点操作
（或直接去掉，让菜单也走 `reorder`）。

### 3.4 术语与按钮命名

- 侧栏已有的「导入」= 新增**实例**；README / 界面里「项目」= 实例。
  所以「新建项目（母栏）」这个按钮名会和新语义打架。
  **建议**：按钮叫「**新建母栏**」，弹窗标题「母栏信息」。
- 代码里 `instanceIds` 用 instance、界面叫「项目」——统一成「母栏 / 实例」一套词，
  否则后来读代码的人要绕一圈。

### 3.5 `buildGroupedView` 的入参要用**已富化**的 summaries，别用裸 manifest

`ProjectSummary` 已经带 `running` / `phase` / `depsState`，而 `depsState` 来自
`installer.quickState()`（**文件系统探测**，n 个项目 n 次 I/O）。若 `group:list` 重新拿
裸 `manifest` 再探测一遍，等于把开销翻倍。
**建议**：`buildGroupedView(groups, summaries, order)`，并在 `group:list` 里复用与
`project:list` 同一份 summaries（抽一个内部函数给两个通道用）。

### 3.6 测试基数写错了

§7 写「现有 11 个测试文件必须全绿」。实际 `tests/` 下有 **12 个** `.test.ts`
（含 `e2e.test.ts`，需 `NL_E2E=1` 才跑）。当前基线是
**140 用例通过 + 1 跳过**（12 文件通过 + 1 跳过）。
建议验收标准改成：「现有 140 通过 + 1 跳过不得回退」。

### 3.7 写路径也要归一化，别只靠读路径过滤

§1.2 说「实例被删除后残留在 `instanceIds` 里无害，读路径过滤掉」——读侧确实无害，
但脏 id 会一直**留在文件里**越积越多（用户删了 10 个项目就留 10 个）。
**建议**：`GroupsStore.save()` 落盘前统一过一遍 `normalizeGroupsFile(raw, knownIds)`。

---

## 4. 与现有实现的衔接（已逐条核实）

| 计划里用到的能力 | 现状 | 结论 |
| --- | --- | --- |
| `writeJsonAtomic` / `readJsonSafe` | `core/util/atomic-json.ts` | ✅ 存在，注意 §2.4 |
| `fetchGithubReleases({repo,token,mirror,log})` | `core/net/github-mirror.ts:76`，镜像优先 + 直连回退 | ✅ 可直接复用 |
| `config.githubToken` | `config-store.ts:30` 字段仍在，UI 已移除 | ✅ 正好给 `group:*` 用，无需配置迁移 |
| `applyProjectOrder` / `normalizeProjectOrder` | `core/project/project-order.ts` | ✅ 可被 `buildGroupedView` 复用 |
| `downloadFile(opts)` | `core/download/downloader.ts:49`（https 强制 / 重定向上限 / 空闲超时） | ✅ |
| `project:addZip` | 现只收 `zipPath` | ✅ 扩可选 `groupId` 向后兼容 |
| `importZip(zipPath, name?)` | `project-service.ts:115` 写死 `source:'zip'` | ⚠️ 需新增 `source:'github'` 分支（`SOURCES` 已含该值） |
| `ProjectSummary` 的 `running/phase/depsState` | 已有 | ✅ 母栏「运行中数量」徽标可直接数，但注意 §3.5 |

---

## 5. 建议的最小落地顺序（对 §10 的修订）

1. `group-logic.ts` + 单测（含 `normalizeRepo` 白名单负例、跨母栏去重、**order 拼接语义**）← 先绿
2. `writeJsonAtomic` 加唯一后缀 + 并发回归测试
3. `groups-store.ts` + 单测（损坏自愈 / 20 次并发 / 不残留 `.tmp`）
4. 类型 + IPC（`group:*`；**`project:list` 不动**）+ preload
5. `github-release.ts` + 单测（资产分档、版本比较、首次检查不谎报）
6. UI：树形列表 + 拖拽入栏 + **未分组投放条** + 右键「移出母栏」
7. `GroupInfoModal` + 检查更新（含多资产选择）
8. CSS / README / 手工验收清单
9. `npm run verify` → `build:win` → 0.0.3 打包核对

---

## 6. 一句话总结

数据设计和「不动 `manifest`」的约束是对的，可以直接开工；
把**取数通道（§2.1）、拖拽落盘语义（§2.2）、移出母栏的出路（§2.3）**这三条先钉死，
再顺手补上 `writeJsonAtomic` 的唯一后缀（§2.4）与 `normalizeRepo` 白名单（§2.5），
这个功能就没有结构性风险了。
