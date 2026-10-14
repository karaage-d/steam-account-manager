/**
 * ★ 买家自助取码 ★
 *
 * 场景：
 *   买家租了账号，在 Steam 上登录时 Steam 发验证码到账号绑定的邮箱。
 *   买家拿不到邮箱 —— 所以让他通过一个链接来取这个码。
 *
 *   https://<隧道地址>/c/5127784776043050723
 *                         └── 闲管家订单号
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★ 这个文件里最要紧的一件事：**绝不能把改密码的码发出去** ★★
 * ══════════════════════════════════════════════════════════════════
 *   买家手里**有账号密码**。如果他拿到"更改登录凭据"的验证码，
 *   他就能把密码改掉，把号直接偷走。
 *
 *   所以判据是**白名单**，不是黑名单：
 *     ① 主题和正文都得命中"这是登录码"的明确特征
 *     ② 命中任何"这是改密码码"的特征就一票否决
 *     ③ 两边都说不清 → 不发（返回"暂时没有"）
 *
 *   失败的方向必须是"不给"，绝不能是"给错"。
 *
 * ⚠️ 踩过的坑：
 *   登录邮件的结尾有一句「如果这不是您尝试登录，建议您访问 … 并**重置您的 Steam 密码**」——
 *   拿"重置密码"当改密码特征的话，**正常的登录邮件会被自己拦掉**。
 *   所以特征词必须取自各自**独有的那几句**（见下面两个正则的注释）。
 */

/* ------------------------------------------------------------------ */
/* 一、判断这封邮件是哪种码                                            */
/* ------------------------------------------------------------------ */

/**
 * ★ 改密码邮件的独有特征 ★
 *
 * 真实样本（2026-10-11 21:40:30）：
 *   主题：Steam 帐户验证
 *   正文：以下是您更改 Steam 登录凭据时所需的代码：
 *         您的帐户验证码是：    K58BT
 *         如果您并未在位于Hong Kong, 香港的计算机上尝试更改您的 Steam 登录凭据，请忽略此电子邮件。
 *
 * 注意**不能**把下面这些当特征，它们会误伤登录邮件：
 *   ✗ 「重置您的 Steam 密码」—— 登录邮件结尾也有这句
 *   ✗ 「帐户验证码」—— 太泛
 */
const PASSWORD_MAIL = new RegExp([
  '更改\\s*Steam\\s*登录凭据',      // 正文核心句，最准
  '更改您的\\s*Steam\\s*登录凭据',
  '以下是您更改',                    // 「以下是您更改 Steam 登录凭据时所需的代码」
  'AccountRecoveryCode',             // 邮件里那个查看链接的参数名
  '重置您的\\s*Steam\\s*(帐户|账户)密码',  // 真正的重置流程（不是登录邮件里那句建议）
].join('|'), 'i');

/**
 * ★ 登录邮件的独有特征 ★
 *
 * 真实样本（2026-10-11 21:37:56）：
 *   主题：您的 Steam 帐户：来自新网页或移动设备的访问
 *   正文：看起来您正在尝试使用新设备登录。此处是您访问帐户所需的
 *         Steam 令牌验证码：
 *         请求来自 香港
 *         登录代码
 *         K6MRN
 *         此电子邮件包含一个登录代码，您需要用它访问您的帐户。
 */
const LOGIN_MAIL = new RegExp([
  '来自新网页或移动设备的访问',      // 主题，最准
  '正在尝试使用新设备登录',          // 正文第一句
  '访问帐户所需的',                  // 「此处是您访问帐户所需的 Steam 令牌验证码」
  '此电子邮件包含一个登录代码',
].join('|'), 'i');

/**
 * 这封邮件里的码，属于哪种用途？
 *
 * @returns {'login' | 'password' | 'unknown'}
 *
 * ★ 判断顺序不能反 ★
 *   改密码的特征先查 —— 万一 Steam 某天把两边的句子混在一起，
 *   宁可判成 password（不发），也不能判成 login（发出去）。
 *   顺序反了就等于给了买家一把偷号的钥匙。
 */
export function classifyCodeMail(subject, body) {
  const text = `${subject || ''}\n${body || ''}`;
  if (PASSWORD_MAIL.test(text)) return 'password';
  if (LOGIN_MAIL.test(text)) return 'login';
  return 'unknown';
}

/* ------------------------------------------------------------------ */
/* 二、取码                                                            */
/* ------------------------------------------------------------------ */

/** 只认最近这段时间内的邮件 —— 太旧的多半是上一单留下的 */
export const CODE_FRESH_SEC = 10 * 60;

/**
 * 给买家查一次登录验证码。
 *
 * @param {object} deps
 * @param {object} deps.store   账号管理器 store
 * @param {object} deps.mail    邮件服务（mail.mjs 那个实例）
 * @param {string} deps.orderNo 买家链接里的订单号
 * @param {number} deps.now     当前秒级时间戳
 * @returns {Promise<{ok:boolean, code?:string, account?:string, why?:string, at?:number}>}
 *
 * ★ why 只用于服务端日志 ★
 *   返回给买家的页面**只显示"有"或"没有"**，绝不解释原因 ——
 *   解释就等于告诉他"我们看到了改密码邮件"，等于指路。
 */
export async function fetchLoginCode({ store, mail, orderNo, now = Math.floor(Date.now() / 1000) }) {
  const n = String(orderNo || '').trim();
  if (!n) return { ok: false, why: 'no_order' };

  // ① 用订单号找订单。
  //    闲管家的订单号 / 闲鱼订单号 / 我们生成的号，三种都试 ——
  //    因为内容模板里 {$订单编号} 到底是哪一个，只能靠实测，
  //    三种都认就不怕它给的是哪个。
  const order = (typeof store.findXgjOrderAny === 'function'
    ? store.findXgjOrderAny(n)
    : store.findXgjOrder(n));
  if (!order) return { ok: false, why: 'order_not_found' };

  // ② 订单必须对应到一个账号
  const accountId = order.account_id;
  if (!accountId) return { ok: false, why: 'no_account' };

  const account = store.getAccount(accountId);
  if (!account) return { ok: false, why: 'account_missing' };

  // ③ ★ 只在使用中才给码 ★
  //    待改密 / 可用 阶段，邮箱里出现的码几乎都是 worker 改密用的，
  //    这时候把码发出去 = 把改密码的钥匙交给买家。
  if (account.state !== 'in_use') return { ok: false, why: `state_${account.state}` };

  // ④ 账号得绑定收件邮箱，否则无从查起
  const box = store.getAccountMailbox(accountId);
  if (!box) return { ok: false, why: 'no_mailbox' };

  // ⑤ 先拉一次新邮件（服务端那只在真的登录时才会有新邮件）
  try {
    if (mail && typeof mail.fetch === 'function') {
      await mail.fetch(box.id, { silent: true });
    }
  } catch {
    // 拉取失败不致命 —— 库里可能已经有那封了，继续往下查
  }

  // ⑥ 查最近这段时间的邮件，找第一封"确认是登录码"的
  const since = now - CODE_FRESH_SEC;
  let rows = [];
  try {
    rows = store.listMessagesSince(box.id, { since, limit: 30 }) || [];
  } catch {
    rows = [];
  }

  let sawPassword = false;
  for (const m of rows) {
    const kind = classifyCodeMail(m.subject, m.bodyText || m.body || '');
    if (kind === 'password') { sawPassword = true; continue; }

    // ★ 只认 login ★
    //   unknown 一律跳过 —— 文案变了、没见过的邮件，宁可让买家多点一次刷新，
    //   也不能赌。判断不出来就是不发。
    if (kind !== 'login') continue;

    const code = extractCodeFrom(m);
    if (!code) continue;

    return {
      ok: true,
      code,
      account: account.username,
      at: m.receivedAt || m.received_at || 0,
    };
  }

  // 没有任何一封通过白名单
  return { ok: false, why: sawPassword ? 'only_password_mail' : 'no_login_mail_yet' };
}

/**
 * 从一封邮件里抠出 Steam 验证码。
 *
 * 只认 Steam 那套字母表：23456789BCDFGHJKMNPQRTVWXY（没有 A/0/1/I/O）。
 * 和 worker 用同一套规则，免得两边抠出来的东西不一样。
 */
export function extractCodeFrom(msg) {
  const body = String(msg?.bodyText || msg?.body || '');
  // 优先取「登录代码」/「验证码是」这类标签后面那一串
  const labelled = body.match(/(?:登录代码|验证码是|令牌验证码)\s*[:：]?\s*([2-9BCDFGHJKMNPQRTVWXY]{5})\b/i);
  if (labelled) return labelled[1].toUpperCase();
  // 退一步：全文找 5 位、只含 Steam 字母表的词
  const loose = body.match(/\b([2-9BCDFGHJKMNPQRTVWXY]{5})\b/);
  return loose ? loose[1].toUpperCase() : '';
}

/* ------------------------------------------------------------------ */
/* 三、买家看到的页面                                                  */
/* ------------------------------------------------------------------ */

/**
 * 取码页面。
 *
 * ★ 为什么服务端直出 HTML，不放进 Vue 那一套 ★
 *   这个页面是给**买家**看的 —— 他没登录、没会话，
 *   而且是在闲鱼内置浏览器 / 微信 / 手机浏览器里打开。
 *   服务端直出一张自包含的静态页面最稳：不依赖前端构建、不依赖 JS 框架、
 *   也不用改 vite 的入口。整页就几 KB。
 *
 * ★ 页面上绝不出现解释 ★
 *   查不到就只说"暂时没有验证码"，不写"因为检测到这是改密码邮件" ——
 *   那种话等于告诉买家怎么绕。
 */
export function renderCodePage(orderNo, opts = {}) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const title = opts.title || 'Steam 登录验证码';
  const safeOrder = esc(orderNo);

  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<style>
  :root{
    --bg:#f2f2f7; --card:#fff; --text:#1c1c1e; --text2:#6e6e73;
    --accent:#0a84ff; --ok:#30d158; --line:rgba(60,60,67,.14);
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#000; --card:#1c1c1e; --text:#f5f5f7; --text2:#98989d;
           --line:rgba(255,255,255,.13); }
  }
  *{ box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body{
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    padding:20px; background:var(--bg); color:var(--text);
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  }
  .card{
    width:100%; max-width:420px; background:var(--card); border-radius:20px;
    padding:28px 22px 22px; text-align:center;
    box-shadow:0 12px 40px rgba(0,0,0,.13);
  }
  h1{ margin:0 0 4px; font-size:19px; font-weight:640; letter-spacing:-.2px; }
  .sub{ color:var(--text2); font-size:13px; margin-bottom:20px; }
  .code{
    font:700 46px/1.15 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    letter-spacing:.14em; padding:20px 8px 18px; margin:0 0 6px;
    color:var(--ok); word-break:break-all;
  }
  .hint{ color:var(--text2); font-size:13px; min-height:20px; }
  .none{ padding:34px 6px 30px; color:var(--text2); font-size:15px; line-height:1.7; }
  .none strong{ color:var(--text); display:block; margin-bottom:8px; font-size:17px; }
  button{
    width:100%; margin-top:20px; padding:14px; border:0; border-radius:13px;
    background:var(--accent); color:#fff; font-size:16px; font-weight:600;
    font-family:inherit; cursor:pointer;
  }
  button:active{ opacity:.75; }
  .foot{ margin-top:16px; padding-top:14px; border-top:1px solid var(--line);
         color:var(--text2); font-size:11.5px; line-height:1.6; }
  .order{ font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; opacity:.7; }
</style>
<body>
<div class="card">
  <h1>Steam 登录验证码</h1>
  <div class="sub" id="sub">正在查询…</div>
  <div id="body"><div class="none">正在查询，请稍等…</div></div>
  <button id="refresh" hidden>没收到？点这里刷新</button>
  <div class="foot">
    此验证码<strong>仅用于本次登录</strong>。<br>
    不要把它发给任何人。
    <div class="order">订单 ${safeOrder}</div>
  </div>
</div>
<script>
(function(){
  var ORDER = ${JSON.stringify(orderNo)};
  var body = document.getElementById('body');
  var sub = document.getElementById('sub');
  var btn = document.getElementById('refresh');
  var timer = null;

  function render(d){
    if (d && d.code){
      body.innerHTML = '<div class="code">' + d.code.replace(/[&<>"]/g,'') + '</div>'
        + '<div class="hint">请在 Steam 里填入这个验证码</div>';
      // 每 30 秒自动重新拉一次：码快过期、或买家又触发了一封新邮件时能跟上
      clearTimeout(timer);
      timer = setTimeout(load, 30000);
      btn.hidden = false;
      sub.textContent = '已验证';
    } else {
      body.innerHTML = '<div class="none"><strong>暂时没有验证码</strong>'
        + '请先在 Steam 上点击登录，等它提示需要验证码，<br>再回来点下面的按钮刷新。</div>';
      sub.textContent = '等待中';
      btn.hidden = false;
      clearTimeout(timer);
    }
  }

  function load(){
    sub.textContent = '正在查询…';
    fetch('/c/' + encodeURIComponent(ORDER) + '/code', { cache:'no-store' })
      .then(function(r){ return r.json(); })
      .then(render)
      .catch(function(){
        sub.textContent = '查询失败';
        body.innerHTML = '<div class="none"><strong>网络不太好</strong>请稍后再试</div>';
        btn.hidden = false;
      });
  }

  btn.addEventListener('click', function(){ btn.hidden = true; load(); });
  load();
})();
</script>`;
}

/* ------------------------------------------------------------------ */
/* 四、买家看得懂的错误页                                              */
/* ------------------------------------------------------------------ */

export function renderErrorPage(reason) {
  const msg = reason === 'order_not_found'
    ? '订单号不对，或者链接不完整。<br>请从发货消息里点开这条链接。'
    : '这个订单已经结束或者暂时不可用。';
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>无法取码</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  padding:20px;background:#f2f2f7;color:#1c1c1e;
  font:16px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',system-ui,sans-serif">
<div style="max-width:400px;background:#fff;border-radius:20px;padding:28px 22px;text-align:center;
  box-shadow:0 12px 40px rgba(0,0,0,.13)">
  <div style="font-size:19px;font-weight:640;margin-bottom:10px">无法取码</div>
  <div style="color:#6e6e73;font-size:15px">${msg}</div>
</div></body></html>`;
}
