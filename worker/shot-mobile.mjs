/**
 * 按手机尺寸截图，看当前布局在手机上到底什么样。
 * 用法：node shot-mobile.mjs [宽度] [高度]
 */
import { spawn } from 'node:child_process';
import { chromium, devices } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8955;
const DATA = path.join(os.tmpdir(), 'shot-mobile');
const OUT = path.join(HERE, 'out', 'shots');

const W = Number(process.argv[2]) || 412;   // 安卓常见宽度
const H = Number(process.argv[3]) || 915;

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const srv = spawn('D:\\node.exe', [path.join(ROOT, 'server', 'index.mjs')], {
  env: { ...process.env, PORT: String(PORT), VAULT_DATA_DIR: DATA },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 3000));

const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({
  ...devices['Pixel 7'],
  viewport: { width: W, height: H },
  locale: 'zh-CN',
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(async (base) => {
  await fetch(base + '/api/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterPassword: 'shot-123456' }),
  });
}, BASE);
const unlock = await page.evaluate(async (base) => {
  const r = await fetch(base + '/api/unlock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterPassword: 'shot-123456' }),
  });
  return r.json();
}, BASE);

// 造几个账号，三种状态都有，好看出问题
const mk = async (username, game, note) => {
  const r = await fetch(BASE + '/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${unlock.token}` },
    body: JSON.stringify({ username, password: 'Shot12345', game, note, usageMinutes: 360 }),
  });
  return (await r.json()).account;
};
const a1 = await mk('3945687452', '链在一起', '一号机');
const a2 = await mk('3945687453', 'CS2', '二号机');
const a3 = await mk('3945687454', 'Dota 2', '');
const a4 = await mk('3945687455', '链在一起', '备用');

// 让一个进「使用中」，一个进「待改密」
await fetch(`${BASE}/api/accounts/${a2.id}/use`, {
  method: 'POST', headers: { Authorization: `Bearer ${unlock.token}`, 'Content-Type': 'application/json' },
  body: '{}',
});
await fetch(`${BASE}/api/accounts/${a3.id}/use`, {
  method: 'POST', headers: { Authorization: `Bearer ${unlock.token}`, 'Content-Type': 'application/json' },
  body: '{}',
});
// 把 a3 的会话往前拨，让它立刻过期 → 待改密
const { DatabaseSync } = await import('node:sqlite');
{
  const db = new DatabaseSync(path.join(DATA, 'vault.db'));
  db.prepare("UPDATE sessions SET started_at = started_at - 99999 WHERE account_id = ? AND status='active'")
    .run(a3.id);
  db.close();
}

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const pw = page.locator('input[type=password]').first();
if (await pw.count().catch(() => 0)) {
  await pw.fill('shot-123456');
  const btn = page.locator('button', { hasText: /解锁|进入/ }).first();
  if (await btn.count().catch(() => 0)) await btn.click();
  await page.waitForTimeout(2500);
}

// 等调度器把过期会话转成待改密
await page.waitForTimeout(7000);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

const shot = async (name, note) => {
  const p = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`  ✓ ${name}.png   （${note}）`);
};

console.log(`手机尺寸 ${W}×${H}`);
await shot('m1-可用', '默认进去的第一屏');

// 切到使用中
const tabs = page.locator('.tabbar button');
console.log(`底部按钮数量: ${await tabs.count()}`);
const tabTexts = await page.evaluate(() => Array.from(document.querySelectorAll('.tabbar button'))
  .map((b) => (b.textContent || '').trim()).filter(Boolean));
console.log(`底部 Tab: ${JSON.stringify(tabTexts)}`);

const clickTab = async (label) => {
  const t = page.locator('.tabbar button', { hasText: label }).first();
  if (await t.count().catch(() => 0)) { await t.click(); await page.waitForTimeout(1200); return true; }
  return false;
};
if (await clickTab('使用中')) await shot('m2-使用中', '使用中面板');
if (await clickTab('待改密')) await shot('m3-待改密', '待改密面板');
if (await clickTab('可用') || await clickTab('空闲')) await shot('m4-可用', '可用面板');

// 打开「⋯」菜单
const more = page.locator('.topbar button').last();
if (await more.count().catch(() => 0)) {
  await more.click();
  await page.waitForTimeout(600);
  await shot('m5-顶栏菜单', '点开「⋯」之后');
  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('body').click({ position: { x: 5, y: 400 } }).catch(() => {});
  await page.waitForTimeout(400);
}

// 打开「可用」卡片上的编辑弹窗（铅笔按钮）
await clickTab('可用');
await page.waitForTimeout(900);
const pencil = page.locator('.acct__actions button').last();
if (await pencil.count().catch(() => 0)) {
  await pencil.click();
  await page.waitForTimeout(1000);
  const sheetCount = await page.locator('.sheet').count();
  const title = await page.locator('.sheet__title').first().innerText().catch(() => '');
  console.log(`  （弹出的弹窗：${title || '未识别'}，共 ${sheetCount} 个 sheet）`);
  await shot('m6-编辑弹窗', `账号编辑器：${title}`);
  // 滚到底看按钮区
  await page.locator('.sheet__body').first().evaluate((el) => { el.scrollTop = el.scrollHeight; }).catch(() => {});
  await page.waitForTimeout(500);
  await shot('m7-编辑弹窗底部', '编辑弹窗滚到底，看按钮');
}

// 打开「更多」里的设置
await page.keyboard.press('Escape').catch(() => {});
await page.locator('.overlay').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
await page.waitForTimeout(500);
const more2 = page.locator('.topbar button').last();
if (await more2.count().catch(() => 0)) {
  await more2.click();
  await page.waitForTimeout(500);
  const setBtn = page.locator('.menu__item', { hasText: '设置' }).first();
  if (await setBtn.count().catch(() => 0)) {
    await setBtn.click();
    await page.waitForTimeout(1000);
    await shot('m8-设置', '设置弹窗（也走同一套弹窗样式）');
  }
}


console.log(`\n截图目录: ${OUT}`);

await browser.close();
srv.kill();
await new Promise((r) => setTimeout(r, 700));
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
