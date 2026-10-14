<script setup>
import { toasts, dismiss } from '../lib/toast.js';
</script>

<template>
  <div class="toasts" aria-live="polite">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast glass-strong"
        :class="[`toast--${t.kind}`, { 'toast--big': t.kind === 'milestone' }]"
        @click="dismiss(t.id)"
      >
        <div class="toast__icon">
          <span v-if="t.icon">{{ t.icon }}</span>
          <span v-else-if="t.kind === 'success'">✓</span>
          <span v-else-if="t.kind === 'error'">!</span>
          <span v-else-if="t.kind === 'warn'">!</span>
          <span v-else>i</span>
        </div>
        <div class="toast__body">
          <div v-if="t.title" class="toast__title">{{ t.title }}</div>
          <div class="toast__msg">{{ t.message }}</div>
          <div v-if="t.detail" class="toast__detail">{{ t.detail }}</div>
        </div>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  top: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 300;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  pointer-events: none;
  width: min(440px, calc(100vw - 32px));
}

.toast {
  pointer-events: auto;
  cursor: pointer;
  display: flex;
  gap: 12px;
  align-items: flex-start;
  width: 100%;
  padding: 13px 16px;
  border-radius: var(--r-md);
  transition: transform var(--dur-fast) var(--ease-spring);
}
.toast:hover { transform: scale(1.015); }
.toast:active { transform: scale(0.985); }

.toast__icon {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-size: 13px;
  font-weight: 700;
  background: var(--surface-3);
  color: var(--text-2);
}
.toast--success .toast__icon { background: var(--green-soft); color: var(--green); }
.toast--error .toast__icon { background: var(--red-soft); color: var(--red); }
.toast--warn .toast__icon { background: var(--orange-soft); color: var(--orange); }
.toast--milestone .toast__icon {
  background: linear-gradient(160deg, var(--accent), var(--purple));
  color: #fff;
  width: 30px; height: 30px;
  font-size: 16px;
  box-shadow: 0 6px 18px -6px var(--accent);
}

.toast__body { min-width: 0; flex: 1; }
.toast__title {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 1px;
}
.toast__msg { font-size: 13.5px; line-height: 1.42; color: var(--text); }
.toast--milestone .toast__msg { font-size: 14.5px; font-weight: 620; letter-spacing: -0.02em; }
.toast__detail { font-size: 12px; color: var(--text-2); margin-top: 3px; line-height: 1.45; }

/* 动效 */
.toast-enter-active { transition: all 420ms var(--ease-spring); }
.toast-leave-active { transition: all 220ms var(--ease-out); position: absolute; width: 100%; }
.toast-enter-from { opacity: 0; transform: translateY(-18px) scale(0.94); }
.toast-leave-to { opacity: 0; transform: translateY(-10px) scale(0.96); }
.toast-move { transition: transform 320ms var(--ease-spring); }
</style>
