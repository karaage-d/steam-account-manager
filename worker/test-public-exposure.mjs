/**
 * ★ 安全测试：陌生人拿到公网地址，能不能直接看到账号库？★
 *
 * 背景：服务当前 unlocked=true。如果前端把"服务端已解锁"当成"我也解锁了"，
 * 那么任何人打开这个公网地址都会直接看到全部账号密码 —— 那就是严重泄露。
 *
 * 这个测试用一个**全新的、没有任何 cookie/sessionStorage 的浏览器**去访问公网地址，
 * 看它到底是停在锁屏，还是直接进了账号库。
 *
 * 用法：node test-public-exposure.mjs <公网地址>
 */
import { chromium } from 'playwright-core';

const URL = process.argv[2] || 'http://127.0.0.1:8787';

let pass = 0; const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name} — ${extra}`); console.log(`  ✗ ${name} — ${extra}`); }
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
// ★ 全新 context：没有 cookie、没有 localStorage/sessionStorage ★
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();

console.log(`目标: ${URL}\n`);

await page.goto(URL, { waitUntil: 'networkidle', timeout: 40000 });
await page.waitForTimeout(3000);

const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
console.log('--- 陌生人看到的页面（前 400 字）---');
console.log(bodyText.slice(0, 400));
console.log('--- 结束 ---\n');

// 1) 有没有密码输入框 → 说明停在锁屏
const pwInputs = await page.locator('input[type=password]').count();
ok('★★★ 陌生浏览器看到的是锁屏，不是账号库', pwInputs > 0,
  `密码输入框数量=${pwInputs}`);

// 2) 页面里有没有泄露账号/密码特征
const leaks = [];
if (/账号[:：]\s*\n?\s*\d{6,}/.test(bodyText)) leaks.push('看起来有账号列表');
if (/密码[:：]/.test(bodyText)) leaks.push('出现了「密码：」');
if (/3945687452|3945687453/.test(bodyText)) leaks.push('出现了真实账号名');
if (/Fxvxtbmx|lYxZdDu/.test(bodyText)) leaks.push('出现了真实密码');
ok('★★★ 页面上没有任何账号/密码泄露', leaks.length === 0, leaks.join('；'));

// 3) 直接打接口：没有 token 能不能拿到数据
const probes = [
  ['GET', '/api/board'],
  ['GET', '/api/accounts'],
  ['GET', '/api/stats'],
  ['GET', '/api/accounts/export?format=json'],
  ['GET', '/api/mailboxes'],
  ['GET', '/api/settings'],
];
console.log('--- 无令牌直接请求受保护的接口 ---');
for (const [method, path] of probes) {
  let status = 0; let leaked = false;
  try {
    const r = await page.evaluate(async ({ u, m, p }) => {
      const res = await fetch(u + p, { method: m });
      const t = await res.text();
      return { status: res.status, len: t.length, head: t.slice(0, 90) };
    }, { u: URL, m: method, p: path });
    status = r.status;
    leaked = r.status === 200 && r.len > 200;
    console.log(`  ${String(status).padEnd(4)} ${path.padEnd(38)} ${r.len} 字节  ${r.head.replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`  ERR  ${path}  ${e.message.split('\n')[0]}`);
  }
  ok(`  ${path} 拒绝了无令牌访问`, status === 401 || status === 403, `status=${status}`);
}

// 4) 自动化接口：没有 API Key 能不能调
console.log('\n--- 无 API Key 直接请求自动化接口 ---');
for (const path of ['/api/automation/available', '/api/automation/claim?game=CS2',
  '/api/automation/accounts/1/credential', '/api/automation/tasks?status=pending']) {
  let status = 0;
  try {
    const r = await page.evaluate(async ({ u, p }) => {
      const res = await fetch(u + p);
      const t = await res.text();
      return { status: res.status, len: t.length };
    }, { u: URL, p: path });
    status = r.status;
    console.log(`  ${String(status).padEnd(4)} ${path}   ${r.len} 字节`);
  } catch (e) {
    console.log(`  ERR  ${path}  ${e.message.split('\n')[0]}`);
  }
  ok(`  ${path} 拒绝了无密钥访问`, status === 401 || status === 403, `status=${status}`);
}

console.log(`\n── 结果：${pass} 通过 / ${fails.length} 失败 ──`);
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  · ' + f); }

await browser.close();
process.exit(fails.length ? 1 : 0);
