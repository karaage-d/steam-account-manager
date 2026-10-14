/**
 * Steam 改密流程（Playwright）
 *
 * ⚠ 验证边界说明（重要，请先读）
 *   · 「打开页面」和「登录」两步，选择器是我**实测**过 Steam 真实页面得到的，可靠。
 *   · 「登录之后」的步骤（Steam Guard 验证、进入改密表单）我**无法预先测定** ——
 *     那需要真实账号和真实验证码。所以这部分的设计是：
 *         能自动走就自动走 → 走不通就请你手动操作 → 脚本持续检测，
 *         一旦发现「新密码表单」就自动接管，继续填密码、提交、校验。
 *   · 任何一步失败，都会把当前页面的输入框/按钮/文本 dump 出来并截图，
 *     你（或我）照着 dump 就能立刻把选择器补上。
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs/promises';

export const DEFAULT_WIZARD_URL = 'https://help.steampowered.com/zh-cn/wizard/HelpChangePassword';

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const firstLine = (s) => String(s || '').split('\n')[0].slice(0, 160);
const slug = (s) => String(s).replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 进度打点                                                            */
/* ------------------------------------------------------------------ */

/**
 * 当前正在做哪一步。
 *
 * 心跳每 10 秒把它打出来 —— 这样"卡住了"永远是明确的：
 * 屏幕上会一直刷「⏱ 仍在进行：正在填第 3 格验证码（已 42s）」，
 * 而不是像以前那样停在某一行让人猜。
 */
let CURRENT_STEP = '（未开始）';
const setStep = (s) => { CURRENT_STEP = String(s); };
export const getCurrentStep = () => CURRENT_STEP;

/**
 * 打点：**开始前**先打一行，结束或失败再打一行（带耗时）。
 *
 * ★ 关键是"开始前"就要打 ★
 *   只在成功之后打日志的话，一旦卡住，日志里就只剩上一行的记录，
 *   根本不知道到底进到哪一步了 —— 之前的排查全卡在这个问题上。
 */
async function trace(log, label, fn) {
  const t0 = Date.now();
  setStep(label);
  log(`  ▸ ${label}…`);
  try {
    const out = await fn();
    const ms = Date.now() - t0;
    // 快的不啰嗦，慢的才值得单独报一行
    log(`    ✓ ${label}${ms > 300 ? `（${(ms / 1000).toFixed(1)} 秒）` : ''}`);
    return out;
  } catch (e) {
    log(`    ✗ ${label} 失败（${((Date.now() - t0) / 1000).toFixed(1)} 秒）：${firstLine(e.message)}`);
    throw e;
  }
}

/**
 * ★ 把当前页面结构落盘 ★
 *
 * 为什么要写文件而不是只打日志：
 *   排查"明明有按钮却点不到"这类问题时，需要看的是真实的 DOM 细节
 *   （标签、role、aria-label、class、cursor、外层结构）。
 *   让它出现在控制台里，意味着要人工复制粘贴一大段 —— 实际很难拿到。
 *   写进文件后，直接打开就能看，也方便发给别人定位。
 *
 * 会写两份：
 *   logs/stuck-page.txt    给人看的摘要
 *   logs/stuck-page.json   完整结构化数据（含关键元素的 outerHTML）
 */
export async function dumpPageToFile(page, cfg, log, note = '') {
  try {
    const dir = path.resolve(cfg.outDir || '.', 'logs');
    await fs.mkdir(dir, { recursive: true });

    const data = await page.evaluate(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const attr = (el, n) => el.getAttribute(n) || '';
      // ★ 用 textContent 而不是 innerText ★
      //   innerText 会强制触发布局计算，对页面上几千个元素逐个调用会慢到超时
      //   （实测：evaluate 直接不返回，文件写不出来，成了"目录建了但没内容"）。
      //   textContent 不触发回流，快几个数量级。
      const txt = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
      const describe = (el) => ({
        tag: el.tagName.toLowerCase(),
        type: attr(el, 'type'),
        id: attr(el, 'id'),
        name: attr(el, 'name'),
        cls: String(el.className || '').slice(0, 120),
        role: attr(el, 'role'),
        ariaLabel: attr(el, 'aria-label'),
        maxlength: attr(el, 'maxlength'),
        autocomplete: attr(el, 'autocomplete'),
        placeholder: attr(el, 'placeholder'),
        cursor: (() => { try { return getComputedStyle(el).cursor; } catch { return ''; } })(),
        text: (txt(el) || el.value || '').slice(0, 160),
        visible: vis(el),
        outerHtml: (el.outerHTML || '').slice(0, 800),
      });

      const inputs = [...document.querySelectorAll('input, textarea, select')].map(describe);
      const buttons = [...document.querySelectorAll(
        'button, [role=button], [role=link], input[type=submit], input[type=button]',
      )].map(describe);
      const links = [...document.querySelectorAll('a')].map(describe);

      // 所有"看起来能点"的元素（含加样式冒充按钮的 div/span）。
      // 先按便宜的特征筛，再限制扫描量 —— 不做全量 innerText。
      const clickable = [];
      for (const el of document.querySelectorAll('a, button, [role=button], [role=link], [onclick], [tabindex], input[type=submit], input[type=button]')) {
        const t = txt(el);
        if (!t || t.length > 160) continue;
        clickable.push({ text: t, ...describe(el) });
      }
      const divs = [...document.querySelectorAll('div, span, li, td')].slice(0, 2500);
      for (const el of divs) {
        let cur = '';
        try { cur = getComputedStyle(el).cursor; } catch { continue; }
        if (cur !== 'pointer') continue;
        if (!vis(el)) continue;
        const t = txt(el);
        if (!t || t.length > 160) continue;
        clickable.push({ text: t, ...describe(el) });
      }

      return {
        url: location.href,
        title: document.title,
        bodyText: (document.body.textContent || '').replace(/\n{2,}/g, '\n').slice(0, 4000),
        inputs,
        buttons,
        links,
        clickable,
      };
    });

    data.note = note;
    data.at = new Date().toISOString();

    const lines = [];
    lines.push(`说明: ${note}`);
    lines.push(`时间: ${data.at}`);
    lines.push(`URL : ${data.url}`);
    lines.push(`标题: ${data.title}`);
    lines.push('');
    lines.push(`可见输入框 (${data.inputs.filter((i) => i.visible).length}/${data.inputs.length}):`);
    for (const i of data.inputs.filter((x) => x.visible)) {
      lines.push(`  <${i.tag} type=${i.type || '-'} id="${i.id}" name="${i.name}" maxlength="${i.maxlength}"`
        + ` autocomplete="${i.autocomplete}" placeholder="${i.placeholder}" aria-label="${i.ariaLabel}">`);
    }
    lines.push('');
    lines.push(`按钮 (${data.buttons.length}):`);
    for (const b of data.buttons) {
      lines.push(`  visible=${b.visible} <${b.tag} role="${b.role}" aria-label="${b.ariaLabel}" class="${b.cls}"> 文字=「${b.text}」`);
      lines.push(`     html: ${b.outerHtml}`);
    }
    lines.push('');
    lines.push(`链接 (${data.links.filter((l) => l.visible).length}/${data.links.length}):`);
    for (const l of data.links.filter((x) => x.visible)) {
      lines.push(`  <a class="${l.cls}"> 文字=「${l.text}」`);
      lines.push(`     html: ${l.outerHtml}`);
    }
    lines.push('');
    lines.push(`可点击元素 (${data.clickable.length}):`);
    for (const c of data.clickable) {
      lines.push(`  <${c.tag} class="${c.cls}" cursor=${c.cursor}> 「${c.text}」`);
      lines.push(`     外层 html: ${c.outerHtml}`);
    }
    lines.push('');
    lines.push('可见文本:');
    lines.push(data.bodyText);

    await fs.writeFile(path.join(dir, 'stuck-page.txt'), lines.join('\n'), 'utf8');
    await fs.writeFile(path.join(dir, 'stuck-page.json'), JSON.stringify(data, null, 2), 'utf8');
    // 原始 HTML 单独存一份 —— 排查选择器时这个信息最全
    const html = await page.content().catch(() => '');
    if (html) await fs.writeFile(path.join(dir, 'stuck-page.html'), html.slice(0, 400000), 'utf8');
    if (log) log(`  （页面结构已写入 ${path.join(dir, 'stuck-page.txt')}）`);
    return true;
  } catch (e) {
    if (log) log(`  （写页面结构失败：${firstLine(e.message)}）`);
    // ★ 保底：完整 dump 失败也要留下点东西 ★
    //   否则就是"日志里说在写文件，目录建了但空的"，等于什么都没查。
    try {
      const dir = path.resolve(cfg.outDir || '.', 'logs');
      await fs.mkdir(dir, { recursive: true });
      const html = await page.content().catch(() => '');
      const minimal = [
        `说明: ${note}`,
        `时间: ${new Date().toISOString()}`,
        `URL : ${page.url()}`,
        `完整 dump 失败原因: ${firstLine(e.message)}`,
        '',
        '（下面是页面原始 HTML，前 300000 字符）',
        html.slice(0, 300000),
      ].join('\n');
      await fs.writeFile(path.join(dir, 'stuck-page-FALLBACK.txt'), minimal, 'utf8');
      if (log) log(`  （已写一份最小现场：${path.join(dir, 'stuck-page-FALLBACK.txt')}）`);
    } catch { /* 实在写不出来就算了 */ }
    return false;
  }
}

/** 轮询等待，比 waitForSelector 更灵活（可以等任意异步条件） */
async function waitUntil(predicate, { timeoutMs, intervalMs = 500, label = '条件' }) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`等待超时（${Math.round(timeoutMs / 1000)} 秒）：${label}`);
}

/** 在若干候选定位器里挑第一个真实可见的 */
async function firstVisible(locators) {
  for (const loc of locators) {
    if (!loc) continue;
    try {
      const n = await loc.count();
      for (let i = 0; i < n; i += 1) {
        const item = loc.nth(i);
        if (await item.isVisible()) return item;
      }
    } catch { /* 忽略单个候选的报错 */ }
  }
  return null;
}

/** 按文字找可点的按钮/链接 */
async function findClickable(page, patterns) {
  const candidates = [
    ...patterns.map((p) => page.getByRole('button', { name: p })),
    ...patterns.map((p) => page.getByRole('link', { name: p })),
    ...patterns.map((p) => page.locator('a, button').filter({ hasText: p })),
  ];
  const el = await firstVisible(candidates);
  if (!el) return null;
  const text = (await el.innerText().catch(() => '')) || (await el.textContent().catch(() => '')) || '';
  return { locator: el, text: text.trim().slice(0, 40) };
}

/* ------------------------------------------------------------------ */
/* 失败自诊断                                                          */
/* ------------------------------------------------------------------ */

async function dumpPage(page) {
  try {
    return await page.evaluate(() => {
      const lines = [];
      const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
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
        if (lb) {
          const t = document.getElementById(lb);
          if (t) return t.innerText.trim();
        }
        const prev = el.previousElementSibling;
        if (prev && prev.innerText) return prev.innerText.trim();
        return '';
      };

      lines.push(`URL: ${location.href}`);
      lines.push(`标题: ${document.title}`);

      const inputs = Array.from(document.querySelectorAll('input, textarea, select')).filter(vis);
      lines.push(`可见输入框 (${inputs.length}):`);
      for (const el of inputs) {
        // ★ 属性必须打出来 ★
        //   检测验证码框靠的就是 name / id / maxlength / autocomplete / placeholder，
        //   只打 type 和 label 根本没法定位问题（实测踩过）。
        const attrs = ['name', 'id', 'maxlength', 'autocomplete', 'placeholder', 'inputmode', 'aria-label']
          .map((a) => { const v = el.getAttribute(a); return v ? `${a}="${String(v).slice(0, 30)}"` : ''; })
          .filter(Boolean).join(' ');
        lines.push(`  <${el.tagName.toLowerCase()} type=${el.type || '-'}${attrs ? ` ${attrs}` : ''}> label=「${labelOf(el).slice(0, 40)}」`);
      }

      const btns = Array.from(document.querySelectorAll('button, input[type=submit], [role=button], a.btn'))
        .filter(vis)
        .map((el) => (el.innerText || el.value || '').trim())
        .filter(Boolean);
      lines.push(`可见按钮 (${btns.length}): ${btns.slice(0, 15).map((t) => `「${t.slice(0, 30)}」`).join(' ')}`);

      // ★ 可点击元素（含被包成链接的 span/div）★
      //   Steam 的「通过电子邮件发送帐户验证码至 xxx」这类入口常常既不是 <a> 也不是
      //   <button>，而是加了 cursor:pointer 的 div/span。只看标签的话 dump 里根本看不到它，
      //   于是"页面上明明有入口，日志里却说没找到"。
      const clickable = [];
      for (const el of document.querySelectorAll('a, button, [role=button], [role=link], [onclick], [tabindex], span, div, li')) {
        if (!vis(el)) continue;
        let hit = el.tagName === 'A' || el.tagName === 'BUTTON'
          || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link'
          || el.hasAttribute('onclick');
        if (!hit) {
          try { hit = getComputedStyle(el).cursor === 'pointer'; } catch { /* 忽略 */ }
        }
        if (!hit) continue;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 60) clickable.push(t);
      }
      const uniqClick = [...new Set(clickable)];
      lines.push(`可点击元素 (${uniqClick.length}): ${uniqClick.slice(0, 15).map((t) => `「${t}」`).join(' ')}`);

      const text = (document.body.innerText || '').replace(/\n{2,}/g, '\n').trim();
      lines.push(`可见文本: ${text.slice(0, 600).replace(/\n/g, ' / ')}`);
      return lines;
    });
  } catch (e) {
    return [`(页面结构 dump 失败: ${e.message})`];
  }
}

/** 步骤失败时的现场：截图 + 页面结构（控制台 + 落盘） */
async function diagnose(page, stepName, cfg, log) {
  const dump = await dumpPage(page);
  const file = path.join(cfg.outDir, 'screenshots', `${Date.now()}-${slug(stepName)}.png`);
  let shot = null;
  try {
    await page.screenshot({ path: file, fullPage: false });
    shot = file;
  } catch { /* 截图失败不致命 */ }

  log('');
  log(`  ✗ 步骤失败：${stepName}`);
  log('  ── 页面结构（照着这个就能补选择器）──');
  for (const l of dump) log(`    ${l}`);
  if (shot) log(`  ── 截图：${shot}`);
  // ★ 同时落盘 ★ 这样"步骤失败"的现场也能直接打开看，不用从控制台里翻
  await dumpPageToFile(page, cfg, log, `步骤「${stepName}」失败`);
  log('');
  return { dump, shot };
}

/* ------------------------------------------------------------------ */
/* 页面判定                                                            */
/* ------------------------------------------------------------------ */

async function isLoginPage(page) {
  if (/\/login/i.test(page.url())) return true;
  const pw = page.locator('input[type=password]:visible');
  const btn = page.getByRole('button', { name: /登录|sign in/i });
  return (await pw.count()) > 0 && (await btn.count()) > 0;
}

/**
 * 判断当前是不是「新密码表单」。
 * 返回 { password, confirm, mode } 或 null。
 *
 * ★ 这里必须严格 ★
 *   登录页也有一个密码框。如果只看"有没有密码框"就认为到了改密表单，
 *   那么任何在循环里调用本函数的地方都会在登录页误判 ——
 *   实测踩过：doLogin 一进循环就"以为已经到改密表单"直接返回，一个验证码都不填。
 */
export async function detectNewPasswordForm(page) {
  const pws = page.locator('input[type=password]:visible');
  const n = await pws.count();

  // 最可靠的信号：两个可见密码框（新密码 + 确认）
  if (n >= 2) {
    return { password: pws.nth(0), confirm: pws.nth(1), mode: '两个密码框' };
  }
  if (n === 0) return null;

  // 只有一个密码框时，页面上必须真的写着"新密码"之类的字眼才算。
  //   ★ 不能只看标签选择器 ★
  //   之前那句 `input[type=password]` 再 filter xpath=.. 会匹配**任何有父元素的密码框**，
  //   等于无条件命中，登录页也会被判成改密表单。
  const text = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  if (!/新密码|新的密码|设置新密码|新的密碼|new password/i.test(text)) return null;

  const confirm = await firstVisible([
    page.getByLabel(/确认密码|再次输入|重新输入|confirm password|retype/i),
  ]);
  return { password: pws.nth(0), confirm, mode: '按标签识别' };
}

/* ------------------------------------------------------------------ */
/* 各步骤                                                              */
/* ------------------------------------------------------------------ */

async function launchBrowser(cfg, log) {
  const tried = [];
  const candidates = [cfg.browserChannel, 'chrome', 'msedge', 'chromium'].filter(Boolean);
  for (const ch of [...new Set(candidates)]) {
    try {
      const browser = await chromium.launch({
        channel: ch,
        headless: cfg.headless,
        slowMo: cfg.slowMoMs,
      });
      log(`  浏览器已启动：channel=${ch}，${cfg.headless ? '无界面' : '有界面'}`);
      return browser;
    } catch (e) {
      tried.push(`${ch}(${firstLine(e.message)})`);
    }
  }
  throw new Error(
    '没有可用浏览器。已尝试：\n    ' + tried.join('\n    ')
    + '\n  请确认装了 Chrome 或 Edge，或在 .env 里设置 BROWSER_CHANNEL。',
  );
}

/** 登录 —— 选择器已对 Steam 真实登录页实测确认 */
/**
 * 找出「输入验证码」那个框。
 *
 * 分两层：
 *   ① 明确的特征（autocomplete=one-time-code / name=code / maxlength=5 …）—— 一见就认
 *   ② 兜底：页面上**唯一一个**可见文本框，且当前没有可见的密码框
 *
 * ★ 第 ② 层的两个前提都不能少 ★
 *   · 没有可见密码框 —— 否则还在凭据表单上，用户名框会被误认成验证码框
 *   · 只剩一个候选 —— 多个候选说明认不出来，宁可等人工也不要填错框
 *
 * 另：用户名框会被打上 data-dsh-skip 标记，兜底时排除掉。
 */
/**
 * 收集页面上"能输入文字"的可见框（排除密码/按钮/勾选框等）
 */
async function listTextInputs(page) {
  const all = page.locator('input:visible:not([data-dsh-skip])');
  const n = await all.count().catch(() => 0);
  const usable = [];
  for (let i = 0; i < n; i += 1) {
    const loc = all.nth(i);
    const type = ((await loc.getAttribute('type').catch(() => '')) || 'text').toLowerCase();
    if (['password', 'hidden', 'submit', 'button', 'reset', 'checkbox', 'radio', 'file', 'image'].includes(type)) continue;
    usable.push(loc);
  }
  return usable;
}

/**
 * 找出「输入验证码」的地方。
 *
 * 返回一个描述对象，因为 Steam 有两种截然不同的形态：
 *
 *   { kind: 'single', locator }        一个普通输入框
 *   { kind: 'split', boxes: [...] }    ★ 拆分的 5 个单字符框 ★
 *   null                              认不出来（交给人工）
 *
 * ★ 拆分式是关键 ★
 *   实测 Steam 的邮箱验证码界面是 5 个独立的单字符输入框（看起来就是 5 条短横线），
 *   每个 maxlength=1。之前的兜底要求"页面上只剩一个文本框"，
 *   遇到 5 个就直接放弃 —— 表现就是"明明有输入框却认不出来"。
 */
export async function detectCodeField(page) {
  // ① 明确特征（单框）
  const candidates = [
    'input[autocomplete="one-time-code"]',
    'input[name="code"]',
    'input[name="authcode"]',
    'input[name*="code" i]',
    'input[id*="code" i]',
    'input[id*="guard" i]',
    'input[maxlength="5"]',
    'input[placeholder*="代码" i]',
    'input[placeholder*="验证码" i]',
    'input[placeholder*="code" i]',
    'input[aria-label*="代码" i]',
    'input[aria-label*="code" i]',
    'input[inputmode="numeric"]',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    const type = ((await loc.getAttribute('type').catch(() => '')) || '').toLowerCase();
    if (type === 'password') continue;
    // maxlength=1 的说明是拆分式的一格，不算"整框"
    const maxLen = await loc.getAttribute('maxlength').catch(() => null);
    if (maxLen === '1') break;
    return { kind: 'single', locator: loc };
  }

  // ② 必须已经离开凭据表单 —— 否则下面几条会把账号框误认成验证码框
  const pwVisible = await page.locator('input[type=password]:visible').count().catch(() => 0);
  if (pwVisible > 0) return null;

  // ③ 拆分式：一组单字符框（看 maxlength=1 最准）
  const oneChar = page.locator('input:visible[maxlength="1"]:not([data-dsh-skip])');
  const oc = await oneChar.count().catch(() => 0);
  if (oc >= 2 && oc <= 8) {
    const boxes = [];
    for (let i = 0; i < oc; i += 1) boxes.push(oneChar.nth(i));
    return { kind: 'split', boxes };
  }

  // ④ 兜底：一组可见文本框（2~8 个）
  const usable = await listTextInputs(page);
  if (usable.length >= 2 && usable.length <= 8) return { kind: 'split', boxes: usable };

  // ⑤ 兜底：唯一一个文本框
  if (usable.length === 1) return { kind: 'single', locator: usable[0] };

  return null;
}

/**
 * 往「拆分式的 5 个格子」里填验证码。
 *
 * 两种打法，先易后难：
 *   ① 整串打进第一格 —— 绝大多数 OTP 界面会自动跳格
 *   ② 不行就挨个格子填一个字符
 * 打完回读拼接结果校验，对不上就返回 false（上层会转人工）。
 */
export async function fillSplitCode(page, boxes, code, cfg, log) {
  // ★ 回读必须给短超时 ★
  //   实测踩过：Steam 的 5 格填满会**自动提交**，页面立刻跳到下一屏，
  //   这时候再去读那 5 个格子 —— 元素已经不存在了 ——
  //   而 inputValue() 的默认超时是 30 秒，5 个格子就是 **150 秒白等**。
  //   日志里表现为"一直卡在：填验证码：回读校验"，看起来像卡死，
  //   实际上是它到了二选一界面却没机会去点。
  const READ_TIMEOUT = 800;
  const readAll = async () => {
    const vals = [];
    for (const b of boxes) vals.push(await b.inputValue({ timeout: READ_TIMEOUT }).catch(() => ''));
    return vals.join('').toUpperCase();
  };

  const urlBefore = page.url();

  // ① 整串打进第一格
  //   ★ 每一步都先打点再动手 ★ 这样万一卡住，日志会停在具体哪一步上
  setStep(`填验证码：点第 1 格（共 ${boxes.length} 格）`);
  log(`  ▸ 点第 1 格…`);
  await boxes[0].click({ timeout: 5000 }).catch(() => log('    （点第 1 格超时，继续）'));

  setStep('填验证码：清空第 1 格');
  log(`  ▸ 清空第 1 格…`);
  await boxes[0].fill('', { timeout: 3000 }).catch(() => {});

  setStep(`填验证码：整串输入 ${code}`);
  log(`  ▸ 整串输入「${code}」（每字符 ${cfg.typeDelayMs}ms）…`);
  try {
    await boxes[0].pressSequentially(code, { delay: cfg.typeDelayMs, timeout: 8000 });
  } catch {
    await boxes[0].type?.(code, { delay: cfg.typeDelayMs, timeout: 8000 }).catch(() => {});
  }
  await page.waitForTimeout(cfg.fieldSettleMs);

  // ★ 打完先看页面跳没跳 ★ —— 跳了就说明填对了，根本不用回读
  if (page.url() !== urlBefore) {
    log(`  ✓ 填满后页面自动跳转了（${page.url().split('/').slice(-2)[0] || '下一屏'}），不需要回读`);
    return true;
  }

  setStep('填验证码：回读校验');
  let got = await readAll();
  log(`  ▸ 回读第 1 遍：「${got || '空'}」`);
  if (got === code.toUpperCase()) {
    log(`  ✓ 已填入 ${boxes.length} 格的验证码（整串输入）`);
    return true;
  }
  // 回读时页面跳走了也算成功
  if (page.url() !== urlBefore) {
    log('  ✓ 回读期间页面已跳转，视为填入成功');
    return true;
  }

  // ② 逐格填
  log(`  整串输入没生效（读到 ${got || '空'}），改成逐格填`);
  for (let i = 0; i < boxes.length; i += 1) {
    const ch = code[i] || '';
    setStep(`填验证码：逐格 第 ${i + 1}/${boxes.length} 格`);
    log(`  ▸ 第 ${i + 1} 格填「${ch}」…`);
    await boxes[i].click({ timeout: 3000 }).catch(() => {});
    await boxes[i].fill('', { timeout: 2000 }).catch(() => {});
    if (ch) {
      try { await boxes[i].pressSequentially(ch, { delay: cfg.typeDelayMs, timeout: 5000 }); }
      catch { await boxes[i].type?.(ch, { delay: cfg.typeDelayMs, timeout: 5000 }).catch(() => {}); }
    }
    await page.waitForTimeout(120);
    // 填到一半页面就跳了（自动提交）—— 直接算成功
    if (page.url() !== urlBefore) {
      log(`  ✓ 填到第 ${i + 1} 格时页面自动跳转了`);
      return true;
    }
  }
  await page.waitForTimeout(cfg.fieldSettleMs);
  if (page.url() !== urlBefore) {
    log('  ✓ 逐格填完后页面已跳转');
    return true;
  }
  got = await readAll();
  log(`  ▸ 回读第 2 遍：「${got || '空'}」`);
  if (got === code.toUpperCase()) {
    log(`  ✓ 已填入 ${boxes.length} 格的验证码（逐格输入）`);
    return true;
  }
  log(`  ⚠ 填入后回读是「${got}」，和期望的「${code}」对不上`);
  return false;
}

/** 给用户名框打标记，免得兜底时被当成验证码框 */
async function tagSkipFields(page, locators) {
  for (const loc of locators) {
    await loc?.evaluate?.((el) => el.setAttribute('data-dsh-skip', '1')).catch(() => {});
  }
}

/**
 * 登录 Steam。
 *
 * 遇到验证码时的策略：
 *   账号关联了邮箱 → 让服务端去邮箱取码并自动填上（取码由服务端轮询，这里只等一次请求）
 *   没关联 / 取不到 → 打印手动提示，继续等你自己填
 *
 * ★ 无论哪条路，都不会因为"没自动取到"就直接失败 ★
 *   自动只是省事，人工永远是可用的兜底。
 *
 * 导出是为了让 test-flow.mjs 能直接对着模拟登录页测这段逻辑。
 */
export async function doLogin(page, {
  api, accountId, username, currentPassword, cfg, log, onProgress, since,
}) {
  log('  检测到登录页，开始登录');

  const userFieldLocs = [
    page.getByLabel(/帐户名称|账户名称|account name/i),
    page.locator('form input[type=text]'),
    page.locator('input[type=text]'),
  ];
  const pwFieldLocs = [
    page.getByLabel(/^密码$|password/i),
    page.locator('form input[type=password]'),
    page.locator('input[type=password]'),
  ];

  // ★★★ 必须等表单渲染完，不能拿到页面就找输入框 ★★★
  //
  //   实测（看 stuck-page.html 得到的结论）：
  //   help.steampowered.com/zh-cn/login 这个页面的 HTML 里**一个 <input> 都没有**，
  //   表单是 React 在浏览器里动态渲染进这个空壳的：
  //
  //     <div data-featuretarget="login" data-props='{"redirectUrl":"...HelpChangePassword"}'></div>
  //
  //   domcontentloaded 只保证骨架到了，React 还没跑。
  //   这时候去找输入框会扑空（0 个），脚本直接判定"找不到账号输入框"而失败。
  //   之前偶尔能成，纯粹是页面恰好已经渲染完 —— 典型的时序竞态，不是稳定行为。
  const waitMs = Math.max(10000, Number(cfg.loginFormWaitMs) || 30000);
  const waitDeadline = Date.now() + waitMs;
  let userField = await firstVisible(userFieldLocs);
  let pwField = await firstVisible(pwFieldLocs);
  let announcedWait = false;

  while ((!userField || !pwField) && Date.now() < waitDeadline) {
    if (!announcedWait) {
      announcedWait = true;
      log(`  登录表单还没渲染出来（React 客户端渲染），等它出现，最多 ${Math.round(waitMs / 1000)} 秒…`);
      await onProgress('等待登录表单渲染');
    }
    await sleep(500);
    userField = await firstVisible(userFieldLocs);
    pwField = await firstVisible(pwFieldLocs);
  }

  // 还是没出现：有些入口先给一个「登录」链接，点进去才是表单
  if (!userField || !pwField) {
    const entry = await firstVisible([
      page.getByRole('link', { name: /^登录$|sign in/i }),
      page.getByRole('button', { name: /^登录$|sign in/i }),
    ]);
    if (entry) {
      log('  页面上没有表单，只有一个「登录」入口 —— 点它进去');
      await robustClick(entry, log);
      const retryUntil = Date.now() + 20000;
      while (Date.now() < retryUntil && (!userField || !pwField)) {
        await sleep(500);
        userField = await firstVisible(userFieldLocs);
        pwField = await firstVisible(pwFieldLocs);
      }
    }
  }

  if (!userField) {
    throw new Error(
      `找不到账号输入框 —— 等了 ${Math.round(waitMs / 1000)} 秒表单也没渲染出来（当前 ${page.url()}）`,
    );
  }
  if (!pwField) throw new Error('找不到密码输入框');

  // 给账号框打标记：验证码框的兜底识别要靠"排除账号框"才敢认
  await tagSkipFields(page, [userField]);

  // 同样不能一次性 fill 完立刻点登录 —— 登录表单也是 React，同一个竞态
  await fillField(userField, username, cfg, log);
  await page.waitForTimeout(cfg.fieldSettleMs);
  await fillField(pwField, currentPassword, cfg, log);
  await page.waitForTimeout(cfg.fieldSettleMs);

  // 「记住我」默认勾选 —— 关掉，避免在这台机器上留下长期会话
  if (!cfg.keepLoggedIn) {
    const cb = page.locator('[role=checkbox][aria-checked=true]').first();
    if (await cb.count()) {
      await cb.click().catch(() => {});
      log('  已取消勾选「记住我」');
    }
  }

  const loginBtn = await firstVisible([
    page.getByRole('button', { name: /登录|sign in/i }),
    page.locator('button[type=submit]'),
  ]);
  if (!loginBtn) throw new Error('找不到登录按钮');

  await onProgress('正在登录 Steam');
  // 点登录前也留一点时间，让表单状态更新完
  await page.waitForTimeout(cfg.submitSettleMs);
  await loginBtn.click();

  // 等离开登录页；同时盯着页面上的报错文案
  // 注意：这里必须覆盖 Steam 中英文的多种说法，否则会白等到超时。
  // 实测 Steam 中文报错是「请核对您的密码和帐户名称并重试。」
  const LOGIN_ERROR_RE = new RegExp(
    '(密码错误|帐户名称或密码|账户名称或密码|请核对您的密码|核对您的密码|请检查您的密码'
    + '|密码不正确|帐户不存在|账户不存在'
    + '|incorrect|invalid password|check your password|try again|too many)',
    'i',
  );

  const t0 = Date.now();
  let diagDumped = false;
  // ★ autoDisabled 一旦置位就不再恢复 ★
  //   之前这里叫 manualMode 并在提示过后重置为 false，
  //   结果自动逻辑又活过来、反复去取码 —— 名字和语义都对不上了。
  let autoDisabled = false;
  let manualAnnounced = false;
  /** 上次"有实质进展"的时间。卡住判断和诊断 dump 都看它 */
  let lastProgressAt = Date.now();

  // ★ 验证码可能要输不止一次 ★
  //   实测：输完第一次码之后，Steam 有时会再弹一屏，上面有两个入口：
  //     「通过电子邮件发送账户验证码至 xxx」      ← 点它才会发新码（我们要走这条）
  //     「我已无法访问此电子邮件地址，或是没有收到验证码」 ← 这是账号找回，绝对不能点
  let codeRounds = 0;               // 已经成功填过几次码
  let resendClicks = 0;             // 点过几次"重新发送"
  let lastCodeAction = 0;           // 上次动作时间，防止同一屏反复触发
  /** ★ 这一趟流程里已经用过的验证码 ★ 下一轮取码时排除掉，免得又拿到旧的那封 */
  const usedCodes = [];
  const deadline = t0 + cfg.loginTimeoutMs;

  // ★ 这两个值必须兜底 ★
  //   直接写 cfg.maxCodeRounds 的话，配置里少一项就会变成 `0 < undefined` === false，
  //   整块自动填码静默失效 —— 看起来像"功能没生效"，实际只是配置没读到。
  const maxRounds = Math.max(1, Number(cfg.maxCodeRounds) || 3);
  const maxResends = Math.max(0, Number.isFinite(Number(cfg.maxResends)) ? Number(cfg.maxResends) : 2);

  while (Date.now() < deadline) {
    // ★★★ 退出条件 ★★★
    //
    //   背景：Steam 改密是一条 6 步向导：
    //     1 账号密码 → 2 验证码 → 3 二选一(发验证码) → 4 验证码 → 5/6 新密码
    //   第 2 步一过 URL 就离开 /login 了，可第 3、4 步还得有人做。
    //
    //   旧逻辑写的是「URL 里没有 /login 就 return」——
    //   于是第 3 步那一屏出现时 doLogin 直接溜走，丢给后面的 reachNewPasswordForm；
    //   而第 3 步常常在 doLogin 还活着的时候就出现了。两边都当"不是我的事"，
    //   结果就是**卡在二选一那一屏不动**（实测反复踩）。
    //
    //   新逻辑：离开登录页之后，看向导里**还有没有要做的验证码步骤**（验证码框 / 二选一入口）。
    //     有 → 留下继续做
    //     没有 → 才交回后面的流程（它负责进改密表单）
    //   这样既不会在二选一那屏溜走，也不会在普通落地页上空转到超时。
    // ★ 登录页绝不能进这个判断 ★
    //   登录页也有密码框；detectNewPasswordForm 一旦在登录页误判成"已到改密表单"，
    //   doLogin 第一轮就 return，一个验证码都不填（实测踩过，就是这么来的）。
    const curUrl = page.url();
    const onLoginPage = /\/login/i.test(curUrl);
    if (!onLoginPage && await detectNewPasswordForm(page)) {
      log('  已到达改密表单，登录阶段结束');
      return;
    }

    const codeTarget = await detectCodeField(page).catch(() => null);
    const choice = codeTarget ? null : await findResendLink(page).catch(() => null);

    // 心跳里显示的"现在在哪一步" —— 卡住时一眼可见
    setStep(`登录向导 · ${codeTarget ? '发现验证码框' : choice?.locator ? '发现二选一界面'
      : onLoginPage ? '登录页（凭据/等待）' : `向导页（${curUrl.split('/').slice(-2)[0] || '等待'}）`}`);

    if (!onLoginPage && !codeTarget && !choice?.locator) {
      log('  登录通过（已离开登录页，向导里也没有待处理的验证码步骤）');
      return;
    }

    const txt = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    const err = txt.match(LOGIN_ERROR_RE);
    if (err) {
      const line = txt.split('\n').map((s) => s.trim())
        .find((s) => LOGIN_ERROR_RE.test(s));
      throw new Error(`Steam 拒绝登录：${line || err[0]}`);
    }

    // ★ 第 3 步：二选一那一屏（「通过电子邮件发送帐户验证码至 xxx」）★
    if (choice?.error) {
      log(`  [登录页] 入口扫描出错: ${choice.error}`);
    } else if (choice?.locator && Date.now() - lastCodeAction > 3500
               && (codeRounds === 0 || resendClicks < maxResends)) {
      resendClicks += 1;
      lastCodeAction = Date.now();
      log('');
      log(`  二选一界面 → 点击「${choice.text}」`);
      log(`     （${choice.via}）`);
      await onProgress('正在请求发送验证码');
      await clickSendCodeOption(page, cfg, log);
      lastProgressAt = Date.now();
      await page.waitForTimeout(3000);
      continue;
    }

    if (!autoDisabled) {
      const target = codeTarget;
      const now = Date.now();
      const ready = now - lastCodeAction > 4000;   // 给页面留出反应时间，避免重复填

      if (target && codeRounds < maxRounds && ready) {
        // ---------- 填一轮验证码 ----------
        codeRounds += 1;
        lastCodeAction = now;
        log('');
        log(target.kind === 'split'
          ? `  第 ${codeRounds} 次：检测到 ${target.boxes.length} 格验证码输入框 —— 去邮箱取码…`
          : `  第 ${codeRounds} 次：检测到验证码输入框 —— 去邮箱取码…`);
        await onProgress(`正在从邮箱获取验证码（第 ${codeRounds} 次）`);

        // ★★ 第二轮开始必须"等新邮件 + 排除用过的码" ★★
        //   实测踩过：第二次要码时 Steam 的新邮件还没到，
        //   邮箱里最新那封仍是第一封 → 又把同一个旧码返回去，
        //   日志里就是「第 2 次取到验证码：HPQ9T」「第 3 次取到验证码：HPQ9T」。
        //   两道保险一起上：
        //     ① 先歇一会儿 —— 发第二封邮件本来就要几秒到几十秒
        //     ② 把用过的码传给服务端，让它跳过旧邮件、继续等新的
        if (codeRounds > 1 && usedCodes.length) {
          const waitMs = Math.max(0, Number(cfg.secondCodeWaitMs) || 5000);
          if (waitMs > 0) {
            log(`  ⏳ 先等 ${Math.round(waitMs / 1000)} 秒，让 Steam 把新验证码发出来…`);
            setStep(`等新验证码邮件（${Math.round(waitMs / 1000)} 秒）`);
            await page.waitForTimeout(waitMs);
          }
        }

        const code = await tryFetchCode({
          api,
          accountId,
          cfg,
          log,
          since: since || Math.floor(t0 / 1000),
          exclude: usedCodes,
        });
        if (code) {
          log(`  取到验证码：${code}`);
          usedCodes.push(code);          // ★ 记下来，下一轮别再要这个 ★
          const filled = target.kind === 'split'
            ? await fillSplitCode(page, target.boxes, code, cfg, log)
            : (await fillField(target.locator, code, cfg, log), true);
          await page.waitForTimeout(cfg.fieldSettleMs);

          if (filled) {
            await submitCode(page, target);
            await page.waitForTimeout(3000);
            lastProgressAt = Date.now();
            continue;
          }
          log('  ⚠ 验证码没能填进去');
        } else {
          log('  ⚠ 没取到验证码');
          // ★ 取码这一步本身已经在服务端轮询过 codeWaitSec 了 ★
          //   再重来几轮只是白白耗掉登录超时，直接转人工更实在。
          autoDisabled = true;
        }
        if (!autoDisabled && codeRounds >= maxRounds) {
          autoDisabled = true;
          log(`  ⚠ 已经试了 ${codeRounds} 次验证码，转人工`);
        }
      } else if (!target && codeRounds > 0 && codeRounds < maxRounds
                 && resendClicks < maxResends && ready) {
        // ---------- 页面上没有输入框，但可能有"重新发送验证码"入口 ----------
        const resend = await findResendLink(page);
        if (resend?.error) log(`  [登录页] 入口扫描出错: ${resend.error}`);
        else if (!resend?.locator && resend?.hits) log('  [登录页] 入口扫描: 页面上没有含「通过电子邮件发送」的元素');
        if (resend?.locator) {
          resendClicks += 1;
          lastCodeAction = now;
          log('');
          log(`  这一屏要求重新发送验证码 → 点击「${resend.text}」（${resend.via}）`);
          await onProgress('正在请求重新发送验证码');
          await clickSendCodeOption(page, cfg, log);
          await page.waitForTimeout(3000);
          lastProgressAt = Date.now();
          continue;
        }
      }
    }

    if (autoDisabled && !manualAnnounced) {
      manualAnnounced = true;
      log('');
      log('  ┌────────────────────────────────────────────────────────────┐');
      log('  │ 请在浏览器窗口里手动完成验证码步骤                         │');
      log('  │ （脚本会自动检测，你填完它继续）                           │');
      log('  └────────────────────────────────────────────────────────────┘');
    }

    // ---- 卡住就 dump 页面（不管走到哪一步）----
    //
    // ★ 早先这里限定 codeRounds === 0 ★ 结果"第一轮码填完、卡在第二屏"时
    //   一条诊断都不打 —— 而那恰恰是最需要看页面的时候。
    //   现在改成"只要 25 秒没有实质进展就 dump 一次"，并把脚本当时的判断结果一并打出来。
    if (!diagDumped && Date.now() - lastProgressAt > 25000) {
      diagDumped = true;
      const probeTarget = await detectCodeField(page).catch(() => null);
      const probeResend = await findResendLink(page).catch(() => null);
      log('');
      log('  ── 卡在登录页超过 25 秒没有进展 ──');
      log(`     已填过 ${codeRounds} 轮验证码，点过 ${resendClicks} 次"重新发送"`);
      log(`     此刻认到的验证码框：${probeTarget ? (probeTarget.kind === 'split' ? `${probeTarget.boxes.length} 格` : '单框') : '没有'}`);
      log(`     此刻找到的"重新发送"入口：${probeResend?.locator
        ? `有 →「${probeResend.text}」（${probeResend.via}）` : '没有'}`);
      if (probeResend?.error) log(`     入口扫描出错: ${probeResend.error}`);
      else if (!probeResend?.locator) log('     入口扫描: 页面上没有含「通过电子邮件发送」的元素');
      log('     把下面这段发我，就能定位：');
      for (const line of await dumpPage(page)) log(`     ${line}`);
      log('  ────────────────────────────────────────────────');
    }

    await sleep(600);
  }
  throw new Error(
    `${Math.round(cfg.loginTimeoutMs / 1000)} 秒内仍停在登录页 —— `
    + '账号或密码可能不对，也可能卡在验证码，请查看截图'
    // 把取码失败的真实原因带上：最常见的就是"账号没关联收件邮箱"，
    // 不写出来的话，报错只说"停在登录页"，排查方向完全跑偏。
    + (lastCodeFailure ? `（取码情况：${lastCodeFailure}）` : ''),
  );
}

/**
 * 找「通过电子邮件发送账户验证码至 xxx」这类重新发送入口。
 *
 * ★ 必须同时做"要什么"和"躲什么"两个判断 ★
 *   Steam 那一屏上有两个挨着的入口：
 *     ① 通过电子邮件发送账户验证码至 xxx        ← 要点这个
 *     ② 我已无法访问此电子邮件地址，或是没有收到验证码  ← 这是账号找回，点了会惹麻烦
 *   两个都含「验证码」字样，所以先按 AVOID 排除，再按 WANT 命中。
 */
async function findResendLink(page) {
  const AVOID = /我已无法访问|无法访问此电子邮件|不能访问此电子邮件|找回帐|找回账|account\s*recovery|recover\s+my\s+account|can'?t\s+access/i;

  try {
    // ★ 直接在 DOM 里扫文字，然后把"该点的那个"标记出来 ★
    //
    //   为什么不用 getByText / getByRole：
    //   这两个都要靠 Playwright 的可见性和文本匹配规则去猜，而这一屏的选项
    //   是加样式冒充按钮的 div（或者带一坨子元素的容器），命中的往往是外层包装。
    //   这里换个思路：找出**所有**含关键文字的元素 → 跳过"子元素也含同样文字"的容器
    //   （取最内层）→ 从它往上找第一个真正可点的祖先 → 打标记 → 之后按标记点。
    //   这样"要点哪个元素"是明确算出来的，不是猜的。
    const hits = await page.evaluate(({ avoidSrc }) => {
      const AVOID = new RegExp(avoidSrc, 'i');
      const KEYS = ['通过电子邮件发送', '发送帐户验证码', '发送账户验证码', '重新发送', '再次发送', 'resend'];
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const out = [];

      const all = document.querySelectorAll(
        'button, a, [role=button], [role=link], div, span, li, p, td, label, section, article',
      );
      for (const el of all) {
        const t = clean(el.textContent);
        if (!t || t.length > 120) continue;
        if (!KEYS.some((k) => t.includes(k))) continue;
        if (AVOID.test(t)) continue;                       // ★ 账号找回那条绝不要 ★
        // 子元素里还有同样的文字 → 说明这是容器，跳过，取最内层的
        const childHasIt = [...el.children].some((c) => {
          const ct = clean(c.textContent);
          return ct && KEYS.some((k) => ct.includes(k));
        });
        if (childHasIt) continue;
        // 从它往上找第一个"真的能点"的祖先
        let cur = el;
        let depth = 0;
        while (cur && depth < 6) {
          let cursor = '';
          try { cursor = getComputedStyle(cur).cursor; } catch { /* 忽略 */ }
          const clickable = cur.tagName === 'BUTTON' || cur.tagName === 'A'
            || cur.getAttribute('role') === 'button' || cur.getAttribute('role') === 'link'
            || cur.hasAttribute('onclick') || cursor === 'pointer';
          if (clickable) break;
          cur = cur.parentElement;
          depth += 1;
        }
        if (!cur) continue;
        const r = cur.getBoundingClientRect();
        if (!r.width || !r.height) continue;               // 不可见
        cur.setAttribute('data-dsh-sendcode', String(out.length));
        out.push({
          idx: out.length,
          tag: cur.tagName.toLowerCase(),
          cls: String(cur.className || '').slice(0, 90),
          cursor: (() => { try { return getComputedStyle(cur).cursor; } catch { return ''; } })(),
          depth,
          text: clean(cur.textContent).slice(0, 90),
          innerTag: el.tagName.toLowerCase(),
        });
      }
      return out;
    }, { avoidSrc: AVOID.source });

    if (!hits.length) {
      return { locator: null, text: '', via: '', tried: [`DOM扫描:0`] };
    }

    const best = hits[0];
    const via = `DOM扫描 → ${best.innerTag} 上溯 ${best.depth} 层到 <${best.tag}>`;
    return {
      locator: page.locator(`[data-dsh-sendcode="${best.idx}"]`).first(),
      text: best.text,
      via,
      hits,
    };
  } catch (e) {
    // ★ 绝不往外抛 ★
    //   之前这里没包 try/catch：浏览器一旦被关掉，这里抛的错会直接让
    //   「登录 Steam」整个步骤失败，日志只显示"Target page has been closed"，
    //   把真正的问题（页面结构）完全盖住了。
    return { locator: null, text: '', via: '', error: firstLine(e.message) };
  }
}

/**
 * 点一个元素，尽量点中，并把结果如实返回。
 *
 * ★ 为什么要包一层 ★
 *   这类入口常常是加了 cursor:pointer 的 div/span，外面还套着布局容器，
 *   普通 click() 会因为"被其他元素遮挡"或"元素不稳定"失败。
 *   而之前的写法是 `.click().catch(() => {})` —— 失败了完全无声，
 *   日志照样打印"点击了 xxx"，看起来像点了其实没点。
 *
 * 返回 'ok'（正常点中）| 'dom'（退回 DOM 原生 click）| 'fail'
 */
async function robustClick(locator, log) {
  await locator.scrollIntoViewIfNeeded?.().catch(() => {});
  try {
    await locator.click({ timeout: 8000 });
    return 'ok';
  } catch (e1) {
    try {
      // 绕过命中判定：直接触发 DOM click（事件照样冒泡到父元素的处理函数）
      await locator.evaluate((el) => el.click());
      return 'dom';
    } catch {
      if (log) log(`  ⚠ 点击失败：${String(e1.message || e1).split('\n')[0]}`);
      return 'fail';
    }
  }
}

/**
 * 点「二选一」里那个发验证码的选项。
 *
 * ★★ 就是照抄点「登录」键的写法 ★★
 *
 *   第一步点登录是这么写的（steam.mjs 里 doLogin）：
 *
 *     const loginBtn = await firstVisible([
 *       page.getByRole('button', { name: /登录|sign in/i }),
 *       page.locator('button[type=submit]'),
 *     ]);
 *     await loginBtn.click();
 *
 *   这里一模一样，只是把名字换成这一屏的文案。
 *
 *   试的顺序：
 *     ① 完全照抄登录键那套（getByRole + firstVisible + click）
 *     ② 还是不行 → 退回页面内原生 el.click()
 *        （加样式冒充按钮的 div、或者被别的元素盖住的情况，原生 click 一定点得中）
 *
 *   ★ 绝不碰「我已无法访问此电子邮件地址…」那一条 ★
 *     它的文案里既没有「通过电子邮件发送」也没有「发送帐户验证码」，所以匹配不到它。
 */
export async function clickSendCodeOption(page, cfg, log) {
  const WANT = /通过电子邮件发送|发送帐户验证码|发送账户验证码/;

  // ① 和点「登录」键一模一样
  setStep('二选一：找「通过电子邮件发送…」这一项');
  log(`  ▸ 找「通过电子邮件发送…」这一项（getByRole button → link → 兜底）…`);
  const btn = await firstVisible([
    page.getByRole('button', { name: WANT }),
    page.getByRole('link', { name: WANT }),
    page.locator('a, button, [role=button], [role=link]').filter({ hasText: WANT }),
  ]);
  log(btn ? '  ✓ 找到了' : '  ✗ 没找到');

  if (btn) {
    const text = String(await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    setStep('二选一：点击');
    log(`  点击「${text.slice(0, 40) || '(无文字)'}」`);
    log(`     URL: ${page.url().slice(0, 70)}`);
    await page.waitForTimeout(cfg?.submitSettleMs ?? 500);
    const urlBefore = page.url();
    try {
      await btn.click({ timeout: 10000 });
      log('  ✓ 已点击');
    } catch (e) {
      log(`  ⚠ 常规点击失败：${firstLine(e.message)} → 改用页面内原生 click`);
      await btn.evaluate((el) => el.click()).catch(() => {});
      log('  ✓ 已用原生 click 点击');
    }
    await page.waitForTimeout(2500);
    if (page.url() !== urlBefore) {
      log('  ✓ 页面已经跳转');
      return true;
    }
    log('  点了但页面还没跳转，改用直接跳 href');

    // ② ★ 兜底：它其实是个普通链接，直接读 href 跳过去 ★
    //   实测这一项的真实结构（来自 stuck-page.html）：
    //     <a class="help_wizard_button help_wizard_arrow_right"
    //        href=".../wizard/HelpWithLoginInfoEnterCode?s=...&account=...&reset=1&lost=0&issueid=406">
    //       <span>通过电子邮件发送帐户验证码至 h******@i*****.c**</span>
    //     </a>
    //   就是个纯 <a href>，**没有 onclick** —— 所以"跳转到 href"和"点它"完全等价，
    //   同时彻底绕开点击机制（遮挡、命中判定、事件绑定都不用操心）。
    const href = await btn.getAttribute('href').catch(() => null);
    if (href && !/^javascript:/i.test(href)) {
      const abs = new URL(href, page.url()).href;
      log(`  → 直接跳转：${abs.slice(0, 80)}`);
      await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
        log(`     跳转失败：${firstLine(e.message)}`);
      });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      log(`  ✓ 当前页面：${page.url().slice(0, 70)}`);
      return true;
    }
    log('  这个元素没有可用的 href，只能等页面自己反应');
    return true;
  }

  // ② 登录键那套找不到 —— 退回页面内原生 click
  log('  ⚠ 用「登录键」那套写法找不到这一项，改用页面内原生 click');
  const done = await page.evaluate(({ wantSrc }) => {
    const AVOID = /我已无法访问|无法访问此电子邮件|不能访问此电子邮件|account\s*recovery|recover\s+my\s+account|can'?t\s+access/i;
    const WANT = new RegExp(wantSrc, 'i');
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    const cands = [];
    for (const el of document.querySelectorAll('body *')) {
      if (['SCRIPT', 'STYLE', 'HTML', 'BODY'].includes(el.tagName)) continue;
      const t = clean(el.textContent);
      if (!t || t.length > 160) continue;
      if (!WANT.test(t)) continue;
      if (AVOID.test(t)) continue;
      if ([...el.children].some((c) => WANT.test(clean(c.textContent)))) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      cands.push(el);
    }
    if (!cands.length) return { ok: false };

    let target = cands[0];
    for (let d = 0; d < 6 && target.parentElement; d += 1) {
      let cursor = '';
      try { cursor = getComputedStyle(target).cursor; } catch { /* 忽略 */ }
      if (target.tagName === 'BUTTON' || target.tagName === 'A'
          || target.getAttribute('role') === 'button' || target.getAttribute('role') === 'link'
          || target.hasAttribute('onclick') || cursor === 'pointer') break;
      target = target.parentElement;
    }
    try { target.scrollIntoView({ block: 'center' }); } catch { /* 忽略 */ }
    target.click();
    return { ok: true, tag: target.tagName.toLowerCase(), cls: String(target.className || '').slice(0, 80) };
  }, { wantSrc: WANT.source }).catch((e) => ({ ok: false, err: firstLine(e.message) }));

  if (done.ok) log(`  ✓ 已用原生 click 点击 <${done.tag} class="${done.cls}">`);
  else log(`  ⚠ 还是没找到这一项${done.err ? `（${done.err}）` : ''}`);
  return !!done.ok;
}

/**
 * 最近一次取码失败的原因（给登录超时的错误信息用）。
 *
 * ★ 为什么要留这个 ★
 *   账号没关联收件邮箱时，worker 会一直卡在登录页等验证码，
 *   最后只抛一句「360 秒内仍停在登录页」—— 看的人根本想不到"是没配邮箱"。
 *   实测就踩过：账号 #8 没关联邮箱，报的就是这句，得翻库才发现。
 *   把中途记下的原因挂到最终错误上，一眼就能定位。
 */
let lastCodeFailure = '';

/** 取验证码：失败一律返回 null，由调用方回落到手动 */
async function tryFetchCode({ api, accountId, cfg, log, since, exclude = [] }) {
  // ★ 只有**显式**关掉才跳过 ★
  //   写成 `if (!cfg.autoCode)` 的话，配置里没这一项就等于把功能静默关了
  //   （undefined 也是 falsy）—— 表现是"脚本说要去取码，却一次都没请求"。
  if (cfg.autoCode === false) return null;
  if (!api) {
    log('  （没有可用的取码接口，跳过自动取码）');
    return null;
  }
  if (!accountId) {
    log('  （没有账号 id，无法自动取码）');
    return null;
  }
  try {
    setStep(`去邮箱取验证码（最多等 ${cfg.codeWaitSec} 秒）`);
    const skip = (Array.isArray(exclude) ? exclude : [exclude]).filter(Boolean);
    log(`  ▸ 去邮箱取验证码（服务端最多轮询 ${cfg.codeWaitSec} 秒）…`);
    if (skip.length) {
      log(`     已排除用过的码：${skip.join(' / ')} —— 只等新的那一封`);
    }
    const t0 = Date.now();
    const r = await api.fetchCode(accountId, { since, wait: cfg.codeWaitSec, exclude: skip });
    log(`    ✓ 取码请求返回（${((Date.now() - t0) / 1000).toFixed(1)} 秒，轮询 ${r?.rounds ?? 1} 次）`);
    if (r?.code) return r.code;
    const whyMap = {
      no_mailbox: '这个账号没关联邮箱',
      all_seen: `只找到已经用过的旧码（${skip.join('/')}），新的那封一直没到`,
      no_mail: `等了 ${cfg.codeWaitSec} 秒邮件还没到`,
      no_code: `等了 ${cfg.codeWaitSec} 秒，邮件到了但没抠出验证码`,
    };
    log(`  ⚠ 邮箱里没找到新验证码（${whyMap[r?.reason] || `等了 ${cfg.codeWaitSec} 秒还是没取到`}）`);
    lastCodeFailure = whyMap[r?.reason] || `等了 ${cfg.codeWaitSec} 秒还是没取到验证码`;
    if (r?.lastError) log(`  ${r.lastError}`);
    return null;
  } catch (e) {
    log(`  ⚠ 自动取码失败：${e.message.split('\n')[0]}`);
    lastCodeFailure = `取码接口出错：${e.message.split('\n')[0]}`;
    return null;
  }
}
/** 把填好的验证码提交出去（有按钮就点，没有就回车） */
async function submitCode(page, target) {
  setStep('提交验证码');
  const submit = await firstVisible([
    page.getByRole('button', { name: /提交|继续|确认|下一步|submit|continue|next|verify/i }),
    page.locator('button[type=submit]'),
  ]);
  if (submit) { await submit.click().catch(() => {}); return; }
  const last = target.kind === 'split' ? target.boxes[target.boxes.length - 1] : target.locator;
  await last.press('Enter').catch(() => {});
}

/**
 * 走到「新密码表单」。
 *
 * ★ 这一步不只是"点几下导航" ★
 *   登录阶段一结束，Steam 的改密向导里**还可能再要一次邮箱验证码**。
 *   实测的界面长这样（面包屑是「主页 > 发送代码」，URL 已经不在 /login 下了）：
 *
 *     您希望如何更改您的密码？
 *     ┌──────────────────────────────────────────────────────┐
 *     │ 通过电子邮件发送帐户验证码至 h*****_******@i****.c** │ ▶ │  ← 点它才会发码
 *     └──────────────────────────────────────────────────────┘
 *     ┌──────────────────────────────────────────────────────┐
 *     │ 我已无法访问此电子邮件地址，或是没有收到验证码        │ ▶ │  ← 账号找回，绝不能点
 *     └──────────────────────────────────────────────────────┘
 *
 *   ★ 之前踩的坑 ★
 *     这段"点发送验证码"的逻辑原本写在 doLogin 的循环里，而那个循环看到 URL
 *     不含 /login 就 return 了 —— 于是这一屏根本没人管，脚本干等。
 *     现在三件事统一放在这里：点"发送验证码"、填验证码、点已知导航入口。
 */
export async function reachNewPasswordForm(page, {
  api, accountId, cfg, log, onProgress, since,
}) {
  let form = await detectNewPasswordForm(page);
  if (form) return form;

  const entryPatterns = [
    /更改密码|修改密码|重置密码|change.{0,3}password|reset.{0,3}password/i,
    /我知道我的密码|i know my password/i,
    /继续|下一步|continue|next/i,
  ];

  const maxRounds = Math.max(1, Number(cfg.maxCodeRounds) || 3);
  const maxResends = Math.max(0, Number.isFinite(Number(cfg.maxResends)) ? Number(cfg.maxResends) : 2);
  const deadline = Date.now() + cfg.assistMinutes * 60 * 1000;

  let announced = false;
  let lastAction = 0;
  let codeRounds = 0;
  let resendClicks = 0;
  /** ★ 这一趟流程里已经用过的验证码 ★ 下一轮取码时排除掉，免得又拿到旧的那封 */
  const usedCodes = [];
  /** 上一轮"看到了什么"，变了才打印，避免刷屏 */
  let lastStateKey = '';
  /** ★ 心跳落盘 ★ URL 20 秒没变就写一次现场文件 */
  let lastUrl = page.url();
  let lastUrlAt = Date.now();
  let lastDumpAt = 0;

  while (Date.now() < deadline) {
    form = await detectNewPasswordForm(page);
    if (form) { log('  检测到改密表单，脚本接管'); return form; }

    // ★ 心跳：URL 20 秒没变就落盘现场 ★
    //   之前的 dump 挂在"三个探测全都没命中"那个分支上 ——
    //   如果脚本一直在重试点某个东西（找到了但没生效），就一直 continue，
    //   永远走不到那个分支，于是干等到超时也没留下任何现场。
    //   现在改成按"页面有没有变化"来判断，跟它在干什么无关。
    const curUrl = page.url();
    if (curUrl !== lastUrl) {
      lastUrl = curUrl;
      lastUrlAt = Date.now();
    } else if (Date.now() - lastUrlAt > 20000 && Date.now() - lastDumpAt > 20000) {
      lastDumpAt = Date.now();
      log('');
      log(`  （页面 20 秒没有变化，把现场写进文件：已填 ${codeRounds} 轮码、点过 ${resendClicks} 次发送）`);
      await dumpPageToFile(page, cfg, log,
        `改密向导：URL 20 秒未变；已填 ${codeRounds} 轮码、点过 ${resendClicks} 次发送`);
    }

    const now = Date.now();
    const ready = now - lastAction > 3500;      // 给页面留反应时间，避免重复动作

    // ★ 每轮都把三个探测都做一遍，并打印出来 ★
    //   之前的日志只记录"做了什么"，不记录"看到了什么"，
    //   于是"没找到入口"和"找到了但没点着"在日志里长得一模一样，只能靠猜。
    const target = codeRounds < maxRounds ? await detectCodeField(page) : null;
    const resend = (!target && resendClicks < maxResends) ? await findResendLink(page) : null;
    const entry = (!target && !resend?.locator) ? await findClickable(page, entryPatterns) : null;

    // 心跳里显示的"现在在哪一步"
    setStep(`改密向导 · ${target ? '发现验证码框' : resend?.locator ? '发现二选一界面'
      : entry ? `发现导航入口「${entry.text.slice(0, 16)}」` : '等待页面变化'}`);

    const stateKey = `${target ? 'code' : '-'}${resend?.locator ? '|resend' : ''}${entry ? '|entry' : ''}`;
    if (stateKey !== lastStateKey) {
      lastStateKey = stateKey;
      log(`  [向导] ${page.url().slice(0, 90)}`);
      log(`         验证码框:${target ? (target.kind === 'split' ? `${target.boxes.length}格` : '有') : '无'}`
        + `  发送入口:${resend?.locator ? '有' : '无'}  已知导航:${entry ? '有' : '无'}`);
      // 把扫描结果如实打出来 —— 到底有没有那个元素、命中的是哪个、有没有被账号找回规则挡掉
      if (resend?.error) log(`         入口扫描出错: ${resend.error}`);
      else if (resend?.hits?.length) {
        for (const h of resend.hits.slice(0, 4)) {
          log(`         候选: <${h.tag} class="${h.cls}" cursor=${h.cursor}> 「${h.text}」`);
        }
      } else if (resend) log('         入口扫描: 页面上没有含「通过电子邮件发送」的元素');
    }

    // ① 验证码输入框（向导里第二次要码）
    if (target && ready) {
      codeRounds += 1;
      lastAction = now;
      log('');
      log(`  改密向导里又要验证码（第 ${codeRounds} 次）—— 去邮箱取码…`);
      await onProgress('正在从邮箱获取验证码');

      // 同样要排除用过的码 + 等新邮件（理由见 doLogin 里那段注释）
      if (codeRounds > 1 && usedCodes.length) {
        const waitMs = Math.max(0, Number(cfg.secondCodeWaitMs) || 5000);
        if (waitMs > 0) {
          log(`  ⏳ 先等 ${Math.round(waitMs / 1000)} 秒，让 Steam 把新验证码发出来…`);
          setStep(`等新验证码邮件（${Math.round(waitMs / 1000)} 秒）`);
          await sleep(waitMs);
        }
      }
      const code = await tryFetchCode({ api, accountId, cfg, log, since, exclude: usedCodes });
      if (code) {
        log(`  取到验证码：${code}`);
        usedCodes.push(code);
        const filled = target.kind === 'split'
          ? await fillSplitCode(page, target.boxes, code, cfg, log)
          : (await fillField(target.locator, code, cfg, log), true);
        if (filled) {
          await sleep(cfg.fieldSettleMs);
          await submitCode(page, target);
          await sleep(2500);
          continue;
        }
      }
      log('  ⚠ 这一步没能自动完成，转人工');
      continue;
    }

    // ② 「通过电子邮件发送帐户验证码至 xxx」这一类入口
    if (resend?.locator && ready) {
      resendClicks += 1;
      lastAction = now;
      log('');
      log(`  这一屏要求发送验证码 → 点击「${resend.text}」（${resend.via}）`);
      await onProgress('正在请求重新发送验证码');
      await clickSendCodeOption(page, cfg, log);
      await sleep(3000);
      continue;
    }

    // ③ 已知的导航入口文案
    if (entry && ready) {
      lastAction = now;
      log(`  尝试点击「${entry.text}」`);
      const how2 = await robustClick(entry.locator, log);
      if (how2 === 'fail') log('  ⚠ 点了但没成功');
      await sleep(1800);
      continue;
    }

    // ④ 自动都走不通 —— 提示人工，但继续检测，你做完脚本自己接手
    if (!announced) {
      announced = true;
      log('');
      log('  ┌────────────────────────────────────────────────────────────┐');
      log('  │ 接下来需要你手动操作（脚本无法预先测定这段流程）           │');
      log('  │                                                            │');
      log('  │  请在打开的浏览器窗口里完成：                              │');
      log('  │    1. Steam Guard / 邮箱验证码                             │');
      log('  │    2. 进入「修改密码」页面（能看到两个密码输入框就够了）    │');
      log('  │                                                            │');
      log(`  │  脚本会自动检测，最多等 ${String(cfg.assistMinutes).padEnd(2)} 分钟，检测到就接管继续。   │`);
      log('  │  不想等了：按 Ctrl+C 停掉，这个任务会留在「待改密」。      │');
      log('  └────────────────────────────────────────────────────────────┘');
      log('');
      await onProgress('等待人工完成 Steam 验证');

      // ★ 顺手把页面结构 dump 一次 ★
      //   这一屏最容易出现"明明有入口却点不到"，不给结构就只能靠猜。
      //   同时把脚本当时的判断结果一并打出来 —— 到底是有输入框没认出来，
      //   还是入口找不着，一眼就能分。
      const probeCode = await detectCodeField(page).catch(() => null);
      const probeResend = await findResendLink(page).catch(() => null);
      log('');
      log('  ══ 卡住的页面结构（把这一段发我就能定位）══');
      log(`     URL: ${page.url()}`);
      log(`     识别到的验证码输入框: ${probeCode
        ? (probeCode.kind === 'split' ? `${probeCode.boxes.length} 格` : '单框')
        : '没有'}`);
      log(`     找到的"发送验证码"入口: ${probeResend?.locator
        ? `有 →「${probeResend.text}」（${probeResend.via}）` : '没有'}`);
      if (probeResend?.error) log(`     入口扫描出错: ${probeResend.error}`);
      else if (!probeResend?.locator) log('     入口扫描: 页面上没有含「通过电子邮件发送」的元素');
      for (const line of await dumpPage(page)) log(`     ${line}`);
      log('  ══════════════════════════════════════════');

      // ★ 现场说明必须和**当前页面**一致 ★
      //   原先这里是两次 dumpPageToFile 连调，文件名写死成同一套，
      //   后一次（说明写着"登录阶段卡住"）会把前一次整个覆盖掉 ——
      //   留下的现场被贴了错误的标签，照它排查只会越走越偏。
      //   现在按当前页面实测判断卡在哪一段，只写一次。
      const stuckOnLogin = await isLoginPage(page).catch(() => false);
      const stuckNote = stuckOnLogin
        ? `登录阶段卡住（还停在登录页）；已填 ${codeRounds} 轮码、点过 ${resendClicks} 次发送`
        : `改密向导卡住；已填 ${codeRounds} 轮码、点过 ${resendClicks} 次发送`;
      await dumpPageToFile(page, cfg, log, stuckNote);
    }
    await sleep(1500);
  }
  throw new Error(
    `等了 ${cfg.assistMinutes} 分钟仍没进入改密表单 —— `
    + `已在向导里填过 ${codeRounds} 次验证码、点过 ${resendClicks} 次发送。请查看截图。`,
  );
}

/**
 * 往一个输入框里填值。
 *
 * ★ 不能用 fill() 一次性塞进去 ★
 *   实测踩过：两个密码框用 fill() 填完立刻点提交，Steam 会返回「输入的密码无效」。
 *   原因是 React 的状态更新与表单校验是异步的，值还没来得及进入框架的 state，
 *   提交上去的其实是空值/旧值。
 *   这里改成逐字符输入（模拟真人打字节奏），每个字符之间留出间隔。
 */
async function fillField(field, value, cfg, log) {
  setStep(`逐字符输入（${String(value).length} 个字符，每字 ${cfg.typeDelayMs}ms）`);
  // ★ 只打长度，绝不打内容 ★ —— 这里可能正在输入账号密码
  if (log) log(`    ␣ 逐字符输入 ${String(value).length} 个字符（每字 ${cfg.typeDelayMs}ms）…`);
  // ★ 每一步都给超时 ★
  //   Playwright 定位器的默认超时是 30 秒；页面一跳动元素就没了，
  //   没有超时的话每一步都白等 30 秒，几步加起来就是好几分钟的"假卡死"。
  await field.click({ timeout: 5000 }).catch(() => {});
  await field.fill('', { timeout: 3000 }).catch(() => {});
  if (cfg.typeDelayMs > 0) {
    // pressSequentially 是逐字符输入；老版本 Playwright 叫 type
    const typeFn = field.pressSequentially?.bind(field) || field.type?.bind(field);
    if (typeFn) {
      await typeFn(value, { delay: cfg.typeDelayMs, timeout: 15000 }).catch(async () => {
        await field.fill(value, { timeout: 3000 }).catch(() => {});
      });
    } else {
      await field.fill(value, { timeout: 3000 }).catch(() => {});
    }
  } else {
    await field.fill(value, { timeout: 3000 }).catch(() => {});
  }
}

/** 等一个按钮从禁用变成可点 */
async function waitForEnabled(locator, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const disabled = await locator.isDisabled().catch(() => false);
    if (!disabled) return true;
    await sleep(200);
  }
  return false;
}

async function fillNewPassword(page, form, newPassword, log, cfg) {
  const fields = [
    ['新密码', form.password],
    ['确认新密码', form.confirm],
  ].filter(([, f]) => f);

  for (const [name, field] of fields) {
    await fillField(field, newPassword, cfg, log);
    // 让 React 处理完这次输入
    await page.waitForTimeout(cfg.fieldSettleMs);
    // 再失焦一次：很多表单是在 blur 时才做「两次是否一致」的校验
    await field.evaluate((el) => { if (typeof el.blur === 'function') el.blur(); }).catch(() => {});
    await page.waitForTimeout(cfg.fieldSettleMs);
    log(`  已填入「${name}」（${newPassword.length} 位）`);
  }

  // 回读确认：React 若在重渲染时把值重置掉，这里能立刻发现
  for (const [name, field] of fields) {
    // ★ 短超时 ★ 页面一跳动元素就没了，默认 30 秒会让这一步白等
    const got = await field.inputValue({ timeout: 1000 }).catch(() => '');
    if (got !== newPassword) {
      log(`  ⚠ 「${name}」回读不一致（只读到 ${got.length} 个字符），重填一次`);
      await fillField(field, newPassword, cfg, log);
      await page.waitForTimeout(cfg.fieldSettleMs * 2);
    }
  }
}

async function submitNewPassword(page, cfg, log) {
  const btn = await firstVisible([
    page.getByRole('button', { name: /更改密码|修改密码|确认更改|保存|提交|change password|save|submit/i }),
    page.locator('button[type=submit]'),
    page.locator('input[type=submit]'),
  ]);
  if (!btn) throw new Error('找不到提交按钮');

  // ★ 点击之前必须留出稳定时间 ★
  //   两个框填完立刻点提交，Steam 会判定密码无效 —— 这就是当初失败的原因。
  await page.waitForTimeout(cfg.submitSettleMs);

  // 有些表单要两项一致才启用按钮，等它就绪
  const enabled = await waitForEnabled(btn, Math.max(3000, cfg.submitSettleMs * 4));
  if (!enabled) log('  ⚠ 提交按钮一直是禁用状态，仍然尝试点击');

  await btn.click();
  log(`  已点击提交（点击前等待了 ${cfg.submitSettleMs} 毫秒）`);
}

/**
 * 判定是否改密成功 —— 全自动检测，不需要人工确认。
 *
 * 用四路信号，任意一路命中即判成功（会打印是哪一路命中的）：
 *   ① 页面出现成功文案（中英文多种写法）
 *   ② URL 离开了改密向导页
 *   ③ 两个密码框消失了（表单被结果页替换掉）
 *   ④ 被重定向到登录页 —— Steam 改密后会失效会话，这也是成功信号
 *
 * ★ 默认「没抓到明确错误就算成功」★
 *   反过来（没看到成功文案就判失败）后果更糟：
 *   密码其实已经改了，但工具里存的还是旧密码 —— 账号等于丢了。
 *   所以只有捕获到明确错误文案才判失败。
 */
async function verifyResult(page, cfg, log, before = {}) {
  const ERROR_RE = new RegExp(
    '(密码不匹配|两次输入不[一致匹配]|密码无效|密码不能|密码太短|密码太长'
    + '|出错|失败|错误|请核对|try again|error occurred|invalid|mismatch|too short|too long)',
    'i',
  );
  const OK_RE = new RegExp(
    '(密码已更改|密码已更新|密码已修改|更改成功|修改成功|已成功'
    + '|successfully|has been changed|has been updated|password changed|password updated)',
    'i',
  );

  // 提交前的现场：提交时的 URL / 密码框数量
  const baseUrl = before.url || page.url();
  const basePwCount = before.pwCount ?? 0;
  /** 提交前不在登录页 —— 只有这样，"变成登录页"才是有效信号 */
  const wasOnChangePage = !/\/login/i.test(baseUrl);

  const t0 = Date.now();
  while (Date.now() - t0 < cfg.verifyTimeoutMs) {
    const txt = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    const url = page.url();

    // ① 成功文案
    if (OK_RE.test(txt)) {
      const hit = txt.match(OK_RE);
      log(`  ✓ 检测到成功：页面提示「${hit ? hit[0] : 'ok'}」`);
      return { confirmed: true, by: '页面文案' };
    }

    // 失败文案 —— 优先判失败，避免误判成功
    if (ERROR_RE.test(txt)) {
      const hit = txt.match(/[^\n]*(密码不匹配|两次输入不[一致匹配]|密码无效|密码不能|密码太[短长]|出错|失败|错误|请核对|invalid|mismatch|too short|too long)[^\n]*/i);
      throw new Error(`Steam 返回错误：${(hit ? hit[0] : '').trim() || '见截图'}`);
    }

    // ④ 会话失效被踢回登录页 —— Steam 改密成功后的典型表现
    if (wasOnChangePage && /\/login/i.test(url)) {
      log('  ✓ 检测到成功：会话已失效、被踢回登录页（Steam 改密后就是这样）');
      log('    那个登录页不用管它，脚本已经判定完成，不需要你再登录一次');
      return { confirmed: true, by: '会话失效' };
    }

    // ② URL 变了（且不是登录页）
    if (wasOnChangePage && url !== baseUrl && !/\/login/i.test(url)) {
      await page.waitForTimeout(600);
      log('  ✓ 检测到成功：页面已离开改密页');
      return { confirmed: true, by: 'URL 变化' };
    }

    // ③ 提交时的密码框全没了（表单被结果页替换）
    if (basePwCount >= 1 && !/\/login/i.test(url)) {
      const now = await page.locator('input[type=password]:visible').count().catch(() => basePwCount);
      if (now === 0) {
        log('  ✓ 检测到成功：改密表单已消失（提交被接受）');
        return { confirmed: true, by: '表单消失' };
      }
    }

    await sleep(800);
  }

  log(`  ⚠ ${Math.round(cfg.verifyTimeoutMs / 1000)} 秒内四路信号都没命中`);
  log('    按「未发现明确错误即视为成功」处理，账号照常自动回到「可用」。');
  log('    万一这次其实没改成功，下次取用时会登不上 —— 到时手动改一次即可。');
  return { confirmed: false, by: '未确认' };
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

export async function changeSteamPassword({
  api = null, accountId = null,
  username, currentPassword, email, newPassword,
  cfg, log = console.log, onProgress = async () => {},
  onBeforeSubmit = null,
}) {
  const wizardUrl = process.env.STEAM_WIZARD_URL || DEFAULT_WIZARD_URL;
  /**
   * ★ 整个改密流程的起始时刻 ★
   *   取验证码时用它当"只看这之后到的邮件"的下界 —— 这样既能避开陈年旧码，
   *   又能覆盖到流程中途才发来的第二、第三个码。
   */
  const since = Math.floor(Date.now() / 1000);
  let browser = null;
  let page = null;

  // ★ 心跳：每 10 秒报一次"现在在哪一步" ★
  //   没有它的话，一旦某一步卡住，屏幕就静止了 —— 分不清是在等还是死了。
  const hbT0 = Date.now();
  const heartbeat = setInterval(() => {
    log(`  ⏱ 仍在进行：${CURRENT_STEP}（已 ${Math.round((Date.now() - hbT0) / 1000)} 秒）`);
  }, 10000);
  if (heartbeat.unref) heartbeat.unref();
  /** 出错时若要让浏览器多留一会儿，就交给后台定时器关，finally 里不再立即关 */
  let keepBrowserOpen = false;

  const step = async (name, fn) => {
    const t0 = Date.now();
    setStep(name);
    // ★ 开始之前先打一行 ★
    //   原来是"成功/失败才打日志"，于是卡在某一步时，日志最后一行还停在上一步，
    //   看的人分不清"到底进没进这一步"。需求里「卡住时必须能看到卡在哪一步」
    //   就断在这里。
    log(`  ▶ [步骤] ${name} …`);
    try {
      const out = await fn();
      log(`  ✔ [步骤] ${name}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
      return out;
    } catch (e) {
      log(`  ✘ [步骤] ${name} 失败（${((Date.now() - t0) / 1000).toFixed(1)} 秒）：${firstLine(e.message)}`);
      if (e.diagnosed) throw e;
      const { shot } = await diagnose(page, name, cfg, log);
      const err = new Error(`步骤「${name}」失败：${e.message}`);
      err.diagnosed = true;
      err.screenshot = shot;
      throw err;
    }
  };

  try {
    browser = await launchBrowser(cfg, log);
    const ctx = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 1280, height: 900 },
    });
    page = await ctx.newPage();

    await step('打开改密页面', async () => {
      await page.goto(wizardUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      if (email) log(`  （该账号登记邮箱：${email}，验证码可能发到这里）`);
    });

    if (cfg.stopAfterLogin) {
      log('  --stop-after-login：停在登录前，浏览器留给你');
      await onProgress('停在登录前（--stop-after-login）');
      await waitUntil(async () => false, { timeoutMs: 10 * 60 * 1000, label: '手动关闭' })
        .catch(() => {});
      return { stoppedEarly: true };
    }

    await step('登录 Steam', async () => {
      if (await isLoginPage(page)) {
        await doLogin(page, {
          api, accountId, username, currentPassword, cfg, log, onProgress, since,
        });
      } else {
        log('  未出现登录页（可能已有会话），跳过登录');
      }
    });

    await step('进入改密表单', async () => {
      const form = await reachNewPasswordForm(page, {
        api, accountId, cfg, log, onProgress, since,
      });
      page.__form = form;
    });

    await step('填写新密码', async () => {
      await fillNewPassword(page, page.__form, newPassword, log, cfg);
    });

    if (cfg.pauseBeforeSubmit) {
      log('');
      log('  PAUSE_BEFORE_SUBMIT=true：请在浏览器里检查无误后，回到这里按回车继续…');
      await new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
      });
    }

    // ★ 落盘恢复文件的最佳时机：密码马上要提交到 Steam 了
    if (onBeforeSubmit) await onBeforeSubmit();

    // ★ 提交前先记录现场 ★
    //   Playwright 的 click() 会等待点击触发的跳转完成，所以等校验环节开始时，
    //   页面可能已经在登录页了 —— 不能到了那时候再取"提交前的 URL"，
    //   否则「从非登录页跳过来才算成功」这个判断会把自己的信号关掉。
    const beforeSubmit = {
      url: page.url(),
      pwCount: await page.locator('input[type=password]:visible').count().catch(() => 0),
    };

    await step('提交新密码', async () => {
      await submitNewPassword(page, cfg, log);
    });

    const result = await step('校验改密结果', async () => verifyResult(page, cfg, log, beforeSubmit));

    return { ok: true, confirmed: result.confirmed };
  } catch (err) {
    // ★ 出错时不再阻塞 ★
    //   以前这里是 await 等 5 分钟（让你看现场），代价是失败要等 5 分钟才上报、
    //   账号也就一直卡在「待改密」。现在改成后台倒计时关闭：
    //   立刻抛错 → 立刻上报 → 立刻能重试；浏览器在后台多留一会儿给你看。
    if (cfg.keepBrowserOpenOnError && page && browser) {
      const secs = cfg.keepBrowserOpenSecs;
      if (secs > 0) {
        keepBrowserOpen = true;
        log(`  ⚠ 浏览器会保持打开 ${secs} 秒方便你看现场（不影响失败上报，到点自动关）`);
        const b = browser;
        const timer = setTimeout(() => { b.close().catch(() => {}); }, secs * 1000);
        if (timer.unref) timer.unref();
      }
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
    // 设了保持打开的，就交给上面那个定时器去关
    if (browser && !keepBrowserOpen) await browser.close().catch(() => {});
  }
}
