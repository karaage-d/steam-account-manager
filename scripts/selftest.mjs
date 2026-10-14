/**
 * 端到端自检：重点关注「可用 → 使用中 → 待改密 → 可用」这一条主链路
 *
 * 用法：node scripts/selftest.mjs
 * 环境变量：
 *   BASE_URL  默认 http://127.0.0.1:8787
 *   MASTER    主密码（已初始化时用于解锁）
 *   DB_PATH   vault.db 路径，提供后可精确测试倒计时归零（会把会话时间往前拨）
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const MASTER = process.env.MASTER || 'selftest-master-123';
const DB_PATH = process.env.DB_PATH || '';

let token = '';
let apiKey = '';
let passed = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  \u2713 ${name}`); }
  else { failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  \u2717 ${name}${extra ? ' — ' + extra : ''}`); }
}

async function call(method, path, body, { key = false, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  if (key && apiKey) headers['X-API-Key'] = apiKey;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

/** 把某个账号的进行中会话往前拨，模拟"倒计时已经走完" */
async function rewindSession(accountId, secondsBack = 3600) {
  if (!DB_PATH) return false;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB_PATH);
  db.prepare(`
    UPDATE sessions SET started_at = started_at - ?
    WHERE account_id = ? AND status = 'active'
  `).run(secondsBack, accountId);
  db.close();
  return true;
}

async function stateOf(id) {
  const r = await call('GET', '/api/accounts?state=available');
  if (r.data.items.some((a) => a.id === id)) return 'available';
  const u = await call('GET', '/api/accounts?state=in_use');
  if (u.data.items.some((a) => a.id === id)) return 'in_use';
  const p = await call('GET', '/api/accounts?state=pending_change');
  if (p.data.items.some((a) => a.id === id)) return 'pending_change';
  return 'unknown';
}

async function main() {
  console.log('\n── Steam 账号管理器 · 三态流转自检 ──');
  console.log(`目标: ${BASE}\n`);

  console.log('[1] 服务与解锁');
  const health = await call('GET', '/api/health', undefined, { auth: false });
  ok('健康检查可访问', health.status === 200 && health.data.ok === true);
  ok('版本为 2.x（三态状态机）', String(health.data.version || '').startsWith('2.'), health.data.version);

  if (!health.data.initialized) {
    const s = await call('POST', '/api/setup', { masterPassword: MASTER }, { auth: false });
    ok('初始化保险库', s.status === 200 && !!s.data.token, JSON.stringify(s.data));
    token = s.data.token; apiKey = s.data.apiKey;
  } else {
    const u = await call('POST', '/api/unlock', { masterPassword: MASTER }, { auth: false });
    ok('主密码解锁', u.status === 200 && !!u.data.token, JSON.stringify(u.data));
    token = u.data.token; apiKey = u.data.apiKey;
  }
  if (!token) { console.log('\n无法解锁，中止。'); process.exit(1); }

  ok('错误主密码被拒绝',
    (await call('POST', '/api/unlock', { masterPassword: 'wrong-wrong' }, { auth: false })).status === 401);
  ok('无令牌访问被拒绝', (await call('GET', '/api/accounts', undefined, { auth: false })).status === 401);

  const baseline = (await call('GET', '/api/stats')).data;
  const B = baseline.todaySessions;
  if (B) console.log(`  · 基线：今日已用 ${B} 个（断言按基线偏移）`);

  console.log('\n[2] 添加账号 → 进入「可用」');
  const stamp = Date.now();
  const mk = (n, extra = {}) => call('POST', '/api/accounts', {
    username: `selftest_${stamp}_${n}`,
    password: `Pass${n}!2024`,
    game: 'Counter-Strike 2',
    note: `自检账号 ${n}`,
    usageMinutes: 360,
    ...extra,
  });
  const a1 = await mk(1);
  ok('创建账号成功', a1.status === 200, JSON.stringify(a1.data));
  ok('新账号立刻返回且状态为 available', a1.data.account?.state === 'available', a1.data.account?.state);
  ok('返回体自带最新统计（前端可即时更新）', typeof a1.data.stats?.available === 'number');
  const id1 = a1.data.account.id;

  const a2 = await mk(2, { game: 'Dota 2', usageMinutes: 90 });
  const a3 = await mk(3, { game: 'Apex Legends', usageMinutes: 45 });
  const id2 = a2.data.account.id;
  const id3 = a3.data.account.id;

  const avail = await call('GET', '/api/accounts?state=available');
  const mine = avail.data.items.filter((x) => x.username.startsWith(`selftest_${stamp}_`));
  ok('「可用」界面能看到这 3 个账号', mine.length === 3, `got ${mine.length}`);
  ok('账号带游戏名', mine.some((x) => x.game === 'Dota 2'));
  ok('账号带自己的使用时间', mine.find((x) => x.id === id2)?.usageMinutes === 90);

  ok('重复账号被拒绝', (await mk(1)).status === 409);

  const byGame = await call('GET', '/api/accounts?state=available&q=Dota');
  ok('可按游戏名搜索', byGame.data.items.some((x) => x.game === 'Dota 2'));

  console.log('\n[3] 可用 ──▶ 使用中');
  const use1 = await call('POST', `/api/accounts/${id1}/use`);
  ok('开始使用成功', use1.status === 200, JSON.stringify(use1.data).slice(0, 120));
  ok('状态变为 in_use', use1.data.account?.state === 'in_use', use1.data.account?.state);
  ok(`今日序号为 ${B + 1}`, use1.data.todayIndex === B + 1, `got ${use1.data.todayIndex}`);
  ok('倒计时长度取自该账号自己的使用时间', use1.data.session?.plannedMinutes === 360,
    `got ${use1.data.session?.plannedMinutes}`);
  ok('凭据格式为 账号：\\n… 密码：\\n…',
    use1.data.credential?.text === `账号：\nselftest_${stamp}_1\n\n密码：\nPass1!2024`,
    JSON.stringify(use1.data.credential?.text));
  ok('提示"今天第 N 个"', new RegExp(`今天第 ${B + 1} 个`).test(use1.data.message || ''), use1.data.message);

  ok('「可用」里已经没有它了', await stateOf(id1) === 'in_use');
  const inUseList = await call('GET', '/api/accounts?state=in_use');
  ok('「使用中」界面能看到它', inUseList.data.items.some((x) => x.id === id1));
  ok('使用中列表带倒计时字段', typeof inUseList.data.items[0]?.session?.remainingSeconds === 'number');
  ok('使用中的账号不能重复开始', (await call('POST', `/api/accounts/${id1}/use`)).status === 409);

  console.log('\n[4] 使用中 ──▶ 待改密（倒计时归零，唯一计时器）');
  if (!DB_PATH) {
    console.log('  · 未提供 DB_PATH，跳过倒计时实测');
  } else {
    await rewindSession(id1, 3600 * 7);           // 360 分钟的额度，往前拨 7 小时
    const run = await call('POST', '/api/scheduler/run');
    ok('调度器执行成功', run.status === 200);
    ok('产生了改密任务', run.data.created >= 1, `created=${run.data.created}`);
    ok('账号状态变为 pending_change', await stateOf(id1) === 'pending_change', await stateOf(id1));

    const pend = await call('GET', '/api/accounts?state=pending_change');
    const card = pend.data.items.find((x) => x.id === id1);
    ok('「待改密」界面能看到它', !!card);
    ok('卡片上带出改密任务', !!card?.task, JSON.stringify(card?.task));
    ok('任务来源标记为计时器', card?.task?.source === 'timer', card?.task?.source);
    ok('任务原因说明了使用时间', /使用时间已用完/.test(card?.task?.reason || ''), card?.task?.reason);
    ok('「使用中」里已经没有它了',
      !(await call('GET', '/api/accounts?state=in_use')).data.items.some((x) => x.id === id1));
    ok('待改密的账号不能再被使用', (await call('POST', `/api/accounts/${id1}/use`)).status === 409);
    ok('重复调度不会重复建任务', (await call('POST', '/api/scheduler/run')).data.created === 0);
  }

  console.log('\n[5] AI 改密：待改密 ──▶ 可用');
  const tasksRes = await call('GET', '/api/automation/tasks?status=pending', undefined, { key: true, auth: false });
  ok('API Key 可拉取待改密任务', tasksRes.status === 200, JSON.stringify(tasksRes.data).slice(0, 100));
  ok('无凭据访问被拒绝',
    (await call('GET', '/api/automation/tasks', undefined, { auth: false })).status === 401);

  const task = tasksRes.data.tasks.find((t) => t.accountId === id1);
  if (task) {
    const ctx = await call('GET', `/api/automation/context/${task.id}`, undefined, { key: true, auth: false });
    ok('上下文含当前密码', ctx.data.target?.currentPassword === 'Pass1!2024', ctx.data.target?.currentPassword);
    ok('上下文含游戏名（给 AI 判断场景）', ctx.data.target?.game === 'Counter-Strike 2');
    ok('上下文含操作步骤', Array.isArray(ctx.data.instructions) && ctx.data.instructions.length >= 3);

    const claim = await call('POST', `/api/automation/tasks/${task.id}/claim`,
      { worker: 'selftest-ai' }, { key: true, auth: false });
    ok('任务可被 AI 认领', claim.data.task?.status === 'running' && claim.data.task?.claimedBy === 'selftest-ai');

    await call('POST', `/api/automation/tasks/${task.id}/progress`,
      { message: '等待邮箱验证码' }, { key: true, auth: false });

    const done = await call('POST', `/api/automation/tasks/${task.id}/complete`,
      { newPassword: 'AiChanged#2024', message: 'ok', worker: 'selftest-ai' }, { key: true, auth: false });
    ok('AI 回传新密码成功', done.data.task?.status === 'done');
    ok('账号自动回到 available', done.data.account?.state === 'available', done.data.account?.state);

    const reveal = await call('POST', `/api/accounts/${id1}/reveal`);
    ok('新密码已写回账号', reveal.data.password === 'AiChanged#2024', reveal.data.password);
    ok('累计使用时长已清零',
      (await call('GET', '/api/accounts?state=available')).data.items.find((x) => x.id === id1)?.usageSinceChangeSeconds === 0);
    ok('回传后立刻出现在「可用」界面', await stateOf(id1) === 'available');
  } else {
    ok('找到待办任务', false, '未找到该账号的任务');
  }

  console.log('\n[5b] 自动化接口的鉴权与说明页');
  const helpRes = await fetch(`${BASE}/api/automation`);
  const helpText = await helpRes.text();
  ok('说明页可直接用浏览器打开', helpRes.status === 200 && helpText.includes('<html'),
    String(helpRes.status));
  ok('说明页解释了浏览器为何会被拒', helpText.includes('浏览器地址栏'));
  const noKeyBody = await (await fetch(`${BASE}/api/automation/tasks`)).json();
  ok('未带 Key 的报错是可读的（不是光秃秃一句）',
    /浏览器地址栏/.test(String(noKeyBody.error)), String(noKeyBody.error));
  const wrongKey = await (await fetch(`${BASE}/api/automation/tasks`, { headers: { 'X-API-Key': 'nope' } })).json();
  ok('错误 Key 的提示指向应用内重新复制', /重新复制/.test(String(wrongKey.error)), String(wrongKey.error));
  const specPub = await fetch(`${BASE}/api/automation/spec`);
  ok('接口规格无需鉴权即可查看', specPub.status === 200, String(specPub.status));
  ok('状态码：正确 Key 可访问', (await fetch(`${BASE}/api/automation/tasks`, {
    headers: { 'X-API-Key': apiKey },
  })).status === 200);
  // ★ 说明页是公开页面，绝不能印上 API Key（否则绕过主密码就能读全部密码）
  ok('★ 说明页未泄露完整 API Key', !helpText.includes(apiKey));
  ok('★ 说明页未泄露 Key 片段', !helpText.includes(apiKey.slice(0, 8)));

  console.log('\n[6] 手动改密：待改密 ──▶ 可用');
  await call('POST', `/api/accounts/${id2}/use`);
  if (DB_PATH) {
    await rewindSession(id2, 3600 * 3);          // 90 分钟额度
    await call('POST', '/api/scheduler/run');
  }
  ok('账号 2 进入 pending_change', await stateOf(id2) === 'pending_change', await stateOf(id2));
  const manual = await call('POST', `/api/accounts/${id2}/password`, { newPassword: 'ManualNew!77' });
  ok('手动改密成功', manual.status === 200 && manual.data.account?.state === 'available',
    JSON.stringify(manual.data.account?.state));
  ok('手动设置的新密码生效', (await call('POST', `/api/accounts/${id2}/reveal`)).data.password === 'ManualNew!77');
  ok('该账号未完成的任务被一并关闭',
    (await call('GET', `/api/tasks?accountId=${id2}`)).data.tasks.every((t) => t.status !== 'pending'));

  console.log('\n[7] 跳过改密：待改密 ──> 可用');
  await call('POST', `/api/accounts/${id3}/use`);
  if (DB_PATH) {
    await rewindSession(id3, 3600 * 2);
    await call('POST', '/api/scheduler/run');
  }
  ok('账号 3 进入 pending_change', await stateOf(id3) === 'pending_change', await stateOf(id3));
  const skip = await call('POST', `/api/accounts/${id3}/skip-change`);
  ok('跳过改密后回到 available', skip.data.account?.state === 'available', skip.data.account?.state);
  ok('跳过时保留原密码', (await call('POST', `/api/accounts/${id3}/reveal`)).data.password === 'Pass3!2024');

  console.log('\n[8] 使用中 ──▶ 可用（提前结束）');
  const a4 = await mk(4, { usageMinutes: 120 });
  const id4 = a4.data.account.id;
  await call('POST', `/api/accounts/${id4}/use`);
  ok('账号 4 进入使用中', await stateOf(id4) === 'in_use');
  const cancel = await call('POST', `/api/accounts/${id4}/cancel-use`);
  ok('提前结束后回到 available', cancel.data.account?.state === 'available', cancel.data.account?.state);
  ok('提前结束不会创建改密任务',
    (await call('GET', `/api/tasks?accountId=${id4}`)).data.tasks.length === 0);

  console.log('\n[9] 统计与界面隔离');
  const board = await call('GET', '/api/board');
  ok('/api/board 一次返回三个界面',
    Array.isArray(board.data.available?.items) && Array.isArray(board.data.inUse?.items) && Array.isArray(board.data.pending?.items));
  const stats = board.data.stats;
  ok('统计三态相加等于总数',
    stats.available + stats.inUse + stats.pendingChange === stats.total,
    `${stats.available}+${stats.inUse}+${stats.pendingChange} vs ${stats.total}`);
  const allIds = new Set([
    ...board.data.available.items.map((x) => x.id),
    ...board.data.inUse.items.map((x) => x.id),
    ...board.data.pending.items.map((x) => x.id),
  ]);
  ok('同一账号不会同时出现在两个界面', allIds.size === stats.total, `${allIds.size} vs ${stats.total}`);

  const today = await call('GET', '/api/stats/today');
  ok('今日使用记录已累计', today.data.count >= B + 4, `got ${today.data.count}`);

  console.log('\n[10] 设置 / 批量 / 导出 / 清理');
  const setRes = await call('PUT', '/api/settings', { autoLockMinutes: 25, theme: 'dark' });
  ok('设置可保存', setRes.data.settings.autoLockMinutes === 25);
  ok('设置里已无统一使用时长', setRes.data.settings.sessionDefaultMinutes === undefined);
  ok('设置里已无自动改密阈值', setRes.data.settings.autoChangeAfterMinutes === undefined);

  const parse = await call('POST', '/api/accounts/parse', {
    text: '账号：bulk_a\n密码：pw_a\n游戏：CS2\n使用时间：6小时\n\n账号:bulk_b\n密码:pw_b\n',
  });
  ok('批量文本解析出 2 条', parse.data.count === 2, `got ${parse.data.count}`);
  ok('解析出游戏名', parse.data.entries[0].game === 'CS2', parse.data.entries[0].game);
  ok('解析出使用时间（6小时=360）', parse.data.entries[0].usageMinutes === 360, String(parse.data.entries[0].usageMinutes));

  const exp = await call('GET', '/api/accounts/export?format=txt&mode=readable');
  ok('可导出为 账号/密码 文本', String(exp.data.text).includes('账号：'));

  for (const id of [id1, id2, id3, id4]) await call('DELETE', `/api/accounts/${id}`);
  const after = await call('GET', `/api/board?q=selftest_${stamp}`);
  ok('自检账号已清理', after.data.available.items.length === 0 && after.data.inUse.items.length === 0);

  /* ---------------- [11] 僵尸任务 ---------------- */
  // 真机踩过：跳过改密后账号回了「可用」，但任务没关，
  // worker 每次轮询都重新认领它 —— 表现就是「待改密里没账号，却一直登录空闲账号」。
  console.log('\n[11] ★ 僵尸任务：账号回到可用后，任务不许再被认领');

  const z = await call('POST', '/api/accounts', {
    username: `zombie_${stamp}`, password: 'Abcdefg123', usageMinutes: 1,
  });
  const zid = z.data.account.id;
  await call('POST', `/api/accounts/${zid}/use`);
  // 把会话时间往前拨，让调度器把它推进「待改密」
  await rewindSession(zid);
  await call('POST', '/api/scheduler/run');

  const pend = await call('GET', '/api/accounts?state=pending_change');
  const zAcc = (pend.data.items || []).find((a) => a.id === zid);
  ok('账号已进入「待改密」', !!zAcc);
  const zTaskId = zAcc?.task?.id;
  ok('同时生成了改密任务', !!zTaskId, String(zTaskId));

  // worker 认领它（此刻账号确实在待改密，应当允许）
  const claim1 = await call('POST', `/api/automation/tasks/${zTaskId}/claim`, { worker: 'selftest' });
  ok('账号在待改密时允许认领', claim1.status === 200, JSON.stringify(claim1.data).slice(0, 100));

  // 用户点「跳过改密」→ 账号回到可用
  const skipRes = await call('POST', `/api/accounts/${zid}/skip-change`);
  ok('跳过改密后账号回到「可用」', skipRes.status === 200 && skipRes.data.account.state === 'available',
    JSON.stringify(skipRes.data.account?.state));

  const taskAfter = await call('GET', '/api/automation/tasks?status=pending');
  ok('★ 未完成任务不再出现在待办队列里',
    !(taskAfter.data.tasks || []).some((t) => t.id === zTaskId),
    JSON.stringify((taskAfter.data.tasks || []).map((t) => t.id)));

  const claim2 = await call('POST', `/api/automation/tasks/${zTaskId}/claim`, { worker: 'selftest' });
  ok('★ 账号不在待改密时，再次认领会被拒绝（409）',
    claim2.status === 409, `实际 ${claim2.status} ${JSON.stringify(claim2.data).slice(0, 80)}`);

  // 账号还在可用、任务已作废 —— 不该有人再来登录它
  const board2 = await call('GET', `/api/board?q=zombie_${stamp}`);
  ok('账号仍在「可用」界面', board2.data.available.items.length === 1);

  // 反向验证：账号在待改密时，失败重试仍然有效
  const z2 = await call('POST', '/api/accounts', {
    username: `zombie2_${stamp}`, password: 'Abcdefg123', usageMinutes: 1,
  });
  const zid2 = z2.data.account.id;
  await call('POST', `/api/accounts/${zid2}/use`);
  await rewindSession(zid2);
  await call('POST', '/api/scheduler/run');
  const pend2 = await call('GET', '/api/accounts?state=pending_change');
  const zTask2 = (pend2.data.items || []).find((a) => a.id === zid2)?.task?.id;
  await call('POST', `/api/automation/tasks/${zTask2}/claim`, { worker: 'selftest' });
  const failRetry = await call('POST', `/api/automation/tasks/${zTask2}/fail`, { error: '模拟失败', retry: true });
  ok('账号还在待改密时，失败重试仍然生效',
    failRetry.data.task.status === 'pending', failRetry.data.task?.status);

  // 收尾
  await call('POST', `/api/accounts/${zid}/skip-change`);
  await call('POST', `/api/accounts/${zid2}/skip-change`);
  await call('DELETE', `/api/accounts/${zid}`);
  await call('DELETE', `/api/accounts/${zid2}`);

  /* ---------------- [12] 需求回归 ---------------- */
  // 这一节守的是"需求文档里明写、但实现曾经漏掉"的几条：
  //   ① 批量导入格式 账号--密码--邮箱--游戏名（原来只吃前两段，邮箱/游戏名被静默丢掉）
  //   ② 邮箱的一整行格式 邮箱@icloud.com----https://取件接口
  //   ③ 今日使用次数的两个口径（开始使用 / 已改密）
  //   ④ 给外部程序用的接口：X-API-Key 就能「开始使用」并拿到 账号/密码
  console.log('\n[12] ★ 需求回归：导入四段式 / 整行邮箱 / 今日改密口径 / 对外接口');

  const bulk4 = await call('POST', '/api/accounts/parse', {
    text: `bulk4_${stamp}--Pw1--mail1@icloud.com--Counter-Strike 2\n`
      + `bulk4b_${stamp}----Pw2----mail2@icloud.com----Dota 2`,
  });
  ok('四段式解析出 2 条', bulk4.data.count === 2, `got ${bulk4.data.count}`);
  const b0 = bulk4.data.entries?.[0] || {};
  const b1 = bulk4.data.entries?.[1] || {};
  ok('★ 第 3 段当邮箱（不再被吞进密码）', b0.email === 'mail1@icloud.com', String(b0.email));
  ok('★ 第 4 段当游戏名', b0.game === 'Counter-Strike 2', String(b0.game));
  ok('★ ---- 四段式同样解析正确',
    b1.email === 'mail2@icloud.com' && b1.game === 'Dota 2',
    JSON.stringify({ email: b1.email, game: b1.game }));

  const bulkImp = await call('POST', '/api/accounts/bulk', {
    text: `bulkimp_${stamp}--Pw3--mail3@icloud.com--Apex Legends`,
  });
  ok('批量导入写库成功', bulkImp.data.created === 1, JSON.stringify(bulkImp.data).slice(0, 100));
  const impList = await call('GET', `/api/accounts?state=available&q=bulkimp_${stamp}`);
  const impAcc = impList.data.items?.[0];
  ok('★ 导入后邮箱真的落库', impAcc?.email === 'mail3@icloud.com', String(impAcc?.email));
  ok('★ 导入后游戏名真的落库', impAcc?.game === 'Apex Legends', String(impAcc?.game));

  // ② 邮箱：需求给的那一整行
  const mbLine = 'humbugs_errors4z@icloud.com----https://api.wdmail.top/m?f=html'
    + '&e=humbugs_errors4z@icloud.com:TF4Tqxn8';
  const mbA = await call('POST', '/api/mailboxes', { provider: 'http', address: mbLine });
  ok('整行粘进「邮箱地址」也能建库', mbA.status === 200, JSON.stringify(mbA.data).slice(0, 140));
  ok('★ 邮箱与取件地址被拆开（凭据已加密入库）',
    mbA.data.mailbox?.address === 'humbugs_errors4z@icloud.com'
    && mbA.data.mailbox?.credentialInUrl === true,
    JSON.stringify({ a: mbA.data.mailbox?.address, c: mbA.data.mailbox?.credentialInUrl }));
  const mbBLine = 'other_box@icloud.com----https://api.wdmail.top/m?f=html'
    + '&e=other_box@icloud.com:ab12cd';
  const mbB = await call('POST', '/api/mailboxes', { provider: 'http', apiUrl: mbBLine });
  ok('整行粘进「取件接口地址」同样能建库',
    mbB.status === 200 && mbB.data.mailbox?.address === 'other_box@icloud.com',
    JSON.stringify({ s: mbB.status, a: mbB.data.mailbox?.address }).slice(0, 140));
  const mbList = await call('GET', '/api/mailboxes');
  const mbCreated = (mbList.data.items || []).find((x) => x.id === mbA.data.mailbox?.id);
  ok('★ 邮箱列表不回传取件地址（凭据不外泄）', mbCreated && mbCreated.apiUrl === undefined,
    JSON.stringify(mbCreated || {}).slice(0, 140));

  // ③ 今日次数：两个口径
  const boardNow = await call('GET', '/api/board');
  const statsNow = boardNow.data.stats;
  ok('★ 统计里有「今日已改密」口径（需求第 5 条）',
    typeof statsNow.todayChanges === 'number', String(statsNow.todayChanges));
  const st8 = await call('GET', '/api/stats/today');
  ok('★ /api/stats/today 用本地日界（不再用 UTC）', st8.data.dayKey === statsNow.dayKey,
    `${st8.data.dayKey} vs ${statsNow.dayKey}`);
  ok('/api/stats/today 也带「已改密」次数', typeof st8.data.changes === 'number');

  const cntAcc = await call('POST', '/api/accounts', {
    username: `cnt_${stamp}`, password: 'Abcdefg123', usageMinutes: 1,
  });
  const cntId = cntAcc.data.account.id;
  await call('POST', `/api/accounts/${cntId}/use`);
  await rewindSession(cntId);
  await call('POST', '/api/scheduler/run');
  const changesBefore = (await call('GET', '/api/board')).data.stats.todayChanges;
  await call('POST', `/api/accounts/${cntId}/password`, { newPassword: 'Newpass12345' });
  const changesAfter = (await call('GET', '/api/board')).data.stats.todayChanges;
  ok('★ 手动改密一次，「今日已改密」+1', changesAfter === changesBefore + 1,
    `${changesBefore} → ${changesAfter}`);

  // ④ 对外程序（X-API-Key）：开始使用 → 直接拿到 账号/密码
  const autoAvail = await call('GET', '/api/automation/available', undefined, { key: true });
  ok('★ 对外接口能列出空闲账号',
    autoAvail.status === 200 && Array.isArray(autoAvail.data.items), `status=${autoAvail.status}`);
  ok('★ 列表里能看到刚导入的账号',
    (autoAvail.data.items || []).some((a) => a.id === impAcc?.id));

  const autoUse = await call('POST', `/api/automation/accounts/${impAcc.id}/use`, {}, { key: true });
  ok('★ 外部程序能直接「开始使用」', autoUse.status === 200,
    JSON.stringify(autoUse.data).slice(0, 140));
  ok('★ 输出就是需求里的 账号：/密码： 格式',
    autoUse.data.credentialText === `账号：\n${impAcc.username}\n\n密码：\nPw3`,
    JSON.stringify(autoUse.data.credentialText));
  const credText = await call('GET',
    `/api/automation/accounts/${impAcc.id}/credential?format=text`, undefined, { key: true });
  ok('★ 凭据接口可直接取纯文本',
    credText.status === 200 && String(credText.data.text).includes('密码：'),
    JSON.stringify(credText.data).slice(0, 120));
  const noKey = await call('GET', '/api/automation/available', undefined, { auth: false });
  ok('★ 没有 API Key 一律 401', noKey.status === 401, `status=${noKey.status}`);

  /* ---------------- [12] ★ 按游戏名领号（客服系统用） ---------------- */
  console.log('\n[12] ★ /api/automation/claim：按游戏名一步领号');

  const mkClaimAcc = async (username, game) => {
    const r = await call('POST', '/api/accounts', {
      username, password: 'ClaimPw3', game, usageMinutes: 5,
    });
    return r.data.account;
  };

  const cA = await mkClaimAcc(`claim_a_${stamp}`, 'CS2');
  const cB = await mkClaimAcc(`claim_b_${stamp}`, 'CS2');
  const cC = await mkClaimAcc(`claim_c_${stamp}`, 'Dota 2');

  // 先让 cA 被用过一次再还回来 —— 这样它的 last_used_at 比 cB 新，
  // 用来验证「最近没用的优先」是不是真的生效（应该先给从没用过的 cB）
  await call('POST', `/api/accounts/${cA.id}/use`);
  await call('POST', `/api/accounts/${cA.id}/cancel-use`);

  // ① 精确匹配
  const q1 = await call('GET', '/api/automation/claim?game=CS2', undefined, { key: true });
  ok('★ 按游戏名一步领到账号', q1.status === 200 && q1.data.ok === true,
    JSON.stringify(q1.data).slice(0, 160));
  ok('★ 直接返回了账号和密码', !!q1.data.username && !!q1.data.password);
  ok('★ text 就是需求里的「账号：/密码：」格式',
    q1.data.text === `账号：\n${q1.data.username}\n\n密码：\n${q1.data.password}`,
    JSON.stringify(q1.data.text));
  ok('★ 标明了是精确匹配', q1.data.matchedBy === 'exact', String(q1.data.matchedBy));
  ok('★ 领到的确实是 CS2（没串到 Dota 2）', q1.data.game === 'CS2', String(q1.data.game));
  ok('★★★ 最近没用的优先：先用过的那个不会被先给',
    q1.data.username === `claim_b_${stamp}`, `${q1.data.username}（期望 claim_b，因为 claim_a 用过）`);
  ok('★ 领走后账号进入「使用中」',
    (await call('GET', '/api/accounts?state=in_use')).data.items.some((a) => a.id === q1.data.accountId));

  // ② 再领一个（大小写不敏感）
  const q2 = await call('GET', '/api/automation/claim?game=cs2', undefined, { key: true });
  ok('★ 游戏名大小写不敏感，第二次领到另一个',
    q2.data.ok === true && q2.data.username !== q1.data.username,
    `${q1.data.username} → ${q2.data.username}`);

  // ③ 这一类用完了 → 必须返回「暂无账号」
  const q3 = await call('GET', '/api/automation/claim?game=CS2', undefined, { key: true });
  ok('★★★ 没有空闲的该游戏账号时，返回「暂无账号」',
    q3.data.ok === false && q3.data.message === '暂无账号', JSON.stringify(q3.data));
  ok('  并且如实说明当前还有几个空闲账号（便于排查是没货还是没匹配上）',
    typeof q3.data.availableTotal === 'number' && q3.data.availableTotal >= 1,
    `availableTotal=${q3.data.availableTotal}`);

  // ④ 包含匹配
  const q4 = await call('GET', '/api/automation/claim?game=Dota', undefined, { key: true });
  ok('★ 精确找不到时退回包含匹配（Dota → Dota 2）',
    q4.data.ok === true && q4.data.matchedBy === 'contains' && q4.data.username === `claim_c_${stamp}`,
    JSON.stringify(q4.data).slice(0, 160));

  // ⑤ 完全不存在的游戏名
  const q5 = await call('GET', '/api/automation/claim?game=不存在的游戏xyz', undefined, { key: true });
  ok('★ 游戏名完全对不上时也是「暂无账号」',
    q5.data.ok === false && q5.data.message === '暂无账号', JSON.stringify(q5.data));

  // ⑥ POST 方式 + 不传 game（任意给一个）
  const q6 = await call('POST', '/api/automation/claim', { game: 'CS2' }, { key: true });
  ok('★ POST 方式一样能用（此时 CS2 已领完，应为暂无账号）',
    q6.data.ok === false && q6.data.message === '暂无账号', JSON.stringify(q6.data));

  // ⑦ 无 API Key 必须拒绝
  const q7 = await call('GET', '/api/automation/claim?game=CS2', undefined, { auth: false });
  ok('★ 没有 API Key 一律 401', q7.status === 401, `status=${q7.status}`);

  // ⑧ 归还（测试用，不然会占用 5 分钟）
  for (const id of [q1.data.accountId, q2.data.accountId, q4.data.accountId].filter(Boolean)) {
    await call('POST', `/api/accounts/${id}/cancel-use`).catch(() => {});
  }
  for (const a of [cA, cB, cC]) await call('DELETE', `/api/accounts/${a.id}`);

  /* ---------------- [13] ★ 订单带时长（B 方案） ---------------- */
  // 订单形如「链在一起 6小时」：随便给一个该游戏的空闲账号，
  // 把它的使用时间改成订单要的时长，再开始计时。
  console.log('\n[13] ★ 订单带时长：按订单改账号的使用时间');

  const durAcc = (await call('POST', '/api/accounts', {
    username: `dur_${stamp}`, password: 'DurPw3', game: '链在一起', usageMinutes: 60,
  })).data.account;
  ok('  建了一个「链在一起 / 60 分钟」的账号', durAcc?.usageMinutes === 60, String(durAcc?.usageMinutes));

  // ① hours=6 → 应该把使用时间改成 360 分钟
  const d1 = await call('GET', '/api/automation/claim?game=链在一起&hours=6', undefined, { key: true });
  ok('★ hours=6 能领到账号', d1.data.ok === true, JSON.stringify(d1.data).slice(0, 140));
  ok('★★★ 账号的使用时间被改成 6 小时（360 分钟）',
    d1.data.usageMinutes === 360 && d1.data.appliedMinutes === 360,
    `usageMinutes=${d1.data.usageMinutes} appliedMinutes=${d1.data.appliedMinutes}`);
  ok('★ 标明这次改过时长', d1.data.durationChanged === true, String(d1.data.durationChanged));
  ok('  会话的倒计时也是 360 分钟',
    (await call('GET', '/api/accounts?state=in_use')).data.items
      .find((a) => a.id === durAcc.id)?.session?.plannedMinutes === 360,
    JSON.stringify((await call('GET', '/api/accounts?state=in_use')).data.items
      .find((a) => a.id === durAcc.id)?.session));
  ok('  message 里带上了可用分钟数', /360/.test(String(d1.data.message)), d1.data.message);

  await call('POST', `/api/accounts/${durAcc.id}/cancel-use`);

  // ② minutes=90 → 换成 90 分钟
  const d2 = await call('GET', '/api/automation/claim?game=链在一起&minutes=90', undefined, { key: true });
  ok('★ minutes=90 也认', d2.data.ok === true && d2.data.appliedMinutes === 90,
    `appliedMinutes=${d2.data.appliedMinutes}`);
  await call('POST', `/api/accounts/${durAcc.id}/cancel-use`);

  // ③ duration=6小时 这种中文写法
  const d3 = await call('GET', `/api/automation/claim?game=链在一起&duration=${encodeURIComponent('6小时')}`,
    undefined, { key: true });
  ok('★ duration=6小时 这种中文写法也认',
    d3.data.ok === true && d3.data.appliedMinutes === 360, `appliedMinutes=${d3.data.appliedMinutes}`);
  await call('POST', `/api/accounts/${durAcc.id}/cancel-use`);

  // ④ POST + hours
  const d4 = await call('POST', '/api/automation/claim', { game: '链在一起', hours: 2 }, { key: true });
  ok('★ POST 发 hours=2 也认', d4.data.ok === true && d4.data.appliedMinutes === 120,
    `appliedMinutes=${d4.data.appliedMinutes}`);
  await call('POST', `/api/accounts/${durAcc.id}/cancel-use`);

  // ⑤ ★ 不传时长时必须保持原样 ★
  //   normalizeUsageMinutes() 对空值会返回默认的 360；
  //   不判断的话，不传时长的调用会把账号悄悄改成 6 小时 —— 这是个很容易踩的坑。
  const before = (await call('GET', '/api/accounts')).data.items.find((a) => a.id === durAcc.id);
  const d5 = await call('GET', '/api/automation/claim?game=链在一起', undefined, { key: true });
  ok('★★★ 不传时长时，账号的使用时间不会被改动',
    d5.data.appliedMinutes === before.usageMinutes && d5.data.durationChanged === false,
    `原来 ${before.usageMinutes} → 现在 ${d5.data.appliedMinutes}（durationChanged=${d5.data.durationChanged}）`);
  await call('POST', `/api/accounts/${durAcc.id}/cancel-use`);

  await call('DELETE', `/api/accounts/${durAcc.id}`);

  // 这一节的收尾
  await call('POST', `/api/accounts/${impAcc.id}/cancel-use`);
  await call('DELETE', `/api/accounts/${impAcc.id}`);
  await call('DELETE', `/api/accounts/${cntId}`);
  await call('DELETE', `/api/mailboxes/${mbA.data.mailbox.id}`);
  if (mbB.data.mailbox) await call('DELETE', `/api/mailboxes/${mbB.data.mailbox.id}`);
  const leftover = await call('GET', `/api/board?q=${stamp}`);
  ok('回归用例已清理干净',
    (leftover.data.available.items.length + leftover.data.inUse.items.length
      + leftover.data.pending.items.length) === 0);

  console.log(`\n── 结果：${passed} 通过 / ${failures.length} 失败 ──`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log('  · ' + f);
  }
  console.log('');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\n自检异常：', e);
  process.exit(1);
});
