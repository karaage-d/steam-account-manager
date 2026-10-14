/**
 * 验证 API 面板：能不能打开、内容全不全、在线试用按钮真的能领到号。
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(process.cwd(), '..');
const PORT = 8982;
const DATA = path.join(os.tmpdir(), 'api-panel-check');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const srv = spawn('D:\\node.exe', [path.join(ROOT, 'server', 'index.mjs')], {
  env: { ...process.env, PORT: String(PORT), VAULT_DATA_DIR: DATA },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 3000));

const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ locale: 'zh-CN' })).newPage();

let pass = 0; const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name} — ${extra}`); console.log(`  ✗ ${name} — ${extra}`); }
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(async (base) => {
  await fetch(base + '/api/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterPassword: 'panel-123456' }),
  });
}, BASE).catch(() => {});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// 用接口建一个 CS2 账号，供在线试用
// ★ 注意：/api/accounts 要的是**会话令牌**，不是 API Key ★
const unlock = await page.evaluate(async (base) => {
  const r = await fetch(base + '/api/unlock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterPassword: 'panel-123456' }),
  });
  return r.json();
}, BASE);
const apiKey = unlock.apiKey;
const sessionToken = unlock.token;
const made = await page.evaluate(async ({ base, tok }) => {
  const r = await fetch(base + '/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ username: 'panel_cs2', password: 'Test1234', game: 'CS2', usageMinutes: 5 }),
  });
  return { status: r.status, body: await r.text() };
}, { base: BASE, tok: sessionToken }).catch((e) => ({ status: 0, body: String(e.message) }));
console.log('建账号结果:', made.status, made.body.slice(0, 120));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const pw = page.locator('input[type=password]').first();
if (await pw.count().catch(() => 0)) {
  await pw.fill('panel-123456');
  const btn = page.locator('button', { hasText: /解锁|进入/ }).first();
  if (await btn.count().catch(() => 0)) await btn.click();
  await page.waitForTimeout(2500);
}

// 打开「…」菜单 → API 接口
await page.locator('.topbar button').last().click();
await page.waitForTimeout(500);
const apiItem = page.locator('.menu button', { hasText: 'API 接口' }).first();
ok('★ 菜单里有「API 接口」入口', (await apiItem.count()) > 0);
if (await apiItem.count()) {
  await apiItem.click();
  await page.waitForTimeout(900);
}

const sheet = page.locator('.sheet.api');
ok('★★★ API 面板能打开', (await sheet.count()) > 0);
const txt = await sheet.first().innerText().catch(() => '');
console.log('\n--- 面板内容 ---');
console.log(txt.split('\n').filter(Boolean).slice(0, 40).join('\n'));
console.log('--- 内容结束 ---\n');

ok('  显示了接口地址', txt.includes(BASE));
ok('★ 显示了完整的 API Key（不是截断的）', txt.includes(apiKey.slice(0, 16)), `key 前段=${apiKey.slice(0, 10)}`);
ok('  有查询输入框', (await sheet.locator('input.input').count()) > 0);
ok('  有「查一下」按钮', (await page.locator('.sheet.api button', { hasText: '查一下' }).count()) > 0);
ok('  有调用示例（curl/JS/Python/返回格式）', txt.includes('curl') && txt.includes('JavaScript') && txt.includes('Python'));
ok('  列出了全部自动化接口', txt.includes('/api/automation/available') && txt.includes('/api/automation/tasks'));

const inUseNow = () => page.evaluate(async ({ base, tok }) => {
  const r = await fetch(base + '/api/accounts?state=in_use', {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const d = await r.json();
  return (d.items || []).map((a) => a.username);
}, { base: BASE, tok: sessionToken });

/* ---------------------------------------------------------------- */
/* ★★★ 最关键：搜索不能改变状态 ★★★                                  */
/* ---------------------------------------------------------------- */

// 输入游戏名 + 敲回车（用户的自然习惯）—— 必须是"查"，不是"领"
await sheet.locator('input.input').first().fill('CS2');
await sheet.locator('input.input').first().press('Enter');
await page.waitForTimeout(1800);

const afterEnter = await inUseNow();
ok('★★★ 输入游戏名敲回车 → 只是查询，账号没有被领走',
  !afterEnter.includes('panel_cs2'), `「使用中」里有：${JSON.stringify(afterEnter)}`);
const pvTxt = await sheet.locator('.preview').innerText().catch(() => '');
ok('  查询结果里列出了匹配到的账号名', pvTxt.includes('panel_cs2'), pvTxt);
ok('  查询结果不显示密码', !pvTxt.includes('Test1234'), pvTxt);

// 再点一次「查一下」按钮，也不能领走
await page.locator('.sheet.api button', { hasText: '查一下' }).click();
await page.waitForTimeout(1500);
ok('★★★ 点「查一下」也只是查询，账号仍未被领走',
  !(await inUseNow()).includes('panel_cs2'), JSON.stringify(await inUseNow()));

// 只有点「确认领取一个」才会真的领 —— 而且会弹确认框
page.once('dialog', (d) => d.accept());
await page.locator('.sheet.api button', { hasText: '确认领取一个' }).click();
await page.waitForTimeout(2200);

const okBlock = sheet.locator('.result--ok');
const gotOk = (await okBlock.count()) > 0;
const resTxt = gotOk ? await okBlock.innerText().catch(() => '') : '';
console.log('--- 领取结果块 ---');
console.log(resTxt.split('\n').filter(Boolean).join(' | '));

ok('★★★ 点「确认领取」才真的调接口', gotOk, resTxt.slice(0, 120));
ok('★★★ 领到的就是那个 CS2 账号', resTxt.includes('panel_cs2') && resTxt.includes('Test1234'),
  resTxt.slice(0, 160));
ok('  结果块里标明了匹配方式', /精确匹配|包含匹配|任意分配/.test(resTxt), resTxt.slice(0, 160));
ok('★ 这次账号真的进入了「使用中」', (await inUseNow()).includes('panel_cs2'),
  JSON.stringify(await inUseNow()));

// 领完之后再查 —— 唯一那个已被领走，应该显示「暂无账号」
await sheet.locator('input.input').first().fill('CS2');
await page.locator('.sheet.api button', { hasText: '查一下' }).click();
await page.waitForTimeout(1600);
const noTxt = await page.locator('.sheet.api .preview--none').innerText().catch(() => '');
console.log('--- 领完再查 ---');
console.log(noTxt.split('\n').filter(Boolean).join(' | '));
ok('★★★ 已经领完时，查询显示「暂无账号」', noTxt.includes('暂无账号'), noTxt.slice(0, 160));

await browser.close();
srv.kill();
// 服务器退出后再删目录（否则 Windows 会因文件占用报错）
await new Promise((r) => setTimeout(r, 800));
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n── 结果：${pass} 通过 / ${fails.length} 失败 ──`);
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  · ' + f); }
process.exit(fails.length ? 1 : 0);
