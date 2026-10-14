/**
 * 账号管理器的自动化接口封装。
 * 对应 server/index.mjs 里 /api/automation/* 那组端点。
 */

export class VaultError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

export function createApi({ base, key, workerName = 'local-worker' }) {
  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new VaultError(
        `连不上账号管理器（${base}）。确认服务在运行：双击「启动.bat」，或跑 npm start。\n    原始错误：${e.message}`,
        0,
      );
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    if (!res.ok) {
      if (res.status === 401) {
        // 401 有两种完全不同的原因，别让用户去反复复制 Key
        const serverMsg = String(data?.error || '');
        if (/锁定|解锁/.test(serverMsg)) {
          throw new VaultError(
            `账号管理器当前处于锁定状态：${serverMsg}\n`
            + '    打开界面用主密码解锁即可，worker 会自动重试。',
            401,
            data,
          );
        }
        throw new VaultError(
          'API Key 被拒绝。\n'
          + '    去账号管理器 →「待改密」界面顶部的卡片 或「设置」页 → 复制最新的 API Key，\n'
          + '    更新 .env 里的 VAULT_API_KEY。\n'
          + `    服务端原话：${serverMsg || '(未提供)'}`,
          401,
          data,
        );
      }
      throw new VaultError(data?.error || `请求失败（${res.status}）`, res.status, data);
    }
    return data;
  }

  return {
    base,
    health: () => fetch(base + '/api/health').then((r) => r.json()),

    /** 拉取待改密任务 */
    listPending: () => call('GET', '/api/automation/tasks?status=pending'),

    /** 拉取「处理中」的任务 —— 用来找出上次没收尾就退出的 */
    listRunning: () => call('GET', '/api/automation/tasks?status=running'),

    /** 取改密上下文：账号、当前密码、邮箱、游戏名 */
    context: (id) => call('GET', `/api/automation/context/${encodeURIComponent(id)}`),

    /** 声明接管，避免多个 worker 重复处理同一个任务 */
    claim: (id, worker = workerName) => call('POST', `/api/automation/tasks/${encodeURIComponent(id)}/claim`, { worker }),

    /** 上报进度（会显示在「待改密」的卡片上） */
    progress: (id, message) => call('POST', `/api/automation/tasks/${encodeURIComponent(id)}/progress`, { message }),

    /** 回传新密码 —— 服务端会把账号从「待改密」放回「可用」 */
    complete: (id, newPassword, worker = workerName, message = '') =>
      call('POST', `/api/automation/tasks/${encodeURIComponent(id)}/complete`, { newPassword, worker, message }),

    /** 上报失败；retry=true 会把任务放回待处理队列 */
    fail: (id, error, worker = workerName, retry = true) =>
      call('POST', `/api/automation/tasks/${encodeURIComponent(id)}/fail`, { error, worker, retry }),

    /**
     * 让服务端从该账号关联的邮箱里取验证码。
     *
     * wait>0 时服务端会自己轮询（间隔递增），直到取到或超时。
     * 所以这里只要一次请求就够了，不用在 worker 里写重试循环。
     *
     * ★ exclude：已经用过的码 ★
     *   第二次要验证码时，Steam 的新邮件往往还没到，邮箱里"最新的一封"还是第一封 ——
     *   服务端会把同一个旧码又返回回来。把用过的码传过去，它会主动跳过，
     *   并继续轮询等新的那封（实测踩过：同一个码被连取三次）。
     */
    fetchCode: (accountId, { since, wait = 0, exclude = [] } = {}) => {
      const qs = new URLSearchParams();
      if (since) qs.set('since', String(since));
      qs.set('wait', String(wait));
      const list = (Array.isArray(exclude) ? exclude : [exclude]).filter(Boolean);
      if (list.length) qs.set('exclude', list.join(','));
      return call('GET', `/api/automation/accounts/${encodeURIComponent(accountId)}/code?${qs}`);
    },
  };
}
