/**
 * 页面结构检查工具
 *
 * 用途：Steam 改版导致 worker 找不到元素时，用这个把页面的真实结构 dump 出来，
 *       照着输出改 steam.mjs 里的选择器即可，不用瞎猜。
 *
 * 用法：
 *   node inspect.mjs                                 默认看改密向导首页
 *   node inspect.mjs "https://help.steampowered.com/"  看任意页面
 *   node inspect.mjs --headed                        带界面打开（能顺便手动登录后再看后续页面）
 */
import { chromium } from 'playwright-core';
import { loadConfig } from './config.mjs';

const argv = process.argv.slice(2);
const headed = argv.includes('--headed');
const url = argv.find((a) => a.startsWith('http'))
  || 'https://help.steampowered.com/zh-cn/wizard/HelpChangePassword';

const cfg = loadConfig([]);

async function launch() {
  for (const ch of [cfg.browserChannel, 'chrome', 'msedge'].filter(Boolean)) {
    try {
      return await chromium.launch({ channel: ch, headless: !headed });
    } catch { /* 试下一个 */ }
  }
  throw new Error('没有可用浏览器（需要 Chrome 或 Edge）');
}

const browser = await launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

console.log(`打开：${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => {
  console.log('导航出错：', e.message);
});
await page.waitForTimeout(3000);

/** 打印当前页面的结构；带界面时可以登录后再调一次 */
async function dump(tag) {
  console.log(`\n${'='.repeat(60)}\n${tag}\n${'='.repeat(60)}`);

  const info = await page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight);
    const labelOf = (el) => {
      if (el.id) {
        const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (byFor) return byFor.innerText.trim();
      }
      const wrapped = el.closest('label');
      if (wrapped) return wrapped.innerText.trim();
      const al = el.getAttribute('aria-label');
      if (al) return al;
      const lb = el.getAttribute('aria-labelledby');
      if (lb && document.getElementById(lb)) return document.getElementById(lb).innerText.trim();
      const prev = el.previousElementSibling;
      return prev && prev.innerText ? prev.innerText.trim() : '';
    };
    return {
      url: location.href,
      title: document.title,
      inputs: Array.from(document.querySelectorAll('input, textarea, select')).filter(vis).map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        id: el.id || '',
        label: labelOf(el).slice(0, 50),
      })),
      buttons: Array.from(document.querySelectorAll('button, input[type=submit], [role=button], a.btn'))
        .filter(vis)
        .map((el) => ({
          text: (el.innerText || el.value || '').trim().slice(0, 50),
          type: el.getAttribute('type') || '',
        }))
        .filter((b) => b.text),
      checkboxes: Array.from(document.querySelectorAll('[role=checkbox], input[type=checkbox]'))
        .filter(vis)
        .map((el) => ({ role: el.getAttribute('role') || 'checkbox', checked: el.getAttribute('aria-checked') || el.checked })),
      text: (document.body.innerText || '').replace(/\n{2,}/g, '\n').trim().slice(0, 800),
      frames: 0,
    };
  });

  console.log(`URL  : ${info.url}`);
  console.log(`标题 : ${info.title}`);
  console.log(`frame: ${page.frames().length} 个（>1 说明有 iframe，选择器要进 frame）`);

  console.log(`\n可见输入框 (${info.inputs.length}):`);
  for (const i of info.inputs) {
    console.log(`  <${i.tag} type=${i.type || '-'} id=${i.id || '-'}>  label=「${i.label}」`);
  }

  console.log(`\n可见按钮 (${info.buttons.length}):`);
  for (const b of info.buttons) console.log(`  「${b.text}」 type=${b.type || '-'}`);

  console.log(`\n复选框 (${info.checkboxes.length}): ${JSON.stringify(info.checkboxes)}`);
  console.log(`\n可见文本:\n${info.text}\n`);

  const file = `inspect-${Date.now()}.png`;
  await page.screenshot({ path: file }).catch(() => {});
  console.log(`截图：${file}`);
}

await dump('当前页面结构');

if (headed) {
  console.log('\n带界面模式：你现在可以在浏览器里操作。');
  console.log('每按一次回车，就 dump 一次当前页面结构（方便看登录之后的页面）。');
  console.log('输入 q 回车退出。\n');
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  let n = 0;
  for await (const line of process.stdin) {
    if (line.trim().toLowerCase() === 'q') break;
    n += 1;
    await dump(`第 ${n} 次 dump`);
  }
}

await browser.close();
