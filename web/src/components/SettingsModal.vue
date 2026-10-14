<script setup>
import { ref, onMounted } from 'vue';
import Toggle from './Toggle.vue';
import {
  state, saveSettings, rotateApiKey, testWebhook, setTheme,
  refreshSettings, lockVault, TAB_KEYS,
} from '../lib/store.js';
import { api, get, downloadText, copyText } from '../lib/api.js';
import { toastSuccess, toastError, toastWarn } from '../lib/toast.js';

const emit = defineEmits(['close']);

const cur = ref('');
const next = ref('');
const confirmPw = ref('');
const pwBusy = ref(false);

onMounted(refreshSettings);

function patch(obj) { saveSettings(obj); }

async function changeMaster() {
  if (next.value.length < 6) { toastWarn('新主密码至少 6 位'); return; }
  if (next.value !== confirmPw.value) { toastWarn('两次输入不一致'); return; }
  pwBusy.value = true;
  try {
    const r = await api('POST', '/api/master/change', { current: cur.value, next: next.value });
    sessionStorage.setItem('vault.token', r.token);
    cur.value = ''; next.value = ''; confirmPw.value = '';
    toastSuccess('主密码已更新', { detail: '所有账号密码已用新密钥重新加密' });
  } catch (e) {
    toastError('修改失败', { detail: e.message });
  } finally {
    pwBusy.value = false;
  }
}

async function exportData(format, mode) {
  try {
    const r = await get(`/api/accounts/export?format=${format}&mode=${mode || 'readable'}`);
    if (format === 'json') downloadText(r.filename, JSON.stringify(r.json, null, 2));
    else downloadText(r.filename, r.text);
    toastWarn('文件已导出', { detail: '导出内容是明文，请妥善保管，用完建议删除', duration: 8000 });
  } catch (e) {
    toastError('导出失败', { detail: e.message });
  }
}

async function copyKey() {
  const ok = await copyText(state.apiKey);
  if (ok) toastSuccess('API Key 已复制');
  else toastWarn('复制失败');
}

const counts = () => TAB_KEYS.map((k) => `${state.counts[k] ?? 0}`).join(' / ');
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="sheet settings pop-in">
      <div class="sheet__head">
        <div>
          <div class="sheet__title">设置</div>
          <div class="sheet__sub">可用 / 使用中 / 待改密 当前共 {{ state.stats?.total ?? 0 }} 个账号</div>
        </div>
        <button class="btn btn--ghost btn--icon btn--sm" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      <div class="sheet__body">
        <!-- 取用行为 -->
        <div class="scard">
          <div class="scard__head">
            <div class="scard__title">取用行为</div>
          </div>
          <div class="srow">
            <div class="srow__l">
              <div class="srow__t">开始使用时自动复制</div>
              <div class="srow__d">点「开始使用」后，把「账号 / 密码」格式自动复制到剪贴板</div>
            </div>
            <Toggle
              :model-value="state.settings.autoCopyOnUse"
              @update:model-value="patch({ autoCopyOnUse: $event })"
            />
          </div>
          <div class="srow">
            <div class="srow__l">
              <div class="srow__t">闲置自动锁库</div>
              <div class="srow__d">超过这个时间没有任何操作就自动锁定，需要重新输入主密码（0 表示不锁）</div>
            </div>
            <div class="srow__r">
              <input
                type="number" min="0" max="1440" class="input ninput"
                :value="state.settings.autoLockMinutes"
                @change="patch({ autoLockMinutes: Number($event.target.value) })"
              />
              <span class="unit">分钟</span>
            </div>
          </div>
        </div>

        <!-- 自动化回调 -->
        <div class="scard">
          <div class="scard__head">
            <div class="scard__title">自动化回调（Webhook）</div>
            <div class="scard__sub">
              有账号倒计时结束、进入「待改密」时，向这个地址推送一条 POST，让你的 AI 程序立刻被唤醒
            </div>
          </div>
          <div class="srow srow--col">
            <div class="field" style="width:100%">
              <label class="field__label">Webhook 地址</label>
              <input
                class="input mono" placeholder="http://127.0.0.1:9000/steam-change-password"
                :value="state.settings.webhookUrl"
                @change="patch({ webhookUrl: $event.target.value })"
              />
            </div>
          </div>
          <div class="srow">
            <div class="srow__l">
              <div class="srow__t">签名密钥</div>
              <div class="srow__d">
                会用 <code>sha256=&lt;hmac&gt;</code> 写进 <code>X-Vault-Signature</code> 头，方便校验来源
              </div>
            </div>
            <input
              class="input mono srow__input" placeholder="可选"
              :value="state.settings.webhookSecret"
              @change="patch({ webhookSecret: $event.target.value })"
            />
          </div>
          <div class="srow">
            <div class="srow__l">
              <div class="srow__t">测试推送</div>
              <div class="srow__d">向上面填写的地址发送一条测试事件</div>
            </div>
            <button class="btn btn--sm" @click="testWebhook">发送测试</button>
          </div>
        </div>

        <!-- 安全 -->
        <div class="scard">
          <div class="scard__head">
            <div class="scard__title">安全</div>
            <div class="scard__sub">主密码与自动化 API Key</div>
          </div>

          <div class="srow">
            <div class="srow__l">
              <div class="srow__t">自动化 API Key</div>
              <div class="srow__d">外部 AI 用它调用改密接口，重置后旧脚本立即失效</div>
            </div>
            <div class="srow__r">
              <code class="keycode mono">{{ state.apiKey.slice(0, 10) }}…</code>
              <button class="btn btn--sm" @click="copyKey">复制</button>
              <button class="btn btn--sm btn--danger" @click="rotateApiKey">重置</button>
            </div>
          </div>

          <div class="srow srow--col">
            <div class="srow__t" style="margin-bottom:9px">修改主密码</div>
            <div class="pwgrid">
              <input v-model="cur" class="input" type="password" placeholder="当前主密码" autocomplete="off" />
              <input v-model="next" class="input" type="password" placeholder="新主密码（至少 6 位）" autocomplete="off" />
              <input v-model="confirmPw" class="input" type="password" placeholder="再输一次新主密码" autocomplete="off" />
              <button class="btn btn--primary" :disabled="pwBusy || !cur || !next" @click="changeMaster">
                {{ pwBusy ? '处理中…' : '修改' }}
              </button>
            </div>
            <div class="srow__d" style="margin-top:9px">
              修改后会立即用新密钥重新加密全部账号密码，所有会话失效。
            </div>
          </div>
        </div>

        <!-- 外观与数据 -->
        <div class="scard">
          <div class="scard__head"><div class="scard__title">外观与数据</div></div>

          <div class="srow">
            <div class="srow__l">
              <div class="srow__t">界面主题</div>
              <div class="srow__d">深色更沉浸，浅色更接近 macOS 原生观感</div>
            </div>
            <div class="segmini">
              <button class="segmini__b" :class="{ 'segmini__b--on': state.settings.theme === 'dark' }"
                      @click="setTheme('dark')">深色</button>
              <button class="segmini__b" :class="{ 'segmini__b--on': state.settings.theme === 'light' }"
                      @click="setTheme('light')">浅色</button>
            </div>
          </div>

          <div class="srow">
            <div class="srow__l">
              <div class="srow__t">导出账号</div>
              <div class="srow__d">导出为明文文件，请自行妥善保管</div>
            </div>
            <div class="srow__r">
              <button class="btn btn--sm" @click="exportData('txt', 'readable')">账号/密码 TXT</button>
              <button class="btn btn--sm" @click="exportData('txt', 'csv')">CSV</button>
              <button class="btn btn--sm" @click="exportData('json')">JSON</button>
            </div>
          </div>

          <div class="srow">
            <div class="srow__l">
              <div class="srow__t">数据位置</div>
              <div class="srow__d">
                全部数据在 <code>data/vault.db</code>，密码字段为 AES-256-GCM 密文
              </div>
            </div>
            <button class="btn btn--sm" @click="lockVault(); emit('close')">立即锁定</button>
          </div>
        </div>

        <div class="about">
          Steam 账号管理器 · 本地版 v2.0.0 · 当前 {{ counts() }}（可用 / 使用中 / 待改密）
        </div>
      </div>

      <div class="sheet__foot">
        <button class="btn" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings { width: min(720px, 100%); }

.scard {
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--surface);
  padding: 15px 17px;
  margin-bottom: 12px;
}
.scard__head { margin-bottom: 4px; }
.scard__title { font-size: 14px; font-weight: 680; letter-spacing: -0.02em; }
.scard__sub { font-size: 12px; color: var(--text-3); margin-top: 3px; line-height: 1.55; }

.srow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 12px 0;
  border-top: 1px solid var(--hairline);
  margin-top: 10px;
}
.srow--col { flex-direction: column; align-items: stretch; }
.srow__l { min-width: 0; }
.srow__t { font-size: 13px; font-weight: 600; letter-spacing: -0.01em; }
.srow__d { font-size: 11.5px; color: var(--text-3); margin-top: 3px; line-height: 1.55; max-width: 460px; }
.srow__r { display: flex; align-items: center; gap: 9px; flex: none; }
.srow__input { width: 240px; height: 34px; font-size: 12.5px; }
.unit { font-size: 12px; color: var(--text-3); }
.ninput { width: 84px; height: 34px; text-align: center; font-variant-numeric: tabular-nums; }

.pwgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; align-items: center; }

.keycode {
  font-size: 12px;
  color: var(--accent);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  padding: 6px 10px;
}

.segmini {
  display: flex;
  padding: 3px;
  gap: 3px;
  border-radius: var(--r-xs);
  background: var(--surface);
  border: 1px solid var(--border);
}
.segmini__b {
  height: 26px;
  padding: 0 14px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 550;
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.segmini__b--on { background: var(--surface-3); color: var(--text); font-weight: 650; }

.about { text-align: center; font-size: 11.5px; color: var(--text-3); padding: 4px 0 8px; }

code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--surface-3);
  padding: 1px 5px;
  border-radius: 5px;
}
</style>
