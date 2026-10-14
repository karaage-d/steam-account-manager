/**
 * 新密码生成 —— 和账号管理器主程序完全相同的规则：
 *
 *   长度  10 ~ 12 位（每次随机）
 *   字符  只有数字、大写字母、小写字母 —— 不含任何其他字符
 *   保证  三类字符各自至少出现一次
 */
import crypto from 'node:crypto';

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGIT = '0123456789';
const ALL = UPPER + LOWER + DIGIT;

/** 密码长度范围：10 ~ 12 位，每次生成时随机取一个 */
export const PW_MIN_LEN = 10;
export const PW_MAX_LEN = 12;

function randInt(max) {
  return crypto.randomInt(max);
}

/** 在 10 ~ 12 之间随机取一个长度 */
export function randomPasswordLength() {
  return PW_MIN_LEN + randInt(PW_MAX_LEN - PW_MIN_LEN + 1);
}

/**
 * 生成新密码。不接收长度参数 —— 长度由 PW_MIN_LEN / PW_MAX_LEN 决定。
 *
 *   1. 长度 10 ~ 12 位（每次随机）
 *   2. 只含数字、大写字母、小写字母
 *   3. 以字母开头
 *   4. 三类字符各自至少出现一次
 *
 * 关于第 3 条「以字母开头」：
 *   按用户说明加上（据说是 Steam 的要求）。但**这一点尚未被独立验证** ——
 *   手头能拿到的失败样本（含以字母开头、12 位、完全合规的密码）都能用
 *   「输入太快导致 React state 没跟上」解释，所以无法据此证明 Steam 真的
 *   要求字母开头。保留它是因为字母开头的密码在任何规则下都合法，属于双保险。
 *   真正被证实的关键因素是输入节奏，见 steam.mjs 里的 TYPE_DELAY_MS 等参数。
 *
 * ★ 用「拒绝采样」而不是「先塞三类再补齐」★
 *   后者会让数字被系统性过度抽中：数字只有 10 个字符、字母有 52 个，
 *   先固定塞一个数字，等于把数字的期望出现次数抬高近一倍（实测偏差 34%）。
 *   拒绝采样先完全均匀地生成，不满足规则就整个重来，
 *   得到的是「满足约束的集合上」的均匀分布。
 *   n>=10 时单次成功率约 70%，平均试 1.4 次，性能无影响。
 */
export function generatePassword() {
  const n = randomPasswordLength();
  const pick = (pool) => pool[randInt(pool.length)];

  for (let attempt = 0; attempt < 500; attempt += 1) {
    let out = '';
    let hasUpper = false;
    let hasLower = false;
    let hasDigit = false;

    for (let i = 0; i < n; i += 1) {
      const c = pick(ALL);
      out += c;
      if (isUpper(c)) hasUpper = true;
      else if (isLower(c)) hasLower = true;
      else hasDigit = true;
    }

    if (!isLetter(out[0])) continue;          // 以字母开头（见上方说明）
    if (hasUpper && hasLower && hasDigit) return out;
  }
  // 连续 500 次都失败的概率约 0.3^500，实际不可能发生
  throw new Error('生成密码失败：多次尝试都没能满足规则');
}

/* ------------------------------------------------------------------ */

const isUpper = (c) => c >= 'A' && c <= 'Z';
const isLower = (c) => c >= 'a' && c <= 'z';
const isLetter = (c) => isUpper(c) || isLower(c);

/** 只允许数字与大小写字母 —— 与主程序 generatePassword 的约束一致 */
export function isDigitsAndLetters(text) {
  return /^[0-9A-Za-z]+$/.test(String(text || ''));
}

/** 按规则要求以字母开头（见 generatePassword 上方关于这一条的说明） */
export function startsWithLetter(text) {
  return isLetter(String(text || '')[0]);
}

/** 一次性校验全部规则，返回问题列表（空数组表示合格） */
export function checkPassword(text) {
  const s = String(text || '');
  const problems = [];
  if (s.length < PW_MIN_LEN || s.length > PW_MAX_LEN) {
    problems.push(`长度必须是 ${PW_MIN_LEN}~${PW_MAX_LEN} 位，当前 ${s.length} 位`);
  }
  if (!isDigitsAndLetters(s)) problems.push('只能包含数字与大小写字母');
  if (!startsWithLetter(s)) problems.push('必须以字母开头');
  if (!/[A-Z]/.test(s)) problems.push('至少包含一个大写字母');
  if (!/[a-z]/.test(s)) problems.push('至少包含一个小写字母');
  if (!/[0-9]/.test(s)) problems.push('至少包含一个数字');
  return problems;
}
