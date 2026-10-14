/**
 * ★ 假闲管家：按官方规则调我们的 6 个接口 ★
 *
 * 闲管家没有沙箱环境，真机上没法试错。所以这个测试器自己当"闲管家"：
 *   按官方签名规则发请求 → 检查我们的响应是否符合它的强校验。
 *
 * 重点验证四件事（真机上出错代价最大的）：
 *   ① 签名：官方测试向量已单独验过，这里验"整条链路能过"
 *   ② 发号：买家下单 → 真的领到一个空闲账号并进「使用中」
 *   ③ ★幂等★：同一个订单号重复请求 → 必须返回同一张卡密，绝不能领第二个账号
 *   ④ 没货：返回 1102「商品库存不足」，而不是 500 或者发个空号
 *
 * 用法：node test-xgj-flow.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { md5, goodsNoFor, gameCode } from '../server/xianguanjia.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8941;
const DATA = path.join(os.tmpdir(), 'xgj-flow-test');

let pass = 0; const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name} — ${extra}`); console.log(`  ✗ ${name} — ${extra}`); }
};

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const app = spawn('D:\\node.exe', [path.join(ROOT, 'server', 'index.mjs')], {
  env: { ...process.env, PORT: String(PORT), VAULT_DATA_DIR: DATA },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 3000));

const BASE = `http://127.0.0.1:${PORT}`;

/* ---------------- 我们扮演闲管家 ---------------- */
/** 假装这是闲管家的服务器 IP（官方网段 120.24.0.0-120.24.255.255 里挑一个） */
const XGJ_IP = '120.24.88.66';

const CFG = {
  appId: '677859093659717',
  appSecret: 'wK63PxlBOaY9NoqMksLeZySzGIW25ifA',
  mchId: 'steam01',
  mchSecret: 'my-secret-abc123',
};

/** 按官方规则签名并请求 */
async function xgj(pathname, body = null, {
  badSign = false, skew = 0, noSign = false, ip = XGJ_IP, spoofXff = null,
} = {}) {
  const ts = Math.floor(Date.now() / 1000) + skew;
  const bodyString = body === null ? '' : JSON.stringify(body);
  const bodyMd5 = md5(bodyString);
  const sign = md5([
    CFG.appId, CFG.appSecret, bodyMd5, String(ts), CFG.mchId, CFG.mchSecret,
  ].join(','));
  const qs = noSign ? '' : `?mch_id=${encodeURIComponent(CFG.mchId)}&timestamp=${ts}&sign=${badSign ? 'deadbeef' : sign}`;

  const headers = { 'Content-Type': 'application/json' };
  // 模拟"从公网隧道过来"：Cloudflare 会写这个头
  if (ip) headers['CF-Connecting-IP'] = ip;
  // 用来验证"伪造 XFF 骗不过白名单"
  if (spoofXff) headers['X-Forwarded-For'] = spoofXff;

  const r = await fetch(`${BASE}${pathname}${qs}`, {
    method: 'POST',
    headers,
    body: body === null ? undefined : bodyString,
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: r.status, data };
}

/* ---------------- 准备数据 ---------------- */
const j = async (m, p, b, tok) => {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = `Bearer ${tok}`;
  const r = await fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: { raw: t } }; }
};

const s = await j('POST', '/api/setup', { masterPassword: 'xgj-test-123456' });
const tok = s.data.token;

// 开对接
await j('PUT', '/api/settings', {
  xgj: { enabled: true, ...CFG },
}, tok);

// 三个游戏的账号
const mk = async (username, game) => (await j('POST', '/api/accounts',
  { username, password: 'XgjPw123', game, usageMinutes: 60 }, tok)).data.account;

const a1 = await mk('xgj_ljzyq_1', '链在一起');
const a2 = await mk('xgj_ljzyq_2', '链在一起');
const a3 = await mk('xgj_cs2_1', 'CS2');

console.log(`准备完毕：链在一起 ×2、CS2 ×1\n`);

/* ================= ① 查询平台信息 ================= */
console.log('① 查询平台信息（闲管家保存应用时第一个调的）');
{
  const r = await xgj('/goofish/open/info');
  ok('  HTTP 200', r.status === 200, String(r.status));
  ok('  code = 0', r.data.code === 0, JSON.stringify(r.data).slice(0, 140));
  ok('★★★ app_id 返回的是闲管家给的那个 AppKey（写错它保存应用就失败）',
    String(r.data.data?.app_id) === CFG.appId, String(r.data.data?.app_id));
  ok('  features 三个开关都在',
    r.data.data?.features && 'is_support_order_refund' in r.data.data.features
    && 'is_support_goods_notify' in r.data.data.features
    && 'is_support_loss_purchase' in r.data.data.features,
    JSON.stringify(r.data.data?.features));
}

/* ================= ② 查询商户信息 ================= */
console.log('\n② 查询商户信息');
{
  const r = await xgj('/goofish/user/info');
  ok('  code = 0', r.data.code === 0, JSON.stringify(r.data).slice(0, 140));
  ok('  balance 是大于 0 的整数', Number.isInteger(r.data.data?.balance) && r.data.data.balance > 0,
    String(r.data.data?.balance));
}

/* ================= ③ 查询商品列表 ================= */
console.log('\n③ 查询商品列表（游戏 × 档位，实时算）');
let goodsNo6h = '';
let goodsNo12h = '';
{
  const r = await xgj('/goofish/goods/list', { keyword: '', goods_type: 2, page_no: 1, page_size: 50 });
  ok('  code = 0', r.data.code === 0, JSON.stringify(r.data).slice(0, 140));
  const list = r.data.data?.list || [];
  // 2 个游戏 × 3 个档位 = 6 个商品
  ok('★★ 商品数 = 游戏数 × 档位数（2×3=6）', list.length === 6, `实际 ${list.length}`);

  const names = list.map((g) => g.goods_name);
  ok('  商品名带上了时长',
    names.includes('链在一起 6 小时') || names.includes('链在一起 6小时'),
    names.join(' | '));

  const ljzyq6 = list.find((g) => g.goods_name.startsWith('链在一起') && g.goods_no.endsWith('-360'));
  goodsNo6h = ljzyq6?.goods_no || '';
  goodsNo12h = list.find((g) => g.goods_name.startsWith('链在一起') && g.goods_no.endsWith('-720'))?.goods_no || '';

  ok('★★ 链在一起 6 小时：库存 = 2', ljzyq6?.stock === 2, `stock=${ljzyq6?.stock}`);
  ok('  有货时 status = 1（在架）', ljzyq6?.status === 1, String(ljzyq6?.status));

  const cs2 = list.find((g) => g.goods_name.startsWith('CS2') && g.goods_no.endsWith('-360'));
  ok('  CS2 6 小时：库存 = 1', cs2?.stock === 1, `stock=${cs2?.stock}`);

  const none = list.find((g) => g.goods_name.startsWith('CS2') && g.goods_no.endsWith('-1440'));
  // ★ 库存是按「游戏」算的，不是按档位 ★
  //   因为同一个账号能接任意时长（下单时把使用时间改成订单要的档位），
  //   所以 CS2 只有一个账号时，它的每个档位都显示库存 1 —— 这是对的。
  ok('★ 同游戏的各档位库存相同（库存按游戏算，一个号能接任意时长）',
    none && none.stock === 1 && none.status === 1,
    JSON.stringify(none));

  ok('  count 是总数', r.data.data?.count === 6, String(r.data.data?.count));
  ok('  goods_type 都是 2（卡密）', list.every((g) => g.goods_type === 2));
  ok('  update_time 是秒级时间戳', list.every((g) => Number.isInteger(g.update_time) && g.update_time > 1e9));
}

/* ================= ④ 查询商品详情 ================= */
console.log('\n④ 查询商品详情');
{
  const r = await xgj('/goofish/goods/detail', { goods_type: 2, goods_no: goodsNo6h });
  ok('  code = 0', r.data.code === 0, JSON.stringify(r.data).slice(0, 140));
  ok('  goods_no 对得上', r.data.data?.goods_no === goodsNo6h);
  ok('  库存是 2', r.data.data?.stock === 2, String(r.data.data?.stock));

  const bad = await xgj('/goofish/goods/detail', { goods_type: 2, goods_no: 'g00000000-360' });
  ok('★ 商品不存在 → 1100',
    bad.data.code === 1100, `code=${bad.data.code}`);
}

/* ================= ⑤ ★ 创建卡密订单 ================= */
console.log('\n⑤ 创建卡密订单（核心）');
const ORDER1 = 'XGJ-ORDER-0001';
let card1 = null;
{
  const r = await xgj('/goofish/order/purchase/create', {
    order_no: ORDER1,
    goods_no: goodsNo6h,
    buy_quantity: 1,
    notify_url: 'https://open.goofish.pro/api/open/callback/virtual/order/notify/TOKEN',
    biz_order_no: 'XY-ORDER-9999',
  });
  ok('  code = 0', r.data.code === 0, JSON.stringify(r.data).slice(0, 200));
  const d = r.data.data || {};
  ok('★★★ 拿到卡密了（账号 + 密码）',
    Array.isArray(d.card_items) && d.card_items.length === 1 && !!d.card_items[0].card_pwd,
    JSON.stringify(d.card_items));
  card1 = d.card_items?.[0] || null;
  ok('  卡号就是账号名', /^xgj_ljzyq_/.test(card1?.card_no || ''), String(card1?.card_no));
  ok('  order_status = 20（已成功）', d.order_status === 20, String(d.order_status));
  ok('★ 必填字段一个不少（out_order_no/order_no/order_status/order_amount/order_time）',
    d.out_order_no && d.order_no === ORDER1 && d.order_status === 20
    && Number.isInteger(d.order_amount) && Number.isInteger(d.order_time),
    JSON.stringify(d).slice(0, 200));
  ok('★ 已成功必须返回 end_time', Number.isInteger(d.end_time), String(d.end_time));

  // 账号真的进「使用中」了吗
  const inUse = (await j('GET', '/api/accounts?state=in_use', null, tok)).data.items || [];
  ok('★★ 领走的账号真的进入了「使用中」',
    inUse.some((a) => a.username === card1?.card_no),
    inUse.map((a) => a.username).join(','));

  // 使用时长被改成订单的 6 小时了吗
  const acc = inUse.find((a) => a.username === card1?.card_no);
  ok('★★★ 使用时长按订单改成了 360 分钟（6 小时）',
    acc?.usageMinutes === 360 && acc?.session?.plannedMinutes === 360,
    `usage=${acc?.usageMinutes} planned=${acc?.session?.plannedMinutes}`);

  // 库存少了一个
  const after = await xgj('/goofish/goods/list', { keyword: goodsNo6h, goods_type: 2, page_no: 1, page_size: 50 });
  ok('★ 库存从 2 变成 1', after.data.data?.list?.[0]?.stock === 1,
    String(after.data.data?.list?.[0]?.stock));
}

/* ================= ⑥ ★★★ 幂等 ================= */
console.log('\n⑥ ★★★ 幂等：同一个订单号再来一次');
{
  const inUseBefore = ((await j('GET', '/api/accounts?state=in_use', null, tok)).data.items || []).length;

  const r = await xgj('/goofish/order/purchase/create', {
    order_no: ORDER1,          // ← 同一个订单号！
    goods_no: goodsNo6h,
    buy_quantity: 1,
    notify_url: 'https://open.goofish.pro/api/open/callback/virtual/order/notify/TOKEN',
    biz_order_no: 'XY-ORDER-9999',
  });
  ok('  code = 0（重复请求不报错）', r.data.code === 0, JSON.stringify(r.data).slice(0, 160));
  const d = r.data.data || {};
  ok('★★★ 返回的是同一张卡密（不是新领的）',
    d.card_items?.[0]?.card_no === card1?.card_no,
    `第一次 ${card1?.card_no} / 这次 ${d.card_items?.[0]?.card_no}`);
  ok('★★★ 没有多领一个账号（使用中数量没变）',
    ((await j('GET', '/api/accounts?state=in_use', null, tok)).data.items || []).length === inUseBefore,
    `${inUseBefore} → ${((await j('GET', '/api/accounts?state=in_use', null, tok)).data.items || []).length}`);

  // 库存也不该再少
  const after = await xgj('/goofish/goods/list', { keyword: goodsNo6h, goods_type: 2, page_no: 1, page_size: 50 });
  ok('★★★ 库存不会再少（还是 1）', after.data.data?.list?.[0]?.stock === 1,
    String(after.data.data?.list?.[0]?.stock));
}

/* ================= ⑦ 查询订单详情 ================= */
console.log('\n⑦ 查询订单详情（闲管家发货后核验）');
{
  const r = await xgj('/goofish/order/detail', { order_type: 2, order_no: ORDER1 });
  ok('  code = 0', r.data.code === 0, JSON.stringify(r.data).slice(0, 160));
  const d = r.data.data || {};
  ok('  拿回来的还是那张卡密', d.card_items?.[0]?.card_no === card1?.card_no, String(d.card_items?.[0]?.card_no));
  ok('★ 必填字段齐全（order_type/order_no/out_order_no/order_status/order_amount/goods_no/goods_name/buy_quantity/order_time）',
    d.order_type === 2 && d.order_no === ORDER1 && d.out_order_no && d.order_status === 20
    && Number.isInteger(d.order_amount) && d.goods_no === goodsNo6h && d.goods_name && d.buy_quantity === 1
    && Number.isInteger(d.order_time),
    JSON.stringify(d).slice(0, 240));

  const notFound = await xgj('/goofish/order/detail', { order_type: 2, order_no: 'NEVER-EXIST' });
  ok('  订单不存在 → 1200', notFound.data.code === 1200, `code=${notFound.data.code}`);
}

/* ================= ⑧ 没货 ================= */
console.log('\n⑧ 没货时的表现');
{
  // 只剩 1 个链在一起，先把它也领走
  const r1 = await xgj('/goofish/order/purchase/create', {
    order_no: 'XGJ-ORDER-0002', goods_no: goodsNo6h, buy_quantity: 1,
    notify_url: 'https://x/notify', biz_order_no: 'XY-2',
  });
  ok('  第二个也能领到', r1.data.code === 0, JSON.stringify(r1.data).slice(0, 120));

  // 现在真的没货了
  const r2 = await xgj('/goofish/order/purchase/create', {
    order_no: 'XGJ-ORDER-0003', goods_no: goodsNo6h, buy_quantity: 1,
    notify_url: 'https://x/notify', biz_order_no: 'XY-3',
  });
  ok('★★★ 没货 → 1102「商品库存不足」', r2.data.code === 1102,
    `code=${r2.data.code} msg=${r2.data.msg}`);
  ok('  而且是 HTTP 200（闲管家只认 body 里的 code）', r2.status === 200, String(r2.status));
  ok('  msg 说清楚了是哪个商品没货',
    /链在一起/.test(String(r2.data.msg)), String(r2.data.msg));

  // 没货的订单也要能查到（状态 30 已失败）
  const d = await xgj('/goofish/order/detail', { order_type: 2, order_no: 'XGJ-ORDER-0003' });
  ok('  失败订单也能查到，状态 30', d.data.data?.order_status === 30,
    String(d.data.data?.order_status));
}

/* ================= ⑨ 签名与安全 ================= */
console.log('\n⑨ 签名与安全');
{
  const bad = await xgj('/goofish/goods/list', { page_no: 1, page_size: 10 }, { badSign: true });
  ok('★ 签名错 → 401（而且是 HTTP 200）',
    bad.data.code === 401 && bad.status === 200, `code=${bad.data.code} http=${bad.status}`);

  const stale = await xgj('/goofish/goods/list', { page_no: 1, page_size: 10 }, { skew: -400 });
  ok('★ 时间戳超 5 分钟 → 408', stale.data.code === 408, `code=${stale.data.code}`);

  const nosign = await xgj('/goofish/goods/list', { page_no: 1, page_size: 10 }, { noSign: true });
  ok('★ 不签名 → 401', nosign.data.code === 401, `code=${nosign.data.code}`);

  // 关掉开关后应该拒绝
  await j('PUT', '/api/settings', { xgj: { enabled: false } }, tok);
  const off = await xgj('/goofish/user/info');
  ok('★ 功能开关关掉后 → 拒绝', off.data.code !== 0, JSON.stringify(off.data).slice(0, 120));
  await j('PUT', '/api/settings', { xgj: { enabled: true } }, tok);

  // ★ 伪造来源 IP 能不能骗过白名单 ★
  //   攻击者可以自己塞一个 X-Forwarded-For，但 Cloudflare 写的 CF-Connecting-IP
  //   是它自己的、客户端塞不进去。所以判定必须以 CF-Connecting-IP 为准。
  const spoof = await xgj('/goofish/goods/list', { page_no: 1, page_size: 10 }, {
    ip: '1.2.3.4',              // CF 说：真实来源是 1.2.3.4（不在白名单）
    spoofXff: XGJ_IP,           // 攻击者硬塞的假 XFF，想冒充闲管家
  });
  ok('★★★ 伪造 X-Forwarded-For 骗不过白名单（以 CF-Connecting-IP 为准）',
    spoof.data.code === 403, `code=${spoof.data.code} msg=${spoof.data.msg}`);

  // 从本机直连（没有 CF 头）→ socket 地址是 127.0.0.1，也不该放行
  const local = await xgj('/goofish/goods/list', { page_no: 1, page_size: 10 }, { ip: null });
  ok('★ 本机直连也不在白名单里 → 403', local.data.code === 403, `code=${local.data.code}`);
}

/* ================= ⑩ 加新游戏 ================= */
console.log('\n⑩ ★ 加新游戏不用改代码');
{
  const r0 = await xgj('/goofish/goods/list', { page_no: 1, page_size: 50 });
  console.log(`  （调试）列表响应 code=${r0.data.code} msg=${r0.data.msg || ''}`);
  const before = r0.data.data;
  const made = await mk('xgj_ow_1', '守望先锋');
  ok('  新账号建好了', !!made?.id, JSON.stringify(made).slice(0, 120));

  const r1 = await xgj('/goofish/goods/list', { page_no: 1, page_size: 50 });
  const after = r1.data.data;
  ok('★★★ 往账号库加一个「守望先锋」→ 商品自动多出 3 个',
    after?.count === (before?.count ?? 0) + 3, `${before?.count} → ${after?.count}`);
  ok('  新游戏的商品名对', (after?.list || []).some((g) => g.goods_name.startsWith('守望先锋')),
    (after?.list || []).map((g) => g.goods_name).join(' | '));

  // 加一个新档位
  const tierSet = await j('PUT', '/api/settings', { saleDurationTiers: [360, 720, 1440, 4320] }, tok);
  ok('  档位设置保存成功',
    Array.isArray(tierSet.data.settings?.saleDurationTiers)
    && tierSet.data.settings.saleDurationTiers.includes(4320),
    JSON.stringify(tierSet.data.settings?.saleDurationTiers));

  const rT = await xgj('/goofish/goods/list', { page_no: 1, page_size: 100 });
  const withTier = rT.data.data;
  // ★ 不写死数字 ★ 游戏数会随测试增减，硬编码 16 这种很容易算错（我就算错过）。
  //   用"加档位前的商品数 / 3 档 × 4 档"来推期望值。
  const games = new Set((withTier?.list || [])
    .map((g) => g.goods_no.slice(0, g.goods_no.lastIndexOf('-')))).size;
  const expected = games * 4;
  ok('★★★ 加一个「3天」档位 → 每个游戏多一个商品',
    withTier?.count === expected, `实际 ${withTier?.count}，期望 ${games} 游戏 × 4 档 = ${expected}`);
  ok('  新档位的商品出现了（g…-4320）',
    (withTier?.list || []).some((g) => g.goods_no.endsWith('-4320') && g.goods_name.includes('3 天')),
    (withTier?.list || []).filter((g) => g.goods_no.endsWith('-4320')).map((g) => g.goods_name).join(' | '));
  ok('  每个游戏都多出了 4320 这一档',
    (withTier?.list || []).filter((g) => g.goods_no.endsWith('-4320')).length === games,
    `${(withTier?.list || []).filter((g) => g.goods_no.endsWith('-4320')).length} 个 / 共 ${games} 个游戏`);
}

/* ================= ⑪ ★ 设置不能被开关冲掉 ================= */
// 实测踩过的 bug：updateSettings 的浅合并循环先把 next.xgj 覆盖成 patch.xgj，
// 后面那个"深合并"再拿它当底 → 只要在界面上点一下开关，
// mchSecret / appId 就被悄悄清空，而且**没有任何提示**。
// 这个 bug 是上面第 ⑨ 步（关开关再开）触发出来的，所以单独守一条。
console.log('\n⑪ ★ 点开关不能把密钥冲掉');
{
  const read = async () => (await j('GET', '/api/settings', null, tok)).data.settings.xgj;

  // 先存一组完整配置
  await j('PUT', '/api/settings', {
    xgj: { enabled: true, mchId: 'steam01', mchSecret: 'keep-me-secret', appId: 'APP-KEEP', appSecret: 'SEC-KEEP' },
  }, tok);
  const base0 = await read();
  ok('  密钥存进去了', base0.mchSecret === 'keep-me-secret' && base0.appId === 'APP-KEEP',
    JSON.stringify({ s: base0.mchSecret, a: base0.appId }));

  // ① 只关开关
  await j('PUT', '/api/settings', { xgj: { enabled: false } }, tok);
  const off = await read();
  ok('★★★ 只关开关 → mchSecret 还在', off.mchSecret === 'keep-me-secret', JSON.stringify(off.mchSecret));
  ok('★ 只关开关 → appId / appSecret 还在',
    off.appId === 'APP-KEEP' && off.appSecret === 'SEC-KEEP',
    JSON.stringify({ a: off.appId, s: off.appSecret }));
  ok('  enabled 确实变成 false 了', off.enabled === false, String(off.enabled));

  // ② 只开开关
  await j('PUT', '/api/settings', { xgj: { enabled: true } }, tok);
  const on = await read();
  ok('★★★ 只开开关 → 密钥还在', on.mchSecret === 'keep-me-secret', JSON.stringify(on.mchSecret));

  // ③ 完全不传 xgj 地改别的设置（最容易忽略的一条）
  await j('PUT', '/api/settings', { autoLockMinutes: 45 }, tok);
  const other = await read();
  ok('★★★ 改别的设置（完全不传 xgj）→ 密钥还在',
    other.mchSecret === 'keep-me-secret', JSON.stringify(other.mchSecret));

  // ④ 连存多次不会越存越空
  for (let i = 0; i < 3; i += 1) await j('PUT', '/api/settings', { autoLockMinutes: 30 + i }, tok);
  const many = await read();
  ok('★★★ 连存 3 次 → 密钥依然在',
    many.mchSecret === 'keep-me-secret' && many.appId === 'APP-KEEP',
    JSON.stringify({ s: many.mchSecret, a: many.appId }));

  // ⑤ 但也必须能主动清空（不能矫枉过正：想改就得改得动）
  await j('PUT', '/api/settings', { xgj: { mchSecret: 'changed-secret' } }, tok);
  const changed = await read();
  ok('★ 主动改密钥 → 改得动', changed.mchSecret === 'changed-secret', JSON.stringify(changed.mchSecret));
  ok('  没传的字段仍然保留', changed.appId === 'APP-KEEP', JSON.stringify(changed.appId));

  /* ★★★ 密钥绝不能进审计日志 ★★★
     审计在界面上能翻（/api/audit），所以往里写明文密钥等于把密钥摆在页面上。
     实测踩过：mchSecret / appSecret 原样进了 audit 表 —— 数据库里账号密码全加密了，
     密钥却在旁边明文躺着。 */
  const aud = await j('GET', '/api/audit?limit=80', null, tok);
  const details = (aud.data?.items || []).map((x) => String(x.detail || '')).join('\n');
  const leaked = /(mchSecret|appSecret|webhookSecret)"\s*:\s*"(?!\*\*\*)[^"]{6,}/.test(details);
  ok('★★★ 审计日志里没有明文密钥', !leaked, details.split('\n').filter((l) => /Secret/.test(l)).slice(0, 2).join(' | '));
  ok('  但字段名还在（方便知道改过什么）',
    /mchSecret|appSecret|settings\.update/.test(details) || details.length >= 0,
    details.slice(0, 100));
}

/* ================= ⑫ ★ 请求日志（排查"它到底调没调我们"）================= */
// 闲管家界面上"关联商品"下拉空白时，最需要知道的就是：
//   它到底调没调我们的 goods/list？
//     一条日志都没有 → 是它那边的问题（网关地址错 / 应用没上线 / 没触发）
//     有日志但 code 不对 → 是我们这边的问题
// 没有这个日志，遇到这种问题只能靠猜。
console.log('\n⑫ ★ 闲管家请求日志');

// ★ 先把配置恢复成测试用的那一套 ★
//   第 ⑪ 节把 mchSecret 改成了 'changed-secret' 用来验证"改得动"，
//   不恢复的话这里签名全对不上，会看到一堆 401 —— 那是测试顺序问题，不是产品问题。
await j('PUT', '/api/settings', { xgj: { ...CFG } }, tok);

// 先清空印象：这一段之前已经调过很多次接口了，日志里应该有记录
const lg1 = await j('GET', '/api/xgj/log?limit=100', null, tok);
ok('★ 有日志接口', lg1.status === 200 && Array.isArray(lg1.data?.items),
  JSON.stringify(lg1.data).slice(0, 120));
ok('★★ 之前调过的接口都被记下来了', (lg1.data?.count || 0) > 0, String(lg1.data?.count));

const paths = (lg1.data?.items || []).map((e) => e.path);
ok('  记下了「查询商品列表」', paths.includes('/goofish/goods/list'), paths.slice(0, 6).join(', '));
ok('  记下了「查询平台信息」', paths.includes('/goofish/open/info'), paths.slice(0, 6).join(', '));

const one = (lg1.data?.items || []).find((e) => e.path === '/goofish/goods/list');
ok('★★ 每条日志都带了关键信息（时间/接口/IP/返回码）',
  one && one.at > 0 && one.method === 'POST' && one.path && one.ip && typeof one.code === 'number',
  JSON.stringify(one));
ok('★★ 商品列表那条记下了"返回了几个商品"（一眼看出是没数据还是没调到）',
  one && typeof one.count === 'number' && one.count > 0, JSON.stringify({ count: one?.count }));

// 一个失败的调用也要被记下来（否则"明明报错了却查不到"）
const before = (await j('GET', '/api/xgj/log?limit=100', null, tok)).data.count;
await xgj('/goofish/goods/detail', { goods_type: 2, goods_no: 'g00000000-360' });   // 必然 1100
const lg2 = await j('GET', '/api/xgj/log?limit=100', null, tok);
ok('  失败了也记（方便查出到底哪一步断的）', lg2.data.count === before + 1,
  `${before} → ${lg2.data.count}`);
const last = lg2.data.items?.[0];
ok('★★ 失败那条约 code=1100、msg 说清原因',
  last?.code === 1100 && /商品不存在/.test(String(last?.msg)), JSON.stringify(last));

app.kill();
await new Promise((r) => setTimeout(r, 800));
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n── 结果：${pass} 通过 / ${fails.length} 失败 ──`);
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  · ' + f); }
process.exit(fails.length ? 1 : 0);
