/**
 * ★ 闲管家（虚拟货源标准接口）对接 ★
 *
 * 闲管家是「请求方」，我们是「货源方」。买家在闲鱼下单后，闲管家来调我们的接口，
 * 我们把一个空闲账号的账号/密码当作「卡密」还回去，它自动发货给买家。
 *
 * 官方文档：https://s.apifox.cn/cf4d53fd-8bb2-41c5-8da3-371ba9a38956
 *
 * ── 我们要实现的接口 ─────────────────────────────────────────────
 *   查询平台信息   POST /goofish/open/info              无参数
 *   查询商户信息   POST /goofish/user/info
 *   查询商品列表   POST /goofish/goods/list
 *   查询商品详情   POST /goofish/goods/detail
 *   创建卡密订单   POST /goofish/order/purchase/create   ★核心
 *   查询订单详情   POST /goofish/order/detail
 *
 * ── 我们主动调闲管家（方向相反）─────────────────────────────────
 *   订单回调通知   POST {notify_url}
 *
 * ── 签名规则（一个空格错了就失败）───────────────────────────────
 *   bodyMd5 = md5(请求体原文，必须是压缩后的 JSON，原样参与，不排序)
 *   sign    = md5("app_id,app_secret,bodyMd5,timestamp,mch_id,mch_secret")
 *
 *   app_id/app_secret  —— 闲管家给的（它的「应用概况」）
 *   mch_id/mch_secret  —— 我们自己定的，填在它的「货源授权信息」里
 *
 * ── 商品怎么来（不写死）────────────────────────────────────────
 *   商品 = 游戏 × 售卖档位，两边都是实时算的：
 *     游戏   ← 账号库里出现过的游戏名（加账号 = 上架新游戏）
 *     档位   ← 设置里的 saleDurationTiers（加数字 = 多一档商品）
 *   库存 = 该游戏当前「可用」的账号数
 *
 *   商品编码 goods_no 用哈希而不是中文：闲管家对「商品编码」可能有格式限制，
 *   纯 ASCII 最稳。人看不懂没关系 —— 闲管家界面显示的是商品名称。
 */
import crypto from 'node:crypto';

/* ------------------------------------------------------------------ */
/* 错误码（闲管家官方定义）                                           */
/* ------------------------------------------------------------------ */
export const CODE = {
  OK: 0,
  BAD_REQUEST: 1,
  SIGN_ERROR: 401,
  IP_FORBIDDEN: 403,
  TIMESTAMP_EXPIRED: 408,
  SERVER_ERROR: 500,
  MCH_NOT_FOUND: 1000,
  MCH_UNAVAILABLE: 1001,
  MCH_NO_BALANCE: 1002,
  GOODS_NOT_FOUND: 1100,
  GOODS_UNAVAILABLE: 1101,
  GOODS_NO_STOCK: 1102,        // ★ 没空闲账号时用它
  ORDER_NOT_FOUND: 1200,
  ORDER_PARAM_ERROR: 1201,
  ORDER_BELOW_COST: 1202,
  ORDER_DUPLICATE: 1203,       // ★ 幂等：同一个订单号重复请求
  ORDER_TIMEOUT: 1209,
};

/** 订单状态 */
export const ORDER_STATUS = { PROCESSING: 10, SUCCESS: 20, FAILED: 30 };

/** 商品类型：我们只做卡密 */
export const GOODS_TYPE = { DIRECT: 1, CARD: 2, TICKET: 3 };

/** 闲管家服务器 IP 段（官方 20251029 更新）—— 用于白名单 */
export const XGJ_IP_RANGES = [
  '112.74.0.0-112.74.255.255',
  '120.24.0.0-120.24.255.255',
  '120.77.0.0-120.77.255.255',
  '120.78.0.0-120.78.255.255',
  '120.79.0.0-120.79.255.255',
  '39.108.0.0-39.108.255.255',
  '47.106.0.0-47.106.255.255',
];

/* ------------------------------------------------------------------ */
/* 签名                                                               */
/* ------------------------------------------------------------------ */

export function md5(s) {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
}

/** 压缩到和闲管家一致的样子：它传什么，我们就原样签什么 */
export function compactJson(obj) {
  return JSON.stringify(obj);
}

/**
 * 算签名。
 * @param {object} p
 * @param {string} p.appId
 * @param {string} p.appSecret
 * @param {string} p.bodyString   —— 请求体**原文**（压缩 JSON）；无 body 传 ''
 * @param {string|number} p.timestamp
 * @param {string} p.mchId
 * @param {string} p.mchSecret
 */
export function computeSign({ appId, appSecret, bodyString, timestamp, mchId, mchSecret }) {
  // 无 body 时闲管家文档说 md5("{}") 或 md5("") 都行，只要两边的 body 一致。
  // 我们按"实际传了什么就签什么"来算，空就是空。
  const bodyMd5 = md5(String(bodyString ?? ''));
  return md5([
    String(appId ?? ''), String(appSecret ?? ''), bodyMd5,
    String(timestamp ?? ''), String(mchId ?? ''), String(mchSecret ?? ''),
  ].join(','));
}

/** 定长比较，避免时序侧信道 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * 校验闲管家发来的请求。
 * @returns {{ok:true}|{ok:false, code:number, msg:string}}
 */
export function verifyIncoming({ headers, query, bodyString, cfg, remoteIp }) {
  // ① IP 白名单（第一道门，最省事）
  //    公网地址是可以被扫到的，先按 IP 拦掉绝大多数噪音。
  if (cfg.ipWhitelist && remoteIp && !isXgjIp(remoteIp)) {
    return { ok: false, code: CODE.IP_FORBIDDEN, msg: `访问IP不在白名单内：${remoteIp}` };
  }

  const { mch_id: mchId, timestamp, sign } = query || {};
  if (!mchId || !timestamp || !sign) {
    return { ok: false, code: CODE.SIGN_ERROR, msg: '缺少 mch_id / timestamp / sign' };
  }
  if (String(mchId) !== String(cfg.mchId)) {
    return { ok: false, code: CODE.MCH_NOT_FOUND, msg: `商户不存在：${mchId}` };
  }
  if (!cfg.mchSecret) {
    return { ok: false, code: CODE.MCH_UNAVAILABLE, msg: '本机还没配置 mch_secret' };
  }

  // ② 时间戳 5 分钟内有效
  const ts = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) {
    return { ok: false, code: CODE.TIMESTAMP_EXPIRED, msg: `时间戳已超过有效期（差 ${now - ts} 秒）` };
  }

  // ③ 签名
  const expect = computeSign({
    appId: cfg.appId, appSecret: cfg.appSecret,
    bodyString, timestamp: ts, mchId, mchSecret: cfg.mchSecret,
  });
  if (!safeEqual(expect, String(sign).toLowerCase())) {
    return {
      ok: false,
      code: CODE.SIGN_ERROR,
      msg: '签名错误',
      // 把该给的都摆出来，方便对着官方示例核对；只有签名不合才走到这
      detail: { expect, got: String(sign).toLowerCase(), bodyMd5: md5(String(bodyString ?? '')) },
    };
  }

  return { ok: true };
}

/** IP 是否落在闲管家的段里 */
export function isXgjIp(ip) {
  const v4 = ipToInt(String(ip).replace(/^::ffff:/, ''));
  if (v4 === null) return false;
  for (const r of XGJ_IP_RANGES) {
    const [a, b] = r.split('-');
    const lo = ipToInt(a); const hi = ipToInt(b);
    if (lo !== null && hi !== null && v4 >= lo && v4 <= hi) return true;
  }
  return false;
}

function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const x = Number(p);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = n * 256 + x;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* 商品编码                                                           */
/* ------------------------------------------------------------------ */

/** 游戏名 → 稳定的短哈希（纯 ASCII，改名就换编码，所以定下来别乱改） */
export function gameCode(game) {
  return `g${md5(String(game).trim().toLowerCase()).slice(0, 8)}`;
}

/** 商品编码 = 游戏哈希-分钟数，例如 g7f3a91-360 */
export function goodsNoFor(game, minutes) {
  return `${gameCode(game)}-${normalizeMinutes(minutes)}`;
}

/** 反解商品编码 → { game 不知道，minutes 知道 } */
export function parseGoodsNo(goodsNo) {
  const m = String(goodsNo || '').trim().match(/^(g[0-9a-f]{8})-(\d+)$/i);
  if (!m) return null;
  return { code: m[1].toLowerCase(), minutes: Number(m[2]) };
}

function normalizeMinutes(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(43200, n) : 60;
}

/** 分钟数 → 中文时长（商品名和商品描述都用它） */
export function humanDuration(minutes) {
  const n = Math.round(Number(minutes) || 0);
  if (n <= 0) return '0 分钟';
  if (n < 60) return `${n} 分钟`;
  if (n % 1440 === 0) return `${n / 1440} 天`;
  if (n % 60 === 0) return `${n / 60} 小时`;
  const h = Math.floor(n / 60); const m = n % 60;
  return h ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
}

/* ------------------------------------------------------------------ */
/* 商品：游戏 × 售卖档位，两边都是实时算的                              */
/* ------------------------------------------------------------------ */

/**
 * 把「游戏 × 档位」展开成商品列表。
 *
 * ★ 这里就是"以后加游戏怎么办"的答案 ★
 *   游戏来自账号库（gameStock() 的键），档位来自设置。
 *   两边任何一个变了，下次查询自动多出/少掉商品，**不用改代码、不用重启**。
 *
 * 库存只算「可用」的账号 —— 卖出去的正在用、待改密的都不算货。
 * 库存为 0 的商品照样返回（status 标下架），这样闲管家能显示"无货"而不是商品凭空消失。
 *
 * @param {object} store
 * @param {object} [opts]
 * @param {string} [opts.keyword]   闲管家传的搜索词：支持商品名模糊 + 编码精确
 * @param {number} [opts.minutes]   只要某个档位（可选）
 */
export function buildGoodsList(store, { keyword = '', minutes = null } = {}) {
  const settings = store.getSettings();
  const tiers = Array.isArray(settings.saleDurationTiers) && settings.saleDurationTiers.length
    ? settings.saleDurationTiers
    : DEFAULT_TIERS;
  const stock = store.gameStock();
  const price = Math.max(0, Math.round(Number(settings.xgj?.priceFen) || 0));
  const now = Math.floor(Date.now() / 1000);

  const all = [];
  for (const game of Object.keys(stock).sort((a, b) => a.localeCompare(b, 'zh'))) {
    for (const tier of tiers) {
      if (minutes && Number(minutes) !== Number(tier)) continue;
      const available = Number(stock[game]?.available || 0);
      all.push({
        goods_no: goodsNoFor(game, tier),
        goods_type: GOODS_TYPE.CARD,
        goods_name: `${game} ${humanDuration(tier)}`,
        price,
        stock: available,
        // 1 在架 / 2 下架：没货就标下架，闲管家那边自然会显示无货
        status: available > 0 ? 1 : 2,
        update_time: now,
        // 我们内部用，不发给闲管家（保留在对象里方便查订单时反查）
        __game: game,
        __minutes: Number(tier),
      });
    }
  }

  const kw = String(keyword || '').trim();
  let list = all;
  if (kw) {
    const lower = kw.toLowerCase();
    list = all.filter((g) =>
      // 编码精确匹配（官方要求：编码精准搜索）
      g.goods_no.toLowerCase() === lower
      // 或商品名模糊匹配
      || g.goods_name.toLowerCase().includes(lower));
  }
  return { list, count: list.length };
}

const DEFAULT_TIERS = [360, 720, 1440];

/**
 * 从商品编码反查是哪个游戏 —— 编码里只有哈希，得拿当前游戏列表比一遍。
 * @returns {{game:string, minutes:number}|null}
 */
export function resolveGoodsNo(store, goodsNo) {
  const parsed = parseGoodsNo(goodsNo);
  if (!parsed) return null;
  const stock = store.gameStock();
  for (const game of Object.keys(stock)) {
    if (gameCode(game) === parsed.code) {
      return { game, minutes: parsed.minutes };
    }
  }
  return null;
}

/** 去掉内部字段，只把闲管家认识的发给它（它强校验字段类型，多传可能报错） */
export function toWireGoods(g) {
  return {
    goods_no: g.goods_no,
    goods_type: g.goods_type,
    goods_name: g.goods_name,
    price: g.price,
    stock: g.stock,
    status: g.status,
    update_time: g.update_time,
  };
}

/* ------------------------------------------------------------------ */
/* 下单：幂等 + 领号                                                  */
/* ------------------------------------------------------------------ */

/**
 * 处理一张卡密订单。
 *
 * ★ 幂等是这里最重要的事 ★
 *   闲管家超时（错误码 1209）会重试同一个订单号。
 *   如果不做去重，一张订单会领走两个账号 —— 一个白白占着，还多改一次密码。
 *   所以：**先查 order_no，已经有记录就直接把当时的结果原样返回。**
 *
 * @param {object} store
 * @param {object} order  { order_no, goods_no, buy_quantity, notify_url, biz_order_no, max_amount }
 * @returns {object} 闲管家格式的 data（不含外层 code/msg）
 */
export function handleCardOrder(store, order) {
  const orderNo = String(order.order_no || '').trim();
  const goodsNo = String(order.goods_no || '').trim();
  const qty = Math.max(1, Number(order.buy_quantity) || 1);

  if (!orderNo) return { __error: CODE.ORDER_PARAM_ERROR, __msg: 'order_no 不能为空' };
  if (!goodsNo) return { __error: CODE.ORDER_PARAM_ERROR, __msg: 'goods_no 不能为空' };

  /* ① 幂等：这张单来过了就原样奉还 -------------------------------- */
  const existed = store.findXgjOrder(orderNo);
  if (existed) {
    return {
      out_order_no: existed.out_order_no,
      order_no: existed.order_no,
      order_status: existed.order_status,
      order_amount: existed.order_amount,
      order_time: existed.created_at,
      end_time: existed.end_time ?? existed.created_at,
      card_items: existed.card_pwd
        ? [{ card_no: existed.card_no, card_pwd: existed.card_pwd, card_type: 2 }]
        : [],
      remark: existed.remark || '（这是重复请求，返回的是首次下单的结果）',
      __replay: true,
    };
  }

  /* ② 认得这个商品吗 --------------------------------------------- */
  const resolved = resolveGoodsNo(store, goodsNo);
  if (!resolved) {
    return { __error: CODE.GOODS_NOT_FOUND, __msg: `商品不存在：${goodsNo}` };
  }

  /* ③ 一次一单：我们一张订单只发一个账号 ------------------------- */
  //   买家一次买 3 个（buy_quantity=3）的话，这里只发 1 个会少发。
  //   与其悄悄少发，不如明确拒绝，让对方改成一单一号。
  if (qty !== 1) {
    const r = {
      out_order_no: '',
      order_no: orderNo,
      order_status: ORDER_STATUS.FAILED,
      order_amount: 0,
      order_time: Math.floor(Date.now() / 1000),
      end_time: Math.floor(Date.now() / 1000),
      card_items: [],
      remark: `本店一次只能买 1 个（收到 buy_quantity=${qty}）。请分开下单。`,
    };
    store.insertXgjOrder({
      orderNo, outOrderNo: `XGJ${Date.now()}`, bizOrderNo: order.biz_order_no,
      goodsNo, goodsName: '', buyQuantity: qty, orderStatus: ORDER_STATUS.FAILED,
      orderAmount: 0, remark: r.remark, notifyUrl: order.notify_url,
    });
    return r;
  }

  /* ④ 真的去领一个号 --------------------------------------------- */
  //   复用 /api/automation/claim 那套逻辑：先精确匹配游戏名，把使用时间改成订单要的档位，
  //   然后账号进入「使用中」开始倒计时 —— 到点自动改密再回「可用」。
  const claim = store.claimAvailable({
    game: resolved.game,
    minutes: resolved.minutes,
    actor: '闲管家',
  });

  const now = Math.floor(Date.now() / 1000);

  if (!claim.ok) {
    // ★ 没货：返回 1102「商品库存不足」—— 闲管家会据此把订单标失败并退款/提示
    const r = {
      out_order_no: '',
      order_no: orderNo,
      order_status: ORDER_STATUS.FAILED,
      order_amount: 0,
      order_time: now,
      end_time: now,
      card_items: [],
      remark: `「${resolved.game} ${humanDuration(resolved.minutes)}」暂时没有空闲账号`,
    };
    store.insertXgjOrder({
      orderNo, outOrderNo: `XGJ${now}${Math.floor(Math.random() * 1000)}`,
      bizOrderNo: order.biz_order_no, goodsNo,
      goodsName: `${resolved.game} ${humanDuration(resolved.minutes)}`,
      buyQuantity: 1, orderStatus: ORDER_STATUS.FAILED, orderAmount: 0,
      remark: r.remark, notifyUrl: order.notify_url, endTime: now,
    });
    return { ...r, __error: CODE.GOODS_NO_STOCK, __msg: r.remark };
  }

  /* ⑤ 成功：把账号/密码当卡密还回去 ------------------------------- */
  const outOrderNo = `XGJ${now}${String(claim.accountId).padStart(4, '0')}`;
  const goodsName = `${resolved.game} ${humanDuration(resolved.minutes)}`;
  const card = { card_no: claim.username, card_pwd: claim.password, card_type: 2 };

  // 订单金额（分）：闲管家传了 max_amount 就用它，否则用设置里的成本价。
  // 这个数只是记账用，不影响发货。
  const cfgPrice = Math.max(0, Math.round(Number(store.getSettings().xgj?.priceFen) || 0));
  const amount = Math.max(0, Math.round(Number(order.max_amount) || 0)) || cfgPrice;

  store.insertXgjOrder({
    orderNo, outOrderNo, bizOrderNo: order.biz_order_no,
    goodsNo, goodsName, buyQuantity: 1,
    orderStatus: ORDER_STATUS.SUCCESS,
    orderAmount: amount,
    accountId: claim.accountId,
    cardNo: card.card_no, cardPwd: card.card_pwd,
    remark: `今日第 ${claim.todayIndex} 个 · 可用 ${claim.usageMinutes} 分钟`,
    notifyUrl: order.notify_url, endTime: now,
  });

  return {
    out_order_no: outOrderNo,
    order_no: orderNo,
    order_status: ORDER_STATUS.SUCCESS,
    order_amount: amount,
    order_time: now,
    end_time: now,
    card_items: [card],
    remark: `已发货：今日第 ${claim.todayIndex} 个，可用 ${humanDuration(claim.usageMinutes)}`,
  };
}

