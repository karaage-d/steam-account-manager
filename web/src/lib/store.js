import { reactive, computed } from 'vue';
import { get, post, patch, put, del, auth, copyText, onUnauthorized } from './api.js';
import { toast, toastSuccess, toastError, toastWarn } from './toast.js';

/* ------------------------------------------------------------------ */
/* 一级导航                                                             */
/* ------------------------------------------------------------------ */

/**
 * 需求第 4 条：「分级页面：一级界面（空闲中 使用中 待改密 添加账号 ...
 * （用于存放多个附加界面））」
 *
 * 三个状态界面由 TABS 驱动（顺序即界面顺序，同时决定左右滑动分几页）；
 * 「添加账号」是导航里的一个动作入口；其余附加界面全部注册在
 * ATTACHED_SCREENS 里 —— **加一个新界面只要往这个数组加一行**，
 * 导航栏和菜单会自动多出来（原来是硬编码 3 列 + 3 个具名插槽，
 * 加一个界面要同时改 TabBar、App、分页数三处）。
 */
export const TABS = [
  { key: 'available', label: '可用', hint: '账号闲置中，点「开始使用」进入计时' },
  { key: 'in_use', label: '使用中', hint: '倒计时进行中，时间一到自动转入待改密' },
  { key: 'pending_change', label: '待改密', hint: '使用时间已用完，改完密码才会回到可用' },
];

/** 一级导航里的「添加账号」入口 */
export const ADD_SCREEN = { key: 'add', label: '添加账号' };

/** 附加界面注册表：加一行 = 多一个一级导航里的入口 */
export const ATTACHED_SCREENS = [
  { key: 'help', label: '管理器说明' },
  { key: 'import', label: '批量导入' },
  { key: 'today', label: '今日使用记录' },
  { key: 'mail', label: '邮箱（验证码来源）' },
  { key: 'export', label: '导出全部账号' },
  { key: 'settings', label: '设置' },
];

export const TAB_KEYS = TABS.map((t) => t.key);

export const state = reactive({
  booted: false,
  initialized: false,
  unlocked: false,
  loading: false,

  tab: 0,                     // 当前界面索引，0=可用 1=使用中 2=待改密

  lists: { available: [], in_use: [], pending_change: [] },
  counts: { available: 0, in_use: 0, pending_change: 0 },
  stats: null,
  settings: {
    autoLockMinutes: 30,
    webhookUrl: '',
    webhookSecret: '',
    autoCopyOnUse: true,
    theme: 'dark',
    saleDurationTiers: [360, 720, 1440],
    xgj: {
      enabled: false,
      mchId: 'steam01',
      mchSecret: '',
      appId: '',
      appSecret: '',
      ipWhitelist: true,
      priceFen: 100,
    },
  },
  apiKey: '',
  baseUrl: '',
  /** ★ 最近一次从公网进来的地址（隧道给的）★ 闲管家的「接口网关」要填这个 */
  publicBaseUrl: '',

  /** 闲管家对接自检结果 + 商品预览（面板用） */
  xgjStatus: null,
  xgjGoods: [],
  /** 闲管家最近调我们的记录（排查"它到底调没调"用） */
  xgjLog: null,

  query: '',
  now: Math.floor(Date.now() / 1000),

  credential: null,
  today: null,
  tasks: [],

  // 邮箱（读验证码用）
  mailboxes: [],
  mailRate: null,
  mailConfig: null,
  mailSelectedId: null,
  mailMessages: [],
  mailBusy: '',
});

/* ------------------------------------------------------------------ */
/* 派生                                                                */
/* ------------------------------------------------------------------ */

export const currentKey = computed(() => TAB_KEYS[state.tab] || 'available');
export const currentList = computed(() => state.lists[currentKey.value] || []);
export const totalAccounts = computed(() => state.stats?.total ?? 0);

/** 使用中账号的剩余秒数（服务端给了绝对到期时间，前端纯本地推算） */
export function remainingSeconds(account) {
  const s = account?.session;
  if (!s) return 0;
  return Math.max(0, s.expiresAt - state.now);
}

export function elapsedSeconds(account) {
  const s = account?.session;
  if (!s) return 0;
  return Math.max(0, state.now - s.startedAt);
}

export function usedProgress(account) {
  const s = account?.session;
  if (!s) return 0;
  return Math.min(1, elapsedSeconds(account) / Math.max(1, s.plannedSeconds));
}

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */

export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(ss)}`;
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

/** 用分钟描述使用时长，例如 360 → 「6 小时」 */
export function fmtMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440} 天`;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
  }
  return `${m} 分钟`;
}

export function fmtAgo(ts) {
  if (!ts) return '从未使用';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(ts * 1000).toLocaleDateString('zh-CN');
}

export function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function credentialText(username, password) {
  return `账号：\n${username}\n\n密码：\n${password}`;
}

/* ------------------------------------------------------------------ */
/* 密码生成：只允许数字 + 大写 + 小写（需求指定）                        */
/* ------------------------------------------------------------------ */

const PW_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PW_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const PW_DIGIT = '0123456789';
const PW_ALL = PW_UPPER + PW_LOWER + PW_DIGIT;

/** 密码长度范围：10 ~ 12 位，每次生成时随机取一个 */
export const PW_MIN_LEN = 10;
export const PW_MAX_LEN = 12;

function randomInt(max) {
  if (globalThis.crypto?.getRandomValues) {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0] % max;
  }
  return Math.floor(Math.random() * max);
}

/** 在 10 ~ 12 之间随机取一个长度 */
export function randomPasswordLength() {
  return PW_MIN_LEN + randomInt(PW_MAX_LEN - PW_MIN_LEN + 1);
}

const isUpper = (c) => c >= 'A' && c <= 'Z';
const isLower = (c) => c >= 'a' && c <= 'z';
const isLetter = (c) => isUpper(c) || isLower(c);

/**
 * 生成新密码。
 *
 *   1. 长度 10 ~ 12 位（每次随机）
 *   2. 只含数字、大写字母、小写字母
 *   3. 以字母开头
 *   4. 三类字符各自至少出现一次
 *
 * 关于第 3 条：按用户说明加上。字母开头的密码在任何规则下都合法，属于双保险；
 * 真正导致「输入的密码无效」的原因已定位为输入节奏（见 worker/steam.mjs）。
 *
 * ★ 用「拒绝采样」而不是「先塞三类再补齐」★
 *   后者会让数字被系统性过度抽中：数字只有 10 个字符、字母有 52 个，
 *   先固定塞一个数字，等于把数字的期望出现次数抬高近一倍（实测偏差 34%）。
 *   这里先完全均匀地生成，不满足规则就整个重来，
 *   得到的是约束集合上的均匀分布。
 *
 * 不接收长度参数：长度由 PW_MIN_LEN / PW_MAX_LEN 决定。
 */
export function generatePassword() {
  const n = randomPasswordLength();
  const pick = (pool) => pool[randomInt(pool.length)];

  for (let attempt = 0; attempt < 500; attempt += 1) {
    let out = '';
    let hasUpper = false;
    let hasLower = false;
    let hasDigit = false;

    for (let i = 0; i < n; i += 1) {
      const c = pick(PW_ALL);
      out += c;
      if (isUpper(c)) hasUpper = true;
      else if (isLower(c)) hasLower = true;
      else hasDigit = true;
    }

    if (!isLetter(out[0])) continue;          // 以字母开头
    if (hasUpper && hasLower && hasDigit) return out;
  }
  throw new Error('生成密码失败：多次尝试都没能满足规则');
}

/** 是否以字母开头（见 generatePassword 上方关于这一条的说明） */
export function startsWithLetter(text) {
  return isLetter(String(text || '')[0]);
}

/** 一次性校验全部规则，返回问题列表（空数组表示合格） */
export function checkPassword(text) {
  const s = String(text || '');
  const problems = [];
  if (s.length < PW_MIN_LEN || s.length > PW_MAX_LEN) {
    problems.push(`长度必须是 ${PW_MIN_LEN}~${PW_MAX_LEN} 位，当前 ${s.length} 位`);
  }
  if (!isDigitsAndLetters(s)) problems.push('只能包含数字与大小写字母');
  if (!startsWithLetter(s)) problems.push('必须以字母开头（Steam 的硬要求）');
  if (!/[A-Z]/.test(s)) problems.push('至少包含一个大写字母');
  if (!/[a-z]/.test(s)) problems.push('至少包含一个小写字母');
  if (!/[0-9]/.test(s)) problems.push('至少包含一个数字');
  return problems;
}

/** 校验密码是否只含数字与大小写字母 */
export function isDigitsAndLetters(text) {
  return /^[0-9A-Za-z]+$/.test(String(text || ''));
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

let ticker = null;
const firedTimers = new Set();   // 已经主动触发过调度的会话

export function startTicker() {
  if (ticker) return;
  ticker = setInterval(async () => {
    state.now = Math.floor(Date.now() / 1000);
    if (!state.unlocked) return;

    const inUse = state.lists.in_use || [];
    if (!inUse.length) return;

    // 倒计时归零：主动推一下服务端，让状态流转立刻可见（否则最多等 5 秒调度周期）
    let needRefresh = false;
    for (const a of inUse) {
      if (remainingSeconds(a) <= 0) {
        needRefresh = true;
        const sid = a.session?.id;
        if (sid && !firedTimers.has(sid)) {
          firedTimers.add(sid);
          try {
            await post('/api/scheduler/run');
            await refresh();
          } catch { /* 下一轮再试 */ }
        }
      }
    }
    if (needRefresh && firedTimers.size > 40) firedTimers.clear();
  }, 1000);
}

onUnauthorized(() => {
  auth.token = '';
  state.unlocked = false;
  state.credential = null;
  state.lists = { available: [], in_use: [], pending_change: [] };
  state.counts = { available: 0, in_use: 0, pending_change: 0 };
});

export async function bootstrap() {
  try {
    const s = await get('/api/state');
    state.initialized = s.initialized;
    state.unlocked = !!s.unlocked && !!auth.token;
    if (s.settings) Object.assign(state.settings, s.settings);
    state.apiKey = s.apiKey || '';
    state.baseUrl = `http://${location.host}`;
    if (state.unlocked) await refresh();
  } catch (e) {
    toastError('无法连接本地服务', { detail: e.message });
  } finally {
    state.booted = true;
    startTicker();
  }
}

export async function setupVault(masterPassword) {
  const r = await post('/api/setup', { masterPassword });
  auth.token = r.token;
  state.apiKey = r.apiKey;
  state.initialized = true;
  state.unlocked = true;
  await refresh();
  toastSuccess('保险库已创建', { detail: '请务必牢记主密码，它无法找回' });
}

export async function unlockVault(masterPassword) {
  const r = await post('/api/unlock', { masterPassword });
  auth.token = r.token;
  state.apiKey = r.apiKey;
  state.unlocked = true;
  await refresh();
  toastSuccess('已解锁', { detail: `共 ${state.stats?.total ?? 0} 个账号` });
}

export async function lockVault() {
  try { await post('/api/lock'); } catch { /* 忽略 */ }
  auth.token = '';
  state.unlocked = false;
  state.credential = null;
  state.lists = { available: [], in_use: [], pending_change: [] };
}

/* ------------------------------------------------------------------ */
/* 数据刷新                                                            */
/* ------------------------------------------------------------------ */

export function applyBoard(b) {
  state.lists.available = b.available.items;
  state.lists.in_use = b.inUse.items;
  state.lists.pending_change = b.pending.items;
  state.counts.available = b.available.count;
  state.counts.in_use = b.inUse.count;
  state.counts.pending_change = b.pending.count;
  state.stats = b.stats;
}

export async function refresh() {
  const b = await get(`/api/board?q=${encodeURIComponent(state.query)}`);
  applyBoard(b);
  return b;
}

export async function refreshTasks() {
  state.tasks = (await get('/api/tasks')).tasks;
}

export async function refreshToday() {
  state.today = await get('/api/stats/today');
}

export async function refreshSettings() {
  const r = await get('/api/settings');
  Object.assign(state.settings, r.settings);
  state.apiKey = r.apiKey;
  // 接口地址也给出来 —— API 面板要显示，方便直接抄给客服系统
  state.baseUrl = r.baseUrl || '';
  // ★ 公网地址（隧道）★ 闲管家的「接口网关」必须填它，不能填 127.0.0.1
  state.publicBaseUrl = r.publicBaseUrl || '';
}

/**
 * ★ 只查不领 ★ —— 看看某个游戏名有几个空闲账号，**不改变任何状态**。
 *
 * 和 claimAccount 的区别很重要：
 *   available 只是列出来，账号还是「可用」；
 *   claim     会把账号真的领走（进「使用中」开始计时）。
 * 界面上"搜索"必须用这个，否则用户以为在搜，其实已经把号领了。
 */
export async function searchAvailable(game = '') {
  const qs = game ? `?q=${encodeURIComponent(game)}` : '';
  return get(`/api/automation/available${qs}`);
}

/**
 * 按游戏名 + 订单时长领一个空闲账号 —— ★ 会改变状态 ★
 *
 * minutes 传了就按订单改账号的使用时间（一个账号能接任意时长的单）；
 * 不传就用账号原本配置的时长。
 *
 * 这个接口认 X-API-Key，但**同时也接受会话令牌**（服务端 requireAutomation 里两条都放行），
 * 所以页面里不用把 Key 塞进请求头也能调 —— 免得 Key 出现在前端网络面板里。
 */
export async function claimAccount(game = '', minutes = null) {
  const p = new URLSearchParams();
  if (game) p.set('game', game);
  if (minutes) p.set('minutes', String(minutes));
  const qs = p.toString();
  return get(`/api/automation/claim${qs ? `?${qs}` : ''}`);
}

/* ------------------------------------------------------------------ */
/* ★ 闲管家对接（设置面板用）★                                          */
/* ------------------------------------------------------------------ */

/** 拉一次对接自检 + 商品预览 */
export async function refreshXgj() {
  const [status, goods, log] = await Promise.all([
    get('/api/xgj/status'),
    get('/api/xgj/goods'),
    get('/api/xgj/log?limit=40'),
  ]);
  state.xgjStatus = status;
  state.xgjGoods = goods.items || [];
  state.xgjLog = log;
  return status;
}

/** 只刷请求日志（看闲管家调没调我们） */
export async function refreshXgjLog() {
  state.xgjLog = await get('/api/xgj/log?limit=40');
  return state.xgjLog;
}

/**
 * 保存闲管家配置。
 *
 * ★ 只传要改的字段 ★
 *   后端是"有就覆盖、没传就保留"的深合并。如果每次都把整个 xgj 对象发过去，
 *   界面上没填的字段（比如你还没拿到 AppSecret）就会把已存的值冲成空。
 *   实测踩过这个坑（而且它是静默把密钥清掉、不报错），所以这里坚持只发改动项。
 */
export async function saveXgj(patch) {
  const r = await saveSettings({ xgj: patch });
  await refreshXgj();
  return r;
}

/** 改售卖档位（分钟数组），改完商品列表会立刻跟着变 */
export async function saveTiers(tiers) {
  const r = await saveSettings({ saleDurationTiers: tiers });
  await refreshXgj();
  return r;
}

/** 供搜索框使用，带错误兜底 */
export async function search(q) {
  state.query = q;
  try { await refresh(); } catch (e) { if (e.status !== 401) toastError('搜索失败', { detail: e.message }); }
}

/* ------------------------------------------------------------------ */
/* 账号增删改（新增后立刻可见，不需要刷新页面）                          */
/* ------------------------------------------------------------------ */

export async function saveAccount(payload, id) {
  if (id) {
    const r = await patch(`/api/accounts/${id}`, payload);
    if (r.stats) state.stats = r.stats;
    await refresh();
    toastSuccess('已保存');
    return r.account;
  }

  const r = await post('/api/accounts', payload);
  if (r.stats) state.stats = r.stats;
  // 乐观插入：先把返回的账号塞进「可用」，界面立刻能看到，再后台对齐服务端
  if (r.account) {
    state.lists.available = [r.account, ...state.lists.available.filter((a) => a.id !== r.account.id)];
    state.counts.available = state.lists.available.length;
  }
  toastSuccess('账号已添加', { detail: `${r.account?.username} 已进入「可用」` });
  refresh().catch(() => {});
  return r.account;
}

export async function removeAccount(account) {
  await del(`/api/accounts/${account.id}`);
  for (const k of TAB_KEYS) {
    state.lists[k] = state.lists[k].filter((a) => a.id !== account.id);
    state.counts[k] = state.lists[k].length;
  }
  toastSuccess('账号已删除', { detail: account.username });
  refresh().catch(() => {});
}

/* ------------------------------------------------------------------ */
/* 三态流转动作                                                        */
/* ------------------------------------------------------------------ */

function syncCounts() {
  for (const k of TAB_KEYS) state.counts[k] = state.lists[k].length;
}

/**
 * 本地即时把一个账号挪到目标界面，不等网络刷新。
 *
 * 服务端返回的账号对象已经带了正确的 state / session，直接用它替换，
 * 界面立刻就是对的；refresh() 再在后台对齐一次即可。
 * 这样即使刷新慢、失败、或刚好撞上自动锁库，面板也不会出现「空白」。
 */
export function applyLocalMove(account, toKey) {
  if (!account?.id) return;
  for (const k of TAB_KEYS) {
    const i = state.lists[k].findIndex((a) => a.id === account.id);
    if (i >= 0) state.lists[k].splice(i, 1);
  }
  if (toKey && TAB_KEYS.includes(toKey)) {
    state.lists[toKey] = [account, ...state.lists[toKey]];
  }
  syncCounts();
}

/** 先本地挪位，再后台与服务端对齐 */
function commitMove(account, toKey, stats) {
  applyLocalMove(account, toKey);
  if (stats) state.stats = stats;
  syncCounts();
  refresh().catch(() => {});
}

/** 可用 ──▶ 使用中 */
export async function startUse(account) {
  try {
    const r = await post(`/api/accounts/${account.id}/use`);
    state.credential = {
      accountId: account.id,
      username: r.credential.username,
      password: r.credential.password,
      session: r.session,
      todayIndex: r.todayIndex,
      revealed: true,
    };
    // 先本地把账号挪进「使用中」，保证切过去立刻能看到（不等网络刷新）
    commitMove(r.account, 'in_use', r.stats);
    state.tab = 1;

    if (state.settings.autoCopyOnUse) {
      const ok = await copyText(r.credential.text);
      if (!ok) toastWarn('自动复制失败，请手动复制', { detail: '浏览器拒绝了剪贴板权限' });
    }
    toast(`这是今天第 ${r.todayIndex} 个使用的账号`, {
      kind: 'milestone',
      icon: '🎯',
      title: `今天第 ${r.todayIndex} 个`,
      detail: `${r.credential.username} · 倒计时 ${fmtMinutes(r.plannedMinutes)}`,
      duration: 6500,
    });
    return r;
  } catch (e) {
    toastError('开始使用失败', { detail: e.message });
    throw e;
  }
}

/** 使用中 ──▶ 可用（提前结束） */
export async function cancelUse(account) {
  try {
    const r = await post(`/api/accounts/${account.id}/cancel-use`);
    commitMove(r.account, 'available', r.stats);
    toast('已提前结束，账号回到「可用」', { detail: account.username });
  } catch (e) {
    toastError('操作失败', { detail: e.message });
  }
}

/** 待改密 ──▶ 可用（手动改密） */
export async function submitManualPassword(account, newPassword) {
  try {
    const r = await post(`/api/accounts/${account.id}/password`, { newPassword });
    commitMove(r.account, 'available', r.stats);
    toastSuccess('改密完成', { detail: `${account.username} 已回到「可用」` });
  } catch (e) {
    toastError('改密失败', { detail: e.message });
    throw e;
  }
}

/** 待改密 ──▶ 可用（跳过改密，保留原密码） */
export async function skipChange(account) {
  try {
    const r = await post(`/api/accounts/${account.id}/skip-change`);
    commitMove(r.account, 'available', r.stats);
    toastWarn('已跳过改密', { detail: `${account.username} 回到「可用」，密码未变` });
  } catch (e) {
    toastError('操作失败', { detail: e.message });
  }
}

/** 重新把账号派发给 AI */
export async function redispatch(account) {
  try {
    await post('/api/tasks', { accountId: account.id, reason: '手动重新派发给 AI' });
    toastSuccess('已重新派发给 AI', { detail: account.username });
    await refresh();
  } catch (e) {
    toastError('派发失败', { detail: e.message });
  }
}

export async function openCredential(account) {
  try {
    const r = await post(`/api/accounts/${account.id}/reveal`);
    state.credential = {
      accountId: account.id,
      username: r.username,
      password: r.password,
      session: account.session || null,
      todayIndex: account.session?.todayIndex ?? null,
      revealed: true,
      readonly: !account.inUse,
    };
  } catch (e) {
    toastError('读取失败', { detail: e.message });
  }
}

/* ------------------------------------------------------------------ */
/* 复制                                                                */
/* ------------------------------------------------------------------ */

export async function copyUsername(account) {
  const ok = await copyText(account.username);
  if (ok) toastSuccess('账号已复制', { detail: account.username });
  else toastWarn('复制失败，请手动复制');
}

export async function copyPasswordRaw(password, username) {
  const ok = await copyText(password);
  if (ok) toastSuccess('密码已复制', { detail: username });
  else toastWarn('复制失败，请手动复制');
  return ok;
}

export async function copyPassword(account) {
  try {
    const r = await post(`/api/accounts/${account.id}/reveal`);
    return copyPasswordRaw(r.password, r.username);
  } catch (e) {
    toastError('读取密码失败', { detail: e.message });
    return false;
  }
}

export async function copyFormatted(account) {
  try {
    const r = await post(`/api/accounts/${account.id}/reveal`);
    const ok = await copyText(credentialText(r.username, r.password));
    if (ok) toastSuccess('已复制「账号/密码」格式', { detail: r.username });
    else toastWarn('复制失败，请手动复制');
    return ok;
  } catch (e) {
    toastError('读取密码失败', { detail: e.message });
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 设置与主题                                                          */
/* ------------------------------------------------------------------ */

export async function saveSettings(patchObj) {
  const r = await put('/api/settings', patchObj);
  Object.assign(state.settings, r.settings);
  toastSuccess('设置已保存');
}

export async function rotateApiKey() {
  const r = await post('/api/apikey/rotate');
  state.apiKey = r.apiKey;
  toastSuccess('API Key 已重置', { detail: '旧的自动化脚本需要更新' });
}

export async function testWebhook() {
  const r = await post('/api/webhook/test');
  if (r.result?.ok) toastSuccess('Webhook 推送成功', { detail: `HTTP ${r.result.status}` });
  else toastError('Webhook 推送失败', { detail: r.result?.error || `HTTP ${r.result?.status}` });
}

export function setTheme(theme) {
  state.settings.theme = theme;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f5f5f7' : '#08090d');
  put('/api/settings', { theme }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* 邮箱（读取验证码用）                                                */
/* ------------------------------------------------------------------ */

export async function refreshMailboxes() {
  const r = await get('/api/mailboxes');
  state.mailboxes = r.items || [];
  state.mailRate = r.rate || null;
  state.mailConfig = r.config || null;
  return state.mailboxes;
}

/** 添加邮箱。refreshToken 只在这一次提交，之后服务端只回 hasToken 布尔值 */
export async function addMailbox(payload) {
  const r = await post('/api/mailboxes', payload);
  state.mailboxes.unshift(r.mailbox);
  toastSuccess('邮箱已添加', { detail: '建议先点「测试连接」确认凭据可用' });
  return r.mailbox;
}

export async function updateMailbox(id, patchObj) {
  const r = await patch(`/api/mailboxes/${id}`, patchObj);
  const i = state.mailboxes.findIndex((b) => b.id === id);
  if (i >= 0) state.mailboxes[i] = r.mailbox;
  return r.mailbox;
}

export async function removeMailbox(id) {
  const box = state.mailboxes.find((b) => b.id === id);
  await del(`/api/mailboxes/${id}`);
  state.mailboxes = state.mailboxes.filter((b) => b.id !== id);
  if (state.mailSelectedId === id) {
    state.mailSelectedId = null;
    state.mailMessages = [];
  }
  toastSuccess('邮箱已删除', { detail: box?.address });
}

/** 测试连接：只验证凭据能用，不落邮件 */
export async function testMailbox(id) {
  try {
    const r = await post(`/api/mailboxes/${id}/test`);
    await refreshMailboxes();
    toastSuccess('连接正常', { detail: '凭据可用，能读到收件箱' });
    return r;
  } catch (e) {
    await refreshMailboxes().catch(() => {});
    if (e.payload?.needsReauth) {
      toastError('授权已失效，需要重新获取 token', { detail: e.message, duration: 9000 });
    } else {
      toastError('连接失败', { detail: e.message, duration: 8000 });
    }
    throw e;
  }
}

export async function fetchMailbox(id, { force = false } = {}) {
  try {
    const r = await post(`/api/mailboxes/${id}/fetch`, force ? { force: true } : {});
    await refreshMailboxes();
    if (state.mailSelectedId === id) await loadMessages(id);

    // 接口返回 HTML 时给出明确提示 —— 否则用户看着「0 封」完全不知道问题在哪
    if (r.hint) {
      toastWarn('取回了内容，但解析不出邮件列表', { detail: r.hint, duration: 12000 });
    } else if (r.added > 0) {
      toastSuccess(`取回 ${r.fetched} 封，新增 ${r.added} 封`);
    } else {
      toastSuccess('检查完成，没有新邮件', { detail: `最近 ${r.fetched} 封都已在库里` });
    }
    return r;
  } catch (e) {
    await refreshMailboxes().catch(() => {});
    if (e.payload?.needsReauth) {
      toastError('授权已失效，需要重新获取 token', { detail: e.message, duration: 9000 });
    } else {
      toastError('拉取失败', { detail: e.message, duration: 8000 });
    }
    throw e;
  }
}

export async function loadMessages(mailboxId, q = '') {
  state.mailSelectedId = mailboxId;
  const qs = new URLSearchParams({ limit: '100' });
  if (q) qs.set('q', q);
  const r = await get(`/api/mailboxes/${mailboxId}/messages?${qs}`);
  state.mailMessages = r.items || [];
  return state.mailMessages;
}

export async function openMessage(id) {
  const r = await get(`/api/messages/${id}`);
  return r.message;
}
