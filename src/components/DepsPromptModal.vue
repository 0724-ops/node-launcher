<template>
  <div class="modal-mask">
    <div class="modal" style="width: 520px">
      <div class="modal-head">
        <div class="modal-title">{{ prompt.message }}</div>
      </div>
      <div class="modal-body">
        <pre
          style="
            white-space: pre-wrap;
            font-family: inherit;
            font-size: 12px;
            line-height: 1.8;
            color: var(--text-dim);
            margin: 0;
          "
          >{{ prompt.detail }}</pre
        >

        <div class="info-box" style="margin-top: 12px">
          安装使用当前内置 Node 与包管理器，默认追加
          <span class="mono">--ignore-scripts</span>（不执行项目自带的安装脚本）。
        </div>
      </div>
      <div class="modal-foot" style="flex-wrap: wrap">
        <button class="btn ghost" @click="emit('decide', 'cancel')">取消启动</button>
        <button class="btn ghost" @click="emit('decide', 'skip')">
          {{ prompt.kind === 'preflight-missing' ? '直接启动' : '放弃' }}
        </button>
        <div class="grow"></div>
        <button class="btn ghost" @click="emit('decide', 'install-allow-scripts')">
          允许安装脚本并安装
        </button>
        <button class="btn primary" @click="emit('decide', 'install')">
          {{ prompt.installLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { DepsPrompt } from '../types';

defineProps<{ prompt: DepsPrompt }>();
const emit = defineEmits<{ (e: 'decide', action: string): void }>();
</script>
