<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal" style="width: 560px">
      <div class="modal-head">
        <div class="modal-title">{{ isCreate ? '新建母栏' : '母栏信息' }}</div>
        <div class="modal-close" @click="emit('close')">✕</div>
      </div>

      <div class="modal-body">
        <div class="field-label">母栏名称</div>
        <input
          class="input"
          v-model="form.name"
          maxlength="40"
          style="margin-top: 6px"
        />
        <div class="field-hint">
          把同类实例收在一起，最多 40 字。<template v-if="!isCreate">
            当前栏内实例：{{ group?.projects.length ?? 0 }} 个
            <template v-if="group?.lastCheckedAt">
              ·上次检查 {{ group.lastCheckedAt.slice(0, 10) }}
            </template>
          </template>
        </div>

        <div class="divider"></div>

        <div class="field-label">GitHub 仓库（可选）</div>
        <input
          class="input"
          v-model="form.githubRepo"
          placeholder="owner/repo"
          style="margin-top: 6px"
        />
        <div class="field-hint">
          支持直接粘贴完整地址（<span class="mono">https://github.com/owner/repo</span>、
          <span class="mono">git@github.com:owner/repo.git</span>），保存时统一归一成
          <span class="mono">owner/repo</span>。留空表示这个母栏不绑定仓库，只做收纳。
        </div>
        <div v-if="repoLooksWrong" class="warn-box" style="margin-top: 6px">
          地址看起来不是 <span class="mono">owner/repo</span> 形式，保存时会被忽略。
        </div>

        <div class="row-between" style="margin-top: 14px">
          <div class="field-label" style="margin: 0">版本检查</div>
          <button
            class="btn mini"
            :disabled="!form.githubRepo.trim() || checking || installing"
            @click="emit('check-update')"
          >
            {{ checking ? '正在检查…' : '检查更新' }}
          </button>
        </div>
        <div v-if="!form.githubRepo.trim()" class="field-hint" style="margin-top: 6px">
          填写仓库地址后可以检查 release，并一键把某个版本下载成本母栏的新实例。
        </div>

        <div v-if="check" class="info-box" style="margin-top: 8px">
          <template v-if="check.firstCheck">
            已记录当前最新版本 <b>{{ check.latestTag }}</b>，下次检查即可对比。
          </template>
          <template v-else-if="check.hasUpdate">
            <b style="color: var(--green)">发现新版本 {{ check.latestTag }}</b>
            <span class="hint">（当前记录 {{ check.currentTag }}）</span>
          </template>
          <template v-else>
            已是最新版本 <b>{{ check.latestTag }}</b>。
          </template>
          <div v-if="check.releaseName || check.publishedAt" class="hint" style="margin-top: 4px">
            {{ check.releaseName || check.latestTag }}
            <template v-if="check.publishedAt"> · {{ check.publishedAt.slice(0, 10) }}</template>
          </div>
        </div>

        <template v-if="check && check.releases.length">
          <div class="field-label" style="margin-top: 12px">选择版本</div>
          <div class="asset-list version-list">
            <label
              v-for="v in check.releases"
              :key="v.tag"
              class="asset-row"
              :class="{ active: selectedTag === v.tag }"
            >
              <input type="radio" :value="v.tag" v-model="selectedTag" />
              <span class="asset-name mono" :title="v.tag">{{ v.tag }}</span>
              <span v-if="v.tag === check.latestTag" class="tag">最新</span>
              <span v-if="v.tag === check.currentTag" class="tag">当前</span>
              <span class="hint version-meta">
                {{ v.publishedAt.slice(0, 10) }} · {{ v.options.length }} 个资产
              </span>
            </label>
          </div>

          <div class="field-label" style="margin-top: 12px">要添加的资产</div>
          <template v-if="selectedVersion && selectedVersion.options.length">
            <div class="asset-list">
              <label
                v-for="opt in selectedVersion.options"
                :key="opt.name"
                class="asset-row"
                :class="{ active: selectedAsset === opt.name }"
              >
                <input type="radio" :value="opt.name" v-model="selectedAsset" />
                <span class="asset-name mono" :title="opt.name">{{ opt.name }}</span>
                <span class="hint">{{ formatSize(opt.size) }}</span>
                <span v-if="opt.sourceArchive" class="tag warn">源码包</span>
                <span v-else-if="selectedVersion.auto?.name === opt.name" class="tag">推荐</span>
              </label>
            </div>
            <div class="actions" style="margin-top: 10px; align-items: center">
              <button
                class="btn primary"
                :disabled="!selectedAsset || installing"
                @click="emit('add-release', { tag: selectedTag, assetName: selectedAsset })"
              >
                {{ installing ? '正在处理…' : '下载并添加为实例' }}
              </button>
              <span class="field-hint">作为新实例加进本母栏，不会覆盖已有的实例。</span>
            </div>
          </template>
          <div v-else class="field-hint" style="margin-top: 8px">
            该版本里没有可用的 zip 资产（安装器 / 非 zip 格式不在范围内）。
          </div>
        </template>

        <div v-if="progress" class="info-box" style="margin-top: 10px">
          {{ progress.message ?? '处理中…' }}
          <div
            v-if="progress.phase === 'downloading'"
            style="margin-top: 6px; height: 4px; background: #ffffff14; border-radius: 2px; overflow: hidden"
          >
            <div
              :style="{
                width: progress.percent + '%',
                height: '100%',
                background: 'var(--accent)',
                transition: 'width .2s',
              }"
            ></div>
          </div>
        </div>

        <div v-if="error" class="error-box" style="margin-top: 10px">{{ error }}</div>
      </div>

      <div class="modal-foot">
        <button
          v-if="!isCreate"
          class="btn ghost danger"
          :disabled="installing"
          @click="emit('delete')"
        >
          删除母栏
        </button>
        <div class="grow"></div>
        <button class="btn ghost" :disabled="installing" @click="emit('close')">取消</button>
        <button
          class="btn primary"
          :disabled="!form.name.trim() || installing"
          @click="emit('save', { name: form.name.trim(), githubRepo: form.githubRepo.trim() })"
        >
          {{ isCreate ? '创建' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type {
  GroupedProjects,
  GroupProgress,
  GroupReleaseCheck,
  ReleaseVersionOption,
} from '../types';

type ViewGroup = GroupedProjects['groups'][number];

const props = defineProps<{
  /** null = 新建态 */
  group: ViewGroup | null;
  check: GroupReleaseCheck | null;
  checking?: boolean;
  installing?: boolean;
  progress?: GroupProgress | null;
  error?: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save', payload: { name: string; githubRepo: string }): void;
  (e: 'delete'): void;
  (e: 'check-update'): void;
  (e: 'add-release', payload: { tag: string; assetName: string }): void;
}>();

const isCreate = computed(() => !props.group);

const form = reactive({
  name: props.group?.name ?? '',
  githubRepo: props.group?.githubRepo ?? '',
});

/** 当前选中的版本 / 资产（检查结果一到就默认选最新版，资产默认选推荐项） */
const selectedTag = ref('');
const selectedAsset = ref('');

const selectedVersion = computed<ReleaseVersionOption | null>(
  () => props.check?.releases.find((v) => v.tag === selectedTag.value) ?? null
);

/** 换版本时重选资产：只有一个候选才自动勾选，多个交给用户挑 */
function applyDefaultAsset(): void {
  selectedAsset.value = selectedVersion.value?.auto?.name ?? '';
}

watch(
  () => props.check,
  (check) => {
    selectedTag.value = check?.latestTag ?? check?.releases[0]?.tag ?? '';
    applyDefaultAsset();
  }
);

watch(selectedTag, () => applyDefaultAsset());

/**
 * 只做「看起来对不对」的提示，真正的白名单清洗在主进程
 * （`core/project/group-logic.ts` 的 `normalizeRepo`）里做，这里不重复那套规则。
 */
const repoLooksWrong = computed(() => {
  const raw = form.githubRepo.trim();
  if (!raw || /^https?:\/\//i.test(raw) || raw.startsWith('git@')) return false;
  const parts = raw.split('/').filter(Boolean);
  return parts.length !== 2 || parts.some((part) => !part.trim());
});

function formatSize(bytes: number): string {
  if (!bytes) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>
