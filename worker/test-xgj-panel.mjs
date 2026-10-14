/**
 * 验证闲管家对接面板：能打开、内容全、改配置能存住、档位能增删、商品预览对得上。
 */
import { spawn } from 'node:child_process';
import { chromium, devices } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8931;
const DATA = path.join(os.tmpdir(), 'xgj-panel-test');
const OUT = path.join(HERE, 'out', 'shots');

let pass = 0; const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name} — ${extra}`); console.log(`  ✗ ${name} — ${extra}`); }
};

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const app = spawn('D:\\node.exe', [path.join(ROOT, 'server', 'index.mjs')], {
  env: { ...process.env, PORT: String(PORT), VAULT_DATA_DIR: DATA }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 3000));
const BASE = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const phone = String(process.argv[2] || '') === 'phone';
const ctx = await browser.newContext(phone
  ? { ...devices['Pixel 7'], locale: 'zh-CN' }
  : { viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(async (base) => {
  await fetch(base + '/api/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterPassword: 'panel-123456' }),
  });
}, BASE);
const unlock = await page.evaluate(async (base) => {
  const r = await fetch(base + '/api/unlock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterPassword: 'panel-123456' }),
  });
  return r.json();
}, BASE);

// 造点数据：3 个游戏
for (const [u, g] of [['p_ljzyq_1', '链在一起'], ['p_ljzyq_2', '链在一起'], ['p_cs2_1', 'CS2'], ['p_dota_1', 'Dota 2']]) {
  await fetch(BASE + '/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${unlock.token}` },
    body: JSON.stringify({ username: u, password: 'Panel123', game: g, usageMinutes: 60 }),
  });
}

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const pw = page.locator('input[type=password]').first();
if (await pw.count().catch(() => 0)) {
  await pw.fill('panel-123456');
  const btn = page.locator('button', { hasText: /解锁|进入/ }).first();
  if (await btn.count().catch(() => 0)) await btn.click();
  await page.waitForTimeout(2500);
}

/* 打开面板 */
await page.locator('.topbar button').last().click();
await page.waitForTimeout(500);
const item = page.locator('.menu button', { hasText: '闲管家' }).first();
ok('★ 菜单里有「闲管家对接」入口', (await item.count()) > 0);
if (await item.count()) { await item.click(); await page.waitForTimeout(1200); }

/**
 * ★ 带会话令牌的 GET ★
 *   页面里裸 fetch 是拿不到数据的 —— 服务端要 Authorization，
 *   而浏览器地址栏/裸 fetch 不会自动带上。（我第一版就栽在这里，全部 401）
 */
const apiGet = (p) => page.evaluate(async ({ base, tok, path }) => {
  const r = await fetch(base + path, { headers: { Authorization: `Bearer ${tok}` } });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; }
}, { base: BASE, tok: unlock.token, path: p });

const sheet = page.locator('.sheet.xgj');
ok('★★★ 面板能打开', (await sheet.count()) > 0);
const txt = await sheet.first().innerText().catch(() => '');
console.log('\n--- 面板文字（前 900 字）---');
console.log(txt.slice(0, 900));
console.log('--- 结束 ---\n');

ok('  有自检状态',
  /可以对接|还差|未开启/.test(txt), txt.split('\n').slice(0, 4).join(' | '));
ok('  有「接口网关」', txt.includes('接口网关'));

/* ★★★ 接口网关不能显示本机地址 ★★★
   实测踩过：面板显示 http://127.0.0.1:8787，用户照抄进闲管家必然连不上
   （闲管家的服务器访问不到他的 127.0.0.1）。所以本机打开时必须有醒目警告。 */
const warnBox = page.locator('.sheet.xgj .warnbox');
const gwTxt = await page.locator('.sheet.xgj .code').first().innerText().catch(() => '');
ok(`  接口网关显示的是：${gwTxt}`, !!gwTxt);
if (/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(gwTxt)) {
  ok('★★★ 本机地址时必须显示「闲管家访问不到」的警告', (await warnBox.count()) > 0,
    '没有警告框，用户会照抄 127.0.0.1 导致对接失败');
  // ★ 用 .first() ★
  //   面板上不止一个警告框 —— 后来又加了「买家取码链接」那一块，它也有一个
  //   （提示"还没公网地址"）。locator 匹配到多个时 innerText() 会直接抛异常，
  //   被 .catch 吞成空串，断言就莫名其妙地挂了。踩过一次。
  //   第一个才是「接口网关」那块下面的。
  const w = await warnBox.first().innerText().catch(() => '');
  ok('  警告里说清了正确做法（用隧道地址打开）',
    w.includes('访问不到') && /隧道|trycloudflare/.test(w), w.replace(/\n/g, ' ').slice(0, 160));
} else {
  ok('★★★ 显示的是公网地址时不该有警告', (await warnBox.count()) === 0, gwTxt);
}

/* ★★★ 买家取码链接 ★★★
   用户特意交代过："要修改闲管家模板就修改吧，每次记得提醒我。"
   所以面板必须给出**可以直接复制**的模板行，而且要带上当前的公网地址。
   隧道一换，这行就跟着换 —— 这就是那个"提醒"。 */
const tplTxt = await page.locator('.sheet.xgj .tplbox').innerText().catch(() => '');
ok('★★★ 面板上有「买家取码链接」的模板行', !!tplTxt, tplTxt.slice(0, 80));
ok('★★ 模板行里带了取码路径 /c/ 和订单号变量',
  tplTxt.includes('/c/') && tplTxt.includes('{$订单编号}'), tplTxt.slice(0, 120));
ok('★★★ 模板行用的是闲管家的变量语法 {$...}，不是 JS 的 ${...}',
  !/\$\{/.test(tplTxt), tplTxt.slice(0, 120));
ok('★ 有醒目的「隧道地址一变就要重粘」提醒',
  (await page.locator('.sheet.xgj').innerText()).includes('隧道地址'), '');

/* 服务端要能记住公网地址（面板就是靠它显示的） */
const seeded = await page.evaluate(async (base) => {
  // 模拟一次"从隧道进来"的请求
  await fetch(base + '/api/health', {
    headers: { 'X-Forwarded-Host': 'demo-tunnel.trycloudflare.com', 'X-Forwarded-Proto': 'https' },
  });
  return true;
}, BASE);
void seeded;
const afterSeed = await apiGet('/api/settings');
ok('★★★ 服务端记住了「最近一次从公网进来的地址」',
  afterSeed.publicBaseUrl === 'https://demo-tunnel.trycloudflare.com',
  JSON.stringify(afterSeed.publicBaseUrl));
ok('  本机地址不会被误记成公网地址（baseUrl 仍是本机）',
  /127\.0\.0\.1/.test(afterSeed.baseUrl), afterSeed.baseUrl);

ok('  有商户 ID / 对接密钥', txt.includes('mch_id') && txt.includes('mch_secret'));
ok('  有 AppKey / AppSecret 输入', txt.includes('app_id') && txt.includes('app_secret'));
ok('  有时长档位区', txt.includes('售卖时长档位'));
ok('  有商品预览', txt.includes('商品预览'));
ok('  有接口清单', txt.includes('/goofish/goods/list') && txt.includes('/goofish/order/purchase/create'));

/* 商品预览对不对 */
const preview = await apiGet('/api/xgj/goods');
ok('★★ 商品预览：3 游戏 × 3 档位 = 9 个商品', preview.count === 9, `实际 ${preview.count}`);
ok('  链在一起 6 小时：库存 2',
  preview.items?.some((g) => g.game === '链在一起' && g.minutes === 360 && g.stock === 2),
  JSON.stringify(preview.items?.filter((g) => g.game === '链在一起').map((g) => [g.duration, g.stock])));

/* 填配置 —— 只填一个字段，别的不能被冲掉 */
await page.locator('.sheet.xgj input').first().fill('steam-test-01');
await page.locator('.sheet.xgj input').first().press('Tab');
await page.waitForTimeout(900);

const secretInput = page.locator('.sheet.xgj input[placeholder="点右边「随机生成」"]');
if (await secretInput.count()) {
  await secretInput.fill('my-secret-for-test');
  await secretInput.press('Tab');
  await page.waitForTimeout(900);
}

const serverCfg = (await apiGet('/api/settings')).settings?.xgj;

ok('★★★ 填了 mchId 之后，服务端真的存住了',
  serverCfg?.mchId === 'steam-test-01', JSON.stringify(serverCfg));
ok('★★★ 只改一个字段，别的字段没被冲掉（对接密钥还在）',
  serverCfg?.mchSecret === 'my-secret-for-test', JSON.stringify(serverCfg?.mchSecret));

/* 加档位 */
const before = (await apiGet('/api/xgj/goods')).count;
const tierIn = page.locator('.sheet.xgj .tier__in');
if (await tierIn.count()) {
  await tierIn.fill('3天');
  await page.locator('.sheet.xgj .tier__add').click();
  await page.waitForTimeout(1400);
}
const after = (await apiGet('/api/xgj/goods')).count;
ok('★★★ 界面上加一个「3天」档位 → 商品从 9 变成 12',
  after === before + 3, `${before} → ${after}`);

const tiersTxt = await page.locator('.sheet.xgj .tiers').innerText().catch(() => '');
ok('★★ 加进去的是「3 天」而不是别的（曾因 ref 写错永远加成 6 分钟）',
  tiersTxt.includes('3 天'), tiersTxt.replace(/\n/g, ' '));
ok('  没有混进奇怪的档位', !tiersTxt.includes('6 分钟'), tiersTxt.replace(/\n/g, ' '));

/* 删档位 */
const xBtn = page.locator('.sheet.xgj .tier').filter({ hasText: '3 天' }).locator('.tier__x').first();
if (await xBtn.count()) { await xBtn.click(); await page.waitForTimeout(1400); }
const after2 = (await apiGet('/api/xgj/goods')).count;
ok('★★ 界面上删掉那一档 → 商品变回 9', after2 === 9, String(after2));

/* 开关（现在有两个：「开启对接」和「只放行闲管家的 IP」，要选准） */
const enableSw = page.locator('.sheet.xgj .row--switch').filter({ hasText: '开启对接' }).locator('.switch').first();
ok('  面板上有「开启对接」开关', (await enableSw.count()) > 0);
if (await enableSw.count()) { await enableSw.click(); await page.waitForTimeout(1200); }
const cfgAfterSwitch = (await apiGet('/api/settings')).settings?.xgj;
ok('★ 开关能开', cfgAfterSwitch?.enabled === true, String(cfgAfterSwitch?.enabled));
ok('★★★ 点开关不会把密钥冲掉', cfgAfterSwitch?.mchSecret === 'my-secret-for-test',
  JSON.stringify(cfgAfterSwitch?.mchSecret));

/* ★ 白名单开关 ★ —— 万一闲管家换了 IP，这是唯一的自救入口 */
const ipSw = page.locator('.sheet.xgj .row--switch').filter({ hasText: '只放行闲管家的 IP' }).locator('.switch').first();
ok('★★ 面板上有「只放行闲管家的 IP」开关', (await ipSw.count()) > 0);
const ipBefore = (await apiGet('/api/settings')).settings?.xgj.ipWhitelist;
if (await ipSw.count()) { await ipSw.click(); await page.waitForTimeout(1200); }
const ipAfter = (await apiGet('/api/settings')).settings?.xgj.ipWhitelist;
ok('★★★ 关掉白名单后，非闲管家 IP 也能调进来（自救入口有效）',
  ipBefore === true && ipAfter === false, `${ipBefore} → ${ipAfter}`);

// 真的从"外部 IP"调一次，验证关掉后不再 403
const fromOutside = await page.evaluate(async (base) => {
  const r = await fetch(`${base}/goofish/user/info?mch_id=steam01&timestamp=1&sign=x`, { method: 'POST' });
  return { status: r.status, body: await r.text() };
}, BASE);
ok('  关掉白名单后不再是 403 IP 拦截', !fromOutside.body.includes('IP不在白名单'),
  fromOutside.body.slice(0, 140));

// 再打开，恢复默认的安全状态
if (await ipSw.count()) { await ipSw.click(); await page.waitForTimeout(1200); }
ok('  能再打开（恢复默认）', (await apiGet('/api/settings')).settings?.xgj.ipWhitelist === true);

const st = await apiGet('/api/xgj/status');
ok('  自检：开关开了但密钥没填全 → 还没 ready',
  st.enabled === true && st.ready === false, JSON.stringify({ e: st.enabled, r: st.ready, m: st.missing }));

const name = phone ? 'xgj-panel-phone' : 'xgj-panel-desktop';
await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
await page.locator('.sheet.xgj .sheet__body').first().evaluate((el) => { el.scrollTop = 780; }).catch(() => {});
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, `${name}-2.png`), fullPage: false });
console.log(`\n截图：${OUT}\\${name}.png`);

await browser.close();
app.kill();
await new Promise((r) => setTimeout(r, 800));
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n── 结果：${pass} 通过 / ${fails.length} 失败 ──`);
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  · ' + f); }
process.exit(fails.length ? 1 : 0);
