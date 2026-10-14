<script setup>
import { computed } from 'vue';
import AccountGrid from './AccountGrid.vue';
import { state } from '../lib/store.js';

const emit = defineEmits(['edit', 'delete', 'manual']);

const items = computed(() => state.lists.in_use);
const soonest = computed(() => {
  if (!items.value.length) return null;
  return items.value.reduce((min, a) => {
    const r = a.session?.expiresAt ?? Infinity;
    return r < (min.session?.expiresAt ?? Infinity) ? a : min;
  }, items.value[0]);
});
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <div class="panel__title">
        使用中
        <span class="panel__count">{{ items.length }}</span>
      </div>
      <div class="panel__sub">
        倒计时归零后，账号会自动从「使用中」转入「待改密」，不需要你手动操作。
      </div>
    </div>

    <Transition name="strip">
      <div v-if="items.length" class="livebar glass">
        <span class="dot dot--live" />
        <strong>{{ items.length }}</strong>
        <span>个账号正在使用</span>
        <span v-if="soonest" class="livebar__soon">
          最快结束：{{ soonest.username }} · 剩余
          <span class="mono">{{ Math.floor(Math.max(0, soonest.session.expiresAt - state.now) / 60) }} 分
            {{ String(Math.max(0, soonest.session.expiresAt - state.now) % 60).padStart(2, '0') }} 秒</span>
        </span>
      </div>
    </Transition>

    <AccountGrid
      :items="items"
      empty-icon="⏱️"
      empty-title="当前没有账号在使用"
      empty-text="去「可用」界面挑一个账号，点「开始使用」就会出现在这里，并开始倒计时。"
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

.livebar {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 15px;
  border-radius: var(--r-md);
  background: linear-gradient(120deg, var(--green-soft), var(--surface) 72%);
  border-color: rgba(50, 215, 75, 0.28);
  font-size: 12.5px;
  color: var(--text-2);
  flex-wrap: wrap;
}
.livebar strong { color: var(--green); font-size: 15px; font-weight: 750; }
.livebar__soon {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-3);
}
.livebar__soon .mono { color: var(--green); font-weight: 650; font-variant-numeric: tabular-nums; }

.strip-enter-active, .strip-leave-active { transition: all 320ms var(--ease-spring); }
.strip-enter-from, .strip-leave-to { opacity: 0; transform: translateY(-8px); }
</style>
