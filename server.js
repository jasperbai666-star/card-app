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
const chat = require('./chat');
const achievements = require('./achievements');

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
app.use(
  '/api/chat/images',
  express.raw({
    type: (req) => /^image\/(jpeg|png|webp|gif)$/i.test(String(req.headers['content-type'] || '').split(';')[0].trim()),
    limit: chat.MAX_IMAGE_BYTES,
  })
);
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

app.get('/healthz', ah(async (_req, res) => {
  // Touch chat / announce schemas so a missing migration fails health checks (and boot) loudly.
  try {
    await db.all('SELECT id FROM chat_messages ORDER BY id DESC LIMIT 1');
    await db.all('SELECT id FROM announcements ORDER BY id DESC LIMIT 1');
    await db.all('SELECT badge_key FROM user_achievements LIMIT 1');
    await db.all('SELECT user_id FROM jump_scores LIMIT 1');
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'schema', detail: String(e.message || e).slice(0, 120) });
  }
  res.json({ ok: true });
}));
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

async function broadcastMembers(payload) {
  try {
    const members = await db.all("SELECT id FROM users WHERE role = 'member' AND disabled = 0");
    for (const m of members) sendToUser(m.id, payload);
  } catch (e) {
    console.error('broadcastMembers', e.message);
  }
}

/** Award badges and push real-time unlock notices. */
async function notifyAchievements(userId, keys) {
  try {
    const newly = await achievements.award(db, userId, keys);
    for (const badge of newly) {
      sendToUser(userId, { type: 'achievement_unlocked', badge });
    }
    return newly;
  } catch (e) {
    console.error('notifyAchievements', e.message);
    return [];
  }
}

function formatAnnouncement(row, { read = false } = {}) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    pinned: !!row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at || null,
    createdBy: row.created_by,
    read: !!read,
  };
}

const ANN_ACTIVE = `deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ${NOW})`;

async function broadcastAdmins(payload) {
  try {
    const admins = await db.all("SELECT id FROM users WHERE role = 'admin' AND disabled = 0");
    for (const a of admins) sendToUser(a.id, payload);
  } catch (e) {
    console.error('broadcastAdmins', e.message);
  }
}

/** Push a chat event to every connected user. Members get the public shape; admins get identity. */
async function broadcastChat(eventType, row) {
  const pub = { type: eventType, message: chat.publicMessage(row) };
  const adm = { type: eventType, message: chat.adminMessage(row) };
  const pubData = JSON.stringify(pub);
  const admData = JSON.stringify(adm);
  let adminIds = new Set();
  try {
    for (const a of await db.all("SELECT id FROM users WHERE role = 'admin'")) adminIds.add(a.id);
  } catch (_) {}
  for (const [uid, set] of socketsByUser) {
    const data = adminIds.has(uid) ? admData : pubData;
    for (const ws of set) {
      if (ws.readyState === 1) {
        try { ws.send(data); } catch (_) {}
      }
    }
  }
}


async function ensureChatAlias(req) {
  if (req.user.role === 'admin') {
    req.session.chatAlias = '管理员';
    return '管理员';
  }
  if (!req.session.chatAlias) {
    req.session.chatAlias = chat.generateAlias('member');
    await saveSession(req);
    try { await db.run('UPDATE user_sessions SET chat_alias = ? WHERE sid = ?', req.session.chatAlias, req.sessionID); } catch (_) {}
  }
  return req.session.chatAlias;
}

async function isMuted(userId) {
  const row = await db.get('SELECT * FROM chat_mutes WHERE user_id = ?', userId);
  if (!row) return false;
  if (row.muted_until && row.muted_until <= sec.nowText()) {
    await db.run('DELETE FROM chat_mutes WHERE user_id = ?', userId);
    return false;
  }
  return true; // null muted_until = permanent
}

async function loadChatRow(id) {
  return db.get(
    `SELECT m.*, u.username, u.display_name FROM chat_messages m
     LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?`,
    id
  );
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
      if (String(raw).length > 8000) return;
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
            ws._role = user.role;
            ws._alias = row.alias || (user.role === 'admin' ? '管理员' : '匿名');
            ws.send(JSON.stringify({ type: 'auth_ok', role: user.role, chatAlias: ws._alias }));
            return;
          }
        }
        ws.send(JSON.stringify({ type: 'auth_fail' }));
        return;
      }
      if (msg.type === 'chat_send' && ws._userId) {
        await handleWsChatSend(ws, msg);
      }
    } catch (_) {
      /* ignore */
    }
  });
  ws.on('close', () => detachUser(ws));
});

async function handleWsChatSend(ws, msg) {
  const user = await findUserById(ws._userId);
  if (!user || user.disabled) return ws.send(JSON.stringify({ type: 'chat_error', error: '未登录' }));
  if (await isMuted(user.id)) return ws.send(JSON.stringify({ type: 'chat_error', error: '你已被禁言，暂时无法发言' }));
  // per-socket simple throttle
  const now = Date.now();
  ws._chatTimes = (ws._chatTimes || []).filter((t) => now - t < 10_000);
  if (ws._chatTimes.length >= 8) return ws.send(JSON.stringify({ type: 'chat_error', error: '发送太快，请稍候' }));
  ws._chatTimes.push(now);
  const v = chat.validateText(msg.text);
  if (!v.ok) return ws.send(JSON.stringify({ type: 'chat_error', error: v.error }));
  const alias = user.role === 'admin' ? '管理员' : (ws._alias || '匿名');
  const info = await db.run(
    `INSERT INTO chat_messages (user_id, alias, role, msg_type, content, created_at)
     VALUES (?, ?, ?, 'text', ?, ${NOW})`,
    user.id, alias, user.role, v.text
  );
  const row = await loadChatRow(info.lastInsertRowid);
  await broadcastChat('chat_message', row);
  await notifyAchievements(user.id, ['first_chat']);
}

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

async function issueWsToken(userId, alias = null) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.run(
    'INSERT INTO ws_tokens (token, user_id, expires_at, alias) VALUES (?, ?, ?, ?)',
    token,
    userId,
    nowText(60 * 60 * 1000),
    alias
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

/** Inviter shown in the UI; uses the inviter's CURRENT name (joined live, never copied). */
function inviterOf(row) {
  if (row.invited_by === null || row.invited_by === undefined) return { id: null, name: '未知', role: null };
  if (!row.inviter_role) return { id: row.invited_by, name: '已删除成员', role: null };
  if (row.inviter_role === 'admin') return { id: row.invited_by, name: '管理员', role: 'admin' };
  return { id: row.invited_by, name: row.inviter_display_name || row.inviter_username, role: 'member' };
}
const INVITER_JOIN = `LEFT JOIN users iv ON iv.id = u.invited_by`;
const INVITER_COLS = `iv.role AS inviter_role, iv.display_name AS inviter_display_name, iv.username AS inviter_username`;

function inviteStatus(r) {
  return r.revoked ? 'revoked' : r.used_by ? 'used' : r.expires_at && r.expires_at <= sec.nowText() ? 'expired' : 'unused';
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
}

/** Rotate the session id and bind it to the user (prevents session fixation). */
async function establishSession(req, user) {
  await regenerateSession(req);
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.chatAlias = chat.generateAlias(user.role);
  await saveSession(req);
  await sec.trackSession(req, user.id);
  try {
    await db.run('UPDATE user_sessions SET chat_alias = ? WHERE sid = ?', req.session.chatAlias, req.sessionID);
  } catch (_) {}
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
const adminWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => 'a' + (req.session?.userId || 'anon'),
  handler: limitJson('操作太频繁，请稍后再试'),
});
const announcementLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => 'ann' + (req.session?.userId || 'anon'),
  handler: limitJson('公告操作太频繁，请稍后再试'),
});
const jumpScoreLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => 'jump' + (req.session?.userId || 'anon'),
  handler: limitJson('提交太频繁，请稍后再试'),
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
    displayName: row.display_name || row.username,
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
  res.json({ token: await issueWsToken(req.user.id, req.session.chatAlias || null) });
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
  if (user.role === 'member') await notifyAchievements(user.id, ['first_login']);
  res.json({ user: sanitizeUser(user), wsToken: await issueWsToken(user.id, req.session.chatAlias || null), chatAlias: req.session.chatAlias });
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
  let dispName = uname;
  if (typeof displayName === 'string' && displayName.trim()) {
    const v = sec.normalizeDisplayName(displayName);
    if (!v.ok) return res.status(400).json({ error: v.error });
    dispName = v.name;
  }
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
        `INSERT INTO users (username, password_hash, role, display_name, invite_code_used, invited_by)
         VALUES (?, ?, 'member', ?, ?, ?)`,
        uname,
        pwHash,
        dispName,
        code,
        invite.created_by ?? null
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
  if (invite.created_by) sendToUser(invite.created_by, { type: 'invite_used', displayName: user.display_name || user.username });
  await notifyAchievements(user.id, ['first_login']);
  if (invite.created_by) {
    const inviter = await findUserById(invite.created_by);
    if (inviter && inviter.role === 'member') {
      const cnt = await db.get(`SELECT COUNT(*) AS c FROM users WHERE invited_by = ? AND role = 'member'`, invite.created_by);
      const n = Number(cnt?.c || 0);
      const keys = [];
      if (n >= 1) keys.push('invite_1');
      if (n >= 3) keys.push('invite_3');
      if (keys.length) await notifyAchievements(invite.created_by, keys);
    }
  }
  res.json({ user: sanitizeUser(user), wsToken: await issueWsToken(user.id, req.session.chatAlias || null), chatAlias: req.session.chatAlias });
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
  await notifyAchievements(req.user.id, ['suggestion']);
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

// ---------- Member: own invite code (max ONE active at a time) + who invited me ----------
const MEMBER_INVITE_DAYS = 7;
async function myActiveInvite(userId, q = db) {
  return q.get(
    `SELECT * FROM invite_codes WHERE created_by = ? AND member_limited = 1 AND used_by IS NULL AND revoked = 0 ORDER BY id DESC LIMIT 1`,
    userId
  );
}
function fmtMyInvite(r) {
  return r ? { id: r.id, code: r.code, createdAt: r.created_at, expiresAt: r.expires_at, status: inviteStatus(r) } : null;
}

app.get('/api/my/invite', requireAuth, ah(async (req, res) => {
  const me = await db.get(`SELECT u.*, ${INVITER_COLS} FROM users u ${INVITER_JOIN} WHERE u.id = ?`, req.user.id);
  const active = req.user.role === 'member' ? await myActiveInvite(req.user.id) : null;
  const invited = await db.all(
    `SELECT id, username, display_name, created_at FROM users WHERE invited_by = ? AND role = 'member' ORDER BY id ASC`,
    req.user.id
  );
  res.json({
    invitedBy: req.user.role === 'member' ? inviterOf(me) : null,
    invite: fmtMyInvite(active),
    invitedMembers: invited.map((u) => ({ id: u.id, displayName: u.display_name || u.username, createdAt: u.created_at })),
  });
}));

app.post('/api/my/invite', requireAuth, sensitiveLimiter, ah(async (req, res) => {
  if (req.user.role !== 'member') return res.status(400).json({ error: '管理员请在「邀请码」页生成' });
  let created;
  try {
    created = await db.transaction(async (tx) => {
      // An expired-but-unused code no longer counts: retire it so a new one can be issued.
      await tx.run(
        `UPDATE invite_codes SET revoked = 1 WHERE created_by = ? AND member_limited = 1 AND used_by IS NULL AND revoked = 0
         AND expires_at IS NOT NULL AND expires_at <= ?`,
        req.user.id, sec.nowText()
      );
      const existing = await myActiveInvite(req.user.id, tx);
      if (existing) return { existing };
      const code = generateInviteCode();
      // The partial unique index uniq_member_active_invite makes a concurrent second insert fail.
      await tx.run(
        `INSERT INTO invite_codes (code, created_by, expires_at, member_limited) VALUES (?, ?, ?, 1)`,
        code, req.user.id, sec.nowText(MEMBER_INVITE_DAYS * 86400000)
      );
      return { row: await myActiveInvite(req.user.id, tx) };
    });
  } catch (_) {
    return res.status(409).json({ error: '你已有一个未使用的邀请码，每人同时只能有 1 个；请等它被使用或先撤销' });
  }
  if (created.existing) {
    return res.status(409).json({ error: '你已有一个未使用的邀请码，每人同时只能有 1 个；请等它被使用或先撤销', invite: fmtMyInvite(created.existing) });
  }
  await sec.audit(req, { username: req.user.username, userId: req.user.id, success: true, reason: 'member_invite_created' });
  broadcastAdmins({ type: 'invites_changed' });
  res.json({ invite: fmtMyInvite(created.row) });
}));

app.post('/api/my/invite/revoke', requireAuth, sensitiveLimiter, ah(async (req, res) => {
  if (req.user.role !== 'member') return res.status(400).json({ error: '管理员请在「邀请码」页撤销' });
  const r = await db.run(
    `UPDATE invite_codes SET revoked = 1 WHERE created_by = ? AND member_limited = 1 AND used_by IS NULL AND revoked = 0`,
    req.user.id
  );
  if (!r.changes) return res.status(404).json({ error: '你当前没有可撤销的邀请码' });
  await sec.audit(req, { username: req.user.username, userId: req.user.id, success: true, reason: 'member_invite_revoked' });
  broadcastAdmins({ type: 'invites_changed' });
  res.json({ ok: true });
}));


// ---------- Anonymous chat ----------
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => 'c' + (req.session?.userId || 'anon'),
  handler: limitJson('发送太频繁，请稍后再试'),
});
const chatUploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => 'ci' + (req.session?.userId || 'anon'),
  handler: limitJson('图片上传太频繁，请稍后再试'),
});

app.get('/api/chat/meta', requireAuth, (_req, res) => {
  res.json({ maxTextLen: chat.MAX_TEXT_LEN, maxImageBytes: chat.MAX_IMAGE_BYTES, emoji: chat.EMOJI_PRESET });
});

app.get('/api/chat/me', requireAuth, (req, res) => {
  res.json({
    alias: req.user.role === 'admin' ? '管理员' : (req.session.chatAlias || '匿名'),
    muted: false, // filled below via async wrapper if needed
  });
});

app.get('/api/chat/messages', requireAuth, ah(async (req, res) => {
  // Avoid `WHERE (? IS NULL OR …)` — Postgres cannot infer the type of a bare NULL $1.
  const beforeRaw = req.query.before != null && req.query.before !== '' ? Number(req.query.before) : null;
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const muted = await isMuted(req.user.id);
  const myAlias = await ensureChatAlias(req);
  const base = `SELECT m.*, u.username, u.display_name FROM chat_messages m
       LEFT JOIN users u ON u.id = m.user_id`;
  let rows;
  if (req.user.role === 'admin') {
    rows = before == null
      ? await db.all(`${base} ORDER BY m.id DESC LIMIT ?`, limit)
      : await db.all(`${base} WHERE m.id < ? ORDER BY m.id DESC LIMIT ?`, before, limit);
  } else {
    rows = before == null
      ? await db.all(`${base} WHERE m.deleted_at IS NULL ORDER BY m.id DESC LIMIT ?`, limit)
      : await db.all(`${base} WHERE m.deleted_at IS NULL AND m.id < ? ORDER BY m.id DESC LIMIT ?`, before, limit);
  }
  const list = rows.reverse().map((r) =>
    req.user.role === 'admin' ? chat.adminMessage(r) : chat.publicMessage(r)
  );
  // Strip identity from public shape is already done; double-check no leakage keys for members
  if (req.user.role !== 'admin') {
    for (const m of list) {
      delete m.userId; delete m.username; delete m.displayName; delete m.deletedAt;
    }
  }
  res.json({
    messages: list,
    alias: myAlias,
    muted,
  });
}));

app.post('/api/chat/messages', requireAuth, chatLimiter, ah(async (req, res) => {
  if (await isMuted(req.user.id)) return res.status(403).json({ error: '你已被禁言，暂时无法发言' });
  const v = chat.validateText(req.body?.text);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const alias = await ensureChatAlias(req);
  const info = await db.run(
    `INSERT INTO chat_messages (user_id, alias, role, msg_type, content, created_at)
     VALUES (?, ?, ?, 'text', ?, ${NOW})`,
    req.user.id, alias, req.user.role, v.text
  );
  const row = await loadChatRow(info.lastInsertRowid);
  await broadcastChat('chat_message', row);
  await notifyAchievements(req.user.id, ['first_chat']);
  res.json({ message: req.user.role === 'admin' ? chat.adminMessage(row) : chat.publicMessage(row) });
}));

app.post('/api/chat/images', requireAuth, chatUploadLimiter, ah(async (req, res) => {
  if (await isMuted(req.user.id)) return res.status(403).json({ error: '你已被禁言，暂时无法发言' });
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || !buf.length) return res.status(400).json({ error: '请上传图片' });
  const sniffed = chat.sniffImage(buf, req.headers['content-type']);
  if (!sniffed.ok) return res.status(400).json({ error: sniffed.error });
  const key = chat.newImageKey();
  const alias = await ensureChatAlias(req);
  await db.transaction(async (tx) => {
    await tx.run(
      db.isPg
        ? `INSERT INTO chat_images (key, mime, bytes, size, uploaded_by, created_at) VALUES (?, ?, ?::bytea, ?, ?, ${NOW})`
        : `INSERT INTO chat_images (key, mime, bytes, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ${NOW})`,
      key, sniffed.mime, buf, buf.length, req.user.id
    );
    const info = await tx.run(
      `INSERT INTO chat_messages (user_id, alias, role, msg_type, content, image_key, created_at)
       VALUES (?, ?, ?, 'image', NULL, ?, ${NOW})`,
      req.user.id, alias, req.user.role, key
    );
    req._chatImageMsgId = info.lastInsertRowid;
  });
  const row = await loadChatRow(req._chatImageMsgId);
  await broadcastChat('chat_message', row);
  await notifyAchievements(req.user.id, ['image_master', 'first_chat']);
  await sec.audit(req, { username: req.user.username, userId: req.user.id, success: true, reason: 'chat_image_upload', detail: key.slice(0, 12) });
  res.json({ message: req.user.role === 'admin' ? chat.adminMessage(row) : chat.publicMessage(row) });
}));

app.get('/api/chat/images/:key', requireAuth, ah(async (req, res) => {
  const key = String(req.params.key || '').replace(/[^a-f0-9]/gi, '').slice(0, 64);
  if (key.length < 16) return res.status(404).end();
  const row = await db.get('SELECT mime, bytes, size FROM chat_images WHERE key = ?', key);
  if (!row) return res.status(404).end();
  // Members may only fetch images that belong to a non-deleted message
  if (req.user.role !== 'admin') {
    const msg = await db.get('SELECT id FROM chat_messages WHERE image_key = ? AND deleted_at IS NULL', key);
    if (!msg) return res.status(404).end();
  }
  const bytes = row.bytes;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  res.set({
    'Content-Type': row.mime,
    'Content-Length': String(buf.length),
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}));

app.delete('/api/admin/chat/messages/:id', requireAdmin, adminWriteLimiter, ah(async (req, res) => {
  const id = Number(req.params.id);
  const row = await loadChatRow(id);
  if (!row) return res.status(404).json({ error: '消息不存在' });
  if (row.deleted_at) return res.json({ ok: true });
  await db.run(
    `UPDATE chat_messages SET deleted_at = ${NOW}, deleted_by = ? WHERE id = ?`,
    req.user.id, id
  );
  const updated = await loadChatRow(id);
  // Members receive a delete event without identity
  const delPub = JSON.stringify({ type: 'chat_deleted', id });
  const delAdm = JSON.stringify({ type: 'chat_deleted', id, message: chat.adminMessage(updated) });
  let adminIds = new Set();
  try { for (const a of await db.all("SELECT id FROM users WHERE role = 'admin'")) adminIds.add(a.id); } catch (_) {}
  for (const [uid, set] of socketsByUser) {
    const data = adminIds.has(uid) ? delAdm : delPub;
    for (const ws of set) if (ws.readyState === 1) try { ws.send(data); } catch (_) {}
  }
  await sec.audit(req, { username: req.user.username, userId: req.user.id, success: true, reason: 'chat_message_deleted', detail: String(id) });
  res.json({ ok: true });
}));

app.post('/api/admin/chat/clear', requireAdmin, adminWriteLimiter, ah(async (req, res) => {
  await db.transaction(async (tx) => {
    await tx.run(`UPDATE chat_messages SET deleted_at = ${NOW}, deleted_by = ? WHERE deleted_at IS NULL`, req.user.id);
  });
  // Notify everyone to wipe local view
  const payload = JSON.stringify({ type: 'chat_cleared' });
  for (const [, set] of socketsByUser) {
    for (const ws of set) if (ws.readyState === 1) try { ws.send(payload); } catch (_) {}
  }
  await sec.audit(req, { username: req.user.username, userId: req.user.id, success: true, reason: 'chat_cleared' });
  res.json({ ok: true });
}));

app.get('/api/admin/chat/mutes', requireAdmin, ah(async (_req, res) => {
  const rows = await db.all(
    `SELECT m.*, u.username, u.display_name FROM chat_mutes m JOIN users u ON u.id = m.user_id ORDER BY m.created_at DESC`
  );
  const now = sec.nowText();
  res.json({
    mutes: rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name || r.username,
      mutedUntil: r.muted_until,
      reason: r.reason,
      permanent: !r.muted_until,
      active: !r.muted_until || r.muted_until > now,
      createdAt: r.created_at,
    })),
  });
}));

app.post('/api/admin/chat/mutes', requireAdmin, adminWriteLimiter, ah(async (req, res) => {
  const userId = Number(req.body?.userId);
  const member = await findUserById(userId);
  if (!member || member.role !== 'member') return res.status(404).json({ error: '成员不存在' });
  const minutes = req.body?.minutes == null ? null : Number(req.body.minutes);
  if (minutes != null && (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 30)) {
    return res.status(400).json({ error: '禁言时长需在 1 分钟–30 天之间，或不传表示永久' });
  }
  const until = minutes == null ? null : sec.nowText(minutes * 60_000);
  const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 80) : null;
  await db.run(
    db.isPg
      ? `INSERT INTO chat_mutes (user_id, muted_until, muted_by, reason, created_at) VALUES (?, ?::text, ?, ?::text, ${NOW})
         ON CONFLICT(user_id) DO UPDATE SET muted_until = EXCLUDED.muted_until, muted_by = EXCLUDED.muted_by, reason = EXCLUDED.reason, created_at = EXCLUDED.created_at`
      : `INSERT INTO chat_mutes (user_id, muted_until, muted_by, reason, created_at) VALUES (?, ?, ?, ?, ${NOW})
         ON CONFLICT(user_id) DO UPDATE SET muted_until = excluded.muted_until, muted_by = excluded.muted_by, reason = excluded.reason, created_at = excluded.created_at`,
    userId, until, req.user.id, reason
  );
  // SQLite UPSERT works; for PG ON CONFLICT works with PRIMARY KEY. Good.
  sendToUser(userId, { type: 'chat_muted', mutedUntil: until, reason });
  await sec.audit(req, { username: member.username, userId, success: true, reason: 'chat_muted', detail: until || 'permanent' });
  res.json({ ok: true, mutedUntil: until });
}));

app.delete('/api/admin/chat/mutes/:userId', requireAdmin, adminWriteLimiter, ah(async (req, res) => {
  const userId = Number(req.params.userId);
  await db.run('DELETE FROM chat_mutes WHERE user_id = ?', userId);
  sendToUser(userId, { type: 'chat_unmuted' });
  await sec.audit(req, { username: String(userId), userId, success: true, reason: 'chat_unmuted' });
  res.json({ ok: true });
}));

// ---------- Admin APIs ----------
app.get('/api/admin/members', requireAdmin, ah(async (_req, res) => {
  const rows = await db.all(`SELECT u.*, ${INVITER_COLS} FROM users u ${INVITER_JOIN} WHERE u.role = 'member' ORDER BY u.id ASC`);
  const achMap = await achievements.summaryForUsers(db, rows.map((u) => u.id));
  const members = rows.map((u) => ({
    ...sanitizeUser(u),
    invitedBy: inviterOf(u),
    level: levelOf(u.card_rank),
    achievements: achMap[u.id] || { unlocked: 0, total: achievements.BADGES.length, keys: [] },
  }));
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
  if (levelOf(updated.card_rank) >= achievements.HIGH_CARD_LEVEL) {
    await notifyAchievements(id, ['high_card']);
  }
  res.json({ member: sanitizeUser(updated) });
}));

// Rename a member (display name only; login username never changes). Admin-only by design:
// there is intentionally no member-facing endpoint for this.
app.put('/api/admin/members/:id/name', requireAdmin, adminWriteLimiter, ah(async (req, res) => {
  const id = Number(req.params.id);
  const member = await findUserById(id);
  if (!member || member.role !== 'member') return res.status(404).json({ error: '成员不存在' });
  const v = sec.normalizeDisplayName(req.body?.displayName);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const oldName = member.display_name || member.username;
  if (v.name !== oldName || !member.display_name) {
    await db.run('UPDATE users SET display_name = ? WHERE id = ?', v.name, id);
  }
  const updated = await findUserById(id);
  if (v.name !== oldName) {
    await sec.audit(req, {
      username: member.username, userId: id, success: true, reason: 'display_name_changed',
      detail: `${oldName} → ${v.name}（操作人 ${req.user.username}）`,
    });
    const pub = sanitizeUser(updated);
    sendToUser(id, { type: 'profile_updated', user: pub });
    broadcastAdmins({ type: 'member_updated', memberId: id, member: pub });
  }
  res.json({ member: sanitizeUser(updated), changed: v.name !== oldName });
}));

app.post('/api/admin/members/:id/disable', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const member = await findUserById(id);
  if (!member || member.role !== 'member') return res.status(404).json({ error: '成员不存在' });
  const disabled = req.body && req.body.disabled === false ? 0 : 1;
  await db.run(`UPDATE users SET disabled = ? WHERE id = ?`, disabled, id);
  if (disabled) {
    await db.run(`UPDATE invite_codes SET revoked = 1 WHERE created_by = ? AND used_by IS NULL AND revoked = 0`, id);
    await forceLogoutUser(id, '账号已被停用');
  }
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
    await tx.run(`DELETE FROM chat_mutes WHERE user_id = ?`, id);
    await tx.run(`DELETE FROM user_achievements WHERE user_id = ?`, id);
    await tx.run(`DELETE FROM announcement_reads WHERE user_id = ?`, id);
    await tx.run(`DELETE FROM jump_scores WHERE user_id = ?`, id);
    // Codes the member used: detach and mark revoked so they can never be re-used.
    await tx.run(`UPDATE invite_codes SET used_by = NULL, used_at = NULL, revoked = 1 WHERE used_by = ?`, id);
    // Codes the member issued: revoke unused ones and detach creator. Members they invited keep
    // users.invited_by (shown as 已删除成员).
    await tx.run(`UPDATE invite_codes SET revoked = 1, created_by = NULL WHERE created_by = ?`, id);
    await tx.run(`DELETE FROM users WHERE id = ?`, id);
  });
  broadcastAdmins({ type: 'member_removed', memberId: id });
  res.json({ ok: true });
}));

// Invite codes
app.get('/api/admin/invites', requireAdmin, ah(async (_req, res) => {
  const rows = await db.all(
    `SELECT i.*, u.username AS used_by_username, c.role AS creator_role, c.display_name AS creator_display_name, c.username AS creator_username
     FROM invite_codes i
     LEFT JOIN users u ON u.id = i.used_by
     LEFT JOIN users c ON c.id = i.created_by
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
      createdByName: r.creator_role === 'admin' ? '管理员' : r.creator_role ? (r.creator_display_name || r.creator_username) : '未知',
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
      ip: r.ip, userAgent: r.user_agent, success: !!r.success, reason: r.reason, detail: r.detail || null,
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


// ---------- Announcements (member + admin) ----------
app.get('/api/announcements', requireAuth, ah(async (req, res) => {
  const rows = await db.all(
    `SELECT a.*,
       CASE WHEN r.user_id IS NULL THEN 0 ELSE 1 END AS is_read
     FROM announcements a
     LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
     WHERE a.deleted_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > ${NOW})
     ORDER BY a.pinned DESC, a.id DESC
     LIMIT 100`,
    req.user.id
  );
  const list = rows.map((r) => formatAnnouncement(r, { read: !!r.is_read }));
  const unread = list.filter((a) => !a.read).length;
  res.json({ announcements: list, unread });
}));

app.post('/api/announcements/:id/read', requireAuth, ah(async (req, res) => {
  const id = Number(req.params.id);
  const row = await db.get(
    `SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ${NOW})`,
    id
  );
  if (!row) return res.status(404).json({ error: '公告不存在或已过期' });
  const existing = await db.get(
    'SELECT user_id FROM announcement_reads WHERE user_id = ? AND announcement_id = ?',
    req.user.id, id
  );
  if (!existing) {
    await db.run(
      `INSERT INTO announcement_reads (user_id, announcement_id, read_at) VALUES (?, ?, ${NOW})`,
      req.user.id, id
    );
  }
  res.json({ ok: true });
}));

app.post('/api/announcements/read-all', requireAuth, ah(async (req, res) => {
  const rows = await db.all(
    `SELECT id FROM announcements WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ${NOW})`
  );
  for (const r of rows) {
    const existing = await db.get(
      'SELECT user_id FROM announcement_reads WHERE user_id = ? AND announcement_id = ?',
      req.user.id, r.id
    );
    if (!existing) {
      await db.run(
        `INSERT INTO announcement_reads (user_id, announcement_id, read_at) VALUES (?, ?, ${NOW})`,
        req.user.id, r.id
      );
    }
  }
  res.json({ ok: true, marked: rows.length });
}));

app.get('/api/admin/announcements', requireAdmin, ah(async (_req, res) => {
  const rows = await db.all(
    `SELECT * FROM announcements WHERE deleted_at IS NULL ORDER BY pinned DESC, id DESC LIMIT 200`
  );
  res.json({ announcements: rows.map((r) => formatAnnouncement(r)) });
}));

function parseAnnouncementBody(body) {
  const title = String(body?.title || '').trim();
  const text = String(body?.body || '').trim();
  if (!title || title.length > 80) return { ok: false, error: '标题需 1–80 字' };
  if (!text || text.length > 4000) return { ok: false, error: '正文需 1–4000 字' };
  const pinned = body?.pinned === true || body?.pinned === 1 || body?.pinned === '1' ? 1 : 0;
  let expiresAt = null;
  if (body?.expiresAt != null && String(body.expiresAt).trim() !== '') {
    const raw = String(body.expiresAt).trim().replace('T', ' ').slice(0, 19);
    if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return { ok: false, error: '过期时间格式无效' };
    expiresAt = raw.length === 10 ? raw + ' 23:59:59' : raw;
  }
  return { ok: true, title, body: text, pinned, expiresAt };
}

app.post('/api/admin/announcements', requireAdmin, announcementLimiter, ah(async (req, res) => {
  const v = parseAnnouncementBody(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  const info = await db.run(
    db.isPg
      ? `INSERT INTO announcements (title, body, pinned, created_by, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ${NOW}, ${NOW}, ?::text)`
      : `INSERT INTO announcements (title, body, pinned, created_by, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ${NOW}, ${NOW}, ?)`,
    v.title, v.body, v.pinned, req.user.id, v.expiresAt
  );
  const row = await db.get('SELECT * FROM announcements WHERE id = ?', info.lastInsertRowid);
  const pub = formatAnnouncement(row);
  broadcastMembers({ type: 'announcement', announcement: pub });
  broadcastAdmins({ type: 'announcement', announcement: pub });
  await sec.audit(req, {
    username: req.user.username, userId: req.user.id, success: true,
    reason: 'announcement_created', detail: String(row.id),
  });
  res.json({ announcement: pub });
}));

app.put('/api/admin/announcements/:id', requireAdmin, announcementLimiter, ah(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.get('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL', id);
  if (!existing) return res.status(404).json({ error: '公告不存在' });
  const v = parseAnnouncementBody({
    title: req.body?.title != null ? req.body.title : existing.title,
    body: req.body?.body != null ? req.body.body : existing.body,
    pinned: req.body?.pinned != null ? req.body.pinned : existing.pinned,
    expiresAt: req.body?.expiresAt !== undefined ? req.body.expiresAt : existing.expires_at,
  });
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (db.isPg) {
    await db.run(
      `UPDATE announcements SET title = ?, body = ?, pinned = ?, expires_at = ?::text, updated_at = ${NOW} WHERE id = ?`,
      v.title, v.body, v.pinned, v.expiresAt, id
    );
  } else {
    await db.run(
      `UPDATE announcements SET title = ?, body = ?, pinned = ?, expires_at = ?, updated_at = ${NOW} WHERE id = ?`,
      v.title, v.body, v.pinned, v.expiresAt, id
    );
  }
  const row = await db.get('SELECT * FROM announcements WHERE id = ?', id);
  const pub = formatAnnouncement(row);
  broadcastMembers({ type: 'announcement_updated', announcement: pub });
  broadcastAdmins({ type: 'announcement_updated', announcement: pub });
  await sec.audit(req, {
    username: req.user.username, userId: req.user.id, success: true,
    reason: 'announcement_updated', detail: String(id),
  });
  res.json({ announcement: pub });
}));

app.post('/api/admin/announcements/:id/pin', requireAdmin, announcementLimiter, ah(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.get('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL', id);
  if (!existing) return res.status(404).json({ error: '公告不存在' });
  const pinned = req.body?.pinned === false || req.body?.pinned === 0 || req.body?.pinned === '0' ? 0 : 1;
  await db.run(`UPDATE announcements SET pinned = ?, updated_at = ${NOW} WHERE id = ?`, pinned, id);
  const row = await db.get('SELECT * FROM announcements WHERE id = ?', id);
  const pub = formatAnnouncement(row);
  broadcastMembers({ type: 'announcement_updated', announcement: pub });
  broadcastAdmins({ type: 'announcement_updated', announcement: pub });
  await sec.audit(req, {
    username: req.user.username, userId: req.user.id, success: true,
    reason: pinned ? 'announcement_pinned' : 'announcement_unpinned', detail: String(id),
  });
  res.json({ announcement: pub });
}));

app.delete('/api/admin/announcements/:id', requireAdmin, announcementLimiter, ah(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.get('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL', id);
  if (!existing) return res.status(404).json({ error: '公告不存在' });
  await db.run(`UPDATE announcements SET deleted_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`, id);
  broadcastMembers({ type: 'announcement_deleted', id });
  broadcastAdmins({ type: 'announcement_deleted', id });
  await sec.audit(req, {
    username: req.user.username, userId: req.user.id, success: true,
    reason: 'announcement_deleted', detail: String(id),
  });
  res.json({ ok: true });
}));

// ---------- Achievements ----------
app.get('/api/my/achievements', requireAuth, ah(async (req, res) => {
  if (req.user.role === 'admin') {
    return res.json({ badges: achievements.BADGES.map((b) => achievements.publicBadge(b, null)), unlocked: 0 });
  }
  const badges = await achievements.listForUser(db, req.user.id);
  res.json({ badges, unlocked: badges.filter((b) => b.unlocked).length, total: badges.length });
}));

app.get('/api/admin/members/:id/achievements', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const member = await findUserById(id);
  if (!member || member.role !== 'member') return res.status(404).json({ error: '成员不存在' });
  const badges = await achievements.listForUser(db, id);
  res.json({
    memberId: id,
    badges,
    unlocked: badges.filter((b) => b.unlocked).length,
    total: badges.length,
  });
}));


// ---------- Jump Jump (跳一跳) ----------
const JUMP_MAX_SCORE = 500;
const JUMP_MAX_DELTA = 120; // one run cannot raise best by more than this vs previous best

function jumpAliasFor(req) {
  if (req.user.role === 'admin') return '管理员';
  return String(req.session.chatAlias || '匿名玩家').slice(0, 24);
}

app.get('/api/jump/me', requireAuth, ah(async (req, res) => {
  const row = await db.get('SELECT * FROM jump_scores WHERE user_id = ?', req.user.id);
  res.json({
    best: row ? Number(row.best_score) : 0,
    gamesPlayed: row ? Number(row.games_played) : 0,
    alias: row?.alias || jumpAliasFor(req),
    proThreshold: achievements.JUMP_PRO_SCORE,
  });
}));

app.get('/api/jump/leaderboard', requireAuth, ah(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const rows = await db.all(
    `SELECT j.user_id, j.best_score, j.alias, j.best_at, j.games_played,
            u.username, u.display_name, u.role
     FROM jump_scores j
     JOIN users u ON u.id = j.user_id
     WHERE j.best_score > 0 AND u.disabled = 0
     ORDER BY j.best_score DESC, j.best_at ASC
     LIMIT ?`,
    limit
  );
  const isAdmin = req.user.role === 'admin';
  res.json({
    leaderboard: rows.map((r, i) => ({
      rank: i + 1,
      score: Number(r.best_score),
      alias: r.role === 'admin' ? '管理员' : (r.alias || '匿名玩家'),
      bestAt: r.best_at,
      gamesPlayed: Number(r.games_played || 0),
      // identity only for admins
      ...(isAdmin ? {
        userId: r.user_id,
        username: r.username,
        displayName: r.display_name || r.username,
        role: r.role,
      } : {}),
      me: r.user_id === req.user.id,
    })),
  });
}));

app.post('/api/jump/score', requireAuth, jumpScoreLimiter, ah(async (req, res) => {
  const score = Number(req.body?.score);
  const hops = Number(req.body?.hops);
  const durationMs = Number(req.body?.durationMs);
  if (!Number.isFinite(score) || score < 0 || score !== Math.floor(score)) {
    return res.status(400).json({ error: '分数无效' });
  }
  if (score > JUMP_MAX_SCORE) return res.status(400).json({ error: '分数超出合理范围' });
  if (Number.isFinite(hops) && hops >= 0) {
    if (hops > JUMP_MAX_SCORE + 5) return res.status(400).json({ error: '跳跃次数异常' });
    // score roughly <= hops * 3 (center + combo padding)
    if (score > hops * 3 + 5) return res.status(400).json({ error: '分数与跳跃次数不匹配' });
  }
  if (Number.isFinite(durationMs) && durationMs > 0) {
    // ~1 hop / 350ms absolute floor; reject insanely fast high scores
    if (score >= 10 && durationMs < score * 250) {
      return res.status(400).json({ error: '用时过短，分数未采纳' });
    }
  }

  const alias = jumpAliasFor(req);
  const prev = await db.get('SELECT * FROM jump_scores WHERE user_id = ?', req.user.id);
  const prevBest = prev ? Number(prev.best_score) : 0;
  if (score > prevBest + JUMP_MAX_DELTA && score > 30) {
    return res.status(400).json({ error: '单局提升过大，请再接再厉（分次刷新纪录）' });
  }

  let best = prevBest;
  let isNewBest = false;
  if (!prev) {
    await db.run(
      `INSERT INTO jump_scores (user_id, best_score, games_played, alias, best_at, updated_at)
       VALUES (?, ?, 1, ?, ${NOW}, ${NOW})`,
      req.user.id, score, alias
    );
    best = score;
    isNewBest = score > 0;
  } else {
    isNewBest = score > prevBest;
    best = Math.max(prevBest, score);
    if (isNewBest) {
      await db.run(
        `UPDATE jump_scores SET best_score = ?, games_played = games_played + 1, alias = ?, best_at = ${NOW}, updated_at = ${NOW}
         WHERE user_id = ?`,
        score, alias, req.user.id
      );
    } else {
      await db.run(
        `UPDATE jump_scores SET games_played = games_played + 1, alias = ?, updated_at = ${NOW}
         WHERE user_id = ?`,
        alias, req.user.id
      );
    }
  }

  const keys = ['jump_newbie'];
  if (best >= achievements.JUMP_PRO_SCORE) keys.push('jump_pro');
  const newly = await notifyAchievements(req.user.id, keys);

  const row = await db.get('SELECT * FROM jump_scores WHERE user_id = ?', req.user.id);
  res.json({
    ok: true,
    best: Number(row.best_score),
    gamesPlayed: Number(row.games_played),
    isNewBest,
    accepted: score,
    newBadges: newly,
  });
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
  try {
    const bf = await achievements.backfillAll(db);
    if (bf.awarded) console.log(`成就回填: 为 ${bf.members} 名成员补发 ${bf.awarded} 枚勋章`);
  } catch (e) {
    console.error('成就回填失败:', e.message);
  }
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
