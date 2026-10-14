<script setup>
import { ref, watch, computed } from 'vue';
import { post } from '../lib/api.js';
import { refresh, fmtMinutes } from '../lib/store.js';
import { toastSuccess, toastError } from '../lib/toast.js';

const emit = defineEmits(['close']);

const text = ref('');
const parsed = ref([]);
const busy = ref(false);
const defaultAmount = ref(6);
const defaultUnit = ref('hour');
let timer = null;

const UNITS = { minute: 1, hour: 60, day: 1440 };
const defaultMinutes = computed(() => Math.max(1, Math.round(defaultAmount.value * UNITS[defaultUnit.value])));

const SAMPLE = `账号：steam_user_01
密码：MyPass123
游戏：Counter-Strike 2
使用时间：6小时

账号：steam_user_02
密码：AnotherPass456
游戏：Dota 2
使用时间：3小时`;

watch(text, () => {
  clearTimeout(timer);
  if (!text.value.trim()) { parsed.value = []; return; }
  timer = setTimeout(async () => {
    try {
      parsed.value = (await post('/api/accounts/parse', { text: text.value })).entries;
    } catch { parsed.value = []; }
  }, 220);
});

async function doImport() {
  if (!parsed.value.length || busy.value) return;
  busy.value = true;
  try {
    const r = await post('/api/accounts/bulk', {
      text: text.value,
      usageMinutes: defaultMinutes.value,
    });
    toastSuccess(`导入完成：新增 ${r.created} 个`, {
      detail: [r.skipped ? `跳过已存在 ${r.skipped} 个` : '', ...(r.errors || [])]
        .filter(Boolean).join(' · ') || `已全部进入「可用」`,
      duration: 7000,
    });
    await refresh();
    emit('close');
  } catch (e) {
    toastError('导入失败', { detail: e.message });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="sheet imp pop-in">
      <div class="sheet__head">
        <div>
          <div class="sheet__title">批量导入账号</div>
          <div class="sheet__sub">
            支持 <code>账号：</code> <code>密码：</code> <code>游戏：</code> <code>使用时间：6小时</code>
            <code>备注：</code> 这样的分标签写法，也支持 <code>用户名:密码</code>
          </div>
        </div>
        <button class="btn btn--ghost btn--icon btn--sm" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      <div class="sheet__body imp__body">
        <div class="field">
          <div class="imp__labelrow">
            <label class="field__label">粘贴账号文本</label>
            <button class="btn btn--ghost btn--sm" @click="text = SAMPLE">填入示例</button>
          </div>
          <textarea
            v-model="text"
            class="textarea mono imp__ta"
            placeholder="把账号密码按行粘贴进来，空行分隔每个账号…"
            spellcheck="false"
          />
        </div>

        <div class="imp__default">
          <div class="imp__default-l">
            <div class="srow__t">默认使用时间</div>
            <div class="srow__d">文本里没写「使用时间」的账号，用这个值</div>
          </div>
          <div class="imp__default-r">
            <input v-model.number="defaultAmount" type="number" min="1" class="input numinput" />
            <select v-model="defaultUnit" class="select unitselect">
              <option value="minute">分钟</option>
              <option value="hour">小时</option>
              <option value="day">天</option>
            </select>
            <span class="imp__default-hint">= {{ fmtMinutes(defaultMinutes) }}</span>
          </div>
        </div>

        <div class="imp__preview">
          <div class="imp__preview-head">
            <span>解析预览</span>
            <span class="badge" :class="parsed.length ? 'badge--accent' : ''">
              识别到 {{ parsed.length }} 个账号
            </span>
          </div>
          <div v-if="!parsed.length" class="imp__empty">还没有识别到内容</div>
          <div v-else class="imp__list">
            <div v-for="(p, i) in parsed.slice(0, 30)" :key="i" class="imp__item">
              <span class="imp__idx">{{ i + 1 }}</span>
              <span class="imp__user mono">{{ p.username }}</span>
              <span class="imp__game">{{ p.game || '—' }}</span>
              <span class="imp__time">{{ p.usageMinutes ? fmtMinutes(p.usageMinutes) : fmtMinutes(defaultMinutes) }}</span>
              <span class="imp__pw mono">{{ '•'.repeat(Math.min(8, (p.password || '').length)) }}</span>
            </div>
            <div v-if="parsed.length > 30" class="imp__more">… 还有 {{ parsed.length - 30 }} 个</div>
          </div>
        </div>
      </div>

      <div class="sheet__foot">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn btn--primary" :disabled="!parsed.length || busy" @click="doImport">
          {{ busy ? '导入中…' : `导入 ${parsed.length} 个到「可用」` }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.imp { width: min(660px, 100%); }
.imp__body { display: flex; flex-direction: column; gap: 14px; }
.imp__labelrow { display: flex; align-items: center; justify-content: space-between; }
.imp__ta { min-height: 168px; font-size: 12.5px; line-height: 1.7; }

.imp__default {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--surface);
}
.imp__default-r { display: flex; align-items: center; gap: 8px; flex: none; }
.imp__default-hint { font-size: 12px; color: var(--text-3); min-width: 64px; }
.numinput { width: 84px; text-align: center; font-variant-numeric: tabular-nums; }
.unitselect { width: 92px; }
.srow__t { font-size: 13px; font-weight: 600; }
.srow__d { font-size: 11.5px; color: var(--text-3); margin-top: 3px; }

.imp__preview {
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--surface);
  overflow: hidden;
}
.imp__preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 14px;
  border-bottom: 1px solid var(--hairline);
  font-size: 12.5px;
  font-weight: 650;
}
.imp__empty { padding: 22px; text-align: center; font-size: 12.5px; color: var(--text-3); }
.imp__list { max-height: 210px; overflow-y: auto; }
.imp__item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 8px 14px;
  font-size: 12.5px;
}
.imp__item + .imp__item { border-top: 1px solid var(--hairline); }
.imp__idx { width: 20px; flex: none; color: var(--text-3); font-size: 11px; font-variant-numeric: tabular-nums; }
.imp__user { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.imp__game {
  flex: none;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent);
  font-size: 11.5px;
}
.imp__time { flex: none; color: var(--text-2); font-size: 11.5px; min-width: 56px; text-align: right; }
.imp__pw { flex: none; color: var(--text-3); letter-spacing: 0.1em; }
.imp__more { padding: 9px 14px; font-size: 11.5px; color: var(--text-3); border-top: 1px solid var(--hairline); }

code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  background: var(--surface-3);
  padding: 1px 5px;
  border-radius: 5px;
}
</style>
