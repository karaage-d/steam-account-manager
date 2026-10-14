<script setup>
import { ref, computed, onMounted, nextTick } from 'vue';
import {
  state, saveAccount, generatePassword, isDigitsAndLetters, fmtMinutes,
  refreshMailboxes, PW_MIN_LEN, PW_MAX_LEN,
} from '../lib/store.js';
import { toastError, toastWarn } from '../lib/toast.js';

const props = defineProps({ account: { type: Object, default: null } });
const emit = defineEmits(['close', 'saved']);

const isEdit = computed(() => !!props.account?.id);
const UNITS = { minute: 1, hour: 60, day: 1440 };

function bestUnit(minutes) {
  const m = Number(minutes) || 360;
  if (m % 1440 === 0 && m >= 1440) return { value: m / 1440, unit: 'day' };
  if (m % 60 === 0 && m >= 60) return { value: m / 60, unit: 'hour' };
  return { value: m, unit: 'minute' };
}

const init = bestUnit(props.account?.usageMinutes ?? 360);

const form = ref({
  username: props.account?.username || '',
  password: '',
  amount: init.value,
  unit: init.unit,
  game: props.account?.game || '',
  note: props.account?.note || '',
  email: props.account?.email || '',
  mailboxId: props.account?.mailboxId ?? null,
});

const reveal = ref(false);
const busy = ref(false);
const error = ref('');
const nameEl = ref(null);

const usageMinutes = computed(() => {
  const n = Number(form.value.amount) || 0;
  return Math.max(1, Math.round(n * (UNITS[form.value.unit] || 1)));
});

const canSubmit = computed(() => {
  if (!form.value.username.trim()) return false;
  if (!isEdit.value && !form.value.password) return false;
  if (usageMinutes.value < 1) return false;
  return true;
});

const presets = [
  { label: '1 小时', value: 1, unit: 'hour' },
  { label: '3 小时', value: 3, unit: 'hour' },
  { label: '6 小时', value: 6, unit: 'hour' },
  { label: '12 小时', value: 12, unit: 'hour' },
  { label: '1 天', value: 1, unit: 'day' },
  { label: '3 天', value: 3, unit: 'day' },
];

function applyPreset(p) {
  form.value.amount = p.value;
  form.value.unit = p.unit;
}

function genPassword() {
  form.value.password = generatePassword();
  reveal.value = true;
}

onMounted(() => {
  nextTick(() => nameEl.value?.focus());
  // 关联邮箱的下拉需要邮箱列表
  refreshMailboxes().catch(() => {});
});

async function submit() {
  if (!canSubmit.value || busy.value) return;
  if (form.value.password && !isDigitsAndLetters(form.value.password) && !isEdit.value) {
    // 仅提示，不阻断：用户可能就是想要别的密码
    toastWarn('密码含有非字母数字字符', { detail: '本工具生成的密码只含数字与大小写字母' });
  }
  busy.value = true;
  error.value = '';
  try {
    const payload = {
      username: form.value.username.trim(),
      game: form.value.game.trim(),
      note: form.value.note.trim(),
      email: form.value.email.trim(),
      usageMinutes: usageMinutes.value,
      mailboxId: form.value.mailboxId || null,
    };
    if (form.value.password) payload.password = form.value.password;
    await saveAccount(payload, props.account?.id);
    emit('saved');
    emit('close');
  } catch (e) {
    error.value = e.message;
    toastError(isEdit.value ? '保存失败' : '添加失败', { detail: e.message });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="sheet editor pop-in">
      <div class="sheet__head">
        <div>
          <div class="sheet__title">{{ isEdit ? '编辑账号' : '添加 Steam 账号' }}</div>
          <div class="sheet__sub">
            {{ isEdit
              ? '密码留空表示不修改；改动会立即加密保存'
              : '填好后账号会直接进入「可用」，点开始使用才开始计时' }}
          </div>
        </div>
        <button class="btn btn--ghost btn--icon btn--sm" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      <form class="sheet__body editor__body" @submit.prevent="submit">
        <div class="two">
          <div class="field">
            <label class="field__label">Steam 账号</label>
            <input ref="nameEl" v-model="form.username" class="input mono"
                   placeholder="例如 steam_user_01" spellcheck="false" autocomplete="off" />
          </div>
          <div class="field">
            <label class="field__label">游戏名</label>
            <input v-model="form.game" class="input" placeholder="例如 Counter-Strike 2" spellcheck="false" />
          </div>
        </div>

        <div class="field">
          <label class="field__label">{{ isEdit ? '新密码（留空不修改）' : '密码' }}</label>
          <div class="pwrow">
            <input
              v-model="form.password"
              class="input mono pwinput"
              :type="reveal ? 'text' : 'password'"
              :placeholder="isEdit ? '••••••••（保持不变）' : '输入密码'"
              spellcheck="false"
              autocomplete="new-password"
            />
            <button type="button" class="btn btn--icon" :title="reveal ? '隐藏' : '显示'"
                    @click="reveal = !reveal">
              <svg v-if="!reveal" viewBox="0 0 24 24" width="15" height="15" fill="none"
                   stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="none"
                   stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <path d="M3 3l18 18M10.2 10.4a3 3 0 0 0 4.2 4.2" />
                <path d="M6.4 6.6C3.9 8.5 2.5 12 2.5 12s3.5 6.2 9.5 6.2c1.6 0 3-.4 4.2-1" />
              </svg>
            </button>
          </div>
          <div class="genrow">
            <button type="button" class="btn btn--sm" @click="genPassword">随机生成</button>
            <span class="field__hint">{{ PW_MIN_LEN }}~{{ PW_MAX_LEN }} 位，字母开头，只含数字与大小写字母</span>
          </div>
        </div>

        <div class="field">
          <label class="field__label">使用时间</label>
          <div class="userow">
            <input v-model.number="form.amount" type="number" min="1" class="input numinput" />
            <select v-model="form.unit" class="select unitselect">
              <option value="minute">分钟</option>
              <option value="hour">小时</option>
              <option value="day">天</option>
            </select>
            <div class="presets">
              <button
                v-for="p in presets" :key="p.label"
                type="button"
                class="preset"
                :class="{ 'preset--on': form.amount === p.value && form.unit === p.unit }"
                @click="applyPreset(p)"
              >{{ p.label }}</button>
            </div>
          </div>
          <div class="field__hint">
            点「开始使用」后开始倒计时 {{ fmtMinutes(usageMinutes) }}，
            时间一到账号自动进入「待改密」，改完密码回到「可用」。
          </div>
        </div>

        <div class="field">
          <label class="field__label">备注（选填）</label>
          <textarea v-model="form.note" class="textarea"
                    placeholder="例如：绑定手机 13x，只用来挂卡" />
        </div>

        <div class="field">
          <label class="field__label">邮箱（选填，这个账号自己的收件地址）</label>
          <input v-model="form.email" class="input mono" placeholder="user@example.com"
                 spellcheck="false" autocomplete="off" />
          <span class="field__hint">填了它，取验证码时就能按收件地址精确定位</span>
        </div>

        <div class="field">
          <label class="field__label">验证邮件收在哪个邮箱（选填）</label>
          <select v-model="form.mailboxId" class="input">
            <option :value="null">不关联（改密时需要手动输入验证码）</option>
            <option v-for="b in state.mailboxes" :key="b.id" :value="b.id">
              {{ b.label || b.address }}
            </option>
          </select>
          <span class="field__hint">
            <template v-if="state.mailboxes.length">
              关联后，worker 登录时能自动去这个邮箱取验证码
            </template>
            <template v-else>
              还没有添加邮箱。顶栏「更多」→「邮箱」里先添加一个
            </template>
          </span>
        </div>

        <div v-if="error" class="editor__error">{{ error }}</div>
      </form>

      <div class="sheet__foot">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn btn--primary" :disabled="!canSubmit || busy" @click="submit">
          {{ busy ? '保存中…' : (isEdit ? '保存修改' : '添加到「可用」') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor { width: min(600px, 100%); }
.editor__body { display: flex; flex-direction: column; gap: 15px; padding-bottom: 4px; }

.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 560px) { .two { grid-template-columns: 1fr; } }

.pwrow { display: flex; gap: 8px; }
.pwinput { flex: 1; }
.genrow { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }

.userow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.numinput { width: 92px; text-align: center; font-variant-numeric: tabular-nums; }
.unitselect { width: 92px; }
.presets { display: flex; gap: 5px; flex-wrap: wrap; }
.preset {
  height: 30px;
  padding: 0 11px;
  border-radius: var(--r-xs);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-2);
  font-size: 12.5px;
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.preset:hover { color: var(--text); border-color: var(--border-2); }
.preset--on { background: var(--accent-soft); border-color: transparent; color: var(--accent); font-weight: 650; }

.editor__error {
  font-size: 12.5px;
  color: var(--red);
  background: var(--red-soft);
  border-radius: var(--r-xs);
  padding: 9px 12px;
}
</style>
