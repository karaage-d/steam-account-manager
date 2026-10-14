/**
 * Steam 账号管理器 · 本地服务
 * 只监听 127.0.0.1，不对外网暴露。
 *
 * 三态流转由本文件的调度器统一驱动（每 5 秒扫一次）：
 *   可用 ──开始使用──▶ 使用中 ──倒计时归零──▶ 待改密 ──改密完成──▶ 可用
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Store, STATE, STATE_LABEL, formatCredential, parseBulkText, dayKey,
  DEFAULT_SETTINGS, DEFAULT_USAGE_MINUTES, normalizeUsageMinutes,
} from './store.mjs';
import { hmacHex, safeEqual } from './crypto.mjs';
import { MailError } from './graph.mjs';
import { MailService } from './mail.mjs';
import { addressFromApiUrl, apiUrlHasCredential, splitMailboxPaste, normalizeWebmailUrl } from './webmail.mjs';
import { fetchLoginCode, renderCodePage, renderErrorPage } from './buyer.mjs';
import { extractSteamCode, looksLikeCodeMail } from './code.mjs';
import {
  verifyIncoming as xgjVerify, md5 as xgjMd5, CODE as XGJ_CODE,
  buildGoodsList, toWireGoods, resolveGoodsNo, handleCardOrder,
  ORDER_STATUS as XGJ_ORDER_STATUS, GOODS_TYPE as XGJ_GOODS_TYPE,
  humanDuration as xgjDuration, goodsNoFor,
} from './xianguanjia.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_DIST = path.join(ROOT, 'web', 'dist');
const DATA_DIR = process.env.VAULT_DATA_DIR || path.join(ROOT, 'data');

const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';

const store = new Store(DATA_DIR);
const mail = new MailService(store);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * 读请求体**原文**并缓存到 req 上。
 *
 * ★ 为什么需要"原文"★
 *   闲管家的签名是 md5(请求体原文)，多一个空格、换个字段顺序都会导致签名不符。
 *   所以校验签名时必须拿到**字节原样**的字符串，不能用 JSON.stringify 重新生成
 *   （那样键顺序和空格都可能变，签出来必然对不上）。
 *
 * 缓存是为了让后面真正的处理函数还能再读一次 —— 流只能读一遍。
 */
function readRawBody(req, limit = 8 * 1024 * 1024) {
  if (req.__rawBody !== undefined) return Promise.resolve(req.__rawBody);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      req.__rawBody = raw;
      resolve(raw);
    });
    req.on('error', reject);
  });
}

function readBody(req, limit = 8 * 1024 * 1024) {
  if (req.__parsedBody !== undefined) return Promise.resolve(req.__parsedBody);
  return readRawBody(req, limit).then((raw) => {
    if (!raw) { req.__parsedBody = {}; return {}; }
    try {
      const o = JSON.parse(raw);
      req.__parsedBody = o;
      return o;
    } catch {
      throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
    }
  });
}

const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([A-Za-z0-9_]+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  }) + '$');
  routes.push({ method, regex, keys, handler, auth: opts.auth || 'session' });
}

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };

/* ------------------------------------------------------------------ */
/* Webhook                                                             */
/* ------------------------------------------------------------------ */

async function fireWebhook(event, payload) {
  const settings = store.getSettings();
  if (!settings.webhookUrl) return { skipped: true };
  const envelope = { event, at: Math.floor(Date.now() / 1000), data: payload };
  const body = JSON.stringify(envelope);
  const headers = { 'Content-Type': 'application/json', 'X-Vault-Event': event };
  if (settings.webhookSecret) headers['X-Vault-Signature'] = `sha256=${hmacHex(settings.webhookSecret, body)}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(settings.webhookUrl, { method: 'POST', headers, body, signal: controller.signal });
    clearTimeout(timer);
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* 认证                                                                */
/* ------------------------------------------------------------------ */

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-vault-token'] || '');
}

function requireSession(req) {
  const token = bearer(req);
  if (!token || !store.validateToken(token)) {
    throw new HttpError(401, '未解锁或登录状态已失效');
  }
}

function requireAutomation(req) {
  const key = req.headers['x-api-key'];
  if (key) {
    if (safeEqual(key, store.getApiKey())) return;
    throw new HttpError(401, 'API Key 不正确。请在应用的「待改密」界面或「设置」页重新复制。');
  }
  const token = bearer(req);
  if (token && store.validateToken(token)) return;
  // 浏览器地址栏无法发送自定义请求头，直接打开这些接口必然走到这里。
  // 与其丢一句冷冰冰的报错，不如把该怎么做说清楚。
  throw new HttpError(401,
    '这个接口需要鉴权，而浏览器地址栏无法携带请求头，所以直接打开一定会被拒绝。'
    + `请用 curl / PowerShell / 你的程序带上 X-API-Key 请求头调用。`
    + `接口说明与调用示例：http://${HOST}:${PORT}/api/automation`);
}

/* ------------------------------------------------------------------ */
/* 闲管家鉴权                                                          */
/* ------------------------------------------------------------------ */

/**
 * 取出真实来源 IP。
 *
 * ★ 顺序很重要，取错了白名单就是摆设 ★
 *
 *   X-Forwarded-For 是"追加"语义：客户端可以自己先塞一个假的，
 *   隧道/代理再把它自己看到的追加到后面。所以：
 *     - 取**第一个** → 拿到的是攻击者伪造的那个 ✗
 *     - 取**最后一个** → 拿到的是最近的代理看到的那个 ✓
 *
 *   更好的是用 Cloudflare 专门提供的 CF-Connecting-IP —— 这个头是它写死的，
 *   客户端塞不进去，最可信。
 */
function clientIp(req) {
  // ① Cloudflare 写的，最可信
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf.replace(/^::ffff:/, '');

  // ② 别的反代常见写法
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real.replace(/^::ffff:/, '');

  // ③ 兜底：X-Forwarded-For 取**最后一个**（最近一跳看到的）
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (xff.length) return xff[xff.length - 1].replace(/^::ffff:/, '');

  // ④ 直连
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

/**
 * ★ 闲管家专用鉴权 ★
 *
 * 和另两套不一样：
 *   session     —— 界面用，主密码换来的令牌
 *   automation  —— 外部脚本用，X-API-Key
 *   xgj         —— 闲管家用，**MD5 签名**（它只能按官方规则签名，没法带我们的密钥）
 *
 * 四道门依次过：功能开关 → IP 白名单 → 参数齐全 → 签名与时间戳。
 * 任何一道不过，都按闲管家的错误码返回（不是 HTTP 401），
 * 因为它只认响应体里的 code，不认 HTTP 状态码。
 */
async function requireXgj(req, url) {
  const cfg = store.getSettings().xgj;

  if (!cfg?.enabled) {
    throw new XgjError(XGJ_CODE.SERVER_ERROR, '本机还没开启闲管家对接（设置 → 闲管家）');
  }

  // 签名要用请求体原文，这里先读出来并缓存，处理函数后面还能再读
  const raw = req.method === 'POST' ? await readRawBody(req) : '';

  const query = Object.fromEntries(url.searchParams.entries());
  const v = xgjVerify({
    query,
    bodyString: raw,
    cfg,
    remoteIp: clientIp(req),
  });
  if (!v.ok) {
    throw new XgjError(v.code, v.msg, v.detail);
  }
  return v;
}

/**
 * 闲管家的错误是「HTTP 200 + body 里 code != 0」。
 * 用这个异常把 code 带出去，由路由层统一转成它的格式。
 */
class XgjError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.xgjCode = code;
    this.xgjDetail = detail;
  }
}

/* ------------------------------------------------------------------ */
/* 状态与解锁                                                          */
/* ------------------------------------------------------------------ */

route('GET', '/api/health', async () => ({
  ok: true,
  service: 'steam-account-manager',
  version: '2.0.0',
  initialized: store.initialized,
  unlocked: store.unlocked,
  time: Math.floor(Date.now() / 1000),
}), { auth: 'public' });

route('GET', '/api/state', async () => {
  const settings = store.getSettings();
  return {
    initialized: store.initialized,
    unlocked: store.unlocked,
    settings: store.unlocked ? settings : { theme: settings.theme },
    apiKey: store.unlocked ? store.getApiKey() : null,
    stats: store.unlocked ? store.stats() : null,
    states: { available: STATE_LABEL.available, in_use: STATE_LABEL.in_use, pending_change: STATE_LABEL.pending_change },
    defaults: { usageMinutes: DEFAULT_USAGE_MINUTES },
  };
}, { auth: 'public' });

route('POST', '/api/setup', async (req) => {
  const body = await readBody(req);
  const token = store.setup(String(body.masterPassword || ''));
  return { token, apiKey: store.getApiKey(), baseUrl: `http://${HOST}:${PORT}` };
}, { auth: 'public' });

route('POST', '/api/unlock', async (req) => {
  const body = await readBody(req);
  const token = store.unlock(String(body.masterPassword || ''));
  return { token, apiKey: store.getApiKey(), baseUrl: `http://${HOST}:${PORT}` };
}, { auth: 'public' });

route('POST', '/api/lock', async (req) => {
  store.dropToken(bearer(req));
  return { ok: true };
}, { auth: 'public' });

route('POST', '/api/master/change', async (req) => {
  const body = await readBody(req);
  return { token: store.changeMasterPassword(String(body.current || ''), String(body.next || '')) };
});

/* ------------------------------------------------------------------ */
/* 账号（按三个界面查询）                                              */
/* ------------------------------------------------------------------ */

route('GET', '/api/accounts', async (req, _res, _m, url) => {
  const state = url.searchParams.get('state') || STATE.AVAILABLE;
  const out = store.listByState(state, {
    q: url.searchParams.get('q') || '',
    sort: url.searchParams.get('sort') || '',
  });
  return { ...out, stats: store.stats() };
});

/** 三个界面一次拿全（首屏、轮询用） */
route('GET', '/api/board', async (req, _res, _m, url) => {
  const q = url.searchParams.get('q') || '';
  return {
    available: store.listByState(STATE.AVAILABLE, { q }),
    inUse: store.listByState(STATE.IN_USE, { q }),
    pending: store.listByState(STATE.PENDING, { q }),
    stats: store.stats(),
  };
});

route('POST', '/api/accounts', async (req) => {
  const b = await readBody(req);
  const account = store.createAccount({
    username: b.username,
    password: b.password,
    game: b.game,
    note: b.note,
    email: b.email,
    usageMinutes: b.usageMinutes,
    mailboxId: b.mailboxId,
  });
  return { account, stats: store.stats() };
});

route('POST', '/api/accounts/bulk', async (req) => {
  const b = await readBody(req);
  let entries = Array.isArray(b.entries) ? b.entries : [];
  if (!entries.length && b.text) entries = parseBulkText(b.text);
  if (!entries.length) bad('没有解析到任何账号');
  const out = store.bulkImport(entries, b.usageMinutes || DEFAULT_USAGE_MINUTES);
  return { ...out, stats: store.stats() };
});

route('POST', '/api/accounts/parse', async (req) => {
  const b = await readBody(req);
  const parsed = parseBulkText(b.text || '');
  return { count: parsed.length, entries: parsed };
});

route('PATCH', '/api/accounts/:id', async (req, _res, m) => {
  const b = await readBody(req);
  return { account: store.updateAccount(Number(m.id), b), stats: store.stats() };
});

route('DELETE', '/api/accounts/:id', async (_req, _res, m) => {
  const out = store.deleteAccount(Number(m.id));
  return { ...out, stats: store.stats() };
});

route('POST', '/api/accounts/:id/reveal', async (_req, _res, m) => store.revealPassword(Number(m.id)));

route('GET', '/api/accounts/:id/credential', async (req, _res, m, url) => {
  const c = store.revealPassword(Number(m.id));
  if ((url.searchParams.get('format') || 'json') === 'text') {
    return { text: formatCredential(c.username, c.password) };
  }
  return c;
});

route('GET', '/api/accounts/export', async (req, _res, _m, url) => {
  const format = url.searchParams.get('format') || 'txt';
  const mode = url.searchParams.get('mode') || 'readable';
  const stateFilter = url.searchParams.get('state') || '';
  const states = stateFilter ? [stateFilter] : [STATE.AVAILABLE, STATE.IN_USE, STATE.PENDING];
  const rows = [];
  for (const st of states) {
    for (const a of store.listByState(st, {}).items) {
      rows.push({ ...a, password: store.revealPassword(a.id).password });
    }
  }
  if (format === 'json') {
    return { json: rows, filename: `steam-accounts-${Date.now()}.json` };
  }
  let text;
  if (mode === 'csv') {
    text = '账号,密码,游戏,使用时间(分钟),备注,邮箱,状态\n' + rows
      .map((r) => [r.username, r.password, r.game, r.usageMinutes, r.note, r.email, r.stateLabel]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
  } else {
    text = rows
      .map((r) => `${formatCredential(r.username, r.password)}${r.game ? `\n\n游戏：${r.game}` : ''}`)
      .join('\n\n' + '─'.repeat(28) + '\n\n');
  }
  return { text, filename: `steam-accounts-${Date.now()}.txt` };
});

/* ------------------------------------------------------------------ */
/* 三态流转                                                            */
/* ------------------------------------------------------------------ */

/** 可用 ──▶ 使用中 */
route('POST', '/api/accounts/:id/use', async (req, _res, m) => {
  const b = await readBody(req);
  const r = store.startUse(Number(m.id), { actor: b.actor || 'local' });
  return { ...r, stats: store.stats() };
});

/** 使用中 ──▶ 可用（提前结束，不改密） */
route('POST', '/api/accounts/:id/cancel-use', async (req, _res, m) => {
  const b = await readBody(req);
  const account = store.cancelUse(Number(m.id), { actor: b.actor || 'local' });
  return { account, stats: store.stats() };
});

/** 待改密 ──▶ 可用（手动改密） */
route('POST', '/api/accounts/:id/password', async (req, _res, m) => {
  const b = await readBody(req);
  const account = store.setPassword(Number(m.id), String(b.newPassword || ''), { actor: b.actor || 'local' });
  return { account, stats: store.stats() };
});

/** 待改密 ──▶ 可用（跳过改密，保留原密码） */
route('POST', '/api/accounts/:id/skip-change', async (_req, _res, m) => {
  const account = store.skipChange(Number(m.id));
  return { account, stats: store.stats() };
});

/** 立刻跑一次调度（前端倒计时归零时主动触发，让流转即时可见） */
route('POST', '/api/scheduler/run', async () => {
  const created = await store.sweep();
  for (const t of created) await fireWebhook('password_change.pending', t);
  return { created: created.length, tasks: created, stats: store.stats() };
});

/* ------------------------------------------------------------------ */
/* 会话与统计                                                          */
/* ------------------------------------------------------------------ */

route('GET', '/api/sessions/active', async () => {
  const sessions = store.listActiveSessions();
  return { sessions, count: sessions.length };
});

route('GET', '/api/stats', async () => store.stats());

route('GET', '/api/stats/today', async () => {
  const sessions = store.todaySessions();
  return {
    // ★ 用本地日界，别用 UTC ★
    //   原来写的是 toISOString().slice(0,10)（UTC）。东八区每天 08:00 之前，
    //   这里返回的还是"昨天"，和 store 里 sessions.day_key（本地）对不上，
    //   界面上就会出现「今天 0 条」但明明刚用过的情况。
    dayKey: dayKey(),
    count: sessions.length,
    // 需求第 5 条的口径：今日改密完成次数（自动 + 手动）
    changes: store.todayChanges(),
    distinctAccounts: new Set(sessions.map((s) => s.accountId)).size,
    sessions,
  };
});

/* ------------------------------------------------------------------ */
/* 改密任务                                                            */
/* ------------------------------------------------------------------ */

route('GET', '/api/tasks', async (req, _res, _m, url) => ({
  tasks: store.listTasks({
    status: url.searchParams.get('status') || '',
    accountId: url.searchParams.get('accountId') || null,
  }),
}));

route('POST', '/api/tasks', async (req) => {
  const b = await readBody(req);
  const task = store.createTask(Number(b.accountId), {
    reason: b.reason || '手动重新派发改密',
    source: b.source || 'manual',
  });
  await fireWebhook('password_change.pending', task);
  return { task };
});

route('POST', '/api/tasks/:id/cancel', async (_req, _res, m) => ({ task: store.cancelTask(String(m.id)) }));

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

route('GET', '/api/settings', async () => ({
  settings: store.getSettings(),
  apiKey: store.getApiKey(),
  defaults: DEFAULT_SETTINGS,
  /** 本机地址（界面自己用） */
  baseUrl: `http://${HOST}:${PORT}`,
  /**
   * 最近一次从公网进来的地址（隧道给的）。
   * ★ 闲管家的「接口网关」要填这个，不是 baseUrl ★
   * 空字符串表示"还没见过外部访问" —— 那时只能让用户去从隧道地址打开一次。
   */
  publicBaseUrl: lastPublicBase,
  localBaseUrl: `http://${HOST}:${PORT}`,
}));

route('PUT', '/api/settings', async (req) => {
  const b = await readBody(req);
  return { settings: store.updateSettings(b || {}) };
});

route('POST', '/api/apikey/rotate', async () => ({ apiKey: store.rotateApiKey() }));

route('POST', '/api/webhook/test', async () => ({
  result: await fireWebhook('test', { hello: 'world', from: 'steam-account-manager' }),
  webhookUrl: store.getSettings().webhookUrl,
}));

route('GET', '/api/audit', async (req, _res, _m, url) => {
  const limit = Math.min(500, Number(url.searchParams.get('limit') || 80));
  return { items: store.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) };
});

/* ------------------------------------------------------------------ */
/* 邮箱（读取验证码用）                                                */
/* ------------------------------------------------------------------ */

/**
 * 把 MailError 翻译成合适的 HTTP 状态码。
 *
 * ★ 这里故意不用 401 ★
 *   前端的 api.js 对 401 的处理是「锁库、踢回解锁页」——那是给保险库会话用的。
 *   邮箱的 token 失效和保险库会话是两码事，混用会导致：
 *   某个邮箱 token 一过期，整个保险库就被锁上。
 *   所以统一用 400 + 机器可读的 code 字段，前端按 code 分支。
 */
function mailErrorToHttp(e) {
  if (e instanceof MailError) {
    const status = e.code === 'need_reauth' ? 400
      : (e.status && e.status >= 400 && e.status !== 401 ? e.status : 502);
    return new HttpError(status, e.message, { code: e.code, needsReauth: e.code === 'need_reauth' });
  }
  return e;
}

route('GET', '/api/mailboxes', async () => ({
  items: store.listMailboxes(),
  rate: mail.getRateStats(),
  config: mail.getConfigView(),
}));

route('POST', '/api/mailboxes', async (req) => {
  const b = await readBody(req);
  const given = String(b.address || '').trim();
  const givenUrl = String(b.apiUrl || b.credential || '').trim();

  // ★ 支持需求里那条整行格式 ★
  //   邮箱----取件地址，粘进「邮箱地址」或「取件接口地址」任意一栏都能认出来。
  const looksLikeLine = (v) => /@/.test(v) && /[-—–]{2,}/.test(v);
  const fromAddressField = looksLikeLine(given) ? splitMailboxPaste(given) : { address: '', apiUrl: '' };
  const fromUrlField = looksLikeLine(givenUrl) ? splitMailboxPaste(givenUrl) : { address: '', apiUrl: '' };

  let apiUrl = fromAddressField.apiUrl || fromUrlField.apiUrl || givenUrl;
  let address = fromAddressField.address || fromUrlField.address || given;

  // 地址字段容错：用户很容易把整条接口地址粘进「邮箱地址」那一栏。
  // 只要它长得像 URL，就先试着从里面把邮箱抠出来，别让一条 URL 变成邮箱地址。
  if (address.includes('://') || !address.includes('@')) {
    const fromUrl = addressFromApiUrl(address.includes('://') ? address : apiUrl);
    if (fromUrl) address = fromUrl;
  }
  if (!address) {
    const fromUrl = addressFromApiUrl(apiUrl);
    if (fromUrl) address = fromUrl;
  }

  // ★ 保存前把地址里的 f=html 换成 f=json ★
  //   wdmail 复制出来的是 html 版（给浏览器看的整页 HTML），我们解析不出邮件列表。
  //   实测同一个邮箱：f=html 得 0 封、f=json 得 1 封。
  //   用户从浏览器复制来的必然是这个版本，所以直接替他换掉，并在 hint 里说明。
  const norm = normalizeWebmailUrl(apiUrl);
  apiUrl = norm.url;

  const box = store.createMailbox({
    label: b.label,
    address,
    provider: b.provider || 'microsoft',
    clientId: b.clientId,
    // ★ 用拆好的 apiUrl ★
    //   原来这里写的是 b.apiUrl（原始入参）。整行粘贴时 b.apiUrl 是空的，
    //   于是「邮箱----取件地址」这种粘法会报「取件接口地址不能为空」。
    credential: apiUrl || b.credential || b.refreshToken,
  });
  return {
    mailbox: box,
    // 接口地址本身带凭据时提醒一次
    hint: [
      norm.changed
        ? '已把地址里的 f=html 自动改成 f=json（html 版解析不出邮件列表，「查看邮件」会是空的）'
        : '',
      b.provider === 'http' && apiUrlHasCredential(apiUrl)
        ? '这条地址里内嵌了邮箱凭据，它本身就是钥匙 —— 别外传'
        : '',
    ].filter(Boolean).join('；'),
  };
});

route('PATCH', '/api/mailboxes/:id', async (req, _res, m) => {
  const b = await readBody(req);
  // 和新增时一样：编辑时也把 f=html 换成 f=json，免得改一次又踩同一个坑
  if (typeof b.credential === 'string') b.credential = normalizeWebmailUrl(b.credential).url;
  if (typeof b.apiUrl === 'string') b.apiUrl = normalizeWebmailUrl(b.apiUrl).url;
  return { mailbox: store.updateMailbox(Number(m.id), b || {}) };
});

route('DELETE', '/api/mailboxes/:id', async (_req, _res, m) => {
  store.deleteMailbox(Number(m.id));
  return { ok: true };
});

/** 测试连接：只验证凭据能用，不落邮件 */
route('POST', '/api/mailboxes/:id/test', async (_req, _res, m) => {
  try {
    return await mail.test(Number(m.id));
  } catch (e) { throw mailErrorToHttp(e); }
});

/** 拉取邮件 */
route('POST', '/api/mailboxes/:id/fetch', async (req, _res, m) => {
  let force = false;
  try { force = !!(await readBody(req))?.force; } catch { /* 没 body 也算正常 */ }
  try {
    return await mail.fetch(Number(m.id), { force });
  } catch (e) { throw mailErrorToHttp(e); }
});

/** 已缓存的邮件列表（顺带把识别到的验证码标出来，方便核对提取逻辑） */
route('GET', '/api/mailboxes/:id/messages', async (req, _res, m, url) => {
  const items = store.listMessages(Number(m.id), {
    limit: Math.min(200, Number(url.searchParams.get('limit') || 50)),
    q: url.searchParams.get('q') || '',
  });
  const withCode = items.map((item) => {
    const { bodyText, ...rest } = item;
    const hit = extractSteamCode(bodyText || rest.bodyPreview);
    return {
      ...rest,
      isSteam: /steampowered|steamgames|valvesoftware/i.test(rest.fromAddress || ''),
      code: hit?.code || null,
      codeSource: hit?.source || '',
    };
  });
  return { items: withCode };
});

route('GET', '/api/messages/:id', async (_req, _res, m) => {
  const msg = store.getMessage(Number(m.id));
  const hit = extractSteamCode(msg.bodyText || msg.subject);
  return { message: { ...msg, code: hit?.code || null, codeConfidence: hit?.confidence || null } };
});

/* ------------------------------------------------------------------ */
/* 验证码                                                              */
/* ------------------------------------------------------------------ */

/**
 * 从已入库的邮件里找这个账号的验证码。
 *
 * 匹配策略（账号已按「每个账号独立地址」配置，所以能靠收件地址精确定位）：
 *   1. 只看该账号关联邮箱里、since 之后到达的邮件
 *   2. 只认 Steam 发来的、像验证码邮件的那些
 *   3. 如果账号登记了邮箱地址，优先取「收件地址 == 该地址」的
 *   4. 同优先级里取最新的
 *   5. 全文有多个候选码时宁可不给（绝不猜）
 *
 * fallbackText 是给「取件接口」用的兜底：那种接口的返回字段名我们事先不知道，
 * 可能解析不出结构化邮件 —— 这时把整段响应文本丢进来直接抠码。
 */
/**
 * 从邮箱里找验证码。
 *
 * ★ exclude：已经用过的码 ★
 *   实测踩过：第二次要验证码时，Steam 的新邮件还没到，
 *   邮箱里"最新的一封"仍然是第一封 → 又把**同一个旧码**返回去了。
 *   日志里表现为「第 2 次取到验证码：HPQ9T」「第 3 次取到验证码：HPQ9T」……
 *   所以调用方把用过的码传进来，这里主动跳过，只认新的。
 */
function findAccountCode(account, since, fallbackText = '', exclude = []) {
  const box = store.getAccountMailbox(account.id);
  if (!box) return { code: null, reason: 'no_mailbox' };

  const skip = new Set(exclude.map((c) => String(c).toUpperCase()));
  const rows = store.listMessagesSince(box.id, { since, limit: 40 });
  const candidates = rows.filter((r) => looksLikeCodeMail(r.subject, r.bodyText, r.fromAddress));

  if (!candidates.length) {
    // 兜底：直接从整段响应里抠
    if (fallbackText) {
      const hit = extractSteamCode(fallbackText);
      if (hit && !skip.has(String(hit.code).toUpperCase())) {
        return { code: hit.code, confidence: hit.confidence, source: `${hit.source}（接口原文）`, mailbox: box };
      }
      if (hit) {
        return { code: null, reason: 'all_seen', mailbox: box, scanned: rows.length, skipped: [...skip] };
      }
    }
    return { code: null, reason: 'no_mail', mailbox: box, scanned: rows.length };
  }

  const target = String(account.email || '').trim().toLowerCase();
  const ranked = [...candidates].sort((a, b) => {
    if (target) {
      const am = String(a.toAddress || '').toLowerCase() === target ? 1 : 0;
      const bm = String(b.toAddress || '').toLowerCase() === target ? 1 : 0;
      if (am !== bm) return bm - am;
    }
    return b.receivedAt - a.receivedAt;
  });

  let sawOnlyOld = false;
  for (const r of ranked) {
    const hit = extractSteamCode(r.bodyText) || extractSteamCode(r.subject);
    if (!hit) continue;
    if (skip.has(String(hit.code).toUpperCase())) { sawOnlyOld = true; continue; }
    return {
      code: hit.code,
      confidence: hit.confidence,
      source: hit.source,
      mailbox: box,
      message: {
        id: r.id,
        subject: r.subject,
        fromAddress: r.fromAddress,
        toAddress: r.toAddress,
        receivedAt: r.receivedAt,
      },
    };
  }
  // 全是已经用过的 —— 说明新邮件还没到，继续等
  return {
    code: null,
    reason: sawOnlyOld ? 'all_seen' : 'no_code',
    mailbox: box,
    scanned: candidates.length,
    skipped: [...skip],
  };
}

/** 轮询等待验证码。间隔递增，既够快又不至于把请求打得太密。 */
async function waitForAccountCode(account, { since, waitSec, exclude = [] }) {
  const box = store.getAccountMailbox(account.id);
  if (!box) {
    throw Object.assign(new Error('这个账号还没关联邮箱，无法自动取验证码'), {
      status: 400, extra: { code: 'no_mailbox' },
    });
  }

  const deadline = Date.now() + Math.max(0, waitSec) * 1000;
  let round = 0;
  let lastError = '';
  let lastReason = '';

  for (;;) {
    round += 1;
    let fallbackText = '';
    try {
      // 第一次强制全量，之后只取增量。
      // http 取件接口会额外返回"整段响应文本"，用于字段名不认识时兜底抠码。
      const r = await mail.fetchForCode(box.id, { force: round === 1 });
      fallbackText = r?.fallbackText || '';
    } catch (e) {
      if (e instanceof MailError && e.code === 'need_reauth') throw mailErrorToHttp(e);
      lastError = e.message;      // 网络抖动不算致命，继续等
    }

    const hit = findAccountCode(account, since, fallbackText, exclude);
    if (hit.code) return { ...hit, rounds: round, lastError };

    lastReason = hit.reason;
    if (Date.now() >= deadline) {
      return { code: null, reason: lastReason || 'timeout', rounds: round, lastError, skipped: exclude };
    }
    // 10s → 14s → 18s … 封顶 30s，再加点抖动
    // all_seen（只找到旧码）时等短一点 —— 新邮件通常几秒就到，没必要等 10 秒起步
    const base = lastReason === 'all_seen' ? 3000 : 10000;
    const gap = Math.min(30000, base + (round - 1) * 4000) + Math.floor(Math.random() * 3000);
    await sleep(Math.min(gap, Math.max(500, deadline - Date.now())));
  }
}

function codeQuery(url) {
  const now = Math.floor(Date.now() / 1000);
  const since = Number(url.searchParams.get('since')) || (now - 600);
  const waitSec = Math.min(240, Math.max(0, Number(url.searchParams.get('wait')) || 0));
  // ★ exclude=ABCDE,WXYZ1 —— 已经用过的码，别再返回 ★
  const exclude = String(url.searchParams.get('exclude') || '')
    .split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  return { since, waitSec, exclude };
}

/** 界面上手动取一次（会真的去拉邮件） */
route('GET', '/api/accounts/:id/code', async (req, _res, m, url) => {
  const account = store.getAccount(Number(m.id));
  const { since, waitSec, exclude } = codeQuery(url);
  const r = await waitForAccountCode(account, { since, waitSec, exclude });
  store.audit('code.fetch', {
    accountId: account.id,
    detail: r.code ? `取到验证码（${r.source}）` : `没取到：${r.reason}`,
  });
  return r;
});

/** 给 worker 用的自动化版本 */
route('GET', '/api/automation/accounts/:id/code', async (req, _res, m, url) => {
  const account = store.getAccount(Number(m.id));
  const { since, waitSec, exclude } = codeQuery(url);
  const r = await waitForAccountCode(account, { since, waitSec, exclude });
  store.audit('code.fetch', {
    actor: 'automation',
    accountId: account.id,
    detail: (r.code ? `取到验证码（${r.source}）` : `没取到：${r.reason}`)
      + (exclude.length ? `　已排除旧码 ${exclude.join('/')}` : ''),
  });
  return r;
}, { auth: 'automation' });

/* ------------------------------------------------------------------ */
/* AI 自动化接口（X-API-Key）                                          */
/* ------------------------------------------------------------------ */

/**
 * ★ 需求原文：「预留 api，方便后续我的其他程序调用这个账号管理器，
 *   达到的效果是『空闲中账号点击使用中后输出 账号：****** 密码******』」★
 *
 * 下面三个接口就是给外部程序用的（X-API-Key 鉴权，和改密接口同一把钥匙）：
 *   GET  /api/automation/available            → 看一眼有哪些空闲账号
 *   POST /api/automation/accounts/:id/use     → 让它「开始使用」，直接拿到 账号/密码
 *   GET  /api/automation/accounts/:id/credential?format=text → 只取凭据文本
 *
 * 会话鉴权的 /api/accounts/:id/use 只能给界面用；外部程序（脚本、别的程序）
 * 走这三个接口，不需要主密码，只需要 API Key。
 */
route('GET', '/api/automation/available', async (req, _res, _m, url) => {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const items = store.listByState(STATE.AVAILABLE, { q }).items
    .map((a) => ({
      id: a.id,
      username: a.username,
      game: a.game,
      note: a.note,
      email: a.email,
      usageMinutes: a.usageMinutes,
    }));
  return {
    count: items.length,
    items,
    useEndpoint: `POST http://${HOST}:${PORT}/api/automation/accounts/{id}/use`,
  };
}, { auth: 'automation' });

/** 让一个空闲账号进入「使用中」，并把 账号/密码 直接交给调用方 */
route('POST', '/api/automation/accounts/:id/use', async (req, _res, m) => {
  let actor = 'automation';
  try { actor = (await readBody(req))?.actor || actor; } catch { /* 无 body 也允许 */ }
  const r = store.startUse(Number(m.id), { actor });
  return {
    ...r,
    // 需求里那个格式：账号：\nxxx\n\n密码：\nyyy
    credentialText: r.credential?.text || '',
    stats: store.stats(),
  };
}, { auth: 'automation' });

/** 只取凭据（不改状态）；format=text 时额外给一段可直接打印的文本 */
route('GET', '/api/automation/accounts/:id/credential', async (_req, _res, m, url) => {
  const acc = store.getAccount(Number(m.id));
  const cred = store.revealPassword(acc.id, 'automation');
  const text = formatCredential(acc.username, cred.password);
  if (url.searchParams.get('format') === 'text') {
    return { text, contentType: 'text/plain; charset=utf-8' };
  }
  return { accountId: acc.id, username: acc.username, password: cred.password, text };
}, { auth: 'automation' });

/**
 * ★ 按游戏名领一个空闲账号（给客服系统这类外部程序用）★
 *
 *   GET  /api/automation/claim?game=CS2
 *   POST /api/automation/claim   { "game": "CS2" }
 *
 * 一次调用直接拿到账号密码；没有空闲的就返回 { ok:false, message:'暂无账号' }。
 *
 * 匹配规则：先精确（忽略大小写），再包含；多个候选时**最近没用的优先**。
 * 领走后账号进入「使用中」开始计时 —— 到点自动进「待改密」→ 改密 → 回「可用」。
 *
 * 为什么两种方法都开：客服系统有的喜欢 GET 拼参数，有的习惯 POST 发 JSON，
 * 都支持就省得对方改代码。参数名同时接受 game / 游戏名 / q。
 */
function pickGameParam(src) {
  return String(src?.game ?? src?.q ?? src?.['游戏名'] ?? '').trim();
}

/**
 * 从请求里解出"订单要求的时长（分钟）"。
 *
 * 客服系统传来的可能是这些写法，都认：
 *   minutes=360 / minute=360 / 分钟=360      → 直接就是分钟
 *   hours=6   / hour=6   / 小时=6 / h=6       → ×60
 *   360                                       → 裸数字，当分钟
 * 也认带中文的字符串：「6小时」「360分钟」「6h」「6 小时」。
 * 解析不出来就返回 undefined —— 表示"这一单没指定时长"，那就用账号自己的值。
 */
function pickMinutesParam(src) {
  if (!src) return undefined;
  const raw = src.minutes ?? src.minute ?? src['分钟']
    ?? src.duration ?? src['时长'] ?? '';
  const rawH = src.hours ?? src.hour ?? src['小时'] ?? src.h ?? '';

  const toNum = (v) => {
    const n = Number(String(v).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const h = toNum(rawH);
  if (h !== null) return Math.round(h * 60);

  const s = String(raw).trim();
  if (s) {
    const n = toNum(s);
    if (n !== null) {
      // 「6小时」「3天」这种把单位写在同一个字段里的情况。
      // ★ 顺序：先判最大的单位 ★ 否则「3天」会被当成 3 分钟。
      if (/天|day/i.test(s)) return Math.round(n * 1440);
      if (/分钟|min/i.test(s)) return Math.round(n);
      if (/小时|hour|hr|h\b/i.test(s)) return Math.round(n * 60);
      return Math.round(n);
    }
  }
  return undefined;
}

route('GET', '/api/automation/claim', async (req, _res, _m, url) => {
  const params = Object.fromEntries(url.searchParams.entries());
  return store.claimAvailable({
    game: pickGameParam(params),
    minutes: pickMinutesParam(params),
    actor: 'automation',
  });
}, { auth: 'automation' });

route('POST', '/api/automation/claim', async (req) => {
  let body = {};
  try { body = (await readBody(req)) || {}; } catch { /* 无 body 也允许 */ }
  return store.claimAvailable({
    game: pickGameParam(body),
    minutes: pickMinutesParam(body),
    actor: String(body.actor || 'automation'),
  });
}, { auth: 'automation' });

route('GET', '/api/automation/tasks', async (req, _res, _m, url) => {
  const status = url.searchParams.get('status') || 'pending';
  const tasks = store.listTasks({ status });
  return { tasks, count: tasks.length };
}, { auth: 'automation' });

route('GET', '/api/automation/context/:id', async (_req, _res, m) => {
  const task = store.getTask(String(m.id));
  const acc = store.getAccount(task.accountId);
  const cred = store.revealPassword(acc.id, 'automation');
  return {
    task,
    target: {
      platform: 'steam',
      accountId: acc.id,
      username: acc.username,
      currentPassword: cred.password,
      email: acc.email,
      game: acc.game,
      note: acc.note,
      usageMinutes: acc.usageMinutes,
      // 关联了邮箱就能自动取验证码；没关联则为 null，worker 会回落到手动
      mailboxId: acc.mailboxId ?? null,
      hasMailbox: !!acc.mailboxId,
    },
    instructions: [
      '1. 打开 https://help.steampowered.com/zh-cn/wizard/HelpChangePassword 并用 currentPassword 登录',
      '2. 若该账号开启了 Steam Guard，需要从邮箱或手机 App 获取验证码',
      '3. 设置好新密码后，调用 complete 接口回传 newPassword',
      '4. 回传成功后，该账号会自动从「待改密」回到「可用」',
    ],
    completeEndpoint: `POST http://${HOST}:${PORT}/api/automation/tasks/${task.id}/complete`,
    failEndpoint: `POST http://${HOST}:${PORT}/api/automation/tasks/${task.id}/fail`,
  };
}, { auth: 'automation' });

route('POST', '/api/automation/tasks/:id/claim', async (req, _res, m) => {
  const b = await readBody(req);
  return { task: store.claimTask(String(m.id), b.worker || req.headers['x-worker'] || 'ai-agent') };
}, { auth: 'automation' });

route('POST', '/api/automation/tasks/:id/progress', async (req, _res, m) => {
  const b = await readBody(req);
  return { task: store.progressTask(String(m.id), b.message || '') };
}, { auth: 'automation' });

route('POST', '/api/automation/tasks/:id/complete', async (req, _res, m) => {
  const b = await readBody(req);
  const task = store.completeTask(String(m.id), {
    newPassword: b.newPassword,
    message: b.message,
    worker: b.worker || 'ai-agent',
  });
  await fireWebhook('password_change.completed', task);
  return { task, account: store.getAccount(task.accountId), stats: store.stats() };
}, { auth: 'automation' });

route('POST', '/api/automation/tasks/:id/fail', async (req, _res, m) => {
  const b = await readBody(req);
  return {
    task: store.failTask(String(m.id), {
      error: b.error, worker: b.worker || 'ai-agent', retry: !!b.retry,
    }),
  };
}, { auth: 'automation' });

/**
 * 人类可读的接口说明页 —— 可以直接在浏览器里打开。
 * ★ 刻意不在这里显示 API Key ★
 *   这个页面是公开的，一旦把 Key 印在上面，任何能访问本机的人
 *   不用主密码就能通过 /context/{id} 读到全部账号密码。
 */
/* ================================================================== */
/* ★ 闲管家（虚拟货源）接口 ★                                          */
/*                                                                    */
/* 闲管家是请求方，我们是货源方。买家在闲鱼下单后它来调这些接口，        */
/* 我们把一个空闲账号的账号/密码当「卡密」还回去，它自动发货。         */
/*                                                                    */
/* 注意两点和别的接口不一样：                                          */
/*   ① 鉴权用 MD5 签名（auth: 'xgj'），不是会话令牌也不是 API Key      */
/*   ② 出错要回 **HTTP 200 + {code}**，回 401 会让它当成网络异常重试    */
/* ================================================================== */

/** 统一包一层闲管家的成功响应格式 */
const xgjOk = (data) => ({ code: XGJ_CODE.OK, msg: 'OK', data });

/**
 * 查询平台信息 —— 无参数，是闲管家"保存应用"时第一个调的接口。
 *
 * ★ 关键：返回的 app_id 必须是它给我们的「应用概况 AppKey」★
 *   写错了它保存应用就会失败，而且只提示"保存失败"，不告诉你哪错了。
 *   所以没配置时宁可明确报错，也不要返回一个假的。
 */
route('POST', '/goofish/open/info', async () => {
  const cfg = store.getSettings().xgj;
  if (!cfg?.appId) {
    throw new XgjError(XGJ_CODE.SERVER_ERROR,
      '本机还没填「应用概况 AppKey」。请在设置 → 闲管家里填上闲管家给你的 AppKey / AppSecret。');
  }
  return xgjOk({
    app_id: Number(cfg.appId),        // 官方要求是整数
    features: {
      // 我们没做退款接口 —— 如实返回 false，免得它把退款请求发过来
      is_support_order_refund: false,
      // 没做调价订阅
      is_support_goods_notify: false,
      // 支持不带安全价下单（我们自己控库存，不需要它兜底）
      is_support_loss_purchase: true,
    },
  });
}, { auth: 'public' });   // 这个接口官方规格里没有任何参数，所以也不签名

/** 查询商户信息 —— 自研系统固定返回一个大于 0 的余额即可 */
route('POST', '/goofish/user/info', async () => xgjOk({
  balance: 99999900,
}), { auth: 'xgj' });

/** 查询商品列表 —— 游戏 × 售卖档位，实时算 */
route('POST', '/goofish/goods/list', async (req) => {
  const body = await readBody(req);
  const pageNo = Math.max(1, Number(body.page_no) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(body.page_size) || 50));

  const { list } = buildGoodsList(store, { keyword: body.keyword });
  const start = (pageNo - 1) * pageSize;
  const page = list.slice(start, start + pageSize);

  return xgjOk({ list: page.map(toWireGoods), count: list.length });
}, { auth: 'xgj' });

/** 查询商品详情 */
route('POST', '/goofish/goods/detail', async (req) => {
  const body = await readBody(req);
  const goodsNo = String(body.goods_no || '').trim();
  const { list } = buildGoodsList(store);
  const hit = list.find((g) => g.goods_no === goodsNo);
  if (!hit) {
    throw new XgjError(XGJ_CODE.GOODS_NOT_FOUND, `商品不存在：${goodsNo}`);
  }
  return xgjOk(toWireGoods(hit));
}, { auth: 'xgj' });

/**
 * ★ 创建卡密订单 —— 核心 ★
 *
 * 买家付款后闲管家调这里。我们把一个空闲账号当卡密给它，它自动发给买家。
 * handleCardOrder 里做了幂等（同一个 order_no 重复来只会发一次货）。
 */
route('POST', '/goofish/order/purchase/create', async (req) => {
  const body = await readBody(req);
  const r = handleCardOrder(store, body || {});

  if (r.__error !== undefined) {
    // 没货用 1102、商品不存在用 1100 —— 闲管家会据此把订单标失败
    throw new XgjError(r.__error, r.__msg || '下单失败', r);
  }

  store.audit('xgj.order', {
    actor: '闲管家',
    detail: `${r.order_no} → ${r.card_items?.[0]?.card_no || '-'}${r.__replay ? '（重复请求，返回首次结果）' : ''}`,
  });
  return xgjOk(r);
}, { auth: 'xgj' });

/** 查询订单详情 —— 闲管家发货后/对账时来核验 */
route('POST', '/goofish/order/detail', async (req) => {
  const body = await readBody(req);
  const orderNo = String(body.order_no || '').trim();
  const outNo = String(body.out_order_no || '').trim();

  // order_no 和 out_order_no 必传其一；同时传时以 order_no 为准
  let row = orderNo ? store.findXgjOrder(orderNo) : null;
  if (!row && outNo) {
    row = store.db.prepare('SELECT * FROM xgj_orders WHERE out_order_no = ?').get(outNo) || null;
  }
  if (!row) {
    throw new XgjError(XGJ_CODE.ORDER_NOT_FOUND,
      `订单不存在：${orderNo || outNo}`);
  }

  // 注意：已成功或已失败时**必须**返回 end_time
  return xgjOk({
    order_type: XGJ_GOODS_TYPE.CARD,
    order_no: row.order_no,
    out_order_no: row.out_order_no,
    order_status: row.order_status,
    order_amount: row.order_amount,
    goods_no: row.goods_no,
    goods_name: row.goods_name,
    buy_quantity: row.buy_quantity,
    order_time: row.created_at,
    end_time: row.end_time ?? row.created_at,
    card_items: row.card_pwd
      ? [{ card_no: row.card_no, card_pwd: row.card_pwd, card_type: 2 }]
      : [],
    remark: row.remark || '',
  });
}, { auth: 'xgj' });

/* ================================================================== */
/* ★ 买家自助取码 ★                                                    */
/*                                                                    */
/* 买家租了账号，登录 Steam 时要验证码，而验证码发到的是账号绑定的邮箱 —— */
/* 他拿不到。所以给他一个链接，点开就能看到这个码。                     */
/*                                                                    */
/*   https://<隧道地址>/c/5127784776043050723                          */
/*                         └── 闲管家订单号（写进闲管家内容模板即可）    */
/*                                                                    */
/* ★ 这两个路由是 public（买家没有会话）★                              */
/*   安全性靠"订单号本身就是凭据" + 一堆限制（见 buyer.mjs 的注释）。    */
/*   最要紧的一条：**只发登录码，改密码的码一律不发**。                 */
/* ================================================================== */

/** 取码页面 */
route('GET', '/c/:orderNo', async (_req, res, m) => {
  const orderNo = decodeURIComponent(m.orderNo);
  const html = renderCodePage(orderNo);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  res.end(html);
  return null;   // 已经自己 end 了
}, { auth: 'public' });

/** 取码接口（页面每 30 秒调一次） */
route('GET', '/c/:orderNo/code', async (_req, _res, m) => {
  const orderNo = decodeURIComponent(m.orderNo);

  // ★ 限流 ★
  //   防两件事：① 买家狂点刷新把邮箱接口打爆 ② 有人拿链接枚举试探。
  const now = Date.now();
  const last = buyerCodeHits.get(orderNo) || 0;
  if (now - last < 3000) {
    return { ok: false, code: '' };
  }
  buyerCodeHits.set(orderNo, now);
  // 顺手清一下这张表，别让它无限长大
  if (buyerCodeHits.size > 500) {
    for (const [k, t] of buyerCodeHits) {
      if (now - t > 3600_000) buyerCodeHits.delete(k);
    }
  }

  const r = await fetchLoginCode({ store, mail, orderNo });
  if (r.ok) {
    // 只记"给了码"，不记码本身 —— 审计日志是给人翻的，别在里面留凭据
    store.audit('buyer.code.issued', { orderNo, accountId: null, detail: r.account || '' }, 'buyer');
    return { ok: true, code: r.code, account: r.account };
  }
  // ★ 不给原因 ★
  //   页面只说"暂时没有"。把 why 写进响应体等于告诉买家
  //   "我们看到了改密码邮件" —— 那是给他指路。
  return { ok: false, code: '' };
}, { auth: 'public' });

/** 取码限流表：订单号 → 上次请求时间 */
const buyerCodeHits = new Map();

/**
 * 给界面看的：闲管家对接状态自检。
 * 不涉及签名，只用来说明"现在能不能对接"。
 */
route('GET', '/api/xgj/status', async () => {
  const cfg = store.getSettings().xgj;
  const { list, count } = buildGoodsList(store);
  const byGame = {};
  for (const g of list) {
    byGame[g.__game] = (byGame[g.__game] || 0) + 1;
  }
  const missing = [];
  if (!cfg.enabled) missing.push('enabled（功能开关）');
  if (!cfg.appId) missing.push('appId（闲管家给你的 AppKey）');
  if (!cfg.appSecret) missing.push('appSecret（闲管家给你的 AppSecret）');
  if (!cfg.mchSecret) missing.push('mchSecret（我们自己定的对接密钥）');

  return {
    enabled: !!cfg.enabled,
    ready: missing.length === 0,
    missing,
    mchId: cfg.mchId,
    hasMchSecret: !!cfg.mchSecret,
    hasAppKey: !!cfg.appId,
    ipWhitelist: !!cfg.ipWhitelist,
    tiers: store.getSettings().saleDurationTiers.map((m) => ({ minutes: m, label: xgjDuration(m) })),
    goodsCount: count,
    games: Object.entries(byGame).map(([game, n]) => ({ game, goods: n })),
    endpoints: {
      platformInfo: 'POST /goofish/open/info',
      merchantInfo: 'POST /goofish/user/info',
      goodsList: 'POST /goofish/goods/list',
      goodsDetail: 'POST /goofish/goods/detail',
      createOrder: 'POST /goofish/order/purchase/create',
      orderDetail: 'POST /goofish/order/detail',
    },
  };
});

/**
 * ★ 闲管家请求日志（界面用）★
 *
 * 闲管家界面出问题（比如"关联商品"下拉空白）时，最需要知道的是：
 * **它到底调没调我们、我们回了什么**。
 *   一条日志都没有 → 是它那边的问题（网关地址错/应用没上线/它没触发）
 *   有日志但 code 不是 0 → 是我们这边的问题
 */
route('GET', '/api/xgj/log', async (req, _res, _m, url) => {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  return {
    count: xgjLog.length,
    items: xgjLog.slice(0, limit),
    hint: xgjLog.length
      ? '这是闲管家最近调我们的记录'
      : '一条记录都没有 —— 说明闲管家压根没调到我们。检查它的「接口网关」填对了没、地址是不是已经失效。',
  };
});

/**
 * 商品预览（界面用，会话鉴权）。
 *
 * 和闲管家调的 /goofish/goods/list 是同一份逻辑，只是换成主密码鉴权，
 * 让你在界面上直接看到"会生成哪些商品、各自还有多少货"。
 */
route('GET', '/api/xgj/goods', async (req, _res, _m, url) => {
  const keyword = url.searchParams.get('q') || '';
  const { list, count } = buildGoodsList(store, { keyword });
  return {
    count,
    // 把内部字段去掉，换成给界面看的样子
    items: list.map((g) => ({
      goodsNo: g.goods_no,
      name: g.goods_name,
      game: g.__game,
      minutes: g.__minutes,
      duration: xgjDuration(g.__minutes),
      price: g.price,
      stock: g.stock,
      onSale: g.status === 1,
    })),
    games: [...new Set(list.map((g) => g.__game))],
  };
});

/* ------------------------------------------------------------------ */
/* 自动化接口说明页                                                    */
/* ------------------------------------------------------------------ */

route('GET', '/api/automation', async (req, res) => {
  let openTasks = null;
  if (store.initialized && store.unlocked) {
    try {
      openTasks = store.listTasks({}).filter((t) => t.status === 'pending' || t.status === 'running').length;
    } catch { /* 忽略 */ }
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(automationHelpPage({
    openTasks,
    initialized: store.initialized,
    unlocked: store.unlocked,
  }));
  return null;
}, { auth: 'public' });

/** 接口规格是纯文档、不含任何密钥，因此公开，方便直接用浏览器查看 */
route('GET', '/api/automation/spec', async () => automationSpec(), { auth: 'public' });

function automationHelpPage(vault) {
  const base = `http://${HOST}:${PORT}`;
  const { openTasks = null, initialized = false, unlocked = false } = vault || {};
  let stateLine;
  if (!initialized) {
    stateLine = '<span class="warn">保险库还没有创建。先在应用里设置主密码。</span>';
  } else if (!unlocked) {
    stateLine = '<span class="warn">保险库当前已锁定，先在应用里解锁才能读取待办数量。</span>';
  } else if (openTasks > 0) {
    stateLine = `当前有 <b class="ok">${openTasks}</b> 个改密任务等待处理`;
  } else {
    stateLine = '当前没有待处理的改密任务';
  }

  const curl = [
    `KEY="你的API Key"`,
    ``,
    `# 1) 拉取待改密任务`,
    `curl -H "X-API-Key: $KEY" "${base}/api/automation/tasks?status=pending"`,
    ``,
    `# 2) 读取改密上下文（含账号、当前密码、邮箱、游戏名）`,
    `curl -H "X-API-Key: $KEY" "${base}/api/automation/context/<任务ID>"`,
    ``,
    `# 3) 改完后回传新密码 —— 账号会自动回到「可用」`,
    `curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \\`,
    `     -d '{"newPassword":"新密码","worker":"my-agent"}' \\`,
    `     "${base}/api/automation/tasks/<任务ID>/complete"`,
  ].join('\n');

  const ps = [
    `$KEY = "你的API Key"`,
    `$H = @{ "X-API-Key" = $KEY }`,
    ``,
    `# 拉取待改密任务`,
    `Invoke-RestMethod -Headers $H "${base}/api/automation/tasks?status=pending"`,
    ``,
    `# 回传新密码`,
    `Invoke-RestMethod -Method Post -Headers ($H + @{"Content-Type"="application/json"}) \``,
    `  -Body '{"newPassword":"新密码"}' \``,
    `  "${base}/api/automation/tasks/<任务ID>/complete"`,
  ].join('\n');

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI 自动化接口 · Steam 账号管理器</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 20px 64px;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
    background: radial-gradient(120% 90% at 50% -10%, #12141c, #07080c 62%);
    color: #f5f5f7; line-height: 1.6; -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 780px; margin: 0 auto; }
  h1 { font-size: 24px; letter-spacing: -0.03em; margin: 0 0 6px; }
  h2 { font-size: 15px; letter-spacing: -0.02em; margin: 34px 0 12px; color: #f5f5f7; }
  p { margin: 0 0 12px; color: rgba(235,235,245,0.66); font-size: 13.5px; }
  a { color: #409cff; }
  code, pre {
    font-family: "Cascadia Code", ui-monospace, Consolas, monospace;
    font-size: 12.5px;
  }
  code { background: rgba(255,255,255,0.09); padding: 2px 6px; border-radius: 5px; }
  .banner {
    margin: 22px 0; padding: 15px 17px; border-radius: 14px;
    background: rgba(255,159,10,0.11); border: 1px solid rgba(255,159,10,0.3);
  }
  .banner b { color: #ff9f0a; }
  .card {
    background: rgba(255,255,255,0.055); border: 1px solid rgba(255,255,255,0.1);
    border-radius: 16px; padding: 18px 20px; margin-bottom: 14px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  td { padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.07); vertical-align: top; }
  tr:first-child td { border-top: 0; }
  td.m { width: 58px; }
  .verb { font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 5px; letter-spacing: .04em; }
  .get { background: rgba(10,132,255,0.18); color: #409cff; }
  .post { background: rgba(50,215,75,0.16); color: #32d74b; }
  td.d { color: rgba(235,235,245,0.5); text-align: right; }
  pre {
    background: rgba(0,0,0,0.32); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px; padding: 14px 16px; overflow-x: auto;
    color: rgba(235,235,245,0.8); margin: 0; white-space: pre;
  }
  .ok { color: #32d74b; } .warn { color: #ff9f0a; }
  .steps { counter-reset: s; list-style: none; padding: 0; margin: 0; }
  .steps li { position: relative; padding-left: 30px; margin-bottom: 11px; font-size: 13.5px; }
  .steps li::before {
    counter-increment: s; content: counter(s);
    position: absolute; left: 0; top: 1px;
    width: 20px; height: 20px; border-radius: 50%;
    background: rgba(10,132,255,0.2); color: #409cff;
    font-size: 11px; font-weight: 700; display: grid; place-items: center;
  }
  .foot { margin-top: 34px; font-size: 12px; color: rgba(235,235,245,0.34); }
</style>
</head>
<body>
<div class="wrap">
  <h1>AI 自动化改密接口</h1>
  <p>Steam 账号管理器 · 本地服务 <code>${base}</code></p>

  <div class="banner">
    <b>刚才那条「未解锁或登录状态已失效」是正常的。</b>
    这些接口需要 <code>X-API-Key</code> 请求头，而浏览器地址栏只能发 GET、<b>无法附加请求头</b>，
    所以直接打开一定会被拒绝。请用下面的方式调用。
  </div>

  <div class="card">
    <b>${stateLine}</b>
  </div>

  <h2>怎么接</h2>
  <ol class="steps">
    <li>回到应用界面，在「<b>待改密</b>」页顶部的卡片里，或「<b>设置</b>」页里，复制你的 API Key。</li>
    <li>用下面的命令或你自己的程序，带上 <code>X-API-Key</code> 拉取待改密任务。</li>
    <li>拿到任务后调用 <code>/context/&lt;任务ID&gt;</code> 获取账号、当前密码、邮箱与游戏名。</li>
    <li>用你的自动化去 Steam 改密（需要邮箱或 Steam Guard 验证码），改完把新密码回传给
        <code>/complete</code>，账号就会自动回到「可用」。</li>
  </ol>

  <h2>接口一览</h2>
  <div class="card">
    <table>
      <tr><td class="m"><span class="verb get">GET</span></td><td><code>/api/automation/claim?game=CS2</code></td><td class="d">★ 按游戏名一步领取账号（含密码）</td></tr>
      <tr><td class="m"><span class="verb get">GET</span></td><td><code>/api/automation/available</code></td><td class="d">列出空闲账号（外部程序取号用）</td></tr>
      <tr><td class="m"><span class="verb post">POST</span></td><td><code>/api/automation/accounts/{id}/use</code></td><td class="d">开始使用 → 直接返回 账号/密码</td></tr>
      <tr><td class="m"><span class="verb get">GET</span></td><td><code>/api/automation/accounts/{id}/credential</code></td><td class="d">只取凭据（<code>?format=text</code>）</td></tr>
      <tr><td class="m"><span class="verb get">GET</span></td><td><code>/api/automation/tasks?status=pending</code></td><td class="d">拉取待改密任务</td></tr>
      <tr><td class="m"><span class="verb get">GET</span></td><td><code>/api/automation/context/{id}</code></td><td class="d">账号、当前密码、操作步骤</td></tr>
      <tr><td class="m"><span class="verb post">POST</span></td><td><code>/api/automation/tasks/{id}/claim</code></td><td class="d">声明接管</td></tr>
      <tr><td class="m"><span class="verb post">POST</span></td><td><code>/api/automation/tasks/{id}/progress</code></td><td class="d">上报进度</td></tr>
      <tr><td class="m"><span class="verb post">POST</span></td><td><code>/api/automation/tasks/{id}/complete</code></td><td class="d">回传新密码 → 回到可用</td></tr>
      <tr><td class="m"><span class="verb post">POST</span></td><td><code>/api/automation/tasks/{id}/fail</code></td><td class="d">上报失败（可重试）</td></tr>
      <tr><td class="m"><span class="verb get">GET</span></td><td><a href="/api/automation/spec"><code>/api/automation/spec</code></a></td><td class="d">机器可读的完整规格</td></tr>
    </table>
  </div>

  <h2>curl 示例</h2>
  <pre>${esc(curl)}</pre>

  <h2>PowerShell 示例</h2>
  <pre>${esc(ps)}</pre>

  <h2>Webhook 主动通知</h2>
  <p>在「设置」页填一个地址，有账号倒计时结束、进入「待改密」时会立刻收到 POST：</p>
  <pre>${esc('{\n  "event": "password_change.pending",\n  "at": 1735200000,\n  "data": { "id": "任务ID", "username": "steam_user_01", "reason": "使用时间已用完（360 分钟）" }\n}')}</pre>

  <div class="foot">
    本页面不显示 API Key —— 它是公开页面，而拿到 Key 就能读取全部账号密码，
    必须由你在应用内（通过主密码解锁后）自行复制。
  </div>
</div>
</body>
</html>`;
}

function automationSpec() {
  const base = `http://${HOST}:${PORT}`;
  return {
    name: 'Steam 账号管理器 · AI 自动化改密接口',
    version: '2.0.0',
    baseUrl: base,
    auth: { header: 'X-API-Key', note: '在设置页可查看/重置；也接受会话 Bearer Token' },
    lifecycle: [
      '账号在「使用中」的倒计时归零后，自动进入「待改密」并生成一个 pending 任务',
      'AI 处理完并回传 newPassword 后，任务变 done，账号自动回到「可用」',
    ],
    flow: [
      'GET  /api/automation/claim?game=CS2             ★ 按游戏名一步领取账号（含密码）★',
      'GET  /api/automation/available                列出空闲账号（外部程序取号用）',
      'POST /api/automation/accounts/{id}/use        开始使用 → 直接返回 账号/密码',
      'GET  /api/automation/accounts/{id}/credential 只取凭据（?format=text）',
      'GET  /api/automation/tasks?status=pending   拉取待改密任务',
      'GET  /api/automation/context/{id}           读取改密上下文（含当前密码）',
      'POST /api/automation/tasks/{id}/claim       声明接管 {"worker":"my-agent"}',
      'POST /api/automation/tasks/{id}/progress    上报进度 {"message":"等待验证码"}',
      'POST /api/automation/tasks/{id}/complete    回传新密码 {"newPassword":"..."}',
      'POST /api/automation/tasks/{id}/fail        上报失败 {"error":"...","retry":true}',
    ],
    endpoints: [
      {
        method: 'GET',
        path: '/api/automation/claim',
        query: {
          game: '游戏名（也接受 q）；不传则任意给一个空闲账号',
          minutes: '★订单要求的时长（分钟）；也接受 hours=6、h=6、duration=6小时、分钟/小时中文',
        },
        returns: 'ok:true 时给 username/password/text；没空闲账号时 ok:false + message:"暂无账号"',
        note: '一步到位：领走后账号进入「使用中」开始计时，到点自动改密再回「可用」。'
          + '匹配规则：先精确再包含；多个候选时最近没用的优先。'
          + '传了时长就把账号的使用时间改成这个值（一个账号能接任意时长的单），不传则用它原本配置的时长。',
      },
      {
        method: 'POST',
        path: '/api/automation/claim',
        body: {
          game: '游戏名',
          minutes: '订单时长（分钟）；也可用 hours',
          actor: '可选，记录是谁领的',
        },
      },
      { method: 'GET', path: '/api/automation/available', query: { q: '可选，按账号/游戏名过滤' } },
      { method: 'POST', path: '/api/automation/accounts/{id}/use', body: { actor: '可选' }, returns: 'credentialText：账号：\\n…\\n\\n密码：\\n…' },
      { method: 'GET', path: '/api/automation/accounts/{id}/credential', query: { format: 'text 时返回纯文本' } },
      { method: 'GET', path: '/api/automation/tasks', query: { status: 'pending|running|done|failed|canceled' } },
      { method: 'GET', path: '/api/automation/context/{id}' },
      { method: 'POST', path: '/api/automation/tasks/{id}/claim', body: { worker: 'string' } },
      { method: 'POST', path: '/api/automation/tasks/{id}/progress', body: { message: 'string' } },
      { method: 'POST', path: '/api/automation/tasks/{id}/complete', body: { newPassword: 'string', message: 'string', worker: 'string' } },
      { method: 'POST', path: '/api/automation/tasks/{id}/fail', body: { error: 'string', retry: false } },
    ],
    webhook: {
      description: '任务创建/完成时向设置里的 webhookUrl 推送 POST',
      events: ['password_change.pending', 'password_change.completed', 'test'],
      signatureHeader: 'X-Vault-Signature',
      signatureFormat: 'sha256=<hex hmac-sha256(webhookSecret, rawBody)>',
    },
  };
}

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res, pathname) {
  if (!fs.existsSync(WEB_DIST)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Steam 账号管理器</title>
      <body style="font-family:system-ui;padding:48px;background:#0b0c10;color:#eee">
      <h1>前端尚未构建</h1>
      <p>API 已在 <code>http://${HOST}:${PORT}/api/health</code> 运行。</p>
      <p>请先执行 <code>npm run build</code>，或直接双击「启动.bat」。</p>
      </body>`);
    return;
  }
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.join(WEB_DIST, rel);
  if (!target.startsWith(WEB_DIST)) { res.writeHead(403); res.end('forbidden'); return; }
  let file = target;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIST, 'index.html');
  const data = await fsp.readFile(file);
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(data);
}

/* ------------------------------------------------------------------ */
/* 主处理                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 记住"最后一次从公网进来的地址"                                       */
/* ------------------------------------------------------------------ */

/**
 * ★ 为什么需要这个 ★
 *
 * 闲管家的「接口网关」必须填**公网地址**，不能是 127.0.0.1。
 * 但界面是在本机打开的（location.origin = http://127.0.0.1:8787），
 * 面板无从知道隧道给的那个公网地址是什么 —— 实测就被这个问题坑过：
 * 面板显示的接口网关是 http://127.0.0.1:8787，照着填进闲管家必然连不上。
 *
 * 解法：服务端从每个请求的 Host 头里认一下，只要是**非本机**的地址就记下来。
 * 这样你从隧道地址打开过一次页面（或隧道启动器探活一次），
 * 本机打开的面板也能知道该填哪个公网地址。
 *
 * 只存在内存里：临时隧道每次重启都换地址，记到磁盘反而会显示过期地址。
 */
let lastPublicBase = '';

function isLocalHostName(h) {
  const name = String(h || '').split(':')[0].toLowerCase();
  if (!name) return true;
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1') return true;
  if (name.startsWith('192.168.')) return true;
  if (name.startsWith('10.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(name)) return true;
  if (name.endsWith('.local')) return true;
  return false;
}

/** 从请求头里认出外部地址并记下来 */
function rememberPublicBase(req) {
  // 反代/隧道会写 x-forwarded-host；没有就看 Host
  const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!raw || isLocalHostName(raw)) return;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket?.encrypted ? 'https' : 'http');
  lastPublicBase = `${proto}://${raw}`;
}

/* ------------------------------------------------------------------ */
/* ★ 闲管家请求日志 ★                                                  */
/* ------------------------------------------------------------------ */

/**
 * 环形缓冲，只留最近 200 条。
 *
 * ★ 为什么需要 ★
 *   闲管家那边界面出问题（比如"关联商品"下拉是空的）时，
 *   最需要知道的就一件事：**它到底调没调我们的接口、我们回了什么**。
 *   一条日志都没有 → 是它那边的问题；
 *   有日志但 code 不对 → 是我们这边的问题。
 *   没有这个，只能靠猜。
 */
const XGJ_LOG_MAX = 200;
const xgjLog = [];

function pushXgjLog(entry) {
  xgjLog.unshift(entry);
  if (xgjLog.length > XGJ_LOG_MAX) xgjLog.length = XGJ_LOG_MAX;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = url.pathname;
  const isXgjPath = pathname.startsWith('/goofish/');
  const xgjT0 = Date.now();

  // 记下外部地址（本机地址会被忽略）
  try { rememberPublicBase(req); } catch { /* 不影响正常请求 */ }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key,X-Vault-Token,X-Worker',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }

  if (!pathname.startsWith('/api/') && !pathname.startsWith('/goofish/') && !pathname.startsWith('/c/')) {
    try { await serveStatic(req, res, pathname); }
    catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('静态资源读取失败: ' + e.message);
    }
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key,X-Vault-Token,X-Worker,X-Worker-Name');

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.regex);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = m[i + 1]; });

    // 闲管家路径：先把请求体原文读出来（会缓存，处理函数还能再读），用于记日志
    let xgjReqBody = '';
    if (isXgjPath) {
      try { xgjReqBody = await readRawBody(req); } catch { /* 读不到就算了 */ }
    }

    /** 记一条闲管家调用日志 */
    const logCall = (code, msg, data) => {
      if (!isXgjPath) return;
      const list = Array.isArray(data?.data?.list) ? data.data.list : null;
      pushXgjLog({
        at: Math.floor(Date.now() / 1000),
        ms: Date.now() - xgjT0,
        method: req.method,
        path: pathname,
        ip: clientIp(req),
        // ★ 请求体原文也记下来 ★
        //   排查"下拉是空的"这类问题时，最要紧的是知道它到底**问了什么** ——
        //   比如它带了 keyword 或 goods_type 过滤，而我们返回的没匹配上。
        body: xgjReqBody.slice(0, 400),
        code,
        msg: String(msg ?? '').slice(0, 200),
        // 商品列表那种返回，把 count 也记下来，方便一眼看出"调到了但没数据"
        count: data?.data?.count ?? null,
        items: list ? list.length : null,
        // ★ 把返回的商品名也记下来（最多 8 个）★
        //   这样能确认"我们给的东西和它要的是不是同一批"
        names: list ? list.slice(0, 8).map((g) => `${g.goods_name}(${g.goods_no})`) : null,
        query: url.searchParams.get('mch_id') ? '有 mch_id' : '无 mch_id',
      });
    };

    try {
      if (r.auth === 'session') requireSession(req);
      else if (r.auth === 'automation') requireAutomation(req);
      else if (r.auth === 'xgj') await requireXgj(req, url);
      if (r.auth !== 'public' && r.auth !== 'xgj') store.checkAutoLock(store.getSettings());
      const out = await r.handler(req, res, params, url);
      logCall(out?.code ?? 0, out?.msg ?? 'OK', out);
      if (!res.writableEnded) sendJson(res, 200, out ?? { ok: true });
    } catch (e) {
      // ★ 闲管家的错误要用它自己的格式 ★
      //   它只认响应体里的 code，而且是 **HTTP 200**——
      //   回 401/403 反而会让它当成"网络异常"重试，把错误信息也丢掉。
      if (e.xgjCode !== undefined) {
        logCall(e.xgjCode, e.message, null);
        if (!res.writableEnded) {
          sendJson(res, 200, {
            code: e.xgjCode,
            msg: e.message || '失败',
            data: {},
            ...(e.xgjDetail ? { detail: e.xgjDetail } : {}),
          });
        }
        return;
      }
      const status = e.status || 500;
      if (status >= 500) console.error('[error]', req.method, pathname, e);
      if (!res.writableEnded) sendJson(res, status, { error: e.message || '服务器内部错误', ...(e.extra || {}) });
    }
    return;
  }

  sendJson(res, 404, { error: `未知接口 ${req.method} ${pathname}` });
});

/* 唯一的调度器：每 5 秒推进一次三态流转，并推送 Webhook */
let sweeping = false;
setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    store.checkAutoLock(store.getSettings());
    // 对账：清掉"账号已不在待改密、任务还挂着"的僵尸任务，
    // 否则 worker 会一直去登录一个本该空闲的账号。
    const zombie = store.reconcileTasks();
    if (zombie) console.log(`[reconcile] 清理了 ${zombie} 个僵尸任务`);
    const created = await store.sweep();
    for (const t of created) {
      console.log(`[state] ${t.username} 使用时间结束 → 待改密（任务 ${t.id}）`);
      await fireWebhook('password_change.pending', t);
    }
  } catch (e) {
    console.error('[scheduler]', e.message);
  } finally {
    sweeping = false;
  }
}, 5000);

server.listen(PORT, HOST, () => {
  const line = '─'.repeat(58);
  console.log(`\n${line}`);
  console.log('  🔐  Steam 账号管理器  已启动');
  console.log(`${line}`);
  console.log(`  界面地址   http://${HOST}:${PORT}`);
  console.log(`  健康检查   http://${HOST}:${PORT}/api/health`);
  console.log(`  自动化接口 http://${HOST}:${PORT}/api/automation/spec`);
  console.log(`  数据目录   ${DATA_DIR}`);
  console.log(`  运行状态   ${store.initialized ? (store.unlocked ? '已解锁' : '已初始化 · 待解锁') : '首次使用 · 待创建主密码'}`);
  console.log(`${line}\n`);
});

function shutdown() {
  console.log('\n正在关闭…');
  store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
