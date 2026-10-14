<script setup>
import { computed } from 'vue';
import AccountGrid from './AccountGrid.vue';
import { state } from '../lib/store.js';

const emit = defineEmits(['edit', 'delete', 'manual']);

const items = computed(() => state.lists.available);
const totalMinutes = computed(() => items.value.reduce((s, a) => s + (a.usageMinutes || 0), 0));
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <div class="panel__title">
        可用
        <span class="panel__count">{{ items.length }}</span>
      </div>
      <div class="panel__sub">
        这些账号当前没被使用。点「开始使用」后进入「使用中」并开始倒计时。
      </div>
    </div>

    <AccountGrid
      :items="items"
      :empty-icon="state.query ? '🔍' : '🗂️'"
      :empty-title="state.query ? '没有匹配的账号' : '还没有可用账号'"
      :empty-text="state.query
        ? '换个关键词试试，搜索会匹配账号、游戏名、备注和邮箱。'
        : '点右上角「添加账号」，填上账号、密码、使用时间、备注和游戏名，它就会出现在这里。'"
      @edit="emit('edit', $event)"
      @delete="emit('delete', $event)"
      @manual="emit('manual', $event)"
    />
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
</style>
