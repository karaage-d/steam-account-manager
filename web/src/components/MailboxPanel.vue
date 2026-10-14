<script setup>
/**
 * 邮箱面板 —— 管理用于读取 Steam 验证码的邮箱。
 *
 * 支持两种提供商：
 *   microsoft  微软邮箱（Graph + refresh token）
 *   http       取件接口（iCloud 这类没有公开 API 的邮箱，填一条能返回邮件的接口地址）
 */
import { ref, computed, onMounted } from 'vue';
import {
  state, refreshMailboxes, addMailbox, removeMailbox,
  testMailbox, fetchMailbox, loadMessages, openMessage,
  fmtAgo, fmtDateTime,
} from '../lib/store.js';
import { toastWarn, toastError, toastSuccess } from '../lib/toast.js';
import { copyText } from '../lib/api.js';

const emit = defineEmits(['close']);

const showAdd = ref(false);
const busy = ref('');
const detail = ref(null);          // 展开的那封邮件
const form = ref({
  provider: 'microsoft',
  label: '',
  address: '',
  clientId: '',
  refreshToken: '',
  apiUrl: '',
});

const PROVIDERS = [
  { key: 'microsoft', label: '微软邮箱', hint: '要 client_id + refresh token' },
  { key: 'http', label: '取件接口', hint: 'iCloud 等：一条能返回邮件的接口地址' },
];

/** 从接口地址里认邮箱 —— wdmail 这类是 ?e=邮箱:密码 */
function addressFromUrl(raw) {
  try {
    const u = new URL(String(raw));
    for (const key of ['e', 'email', 'mail', 'account', 'user']) {
      const v = u.searchParams.get(key);
      if (!v) continue;
      const addr = v.includes(':') ? v.split(':')[0] : v;
      if (/@/.test(addr)) return addr.trim();
    }
    const m = String(raw).match(/[^\s:/@]+@[^\s:/@?&]+/);
    if (m) return m[0];
  } catch { /* 还不是合法 URL */ }
  return '';
}

/** 地址里内嵌凭据 = 它本身就是钥匙 */
function urlHasCredential(raw) {
  try {
    const u = new URL(String(raw));
    for (const key of ['e', 'email', 'mail', 'account', 'user']) {
      const v = u.searchParams.get(key);
      if (v && v.includes(':') && v.split(':')[1]) return true;
    }
  } catch { /* 忽略 */ }
  return false;
}

const isHttp = computed(() => form.value.provider === 'http');
const detectedAddress = computed(() => (isHttp.value ? addressFromUrl(form.value.apiUrl) : ''));
const urlCarriesSecret = computed(() => (isHttp.value ? urlHasCredential(form.value.apiUrl) : false));

const selected = computed(() => state.mailboxes.find((b) => b.id === state.mailSelectedId) || null);

const STATUS = {
  ok: { text: '正常', cls: 'st--ok' },
  need_reauth: { text: '需重新授权', cls: 'st--bad' },
  error: { text: '出错', cls: 'st--warn' },
  unknown: { text: '未验证', cls: 'st--idle' },
};
const statusOf = (b) => STATUS[b.status] || STATUS.unknown;

onMounted(async () => {
  try { await refreshMailboxes(); } catch (e) { toastError('读取邮箱列表失败', { detail: e.message }); }
});

/**
 * ★ 需求里给的就是一整行 ★
 *   humbugs_errors4z@icloud.com----https://api.wdmail.top/m?f=html&e=humbugs_errors4z@icloud.com:TF4Tqxn8
 * 不管粘到「取件接口地址」还是「邮箱地址」哪一栏，都自动拆成两栏。
 * 普通粘贴（没有 `----`）不受影响，照原样落进输入框。
 */
function onPasteLine(e) {
  const text = (e.clipboardData?.getData('text') || '').trim();
  const m = text.match(/^([^\s@]+@[^\s@]+?)\s*[-—–]{2,}\s*(\S[\s\S]*)$/);
  if (!m) return;
  e.preventDefault();
  form.value.address = m[1].trim();
  form.value.apiUrl = m[2].trim();
  toastSuccess('已拆成「邮箱地址 + 取件接口地址」两栏', { detail: form.value.address });
}

async function submitAdd() {
  const f = form.value;
  const http = f.provider === 'http';
  const apiUrl = f.apiUrl.trim();

  // 邮箱地址：留空就用接口地址里认出来的
  let finalAddress = http ? (f.address.trim() || detectedAddress.value) : f.address.trim();
  // 容错：用户很容易把整条接口地址粘进「邮箱地址」那一栏。只要它像 URL，就先把邮箱抠出来。
  if (finalAddress.includes('://') || !finalAddress.includes('@')) {
    const fromUrl = addressFromUrl(finalAddress.includes('://') ? finalAddress : apiUrl);
    if (fromUrl) finalAddress = fromUrl;
  }

  if (!finalAddress) {
    toastWarn(http ? '没能从接口地址里认出邮箱，请手动填一下邮箱地址' : '填一下邮箱地址');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(finalAddress)) {
    toastWarn('这不是一个合法的邮箱地址', {
      detail: '「邮箱地址」要填邮箱本身，接口地址请填到上面那一栏',
      duration: 7000,
    });
    return;
  }
  if (http) {
    if (!/^https?:\/\//i.test(apiUrl)) { toastWarn('接口地址要以 http:// 或 https:// 开头'); return; }
    if (urlHasCredential(apiUrl)) {
      toastWarn('这条地址里内嵌了凭据', {
        detail: '它本身就是钥匙，别外传；确认无误就继续',
        duration: 6000,
      });
    }
  } else {
    if (!f.clientId.trim()) { toastWarn('client_id 不能为空', { detail: '微软应用的 client_id' }); return; }
    if (!f.refreshToken.trim()) { toastWarn('refresh token 不能为空'); return; }
  }

  busy.value = 'add';
  try {
    const box = await addMailbox({
      provider: f.provider,
      label: f.label.trim() || finalAddress,
      address: finalAddress,
      clientId: http ? '' : f.clientId.trim(),
      credential: http ? apiUrl : f.refreshToken.trim(),
      apiUrl: http ? apiUrl : undefined,
    });
    form.value = {
      provider: f.provider, label: '', address: '', clientId: '', refreshToken: '', apiUrl: '',
    };
    showAdd.value = false;
    // 顺手测一次，让用户立刻知道凭据对不对
    await run('test', box);
  } catch (e) {
    toastError('添加失败', { detail: e.message });
  } finally {
    busy.value = '';
  }
}

async function run(kind, box) {
  busy.value = `${kind}:${box.id}`;
  try {
    if (kind === 'test') await testMailbox(box.id);
    else if (kind === 'fetch') await fetchMailbox(box.id);
    else if (kind === 'open') {
      detail.value = null;
      await loadMessages(box.id);
    }
  } catch { /* toast 已在 store 里弹过 */ } finally {
    busy.value = '';
  }
}

async function expand(msg) {
  if (detail.value?.id === msg.id) { detail.value = null; return; }
  try { detail.value = await openMessage(msg.id); } catch (e) { toastError('读取邮件失败', { detail: e.message }); }
}

async function doRemove(box) {
  // 二次确认，避免误删
  if (!window.confirm(`删除邮箱「${box.address}」？\n\n已拉取的 ${box.messageCount} 封邮件也会一起删掉。`)) return;
  try { await removeMailbox(box.id); } catch (e) { toastError('删除失败', { detail: e.message }); }
}

function back() {
  state.mailSelectedId = null;
  state.mailMessages = [];
  detail.value = null;
}

async function copyCode(code) {
  const ok = await copyText(code);
  if (ok) toastSuccess(`已复制验证码 ${code}`);
  else toastWarn('复制失败，手动抄一下吧');
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="sheet mail pop-in">
      <div class="sheet__head">
        <div>
          <div class="sheet__title">
            <button v-if="selected" class="backbtn" title="返回邮箱列表" @click="back">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                   stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
                <path d="m14 6-6 6 6 6" />
              </svg>
            </button>
            {{ selected ? selected.address : '邮箱' }}
          </div>
          <div class="sheet__sub">
            <template v-if="selected">
              {{ state.mailMessages.length }} 封已拉取
              <span v-if="selected.lastFetchAt"> · 上次拉取 {{ fmtAgo(selected.lastFetchAt) }}</span>
            </template>
            <template v-else>
              用于自动读取 Steam 验证码 · 本期只做收取，暂不提取验证码
            </template>
          </div>
        </div>
        <button class="btn btn--ghost btn--icon btn--sm" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      <div class="sheet__body">
        <!-- ================= 邮箱列表 ================= -->
        <template v-if="!selected">
          <div class="ratecard">
            <div class="ratecard__t">防封设置</div>
            <div class="ratecard__d">
              请求串行发送 · 每次间隔 {{ ((state.mailConfig?.minIntervalMs ?? 1500) / 1000).toFixed(1) }} 秒
              + 最多 {{ state.mailConfig?.jitterMs ?? 800 }}ms 随机抖动 · 被限流自动退避
              <template v-if="state.mailRate">
                <br>已发 {{ state.mailRate.requests }} 次请求<template v-if="state.mailRate.throttled">，被限流 {{ state.mailRate.throttled }} 次</template>
                <template v-if="state.mailRate.pendingPenaltyMs > 0">
                  · 正在退避，还需 {{ Math.ceil(state.mailRate.pendingPenaltyMs / 1000) }} 秒
                </template>
              </template>
            </div>
          </div>

          <div v-if="!state.mailboxes.length && !showAdd" class="empty">
            <div class="empty__title">还没有添加邮箱</div>
            <div class="empty__text">添加微软邮箱后，就能在这里拉取邮件。<br>下一步会从邮件里自动提取验证码。</div>
          </div>

          <div v-for="box in state.mailboxes" :key="box.id" class="mbox">
            <div class="mbox__main">
              <div class="mbox__row">
                <span class="mbox__label">{{ box.label || box.address }}</span>
                <span class="st" :class="statusOf(box).cls">{{ statusOf(box).text }}</span>
              </div>
              <div class="mbox__addr mono">{{ box.address }}</div>
              <div class="mbox__meta">
                <span class="prov">{{ box.providerLabel || '微软邮箱' }}</span>
                <span>{{ box.messageCount }} 封</span>
                <span v-if="box.lastOkAt">· 上次成功 {{ fmtAgo(box.lastOkAt) }}</span>
                <span v-if="box.clientIdHint">· client {{ box.clientIdHint }}</span>
                <span v-if="box.credentialInUrl" class="mbox__warn">· 凭据内嵌在地址里</span>
              </div>
              <div v-if="box.lastError" class="mbox__err">{{ box.lastError }}</div>
            </div>
            <div class="mbox__acts">
              <button class="btn btn--sm" :disabled="!!busy"
                      @click="run('test', box)">
                {{ busy === `test:${box.id}` ? '测试中…' : '测试连接' }}
              </button>
              <button class="btn btn--sm btn--primary" :disabled="!!busy"
                      @click="run('fetch', box)">
                {{ busy === `fetch:${box.id}` ? '拉取中…' : '拉取邮件' }}
              </button>
              <button class="btn btn--sm" :disabled="!!busy" @click="run('open', box)">查看邮件</button>
              <button class="btn btn--sm btn--ghost danger" :disabled="!!busy" @click="doRemove(box)">删除</button>
            </div>
          </div>

          <!-- 添加表单 -->
          <div v-if="showAdd" class="addbox">
            <div class="field">
              <label class="field__label">邮箱类型</label>
              <div class="seg">
                <button v-for="p in PROVIDERS" :key="p.key" class="seg__btn"
                        :class="{ 'seg__btn--on': form.provider === p.key }"
                        @click="form.provider = p.key">{{ p.label }}</button>
              </div>
              <span class="field__hint">{{ PROVIDERS.find((p) => p.key === form.provider)?.hint }}</span>
            </div>

            <div class="field">
              <label class="field__label">备注名（选填）</label>
              <input v-model="form.label" class="input" placeholder="例如：游戏邮箱 A" spellcheck="false" />
            </div>

            <!-- ===== 取件接口 ===== -->
            <template v-if="isHttp">
              <div class="field">
                <label class="field__label">取件接口地址</label>
                <textarea v-model="form.apiUrl" class="input mono ta" rows="2"
                          placeholder="https://api.example.com/m?f=json&e=你对这个邮箱的地址"
                          spellcheck="false" @paste="onPasteLine" />
                <span class="field__hint">
                  这类接口把邮箱凭据写在地址里（通常是 <code>?e=邮箱:密码</code>），
                  <b>地址本身就是钥匙</b> —— 会加密存库，别外传。<br />
                  也可以直接把需求里那条整行粘进来：
                  <code>邮箱@icloud.com----https://…</code>，会自动拆成两栏。
                </span>
              </div>
              <div v-if="urlCarriesSecret" class="warnbox">
                ⚠️ 这条地址里内嵌了凭据。它能读那个邮箱的<b>全部</b>邮件（不只是 Steam 的），
                在别处贴过就建议换一次。
              </div>
              <div class="field">
                <label class="field__label">邮箱地址</label>
                <input v-model="form.address" class="input mono"
                       :placeholder="detectedAddress || '通常能从接口地址里自动认出来'"
                       spellcheck="false" @paste="onPasteLine" />
                <span v-if="detectedAddress" class="field__hint">
                  已从接口地址里认出：<b class="mono">{{ detectedAddress }}</b>（留空就用它）
                </span>
              </div>
            </template>

            <!-- ===== 微软邮箱 ===== -->
            <template v-else>
              <div class="field">
                <label class="field__label">邮箱地址</label>
                <input v-model="form.address" class="input mono" placeholder="box@outlook.com" spellcheck="false" />
              </div>
              <div class="field">
                <label class="field__label">client_id</label>
                <input v-model="form.clientId" class="input mono" placeholder="微软应用的 client_id" spellcheck="false" />
              </div>
              <div class="field">
                <label class="field__label">refresh token</label>
                <textarea v-model="form.refreshToken" class="input mono ta" rows="3"
                          placeholder="粘贴 refresh token" spellcheck="false" />
              </div>
            </template>

            <span class="field__hint addbox__note">
              凭据和账号密码一样用 AES-256-GCM 加密存库，接口永远不会再把它读回来。
              提交时会自动测一次连接。
            </span>

            <div class="addbox__acts">
              <button class="btn btn--sm btn--ghost" @click="showAdd = false">取消</button>
              <button class="btn btn--sm btn--primary" :disabled="busy === 'add'" @click="submitAdd">
                {{ busy === 'add' ? '添加中…' : '添加并测试' }}
              </button>
            </div>
          </div>

          <button v-else class="btn btn--primary addbtn" @click="showAdd = true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                 stroke-width="2.2" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13" /></svg>
            添加邮箱
          </button>
        </template>

        <!-- ================= 邮件列表 ================= -->
        <template v-else>
          <div class="mact">
            <button class="btn btn--sm btn--primary" :disabled="!!busy" @click="run('fetch', selected)">
              {{ busy === `fetch:${selected.id}` ? '拉取中…' : '拉取新邮件' }}
            </button>
            <button class="btn btn--sm" :disabled="!!busy" @click="run('test', selected)">
              {{ busy === `test:${selected.id}` ? '测试中…' : '测试连接' }}
            </button>
          </div>

          <div v-if="!state.mailMessages.length" class="empty">
            <div class="empty__title">还没有邮件</div>
            <div class="empty__text">点上面的「拉取新邮件」试试。</div>
          </div>

          <div v-for="m in state.mailMessages" :key="m.id" class="msg"
               :class="{ 'msg--open': detail?.id === m.id }" @click="expand(m)">
            <div class="msg__row">
              <span class="msg__subj">
                <span v-if="m.isSteam" class="tag tag--steam">Steam</span>
                {{ m.subject || '(无主题)' }}
              </span>
              <span class="msg__time">{{ fmtAgo(m.receivedAt) }}</span>
            </div>
            <div class="msg__from mono">
              {{ m.fromAddress }}
              <span v-if="m.toAddress"> → {{ m.toAddress }}</span>
            </div>
            <div class="msg__prev">{{ m.bodyPreview }}</div>

            <!-- ★ 识别到的验证码：一眼就能看出提取逻辑对没对 ★ -->
            <div v-if="m.code" class="codemark">
              <span class="codemark__t">识别到验证码</span>
              <b class="codemark__c mono">{{ m.code }}</b>
              <span class="codemark__s">{{ m.codeSource }}</span>
              <button class="btn btn--sm codemark__copy" @click.stop="copyCode(m.code)">复制</button>
            </div>
            <div v-else-if="m.isSteam" class="codefail">没识别出验证码（点开看正文，确认格式）</div>

            <div v-if="detail?.id === m.id" class="msg__full">
              <div class="msg__fullhead">
                <span>收件地址：<b class="mono">{{ detail.toAddress || '—' }}</b></span>
                <span>{{ fmtDateTime(detail.receivedAt) }}</span>
              </div>
              <pre class="msg__body">{{ detail.bodyText || '(没有正文)' }}</pre>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sheet.mail { width: min(760px, calc(100vw - 32px)); max-height: min(84vh, 760px); }
.sheet.mail :deep(.sheet__body) { padding-bottom: 22px; }

.backbtn {
  width: 26px; height: 26px; margin-right: 6px;
  display: inline-grid; place-items: center;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--surface-2); color: var(--text-2);
  cursor: pointer; vertical-align: middle;
  transition: all var(--dur-fast);
}
.backbtn:hover { color: var(--text); border-color: var(--border-2); }

.ratecard {
  padding: 11px 13px; margin: 16px 0 14px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: linear-gradient(120deg, var(--accent-soft), transparent 70%);
}
.ratecard__t { font-size: 12px; font-weight: 680; margin-bottom: 4px; }
.ratecard__d { font-size: 11.5px; color: var(--text-3); line-height: 1.65; }

.empty { padding: 30px 20px; }
.mbox {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 13px; margin-bottom: 9px;
  border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--surface-2);
}
.mbox__main { flex: 1; min-width: 0; }
.mbox__row { display: flex; align-items: center; gap: 8px; }
.mbox__label { font-size: 13px; font-weight: 640; }
.mbox__addr { font-size: 11.5px; color: var(--text-2); margin-top: 2px; }
.mbox__meta {
  font-size: 11px; color: var(--text-3); margin-top: 4px;
  display: flex; gap: 5px; flex-wrap: wrap;
}
.mbox__err {
  font-size: 11px; color: var(--red); margin-top: 5px;
  line-height: 1.5; word-break: break-all;
}
.mbox__acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; max-width: 300px; }

.st { font-size: 10.5px; padding: 2px 7px; border-radius: 999px; font-weight: 620; }
.prov {
  font-size: 10px; padding: 1px 6px; border-radius: 4px;
  background: var(--accent-soft); color: var(--accent-hi); font-weight: 620;
}
.mbox__warn { color: var(--orange); }
.st--ok { background: var(--green-soft); color: var(--green); }
.st--bad { background: var(--red-soft); color: var(--red); }
.st--warn { background: var(--orange-soft); color: var(--orange); }
.st--idle { background: var(--surface-3); color: var(--text-3); }

.addbox {
  margin-top: 12px; padding: 14px;
  border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--surface-2);
}
.addbox__acts { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.addbox__note { display: block; margin-top: 4px; }
.ta { resize: vertical; font-size: 11.5px; line-height: 1.55; min-height: 62px; }
.addbtn { width: 100%; justify-content: center; }

/* 提供商切换 */
.seg {
  display: flex; gap: 4px; padding: 3px;
  border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--surface);
}
.seg__btn {
  flex: 1; height: 28px;
  border: 0; border-radius: var(--r-xs);
  background: transparent; color: var(--text-2);
  font-size: 12.5px; font-family: inherit; cursor: pointer;
  transition: all var(--dur-fast);
}
.seg__btn:hover { color: var(--text); background: var(--surface-3); }
.seg__btn--on { background: var(--accent); color: #fff; }

.warnbox {
  padding: 8px 11px; margin-bottom: 12px;
  border-radius: var(--r-xs);
  background: var(--orange-soft); color: var(--orange);
  font-size: 11.5px; line-height: 1.6;
}

.mact { display: flex; gap: 8px; margin-bottom: 12px; }

.msg {
  padding: 11px 13px; margin-bottom: 7px;
  border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--surface-2); cursor: pointer;
  transition: border-color var(--dur-fast);
}
.msg:hover { border-color: var(--border-2); }
.msg--open { border-color: var(--accent); }
.msg__row { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
.msg__subj { font-size: 12.5px; font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg__time { font-size: 11px; color: var(--text-3); flex: none; }
.msg__from { font-size: 11px; color: var(--text-3); margin-top: 3px; }
.msg__prev {
  font-size: 11.5px; color: var(--text-2); margin-top: 5px;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}

.tag {
  display: inline-block; margin-right: 5px;
  font-size: 9.5px; font-weight: 700; letter-spacing: 0.03em;
  padding: 1px 5px; border-radius: 4px; vertical-align: 1px;
}
.tag--steam { background: var(--accent-soft); color: var(--accent-hi); }

.codemark {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 8px; padding: 7px 10px;
  border-radius: var(--r-xs);
  background: var(--green-soft);
}
.codemark__t { font-size: 10.5px; color: var(--text-2); }
.codemark__c {
  font-size: 16px; font-weight: 750; letter-spacing: 0.09em;
  color: var(--green);
}
.codemark__s { font-size: 10px; color: var(--text-3); }
.codemark__copy { margin-left: auto; }
.codefail {
  margin-top: 8px; padding: 6px 10px;
  border-radius: var(--r-xs);
  background: var(--orange-soft); color: var(--orange);
  font-size: 11px;
}
.msg__full { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--hairline); }
.msg__fullhead {
  display: flex; justify-content: space-between; gap: 10px;
  font-size: 11px; color: var(--text-3); margin-bottom: 8px;
}
.msg__body {
  margin: 0; padding: 10px;
  font-size: 12px; line-height: 1.7;
  white-space: pre-wrap; word-break: break-word;
  background: var(--surface); border-radius: var(--r-xs);
  max-height: 260px; overflow: auto;
  font-family: inherit;
}
.danger { color: var(--red); }
.danger:hover { background: var(--red-soft); }
</style>
