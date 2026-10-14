/**
 * Steam 验证码提取
 *
 * Steam 的邮箱安全码是 **5 位**，由大写字母和数字组成。
 * 邮件文案中英文都有，且 Steam 改过版式，所以这里用「分层兜底」而不是单一正则：
 *
 *   ① 关键词锚定：在「安全代码 / 验证码 / 代码 / security code」附近的 5 位串
 *   ② 反向锚定：5 位串后面跟着「是您的 / 安全代码」之类
 *   ③ 兜底：全文里**唯一**一个像验证码的 5 位串
 *   ④ 有歧义（多个候选）就返回 null，绝不瞎猜
 *
 * ★ 第 ④ 条是刻意的 ★
 *   猜错验证码的代价是登录失败甚至触发风控，比"没拿到"更糟。
 *   拿不到时上层会回落到人工输入。
 */

/**
 * Steam 验证码使用的字符表 —— 去掉了容易混淆的 0/O/1/I 和全部元音。
 * 这不是硬性要求（邮件码可能更宽），但命中这个字符表说明**非常**可能是真码。
 */
export const STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';

/** 常见的 5 字母英文词，避免把正文里的普通单词当成验证码 */
const STOPWORDS = new Set([
  'STEAM', 'HTTPS', 'HTTP', 'EMAIL', 'REPLY', 'ABOUT', 'PRIVACY', 'TERMS',
  'LOGIN', 'TODAY', 'HELLO', 'THERE', 'PLEASE', 'THANK', 'CLICK', 'HERE',
  'STEAM', 'VALVE', 'ACCOUNT', 'OFFER', 'GAMES', 'STORE', 'SUPPORT',
  'NOREPLY', 'SECURITY', 'NOTICE', 'ISSUES', 'ERROR', 'FIRST', 'NAME',
]);

const isAlnum5 = (s) => /^[A-Z0-9]{5}$/.test(s);
const inSteamAlphabet = (s) => [...s].every((ch) => STEAM_ALPHABET.includes(ch));

/** 像不像一个真验证码 */
export function looksLikeCode(candidate) {
  const c = String(candidate || '').toUpperCase();
  if (!isAlnum5(c)) return false;
  if (STOPWORDS.has(c)) return false;
  // 要么命中 Steam 字符表，要么至少含一个数字
  // （纯字母且不在字符表里的 5 位串更可能是单词）
  return inSteamAlphabet(c) || /[0-9]/.test(c);
}

/* ------------------------------------------------------------------ */

/**
 * 关键词和码之间允许的间隔。
 *
 * ★ 必须能跨换行 ★
 *   Steam 常把码放在下一行：
 *
 *     Steam 令牌验证码：
 *     MNC9P
 *
 *   原先用 [^\n\r]{0,40} 不跨行，这里会全部失效（实测踩过）。
 *   改成 [\s\S]（任意字符，含换行），长度仍然收紧在 40 以内。
 */
const GAP = '[\\s\\S]{0,40}?';

/** ① 关键词在前 */
const RE_KEY_BEFORE = [
  new RegExp(`(?:安全代码|验证码|动态码|一次性代码|代码是|您的代码|你的代码)${GAP}([A-Za-z0-9]{5})(?![A-Za-z0-9])`, 'i'),
  new RegExp(`(?:security\\s*code|access\\s*code|verification\\s*code|login\\s*code|\\bcode\\b)${GAP}([A-Za-z0-9]{5})(?![A-Za-z0-9])`, 'i'),
];

/** ② 关键词在后 */
const RE_KEY_AFTER = [
  /([A-Za-z0-9]{5})[^\n\r]{0,24}?(?:是您的|是您的 Steam|为您的|安全代码|验证码)/i,
  /([A-Za-z0-9]{5})[^\n\r]{0,24}?(?:is your|your Steam|security code|access code)/i,
];

/**
 * ③ 宽松锚定：只出现「代码」两个字。
 * 单看很弱，但精度由 looksLikeCode 兜住，而且排在精确关键词之后，不会抢先命中。
 */
const RE_LOOSE = [
  new RegExp(`(?:代码)${GAP}([A-Za-z0-9]{5})(?![A-Za-z0-9])`, 'i'),
  new RegExp(`(?:code)\\s*[:：]?\\s*${GAP}([A-Za-z0-9]{5})(?![A-Za-z0-9])`, 'i'),
];


/**
 * 从一段文本里抽取 Steam 验证码。
 * @returns {{code: string, confidence: 'high'|'medium', source: string} | null}
 */
export function extractSteamCode(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) return null;

  // ① 关键词在前
  for (const re of RE_KEY_BEFORE) {
    const m = text.match(re);
    if (m && m[1]) {
      const c = m[1].toUpperCase();
      if (looksLikeCode(c)) return { code: c, confidence: 'high', source: '关键词锚定' };
    }
  }

  // ② 关键词在后
  for (const re of RE_KEY_AFTER) {
    const m = text.match(re);
    if (m && m[1]) {
      const c = m[1].toUpperCase();
      if (looksLikeCode(c)) return { code: c, confidence: 'high', source: '关键词锚定（后置）' };
    }
  }

  // ③ 宽松锚定（只靠「代码」二字，精度靠 looksLikeCode）
  for (const re of RE_LOOSE) {
    const m = text.match(re);
    if (m && m[1]) {
      const c = m[1].toUpperCase();
      if (looksLikeCode(c)) return { code: c, confidence: 'medium', source: '宽松关键词' };
    }
  }

  // ④ 兜底：全文里的候选
  const all = [...text.matchAll(/\b([A-Za-z0-9]{5})\b/g)]
    .map((m) => m[1].toUpperCase())
    .filter(looksLikeCode);
  const uniq = [...new Set(all)];

  if (uniq.length === 1) {
    return {
      code: uniq[0],
      confidence: inSteamAlphabet(uniq[0]) ? 'high' : 'medium',
      source: '全文唯一候选',
    };
  }

  // ⑤ 多个候选时，用 Steam 专用字符表来甄别
  //
  //    Steam 验证码只用 23456789BCDFGHJKMNPQRTVWXY（去掉 0/O/1/I 和全部元音）。
  //    邮件正文里常见的干扰项会含这些被排除的字符，例如 XHTML 里的 L。
  //    如果**恰好只有一个**候选完全命中字符表，那就是它。
  if (uniq.length > 1) {
    const strict = uniq.filter(inSteamAlphabet);
    if (strict.length === 1) {
      return { code: strict[0], confidence: 'high', source: '全文唯一（限 Steam 字符表）' };
    }
  }

  // ⑥ 还是分不出来 / 一个都没有 —— 不猜
  return null;
}

/** 只取码本身，拿不到返回 null */
export function pickCode(rawText) {
  return extractSteamCode(rawText)?.code ?? null;
}

/* ------------------------------------------------------------------ */

/**
 * 这封邮件是不是 Steam 发来的。
 *
 * ★ 不能只看域名 ★
 *   邮件经过转发 / 隐私中继后发件人会被改写。实测 iCloud 转发的 Steam 邮件长这样：
 *
 *     Steam 客服 <noreply_at_steampowered_com_sqm20d3fm5yze5_485r9081@icloud.com>
 *
 *   域名变成了 @icloud.com，但用户名里还留着 steampowered 的痕迹。
 *   只认域名的写法会把这类邮件**全部误杀**（实测踩过，验证码邮件被整封过滤掉）。
 *
 * 三层判断，命中任意一层就算：
 *   ① 域名就是 Steam 的
 *   ② 整串里留着 steampowered / steamgames / valvesoftware 的痕迹（被改写的情况）
 *   ③ 显示名写着 Steam（如「Steam 客服 <...>」）
 *
 * 放宽是有意的：这里只是粗筛，真正的把关在 looksLikeCode 那一步。
 * 宁可多放几封进来让它去判别，也不要漏掉真正的验证码邮件。
 */
export function isSteamSender(address) {
  const raw = String(address || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();

  // ① 域名就是 Steam 的
  const at = lower.lastIndexOf('@');
  const domain = at >= 0 ? lower.slice(at + 1).replace(/[>\s].*$/, '') : lower;
  if (/^(?:[a-z0-9-]+\.)*(?:steampowered\.com|steamgames\.com|valvesoftware\.com)$/.test(domain)) {
    return true;
  }

  // ② 被转发/改写过的：整串里还留着 Steam 域名的痕迹
  if (/steampowered|steamgames|valvesoftware/.test(lower)) return true;

  // ③ 显示名写着 Steam
  if (/^"?steam\b/i.test(raw)) return true;
  if (/^"?steam\s*(客服|支持|团队|帳戶|帐户|账户|support|team|account)/i.test(raw)) return true;

  return false;
}

/** 这封邮件像不像"验证码邮件" */
export function looksLikeCodeMail(subject, bodyText, fromAddress) {
  if (!isSteamSender(fromAddress)) return false;
  const hay = `${subject || ''}\n${bodyText || ''}`;
  return /(安全代码|验证码|security code|access code|verification code|steam guard|登录代码)/i.test(hay);
}
