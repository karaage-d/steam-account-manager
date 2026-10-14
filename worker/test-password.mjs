/**
 * 密码规则测试
 *
 *   node test-password.mjs
 *
 * 规则：
 *   · 长度 10 ~ 12 位
 *   · 只含数字、大写字母、小写字母（不含任何其他字符）
 *   · ★ 必须以字母开头 ★（Steam 的硬要求）
 *   · 三类字符各自至少出现一次
 */
import { generatePassword, checkPassword, PW_MIN_LEN, PW_MAX_LEN } from './password.mjs';

const N = 5000;

/**
 * 卡方分布上尾分位数的临界值（默认 p = 0.001）。
 *
 * ★ 为什么要专门写这个函数 ★
 *   原先这里是一条拍脑袋的线性公式 `df * 2.1 + 3`：
 *     df=25 → 55.5（真值 52.6，偏松，抓不出问题）
 *     df=9  → 21.9（真值 27.9，**偏紧**）
 *   于是「数字」那一类（df=9）会时不时冤枉失败 —— 明明随机源是均匀的，
 *   却被自己的阈值判成不均匀。一个用来"防止统计测试抖动"的测试，
 *   阈值本身就抖，等于没修。
 *
 *   df ≤ 30 查表；df > 30 用 Wilson–Hilferty 近似
 *   （z = 3.0902 对应 p=0.001）。
 */
const CHI2_001 = [
  10.828, 13.816, 16.266, 18.467, 20.515, 22.458, 24.322, 26.125, 27.877,
  29.588, 31.264, 32.909, 34.528, 36.123, 37.697, 39.252, 40.790, 42.312,
  43.820, 45.315, 46.797, 48.268, 49.728, 51.179, 52.620, 54.052, 55.476,
  56.892, 58.301, 59.703,
];

function chi2Critical(df, p = 0.001) {
  if (Number.isInteger(df) && df >= 1 && df <= 30) return CHI2_001[df - 1];
  // Wilson–Hilferty：把卡方近似成正态
  const z = p === 0.001 ? 3.0902 : 2.3263; // 0.001 / 0.01
  const t = 1 - 2 / (9 * df) + z * Math.sqrt(2 / (9 * df));
  return df * t ** 3;
}

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fails.push(name + (extra ? ` — ${extra}` : '')); console.log(`  \u2717 ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log(`\n── 密码规则测试（${N} 个样本）──\n`);

const samples = Array.from({ length: N }, () => generatePassword());

/* ---------- 长度 ---------- */
console.log('[1] 长度');
const lens = samples.map((s) => s.length);
const minLen = Math.min(...lens);
const maxLen = Math.max(...lens);
ok(`最短 >= ${PW_MIN_LEN}（实际 ${minLen}）`, minLen >= PW_MIN_LEN);
ok(`最长 <= ${PW_MAX_LEN}（实际 ${maxLen}）`, maxLen <= PW_MAX_LEN);

const hist = {};
for (const l of lens) hist[l] = (hist[l] || 0) + 1;
console.log(`    长度分布: ${Object.entries(hist).sort().map(([k, v]) => `${k}位×${v}`).join('  ')}`);
for (let l = PW_MIN_LEN; l <= PW_MAX_LEN; l += 1) {
  ok(`${l} 位出现过（${hist[l] || 0} 个）`, (hist[l] || 0) > 0);
}
ok('没有超出范围的取值',
  Object.keys(hist).every((k) => Number(k) >= PW_MIN_LEN && Number(k) <= PW_MAX_LEN),
  Object.keys(hist).join(','));

/* ---------- 字符集 ---------- */
console.log('\n[2] 字符集');
const bad = samples.filter((s) => !/^[0-9A-Za-z]+$/.test(s));
ok('全部只含数字与大小写字母', bad.length === 0,
  bad.length ? `有 ${bad.length} 个违规，例如 ${JSON.stringify(bad[0])}` : '');

const allChars = new Set(samples.join(''));
const illegal = [...allChars].filter((c) => !/[0-9A-Za-z]/.test(c));
ok('没有出现过非法字符', illegal.length === 0, illegal.join(''));
console.log(`    实际用到的字符种类: ${allChars.size} 种（应为 62 种）`);
ok('字符覆盖完整（62 种）', allChars.size === 62, `got ${allChars.size}`);

/* ---------- 复杂度 ---------- */
console.log('\n[3] 复杂度');
const noUpper = samples.filter((s) => !/[A-Z]/.test(s));
const noLower = samples.filter((s) => !/[a-z]/.test(s));
const noDigit = samples.filter((s) => !/[0-9]/.test(s));
ok('每个都至少含一个大写字母', noUpper.length === 0, `${noUpper.length} 个不合格`);
ok('每个都至少含一个小写字母', noLower.length === 0, `${noLower.length} 个不合格`);
ok('每个都至少含一个数字', noDigit.length === 0, `${noDigit.length} 个不合格`);

/* ---------- 首位必须是字母（Steam 的硬要求）---------- */
console.log('\n[3b] 首位必须是字母');
const firstDigit = samples.filter((s) => /^[0-9]/.test(s));
const firstUpper = samples.filter((s) => /^[A-Z]/.test(s)).length;
const firstLower = samples.filter((s) => /^[a-z]/.test(s)).length;
console.log(`    首位：大写 ${firstUpper} 个，小写 ${firstLower} 个，数字 ${firstDigit.length} 个`);
ok('★ 没有一个以数字开头', firstDigit.length === 0,
  firstDigit.length ? `例如 ${JSON.stringify(firstDigit[0])}` : '');
ok('首位是字母的比例 = 100%', firstUpper + firstLower === N);
ok('首位大写与小写都出现过（不是固定某一类）', firstUpper > 0 && firstLower > 0);

/* ---------- checkPassword 能识别违规 ---------- */
console.log('\n[3c] checkPassword 校验函数');
const cases = [
  ['05Z7NoQ3DuER7OHG', false, '数字开头 —— 就是当初被 Steam 拒掉的那个密码'],
  ['abcDEF1234', true, '10 位，字母开头，三类齐全'],
  ['Abcdefg123', true, '10 位，大写字母开头'],
  ['abcdefghij', false, '没有大写字母和数字'],
  ['ABCdef1234!', false, '含非法字符 !'],
  ['Ab1', false, '长度不足'],
  ['Abcdefghijklmnop1', false, '长度超限'],
];
for (const [pw, wantOk, desc] of cases) {
  const problems = checkPassword(pw);
  const isOk = problems.length === 0;
  ok(`  ${desc} → ${wantOk ? '合格' : '不合格'}`, isOk === wantOk,
    isOk ? '' : `实际判定：${problems.join('；')}`);
}

/* ---------- 随机性 ---------- */
console.log('\n[4] 随机性');
ok('没有重复样本', new Set(samples).size === N, `去重后 ${new Set(samples).size} / ${N}`);

/**
 * 类内均匀性 —— 这才是真正检验「随机源与抽样是否公平」的指标。
 * 同一类里的字符（26 个大写字母、26 个小写字母、10 个数字）应当等概率出现。
 */
const freq = {};
for (const s of samples) for (const c of s) freq[c] = (freq[c] || 0) + 1;

const classes = {
  大写字母: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  小写字母: 'abcdefghijklmnopqrstuvwxyz',
  数字: '0123456789',
};
for (const [name, chars] of Object.entries(classes)) {
  const counts = [...chars].map((c) => freq[c] || 0);
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  const dev = Math.max(...counts.map((c) => Math.abs(c - avg) / avg));

  // ★ 用卡方检验，别用固定阈值 ★
  //   之前写死 `dev < 0.12`：偏差本身随样本量波动，偶尔就蹦到 12.5% 冤枉失败
  //   （实测连续跑时遇到过）。卡方统计量与量纲无关，只要样本量够，
  //   分布的临界值是确定的 —— 这才是判断"均匀不均匀"的正确工具。
  const chi2 = counts.reduce((acc, c) => acc + ((c - avg) ** 2) / avg, 0);
  const df = counts.length - 1;
  // p=0.001 的上尾临界值：真实的"随机源均匀，却误判为不均匀"的概率是 0.1%
  const chi2Limit = chi2Critical(df);
  console.log(`    ${name}：共 ${counts.length} 种，均值 ${Math.round(avg)} 次，`
    + `最大偏差 ${(dev * 100).toFixed(1)}%，χ²=${chi2.toFixed(1)}（df=${df}，上限 ${chi2Limit.toFixed(1)}）`);
  ok(`类内均匀：${name}`, chi2 < chi2Limit, `χ²=${chi2.toFixed(1)} 超过上限 ${chi2Limit.toFixed(1)}`);
}

/**
 * 类间比例 —— 注意：这里**不能**要求等于 1/62。
 * 「三类至少各出现一次」这个约束本身就会抬高数字的占比：
 * 数字只有 10 个字符、字母有 52 个，一旦要求「必须出现数字」，
 * 数字被抽中的条件期望就必然上升。这是数学上不可避免的，
 * 不是 bug —— 所以只给一个理论区间，用来抓「明显跑偏」的严重问题。
 */
const totalChars = samples.reduce((a, s) => a + s.length, 0);
const digitShare = Object.entries(freq)
  .filter(([c]) => /[0-9]/.test(c))
  .reduce((a, [, v]) => a + v, 0) / totalChars;
console.log(`    数字占比 ${(digitShare * 100).toFixed(2)}%（均匀分布应为 16.13%，受约束抬升至约 19%）`);
ok('数字占比在合理区间（10% ~ 25%）', digitShare > 0.10 && digitShare < 0.25,
  `${(digitShare * 100).toFixed(2)}%`);
ok('全部 62 种字符都出现过', Object.keys(freq).length === 62, `${Object.keys(freq).length} 种`);

/* ---------- 样例 ---------- */
console.log('\n[5] 样例（前 10 个）');
for (const s of samples.slice(0, 10)) console.log(`    ${s}   (${s.length} 位)`);

console.log(`\n── 结果：${pass} 通过 / ${fails.length} 失败 ──`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log('  · ' + f);
}
console.log('');
process.exit(fails.length ? 1 : 0);
