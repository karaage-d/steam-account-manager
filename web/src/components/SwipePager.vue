<script setup>
import { ref, computed, watch } from 'vue';

const props = defineProps({
  modelValue: { type: Number, default: 0 },
  count: { type: Number, default: 3 },
});
const emit = defineEmits(['update:modelValue']);

const root = ref(null);
const dragging = ref(false);
const dx = ref(0);

let startX = 0;
let startY = 0;
let startT = 0;
let axis = null;          // null | 'h' | 'v'
/**
 * ★ 必须是 ref（响应式），不能是普通变量 ★
 *
 * 原来是 `let targetIndex = props.modelValue`：
 * trackStyle 这个 computed 里只读到普通变量，Vue 收集不到依赖，
 * 于是「点击顶部标签」时 modelValue 变了、watch 也把 targetIndex 改了，
 * 但 computed 不会重算 —— 页面**纹丝不动**，只有拖动过（dx 变化触发重算）才跟着动。
 * 表现就是"标签高亮了，内容还是上一页"。
 */
const targetIndex = ref(props.modelValue);

watch(() => props.modelValue, (v) => { targetIndex.value = v; });

const trackStyle = computed(() => {
  const step = 100 / props.count;
  return {
    width: `${props.count * 100}%`,
    transform: `translate3d(calc(${-targetIndex.value * step}% + ${dx.value}px), 0, 0)`,
    transition: dragging.value ? 'none' : 'transform 460ms cubic-bezier(0.32, 0.72, 0, 1)',
  };
});

const pageStyle = computed(() => ({ width: `${100 / props.count}%` }));

function go(i) {
  const next = Math.max(0, Math.min(props.count - 1, i));
  if (next !== targetIndex.value) {
    targetIndex.value = next;
    emit('update:modelValue', next);
  }
}

function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  startX = e.clientX;
  startY = e.clientY;
  startT = Date.now();
  axis = null;
  dragging.value = true;
}

function onPointerMove(e) {
  if (!dragging.value) return;
  const mx = e.clientX - startX;
  const my = e.clientY - startY;

  if (axis === null) {
    if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
    axis = Math.abs(mx) > Math.abs(my) ? 'h' : 'v';
    if (axis === 'v') { dragging.value = false; return; }
  }
  if (axis !== 'h') return;

  let v = mx;
  // 到达两端时加阻尼，手感更接近原生
  if ((targetIndex.value === 0 && v > 0) || (targetIndex.value === props.count - 1 && v < 0)) v *= 0.3;
  dx.value = v;
}

function onPointerUp() {
  if (!dragging.value) { dx.value = 0; axis = null; return; }
  const w = root.value?.clientWidth || 1;
  const dt = Math.max(1, Date.now() - startT);
  const velocity = Math.abs(dx.value) / dt;      // px/ms
  const d = dx.value;

  dragging.value = false;
  dx.value = 0;
  axis = null;

  const far = Math.abs(d) > w * 0.18;
  const flick = velocity > 0.45 && Math.abs(d) > 36;
  if (far || flick) {
    if (d < 0) go(targetIndex.value + 1);
    else go(targetIndex.value - 1);
  }
}

/* 触控板横向滑动 */
let wheelAcc = 0;
let wheelLocked = false;
let wheelResetTimer = null;

function onWheel(e) {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;   // 竖向滚动交给页面
  wheelAcc += e.deltaX;
  if (wheelLocked) return;
  if (Math.abs(wheelAcc) > 55) {
    go(wheelAcc > 0 ? targetIndex.value + 1 : targetIndex.value - 1);
    wheelAcc = 0;
    wheelLocked = true;
    setTimeout(() => { wheelLocked = false; }, 420);
  }
  clearTimeout(wheelResetTimer);
  wheelResetTimer = setTimeout(() => { wheelAcc = 0; }, 180);
}

defineExpose({ go });
</script>

<template>
  <div
    ref="root"
    class="pager"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @pointerleave="onPointerUp"
    @wheel.passive="onWheel"
  >
    <div class="pager__track" :class="{ 'pager__track--drag': dragging }" :style="trackStyle">
      <div
        v-for="(_, i) in count"
        :key="i"
        class="pager__page"
        :style="pageStyle"
        :aria-hidden="i !== modelValue"
      >
        <div class="pager__inner">
          <slot :name="`page-${i}`" :index="i" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pager {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
  touch-action: pan-y;
}

.pager__track {
  display: flex;
  height: 100%;
  /* 只在拖拽时提升为合成层。
     常驻 will-change 会把三个界面所有卡片永久塞进一个巨大的合成层，
     层内元素一多，Chromium 会渲染不出来（点击才重绘）。 */
}
.pager__track--drag { will-change: transform; }

.pager__page {
  flex: none;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.pager__inner {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 18px 22px 44px;
}

@media (max-width: 760px) {
  .pager__inner { padding: 14px 12px 36px; }
}
</style>
