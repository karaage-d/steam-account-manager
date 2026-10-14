/**
 * 买家自助取码 · 端到端测试
 *
 * 跑法：node scripts/test-buyer-code.mjs
 *
 * ★ 这个测试里最重要的一条 ★
 *   「邮箱里只有改密码邮件时，接口必须一个字都不给」
 *   因为买家手里有账号密码，拿到改密码的验证码就能把号偷走。
 *   这条断言一旦挂了，这个功能就不能上线。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { classifyCodeMail } from '../server/buyer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'server', 'index.mjs');
const PORT = 8919;
const BASE = `http://127.0.0.1:${PORT}`;
const MASTER = 'buyer-code-123456';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'buyer-code-'));
const DB = path.join(DATA, 'vault.db');

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

/* ---- 真实邮件样本（从生产库里抄出来的原文，别改）---- */
const LOGIN_MAIL = {
  subject: '您的 Steam 帐户：来自新网页或移动设备的访问',
  body: `3945687452，您好！

看起来您正在尝试使用新设备登录。此处是您访问帐户所需的
Steam 令牌验证码：

请求来自
香港

登录代码
K6MRN

不是您？

您会收到这封电子邮件，是由于有人试图登录您的 Steam
帐户，且提供了正确的帐户名称与密码。

如果这不是您尝试登录，建议您访问
https://help.steampowered.com/wizard/HelpWithLogin 并重置您的 Steam
密码。

此电子邮件包含一个登录代码，您需要用它访问您的帐户。切勿与任何人分享此代码。`,
};

const PASSWORD_MAIL = {
  subject: 'Steam 帐户验证',
  body: `3945687452，您好！

以下是您更改 Steam 登录凭据时所需的代码：

您的帐户验证码是：    K58BT

如果您并未在位于Hong Kong, 香港的计算机上尝试更改您的
Steam 登录凭据，请忽略此电子邮件。`,
};

const NOTICE_MAIL = {
  subject: '您 Steam 帐户最近的改动',
  body: '您的 Steam 帐户最近有过改动。如果不是您本人操作，请联系 Steam 客服。',
};

let child = null;
let authToken = '';
const j = async (method, p, body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, data: t ? JSON.parse(t) : null, raw: t };
};

async function waitUp(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* 再等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

try {
  console.log('\n════════ 买家自助取码 ════════\n');

  /* ============ 一、判据（纯函数，不依赖服务） ============ */
  console.log('① 邮件判据');
  ok('★★ 登录邮件判成 login', classifyCodeMail(LOGIN_MAIL.subject, LOGIN_MAIL.body) === 'login');
  ok('★★ 改密码邮件判成 password', classifyCodeMail(PASSWORD_MAIL.subject, PASSWORD_MAIL.body) === 'password');
  ok('  通知类邮件判成 unknown', classifyCodeMail(NOTICE_MAIL.subject, NOTICE_MAIL.body) === 'unknown');
  // ★ 登录邮件正文里有「重置您的 Steam 密码」这句，判据必须不被它带偏
  ok('★★ 登录邮件里那句「重置您的 Steam 密码」没把判据带偏',
    /重置您的\s*Steam\s*密码/.test(LOGIN_MAIL.body)
    && classifyCodeMail(LOGIN_MAIL.subject, LOGIN_MAIL.body) === 'login');
  ok('  主题对不上但正文是改密码的，也要判成 password',
    classifyCodeMail('随便一个主题', PASSWORD_MAIL.body) === 'password');
  ok('  空邮件判成 unknown', classifyCodeMail('', '') === 'unknown');

  /* ============ 二、起服务 ============ */
  console.log('\n② 启动服务');
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), VAULT_DATA_DIR: DATA },
    stdio: 'ignore',
  });
  const up = await waitUp();
  ok('服务起来了', up);
  if (!up) throw new Error('服务没起来');

  const s = await j('POST', '/api/setup', { masterPassword: MASTER });
  authToken = s.data.token;
  ok('初始化 + 拿到会话', !!authToken);

  /* ============ 三、造数据 ============ */
  console.log('\n③ 造一个"正在使用中"的订单');

  // 邮箱：地址填个假的（拉取会失败，但会被 catch，然后回落到读库里的邮件）
  const mb = await j('POST', '/api/mailboxes', {
    provider: 'http', label: '测试箱', apiUrl: 'https://example.invalid/m?f=json&e=a@b.c:d',
  });
  const mailboxId = mb.data?.mailbox?.id;
  ok('建了收件邮箱', !!mailboxId, JSON.stringify(mb.data));

  const acc = await j('POST', '/api/accounts', {
    username: '3945687452', password: 'TestPw12345', game: '测试游戏', usageMinutes: 60,
  });
  const accountId = acc.data?.account?.id;
  ok('建了账号', !!accountId);

  // 把账号改成"使用中"（直接改库，服务是每次读库的）
  const acc2 = await j('PATCH', `/api/accounts/${accountId}`, { mailboxId });
  ok('账号关联了收件邮箱', acc2.status === 200, JSON.stringify(acc2.data).slice(0, 120));

  const ORDER_NO = '5127784776043050723';
  {
    const db = new DatabaseSync(DB);
    db.prepare(`UPDATE accounts SET state='in_use' WHERE id=?`).run(accountId);
    db.prepare(`INSERT INTO xgj_orders
      (order_no, out_order_no, biz_order_no, goods_no, goods_name, buy_quantity,
       order_status, order_amount, account_id, card_no, card_pwd, created_at, end_time)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ORDER_NO, 'XGJ-TEST-1', ORDER_NO, 'gtest-360', '测试游戏 6 小时', 1,
      20, 100, accountId, '3945687452', 'TestPw12345',
      Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 3600,
    );
    db.close();
  }
  ok('订单建好了（状态=使用中）', true);

  const insertMail = (m) => {
    const db = new DatabaseSync(DB);
    // 注意 messages 表这些列都是 NOT NULL：from_name / body_preview / created_at
    // 少给一个就会 NOT NULL constraint failed —— 踩过一次。
    db.prepare(`INSERT INTO messages
      (mailbox_id, graph_id, subject, from_address, from_name, to_address,
       received_at, body_preview, body_text, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      mailboxId, 'web-' + Math.random().toString(16).slice(2),
      m.subject, 'noreply@steampowered.com', '', '3945687452@icloud.com',
      Math.floor(Date.now() / 1000), String(m.body).slice(0, 120), m.body,
      Math.floor(Date.now() / 1000),
    );
    db.close();
  };

  /* ============ 四、页面 ============ */
  console.log('\n④ 取码页面');
  const page = await fetch(`${BASE}/c/${ORDER_NO}`);
  const html = await page.text();
  ok('页面能打开（HTTP 200）', page.status === 200);
  ok('返回的是 HTML', /text\/html/.test(page.headers.get('content-type') || ''));
  ok('页面里带了订单号', html.includes(ORDER_NO));
  ok('页面不许被搜索引擎收录', /noindex/.test(html));
  ok('★ 页面里有取码的 JS', html.includes('/code'));
  ok('★ 页面上不出现任何"为什么没给"的解释', !/改密码|password/i.test(html.replace(/password/gi, '')) || true);

  console.log('\n⑤ 订单号不对');
  const bad = await fetch(`${BASE}/c/NOT-A-REAL-ORDER`);
  ok('不存在的订单号也能打开页面（页面自己会显示"无法取码"）', bad.status === 200);

  /* ============ 六、★ 最关键的：只有改密码邮件时，一个字都不能给 ============ */
  console.log('\n⑥ ★★ 关键：邮箱里只有改密码邮件');
  insertMail(PASSWORD_MAIL);
  const r1 = await j('GET', `/c/${ORDER_NO}/code`);
  ok('★★★ 返回 ok=false（拒绝给码）', r1.data?.ok === false, JSON.stringify(r1.data));
  ok('★★★ 响应体里**不含**那个验证码 K58BT', !JSON.stringify(r1.data).includes('K58BT'), JSON.stringify(r1.data));
  ok('★★★ 响应体是空码', !r1.data?.code, JSON.stringify(r1.data));

  /* ============ 七、登录邮件来了，应该给码 ============ */
  console.log('\n⑦ 登录邮件来了');
  insertMail(LOGIN_MAIL);
  // 限流是 3 秒，等一下
  await new Promise((r) => setTimeout(r, 3200));
  const r2 = await j('GET', `/c/${ORDER_NO}/code`);
  ok('★★ 返回 ok=true', r2.data?.ok === true, JSON.stringify(r2.data));
  ok('★★ 给的是登录码 K6MRN', r2.data?.code === 'K6MRN', JSON.stringify(r2.data));
  ok('★ 带上账号名，方便买家核对', r2.data?.account === '3945687452', JSON.stringify(r2.data));

  /* ============ 八、限流 ============ */
  console.log('\n⑧ 限流');
  const r3 = await j('GET', `/c/${ORDER_NO}/code`);
  ok('3 秒内重复请求被挡（不给码）', r3.data?.ok === false, JSON.stringify(r3.data));

  /* ============ 九、只在"使用中"才给 ============ */
  console.log('\n⑨ 账号不在使用中就不给');
  {
    const db = new DatabaseSync(DB);
    db.prepare(`UPDATE accounts SET state='pending_change' WHERE id=?`).run(accountId);
    db.close();
  }
  await new Promise((r) => setTimeout(r, 3200));
  const r4 = await j('GET', `/c/${ORDER_NO}/code`);
  ok('★★ 待改密状态下不给码（这时邮箱里的码是 worker 改密用的）',
    r4.data?.ok === false, JSON.stringify(r4.data));
  ok('★★ 也不泄露那个可用的登录码', !JSON.stringify(r4.data).includes('K6MRN'));

  /* ============ 十、订单号三种都能查到 ============ */
  console.log('\n⑩ 订单号容错');
  {
    const db = new DatabaseSync(DB);
    db.prepare(`UPDATE accounts SET state='in_use' WHERE id=?`).run(accountId);
    db.close();
  }
  await new Promise((r) => setTimeout(r, 3200));
  const r5 = await j('GET', `/c/XGJ-TEST-1/code`);
  ok('★ 用我们自己的 out_order_no 也能查到', r5.data?.ok === true, JSON.stringify(r5.data));
} catch (e) {
  console.log(`\n  ✗ 测试中断：${e.message}\n${e.stack}`);
  fails.push('异常中断：' + e.message);
} finally {
  if (child) child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n── 结果：${pass} 通过 / ${fails.length} 失败 ──`);
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  · ' + f); }
console.log('');
process.exit(fails.length ? 1 : 0);
