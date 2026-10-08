<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal" style="width: 620px">
      <div class="modal-head">
        <div class="modal-title">编辑项目</div>
        <div class="modal-close" @click="emit('close')">✕</div>
      </div>

      <div class="modal-body">
        <div class="row-between" style="gap: 12px">
          <div style="flex: 1">
            <div class="field-label">项目名称</div>
            <input class="input" v-model="form.name" placeholder="例如 my-api" />
          </div>
          <div style="flex: 1">
            <div class="field-label">备注</div>
            <input class="input" v-model="form.desc" placeholder="可选" />
          </div>
        </div>

        <div class="divider"></div>

        <!-- 启动模式 -->
        <div class="row-between">
          <div class="field-label" style="margin: 0">启动模式</div>
          <div class="seg">
            <div
              class="seg-item"
              :class="{ active: form.startMode === 'node' }"
              @click="form.startMode = 'node'"
            >
              Node 直启
            </div>
            <div
              class="seg-item"
              :class="{ active: form.startMode === 'command' }"
              @click="form.startMode = 'command'"
            >
              自定义命令
            </div>
          </div>
        </div>

        <!-- Node 直启 -->
        <template v-if="form.startMode === 'node'">
          <div style="margin-top: 14px">
            <div class="row-between">
              <div class="field-label" style="margin: 0">入口文件（相对工作目录）</div>
              <button
                class="btn mini ghost"
                :disabled="!detect || detect.entryCandidates.length === 0"
                @click="applyDetectEntry"
              >
                自动探测
              </button>
            </div>
            <input
              class="input"
              v-model="form.entry"
              list="entry-candidates"
              placeholder="例如 server.js 或 src/index.js"
              style="margin-top: 6px"
            />
            <datalist id="entry-candidates">
              <option v-for="c in detect?.entryCandidates ?? []" :key="c" :value="c" />
            </datalist>
            <div class="field-hint">
              以真实 Node 运行，参数逐个传递、不经过 shell，最安全。
            </div>
          </div>

          <div style="margin-top: 14px">
            <div class="field-label">附加启动参数</div>
            <textarea
              class="input"
              v-model="form.argsText"
              placeholder="例如 --port {PORT} --no-local"
            ></textarea>
            <div class="field-hint">
              空格或换行分隔；支持 <span class="mono">{PORT}</span>、
              <span class="mono">{HOST}</span>、<span class="mono">{CWD}</span> 占位符。
            </div>
          </div>
        </template>

        <!-- 自定义命令 -->
        <template v-else>
          <div style="margin-top: 14px">
            <div class="row-between">
              <div class="field-label" style="margin: 0">命令（整条命令行）</div>
              <div class="inline" v-if="scriptNames.length">
                <span class="hint">从 package.json 选择：</span>
                <select class="input" style="width: 150px" @change="onPickScript">
                  <option value="">-- 脚本 --</option>
                  <option v-for="s in scriptNames" :key="s" :value="s">
                    {{ s }}
                  </option>
                </select>
              </div>
            </div>
            <textarea
              class="input"
              v-model="form.command"
              placeholder="例如 npm run dev 或 node --enable-source-maps dist/main.js"
              style="margin-top: 6px; min-height: 72px"
            ></textarea>
            <div class="field-hint">
              由 shell 执行（Windows: cmd /d /s /c），因此支持
              <span class="mono">&amp;&amp;</span>、管道与环境变量展开；此模式下「附加参数」不再生效，
              参数请直接写在命令里。占位符同样可用。
            </div>
          </div>
        </template>

        <div style="margin-top: 14px">
          <div class="row-between">
            <div class="field-label" style="margin: 0">工作目录（相对项目根）</div>
            <div class="inline" v-if="detect?.workspaceCandidates.length">
              <span class="hint">工作区：</span>
              <select class="input" style="width: 170px" @change="onPickWorkspace">
                <option value="">-- 子包 --</option>
                <option v-for="w in detect?.workspaceCandidates ?? []" :key="w" :value="w">
                  {{ w }}
                </option>
              </select>
            </div>
          </div>
          <input
            class="input"
            v-model="form.cwd"
            placeholder="留空 = 项目根目录；monorepo 可填 packages/api"
            style="margin-top: 6px"
          />
        </div>

        <div class="code-line" style="margin-top: 12px">
          将执行：<span style="color: var(--accent)">{{ preview }}</span
          ><br />
          cwd={{ previewCwd }} · shell={{ form.startMode === 'command' ? '是' : '否' }} ·
          Node={{ form.nodeVersion || '默认' }}
        </div>

        <div class="divider"></div>

        <!-- 端口 -->
        <div class="row-between">
          <div class="field-label" style="margin: 0">端口策略</div>
          <div class="seg">
            <div
              class="seg-item"
              :class="{ active: form.portMode === 'inject' }"
              @click="form.portMode = 'inject'"
            >
              注入并检查
            </div>
            <div
              class="seg-item"
              :class="{ active: form.portMode === 'display' }"
              @click="form.portMode = 'display'"
            >
              仅展示
            </div>
            <div
              class="seg-item"
              :class="{ active: form.portMode === 'none' }"
              @click="form.portMode = 'none'"
            >
              不管理
            </div>
          </div>
        </div>

        <div class="inline" style="margin-top: 10px" v-if="form.portMode !== 'none'">
          <div style="width: 130px">
            <div class="field-label">端口</div>
            <input class="input" type="number" min="1" max="65535" v-model.number="form.port" />
          </div>
          <div style="flex: 1">
            <div class="field-label">绑定地址（HOST）</div>
            <input class="input" v-model="form.host" placeholder="0.0.0.0" />
          </div>
        </div>
        <div class="field-hint" v-if="form.portMode === 'inject'">
          启动前检查端口是否可用并注入 <span class="mono">PORT</span>/<span class="mono">HOST</span>；
          被占用时会自动改用空闲端口（可在设置里关闭）。
        </div>
        <div class="field-hint" v-else-if="form.portMode === 'display'">
          不注入任何环境变量，仅用于展示访问地址（适合自己读配置文件的程序）。
        </div>

        <div class="divider"></div>

        <!-- 就绪判定 -->
        <div class="field-label">就绪判定</div>
        <div class="inline">
          <input
            class="input"
            v-model="form.readyPattern"
            placeholder="日志正则，如 Server listening|ready in"
          />
          <input
            class="input"
            v-model="form.healthUrl"
            placeholder="健康检查 URL，如 http://127.0.0.1:{PORT}/health"
          />
        </div>
        <div class="field-hint">
          二选一或都留空。留空时自动用 TCP 探测端口；两者都没有则短暂缓冲后视为已启动。
        </div>

        <div class="inline" style="margin-top: 12px">
          <div style="width: 150px">
            <div class="field-label">就绪超时（毫秒）</div>
            <input class="input" type="number" min="1000" v-model.number="form.readyTimeoutMs" />
          </div>
          <div style="width: 150px">
            <div class="field-label">停止等待（毫秒）</div>
            <input class="input" type="number" min="500" v-model.number="form.stopTimeoutMs" />
          </div>
          <div style="flex: 1">
            <div class="field-label">Node 版本</div>
            <input class="input" v-model="form.nodeVersion" placeholder="默认（22）" />
          </div>
        </div>
        <div class="field-hint">
          只填主版本号（<span class="mono">22</span>）或完整版本（
          <span class="mono">22.11.0</span>）。engines 里的范围写法（
          <span class="mono">&gt;=22</span>）会自动取主版本号。
        </div>

        <div class="divider"></div>

        <!-- 环境变量 -->
        <div class="field-label">环境变量</div>
        <textarea
          class="input"
          v-model="form.envText"
          placeholder="每行一个 KEY=VALUE，例如&#10;NODE_ENV=development"
        ></textarea>
        <div class="field-hint">
          可覆盖默认注入的 PORT/HOST；密钥类字段写入日志时会自动打码。
        </div>

        <div style="margin-top: 12px">
          <div class="field-label">.env 文件（相对工作目录）</div>
          <input class="input" v-model="form.envFile" placeholder="可选，例如 .env.local" />
        </div>

        <div class="divider"></div>

        <!-- 依赖策略 -->
        <div class="field-label">依赖策略</div>
        <div class="inline">
          <select class="input" v-model="form.autoInstallDeps" style="width: 240px">
            <option value="ask">缺少依赖时先询问（推荐）</option>
            <option value="always">自动安装并重试</option>
            <option value="never">从不自动安装</option>
          </select>
        </div>
        <label class="toggle-row">
          <input type="checkbox" class="toggle-check" v-model="form.allowInstallScripts" />
          <span class="toggle-text">
            <span class="toggle-title">允许执行安装脚本（postinstall 等）</span>
            <span class="toggle-sub">
              默认关闭（使用 --ignore-scripts）。来自网络的项目其安装脚本等于任意代码执行，
              仅在确实需要原生模块编译时开启。
            </span>
          </span>
        </label>

        <div class="inline" style="margin-top: 12px">
          <div style="width: 190px">
            <div class="field-label">崩溃重启</div>
            <select class="input" v-model="form.restartMode">
              <option value="never">不自动重启</option>
              <option value="on-failure">失败时自动重启</option>
            </select>
          </div>
          <div style="width: 110px">
            <div class="field-label">最多次数</div>
            <input class="input" type="number" min="0" max="20" v-model.number="form.maxRetries" />
          </div>
          <div style="flex: 1">
            <div class="field-label">退避（毫秒）</div>
            <input class="input" type="number" min="200" v-model.number="form.backoffMs" />
          </div>
        </div>

        <div v-if="error" class="error-box" style="margin-top: 14px">{{ error }}</div>
      </div>

      <div class="modal-foot">
        <button class="btn ghost" @click="emit('close')">取消</button>
        <div class="grow"></div>
        <button class="btn primary" :disabled="busy" @click="handleSave">
          {{ busy ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { ProjectDetectResult, ProjectManifest } from '../types';

const props = defineProps<{
  project: ProjectManifest;
  detect: ProjectDetectResult | null;
  busy?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save', patch: Record<string, unknown>): void;
}>();

const error = ref('');

/**
 * 版本号归一化（与主进程 electron/core/runtime/version-spec.ts 保持一致）。
 * engines 里常见 ">=22" / "^20.11.0"，直接当目录名在 Windows 上会非法，
 * 因此在弹窗里就先收敛成主版本号。
 */
function normalizeSpec(input: string): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';
  const full = raw.match(/^v?(\d+)\.(\d+)\.(\d+)$/i);
  if (full) return `${full[1]}.${full[2]}.${full[3]}`;
  const m = raw.match(/(\d+)/);
  return m ? m[1] : '';
}

const form = reactive({
  name: props.project.name ?? '',
  desc: props.project.desc ?? '',
  startMode: props.project.startMode ?? 'node',
  entry: props.project.entry ?? '',
  command: props.project.command ?? '',
  argsText: (props.project.args ?? []).join(' '),
  cwd: props.project.cwd ?? '',
  nodeVersion: normalizeSpec(props.project.nodeVersion ?? ''),
  portMode: props.project.portMode ?? 'inject',
  port: props.project.port ?? 3000,
  host: props.project.host ?? '0.0.0.0',
  readyPattern: props.project.readyPattern ?? '',
  healthUrl: props.project.healthUrl ?? '',
  readyTimeoutMs: props.project.readyTimeoutMs ?? 60000,
  stopTimeoutMs: props.project.stopTimeoutMs ?? 8000,
  envText: Object.entries(props.project.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n'),
  envFile: props.project.envFile ?? '',
  autoInstallDeps: props.project.autoInstallDeps ?? 'ask',
  allowInstallScripts: props.project.allowInstallScripts ?? false,
  restartMode: props.project.restartPolicy?.mode ?? 'never',
  maxRetries: props.project.restartPolicy?.maxRetries ?? 3,
  backoffMs: props.project.restartPolicy?.backoffMs ?? 2000,
});

const scriptNames = computed(() => Object.keys(props.detect?.scripts ?? {}));

const preview = computed(() => {
  if (form.startMode === 'command') {
    return form.command.trim() || '(未填写命令)';
  }
  const entry = form.entry.trim() || '(未填写入口)';
  const args = form.argsText.trim();
  return `node ${entry}${args ? ' ' + args : ''}`;
});

const previewCwd = computed(() => {
  const base = props.project.source === 'linked' ? props.project.rootDir : 'projects/<id>/src';
  return form.cwd.trim() ? `${base}\\${form.cwd.trim()}` : base;
});

function applyDetectEntry(): void {
  const candidate = props.detect?.suggestedEntry ?? props.detect?.entryCandidates[0];
  if (candidate) form.entry = candidate;
}

function onPickScript(event: Event): void {
  const script = (event.target as HTMLSelectElement).value;
  if (!script) return;
  const pm = props.detect?.packageManager ?? 'npm';
  form.command =
    pm === 'npm' ? `npm run ${script}` : pm === 'bun' ? `bun run ${script}` : `${pm} ${script}`;
}

function onPickWorkspace(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value) form.cwd = value;
}

function parseArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[1] ?? m[2] ?? m[3];
    if (token) out.push(token);
  }
  return out;
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    if (key) out[key] = t.slice(i + 1).trim();
  }
  return out;
}

function handleSave(): void {
  error.value = '';
  const name = form.name.trim();
  if (!name) {
    error.value = '项目名称不能为空';
    return;
  }
  if (form.startMode === 'node' && !form.entry.trim()) {
    error.value = 'Node 直启模式必须填写入口文件（可点「自动探测」）';
    return;
  }
  if (form.startMode === 'command' && !form.command.trim()) {
    error.value = '自定义命令模式必须填写命令';
    return;
  }
  const port = Number(form.port);
  if (form.portMode !== 'none' && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    error.value = '端口需为 1-65535 之间的整数';
    return;
  }
  if (form.healthUrl && !/^https?:\/\//i.test(form.healthUrl.trim())) {
    error.value = '健康检查地址必须以 http:// 或 https:// 开头';
    return;
  }
  const nodeVersion = normalizeSpec(form.nodeVersion);
  if (form.nodeVersion.trim() && !nodeVersion) {
    error.value = 'Node 版本只能填主版本号（如 22）或完整版本（如 22.11.0）';
    return;
  }

  emit('save', {
    name,
    desc: form.desc.trim(),
    startMode: form.startMode,
    entry: form.entry.trim(),
    command: form.command.trim(),
    args: parseArgs(form.argsText),
    cwd: form.cwd.trim(),
    nodeVersion,
    portMode: form.portMode,
    port,
    host: form.host.trim() || '0.0.0.0',
    readyPattern: form.readyPattern.trim(),
    healthUrl: form.healthUrl.trim(),
    readyTimeoutMs: Number(form.readyTimeoutMs) || 60000,
    stopTimeoutMs: Number(form.stopTimeoutMs) || 8000,
    env: parseEnv(form.envText),
    envFile: form.envFile.trim(),
    autoInstallDeps: form.autoInstallDeps,
    allowInstallScripts: form.allowInstallScripts,
    restartPolicy: {
      mode: form.restartMode,
      maxRetries: Number(form.maxRetries) || 0,
      backoffMs: Number(form.backoffMs) || 2000,
    },
  });
}
</script>
