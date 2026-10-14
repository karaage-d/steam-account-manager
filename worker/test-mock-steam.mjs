/**
 * 模拟 Steam 改密页 —— 专为复现「输入太快导致密码无效」而造。
 *
 * 关键：内部 state 用 setTimeout 延迟 LAG 毫秒才更新（模拟 React 的异步状态），
 *       但提交时立刻读取 state。两个框刚填完就点提交 → state 还是空的
 *       → 判「输入的密码无效」。这与真实遇到的故障一致。
 *
 * 提交时会把「DOM 里看到的值」和「state 里的值」一起回报给服务端，供测试断言。
 */
import http from 'node:http';

const LAG = Number(process.env.MOCK_LAG_MS || 300);
const PORT = Number(process.env.MOCK_PORT || 8899);

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>更改密码（模拟）</title>
<style>
  body{font-family:system-ui;background:#1b2838;color:#c7d5e0;padding:40px}
  input{display:block;margin:8px 0;padding:10px;width:320px;background:#316282;border:0;color:#fff;font-size:15px}
  button{margin-top:16px;padding:10px 26px;background:#1a9fff;border:0;color:#fff;font-size:15px;cursor:pointer}
  #msg{margin-top:18px;padding:10px 14px;font-weight:600}
  .err{background:#5c2b29;color:#ffb3ad}
  .ok{background:#1e4030;color:#8ce0a8}
</style></head>
<body>
  <h1>密码重置</h1>
  <div>账户名称：mock_user_01</div>
  <form id="f">
    <label for="p1">更改我的密码</label>
    <input id="p1" type="password" autocomplete="new-password">
    <label for="p2">再次输入新密码</label>
    <input id="p2" type="password" autocomplete="new-password">
    <button id="btn" type="submit">更改密码</button>
  </form>
  <div id="msg" style="display:none"></div>
<script>
  var MODE = new URLSearchParams(location.search).get('mode') || 'text';
  // 模拟 React：框架内部 state 异步更新，而 DOM 值是立刻生效的
  var state = { p1: '', p2: '' };
  var timers = {};
  function schedule(key, value) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(function () { state[key] = value; }, ${LAG});
  }
  document.getElementById('p1').addEventListener('input', function (e) { schedule('p1', e.target.value); });
  document.getElementById('p2').addEventListener('input', function (e) { schedule('p2', e.target.value); });

  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var dom1 = document.getElementById('p1').value;
    var dom2 = document.getElementById('p2').value;
    var ok = !!(state.p1 && state.p2 && state.p1 === state.p2);
    fetch('/__report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dom1: dom1, dom2: dom2, state1: state.p1, state2: state.p2, ok: ok, mode: MODE })
    }).catch(function () {});
    if (!ok) {
      var m = document.getElementById('msg');
      m.className = 'err'; m.textContent = '输入的密码无效'; m.style.display = 'block';
      return;
    }
    if (MODE === 'logout') {
      // ★ 模拟 Steam 改密成功后的真实行为：会话失效，被踢回登录页 ★
      location.href = '/login';
      return;
    }
    var m2 = document.getElementById('msg');
    m2.className = 'ok'; m2.textContent = '密码已更改'; m2.style.display = 'block';
  });
</script>
</body></html>`;

/** 登录页 —— 故意不含任何成功/错误文案，用来验证「靠 URL 判定」是否生效 */
const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>登录（模拟）</title>
<style>body{font-family:system-ui;background:#1b2838;color:#c7d5e0;padding:40px}
input{display:block;margin:8px 0;padding:10px;width:320px;background:#316282;border:0;color:#fff}
button{margin-top:16px;padding:10px 26px;background:#1a9fff;border:0;color:#fff}</style></head>
<body>
  <h1>登录</h1>
  <div>出于安全目的，请确认您的帐户凭据。</div>
  <form><label for="u">用帐户名称登录</label><input id="u" type="text">
  <label for="p">密码</label><input id="p" type="password">
  <button type="submit">登录</button></form>
</body></html>`;

/**
 * 带 Steam Guard 验证码的两步登录页，用来测 worker 的
 * 「检测到验证码框 → 自动取码 → 填入 → 提交」这段逻辑。
 *
 *   第一步：账号 + 密码 + 登录按钮
 *   第二步：出现验证码输入框（name=code, maxlength=5）
 *   填对 → 跳到 /wizard/done（URL 里没有 /login，登录循环据此判定通过）
 */
export const GUARD_CODE = process.env.MOCK_GUARD_CODE || 'K4F7B';
/** 第二轮的验证码故意不同，用来证明"确实又去邮箱取了一次新码" */
export const GUARD_CODE2 = process.env.MOCK_GUARD_CODE2 || 'MNC9P';

/**
 * 验证码框长什么样，用来测不同的识别路径：
 *   obvious        —— 带明确特征（name=code / maxlength=5 / autocomplete=one-time-code）
 *   bare           —— ★ 什么特征都没有，只有一个裸的 <input type="text"> ★
 *   split          —— ★ 5 个独立的单字符框，输入后自动跳格（Steam 真实的样子）★
 *   split-static   —— 5 个单字符框但**不自动跳格**，专门考验"逐格填"的兜底
 *
 * bare / split 这两个场景都是真机踩过的：
 * worker 认不出验证码框，就只是干等，全程不碰邮箱，看起来像"自动取码没生效"。
 */
export const guardStyle = { mode: 'obvious' };

function codeInputs() {
  if (guardStyle.mode === 'split' || guardStyle.mode === 'split-static') {
    return Array.from({ length: 5 }, (_, i) =>
      `<input class="otp" type="text" maxlength="1" inputmode="numeric" data-i="${i}">`).join('');
  }
  return guardStyle.mode === 'bare'
    ? '<input id="x7" type="text">'
    : '<input id="code" name="code" type="text" maxlength="5" autocomplete="one-time-code">';
}

function otpAutoAdvanceScript() {
  if (guardStyle.mode !== 'split') return '';
  return `
    document.querySelectorAll('#f2 input').forEach(function (el) {
      el.addEventListener('input', function () {
        var i = Number(el.getAttribute('data-i'));
        var next = document.querySelector('#f2 input[data-i="' + (i + 1) + '"]');
        if (el.value && next) next.focus();
      });
    });`;
}

const GUARD_LOGIN_PAGE = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>登录（模拟带验证码）</title>
<style>body{font-family:system-ui;background:#1b2838;color:#c7d5e0;padding:40px}
input{display:block;margin:8px 0;padding:10px;width:320px;background:#316282;border:0;color:#fff}
button{margin-top:16px;padding:10px 26px;background:#1a9fff;border:0;color:#fff}
#err{color:#ffb3ad;margin-top:12px}</style></head>
<body>
  <h1>登录</h1>
  <div id="stage1">
    <form id="f1"><label for="u">用帐户名称登录</label><input id="u" type="text">
    <label for="p">密码</label><input id="p" type="password">
    <button type="submit">登录</button></form>
  </div>
  <div id="stage2" style="display:none">
    <div>请输入 Steam Guard 验证码</div>
    <form id="f2"><span class="otpwrap">${codeInputs()}</span>
    <button type="submit">提交</button></form>
    <div id="err"></div>
  </div>
<script>
  document.getElementById('f1').addEventListener('submit', function (e) {
    e.preventDefault();
    fetch('/__report', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ step:'credentials',
        username: document.getElementById('u').value,
        password: document.getElementById('p').value }) }).catch(function(){});
    document.getElementById('stage1').style.display = 'none';
    document.getElementById('stage2').style.display = 'block';
  });
  ${otpAutoAdvanceScript()}
  document.getElementById('f2').addEventListener('submit', function (e) {
    e.preventDefault();
    // 把所有格子的值拼起来 —— 单框模式和拆分式都能用
    var code = Array.from(document.querySelectorAll('#f2 input'))
      .map(function (i) { return i.value; }).join('');
    fetch('/__report', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ step:'code', code: code }) }).catch(function(){});
    if (code.toUpperCase() === ${JSON.stringify(GUARD_CODE)}) location.href = '/wizard/done';
    else document.getElementById('err').textContent = '验证码无效，请重试';
  });
</script>
</body></html>`;

/** 第二轮的验证码故意不同，用来证明"确实又去邮箱取了一次新码" */

/**
 * ★ 两轮验证码的登录页（真机场景）★
 *
 *   第一屏：账号 + 密码
 *   第二屏：验证码输入（5 格拆分式）
 *   第三屏：★ 两个入口 ★
 *        「通过电子邮件发送账户验证码至 xxx」              ← 要点这个
 *        「我已无法访问此电子邮件地址，或是没有收到验证码」  ← 这是账号找回，**点了算失败**
 *   点对之后回到验证码屏，填第二个码才通过。
 *
 * 第三屏是这一整个测试的重点：两个入口都含「验证码」字样，
 * 必须靠 AVOID 规则把账号找回那条排除掉。
 */
const GUARD2_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>登录（模拟两轮验证码）</title>
<style>body{font-family:system-ui;background:#1b2838;color:#c7d5e0;padding:40px}
input{display:inline-block;margin:8px 4px;padding:10px;width:44px;text-align:center;background:#316282;border:0;color:#fff}
#stage1 input{display:block;width:320px;text-align:left}
button{margin-top:16px;padding:10px 26px;background:#1a9fff;border:0;color:#fff;display:block}
.link{color:#66c0f4;cursor:pointer;margin:10px 0;display:block;text-decoration:underline;font-size:14px}
#err{color:#ffb3ad;margin-top:12px}</style></head>
<body>
  <h1>登录</h1>
  <div id="stage1">
    <form id="f1"><label for="u">用帐户名称登录</label><input id="u" type="text">
    <label for="p">密码</label><input id="p" type="password">
    <button type="submit">登录</button></form>
  </div>

  <div id="stage2" style="display:none">
    <div>请输入 Steam Guard 验证码</div>
    <form id="f2">
      <input data-i="0" type="text" maxlength="1" autocomplete="one-time-code">
      <input data-i="1" type="text" maxlength="1">
      <input data-i="2" type="text" maxlength="1">
      <input data-i="3" type="text" maxlength="1">
      <input data-i="4" type="text" maxlength="1">
      <button type="submit">提交</button>
    </form>
    <div id="err"></div>
  </div>

  <div id="stage3" style="display:none">
    <div>请选择一种方式验证您的身份</div>
    <span class="link" id="resend">通过电子邮件发送账户验证码至 humbugs_errors4z@icloud.com</span>
    <span class="link" id="recovery">我已无法访问此电子邮件地址，或是没有收到验证码</span>
  </div>

<script>
  var round = 0;
  var CODES = [${JSON.stringify(GUARD_CODE)}, ${JSON.stringify(GUARD_CODE2)}];

  function report(obj) {
    fetch('/__report', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(obj) }).catch(function(){});
  }
  function show(which) {
    ['stage1','stage2','stage3'].forEach(function (id) {
      document.getElementById(id).style.display = (id === which) ? 'block' : 'none';
    });
  }
  function readCode() {
    return Array.from(document.querySelectorAll('#f2 input'))
      .map(function (i) { return i.value; }).join('');
  }

  document.getElementById('f1').addEventListener('submit', function (e) {
    e.preventDefault();
    report({ step:'credentials', username: document.getElementById('u').value,
      password: document.getElementById('p').value });
    show('stage2');
  });

  document.getElementById('f2').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = readCode();
    report({ step:'code', round: round + 1, code: code });
    if (code.toUpperCase() !== CODES[round]) {
      document.getElementById('err').textContent = '验证码无效，请重试';
      return;
    }
    round += 1;
    if (round >= CODES.length) { location.href = '/wizard/done'; return; }
    // 第一轮通过后弹"选择验证方式"这一屏
    show('stage3');
  });

  // 5 格自动跳格
  document.querySelectorAll('#f2 input').forEach(function (el) {
    el.addEventListener('input', function () {
      var i = Number(el.getAttribute('data-i'));
      var next = document.querySelector('#f2 input[data-i="' + (i + 1) + '"]');
      if (el.value && next) next.focus();
    });
  });

  document.getElementById('resend').addEventListener('click', function () {
    report({ step:'resend-clicked' });
    show('stage2');
  });
  document.getElementById('recovery').addEventListener('click', function () {
    // ★ 走了这条就是走错路 —— 立刻停下并上报 ★
    report({ step:'RECOVERY-CLICKED-WRONG-PATH' });
    show('stage1');
  });
</script>
</body></html>`;

/**
 * ★★ 完整 6 步向导的模拟（真机形状）★★
 *
 *   1 账号密码（/login/guard3）
 *   2 验证码（5 格）—— 通过后跳到 /wizard/sendcode
 *   3 二选一 —— ★ 在 /login 之外 ★，要点「通过电子邮件发送帐户验证码至…」
 *   4 验证码（第二个码）
 *   5/6 改密表单
 *
 * 这一页专门验证："doLogin 必须一路走到改密表单"。
 * 之前 doLogin 一看到 URL 没有 /login 就 return，把第 3 步丢给后面那个函数；
 * 而第 3 步常常在 doLogin 还活着的时候就出现 —— 两边都当"不是我的事"，卡死。
 */
const GUARD3_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>登录（完整向导）</title>
<style>body{font-family:system-ui;background:#1b2838;color:#c7d5e0;padding:40px}
input{display:inline-block;margin:8px 4px;padding:10px;width:44px;text-align:center;background:#316282;border:0;color:#fff}
#stage1 input{display:block;width:320px;text-align:left}
button{margin-top:16px;padding:10px 26px;background:#1a9fff;border:0;color:#fff;display:block}</style></head>
<body>
  <h1>登录</h1>
  <div id="stage1">
    <form id="f1"><label for="u">用帐户名称登录</label><input id="u" type="text">
    <label for="p">密码</label><input id="p" type="password">
    <button type="submit">登录</button></form>
  </div>
  <div id="stage2" style="display:none">
    <div>请输入 Steam Guard 验证码</div>
    <form id="f2">
      <input data-i="0" type="text" maxlength="1" autocomplete="one-time-code">
      <input data-i="1" type="text" maxlength="1">
      <input data-i="2" type="text" maxlength="1">
      <input data-i="3" type="text" maxlength="1">
      <input data-i="4" type="text" maxlength="1">
      <button type="submit">提交</button>
    </form>
    <div id="err"></div>
  </div>
<script>
  function report(obj) {
    fetch('/__report', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(obj) }).catch(function(){});
  }
  function readCode() {
    return Array.from(document.querySelectorAll('#f2 input'))
      .map(function (i) { return i.value; }).join('');
  }
  document.getElementById('f1').addEventListener('submit', function (e) {
    e.preventDefault();
    report({ step:'credentials', username: document.getElementById('u').value,
      password: document.getElementById('p').value });
    document.getElementById('stage1').style.display = 'none';
    document.getElementById('stage2').style.display = 'block';
  });
  document.querySelectorAll('#f2 input').forEach(function (el) {
    el.addEventListener('input', function () {
      var i = Number(el.getAttribute('data-i'));
      var next = document.querySelector('#f2 input[data-i="' + (i + 1) + '"]');
      if (el.value && next) next.focus();
    });
  });
  document.getElementById('f2').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = readCode();
    report({ step:'code', round: 1, code: code });
    if (code.toUpperCase() === ${JSON.stringify(GUARD_CODE)}) {
      // ★ 第一个码通过后跳到向导页（URL 不再含 /login）★
      location.href = '/wizard/sendcode';
    } else {
      document.getElementById('err').textContent = '验证码无效，请重试';
    }
  });
</script>
</body></html>`;

let lastReport = null;
/** 全部上报事件，供测试检查"有没有点错链接"这类行为 */
let reports = [];

/**
 * ★ React 客户端渲染的登录页（真机复刻）★
 *
 * 实测 help.steampowered.com 的登录页 HTML 里**一个 <input> 都没有**：
 *   <div data-featuretarget="login" data-props='{"redirectUrl":"..."}'></div>
 * 表单是 JS 在浏览器里动态塞进去的。所以 domcontentloaded 之后立刻找输入框会扑空。
 *
 * 这个页面就是照那个形状造的：骨架里没有输入框，1.2 秒后才渲染出来。
 * 脚本必须学会"等"，否则会报"找不到账号输入框"。
 */
const LAZY_LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>登录（表单延迟渲染）</title>
<style>body{font-family:system-ui;background:#1b2838;color:#c7d5e0;padding:40px}
input{display:block;margin:8px 0;padding:10px;width:320px;background:#316282;border:0;color:#fff}
button{margin-top:16px;padding:10px 26px;background:#1a9fff;border:0;color:#fff}</style></head>
<body>
  <h1>Steam 客服中心</h1>
  <div class="page_body_ctn login">
    <div class="page_content login_page">
      <div id="root" data-featuretarget="login" data-props='{"redirectUrl":"/wizard/done","disableQR":false}'></div>
    </div>
  </div>
<script>
  // 模拟 React 客户端渲染：延迟 1.2 秒才把表单挂上去
  setTimeout(function () {
    document.getElementById('root').innerHTML =
      '<form id="f1">' +
      '<label for="u">用帐户名称登录</label><input id="u" type="text">' +
      '<label for="p">密码</label><input id="p" type="password">' +
      '<button type="submit">登录</button></form>';
    document.getElementById('f1').addEventListener('submit', function (e) {
      e.preventDefault();
      fetch('/__report', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ step:'credentials',
          username: document.getElementById('u').value,
          password: document.getElementById('p').value }) }).catch(function(){});
      location.href = '/wizard/done';
    });
  }, 1200);
</script>
</body></html>`;

/**
 * ★ 「主页 > 发送代码」那一屏 —— 真机截图复刻 ★
 *
 * 关键点：**URL 不在 /login 下**（是 help.steampowered.com 的向导页），
 * 所以 doLogin 早就返回了，这一屏必须由 reachNewPasswordForm 处理。
 * 之前那段逻辑写在 doLogin 里 → 完全没人管 → 脚本干等。
 *
 *   ① 通过电子邮件发送帐户验证码至 h*****_******@i****.c**   ← 点它
 *   ② 我已无法访问此电子邮件地址，或是没有收到验证码          ← 账号找回，点了算失败
 *   点对之后出现验证码框；填对之后出现改密表单（两个密码框）。
 */
const SENDCODE_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Steam 客服</title>
<style>body{font-family:system-ui;background:#1b2838;color:#c7d5e0;padding:40px}
.row{display:block;background:#2a475e;padding:18px;margin:10px 0;cursor:pointer;border-radius:4px}
.row:hover{background:#316282}
input{margin:8px 4px;padding:10px;background:#316282;border:0;color:#fff}
.otp{width:44px;text-align:center}
button{margin-top:14px;padding:10px 26px;background:#1a9fff;border:0;color:#fff;display:block}
.pw{display:block;width:320px}</style></head>
<body>
  <div>Steam 客服</div>
  <div style="opacity:0.6;font-size:13px">主页 &gt; 发送代码</div>

  <div id="s1">
    <h2 style="color:#66c0f4;font-weight:500">您希望如何更改您的密码？</h2>
    <span class="row" id="resend">通过电子邮件发送帐户验证码至 h*******_********@i*****.c**　▶</span>
    <span class="row" id="recovery">我已无法访问此电子邮件地址，或是没有收到验证码　▶</span>
  </div>

  <div id="s2" style="display:none">
    <div>请输入 Steam Guard 验证码</div>
    <form id="f2">
      <input class="otp" data-i="0" type="text" maxlength="1" autocomplete="one-time-code">
      <input class="otp" data-i="1" type="text" maxlength="1">
      <input class="otp" data-i="2" type="text" maxlength="1">
      <input class="otp" data-i="3" type="text" maxlength="1">
      <input class="otp" data-i="4" type="text" maxlength="1">
      <button type="submit">提交</button>
    </form>
  </div>

  <div id="s3" style="display:none">
    <div>更改我的密码</div>
    <input class="pw" type="password" autocomplete="new-password">
    <div>再次输入新密码</div>
    <input class="pw" type="password" autocomplete="new-password">
    <button>更改密码</button>
  </div>

<script>
  function report(obj) {
    fetch('/__report', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(obj) }).catch(function(){});
  }
  function show(id) {
    ['s1','s2','s3'].forEach(function (k) {
      document.getElementById(k).style.display = (k === id) ? 'block' : 'none';
    });
  }
  document.getElementById('resend').addEventListener('click', function () {
    report({ step:'resend-clicked' });
    show('s2');
  });
  document.getElementById('recovery').addEventListener('click', function () {
    report({ step:'RECOVERY-CLICKED-WRONG-PATH' });
    show('s1');
  });
  document.getElementById('f2').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = Array.from(document.querySelectorAll('#f2 input'))
      .map(function (i) { return i.value; }).join('');
    report({ step:'code', code: code });
    if (code.toUpperCase() === ${JSON.stringify(GUARD_CODE2)}) show('s3');
  });
  document.querySelectorAll('#f2 input').forEach(function (el) {
    el.addEventListener('input', function () {
      var i = Number(el.getAttribute('data-i'));
      var next = document.querySelector('#f2 input[data-i="' + (i + 1) + '"]');
      if (el.value && next) next.focus();
    });
  });
</script>
</body></html>`;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__report') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        lastReport = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        reports.push(lastReport);
      } catch { /* 忽略 */ }
      res.writeHead(204); res.end();
    });
    return;
  }
  if (req.url === '/__events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reports));
    return;
  }
  if (req.url === '/__last') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lastReport));
    return;
  }
  if (req.url === '/__reset') {
    lastReport = null;
    reports = [];
    res.writeHead(204); res.end();
    return;
  }
  // 带验证码的两步登录页（注意要放在 /login 分支之前）
  // 表单由 JS 延迟渲染的登录页（真机就是 React 这么干的）
  if (req.url.startsWith('/login/lazy')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LAZY_LOGIN_PAGE);
    return;
  }
  // 「主页 > 发送代码」那一屏（URL 故意不含 /login，模拟真实向导页）
  if (req.url.startsWith('/wizard/sendcode')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SENDCODE_PAGE);
    return;
  }
  // 完整 6 步向导的起点（放在 /login/guard 之前，后者是它的前缀）
  if (req.url.startsWith('/login/guard3')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(GUARD3_PAGE);
    return;
  }
  // 两轮验证码（注意要放在 /login/guard 之前 —— 后者是前者的前缀）
  if (req.url.startsWith('/login/guard2')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(GUARD2_PAGE);
    return;
  }
  if (req.url.startsWith('/login/guard')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(GUARD_LOGIN_PAGE());
    return;
  }
  if (req.url.startsWith('/login')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGIN_PAGE);
    return;
  }
  // 登录成功后的落地页（URL 里没有 /login，登录循环据此判定通过）
  if (req.url.startsWith('/wizard/done')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>已登录</title></head>'
      + '<body><h1>已登录</h1><p>欢迎回来。</p></body></html>');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`模拟 Steam 改密页: http://127.0.0.1:${PORT}/wizard  (state 延迟 ${LAG}ms)`);
});

export { server, PORT, LAG };
