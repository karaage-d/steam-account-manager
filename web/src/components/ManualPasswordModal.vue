<script setup>
import { ref, computed } from 'vue';
import { submitManualPassword, skipChange, generatePassword, fmtMinutes, PW_MIN_LEN, PW_MAX_LEN } from '../lib/store.js';
import { toastWarn } from '../lib/toast.js';

const props = defineProps({ account: { type: Object, required: true } });
const emit = defineEmits(['close']);

const password = ref('');
const reveal = ref(true);
const busy = ref(false);

const canSubmit = computed(() => password.value.trim().length > 0 && !busy.value);

function gen() {
  password.value = generatePassword();
  reveal.value = true;
}

async function submit() {
  if (!canSubmit.value) return;
  if (password.value.length < 6) { toastWarn('新密码太短了', { detail: '建议至少 8 位' }); return; }
  busy.value = true;
  try {
    await submitManualPassword(props.account, password.value.trim());
    emit('close');
  } catch { /* store 里已提示 */ } finally {
    busy.value = false;
  }
}

async function skip() {
  busy.value = true;
  try {
    await skipChange(props.account);
    emit('close');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="sheet mp pop-in">
      <div class="sheet__head">
        <div>
          <div class="sheet__title">手动改密</div>
          <div class="sheet__sub">
            去 Steam 官网把 <strong>{{ account.username }}</strong> 的密码改掉，然后把新密码填在这里。
            保存后账号会自动回到「可用」。
          </div>
        </div>
        <button class="btn btn--ghost btn--icon btn--sm" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      <div class="sheet__body mp__body">
        <div class="mp__info">
          <div class="mp__info-row">
            <span>账号</span><strong class="mono">{{ account.username }}</strong>
          </div>
          <div v-if="account.game" class="mp__info-row">
            <span>游戏</span><strong>{{ account.game }}</strong>
          </div>
          <div class="mp__info-row">
            <span>本次使用时间</span><strong>{{ fmtMinutes(account.usageMinutes) }}</strong>
          </div>
        </div>

        <div class="field">
          <label class="field__label">新密码</label>
          <div class="pwrow">
            <input
              v-model="password"
              class="input mono"
              :type="reveal ? 'text' : 'password'"
              placeholder="填入你刚在 Steam 设置的新密码"
              spellcheck="false"
              autocomplete="off"
            />
            <button class="btn btn--icon" :title="reveal ? '隐藏' : '显示'" @click="reveal = !reveal">
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
            <button class="btn btn--sm" @click="gen">随机生成一个</button>
            <span class="field__hint">{{ PW_MIN_LEN }}~{{ PW_MAX_LEN }} 位，字母开头，只含数字与大小写字母</span>
          </div>
        </div>
      </div>

      <div class="sheet__foot mp__foot">
        <button class="btn btn--ghost mp__skip" :disabled="busy" @click="skip">
          跳过改密，直接放回可用
        </button>
        <div class="mp__foot-right">
          <button class="btn" :disabled="busy" @click="emit('close')">取消</button>
          <button class="btn btn--primary" :disabled="!canSubmit" @click="submit">
            {{ busy ? '保存中…' : '保存并回到「可用」' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mp { width: min(520px, 100%); }
.mp__body { display: flex; flex-direction: column; gap: 15px; }

.mp__info {
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--surface);
  overflow: hidden;
}
.mp__info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  font-size: 13px;
}
.mp__info-row + .mp__info-row { border-top: 1px solid var(--hairline); }
.mp__info-row span { color: var(--text-3); font-size: 12.5px; }
.mp__info-row strong { font-weight: 620; letter-spacing: -0.01em; }

.pwrow { display: flex; gap: 8px; }
.pwrow .input { flex: 1; }
.genrow { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.genlen { width: 96px; height: 30px; font-size: 12.5px; border-radius: var(--r-xs); }

.mp__foot { justify-content: space-between; align-items: center; }
.mp__foot-right { display: flex; gap: 10px; }
.mp__skip { color: var(--text-2); }
</style>
