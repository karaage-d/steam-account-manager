/**
 * 配置：从 .env 和命令行参数读取，带校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 极简 .env 解析，避免为了读配置再装一个依赖 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return true;
}

const bool = (v, dflt = false) => {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
};
const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

/**
 * 解析 --config=<路径>（或 --config <路径>），没给就用默认的 worker/.env。
 *
 * 注意：**不能**叫 --env-file —— 那是 Node 自己的内置参数，
 * 会被 Node 拦截消费掉，根本传不到脚本里（实测踩过）。
 */
function resolveEnvFile(argv) {
  const eq = argv.find((a) => a.startsWith('--config='));
  if (eq) return path.resolve(WORKER_DIR, eq.slice('--config='.length));
  const i = argv.indexOf('--config');
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) {
    return path.resolve(WORKER_DIR, argv[i + 1]);
  }
  return path.join(WORKER_DIR, '.env');
}

export function loadConfig(argv = process.argv.slice(2)) {
  // 用 --config 指定别的配置文件，这样测试就不会碰到你的 .env
  const envFile = resolveEnvFile(argv);
  const hadEnvFile = loadEnvFile(envFile);

  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const once = flags.has('--once');
  const dryRun = flags.has('--dry');
  const stopAfterLogin = flags.has('--stop-after-login');

  const outDir = path.resolve(WORKER_DIR, process.env.OUT_DIR || 'out');

  const cfg = {
    hadEnvFile,
    envFile,
    // —— 账号管理器 ——
    vaultBase: (process.env.VAULT_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    apiKey: process.env.VAULT_API_KEY || '',
    workerName: process.env.WORKER_NAME || 'local-worker',

    // —— 运行方式 ——
    once,
    dryRun,
    stopAfterLogin,
    pollSeconds: Math.max(2, num(process.env.POLL_SECONDS, 5)),
    intervalSeconds: Math.max(0, num(process.env.INTERVAL_SECONDS, 45)),

    // —— 浏览器 ——
    headless: bool(process.env.HEADLESS, false),
    browserChannel: process.env.BROWSER_CHANNEL || 'chrome',
    keepLoggedIn: bool(process.env.KEEP_LOGGED_IN, false),
    slowMoMs: Math.max(0, num(process.env.SLOW_MO_MS, 120)),

    // —— 流程 ——
    // 新密码长度固定在 10~12 位之间随机，见 password.mjs 的 PW_MIN_LEN / PW_MAX_LEN
    /** 在控制台打印每次生成的新密码（默认开）。关掉填 false */
    showPassword: bool(process.env.SHOW_PASSWORD, true),

    // —— 自动取验证码 ——
    /** 账号关联了邮箱时，登录遇到验证码就自动去取（填 false 一律手动） */
    autoCode: bool(process.env.AUTO_CODE, true),
    /** 自动取码时，让服务端在邮箱里最多轮询多少秒（邮件一般几秒到几十秒） */
    codeWaitSec: Math.max(0, num(process.env.CODE_WAIT_SEC, 90)),
    /**
     * 登录阶段最多等多久（毫秒）。
     * ★ 注意：这一段的范围是「从打开登录页到看见改密表单」★
     *   Steam 改密是一条 6 步向导（账号密码 → 验证码 → 二选一 → 验证码 → 新密码），
     *   中间两次取码每次最多等 CODE_WAIT_SEC 秒，所以这个值不能太小。
     */
    loginTimeoutMs: Math.max(60000, num(process.env.LOGIN_TIMEOUT_MS, 360000)),
    /**
     * 等登录表单渲染出来的最长时间（毫秒）。
     * Steam 客服的登录页 HTML 是空壳，表单由 React 客户端渲染 ——
     * 不等就会扑空（页面上 0 个输入框），报"找不到账号输入框"。
     */
    loginFormWaitMs: Math.max(5000, num(process.env.LOGIN_FORM_WAIT_MS, 30000)),
    /**
     * 最多自动填几次验证码。
     * Steam 有时输完第一次码后会再弹一屏要求"通过电子邮件发送账户验证码"，
     * 点了才会发第二次码 —— 所以至少要给 2 次。
     */
    maxCodeRounds: Math.max(1, num(process.env.MAX_CODE_ROUNDS, 3)),
    /** 最多自动点几次"重新发送验证码" */
    maxResends: Math.max(0, num(process.env.MAX_RESENDS, 2)),
    /**
     * ★ 第二轮取验证码前先等多久（毫秒）★
     *   实测踩过：第二次要码时 Steam 的新邮件还没到，邮箱里"最新那封"仍是第一封，
     *   于是又把同一个旧码返回去（日志里连取三次同一个码，全填了旧码）。
     *   两道保险：① 排除用过的码（服务端继续等新的）② 这里先留点时间让邮件飞过来。
     */
    secondCodeWaitMs: Math.max(0, num(process.env.SECOND_CODE_WAIT_MS, 8000)),

    // —— 输入节奏（★ 这三个值是修「密码无效」的关键，别轻易调小）——
    /**
     * 逐字符输入时每个字符之间的毫秒数。
     * 用 fill() 一次性塞值会让 React 来不及更新状态，提交上去是空值。
     * 填 0 表示退回 fill() 行为。
     */
    typeDelayMs: Math.max(0, num(process.env.TYPE_DELAY_MS, 45)),
    /** 每个密码框填完之后等待多久（毫秒）—— 给表单校验留时间 */
    fieldSettleMs: Math.max(0, num(process.env.FIELD_SETTLE_MS, 400)),
    /** 点击「更改密码」之前等待多久（毫秒）—— 给 React 状态与校验留时间 */
    submitSettleMs: Math.max(0, num(process.env.SUBMIT_SETTLE_MS, 1200)),
    /** 提交后最多花多久检测「是否真的改成功」（毫秒） */
    verifyTimeoutMs: Math.max(3000, num(process.env.VERIFY_TIMEOUT_MS, 60000)),
    /**
     * 「处理中」超过这么多分钟的任务，视为上次没收尾，启动时自动放回队列。
     * 这是为了修「worker 被杀掉后账号永远卡在待改密」那种死状态。
     */
    staleTaskMinutes: Math.max(1, num(process.env.STALE_TASK_MINUTES, 20)),

    /** 登录后若无法自动导航到改密表单，等待你手动操作的最长时间（分钟） */
    assistMinutes: Math.max(1, num(process.env.ASSIST_MINUTES, 8)),
    /** 提交新密码前暂停，让你先肉眼确认页面（首次跑建议开） */
    pauseBeforeSubmit: bool(process.env.PAUSE_BEFORE_SUBMIT, false),

    // —— 输出 ——
    outDir,
    /**
     * 出错时是否让浏览器多留一会儿，方便你看现场。
     * 注意：**不会阻塞失败上报** —— 浏览器在后台倒计时关闭，
     * 账号该回到哪个状态立刻就回，不会像以前那样卡 5 分钟。
     */
    keepBrowserOpenOnError: bool(process.env.KEEP_BROWSER_OPEN_ON_ERROR, true),
    keepBrowserOpenSecs: Math.max(0, num(process.env.KEEP_BROWSER_OPEN_SECS, 60)),
  };

  return cfg;
}

export function validateConfig(cfg) {
  const problems = [];
  if (!cfg.apiKey || cfg.apiKey.length < 10) {
    problems.push(
      '缺少 VAULT_API_KEY。\n'
      + '    打开账号管理器 → 「待改密」界面顶部的卡片 或 「设置」页 → 复制 API Key，\n'
      + `    填进 ${path.join(WORKER_DIR, '.env')}（可先复制 .env.example 改名）`,
    );
  }
  if (!/^https?:\/\//.test(cfg.vaultBase)) {
    problems.push(`VAULT_BASE 必须是 http(s) 地址，当前是「${cfg.vaultBase}」`);
  }
  if (problems.length) {
    const err = new Error(`配置有问题：\n  - ${problems.join('\n  - ')}\n`);
    err.isConfigError = true;
    throw err;
  }
  return cfg;
}

export function ensureDirs(cfg) {
  fs.mkdirSync(cfg.outDir, { recursive: true });
  fs.mkdirSync(path.join(cfg.outDir, 'screenshots'), { recursive: true });
}
