/**
 * 闲管家对接的自检。
 *
 * ★ 最重要的一条：用官方文档给的测试向量验证签名算法 ★
 *   官方示例（文档「接入说明」里公布的，不是我们自己编的）：
 *     app_id     = 677859093659717
 *     app_secret = wK63PxlOBaY9NoqMksLeZySzGIW25ifA
 *     mch_id     = 100
 *     mch_secret = o9wl81dncmvby3ijpq7eur456zhgtaxs
 *     timestamp  = 1724414553
 *     body       = {"goods_type":1,"goods_no":"12344532"}
 *   官方说：
 *     bodyMd5 = 9b8030f5097d5ed123405b003dd247c5
 *     sign    = f8677927fd8421a75718e8cfaaf92221
 *
 *   我们算出来必须一模一样。差一个字符，闲管家就会一直回 401 签名错误。
 *
 * 用法：node test-xgj-sign.mjs
 */
import {
  computeSign, md5, verifyIncoming, isXgjIp,
  goodsNoFor, parseGoodsNo, gameCode, humanDuration, CODE,
} from '../server/xianguanjia.mjs';

let pass = 0; const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name} — ${extra}`); console.log(`  ✗ ${name} — ${extra}`); }
};

/* ---------------- ① 官方测试向量 ---------------- */
console.log('① 官方测试向量（对不上就说明算法错了）');

const OFFICIAL = {
  appId: '677859093659717',
  appSecret: 'wK63PxlOBaY9NoqMksLeZySzGIW25ifA',
  mchId: '100',
  mchSecret: 'o9wl81dncmvby3ijpq7eur456zhgtaxs',
  timestamp: 1724414553,
  body: '{"goods_type":1,"goods_no":"12344532"}',
};

const bodyMd5 = md5(OFFICIAL.body);
ok('  ① bodyMd5 和官方一致（9b8030f5…）',
  bodyMd5 === '9b8030f5097d5ed123405b003dd247c5', `实际 ${bodyMd5}`);

const sign = computeSign({
  appId: OFFICIAL.appId, appSecret: OFFICIAL.appSecret,
  bodyString: OFFICIAL.body, timestamp: OFFICIAL.timestamp,
  mchId: OFFICIAL.mchId, mchSecret: OFFICIAL.mchSecret,
});
ok('★★★ sign 和官方一致（f8677927…）',
  sign === 'f8677927fd8421a75718e8cfaaf92221', `实际 ${sign}`);

/* ---------------- ② 签名的敏感度 ---------------- */
console.log('\n② 签名会不会太"宽松"（改一点点就应该全变）');

const base = { ...OFFICIAL };
const variants = [
  ['body 多一个空格', { body: '{"goods_type":1, "goods_no":"12344532"}' }],
  ['字段顺序换了', { body: '{"goods_no":"12344532","goods_type":1}' }],
  ['timestamp 差 1 秒', { timestamp: 1724414554 }],
  ['mch_secret 错一个字符', { mchSecret: 'o9wl81dncmvby3ijpq7eur456zhgtaxr' }],
  ['app_id 少一位', { appId: '67785909365971' }],
];
for (const [label, patch] of variants) {
  const s = computeSign({
    appId: patch.appId ?? base.appId,
    appSecret: patch.appSecret ?? base.appSecret,
    bodyString: patch.body ?? base.body,
    timestamp: patch.timestamp ?? base.timestamp,
    mchId: patch.mchId ?? base.mchId,
    mchSecret: patch.mchSecret ?? base.mchSecret,
  });
  ok(`  ${label} → 签名不同`, s !== sign, '居然算出同一个签名，说明拼接有问题');
}

/* ---------------- ③ 请求校验 ---------------- */
console.log('\n③ 校验闲管家发来的请求');

const cfg = {
  appId: OFFICIAL.appId, appSecret: OFFICIAL.appSecret,
  mchId: OFFICIAL.mchId, mchSecret: OFFICIAL.mchSecret,
  ipWhitelist: false,
};
const tsNow = Math.floor(Date.now() / 1000);
const bodyStr = '{"goods_type":2,"goods_no":"g7f3a91-360"}';
const goodSign = computeSign({
  appId: cfg.appId, appSecret: cfg.appSecret, bodyString: bodyStr,
  timestamp: tsNow, mchId: cfg.mchId, mchSecret: cfg.mchSecret,
});

const v1 = verifyIncoming({
  query: { mch_id: cfg.mchId, timestamp: tsNow, sign: goodSign },
  bodyString: bodyStr, cfg,
});
ok('  正常请求 → 通过', v1.ok === true, JSON.stringify(v1));

const v2 = verifyIncoming({
  query: { mch_id: cfg.mchId, timestamp: tsNow, sign: 'deadbeef' },
  bodyString: bodyStr, cfg,
});
ok('  签名错了 → 401 签名错误', v2.ok === false && v2.code === CODE.SIGN_ERROR, JSON.stringify(v2));

const v3 = verifyIncoming({
  query: { mch_id: cfg.mchId, timestamp: tsNow - 400, sign: goodSign },
  bodyString: bodyStr, cfg,
});
ok('  时间戳超 5 分钟 → 408', v3.ok === false && v3.code === CODE.TIMESTAMP_EXPIRED, JSON.stringify(v3));

const v4 = verifyIncoming({
  query: { mch_id: 'someone-else', timestamp: tsNow, sign: goodSign },
  bodyString: bodyStr, cfg,
});
ok('  mch_id 不对 → 1000 商户不存在', v4.ok === false && v4.code === CODE.MCH_NOT_FOUND, JSON.stringify(v4));

const v5 = verifyIncoming({
  query: { timestamp: tsNow, sign: goodSign }, bodyString: bodyStr, cfg,
});
ok('  少了 mch_id → 401', v5.ok === false && v5.code === CODE.SIGN_ERROR, JSON.stringify(v5));

const v6 = verifyIncoming({
  query: { mch_id: cfg.mchId, timestamp: tsNow, sign: goodSign },
  bodyString: bodyStr, cfg: { ...cfg, ipWhitelist: true }, remoteIp: '1.2.3.4',
});
ok('  IP 不在白名单 → 403', v6.ok === false && v6.code === CODE.IP_FORBIDDEN, JSON.stringify(v6));

const v7 = verifyIncoming({
  query: { mch_id: cfg.mchId, timestamp: tsNow, sign: goodSign },
  bodyString: bodyStr, cfg: { ...cfg, ipWhitelist: true }, remoteIp: '120.24.1.1',
});
ok('  闲管家的 IP → 放行', v7.ok === true, JSON.stringify(v7));

/* ---------------- ④ IP 判断 ---------------- */
console.log('\n④ IP 白名单');
ok('  120.24.5.5 在段内', isXgjIp('120.24.5.5') === true);
ok('  39.108.200.1 在段内', isXgjIp('39.108.200.1') === true);
ok('  47.106.0.1 在段内', isXgjIp('47.106.0.1') === true);
ok('  8.8.8.8 不在段内', isXgjIp('8.8.8.8') === false);
ok('  ::ffff:120.24.5.5 这种 IPv6 写法也认', isXgjIp('::ffff:120.24.5.5') === true);
ok('  乱写的不认', isXgjIp('not-an-ip') === false);

/* ---------------- ⑤ 商品编码 ---------------- */
console.log('\n⑤ 商品编码');

const g1 = goodsNoFor('链在一起', 360);
ok('  编码是纯 ASCII（g + 8 位哈希 + 分钟）',
  /^g[0-9a-f]{8}-360$/.test(g1), g1);
ok('  同一个游戏名 → 同一个编码（稳定）',
  goodsNoFor('链在一起', 720) === goodsNoFor('链在一起', 720));
ok('  不同时长 → 不同编码',
  goodsNoFor('链在一起', 360) !== goodsNoFor('链在一起', 720));
ok('  不同游戏 → 不同编码',
  gameCode('链在一起') !== gameCode('CS2'));
ok('  大小写/空格不影响编码（避免手滑）',
  gameCode('CS2') === gameCode(' cs2 '));

const parsed = parseGoodsNo(g1);
ok('  能反解出分钟数', parsed && parsed.minutes === 360, JSON.stringify(parsed));

// ★ 关键：商品编码本身不含游戏名，得靠"当前游戏列表"反查
//   所以反解出 code 后，要和 gameCode(每个游戏) 比一遍才能知道是哪个游戏
ok('  反解出的 code 能和游戏对上',
  parsed.code === gameCode('链在一起'), `${parsed.code} vs ${gameCode('链在一起')}`);
ok('  乱写的编码反解为 null', parseGoodsNo('hello') === null);
ok('  少了分钟数也反解为 null', parseGoodsNo('g7f3a91-') === null);

/* ---------------- ⑥ 时长显示 ---------------- */
console.log('\n⑥ 时长文案');
ok('  360 → 6 小时', humanDuration(360) === '6 小时', humanDuration(360));
ok('  720 → 12 小时', humanDuration(720) === '12 小时', humanDuration(720));
ok('  1440 → 1 天', humanDuration(1440) === '1 天', humanDuration(1440));
ok('  90 → 1 小时 30 分钟', humanDuration(90) === '1 小时 30 分钟', humanDuration(90));
ok('  30 → 30 分钟', humanDuration(30) === '30 分钟', humanDuration(30));

console.log(`\n── 结果：${pass} 通过 / ${fails.length} 失败 ──`);
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  · ' + f); }
process.exit(fails.length ? 1 : 0);
