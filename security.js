/** Security helpers: login throttling, audit log, tracked sessions, CSRF origin check, TOTP. */
const { authenticator } = require('otplib');
const db = require('./db');

authenticator.options = { window: 1, step: 30, digits: 6 };

const LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES) || 15;
const MAX_USER_FAILS = Number(process.env.LOGIN_MAX_FAILS_PER_USER) || 5;
const MAX_IP_FAILS = Number(process.env.LOGIN_MAX_FAILS_PER_IP) || 10;
const WINDOW_MS = LOCK_MINUTES * 60 * 1000;

function nowText(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().replace('T', ' ').slice(0, 19);
}

function clip(s, n) {
  return s == null ? null : String(s).slice(0, n);
}

// ---------- login throttling (stored in DB so it survives restarts) ----------
function throttleKeys(username, ip) {
  return [
    { key: 'u:' + String(username || '').trim().toLowerCase().slice(0, 64), max: MAX_USER_FAILS },
    { key: 'ip:' + String(ip || ''), max: MAX_IP_FAILS },
  ];
}

/** Returns true if either the username or the IP is currently locked. */
async function isLocked(username, ip) {
  const now = nowText();
  for (const { key } of throttleKeys(username, ip)) {
    const row = await db.get('SELECT locked_until FROM login_throttle WHERE key = ?', key);
    if (row && row.locked_until && row.locked_until > now) return true;
  }
  return false;
}

async function recordFailure(username, ip) {
  const now = nowText();
  const windowStart = nowText(-WINDOW_MS);
  for (const { key, max } of throttleKeys(username, ip)) {
    const row = await db.get('SELECT * FROM login_throttle WHERE key = ?', key);
    let fails = 1;
    let first = now;
    if (row && row.first_fail_at && row.first_fail_at > windowStart) {
      fails = row.fails + 1;
      first = row.first_fail_at;
    }
    const locked = fails >= max ? nowText(WINDOW_MS) : null;
    if (row) {
      await db.run(
        'UPDATE login_throttle SET fails = ?, first_fail_at = ?, locked_until = ? WHERE key = ?',
        fails, first, locked, key
      );
    } else {
      await db.run(
        'INSERT INTO login_throttle (key, fails, first_fail_at, locked_until) VALUES (?, ?, ?, ?)',
        key, fails, first, locked
      );
    }
  }
}

async function clearFailures(username, ip) {
  for (const { key } of throttleKeys(username, ip)) {
    await db.run('DELETE FROM login_throttle WHERE key = ?', key);
  }
}

// ---------- audit ----------
async function audit(req, { username, userId = null, success, reason, detail = null }) {
  try {
    await db.run(
      'INSERT INTO login_audit (username, user_id, ip, user_agent, success, reason, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      clip(username, 64), userId, clip(req.ip, 64), clip(req.get('user-agent'), 300), success ? 1 : 0, clip(reason, 64), clip(detail, 200)
    );
  } catch (e) {
    console.error('audit failed', e.message);
  }
}

// ---------- tracked sessions ----------
async function trackSession(req, userId) {
  await db.run(
    'INSERT INTO user_sessions (sid, user_id, ip, user_agent) VALUES (?, ?, ?, ?)',
    req.sessionID, userId, clip(req.ip, 64), clip(req.get('user-agent'), 300)
  );
}

async function touchSession(sid) {
  const row = await db.get('SELECT last_seen FROM user_sessions WHERE sid = ?', sid);
  if (!row) return false;
  if (row.last_seen < nowText(-60 * 1000)) {
    await db.run('UPDATE user_sessions SET last_seen = ? WHERE sid = ?', nowText(), sid);
  }
  return true;
}

/** Destroy every session of a user (optionally except one sid). Returns count. */
async function killUserSessions(store, userId, exceptSid = null) {
  const rows = await db.all('SELECT sid FROM user_sessions WHERE user_id = ?', userId);
  let n = 0;
  for (const { sid } of rows) {
    if (sid === exceptSid) continue;
    await new Promise((r) => store.destroy(sid, () => r()));
    await db.run('DELETE FROM user_sessions WHERE sid = ?', sid);
    n++;
  }
  if (!exceptSid) await db.run('DELETE FROM ws_tokens WHERE user_id = ?', userId);
  return n;
}

// ---------- CSRF: same-origin check for state-changing requests ----------
function allowedOrigins(req) {
  const list = new Set([`${req.protocol}://${req.get('host')}`]);
  for (const o of String(process.env.ALLOWED_ORIGINS || '').split(',')) if (o.trim()) list.add(o.trim());
  return list;
}

function originOk(req) {
  const allowed = allowedOrigins(req);
  const origin = req.get('origin');
  if (origin) return allowed.has(origin);
  const ref = req.get('referer');
  if (ref) {
    try {
      return allowed.has(new URL(ref).origin);
    } catch {
      return false;
    }
  }
  return false;
}

function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!originOk(req)) return res.status(403).json({ error: '请求来源校验失败（CSRF 防护）' });
  const ct = (req.get('content-type') || '').toLowerCase();
  // Raw image upload for anonymous chat (still Origin-checked above).
  if (req.method === 'POST' && /\/chat\/images\/?$/.test(req.path) &&
      /^image\/(jpeg|png|webp|gif)\b/.test(ct)) {
    return next();
  }
  if (req.method !== 'DELETE' && !ct.startsWith('application/json')) {
    return res.status(415).json({ error: '请求格式不正确' });
  }
  next();
}

// ---------- TOTP ----------
function newTotpSecret() {
  return authenticator.generateSecret(20);
}

function totpUri(username, secret) {
  return authenticator.keyuri(username, 'CardRank 卡牌系统', secret);
}

/** Verify a code and return the time-step it matched (for replay protection), or null. */
function verifyTotp(secret, code, lastStep) {
  const token = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(token) || !secret) return null;
  const delta = authenticator.checkDelta(token, secret);
  if (delta == null) return null;
  const step = Math.floor(Date.now() / 30000) + delta;
  if (lastStep != null && step <= Number(lastStep)) return null; // already used
  return step;
}

// Display name: trimmed, control/invisible/bidi chars removed, 1..20 characters (code points).
const NAME_STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
function normalizeDisplayName(v) {
  if (typeof v !== 'string') return { ok: false, error: '姓名不能为空' };
  const name = v.replace(NAME_STRIP_RE, '').replace(/\s+/g, ' ').trim();
  const len = [...name].length;
  if (len < 1) return { ok: false, error: '姓名不能为空' };
  if (len > 20) return { ok: false, error: '姓名最多 20 个字' };
  return { ok: true, name };
}

module.exports = {
  normalizeDisplayName,
  nowText, clip,
  isLocked, recordFailure, clearFailures, LOCK_MINUTES,
  audit,
  trackSession, touchSession, killUserSessions,
  csrfGuard, originOk, allowedOrigins,
  newTotpSecret, totpUri, verifyTotp,
};
