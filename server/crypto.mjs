/**
 * 密码学层
 * - 主密码 -> scrypt 派生 32 字节密钥（不落盘）
 * - 账号密码 -> AES-256-GCM 认证加密后入库
 * - 主密码校验 -> 用派生密钥解密哨兵字符串，解不开即密码错误
 */
import crypto from 'node:crypto';

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;
const MAXMEM = 256 * 1024 * 1024;

const SENTINEL = 'steam-vault::sentinel::v1';

export function newSalt() {
  return crypto.randomBytes(16).toString('base64');
}

export function deriveKey(masterPassword, saltB64) {
  const salt = Buffer.from(saltB64, 'base64');
  return crypto.scryptSync(Buffer.from(masterPassword, 'utf8'), salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAXMEM,
  });
}

/** 输出 v1.<iv>.<tag>.<ciphertext>，全部 base64 */
export function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join('.');
}

export function decrypt(key, payload) {
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('密文格式不受支持');
  const [, ivB64, tagB64, bodyB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(bodyB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function makeVerifier(key) {
  return encrypt(key, SENTINEL);
}

export function checkVerifier(key, verifier) {
  try {
    return decrypt(key, verifier) === SENTINEL;
  } catch {
    return false;
  }
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

export function hmacHex(secret, body) {
  return crypto.createHmac('sha256', String(secret)).update(body).digest('hex');
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
