<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { state, refresh, setTheme, lockVault } from '../lib/store.js';

const emit = defineEmits(['add', 'import', 'export', 'today', 'settings', 'mail', 'api', 'xgj', 'help']);

const searchEl = ref(null);
const menuOpen = ref(false);
const root = ref(null);
let timer = null;

const todayCount = computed(() => state.stats?.todaySessions ?? 0);
/**
 * 今日「已改密」次数 —— 需求第 5 条的口径：
 *   「今日使用账号次数（自动修改密码或手动修改密码并返回密码表单的次数）」
 * 和「已用」（开始使用次数）是两个口径，都显示出来，免得对不上账。
 */
const todayChanges = computed(() => state.stats?.todayChanges ?? 0);
const nextIndex = computed(() => (state.stats?.todaySessions ?? 0) + 1);

function onSearch() {
  clearTimeout(timer);
  timer = setTimeout(() => refresh().catch(() => {}), 200);
}

function clearSearch() {
  state.query = '';
  refresh().catch(() => {});
  searchEl.value?.focus();
}

function onDocClick(e) {
  if (menuOpen.value && root.value && !root.value.contains(e.target)) menuOpen.value = false;
}

function onKey(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
  if (e.key === '/' && !typing) { e.preventDefault(); searchEl.value?.focus(); }
  if (e.key === 'Escape' && document.activeElement === searchEl.value) clearSearch();
  if (e.key === 'n' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); emit('add'); }
  if (e.key === 'l' && (e.metaKey || e.ctrlKey) && state.unlocked) { e.preventDefault(); lockVault(); }
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  document.addEventListener('click', onDocClick);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  document.removeEventListener('click', onDocClick);
});

function pick(fn) {
  menuOpen.value = false;
  fn();
}
</script>

<template>
  <header ref="root" class="topbar">
    <div class="brand">
      <div class="brand__mark">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
             stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3.5" y="10.5" width="17" height="10.5" rx="3" />
          <path d="M7.5 10.5V7.4a4.5 4.5 0 0 1 9 0v3.1" />
        </svg>
      </div>
      <div class="brand__text">
        <div class="brand__title">Steam 账号库</div>
        <div class="brand__sub">{{ state.stats?.total ?? 0 }} 个账号 · 本地加密</div>
      </div>
    </div>

    <div class="search">
      <svg class="search__icon" viewBox="0 0 24 24" width="15" height="15" fill="none"
           stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
        <circle cx="11" cy="11" r="6.6" /><path d="m16 16 4.2 4.2" />
      </svg>
      <input
        ref="searchEl"
        v-model="state.query"
        class="search__input"
        type="text"
        placeholder="搜索账号、游戏名、备注、邮箱…"
        spellcheck="false"
        @input="onSearch"
      />
      <button v-if="state.query" class="search__clear" title="清空" @click="clearSearch">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
             stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
      <kbd v-else class="search__kbd">/</kbd>
    </div>

    <div class="topbar__right">
      <button class="today" title="查看今日使用记录" @click="emit('today')">
        <span class="today__label">今日已用</span>
        <span class="today__num">{{ todayCount }}</span>
        <span class="today__next">已改密 {{ todayChanges }} · 下一个是第 {{ nextIndex }} 个</span>
      </button>

      <button class="btn btn--sm desk-only" @click="emit('import')">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20.5v-11m0 0 4 4m-4-4-4 4" />
          <path d="M4.5 7.5V5.3a1.8 1.8 0 0 1 1.8-1.8h11.4a1.8 1.8 0 0 1 1.8 1.8v2.2" />
        </svg>
        批量导入
      </button>

      <button class="btn btn--primary btn--sm desk-only" @click="emit('add')">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="2.2" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13" /></svg>
        添加账号
      </button>

      <button class="btn btn--sm btn--icon" title="更多" @click.stop="menuOpen = !menuOpen">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <circle cx="5.5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18.5" cy="12" r="1.6" />
        </svg>
      </button>

      <Transition name="menu">
        <div v-if="menuOpen" class="menu glass-strong" @click.stop>
          <button class="menu__item" @click="pick(() => emit('help'))">管理器说明</button>
          <button class="menu__item" @click="pick(() => emit('today'))">今日使用记录</button>
          <button class="menu__item" @click="pick(() => emit('mail'))">邮箱（验证码来源）</button>
          <button class="menu__item" @click="pick(() => emit('api'))">API 接口（取号给客服系统）</button>
          <button class="menu__item" @click="pick(() => emit('xgj'))">闲管家对接（闲鱼自动发货）</button>
          <button class="menu__item" @click="pick(() => emit('export'))">导出全部账号</button>
          <button class="menu__item" @click="pick(() => emit('settings'))">设置</button>
          <div class="menu__sep" />
          <button class="menu__item" @click="pick(() => setTheme(state.settings.theme === 'dark' ? 'light' : 'dark'))">
            切换到{{ state.settings.theme === 'dark' ? '浅色' : '深色' }}主题
          </button>
          <button class="menu__item menu__item--danger" @click="pick(lockVault)">锁定保险库</button>
        </div>
      </Transition>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  height: var(--topbar-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 20px;
  border-bottom: 1px solid var(--hairline);
  background: var(--surface);
  backdrop-filter: blur(var(--blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--blur)) saturate(180%);
  /*
   * ★ 这两行是「更多」菜单能不能点到的关键 ★
   *
   * backdrop-filter 会让 .topbar 创建层叠上下文（z-index: auto）。
   * 菜单在它里面，自己的 z-index: 60 只在这个上下文内部有效 ——
   * 对后面的 .pager（position: relative，DOM 里更靠后）完全无效，
   * 结果菜单下半部分被 pager 盖住、点不到。
   *
   * 把整体提到 80：高于 pager 和卡片菜单(40)，低于弹窗(100)与 toast(300)。
   */
  position: relative;
  z-index: 80;
}

.brand { display: flex; align-items: center; gap: 10px; flex: none; }
.brand__mark {
  width: 32px; height: 32px;
  border-radius: 10px;
  display: grid; place-items: center;
  color: #fff;
  background: linear-gradient(160deg, var(--accent-hi), var(--purple));
  box-shadow: 0 8px 20px -8px var(--accent), 0 1px 0 rgba(255, 255, 255, 0.28) inset;
}
.brand__title { font-size: 13.5px; font-weight: 680; letter-spacing: -0.02em; }
.brand__sub { font-size: 11px; color: var(--text-3); margin-top: 1px; }

.search { position: relative; flex: 1; max-width: 380px; display: flex; align-items: center; }
.search__icon { position: absolute; left: 12px; color: var(--text-3); pointer-events: none; }
.search__input {
  width: 100%;
  height: 36px;
  padding: 0 34px 0 34px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 13.5px;
  font-family: inherit;
  outline: none;
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast), background var(--dur-fast);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.search__input::placeholder { color: var(--text-3); }
.search__input:focus {
  border-color: var(--accent);
  background: var(--surface-2);
  box-shadow: 0 0 0 3.5px var(--accent-soft);
}
.search__clear, .search__kbd { position: absolute; right: 7px; }
.search__clear {
  width: 24px; height: 24px;
  display: grid; place-items: center;
  border: 0; border-radius: 6px;
  background: transparent; color: var(--text-3); cursor: pointer;
}
.search__clear:hover { background: var(--surface-3); color: var(--text); }

.topbar__right { display: flex; align-items: center; gap: 8px; margin-left: auto; position: relative; }

.today {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 13px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: linear-gradient(120deg, var(--accent-soft), var(--surface) 75%);
  color: var(--text);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.today:hover { border-color: var(--border-2); transform: translateY(-1px); }
.today__label { font-size: 11.5px; color: var(--text-3); font-weight: 600; }
.today__num {
  font-size: 17px;
  font-weight: 750;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  background: linear-gradient(160deg, var(--accent-hi), var(--purple));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  line-height: 1;
}
.today__next {
  font-size: 11px;
  color: var(--text-3);
  padding-left: 7px;
  border-left: 1px solid var(--hairline);
}

.menu {
  position: absolute;
  top: 44px;
  right: 0;
  z-index: 60;
  width: 200px;
  padding: 5px;
  border-radius: var(--r-md);
  display: flex;
  flex-direction: column;
  gap: 1px;
  /* 菜单项以后还会加，留个兜底：太高就自己滚动，别溢出屏幕 */
  max-height: calc(100vh - 90px);
  overflow-y: auto;
}
.menu__item {
  height: 31px;
  padding: 0 11px;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--text);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast);
}
.menu__item:hover { background: var(--surface-3); }
.menu__item--danger { color: var(--red); }
.menu__item--danger:hover { background: var(--red-soft); }
.menu__sep { height: 1px; background: var(--hairline); margin: 4px 6px; }

.menu-enter-active { transition: all 200ms var(--ease-spring); }
.menu-leave-active { transition: all 130ms var(--ease-out); }
.menu-enter-from, .menu-leave-to { opacity: 0; transform: scale(0.94) translateY(-6px); }

@media (max-width: 1080px) {
  .today__next { display: none; }
}
@media (max-width: 900px) {
  .topbar { flex-wrap: wrap; height: auto; padding: 10px 14px; gap: 8px; }
  .search { flex: 1 1 100%; max-width: none; order: 3; }
  .topbar__right { margin-left: auto; flex-wrap: wrap; }
  .brand__sub { display: none; }
}

/* ★ 手机（≤ 620px）★
   顶部栏在 412px 上会挤成一排小按钮，手指很难点准。
   这里做两件事：
     ① 藏掉「批量导入」「添加账号」—— 这两个在手机上本来也没法用
        （导入要粘贴一大段账号密码，添加要填一堆字段），留着只是占地方。
        它们在电脑上照常显示，功能一点没少。
     ② 「今日已用」保留 —— 这是你要在手机上看的关键信息之一，
        但把文字压短，只留一个紧凑的胶囊。
   ★ 注意：用 display:none 而不是 v-if，这样桌面端完全不受影响。 */
@media (max-width: 620px) {
  .topbar { padding: 8px 10px; gap: 7px; }
  .topbar__right { gap: 6px; }
  .brand__title { font-size: 14px; }
  .desk-only { display: none !important; }
  .search { order: 3; }
  .search__kbd { display: none; }
  .today { padding: 0 10px; height: 36px; }
  .today__label { font-size: 11.5px; }

  /* 菜单项加高加宽：手指点得准，长条目也不会顶到边 */
  .menu {
    width: 240px;
    max-width: calc(100vw - 20px);
    padding: 7px;
    max-height: 68vh;
  }
  .menu__item {
    height: 44px;
    font-size: 14px;
    padding: 0 13px;
  }
}

</style>
