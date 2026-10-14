/**
 * 邮箱服务分发层
 *
 * 目前支持两种提供商：
 *
 *   microsoft  微软 Graph（refresh token 换 access token）
 *   http       第三方"取件接口"（iCloud 这类没有公开 API 的邮箱走这条）
 *              —— 你给一个接口地址，它返回邮箱内容，我们自己抠验证码。
 *
 * 上层（index.mjs）只跟这个类打交道，不用关心背后是哪一种。
 */
import { GraphMail, MailError, RateLimiter } from './graph.mjs';
import { fetchWebmail, addressFromApiUrl, apiUrlHasCredential, WEBMAIL_DEFAULTS } from './webmail.mjs';

export const PROVIDERS = {
  microsoft: { key: 'microsoft', label: '微软邮箱（Graph + refresh token）' },
  http: { key: 'http', label: '取件接口（iCloud 等，填接口地址）' },
};

export function isKnownProvider(p) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, String(p || ''));
}

function numOr(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export class MailService {
  constructor(store, overrides = {}) {
    this.store = store;
    this.graph = new GraphMail(store, overrides);
    this.webCfg = {
      ...WEBMAIL_DEFAULTS,
      timeoutMs: numOr(process.env.WEBMAIL_TIMEOUT_MS, WEBMAIL_DEFAULTS.timeoutMs),
      ...overrides,
    };
    // 取件接口同样要限流：那是第三方服务，打太密会把你的凭据连带限掉
    this.webLimiter = new RateLimiter({
      minIntervalMs: numOr(process.env.WEBMAIL_MIN_INTERVAL_MS, 1200),
      jitterMs: numOr(process.env.WEBMAIL_JITTER_MS, 600),
      maxBackoffMs: 5 * 60 * 1000,
    });
    this._busy = new Set();
  }

  providerOf(row) {
    const p = String(row?.provider || 'microsoft');
    return isKnownProvider(p) ? p : 'microsoft';
  }

  getRateStats() {
    return {
      graph: this.graph.getRateStats(),
      web: this.webLimiter.snapshot(),
      requests: this.graph.getRateStats().requests + this.webLimiter.snapshot().requests,
      throttled: this.graph.getRateStats().throttled + this.webLimiter.snapshot().throttled,
      pendingPenaltyMs: Math.max(
        this.graph.getRateStats().pendingPenaltyMs,
        this.webLimiter.snapshot().pendingPenaltyMs,
      ),
    };
  }

  getConfigView() {
    return {
      ...this.graph.getConfigView(),
      providers: Object.values(PROVIDERS),
      web: {
        minIntervalMs: this.webLimiter.minIntervalMs,
        jitterMs: this.webLimiter.jitterMs,
        timeoutMs: this.webCfg.timeoutMs,
      },
    };
  }

  /** 取件接口的凭据就是那条 URL，它本身就是钥匙 */
  credentialFor(row) {
    const raw = this.store.getMailboxCredential(row.id);
    if (!raw) throw new MailError('这个邮箱还没保存凭据', { code: 'need_reauth' });
    return raw;
  }

  /* ---------------- microsoft ---------------- */

  async _graphTest(id) { return this.graph.test(id); }

  async _graphFetch(id, opts) { return this.graph.fetch(id, opts); }

  /* ---------------- http 取件接口 ---------------- */

  async _httpFetchOnce(row) {
    const url = this.credentialFor(row);
    const parsed = await this.webLimiter.schedule(() => fetchWebmail(url, this.webCfg));
    // 记录一下接口自报的邮箱地址（对不上就提示，避免张冠李戴）
    const reported = parsed.recipient || addressFromApiUrl(url);
    return { parsed, reported };
  }

  async _httpTest(id) {
    const row = this.store.getMailboxRow(id);
    try {
      const { parsed, reported } = await this._httpFetchOnce(row);
      const updated = this.store.setMailboxStatus(row.id, 'ok');
      return {
        ok: true,
        mailbox: updated,
        reachable: true,
        provider: 'http',
        reportedAddress: reported,
        messageCount: parsed.messages.length,
        // 提醒：接口地址里带凭据 = 它本身就是钥匙
        credentialIsUrl: apiUrlHasCredential(this.store.getMailboxCredential(row.id)),
      };
    } catch (e) {
      const status = e.code === 'need_reauth' ? 'need_reauth' : 'error';
      this.store.setMailboxStatus(row.id, status, e.message);
      throw e;
    }
  }

  async _httpFetch(id) {
    const row = this.store.getMailboxRow(id);
    if (this._busy.has(row.id)) {
      throw new MailError('这个邮箱正在拉取中，请稍候', { code: 'busy', status: 409 });
    }
    this._busy.add(row.id);
    try {
      const { parsed, reported } = await this._httpFetchOnce(row);
      const added = this.store.saveMessages(row.id, parsed.messages);
      const updated = this.store.setMailboxStatus(row.id, 'ok');

      // 接口返回的是 HTML（通常是地址里写了 f=html）时，我们解析不出结构化邮件，
      // 只能拿到一大段文本 —— 验证码仍然抠得出来，但界面看不到邮件。
      // 这里如实告诉用户该改哪里，别让人对着"0 封"发呆。
      const url = this.store.getMailboxCredential(row.id) || '';
      let hint = '';
      if (!parsed.messages.length && parsed.looksHtml) {
        hint = /[?&]f=html/i.test(url)
          ? '接口返回的是 HTML，解析不出结构化邮件。把地址里的 f=html 改成 f=json 就有邮件列表了（验证码本身照常能取）。'
          : '接口返回的是 HTML，解析不出结构化邮件。试试在地址里加 &f=json。';
      }

      this.store.audit('mailbox.fetch', {
        actor: 'local',
        detail: `${row.address}：接口返回 ${parsed.messages.length} 封，新增 ${added} 封${hint ? '（HTML 响应）' : ''}`,
      });
      return {
        ok: true,
        provider: 'http',
        fetched: parsed.messages.length,
        added,
        mailbox: updated,
        reportedAddress: reported,
        // 接口只给最近 24 小时，这里如实带出来让上层知道
        queryHours: parsed.hours || 0,
        looksHtml: !!parsed.looksHtml,
        hint,
        rate: this.getRateStats(),
      };
    } catch (e) {
      const status = e.code === 'need_reauth' ? 'need_reauth' : 'error';
      this.store.setMailboxStatus(row.id, status, e.message);
      throw e;
    } finally {
      this._busy.delete(row.id);
    }
  }

  /* ---------------- 对外 ---------------- */

  async test(mailboxId) {
    const row = this.store.getMailboxRow(mailboxId);
    return this.providerOf(row) === 'http'
      ? this._httpTest(mailboxId)
      : this._graphTest(mailboxId);
  }

  async fetch(mailboxId, opts = {}) {
    const row = this.store.getMailboxRow(mailboxId);
    return this.providerOf(row) === 'http'
      ? this._httpFetch(mailboxId, opts)
      : this._graphFetch(mailboxId, opts);
  }

  /**
   * 取回"可搜索文本"用于抠验证码。
   * 入库的 messages 已经带了正文，所以这里主要给 http 场景兜底：
   * 接口可能没解析出 messages（字段名不认识），那就把整段响应文本拿回来。
   */
  async fetchForCode(mailboxId, opts = {}) {
    const row = this.store.getMailboxRow(mailboxId);
    if (this.providerOf(row) !== 'http') {
      await this.fetch(mailboxId, opts);
      return { fallbackText: '' };
    }
    // http：拉一次并入库；拿不到结构化邮件时把整段文本带出去
    const url = this.credentialFor(row);
    const parsed = await this.webLimiter.schedule(() => fetchWebmail(url, this.webCfg));
    this.store.saveMessages(row.id, parsed.messages);
    this.store.setMailboxStatus(row.id,
      parsed.messages.length || parsed.text ? 'ok' : 'ok');
    return { fallbackText: parsed.text || '' };
  }
}

export { MailError };
