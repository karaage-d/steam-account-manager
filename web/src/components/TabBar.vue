<script setup>
/**
 * 一级导航栏
 *
 * 一栏里放两类东西（各自独立位置，互不遮挡）：
 *   1. 三个状态界面：可用 / 使用中 / 待改密 —— 点击或左右滑动切换
 *   2. 「更多」：列出 ATTACHED_SCREENS 里的全部附加界面
 *
 * ★ 为什么这里没有「添加账号」★
 *   它曾经在这里，但和顶栏右上角那个重复 —— 同一个屏幕出现两个一样的按钮只会让人犹豫。
 *   而且「添加账号」是**动作**，而这一排「可用/使用中/待改密」是**状态筛选**，
 *   动作混在状态里语义上也不对。所以统一收到顶栏（那边本来就有「批量导入」这类动作）。
 *
 * ★ 可扩展 ★
 *   状态界面来自 store 的 TABS，列数按 TABS.length 算；
 *   附加界面来自 ATTACHED_SCREENS。加界面不用改这个文件。
 */
import { computed, ref } from 'vue';
import { TABS, ATTACHED_SCREENS, state } from '../lib/store.js';

const props = defineProps({ modelValue: { type: Number, default: 0 } });
const emit = defineEmits(['update:modelValue', 'screen']);

const moreOpen = ref(false);

/** 胶囊滑块的位移按「有几个状态界面」算，不再是写死的 3 */
const pillStyle = computed(() => ({
  transform: `translate3d(${props.modelValue * 100}%, 0, 0)`,
}));

const items = computed(() => TABS.map((t) => ({
  ...t,
  count: state.counts[t.key] ?? 0,
  live: t.key === 'in_use' && (state.counts.in_use ?? 0) > 0,
  warn: t.key === 'pending_change' && (state.counts.pending_change ?? 0) > 0,
})));

function pickScreen(key) {
  moreOpen.value = false;
  emit('screen', key);
}
</script>

<template>
  <div class="tabbar">
    <div class="tabbar__inner" role="tablist">
      <!-- 状态界面（滑块 + 点击切换） -->
      <div class="tabbar__views" :style="{ '--tab-count': items.length }">
        <div class="tabbar__pill" :style="pillStyle" />
        <button
          v-for="(t, i) in items"
          :key="t.key"
          class="tab tab--view"
          :class="{ 'tab--on': modelValue === i }"
          role="tab"
          :aria-selected="modelValue === i"
          @click="emit('update:modelValue', i)"
        >
          <span v-if="t.live" class="dot dot--live" />
          <span v-else-if="t.warn" class="dot dot--warn" />
          <span class="tab__label">{{ t.label }}</span>
          <span class="tab__count">{{ t.count }}</span>
        </button>
      </div>

      <!-- 其余附加界面（可扩展） -->
      <div class="more">
        <button class="tab tab--act" title="更多界面" @click="moreOpen = !moreOpen">
          <span class="tab__label">更多</span>
          <span class="caret">▾</span>
        </button>
        <div v-if="moreOpen" class="more__menu glass-strong" @click.stop>
          <button
            v-for="s in ATTACHED_SCREENS"
            :key="s.key"
            class="more__item"
            @click="pickScreen(s.key)"
          >{{ s.label }}</button>
        </div>
      </div>
    </div>

    <div class="tabbar__hint">{{ items[modelValue]?.hint }}</div>
  </div>
</template>

<style scoped>
.tabbar {
  flex: none;
  padding: 12px 22px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;

  /* ★ 手机端这两行不能删 ★
     和顶栏（TopBar 的 z-index:80）是同一个坑，这里当初漏了：
     .pager 是 position:relative（层级 auto），而这一层原本什么都不是，
     于是 .more__menu 自己的 z-index:60 就只在这一层内部有效，对 .pager 毫无作用。
     后果：小屏上「更多」菜单正好落在列表上方，整个菜单被列表盖住 ——
     6 个附加界面一个都点不到（实测手机端 6 项全被挡，桌面端因位置不重叠才侥幸能点）。
     提到 80：高于 pager 和卡片菜单(40)，低于弹窗(100)与 toast(300)。 */
  position: relative;
  z-index: 80;
}

.tabbar__inner {
  display: flex;
  align-items: stretch;
  gap: 6px;
  width: min(620px, 100%);
  padding: 4px;
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--border);
  backdrop-filter: blur(var(--blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--blur)) saturate(180%);
  box-shadow: var(--glow);
}

/* 状态界面那一组：滑块的范围和百分比计算都只在这组内，不受旁边按钮影响 */
.tabbar__views {
  position: relative;
  display: grid;
  grid-template-columns: repeat(var(--tab-count, 3), 1fr);
  flex: 1;
  min-width: 0;
}

.tabbar__pill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: calc(100% / var(--tab-count, 3));
  border-radius: 11px;
  background: var(--surface-3);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.1) inset, var(--shadow-sm);
  transition: transform 420ms var(--ease-spring);
  pointer-events: none;
}
html[data-theme='light'] .tabbar__pill {
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

.tab {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  border: 0;
  border-radius: 11px;
  background: transparent;
  color: var(--text-2);
  font-size: 13.5px;
  font-weight: 550;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: color var(--dur) var(--ease-out), background var(--dur-fast);
}
.tab:hover { color: var(--text); }
.tab--on { color: var(--text); font-weight: 680; }

/* 动作入口：和状态界面视觉上分开，避免误点 */
.tab--act {
  flex: none;
  padding: 0 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 12.5px;
}
.tab--act:hover { color: var(--text); background: var(--surface-3); }
.tab--act .tab__label { white-space: nowrap; }
.caret { font-size: 10px; opacity: 0.7; }

.tab__count {
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  padding: 1px 6px;
  border-radius: var(--r-pill);
  background: var(--surface-2);
  color: var(--text-3);
  min-width: 20px;
  text-align: center;
  transition: all var(--dur) var(--ease-out);
}
.tab--on .tab__count { background: var(--accent-soft); color: var(--accent); }

.more { position: relative; flex: none; }
.more__menu {
  position: absolute;
  top: 38px;
  right: 0;
  z-index: 60;                    /* 盖在卡片之上，保证点得到 */
  min-width: 176px;
  padding: 5px;
  border-radius: var(--r-md);
  display: flex;
  flex-direction: column;
  gap: 1px;
  box-shadow: var(--shadow-md);
}
.more__item {
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--text);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.more__item:hover { background: var(--surface-3); }

.dot--warn {
  background: var(--orange);
  box-shadow: 0 0 0 0 rgba(255, 159, 10, 0.5);
  animation: pulseWarn 2.1s var(--ease-out) infinite;
}
@keyframes pulseWarn {
  0% { box-shadow: 0 0 0 0 rgba(255, 159, 10, 0.5); }
  70% { box-shadow: 0 0 0 6px rgba(255, 159, 10, 0); }
  100% { box-shadow: 0 0 0 0 rgba(255, 159, 10, 0); }
}

.tabbar__hint {
  font-size: 11.5px;
  color: var(--text-3);
  text-align: center;
  min-height: 16px;
}

@media (max-width: 760px) {
  .tabbar { padding: 10px 12px 0; }
  .tab { font-size: 12px; gap: 4px; }
  .tab--act { padding: 0 7px; font-size: 11.5px; }
}

/* ★ 手机（≤ 620px）★
   这条 hint 说的是「账号闲置中，点【开始使用】进入计时」，
   而下面那个面板又写了一遍「这些账号当前没被使用。点【开始使用】后进入【使用中】并开始倒计时。」
   —— 同一个意思在手机小屏上占了两行，纯浪费竖向空间。这里只留面板那条。 */
@media (max-width: 620px) {
  .tabbar__hint { display: none; }
  .tab { height: 40px; }
}

</style>
