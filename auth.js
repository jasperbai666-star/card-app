const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');
const { touchSession } = require('./security');

const SALT_ROUNDS = 12;

function hashPassword(password) {
  return bcrypt.hashSync(password, SALT_ROUNDS);
}

// Used to spend the same bcrypt time when the username does not exist (avoids user enumeration by timing)
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), SALT_ROUNDS);

function verifyPassword(password, hash) {
  return bcrypt.compareSync(String(password), hash || DUMMY_HASH);
}

/** Returns an error message, or null if the password is acceptable. */
function checkPasswordPolicy(pw) {
  const s = String(pw || '');
  if (s.length < 8) return '密码至少 8 位';
  if (Buffer.byteLength(s, 'utf8') > 72) return '密码过长（最多 72 字节）';
  return null;
}

function generateInviteCode() {
  // 8 uppercase alphanumeric, exclude ambiguous chars
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

function generatePassword(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = crypto.randomBytes(length);
  let pw = '';
  for (let i = 0; i < length; i++) pw += alphabet[bytes[i] % alphabet.length];
  return pw;
}

function findUserByUsername(username) {
  return db.get('SELECT * FROM users WHERE username = ?', username);
}

function findUserById(id) {
  return db.get('SELECT * FROM users WHERE id = ?', id);
}

async function requireAuth(req, res, next) {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: '请先登录' });
    }
    const tracked = await touchSession(req.sessionID);
    const user = tracked ? await findUserById(req.session.userId) : null;
    if (!user || user.disabled) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: '账号不可用，请重新登录' });
    }
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: '需要管理员权限' });
    }
    next();
  });
}

function requireMember(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'member' && req.user.role !== 'admin') {
      return res.status(403).json({ error: '权限不足' });
    }
    next();
  });
}

module.exports = {
  hashPassword,
  verifyPassword,
  checkPasswordPolicy,
  SALT_ROUNDS,
  generateInviteCode,
  generatePassword,
  findUserByUsername,
  findUserById,
  requireAuth,
  requireAdmin,
  requireMember,
};
