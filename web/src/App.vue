<script setup>
import { ref, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import Aurora from './components/Aurora.vue';
import ToastHost from './components/ToastHost.vue';
import LockScreen from './components/LockScreen.vue';
import TopBar from './components/TopBar.vue';
import TabBar from './components/TabBar.vue';
import SwipePager from './components/SwipePager.vue';
import AvailablePanel from './components/AvailablePanel.vue';
import InUsePanel from './components/InUsePanel.vue';
import PendingPanel from './components/PendingPanel.vue';
import CredentialModal from './components/CredentialModal.vue';
import AccountEditor from './components/AccountEditor.vue';
import ManualPasswordModal from './components/ManualPasswordModal.vue';
import ImportModal from './components/ImportModal.vue';
import TodayModal from './components/TodayModal.vue';
import SettingsModal from './components/SettingsModal.vue';
import MailboxPanel from './components/MailboxPanel.vue';
import HelpPanel from './components/HelpPanel.vue';
import ApiPanel from './components/ApiPanel.vue';
import XgjPanel from './components/XgjPanel.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import {
  state, bootstrap, refresh, removeAccount, lockVault,
} from './lib/store.js';
import { get, downloadText } from './lib/api.js';
import { toastError, toastSuccess, toastWarn } from './lib/toast.js';

document.documentElement.dataset.theme = 'dark';

const editorOpen = ref(false);
const editing = ref(null);
const importOpen = ref(false);
const manualAccount = ref(null);
const todayOpen = ref(false);
const settingsOpen = ref(false);
const mailOpen = ref(false);
const apiOpen = ref(false);
const xgjOpen = ref(false);
const helpOpen = ref(false);

const confirmState = reactive({
  open: false, title: '', message: '', detail: '',
  confirmText: '删除', danger: true, busy: false, action: null,
});

onMounted(bootstrap);

watch(() => state.settings.theme, (t) => {
  document.documentElement.dataset.theme = t || 'dark';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#f5f5f7' : '#08090d');
});

/* 解锁后周期性对齐服务端（调度器 / worker 可能已经推进了状态） */
let syncTimer = null;

/**
 * ★ 不要因为标签页在后台就跳过同步 ★
 *
 * 之前这里有 `if (document.hidden) return;`。看起来是省资源，
 * 实际后果很糟：用 worker 改密时，你正在看 worker 打开的那个浏览器窗口，
 * 账号管理器的标签页就是「后台」→ 一次都不同步 → 改密完成后界面一直显示账号
 * 还在「待改密」，必须手动刷新才看得到。本地应用，这点开销可以忽略。
 */
function syncNow() {
  if (!state.unlocked) return;
  refresh().catch(() => {});
}

function onVisibilityChange() {
  // 切回这个标签页时立刻同步一次，不用等下一个周期
  if (!document.hidden) syncNow();
}

watch(() => state.unlocked, (on) => {
  clearInterval(syncTimer);
  if (!on) {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    return;
  }
  syncTimer = setInterval(syncNow, 8000);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onBeforeUnmount(() => {
  clearInterval(syncTimer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});

function openAdd() {
  editing.value = null;
  editorOpen.value = true;
}

/**
 * 一级导航里的「附加界面」入口（TabBar 的「更多」）。
 * 想加新界面：在 store.js 的 ATTACHED_SCREENS 里加一行，再在这里加一个分支。
 */
function openScreen(key) {
  if (key === 'help') helpOpen.value = true;
  else if (key === 'import') importOpen.value = true;
  else if (key === 'today') todayOpen.value = true;
  else if (key === 'mail') mailOpen.value = true;
  else if (key === 'api') apiOpen.value = true;
  else if (key === 'xgj') xgjOpen.value = true;
  else if (key === 'settings') settingsOpen.value = true;
  else if (key === 'export') doExport();
}

function openEdit(account) {
  editing.value = account;
  editorOpen.value = true;
}

function openManual(account) {
  manualAccount.value = account;
}

function askDelete(account) {
  confirmState.title = '删除账号';
  confirmState.message = `确定要删除「${account.username}」吗？`;
  confirmState.detail = '该账号的密码、使用记录都会从本地数据库中永久移除，此操作不可撤销。';
  confirmState.confirmText = '删除';
  confirmState.danger = true;
  confirmState.action = () => removeAccount(account);
  confirmState.open = true;
}

async function runConfirm() {
  if (!confirmState.action) return;
  confirmState.busy = true;
  try {
    await confirmState.action();
    confirmState.open = false;
  } catch (e) {
    toastError('操作失败', { detail: e.message });
  } finally {
    confirmState.busy = false;
  }
}

async function doExport() {
  try {
    const r = await get('/api/accounts/export?format=txt&mode=readable');
    downloadText(r.filename, r.text);
    toastSuccess('已导出为 TXT', { detail: '内容为明文，请注意保管', duration: 7000 });
  } catch (e) {
    toastError('导出失败', { detail: e.message });
  }
}

function closeAll() {
  if (state.credential) { state.credential = null; return true; }
  if (editorOpen.value) { editorOpen.value = false; return true; }
  if (manualAccount.value) { manualAccount.value = null; return true; }
  if (importOpen.value) { importOpen.value = false; return true; }
  if (helpOpen.value) { helpOpen.value = false; return true; }
  if (todayOpen.value) { todayOpen.value = false; return true; }
  if (settingsOpen.value) { settingsOpen.value = false; return true; }
  if (confirmState.open) { confirmState.open = false; return true; }
  return false;
}

function onKey(e) {
  if (e.key === 'Escape') closeAll();
  if (e.key === 'l' && (e.metaKey || e.ctrlKey) && state.unlocked) {
    e.preventDefault();
    lockVault();
  }
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Aurora />
  <ToastHost />

  <Transition name="swap" mode="out-in">
    <LockScreen v-if="!state.booted" key="boot" />
    <LockScreen v-else-if="!state.unlocked" key="lock" />

    <div v-else key="app" class="app">
      <TopBar
        @add="openAdd"
        @import="importOpen = true"
        @export="doExport"
        @today="todayOpen = true"
        @settings="settingsOpen = true"
        @mail="mailOpen = true"
        @api="apiOpen = true"
        @xgj="xgjOpen = true"
        @help="helpOpen = true"
      />

      <!-- 「添加账号」只保留顶栏这一个入口：
           TabBar 那一排是状态筛选（可用/使用中/待改密），动作混进去语义不对；
           可用面板标题行那个又和顶栏重复。见 需求清单.md 的说明。 -->
      <TabBar v-model="state.tab" @screen="openScreen" />

      <SwipePager v-model="state.tab" :count="3">
        <template #page-0>
          <AvailablePanel
            @edit="openEdit"
            @delete="askDelete"
            @manual="openManual"
          />
        </template>
        <template #page-1>
          <InUsePanel
            @edit="openEdit"
            @delete="askDelete"
            @manual="openManual"
          />
        </template>
        <template #page-2>
          <PendingPanel
            @edit="openEdit"
            @delete="askDelete"
            @manual="openManual"
          />
        </template>
      </SwipePager>
    </div>
  </Transition>

  <CredentialModal v-if="state.credential" @close="state.credential = null" />

  <AccountEditor
    v-if="editorOpen"
    :account="editing"
    @close="editorOpen = false"
    @saved="refresh"
  />

  <ManualPasswordModal
    v-if="manualAccount"
    :account="manualAccount"
    @close="manualAccount = null"
  />

  <ImportModal v-if="importOpen" @close="importOpen = false" />
  <TodayModal v-if="todayOpen" @close="todayOpen = false" />
  <SettingsModal v-if="settingsOpen" @close="settingsOpen = false" />
  <MailboxPanel v-if="mailOpen" @close="mailOpen = false" />
  <HelpPanel v-if="helpOpen" @close="helpOpen = false" />
  <ApiPanel v-if="apiOpen" @close="apiOpen = false" />
  <XgjPanel v-if="xgjOpen" @close="xgjOpen = false" />

  <ConfirmDialog
    v-if="confirmState.open"
    :title="confirmState.title"
    :message="confirmState.message"
    :detail="confirmState.detail"
    :confirm-text="confirmState.confirmText"
    :danger="confirmState.danger"
    :busy="confirmState.busy"
    @confirm="runConfirm"
    @cancel="confirmState.open = false"
  />
</template>

<style scoped>
.app {
  position: relative;
  z-index: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.swap-enter-active, .swap-leave-active { transition: opacity 260ms var(--ease-out); }
.swap-enter-from, .swap-leave-to { opacity: 0; }
</style>
