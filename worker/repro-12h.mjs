/**
 * 复现：订单 12 小时 → 账号 usage_minutes 改了，但会话倒计时对不对？
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8971;
const DATA = path.join(os.tmpdir(), 'dur-repro');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const srv = spawn('D:\\node.exe', [path.join(ROOT, 'server', 'index.mjs')], {
  env: { ...process.env, PORT: String(PORT), VAULT_DATA_DIR: DATA },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 3000));

const BASE = `http://127.0.0.1:${PORT}`;
const j = async (m, p, b, tok, key) => {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = `Bearer ${tok}`;
  if (key) h['X-API-Key'] = key;
  const r = await fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: { raw: t } }; }
};

const s = await j('POST', '/api/setup', { masterPassword: 'repro-123456' });
const tok = s.data.token; const key = s.data.apiKey;

const a = await j('POST', '/api/accounts',
  { username: 'repro_12h', password: 'Repro123', game: '链在一起', usageMinutes: 1 }, tok);
const id = a.data.account.id;
console.log(`建账号: #${id}  usage_minutes=${a.data.account.usageMinutes}`);

// 领 12 小时
const c = await j('GET', `/api/automation/claim?game=${encodeURIComponent('链在一起')}&hours=12`, null, null, key);
console.log('\n=== 领号返回 ===');
console.log(JSON.stringify({
  ok: c.data.ok, appliedMinutes: c.data.appliedMinutes, usageMinutes: c.data.usageMinutes,
  durationChanged: c.data.durationChanged, expiresAt: c.data.expiresAt,
  remainingSeconds: c.data.remainingSeconds, message: c.data.message,
}, null, 2));

const after = await j('GET', `/api/accounts?state=in_use`, null, tok);
const acc = (after.data.items || []).find((x) => x.id === id);
console.log('\n=== 账号现在 ===');
console.log(`  usage_minutes = ${acc?.usageMinutes}`);
console.log(`  会话 plannedMinutes = ${acc?.session?.plannedMinutes}`);
console.log(`  会话 plannedSeconds = ${acc?.session?.plannedSeconds}`);
console.log(`  剩余秒数 = ${acc?.session?.remainingSeconds}`);

console.log('\n=== 结论 ===');
const expect = 720;
if (acc?.usageMinutes === expect && acc?.session?.plannedMinutes === expect) {
  console.log(`  ✓ 完全正确：账号和会话都是 ${expect} 分钟`);
} else {
  console.log(`  ✗ 不对！期望 ${expect} 分钟`);
  console.log(`     账号 usage_minutes = ${acc?.usageMinutes}`);
  console.log(`     会话 plannedMinutes = ${acc?.session?.plannedMinutes}`);
}

srv.kill();
await new Promise((r) => setTimeout(r, 700));
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
