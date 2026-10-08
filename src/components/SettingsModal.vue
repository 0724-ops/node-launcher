<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal" style="width: 640px">
      <div class="modal-head">
        <div class="modal-title">设置</div>
        <div class="modal-close" @click="emit('close')">✕</div>
      </div>

      <div class="modal-body">
        <div class="field-label">运行时</div>
        <div class="inline">
          <div style="width: 150px">
            <input class="input" v-model="form.defaultNodeVersion" placeholder="22" />
          </div>
          <span class="hint">默认 Node 主版本</span>
          <div class="grow" style="flex: 1"></div>
          <button class="btn ghost mini" :disabled="preparing" @click="emit('ensure-runtime')">
            {{ preparing ? '准备中…' : '下载/校验运行时' }}
          </button>
        </div>
        <div class="field-hint">
          已就绪：<span class="mono">{{ runtimeLabel }}</span>
        </div>

        <div style="margin-top: 12px">
          <div class="field-label">Node 下载镜像</div>
          <input class="input" v-model="form.nodeDownloadMirror" />
        </div>

        <label class="toggle-row">
          <input type="checkbox" class="toggle-check" v-model="form.preferBundledRuntime" />
          <span class="toggle-text">
            <span class="toggle-title">优先使用随安装包内置的 Node</span>
            <span class="toggle-sub">关闭则优先使用按需下载并缓存的运行时。</span>
          </span>
        </label>

        <div class="divider"></div>

        <div class="field-label">依赖</div>
        <div class="field-label" style="margin-top: 10px">npm registry</div>
        <input class="input" v-model="form.npmRegistry" placeholder="https://registry.npmmirror.com" />
        <div class="field-hint">国内建议使用镜像；留空则用 npm 默认源。</div>

        <div class="inline" style="margin-top: 12px">
          <div style="width: 260px">
            <div class="field-label">新项目的依赖策略</div>
            <select class="input" v-model="form.defaultAutoInstallDeps">
              <option value="ask">缺少依赖时先询问</option>
              <option value="always">自动安装</option>
              <option value="never">从不自动安装</option>
            </select>
          </div>
          <div style="flex: 1">
            <div class="field-label">安装超时（毫秒）</div>
            <input class="input" type="number" v-model.number="form.installTimeoutMs" />
          </div>
        </div>

        <label class="toggle-row">
          <input type="checkbox" class="toggle-check" v-model="form.defaultAllowInstallScripts" />
          <span class="toggle-text">
            <span class="toggle-title">新项目默认允许执行安装脚本</span>
            <span class="toggle-sub">
              默认关闭。开启后新项目安装依赖时会执行 postinstall 等脚本（存在代码执行风险）。
            </span>
          </span>
        </label>

        <div class="divider"></div>

        <div class="field-label">启动</div>
        <div class="inline" style="margin-top: 10px">
          <div style="width: 170px">
            <div class="field-label">默认端口</div>
            <input class="input" type="number" v-model.number="form.defaultPort" />
          </div>
          <div style="flex: 1">
            <div class="field-label">新项目默认端口策略</div>
            <select class="input" v-model="form.defaultPortMode">
              <option value="inject">注入并检查</option>
              <option value="display">仅展示</option>
              <option value="none">不管理</option>
            </select>
          </div>
        </div>

        <label class="toggle-row">
          <input type="checkbox" class="toggle-check" v-model="form.autoPickFreePort" />
          <span class="toggle-text">
            <span class="toggle-title">端口被占用时自动改用空闲端口</span>
          </span>
        </label>

        <label class="toggle-row">
          <input type="checkbox" class="toggle-check" v-model="form.openBrowserOnReady" />
          <span class="toggle-text">
            <span class="toggle-title">就绪后自动打开浏览器</span>
          </span>
        </label>

        <div class="divider"></div>

        <div class="field-label">观测与日志</div>
        <div class="inline" style="margin-top: 10px">
          <div style="flex: 1">
            <div class="field-label">性能采集方式</div>
            <select class="input" v-model="form.metricsStrategy">
              <option value="auto">自动（推荐）</option>
              <option value="reporter">仅子进程上报</option>
              <option value="polling">仅外部轮询（进程树）</option>
            </select>
          </div>
          <div style="width: 140px">
            <div class="field-label">内存上限 (MB)</div>
            <input class="input" type="number" v-model.number="form.metricsMemoryLimit" />
          </div>
        </div>

        <div class="inline" style="margin-top: 12px">
          <div style="width: 170px">
            <div class="field-label">日志缓冲行数</div>
            <input class="input" type="number" v-model.number="form.logBufferLines" />
          </div>
          <label class="toggle-row" style="margin-top: 16px">
            <input type="checkbox" class="toggle-check" v-model="form.logToFile" />
            <span class="toggle-text"><span class="toggle-title">同时写入日志文件</span></span>
          </label>
        </div>

        <div class="divider"></div>

        <!-- 引用目录（原侧栏按钮移到这里） -->
        <div class="field-label">引用目录</div>
        <div class="actions" style="margin-top: 6px">
          <button class="btn ghost" :disabled="busy" @click="emit('link-folder')">
            引用已有目录…
          </button>
        </div>
        <div class="field-hint">
          引用 = 直接登记你已有的项目目录，<b>不复制源码</b>；删除项目时也只移除登记。
          需要纳入启动器管理时，可对下面的引用项目执行「迁移为受管副本」。
        </div>

        <div v-if="linkedProjects.length" class="stack" style="margin-top: 10px">
          <div
            v-for="p in linkedProjects"
            :key="p.id"
            class="row-between"
            style="background: #0f1216; border: 1px solid var(--line-soft); border-radius: 8px; padding: 8px 10px"
          >
            <div style="min-width: 0">
              <div style="font-weight: 500">{{ p.name }}</div>
              <div class="field-hint mono" style="margin-top: 2px">{{ p.rootDir }}</div>
            </div>
            <button
              class="btn mini ghost"
              :disabled="busy || p.running"
              @click="emit('adopt-project', p.id)"
            >
              迁移为受管副本
            </button>
          </div>
        </div>

        <div class="divider"></div>

        <!-- 项目数据目录 + 迁移（逻辑同旧启动器） -->
        <div class="field-label">项目数据目录</div>
        <div class="code-line" style="margin-top: 6px">{{ rootInfo?.currentDir ?? info?.projectsDir }}</div>
        <div class="actions" style="margin-top: 8px">
          <button class="btn ghost mini" :disabled="busy" @click="emit('change-root')">
            更改…
          </button>
          <button class="btn ghost mini" :disabled="busy" @click="emit('reset-root')">
            恢复默认
          </button>
          <button class="btn ghost mini" @click="emit('open-data-dir')">打开数据目录</button>
        </div>
        <div class="field-hint">
          受管项目（复制 / 压缩包 / Git 导入的项目）都放在这里；默认
          <span class="mono">%APPDATA%\node-launcher\projects</span>。引用目录的项目不受影响。
        </div>

        <div v-if="rootInfo?.changed && rootInfo.prevCount > 0" class="warn-box" style="margin-top: 10px">
          <div>
            检测到旧目录 <span class="mono">{{ rootInfo.prevDir }}</span> 中还有
            {{ rootInfo.prevCount }} 个项目，是否迁移过来？
          </div>
          <div class="actions" style="margin-top: 8px">
            <button class="btn mini" :disabled="busy" @click="emit('migrate-root')">
              {{ busy ? '迁移中…' : '立即迁移' }}
            </button>
          </div>
        </div>
        <div v-else-if="rootInfo?.changed" class="field-hint">
          旧目录 <span class="mono">{{ rootInfo.prevDir }}</span> 中没有可迁移的项目，可直接使用新目录。
        </div>

        <div class="divider"></div>

        <!-- 网络加速 + 内网穿透 -->
        <div class="field-label">GitHub 加速</div>
        <input
          class="input"
          v-model="form.githubMirror"
          placeholder="https://gh-proxy.com/"
          style="margin-top: 6px"
        />
        <div class="field-hint">
          镜像前缀 + 原始 GitHub 地址即为加速地址；留空表示直连。仅作用于 release
          资产与 cloudflared 的文件下载（release 列表始终直连 api.github.com）；
          镜像下载失败会自动回退直连。
        </div>

        <label class="toggle-row">
          <input type="checkbox" class="toggle-check" v-model="form.tunnelUseHttp2" />
          <span class="toggle-text">
            <span class="toggle-title">内网穿透使用 HTTP2/TCP（兼容性更好）</span>
            <span class="toggle-sub">
              关闭则使用 QUIC/UDP。首次启用穿透会自动下载 cloudflared 到数据目录。
            </span>
          </span>
        </label>

        <label class="toggle-row">
          <input type="checkbox" class="toggle-check" v-model="form.showVirtualIps" />
          <span class="toggle-text">
            <span class="toggle-title">在「访问地址」里显示虚拟网卡地址</span>
            <span class="toggle-sub">
              勾选后额外展示 ZeroTier / Tailscale / 虚拟机网卡地址，方便异地联机；真实局域网地址始终显示。
            </span>
          </span>
        </label>

        <div class="divider"></div>

        <div class="info-box">
          <div><b>运行环境</b></div>
          <div style="margin-top: 4px">
            应用标识 <span class="mono">{{ info?.isolation.appId }}</span> ·
            数据目录 <span class="mono">{{ info?.dataDir }}</span>
          </div>
          <div class="hint" style="margin-top: 4px">
            Electron {{ info?.electron }} · Node {{ info?.node }} · {{ info?.platform }} {{ info?.arch }}
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn ghost" @click="emit('close')">取消</button>
        <div class="grow"></div>
        <button class="btn primary" @click="emit('save', { ...form })">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue';
import type {
  AppConfig,
  AppInfo,
  ProjectSummary,
  ProjectsRootInfo,
  RuntimeInfo,
} from '../types';

const props = defineProps<{
  config: AppConfig;
  info: AppInfo | null;
  runtimes: RuntimeInfo[];
  preparing?: boolean;
  busy?: boolean;
  rootInfo?: ProjectsRootInfo | null;
  linkedProjects?: ProjectSummary[];
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save', patch: Record<string, unknown>): void;
  (e: 'ensure-runtime'): void;
  (e: 'open-data-dir'): void;
  (e: 'link-folder'): void;
  (e: 'change-root'): void;
  (e: 'migrate-root'): void;
  (e: 'reset-root'): void;
  (e: 'adopt-project', id: string): void;
}>();

const form = reactive({
  defaultNodeVersion: props.config.defaultNodeVersion ?? '22',
  nodeDownloadMirror: props.config.nodeDownloadMirror ?? '',
  preferBundledRuntime: props.config.preferBundledRuntime ?? true,
  npmRegistry: props.config.npmRegistry ?? '',
  defaultAutoInstallDeps: props.config.defaultAutoInstallDeps ?? 'ask',
  defaultAllowInstallScripts: props.config.defaultAllowInstallScripts ?? false,
  installTimeoutMs: props.config.installTimeoutMs ?? 600000,
  defaultPort: props.config.defaultPort ?? 3000,
  defaultPortMode: props.config.defaultPortMode ?? 'inject',
  autoPickFreePort: props.config.autoPickFreePort ?? true,
  openBrowserOnReady: props.config.openBrowserOnReady ?? false,
  metricsStrategy: props.config.metricsStrategy ?? 'auto',
  metricsMemoryLimit: props.config.metricsMemoryLimit ?? 512,
  logBufferLines: props.config.logBufferLines ?? 5000,
  logToFile: props.config.logToFile ?? true,
  githubMirror: props.config.githubMirror ?? '',
  tunnelUseHttp2: props.config.tunnelUseHttp2 ?? true,
  showVirtualIps: props.config.showVirtualIps ?? true,
});

const linkedProjects = computed(() =>
  (props.linkedProjects ?? []).filter((p) => p.source === 'linked')
);

const runtimeLabel = computed(() =>
  props.runtimes.length
    ? props.runtimes
        .map((r) => `v${r.version}(${r.source === 'bundled' ? '内置' : '缓存'}, ABI ${r.abi})`)
        .join('、')
    : '暂无（首次启动时会自动下载）'
);
</script>
