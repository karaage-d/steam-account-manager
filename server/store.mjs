/**
 * 数据层：SQLite（node:sqlite 内置）+ 领域逻辑
 *
 * ★ 核心是一个三态状态机，只有一个计时器 ★
 *
 *     添加账号 ──▶  available（可用）
 *                      │ 点「开始使用」
 *                      ▼
 *                  in_use（使用中）  倒计时 = 该账号的 usage_minutes
 *                      │ 倒计时归零
 *                      ▼
 *              pending_change（待改密）  ← 同时自动创建 AI 改密任务
 *                      │ AI 回传新密码 / 手动改密
 *                      └──────────────▶ 回到 available（可用）
 *
 * 表结构
 *   meta      键值元数据（KDF 盐、校验器、设置、API Key）
 *   accounts  账号（密码 AES-256-GCM 加密，state 记录所处界面）
 *   sessions  使用会话（用于「今日第 N 个」与使用记录）
 *   tasks     改密任务（供 AI 自动化接口消费）
 *   audit     审计日志
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  newSalt, deriveKey, encrypt, decrypt, makeVerifier, checkVerifier,
  randomToken,
} from './crypto.mjs';

/* ------------------------------------------------------------------ */
/* 三态常量                                                            */
/* ------------------------------------------------------------------ */

export const STATE = {
  AVAILABLE: 'available',        // 可用
  IN_USE: 'in_use',              // 使用中
  PENDING: 'pending_change',     // 待改密
};

export const STATE_LABEL = {
  [STATE.AVAILABLE]: '可用',
  [STATE.IN_USE]: '使用中',
  [STATE.PENDING]: '待改密',
};

const ALL_STATES = Object.values(STATE);

/* ------------------------------------------------------------------ */
/* 设置（已移除所有"统一使用时长 / 自动改密阈值"相关项）                 */
/* ------------------------------------------------------------------ */

/**
 * 把要被写进审计的设置改动"洗干净"：只留字段名，值一律打码。
 *
 * ★ 为什么必须做 ★
 *   审计日志是**给人看的**（界面「设置」里能翻，/api/audit 也能拿到），
 *   所以绝不能往里写明文密钥。写进去就等于：
 *     数据库里账号密码全加密了，密钥却在旁边明文躺着。
 *   实测踩过：mchSecret / appSecret 原样进了 audit 表。
 */
export function redactSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object') return '{}';
  /** 这些字段只记名字，值永远不落盘 */
  const SECRET_KEYS = [
    'mchSecret', 'appSecret', 'webhookSecret',
    'mchsecret', 'appsecret', 'webhooksecret',
    'secret', 'password', 'token', 'apiKey',
  ];
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'xgj' && v && typeof v === 'object') {
      const inner = {};
      for (const [ik, iv] of Object.entries(v)) {
        inner[ik] = SECRET_KEYS.some((s) => s.toLowerCase() === ik.toLowerCase())
          ? (iv ? '***（已设置，不记录）' : '***（已清空）')
          : iv;
      }
      out[k] = inner;
      continue;
    }
    out[k] = SECRET_KEYS.some((s) => s.toLowerCase() === k.toLowerCase())
      ? (v ? '***（已设置，不记录）' : '***（已清空）')
      : v;
  }
  return JSON.stringify(out);
}

export const DEFAULT_SETTINGS = {
  /** 闲置多久自动锁库（分钟），0=不自动锁 */
  autoLockMinutes: 30,
  /** 改密任务创建后回调的外部地址（给 AI 自动化用） */
  webhookUrl: '',
  /** Webhook HMAC 签名密钥 */
  webhookSecret: '',
  /** 取用后自动把「账号/密码」复制到剪贴板 */
  autoCopyOnUse: true,
  /** 界面主题 */
  theme: 'dark',

  /**
   * ★ 售卖时长档位（分钟）★ —— 闲管家商品就是「游戏 × 这些档位」
   *
   * 加一档只需在这里加个数字，商品列表会自动多出对应的商品，
   * 代码里一个档位都不写死。游戏同理：账号库里出现哪个游戏名，
   * 商品里就自动出现哪个游戏 —— 加新游戏不用改代码、不用重启。
   */
  saleDurationTiers: [360, 720, 1440],   // 6 小时 / 12 小时 / 24 小时

  /**
   * ★ 闲管家（虚拟货源）对接配置 ★
   *
   *   mchId / mchSecret  —— 我们自己定，填到闲管家的「货源授权信息」里
   *   appId / appSecret  —— 闲管家给的，来自它的「应用概况」
   *
   *   sign = md5("app_id,app_secret,md5(body原文),timestamp,mch_id,mch_secret")
   */
  xgj: {
    /** 关掉时所有闲管家接口直接 404，等于没这个功能 */
    enabled: false,
    mchId: 'steam01',
    mchSecret: '',
    appId: '',
    appSecret: '',
    /** 只放行闲管家的 IP（出错码 403 那套）。留空 = 不限制 */
    ipWhitelist: true,
    /** 商品成本下限（分）—— 闲管家会用它校验「下单金额低于成本价」 */
    priceFen: 100,
  },
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 本地时区某一天的 [起, 止) 秒级时间戳。
 * audit 表只存了 at（秒），要按「本地自然日」统计就得自己算出这一天的边界。
 */
export function dayRangeSec(dk = dayKey()) {
  const [y, m, d] = String(dk).split('-').map(Number);
  const start = Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000);
  return [start, start + 86400];
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** 默认使用时长（分钟）；添加账号时未填则用它 */
export const DEFAULT_USAGE_MINUTES = 360;

export function normalizeUsageMinutes(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_USAGE_MINUTES;
  // 1 分钟 ~ 30 天
  return Math.min(43200, Math.max(1, n));
}

/**
 * 洗干净「售卖时长档位」：正整数、去重、从小到大、上限 20 个。
 *
 * 为什么要洗：这个数组决定闲管家那边出现多少个商品。
 * 传进一个 0 或者字符串会算出「0 分钟」这种荒唐商品，
 * 传进 200 个档位会把商品列表撑爆。
 */
export function normalizeTiers(v) {
  const arr = Array.isArray(v) ? v : DEFAULT_SETTINGS.saleDurationTiers;
  const out = [];
  for (const x of arr) {
    const n = Math.round(Number(x));
    if (!Number.isFinite(n) || n <= 0) continue;
    const clamped = Math.min(43200, Math.max(1, n));
    if (!out.includes(clamped)) out.push(clamped);
  }
  if (!out.length) return [...DEFAULT_SETTINGS.saleDurationTiers];
  return out.sort((a, b) => a - b).slice(0, 20);
}

/* ------------------------------------------------------------------ */
/* 库                                                                  */
/* ------------------------------------------------------------------ */

export class Store {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'vault.db');
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.key = null;              // 解锁后才存在
    this.tokens = new Map();      // token -> { createdAt, lastSeen }
    this._migrate();
    // 调度器由 HTTP 层统一驱动（见 server/index.mjs），
    // 这样状态流转与 Webhook 推送在同一处发生，不会互相抢跑。
  }

  _migrate() {
    // 1) 基础表。注意：依赖「后加列」的索引必须放到补列之后，
    //    否则老库（accounts 已存在、没有 state 列）会在这里直接报 no such column。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id                         INTEGER PRIMARY KEY AUTOINCREMENT,
        username                   TEXT NOT NULL,
        password_enc               TEXT NOT NULL,
        game                       TEXT NOT NULL DEFAULT '',
        note                       TEXT NOT NULL DEFAULT '',
        email                      TEXT NOT NULL DEFAULT '',
        usage_minutes              INTEGER NOT NULL DEFAULT ${DEFAULT_USAGE_MINUTES},
        state                      TEXT NOT NULL DEFAULT 'available',
        usage_since_change_seconds INTEGER NOT NULL DEFAULT 0,
        entered_pending_at         INTEGER,
        created_at                 INTEGER NOT NULL,
        updated_at                 INTEGER NOT NULL,
        last_used_at               INTEGER,
        use_count                  INTEGER NOT NULL DEFAULT 0,
        password_changed_at        INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS sessions (
        id                TEXT PRIMARY KEY,
        account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        started_at        INTEGER NOT NULL,
        ended_at          INTEGER,
        planned_seconds   INTEGER NOT NULL,
        status            TEXT NOT NULL DEFAULT 'active',
        end_reason        TEXT,
        day_key           TEXT NOT NULL,
        today_index       INTEGER NOT NULL,
        operator          TEXT NOT NULL DEFAULT 'local'
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day_key);
      CREATE INDEX IF NOT EXISTS idx_sessions_acct ON sessions(account_id, status);
      CREATE TABLE IF NOT EXISTS tasks (
        id               TEXT PRIMARY KEY,
        account_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        reason           TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending',
        source           TEXT NOT NULL DEFAULT 'system',
        created_at       INTEGER NOT NULL,
        claimed_at       INTEGER,
        claimed_by       TEXT,
        finished_at      INTEGER,
        attempts         INTEGER NOT NULL DEFAULT 0,
        message          TEXT NOT NULL DEFAULT '',
        new_password_enc TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);
      CREATE TABLE IF NOT EXISTS audit (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        at         INTEGER NOT NULL,
        actor      TEXT NOT NULL DEFAULT 'local',
        action     TEXT NOT NULL,
        account_id INTEGER,
        detail     TEXT NOT NULL DEFAULT ''
      );
    `);

    // ---- 2) 老库补列（v1 → v2）----
    const cols = new Set(
      this.db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name),
    );
    const add = (name, ddl) => {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE accounts ADD COLUMN ${ddl}`);
    };
    add('game', "game TEXT NOT NULL DEFAULT ''");
    add('usage_minutes', `usage_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_USAGE_MINUTES}`);
    add('state', "state TEXT NOT NULL DEFAULT 'available'");
    add('entered_pending_at', 'entered_pending_at INTEGER');

    // 3) 到这里 state 列一定存在了，再建索引
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_state ON accounts(state)');

    // 4) 状态修复
    // 有活跃会话的老账号 → 使用中
    this.db.exec(`
      UPDATE accounts SET state = 'in_use'
       WHERE id IN (SELECT account_id FROM sessions WHERE status = 'active')
         AND state NOT IN ('pending_change')
    `);
    this.db.exec(`
      UPDATE accounts SET state = 'available'
       WHERE state IS NULL OR state NOT IN ('available','in_use','pending_change')
    `);
    // 已有未完成改密任务的账号，归到「待改密」
    this.db.exec(`
      UPDATE accounts SET state = 'pending_change',
             entered_pending_at = COALESCE(entered_pending_at, ${nowSec()})
       WHERE id IN (SELECT account_id FROM tasks WHERE status IN ('pending','running'))
    `);

    // ---- 5) 邮箱（用于自动读取验证码）----
    // 凭据（refresh token）与账号密码同一套 AES-256-GCM 加密，绝不落明文。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mailboxes (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        label             TEXT NOT NULL DEFAULT '',
        address           TEXT NOT NULL,
        provider          TEXT NOT NULL DEFAULT 'microsoft',
        client_id         TEXT NOT NULL DEFAULT '',
        refresh_token_enc TEXT NOT NULL DEFAULT '',
        status            TEXT NOT NULL DEFAULT 'unknown',
        last_error        TEXT NOT NULL DEFAULT '',
        last_ok_at        INTEGER,
        last_fetch_at     INTEGER,
        message_count     INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_address ON mailboxes(address COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        mailbox_id   INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        graph_id     TEXT NOT NULL,
        subject      TEXT NOT NULL DEFAULT '',
        from_address TEXT NOT NULL DEFAULT '',
        from_name    TEXT NOT NULL DEFAULT '',
        to_address   TEXT NOT NULL DEFAULT '',
        received_at  INTEGER NOT NULL DEFAULT 0,
        body_preview TEXT NOT NULL DEFAULT '',
        body_text    TEXT NOT NULL DEFAULT '',
        created_at   INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_graph ON messages(mailbox_id, graph_id);
      CREATE INDEX IF NOT EXISTS idx_messages_recv ON messages(mailbox_id, received_at DESC);

      -- ★ 闲管家订单映射 ★
      --   两个用途：
      --     ① 幂等：同一个管家订单号重复请求（闲管家超时会重试），
      --        必须返回同一个结果，绝不能领两次号 —— 那等于一个订单占掉两个账号。
      --     ② 查订单详情：闲管家发货后会来核验，要从这张表把当时的卡密还回去。
      CREATE TABLE IF NOT EXISTS xgj_orders (
        order_no      TEXT PRIMARY KEY,      -- 管家订单号（闲管家唯一）
        out_order_no  TEXT NOT NULL,         -- 我们的订单号
        biz_order_no  TEXT NOT NULL DEFAULT '', -- 闲鱼订单号
        goods_no      TEXT NOT NULL DEFAULT '',
        goods_name    TEXT NOT NULL DEFAULT '',
        buy_quantity  INTEGER NOT NULL DEFAULT 1,
        order_status  INTEGER NOT NULL DEFAULT 10,  -- 10处理中 20已成功 30已失败
        order_amount  INTEGER NOT NULL DEFAULT 0,
        account_id    INTEGER,               -- 领到的账号
        card_no       TEXT NOT NULL DEFAULT '',
        card_pwd      TEXT NOT NULL DEFAULT '',
        remark        TEXT NOT NULL DEFAULT '',
        notify_url    TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,
        end_time      INTEGER,
        -- 同一次流程里我们自己的动作结果，用于回调闲管家
        notified      INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_xgj_out ON xgj_orders(out_order_no);
      CREATE INDEX IF NOT EXISTS idx_xgj_acct ON xgj_orders(account_id);
    `);

    // 账号 -> 邮箱 的关联。放在 mailboxes 建表之后再加列，
    // 对外键引用来说顺序很重要。不挂 REFERENCES：删除邮箱时下面手动置空。
    const accCols = new Set(
      this.db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name),
    );
    if (!accCols.has('mailbox_id')) {
      this.db.exec('ALTER TABLE accounts ADD COLUMN mailbox_id INTEGER');
    }
  }

  /* ---------------- 邮箱 ---------------- */

  /** 每个邮箱最多留多少封，避免数据库无限膨胀 */
  static MAX_MESSAGES_PER_MAILBOX = 300;

  _mailboxView(row) {
    return {
      id: row.id,
      label: row.label,
      address: row.address,
      provider: row.provider,
      providerLabel: row.provider === 'http' ? '取件接口' : '微软邮箱',
      // ★ 注意：绝不返回 refresh token / access token / 接口地址 ★
      hasToken: !!row.refresh_token_enc,
      // 接口地址本身就是钥匙，这里只给一个"有没有带凭据"的布尔值
      credentialInUrl: row.provider === 'http' && !!row.refresh_token_enc,
      clientIdHint: row.client_id ? `${row.client_id.slice(0, 8)}…` : '',
      status: row.status,
      lastError: row.last_error,
      lastOkAt: row.last_ok_at,
      lastFetchAt: row.last_fetch_at,
      messageCount: row.message_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listMailboxes() {
    this._requireKey();
    return this.db
      .prepare('SELECT * FROM mailboxes ORDER BY created_at DESC')
      .all()
      .map((r) => this._mailboxView(r));
  }

  getMailboxRow(id) {
    this._requireKey();
    const r = this.db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(Number(id));
    if (!r) throw Object.assign(new Error('邮箱不存在'), { status: 404 });
    return r;
  }

  /** 内部使用：把加密的凭据解出来（微软=refresh token，http=取件接口地址） */
  getMailboxToken(id) {
    const row = this.getMailboxRow(id);
    if (!row.refresh_token_enc) return null;
    try {
      return this._dec(row.refresh_token_enc);
    } catch {
      throw Object.assign(new Error('邮箱凭据解密失败'), { status: 500 });
    }
  }

  /** 通用别名 —— 现在凭据不一定是个 token 了 */
  getMailboxCredential(id) {
    return this.getMailboxToken(id);
  }

  createMailbox({
    label = '', address, provider = 'microsoft', clientId,
    refreshToken, credential,
  }, actor = 'local') {
    this._requireKey();
    const addr = String(address || '').trim();
    if (!addr) throw Object.assign(new Error('邮箱地址不能为空'), { status: 400 });
    // 邮箱地址必须长得像邮箱。用户把整条接口地址粘进这一栏是常见的误操作，
    // API 层会先尝试从 URL 里抠出邮箱；到这里还带 :// 说明真的没救，直接拒绝。
    if (addr.includes('://') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      throw Object.assign(new Error(
        `「${addr.slice(0, 60)}」不是合法的邮箱地址。这一栏要填邮箱本身，不是接口地址。`,
      ), { status: 400 });
    }

    const prov = ['microsoft', 'http'].includes(String(provider)) ? String(provider) : 'microsoft';
    // credential 是通用名；refreshToken 保留以兼容旧调用
    const secret = String(credential || refreshToken || '').trim();
    if (!secret) {
      throw Object.assign(new Error(
        prov === 'http' ? '取件接口地址不能为空' : 'refresh token 不能为空',
      ), { status: 400 });
    }
    if (prov === 'http' && !/^https?:\/\//i.test(secret)) {
      throw Object.assign(new Error('取件接口地址必须以 http:// 或 https:// 开头'), { status: 400 });
    }

    const dup = this.db.prepare('SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE').get(addr);
    if (dup) throw Object.assign(new Error('这个邮箱已经添加过了'), { status: 409 });

    const t = nowSec();
    const info = this.db.prepare(`
      INSERT INTO mailboxes (label, address, provider, client_id, refresh_token_enc,
                             status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?)
    `).run(String(label || '').trim(), addr, prov, String(clientId || '').trim(),
      this._enc(secret), t, t);

    const id = Number(info.lastInsertRowid);
    this.audit('mailbox.create', { actor, detail: `${addr}（${prov}）` });
    return this._mailboxView(this.getMailboxRow(id));
  }

  updateMailbox(id, patch = {}, actor = 'local') {
    this._requireKey();
    const row = this.getMailboxRow(id);
    const sets = [];
    const vals = [];

    if (patch.label !== undefined) { sets.push('label = ?'); vals.push(String(patch.label).trim()); }
    if (patch.address !== undefined) {
      const addr = String(patch.address).trim();
      if (!addr) throw Object.assign(new Error('邮箱地址不能为空'), { status: 400 });
      const dup = this.db.prepare('SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE AND id != ?').get(addr, Number(id));
      if (dup) throw Object.assign(new Error('这个邮箱已经添加过了'), { status: 409 });
      sets.push('address = ?'); vals.push(addr);
    }
    if (patch.clientId !== undefined) { sets.push('client_id = ?'); vals.push(String(patch.clientId).trim()); }
    // 只有显式传了新凭据才覆盖，避免"改个备注把凭据清空"
    const newSecret = patch.credential ?? patch.refreshToken;
    if (newSecret !== undefined && String(newSecret).trim()) {
      const secret = String(newSecret).trim();
      const prov = patch.provider ? String(patch.provider) : row.provider;
      if (prov === 'http' && !/^https?:\/\//i.test(secret)) {
        throw Object.assign(new Error('取件接口地址必须以 http:// 或 https:// 开头'), { status: 400 });
      }
      sets.push('refresh_token_enc = ?');
      vals.push(this._enc(secret));
    }
    if (!sets.length) return this._mailboxView(row);

    sets.push('updated_at = ?'); vals.push(nowSec());
    vals.push(Number(id));
    this.db.prepare(`UPDATE mailboxes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    this.audit('mailbox.update', { actor, detail: row.address });
    return this._mailboxView(this.getMailboxRow(id));
  }

  deleteMailbox(id, actor = 'local') {
    this._requireKey();
    const row = this.getMailboxRow(id);
    // 先把引用置空，避免账号指向一个不存在的邮箱
    const n = this.db.prepare('UPDATE accounts SET mailbox_id = NULL WHERE mailbox_id = ?').run(Number(id)).changes;
    this.db.prepare('DELETE FROM mailboxes WHERE id = ?').run(Number(id));
    this.audit('mailbox.delete', {
      actor,
      detail: `${row.address}${n ? `（解除了 ${n} 个账号的关联）` : ''}`,
    });
    return { ok: true, unlinked: n };
  }

  /**
   * 保存刷新后的 token。
   *
   * ★ 这一步不能省 ★ 微软会轮换 refresh token：每次刷新都可能返回新的，
   * 旧的随之作废。如果不回写，用一段时间后所有 token 会集体失效。
   */
  saveRefreshedToken(id, refreshToken) {
    if (!refreshToken) return;             // 微软没给新的就保持原样
    this.db
      .prepare('UPDATE mailboxes SET refresh_token_enc = ?, updated_at = ? WHERE id = ?')
      .run(this._enc(String(refreshToken)), nowSec(), Number(id));
  }

  setMailboxStatus(id, status, error = '') {
    const ok = status === 'ok';
    this.db.prepare(`
      UPDATE mailboxes
         SET status = ?, last_error = ?,
             last_ok_at = CASE WHEN ? THEN ? ELSE last_ok_at END,
             updated_at = ?
       WHERE id = ?
    `).run(status, String(error).slice(0, 500), ok ? 1 : 0, nowSec(), nowSec(), Number(id));
    return this._mailboxView(this.getMailboxRow(id));
  }

  /** 写入一批邮件；已存在的（同 graph_id）不重复插 */
  saveMessages(mailboxId, items = []) {
    this._requireKey();
    if (!items.length) return 0;
    const ins = this.db.prepare(`
      INSERT OR IGNORE INTO messages
        (mailbox_id, graph_id, subject, from_address, from_name,
         to_address, received_at, body_preview, body_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const t = nowSec();
    let added = 0;
    for (const m of items) {
      const r = ins.run(
        Number(mailboxId), String(m.graphId), String(m.subject || '').slice(0, 400),
        String(m.fromAddress || '').slice(0, 300), String(m.fromName || '').slice(0, 200),
        String(m.toAddress || '').slice(0, 300), Number(m.receivedAt) || 0,
        String(m.bodyPreview || '').slice(0, 1000), String(m.bodyText || '').slice(0, 20000), t,
      );
      if (r.changes) added += 1;
    }
    // 只保留最近 N 封
    this.db.prepare(`
      DELETE FROM messages
       WHERE mailbox_id = ?
         AND id NOT IN (
           SELECT id FROM messages WHERE mailbox_id = ? ORDER BY received_at DESC LIMIT ?
         )
    `).run(Number(mailboxId), Number(mailboxId), Store.MAX_MESSAGES_PER_MAILBOX);

    const cnt = this.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE mailbox_id = ?').get(Number(mailboxId)).c;
    this.db.prepare('UPDATE mailboxes SET message_count = ?, last_fetch_at = ?, updated_at = ? WHERE id = ?')
      .run(cnt, t, t, Number(mailboxId));
    return added;
  }

  listMessages(mailboxId, { limit = 50, q = '' } = {}) {
    this._requireKey();
    const like = `%${String(q).trim()}%`;
    const rows = q
      ? this.db.prepare(`
          SELECT id, mailbox_id, graph_id, subject, from_address, from_name, to_address,
                 received_at, body_preview, body_text
            FROM messages
           WHERE mailbox_id = ? AND (subject LIKE ? OR from_address LIKE ? OR body_preview LIKE ?)
           ORDER BY received_at DESC LIMIT ?
        `).all(Number(mailboxId), like, like, like, Number(limit))
      : this.db.prepare(`
          SELECT id, mailbox_id, graph_id, subject, from_address, from_name, to_address,
                 received_at, body_preview, body_text
            FROM messages
           WHERE mailbox_id = ? ORDER BY received_at DESC LIMIT ?
        `).all(Number(mailboxId), Number(limit));
    return rows.map((r) => ({
      id: r.id,
      mailboxId: r.mailbox_id,
      graphId: r.graph_id,
      subject: r.subject,
      fromAddress: r.from_address,
      fromName: r.from_name,
      toAddress: r.to_address,
      receivedAt: r.received_at,
      bodyPreview: r.body_preview,
      bodyText: r.body_text,
    }));
  }

  getMessage(id) {
    this._requireKey();
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id));
    if (!r) throw Object.assign(new Error('邮件不存在'), { status: 404 });
    return {
      id: r.id,
      mailboxId: r.mailbox_id,
      graphId: r.graph_id,
      subject: r.subject,
      fromAddress: r.from_address,
      fromName: r.from_name,
      toAddress: r.to_address,
      receivedAt: r.received_at,
      bodyPreview: r.body_preview,
      bodyText: r.body_text,
    };
  }

  /** 取一段时间内到达的邮件（带完整正文），用于提取验证码 */
  listMessagesSince(mailboxId, { since = 0, limit = 30 } = {}) {
    this._requireKey();
    return this.db.prepare(`
      SELECT id, mailbox_id, subject, from_address, to_address, received_at, body_text
        FROM messages
       WHERE mailbox_id = ? AND received_at >= ?
       ORDER BY received_at DESC LIMIT ?
    `).all(Number(mailboxId), Number(since), Number(limit)).map((r) => ({
      id: r.id,
      mailboxId: r.mailbox_id,
      subject: r.subject,
      fromAddress: r.from_address,
      toAddress: r.to_address,
      receivedAt: r.received_at,
      bodyText: r.body_text,
    }));
  }

  /** 这个账号的验证邮件收在哪个邮箱；没关联返回 null */
  getAccountMailbox(accountId) {
    const row = this.getAccountRow(accountId);
    if (!row.mailbox_id) return null;
    const box = this.db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(row.mailbox_id);
    return box ? this._mailboxView(box) : null;
  }

  /* ---------------- meta ---------------- */

  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  audit(action, { actor = 'local', accountId = null, detail = '' } = {}) {
    this.db
      .prepare('INSERT INTO audit (at, actor, action, account_id, detail) VALUES (?, ?, ?, ?, ?)')
      .run(nowSec(), actor, action, accountId, detail);
  }

  /* ---------------- 生命周期 ---------------- */

  get initialized() {
    return !!this.getMeta('verifier');
  }

  get unlocked() {
    return !!this.key;
  }

  setup(masterPassword) {
    if (this.initialized) throw Object.assign(new Error('保险库已初始化'), { status: 409 });
    if (!masterPassword || masterPassword.length < 6) {
      throw Object.assign(new Error('主密码至少 6 位'), { status: 400 });
    }
    const salt = newSalt();
    const key = deriveKey(masterPassword, salt);
    this.setMeta('kdf.salt', salt);
    this.setMeta('verifier', makeVerifier(key));
    this.setMeta('settings', JSON.stringify(DEFAULT_SETTINGS));
    this.setMeta('apiKey', randomToken(24));
    this.setMeta('createdAt', String(nowSec()));
    this.key = key;
    this.audit('vault.setup');
    return this.issueToken();
  }

  unlock(masterPassword) {
    if (!this.initialized) throw Object.assign(new Error('保险库尚未初始化'), { status: 409 });
    const salt = this.getMeta('kdf.salt');
    const key = deriveKey(masterPassword, salt);
    if (!checkVerifier(key, this.getMeta('verifier'))) {
      this.audit('vault.unlock.failed', { detail: '主密码错误' });
      throw Object.assign(new Error('主密码错误'), { status: 401 });
    }
    this.key = key;
    this.audit('vault.unlock');
    return this.issueToken();
  }

  lock() {
    this.key = null;
    this.tokens.clear();
    this.audit('vault.lock');
  }

  issueToken() {
    const token = randomToken(32);
    this.tokens.set(token, { createdAt: Date.now(), lastSeen: Date.now() });
    return token;
  }

  validateToken(token) {
    const rec = this.tokens.get(token);
    if (!rec || !this.key) return false;
    rec.lastSeen = Date.now();
    return true;
  }

  dropToken(token) {
    this.tokens.delete(token);
  }

  checkAutoLock(settings) {
    const mins = Number(settings?.autoLockMinutes) || 0;
    if (!mins || !this.key) return false;
    const limit = mins * 60 * 1000;
    const now = Date.now();
    let latest = 0;
    for (const rec of this.tokens.values()) latest = Math.max(latest, rec.lastSeen);
    if (latest && now - latest > limit) {
      this.lock();
      return true;
    }
    return false;
  }

  changeMasterPassword(current, next) {
    this._requireKey();
    const salt = this.getMeta('kdf.salt');
    if (!checkVerifier(deriveKey(current, salt), this.getMeta('verifier'))) {
      throw Object.assign(new Error('当前主密码错误'), { status: 401 });
    }
    if (!next || next.length < 6) throw Object.assign(new Error('新主密码至少 6 位'), { status: 400 });
    const newSaltV = newSalt();
    const newKey = deriveKey(next, newSaltV);
    const re = [];
    for (const r of this.db.prepare('SELECT id, password_enc FROM accounts').all()) {
      re.push([r.id, encrypt(newKey, decrypt(this.key, r.password_enc))]);
    }
    const reTasks = [];
    for (const r of this.db
      .prepare('SELECT id, new_password_enc FROM tasks WHERE new_password_enc IS NOT NULL').all()) {
      reTasks.push([r.id, encrypt(newKey, decrypt(this.key, r.new_password_enc))]);
    }
    this.db.exec('BEGIN');
    try {
      const upAcc = this.db.prepare('UPDATE accounts SET password_enc = ? WHERE id = ?');
      for (const [id, v] of re) upAcc.run(v, id);
      const upTask = this.db.prepare('UPDATE tasks SET new_password_enc = ? WHERE id = ?');
      for (const [id, v] of reTasks) upTask.run(v, id);
      this.setMeta('kdf.salt', newSaltV);
      this.setMeta('verifier', makeVerifier(newKey));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.key = newKey;
    this.tokens.clear();
    this.audit('vault.master.changed');
    return this.issueToken();
  }

  _requireKey() {
    if (!this.key) throw Object.assign(new Error('保险库已锁定，请先解锁'), { status: 401 });
    return this.key;
  }

  /* ---------------- 设置 ---------------- */

  getSettings() {
    let s = {};
    try { s = JSON.parse(this.getMeta('settings') || '{}'); } catch { s = {}; }
    // 只保留当前版本认识的键，老版本的自动改密设置一并丢弃
    // ★ xgj 要单独拷一份 ★
    //   写成 `{ ...DEFAULT_SETTINGS }` 的话，out.xgj 和 DEFAULT_SETTINGS.xgj
    //   是**同一个对象**。后面只要有地方原地改 out.xgj，就把模块级的默认值污染了，
    //   之后所有新账本都会带着上一个账本的密钥 —— 很难查。
    const out = { ...DEFAULT_SETTINGS, xgj: { ...DEFAULT_SETTINGS.xgj } };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (s[k] !== undefined) {
        out[k] = (k === 'xgj' && s.xgj && typeof s.xgj === 'object')
          ? { ...s.xgj }
          : s[k];
      }
    }
    return out;
  }

  updateSettings(patch) {
    const cur = this.getSettings();
    const next = { ...cur };

    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      // ★ 跳过嵌套对象 ★
      //   这个循环是"有就覆盖"的浅合并。xgj 是个对象，一旦让它把 next.xgj 覆盖成
      //   patch.xgj（比如只是 `{enabled:false}`），下面那个深合并就拿不到已保存的
      //   密钥了，结果就是：**在界面上点一下开关，mchSecret/appId 全被清空**。
      //   实测踩过。嵌套对象一律交给下面单独处理。
      if (k === 'xgj') continue;
      if (patch[k] !== undefined) next[k] = patch[k];
    }

    next.autoLockMinutes = Math.max(0, Number(next.autoLockMinutes) || 0);
    next.webhookUrl = String(next.webhookUrl || '');
    next.webhookSecret = String(next.webhookSecret || '');
    next.autoCopyOnUse = !!next.autoCopyOnUse;
    if (!['dark', 'light'].includes(next.theme)) next.theme = 'dark';

    // ★ 售卖档位：必须是正整数数组，去重后从小到大 ★
    //   传成字符串或带 0 会算出荒唐的商品（0 分钟的号），所以这里强制洗一遍
    next.saleDurationTiers = normalizeTiers(next.saleDurationTiers);

    // ★ xgj 深合并：底必须是**已保存的 cur.xgj**，不是 next.xgj ★
    next.xgj = { ...DEFAULT_SETTINGS.xgj, ...cur.xgj, ...(patch.xgj || {}) };
    next.xgj.enabled = !!next.xgj.enabled;
    next.xgj.mchId = String(next.xgj.mchId || 'steam01').trim() || 'steam01';
    next.xgj.mchSecret = String(next.xgj.mchSecret || '').trim();
    next.xgj.appId = String(next.xgj.appId || '').trim();
    next.xgj.appSecret = String(next.xgj.appSecret || '').trim();
    next.xgj.ipWhitelist = !!next.xgj.ipWhitelist;
    next.xgj.priceFen = Math.max(0, Math.round(Number(next.xgj.priceFen) || 0));

    this.setMeta('settings', JSON.stringify(next));
    // ★ 审计里不能落明文密钥 ★
    //   settings.update 原本是把整个 patch 原样 JSON 进去的，结果
    //   mchSecret / appSecret / webhookSecret 这些全成了明文存在 audit 表里，
    //   而审计在界面上是能看的 —— 相当于数据库加密做了个寂寞。实测踩过。
    //   这里只记"改了哪些字段"，值一律打码。
    const changedKeys = redactSettingsPatch(patch);
    this.audit('settings.update', { detail: changedKeys });
    return next;
  }

  getApiKey() {
    let k = this.getMeta('apiKey');
    if (!k) { k = randomToken(24); this.setMeta('apiKey', k); }
    return k;
  }

  rotateApiKey() {
    const k = randomToken(24);
    this.setMeta('apiKey', k);
    this.audit('apikey.rotate');
    return k;
  }

  /* ---------------- 账号 ---------------- */

  _enc(plain) { return encrypt(this._requireKey(), plain); }
  _dec(enc) { return decrypt(this._requireKey(), enc); }

  _view(row, extra = {}) {
    const session = extra.session || null;
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      game: row.game,
      note: row.note,
      usageMinutes: row.usage_minutes,
      state: row.state,
      stateLabel: STATE_LABEL[row.state] || row.state,
      usageSinceChangeSeconds: row.usage_since_change_seconds,
      enteredPendingAt: row.entered_pending_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      useCount: row.use_count,
      passwordChangedAt: row.password_changed_at,
      mailboxId: row.mailbox_id ?? null,
      session,
      inUse: row.state === STATE.IN_USE,
      pendingChange: row.state === STATE.PENDING,
      available: row.state === STATE.AVAILABLE,
      task: extra.task || null,
    };
  }

  getAccountRow(id) {
    this._requireKey();
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(id));
    if (!r) throw Object.assign(new Error('账号不存在'), { status: 404 });
    return r;
  }

  /** 会话对象（含前端倒计时需要的全部字段） */
  _sessionView(s) {
    const elapsed = s.ended_at ? (s.ended_at - s.started_at) : Math.max(0, nowSec() - s.started_at);
    const remaining = Math.max(0, s.planned_seconds - elapsed);
    return {
      id: s.id,
      accountId: s.account_id,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      plannedSeconds: s.planned_seconds,
      plannedMinutes: Math.round(s.planned_seconds / 60),
      elapsedSeconds: elapsed,
      elapsedText: fmtDuration(elapsed),
      remainingSeconds: remaining,
      status: s.status,
      todayIndex: s.today_index,
      dayKey: s.day_key,
      progress: Math.min(1, elapsed / Math.max(1, s.planned_seconds)),
      expiresAt: s.started_at + s.planned_seconds,
    };
  }

  _activeSession(accountId) {
    return this.db
      .prepare("SELECT * FROM sessions WHERE account_id = ? AND status = 'active'")
      .get(Number(accountId)) || null;
  }

  /** 账号所处的未完成改密任务 */
  _openTask(accountId) {
    const t = this.db.prepare(
      "SELECT * FROM tasks WHERE account_id = ? AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1",
    ).get(Number(accountId));
    return t ? this._taskView(t) : null;
  }

  /**
   * 按界面列出账号
   * @param {'available'|'in_use'|'pending_change'} state 必填，对应三个界面
   */
  listByState(state, { q = '', sort = '' } = {}) {
    this._requireKey();
    if (!ALL_STATES.includes(state)) {
      throw Object.assign(new Error(`未知状态：${state}`), { status: 400 });
    }
    let rows = this.db.prepare('SELECT * FROM accounts WHERE state = ?').all(state);

    const needle = String(q || '').trim().toLowerCase();
    if (needle) {
      rows = rows.filter((r) =>
        r.username.toLowerCase().includes(needle) ||
        r.game.toLowerCase().includes(needle) ||
        r.note.toLowerCase().includes(needle) ||
        r.email.toLowerCase().includes(needle));
    }

    const items = rows.map((r) => {
      const s = state === STATE.IN_USE ? this._activeSession(r.id) : null;
      const extra = { session: s ? this._sessionView(s) : null };
      if (state === STATE.PENDING) extra.task = this._openTask(r.id);
      return this._view(r, extra);
    });

    const cmp = {
      name: (a, b) => a.username.localeCompare(b.username, 'zh'),
      recent: (a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || b.id - a.id,
      created: (a, b) => b.createdAt - a.createdAt || b.id - a.id,
      game: (a, b) => (a.game || '').localeCompare(b.game || '', 'zh') || a.username.localeCompare(b.username, 'zh'),
      longest: (a, b) => b.usageMinutes - a.usageMinutes,
    }[sort];

    if (state === STATE.IN_USE) {
      // 使用中：剩余时间最少的排最前，最紧急的优先处理
      items.sort((a, b) => (a.session?.remainingSeconds ?? 1e9) - (b.session?.remainingSeconds ?? 1e9));
    } else if (state === STATE.PENDING) {
      // 待改密：先按"等了多久"排，等最久的排最前
      items.sort((a, b) => (a.enteredPendingAt || 0) - (b.enteredPendingAt || 0));
    } else if (cmp) {
      items.sort(cmp);
    } else {
      items.sort((a, b) => b.id - a.id);
    }

    return { state, stateLabel: STATE_LABEL[state], items, count: items.length };
  }

  getAccount(id) {
    const row = this.getAccountRow(id);
    const session = row.state === STATE.IN_USE ? this._activeSession(row.id) : null;
    const extra = { session: session ? this._sessionView(session) : null };
    if (row.state === STATE.PENDING) extra.task = this._openTask(row.id);
    return this._view(row, extra);
  }

  createAccount({
    username, password, game = '', note = '', email = '',
    usageMinutes = DEFAULT_USAGE_MINUTES, mailboxId = null,
  }, actor = 'local') {
    this._requireKey();
    const name = String(username || '').trim();
    if (!name) throw Object.assign(new Error('账号不能为空'), { status: 400 });
    if (!password) throw Object.assign(new Error('密码不能为空'), { status: 400 });
    const exists = this.db.prepare('SELECT id FROM accounts WHERE username = ? COLLATE NOCASE').get(name);
    if (exists) throw Object.assign(new Error(`账号 ${name} 已存在`), { status: 409 });

    const box = mailboxId ? this.getMailboxRow(mailboxId) : null;   // 顺带校验存在

    const t = nowSec();
    const info = this.db.prepare(`
      INSERT INTO accounts (username, password_enc, game, note, email, usage_minutes, state,
                            mailbox_id, created_at, updated_at, password_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?, ?, ?)
    `).run(
      name, this._enc(String(password)), String(game || '').trim(), String(note || '').trim(),
      String(email || '').trim(), normalizeUsageMinutes(usageMinutes), box ? box.id : null, t, t, t,
    );
    const id = Number(info.lastInsertRowid);
    this.audit('account.create', { actor, accountId: id, detail: name });
    return this.getAccount(id);
  }

  updateAccount(id, patch, actor = 'local') {
    const row = this.getAccountRow(id);
    const fields = [];
    const vals = [];
    const set = (col, v) => { fields.push(`${col} = ?`); vals.push(v); };

    if (patch.username !== undefined) {
      const name = String(patch.username).trim();
      if (!name) throw Object.assign(new Error('账号不能为空'), { status: 400 });
      const dup = this.db
        .prepare('SELECT id FROM accounts WHERE username = ? COLLATE NOCASE AND id <> ?')
        .get(name, row.id);
      if (dup) throw Object.assign(new Error(`账号 ${name} 已存在`), { status: 409 });
      set('username', name);
    }
    if (patch.game !== undefined) set('game', String(patch.game || '').trim());
    if (patch.note !== undefined) set('note', String(patch.note || '').trim());
    if (patch.email !== undefined) set('email', String(patch.email || '').trim());
    if (patch.usageMinutes !== undefined) set('usage_minutes', normalizeUsageMinutes(patch.usageMinutes));
    if (patch.mailboxId !== undefined) {
      // null / 0 / '' 表示解除关联
      if (!patch.mailboxId) set('mailbox_id', null);
      else set('mailbox_id', this.getMailboxRow(patch.mailboxId).id);
    }
    if (patch.password) {
      set('password_enc', this._enc(String(patch.password)));
      set('password_changed_at', nowSec());
    }

    if (!fields.length) return this.getAccount(row.id);
    set('updated_at', nowSec());
    vals.push(row.id);
    this.db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).run(...vals);

    // 改了使用时长要同步到进行中的会话，否则倒计时不会变
    if (patch.usageMinutes !== undefined && row.state === STATE.IN_USE) {
      const s = this._activeSession(row.id);
      if (s) {
        const planned = normalizeUsageMinutes(patch.usageMinutes) * 60;
        this.db.prepare('UPDATE sessions SET planned_seconds = ? WHERE id = ?').run(planned, s.id);
      }
    }

    this.audit('account.update', { actor, accountId: row.id, detail: Object.keys(patch).join(',') });
    return this.getAccount(row.id);
  }

  deleteAccount(id, actor = 'local') {
    const row = this.getAccountRow(id);
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(row.id);
    this.audit('account.delete', { actor, accountId: row.id, detail: row.username });
    return { ok: true };
  }

  revealPassword(id, actor = 'local') {
    const row = this.getAccountRow(id);
    const pw = this._dec(row.password_enc);
    this.audit('account.reveal', { actor, accountId: row.id, detail: row.username });
    return { username: row.username, game: row.game, password: pw };
  }

  bulkImport(entries, defaultUsageMinutes = DEFAULT_USAGE_MINUTES, actor = 'local') {
    this._requireKey();
    const results = { created: 0, skipped: 0, errors: [] };
    for (const e of entries) {
      try {
        this.createAccount({ ...e, usageMinutes: e.usageMinutes || defaultUsageMinutes }, actor);
        results.created += 1;
      } catch (err) {
        if (err.status === 409) results.skipped += 1;
        else results.errors.push(`${e.username || '?'}: ${err.message}`);
      }
    }
    this.audit('account.bulkImport', { actor, detail: `${results.created} 条` });
    return results;
  }

  /* ---------------- 状态流转 ---------------- */

  /**
   * 可用 ──▶ 使用中
   * 倒计时长度 = 该账号自己的 usage_minutes
   */
  startUse(accountId, { actor = 'local' } = {}) {
    const row = this.getAccountRow(accountId);
    if (row.state === STATE.IN_USE) {
      throw Object.assign(new Error('该账号已经在使用中'), { status: 409 });
    }
    if (row.state === STATE.PENDING) {
      throw Object.assign(new Error('该账号待改密，请先完成改密再使用'), { status: 409 });
    }
    if (this._activeSession(row.id)) {
      throw Object.assign(new Error('该账号存在未结束的会话'), { status: 409 });
    }

    const settings = this.getSettings();
    const dk = dayKey();
    const t = nowSec();
    const planned = normalizeUsageMinutes(row.usage_minutes) * 60;

    this.db.exec('BEGIN IMMEDIATE');
    let todayIndex;
    try {
      todayIndex = this.todayCount(dk) + 1;
      const sid = randomToken(12);
      this.db.prepare(`
        INSERT INTO sessions (id, account_id, started_at, planned_seconds, status, day_key, today_index, operator)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(sid, row.id, t, planned, dk, todayIndex, actor);
      this.db.prepare(`
        UPDATE accounts SET state = 'in_use', last_used_at = ?, use_count = use_count + 1, updated_at = ?
        WHERE id = ?
      `).run(t, t, row.id);
      this.db.exec('COMMIT');
      this.audit('state.available->in_use', { actor, accountId: row.id, detail: `今日第 ${todayIndex} 个` });

      const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
      const credential = { username: row.username, password: this._dec(row.password_enc) };
      credential.text = formatCredential(credential.username, credential.password);
      return {
        account: this.getAccount(row.id),
        session: this._sessionView(session),
        todayIndex,
        todayTotal: this.todayCount(dk),
        credential,
        plannedMinutes: Math.round(planned / 60),
        message: `这是今天第 ${todayIndex} 个使用的账号`,
        autoCopy: settings.autoCopyOnUse,
      };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * 按游戏名领一个空闲账号，并把凭据一起给出去。
   *
   * 给客服系统这类外部程序用 —— 一次调用就拿到可用的账号密码。
   *
   *   规则：
   *     ① 只从「可用」里挑（禁用的不算）
   *     ② 游戏名：先**精确**匹配（忽略大小写），找不到再按**包含**匹配
   *     ③ **最近没用的优先**（last_used_at 升序；从没用过的是 0，排最前）
   *     ④ 一次只给一个
   *
   *   ★ 为什么没有"归还"接口 ★
   *     领走之后账号就进入「使用中」并开始计时，到点自动进「待改密」，
   *     由 worker 改完密码再回到「可用」。**每次借出都换密码**，这是这套工具的安全基础；
   *     如果提供"用完就还、不换密码"，那借出去的密码就一直有效，等于白做。
   *
   * 返回 { ok:false, message:'暂无账号' } 表示没货。
   */
  claimAvailable({ game = '', minutes, actor = 'automation' } = {}) {
    this._requireKey();
    const want = String(game || '').trim().toLowerCase();

    // ① 只挑「可用」的
    //   ★ 注意别用 disabled 列 ★
    //   老版本的库里曾经有 disabled / steam_guard / exclude_auto_change 三列，
    //   但现在的建表语句里**没有它们**，代码也一个都不用 —— 是历史遗留。
    //   在新库上写 `AND disabled = 0` 会直接报 no such column: disabled。
    const pool0 = this.db.prepare(
      "SELECT * FROM accounts WHERE state = 'available'",
    ).all();

    let pool = pool0;
    let matchedBy = 'any';
    if (want) {
      // ② 先精确，再包含
      const exact = pool0.filter((r) => String(r.game || '').trim().toLowerCase() === want);
      if (exact.length) {
        pool = exact;
        matchedBy = 'exact';
      } else {
        const part = pool0.filter((r) => String(r.game || '').toLowerCase().includes(want));
        if (part.length) {
          pool = part;
          matchedBy = 'contains';
        } else {
          pool = [];
          matchedBy = 'none';
        }
      }
    }

    if (!pool.length) {
      return {
        ok: false,
        message: '暂无账号',
        game: String(game || ''),
        // 顺手告诉调用方还有多少空闲账号，方便排查（不是匹配不到，而是真没货）
        availableTotal: pool0.length,
      };
    }

    // ③ 最近没用的优先；一样久就按 id（保证稳定）
    pool.sort((a, b) => (a.last_used_at || 0) - (b.last_used_at || 0) || a.id - b.id);

    const chosen = pool[0];

    // ★ ④ 按订单改使用时长（B 方案）★
    //   订单说「链在一起 6 小时」，就随便抽一个该游戏的空闲账号，把它的使用时间改成 6 小时。
    //   所以不用事先给每个时长单独备货，一个账号能接任意时长的单。
    //
    //   ★ 必须在 startUse 之前改 ★
    //     startUse 是读 accounts.usage_minutes 来算 planned_seconds 的，
    //     改晚了这一单的倒计时还是旧值。
    //
    //   ★ 只在"调用方明确传了时长"时才改 ★
    //     normalizeUsageMinutes() 对空值会返回默认的 360 分钟，
    //     不判断的话，不传时长的调用会把账号悄悄改成 6 小时。
    const wantsDuration = minutes !== undefined && minutes !== null
      && String(minutes).trim() !== '' && Number(minutes) > 0;
    let appliedMinutes = normalizeUsageMinutes(chosen.usage_minutes);
    if (wantsDuration) {
      appliedMinutes = normalizeUsageMinutes(minutes);
      if (appliedMinutes !== normalizeUsageMinutes(chosen.usage_minutes)) {
        this.db.prepare('UPDATE accounts SET usage_minutes = ?, updated_at = ? WHERE id = ?')
          .run(appliedMinutes, nowSec(), chosen.id);
        this.audit('account.usage_minutes', {
          actor,
          accountId: chosen.id,
          detail: `按订单改为 ${appliedMinutes} 分钟（原 ${chosen.usage_minutes}）`,
        });
      }
    }

    const r = this.startUse(chosen.id, { actor });

    return {
      ok: true,
      accountId: chosen.id,
      username: r.credential.username,
      password: r.credential.password,
      // 需求里那个格式：账号：\nxxx\n\n密码：\nyyy
      text: r.credential.text,
      game: chosen.game,
      note: chosen.note || '',
      matchedBy,
      // 计时相关：到点自动进「待改密」→ 改密 → 回「可用」
      sessionId: r.session.id,
      usageMinutes: r.plannedMinutes,
      expiresAt: r.session.expiresAt,
      remainingSeconds: r.session.remainingSeconds,
      todayIndex: r.todayIndex,
      todayTotal: r.todayTotal,
      // 这一单实际用的时长（订单要求的），以及有没有为此改过账号配置
      appliedMinutes,
      durationChanged: wantsDuration && appliedMinutes !== normalizeUsageMinutes(chosen.usage_minutes),
      message: `已分配账号（今日第 ${r.todayIndex} 个，可用 ${r.plannedMinutes} 分钟）`,
    };
  }

  /* ---------------- ★ 闲管家订单 ★ ---------------- */

  findXgjOrder(orderNo) {
    if (!orderNo) return null;
    return this.db.prepare('SELECT * FROM xgj_orders WHERE order_no = ?').get(String(orderNo)) || null;
  }

  /**
   * ★ 三种订单号都能查 ★
   *
   * 闲管家给我们的是 order_no，但**买家在闲鱼页面上看到的是哪一个、内容模板里的
   * {$订单编号} 又对应哪一个，我们控制不了** —— 只能实测。
   * 与其赌，不如三种都认：
   *   order_no      闲管家订单号（下单接口里叫 order_no）
   *   biz_order_no  闲鱼订单号（下单接口里叫 biz_order_no）
   *   out_order_no  我们自己生成的号
   *
   * 实测数据：闲管家真实下单时 order_no 和 biz_order_no 是同一个 19 位数字，
   * 但不同来源的订单不一定，所以三个都查一遍最保险。
   */
  findXgjOrderAny(no) {
    const n = String(no || '').trim();
    if (!n) return null;
    return this.db.prepare(
      `SELECT * FROM xgj_orders
        WHERE order_no = ? OR biz_order_no = ? OR out_order_no = ?
        ORDER BY created_at DESC LIMIT 1`,
    ).get(n, n, n) || null;
  }

  findXgjOrderByAccount(accountId) {
    return this.db.prepare('SELECT * FROM xgj_orders WHERE account_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(accountId) || null;
  }

  insertXgjOrder(row) {
    this.db.prepare(`
      INSERT INTO xgj_orders
        (order_no, out_order_no, biz_order_no, goods_no, goods_name, buy_quantity,
         order_status, order_amount, account_id, card_no, card_pwd, remark,
         notify_url, created_at, end_time, notified)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      String(row.orderNo), String(row.outOrderNo), String(row.bizOrderNo || ''),
      String(row.goodsNo || ''), String(row.goodsName || ''),
      Number(row.buyQuantity) || 1, Number(row.orderStatus) || 10,
      Number(row.orderAmount) || 0, row.accountId ?? null,
      String(row.cardNo || ''), String(row.cardPwd || ''), String(row.remark || ''),
      String(row.notifyUrl || ''), nowSec(), row.endTime ?? null, row.notified ? 1 : 0,
    );
    return this.findXgjOrder(row.orderNo);
  }

  updateXgjOrder(orderNo, patch = {}) {
    const map = {
      orderStatus: 'order_status', orderAmount: 'order_amount', accountId: 'account_id',
      cardNo: 'card_no', cardPwd: 'card_pwd', remark: 'remark', endTime: 'end_time',
      notified: 'notified', outOrderNo: 'out_order_no',
    };
    const sets = []; const vals = [];
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(k === 'notified' ? (patch[k] ? 1 : 0) : patch[k]);
      }
    }
    if (!sets.length) return this.findXgjOrder(orderNo);
    vals.push(String(orderNo));
    this.db.prepare(`UPDATE xgj_orders SET ${sets.join(', ')} WHERE order_no = ?`).run(...vals);
    return this.findXgjOrder(orderNo);
  }

  /**
   * 每个游戏的库存统计 —— 闲管家商品列表的库存就是从这里来的。
   *
   * 返回 { 游戏名: { available, in_use, pending, total } }
   * 「加新游戏」就是往账号库加个该游戏的账号，这里会自动多出一个键。
   */
  gameStock() {
    const rows = this.db.prepare(`
      SELECT game, state, COUNT(*) AS n FROM accounts
      WHERE TRIM(game) <> ''
      GROUP BY game, state
    `).all();
    const out = {};
    for (const r of rows) {
      const g = String(r.game).trim();
      if (!out[g]) out[g] = { available: 0, in_use: 0, pending_change: 0, total: 0 };
      out[g][r.state] = (out[g][r.state] || 0) + r.n;
      out[g].total += r.n;
    }
    return out;
  }

  /** 内部：结束会话并累加已用时长 */
  _closeSession(session, reason) {
    const t = nowSec();
    const elapsed = Math.max(0, t - session.started_at);
    this.db.prepare("UPDATE sessions SET status = ?, ended_at = ?, end_reason = ? WHERE id = ?")
      .run(reason === 'expired' ? 'expired' : 'ended', t, reason, session.id);
    this.db.prepare(
      'UPDATE accounts SET usage_since_change_seconds = usage_since_change_seconds + ? WHERE id = ?',
    ).run(elapsed, session.account_id);
    return elapsed;
  }

  /**
   * 使用中 ──▶ 可用（用户提前结束，不进入待改密）
   */
  cancelUse(accountId, { actor = 'local' } = {}) {
    const row = this.getAccountRow(accountId);
    const s = this._activeSession(row.id);
    if (!s) throw Object.assign(new Error('该账号当前不在使用中'), { status: 409 });
    const elapsed = this._closeSession(s, 'canceled');
    this.db.prepare("UPDATE accounts SET state = 'available', updated_at = ? WHERE id = ?")
      .run(nowSec(), row.id);
    this.audit('state.in_use->available', { actor, accountId: row.id, detail: `提前结束 ${fmtDuration(elapsed)}` });
    return this.getAccount(row.id);
  }

  /**
   * 使用中 ──▶ 待改密（倒计时归零时由调度器调用）
   * 同时创建改密任务，交给 AI 或手动处理
   */
  _expireToPending(accountRow, session, elapsed) {
    const t = nowSec();
    const reason = `使用时间已用完（${Math.round(session.planned_seconds / 60)} 分钟）`;
    this.db.prepare(`
      UPDATE accounts SET state = 'pending_change', entered_pending_at = ?, updated_at = ?
      WHERE id = ?
    `).run(t, t, accountRow.id);
    const task = this.createTask(accountRow.id, { reason, source: 'timer' }, 'timer');
    this.audit('state.in_use->pending_change', {
      actor: 'timer', accountId: accountRow.id, detail: `已用 ${fmtDuration(elapsed)}`,
    });
    return task;
  }

  /**
   * 待改密 ──▶ 可用（AI 回传新密码 / 手动改密后调用）
   */
  _resolveToAvailable(accountId, newPassword, { actor = 'local', detail = '' } = {}) {
    const row = this.getAccountRow(accountId);
    const t = nowSec();
    const enc = newPassword ? this._enc(String(newPassword)) : null;
    this.db.prepare(`
      UPDATE accounts SET state = 'available', entered_pending_at = NULL,
        usage_since_change_seconds = 0, updated_at = ?,
        password_changed_at = CASE WHEN ? IS NULL THEN password_changed_at ELSE ? END,
        password_enc = COALESCE(?, password_enc)
      WHERE id = ?
    `).run(t, enc, t, enc, row.id);
    this.audit('state.pending_change->available', {
      actor, accountId: row.id, detail: newPassword ? `已设置新密码 ${detail}` : `未改密码放回可用 ${detail}`,
    });
    // 今日「已改密」计数（手动改密这条路径）
    if (newPassword) this.audit('password.changed', { actor, accountId: row.id, detail: detail || '手动' });

    // ★ 账号一旦回到「可用」，挂在这个账号上未完成的改密任务就同时作废了 ★
    //
    //   不关掉的话，worker 每次轮询都会重新认领它 ——
    //   表现就是「待改密里明明没有账号，worker 却一直去登录一个空闲账号」（实测踩过）。
    //   放在这里而不是调用方，是为了让所有回头路（跳过改密 / 手动改密 / AI 完成）都覆盖到。
    const closed = this.db.prepare(`
      UPDATE tasks SET status = 'done', finished_at = ?, message = ?,
        claimed_by = COALESCE(claimed_by, ?)
      WHERE account_id = ? AND status IN ('pending','running')
    `).run(t, newPassword ? `已设置新密码${detail}` : `未改密码放回可用${detail}`, actor, row.id).changes;
    if (closed) {
      this.audit('task.autoclose', {
        actor, accountId: row.id, detail: `账号回到可用，自动关闭 ${closed} 个未完成任务`,
      });
    }
    return this.getAccount(row.id);
  }

  /** 手动改密：直接给账号设置新密码，并回到可用 */
  setPassword(accountId, newPassword, { actor = 'local' } = {}) {
    if (!newPassword) throw Object.assign(new Error('新密码不能为空'), { status: 400 });
    const row = this.getAccountRow(accountId);
    // 若还在使用中，先把会话收掉
    const s = this._activeSession(row.id);
    if (s) this._closeSession(s, 'manual');
    const out = this._resolveToAvailable(accountId, String(newPassword), { actor, detail: '（手动）' });
    // 同一个账号上未完成的改密任务一并关闭
    this.db.prepare(`
      UPDATE tasks SET status = 'done', finished_at = ?, message = ?, claimed_by = COALESCE(claimed_by, ?)
      WHERE account_id = ? AND status IN ('pending','running')
    `).run(nowSec(), '已手动改密', actor, row.id);
    return out;
  }

  /** 跳过改密，直接把账号放回可用（保留当前密码） */
  skipChange(accountId, { actor = 'local' } = {}) {
    const row = this.getAccountRow(accountId);
    this.db.prepare(`
      UPDATE tasks SET status = 'done', finished_at = ?, message = ?
      WHERE account_id = ? AND status IN ('pending','running')
    `).run(nowSec(), '已跳过改密', row.id);
    return this._resolveToAvailable(accountId, null, { actor, detail: '（跳过）' });
  }

  /* ---------------- 使用记录 ---------------- */

  todayCount(dk = dayKey()) {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE day_key = ?').get(dk);
    return Number(row?.c || 0);
  }

  /**
   * 今日**已改密**次数 —— 需求第 5 条的原始口径：
   *   「今日使用账号次数（自动修改密码或手动修改密码并返回密码表单的次数）」
   *
   * 注意这是**另一个口径**，和 todayCount()（开始使用次数）不是一回事：
   *   · todayCount()      = 今天点了几次「开始使用」（含点了又提前结束的）
   *   · todayChanges()    = 今天真正改完几次密码（自动 + 手动，且都带着新密码）
   * 两个数界面上都给出来，避免因为口径理解不同而对不上账。
   */
  todayChanges(dk = dayKey()) {
    const [from, to] = dayRangeSec(dk);
    const c = this.db.prepare(
      "SELECT COUNT(*) AS c FROM audit WHERE action = 'password.changed' AND at >= ? AND at < ?",
    ).get(from, to);
    return Number(c?.c || 0);
  }

  listActiveSessions() {
    return this.db.prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at").all()
      .map((s) => {
        const acc = this.db.prepare('SELECT username FROM accounts WHERE id = ?').get(s.account_id);
        return { ...this._sessionView(s), username: acc?.username || '(已删除)' };
      });
  }

  todaySessions(dk = dayKey()) {
    return this.db.prepare('SELECT * FROM sessions WHERE day_key = ? ORDER BY started_at').all(dk)
      .map((s) => {
        const acc = this.db.prepare('SELECT username FROM accounts WHERE id = ?').get(s.account_id);
        return { ...this._sessionView(s), username: acc?.username || '(已删除)' };
      });
  }

  /* ---------------- 改密任务 ---------------- */

  createTask(accountId, { reason, source = 'timer', message = '' }, actor = 'system') {
    this.getAccountRow(accountId); // 校验存在
    const dup = this.db.prepare(
      "SELECT id FROM tasks WHERE account_id = ? AND status IN ('pending','running')",
    ).get(Number(accountId));
    if (dup) return this.getTask(dup.id);
    const id = randomToken(12);
    this.db.prepare(`
      INSERT INTO tasks (id, account_id, reason, status, source, created_at, message)
      VALUES (?, ?, ?, 'pending', ?, ?, ?)
    `).run(id, Number(accountId), String(reason), String(source), nowSec(), String(message || ''));
    this.audit('task.create', { actor, accountId: Number(accountId), detail: reason });
    return this.getTask(id);
  }

  getTask(id) {
    const t = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(String(id));
    if (!t) throw Object.assign(new Error('任务不存在'), { status: 404 });
    return this._taskView(t);
  }

  _taskView(t) {
    const acc = this.db.prepare('SELECT username, game, email FROM accounts WHERE id = ?').get(t.account_id);
    return {
      id: t.id,
      accountId: t.account_id,
      username: acc?.username || '(已删除)',
      game: acc?.game || '',
      email: acc?.email || '',
      reason: t.reason,
      status: t.status,
      source: t.source,
      createdAt: t.created_at,
      claimedAt: t.claimed_at,
      claimedBy: t.claimed_by,
      finishedAt: t.finished_at,
      attempts: t.attempts,
      message: t.message,
      hasNewPassword: !!t.new_password_enc,
    };
  }

  listTasks({ status = '', accountId = null, limit = 200 } = {}) {
    this._requireKey();
    let sql = 'SELECT * FROM tasks';
    const where = [];
    const vals = [];
    if (status) {
      const list = String(status).split(',').filter(Boolean);
      where.push(`status IN (${list.map(() => '?').join(',')})`);
      vals.push(...list);
    }
    if (accountId) { where.push('account_id = ?'); vals.push(Number(accountId)); }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY created_at DESC LIMIT ?';
    vals.push(Number(limit) || 200);
    return this.db.prepare(sql).all(...vals).map((t) => this._taskView(t));
  }

  claimTask(id, worker) {
    const t = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(String(id));
    if (!t) throw Object.assign(new Error('任务不存在'), { status: 404 });
    if (['done', 'canceled'].includes(t.status)) {
      throw Object.assign(new Error(`任务已是 ${t.status} 状态`), { status: 409 });
    }

    // ★ 账号不在「待改密」就不许认领 ★
    //   这是最后一道闸：即使库里还残留一个 pending 任务，
    //   也不会让 worker 去登录一个已经回到「可用」的账号。
    //   顺手把这个作废的任务关掉，免得它一直在队列里转。
    const acc = this.db.prepare('SELECT state FROM accounts WHERE id = ?').get(t.account_id);
    if (!acc || acc.state !== STATE.PENDING) {
      this.db.prepare("UPDATE tasks SET status = 'canceled', finished_at = ?, message = ? WHERE id = ?")
        .run(nowSec(), acc ? '账号已不在待改密，任务作废' : '账号已删除，任务作废', t.id);
      this.audit('task.autocancel', {
        accountId: t.account_id, detail: `${t.id}: 账号状态为 ${acc ? acc.state : '(已删除)'}，拒绝认领`,
      });
      throw Object.assign(new Error('这个账号已经不在「待改密」了，任务已作废'), { status: 409 });
    }

    this.db.prepare(
      "UPDATE tasks SET status = 'running', claimed_at = ?, claimed_by = ?, attempts = attempts + 1 WHERE id = ?",
    ).run(nowSec(), String(worker || 'unknown'), t.id);
    this.audit('task.claim', { actor: worker || 'unknown', accountId: t.account_id, detail: t.id });
    return this.getTask(t.id);
  }

  progressTask(id, message) {
    this.getTask(id);
    this.db.prepare('UPDATE tasks SET message = ? WHERE id = ?').run(String(message || ''), String(id));
    return this.getTask(id);
  }

  /**
   * AI 回传新密码 ──▶ 任务完成 + 账号回到「可用」
   */
  completeTask(id, { newPassword, message = '', worker = 'ai-agent' } = {}) {
    const t = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(String(id));
    if (!t) throw Object.assign(new Error('任务不存在'), { status: 404 });
    if (t.status === 'done') return this.getTask(t.id);

    const tNow = nowSec();
    const enc = newPassword ? this._enc(String(newPassword)) : null;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        UPDATE tasks SET status = 'done', finished_at = ?, message = ?, new_password_enc = ?,
          claimed_by = COALESCE(claimed_by, ?) WHERE id = ?
      `).run(tNow, String(message || '改密完成'), enc, String(worker), t.id);
      if (enc) {
        this.db.prepare(`
          UPDATE accounts SET password_enc = ?, password_changed_at = ?, updated_at = ?,
            state = 'available', entered_pending_at = NULL, usage_since_change_seconds = 0
          WHERE id = ?
        `).run(enc, tNow, tNow, t.account_id);
      } else {
        this.db.prepare(`
          UPDATE accounts SET updated_at = ?, state = 'available',
            entered_pending_at = NULL, usage_since_change_seconds = 0
          WHERE id = ?
        `).run(tNow, t.account_id);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.audit('task.complete', { actor: worker, accountId: t.account_id, detail: t.id });
    this.audit('state.pending_change->available', { actor: worker, accountId: t.account_id, detail: 'AI 改密完成' });
    // 今日「已改密」计数（自动改密这条路径）
    if (newPassword) this.audit('password.changed', { actor: worker, accountId: t.account_id, detail: '自动（AI/worker）' });
    return this.getTask(t.id);
  }

  failTask(id, { error = '', worker = 'ai-agent', retry = false } = {}) {
    const t = this.getTask(id);

    // ★ 重试前先看账号还在不在「待改密」★
    //   账号已经被手动放回可用（跳过改密 / 手动改密）时，这个任务其实已经作废。
    //   再放回队列，worker 就会反复去登录一个本该空闲的账号（实测踩过）。
    let doRetry = !!retry;
    let note = String(error || '失败');
    if (doRetry) {
      const acc = this.db.prepare('SELECT state FROM accounts WHERE id = ?').get(t.accountId);
      if (!acc) {
        doRetry = false;
        note = '账号已删除，任务终止';
      } else if (acc.state !== STATE.PENDING) {
        doRetry = false;
        note = `${note}（账号已不在待改密，任务终止）`;
      }
    }

    this.db.prepare(
      'UPDATE tasks SET status = ?, finished_at = ?, message = ?, claimed_by = COALESCE(claimed_by, ?) WHERE id = ?',
    ).run(doRetry ? 'pending' : 'failed', doRetry ? null : nowSec(), note,
           String(worker), String(id));
    this.audit('task.fail', { actor: worker, detail: `${id}: ${note}` });
    return this.getTask(id);
  }

  cancelTask(id, actor = 'local') {
    this.getTask(id);
    this.db.prepare("UPDATE tasks SET status = 'canceled', finished_at = ?, message = ? WHERE id = ?")
      .run(nowSec(), '已取消', String(id));
    this.audit('task.cancel', { actor, detail: String(id) });
    return this.getTask(id);
  }

  /**
   * 对账：清掉「账号已经不在待改密，但任务还挂着」的僵尸任务。
   *
   * 为什么需要它：
   *   账号回到「可用」的路径有好几条（跳过改密 / 手动改密 / AI 完成 / 直接删号），
   *   只要有一条漏了关任务，worker 就会**永远反复认领它** ——
   *   表现就是「待改密里明明没有账号，却一直去登录一个空闲账号」。
   *
   *   与其在每条路径上一个个堵，不如定时对账：
   *   服务端是任务状态的唯一权威，让不变量在定时器里自我修复。
   */
  reconcileTasks() {
    const rows = this.db.prepare(`
      SELECT t.id, t.account_id, a.state
        FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.status IN ('pending','running')
    `).all();
    const stale = rows.filter((r) => !r.state || r.state !== STATE.PENDING);
    if (!stale.length) return 0;

    const t = nowSec();
    const upd = this.db.prepare("UPDATE tasks SET status = 'canceled', finished_at = ?, message = ? WHERE id = ?");
    for (const r of stale) {
      upd.run(t, r.state ? `账号状态为 ${r.state}，任务作废` : '账号已删除，任务作废', r.id);
    }
    this.audit('task.reconcile', { actor: 'system', detail: `清理 ${stale.length} 个僵尸任务` });
    return stale.length;
  }

  /* ---------------- 调度器：唯一的计时器 ---------------- */

  /**
   * 每 5 秒扫描一次：
   *   使用中 且 倒计时归零 ──▶ 待改密 + 创建 AI 改密任务
   * 返回本次新产生的任务（用于推送 Webhook）
   */
  async sweep() {
    if (!this.key) return [];
    const created = [];
    const t = nowSec();

    const inUse = this.db.prepare("SELECT * FROM accounts WHERE state = 'in_use'").all();
    for (const acc of inUse) {
      const s = this._activeSession(acc.id);
      if (!s) {
        // 状态自愈：标记为使用中却没有会话
        this.db.prepare("UPDATE accounts SET state = 'available', updated_at = ? WHERE id = ?").run(t, acc.id);
        continue;
      }
      if (t - s.started_at >= s.planned_seconds) {
        const elapsed = this._closeSession(s, 'expired');
        created.push(this._expireToPending(acc, s, elapsed));
      }
    }
    return created;
  }

  /* ---------------- 统计 ---------------- */

  countByState(state) {
    return Number(this.db.prepare('SELECT COUNT(*) AS c FROM accounts WHERE state = ?').get(state)?.c || 0);
  }

  stats() {
    const dk = dayKey();
    const total = Number(this.db.prepare('SELECT COUNT(*) AS c FROM accounts').get()?.c || 0);
    const available = this.countByState(STATE.AVAILABLE);
    const inUse = this.countByState(STATE.IN_USE);
    const pendingChange = this.countByState(STATE.PENDING);
    const today = this.todayCount(dk);
    return {
      dayKey: dk,
      total,
      available,
      inUse,
      pendingChange,
      todaySessions: today,
      // 需求第 5 条的口径：今日自动/手动改密并拿到新密码的次数
      todayChanges: this.todayChanges(dk),
      todayUniqueAccounts: Number(
        this.db.prepare('SELECT COUNT(DISTINCT account_id) AS c FROM sessions WHERE day_key = ?').get(dk)?.c || 0,
      ),
      nextIndex: today + 1,
      openTasks: Number(
        this.db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status IN ('pending','running')").get()?.c || 0,
      ),
    };
  }

  close() {
    try { this.db.close(); } catch { /* noop */ }
  }
}

/* ------------------------------------------------------------------ */
/* 文本格式化                                                          */
/* ------------------------------------------------------------------ */

export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

/** 需求指定的输出格式 */
export function formatCredential(username, password) {
  return `账号：\n${username}\n\n密码：\n${password}`;
}

/** 解析 "6小时" / "120分钟" / "6h" / "90" 这类时长写法 */
export function parseDurationText(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(天|d|day|days)$/))) return Math.round(parseFloat(m[1]) * 1440);
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(小时|时|h|hr|hour|hours)$/))) return Math.round(parseFloat(m[1]) * 60);
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(分钟|分|min|mins|minute|minutes)$/))) return Math.round(parseFloat(m[1]));
  if ((m = s.match(/^(\d+)$/))) return parseInt(m[1], 10);
  if ((m = s.match(/(\d+(?:\.\d+)?)/))) return Math.round(parseFloat(m[1]));
  return null;
}

/**
 * 宽松解析粘贴文本
 * 支持：
 *   账号：xxx / 密码：yyy / 游戏：zzz / 使用时间：6小时 / 备注：...
 *   用户名:密码
 *   用户名----密码
 */
export function parseBulkText(text) {
  const out = [];
  const blank = () => ({ username: '', password: '', game: '', note: '', email: '', usageMinutes: null });
  let cur = null;
  const push = () => {
    if (cur && cur.username && cur.password) out.push({ ...cur });
    cur = null;
  };

  const labelRe = /^\s*(账号|帐号|用户名|user|username|login|邮箱|email|mail)\s*[:：=]\s*(.+?)\s*$/i;
  const passRe = /^\s*(密码|password|pass|pwd|passwd)\s*[:：=]\s*(.+?)\s*$/i;
  const gameRe = /^\s*(游戏|游戏名|game|title)\s*[:：=]\s*(.+?)\s*$/i;
  const timeRe = /^\s*(使用时间|时长|时间|time|duration|hours?|分钟|小时)\s*[:：=]\s*(.+?)\s*$/i;
  const noteRe = /^\s*(备注|说明|note|remark|memo)\s*[:：=]\s*(.+?)\s*$/i;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    // 空行与分隔线都视为一条记录的结束
    if (!line || /^[-=_*#]{2,}$/.test(line)) { push(); continue; }
    if (!cur) cur = blank();
    let m;

    if ((m = line.match(labelRe))) {
      if (cur.username && cur.password) push();
      if (!cur) cur = blank();
      // 上一条只有账号没密码，视为残缺，丢掉重开
      if (cur.username && !cur.password) cur = blank();
      cur.username = m[2];
      if (/邮箱|email|mail/i.test(m[1])) cur.email = m[2];
      continue;
    }
    // 注意：密码行不立即定稿，后面还可能有「游戏 / 使用时间 / 备注」
    if ((m = line.match(passRe))) { cur.password = m[2]; continue; }
    if ((m = line.match(gameRe))) { cur.game = m[2]; continue; }
    if ((m = line.match(timeRe))) {
      const v = parseDurationText(m[2]);
      if (v) cur.usageMinutes = v;
      continue;
    }
    if ((m = line.match(noteRe))) { cur.note = m[2]; continue; }

    // ★ 单行多段式：账号--密码 / 账号--密码--邮箱 / 账号--密码--邮箱--游戏名 ★
    //
    //   需求文档里批量导入写的就是这个格式：
    //       账号--密码--邮箱--游戏名
    //   旧实现只切出前两段（正则末尾的 (\S+) 会把后面几段整块吞进密码里），
    //   于是邮箱和游戏名被**静默丢掉** —— 导入完界面看着有账号，字段却是空的。
    //   第 3 段按有没有 `@` 判断是邮箱还是游戏名，第 4 段补游戏名/备注。
    if (!/[：:=]/.test(line)) {
      const parts = line.split(/\s*(?:[-—–]{2,}|[;,\t])\s*/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (parts.length >= 2 && parts.length <= 4 && parts[0].length < 80) {
        push();
        const row = { ...blank(), username: parts[0], password: parts[1] };
        const third = parts[2];
        const fourth = parts[3];
        if (third) {
          if (third.includes('@')) {
            row.email = third;
            if (fourth) row.game = fourth;
          } else {
            row.game = third;
            if (fourth) row.note = fourth;
          }
        }
        out.push(row);
        continue;
      }
    }

    // 单行两段式：用户名:密码 / 用户名----密码
    if ((m = line.match(/^(.+?)\s*[-—|,;\t]{1,4}\s*(\S+)$/)) && m[1].length < 80) {
      push();
      out.push({ ...blank(), username: m[1].trim(), password: m[2].trim() });
      continue;
    }

    if (!cur.username) { cur.username = line; continue; }
    if (!cur.password) { cur.password = line; continue; }
    // 裸行两段式：上一行账号、这一行密码之后又来了新账号
    push();
    cur = { ...blank(), username: line };
  }
  push();
  return out.filter((e) => e.username && e.password);
}
