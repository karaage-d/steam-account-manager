<script setup>
import { onMounted, computed } from 'vue';
import { state, refreshToday, fmtDuration, fmtDateTime, cancelUse } from '../lib/store.js';

const emit = defineEmits(['close']);

onMounted(refreshToday);

const sessions = computed(() => state.today?.sessions || []);
const total = computed(() => state.today?.count ?? 0);
const unique = computed(() => state.today?.distinctAccounts ?? 0);
const totalSeconds = computed(() => sessions.value.reduce((s, x) => s + (x.elapsedSeconds || 0), 0));
const activeCount = computed(() => sessions.value.filter((s) => s.status === 'active').length);

const dayLabel = computed(() => {
  const d = new Date();
  const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${w}`;
});

function statusBadge(s) {
  if (s.status === 'active') return { text: '使用中', cls: 'badge--green' };
  if (s.status === 'expired') return { text: '时间用完', cls: 'badge--orange' };
  return { text: '已结束', cls: '' };
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="sheet day-sheet pop-in">
      <div class="sheet__head">
        <div>
          <div class="sheet__title">今日使用记录</div>
          <div class="sheet__sub">{{ dayLabel }} · 每个账号被使用时都会按顺序记一笔</div>
        </div>
        <button class="btn btn--ghost btn--icon btn--sm" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      <div class="sheet__body">
        <div class="hero">
          <div class="hero__num">{{ total }}</div>
          <div class="hero__text">
            <div class="hero__title">个账号今天被使用</div>
            <div class="hero__hint">下一个取用的账号会是<strong>今天第 {{ total + 1 }} 个</strong></div>
          </div>
          <div class="hero__stats">
            <div class="hstat">
              <div class="hstat__k">去重账号</div>
              <div class="hstat__v">{{ unique }}</div>
            </div>
            <div class="hstat">
              <div class="hstat__k">累计时长</div>
              <div class="hstat__v">{{ fmtDuration(totalSeconds) }}</div>
            </div>
            <div class="hstat">
              <div class="hstat__k">进行中</div>
              <div class="hstat__v" :style="activeCount ? 'color:var(--green)' : ''">{{ activeCount }}</div>
            </div>
            <div class="hstat">
              <div class="hstat__k">今日已改密</div>
              <div class="hstat__v">{{ state.today?.changes ?? 0 }}</div>
            </div>
          </div>
        </div>

        <div v-if="!sessions.length" class="empty">
          <div class="empty__icon">🕐</div>
          <div class="empty__title">今天还没有使用过账号</div>
          <div class="empty__text">去「可用」界面点一下「开始使用」，这里就会按顺序记录下来。</div>
        </div>

        <div v-else class="timeline stagger">
          <div v-for="s in sessions" :key="s.id" class="tlitem" :class="{ 'tlitem--live': s.status === 'active' }">
            <div class="tlitem__idx" :class="{ 'tlitem__idx--live': s.status === 'active' }">
              <span>第</span><strong>{{ s.todayIndex }}</strong><span>个</span>
            </div>
            <div class="tlitem__main">
              <div class="tlitem__name">{{ s.username }}</div>
              <div class="tlitem__meta">
                {{ fmtDateTime(s.startedAt) }} 开始
                <template v-if="s.endedAt"> · {{ fmtDateTime(s.endedAt) }} 结束</template>
              </div>
            </div>
            <div class="tlitem__dur mono">{{ fmtDuration(s.elapsedSeconds) }}</div>
            <span class="badge" :class="statusBadge(s).cls">{{ statusBadge(s).text }}</span>
            <button v-if="s.status === 'active'" class="btn btn--sm btn--danger"
                    @click="cancelUse({ id: s.accountId, username: s.username })">提前结束</button>
          </div>
        </div>
      </div>

      <div class="sheet__foot">
        <button class="btn" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.day-sheet { width: min(720px, 100%); }

.hero {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 18px 20px;
  border-radius: var(--r-lg);
  background: linear-gradient(125deg, var(--accent-soft), transparent 62%);
  border: 1px solid var(--border);
  flex-wrap: wrap;
}
.hero__num {
  font-size: 52px;
  font-weight: 750;
  letter-spacing: -0.055em;
  line-height: 0.95;
  font-variant-numeric: tabular-nums;
  background: linear-gradient(150deg, var(--accent-hi), var(--purple) 70%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.hero__text { flex: 1; min-width: 160px; }
.hero__title { font-size: 14px; font-weight: 620; }
.hero__hint { font-size: 12px; color: var(--text-3); margin-top: 4px; }
.hero__hint strong { color: var(--accent); font-weight: 650; }
.hero__stats { display: flex; gap: 22px; }
.hstat__k { font-size: 11.5px; color: var(--text-3); font-weight: 600; }
.hstat__v {
  font-size: 19px; font-weight: 700; letter-spacing: -0.03em;
  margin-top: 3px; font-variant-numeric: tabular-nums; white-space: nowrap;
}

.timeline {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  border-radius: var(--r-lg);
  border: 1px solid var(--border);
  background: var(--surface);
  overflow: hidden;
}
.tlitem { display: flex; align-items: center; gap: 14px; padding: 11px 15px; transition: background var(--dur-fast); }
.tlitem + .tlitem { border-top: 1px solid var(--hairline); }
.tlitem:hover { background: var(--surface-2); }
.tlitem--live { background: linear-gradient(90deg, var(--green-soft), transparent 55%); }

.tlitem__idx {
  flex: none;
  display: flex; align-items: baseline; gap: 2px;
  font-size: 11px; color: var(--text-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  padding: 4px 9px;
}
.tlitem__idx strong { font-size: 14px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.tlitem__idx--live { border-color: rgba(50, 215, 75, 0.35); }
.tlitem__idx--live strong { color: var(--green); }

.tlitem__main { flex: 1; min-width: 0; }
.tlitem__name {
  font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tlitem__meta { font-size: 11.5px; color: var(--text-3); margin-top: 2px; }
.tlitem__dur {
  flex: none; font-size: 12.5px; color: var(--text-2);
  font-variant-numeric: tabular-nums; min-width: 68px; text-align: right;
}
</style>
