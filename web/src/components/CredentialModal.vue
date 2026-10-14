<script setup>
import { ref, computed } from 'vue';
import {
  state, TAB_KEYS, remainingSeconds, elapsedSeconds, fmtClock, fmtMinutes,
  credentialText, startUse, cancelUse, copyPasswordRaw,
} from '../lib/store.js';
import { copyText } from '../lib/api.js';
import { toastSuccess, toastWarn } from '../lib/toast.js';

const emit = defineEmits(['close']);

const revealing = ref(true);

const cred = computed(() => state.credential);
const account = computed(() => {
  const id = cred.value?.accountId;
  if (!id) return null;
  for (const k of TAB_KEYS) {
    const hit = state.lists[k].find((a) => a.id === id);
    if (hit) return hit;
  }
  return null;
});
const session = computed(() => account.value?.session || cred.value?.session || null);
const isLive = computed(() => account.value?.state === 'in_use' && !!session.value);

const elapsed = computed(() => (isLive.value ? elapsedSeconds(account.value) : 0));
const remaining = computed(() => (isLive.value ? remainingSeconds(account.value) : 0));

const fullText = computed(() => credentialText(cred.value?.username || '', cred.value?.password || ''));
const masked = computed(() => '•'.repeat(Math.max(8, (cred.value?.password || '').length)));
const initial = computed(() => (cred.value?.username || '?').trim().charAt(0).toUpperCase());

async function copyAll() {
  const ok = await copyText(fullText.value);
  if (ok) toastSuccess('已复制「账号/密码」', { detail: '可直接粘贴使用' });
  else toastWarn('复制失败，请手动选中复制');
}

async function copyField(value, name) {
  const ok = await copyText(value);
  if (ok) toastSuccess(`${name}已复制`);
  else toastWarn('复制失败，请手动选中复制');
}

async function beginUse() {
  if (!account.value) return;
  await startUse(account.value);
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="sheet cred pop-in">
      <div class="sheet__head">
        <div class="cred__id">
          <div class="cred__avatar">{{ initial }}</div>
          <div style="min-width:0">
            <div class="sheet__title cred__name">{{ cred?.username }}</div>
            <div class="cred__badges">
              <span v-if="isLive" class="badge badge--green"><span class="dot dot--live" />使用中</span>
              <span v-else-if="account?.state === 'pending_change'" class="badge badge--orange">待改密</span>
              <span v-else-if="account" class="badge">可用</span>
              <span v-if="isLive && session?.todayIndex" class="badge badge--accent">
                今天第 {{ session.todayIndex }} 个使用
              </span>
              <span v-if="account?.game" class="badge">{{ account.game }}</span>
            </div>
          </div>
        </div>
        <button class="btn btn--ghost btn--icon btn--sm" title="关闭" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      <div class="sheet__body">
        <!-- 需求指定的输出格式 -->
        <div class="credblock">
          <div class="credrow">
            <div class="credrow__k">账号：</div>
            <div class="credrow__v mono">{{ cred?.username }}</div>
            <button class="credrow__copy" title="复制账号" @click="copyField(cred?.username, '账号')">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                   stroke-width="1.7" stroke-linejoin="round">
                <rect x="9" y="9" width="11" height="11" rx="2.4" />
                <path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v.5" />
              </svg>
            </button>
          </div>

          <div class="credrow credrow--pw">
            <div class="credrow__k">密码：</div>
            <div class="credrow__v mono" :class="{ 'credrow__v--masked': !revealing }">
              {{ revealing ? cred?.password : masked }}
            </div>
            <button class="credrow__copy" :title="revealing ? '隐藏密码' : '显示密码'"
                    @click="revealing = !revealing">
              <svg v-if="!revealing" viewBox="0 0 24 24" width="14" height="14" fill="none"
                   stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none"
                   stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <path d="M3 3l18 18M10.2 10.4a3 3 0 0 0 4.2 4.2" />
                <path d="M6.4 6.6C3.9 8.5 2.5 12 2.5 12s3.5 6.2 9.5 6.2c1.6 0 3-.4 4.2-1" />
              </svg>
            </button>
            <button class="credrow__copy" title="复制密码"
                    @click="copyPasswordRaw(cred?.password, cred?.username)">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                   stroke-width="1.7" stroke-linejoin="round">
                <rect x="9" y="9" width="11" height="11" rx="2.4" />
                <path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v.5" />
              </svg>
            </button>
          </div>
        </div>

        <button class="btn btn--primary btn--lg btn--block copylg" @click="copyAll">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linejoin="round">
            <rect x="9" y="9" width="11" height="11" rx="2.4" />
            <path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v.5" />
          </svg>
          复制「账号 / 密码」
        </button>

        <!-- 使用计时 -->
        <div class="session">
          <template v-if="isLive">
            <div class="session__top">
              <div>
                <div class="session__label">已使用</div>
                <div class="session__clock mono">{{ fmtClock(elapsed) }}</div>
              </div>
              <div class="session__right">
                <div class="session__label">剩余时间</div>
                <div class="session__remain mono">{{ fmtClock(remaining) }}</div>
              </div>
            </div>
            <div class="meter">
              <div class="meter__fill meter__fill--live"
                   :style="`width:${Math.min(100, (elapsed / Math.max(1, session.plannedSeconds)) * 100)}%`" />
            </div>
            <div class="session__foot">
              <span>倒计时归零后自动转入「待改密」</span>
              <button class="btn btn--sm btn--danger" @click="cancelUse(account)">提前结束</button>
            </div>
          </template>

          <template v-else-if="account?.state === 'available'">
            <div class="session__label">开始一次使用</div>
            <div class="session__start">
              <span class="session__plan">
                倒计时 <strong>{{ fmtMinutes(account.usageMinutes) }}</strong>
              </span>
              <button class="btn btn--primary" @click="beginUse">开始使用</button>
            </div>
            <div class="session__hint">
              这个时长是添加账号时设定的。倒计时结束后账号会自动进入「待改密」。
            </div>
          </template>

          <template v-else>
            <div class="session__label">该账号当前不可使用</div>
            <div class="session__hint">
              它正在等待改密。改完密码后会自动回到「可用」，然后才能再次开始使用。
            </div>
          </template>
        </div>
      </div>

      <div class="sheet__foot">
        <button class="btn" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cred { width: min(540px, 100%); }

.cred__id { display: flex; align-items: center; gap: 12px; min-width: 0; }
.cred__avatar {
  width: 42px; height: 42px;
  flex: none;
  border-radius: 13px;
  display: grid; place-items: center;
  font-size: 18px; font-weight: 700; color: #fff;
  background: linear-gradient(150deg, var(--accent-hi), var(--purple));
  box-shadow: 0 8px 20px -9px var(--accent);
}
.cred__name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
.cred__badges { display: flex; gap: 6px; margin-top: 5px; flex-wrap: wrap; }

.credblock {
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--surface);
  overflow: hidden;
}
.credrow { display: flex; align-items: center; gap: 12px; padding: 13px 14px; }
.credrow + .credrow { border-top: 1px solid var(--hairline); }
.credrow__k { flex: none; width: 52px; font-size: 12.5px; font-weight: 650; color: var(--text-2); }
.credrow__v {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  word-break: break-all;
  user-select: all;
  line-height: 1.5;
}
.credrow__v--masked { letter-spacing: 0.14em; color: var(--text-2); }
.credrow__copy {
  flex: none;
  width: 30px; height: 30px;
  display: grid; place-items: center;
  border: 0; border-radius: var(--r-xs);
  background: transparent; color: var(--text-3); cursor: pointer;
  transition: all var(--dur-fast);
}
.credrow__copy:hover { background: var(--surface-3); color: var(--text); }
.credrow--pw .credrow__v { color: var(--green); }

.copylg { margin-top: 12px; }

.session {
  margin-top: 16px;
  padding: 14px;
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.session__top { display: flex; justify-content: space-between; align-items: flex-start; }
.session__right { text-align: right; }
.session__label { font-size: 11.5px; color: var(--text-3); font-weight: 600; }
.session__clock {
  font-size: 26px; font-weight: 700; letter-spacing: -0.03em;
  color: var(--green); font-variant-numeric: tabular-nums; line-height: 1.15;
}
.session__remain {
  font-size: 26px; font-weight: 700; letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums; line-height: 1.15;
}
.session__foot {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; font-size: 11.5px; color: var(--text-3);
}
.session__start { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
.session__plan { font-size: 13px; color: var(--text-2); }
.session__plan strong { color: var(--text); font-weight: 680; }
.session__hint { font-size: 11.5px; color: var(--text-3); line-height: 1.6; }

.meter__fill--live { background: linear-gradient(90deg, var(--green), #6ee787); }
</style>
