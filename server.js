const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const QRCode = require('qrcode');
const sec = require('./security');

const db = require('./db');
const { NOW } = db;
const {
  hashPassword,
  verifyPassword,
  checkPasswordPolicy,
  generateInviteCode,
  findUserByUsername,
  findUserById,
  requireAuth,
  requireAdmin,
} = require('./auth');
const { RANKS, SUITS, validateCard, publicCard, levelOf } = require('./cards');
const { ensureAdmin } = require('./scripts/setup-admin.js');

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SECURE_COOKIE =
  process.env.FORCE_HTTPS === '1' || !!process.env.RENDER; // Render terminates TLS in front of us

// Behind Render / Nginx reverse proxy
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

// Real client IP. Render sits behind Cloudflare + an internal load balancer, so req.ip (from
// X-Forwarded-For hop counting) is an internal 10.x address. Cloudflare overwrites
// CF-Connecting-IP / True-Client-IP with the real visitor IP, so those can't be spoofed there.
const CLIENT_IP_HEADERS = String(
  process.env.CLIENT_IP_HEADER ?? (process.env.RENDER ? 'cf-connecting-ip,true-client-ip' : '')
).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;
app.use((req, _res, next) => {
  for (const h of CLIENT_IP_HEADERS) {
    const v = String(req.headers[h] || '').trim();
    if (v && IP_RE.test(v)) {
      Object.defineProperty(req, 'ip', { value: v, configurable: true });
      break;
    }
  }
  next();
});

/** Wrap async route handlers so errors reach Express. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // inline style attributes used by the UI
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'", (req) => `wss://${req.headers.host}`, (req) => `ws://${req.headers.host}`],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: SECURE_COOKIE ? [] : null,
      },
    },
    hsts: SECURE_COOKIE ? { maxAge: 15552000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'same-origin' },
  })
);
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());

let store;
if (db.isPg) {
  const PgSession = require('connect-pg-simple')(session);
  store = new PgSession({ pool: db.pool, tableName: 'session', createTableIfMissing: false, pruneSessionInterval: 3600 });
} else {
  store = new session.MemoryStore(); // local fallback only; sessions reset on restart
}
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7-day idle timeout (rolling)
app.use(
  session({
    name: 'card.sid',
    secret: SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: SECURE_COOKIE,
      maxAge: SESSION_MAX_AGE,
    },
  })
);

app.use('/api', sec.csrfGuard);

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- WebSocket ----------
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 4096,
  verifyClient: ({ req }) => {
    const origin = req.headers.origin;
    if (!origin) return !SECURE_COOKIE; // non-browser clients only allowed in local dev
    const proto = SECURE_COOKIE || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const allowed = new Set([`${proto}://${req.headers.host}`]);
    for (const o of String(process.env.ALLOWED_ORIGINS || '').split(',')) if (o.trim()) allowed.add(o.trim());
    return allowed.has(origin);
  },
});
/** @type {Map<number, Set<import('ws').WebSocket>>} */
const socketsByUser = new Map();

function attachUser(ws, userId) {
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId).add(ws);
  ws._userId = userId;
}

function detachUser(ws) {
  const uid = ws._userId;
  if (uid == null) return;
  const set = socketsByUser.get(uid);
  if (set) {
    set.delete(ws);
    if (set.size === 0) socketsByUser.delete(uid);
  }
}

function closeUserSockets(userId, reason) {
  const set = socketsByUser.get(userId);
  if (!set) return;
  for (const ws of set) {
    try {
      ws.send(JSON.stringify({ type: 'force_logout', reason }));
      ws.close(4001, 'logout');
    } catch (_) {}
  }
  socketsByUser.delete(userId);
}

async function forceLogoutUser(userId, reason, exceptSid = null) {
  const n = await sec.killUserSessions(store, userId, exceptSid);
  if (!exceptSid) closeUserSockets(userId, reason);
  return n;
}

function sendToUser(userId, payload) {
  const set = socketsByUser.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(data);
  }
}

async function broadcastAdmins(payload) {
  try {
    const admins = await db.all("SELECT id FROM users WHERE role = 'admin' AND disabled = 0");
    for (const a of admins) sendToUser(a.id, payload);
  } catch (e) {
    console.error('broadcastAdmins', e.message);
  }
}

function nowText(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().replace('T', ' ').slice(0, 19);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
      if (msg.type === 'auth' && msg.token) {
        const row = await db.get(
          'SELECT * FROM ws_tokens WHERE token = ? AND expires_at > ?',
          String(msg.token),
          nowText()
        );
        if (row) {
          const user = await findUserById(row.user_id);
          if (user && !user.disabled) {
            attachUser(ws, user.id);
            ws.send(JSON.stringify({ type: 'auth_ok', role: user.role }));
            return;
          }
        }
        ws.send(JSON.stringify({ type: 'auth_fail' }));
      }
    } catch (_) {
      /* ignore */
    }
  });
  ws.on('close', () => detachUser(ws));
});

setInterval(() => {
  db.run(`DELETE FROM ws_tokens WHERE expires_at <= ?`, nowText()).catch(() => {});
  db.run(`DELETE FROM user_sessions WHERE last_seen <= ?`, nowText(-SESSION_MAX_AGE)).catch(() => {});
  db.run(`DELETE FROM login_throttle WHERE (locked_until IS NULL OR locked_until <= ?) AND first_fail_at <= ?`, nowText(), nowText(-60 * 60 * 1000)).catch(() => {});
  db.run(`DELETE FROM login_audit WHERE created_at <= ?`, nowText(-90 * 86400000)).catch(() => {});
}, 60_000);

// Keep-alive pings (also keeps Render's proxy from closing idle sockets)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25_000);

async function issueWsToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.run(
    'INSERT INTO ws_tokens (token, user_id, expires_at) VALUES (?, ?, ?)',
    token,
    userId,
    nowText(60 * 60 * 1000)
  );
  return token;
}

// ---------- Helpers ----------
function sanitizeUser(u, { includeCard = true } = {}) {
  if (!u) return null;
  const base = {
    id: u.id,
    username: u.username,
    role: u.role,
    displayName: u.display_name || u.username,
    disabled: !!u.disabled,
    totpEnabled: !!u.totp_enabled,
    createdAt: u.created_at,
  };
  if (includeCard) {
    base.card = publicCard(u.card_rank, u.card_suit);
  }
  return base;
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
}

/** Rotate the session id and bind it to the user (prevents session fixation). */
async function establishSession(req, user) {
  await regenerateSession(req);
  req.session.userId = user.id;
  req.session.role = user.role;
  await saveSession(req);
  await sec.trackSession(req, user.id);
}

const limitJson = (msg) => (req, res) => res.status(429).json({ error: msg });
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: limitJson('注册尝试过于频繁，请 15 分钟后再试'),
});
const suggestionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => 'u' + (req.session?.userId || 'anon'),
  handler: limitJson('提交太频繁，请稍后再试（每 10 分钟最多 10 条）'),
});
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => 'u' + (req.session?.userId || 'anon'),
  handler: limitJson('操作太频繁，请稍后再试'),
});

function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
}

function formatSuggestion(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    type: row.type,
    content: row.content,
    status: row.status,
    adminReply: row.admin_reply,
    createdAt: row.created_at,
    handledAt: row.handled_at,
  };
}

const SUGG_SELECT = `SELECT s.*, u.username, u.display_name FROM suggestions s JOIN users u ON u.id = s.user_id`;

// ---------- Auth routes ----------
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

app.post('/api/ws-token', requireAuth, ah(async (req, res) => {
  res.json({ token: await issueWsToken(req.user.id) });
}));

const GENERIC_LOGIN_ERR = '账号或密码错误';
const LOCKED_ERR = `尝试次数过多，请 ${sec.LOCK_MINUTES} 分钟后再试`;

app.post('/api/login', ah(async (req, res) => {
  const { username, password, totp } = req.body || {};
  const uname = String(username || '').trim().slice(0, 64);
  if (!uname || !password) return res.status(400).json({ error: '请输入账号和密码' });
  if (await sec.isLocked(uname, req.ip)) {
    await sec.audit(req, { username: uname, success: false, reason: 'locked' });
    return res.status(429).json({ error: LOCKED_ERR });
  }
  const user = await findUserByUsername(uname);
  const pwOk = verifyPassword(String(password).slice(0, 200), user?.password_hash); // always runs bcrypt
  if (!user || !pwOk) {
    await sec.recordFailure(uname, req.ip);
    await sec.audit(req, { username: uname, userId: user?.id, success: false, reason: user ? 'bad_password' : 'no_user' });
    return res.status(401).json({ error: GENERIC_LOGIN_ERR });
  }
  if (user.totp_enabled) {
    if (!totp) {
      return res.status(401).json({ error: '请输入两步验证码', code: 'TOTP_REQUIRED' });
    }
    const step = sec.verifyTotp(user.totp_secret, totp, user.totp_last_step);
    if (step == null) {
      await sec.recordFailure(uname, req.ip);
      await sec.audit(req, { username: uname, userId: user.id, success: false, reason: 'bad_totp' });
      return res.status(401).json({ error: '两步验证码错误', code: 'TOTP_REQUIRED' });
    }
    await db.run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id);
  }
  if (user.disabled) {
    await sec.audit(req, { username: uname, userId: user.id, success: false, reason: 'disabled' });
    return res.status(403).json({ error: '账号已被停用' });
  }
  await sec.clearFailures(uname, req.ip);
  await establishSession(req, user);
  await sec.audit(req, { username: uname, userId: user.id, success: true, reason: user.totp_enabled ? 'ok_2fa' : 'ok' });
  res.json({ user: sanitizeUser(user), wsToken: await issueWsToken(user.id) });
}));

app.post('/api/logout', (req, res) => {
  const sid = req.sessionID;
  db.run('DELETE FROM user_sessions WHERE sid = ?', sid).catch(() => {});
  req.session.destroy(() => {
    res.clearCookie('card.sid');
    res.json({ ok: true });
  });
});

app.post('/api/register', registerLimiter, ah(async (req, res) => {
  const { username, password, inviteCode, displayName } = req.body || {};
  if (!username || !password || !inviteCode) {
    return res.status(400).json({ error: '请填写用户名、密码和邀请码' });
  }
  const uname = String(username).trim();
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,24}$/.test(uname)) {
    return res.status(400).json({ error: '用户名需 2–24 位字母/数字/下划线/中文' });
  }
  const pwErr = checkPasswordPolicy(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const code = String(inviteCode).trim().toUpperCase().slice(0, 16);

  const invite = await db.get('SELECT * FROM invite_codes WHERE code = ?', code);
  if (!invite || invite.revoked || invite.used_by || (invite.expires_at && invite.expires_at <= sec.nowText())) {
    return res.status(400).json({ error: '邀请码无效、已使用或已过期' });
  }

  if (await findUserByUsername(uname)) {
    return res.status(400).json({ error: '用户名已存在' });
  }

  const pwHash = hashPassword(String(password));
  let userId;
  try {
    userId = await db.transaction(async (tx) => {
      const info = await tx.run(
        `INSERT INTO users (username, password_hash, role, display_name, invite_code_used)
         VALUES (?, ?, 'member', ?, ?)`,
        uname,
        pwHash,
        displayName ? String(displayName).trim().slice(0, 24) || uname : uname,
        code
      );
      const upd = await tx.run(
        `UPDATE invite_codes SET used_by = ?, used_at = ${NOW} WHERE id = ? AND used_by IS NULL AND revoked = 0`,
        info.lastInsertRowid,
        invite.id
      );
      if (upd.changes !== 1) throw new Error('邀请码竞争失败');
      return info.lastInsertRowid;
    });
  } catch (e) {
    return res.status(400).json({ error: '注册失败：邀请码可能刚被使用' });
  }

  const user = await findUserById(userId);
  await establishSession(req, user);
  await sec.audit(req, { username: uname, userId: user.id, success: true, reason: 'register' });
  broadcastAdmins({ type: 'member_joined', user: sanitizeUser(user) });
  res.json({ user: sanitizeUser(user), wsToken: await issueWsToken(user.id) });
}));

app.get('/api/meta/cards', (_req, res) => {
  res.json({ ranks: RANKS, suits: SUITS });
});

// ---------- Member: own card only ----------
app.get('/api/my/card', requireAuth, (req, res) => {
  res.json({ card: publicCard(req.user.card_rank, req.user.card_suit) });
});

app.post('/api/my/suggestions', requireAuth, suggestionLimiter, ah(async (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(400).json({ error: '管理员无需提交建议' });
  }
  const { type, content } = req.body || {};
  if (!['suggestion', 'request'].includes(type)) {
    return res.status(400).json({ error: '类型须为 suggestion 或 request' });
  }
  const text = String(content || '').trim();
  if (!text || text.length > 2000) {
    return res.status(400).json({ error: '内容不能为空且不超过 2000 字' });
  }
  const info = await db.run(
    `INSERT INTO suggestions (user_id, type, content) VALUES (?, ?, ?)`,
    req.user.id,
    type,
    text
  );
  const row = await db.get(`${SUGG_SELECT} WHERE s.id = ?`, info.lastInsertRowid);
  broadcastAdmins({ type: 'new_suggestion', suggestion: formatSuggestion(row) });
  res.json({ suggestion: formatSuggestion(row) });
}));

app.get('/api/my/suggestions', requireAuth, ah(async (req, res) => {
  const rows = await db.all(
    `SELECT * FROM suggestions WHERE user_id = ? ORDER BY id DESC LIMIT 100`,
    req.user.id
  );
  res.json({ suggestions: rows.map(formatSuggestion) });
}));

// ---------- Account security (any logged-in user) ----------
app.post('/api/me/password', requireAuth, sensitiveLimiter, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(String(currentPassword || '').slice(0, 200), req.user.password_hash)) {
    await sec.audit(req, { username: req.user.username, userId: req.user.id, success: false, reason: 'pw_change_bad_current' });
    return res.status(400).json({ error: '当前密码不正确' });
  }
  const err = checkPasswordPolicy(newPassword);
  if (err) return res.status(400).json({ error: err });
  if (String(newPassword) === String(currentPassword)) return res.status(400).json({ error: '新密码不能与当前密码相同' });
  await db.run(
    `UPDATE users SET password_hash = ?, password_changed_at = ${NOW} WHERE id = ?`,
    hashPassword(String(newPassword)), req.user.id
  );
  const n = await forceLogoutUser(req.user.id, '密码已修改，请重新登录', req.sessionID); // keep this device
  await sec.audit(req, { username: req.user.username, userId: req.user.id, success: true, reason: 'pw_changed' });
  res.json({ ok: true, otherSessionsClosed: n });
}));

app.post('/api/me/2fa/setup', requireAuth, sensitiveLimiter, ah(async (req, res) => {
  if (req.user.totp_enabled) return res.status(400).json({ error: '两步验证已开启' });
  const secret = sec.newTotpSecret();
  await db.run('UPDATE users SET totp_pending_secret = ? WHERE id = ?', secret, req.user.id);
  const uri = sec.totpUri(req.user.username, secret);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
  res.json({ secret, otpauthUrl: uri, qr });
}));

app.post('/api/me/2fa/enable', requireAuth, sensitiveLimiter, ah(async (req, res) => {
  const u = await findUserById(req.user.id);
  if (u.totp_enabled) return res.status(400).json({ error: '两步验证已开启' });
  const step = sec.verifyTotp(u.totp_pending_secret, req.body?.code, null);
  if (step == null) return res.status(400).json({ error: '验证码错误，请确认手机时间准确后重试' });
  await db.run(
    'UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled = 1, totp_last_step = ? WHERE id = ?',
    step, u.id
  );
  await sec.audit(req, { username: u.username, userId: u.id, success: true, reason: '2fa_enabled' });
  res.json({ ok: true });
}));

app.post('/api/me/2fa/disable', requireAuth, sensitiveLimiter, ah(async (req, res) => {
  const u = await findUserById(req.user.id);
  if (!u.totp_enabled) return res.status(400).json({ error: '两步验证未开启' });
  if (!verifyPassword(String(req.body?.password || '').slice(0, 200), u.password_hash)) {
    return res.status(400).json({ error: '密码不正确' });
  }
  if (sec.verifyTotp(u.totp_secret, req.body?.code, u.totp_last_step) == null) {
    return res.status(400).json({ error: '两步验证码错误' });
  }
  await db.run('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?', u.id);
  await sec.audit(req, { username: u.username, userId: u.id, success: true, reason: '2fa_disabled' });
  res.json({ ok: true });
}));

app.get('/api/me/sessions', requireAuth, ah(async (req, res) => {
  const rows = await db.all('SELECT * FROM user_sessions WHERE user_id = ? ORDER BY last_seen DESC', req.user.id);
  res.json({ sessions: rows.map((r) => ({ ...fmtSession(r), current: r.sid === req.sessionID })) });
}));

app.post('/api/me/sessions/logout-others', requireAuth, sensitiveLimiter, ah(async (req, res) => {
  const n = await forceLogoutUser(req.user.id, '', req.sessionID);
  await sec.audit(req, { username: req.user.username, userId: req.user.id, success: true, reason: 'logout_others' });
  res.json({ ok: true, closed: n });
}));

function fmtSession(r) {
  return {
    id: crypto.createHash('sha256').update(r.sid).digest('hex').slice(0, 12), // never expose real sid
    userId: r.user_id,
    ip: r.ip,
    userAgent: r.user_agent,
    createdAt: r.created_at,
    lastSeen: r.last_seen,
  };
}

// ---------- Admin APIs ----------
app.get('/api/admin/members', requireAdmin, ah(async (_req, res) => {
  const rows = await db.all(`SELECT * FROM users WHERE role = 'member' ORDER BY id ASC`);
  const members = rows.map((u) => ({ ...sanitizeUser(u), level: levelOf(u.card_rank) }));
  members.sort((a, b) => (b.level || 0) - (a.level || 0) || a.id - b.id);
  res.json({ members });
}));

app.get('/api/admin/ranking', requireAdmin, ah(async (_req, res) => {
  const rows = await db.all(`SELECT * FROM users WHERE role = 'member' AND disabled = 0`);
  const ranking = rows
    .map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name || u.username,
      card: publicCard(u.card_rank, u.card_suit),
      level: levelOf(u.card_rank),
    }))
    .sort((a, b) => (b.level || 0) - (a.level || 0) || a.username.localeCompare(b.username));
  res.json({ ranking });
}));

app.put('/api/admin/members/:id/card', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const member = await findUserById(id);
  if (!member || member.role !== 'member') {
    return res.status(404).json({ error: '成员不存在' });
  }
  const { rank, suit } = req.body || {};
  if (rank === null || rank === '') {
    await db.run(`UPDATE users SET card_rank = NULL, card_suit = NULL WHERE id = ?`, id);
  } else {
    const v = validateCard(rank, suit);
    if (!v.ok) return res.status(400).json({ error: v.error });
    await db.run(
      `UPDATE users SET card_rank = ?, card_suit = ? WHERE id = ?`,
      v.rank.id,
      v.rank.isJoker ? null : v.suit.id,
      id
    );
  }
  const updated = await findUserById(id);
  const card = publicCard(updated.card_rank, updated.card_suit);
  sendToUser(id, { type: 'card_updated', card });
  broadcastAdmins({ type: 'member_card_updated', memberId: id, card, member: sanitizeUser(updated) });
  res.json({ member: sanitizeUser(updated) });
}));

app.post('/api/admin/members/:id/disable', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const member = await findUserById(id);
  if (!member || member.role !== 'member') return res.status(404).json({ error: '成员不存在' });
  const disabled = req.body && req.body.disabled === false ? 0 : 1;
  await db.run(`UPDATE users SET disabled = ? WHERE id = ?`, disabled, id);
  if (disabled) await forceLogoutUser(id, '账号已被停用');
  res.json({ ok: true, disabled: !!disabled });
}));

app.delete('/api/admin/members/:id', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const member = await findUserById(id);
  if (!member || member.role !== 'member') return res.status(404).json({ error: '成员不存在' });
  await forceLogoutUser(id, '账号已被删除');
  await db.transaction(async (tx) => {
    await tx.run(`DELETE FROM user_sessions WHERE user_id = ?`, id);
    await tx.run(`DELETE FROM suggestions WHERE user_id = ?`, id);
    await tx.run(`DELETE FROM ws_tokens WHERE user_id = ?`, id);
    await tx.run(`UPDATE invite_codes SET used_by = NULL, used_at = NULL WHERE used_by = ?`, id);
    await tx.run(`DELETE FROM users WHERE id = ?`, id);
  });
  broadcastAdmins({ type: 'member_removed', memberId: id });
  res.json({ ok: true });
}));

// Invite codes
app.get('/api/admin/invites', requireAdmin, ah(async (_req, res) => {
  const rows = await db.all(
    `SELECT i.*, u.username AS used_by_username
     FROM invite_codes i
     LEFT JOIN users u ON u.id = i.used_by
     ORDER BY i.id DESC`
  );
  res.json({
    invites: rows.map((r) => ({
      id: r.id,
      code: r.code,
      createdAt: r.created_at,
      usedBy: r.used_by,
      usedByUsername: r.used_by_username,
      usedAt: r.used_at,
      revoked: !!r.revoked,
      note: r.note,
      expiresAt: r.expires_at,
      status: r.revoked
        ? 'revoked'
        : r.used_by
        ? 'used'
        : r.expires_at && r.expires_at <= sec.nowText()
        ? 'expired'
        : 'unused',
    })),
  });
}));

app.post('/api/admin/invites', requireAdmin, ah(async (req, res) => {
  const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 20);
  // expiresInDays: default 7; 0 = never; max 90
  let days = req.body?.expiresInDays;
  days = days === undefined || days === null || days === '' ? 7 : Number(days);
  if (!Number.isFinite(days) || days < 0 || days > 90) return res.status(400).json({ error: '有效期需在 0–90 天之间' });
  const expiresAt = days === 0 ? null : sec.nowText(Math.max(days * 86400000, 1000));
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 50) : null;
  const codes = [];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = generateInviteCode();
      try {
        await db.run(
          `INSERT INTO invite_codes (code, created_by, expires_at, note) VALUES (?, ?, ?, ?)`,
          code, req.user.id, expiresAt, note
        );
        codes.push(code);
        break;
      } catch (_) {
        /* unique collision */
      }
    }
  }
  res.json({ codes, expiresAt });
}));

app.post('/api/admin/invites/:id/revoke', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const row = await db.get('SELECT * FROM invite_codes WHERE id = ?', id);
  if (!row) return res.status(404).json({ error: '邀请码不存在' });
  if (row.used_by) return res.status(400).json({ error: '已使用的邀请码无法撤销' });
  await db.run(`UPDATE invite_codes SET revoked = 1 WHERE id = ?`, id);
  res.json({ ok: true });
}));

// Permanently delete an invite code record (unused/revoked, or one whose member was deleted)
app.delete('/api/admin/invites/:id', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const row = await db.get('SELECT * FROM invite_codes WHERE id = ?', id);
  if (!row) return res.status(404).json({ error: '邀请码不存在' });
  if (row.used_by) return res.status(400).json({ error: '该邀请码对应的成员仍存在，请先删除成员' });
  await db.run(`DELETE FROM invite_codes WHERE id = ?`, id);
  res.json({ ok: true });
}));

// Admin: sessions / force logout / 2FA reset / audit
app.get('/api/admin/sessions', requireAdmin, ah(async (_req, res) => {
  const rows = await db.all(
    `SELECT s.*, u.username, u.display_name, u.role FROM user_sessions s JOIN users u ON u.id = s.user_id ORDER BY s.last_seen DESC LIMIT 500`
  );
  res.json({
    sessions: rows.map((r) => ({ ...fmtSession(r), username: r.username, displayName: r.display_name, role: r.role, current: r.sid === _req.sessionID })),
  });
}));

app.post('/api/admin/members/:id/logout', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const member = await findUserById(id);
  if (!member || member.role !== 'member') return res.status(404).json({ error: '成员不存在' });
  const n = await forceLogoutUser(id, '你已被管理员强制下线');
  await sec.audit(req, { username: member.username, userId: id, success: true, reason: 'forced_logout_by_admin' });
  res.json({ ok: true, closed: n });
}));

app.post('/api/admin/members/:id/reset-2fa', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const member = await findUserById(id);
  if (!member || member.role !== 'member') return res.status(404).json({ error: '成员不存在' });
  await db.run('UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?', id);
  await sec.audit(req, { username: member.username, userId: id, success: true, reason: '2fa_reset_by_admin' });
  res.json({ ok: true });
}));

app.post('/api/admin/unlock', requireAdmin, ah(async (req, res) => {
  const uname = String(req.body?.username || '').trim().slice(0, 64);
  if (!uname) return res.status(400).json({ error: '请输入用户名' });
  await db.run('DELETE FROM login_throttle WHERE key = ?', 'u:' + uname.toLowerCase());
  await sec.audit(req, { username: uname, success: true, reason: 'unlocked_by_admin' });
  res.json({ ok: true });
}));

app.get('/api/admin/audit', requireAdmin, ah(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const rows = await db.all(`SELECT * FROM login_audit ORDER BY id DESC LIMIT ${limit}`);
  res.json({
    audit: rows.map((r) => ({
      id: r.id, createdAt: r.created_at, username: r.username, userId: r.user_id,
      ip: r.ip, userAgent: r.user_agent, success: !!r.success, reason: r.reason,
    })),
  });
}));

// Suggestions for admin
app.get('/api/admin/suggestions', requireAdmin, ah(async (req, res) => {
  const status = req.query.status;
  let rows;
  if (status === 'pending' || status === 'handled') {
    rows = await db.all(`${SUGG_SELECT} WHERE s.status = ? ORDER BY s.id DESC`, status);
  } else {
    rows = await db.all(`${SUGG_SELECT} ORDER BY s.id DESC LIMIT 200`);
  }
  res.json({ suggestions: rows.map(formatSuggestion) });
}));

app.post('/api/admin/suggestions/:id/handle', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const row = await db.get('SELECT * FROM suggestions WHERE id = ?', id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  const reply = req.body?.reply != null ? String(req.body.reply).trim().slice(0, 2000) : null;
  await db.run(
    `UPDATE suggestions SET status = 'handled', admin_reply = ?, handled_at = ${NOW} WHERE id = ?`,
    reply || row.admin_reply,
    id
  );
  const updated = await db.get(`${SUGG_SELECT} WHERE s.id = ?`, id);
  sendToUser(row.user_id, { type: 'suggestion_updated', suggestion: formatSuggestion(updated) });
  res.json({ suggestion: formatSuggestion(updated) });
}));

// SPA fallback for clean URLs
app.get(['/', '/login', '/register', '/admin', '/member', '/settings'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

async function start() {
  await db.init();
  await ensureAdmin();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`卡牌系统已启动: http://0.0.0.0:${PORT} (数据库: ${db.isPg ? 'PostgreSQL' : 'SQLite'})`);
    const credPath = path.join(__dirname, 'ADMIN_CREDENTIALS.txt');
    if (!db.isPg && fs.existsSync(credPath)) console.log(`管理员凭证文件: ${credPath}`);
  });
}

if (require.main === module) {
  start().catch((e) => {
    console.error('启动失败:', e);
    process.exit(1);
  });
}

module.exports = { app, server, start };
