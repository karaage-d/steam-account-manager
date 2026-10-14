/**
 * 计时测试：dumpPageToFile 在"元素很多"的页面上要多久。
 *
 * 背景：之前对页面上每个元素都调 innerText（强制触发布局），
 * 在 Steam 那种页面上直接把 evaluate 拖到超时 —— 目录建了、文件是空的。
 * 这个测试保证它在大页面上也能快速返回并真的写出文件。
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dumpPageToFile } from './steam.mjs';

const OUT = path.join(os.tmpdir(), 'dsh-dump-bench');
fs.rmSync(OUT, { recursive: true, force: true });

let pass = 0; const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name} — ${extra}`); console.log(`  ✗ ${name} — ${extra}`); }
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ locale: 'zh-CN' })).newPage();

// 造一个元素很多的页面，形状模仿 Steam 客服那一屏
const rows = Array.from({ length: 2500 }, (_, i) => `<div class="row"><span>填充元素 ${i}</span></div>`).join('');
await page.setContent(`<!doctype html><html><body>
  <div id="app">${rows}</div>
  <div class="wizard">
    <h2>您希望如何更改您的密码？</h2>
    <div class="choice" style="cursor:pointer" onclick="void 0">通过电子邮件发送帐户验证码至 h*******_********@i*****.c**</div>
    <div class="choice" style="cursor:pointer" onclick="void 0">我已无法访问此电子邮件地址，或是没有收到验证码</div>
  </div>
</body></html>`);

console.log(`页面元素总数约 ${await page.evaluate(() => document.querySelectorAll('body *').length)}`);

const logs = [];
const t0 = Date.now();
const okWrite = await dumpPageToFile(page, { outDir: OUT }, (m) => logs.push(String(m)), '计时测试');
const took = Date.now() - t0;

console.log(`  耗时 ${took} ms`);
for (const l of logs) console.log(`     ${l.trim()}`);

ok('  能正常返回 true', okWrite === true);
ok('  ★ 大页面上也在 5 秒内完成', took < 5000, `${took} ms`);
ok('  ★ stuck-page.txt 真的写出来了', fs.existsSync(path.join(OUT, 'logs', 'stuck-page.txt')));

if (fs.existsSync(path.join(OUT, 'logs', 'stuck-page.txt'))) {
  const txt = fs.readFileSync(path.join(OUT, 'logs', 'stuck-page.txt'), 'utf8');
  ok('  ★ 认出了那个"发送验证码"入口', txt.includes('通过电子邮件发送帐户验证码至'), '');
  ok('  ★ 也列出了账号找回那个入口（好判断有没有认错）', txt.includes('我已无法访问'), '');
  // 大页面的可见文本会很长，但必须被截断，不能把文件撑爆
  const txtSize = fs.statSync(path.join(OUT, 'logs', 'stuck-page.txt')).size;
  ok('  ★ 输出有大小上限（不会把文件撑爆）', txtSize < 200 * 1024, `${Math.round(txtSize / 1024)}KB`);
  console.log('  ── 可点击元素那一段 ──');
  const m = txt.split('可点击元素')[1] || '';
  for (const line of m.split('\n').slice(0, 8)) console.log(`     ${line}`);
}

await browser.close();
if (fs.existsSync(path.join(OUT, 'logs', 'stuck-page.json'))) {
  console.log(`  json 大小 ${Math.round(fs.statSync(path.join(OUT, 'logs', 'stuck-page.json')).size / 1024)}KB`);
}

console.log(`\n── 结果：${pass} 通过 / ${fails.length} 失败 ──`);
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  · ' + f); }
fs.rmSync(OUT, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
