<script setup>
defineProps({
  title: { type: String, default: '确认操作' },
  message: { type: String, default: '' },
  detail: { type: String, default: '' },
  confirmText: { type: String, default: '确认' },
  danger: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(['confirm', 'cancel']);
</script>

<template>
  <div class="overlay" @click.self="emit('cancel')">
    <div class="sheet confirm pop-in">
      <div class="sheet__head">
        <div>
          <div class="sheet__title">{{ title }}</div>
          <div v-if="message" class="sheet__sub">{{ message }}</div>
        </div>
      </div>
      <div v-if="detail" class="confirm__detail">{{ detail }}</div>
      <div class="sheet__foot">
        <button class="btn" :disabled="busy" @click="emit('cancel')">取消</button>
        <button
          class="btn"
          :class="danger ? 'btn--danger' : 'btn--primary'"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{ busy ? '处理中…' : confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm { width: min(400px, 100%); }
.confirm__detail {
  margin: 0 24px;
  padding: 11px 13px;
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-2);
  max-height: 180px;
  overflow-y: auto;
}
</style>
