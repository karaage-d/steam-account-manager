<script setup>
import { computed, ref, watch } from 'vue';
import AccountCard from './AccountCard.vue';

const props = defineProps({
  items: { type: Array, default: () => [] },
  emptyIcon: { type: String, default: '📦' },
  emptyTitle: { type: String, default: '这里还是空的' },
  emptyText: { type: String, default: '' },
});
const emit = defineEmits(['edit', 'delete', 'manual']);

/* ------------------------------------------------------------------ */
/* ★ 按游戏分组（可折叠）★                                             */
/*                                                                     */
/* 账号一多，一屏铺满卡片就看不出"哪个游戏还有几个号"了。               */
/* 所以按游戏名分成二级栏，点标题折叠/展开。                            */
/*                                                                     */
/* ★ 只有 1 个游戏时不分组 ★                                            */
/*   那时候标题栏纯粹是多余的 —— 一个游戏一个标题，反而多占一行。       */
/*   有两个及以上游戏才分栏。                                          */
/* ------------------------------------------------------------------ */

const UNNAMED = '未填游戏名';

const groups = computed(() => {
  const map = new Map();
  for (const a of props.items) {
    const g = String(a.game || '').trim() || UNNAMED;
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(a);
  }
  return [...map.entries()]
    .map(([game, list]) => ({ game, list }))
    // 未填游戏名的排最后 —— 它是个"待办"，不是正经分类
    .sort((a, b) => {
      if (a.game === UNNAMED) return 1;
      if (b.game === UNNAMED) return -1;
      return a.game.localeCompare(b.game, 'zh-CN');
    });
});

/** 只有一个游戏时不摆标题栏 */
const grouped = computed(() => groups.value.length > 1);

/* ---------------- 折叠状态 ---------------- */
/* 存 localStorage：你收起某个游戏，刷新页面后还是收着的 ✓ */

const STORE_KEY = 'sam.collapsedGames';
const collapsed = ref(new Set());

try {
  const raw = localStorage.getItem(STORE_KEY);
  if (raw) collapsed.value = new Set(JSON.parse(raw));
} catch { /* 隐私模式/脏数据，忽略 */ }

watch(collapsed, (v) => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify([...v])); } catch { /* 忽略 */ }
}, { deep: true });

function isCollapsed(game) { return collapsed.value.has(game); }

function toggle(game) {
  // ★ 必须换一个新 Set ★
  //   Set 的增删不会触发 Vue 的响应式（Vue 3 对 Set 是支持的，
  //   但这里用的是 ref + Set，直接 mutate 有时不刷新）——
  //   换个新对象最稳，反正游戏数量很少，开销可以忽略。
  const next = new Set(collapsed.value);
  if (next.has(game)) next.delete(game); else next.add(game);
  collapsed.value = next;
}

const allCollapsed = computed(() => grouped.value && groups.value.every((g) => isCollapsed(g.game)));

function toggleAll() {
  if (allCollapsed.value) {
    collapsed.value = new Set();
  } else {
    collapsed.value = new Set(groups.value.map((g) => g.game));
  }
}

/** 某个游戏组里有多少个"使用中" —— 标题上顺手标一下，不用展开也知道 */
function countBy(list, state) { return list.filter((a) => a.state === state).length; }
</script>

<template>
  <div v-if="!items.length" class="empty">
    <div class="empty__icon">{{ emptyIcon }}</div>
    <div class="empty__title">{{ emptyTitle }}</div>
    <div v-if="emptyText" class="empty__text">{{ emptyText }}</div>
    <slot name="empty" />
  </div>

  <!-- 只有一个游戏：直接铺卡片，不分组 -->
  <div v-else-if="!grouped" class="grid stagger">
    <AccountCard
      v-for="a in items"
      :key="a.id"
      :account="a"
      @edit="emit('edit', $event)"
      @delete="emit('delete', $event)"
      @manual="emit('manual', $event)"
    />
  </div>

  <!-- 两个及以上游戏：按游戏分栏 -->
  <div v-else class="groups">
    <div class="gbar">
      <span class="gbar__count">{{ groups.length }} 个游戏 · {{ items.length }} 个账号</span>
      <button class="gbar__btn" @click="toggleAll">
        {{ allCollapsed ? '全部展开' : '全部收起' }}
      </button>
    </div>

    <section v-for="g in groups" :key="g.game" class="group" :class="{ 'group--folded': isCollapsed(g.game) }">
      <button class="ghead" @click="toggle(g.game)">
        <span class="ghead__chev" :class="{ 'ghead__chev--open': !isCollapsed(g.game) }">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
               stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
        <span class="ghead__name">{{ g.game }}</span>
        <span class="ghead__n">{{ g.list.length }}</span>

        <!-- 标题上顺手标状态，不用展开就知道有没有人在用 -->
        <span class="ghead__tags">
          <span v-if="countBy(g.list, 'in_use')" class="gtag gtag--live">
            {{ countBy(g.list, 'in_use') }} 使用中
          </span>
          <span v-if="countBy(g.list, 'pending_change')" class="gtag gtag--pending">
            {{ countBy(g.list, 'pending_change') }} 待改密
          </span>
          <span v-if="countBy(g.list, 'available')" class="gtag gtag--idle">
            {{ countBy(g.list, 'available') }} 可用
          </span>
        </span>
      </button>

      <div v-show="!isCollapsed(g.game)" class="grid stagger">
        <AccountCard
          v-for="a in g.list"
          :key="a.id"
          :account="a"
          @edit="emit('edit', $event)"
          @delete="emit('delete', $event)"
          @manual="emit('manual', $event)"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ★ 卡片最小宽度从 300 降到 246 ★
   加上下面 AccountCard 里那轮瘦身，一屏能多放一列左右。 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(246px, 1fr));
  gap: 10px;
  align-items: start;
}

.groups { display: flex; flex-direction: column; gap: 10px; }

/* 顶部那条：几个游戏、几个账号 + 全部展开/收起 */
.gbar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; padding: 0 2px 2px;
}
.gbar__count { font-size: 11.5px; color: var(--text-3); font-weight: 600; }
.gbar__btn {
  border: 0; background: none; cursor: pointer; font-family: inherit;
  font-size: 11.5px; color: var(--accent); font-weight: 600; padding: 2px 4px;
  border-radius: var(--r-xs);
}
.gbar__btn:active { opacity: .6; }

/* ---------------- 二级栏标题 ---------------- */
.group {
  border: 1px solid var(--hairline);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--surface-1);
}
.group--folded { background: transparent; }

.ghead {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 9px 11px; border: 0; cursor: pointer; text-align: left;
  background: var(--surface-2); color: var(--text);
  font-family: inherit; font-size: 13px; font-weight: 640;
  -webkit-tap-highlight-color: transparent;
}
.ghead:active { opacity: .75; }

.ghead__chev {
  display: flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; flex: none;
  color: var(--text-3);
  transition: transform .18s cubic-bezier(.32, .72, 0, 1);
}
.ghead__chev--open { transform: rotate(90deg); color: var(--accent); }

.ghead__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.ghead__n {
  flex: none; font-size: 11px; font-weight: 700; padding: 1px 7px;
  border-radius: var(--r-pill); background: var(--surface-3); color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.ghead__tags { display: flex; gap: 5px; flex: none; }
.gtag { font-size: 10.5px; font-weight: 620; padding: 1px 6px; border-radius: var(--r-pill); white-space: nowrap; }
.gtag--live { background: rgba(48, 209, 88, .16); color: var(--green); }
.gtag--pending { background: rgba(255, 159, 10, .16); color: var(--orange); }
.gtag--idle { background: var(--surface-3); color: var(--text-3); }

/* 展开后的卡片区 */
.group > .grid { padding: 10px; }

/* 窄屏：状态标签藏起来，只留数量，免得标题挤爆 */
@media (max-width: 620px) {
  .grid { grid-template-columns: 1fr; gap: 9px; }
  .ghead__tags { display: none; }
  .group > .grid { padding: 9px; }
}
</style>
