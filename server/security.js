const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// 憑證加密金鑰：正式環境（含 Vercel）務必以環境變數 APP_SECRET 提供
function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) throw new Error('必須設定環境變數 APP_SECRET');
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '.dev-secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8');
}
const KEY = crypto.createHash('sha256').update(loadSecret()).digest();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, salt, h] = String(stored).split('$');
  if (!salt || !h) return false;
  const calc = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
  if (!blob) return null;
  const [iv, tag, enc] = blob.split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
const mask = s => (s ? `••••••${String(s).slice(-4)}` : '');
const tokenHash = t => crypto.createHash('sha256').update(t).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
const tempPassword = () => crypto.randomBytes(6).toString('base64url');
function passwordProblem(pw) {
  if (!pw || pw.length < 10) return '密碼至少 10 碼';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return '密碼需同時包含英文字母與數字';
  return null;
}

module.exports = { hashPassword, verifyPassword, encrypt, decrypt, mask, tokenHash, newToken, tempPassword, passwordProblem };
