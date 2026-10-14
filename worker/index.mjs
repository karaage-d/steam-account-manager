/**
 * 改密 worker 主循环
 *
 *   拉取待改密任务 → 认领 → 取上下文 → 生成新密码
 *   → （浏览器改密）→ 回传新密码 → 账号自动回到「可用」
 *
 * 用法：
 *   node index.mjs                    常驻轮询
 *   node index.mjs --once             处理完当前待办就退出
 *   node index.mjs --once --dry       只验证接口链路，不开浏览器、不改任何密码
 *   node index.mjs --stop-after-login 只走到登录，把浏览器留给你看
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, validateConfig, ensureDirs, WORKER_DIR } from './config.mjs';
import { createApi } from './api.mjs';
import { generatePassword, PW_MIN_LEN, PW_MAX_LEN } from './password.mjs';
import { changeSteamPassword } from './steam.mjs';

const T = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const log = (...a) => console.log(...a);
const hr = () => log(T.dim + '─'.repeat(62) + T.reset);
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const stamp = () => `[${ts()}]`;

let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(0);
  stopping = true;
  log('');
  log(T.yellow + '  收到 Ctrl+C，当前任务跑完就退出…（再按一次强制退出）' + T.reset);
});

/* ------------------------------------------------------------------ */
/* 新密码恢复文件                                                      */
/*                                                                     */
/* 存在的唯一理由：万一「Steam 上已经改成功了、但回传失败」，           */
/* 没有它你就永远不知道新密码是什么，那个账号等于锁死。                 */
/* 回传成功后立刻删除。                                                */
/* ------------------------------------------------------------------ */

function writeRecovery(cfg, task, newPassword, note) {
  const file = path.join(cfg.outDir, `recovery-${task.id}.json`);
  fs.writeFileSync(file, JSON.stringify({
    taskId: task.id,
    username: task.username,
    game: task.game || '',
    email: task.email || '',
    newPassword,
    note,
    at: new Date().toISOString(),
  }, null, 2), 'utf8');
  return file;
}

function removeRecovery(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* 已经不在了 */ }
}

/* ------------------------------------------------------------------ */

function banner(cfg) {
  hr();
  log('  🔐  Steam 改密 Worker');
  hr();
  log(`  账号管理器   ${cfg.vaultBase}`);
  log(`  配置文件     ${cfg.hadEnvFile ? path.relative(WORKER_DIR, cfg.envFile) : `${path.relative(WORKER_DIR, cfg.envFile)}（不存在，用默认值）`}`);
  log(`  Worker 名称  ${cfg.workerName}`);
  log(`  浏览器       ${cfg.browserChannel} · ${cfg.headless ? '无界面' : '有界面'}`);
  log(`  任务间隔     ${cfg.intervalSeconds} 秒`);
  log(`  新密码       ${PW_MIN_LEN}~${PW_MAX_LEN} 位随机，字母开头，仅数字与大小写字母`);
  log(`  验证码       ${cfg.autoCode ? `自动取（邮箱里最多等 ${cfg.codeWaitSec} 秒，取不到转手动）` : '手动输入（AUTO_CODE=false）'}`);
  log(`  输出目录     ${cfg.outDir}`);
  if (cfg.dryRun) log(T.cyan + '  模式         DRY-RUN —— 只验证接口，不开浏览器、不改任何密码' + T.reset);
  if (cfg.once) log(T.cyan + '  模式         跑完当前待办就退出' + T.reset);
  hr();
}

async function processTask(api, cfg, task) {
  const t0 = Date.now();
  log('');
  log(`${T.bold}▶ ${task.username}${T.reset}${task.game ? `  ${T.dim}(${task.game})${T.reset}` : ''}`);
  log(`  ${T.dim}任务 ${task.id} · 触发原因：${task.reason}${T.reset}`);

  const newPassword = generatePassword();
  let recoveryFile = null;
  let submitted = false;

  await api.claim(task.id);
  const ctx = await api.context(task.id);
  const target = ctx.target;

  if (cfg.dryRun) {
    log(`  ${T.dim}[dry-run] 跳过浏览器；不修改任何密码${T.reset}`);
    // 不传 newPassword：服务端只把账号放回「可用」，不动密码字段
    const r = await api.complete(task.id, undefined, cfg.workerName, 'dry-run 接口链路验证');
    log(`  ${T.green}✓${T.reset} 接口链路通了 —— 账号已回到「${r.account?.stateLabel || '可用'}」，密码未改动`);
    return { ok: true, dry: true, ms: Date.now() - t0, username: task.username };
  }

  // ★ 先把这次生成的新密码打出来 ★
  //   放在动手之前：万一后面任何一步出问题，你已经在控制台看到了它。
  if (cfg.showPassword) {
    log('');
    log(`  ${T.cyan}${T.bold}🔑  本次新密码：  ${newPassword}${T.reset}   ${T.dim}(${newPassword.length} 位，字母开头)${T.reset}`);
    log(`  ${T.dim}    ↑ 请留意这一行；改密成功后它会写进账号库，失败时它就是你的兜底${T.reset}`);
    log('');
  }

  try {
    // ★ 给这一步的每一行都加时间戳 + 相对耗时 ★
    //   排查"卡住了"时，光看内容分辨不出是"正在等"还是"死了"；
    //   有了时间轴，一眼就能看出最后一条之后过了多久、卡在哪一步。
    const flowT0 = Date.now();
    const flowLog = (...a) => {
      const el = ((Date.now() - flowT0) / 1000).toFixed(1).padStart(5);
      log(`${T.dim}${stamp()} +${el}s${T.reset}`, ...a);
    };

    await changeSteamPassword({
      api,
      accountId: target.accountId ?? null,
      username: target.username,
      currentPassword: target.currentPassword,
      email: target.email,
      newPassword,
      cfg,
      log: flowLog,
      onProgress: (m) => api.progress(task.id, m).catch(() => {}),
      onBeforeSubmit: async () => {
        submitted = true;
        recoveryFile = writeRecovery(cfg, task, newPassword, '已提交给 Steam，等待结果');
        log(`  ${T.yellow}⚠ 新密码已落盘：${path.basename(recoveryFile)}${T.reset}`);
        log(`  ${T.dim}  回传成功后自动删除；若回传失败，这就是你找回账号的唯一凭据${T.reset}`);
      },
    });

    const done = await api.complete(task.id, newPassword, cfg.workerName, 'worker 自动改密完成');
    removeRecovery(recoveryFile);
    recoveryFile = null;

    // ★ 确认同步真的发生了 ★
    const state = done?.account?.state;
    const label = done?.account?.stateLabel || state || '?';
    if (state === 'available') {
      log(`  ${T.green}✓ 已自动同步${T.reset} 账号回到「${label}」  ${T.dim}(${Math.round((Date.now() - t0) / 1000)} 秒)${T.reset}`);
    } else {
      log(`  ${T.yellow}⚠ 已完成改密并上报，但账号当前状态是「${label}」—— 去界面看一眼${T.reset}`);
    }
    if (cfg.showPassword) {
      log(`  ${T.green}  新密码 ${T.bold}${newPassword}${T.reset}${T.green} 已生效，并写入账号库${T.reset}`);
    }
    return { ok: true, ms: Date.now() - t0, username: task.username, password: newPassword, state };
  } catch (err) {
    // 密码还没提交给 Steam 就失败了 → 恢复文件没意义，删掉
    if (!submitted) {
      removeRecovery(recoveryFile);
      recoveryFile = null;
    }

    log(`  ${T.red}✗ 失败：${err.message.split('\n')[0]}${T.reset}`);
    if (err.screenshot) log(`  ${T.dim}截图：${err.screenshot}${T.reset}`);

    if (submitted) {
      log('');
      log(`  ${T.yellow}${T.bold}注意：新密码已经提交给 Steam 了，但后续步骤出错。${T.reset}`);
      log(`  ${T.yellow}有可能其实已经改成功 —— 请去 Steam 试一次这个密码：${T.reset}`);
      log(`  ${T.bold}${newPassword}${T.reset}`);
      if (recoveryFile) log(`  ${T.yellow}已保存在：${recoveryFile}${T.reset}`);
      log(`  ${T.yellow}确认之后，要么在界面上手动改密，要么删掉这个文件重新跑。${T.reset}`);
    }

    await api.fail(task.id, err.message.split('\n')[0].slice(0, 300), cfg.workerName, true).catch((e) => {
      log(`  ${T.dim}（上报失败时又出错：${e.message.split('\n')[0]}）${T.reset}`);
    });
    return {
      ok: false,
      ms: Date.now() - t0,
      error: err.message,
      username: task.username,
      // 只有真的提交给 Steam 之后，这个密码才有可能是"已生效"的
      password: submitted ? newPassword : null,
      submitted,
    };
  }
}

/**
 * 收拾上次没收尾的任务。
 *
 * 场景：worker 跑到一半被 Ctrl+C 掉、或电脑重启 —— 任务会一直停在「处理中」，
 * 而轮询只拉「待处理」，于是那个账号就永远卡在「待改密」里没人管。
 * 启动时把超过 STALE_TASK_MINUTES 的「处理中」任务放回队列即可自愈。
 */
async function requeueStaleTasks(api, cfg) {
  try {
    const { tasks } = await api.listRunning();
    const now = Math.floor(Date.now() / 1000);
    const limit = cfg.staleTaskMinutes * 60;
    const stale = (tasks || []).filter((t) => t.claimedAt && now - t.claimedAt > limit);
    if (!stale.length) return 0;

    log(`${stamp()} 发现 ${stale.length} 个上次没收尾的任务，自动放回队列`);
    for (const t of stale) {
      const mins = Math.round((now - t.claimedAt) / 60);
      try {
        await api.fail(t.id, `上次运行未收尾（已过 ${mins} 分钟），自动放回重试`, cfg.workerName, true);
        log(`  ${T.dim}· ${t.username} 已放回待处理${T.reset}`);
      } catch (e) {
        log(`  ${T.dim}· ${t.username} 放回失败：${e.message.split('\n')[0]}${T.reset}`);
      }
    }
    return stale.length;
  } catch (e) {
    log(`${stamp()} ${T.dim}清理遗留任务失败：${e.message.split('\n')[0]}${T.reset}`);
    return 0;
  }
}

async function main() {
  const cfg = validateConfig(loadConfig());
  ensureDirs(cfg);
  banner(cfg);

  const api = createApi({ base: cfg.vaultBase, key: cfg.apiKey, workerName: cfg.workerName });

  // 先探一下服务在不在
  try {
    const h = await api.health();
    if (!h.initialized) {
      log(T.yellow + '  账号管理器还没创建保险库，先去界面里设置主密码。' + T.reset);
      return;
    }
  } catch (e) {
    log(T.red + '  连不上账号管理器：' + e.message + T.reset);
    process.exitCode = 1;
    return;
  }

  // 自愈：把上次没收尾、卡在「处理中」的任务放回队列
  if (!cfg.dryRun) await requeueStaleTasks(api, cfg);

  let okCount = 0;
  let failCount = 0;
  /** 记录每个账号这次生成的新密码，收尾时汇总一遍 */
  const results = [];

  for (;;) {
    let tasks = [];
    try {
      const r = await api.listPending();
      tasks = r.tasks || [];
    } catch (e) {
      log(`${stamp()} ${T.red}拉取任务失败：${e.message.split('\n')[0]}${T.reset}`);
      if (e.status === 401) {
        log(T.yellow + '  —— 保险库可能处于锁定状态，请在界面里解锁后重试。' + T.reset);
        process.exitCode = 1;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.max(5, cfg.pollSeconds) * 1000));
      if (stopping) return;
      continue;
    }

    if (tasks.length) {
      log(`${stamp()} 发现 ${tasks.length} 个待改密任务`);

      for (const task of tasks) {
        if (stopping) break;
        let result;
        try {
          result = await processTask(api, cfg, task);
        } catch (e) {
          log(`${stamp()} ${T.red}任务异常：${e.message.split('\n')[0]}${T.reset}`);
          result = { ok: false };
        }
        if (result.ok) okCount += 1; else failCount += 1;
        results.push(result);

        // 账号之间留间隔，避免触发 Steam 风控
        if (cfg.intervalSeconds > 0 && !stopping) {
          log(`${T.dim}  等待 ${cfg.intervalSeconds} 秒再处理下一个（降低风控风险）${T.reset}`);
          const until = Date.now() + cfg.intervalSeconds * 1000;
          while (Date.now() < until && !stopping) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }

      if (cfg.once) break;
    } else if (cfg.once) {
      log(`${stamp()} 没有待改密任务`);
      break;
    } else {
      process.stdout.write(`\r${stamp()} ${T.dim}没有待改密任务，${cfg.pollSeconds} 秒后重试…${T.reset}   `);
    }

    if (stopping) break;
    await new Promise((r) => setTimeout(r, Math.max(2, cfg.pollSeconds) * 1000));
  }

  hr();
  log(`  本次运行：成功 ${okCount} 个，失败 ${failCount} 个`);

  // 收尾汇总：把这次生成过的所有新密码列一遍，方便你复制留档
  if (cfg.showPassword) {
    const withPw = results.filter((r) => r.password);
    if (withPw.length) {
      log('');
      log(`  ${T.bold}本次生成的新密码汇总${T.reset}`);
      for (const r of withPw) {
        if (r.ok) {
          log(`   ${T.green}✓${T.reset} ${r.username}   ${T.bold}${r.password}${T.reset}   ${T.dim}已写入账号库${T.reset}`);
        } else {
          log(`   ${T.red}✗${T.reset} ${r.username}   ${T.bold}${r.password}${T.reset}   ${T.yellow}流程失败，请去 Steam 确认是否已生效${T.reset}`);
        }
      }
    }
  }
  hr();
}

main().catch((e) => {
  console.error('');
  console.error(T.red + ' 启动失败：' + T.reset);
  console.error(' ' + String(e.message).split('\n').join('\n '));
  console.error('');
  if (e.isConfigError) {
    console.error(T.dim + `  提示：配置文件在 ${path.join(WORKER_DIR, '.env')}` + T.reset);
    console.error(T.dim + '  可以先把 .env.example 复制成 .env 再改。' + T.reset);
    console.error('');
  }
  process.exitCode = 1;
});
