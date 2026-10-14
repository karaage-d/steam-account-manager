<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import {
  state, remainingSeconds, elapsedSeconds, usedProgress, fmtClock, fmtDuration,
  fmtMinutes, fmtAgo, startUse, cancelUse, openCredential, copyPassword,
  copyUsername, copyFormatted, skipChange, redispatch,
} from '../lib/store.js';

const props = defineProps({ account: { type: Object, required: true } });
const emit = defineEmits(['edit', 'delete', 'manual']);

const root = ref(null);
const menuOpen = ref(false);
/**
 * ★ 菜单要不要往上弹 ★
 *
 * 卡片列表在一个 overflow:auto 的滚动容器里，而菜单是绝对定位的。
 * 卡片靠近列表底部时，菜单会超出滚动容器可见区域被裁掉 ——
 * 表现就是"菜单里的按钮点不动"（尤其「待改密」卡片菜单最长，有 8 项）。
 * 打开前先量一下按钮下方还剩多少空间，不够就往上弹。
 */
const menuUp = ref(false);
const busy = ref(false);

function toggleMenu() {
  if (menuOpen.value) { menuOpen.value = false; return; }
  const rect = root.value?.getBoundingClientRect();
  // 菜单最高约 260px；下方放不下、上方放得下就翻转
  menuUp.value = !!rect
    && (window.innerHeight - rect.bottom) < 260
    && rect.top > 260;
  menuOpen.value = true;
}

const acc = computed(() => props.account);
const mode = computed(() => acc.value.state);   // available | in_use | pending_change

const initial = computed(() => (acc.value.username || '?').trim().charAt(0).toUpperCase());
const avatarHue = computed(() => {
  let h = 0;
  for (const ch of acc.value.username || '') h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
});

const remaining = computed(() => remainingSeconds(acc.value));
const elapsed = computed(() => elapsedSeconds(acc.value));
const progress = computed(() => usedProgress(acc.value));
/** 剩余不足 10% 时高亮提醒 */
const urgent = computed(() => mode.value === 'in_use' && progress.value >= 0.9);

const taskStatus = computed(() => {
  const t = acc.value.task;
  if (!t) return null;
  return {
    pending: { text: '等待 AI 处理', cls: 'badge--orange', dot: 'warn' },
    running: { text: 'AI 处理中', cls: 'badge--accent', dot: 'live' },
    failed: { text: 'AI 处理失败', cls: 'badge--red', dot: 'warn' },
  }[t.status] || { text: t.status, cls: '', dot: null };
});

const waitedText = computed(() => {
  const since = acc.value.enteredPendingAt;
  if (!since) return '';
  return fmtDuration(Math.max(0, state.now - since));
});

async function onPrimary() {
  if (busy.value) return;
  busy.value = true;
  try {
    if (mode.value === 'available') await startUse(acc.value);
    else if (mode.value === 'in_use') await cancelUse(acc.value);
    else emit('manual', acc.value);
  } finally {
    busy.value = false;
  }
}

function closeMenu() { menuOpen.value = false; }

function onDocClick(e) {
  if (menuOpen.value && root.value && !root.value.contains(e.target)) closeMenu();
}
onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick));

async function run(fn) {
  closeMenu();
  await fn();
}
</script>

<template>
  <article
    ref="root"
    class="acct card"
    :class="[`acct--${mode}`, { 'acct--urgent': urgent }]"
  >
    <div class="acct__head">
      <div class="acct__avatar" :style="`--h:${avatarHue}`">{{ initial }}</div>
      <div class="acct__id">
        <div class="acct__name" :title="acc.username">{{ acc.username }}</div>
        <div v-if="acc.game" class="acct__game">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"
               stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7.5 7h9a4.5 4.5 0 0 1 4.4 3.6l1 5a3 3 0 0 1-5.4 2.3L15 16H9l-1.5 1.9A3 3 0 0 1 2.1 15.6l1-5A4.5 4.5 0 0 1 7.5 7Z" />
            <path d="M7.4 11.6v2M6.4 12.6h2M15.4 12.2h.01M16.9 13.4h.01" />
          </svg>
          <span>{{ acc.game }}</span>
        </div>
        <div v-else class="acct__game acct__game--none">未填游戏名</div>
      </div>

      <span v-if="mode === 'in_use'" class="badge badge--green"><span class="dot dot--live" />使用中</span>
      <span v-else-if="mode === 'pending_change'" class="badge badge--orange">待改密</span>

      <button class="acct__more" title="更多操作" @click.stop="toggleMenu">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <circle cx="5.5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18.5" cy="12" r="1.6" />
        </svg>
      </button>

      <Transition name="menu">
        <div v-if="menuOpen" class="menu glass-strong" :class="{ 'menu--up': menuUp }" @click.stop>
          <button class="menu__item" @click="run(() => copyUsername(acc))">复制账号</button>
          <button class="menu__item" @click="run(() => copyPassword(acc))">复制密码</button>
          <button class="menu__item" @click="run(() => copyFormatted(acc))">复制「账号/密码」</button>
          <div class="menu__sep" />
          <button class="menu__item" @click="run(() => openCredential(acc))">查看凭据</button>
          <button class="menu__item" @click="run(() => emit('edit', acc))">编辑</button>
          <template v-if="mode === 'pending_change'">
            <button class="menu__item" @click="run(() => emit('manual', acc))">手动改密</button>
            <button class="menu__item" @click="run(() => redispatch(acc))">重新派发给 AI</button>
            <button class="menu__item" @click="run(() => skipChange(acc))">跳过改密放回可用</button>
          </template>
          <button v-if="mode === 'in_use'" class="menu__item" @click="run(() => cancelUse(acc))">
            提前结束并放回可用
          </button>
          <div class="menu__sep" />
          <button class="menu__item menu__item--danger" @click="run(() => emit('delete', acc))">删除账号</button>
        </div>
      </Transition>
    </div>

    <div v-if="acc.note" class="acct__note">{{ acc.note }}</div>

    <div class="acct__stats">
      <div class="stat">
        <div class="stat__k">使用时间</div>
        <div class="stat__v">{{ fmtMinutes(acc.usageMinutes) }}</div>
      </div>
      <div class="stat">
        <div class="stat__k">使用次数</div>
        <div class="stat__v">{{ acc.useCount }} 次</div>
      </div>
      <div class="stat">
        <div class="stat__k">最近使用</div>
        <div class="stat__v">{{ fmtAgo(acc.lastUsedAt) }}</div>
      </div>
    </div>

    <!-- 使用中：倒计时 -->
    <div v-if="mode === 'in_use'" class="zone zone--live">
      <div class="zone__row">
        <span class="zone__label">剩余时间</span>
        <span class="zone__clock mono" :class="{ 'zone__clock--urgent': urgent }">{{ fmtClock(remaining) }}</span>
      </div>
      <div class="meter">
        <div class="meter__fill meter__fill--live" :style="`width:${progress * 100}%`" />
      </div>
      <div class="zone__foot">
        <span>已用 {{ fmtDuration(elapsed) }} / 共 {{ fmtMinutes(acc.usageMinutes) }}</span>
        <span v-if="acc.session?.todayIndex" class="zone__idx">今天第 {{ acc.session.todayIndex }} 个</span>
      </div>
      <div class="zone__notice">倒计时归零后，该账号会自动转入「待改密」</div>
    </div>

    <!-- 待改密：等待改密 -->
    <div v-else-if="mode === 'pending_change'" class="zone zone--pending">
      <div class="zone__row">
        <span class="zone__label">已等待</span>
        <span class="zone__clock zone__clock--wait mono">{{ waitedText || '刚刚' }}</span>
      </div>
      <div v-if="taskStatus" class="pending__status">
        <span class="badge" :class="taskStatus.cls">
          <span v-if="taskStatus.dot" class="dot" :class="taskStatus.dot === 'live' ? 'dot--live' : 'dot--warn'" />
          {{ taskStatus.text }}
        </span>
        <span v-if="acc.task?.claimedBy" class="pending__worker">{{ acc.task.claimedBy }}</span>
      </div>
      <div v-else class="pending__status">
        <span class="badge badge--orange">尚未派发</span>
      </div>
      <div v-if="acc.task?.message" class="pending__msg">{{ acc.task.message }}</div>
      <div class="zone__notice">改完密码后，账号会自动回到「可用」</div>
    </div>

    <!-- 可用：待使用 -->
    <div v-else class="zone zone--idle">
      <div class="zone__row">
        <span class="zone__label">可开始一次</span>
        <span class="zone__clock zone__clock--idle mono">{{ fmtMinutes(acc.usageMinutes) }}</span>
      </div>
      <div class="zone__notice">开始后倒计时 {{ fmtMinutes(acc.usageMinutes) }}，结束即进入待改密</div>
    </div>

    <div class="acct__actions">
      <button
        class="btn btn--sm acct__primary"
        :class="mode === 'in_use' ? 'btn--danger' : (mode === 'pending_change' ? 'btn--primary' : 'btn--primary')"
        :disabled="busy"
        @click="onPrimary"
      >
        <span v-if="busy" class="spin" />
        <template v-else>
          <svg v-if="mode === 'available'" viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
            <path d="M8.5 5.6v12.8l10-6.4z" />
          </svg>
          <svg v-else-if="mode === 'in_use'" viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
            <rect x="6.5" y="6.5" width="11" height="11" rx="2.2" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7.5 11.5V8.4a4.5 4.5 0 0 1 8.6-1.8" /><rect x="4.5" y="11.5" width="15" height="9" rx="2.4" />
          </svg>
        </template>
        <template v-if="mode === 'available'">开始使用</template>
        <template v-else-if="mode === 'in_use'">提前结束</template>
        <template v-else>手动改密</template>
      </button>

      <button class="btn btn--sm" @click="openCredential(acc)">查看</button>
      <button class="btn btn--sm btn--icon" title="编辑" @click="emit('edit', acc)">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4.5 19.5h3.2L18.4 8.8a1.9 1.9 0 0 0 0-2.7l-.5-.5a1.9 1.9 0 0 0-2.7 0L4.5 16.3Z" />
        </svg>
      </button>
    </div>
  </article>
</template>

<style scoped>
.acct {
  position: relative;
  display: flex;
  flex-direction: column;
  /* ★ 整体瘦身 ★
     账号一多，原来的间距就显得松垮，一屏放不下几个。
     内边距 15/16 → 11/12，元素间距 11 → 8。 */
  gap: 8px;
  padding: 11px 12px 10px;
  border-radius: var(--r-md);
}
.acct:hover {
  transform: translateY(-2px);
  border-color: var(--border-2);
  box-shadow: var(--glow), var(--shadow);
}
.acct--in_use {
  border-color: rgba(50, 215, 75, 0.4);
  background: linear-gradient(165deg, var(--green-soft), var(--surface) 55%);
  box-shadow: 0 0 0 1px rgba(50, 215, 75, 0.16), var(--shadow);
}
.acct--in_use.acct--urgent {
  border-color: rgba(255, 159, 10, 0.5);
  background: linear-gradient(165deg, var(--orange-soft), var(--surface) 55%);
  box-shadow: 0 0 0 1px rgba(255, 159, 10, 0.2), var(--shadow);
}
.acct--pending_change {
  border-color: rgba(255, 159, 10, 0.34);
  background: linear-gradient(165deg, var(--orange-soft), var(--surface) 58%);
}

.acct__head { display: flex; align-items: center; gap: 9px; }

.acct__avatar {
  /* 38 → 31：头像占地方最大，缩它最见效 */
  width: 31px; height: 31px;
  flex: none;
  border-radius: 10px;
  display: grid;
  place-items: center;
  font-size: 13.5px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(150deg, hsl(var(--h) 78% 62%), hsl(calc(var(--h) + 42) 72% 47%));
  box-shadow: 0 5px 13px -7px hsl(var(--h) 70% 50%), 0 1px 0 rgba(255, 255, 255, 0.3) inset;
}

.acct__id { min-width: 0; flex: 1; }
.acct__name {
  font-size: 13.5px;
  font-weight: 620;
  letter-spacing: -0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.acct__game {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--accent);
  margin-top: 1px;
  min-width: 0;
}
.acct__game span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acct__game--none { color: var(--text-3); }

.acct__more {
  flex: none;
  width: 24px; height: 24px;
  display: grid; place-items: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.acct__more:hover { background: var(--surface-3); color: var(--text); }

.menu {
  position: absolute;
  top: 46px;
  right: 12px;
  z-index: 40;
  width: 194px;
  padding: 5px;
  border-radius: var(--r-md);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
/* 靠近列表底部时向上弹，避免被滚动容器裁掉后点不到 */
.menu--up {
  top: auto;
  bottom: calc(100% - 46px);
}
.menu__item {
  height: 30px;
  padding: 0 10px;
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

.acct__note {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
  padding: 7px 10px;
  border-radius: var(--r-xs);
  background: var(--surface);
  border-left: 2px solid var(--border-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.acct__stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  padding: 7px 9px;
  border-radius: var(--r-sm);
  background: var(--surface);
}
.stat { min-width: 0; }
.stat__k { font-size: 10px; color: var(--text-3); font-weight: 600; }
.stat__v {
  font-size: 12px;
  font-weight: 600;
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}

/* 状态区 */
.zone {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 10px;
  border-radius: var(--r-sm);
  background: var(--surface);
}
.zone--live { background: var(--green-soft); }
.zone--pending { background: var(--orange-soft); }
.zone--idle { background: var(--surface); }

.zone__row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.zone__label { font-size: 11px; color: var(--text-2); font-weight: 600; }
.zone__clock {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.zone__clock--urgent { color: var(--orange); }
.zone--live .zone__clock { color: var(--green); }
.zone__clock--wait { font-size: 17px; color: var(--orange); }
.zone__clock--idle { font-size: 17px; color: var(--text-2); }

.zone__foot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-2);
}
.zone__idx { color: var(--green); font-weight: 650; }
.zone__notice { font-size: 11.5px; color: var(--text-3); line-height: 1.5; }

.pending__status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pending__worker { font-size: 11.5px; color: var(--text-3); }
.pending__msg {
  font-size: 11.5px;
  color: var(--text-2);
  background: var(--surface-2);
  border-radius: var(--r-xs);
  padding: 6px 9px;
  line-height: 1.5;
  word-break: break-word;
}

.meter__fill--live { background: linear-gradient(90deg, var(--green), #6ee787); }

.acct__actions { display: flex; gap: 6px; margin-top: auto; padding-top: 2px; }
.acct__primary { flex: 1; }

.spin {
  width: 12px; height: 12px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  animation: spin 0.7s linear infinite;
  opacity: 0.8;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ★ 手机（≤ 620px）★
   408px 宽的安卓屏上，卡片要尽量紧，一屏能多看到几个。
   ★ 只有按钮高度反向加大 —— 手指点得准比省空间重要。 */
@media (max-width: 620px) {
  .acct {
    gap: 8px;
    padding: 10px 11px 9px;
    border-radius: var(--r-md);
  }
  .acct:hover { transform: none; }          /* 手机上没有 hover，别留位移 */

  .acct__avatar { width: 29px; height: 29px; font-size: 13px; }
  .acct__name { font-size: 14px; }
  .acct__game { font-size: 11.5px; }

  .acct__note { font-size: 11px; padding: 5px 8px; -webkit-line-clamp: 1; }
  .acct__stats { padding: 6px 8px; gap: 5px; }
  .stat__k { font-size: 9.5px; }
  .stat__v { font-size: 11.5px; }

  .zone { padding: 8px 9px; gap: 4px; }
  .zone__clock { font-size: 19px; }
  .zone__notice { font-size: 10.5px; }

  /* 主要操作按钮做大，查看/编辑做成图标尺寸也够点 */
  .acct__actions { gap: 7px; }
  .acct__actions .btn { height: 42px; }
}
</style>
