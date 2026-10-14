<script setup>
import { ref, computed, onMounted, nextTick } from 'vue';
import { state, setupVault, unlockVault } from '../lib/store.js';

const password = ref('');
const confirm = ref('');
const reveal = ref(false);
const busy = ref(false);
const error = ref('');
const inputEl = ref(null);

const isSetup = computed(() => !state.initialized);
const tooShort = computed(() => password.value.length > 0 && password.value.length < 6);
const mismatch = computed(() => !isSetup.value ? false : confirm.value.length > 0 && confirm.value !== password.value);
const canSubmit = computed(() => {
  if (busy.value || password.value.length < 6) return false;
  if (isSetup.value) return confirm.value === password.value;
  return true;
});

onMounted(() => nextTick(() => inputEl.value?.focus()));

async function submit() {
  if (!canSubmit.value) return;
  busy.value = true;
  error.value = '';
  try {
    if (isSetup.value) await setupVault(password.value);
    else await unlockVault(password.value);
    password.value = '';
    confirm.value = '';
  } catch (e) {
    error.value = e.message;
    password.value = '';
    nextTick(() => inputEl.value?.focus());
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="lock">
    <div class="lock__card glass-strong pop-in">
      <div class="lock__mark">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor"
             stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3.5" y="10.5" width="17" height="10.5" rx="3" />
          <path d="M7.5 10.5V7.4a4.5 4.5 0 0 1 9 0v3.1" />
          <circle cx="12" cy="15.7" r="1.3" fill="currentColor" stroke="none" />
        </svg>
      </div>

      <h1 class="lock__title">
        {{ isSetup ? '创建你的账号保险库' : 'Steam 账号管理器' }}
      </h1>
      <p class="lock__sub">
        {{ isSetup
          ? '设置一个主密码。所有账号密码都会用 AES-256-GCM 加密存放，主密码不会被保存，也无法找回。'
          : '输入主密码解锁。数据只保存在这台电脑上，不会联网上传。' }}
      </p>

      <form class="lock__form" @submit.prevent="submit">
        <div class="lock__input-wrap">
          <input
            ref="inputEl"
            v-model="password"
            class="input lock__input"
            :type="reveal ? 'text' : 'password'"
            :placeholder="isSetup ? '设置主密码（至少 6 位）' : '主密码'"
            autocomplete="current-password"
            spellcheck="false"
          />
          <button
            type="button"
            class="lock__eye"
            :title="reveal ? '隐藏' : '显示'"
            @click="reveal = !reveal"
          >
            <svg v-if="!reveal" viewBox="0 0 24 24" width="17" height="17" fill="none"
                 stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
              <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="17" height="17" fill="none"
                 stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
              <path d="M3 3l18 18M10.2 10.4a3 3 0 0 0 4.2 4.2" />
              <path d="M6.4 6.6C3.9 8.5 2.5 12 2.5 12s3.5 6.2 9.5 6.2c1.6 0 3-.4 4.2-1M9.8 5.9c.7-.1 1.4-.1 2.2-.1 6 0 9.5 6.2 9.5 6.2s-.9 1.7-2.7 3.3" />
            </svg>
          </button>
        </div>

        <div v-if="isSetup" class="lock__input-wrap">
          <input
            v-model="confirm"
            class="input lock__input"
            :type="reveal ? 'text' : 'password'"
            placeholder="再输入一次确认"
            autocomplete="new-password"
            spellcheck="false"
          />
        </div>

        <Transition name="fade">
          <div v-if="error || tooShort || mismatch" class="lock__error">
            {{ error || (tooShort ? '主密码至少 6 位' : '两次输入不一致') }}
          </div>
        </Transition>

        <button class="btn btn--primary btn--lg btn--block" type="submit" :disabled="!canSubmit">
          <span v-if="busy" class="lock__spin" />
          {{ busy ? '正在处理…' : (isSetup ? '创建保险库' : '解锁') }}
        </button>
      </form>

      <div class="lock__foot">
        <span class="dot" />
        本地运行 · 数据不出这台电脑
      </div>
    </div>
  </div>
</template>

<style scoped>
.lock {
  position: relative;
  z-index: 1;
  height: 100%;
  display: grid;
  place-items: center;
  padding: 24px;
}

.lock__card {
  width: min(440px, 100%);
  border-radius: var(--r-xl);
  padding: 38px 34px 30px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.lock__mark {
  width: 62px;
  height: 62px;
  border-radius: 20px;
  display: grid;
  place-items: center;
  color: #fff;
  background: linear-gradient(160deg, var(--accent-hi), var(--purple));
  box-shadow: 0 16px 40px -14px var(--accent), 0 1px 0 rgba(255, 255, 255, 0.3) inset;
  margin-bottom: 22px;
}

.lock__title {
  font-size: 25px;
  font-weight: 700;
  letter-spacing: -0.035em;
  line-height: 1.25;
}

.lock__sub {
  font-size: 13.5px;
  color: var(--text-2);
  line-height: 1.62;
  margin-top: 10px;
  max-width: 340px;
}

.lock__form {
  width: 100%;
  margin-top: 26px;
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.lock__input-wrap { position: relative; }
.lock__input {
  height: 47px;
  border-radius: var(--r-md);
  padding-right: 46px;
  font-size: 15px;
  text-align: left;
  letter-spacing: 0.02em;
}
.lock__input[type='password'] { letter-spacing: 0.16em; }

.lock__eye {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur-fast), background var(--dur-fast);
}
.lock__eye:hover { color: var(--text); background: var(--surface-2); }

.lock__error {
  font-size: 12.5px;
  color: var(--red);
  background: var(--red-soft);
  border-radius: var(--r-xs);
  padding: 8px 11px;
  text-align: left;
}

.lock__spin {
  width: 14px; height: 14px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.lock__foot {
  margin-top: 22px;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-3);
}
.lock__foot .dot { background: var(--green); }

.fade-enter-active, .fade-leave-active { transition: opacity 200ms var(--ease-out); }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
