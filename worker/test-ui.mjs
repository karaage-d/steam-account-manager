/**
 * 界面回归测试：顶栏「更多」菜单
 *
 *   node test-ui.mjs
 *
 * 背景：`.topbar` 上有 backdrop-filter，会创建层叠上下文。
 *       菜单在它里面，自己的 z-index 只在上下文内部有效 ——
 *       对 DOM 里更靠后的 .pager（position: relative）无效，
 *       结果菜单下半部分被盖住，「设置 / 切换主题 / 锁定保险库」点不到。
 *
 * 所以这个测试做两件事：
 *   1. 用 elementFromPoint 量每一项有没有被盖住（几何层面）
 *   2. 每一项真点一遍，验证功能确实生效（行为层面）
 *   3. 顺便验证弹窗仍然盖得住顶栏（别把层级修过头）
 *
 * 需要系统里有 Chrome 或 Edge。会自己起一个临时服务，不需要真账号。
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'server', 'index.mjs');
const PORT = Number(process.env.APP_PORT || 8951);
const APP = `http://127.0.0.1:${PORT}`;
const MASTER = 'ui-test-123456';

let pass = 0;
const fails = [];
const ok = (n, c, e = '') => {
  if (c) { pass += 1; console.log(`  \u2713 ${n}`); }
  else { fails.push(n + (e ? ` — ${e}` : '')); console.log(`  \u2717 ${n}${e ? ' — ' + e : ''}`); }
};

console.log('\n── 顶栏「更多」菜单回归测试 ──\n');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-test-'));
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), VAULT_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => { const s = String(d); if (/\[error\]/.test(s)) console.log('[server]', s.trim()); });

let browser = null;
try {
  let up = false;
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`${APP}/api/health`)).ok) { up = true; break; } } catch { /* 等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) throw new Error('服务没能启动');

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();

  const health = await (await fetch(`${APP}/api/health`)).json();
  if (!health.initialized) {
    await fetch(`${APP}/api/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterPassword: MASTER }),
    });
  }

  const unlock = async () => {
    await page.waitForSelector('.lock__card', { timeout: 15000 });
    const inputs = await page.$$('.lock__input');
    await inputs[0].fill(MASTER);
    if (inputs[1]) await inputs[1].fill(MASTER);
    await page.click('.lock__form button[type=submit]');
    await page.waitForSelector('.tabbar', { timeout: 15000 });
  };

  const openMenu = async () => {
    // 幂等：已经开着就别再点（再点一下就关了）
    if (!(await page.$('.menu'))) {
      await page.click('.topbar__right .btn--icon:last-of-type');
      await page.waitForSelector('.menu', { timeout: 5000 });
    }
    await page.waitForTimeout(250);
  };

  const closeMenu = async () => {
    if (await page.$('.menu')) {
      await page.mouse.click(640, 700);          // 点空白处，靠外部点击关闭
      await page.waitForTimeout(250);
    }
  };

  const clickItem = async (text) => {
    await openMenu();
    await page.locator('.menu__item', { hasText: text }).first().click({ timeout: 5000 });
    await page.waitForTimeout(450);
  };

  await page.goto(APP, { waitUntil: 'networkidle' });
  await unlock();
  ok('解锁进入主界面', !!(await page.$('.tabbar')));

  /* ---------- [0] 一级导航：三个界面真的切得动 ---------- */
  // ★ 这一节守的是一个真出现过的 bug ★
  //   SwipePager 里 targetIndex 原来是个普通变量（不是 ref），
  //   点击标签时 modelValue 变了、watch 也改了值，但 computed 收集不到依赖不会重算 ——
  //   表现就是「标签高亮了，下面的内容还停在上一个界面」。
  //   只断言 .tabbar 存在是抓不到的，必须断言**切换后的实际内容**。
  console.log('[0] 一级导航：点标签是否真的换页');
  // 三个界面的 DOM 是同时存在的（左右滑动的三页），
  // 所以必须读"当前可见那一页"的标题，不能 document.querySelector('.panel__title')
  // —— 那样永远拿到第一页（可用），测不出切换坏了。
  const panelTitle = () => page.evaluate(() => {
    const el = document.querySelector('.pager__page[aria-hidden="false"] .panel__title');
    return el ? (el.textContent || '').trim() : '';
  });

  // ★ 2026-10-10 需求变更 ★
  //   最初需求第 4 条要求「添加账号」在一级导航里，所以这里曾经断言"导航栏里有它"。
  //   但实际用起来同一个屏幕上出现了三个「添加账号」（顶栏 / 导航栏 / 可用面板标题行），
  //   用户明确要求「删两个，剩一个就行」。
  //   现在断言改成守新约定：**整个界面上有且只有一个**，且它在顶栏。
  const addButtons = await page.evaluate(() => {
    const T = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const out = [];
    for (const el of document.querySelectorAll('button, [role=button], a')) {
      if (!el.offsetWidth || !el.offsetHeight) continue;   // 不可见的跳过
      if (T(el) === '添加账号') out.push(el.className || '');
    }
    return out;
  });
  ok('★ 整个界面上只有一个「添加账号」按钮',
    addButtons.length === 1, `找到 ${addButtons.length} 个：${JSON.stringify(addButtons)}`);
  ok('  它在顶栏里',
    addButtons.length === 1 && /topbar|btn/.test(addButtons[0]), JSON.stringify(addButtons));
  ok('  导航栏里已经没有它了（避免和状态筛选混在一起）',
    (await page.locator('.tabbar .tab--act', { hasText: '添加账号' }).count()) === 0);

  const navCount = await page.locator('.tabbar .tab--view').count();
  ok('三个状态界面在同一栏里', navCount === 3, `got ${navCount}`);

  await page.locator('.tabbar .tab--view', { hasText: '使用中' }).first().click();
  await page.waitForTimeout(900);
  const t2 = await panelTitle();
  const hint2 = await page.locator('.tabbar__hint').innerText();
  ok('★ 点「使用中」内容真的换了（不是只换个高亮）',
    t2.includes('使用中'), `panel="${t2}" hint="${hint2}"`);

  await page.locator('.tabbar .tab--view', { hasText: '待改密' }).first().click();
  await page.waitForTimeout(900);
  const t3 = await panelTitle();
  ok('★ 点「待改密」内容也换了', t3.includes('待改密'), `panel="${t3}"`);

  await page.locator('.tabbar .tab--view', { hasText: '可用' }).first().click();
  await page.waitForTimeout(900);
  const t1 = await panelTitle();
  ok('★ 点回「可用」内容跟着回去', t1.includes('可用'), `panel="${t1}"`);

  // 导航里的「更多」要能列出附加界面（可扩展的挂载位）
  await page.locator('.tabbar .tab--act', { hasText: '更多' }).first().click();
  await page.waitForTimeout(300);
  const attached = await page.locator('.more__menu .more__item').allInnerTexts();
  ok('★ 「更多」里能列出附加界面（可扩展）', attached.length >= 3,
    JSON.stringify(attached));
  // 再点一次收起，免得挡住后面的用例
  await page.locator('.tabbar .tab--act', { hasText: '更多' }).first().click();
  await page.waitForTimeout(250);
  ok('「更多」能收起', (await page.locator('.more__menu').count()) === 0);

  /* ---------- [1] 几何：每一项都没被盖住 ---------- */
  console.log('[1] 每一菜单项是否可点（elementFromPoint 实测）');
  await openMenu();
  const geom = await page.evaluate(() => {
    const boxes = {};
    for (const sel of ['.topbar', '.pager', '.menu']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      boxes[sel] = { top: Math.round(r.top), bottom: Math.round(r.bottom) };
    }
    const items = [];
    for (const item of document.querySelectorAll('.menu__item')) {
      const r = item.getBoundingClientRect();
      const top = document.elementFromPoint(
        Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2),
      );
      items.push({
        text: (item.textContent || '').trim(),
        clickable: item.contains(top) || item === top,
        blocker: top ? top.tagName.toLowerCase() + '.' + String(top.className || '').split(/\s+/)[0] : '?',
        y: Math.round(r.top),
      });
    }
    return { boxes, items };
  });

  console.log(`    topbar=${JSON.stringify(geom.boxes['.topbar'])} pager=${JSON.stringify(geom.boxes['.pager'])}`);
  for (const it of geom.items) {
    console.log(`    ${it.clickable ? '✓' : '✗'} ${it.text.padEnd(14)} y=${it.y}  ${it.clickable ? '' : '被 ' + it.blocker + ' 盖住'}`);
  }
  const blocked = geom.items.filter((i) => !i.clickable);
  ok(`★ 全部 ${geom.items.length} 项都没被盖住`, blocked.length === 0,
    `被盖: ${blocked.map((b) => `${b.text}(${b.blocker})`).join(', ')}`);
  ok('顶栏的层级高于 pager（否则菜单会被盖）',
    await page.evaluate(() => {
      const t = getComputedStyle(document.querySelector('.topbar'));
      return Number(t.zIndex) > 0 && t.position !== 'static';
    }));
  await closeMenu();

  /* ---------- [2] 行为：三个功能真点一遍 ---------- */
  console.log('\n[2] 三个功能实际点一遍');

  await clickItem('设置');
  ok('★ 「设置」能打开', !!(await page.$('.sheet.settings')));
  const closeBtn = await page.$('.sheet.settings .sheet__head button');
  if (closeBtn) await closeBtn.click();
  await page.waitForTimeout(300);
  ok('「设置」能关掉', !(await page.$('.sheet.settings')));

  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme || 'dark');
  await clickItem(themeBefore === 'dark' ? '切换到浅色主题' : '切换到深色主题');
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
  ok('★ 「切换主题」生效', themeAfter !== themeBefore, `${themeBefore} → ${themeAfter}`);

  // 切回去，避免影响后面的判断
  const labelBack = themeAfter === 'light' ? '切换到深色主题' : '切换到浅色主题';
  await clickItem(labelBack);
  ok('能切回原主题', (await page.evaluate(() => document.documentElement.dataset.theme)) === themeBefore);

  /* ---------- [3] 弹窗仍要盖得住顶栏 ---------- */
  console.log('\n[3] 弹窗必须仍然盖得住顶栏（别把层级修过头）');
  await page.click('.topbar__right .btn--primary');
  await page.waitForSelector('.editor', { timeout: 5000 });
  await page.waitForTimeout(300);
  const covered = await page.evaluate(() => {
    const btn = document.querySelector('.topbar__right .btn--icon:last-of-type');
    const r = btn.getBoundingClientRect();
    const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return { hitsOverlay: !!(top && top.closest('.overlay')), tag: top ? top.tagName.toLowerCase() : '?' };
  });
  ok('★ 弹窗打开时，顶栏按钮点不到（被弹窗盖住）', covered.hitsOverlay, `命中 ${covered.tag}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  if (await page.$('.editor')) {
    const cancel = await page.$('.sheet__foot .btn');
    if (cancel) await cancel.click();
    await page.waitForTimeout(300);
  }

  /* ---------- [3.5] 邮箱面板：取件接口 ---------- */
  console.log('\n[3.5] 邮箱面板：取件接口（iCloud 路线）');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await clickItem('邮箱（验证码来源）');
  ok('邮箱面板能打开', !!(await page.$('.sheet.mail')));
  await page.click('.sheet.mail .addbtn');
  await page.waitForSelector('.addbox', { timeout: 5000 });
  ok('默认是微软邮箱（有 client_id 输入框）',
    !!(await page.$('.addbox input[placeholder*="client_id"]')));

  await page.locator('.seg__btn', { hasText: '取件接口' }).click();
  await page.waitForTimeout(250);
  ok('切到取件接口后出现「接口地址」输入框', !!(await page.$('.addbox textarea')));
  ok('微软那套字段消失了', !(await page.$('.addbox input[placeholder*="client_id"]')));

  const urlBox = await page.$('.addbox textarea');
  await urlBox.fill('https://api.example.com/m?f=json&e=39.sleeve_meshes@icloud.com:secret123');
  await page.waitForTimeout(350);
  const addText = await page.textContent('.addbox');
  ok('★ 自动从接口地址里认出了邮箱',
    /39\.sleeve_meshes@icloud\.com/.test(addText), addText.slice(0, 200));
  ok('★ 提示了「地址里内嵌了凭据」', /内嵌了凭据/.test(addText));

  await urlBox.fill('https://api.example.com/m?f=json&id=12345');
  await page.waitForTimeout(300);
  ok('普通地址不再显示凭据警告',
    !/内嵌了凭据/.test(await page.textContent('.addbox')));

  await page.click('.sheet.mail .sheet__head button');
  await page.waitForTimeout(300);
  ok('邮箱面板能关掉', !(await page.$('.sheet.mail')));

  /* ---------- [4] 锁定保险库 ---------- */
  console.log('\n[4] 锁定保险库');
  await clickItem('锁定保险库');
  ok('★ 「锁定保险库」生效', !!(await page.$('.lock__card')));
  ok('锁定后主界面消失', !(await page.$('.tabbar')));

  /* ---------- [5] 重新解锁，确认还能用 ---------- */
  console.log('\n[5] 重新解锁');
  await unlock();
  ok('能重新解锁', !!(await page.$('.tabbar')));
} catch (e) {
  console.log(`\n  \u2717 测试中断：${e.message}`);
  fails.push('异常中断：' + e.message);
} finally {
  if (browser) await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n── 结果：${pass} 通过 / ${fails.length} 失败 ──`);
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  · ' + f); }
console.log('');
process.exit(fails.length ? 1 : 0);
