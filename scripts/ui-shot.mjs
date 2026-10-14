/**
 * 界面截图（自动登录 + 造几个示例账号 + 逐个界面截图）
 *
 *   node scripts/ui-shot.mjs
 *
 * 环境变量：
 *   BASE_URL   默认 http://127.0.0.1:8791   ← 建议指向一个**测试用**数据目录的实例
 *   MASTER     主密码，默认 selftest-master-123
 *   DB_PATH    vault.db 路径；给了就能造出「待改密」的账号（把会话时间往前拨）
 *   OUT_DIR    截图目录，默认 <项目根>/ui-shots
 *
 * ⚠ 会先清空目标实例里的全部账号 —— 只对测试数据目录用，别对着真数据跑。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// playwright-core 装在 worker/ 下，这里按它的位置解析
const require = createRequire(path.join(ROOT, 'worker', 'package.json'));
const { chromium } = require('playwright-core');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8791';
const MASTER = process.env.MASTER || 'selftest-master-123';
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data-selftest', 'vault.db');
const OUT = process.env.OUT_DIR || path.join(ROOT, 'ui-shots');

let token = '';
async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

/** 把进行中的会话往前拨，模拟「使用时间已用完」 */
async function rewind(accountId, secondsBack) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB_PATH);
  db.prepare(`UPDATE sessions SET started_at = started_at - ?
              WHERE account_id = ? AND status = 'active'`).run(secondsBack, accountId);
  db.close();
}

async function seed() {
  const health = await call('GET', '/api/health');
  if (!health.data?.initialized) {
    const s = await call('POST', '/api/setup', { masterPassword: MASTER });
    token = s.data.token;
  } else {
    const u = await call('POST', '/api/unlock', { masterPassword: MASTER });
    if (u.status !== 200) throw new Error(`解锁失败：${JSON.stringify(u.data)}`);
    token = u.data.token;
  }

  // 清空（只对测试数据目录）
  // 注意要三个界面都扫：默认 /api/accounts 只返回「可用」，
  // 上次跑剩下的「使用中 / 待改密」账号不删掉，这一轮就会撞用户名重建失败。
  const board = await call('GET', '/api/board');
  const existing = [
    ...(board.data?.available?.items || []),
    ...(board.data?.inUse?.items || []),
    ...(board.data?.pending?.items || []),
  ];
  for (const a of existing) await call('DELETE', `/api/accounts/${a.id}`);

  const rows = [
    ['steam_alice_01', 'Kx7mQp2Lw9Az', 'Counter-Strike 2', '主力号 · 只打竞技', 120],
    ['steam_bob_02', 'Rt4nZb8Yv1Qe', 'Dota 2', '带小号，别乱动饰品', 90],
    ['steam_cara_03', 'Pw6hJd3Ms0Xc', 'Apex Legends', '排位号', 45],
    ['steam_dave_04', 'Lq9vKt5Nc2Rx', '绝地求生', '和室友共用', 60],
    ['steam_erin_05', 'Zf2bWm7Gy4Hd', '艾尔登法环', '', 30],
  ];
  const ids = [];
  for (const [username, password, game, note, usageMinutes] of rows) {
    const r = await call('POST', '/api/accounts', {
      username, password, game, note, usageMinutes,
      mailHint: `${username.replace('steam_', '')}@icloud.com`,
    });
    ids.push(r.data.account.id);
  }

  // 1 个使用中、1 个待改密
  await call('POST', `/api/accounts/${ids[0]}/use`);
  await call('POST', `/api/accounts/${ids[1]}/use`);
  await rewind(ids[1], 3600 * 5);
  await call('POST', '/api/scheduler/run');
  return ids;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  await seed();

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 },   // iPhone 15 Pro Max 尺寸
    deviceScaleFactor: 2,
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();
  let n = 0;
  const shot = async (name) => {
    n += 1;
    const file = path.join(OUT, `${String(n).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: file });
    console.log(`  ✓ ${path.relative(ROOT, file)}`);
  };

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('.lock__input', MASTER);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.tabbar', { timeout: 15000 });
  await page.waitForTimeout(600);

  await shot('可用');
  for (const [tab, name] of [['使用中', '使用中'], ['待改密', '待改密']]) {
    await page.locator('.tab', { hasText: tab }).first().click();
    await page.waitForTimeout(700);
    await shot(name);
  }

  // 开始使用 → 凭据卡片
  await page.locator('.tab', { hasText: '可用' }).first().click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '开始使用' }).first().click();
  await page.waitForTimeout(800);
  await shot('凭据输出');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 添加账号表单
  await page.getByRole('button', { name: '添加账号' }).first().click();
  await page.waitForTimeout(700);
  await shot('添加账号');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 邮箱（验证码来源）
  await page.locator('.topbar button[title="更多"]').first().click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '邮箱（验证码来源）' }).click();
  await page.waitForTimeout(900);
  await shot('邮箱面板');

  await browser.close();
  console.log(`\n共 ${n} 张 → ${OUT}`);
}

main().catch((e) => { console.error('截图失败：', e); process.exit(1); });
