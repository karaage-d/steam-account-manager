<script setup>
import { ref, computed } from 'vue';
import { state } from '../lib/store.js';
import { copyText } from '../lib/api.js';
import { toastSuccess, toastWarn } from '../lib/toast.js';

const showKey = ref(false);
const open = ref(false);

const baseUrl = computed(() => `http://${location.host}`);
const maskedKey = computed(() => {
  const k = state.apiKey || '';
  return k ? `${k.slice(0, 6)}${'•'.repeat(16)}${k.slice(-4)}` : '—';
});

const poll = computed(() => `# 轮询待改密任务，交给你的 AI 处理
curl -H "X-API-Key: ${state.apiKey}" \\
  "${baseUrl.value}/api/automation/tasks?status=pending"

# 取上下文（账号 / 当前密码 / 邮箱 / 游戏名）
curl -H "X-API-Key: ${state.apiKey}" \\
  "${baseUrl.value}/api/automation/context/<任务ID>"

# 改完后回传新密码 —— 账号会自动回到「可用」
curl -X POST -H "X-API-Key: ${state.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"newPassword":"新密码","worker":"my-agent"}' \\
  "${baseUrl.value}/api/automation/tasks/<任务ID>/complete"`);

async function copy(value, name) {
  const ok = await copyText(value);
  if (ok) toastSuccess(`${name}已复制`);
  else toastWarn('复制失败，请手动复制');
}
</script>

<template>
  <div class="ai glass">
    <div class="ai__head">
      <div class="ai__mark">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3.2 14.2 9l5.8.5-4.4 3.8 1.3 5.7L12 16l-4.9 3 1.3-5.7L4 9.5 9.8 9Z" />
        </svg>
      </div>
      <div class="ai__titles">
        <div class="ai__title">让 AI 帮你改密</div>
        <div class="ai__sub">
          下面这些账号的使用时间已经用完。把下面的接口接给你的 AI 程序，它拉走任务、改完密码回传，
          账号就会自动回到「可用」。
        </div>
      </div>
      <button class="btn btn--sm" @click="open = !open">{{ open ? '收起' : '展开接口' }}</button>
    </div>

    <div class="ai__keyrow">
      <div class="keyfield">
        <span class="keyfield__label">API Key</span>
        <code class="mono">{{ showKey ? state.apiKey : maskedKey }}</code>
        <button class="btn btn--ghost btn--sm" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button>
        <button class="btn btn--ghost btn--sm" @click="copy(state.apiKey, 'API Key')">复制</button>
      </div>
      <div class="keyfield">
        <span class="keyfield__label">接口地址</span>
        <code class="mono">{{ baseUrl }}/api/automation</code>
        <button class="btn btn--ghost btn--sm" @click="copy(baseUrl + '/api/automation/spec', '接口说明')">
          复制说明
        </button>
      </div>
    </div>

    <Transition name="expand">
      <div v-if="open" class="ai__body">
        <div class="endpoints">
          <div v-for="e in [
            ['GET', '/tasks?status=pending', '拉取待改密任务'],
            ['GET', '/context/{id}', '读取账号、当前密码与操作步骤'],
            ['POST', '/tasks/{id}/claim', '声明接管'],
            ['POST', '/tasks/{id}/progress', '上报进度'],
            ['POST', '/tasks/{id}/complete', '回传新密码 → 回到可用'],
            ['POST', '/tasks/{id}/fail', '上报失败（可重试）'],
          ]" :key="e[1]" class="ep">
            <span class="ep__m" :class="`ep__m--${e[0].toLowerCase()}`">{{ e[0] }}</span>
            <code class="ep__p mono">{{ e[1] }}</code>
            <span class="ep__d">{{ e[2] }}</span>
          </div>
        </div>

        <div class="ai__curl">
          <div class="ai__curl-head">
            <span>调用示例</span>
            <button class="btn btn--ghost btn--sm" @click="copy(poll, '调用示例')">复制</button>
          </div>
          <pre class="mono">{{ poll }}</pre>
        </div>

        <div class="ai__note">
          Steam 改密必须走官网流程，通常需要邮箱验证码或 Steam Guard 动态码。
          这里只负责「派发任务 → 收下新密码 → 自动回到可用」，中间的验证交给你的自动化程序，
          这样既不会绕过 Steam 的安全机制，也不会因为页面改版就整体失效。
          首次使用可在下方设置里填一个 Webhook 地址，有新任务时会主动通知你的程序。
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.ai {
  border-radius: var(--r-lg);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 13px;
  background: linear-gradient(125deg, var(--accent-soft), var(--surface) 62%);
  margin-bottom: 14px;
}

.ai__head { display: flex; align-items: flex-start; gap: 12px; }
.ai__mark {
  width: 32px; height: 32px;
  flex: none;
  border-radius: 10px;
  display: grid; place-items: center;
  color: #fff;
  background: linear-gradient(160deg, var(--accent-hi), var(--purple));
  box-shadow: 0 8px 18px -8px var(--accent);
}
.ai__titles { flex: 1; min-width: 0; }
.ai__title { font-size: 14.5px; font-weight: 680; letter-spacing: -0.02em; }
.ai__sub { font-size: 12.5px; color: var(--text-2); line-height: 1.6; margin-top: 3px; }

.ai__keyrow { display: flex; gap: 10px; flex-wrap: wrap; }
.keyfield {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 5px 0 11px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface);
  flex: 1;
  min-width: 260px;
}
.keyfield__label { font-size: 11.5px; color: var(--text-3); font-weight: 600; flex: none; }
.keyfield code {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent);
}

.ai__body { display: flex; flex-direction: column; gap: 12px; }

.endpoints { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 6px; }
.ep {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 11px;
  border-radius: var(--r-xs);
  background: var(--surface);
  border: 1px solid var(--border);
}
.ep__m {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 5px;
  flex: none;
  background: var(--surface-3);
  color: var(--text-2);
}
.ep__m--get { background: var(--accent-soft); color: var(--accent); }
.ep__m--post { background: var(--green-soft); color: var(--green); }
.ep__p { font-size: 12px; flex: none; }
.ep__d { font-size: 11.5px; color: var(--text-3); margin-left: auto; text-align: right; }

.ai__curl { border-radius: var(--r-md); border: 1px solid var(--border); background: var(--surface); overflow: hidden; }
.ai__curl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 13px;
  border-bottom: 1px solid var(--hairline);
  font-size: 12.5px;
  font-weight: 650;
}
.ai__curl pre {
  margin: 0;
  padding: 13px;
  font-size: 11.5px;
  line-height: 1.75;
  color: var(--text-2);
  overflow-x: auto;
  white-space: pre;
}

.ai__note {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.7;
  padding: 11px 13px;
  border-radius: var(--r-sm);
  background: var(--surface);
  border-left: 2px solid var(--border-2);
}

.expand-enter-active, .expand-leave-active { transition: all 260ms var(--ease-spring); overflow: hidden; }
.expand-enter-from, .expand-leave-to { opacity: 0; max-height: 0; }
.expand-enter-to, .expand-leave-from { opacity: 1; max-height: 1200px; }
</style>
