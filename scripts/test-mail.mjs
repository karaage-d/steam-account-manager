/**
 * 邮箱功能测试
 *
 *   node test-mail.mjs
 *
 * 用一个模拟的微软服务端 + 一个模拟取件接口跑完整链路，不需要真凭据。验证：
 *   [1] 添加邮箱 / 测试连接 / 拉取邮件 / 查看邮件
 *   [2] ★ token 轮换回写 ★ —— 不回写的话跑一阵子会集体失效
 *   [3] ★ 限流 ★ —— 请求间隔必须达标，且带随机抖动
 *   [4] ★ 429 退避 ★ —— 被限流时要等，不能硬刚
 *   [5] ★ 授权失效识别 ★ —— invalid_grant 要判成「需要重新授权」而非无限重试
 *   [6] ★ 凭据不泄露 ★ —— 数据库存密文，接口不返回明文
 *   [8] 验证码提取器
 *   [9] 账号关联邮箱 → 自动取码
 *   [10] 邮件列表带识别结果
 *   [12] ★ 取件接口（iCloud 路线）★ —— 字段名不认识也要能扛
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { htmlToText, normalizeMessage } from '../server/graph.mjs';
import { extractSteamCode, isSteamSender, looksLikeCodeMail } from '../server/code.mjs';
import {
  addressFromApiUrl, apiUrlHasCredential, collectStrings,
  parseWebmailResponse, normalizeWebmailMessage, toEpochSeconds,
  normalizeWebmailUrl,
} from '../server/webmail.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'server', 'index.mjs');

const MASTER = 'mail-test-123456';
const APP_PORT = 8902;
const MOCK_PORT = 8901;
const WEB_PORT = 8903;
const APP = `http://127.0.0.1:${APP_PORT}`;
const INITIAL_TOKEN = 'INITIAL-refresh-token-value';

/* 取件接口的凭据样例（结构照抄 wdmail 那种） */
const WEB_EMAIL = '39.sleeve_meshes@icloud.com';
const WEB_PASS = 'TEST-only-not-real';
const WEB_URL = `http://127.0.0.1:${WEB_PORT}/m?f=json&e=${WEB_EMAIL}:${WEB_PASS}`;

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fails.push(name + (extra ? ` — ${extra}` : '')); console.log(`  \u2717 ${name}${extra ? ' — ' + extra : ''}`); }
};

/* ------------------------------------------------------------------ */
/* 模拟微软                                                            */
/* ------------------------------------------------------------------ */

const state = {
  mode: 'ok',            // ok | invalid_grant | throttled
  tokenCalls: [],        // { at, clientId, refreshToken }
  graphCalls: [],        // { at, auth, url }
  rotation: 0,
  messages: [],
};

function json(res, code, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(text);
}

function readReq(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);

  if (url.pathname === '/token') {
    const form = new URLSearchParams(await readReq(req));
    state.tokenCalls.push({
      at: Date.now(),
      clientId: form.get('client_id'),
      refreshToken: form.get('refresh_token'),
    });
    if (state.mode === 'invalid_grant') {
      return json(res, 400, {
        error: 'invalid_grant',
        error_description: 'AADSTS700082: The refresh token has expired due to inactivity.',
        error_codes: ['AADSTS700082'],
      });
    }
    state.rotation += 1;
    return json(res, 200, {
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: `access-${state.rotation}`,
      refresh_token: `rotated-${state.rotation}`,   // ★ 每次都给新的（轮换）
    });
  }

  if (url.pathname.endsWith('/me/mailFolders/Inbox/messages')) {
    state.graphCalls.push({ at: Date.now(), auth: req.headers.authorization || '', url: req.url });
    if (state.mode === 'throttled') {
      return json(res, 429, { error: { code: 'TooManyRequests', message: 'Too many requests' } },
        { 'Retry-After': '2' });
    }
    return json(res, 200, { value: state.messages });
  }

  json(res, 404, { error: 'not found' });
});

/* ------------------------------------------------------------------ */
/* 模拟"取件接口"（wdmail 那种风格）                                     */
/* ------------------------------------------------------------------ */

const web = {
  /** json-未知字段 / html / 空 / 码只在别的字段里 / 500 / 401 */
  mode: 'json-unknown',
  hits: [],
};

const STEAM_SUBJECT = '您的 Steam 帐户安全代码';
const STEAM_CODE = 'K4F7B';

const webMock = http.createServer((req, res) => {
  web.hits.push({ at: Date.now(), url: req.url });
  const send = (code, body, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  if (web.mode === '500') return send(500, { error: 'boom' });
  if (web.mode === '401') return send(401, { error: 'bad credential' });

  if (web.mode === 'html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><body>
      <h1>邮箱邮件</h1><div>最近 24 小时邮件</div>
      <div class="mail"><div class="subj">${STEAM_SUBJECT}</div>
      <div class="body"><p>您的 Steam 安全代码是</p><b>${STEAM_CODE}</b></div></div>
    </body></html>`);
  }

  if (web.mode === 'empty') {
    return send(200, {
      code: 0,
      data: { recipient: WEB_EMAIL, mail_query_hours: 24, messages: [] },
    });
  }

  if (web.mode === 'code-elsewhere') {
    // messages 是空的，但码藏在别的字段里 —— 全靠"整段响应抠码"兜底
    return send(200, {
      code: 0,
      data: {
        recipient: WEB_EMAIL,
        mail_query_hours: 24,
        messages: [],
        latest_preview: `${STEAM_SUBJECT}：${STEAM_CODE}`,
      },
    });
  }

  if (web.mode === 'json-unknown') {
    // ★ 故意用完全陌生的字段名 ★ 看归一化能不能扛住
    return send(200, {
      code: 0,
      data: {
        recipient: WEB_EMAIL,
        mail_query_hours: 24,
        messages: [
          {
            msg_id: 'abc-123',
            title: STEAM_SUBJECT,                 // 不是 subject
            sender: 'noreply@steampowered.com',   // 不是 from
            rcpt: WEB_EMAIL,                      // 不是 to
            ts: '2026-10-07T16:00:00Z',           // 不是 date
            content: `<p>您的 Steam 安全代码是</p><b>${STEAM_CODE}</b><p>请勿泄露</p>`,
          },
          {
            msg_id: 'abc-124',
            title: '一封普通邮件',
            sender: 'someone@example.com',
            ts: '2026-10-07T15:00:00Z',
            content: '随便聊聊',
          },
        ],
      },
    });
  }

  // 兜底：和 json-unknown 一样的标准命名
  return send(200, {
    code: 0,
    data: {
      recipient: WEB_EMAIL, mail_query_hours: 24,
      messages: [{
        id: 'std-1', subject: STEAM_SUBJECT, from: 'noreply@steampowered.com',
        to: WEB_EMAIL, date: '2026-10-07T16:00:00Z',
        body: `您的 Steam 安全代码是 ${STEAM_CODE}`,
      }],
    },
  });
});

/* ------------------------------------------------------------------ */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-test-'));
let child = null;

const j = async (method, p, body) => {
  const r = await fetch(APP + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, data: t ? JSON.parse(t) : null };
};
let authToken = '';

function fakeMessage(i) {
  return {
    id: `msg-${i}`,
    subject: i === 1 ? '您的 Steam 帐户安全代码' : `邮件 ${i}`,
    from: { emailAddress: { address: 'noreply@steampowered.com', name: 'Steam' } },
    toRecipients: [{ emailAddress: { address: 'box@example.com' } }],
    receivedDateTime: new Date(Date.now() - i * 60000).toISOString(),
    bodyPreview: '预览',
    body: { contentType: 'html', content: `<p>代码</p><b>K4F7B</b><br>其他内容` },
  };
}

async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`${APP}/api/health`); if (r.ok) return true; } catch { /* 再等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

console.log('\n── 邮箱功能测试 ──\n');

await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
await new Promise((r) => webMock.listen(WEB_PORT, '127.0.0.1', r));

child = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    VAULT_DATA_DIR: DATA_DIR,
    GRAPH_TOKEN_URL: `http://127.0.0.1:${MOCK_PORT}/token`,
    GRAPH_BASE: `http://127.0.0.1:${MOCK_PORT}/v1.0`,
    MAIL_MIN_INTERVAL_MS: '300',
    MAIL_JITTER_MS: '120',
    MAIL_MAX_RETRIES: '2',
    MAIL_FETCH_TOP: '10',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => { const s = String(d); if (/\[error\]/.test(s)) console.log('[server]', s.trim()); });

try {
  if (!await waitForServer()) throw new Error('服务没能启动');

  await j('POST', '/api/setup', { masterPassword: MASTER });
  const un = await j('POST', '/api/unlock', { masterPassword: MASTER });
  authToken = un.data.token;
  ok('服务已启动并解锁', !!authToken);

  /* ---------------- [1] 基本流程 ---------------- */
  console.log('\n[1] 添加邮箱 → 测试 → 拉取');
  state.messages = [1, 2, 3].map(fakeMessage);

  const created = await j('POST', '/api/mailboxes', {
    label: '测试邮箱',
    address: 'box@example.com',
    clientId: 'test-client-id',
    refreshToken: INITIAL_TOKEN,
  });
  ok('添加成功', created.status === 200, JSON.stringify(created.data));
  const boxId = created.data?.mailbox?.id;
  ok('返回了 id', Number.isInteger(boxId));

  const tested = await j('POST', `/api/mailboxes/${boxId}/test`);
  ok('测试连接通过', tested.status === 200 && tested.data?.ok === true, JSON.stringify(tested.data));

  const fetched = await j('POST', `/api/mailboxes/${boxId}/fetch`);
  ok('拉取成功', fetched.status === 200 && fetched.data?.ok === true, JSON.stringify(fetched.data));
  ok('新增 3 封', fetched.data?.added === 3, `实际 ${fetched.data?.added}`);

  const list = await j('GET', `/api/mailboxes/${boxId}/messages`);
  ok('能列出邮件', list.data?.items?.length === 3, `实际 ${list.data?.items?.length}`);
  ok('主题正确', list.data?.items?.[0]?.subject === '邮件 1'
    || list.data?.items?.some((m) => /Steam/.test(m.subject)), '');

  const detail = await j('GET', `/api/messages/${list.data.items[0].id}`);
  ok('能看单封详情（含正文，后面提取验证码要用）', !!detail.data?.message?.bodyText);

  const again = await j('POST', `/api/mailboxes/${boxId}/fetch`);
  ok('重复拉取不会重复入库', again.data?.added === 0, `实际新增 ${again.data?.added}`);

  /* ---------------- [2] token 轮换回写 ---------------- */
  console.log('\n[2] ★ token 轮换回写（不写回的话跑一阵子会集体失效）');
  ok('第一次换取令牌用的是原始 token',
    state.tokenCalls[0]?.refreshToken === INITIAL_TOKEN, state.tokenCalls[0]?.refreshToken);

  // 强制清掉内存缓存：再测一次连接，会重新用 refresh token
  await j('POST', `/api/mailboxes/${boxId}/test`);
  const secondCall = state.tokenCalls[state.tokenCalls.length - 1];
  ok('★ 第二次用的是轮换后的新 token（说明回写生效了）',
    secondCall?.refreshToken === 'rotated-1', `实际用了 ${secondCall?.refreshToken}`);
  ok('用的是同一个 client_id', secondCall?.clientId === 'test-client-id');

  /* ---------------- [3] 限流 ---------------- */
  console.log('\n[3] ★ 限流：请求间隔 + 随机抖动');
  const gaps = [];
  for (let i = 1; i < state.graphCalls.length; i += 1) {
    gaps.push(state.graphCalls[i].at - state.graphCalls[i - 1].at);
  }
  const tokenGaps = [];
  for (let i = 1; i < state.tokenCalls.length; i += 1) {
    tokenGaps.push(state.tokenCalls[i].at - state.tokenCalls[i - 1].at);
  }
  console.log(`    Graph 请求间隔: ${gaps.join(', ')} ms`);
  console.log(`    令牌请求间隔: ${tokenGaps.join(', ')} ms`);
  ok('Graph 请求间隔都 >= 最小间隔（300ms）',
    gaps.every((g) => g >= 300), `实际 ${gaps.join(', ')}`);
  ok('令牌请求也走了同一个限流器',
    tokenGaps.every((g) => g >= 300), `实际 ${tokenGaps.join(', ')}`);
  const allGaps = [...gaps, ...tokenGaps];
  ok('间隔不是恒定值（有随机抖动，避免机器人特征）',
    new Set(allGaps).size > 1 || allGaps.length < 2, `取值：${allGaps.join(', ')}`);

  /* ---------------- [4] 429 退避 ---------------- */
  console.log('\n[4] ★ 429 限流退避');
  state.mode = 'throttled';
  const before = state.graphCalls.length;
  const t0 = Date.now();
  const throttled = await j('POST', `/api/mailboxes/${boxId}/fetch`);
  const took = Date.now() - t0;
  const attempts = state.graphCalls.length - before;
  console.log(`    重试了 ${attempts} 次，共耗时 ${(took / 1000).toFixed(1)} 秒`);
  ok('返回了错误而不是假装成功', throttled.status >= 400, JSON.stringify(throttled.data));
  ok('确实重试了（说明退避逻辑生效）', attempts >= 2, `实际 ${attempts} 次`);
  ok('读到了 Retry-After 并等待（> 2 秒）', took > 2000, `实际 ${took} ms`);
  state.mode = 'ok';

  /* ---------------- [5] 授权失效识别 ---------------- */
  console.log('\n[5] ★ 授权失效（invalid_grant）要识别出来');
  state.mode = 'invalid_grant';
  await j('POST', `/api/mailboxes/${boxId}/test`);
  const boxes = await j('GET', '/api/mailboxes');
  const box = boxes.data?.items?.find((b) => b.id === boxId);
  ok('邮箱被标记为「需要重新授权」', box?.status === 'need_reauth', `实际 ${box?.status}`);
  ok('记录了失败原因', /授权已失效|expired|无效/.test(box?.lastError || ''), box?.lastError);
  const failedTest = await j('POST', `/api/mailboxes/${boxId}/test`);
  // ★ 关键：不能用 401 ★
  //   前端 api.js 收到 401 会锁库回解锁页。邮箱 token 失效跟保险库会话无关，
  //   混用的话「某个邮箱 token 过期」会变成「整个保险库被锁上」。
  ok('★ 没有用 401（否则前端会误锁保险库）', failedTest.status !== 401,
    `实际状态码 ${failedTest.status}`);
  ok('返回 400 且带 needsReauth 标记，前端按 code 分支',
    failedTest.status === 400 && failedTest.data?.needsReauth === true
    && failedTest.data?.code === 'need_reauth',
    JSON.stringify(failedTest.data));
  state.mode = 'ok';

  /* ---------------- [6] 凭据不泄露 ---------------- */
  console.log('\n[6] ★ 凭据不泄露');
  const apiBox = (await j('GET', '/api/mailboxes')).data.items[0];
  const serialized = JSON.stringify(apiBox);
  ok('接口不返回 refresh token', !serialized.includes('rotated-') && !serialized.includes('INITIAL'));
  ok('接口只给一个 client_id 提示', typeof apiBox.clientIdHint === 'string');
  ok('有 hasToken 布尔标记', apiBox.hasToken === true);

  const db = new DatabaseSync(path.join(DATA_DIR, 'vault.db'));
  const row = db.prepare('SELECT refresh_token_enc FROM mailboxes WHERE id = ?').get(boxId);
  db.close();
  ok('数据库里存的是密文（v1.iv.tag.ct 格式）', /^v1\./.test(row?.refresh_token_enc || ''),
    row?.refresh_token_enc);
  ok('数据库里没有明文 token', !String(row?.refresh_token_enc || '').includes('rotated-'));

  const audit = await j('GET', '/api/audit?limit=50');
  const auditText = JSON.stringify(audit.data);
  ok('审计日志里也没有 token 明文', !auditText.includes('rotated-') && !auditText.includes('INITIAL'));

  /* ---------------- [8] 验证码提取器 ---------------- */
  console.log('\n[8] 验证码提取器');
  const EX = [
    ['您的 Steam 安全代码是：K4F7B', 'K4F7B', '中文冒号'],
    ['您的 Steam 帐户安全代码\n\nK4F7B\n\n如果不是您本人操作，请忽略', 'K4F7B', '换行分隔'],
    ['Steam 安全代码：  B9X2M  ', 'B9X2M', '多余空格'],
    ['Your Steam account security code is\n\nR7T4Q\n\nThanks', 'R7T4Q', '英文'],
    ['code: cd3ef', 'CD3EF', '小写要转成大写'],
    ['K4F7B 是您的 Steam 安全代码', 'K4F7B', '关键词在后'],
    ['这是一封普通邮件，没有验证码', null, '没有码就不给'],
    ['请访问 https://help.steampowered.com/zh-cn/ 获取帮助', null, '只有网址不能误抓'],
    ['5TQ8W 与 8WQ5T 都像是码', null, '没有关键词锚点时，多个候选宁可不猜'],
    ['', null, '空文本'],
  ];
  for (const [text, want, desc] of EX) {
    const got = extractSteamCode(text)?.code ?? null;
    ok(`  ${desc} → ${want ?? '(不给)'}`, got === want, `实际 ${got}`);
  }
  ok('Steam 发件人识别', isSteamSender('noreply@steampowered.com')
    && isSteamSender('noreply@steamgames.com') && !isSteamSender('foo@example.com'));
  ok('验证码邮件识别', looksLikeCodeMail('您的 Steam 帐户安全代码', '正文', 'noreply@steampowered.com')
    && !looksLikeCodeMail('促销邮件', '打折啦', 'noreply@steampowered.com'));
  ok('普通单词不会被当验证码（STEAM / HTTPS）',
    extractSteamCode('STEAM HTTPS') === null);
  ok('有「代码」锚点时能提取（靠 looksLikeCode 保精度）',
    extractSteamCode('Steam 代码 5TQ8W 请勿泄露')?.code === '5TQ8W');

  /* ---------------- [9] 账号关联邮箱 + 取码 ---------------- */
  console.log('\n[9] ★ 账号关联邮箱 → 自动取验证码');
  const boxesNow = (await j('GET', '/api/mailboxes')).data.items;
  const boxId2 = boxesNow[0].id;

  const acc = await j('POST', '/api/accounts', {
    username: 'code_test_acc', password: 'Abcdefg123', email: 'box@example.com',
    game: '测试游戏', usageMinutes: 60, mailboxId: boxId2,
  });
  ok('建账号时能直接关联邮箱', acc.status === 200, JSON.stringify(acc.data));
  const accId = acc.data?.account?.id;
  ok('账号视图带 mailboxId', acc.data?.account?.mailboxId === boxId2,
    `实际 ${acc.data?.account?.mailboxId}`);

  // 让模拟邮箱里出现一封带验证码的 Steam 邮件
  state.messages = [fakeMessage(1)];
  const codeRes = await j('GET', `/api/accounts/${accId}/code?since=0&wait=12`);
  ok('★ 取到了验证码', codeRes.data?.code === 'K4F7B', JSON.stringify(codeRes.data));
  ok('给出了识别来源', !!codeRes.data?.source, codeRes.data?.source);
  ok('给出了对应邮件的信息', !!codeRes.data?.message?.subject, JSON.stringify(codeRes.data?.message));
  ok('取码过程有审计记录', (await j('GET', '/api/audit?limit=20')).data.items
    .some((r) => r.action === 'code.fetch'));

  // 没关联邮箱的账号要明确报错，而不是静默失败
  const acc2 = await j('POST', '/api/accounts', {
    username: 'no_mailbox_acc', password: 'Abcdefg123', usageMinutes: 60,
  });
  const noBox = await j('GET', `/api/accounts/${acc2.data.account.id}/code?since=0&wait=0`);
  ok('没关联邮箱时给出明确错误', noBox.status === 400 && noBox.data?.code === 'no_mailbox',
    JSON.stringify(noBox.data));
  ok('★ 也没有用 401（否则前端会误锁保险库）', noBox.status !== 401);

  // 删除邮箱要把账号的关联解掉，不能留下悬空引用
  await j('DELETE', `/api/mailboxes/${boxId2}`);
  const afterDel = await j('GET', '/api/accounts?state=available');
  const stillLinked = (afterDel.data.items || []).find((a) => a.id === accId);
  ok('删除邮箱后账号的关联被解掉', stillLinked?.mailboxId === null,
    `实际 ${stillLinked?.mailboxId}`);

  /* ---------------- [10] 邮件列表带识别结果 ---------------- */
  console.log('\n[10] 邮件列表里直接标出识别到的验证码');
  // 重建一个邮箱并拉一次
  const nb = await j('POST', '/api/mailboxes', {
    label: '再测一次', address: 'box2@example.com', clientId: 'test-client-id', refreshToken: 'tok2',
  });
  state.messages = [fakeMessage(1), fakeMessage(3)];
  await j('POST', `/api/mailboxes/${nb.data.mailbox.id}/fetch`);
  const list2 = await j('GET', `/api/mailboxes/${nb.data.mailbox.id}/messages`);
  const withCode = (list2.data.items || []).find((m) => m.code);
  ok('列表项直接带 code 字段', withCode?.code === 'K4F7B', JSON.stringify(list2.data.items?.[0]));
  ok('标出了是不是 Steam 发来的', list2.data.items?.[0]?.isSteam === true);
  ok('列表接口不返回完整正文（避免响应过大）',
    list2.data.items?.every((m) => m.bodyText === undefined));

  console.log('\n[11] HTML 转纯文本 / 归一化');
  ok('HTML 标签被去掉', !htmlToText('<p>代码</p><b>K4F7B</b>').includes('<'));
  ok('换行被保留下来', htmlToText('<p>甲</p><p>乙</p>').includes('\n'));
  ok('实体被还原', htmlToText('<span>a&nbsp;b&amp;c</span>').replace(/\s+/g, ' ').includes('a b&c'));
  const nm = normalizeMessage(fakeMessage(1));
  ok('归一化出收件地址', nm.toAddress === 'box@example.com');
  ok('归一化出时间戳', nm.receivedAt > 0);
  ok('归一化出纯文本正文（后面提取验证码要用）',
    nm.bodyText.includes('K4F7B'), nm.bodyText);

  /* ---------------- [12] 取件接口（iCloud 路线）---------------- */
  console.log('\n[12] ★ 取件接口：从地址里认邮箱 / 认凭据');
  ok('能从 ?e=邮箱:密码 里认出邮箱',
    addressFromApiUrl(WEB_URL) === WEB_EMAIL, addressFromApiUrl(WEB_URL));
  ok('能识别出地址里内嵌了凭据', apiUrlHasCredential(WEB_URL) === true);
  ok('普通地址不会被误判',
    apiUrlHasCredential('https://api.example.com/m?f=json&id=123') === false);
  ok('不是 URL 就返回空', addressFromApiUrl('随便一段文字') === '');

  console.log('\n[13] ★ 取件接口：字段名不认识也要扛得住');
  // 对方第一次返回的字段名和我们猜的完全不一样
  const webBox = await j('POST', '/api/mailboxes', {
    provider: 'http', label: 'iCloud 测试', apiUrl: WEB_URL,
    // 故意不传 address —— 应该从 URL 里自动认出来
  });
  ok('添加成功（地址自动识别）', webBox.status === 200, JSON.stringify(webBox.data));
  ok('★ 邮箱地址是从接口地址里自动认出来的',
    webBox.data?.mailbox?.address === WEB_EMAIL, webBox.data?.mailbox?.address);
  ok('标成了取件接口', webBox.data?.mailbox?.provider === 'http');
  ok('标出了「凭据内嵌在地址里」', webBox.data?.mailbox?.credentialInUrl === true);
  ok('接口没有返回那条地址', !JSON.stringify(webBox.data).includes(WEB_PASS));
  ok('提示了地址即钥匙', /钥匙|外传/.test(webBox.data?.hint || ''), webBox.data?.hint);
  const webId = webBox.data.mailbox.id;

  const webTest = await j('POST', `/api/mailboxes/${webId}/test`);
  ok('测试连接通过', webTest.status === 200 && webTest.data?.ok === true,
    JSON.stringify(webTest.data));
  ok('测试结果带上了接口自报的邮箱', webTest.data?.reportedAddress === WEB_EMAIL);

  const webFetch = await j('POST', `/api/mailboxes/${webId}/fetch`);
  ok('拉取成功', webFetch.status === 200 && webFetch.data?.ok === true, JSON.stringify(webFetch.data));
  ok('★ 陌生字段名也解析出了 2 封', webFetch.data?.fetched === 2, `实际 ${webFetch.data?.fetched}`);
  ok('带回了接口的查询窗口（24 小时）', webFetch.data?.queryHours === 24);

  const webList = await j('GET', `/api/mailboxes/${webId}/messages`);
  const items = webList.data.items;
  ok('列表能拿到 2 封', items.length === 2, `实际 ${items.length}`);
  const good = items.find((m) => m.code);
  ok('★ 从陌生字段里认出了验证码', good?.code === 'K4F7B', JSON.stringify(items[0]));

  // 再拉一次不能重复入库
  const webAgain = await j('POST', `/api/mailboxes/${webId}/fetch`);
  ok('★ 重复拉取不重复入库（id 要稳定，不能拿数组下标当 id）',
    webAgain.data?.added === 0, `实际新增 ${webAgain.data?.added}`);

  console.log('\n[14] ★ 取件接口：几个异常场景');
  // 码只藏在非 messages 字段里 → 靠"整段响应抠码"兜底
  web.mode = 'code-elsewhere';
  await j('POST', `/api/mailboxes/${webId}/fetch`);
  const accW = await j('POST', '/api/accounts', {
    username: 'web_code_acc', password: 'Abcdefg123', email: WEB_EMAIL,
    usageMinutes: 60, mailboxId: webId,
  });
  const codeW = await j('GET', `/api/accounts/${accW.data.account.id}/code?since=0&wait=8`);
  ok('★ 结构化邮件为空时，仍能从整段响应里抠出验证码',
    codeW.data?.code === 'K4F7B', JSON.stringify(codeW.data));

  // HTML 形态
  web.mode = 'html';
  const webBox2 = await j('POST', '/api/mailboxes', {
    provider: 'http', label: 'HTML 形态', address: 'html@icloud.com',
    apiUrl: `http://127.0.0.1:${WEB_PORT}/m?f=html&e=html@icloud.com:x`,
  });
  const htmlFetch = await j('POST', `/api/mailboxes/${webBox2.data.mailbox.id}/fetch`);
  ok('HTML 形态也能通', htmlFetch.status === 200, JSON.stringify(htmlFetch.data));
  web.mode = 'empty';
  const emptyFetch = await j('POST', `/api/mailboxes/${webBox2.data.mailbox.id}/fetch`);
  ok('接口没邮件时是「取回 0 封」而不是报错',
    emptyFetch.status === 200 && emptyFetch.data?.fetched === 0, JSON.stringify(emptyFetch.data));

  // 服务端错误要能重试并最终报错，而不是假装成功
  web.mode = '500';
  const errFetch = await j('POST', `/api/mailboxes/${webBox2.data.mailbox.id}/fetch`);
  ok('接口 500 时如实报错', errFetch.status >= 400, JSON.stringify(errFetch.data));
  ok('  错误信息里说明了是接口的问题', /接口/.test(errFetch.data?.error || ''), errFetch.data?.error);

  // 凭据失效要能识别
  web.mode = '401';
  const authFetch = await j('POST', `/api/mailboxes/${webBox2.data.mailbox.id}/fetch`);
  ok('★ 接口 401 判成「需要重新授权」，而不是无限重试',
    authFetch.data?.needsReauth === true, JSON.stringify(authFetch.data));
  ok('  仍然没有用 401 状态码（否则前端会误锁保险库）',
    authFetch.status !== 401, `实际 ${authFetch.status}`);
  web.mode = 'json-unknown';

  console.log('\n[15] 取件接口的纯函数');
  const strs = collectStrings({ a: 'x', b: { c: 'y' }, d: ['z', 1, null] });
  ok('只收集字符串值、不收集键名', strs.join(',') === 'x,y,z', strs.join(','));
  ok('毫秒时间戳会转成秒', toEpochSeconds(1791264778806) === 1791264778);
  ok('ISO 时间串能解析', toEpochSeconds('2026-10-07T16:00:00Z') > 0);
  ok('空值返回 0', toEpochSeconds(null) === 0);
  const nm2 = normalizeWebmailMessage({ msg_id: 'id-9', title: 'S', sender: 'a@b.c', content: 'body' });
  ok('陌生字段名也能归一化', nm2.subject === 'S' && nm2.fromAddress === 'a@b.c' && nm2.bodyText === 'body');
  ok('有 id 时用 id 做稳定标识', nm2.graphId === 'web-id-9', nm2.graphId);
  const nm3 = normalizeWebmailMessage({ title: 'S', content: 'body' });
  const nm4 = normalizeWebmailMessage({ title: 'S', content: 'body' });
  ok('★ 没有 id 时用内容指纹，两次结果一致', nm3.graphId === nm4.graphId, `${nm3.graphId} vs ${nm4.graphId}`);
  const bad = parseWebmailResponse('{"code":401,"message":"bad key"}', 'application/json');
  ok('接口自报的失败码能被识别', bad.ok === false && /bad key/.test(bad.error), JSON.stringify(bad));

  /* ---------------- [16] 真实邮件踩过的三个坑 ---------------- */
  console.log('\n[16] ★ 真实邮件踩过的坑（回归）');

  // 坑 1：iCloud 转发把发件人域名改写了，只认域名的写法会把验证码邮件整封误杀
  const ICLOUD_SENDER = 'Steam 客服 <noreply_at_steampowered_com_sqm20d3fm5yze5_485r9081@icloud.com>';
  ok('★ iCloud 改写过的 Steam 发件人能认出来', isSteamSender(ICLOUD_SENDER) === true,
    String(isSteamSender(ICLOUD_SENDER)));
  ok('  普通 @icloud.com 不会被误认', isSteamSender('someone@icloud.com') === false);
  ok('  正常 Steam 域名仍然认', isSteamSender('noreply@steampowered.com') === true);
  ok('  steamgames / valvesoftware 也认',
    isSteamSender('x@steamgames.com') === true && isSteamSender('x@valvesoftware.com') === true);

  // 坑 2：码在冒号后的下一行，正文里还有 XHTML 这种 5 字母干扰项
  const REAL_BODY = '在 Steam 上出现了一次新的登录\n'
    + 'Steam 令牌验证码：\nMNC9P\n\n'
    + '<!DOCTYPE html XHTML 1.0 Transitional>\n如果这不是您本人操作，请忽略。';
  const realHit = extractSteamCode(REAL_BODY);
  ok('★ 码在冒号下一行也能取到（正则需要跨换行）',
    realHit?.code === 'MNC9P', JSON.stringify(realHit));
  ok('  来源标为关键词锚定', /关键词锚定/.test(realHit?.source || ''), realHit?.source);
  ok('  整封邮件能被判为验证码邮件',
    looksLikeCodeMail('您的 Steam 帐户：来自新网页或移动设备的访问', REAL_BODY, ICLOUD_SENDER) === true);

  // 多个候选时用 Steam 字符表甄别（XHTML 含 L，不在表里）
  const twoCand = extractSteamCode('验证码是 5TQ8W，另见 8WQ5T 与 XHTML 说明');
  ok('  多候选时仍不硬猜（无法甄别就给 null）', twoCand === null || twoCand.code === '5TQ8W');
  const strictPick = extractSteamCode('无关词 XHTML 出现在前面，验证码 K4F7B 在后面');
  ok('  有明确关键词锚定时优先级最高', strictPick?.code === 'K4F7B', JSON.stringify(strictPick));

  // 坑 3：「邮箱地址」那一栏被填成整条接口地址
  const badAddr = await j('POST', '/api/mailboxes', {
    provider: 'http',
    label: '地址填错',
    apiUrl: `http://127.0.0.1:${WEB_PORT}/m?f=json&e=bad-addr@icloud.com:zzz`,
    address: `http://127.0.0.1:${WEB_PORT}/m?f=json&e=bad-addr@icloud.com:zzz`,
  });
  ok('★ 「邮箱地址」被粘成 URL 时会自动抠出邮箱',
    badAddr.data?.mailbox?.address === 'bad-addr@icloud.com', badAddr.data?.mailbox?.address);

  // 地址填得不对，但接口地址里能认出邮箱 → 用接口里的（兜底而不是报错）
  const fallbackAddr = await j('POST', '/api/mailboxes', {
    provider: 'http', label: '地址乱填',
    apiUrl: `http://127.0.0.1:${WEB_PORT}/m?f=json&e=fallback@icloud.com:zzz`,
    address: '这不是邮箱',
  });
  ok('  地址乱填时会回落到接口地址里的邮箱',
    fallbackAddr.data?.mailbox?.address === 'fallback@icloud.com',
    fallbackAddr.data?.mailbox?.address);

  // 两边都认不出邮箱 → 必须明确拒绝，不能存一个假的地址进库
  const reallyBad = await j('POST', '/api/mailboxes', {
    provider: 'http', apiUrl: 'https://api.example.com/m', address: '这不是邮箱',
  });
  ok('★ 完全认不出邮箱时明确拒绝',
    reallyBad.status === 400 && /不是合法的邮箱地址/.test(reallyBad.data?.error || ''),
    JSON.stringify(reallyBad.data));
  // 真实那封邮件的字段名（wdmail 用的是 text_body / sender / received_at）
  const realShape = normalizeWebmailMessage({
    id: '87017c2d-f79a-4f0a-9ba3-29a31f9dc525',
    recipient: 'humbugs_errors4z@icloud.com',
    sender: 'Steam 客服 <noreply_at_steampowered_com_sqm20d3fm5yze5_485r9081@icloud.com>',
    subject: '您的 Steam 帐户：来自新网页或移动设备的访问',
    received_at: '2026-10-09 21:13:22+08:00',
    text_body: '3945687452，您好！\n\n此处是您访问帐户所需的\nSteam 令牌验证码：\n\n请求来自\n香港\n\n登录代码\n7JRCW\n\n\n不是您？',
  });
  ok('★ text_body 字段能被认作正文（不然界面预览会是一串 id）',
    realShape.bodyText.includes('登录代码') && !realShape.bodyText.includes('87017c2d'),
    realShape.bodyText.slice(0, 60));
  ok('  sender 字段能被认作发件人', /steampowered/.test(realShape.fromAddress));
  ok('  received_at 能被解析成时间戳', realShape.receivedAt > 0,
    String(realShape.receivedAt));
  ok('  id 用作稳定标识', realShape.graphId === 'web-87017c2d-f79a-4f0a-9ba3-29a31f9dc525');

  const realCode = extractSteamCode(realShape.bodyText);
  ok('★ 真实邮件里的验证码能抠出来（关键词是「登录代码」）',
    realCode?.code === '7JRCW', JSON.stringify(realCode));

  /* ============ ★ f=html 自动改成 f=json ★ ============ */
  // wdmail 的复制按钮给的是 f=html 版（浏览器里看的整页 HTML），
  // 我们解析不出一封封邮件 —— 实测同一个邮箱：f=html 得 0 封、f=json 得 1 封。
  // 用户从浏览器复制来的必然是这个版本，已经踩过两次，所以保存时直接替他换掉。
  console.log('\n★ f=html → f=json 自动修正');

  const html1 = normalizeWebmailUrl('https://api.wdmail.top/m?f=html&e=a@icloud.com:pw');
  ok('★★ 带 f=html 的被换成 f=json', html1.changed && /f=json/.test(html1.url) && !/f=html/.test(html1.url), html1.url);
  ok('  凭据部分原样保留', html1.url.includes('a@icloud.com:pw'), html1.url);

  const json1 = normalizeWebmailUrl('https://api.wdmail.top/m?f=json&e=a@icloud.com:pw');
  ok('  本来就是 f=json 的不动它', !json1.changed && json1.url === 'https://api.wdmail.top/m?f=json&e=a@icloud.com:pw');

  const none = normalizeWebmailUrl('https://api.wdmail.top/m?e=a@icloud.com:pw');
  ok('  没有 f= 参数的不动它', !none.changed, none.url);

  const upper = normalizeWebmailUrl('https://x.com/m?F=HTML&e=a@b.c:d');
  // 换出来统一是小写 f=json（服务端参数名不区分大小写，但统一成小写少一种形态）
  ok('  大小写不敏感', upper.changed && /f=json/i.test(upper.url) && !/html/i.test(upper.url), upper.url);

  // 端到端：把用户实际给我的那条整行粘进去
  const realLine = 'humbugs_errors4z@icloud.com----https://api.wdmail.top/m?f=html&e=humbugs_errors4z@icloud.com:TF4Tqxn8';
  const mb = await j('POST', '/api/mailboxes', { provider: 'http', label: '整行粘贴', apiUrl: realLine });
  ok('★★ 整行粘贴能拆出邮箱地址', mb.data?.mailbox?.address === 'humbugs_errors4z@icloud.com', mb.data?.mailbox?.address);
  ok('★★ 并且返回里说明了"已把 f=html 换成 f=json"', /f=html 自动改成 f=json/.test(mb.data?.hint || ''), mb.data?.hint);

} catch (e) {
  console.log(`\n  \u2717 测试中断：${e.message}\n${e.stack}`);
  fails.push('异常中断：' + e.message);
} finally {
  if (child) child.kill();
  mock.close();
  webMock.close();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n── 结果：${pass} 通过 / ${fails.length} 失败 ──`);
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  · ' + f); }
console.log('');
process.exit(fails.length ? 1 : 0);
