/**
 * 验证：detectNewPasswordForm 会不会在没有改密表单的页面上误判？
 *
 * 背景：doLogin 的循环开头加了 `if (await detectNewPasswordForm(page)) return;`。
 * 如果它在登录页就返回真，doLogin 第一轮直接退出 —— 一个验证码都不填。
 */
import { chromium } from 'playwright-core';
import { detectNewPasswordForm, detectCodeField, clickSendCodeOption, fillSplitCode } from './steam.mjs';

const pages = {
  '登录页（1 个密码框 + 按钮）': `<!doctype html><html><body>
    <div>Steam 客服中心</div>
    <form>
      <label for="u">用帐户名称登录</label><input id="u" type="text">
      <label for="p">密码</label><input id="p" type="password">
      <button type="submit">登录</button>
    </form>
    <div>查看桌面版网站</div>
  </body></html>`,

  '5 格验证码页（无密码框）': `<!doctype html><html><body>
    <div>请输入 Steam Guard 验证码</div>
    <div>${Array.from({ length: 5 }, (_, i) => `<input data-i="${i}" type="text" maxlength="1">`).join('')}</div>
    <button>提交</button>
  </body></html>`,

  '二选一页（无输入框）': `<!doctype html><html><body>
    <h2>您希望如何更改您的密码？</h2>
    <div style="cursor:pointer">通过电子邮件发送帐户验证码至 h***@i***.c**</div>
    <div style="cursor:pointer">我已无法访问此电子邮件地址，或是没有收到验证码</div>
  </body></html>`,

  '改密表单（2 个密码框）': `<!doctype html><html><body>
    <div>更改我的密码</div>
    <input type="password" autocomplete="new-password">
    <div>再次输入新密码</div>
    <input type="password" autocomplete="new-password">
    <button>更改密码</button>
  </body></html>`,
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ locale: 'zh-CN' })).newPage();

let pass = 0; const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name} — ${extra}`); console.log(`  ✗ ${name} — ${extra}`); }
};

const got = {};
console.log('页面'.padEnd(32), 'detectNewPasswordForm      detectCodeField');
console.log('─'.repeat(78));
for (const [name, html] of Object.entries(pages)) {
  await page.setContent(html);
  await page.waitForTimeout(150);
  const form = await detectNewPasswordForm(page).catch((e) => ({ err: e.message }));
  const code = await detectCodeField(page).catch((e) => ({ err: e.message }));
  got[name] = { form, code };
  const fDesc = form?.err ? `ERR ${form.err}` : (form ? `★返回值 mode=${form.mode}` : 'null');
  const cDesc = code?.err ? `ERR ${code.err}` : (code ? (code.kind === 'split' ? `${code.boxes.length}格` : '单框') : 'null');
  console.log(name.padEnd(32), fDesc.padEnd(26), cDesc);
}

console.log('');
// ★★★ 这就是造成"验证码都不填了"的那条回归 ★★★
ok('★★★ 登录页不会被误判成改密表单（否则 doLogin 第一轮就退出，码一个都不填）',
  !got['登录页（1 个密码框 + 按钮）'].form,
  JSON.stringify(got['登录页（1 个密码框 + 按钮）'].form));
ok('  登录页也认不出验证码框（还没到那一步）',
  !got['登录页（1 个密码框 + 按钮）'].code);
ok('  5 格验证码页认得出 5 格', got['5 格验证码页（无密码框）'].code?.kind === 'split'
  && got['5 格验证码页（无密码框）'].code.boxes.length === 5);
ok('  5 格验证码页不会被当成改密表单', !got['5 格验证码页（无密码框）'].form);
ok('  二选一页既不是验证码框也不是改密表单',
  !got['二选一页（无输入框）'].code && !got['二选一页（无输入框）'].form);
ok('  真正的改密表单认得出（两个密码框）',
  got['改密表单（2 个密码框）'].form?.mode === '两个密码框',
  JSON.stringify(got['改密表单（2 个密码框）'].form));

// 单个密码框 + 页面上写着"新密码" —— 这种也算改密表单
await page.setContent(`<!doctype html><html><body>
  <div>设置新密码</div><input type="password" id="np"><button>保存</button></body></html>`);
await page.waitForTimeout(150);
const single = await detectNewPasswordForm(page).catch(() => null);
ok('  单密码框 + 页面写了「新密码」→ 认作改密表单', !!single, JSON.stringify(single));

// 单个密码框但页面没写"新密码" —— 不算（登录页就是这种）
await page.setContent(`<!doctype html><html><body>
  <div>请输入密码</div><input type="password" id="p"><button>登录</button></body></html>`);
await page.waitForTimeout(150);
const notForm = await detectNewPasswordForm(page).catch(() => null);
ok('★ 单密码框但没写「新密码」→ 不算改密表单（登录页）', !notForm, JSON.stringify(notForm));

/* ------------------------------------------------------------------ */
/* 点「二选一」那一项                                                    */
/* ------------------------------------------------------------------ */

// ★ 真机那一屏的形状：两个 cursor:pointer 的 div ★
//   而且故意加一层覆盖元素挡住 —— Playwright 的 locator.click() 会因为"被遮挡"失败，
//   页面内原生 target.click() 不受影响。这正是"和点登录键一样"的做法。
const CHOICE_HTML = `<!doctype html><html><body>
  <div id="wrap" style="position:relative">
    <div style="position:absolute;inset:0;z-index:9"></div>
    <div id="a" style="cursor:pointer;padding:18px;background:#2a475e"
         onclick="window.__hit=window.__hit||[];window.__hit.push('send')">
      通过电子邮件发送帐户验证码至 h*******_********@i*****.c**
    </div>
    <div id="b" style="cursor:pointer;padding:18px;background:#2a475e"
         onclick="window.__hit=window.__hit||[];window.__hit.push('recovery')">
      我已无法访问此电子邮件地址，或是没有收到验证码
    </div>
  </div>
</body></html>`;

await page.setContent(CHOICE_HTML);
await page.waitForTimeout(150);
const logs2 = [];
const r1 = await clickSendCodeOption(page, { submitSettleMs: 100 }, (m) => logs2.push(String(m)));
const hit1 = await page.evaluate(() => window.__hit || []);

ok('★★★ 点中了「通过电子邮件发送帐户验证码至…」（有遮挡元素也点得中）', hit1.includes('send'),
  JSON.stringify(hit1));
ok('★★★ 没有点「我已无法访问此电子邮件地址」（账号找回）', !hit1.includes('recovery'),
  JSON.stringify(hit1));
ok('  返回 true', r1 === true, JSON.stringify(r1));
ok('  日志里说了点击结果', logs2.some((l) => /已点击|点击/.test(l)), logs2.join(' | '));
console.log('  ── 它的日志 ──');
for (const l of logs2) console.log(`     ${l.trim()}`);

// 页面上只有「账号找回」那一项时 —— 什么都不许点
await page.setContent(`<!doctype html><html><body>
  <div style="cursor:pointer;padding:18px"
       onclick="window.__hit2=(window.__hit2||0)+1">我已无法访问此电子邮件地址，或是没有收到验证码</div>
</body></html>`);
await page.waitForTimeout(150);
const logs3 = [];
const r2 = await clickSendCodeOption(page, { submitSettleMs: 100 }, (m) => logs3.push(String(m)));
const hit2 = await page.evaluate(() => window.__hit2 || 0);
ok('★ 只有「账号找回」那一项时，什么都不点', hit2 === 0, `点了 ${hit2} 次`);
ok('  并且如实报告没找到', r2 === false, JSON.stringify(r2));
ok('  日志说明了原因', logs3.some((l) => /找不到/.test(l)), logs3.join(' | '));

/* ------------------------------------------------------------------ */
/* 填 5 格验证码：填满后页面自动跳走时，不能卡在"回读"上                */
/* ------------------------------------------------------------------ */

// ★ 真机踩过的坑 ★
//   Steam 的 5 格验证码填满会**自动提交**，页面立刻跳走。
//   这时候再去读那 5 个格子，元素已经不存在 —— inputValue() 默认等 30 秒，
//   5 个格子就是 150 秒白等。日志里表现为"一直卡在：填验证码：回读校验"，
//   看起来像卡死，实际是它到了二选一界面却没机会去点。
console.log('\n[填 5 格] 填满后页面自动跳转的情况');

const AUTO_SUBMIT_HTML = `<!doctype html><html><body>
  <div>请输入 Steam Guard 验证码</div>
  <div id="boxes">
    <input data-i="0" type="text" maxlength="1">
    <input data-i="1" type="text" maxlength="1">
    <input data-i="2" type="text" maxlength="1">
    <input data-i="3" type="text" maxlength="1">
    <input data-i="4" type="text" maxlength="1">
  </div>
<script>
  // 模拟 Steam：5 格填满立刻自动提交（跳到下一屏）
  document.querySelectorAll('#boxes input').forEach(function (el) {
    el.addEventListener('input', function () {
      var i = Number(el.getAttribute('data-i'));
      var next = document.querySelector('#boxes input[data-i="' + (i + 1) + '"]');
      if (el.value && next) next.focus();
      var all = Array.from(document.querySelectorAll('#boxes input'))
        .map(function (x) { return x.value; }).join('');
      if (all.length === 5) {
        // 跳到一个没有输入框的页面 —— 旧元素彻底消失
        setTimeout(function () { location.href = 'about:blank'; }, 80);
      }
    });
  });
</script>
</body></html>`;

// ★ 注意：必须让页面有一个"真实的 URL" ★
//   page.setContent() 之后 URL 还是 about:blank —— 如果模拟跳转也去 about:blank，
//   前后 URL 一模一样，"页面跳转检测"就永远不成立，测试会假失败。
//   先用 data: URL 打开，再 setContent，URL 就保持是 data:...，跳转才测得出来。
await page.goto('data:text/html,<html><body>placeholder</body></html>');
await page.setContent(AUTO_SUBMIT_HTML);
await page.waitForTimeout(200);
const urlAtStart = page.url();
const boxes = [];
for (let i = 0; i < 5; i += 1) boxes.push(page.locator(`#boxes input[data-i="${i}"]`));

const logs4 = [];
const t0 = Date.now();
const filled = await fillSplitCode(
  page, boxes, 'K4F7B',
  { typeDelayMs: 20, fieldSettleMs: 100 },
  (m) => logs4.push(String(m)),
);
const took = Date.now() - t0;

console.log(`  起始 URL ${urlAtStart.slice(0, 30)}…`);
console.log(`  耗时 ${(took / 1000).toFixed(1)} 秒   返回 ${filled}   最终 URL ${page.url().slice(0, 30)}`);
for (const l of logs4) console.log(`     ${l.trim()}`);

ok('★★★ 没有卡在回读上（5 格 × 30 秒默认超时的坑）', took < 8000, `${took} ms`);
ok('★ 返回 true（页面跳走说明填对了）', filled === true, String(filled));
ok('  日志里说了是"页面自动跳转"才算成功',
  logs4.some((l) => /自动跳转|已跳转/.test(l)), logs4.join(' | '));

await browser.close();
console.log(`\n── 结果：${pass} 通过 / ${fails.length} 失败 ──`);
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  · ' + f); }
process.exit(fails.length ? 1 : 0);
