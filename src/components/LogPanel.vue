<template>
  <div class="card log-card">
    <div class="log-head">
      <div class="card-title">运行日志</div>
      <div class="log-tools">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="chip"
          :class="{ active: tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
        <button class="btn ghost mini" @click="emit('clear')">清空</button>
        <button class="btn ghost mini" @click="emit('export')">导出</button>
        <button
          class="log-jump"
          :class="{ hidden: tab === 'metrics' || atBottom }"
          title="回到底部"
          @click="scrollToBottom"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 3v10M3.5 8.5L8 13l4.5-4.5"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="tab === 'metrics'" class="metrics-body">
      <div class="metrics-cols">
        <div class="metric-col">
          <div class="metric-value">
            {{ (metrics?.cpu ?? 0).toFixed(1) }}<span class="metric-unit">%</span>
          </div>
          <div class="metric-label">CPU 占用率</div>
        </div>
        <div class="metric-col">
          <div class="metric-value" :class="{ danger: memOver }">
            {{ (metrics?.memoryMb ?? 0).toFixed(1) }}<span class="metric-unit">MB</span>
          </div>
          <div class="metric-label">内存占用</div>
          <div class="metric-note" :class="{ danger: memOver }">
            <span>上限: {{ memoryLimit }} MB</span>
            <span v-if="memOver">超过设定上限</span>
          </div>
        </div>
      </div>

      <div class="metrics-bars">
        <div class="metric-bar-row">
          <span class="metric-bar-label">CPU</span>
          <div class="metric-bar-track">
            <div class="metric-bar-fill cpu" :style="{ width: cpuWidth }"></div>
          </div>
        </div>
        <div class="metric-bar-row">
          <span class="metric-bar-label">内存</span>
          <div class="metric-bar-track">
            <div class="metric-bar-fill mem" :class="{ over: memOver }" :style="{ width: memWidth }"></div>
          </div>
        </div>
      </div>

      <div class="metrics-hint hint" style="margin-top: 10px">
        <template v-if="running">
          采集方式：{{ metrics?.strategy === 'reporter' ? '子进程上报' : '进程树轮询' }} ·
          覆盖 {{ metrics?.pidCount ?? 0 }} 个进程
        </template>
        <template v-else>项目未运行，启动后可查看实时占用</template>
      </div>
    </div>

    <div v-else class="log-body" ref="bodyEl" @scroll="onScroll">
      <div v-for="(line, i) in visible" :key="i" class="log-line" :class="line.kind">
        <span class="log-time">{{ formatTime(line.timestamp) }}</span>
        <span class="log-msg">{{ line.msg }}</span>
      </div>
      <div v-if="visible.length === 0" class="empty">暂无日志</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { LogEntry, MetricsSnapshot } from '../types';

const props = defineProps<{
  entries: LogEntry[];
  metrics: MetricsSnapshot | null;
  memoryLimit: number;
  running: boolean;
}>();

const emit = defineEmits<{ (e: 'clear'): void; (e: 'export'): void }>();

type Tab = 'all' | 'out' | 'err' | 'dep' | 'metrics';
const tab = ref<Tab>('all');
const tabs: { key: Tab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'out', label: 'stdout' },
  { key: 'err', label: 'stderr' },
  { key: 'dep', label: '依赖' },
  { key: 'metrics', label: '性能监测' },
];

const bodyEl = ref<HTMLElement | null>(null);
const atBottom = ref(true);

const visible = computed(() => {
  if (tab.value === 'all') return props.entries;
  if (tab.value === 'metrics') return [];
  return props.entries.filter((e) => e.kind === tab.value);
});

const cpuWidth = computed(() => `${Math.min(Math.max(props.metrics?.cpu ?? 0, 0), 100)}%`);
const memPercent = computed(() => {
  const limit = props.memoryLimit || 512;
  return ((props.metrics?.memoryMb ?? 0) / limit) * 100;
});
const memWidth = computed(() => `${Math.min(Math.max(memPercent.value, 0), 100)}%`);
const memOver = computed(() => props.memoryLimit > 0 && (props.metrics?.memoryMb ?? 0) > props.memoryLimit);

watch(
  () => visible.value.length,
  () => {
    if (atBottom.value && tab.value !== 'metrics') {
      void nextTick(scrollToBottom);
    }
  }
);

watch(tab, () => {
  atBottom.value = true;
  void nextTick(scrollToBottom);
});

function onScroll(): void {
  const el = bodyEl.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
}

function scrollToBottom(): void {
  const el = bodyEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function formatTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}
</script>
