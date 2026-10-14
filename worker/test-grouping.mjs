/**
 * 按游戏分组 + 卡片瘦身 的界面测试
 *
 * 跑法：node test-grouping.mjs
 *
 * 验证：
 *   ① 两个及以上游戏时，按游戏名分成可折叠的二级栏
 *   ② 标题上显示该游戏的账号数量
 *   ③ 点标题能折叠/展开
 *   ④ 「全部收起 / 全部展开」有效
 *   ⑤ 折叠状态记得住（刷新后还是收着的）
 *   ⑥ 只有一个游戏时**不**分组（标题栏纯属多余）
 *   ⑦ 卡片确实比原来小了
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'index.mjs');
const PORT = 8916;
const APP = `http://127.0.0.1:${PORT}`;
const MASTER = 'group-test-123456';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'group-test-'));
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), VAULT_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => { const s = String(d); if (/\[error\]/.test(s)) console.log('[server]', s.trim()); });

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const api = async (method, p, body, token) => {
  const r = await fetch(APP + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};

let browser = null;
try {
  console.log('\n════════ 按游戏分组 ════════\n');

  let up = false;
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`${APP}/api/health`)).ok) { up = true; break; } } catch { /* 等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) throw new Error('服务没起来');

  const s = await api('POST', '/api/setup', { masterPassword: MASTER });
  const token = s.token;

  /* ---------- 造数据：3 个游戏，6 个账号 ---------- */
  console.log('① 造数据');
  const spec = [
    ['链在一起', 3], ['机械狂欢', 2], ['原神', 1],
  ];
  let n = 0;
  for (const [game, count] of spec) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      await api('POST', '/api/accounts', {
        username: `${game}_acc_${i + 1}`,
        password: `Pw${n}23456`,
        game,
        usageMinutes: 720,
      }, token);
    }
  }
  ok(`建了 ${n} 个账号、3 个游戏`, true);

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const unlock = async () => {
    await page.waitForSelector('.lock__card', { timeout: 15000 });
    const inputs = await page.$$('.lock__input');
    await inputs[0].fill(MASTER);
    if (inputs[1]) await inputs[1].fill(MASTER);
    await page.click('.lock__form button[type=submit]');
    await page.waitForSelector('.tabbar', { timeout: 15000 });
    // 停在「可用」页
    const tab = await page.$('.tabbar >> text=可用');
    if (tab) await tab.click();
    await page.waitForTimeout(600);
  };

  await page.goto(APP, { waitUntil: 'networkidle' });
  await unlock();
  await page.waitForSelector('.ghead', { timeout: 8000 }).catch(() => {});

  /* ---------- ① 分组标题 ---------- */
  console.log('\n② 分组标题');
  const heads = await page.$$('.ghead');
  ok('★ 出现了 3 个游戏分组', heads.length === 3, `实际 ${heads.length}`);

  const names = await page.$$eval('.ghead__name', (els) => els.map((e) => e.textContent.trim()));
  ok('★★ 标题就是游戏名', names.length === 3 && names.includes('链在一起') && names.includes('机械狂欢') && names.includes('原神'),
    JSON.stringify(names));

  const counts = await page.$$eval('.ghead__n', (els) => els.map((e) => e.textContent.trim()));
  ok('★★ 标题上带了账号数量', counts.length === 3 && counts.reduce((a, b) => a + Number(b), 0) === 6,
    JSON.stringify(counts));

  const allCards = await page.$$('.acct');
  ok('  6 张卡片都在', allCards.length === 6, `实际 ${allCards.length}`);

  /* ---------- ② 折叠 ---------- */
  console.log('\n③ 折叠 / 展开');
  const first = await page.$('.group >> nth=0');
  const firstName = (await (await first.$('.ghead__name')).textContent()).trim();
  // ★ 用这一组自己的数量，别硬编码 ★
  //   第一组按名称排序后是「机械狂欢」（2 个），不是 3 个 —— 写死 3 就挂了。
  const firstCount = Number((await (await first.$('.ghead__n')).textContent()).trim());
  ok(`  （第一组「${firstName}」有 ${firstCount} 个账号）`, firstCount > 0);

  await (await first.$('.ghead')).click();
  await page.waitForTimeout(400);

  const foldedCls = await first.getAttribute('class');
  ok(`★ 点标题后「${firstName}」收起了`, /group--folded/.test(foldedCls || ''), foldedCls);

  const visibleAfter = await page.$$eval('.group >> nth=0 >> .acct', (els) => els.filter((e) => e.offsetParent !== null).length);
  ok('★★ 收起后那个游戏的卡片看不见了', visibleAfter === 0, `还看得见 ${visibleAfter} 张`);

  const stillVisible = await page.$$eval('.group >> nth=1 >> .acct', (els) => els.filter((e) => e.offsetParent !== null).length);
  ok('  别的游戏不受影响', stillVisible > 0, `${stillVisible} 张`);

  await (await first.$('.ghead')).click();
  await page.waitForTimeout(400);
  const visibleBack = await page.$$eval('.group >> nth=0 >> .acct', (els) => els.filter((e) => e.offsetParent !== null).length);
  ok('★ 再点一次又展开了', visibleBack === firstCount, `${visibleBack} 张，期望 ${firstCount}`);

  /* ---------- ③ 全部收起 / 展开 ---------- */
  console.log('\n④ 全部收起 / 全部展开');
  await page.click('.gbar__btn');
  await page.waitForTimeout(400);
  const foldedCount = (await page.$$('.group--folded')).length;
  ok('★★ 「全部收起」把所有组都收了', foldedCount === 3, `${foldedCount} 组`);

  await page.click('.gbar__btn');
  await page.waitForTimeout(400);
  const openCount = (await page.$$('.group--folded')).length;
  ok('  按钮文字应该变成「全部展开」了', openCount === 0, `${openCount} 组还是收着的`);

  /* ---------- ④ 折叠状态持久化 ---------- */
  console.log('\n⑤ 折叠状态记得住');
  await (await (await page.$('.group >> nth=0')).$('.ghead')).click();
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // ★ 刷新后不一定会出现锁屏 ★
  //   保险库是**服务端**的状态 —— 刷新浏览器不等于锁定。
  //   所以这里要等"锁屏或主界面"哪一个先出现，不能死等 .lock__card。
  await page.waitForFunction(
    () => document.querySelector('.lock__card') || document.querySelector('.tabbar'),
    { timeout: 15000 },
  );
  if (await page.$('.lock__card')) {
    const inputs2 = await page.$$('.lock__input');
    await inputs2[0].fill(MASTER);
    await page.click('.lock__form button[type=submit]');
    await page.waitForSelector('.tabbar', { timeout: 15000 });
  }
  await page.waitForTimeout(700);
  const tabAfter = await page.$('.tabbar >> text=可用');
  if (tabAfter) await tabAfter.click();
  await page.waitForTimeout(600);

  const foldedAfterReload = (await page.$$('.group--folded')).length;
  ok('★★ 刷新后那个游戏还是收着的', foldedAfterReload === 1, `${foldedAfterReload} 组收着`);

  // ★ 展开所有组再量尺寸 ★
  //   那个按钮是"切换"：全部收着时点它=展开，只要有一个还开着点它就=全收 ✗
  //   之前直接点一下，结果全收起来了，后面量卡片尺寸就拿不到元素 —— 踩过。
  for (let i = 0; i < 3; i += 1) {
    if ((await page.$$('.group--folded')).length === 0) break;
    await page.click('.gbar__btn');
    await page.waitForTimeout(400);
  }
  ok('  截图前所有分组都展开了', (await page.$$('.group--folded')).length === 0);

  /* ---------- ⑤ 卡片尺寸 ---------- */
  console.log('\n⑥ 卡片确实小了');
  const box = await (await page.$('.acct')).boundingBox();
  ok('★ 卡片高度收下来了（< 250px）', box && box.height < 250, box ? `${Math.round(box.height)}px` : '拿不到');
  ok('★ 卡片宽度不超过 340px', box && box.width <= 340, box ? `${Math.round(box.width)}px` : '拿不到');

  const cols = await page.$$eval('.group >> nth=0 >> .grid', (els) => {
    if (!els.length) return 0;
    const st = getComputedStyle(els[0]);
    return st.gridTemplateColumns.split(' ').length;
  });
  ok('★ 一行能放多列', cols >= 2, `${cols} 列`);

  /* ---------- 截图 ---------- */
  const shotDir = path.join(ROOT, 'worker', 'out', 'shots');
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, 'grouping.png'), fullPage: true });
  console.log(`\n截图：${path.join(shotDir, 'grouping.png')}`);

  /* ---------- ⑥ 只有一个游戏时不分组 ---------- */
  console.log('\n⑦ 只有一个游戏时不分组');
  const page2 = await ctx.newPage();
  // 删掉另外两个游戏的账号，只留「原神」
  const all = await api('GET', '/api/accounts?state=available', null, token);
  for (const a of (all.items || [])) {
    if (a.game !== '原神') await api('DELETE', `/api/accounts/${a.id}`, null, token);
  }
  await page2.goto(APP, { waitUntil: 'networkidle' });
  await page2.waitForFunction(
    () => document.querySelector('.lock__card') || document.querySelector('.tabbar'),
    { timeout: 15000 },
  );
  if (await page2.$('.lock__card')) {
    const inputs3 = await page2.$$('.lock__input');
    await inputs3[0].fill(MASTER);
    await page2.click('.lock__form button[type=submit]');
    await page2.waitForSelector('.tabbar', { timeout: 15000 });
  }
  await page2.waitForTimeout(700);
  const tab2 = await page2.$('.tabbar >> text=可用');
  if (tab2) await tab2.click();
  await page2.waitForTimeout(600);

  const heads2 = (await page2.$$('.ghead')).length;
  ok('★★ 只剩一个游戏时，不显示分组标题', heads2 === 0, `还有 ${heads2} 个标题`);
  const cards2 = (await page2.$$('.acct')).length;
  ok('  卡片照常显示', cards2 === 1, `${cards2} 张`);
  await page2.screenshot({ path: path.join(shotDir, 'grouping-single.png'), fullPage: true });
  console.log(`截图：${path.join(shotDir, 'grouping-single.png')}`);
} catch (e) {
  console.log(`\n  ✗ 测试中断：${e.message}\n${e.stack}`);
  fails.push('异常中断：' + e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n── 结果：${pass} 通过 / ${fails.length} 失败 ──`);
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  · ' + f); }
console.log('');
process.exit(fails.length ? 1 : 0);
