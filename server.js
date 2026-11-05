const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const db = require('./db');
const { NOW } = db;
const {
  hashPassword,
  verifyPassword,
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
app.set('trust proxy', 1);

/** Wrap async route handlers so errors reach Express. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

let store;
if (db.isPg) {
  const PgSession = require('connect-pg-simple')(session);
  store = new PgSession({ pool: db.pool, tableName: 'session', createTableIfMissing: false });
}
app.use(
  session({
    name: 'card.sid',
    secret: SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: SECURE_COOKIE,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });
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
    createdAt: u.created_at,
  };
  if (includeCard) {
    base.card = publicCard(u.card_rank, u.card_suit);
  }
  return base;
}

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

app.post('/api/login', ah(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });
  const user = await findUserByUsername(String(username).trim());
  if (!user || !verifyPassword(String(password), user.password_hash)) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  if (user.disabled) return res.status(403).json({ error: '账号已被停用' });
  req.session.userId = user.id;
  req.session.role = user.role;
  await saveSession(req);
  res.json({ user: sanitizeUser(user), wsToken: await issueWsToken(user.id) });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('card.sid');
    res.json({ ok: true });
  });
});

app.post('/api/register', ah(async (req, res) => {
  const { username, password, inviteCode, displayName } = req.body || {};
  if (!username || !password || !inviteCode) {
    return res.status(400).json({ error: '请填写用户名、密码和邀请码' });
  }
  const uname = String(username).trim();
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,24}$/.test(uname)) {
    return res.status(400).json({ error: '用户名需 2–24 位字母/数字/下划线/中文' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  const code = String(inviteCode).trim().toUpperCase();

  const invite = await db.get('SELECT * FROM invite_codes WHERE code = ?', code);
  if (!invite) return res.status(400).json({ error: '邀请码无效' });
  if (invite.revoked) return res.status(400).json({ error: '邀请码已被撤销' });
  if (invite.used_by) return res.status(400).json({ error: '邀请码已被使用' });

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
        displayName ? String(displayName).trim().slice(0, 40) : uname,
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
  req.session.userId = user.id;
  req.session.role = user.role;
  await saveSession(req);
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

app.post('/api/my/suggestions', requireAuth, ah(async (req, res) => {
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
  if (disabled) sendToUser(id, { type: 'force_logout', reason: '账号已被停用' });
  res.json({ ok: true, disabled: !!disabled });
}));

app.delete('/api/admin/members/:id', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const member = await findUserById(id);
  if (!member || member.role !== 'member') return res.status(404).json({ error: '成员不存在' });
  await db.transaction(async (tx) => {
    await tx.run(`DELETE FROM suggestions WHERE user_id = ?`, id);
    await tx.run(`DELETE FROM ws_tokens WHERE user_id = ?`, id);
    await tx.run(`UPDATE invite_codes SET used_by = NULL, used_at = NULL WHERE used_by = ?`, id);
    await tx.run(`DELETE FROM users WHERE id = ?`, id);
  });
  sendToUser(id, { type: 'force_logout', reason: '账号已被删除' });
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
      status: r.revoked ? 'revoked' : r.used_by ? 'used' : 'unused',
    })),
  });
}));

app.post('/api/admin/invites', requireAdmin, ah(async (req, res) => {
  const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 20);
  const codes = [];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = generateInviteCode();
      try {
        await db.run(`INSERT INTO invite_codes (code, created_by) VALUES (?, ?)`, code, req.user.id);
        codes.push(code);
        break;
      } catch (_) {
        /* unique collision */
      }
    }
  }
  res.json({ codes });
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
app.get(['/', '/login', '/register', '/admin', '/member'], (_req, res) => {
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
