/**
 * HTTP 取件提供商 —— 对接"给你一个接口地址，返回邮箱内容"这类服务。
 *
 * 为什么需要它：
 *   iCloud 没有公开的邮件 API，第三方取件站（如 wdmail 这类）本质是中间人 ——
 *   你给它 `?e=邮箱:密码`，它在自己服务器上替你收信，再把结果返回给你。
 *   这个模块让账号管理器**自己去请求那个接口**，凭据不出本机。
 *
 * 接口形态（实测 wdmail）：
 *   GET https://api.wdmail.top/m?f=json&e=<邮箱>:<密码>
 *   → { "code": 0, "data": { "recipient": "...", "mail_query_hours": 24, "messages": [...] } }
 *
 *   GET ...&f=html
 *   → 一段 HTML
 *
 * ★ 我们不知道 messages 里每一项的字段名 ★
 *   所以这里刻意写得"皮实"：按常见命名猜测 + 把所有字符串值兜底拼起来，
 *   最后交给 code.mjs 的关键词锚定去抠。字段名对不上也能工作。
 */
import { createHash } from 'node:crypto';
import { MailError } from './graph.mjs';

export const WEBMAIL_DEFAULTS = {
  timeoutMs: 20000,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 从接口地址里把邮箱地址抠出来（wdmail 用 ?e=邮箱:密码） */
export function addressFromApiUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    // 常见的几种参数名
    for (const key of ['e', 'email', 'mail', 'account', 'user']) {
      const v = u.searchParams.get(key);
      if (!v) continue;
      const addr = v.includes(':') ? v.split(':')[0] : v;
      if (/@/.test(addr)) return addr.trim();
    }
    // 退一步：整个 URL 里找第一个像邮箱的东西
    const m = String(rawUrl).match(/[^\s:/@]+@[^\s:/@?&]+/);
    if (m) return m[0];
  } catch { /* 不是合法 URL */ }
  return '';
}

/**
 * ★ 把取件地址里的 `f=html` 自动改成 `f=json` ★
 *
 * 为什么必须替用户改：
 *   wdmail 这类取件服务**默认给的就是 `f=html` 的链接**（那是给浏览器看的页面）。
 *   但它是**一整页 HTML**，我们解析不出一封封邮件 ——
 *   验证码还能靠兜底逻辑从整段文本里抠出来，可是**「查看邮件」永远是空的**，
 *   一旦取码失败，连"邮件到底到没到"都查不了，等于失去排查手段。
 *
 * 实测（同一批邮箱，只改这一个参数）：
 *     f=html → 解析出 0 封
 *     f=json → 解析出 1 封（「您的 Steam 帐户：来自新网页或移动设备的访问」）
 *
 * 用户从浏览器复制来的必然是 html 版，已经踩过两次，所以保存时直接替他换掉，
 * 并在返回值里告诉他换了 —— 不做静默修改，免得他以为没生效。
 */
export function normalizeWebmailUrl(rawUrl) {
  const s = String(rawUrl || '');
  if (!/f=html\b/i.test(s)) return { url: s, changed: false };
  return { url: s.replace(/f=html\b/i, 'f=json'), changed: true };
}

/**
 * 一整行粘贴 → `{ address, apiUrl }`
 *
 * ★ 需求里给的格式本来就是**一整行** ★
 *   humbugs_errors4z@icloud.com----https://api.wdmail.top/m?f=html&e=humbugs_errors4z@icloud.com:TF4Tqxn8
 * 之前界面上必须手工拆成「取件接口地址」和「邮箱地址」两个框，
 * 直接把这一行粘进地址栏，它会被当成一个 URL，取信时必然报错。
 *
 * 分隔符兼容 `----`、`——`、`––`（连续 2 个以上横线），
 * 用「第一个连续横线」切分，所以带 `-` 的邮箱（如 my-name@x.com）不会被切坏。
 */
export function splitMailboxPaste(raw) {
  const s = String(raw || '').trim();
  if (!s) return { address: '', apiUrl: '' };

  const parts = s.split(/\s*[-—–]{2,}\s*/);
  if (parts.length >= 2 && /@/.test(parts[0])) {
    return { address: parts[0].trim(), apiUrl: parts.slice(1).join('--').trim() };
  }
  // 只有地址
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return { address: addressFromApiUrl(s), apiUrl: s };
  // 只有邮箱
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { address: s, apiUrl: '' };
  return { address: '', apiUrl: s };
}

/** 接口地址里有没有内嵌凭据（有的话它本身就是钥匙） */
export function apiUrlHasCredential(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    for (const key of ['e', 'email', 'mail', 'account', 'user']) {
      const v = u.searchParams.get(key);
      if (v && v.includes(':') && v.split(':')[1]) return true;
    }
  } catch { /* 忽略 */ }
  return false;
}

/* ------------------------------------------------------------------ */
/* 响应解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把任意 JSON 里**所有字符串值**收集起来（不含键名）。
 * 这样即使字段名和我们猜的不一样，正文内容也不会漏。
 */
export function collectStrings(node, out = [], depth = 0) {
  if (depth > 8) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const v of node) collectStrings(v, out, depth + 1); return out; }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectStrings(v, out, depth + 1);
  }
  return out;
}

/** 常见字段名猜测 —— 不知道对方怎么命名，就都试一遍 */
const FIELD_ALIASES = {
  subject: ['subject', 'title', 'subj', 'Subject', 'SUBJECT'],
  from: ['from', 'sender', 'fromAddress', 'from_address', 'mail_from', 'fromEmail', 'from_email'],
  fromName: ['fromName', 'from_name', 'senderName', 'name'],
  to: ['to', 'recipient', 'rcpt', 'toAddress', 'to_address', 'mail_to', 'toEmail', 'to_email'],
  receivedAt: [
    'receivedAt', 'received_at', 'date', 'time', 'ts', 'timestamp',
    'createdAt', 'created_at', 'receivedDate', 'sentAt', 'sent_at', 'mailDate', 'mail_date',
  ],
  body: [
    'body', 'content', 'text', 'html', 'bodyHtml', 'body_html', 'bodyText', 'body_text',
    'message', 'mailBody',
    // 实测 wdmail 用的是 text_body —— 猜不到就会退化成"全字符串拼接"，
    // 能抠出码但界面预览会显示成一串 id 和地址
    'text_body', 'html_body', 'textBody', 'htmlBody', 'plain_body', 'plainBody', 'content_text',
  ],
};

/** 唯一标识可能的字段名 */
const ID_ALIASES = [
  'id', 'uid', 'messageId', 'message_id', 'mailId', 'mail_id',
  'msg_id', 'msgId', 'key', 'uuid', 'mid',
];

function pickField(obj, names) {
  for (const n of names) {
    const v = obj[n];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/** 把日期字段转成秒级时间戳（容忍字符串/毫秒/秒） */
export function toEpochSeconds(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') {
    // 毫秒还是秒？
    return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return toEpochSeconds(Number(s));
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

/** 把一条原始记录归一化成我们内部的结构（字段名对不上也尽力而为） */
export function normalizeWebmailMessage(raw, index = 0) {
  const obj = (raw && typeof raw === 'object') ? raw : { body: String(raw ?? '') };
  const bodyRaw = pickField(obj, FIELD_ALIASES.body);
  const all = collectStrings(obj).join('\n');
  const subject = pickField(obj, FIELD_ALIASES.subject);
  const fromAddress = pickField(obj, FIELD_ALIASES.from);
  const receivedAt = toEpochSeconds(pickField(obj, FIELD_ALIASES.receivedAt)) || Math.floor(Date.now() / 1000);

  // 唯一 id：优先用对方给的；没有就用内容指纹。
  //
  // ★ 指纹里绝对不能放时间戳或数组下标 ★
  //   时间戳认不出来时会退化成 Date.now()（每次拉取都不一样），
  //   数组下标会随邮件顺序变化 —— 两种情况都会让同一条邮件每次都被当成"新的"，
  //   库里无限重复。所以指纹只由**内容**决定。
  let given = '';
  for (const k of ID_ALIASES) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') { given = String(v); break; }
  }
  const fingerprint = createHash('sha1')
    .update(`${subject}|${fromAddress}|${(bodyRaw || all).slice(0, 500)}`)
    .digest('hex').slice(0, 16);

  return {
    graphId: `web-${given || fingerprint}`,
    subject,
    fromAddress,
    fromName: pickField(obj, FIELD_ALIASES.fromName),
    toAddress: pickField(obj, FIELD_ALIASES.to),
    receivedAt,
    // 正文优先用 body 字段；拿不到就把整条记录的所有字符串拼起来
    bodyText: (bodyRaw || all).slice(0, 20000),
    bodyPreview: (bodyRaw || all).replace(/\s+/g, ' ').slice(0, 1000),
  };
}

/**
 * 解析接口返回。
 * @returns {{ ok: boolean, messages: object[], text: string, error: string, hours: number, recipient: string }}
 */
export function parseWebmailResponse(rawText, contentType = '') {
  const text = String(rawText || '');
  const looksJson = /json/i.test(contentType) || text.trim().startsWith('{') || text.trim().startsWith('[');

  if (looksJson) {
    let j = null;
    try { j = JSON.parse(text); } catch { /* 不是合法 JSON，退化成纯文本 */ }
    if (j) {
      // 有些接口用 code/status 表示成败
      const code = j.code ?? j.status ?? j.errcode;
      const failed = (typeof code === 'number' && code !== 0 && code !== 200)
        || j.success === false || j.ok === false;
      const data = j.data ?? j.result ?? j;
      if (failed) {
        return {
          ok: false, messages: [], text,
          error: String(j.message || j.msg || j.error || `接口返回 code=${code}`),
          hours: Number(data?.mail_query_hours) || 0,
          recipient: String(data?.recipient || ''),
        };
      }
      const arr = Array.isArray(data?.messages) ? data.messages
        : Array.isArray(data) ? data
          : Array.isArray(j.messages) ? j.messages : [];
      const messages = arr.map((m, i) => normalizeWebmailMessage(m, i));
      // 即使没解析出 messages，也把全部字符串值留作兜底
      const fallbackText = collectStrings(data).join('\n');
      return {
        ok: true,
        messages,
        text: messages.length ? '' : fallbackText,
        error: '',
        hours: Number(data?.mail_query_hours) || 0,
        recipient: String(data?.recipient || ''),
        looksHtml: false,
      };
    }
  }

  // HTML 或其他纯文本 —— 原样交给上层去抠
  return {
    ok: true, messages: [], text, error: '', hours: 0, recipient: '',
    looksHtml: /^\s*</.test(text),
  };
}

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

export async function fetchWebmail(rawUrl, cfg = {}) {
  const conf = { ...WEBMAIL_DEFAULTS, ...cfg };
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new MailError('接口地址不是合法的 URL', { code: 'config' });
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new MailError('接口地址必须是 http/https', { code: 'config' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), conf.timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': conf.userAgent,
        Accept: 'application/json, text/html, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e.name === 'AbortError' ? `接口超时（${conf.timeoutMs}ms）` : `连不上取件接口：${e.message}`;
    throw new MailError(msg, { code: 'network', retryable: true });
  }
  clearTimeout(timer);

  const text = await res.text();
  if (res.status === 429) {
    throw new MailError('取件接口限流了（HTTP 429）', {
      code: 'throttled', status: 429, retryable: true,
      retryAfterMs: Number(res.headers.get('retry-after') || 0) * 1000,
    });
  }
  if (res.status >= 500) {
    throw new MailError(`取件接口服务端错误（HTTP ${res.status}）`, {
      code: 'throttled', status: res.status, retryable: true,
    });
  }
  if (!res.ok) {
    // 401/403 通常意味着那条 URL 里的凭据过期或失效
    const dead = res.status === 401 || res.status === 403;
    throw new MailError(
      dead ? `取件接口拒绝了这个凭据（HTTP ${res.status}），需要换一条新地址`
        : `取件接口返回 HTTP ${res.status}`,
      { code: dead ? 'need_reauth' : 'error', status: res.status },
    );
  }

  const parsed = parseWebmailResponse(text, res.headers.get('content-type') || '');
  if (!parsed.ok) {
    throw new MailError(`取件接口报错：${parsed.error}`, { code: 'error' });
  }
  return parsed;
}
