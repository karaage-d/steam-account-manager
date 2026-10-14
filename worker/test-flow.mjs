/**
 * 改密流程测试。
 *
 *   [A] 旧行为（一次性 fill，不留等待）  → 必须失败（复现那个 bug）
 *   [B] 当前默认节奏                      → 必须成功
 *   [C] 改密成功后会话失效被踢回登录页    → 必须秒判成功，不能干等超时
 *   [D] 登录遇到 Steam Guard 验证码       → 自动取码填入；取不到要转人工
 *
 * A/B 的原理：模拟页的内部 state 用 setTimeout 延迟更新（模拟 React 的异步状态），
 * 提交时立刻读取 state。填太快 → state 还空着 → 判「输入的密码无效」。
 * 这正是当初真实遇到、并导致一次改密失败的故障。
 *
 * 需要系统里装有 Chrome 或 Edge。不需要 Steam 账号，也不需要真实邮箱。
 *
 *   node test-flow.mjs
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { PORT, GUARD_CODE, GUARD_CODE2, guardStyle } from './test-mock-steam.mjs';
import { changeSteamPassword, doLogin, reachNewPasswordForm } from './steam.mjs';

const WIZARD = `http://127.0.0.1:${PORT}/wizard`;
const OUT = path.join(os.tmpdir(), 'worker-flowtest');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
const fails = [];
const ok = (n, c, e = '') => {
  if (c) { pass += 1; console.log(`  \u2713 ${n}`); }
  else { fails.push(n + (e ? ` — ${e}` : '')); console.log(`  \u2717 ${n}${e ? ' — ' + e : ''}`); }
};

const baseCfg = {
  headless: true,
  browserChannel: 'chrome',
  slowMoMs: 0,
  keepLoggedIn: false,
  stopAfterLogin: false,
  pauseBeforeSubmit: false,
  assistMinutes: 1,
  // 输入节奏（run() 里会按用例覆盖，doLogin 也依赖这些值）
  typeDelayMs: 45,
  fieldSettleMs: 400,
  submitSettleMs: 1200,
  // ★ 故意开成 true：验证「保持浏览器打开」不会阻塞失败上报 ★
  keepBrowserOpenOnError: true,
  keepBrowserOpenSecs: 8,
  verifyTimeoutMs: 8000,
  // 验证码可以填几轮（Steam 有时会要两次）
  maxCodeRounds: 3,
  maxResends: 2,
  autoCode: true,
  outDir: OUT,
  showPassword: false,
};

const NEW_PW = 'AdlqZ3YxEdxC';

async function run(label, timing, expectOk, opts = {}) {
  const mode = opts.mode || 'text';
  console.log(`\n${label}`);
  console.log(`  节奏: typeDelay=${timing.typeDelayMs}ms  fieldSettle=${timing.fieldSettleMs}ms  submitSettle=${timing.submitSettleMs}ms`);
  console.log(`  成功表现: ${mode === 'logout' ? '会话失效被踢回登录页（Steam 的真实行为）' : '页面显示「密码已更改」'}`);
  await fetch(`http://127.0.0.1:${PORT}/__reset`).catch(() => {});

  process.env.STEAM_WIZARD_URL = `${WIZARD}?mode=${mode}`;
  const cfg = { ...baseCfg, ...timing };
  const logs = [];

  let result = null;
  let error = null;
  const tRun = Date.now();
  try {
    result = await changeSteamPassword({
      username: 'mock_user_01',
      currentPassword: 'whatever',
      email: '',
      newPassword: NEW_PW,
      cfg,
      log: (m) => { logs.push(String(m)); },
      onProgress: async () => {},
    });
  } catch (e) {
    error = e;
    logs.push('ERROR: ' + e.message);
  }
  const elapsedMs = Date.now() - tRun;

  const report = await (await fetch(`http://127.0.0.1:${PORT}/__last`)).json();
  const succeeded = !!result?.ok;
  const reported = report?.ok === true;

  console.log(`  脚本判定: ${succeeded ? '成功' : '失败'}${error ? ` （${error.message.split('\n')[0]}）` : ''}`);
  console.log(`  耗时: ${(elapsedMs / 1000).toFixed(1)} 秒`);
  console.log(`  模拟页看到: DOM=[${report?.dom1}, ${report?.dom2}]  state=[${report?.state1}, ${report?.state2}]`);
  console.log(`  页面是否接受: ${reported ? '接受（显示「密码已更改」）' : '拒绝（显示「输入的密码无效」）'}`);

  // ★ 回归点：keepBrowserOpenOnError=true 时，失败也必须立刻上报，不能阻塞 ★
  if (!expectOk) {
    ok(`  失败立刻上报，没有被「保持浏览器打开」阻塞（${(elapsedMs / 1000).toFixed(1)} 秒）`,
      elapsedMs < 15000,
      `${(elapsedMs / 1000).toFixed(1)} 秒 —— 说明还在阻塞等待`);
  }

  // ★ 回归点：改密成功后被踢回登录页时，必须靠 URL/会话信号秒判，不能干等超时 ★
  if (expectOk && mode === 'logout') {
    const hit = logs.find((l) => /检测到成功：/.test(l));
    ok('  检测到了成功（没有被登录页迷惑）', !!hit, hit || '(四路信号一路都没命中)');
    ok('  靠「会话失效/URL 变化」判定，而不是等文案',
      /会话已失效|离开改密向导/.test(hit || ''), hit || '');
    ok(`  秒级识别，没有干等超时（${(elapsedMs / 1000).toFixed(1)} 秒，超时阈值 ${baseCfg.verifyTimeoutMs / 1000} 秒）`,
      elapsedMs < baseCfg.verifyTimeoutMs,
      `耗时 ${(elapsedMs / 1000).toFixed(1)} 秒 ≥ 超时阈值，说明信号没命中`);
  }

  if (expectOk) {
    ok('  模拟页接受了这次提交', reported, `DOM/state 不一致`);
    ok('  state 里拿到了正确的新密码', report?.state1 === NEW_PW && report?.state2 === NEW_PW,
      `state=[${report?.state1}, ${report?.state2}]`);
    ok('  脚本报告成功', succeeded);
  } else {
    ok('  模拟页拒绝了这次提交（成功复现 bug）', !reported);
    ok('  state 没跟上（证明这就是竞态）',
      report && (report.state1 !== report.dom1 || report.state2 !== report.dom2),
      `DOM=[${report?.dom1}, ${report?.dom2}] state=[${report?.state1}, ${report?.state2}]`);
    ok('  脚本没有误报成功', !succeeded);
  }
  return { succeeded, reported, report, logs };
}

console.log('\n── 复现 + 验证：输入节奏对改密成败的影响 ──');

// A. 旧行为：一次性填充，不留任何等待
await run('[A] 旧行为（fill + 立刻提交）', {
  typeDelayMs: 0, fieldSettleMs: 0, submitSettleMs: 0,
}, false);

// B. 新默认节奏
const b = await run('[B] 新默认节奏（逐字符输入 + 等待）', {
  typeDelayMs: 45, fieldSettleMs: 400, submitSettleMs: 1200,
}, true);

// C. 改密成功后被踢回登录页（Steam 的真实行为）
const c = await run('[C] 改密成功后会话失效、被踢回登录页', {
  typeDelayMs: 45, fieldSettleMs: 400, submitSettleMs: 1200,
}, true, { mode: 'logout' });

console.log('\n[B] 的关键日志:');
for (const l of b.logs.filter((x) => /已填入|已点击提交|回读/.test(x))) console.log('   ', l.trim());

console.log('\n[C] 的关键日志:');
for (const l of c.logs.filter((x) => /检测到成功/.test(x))) console.log('   ', l.trim());

/* ------------------------------------------------------------------ */
/* [D] 登录遇到验证码：自动取码 → 填入 → 提交                            */
/* ------------------------------------------------------------------ */

async function runGuardCase(label, {
  autoCode, codeFromMail, timeoutMs = 18000, pagePath = '/login/guard',
}) {
  console.log(`\n${label}`);
  await fetch(`http://127.0.0.1:${PORT}/__reset`).catch(() => {});

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext({ locale: 'zh-CN' })).newPage();
  await page.goto(`http://127.0.0.1:${PORT}${pagePath}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);

  const logs = [];
  const calls = [];
  const api = {
    fetchCode: async (accountId, opts) => {
      calls.push({ accountId, opts });
      // 传数组时按顺序返回（模拟"每一轮都是一封新邮件"）
      const list = Array.isArray(codeFromMail) ? codeFromMail : [codeFromMail];
      const code = list[Math.min(calls.length - 1, list.length - 1)];
      if (code === null || code === undefined) return { code: null, reason: 'no_mail' };
      return { code, confidence: 'high', source: '关键词锚定' };
    },
  };

  let error = null;
  const t0 = Date.now();
  try {
    await doLogin(page, {
      api, accountId: 42, username: 'mock_user', currentPassword: 'mock-pw',
      cfg: { ...baseCfg, autoCode, codeWaitSec: 5, loginTimeoutMs: timeoutMs },
      log: (m) => logs.push(String(m)),
      onProgress: async () => {},
    });
  } catch (e) { error = e; }
  const took = Date.now() - t0;

  const url = page.url();
  const report = await (await fetch(`http://127.0.0.1:${PORT}/__last`)).json();
  const events = await (await fetch(`http://127.0.0.1:${PORT}/__events`)).json();
  await browser.close();

  console.log(`  耗时 ${(took / 1000).toFixed(1)} 秒   最终 URL: ${url}`);
  console.log(`  取码调用 ${calls.length} 次   事件: ${events.map((e) => e.step).join(', ')}`);
  return { error, url, report, logs, calls, took, events };
}

console.log('\n── [D] 登录验证码：自动取码 ──');

const d1 = await runGuardCase('[D1] 邮箱里能取到码 → 自动填入并登录成功', {
  autoCode: true, codeFromMail: GUARD_CODE,
});
ok('  没有报错', !d1.error, d1.error?.message);
ok('  ★ 自动取码被调用了', d1.calls.length >= 1, `${d1.calls.length} 次`);
ok('  把账号 id 传下去了', d1.calls[0]?.accountId === 42, String(d1.calls[0]?.accountId));
ok('  ★ 验证码被填进了页面', d1.report?.code === GUARD_CODE, JSON.stringify(d1.report));
ok('  ★ 登录成功（URL 已离开 /login）', !/\/login/i.test(d1.url), d1.url);
ok('  日志里说了取到了码', d1.logs.some((l) => /取到验证码/.test(l)),
  d1.logs.filter((l) => /验证码|取码/.test(l)).join(' | '));

const d2 = await runGuardCase('[D2] 邮箱里取不到码 → 必须转人工，不能静默卡死', {
  autoCode: true, codeFromMail: null, timeoutMs: 13000,
});
ok('  没有自动取到时不误判成功', !!d2.error || /\/login/i.test(d2.url), d2.url);
ok('  明确说了没取到码', d2.logs.some((l) => /没找到(新)?验证码/.test(l)));
ok('  给出了「手动完成验证码」的提示',
  d2.logs.some((l) => /手动完成验证码|手动输入/.test(l)),
  d2.logs.filter((l) => /手动|没找到/.test(l)).join(' | '));
ok('  只尝试取码一次，不反复轰炸邮箱', d2.calls.length === 1, `${d2.calls.length} 次`);

const d3 = await runGuardCase('[D3] AUTO_CODE=false → 完全不碰邮箱', {
  autoCode: false, codeFromMail: GUARD_CODE, timeoutMs: 7000,
});
ok('  ★ 一次都没调用取码接口', d3.calls.length === 0, `${d3.calls.length} 次`);

// ★ 真机踩过的场景：验证码框没有任何可识别的特征属性 ★
//   旧版 detectCodeField 只认 name/id/maxlength/placeholder 这些，
//   遇到裸的 <input type="text"> 就完全认不出来 —— worker 只是干等，全程不碰邮箱，
//   看起来像"自动取码功能没生效"。
guardStyle.mode = 'bare';
const d4 = await runGuardCase('[D4] ★ 验证码框没有任何特征属性（裸 <input text>）', {
  autoCode: true, codeFromMail: GUARD_CODE,
});
guardStyle.mode = 'obvious';
ok('  ★ 兜底逻辑认出了它', d4.calls.length >= 1, `取码调用 ${d4.calls.length} 次`);
ok('  ★ 验证码被填进去了', d4.report?.code === GUARD_CODE, JSON.stringify(d4.report));
ok('  ★ 登录成功', !/\/login/i.test(d4.url), d4.url);

// ★ 真机踩过的另一个场景：Steam 的验证码是 5 个独立的单字符框（看起来像 5 条短横线）★
//   旧逻辑要求"页面上只剩一个文本框"，遇到 5 个直接放弃 —— 认不出来。
guardStyle.mode = 'split';
const d5 = await runGuardCase('[D5] ★ 拆分的 5 个单字符框（自动跳格）', {
  autoCode: true, codeFromMail: GUARD_CODE,
});
guardStyle.mode = 'obvious';
ok('  ★ 认出了「5 格」形态', d5.calls.length >= 1, `取码调用 ${d5.calls.length} 次`);
ok('  ★ 整串打进第一格后自动跳格，拼出完整验证码',
  d5.report?.code === GUARD_CODE, JSON.stringify(d5.report));
ok('  ★ 登录成功', !/\/login/i.test(d5.url), d5.url);

// 不自动跳格的情况 —— 整串打法会失效，必须靠"逐格填"兜底
guardStyle.mode = 'split-static';
const d6 = await runGuardCase('[D6] ★ 拆分的 5 格，但不自动跳格（考验逐格填）', {
  autoCode: true, codeFromMail: GUARD_CODE,
});
guardStyle.mode = 'obvious';
ok('  ★ 逐格填兜底生效', d6.report?.code === GUARD_CODE, JSON.stringify(d6.report));
ok('  ★ 登录成功', !/\/login/i.test(d6.url), d6.url);

// ★★ 真机场景：第一轮验证码之后，Steam 又弹一屏要求"通过电子邮件发送账户验证码" ★★
//   那一屏有两个挨着的入口，都含「验证码」字样：
//     ① 通过电子邮件发送账户验证码至 xxx                 ← 要点这个
//     ② 我已无法访问此电子邮件地址，或是没有收到验证码     ← 账号找回，点了算失败
const d7 = await runGuardCase('[D7] ★ 两轮验证码：自动点「通过电子邮件发送…」再取一次', {
  autoCode: true, codeFromMail: [GUARD_CODE, GUARD_CODE2], pagePath: '/login/guard2',
  timeoutMs: 40000,
});
ok('  ★ 两次都去邮箱取了码', d7.calls.length >= 2, `${d7.calls.length} 次`);
ok('  ★ 第一轮的码提交了', d7.events.some((e) => e.step === 'code' && e.round === 1 && e.code === GUARD_CODE),
  JSON.stringify(d7.events));
ok('  ★ 自动点了「重新发送」入口', d7.events.some((e) => e.step === 'resend-clicked'),
  JSON.stringify(d7.events.map((e) => e.step)));
ok('  ★ 第二轮的码也提交了（用的是新码）',
  d7.events.some((e) => e.step === 'code' && e.round === 2 && e.code === GUARD_CODE2),
  JSON.stringify(d7.events));
ok('  ★★★ 没有误点「我已无法访问此电子邮件地址」（账号找回）',
  !d7.events.some((e) => /RECOVERY-CLICKED/.test(e.step)),
  JSON.stringify(d7.events.map((e) => e.step)));
ok('  ★ 最终登录成功', !/\/login/i.test(d7.url), d7.url);
ok('  日志里说明了第几轮', d7.logs.some((l) => /第 2 次/.test(l)),
  d7.logs.filter((l) => /第 \d 次|重新发送/.test(l)).join(' | '));

/* ------------------------------------------------------------------ */
/* [E] 「主页 > 发送代码」那一屏（URL 不在 /login 下）                   */
/* ------------------------------------------------------------------ */

// ★ 真机踩过的坑 ★
//   填完第一个码后 URL 变成向导页（不含 /login），doLogin 直接返回；
//   而"点发送验证码"的逻辑当时写在 doLogin 里 —— 于是那一屏根本没人管，脚本干等。
//   现在这段逻辑搬到了 reachNewPasswordForm，这个用例专门守着。
async function runSendCodeCase() {
  console.log('\n[E] ★ 「主页 > 发送代码」那一屏（向导页，不在 /login 下）');
  await fetch(`http://127.0.0.1:${PORT}/__reset`).catch(() => {});

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext({ locale: 'zh-CN' })).newPage();
  await page.goto(`http://127.0.0.1:${PORT}/wizard/sendcode`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);

  const logs = [];
  const calls = [];
  const api = {
    fetchCode: async (accountId, opts) => {
      calls.push({ accountId, opts });
      return { code: GUARD_CODE2, confidence: 'high', source: '关键词锚定' };
    },
  };

  let form = null;
  let error = null;
  const t0 = Date.now();
  try {
    form = await reachNewPasswordForm(page, {
      api, accountId: 42, cfg: { ...baseCfg, assistMinutes: 1 }, log: (m) => logs.push(String(m)),
      onProgress: async () => {}, since: Math.floor(Date.now() / 1000) - 60,
    });
  } catch (e) { error = e; }
  const took = Date.now() - t0;

  const events = await (await fetch(`http://127.0.0.1:${PORT}/__events`)).json();
  await browser.close();

  console.log(`  耗时 ${(took / 1000).toFixed(1)} 秒   事件: ${events.map((e) => e.step).join(', ')}`);
  for (const l of logs.filter((x) => /点击|验证码|改密表单/.test(x))) console.log(`    ${l.trim()}`);
  return { form, error, events, logs, calls, took };
}

const e1 = await runSendCodeCase();
ok('  没有报错', !e1.error, e1.error?.message);
ok('  ★★★ 没有误点「我已无法访问此电子邮件地址」（账号找回）',
  !e1.events.some((e) => /RECOVERY-CLICKED/.test(e.step)),
  JSON.stringify(e1.events.map((x) => x.step)));
ok('  ★ 自动点了「通过电子邮件发送帐户验证码至…」',
  e1.events.some((e) => e.step === 'resend-clicked'), JSON.stringify(e1.events.map((x) => x.step)));
ok('  ★ 又去邮箱取了码', e1.calls.length >= 1, `${e1.calls.length} 次`);
ok('  ★ 第二个码填进去并提交了',
  e1.events.some((e) => e.step === 'code' && e.code === GUARD_CODE2), JSON.stringify(e1.events));
ok('  ★ 最终进入了改密表单（两个密码框）', !!e1.form, JSON.stringify(e1.form));
ok('  日志里说明了它在点什么', e1.logs.some((l) => /通过电子邮件发送/.test(l)),
  e1.logs.filter((l) => /点击/.test(l)).join(' | '));

/* ------------------------------------------------------------------ */
/* [F] 表单由 JS 延迟渲染的登录页（真机就是 React 这么干的）             */
/* ------------------------------------------------------------------ */

// ★ 真机踩过的坑 ★
//   help.steampowered.com 的登录页 HTML 里一个 <input> 都没有，
//   表单是 React 客户端渲染进去的。拿到页面就找输入框会扑空 → 报"找不到账号输入框"。
//   之前偶尔能成，纯粹是页面恰好已渲染完 —— 时序竞态。
console.log('\n[F] ★ 登录表单由 JS 延迟 1.2 秒才渲染出来');
await fetch(`http://127.0.0.1:${PORT}/__reset`).catch(() => {});
{
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext({ locale: 'zh-CN' })).newPage();
  await page.goto(`http://127.0.0.1:${PORT}/login/lazy`, { waitUntil: 'domcontentloaded' });

  // 先确认这一刻真的还没有输入框（否则这个测试就没有意义了）
  const inputsAtStart = await page.locator('input').count();

  const logs = [];
  let error = null;
  const t0 = Date.now();
  try {
    await doLogin(page, {
      api: { fetchCode: async () => ({ code: null }) },
      accountId: 42, username: 'lazy_user', currentPassword: 'lazy-pw',
      cfg: { ...baseCfg, autoCode: false, loginFormWaitMs: 15000, loginTimeoutMs: 20000 },
      log: (m) => logs.push(String(m)),
      onProgress: async () => {},
    });
  } catch (e) { error = e; }
  const took = Date.now() - t0;
  const url = page.url();
  const report = await (await fetch(`http://127.0.0.1:${PORT}/__last`)).json();
  await browser.close();

  console.log(`  页面刚加载时输入框数: ${inputsAtStart}   耗时 ${(took / 1000).toFixed(1)} 秒`);
  console.log(`  最终 URL: ${url}   上报: ${JSON.stringify(report)}`);

  ok('  这个页面初始确实没有输入框（测试前提成立）', inputsAtStart === 0, `${inputsAtStart} 个`);
  ok('  ★★★ 等到了表单渲染出来，没有报错', !error, error?.message);
  ok('  ★ 账号密码都填进去了', report?.username === 'lazy_user' && report?.password === 'lazy-pw',
    JSON.stringify(report));
  ok('  ★ 登录成功（跳离了登录页）', !/\/login/i.test(url), url);
  ok('  日志里说明了在等表单', logs.some((l) => /等它出现|还没渲染/.test(l)),
    logs.filter((l) => /渲染|等/.test(l)).join(' | '));
}

/* ------------------------------------------------------------------ */
/* [G] 完整 6 步向导：二选一那一屏在 /login 之外                         */
/* ------------------------------------------------------------------ */

// ★★ 真机踩得最惨的一次 ★★
//   流程：1 账号密码 → 2 验证码 → 3 ★二选一（URL 已不含 /login）★ → 4 验证码 → 5/6 改密表单
//   旧逻辑：doLogin 一看到 URL 没有 /login 就 return，把第 3 步丢给 reachNewPasswordForm；
//          而第 3 步常常在 doLogin 还活着的时候就出现 —— 两边都不管，卡在二选一那屏不动。
//   这个用例要求 doLogin 一路走到改密表单。
const g1 = await runGuardCase('[G] ★ 完整向导：二选一在 /login 之外也能自动走完', {
  autoCode: true, codeFromMail: [GUARD_CODE, GUARD_CODE2], pagePath: '/login/guard3',
  timeoutMs: 60000,
});
ok('  ★ 第一个码提交了', g1.events.some((e) => e.step === 'code' && e.code === GUARD_CODE),
  JSON.stringify(g1.events));
ok('  ★★★ 自动点了「通过电子邮件发送帐户验证码至…」',
  g1.events.some((e) => e.step === 'resend-clicked'),
  JSON.stringify(g1.events.map((e) => e.step)));
ok('  ★ 第二个码也提交了', g1.events.some((e) => e.step === 'code' && e.code === GUARD_CODE2),
  JSON.stringify(g1.events));
ok('  ★★★ 没有误点「我已无法访问此电子邮件地址」（账号找回）',
  !g1.events.some((e) => /RECOVERY-CLICKED/.test(e.step)),
  JSON.stringify(g1.events.map((e) => e.step)));
ok('  ★ 两次取码都发生了', g1.calls.length >= 2, `${g1.calls.length} 次`);
ok('  ★ doLogin 一直走到改密表单才返回（没有中途"登录通过"就溜走）',
  g1.logs.some((l) => /已到达改密表单/.test(l)),
  g1.logs.filter((l) => /改密表单|登录通过/.test(l)).join(' | '));
ok('  日志里说明了点的是二选一界面', g1.logs.some((l) => /二选一界面/.test(l)),
  g1.logs.filter((l) => /二选一|点击/.test(l)).join(' | '));

console.log(`\n── 结果：${pass} 通过 / ${fails.length} 失败 ──`);if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  · ' + f); }
console.log('');
process.exit(fails.length ? 1 : 0);
