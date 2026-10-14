<script setup>
import { computed } from 'vue';
import AccountGrid from './AccountGrid.vue';
import AiGuide from './AiGuide.vue';
import { state } from '../lib/store.js';

const emit = defineEmits(['edit', 'delete', 'manual']);

const items = computed(() => state.lists.pending_change);
const processing = computed(() => items.value.filter((a) => a.task?.status === 'running').length);
const waiting = computed(() => items.value.filter((a) => !a.task || a.task.status === 'pending').length);
const failed = computed(() => items.value.filter((a) => a.task?.status === 'failed').length);
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <div class="panel__title">
        待改密
        <span class="panel__count">{{ items.length }}</span>
      </div>
      <div class="panel__sub">
        这些账号的使用时间已经用完。改完密码后会自动回到「可用」，重新开始计算。
      </div>
    </div>

    <div v-if="items.length" class="summary">
      <div class="sum">
        <div class="sum__k">等待处理</div>
        <div class="sum__v" style="color:var(--orange)">{{ waiting }}</div>
      </div>
      <div class="sum">
        <div class="sum__k">AI 处理中</div>
        <div class="sum__v" style="color:var(--accent)">{{ processing }}</div>
      </div>
      <div class="sum">
        <div class="sum__k">处理失败</div>
        <div class="sum__v" style="color:var(--red)">{{ failed }}</div>
      </div>
    </div>

    <AccountGrid
      v-if="items.length || !state.query"
      :items="items"
      :empty-icon="state.query ? '🔍' : '✅'"
      :empty-title="state.query ? '没有匹配的账号' : '没有待改密的账号'"
      :empty-text="state.query
        ? '换个关键词试试。'
        : '当使用中的账号倒计时归零，它会自动出现在这里等你改密。'"
      @edit="emit('edit', $event)"
      @delete="emit('delete', $event)"
      @manual="emit('manual', $event)"
    />

    <AiGuide v-if="items.length" />
  </section>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 14px; }
.panel__head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.panel__title {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.025em;
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel__count {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  padding: 1px 8px;
}
.panel__sub { font-size: 12.5px; color: var(--text-3); flex: 1; min-width: 200px; }

.summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; max-width: 460px; }
.sum {
  padding: 10px 13px;
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--border);
}
.sum__k { font-size: 11px; color: var(--text-3); font-weight: 600; }
.sum__v {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.035em;
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
  line-height: 1.1;
}
</style>
