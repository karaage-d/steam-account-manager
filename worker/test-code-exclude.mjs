/**
 * ★ 端到端验证「排除用过的验证码」★
 *
 * 复现真机上那个 bug：
 *   第二次要验证码时 Steam 的新邮件还没到，
 *   邮箱里"最新的一封"仍然是第一封 → 服务端把同一个旧码又返回去。
 *   日志里表现为「第 2 次取到验证码：HPQ9T」「第 3 次取到验证码：HPQ9T」。
 *
 * 这个测试自己起：
 *   · 一个假邮件接口（wdmail 那种 JSON 格式），可以随时往里塞新邮件
 *   · 一个账号管理器（用临时数据库）
 * 然后验证：
 *   ① 第一次取码 → 拿到第一封邮件的码
 *   ② 带上 exclude=第一封的码再取 → **不能**又返回它（新邮件还没来）
 *   ③ 塞进第二封邮件（新码）→ 再取 → 必须拿到新码
 *
 * 用法：node test-code-exclude.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0; const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name} — ${extra}`); console.log(`  ✗ ${name} — ${extra}`); }
};

/* ---------------- 假邮件接口 ---------------- */
const MAIL_PORT = 8961;
/** 邮箱里现在有哪些邮件（测试过程中往里加） */
let inbox = [];

const mailSrv = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MAIL_PORT}`);
  const to = url.searchParams.get('e') || 'x@x.com:pw';
  const addr = to.split(':')[0];
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    code: 0,
    data: {
      recipient: addr,
      mail_query_hours: 24,
      messages: inbox,
    },
  }));
});
await new Promise((r) => mailSrv.listen(MAIL_PORT, '127.0.0.1', r));

function makeMail(code, minutesAgo) {
  const t = new Date(Date.now() - minutesAgo * 60000).toISOString();
  return {
    id: `msg-${code}`,
    recipient: 'steam_box@icloud.com',
    sender: 'Steam 客服 <noreply_at_steampowered_com_abc123@icloud.com>',
    subject: '您的 Steam 帐户：来自新网页或移动设备的访问',
    received_at: t,
    text_body: `3945687452，您好！\n\n看起来您正在尝试使用新设备登录。此处是您访问帐户所需的\nSteam 令牌验证码：\n\n请求来自\n香港\n\n登录代码\n${code}\n\n\n不是您？`,
  };
}

/* ---------------- 账号管理器 ---------------- */
const APP_PORT = 8962;
const DATA = path.join(os.tmpdir(), 'code-exclude-test');
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const app = spawn('D:\\node.exe', [path.join(ROOT, 'server', 'index.mjs')], {
  env: { ...process.env, PORT: String(APP_PORT), VAULT_DATA_DIR: DATA },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 3000));

const BASE = `http://127.0.0.1:${APP_PORT}`;
const j = async (m, p, b, tok, key) => {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = `Bearer ${tok}`;
  if (key) h['X-API-Key'] = key;
  const r = await fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: { raw: t } }; }
};

const s = await j('POST', '/api/setup', { masterPassword: 'excl-123456' });
const tok = s.data.token; const key = s.data.apiKey;

// 建邮箱：取件接口指向假邮件服务
const mb = await j('POST', '/api/mailboxes', {
  provider: 'http',
  apiUrl: `http://127.0.0.1:${MAIL_PORT}/m?f=json&e=steam_box@icloud.com:pw`,
}, tok);
ok('  建好了取件接口邮箱', mb.status === 200 && mb.data.mailbox?.address === 'steam_box@icloud.com',
  JSON.stringify(mb.data).slice(0, 160));
const boxId = mb.data.mailbox?.id;
const mb2 = await j('PATCH', `/api/mailboxes/${boxId}`, { status: 'ok' }, tok);
void mb2;
// 邮箱地址要能被识别成"官方来信"，所以直接建账号并关联
const acc = await j('POST', '/api/accounts', {
  username: 'excl_acc', password: 'Excl123', game: '链在一起', usageMinutes: 60,
  email: 'steam_box@icloud.com', mailboxId: boxId,
}, tok);
const accId = acc.data.account?.id;
ok('  账号已关联这个邮箱', !!accId && acc.data.account.mailboxId === boxId,
  JSON.stringify({ id: accId, mb: acc.data.account?.mailboxId }));

const fetchCode = (qs = '') => j('GET',
  `/api/automation/accounts/${accId}/code?wait=2${qs}`, null, null, key);

/* ---------------- 开始验证 ---------------- */

console.log('\n① 第一封邮件到了');
inbox = [makeMail('K4F7B', 1)];
const r1 = await fetchCode();
ok('★★ 第一次取码拿到 K4F7B', r1.data.code === 'K4F7B',
  JSON.stringify({ code: r1.data.code, reason: r1.data.reason }));

console.log('\n② 第二封还没到，带上 exclude 再取');
const r2 = await fetchCode('&exclude=K4F7B');
ok('★★★ 不能又把旧码 K4F7B 返回回来', r2.data.code !== 'K4F7B',
  `又返回了 ${r2.data.code}（这正是真机上那个 bug）`);
ok('  并且如实说明"只找到用过的旧码"', r2.data.reason === 'all_seen',
  `reason=${r2.data.reason}`);

console.log('\n③ 第二封邮件到了（新码 MNC9P）');
inbox = [makeMail('MNC9P', 0), makeMail('K4F7B', 2)];
const r3 = await fetchCode('&exclude=K4F7B');
ok('★★★ 排除旧码后，拿到了新码 MNC9P', r3.data.code === 'MNC9P',
  JSON.stringify({ code: r3.data.code, reason: r3.data.reason }));

console.log('\n④ 两个码都排除掉 → 应该等不到');
inbox = [makeMail('MNC9P', 0), makeMail('K4F7B', 2)];
const r4 = await fetchCode('&exclude=K4F7B,MNC9P');
ok('★★ 排除全部用过的码后，不再返回任何一个',
  r4.data.code !== 'K4F7B' && r4.data.code !== 'MNC9P',
  `返回了 ${r4.data.code}`);

console.log('\n⑤ 不带 exclude 时应该照旧返回最新的');
const r5 = await fetchCode();
ok('  不带 exclude 仍然返回最新那个（MNC9P）', r5.data.code === 'MNC9P', String(r5.data.code));

app.kill();
mailSrv.close();
await new Promise((r) => setTimeout(r, 700));
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n── 结果：${pass} 通过 / ${fails.length} 失败 ──`);
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  · ' + f); }
process.exit(fails.length ? 1 : 0);
