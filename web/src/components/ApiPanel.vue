<script setup>
/**
 * API 面板 —— 给外部程序（客服系统 / AI）取号用的接口，集中放这一个框里。
 *
 * 三块内容：
 *   ① 连接信息：接口地址 + 完整 API Key（带复制 / 重置）
 *   ② 在线试用：输入游戏名 → 真的调一次领号接口 → 直接看到账号密码
 *   ③ 调用示例：curl / JavaScript / Python，复制就能用
 *
 * ★ 为什么单独做一个面板 ★
 *   之前这些只散落在「设置」里的半截 Key 和 /api/automation/spec 那个给程序看的说明书里，
 *   人不好找、也不好验证。独立成一个面板，接客服系统时照着抄就行。
 */
import { ref, computed, onMounted } from 'vue';
import { state, refreshSettings, rotateApiKey, claimAccount, searchAvailable } from '../lib/store.js';
import { copyText } from '../lib/api.js';
import { toastSuccess, toastError, toastWarn } from '../lib/toast.js';

const emit = defineEmits(['close']);

const game = ref('');
const minutes = ref('');       // 订单时长（分钟）。留空 = 用账号自己配的时长
const busy = ref(false);
const result = ref(null);      // 领号结果 { ok, username, password, text, message, ... }
const preview = ref(null);     // 查询结果 { count, items } —— 只查不领
const tab = ref('curl');

onMounted(refreshSettings);

/** 把用户填的时长换算成分钟：支持「6」「360」「6小时」「6h」「90分钟」 */
function minutesOf(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const n = Number(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/小时|hour|hr|h$/i.test(s)) return Math.round(n * 60);
  return Math.round(n);
}

/**
 * 查一查：只列出有几个空闲账号，**不改变任何状态**。
 * ★ 这个是搜索，回车和按钮都走它 ★
 */
async function doSearch() {
  busy.value = true;
  preview.value = null;
  result.value = null;          // 换了查询条件，旧的领号结果就不显示了
  try {
    preview.value = await searchAvailable(game.value.trim());
  } catch (e) {
    preview.value = { count: 0, items: [], error: e.message };
  } finally {
    busy.value = false;
  }
}

/**
 * 领取：★ 会真的把账号领走 ★ 所以必须先确认。
 */
async function doClaim() {
  if (!preview.value) { await doSearch(); return; }
  if (!preview.value.count) {
    toastWarn('没有可领的账号', { detail: game.value ? `没有空闲的「${game.value}」账号` : '当前一个空闲账号都没有' });
    return;
  }
  const who = game.value.trim() ? `「${game.value.trim()}」的` : '';
  const mins = minutesOf(minutes.value);
  const durTxt = mins ? `，使用时间改成 ${mins} 分钟（${(mins / 60).toFixed(mins % 60 ? 1 : 0)} 小时）` : '，用账号原本配置的时长';
  if (!confirm(`确认领取一个${who}账号？\n\n账号会进入「使用中」开始计时${durTxt}，到点自动改密。\n（只是想看看有几个，不用点这个）`)) return;

  busy.value = true;
  result.value = null;
  try {
    result.value = await claimAccount(game.value.trim(), mins);
  } catch (e) {
    result.value = { ok: false, message: e.message };
  } finally {
    busy.value = false;
  }
}

const base = computed(() => state.settingsBase || location.origin);
const key = computed(() => state.apiKey || '');

const ENDPOINTS = [
  { m: 'GET', p: '/api/automation/claim?game=CS2', d: '★ 按游戏名一步领号（含密码）' },
  { m: 'GET', p: '/api/automation/available?q=CS2', d: '列出空闲账号（不领走）' },
  { m: 'POST', p: '/api/automation/accounts/{id}/use', d: '指定账号开始使用 → 返回凭据' },
  { m: 'GET', p: '/api/automation/accounts/{id}/credential', d: '只取凭据（?format=text 给纯文本）' },
  { m: 'GET', p: '/api/automation/tasks?status=pending', d: '拉取待改密任务' },
  { m: 'GET', p: '/api/automation/context/{id}', d: '读取改密上下文（含当前密码）' },
  { m: 'POST', p: '/api/automation/tasks/{id}/claim', d: '声明接管改密任务' },
  { m: 'POST', p: '/api/automation/tasks/{id}/complete', d: '回传新密码，账号回到「可用」' },
];

const SAMPLES = computed(() => ({
  curl: `# 订单「链在一起 6小时」→ game 填游戏名，hours 填订单时长\ncurl.exe -H "X-API-Key: ${key.value || '<你的密钥>'}" \\\n  "${base.value}/api/automation/claim?game=${encodeURIComponent('链在一起')}&hours=6"\n\n# 用分钟也行：&minutes=360\n# 不传时长就用账号原本配的时长`,
  js: `const r = await fetch('${base.value}/api/automation/claim'
  + '?game=' + encodeURIComponent('链在一起') + '&hours=6', {
  headers: { 'X-API-Key': '${key.value || '<你的密钥>'}' },
});
const d = await r.json();
if (d.ok) {
  console.log(d.text);          // 「账号：\\nxxx\\n\\n密码：\\nyyy」
  console.log('可用', d.usageMinutes, '分钟');
} else {
  console.log(d.message);       // 「暂无账号」
}`,
  py: `import requests

# 订单：链在一起 6 小时
r = requests.get('${base.value}/api/automation/claim',
                 params={'game': '链在一起', 'hours': 6},
                 headers={'X-API-Key': '${key.value || '<你的密钥>'}'})
d = r.json()
if d.get('ok'):
    print(d['text'])            # 账号：/密码：
    print('可用', d['usageMinutes'], '分钟')
else:
    print(d['message'])         # 暂无账号`,
  http: `GET ${base.value}/api/automation/claim?game=链在一起&hours=6
X-API-Key: ${key.value || '<你的密钥>'}

--- 有货时 ---
{
  "ok": true,
  "username": "3945687452",
  "password": "Fxvxtbmx0d",
  "text": "账号：\\n3945687452\\n\\n密码：\\nFxvxtbmx0d",
  "game": "链在一起",
  "matchedBy": "exact",
  "usageMinutes": 360,          // ← 按订单改成了 6 小时
  "appliedMinutes": 360,
  "durationChanged": true,
  "expiresAt": 1791620000
}

--- 没货时 ---
{ "ok": false, "message": "暂无账号" }

--- 参数写法（都认）---
hours=6 · minutes=360 · h=6 · duration=6小时 · 小时=6`,
}));

async function copy(text, label) {
  const ok = await copyText(text);
  if (ok) toastSuccess(`${label} 已复制`);
  else toastWarn('复制失败，请手动选中');
}

async function doRotate() {
  if (!confirm('重置后旧密钥立即失效，所有正在用它的外部程序都要改。确定重置？')) return;
  try {
    await rotateApiKey();
    toastSuccess('API Key 已重置', { detail: '别忘了把新 Key 更新到客服系统里' });
  } catch (e) {
    toastError('重置失败', { detail: e.message });
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="sheet api pop-in">
      <div class="sheet__head">
        <div>
          <div class="sheet__title">API 接口</div>
          <div class="sheet__sub">
            给外部程序（客服系统 / AI）取号用 · 认 <code>X-API-Key</code>，不需要主密码
          </div>
        </div>
        <button class="btn btn--ghost btn--icon btn--sm" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      <div class="sheet__body">
        <!-- ① 连接信息 -->
        <div class="scard">
          <div class="scard__head">
            <div class="scard__title">连接信息</div>
            <div class="scard__sub">把这两样给客服系统，就能开始取号</div>
          </div>

          <div class="arow">
            <div class="arow__l">
              <div class="arow__t">接口地址</div>
              <div class="arow__d">你的程序往这里发请求</div>
            </div>
            <div class="arow__r">
              <code class="acode mono">{{ base }}</code>
              <button class="btn btn--sm" @click="copy(base, '接口地址')">复制</button>
            </div>
          </div>

          <div class="arow">
            <div class="arow__l">
              <div class="arow__t">API Key</div>
              <div class="arow__d">这就是钥匙 —— 泄露等于所有账号密码泄露，别放到前端或公开仓库</div>
            </div>
            <div class="arow__r">
              <code class="acode mono acode--key">{{ key || '（加载中…）' }}</code>
              <button class="btn btn--sm" @click="copy(key, 'API Key')">复制</button>
              <button class="btn btn--sm btn--danger" @click="doRotate">重置</button>
            </div>
          </div>
        </div>

        <!-- ② 查号 / 领号 -->
        <div class="scard">
          <div class="scard__head">
            <div class="scard__title">按游戏名查号</div>
            <div class="scard__sub">
              查询<strong>不会</strong>动任何账号 —— 只是看看有几个空闲的。
              真要取号，才点下面的「确认领取」。
            </div>
          </div>

          <div class="tryrow">
            <input
              v-model="game"
              class="input"
              placeholder="游戏名，例如 链在一起（留空 = 查全部空闲账号）"
              @keyup.enter="doSearch"
            />
            <input
              v-model="minutes"
              class="input tryrow__dur"
              placeholder="时长，例如 6小时"
              @keyup.enter="doSearch"
            />
            <button class="btn" :disabled="busy" @click="doSearch">
              {{ busy && !preview ? '查询中…' : '查一下' }}
            </button>
          </div>
          <div class="tryhint">
            时长按<strong>订单</strong>填（「6小时」「360」「90分钟」都认）。
            留空就用账号原本配置的时长。领取时会按这个值改账号的使用时间。
          </div>

          <!-- 查询结果：只列账号名，不给密码，不改状态 -->
          <div v-if="preview" class="preview" :class="preview.count ? 'preview--has' : 'preview--none'">
            <template v-if="preview.error">
              <div class="preview__no">查询失败：{{ preview.error }}</div>
            </template>
            <template v-else-if="preview.count">
              <div class="preview__title">
                找到 <strong>{{ preview.count }}</strong> 个空闲账号
                <span v-if="game.trim()">（游戏名含「{{ game.trim() }}」）</span>
              </div>
              <div class="preview__list">
                <code v-for="a in preview.items.slice(0, 12)" :key="a.id" class="chip mono">
                  {{ a.username }}<template v-if="a.game"> · {{ a.game }}</template>
                </code>
                <span v-if="preview.count > 12" class="chip chip--more">…还有 {{ preview.count - 12 }} 个</span>
              </div>
              <button class="btn btn--primary btn--sm" :disabled="busy" @click="doClaim">
                {{ busy ? '领取中…' : `确认领取一个（${minutesOf(minutes) ? `改成 ${minutesOf(minutes)} 分钟` : '用它原本的时长'}）` }}
              </button>
            </template>
            <template v-else>
              <div class="preview__no">暂无账号</div>
              <div class="preview__meta">
                {{ game.trim() ? '没有匹配这个游戏名的空闲账号。' : '当前一个空闲账号都没有。' }}
              </div>
            </template>
          </div>

          <!-- 领号结果 -->
          <div v-if="result" class="result" :class="result.ok ? 'result--ok' : 'result--no'">
            <template v-if="result.ok">
              <div class="result__title">已领取（账号现在进入「使用中」）</div>
              <div class="result__row">
                <span class="result__k">账号</span>
                <code class="mono">{{ result.username }}</code>
              </div>
              <div class="result__row">
                <span class="result__k">密码</span>
                <code class="mono">{{ result.password }}</code>
              </div>
              <div class="result__meta">
                游戏 {{ result.game || '（未填）' }} ·
                {{ result.matchedBy === 'exact' ? '精确匹配' : result.matchedBy === 'contains' ? '包含匹配' : '任意分配' }} ·
                可用 {{ result.usageMinutes }} 分钟 ·
                {{ result.message }}
              </div>
              <button class="btn btn--sm" @click="copy(result.text, '账号密码')">复制「账号/密码」</button>
            </template>
            <template v-else>
              <div class="result__no">{{ result.message || '领取失败' }}</div>
            </template>
          </div>
        </div>

        <!-- ③ 调用示例 -->
        <div class="scard">
          <div class="scard__head">
            <div class="scard__title">调用示例</div>
            <div class="scard__sub">复制过去改一下游戏名就能用</div>
          </div>
          <div class="tabs">
            <button
              v-for="t in [['curl','curl'],['js','JavaScript'],['py','Python'],['http','返回格式']]"
              :key="t[0]"
              class="tabbtn"
              :class="{ 'tabbtn--on': tab === t[0] }"
              @click="tab = t[0]"
            >{{ t[1] }}</button>
            <button class="btn btn--sm tabcopy" @click="copy(SAMPLES[tab], '示例代码')">复制这段</button>
          </div>
          <pre class="code mono">{{ SAMPLES[tab] }}</pre>
        </div>

        <!-- ④ 接口清单 -->
        <div class="scard">
          <div class="scard__head">
            <div class="scard__title">全部自动化接口</div>
            <div class="scard__sub">
              完整说明书（给程序看的）：<code>{{ base }}/api/automation/spec</code>
            </div>
          </div>
          <div class="ep" v-for="e in ENDPOINTS" :key="e.p">
            <span class="ep__m" :class="e.m === 'GET' ? 'ep__m--get' : 'ep__m--post'">{{ e.m }}</span>
            <code class="ep__p mono">{{ e.p }}</code>
            <span class="ep__d">{{ e.d }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sheet.api { width: min(820px, calc(100vw - 32px)); max-height: min(86vh, 820px); }

/* 行 */
.arow {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 0;
  border-top: 1px solid var(--border);
}
.arow:first-of-type { border-top: 0; }
.arow__l { flex: 1; min-width: 0; }
.arow__t { font-size: 13px; font-weight: 600; }
.arow__d { font-size: 11.5px; color: var(--text-3); margin-top: 2px; line-height: 1.5; }
.arow__r { display: flex; align-items: center; gap: 6px; flex: none; }

.acode {
  font-size: 12px;
  padding: 6px 10px;
  border-radius: var(--r-xs);
  background: var(--surface-2);
  border: 1px solid var(--border);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acode--key { max-width: 340px; letter-spacing: 0.02em; }

/* 试用 */
.tryrow { display: flex; gap: 8px; margin-top: 4px; }
.tryrow .input { flex: 1; }
.tryrow__dur { flex: none !important; width: 140px; }
.tryhint { font-size: 11.5px; color: var(--text-3); margin-top: 7px; line-height: 1.6; }

/* 查询结果（只查不领）—— 视觉上刻意做得比"领取结果"轻，避免误以为已经领了 */
.preview {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: var(--r-sm);
  border: 1px dashed var(--border);
  background: var(--surface);
}
.preview--has { border-color: rgba(10, 132, 255, 0.4); }
.preview--none { border-color: rgba(255, 159, 10, 0.4); }
.preview__title { font-size: 13px; margin-bottom: 9px; }
.preview__no { font-size: 14px; font-weight: 620; margin-bottom: 3px; }
.preview__meta { font-size: 11.5px; color: var(--text-3); }
.preview__list { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 11px; }
.chip {
  font-size: 11.5px;
  padding: 3px 9px;
  border-radius: var(--r-pill);
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-2);
}
.chip--more { color: var(--text-3); }

.result__title { font-size: 13px; font-weight: 640; margin-bottom: 9px; }

.result {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface-2);
}
.result--ok { border-color: rgba(48, 209, 88, 0.35); background: rgba(48, 209, 88, 0.08); }
.result--no { border-color: rgba(255, 159, 10, 0.35); background: rgba(255, 159, 10, 0.08); }
.result__row { display: flex; align-items: center; gap: 10px; margin-bottom: 5px; }
.result__k { font-size: 11.5px; color: var(--text-3); width: 34px; flex: none; }
.result__meta { font-size: 11.5px; color: var(--text-3); margin: 7px 0 9px; line-height: 1.6; }
.result__no { font-size: 15px; font-weight: 650; margin-bottom: 3px; }

/* 示例 */
.tabs { display: flex; align-items: center; gap: 5px; margin: 6px 0 9px; }
.tabbtn {
  height: 27px;
  padding: 0 11px;
  border-radius: var(--r-xs);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}
.tabbtn--on { background: var(--surface-3); color: var(--text); font-weight: 620; }
.tabcopy { margin-left: auto; }

.code {
  margin: 0;
  padding: 13px 15px;
  border-radius: var(--r-sm);
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid var(--border);
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--text-2);
  overflow-x: auto;
  white-space: pre;
  max-height: 300px;
}
html[data-theme='light'] .code { background: rgba(0, 0, 0, 0.04); }

/* 接口清单 */
.ep {
  display: flex;
  align-items: baseline;
  gap: 9px;
  padding: 7px 0;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.ep:first-of-type { border-top: 0; }
.ep__m {
  flex: none;
  width: 38px;
  text-align: center;
  font-size: 10px;
  font-weight: 700;
  padding: 2px 0;
  border-radius: 4px;
}
.ep__m--get { background: rgba(10, 132, 255, 0.18); color: #4da3ff; }
.ep__m--post { background: rgba(48, 209, 88, 0.16); color: #30d158; }
.ep__p { flex: none; color: var(--text); }
.ep__d { color: var(--text-3); font-size: 11.5px; }

@media (max-width: 720px) {
  .arow { flex-direction: column; align-items: flex-start; }
  .arow__r { width: 100%; }
  .acode { max-width: none; flex: 1; }
}
</style>
