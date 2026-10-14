/**
 * 体检：一条命令查清 worker 为什么不工作。
 *
 *   node doctor.mjs
 *
 * 依次检查：配置 → 服务是否在跑 → 保险库是否解锁 → API Key 是否有效 → 有没有待办任务
 */
import { loadConfig, validateConfig } from './config.mjs';

const G = '\x1b[32m'; const R = '\x1b[31m'; const Y = '\x1b[33m';
const D = '\x1b[2m'; const B = '\x1b[1m'; const X = '\x1b[0m';

const ok = (m) => console.log(`  ${G}✓${X} ${m}`);
const bad = (m) => console.log(`  ${R}✗${X} ${m}`);
const warn = (m) => console.log(`  ${Y}!${X} ${m}`);
const info = (m) => console.log(`    ${D}${m}${X}`);

let failed = 0;

console.log(`\n${B}改密 Worker 体检${X}`);
console.log('─'.repeat(58));

/* ---------- 1. 配置 ---------- */
console.log(`\n${B}[1] 配置文件${X}`);
let cfg;
try {
  cfg = validateConfig(loadConfig([]));
} catch (e) {
  bad('配置有问题');
  console.log(String(e.message).split('\n').map((l) => '    ' + l).join('\n'));
  process.exit(1);
}

if (!cfg.hadEnvFile) {
  warn(`没有找到 ${cfg.envFile}`);
  info('把 .env.example 复制成 .env 再改');
} else {
  ok(`已加载 ${cfg.envFile}`);
}
info(`VAULT_BASE   = ${cfg.vaultBase}`);
if (/在|粘|贴|paste|your.?key|xxxx/i.test(cfg.apiKey)) {
  bad('VAULT_API_KEY 还是 .env.example 里的占位符，没换成真正的 Key');
  info('去账号管理器 →「待改密」页顶部卡片 或「设置」页 → 复制 API Key');
  info('然后打开 worker/.env，把 VAULT_API_KEY= 后面整段替换掉');
  failed += 1;
} else {
  ok(`VAULT_API_KEY = ${cfg.apiKey.slice(0, 6)}…（共 ${cfg.apiKey.length} 字符）`);
}

/* ---------- 2. 服务在不在 ---------- */
console.log(`\n${B}[2] 账号管理器服务${X}`);
let health = null;
try {
  const res = await fetch(`${cfg.vaultBase}/api/health`);
  health = await res.json();
  ok(`服务在运行（版本 ${health.version}）`);
} catch (e) {
  bad(`连不上 ${cfg.vaultBase}`);
  info(`原始错误：${e.cause?.code || e.message}`);
  info('');
  info('worker 是账号管理器的客户端，服务不开它什么也做不了。');
  info('先双击项目根目录里的「启动.bat」，等它打印出界面地址，再跑 worker。');
  failed += 1;
  process.exit(1);
}

/* ---------- 3. 保险库状态 ---------- */
console.log(`\n${B}[3] 保险库状态${X}`);
if (!health.initialized) {
  bad('还没创建保险库');
  info('打开界面，设置一个主密码');
  failed += 1;
} else if (!health.unlocked) {
  bad('保险库当前是锁定状态');
  info('打开界面，用主密码解锁。worker 需要解锁状态才能读写账号。');
  failed += 1;
} else {
  ok('已初始化且已解锁');
}

/* ---------- 4. API Key 能不能用 ---------- */
console.log(`\n${B}[4] API Key 权限${X}`);
if (failed) {
  warn('前面还有问题，先解决再来这一步');
  console.log('');
  process.exitCode = 1;
} else {
  try {
    const res = await fetch(`${cfg.vaultBase}/api/automation/tasks?status=pending`, {
      headers: { 'X-API-Key': cfg.apiKey },
    });
    const data = await res.json().catch(() => null);
    if (res.ok) {
      ok('API Key 有效');
      const n = data?.count ?? 0;
      if (n > 0) {
        ok(`当前有 ${n} 个待改密任务`);
        for (const t of data.tasks.slice(0, 10)) {
          info(`· ${t.username}${t.game ? `（${t.game}）` : ''} — ${t.reason}`);
        }
        console.log('');
        console.log(`  ${B}下一步：${X} node index.mjs --once --dry   ${D}（先验证接口，不改密码）${X}`);
      } else {
        info('当前没有待改密任务');
        info('想让账号进入待改密：把它的「使用时间」设成 1 分钟，点开始使用，等 1 分钟。');
      }
    } else {
      bad(`被拒绝（HTTP ${res.status}）：${data?.error || ''}`);
      info('去「待改密」页顶部卡片或「设置」页重新复制 API Key。');
      info('如果你重置过 API Key，旧的会立刻失效。');
      failed += 1;
    }
  } catch (e) {
    bad(`请求出错：${e.message}`);
    failed += 1;
  }

  console.log('');
  console.log('─'.repeat(58));
  if (failed) {
    console.log(`  ${R}还有 ${failed} 处需要处理${X}`);
  } else {
    console.log(`  ${G}一切正常，可以跑 worker 了${X}`);
    console.log(`  ${D}建议顺序：--dry  →  --stop-after-login  →  --once${X}`);
  }
  console.log('');
  process.exitCode = failed ? 1 : 0;
}
