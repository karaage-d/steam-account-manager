<script setup>
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

function toggle() {
  if (props.disabled) return;
  emit('update:modelValue', !props.modelValue);
}
</script>

<template>
  <button
    type="button"
    class="switch"
    :class="{ 'switch--on': modelValue, 'switch--disabled': disabled }"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    @click="toggle"
  >
    <span class="switch__knob" />
  </button>
</template>

<style scoped>
.switch {
  position: relative;
  width: 42px;
  height: 25px;
  flex: none;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--surface-3);
  cursor: pointer;
  padding: 0;
  transition: background var(--dur) var(--ease-out);
  box-shadow: 0 0 0 1px var(--border) inset;
}
.switch--on { background: var(--green); box-shadow: none; }
.switch--disabled { opacity: 0.4; cursor: not-allowed; }
.switch__knob {
  position: absolute;
  top: 2.5px;
  left: 2.5px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3), 0 3px 8px rgba(0, 0, 0, 0.15);
  transition: transform var(--dur) var(--ease-spring);
}
.switch--on .switch__knob { transform: translateX(17px); }
</style>
