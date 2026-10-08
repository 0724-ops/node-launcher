<template>
  <div class="app">
    <!-- 标题栏 -->
    <header class="titlebar">
      <div class="brand">
        <div class="brand-mark"></div>
        <span>Node Launcher</span>
        <span class="brand-sub">通用 Node 项目启动器</span>
      </div>
      <div class="spacer"></div>
      <div class="win-btns">
        <div class="win-btn" @click="api.minimize()">‒</div>
        <div class="win-btn" @click="api.maximize()">□</div>
        <div class="win-btn close" @click="api.closeWindow()">✕</div>
      </div>
    </header>

    <div class="main">
      <!-- 侧栏 -->
      <aside class="sidebar">
        <div class="sidebar-head">
          <span>项目</span>
          <span>{{ projects.length }}</span>
        </div>

        <div class="sidebar-actions">
          <button class="btn ghost mini" :disabled="busy" @click="openNewGroup">＋ 新建项目</button>
        </div>
        <div v-if="projects.length > 1 || groupView.groups.length" class="sidebar-tip">
          长按项目可拖动排序{{ groupView.groups.length ? '；拖到母栏行可归入' : '' }}
        </div>

        <div class="ver-list" :class="{ dragging: !!draggingId }">
          <template v-for="row in sidebarRows" :key="row.key">
            <!-- 母栏行（含拖拽期间才出现的「未分组」投放条） -->
            <div
              v-if="row.type === 'group'"
              class="group-row"
              :class="{
                'drop-target': dropGroupId === row.groupId,
                ungrouped: row.groupId === UNGROUPED_ID,
                placeholder: row.groupId === UNGROUPED_ID && !row.count,
              }"
              :data-group-id="row.groupId"
            >
              <button
                v-if="row.groupId !== UNGROUPED_ID"
                class="group-caret"
                :title="row.collapsed ? '展开' : '折叠'"
                @click.stop="toggleGroup(row.groupId, !row.collapsed)"
              >
                {{ row.collapsed ? '▸' : '▾' }}
              </button>
              <span v-else class="group-caret ghost">·</span>
              <span class="group-name" :title="row.name">{{ row.name }}</span>
              <span class="group-count">{{ row.runningCount }}/{{ row.count }}</span>
              <button
                v-if="row.groupId !== UNGROUPED_ID"
                class="group-btn"
                title="母栏信息 / 检查更新"
                @click.stop="openGroupInfo(row.groupId)"
              >
                ⓘ
              </button>
              <button
                v-if="row.groupId !== UNGROUPED_ID"
                class="group-btn"
                title="更多"
                @click.stop="toggleMenu($event, `group:${row.groupId}`)"
              >
                ⋯
              </button>
            </div>

            <!-- 实例行 -->
            <div
              v-else-if="row.type === 'project'"
              class="ver-item"
              :class="{
                active: row.project.id === currentId,
                'drag-source': row.project.id === draggingId,
                'in-group': row.groupId !== UNGROUPED_ID,
              }"
              :data-project-id="row.project.id"
              @pointerdown="onItemPointerDown($event, row.project.id)"
              @click="onItemClick(row.project.id)"
            >
              <span class="dot-status" :class="dotClass(row.project.id)"></span>
              <div class="ver-info">
                <div class="ver-name">{{ row.project.name }}</div>
                <div class="ver-meta">
                  <span class="tag" :class="row.project.source">
                    {{ sourceLabel(row.project.source) }}
                  </span>
                  <span v-if="row.project.depsState === 'missing'" class="tag warn">缺依赖</span>
                  <span v-if="row.project.startMode === 'command'" class="tag warn">命令</span>
                </div>
              </div>
              <button
                class="row-btn"
                title="更多（移出 / 移入母栏）"
                @click.stop="toggleMenu($event, `proj:${row.project.id}`)"
              >
                ⋯
              </button>
            </div>

            <!-- 空母栏：也作为投放目标 -->
            <div v-else class="group-empty" :data-group-id="row.groupId">{{ row.text }}</div>
          </template>

          <div v-if="projects.length === 0" class="empty">
            还没有项目<br />用下面的「导入」加入已有项目
          </div>
        </div>

        <div class="sidebar-foot">
          <div class="drop-wrap">
            <button class="btn ghost" :disabled="busy" @click="importMenu = !importMenu">
              导入 ▾
            </button>
            <div v-if="importMenu" class="drop-menu">
              <div class="drop-item" @click="pickImport('copy')">复制目录导入</div>
              <div class="drop-item" @click="pickImport('zip')">从压缩包导入</div>
            </div>
          </div>
          <button class="btn ghost" @click="openSettings">设置</button>
        </div>

        <div v-if="importMenu || menuKey" class="drop-mask" @click="closeMenus"></div>

        <!-- 行内「⋯」菜单：fixed 定位，避免被 .ver-list 的滚动容器裁掉 -->
        <div
          v-if="menuKey"
          class="mini-menu"
          :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px' }"
        >
          <template v-if="menuProject">
            <div
              v-if="menuProjectGroupId !== UNGROUPED_ID"
              class="mini-item"
              @click="moveOutOfGroup(menuProject.id)"
            >
              移出母栏
            </div>
            <div v-if="otherGroups.length" class="mini-sep"></div>
            <div
              v-for="g in otherGroups"
              :key="g.id"
              class="mini-item"
              @click="moveIntoGroup(menuProject.id, g.id)"
            >
              移入「{{ g.name }}」
            </div>
            <div v-if="menuProjectGroupId === UNGROUPED_ID && !otherGroups.length" class="mini-item disabled">
              还没有其它母栏
            </div>
          </template>
          <template v-else-if="menuGroup">
            <div class="mini-item" @click="openGroupInfo(menuGroup.id)">重命名 / 仓库…</div>
            <div class="mini-item danger" @click="deleteGroup(menuGroup.id)">删除母栏</div>
          </template>
        </div>
      </aside>

      <!-- 内容 -->
      <section class="content" v-if="current">
        <div class="card">
          <div class="ver-detail-head">
            <div style="min-width: 0">
              <div class="ver-detail-title">
                <span>{{ current.name }}</span>
                <span class="tag" :class="current.source">{{ sourceLabel(current.source) }}</span>
                <span class="pill" :class="phasePillClass">{{ phaseLabel }}</span>
              </div>
              <div class="ver-detail-sub">{{ current.desc || current.id }}</div>
            </div>
            <div class="actions">
              <button class="btn ghost" @click="openProjectDir">打开目录</button>
              <button class="btn ghost" :disabled="busy || isRunning" @click="openEdit">编辑</button>
              <button class="btn ghost danger" :disabled="busy || isRunning" @click="removeProject">
                删除
              </button>
              <button
                class="btn primary launch"
                :class="{ stop: isRunning }"
                :disabled="busy"
                @click="toggleRun"
              >
                {{ runButtonText }}
              </button>
            </div>
          </div>

          <div class="meta-grid">
            <div class="meta-cell">
              <div class="k">启动模式</div>
              <div class="v">{{ current.startMode === 'node' ? 'Node 直启' : '自定义命令' }}</div>
            </div>
            <div class="meta-cell">
              <div class="k">{{ current.startMode === 'node' ? '入口' : '命令' }}</div>
              <div class="v">{{ current.startMode === 'node' ? current.entry : current.command }}</div>
            </div>
            <div class="meta-cell">
              <div class="k">端口</div>
              <div class="v">{{ state?.port ?? current.port ?? '-' }}</div>
            </div>
            <div class="meta-cell">
              <div class="k">PID</div>
              <div class="v">{{ state?.pid ?? '-' }}</div>
            </div>
          </div>

          <div v-if="state?.message" class="info-box" style="margin-top: 12px">
            {{ state.message }}
          </div>

          <div v-if="state?.phase === 'failed'" class="error-box" style="margin-top: 12px">
            <b>{{ state.category ? ERROR_CATEGORY_LABEL[state.category] : '启动失败' }}</b>
            <div style="margin-top: 4px">{{ state.message }}</div>
            <div style="margin-top: 8px" class="actions">
              <button
                v-if="state.category === 'missing-module'"
                class="btn mini"
                @click="installDepsNow"
              >
                安装依赖
              </button>
              <button
                v-if="state.category === 'native-abi' || state.category === 'build-tool'"
                class="btn mini"
                @click="installDepsNow"
              >
                允许安装脚本并重装依赖
              </button>
              <button class="btn mini ghost" @click="openEdit">检查配置</button>
            </div>
          </div>

          <!-- 访问地址：本机 + 局域网 / 组网地址（逻辑同旧启动器，默认收起省空间） -->
          <div
            v-if="state?.phase === 'ready' && state?.port && current.portMode !== 'none'"
            class="addr-box"
          >
            <div class="addr-row">
              <span class="addr-tag">本机</span>
              <span class="addr-url mono" :title="addrLocal" @click="copy(addrLocal)">
                {{ addrLocal }}
              </span>
              <button
                v-if="lanAddresses.length"
                class="btn mini ghost"
                :title="showAddresses ? '收起局域网地址' : '展开局域网地址'"
                @click="showAddresses = !showAddresses"
              >
                局域网 {{ lanAddresses.length }} {{ showAddresses ? '▴' : '▾' }}
              </button>
              <button class="btn mini ghost sym" title="在浏览器打开" @click="openUrl(addrLocal)">
                ↗
              </button>
              <button class="btn mini ghost sym" title="复制地址" @click="copy(addrLocal)">⧉</button>
            </div>

            <template v-if="showAddresses">
              <div v-for="ip in lanAddresses" :key="ip.address" class="addr-row sub">
                <span class="addr-tag" :class="ip.type" :title="ip.iface">{{ ipLabel(ip) }}</span>
                <span class="addr-url mono" :title="ipUrl(ip)" @click="copy(ipUrl(ip))">
                  {{ ipUrl(ip) }}
                </span>
                <button class="btn mini ghost sym" title="在浏览器打开" @click="openUrl(ipUrl(ip))">
                  ↗
                </button>
                <button class="btn mini ghost sym" title="复制地址" @click="copy(ipUrl(ip))">⧉</button>
              </div>
              <div v-if="loopbackHost" class="addr-note">
                项目绑定的是 {{ current.host }}，只有本机能访问；要用局域网地址，请把 HOST 改成 0.0.0.0。
              </div>
              <div v-else-if="hiddenAddressCount" class="addr-note">
                另有 {{ hiddenAddressCount }} 个虚拟网卡地址（VPN / 虚拟机），可在「设置」里打开显示。
              </div>
            </template>
          </div>

          <!-- 内网穿透（Cloudflare Tunnel，方案同旧启动器） -->
          <div class="info-box" style="margin-top: 12px" v-if="current.portMode !== 'none'">
            <div class="row-between">
              <div>
                <b>内网穿透</b>
                <span class="hint" style="margin-left: 8px">{{ tunnelLabel }}</span>
              </div>
              <div class="actions">
                <template v-if="tunnel?.url">
                  <button class="btn mini ghost sym" title="在浏览器打开" @click="openUrl(tunnel.url)">
                    ↗
                  </button>
                  <button class="btn mini ghost sym" title="复制公网地址" @click="copy(tunnel.url)">
                    ⧉
                  </button>
                </template>
                <button
                  v-if="!tunnelActive"
                  class="btn mini ghost"
                  :disabled="busy || !isRunning"
                  @click="startTunnel"
                >
                  开启穿透
                </button>
                <button v-else class="btn mini ghost danger" @click="stopTunnel">断开穿透</button>
                <button
                  v-if="tunnel?.status === 'running' && tunnel?.message"
                  class="btn mini ghost"
                  @click="recheckTunnel"
                >
                  重新检测
                </button>
              </div>
            </div>
            <div
              v-if="tunnel?.url"
              class="addr-url mono"
              style="margin-top: 6px"
              :title="tunnel.url"
              @click="copy(tunnel.url)"
            >
              {{ tunnel.url }}
            </div>
            <div v-if="tunnel?.message" class="hint" style="margin-top: 6px">
              {{ tunnel.message }}
            </div>
            <div v-if="!isRunning" class="field-hint" style="margin-top: 6px">
              先启动项目，再开启穿透；项目停止时会自动断开。
            </div>
          </div>
        </div>

        <!-- 依赖 -->
        <div class="card">
          <div class="card-head">
            <div class="card-title">依赖</div>
            <div class="actions">
              <button
                class="btn ghost mini"
                :disabled="busy || isRunning || deps?.state === 'installing'"
                @click="installDepsNow"
              >
                {{ deps?.state === 'ready' ? '重装依赖' : '安装依赖' }}
              </button>
              <button
                class="btn ghost mini"
                :disabled="busy || isRunning || deps?.state === 'installing'"
                @click="cleanDeps"
              >
                清理 node_modules
              </button>
              <button
                v-if="deps?.state === 'installing'"
                class="btn ghost mini danger"
                @click="api.cancelDeps(currentId)"
              >
                取消安装
              </button>
            </div>
          </div>
          <div class="inline" style="flex-wrap: wrap; gap: 14px">
            <span class="hint">状态：<span class="pill" :class="depsPillClass">{{ depsLabel }}</span></span>
            <span class="hint">包管理器：{{ deps?.packageManager ?? '-' }}</span>
            <span class="hint">锁文件：{{ deps?.lockfile ?? '无' }}</span>
            <span class="hint">node_modules：{{ formatSize(deps?.nodeModulesSizeBytes ?? 0) }}</span>
            <span class="hint">允许安装脚本：{{ current.allowInstallScripts ? '是' : '否' }}</span>
            <span class="hint" v-if="deps?.lastInstallAt">
              上次安装：{{ new Date(deps.lastInstallAt).toLocaleString() }}
            </span>
          </div>
          <div v-if="deps?.lastError" class="error-box" style="margin-top: 10px">
            上次安装失败：{{ deps.lastError }}
          </div>
          <div
            v-if="!deps?.hasPackageJson"
            class="field-hint"
            style="margin-top: 8px"
          >
            该项目目录下没有 package.json，不做依赖管理。
          </div>
        </div>

        <!-- 运行目录 -->
        <div class="card">
          <div class="card-head">
            <div class="card-title">路径</div>
          </div>
          <div class="code-line">
            项目根：{{ current.rootDir }}<br />
            工作目录：{{ current.source === 'linked' ? current.rootDir : 'projects/' + current.id + '/src'
            }}{{ current.cwd ? '\\' + current.cwd : '' }}
          </div>
        </div>

        <LogPanel
          :entries="currentLogs"
          :metrics="currentMetrics"
          :memory-limit="config?.metricsMemoryLimit ?? 512"
          :running="isRunning"
          @clear="api.clearLogs(currentId)"
          @export="exportLogs"
        />
      </section>

      <section class="content" v-else>
        <div class="card empty">
          还没有项目。<br />
          点左下角「导入」复制目录或从压缩包导入，或在「设置 → 引用目录」里直接登记已有的
          Node 项目（不复制源码）。
        </div>
      </section>
    </div>

    <footer class="statusbar">
      <span class="status-dot" :class="{ online: isRunning }"></span>
      <span>{{ isRunning ? '运行中' : '空闲' }}</span>
      <span>·</span>
      <span>Node {{ appInfo?.node ?? '-' }}</span>
      <span>·</span>
      <span>{{ runtimes.length ? `运行时 v${runtimes[0].version}` : '运行时待准备' }}</span>
      <span class="spacer"></span>
      <span v-if="runtimeProgress" style="color: var(--yellow)">
        {{ runtimeProgress.message ?? '正在准备运行时' }} {{ runtimeProgress.percent }}%
      </span>
      <span>v{{ appInfo?.version ?? '0.0.1' }}</span>
    </footer>

    <EditProjectModal
      v-if="showEdit && current"
      :project="current"
      :detect="detect"
      :busy="busy"
      @close="showEdit = false"
      @save="saveEdit"
    />

    <SettingsModal
      v-if="showSettings && config"
      :config="config"
      :info="appInfo"
      :runtimes="runtimes"
      :preparing="preparingRuntime"
      :busy="busy"
      :root-info="rootInfo"
      :linked-projects="projects"
      @close="showSettings = false"
      @save="saveSettings"
      @ensure-runtime="ensureRuntime"
      @open-data-dir="api.openPath(appInfo?.dataDir ?? '')"
      @link-folder="addFolder('link')"
      @change-root="changeRootDir"
      @migrate-root="migrateRoot"
      @reset-root="resetRootDir"
      @adopt-project="adoptProject"
    />

    <DepsPromptModal
      v-if="prompt"
      :prompt="prompt"
      @decide="decidePrompt"
    />

    <GroupInfoModal
      v-if="groupModal.open"
      :group="groupModalGroup"
      :check="groupModal.check"
      :checking="groupModal.checking"
      :installing="groupModal.installing"
      :progress="groupModal.progress"
      :error="groupModal.error"
      @close="groupModal.open = false"
      @save="saveGroup"
      @delete="deleteGroup(groupModal.groupId)"
      @check-update="checkGroupUpdate"
      @add-release="addGroupRelease"
    />

    <div class="toast" :class="{ show: toastVisible }">{{ toastMsg }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import EditProjectModal from './components/EditProjectModal.vue';
import SettingsModal from './components/SettingsModal.vue';
import DepsPromptModal from './components/DepsPromptModal.vue';
import GroupInfoModal from './components/GroupInfoModal.vue';
import LogPanel from './components/LogPanel.vue';
import {
  ERROR_CATEGORY_LABEL,
  PHASE_LABEL,
  type AppConfig,
  type AppInfo,
  type DepsPrompt,
  type DepsStatus,
  type GroupedProjects,
  type GroupProgress,
  type GroupReleaseCheck,
  type LaunchState,
  type LogEntry,
  type MetricsSnapshot,
  type NetworkInterface,
  type ProjectDetectResult,
  type ProjectSummary,
  type ProjectsRootInfo,
  type RuntimeInfo,
  type TunnelState,
} from './types';

const api = (window as any).api as any;

/* ------------------------------ 状态 ------------------------------ */
const projects = ref<ProjectSummary[]>([]);
const currentId = ref('');

/* ------------------------------ 母栏（分组） ------------------------------ */
const UNGROUPED_ID = '__ungrouped__';
const groupView = ref<GroupedProjects>({ groups: [], ungrouped: [] });
/** 行内「⋯」菜单：key 形如 `proj:<id>` / `group:<id>`；用 fixed 定位，避免被滚动容器裁掉 */
const menuKey = ref<string | null>(null);
const menuPos = reactive({ x: 0, y: 0 });
/** 拖拽时高亮的目标母栏 */
const dropGroupId = ref<string | null>(null);
const groupModal = reactive({
  open: false,
  groupId: '',
  check: null as GroupReleaseCheck | null,
  checking: false,
  installing: false,
  progress: null as GroupProgress | null,
  error: '',
});

type GroupRow = {
  type: 'group';
  key: string;
  groupId: string;
  name: string;
  collapsed: boolean;
  count: number;
  runningCount: number;
};
type ProjectRow = { type: 'project'; key: string; groupId: string; project: ProjectSummary };
type EmptyRow = { type: 'empty'; key: string; groupId: string; text: string };
type SidebarRow = GroupRow | ProjectRow | EmptyRow;
const launchStates = reactive<Record<string, LaunchState>>({});
const metricsMap = reactive<Record<string, MetricsSnapshot>>({});
const logs = ref<LogEntry[]>([]);
const config = ref<AppConfig | null>(null);
const appInfo = ref<AppInfo | null>(null);
const runtimes = ref<RuntimeInfo[]>([]);
const deps = ref<DepsStatus | null>(null);
const detect = ref<ProjectDetectResult | null>(null);
const prompt = ref<DepsPrompt | null>(null);
const runtimeProgress = ref<{ percent: number; message?: string } | null>(null);
const tunnels = reactive<Record<string, TunnelState>>({});
const rootInfo = ref<ProjectsRootInfo | null>(null);
const localIPs = ref<NetworkInterface[]>([]);
const showAddresses = ref(false);

const showEdit = ref(false);
const showSettings = ref(false);
const importMenu = ref(false);
const busy = ref(false);
const preparingRuntime = ref(false);

const toastMsg = ref('');
const toastVisible = ref(false);
let toastTimer: number | null = null;
let unsubscribers: Array<() => void> = [];

/* ------------------------------ 计算属性 ------------------------------ */
const current = computed(() => projects.value.find((p) => p.id === currentId.value) ?? null);
const state = computed(() => launchStates[currentId.value] ?? null);
const currentMetrics = computed(() => metricsMap[currentId.value] ?? null);

const isRunning = computed(() => {
  const phase = state.value?.phase;
  return (
    !!state.value?.pid ||
    phase === 'starting' ||
    phase === 'ready' ||
    phase === 'spawning' ||
    phase === 'preflight' ||
    phase === 'restarting'
  );
});

const phaseLabel = computed(() => PHASE_LABEL[state.value?.phase ?? 'idle']);
const phasePillClass = computed(() => {
  const phase = state.value?.phase ?? 'idle';
  if (phase === 'ready') return 'ok';
  if (phase === 'failed') return 'err';
  if (phase === 'idle') return '';
  return 'info';
});

const depsLabel = computed(() => {
  switch (deps.value?.state) {
    case 'ready':
      return '已就绪';
    case 'missing':
      return '缺少依赖';
    case 'installing':
      return '安装中';
    case 'failed':
      return '安装失败';
    case 'na':
      return '不适用';
    default:
      return '未知';
  }
});

const depsPillClass = computed(() => {
  switch (deps.value?.state) {
    case 'ready':
      return 'ok';
    case 'missing':
      return 'warn';
    case 'failed':
      return 'err';
    case 'installing':
      return 'info';
    default:
      return '';
  }
});

const runButtonText = computed(() => {
  if (busy.value) return '处理中…';
  if (isRunning.value) return state.value?.phase === 'stopping' ? '停止中…' : '停止';
  if (state.value?.phase === 'failed') return '重新启动';
  return '启动';
});

const currentLogs = computed(() =>
  logs.value.filter((l) => l.projectId === currentId.value || l.projectId === null)
);

const tunnel = computed(() => tunnels[currentId.value] ?? null);
const tunnelActive = computed(
  () =>
    tunnel.value?.status === 'running' ||
    tunnel.value?.status === 'starting' ||
    tunnel.value?.status === 'probing'
);
/* ------------------------------ 母栏：侧栏行 ------------------------------ */

/** 把分组视图摊平成渲染行：母栏行 + 实例行（+ 空母栏提示） */
const sidebarRows = computed<SidebarRow[]>(() => {
  const rows: SidebarRow[] = [];
  const runningCount = (list: ProjectSummary[]): number => list.filter((p) => p.running).length;

  for (const group of groupView.value.groups) {
    rows.push({
      type: 'group',
      key: `g:${group.id}`,
      groupId: group.id,
      name: group.name,
      collapsed: group.collapsed,
      count: group.projects.length,
      runningCount: runningCount(group.projects),
    });
    if (group.collapsed) continue;
    if (!group.projects.length) {
      rows.push({ type: 'empty', key: `e:${group.id}`, groupId: group.id, text: '空母栏' });
      continue;
    }
    for (const project of group.projects) {
      rows.push({ type: 'project', key: `p:${project.id}`, groupId: group.id, project });
    }
  }

  // 「未分组」：为空时并不常驻，只在拖拽期间露出来当投放条，否则实例全入栏后就没法移出了
  const ungrouped = groupView.value.ungrouped;
  if (ungrouped.length || draggingId.value) {
    rows.push({
      type: 'group',
      key: 'g:ungrouped',
      groupId: UNGROUPED_ID,
      name: '未分组',
      collapsed: false,
      count: ungrouped.length,
      runningCount: runningCount(ungrouped),
    });
    for (const project of ungrouped) {
      rows.push({ type: 'project', key: `p:${project.id}`, groupId: UNGROUPED_ID, project });
    }
  }
  return rows;
});

const groupModalGroup = computed(
  () => groupView.value.groups.find((g) => g.id === groupModal.groupId) ?? null
);

/**
 * 摊平后的项目顺序：拖拽落盘时提交的 `order` 必须是**完整**列表。
 * 必须直接读 `groupView` 而不是渲染行 —— 折叠母栏里的实例不在渲染行里，
 * 漏掉它们会被 normalizeProjectOrder 判为「未列出」而补到末尾，等于把折叠栏的顺序静默打乱。
 */
function flattenedOrder(): string[] {
  return [
    ...groupView.value.groups.flatMap((g) => g.projects.map((p) => p.id)),
    ...groupView.value.ungrouped.map((p) => p.id),
  ];
}

/** 某个实例现在在哪个母栏（UNGROUPED_ID 表示未分组） */
function findProjectLocation(id: string): { groupId: string; index: number } | null {
  for (const group of groupView.value.groups) {
    const index = group.projects.findIndex((p) => p.id === id);
    if (index >= 0) return { groupId: group.id, index };
  }
  const index = groupView.value.ungrouped.findIndex((p) => p.id === id);
  return index >= 0 ? { groupId: UNGROUPED_ID, index } : null;
}

/** 把某个实例从它所在的列表里摘出来（拖拽预览用，只动本地副本） */
function detachProject(id: string): ProjectSummary | null {
  for (const group of groupView.value.groups) {
    const index = group.projects.findIndex((p) => p.id === id);
    if (index >= 0) return group.projects.splice(index, 1)[0];
  }
  const index = groupView.value.ungrouped.findIndex((p) => p.id === id);
  return index >= 0 ? groupView.value.ungrouped.splice(index, 1)[0] : null;
}

function listOfGroup(groupId: string): ProjectSummary[] {
  if (groupId === UNGROUPED_ID) return groupView.value.ungrouped;
  return groupView.value.groups.find((g) => g.id === groupId)?.projects ?? [];
}

/** 拖拽预览：把正在拖的实例放进目标母栏（`beforeId` 为空则追加到末尾） */
function previewDrop(groupId: string, beforeId?: string): void {
  const id = draggingId.value;
  if (!id) return;
  const item = detachProject(id);
  if (!item) return;
  const target = listOfGroup(groupId);
  const at = beforeId ? target.findIndex((p) => p.id === beforeId) : -1;
  if (at < 0) target.push(item);
  else target.splice(at, 0, item);
}

/* ------------------------------ 访问地址 ------------------------------ */
/** 本机地址：始终展示，与旧启动器的「本机」一行等价 */
const addrLocal = computed(() => `http://localhost:${state.value?.port ?? ''}`);

/** 旧启动器的 showVpnIps 开关：关掉后只留真实局域网地址 */
const lanAddresses = computed(() =>
  localIPs.value.filter((ip) => ip.type === 'lan' || (config.value?.showVirtualIps ?? true))
);

const hiddenAddressCount = computed(() =>
  config.value?.showVirtualIps === false
    ? localIPs.value.filter((ip) => ip.type !== 'lan').length
    : 0
);

/** 绑定 127.0.0.1 时局域网地址根本连不上，展开列表里点明原因 */
const loopbackHost = computed(() => isLoopbackHost(current.value?.host));

function isLoopbackHost(host?: string | null): boolean {
  const h = String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!h) return false;
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

function ipUrl(ip: NetworkInterface): string {
  return `http://${ip.address}:${state.value?.port ?? ''}`;
}

function ipLabel(ip: NetworkInterface): string {
  if (ip.type === 'vpn') return 'VPN';
  if (ip.type === 'virtual') return '虚拟';
  return ip.iface;
}

const tunnelLabel = computed(() => {
  switch (tunnel.value?.status) {
    case 'starting':
      return '正在建立…';
    case 'probing':
      return '地址已分配，正在验证公网可达…';
    case 'running':
      return '已连接公网';
    case 'error':
      return '建立失败';
    default:
      return '未开启';
  }
});

/* ------------------------------ 基础动作 ------------------------------ */
function showToast(msg: string): void {
  toastMsg.value = msg;
  toastVisible.value = true;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastVisible.value = false), 2600);
}

function errText(e: any, fallback: string): string {
  const msg = String(e?.message ?? e ?? '');
  const cleaned = msg.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
  return cleaned || fallback;
}

/** 用主进程返回的完整视图整体替换本地状态（写操作后也走这里，避免中间态） */
function applyGroupView(view: GroupedProjects): void {
  groupView.value = view;
  projects.value = [...view.groups.flatMap((g) => g.projects), ...view.ungrouped];
  if (!projects.value.some((p) => p.id === currentId.value)) {
    currentId.value = projects.value[0]?.id ?? '';
  }
}

async function refreshProjects(): Promise<void> {
  const list: ProjectSummary[] = await api.listProjects();
  try {
    applyGroupView(await api.listGroups());
  } catch {
    // 母栏读取失败不该让侧栏整个空掉：退化成「全部未分组」
    applyGroupView({ groups: [], ungrouped: list });
  }
}

async function refreshDeps(): Promise<void> {
  if (!currentId.value) {
    deps.value = null;
    return;
  }
  try {
    deps.value = await api.getDepsStatus(currentId.value);
  } catch {
    deps.value = null;
  }
}

async function refreshLaunchStates(): Promise<void> {
  const states: LaunchState[] = await api.getLaunchStates();
  for (const s of states) launchStates[s.projectId] = s;
}

/* ------------------------------ 项目 ------------------------------ */
/*
 * 长按拖动排序：
 *   pointerdown → 280ms 内移动超过 6px 视为滚动/点击，取消长按；
 *   长按成立后进入拖动，拖动时实时重排本地数组做预览，松手才落盘。
 * 顺序存在主进程的 config.projectOrder（只影响界面展示）。
 */
const draggingId = ref<string | null>(null);
/** 拖起时所在的母栏：松手后用于判断是否发生了跨栏，只有跨栏才提交 moves */
let dragFromGroupId: string | null = null;
let pressTimer: number | null = null;
let pressOrigin = { x: 0, y: 0 };
let suppressClick = false;

function clearPressTimer(): void {
  if (pressTimer !== null) {
    window.clearTimeout(pressTimer);
    pressTimer = null;
  }
}

function onItemPointerDown(event: PointerEvent, id: string): void {
  if (event.button !== 0 || busy.value) return;
  pressOrigin = { x: event.clientX, y: event.clientY };
  suppressClick = false;
  clearPressTimer();
  pressTimer = window.setTimeout(() => startDrag(id), 280);
  window.addEventListener('pointermove', onEarlyMove);
  window.addEventListener('pointerup', onPressEnd);
  window.addEventListener('pointercancel', onPressEnd);
}

/** 长按判定前就滑动 → 按滚动/点击处理，不进入拖动 */
function onEarlyMove(event: PointerEvent): void {
  if (draggingId.value) return;
  const moved = Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y);
  if (moved > 6) onPressEnd();
}

function startDrag(id: string): void {
  pressTimer = null;
  window.removeEventListener('pointermove', onEarlyMove);
  window.removeEventListener('pointerup', onPressEnd);
  window.removeEventListener('pointercancel', onPressEnd);
  dragFromGroupId = findProjectLocation(id)?.groupId ?? null;
  draggingId.value = id;
  suppressClick = true;
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
}

/**
 * 拖动中：命中实例行 → 插到它前面（跨栏时连母栏一起换）；
 * 命中母栏行（或空母栏提示）→ 收进该母栏末尾。
 * 只改本地副本做预览，松手才落盘。
 */
function onDragMove(event: PointerEvent): void {
  if (!draggingId.value) return;
  event.preventDefault();
  const under = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
  if (!under) return;

  const overProject = under.closest('[data-project-id]')?.getAttribute('data-project-id') ?? null;
  if (overProject && overProject !== draggingId.value) {
    const target = findProjectLocation(overProject);
    if (!target) return;
    dropGroupId.value = target.groupId;
    previewDrop(target.groupId, overProject);
    return;
  }

  const overGroup = under.closest('[data-group-id]')?.getAttribute('data-group-id') ?? null;
  if (overGroup) {
    dropGroupId.value = overGroup;
    // 已经在这个母栏里就不要重复搬动（否则会在光标下反复跳位）
    if (findProjectLocation(draggingId.value)?.groupId !== overGroup) previewDrop(overGroup);
  }
}

async function onDragEnd(): Promise<void> {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  const id = draggingId.value;
  const fromGroup = dragFromGroupId;
  draggingId.value = null;
  dragFromGroupId = null;
  dropGroupId.value = null;
  // 拖动结束后浏览器可能补发一次 click，吞掉它，避免误切换选中项
  window.setTimeout(() => {
    suppressClick = false;
  }, 250);
  if (!id) return;

  const now = findProjectLocation(id);
  // order 必须是所有母栏拼接后的完整 id 列表（未分组在最后）；moves 只列真正跨栏的
  const order = flattenedOrder();
  const moves =
    now && fromGroup && now.groupId !== fromGroup
      ? [{ instanceId: id, groupId: now.groupId === UNGROUPED_ID ? null : now.groupId }]
      : [];

  try {
    applyGroupView(await api.reorderGroups({ order, moves }));
  } catch (e) {
    showToast('保存顺序失败：' + errText(e, '失败'));
    await refreshProjects();
  }
}

function onPressEnd(): void {
  clearPressTimer();
  window.removeEventListener('pointermove', onEarlyMove);
  window.removeEventListener('pointerup', onPressEnd);
  window.removeEventListener('pointercancel', onPressEnd);
  if (draggingId.value) void onDragEnd();
}

function onItemClick(id: string): void {
  if (suppressClick) return;
  currentId.value = id;
}

/* ------------------------------ 母栏动作 ------------------------------ */
function closeMenus(): void {
  menuKey.value = null;
  importMenu.value = false;
}

function toggleMenu(event: MouseEvent, key: string): void {
  if (menuKey.value === key) {
    menuKey.value = null;
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  menuPos.x = Math.min(rect.left, Math.max(8, window.innerWidth - 210));
  menuPos.y = Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 180));
  menuKey.value = key;
}

const menuProject = computed<ProjectSummary | null>(() => {
  if (!menuKey.value?.startsWith('proj:')) return null;
  const id = menuKey.value.slice(5);
  return projects.value.find((p) => p.id === id) ?? null;
});

const menuProjectGroupId = computed(() =>
  menuProject.value ? findProjectLocation(menuProject.value.id)?.groupId ?? null : null
);

const otherGroups = computed(() =>
  groupView.value.groups.filter((g) => g.id !== menuProjectGroupId.value)
);

const menuGroup = computed(() => {
  if (!menuKey.value?.startsWith('group:')) return null;
  const id = menuKey.value.slice(6);
  return groupView.value.groups.find((g) => g.id === id) ?? null;
});

function openNewGroup(): void {
  closeMenus();
  groupModal.groupId = '';
  groupModal.check = null;
  groupModal.progress = null;
  groupModal.error = '';
  groupModal.open = true;
}

function openGroupInfo(id: string): void {
  closeMenus();
  groupModal.groupId = id;
  groupModal.check = null;
  groupModal.progress = null;
  groupModal.error = '';
  groupModal.open = true;
}

async function saveGroup(payload: { name: string; githubRepo: string }): Promise<void> {
  const editing = !!groupModal.groupId;
  busy.value = true;
  try {
    const view: GroupedProjects = editing
      ? await api.updateGroup(groupModal.groupId, payload)
      : await api.createGroup(payload);
    applyGroupView(view);
    groupModal.open = false;
    showToast(editing ? '母栏已更新' : '母栏已创建');
  } catch (e) {
    groupModal.error = errText(e, '保存失败');
  } finally {
    busy.value = false;
  }
}

async function deleteGroup(id: string): Promise<void> {
  const group = groupView.value.groups.find((g) => g.id === id);
  if (!group) return;
  closeMenus();
  const ok = window.confirm(
    `删除母栏「${group.name}」？\n栏内 ${group.projects.length} 个实例会回到「未分组」，项目本身不会被删除。`
  );
  if (!ok) return;
  try {
    applyGroupView(await api.removeGroup(id));
    groupModal.open = false;
    showToast('母栏已删除');
  } catch (e) {
    showToast('删除失败：' + errText(e, '失败'));
  }
}

async function toggleGroup(id: string, collapsed: boolean): Promise<void> {
  try {
    applyGroupView(await api.collapseGroup(id, collapsed));
  } catch (e) {
    showToast('保存折叠状态失败：' + errText(e, '失败'));
  }
}

async function moveOutOfGroup(instanceId: string): Promise<void> {
  closeMenus();
  try {
    applyGroupView(await api.moveToGroup(instanceId, null));
    showToast('已移出母栏');
  } catch (e) {
    showToast('移动失败：' + errText(e, '失败'));
  }
}

async function moveIntoGroup(instanceId: string, groupId: string): Promise<void> {
  closeMenus();
  try {
    applyGroupView(await api.moveToGroup(instanceId, groupId));
  } catch (e) {
    showToast('移动失败：' + errText(e, '失败'));
  }
}

async function checkGroupUpdate(): Promise<void> {
  const id = groupModal.groupId;
  if (!id) return;
  groupModal.checking = true;
  groupModal.error = '';
  groupModal.check = null;
  try {
    groupModal.check = await api.checkGroupUpdate(id);
    // lastSeenTag / lastCheckedAt 已落盘，顺手刷新视图
    applyGroupView(await api.listGroups());
  } catch (e) {
    groupModal.error = errText(e, '检查更新失败');
  } finally {
    groupModal.checking = false;
  }
}

async function addGroupRelease(payload: { tag: string; assetName: string }): Promise<void> {
  const id = groupModal.groupId;
  if (!id) return;
  const before = new Set(projects.value.map((p) => p.id));
  groupModal.installing = true;
  groupModal.error = '';
  groupModal.progress = { groupId: id, phase: 'fetching', percent: 0 };
  try {
    applyGroupView(await api.addGroupRelease(id, payload));
    const added = projects.value.find((p) => !before.has(p.id));
    if (added) currentId.value = added.id;
    groupModal.open = false;
    showToast(added ? `已添加「${added.name}」` : '已添加为实例');
    await refreshDeps();
  } catch (e) {
    groupModal.error = errText(e, '添加失败');
  } finally {
    groupModal.installing = false;
    groupModal.progress = null;
  }
}

async function pickImport(mode: 'copy' | 'zip'): Promise<void> {
  importMenu.value = false;
  if (mode === 'zip') await addZip();
  else await addFolder('copy');
}

async function addFolder(mode: 'link' | 'copy'): Promise<void> {
  const folder = await api.pickFolder();
  if (!folder) return;
  busy.value = true;
  try {
    const manifest = await api.addFolder(folder, mode);
    await refreshProjects();
    currentId.value = manifest.id;
    showToast(mode === 'link' ? '已引用该目录' : '已复制导入');
  } catch (e) {
    showToast('添加失败：' + errText(e, '添加失败'));
  } finally {
    busy.value = false;
  }
}

async function addZip(): Promise<void> {
  const zip = await api.pickZip();
  if (!zip) return;
  busy.value = true;
  try {
    const manifest = await api.addZip(zip);
    await refreshProjects();
    currentId.value = manifest.id;
    showToast('导入完成');
  } catch (e) {
    showToast('导入失败：' + errText(e, '导入失败'));
  } finally {
    busy.value = false;
  }
}

async function removeProject(): Promise<void> {
  if (!current.value) return;
  const isLinked = current.value.source === 'linked';
  const message = isLinked
    ? `确定从列表中移除「${current.value.name}」吗？\n\n（引用模式只移除登记，不会删除你的项目目录）`
    : `确定删除「${current.value.name}」吗？\n\n将删除启动器管理的项目副本，不可恢复。`;
  if (!window.confirm(message)) return;
  busy.value = true;
  try {
    await api.removeProject(current.value.id, !isLinked);
    await refreshProjects();
    showToast('已移除');
  } catch (e) {
    showToast('删除失败：' + errText(e, '删除失败'));
  } finally {
    busy.value = false;
  }
}

async function openEdit(): Promise<void> {
  if (!current.value) return;
  busy.value = true;
  try {
    detect.value = await api.detectProject(current.value.id);
  } catch {
    detect.value = null;
  } finally {
    busy.value = false;
  }
  showEdit.value = true;
}

async function saveEdit(patch: Record<string, unknown>): Promise<void> {
  if (!current.value) return;
  busy.value = true;
  try {
    await api.updateProject(current.value.id, patch);
    await refreshProjects();
    await refreshDeps();
    showEdit.value = false;
    showToast('已保存');
  } catch (e) {
    showToast('保存失败：' + errText(e, '保存失败'));
  } finally {
    busy.value = false;
  }
}

/* ------------------------------ 启动 ------------------------------ */
async function toggleRun(): Promise<void> {
  if (!current.value) return;
  if (isRunning.value) {
    await api.stopProject(current.value.id);
    showToast('已停止');
    return;
  }
  try {
    await api.startProject(current.value.id);
  } catch (e) {
    showToast('启动失败：' + errText(e, '启动失败'));
  }
}

async function decidePrompt(action: string): Promise<void> {
  const target = prompt.value?.projectId;
  prompt.value = null;
  if (!target) return;
  await api.resolveDepsPrompt(target, action);
}

/* ------------------------------ 依赖 ------------------------------ */
async function installDepsNow(): Promise<void> {
  if (!current.value) return;
  if (deps.value) deps.value = { ...deps.value, state: 'installing' };
  try {
    const result = await api.installDeps(current.value.id, {
      allowScripts: current.value.allowInstallScripts,
    });
    if (result?.ok) showToast('依赖安装完成');
    else showToast('依赖安装失败：' + (result?.error ?? '见日志'));
  } catch (e) {
    showToast('依赖安装失败：' + errText(e, '安装失败'));
  } finally {
    await refreshDeps();
  }
}

async function cleanDeps(): Promise<void> {
  if (!current.value) return;
  if (!window.confirm('确定删除该项目的 node_modules 吗？')) return;
  try {
    await api.cleanDeps(current.value.id);
    await refreshDeps();
    showToast('已清理');
  } catch (e) {
    showToast('清理失败：' + errText(e, '清理失败'));
  }
}

/* ------------------------------ 内网穿透 ------------------------------ */
async function startTunnel(): Promise<void> {
  if (!current.value) return;
  try {
    const state = await api.startTunnel(current.value.id);
    if (state?.projectId) tunnels[state.projectId] = state;
    showToast('正在建立内网穿透…');
  } catch (e) {
    showToast('穿透失败：' + errText(e, '失败'));
  }
}

async function stopTunnel(): Promise<void> {
  if (!current.value) return;
  try {
    await api.stopTunnel(current.value.id);
    showToast('已断开穿透');
  } catch (e) {
    showToast('断开失败：' + errText(e, '失败'));
  }
}

/** 自动验证窗口（40s）用完后仍不确定时，手动再跑一轮检测 */
async function recheckTunnel(): Promise<void> {
  if (!current.value) return;
  try {
    const state = await api.recheckTunnel(current.value.id);
    if (state?.projectId) tunnels[state.projectId] = state;
  } catch (e) {
    showToast('重新检测失败：' + errText(e, '失败'));
  }
}

/* ------------------------------ 数据目录与迁移 ------------------------------ */
async function refreshRootInfo(): Promise<void> {
  try {
    rootInfo.value = await api.getRootInfo();
  } catch {
    rootInfo.value = null;
  }
}

/** 更改受管项目目录（立即生效；旧目录有项目时设置页会出现迁移引导） */
async function changeRootDir(): Promise<void> {
  const dir = await api.selectRootDir();
  if (!dir) return;
  busy.value = true;
  try {
    config.value = await api.setConfig({ projectsRootUser: dir });
    await refreshProjects();
    await refreshRootInfo();
    showToast('已切换数据目录');
  } catch (e) {
    showToast('切换失败：' + errText(e, '失败'));
  } finally {
    busy.value = false;
  }
}

async function migrateRoot(): Promise<void> {
  busy.value = true;
  try {
    const res = await api.migrateProjects();
    await refreshProjects();
    await refreshRootInfo();
    showToast(`已迁移 ${res?.moved ?? 0} 个项目`);
  } catch (e) {
    showToast('迁移失败：' + errText(e, '失败'));
  } finally {
    busy.value = false;
  }
}

async function resetRootDir(): Promise<void> {
  busy.value = true;
  try {
    await api.resetRootDir();
    await refreshProjects();
    await refreshRootInfo();
    showToast('已恢复默认数据目录');
  } catch (e) {
    showToast('恢复失败：' + errText(e, '失败'));
  } finally {
    busy.value = false;
  }
}

/** 把「引用目录」的项目迁移为受管副本（复制源码，原目录保留） */
async function adoptProject(id: string): Promise<void> {
  busy.value = true;
  try {
    await api.adoptProject(id);
    await refreshProjects();
    await refreshDeps();
    showToast('已迁移为受管副本');
  } catch (e) {
    showToast('迁移失败：' + errText(e, '失败'));
  } finally {
    busy.value = false;
  }
}

/* ------------------------------ 设置 / 运行时 ------------------------------ */
async function openSettings(): Promise<void> {
  config.value = await api.getConfig();
  appInfo.value = await api.getAppInfo();
  runtimes.value = await api.listRuntimes();
  await refreshRootInfo();
  await refreshProjects();
  showSettings.value = true;
}

async function saveSettings(patch: Record<string, unknown>): Promise<void> {
  try {
    config.value = await api.setConfig(patch);
    showSettings.value = false;
    showToast('设置已保存');
  } catch (e) {
    showToast('保存失败：' + errText(e, '保存失败'));
  }
}

async function ensureRuntime(): Promise<void> {
  preparingRuntime.value = true;
  try {
    await api.ensureRuntime();
    runtimes.value = await api.listRuntimes();
    showToast('运行时已就绪');
  } catch (e) {
    showToast('运行时准备失败：' + errText(e, '失败'));
  } finally {
    preparingRuntime.value = false;
  }
}

/* ------------------------------ 工具 ------------------------------ */
async function openProjectDir(): Promise<void> {
  if (!current.value) return;
  await api.openProjectDir(current.value.id);
}

async function exportLogs(): Promise<void> {
  const file = await api.exportLogs(currentId.value);
  if (file) showToast('已导出到 ' + file);
}

function openUrl(url: string): void {
  void api.openExternal(url);
}

function copy(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => {});
  showToast('已复制 ' + text);
}

/** 网卡地址只在需要时读一次；VPN 网卡可能是启动后才出现的，项目就绪时再刷一次 */
async function refreshIPs(): Promise<void> {
  try {
    localIPs.value = await api.getLocalIPs();
  } catch {
    localIPs.value = [];
  }
}

function dotClass(id: string): string {
  const phase = launchStates[id]?.phase ?? 'idle';
  if (phase === 'ready' || phase === 'starting' || phase === 'spawning') return 'running';
  if (phase === 'preflight' || phase === 'restarting') return 'starting';
  if (phase === 'failed') return 'failed';
  return '';
}

function sourceLabel(source: string): string {
  if (source === 'linked') return '引用';
  if (source === 'zip') return '压缩包';
  if (source === 'github') return 'GitHub';
  if (source === 'git') return 'Git';
  return '副本';
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------ 生命周期 ------------------------------ */
onMounted(async () => {
  config.value = await api.getConfig();
  appInfo.value = await api.getAppInfo();
  runtimes.value = await api.listRuntimes();
  await refreshProjects();
  await refreshLaunchStates();
  await refreshDeps();
  await refreshRootInfo();
  await refreshIPs();

  const tunnelStates: TunnelState[] = await api.getTunnelStates();
  for (const s of tunnelStates) tunnels[s.projectId] = s;

  unsubscribers = [
    api.onLaunchState((s: LaunchState) => {
      launchStates[s.projectId] = s;
      if (s.phase === 'ready') void refreshIPs();
      if (s.phase === 'ready' && s.url && config.value?.openBrowserOnReady) {
        void api.openExternal(s.url);
      }
    }),
    api.onMetrics((m: MetricsSnapshot) => {
      metricsMap[m.projectId] = m;
    }),
    api.onLog((entry: LogEntry) => {
      logs.value.push(entry);
      const max = (config.value?.logBufferLines ?? 5000) * 2;
      if (logs.value.length > max) logs.value.splice(0, logs.value.length - max);
    }),
    api.onLaunchPrompt((p: DepsPrompt) => {
      prompt.value = p;
    }),
    api.onDepsProgress((p: { projectId: string; installing: boolean }) => {
      if (p.projectId === currentId.value) void refreshDeps();
    }),
    api.onRuntimeProgress((p: { percent: number; message?: string }) => {
      runtimeProgress.value = p.percent >= 100 ? null : p;
    }),
    api.onTunnelState((s: TunnelState) => {
      tunnels[s.projectId] = s;
    }),
    api.onGroupProgress((p: GroupProgress) => {
      if (p.groupId === groupModal.groupId) groupModal.progress = p;
    }),
  ];
});

onUnmounted(() => {
  unsubscribers.forEach((fn) => fn());
  unsubscribers = [];
});
</script>
