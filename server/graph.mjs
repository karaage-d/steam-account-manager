/**
 * 微软 Graph 邮箱客户端
 *
 * ── 设计目标 ────────────────────────────────────────────────────────
 * 在「能稳定拿到邮件」的前提下，把被微软判定为异常活动的概率压到最低。
 * 具体做法（这就是"不容易封号"的落地）：
 *
 *   1. 全局串行    同一时刻只发一个请求，绝不并发轰炸
 *   2. 最小间隔    两次请求之间至少隔 MAIL_MIN_INTERVAL_MS（默认 1500ms）
 *   3. 随机抖动    在间隔上再加 0~MAIL_JITTER_MS 的随机量，
 *                  避免出现"精确每 1500ms 一次"这种机器人特征
 *   4. 被限流退避  收到 429 时读 Retry-After，并叠加指数退避
 *   5. 失败退避    5xx 等可重试错误同样指数退避，最多重试 MAIL_MAX_RETRIES 次
 *   6. 只取必要字段 用 $select 限定返回字段，$top 限制条数
 *   7. 增量拉取    只取"上次之后"到达的邮件，不反复全量拉
 *   8. 手动触发    不做后台高频轮询
 *
 * ── 关于 token ──────────────────────────────────────────────────────
 * access token 约 1 小时过期，这里内存缓存，过期前自动用 refresh token 换新的。
 *
 * ★ 微软会轮换 refresh token ★：每次刷新可能返回一个新的，旧的随之作废。
 *   所以每次刷新后都必须回写数据库（store.saveRefreshedToken），
 *   否则跑一段时间后所有 token 会集体失效。
 */
import { setTimeout as sleep } from 'node:timers/promises';

export const GRAPH_DEFAULTS = {
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  graphBase: 'https://graph.microsoft.com/v1.0',
  /** 两次请求之间的最小间隔 */
  minIntervalMs: 1500,
  /** 附加的随机抖动上限（让节奏不规律） */
  jitterMs: 800,
  /** 可重试错误的最大重试次数 */
  maxRetries: 3,
  /** 单次拉取最多取多少封 */
  fetchTop: 20,
  /** 退避上限，避免无限等待 */
  maxBackoffMs: 5 * 60 * 1000,
  /**
   * 刷新时是否附带 scope。
   * 默认不带：不带就用当初授权时的 scope，最不容易出错。
   */
  scope: '',
  userAgent: 'SteamAccountManager/2.0 (local)',
};

export class MailError extends Error {
  constructor(message, { code = 'error', status = 0, retryable = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'MailError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/* ------------------------------------------------------------------ */
/* 限流器                                                              */
/* ------------------------------------------------------------------ */

export class RateLimiter {
  constructor({ minIntervalMs, jitterMs, maxBackoffMs }) {
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.jitterMs = Math.max(0, jitterMs);
    this.maxBackoffMs = maxBackoffMs;
    this._chain = Promise.resolve();
    this._lastAt = 0;
    this._penaltyUntil = 0;
    this._consecutiveErrors = 0;
    this.stats = { requests: 0, throttled: 0, lastWaitMs: 0, penaltyUntil: 0 };
  }

  /** 排队执行：串行 + 最小间隔 + 抖动 + 退避 */
  schedule(fn) {
    const run = this._chain.then(() => this._execute(fn));
    // 无论成败都让队列继续，避免一次失败卡死后续
    this._chain = run.catch(() => {});
    return run;
  }

  async _execute(fn) {
    const now = Date.now();
    const penaltyWait = Math.max(0, this._penaltyUntil - now);
    const gap = this.minIntervalMs + Math.floor(Math.random() * (this.jitterMs + 1));
    const gapWait = Math.max(0, gap - (now - this._lastAt));
    const wait = Math.max(penaltyWait, gapWait);
    if (wait > 0) {
      this.stats.lastWaitMs = wait;
      await sleep(wait);
    }
    this._lastAt = Date.now();
    this.stats.requests += 1;
    return fn();
  }

  /** 被限流 / 可重试失败后，让后面的请求多等一会儿 */
  penalize(ms) {
    const capped = Math.min(ms, this.maxBackoffMs);
    this._penaltyUntil = Math.max(this._penaltyUntil, Date.now() + capped);
    this.stats.penaltyUntil = this._penaltyUntil;
    return capped;
  }

  noteSuccess() { this._consecutiveErrors = 0; }

  /** 指数退避：1.5s → 3s → 6s … 封顶 maxBackoffMs */
  noteFailure() {
    this._consecutiveErrors += 1;
    const backoff = Math.min(1500 * (2 ** (this._consecutiveErrors - 1)), this.maxBackoffMs);
    return this.penalize(backoff);
  }

  snapshot() {
    return { ...this.stats, pendingPenaltyMs: Math.max(0, this._penaltyUntil - Date.now()) };
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 细节                                                           */
/* ------------------------------------------------------------------ */

/** 把响应里的 Retry-After 解析成毫秒 */
function retryAfterMs(res) {
  const raw = res.headers.get('retry-after');
  if (!raw) return 0;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : 0;
}

/** 把 OAuth 错误码翻译成人话 */
function describeTokenError(status, data) {
  const err = String(data?.error || '');
  const desc = String(data?.error_description || '').split('\n')[0].slice(0, 300);
  const code = String(data?.error_codes?.[0] || '');

  // token 彻底失效 —— 重试没有意义，需要用户重新授权
  const dead = err === 'invalid_grant'
    || err === 'unauthorized_client'
    || code === 'AADSTS700082'   // refresh token 因长期未使用而过期
    || code === 'AADSTS50173'    // 令牌已被吊销（常见于改密码）
    || code === 'AADSTS70000'    // 令牌无效
    || code === 'AADSTS500133';
  if (dead) {
    return new MailError(`授权已失效，需要重新获取 token：${desc || err}`, {
      code: 'need_reauth', status,
    });
  }
  const retryable = status === 429 || status >= 500;
  return new MailError(`换取令牌失败（HTTP ${status}）：${desc || err}`, {
    code: retryable ? 'throttled' : 'error', status, retryable,
  });
}

/* ------------------------------------------------------------------ */
/* 两个原始请求                                                        */
/* ------------------------------------------------------------------ */

/** 用 refresh token 换 access token */
export async function refreshAccessToken({ clientId, refreshToken, cfg }) {
  if (!clientId) throw new MailError('缺少 client_id', { code: 'config' });
  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (cfg.scope) form.set('scope', cfg.scope);

  let res;
  try {
    res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': cfg.userAgent,
        Accept: 'application/json',
      },
      body: form,
    });
  } catch (e) {
    throw new MailError(`连不上微软登录服务：${e.message}`, { code: 'network', retryable: true });
  }

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON 就留 null */ }

  if (!res.ok) throw describeTokenError(res.status, data);
  if (!data?.access_token) {
    throw new MailError('令牌响应里没有 access_token', { code: 'error' });
  }
  return {
    accessToken: data.access_token,
    // ★ 可能为空；为空表示沿用原 token ★
    refreshToken: data.refresh_token || '',
    expiresIn: Number(data.expires_in) || 3600,
  };
}

/** 拉取收件箱邮件 */
export async function fetchInbox({ accessToken, top, sinceIso, cfg }) {
  const url = new URL(`${cfg.graphBase}/me/mailFolders/Inbox/messages`);
  url.searchParams.set('$top', String(Math.max(1, Math.min(50, top))));
  url.searchParams.set('$select', 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,body');
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  if (sinceIso) url.searchParams.set('$filter', `receivedDateTime ge ${sinceIso}`);

  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': cfg.userAgent,
      },
    });
  } catch (e) {
    throw new MailError(`连不上 Graph：${e.message}`, { code: 'network', retryable: true });
  }

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 忽略 */ }

  if (res.status === 401) {
    throw new MailError('access token 被拒绝', { code: 'token_expired', status: 401 });
  }
  if (res.status === 403) {
    throw new MailError('这个 token 没有读取邮件的权限（需要 Mail.Read）', { code: 'forbidden', status: 403 });
  }
  if (!res.ok) {
    const msg = String(data?.error?.message || '').slice(0, 300) || `HTTP ${res.status}`;
    const retryable = res.status === 429 || res.status >= 500;
    throw new MailError(`Graph 返回错误：${msg}`, {
      code: 'throttled', status: res.status, retryable,
      retryAfterMs: retryAfterMs(res),
    });
  }
  return Array.isArray(data?.value) ? data.value : [];
}

/* ------------------------------------------------------------------ */
/* HTML → 纯文本                                                       */
/* ------------------------------------------------------------------ */

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把 Graph 的一条 message 转成本地结构 */
export function normalizeMessage(m) {
  const body = m?.body?.content || '';
  const isHtml = String(m?.body?.contentType || '').toLowerCase() === 'html';
  return {
    graphId: String(m?.id || ''),
    subject: String(m?.subject || ''),
    fromAddress: String(m?.from?.emailAddress?.address || ''),
    fromName: String(m?.from?.emailAddress?.name || ''),
    toAddress: String(m?.toRecipients?.[0]?.emailAddress?.address || ''),
    receivedAt: Math.floor(Date.parse(m?.receivedDateTime || '') / 1000) || 0,
    bodyPreview: String(m?.bodyPreview || '').slice(0, 1000),
    bodyText: (isHtml ? htmlToText(body) : String(body)).slice(0, 20000),
  };
}

/* ------------------------------------------------------------------ */
/* 服务                                                                */
/* ------------------------------------------------------------------ */

export class GraphMail {
  constructor(store, overrides = {}) {
    this.store = store;
    this.cfg = {
      ...GRAPH_DEFAULTS,
      tokenUrl: process.env.GRAPH_TOKEN_URL || GRAPH_DEFAULTS.tokenUrl,
      graphBase: process.env.GRAPH_BASE || GRAPH_DEFAULTS.graphBase,
      minIntervalMs: numOr(process.env.MAIL_MIN_INTERVAL_MS, GRAPH_DEFAULTS.minIntervalMs),
      jitterMs: numOr(process.env.MAIL_JITTER_MS, GRAPH_DEFAULTS.jitterMs),
      maxRetries: numOr(process.env.MAIL_MAX_RETRIES, GRAPH_DEFAULTS.maxRetries),
      fetchTop: numOr(process.env.MAIL_FETCH_TOP, GRAPH_DEFAULTS.fetchTop),
      scope: process.env.MAIL_SCOPE || GRAPH_DEFAULTS.scope,
      ...overrides,
    };
    this.limiter = new RateLimiter(this.cfg);
    this._tokens = new Map();     // mailboxId -> { accessToken, expiresAt }
    this._busy = new Set();       // 防止同一个邮箱并发拉取
  }

  getRateStats() { return this.limiter.snapshot(); }

  getConfigView() {
    return {
      minIntervalMs: this.cfg.minIntervalMs,
      jitterMs: this.cfg.jitterMs,
      maxRetries: this.cfg.maxRetries,
      fetchTop: this.cfg.fetchTop,
      graphBase: this.cfg.graphBase,
    };
  }

  /** 换取 access token（带内存缓存 + 轮换回写） */
  async accessTokenFor(row) {
    const cached = this._tokens.get(row.id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

    const refreshToken = this.store.getMailboxToken(row.id);
    if (!refreshToken) {
      throw new MailError('这个邮箱没有保存 token', { code: 'need_reauth' });
    }

    const res = await this.limiter.schedule(() => refreshAccessToken({
      clientId: row.client_id, refreshToken, cfg: this.cfg,
    }));

    // ★ 轮换回写：不回写的话，跑一阵子就会集体失效 ★
    if (res.refreshToken && res.refreshToken !== refreshToken) {
      this.store.saveRefreshedToken(row.id, res.refreshToken);
    }
    this._tokens.set(row.id, {
      accessToken: res.accessToken,
      expiresAt: Date.now() + res.expiresIn * 1000,
    });
    return res.accessToken;
  }

  /** 带重试的请求包装：可重试错误走指数退避 */
  async _withRetry(fn) {
    let lastErr = null;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt += 1) {
      try {
        const out = await fn();
        this.limiter.noteSuccess();
        return out;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof MailError) || !e.retryable) throw e;
        if (attempt === this.cfg.maxRetries) break;
        if (e.status === 429) this.limiter.stats.throttled += 1;
        const wait = e.retryAfterMs > 0
          ? this.limiter.penalize(e.retryAfterMs)
          : this.limiter.noteFailure();
        this._onNotice?.(`第 ${attempt + 1} 次失败，退避 ${Math.round(wait / 1000)} 秒后重试`);
      }
    }
    throw lastErr;
  }

  /** 测试连接：只验证凭据能不能换到令牌、能不能读到收件箱 */
  async test(mailboxId) {
    const row = this.store.getMailboxRow(mailboxId);
    this._tokens.delete(row.id);          // 测试要真连一次
    try {
      const token = await this.accessTokenFor(row);
      const items = await this._withRetry(() => this.limiter.schedule(() => fetchInbox({
        accessToken: token, top: 1, sinceIso: '', cfg: this.cfg,
      })));
      const updated = this.store.setMailboxStatus(row.id, 'ok');
      return { ok: true, mailbox: updated, reachable: true, sampleCount: items.length };
    } catch (e) {
      const status = e.code === 'need_reauth' ? 'need_reauth' : 'error';
      this.store.setMailboxStatus(row.id, status, e.message);
      throw e;
    }
  }

  /** 拉取邮件并入库 */
  async fetch(mailboxId, { force = false } = {}) {
    const row = this.store.getMailboxRow(mailboxId);
    if (this._busy.has(row.id)) {
      throw new MailError('这个邮箱正在拉取中，请稍候', { code: 'busy', status: 409 });
    }
    this._busy.add(row.id);
    try {
      const token = await this.accessTokenFor(row);

      // 增量：只取上次拉取之后到达的。留 5 分钟重叠，避免边界漏信。
      let sinceIso = '';
      if (!force && row.last_fetch_at) {
        sinceIso = new Date((row.last_fetch_at - 300) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      }

      const raw = await this._withRetry(() => this.limiter.schedule(() => fetchInbox({
        accessToken: token, top: this.cfg.fetchTop, sinceIso, cfg: this.cfg,
      })));

      const items = raw.map(normalizeMessage).filter((m) => m.graphId);
      const added = this.store.saveMessages(row.id, items);
      const updated = this.store.setMailboxStatus(row.id, 'ok');
      this.store.audit('mailbox.fetch', {
        actor: 'local',
        detail: `${row.address}：取回 ${items.length} 封，新增 ${added} 封`,
      });
      return { ok: true, fetched: items.length, added, mailbox: updated, rate: this.getRateStats() };
    } catch (e) {
      const status = e.code === 'need_reauth' ? 'need_reauth' : 'error';
      this.store.setMailboxStatus(row.id, status, e.message);
      throw e;
    } finally {
      this._busy.delete(row.id);
    }
  }
}

function numOr(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
