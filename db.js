/**
 * Async DB layer.
 *  - DATABASE_URL set  -> PostgreSQL (pg)  [used on Render]
 *  - otherwise         -> SQLite via node:sqlite (local fallback, Node >= 22)
 *
 * API (all async):
 *   db.get(sql, ...params) / db.all(sql, ...params) / db.run(sql, ...params)
 *   db.transaction(async (tx) => { await tx.get(...) ... })
 * SQL is written in SQLite style with "?" placeholders and NOW_SQL for current time;
 * it is translated for Postgres automatically.
 */
const path = require('path');
const fs = require('fs');

const isPg = !!process.env.DATABASE_URL;

const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','member')),
  display_name TEXT,
  card_rank TEXT,
  card_suit TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  invite_code_used TEXT
);
CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_by INTEGER,
  used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('suggestion','request')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','handled')),
  admin_reply TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  handled_at TEXT
);
CREATE TABLE IF NOT EXISTS ws_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_invite_unused ON invite_codes(revoked, used_by);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status);

CREATE TABLE IF NOT EXISTS login_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  username TEXT,
  user_id INTEGER,
  ip TEXT,
  user_agent TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON login_audit(created_at);
CREATE TABLE IF NOT EXISTS login_throttle (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  first_fail_at TEXT,
  locked_until TEXT
);
CREATE TABLE IF NOT EXISTS user_sessions (
  sid TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
`;

const PG_NOW = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS')`;

const SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','member')),
  display_name TEXT,
  card_rank TEXT,
  card_suit TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${PG_NOW}),
  invite_code_used TEXT
);
CREATE TABLE IF NOT EXISTS invite_codes (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (${PG_NOW}),
  used_by INTEGER,
  used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS suggestions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('suggestion','request')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','handled')),
  admin_reply TEXT,
  created_at TEXT NOT NULL DEFAULT (${PG_NOW}),
  handled_at TEXT
);
CREATE TABLE IF NOT EXISTS ws_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_invite_unused ON invite_codes(revoked, used_by);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status);

CREATE TABLE IF NOT EXISTS login_audit (
  id SERIAL PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (${PG_NOW}),
  username TEXT,
  user_id INTEGER,
  ip TEXT,
  user_agent TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON login_audit(created_at);
CREATE TABLE IF NOT EXISTS login_throttle (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  first_fail_at TEXT,
  locked_until TEXT
);
CREATE TABLE IF NOT EXISTS user_sessions (
  sid TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (${PG_NOW}),
  last_seen TEXT NOT NULL DEFAULT (${PG_NOW})
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
`;

/** Current-time expression usable inside SQL strings. */
const NOW = isPg ? PG_NOW : `datetime('now')`;

/** Columns added after the first release (migrated on boot). */
const NEW_COLUMNS = [
  ['users', 'totp_secret', 'TEXT'],
  ['users', 'totp_pending_secret', 'TEXT'],
  ['users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'totp_last_step', 'INTEGER'],
  ['users', 'password_changed_at', 'TEXT'],
  ['invite_codes', 'expires_at', 'TEXT'],
  ['invite_codes', 'note', 'TEXT'],
  ['login_audit', 'detail', 'TEXT'],
  ['users', 'invited_by', 'INTEGER'],
  // 1 = member-issued code, subject to the "one active code per member" rule
  ['invite_codes', 'member_limited', 'INTEGER NOT NULL DEFAULT 0'],
  ['ws_tokens', 'alias', 'TEXT'],
  ['user_sessions', 'chat_alias', 'TEXT'],
];

/** Post-column migrations (idempotent; same SQL works on SQLite and Postgres). */

const CHAT_SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  role TEXT NOT NULL,
  msg_type TEXT NOT NULL CHECK(msg_type IN ('text','image')),
  content TEXT,
  image_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id);
CREATE TABLE IF NOT EXISTS chat_images (
  key TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chat_mutes (
  user_id INTEGER PRIMARY KEY,
  muted_until TEXT,
  muted_by INTEGER,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const CHAT_SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  role TEXT NOT NULL,
  msg_type TEXT NOT NULL CHECK(msg_type IN ('text','image')),
  content TEXT,
  image_key TEXT,
  created_at TEXT NOT NULL DEFAULT (${PG_NOW}),
  deleted_at TEXT,
  deleted_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id);
CREATE TABLE IF NOT EXISTS chat_images (
  key TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  bytes BYTEA NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${PG_NOW})
);
CREATE TABLE IF NOT EXISTS chat_mutes (
  user_id INTEGER PRIMARY KEY,
  muted_until TEXT,
  muted_by INTEGER,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (${PG_NOW})
);
`;


const ANNOUNCE_SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ann_pin_id ON announcements(pinned, id);
CREATE TABLE IF NOT EXISTS announcement_reads (
  user_id INTEGER NOT NULL,
  announcement_id INTEGER NOT NULL,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, announcement_id)
);
CREATE TABLE IF NOT EXISTS user_achievements (
  user_id INTEGER NOT NULL,
  badge_key TEXT NOT NULL,
  unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, badge_key)
);
CREATE INDEX IF NOT EXISTS idx_ach_user ON user_achievements(user_id);
CREATE TABLE IF NOT EXISTS jump_scores (
  user_id INTEGER PRIMARY KEY,
  best_score INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  alias TEXT,
  best_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jump_best ON jump_scores(best_score DESC);
`;


const ANNOUNCE_SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${PG_NOW}),
  updated_at TEXT NOT NULL DEFAULT (${PG_NOW}),
  expires_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ann_pin_id ON announcements(pinned, id);
CREATE TABLE IF NOT EXISTS announcement_reads (
  user_id INTEGER NOT NULL,
  announcement_id INTEGER NOT NULL,
  read_at TEXT NOT NULL DEFAULT (${PG_NOW}),
  PRIMARY KEY (user_id, announcement_id)
);
CREATE TABLE IF NOT EXISTS user_achievements (
  user_id INTEGER NOT NULL,
  badge_key TEXT NOT NULL,
  unlocked_at TEXT NOT NULL DEFAULT (${PG_NOW}),
  PRIMARY KEY (user_id, badge_key)
);
CREATE INDEX IF NOT EXISTS idx_ach_user ON user_achievements(user_id);
CREATE TABLE IF NOT EXISTS jump_scores (
  user_id INTEGER PRIMARY KEY,
  best_score INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  alias TEXT,
  best_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (${PG_NOW})
);
CREATE INDEX IF NOT EXISTS idx_jump_best ON jump_scores(best_score DESC);
`;

const POST_MIGRATIONS = [
  // Race-safe guard: at most one active (unused, unrevoked) member-issued code per creator.
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_member_active_invite ON invite_codes(created_by)
     WHERE member_limited = 1 AND used_by IS NULL AND revoked = 0`,
  // Backfill inviter for existing members from the invite-code records (only fills NULLs).
  `UPDATE users SET invited_by = (
       SELECT i.created_by FROM invite_codes i
       WHERE i.used_by = users.id OR (users.invite_code_used IS NOT NULL AND i.code = users.invite_code_used)
       ORDER BY i.id LIMIT 1)
     WHERE invited_by IS NULL AND role = 'member'`,
];

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

let backend;

if (isPg) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });
  pool.on('error', (e) => console.error('pg pool error', e.message));

  const make = (q) => ({
    async get(sql, ...p) { return (await q(toPg(sql), p)).rows[0]; },
    async all(sql, ...p) { return (await q(toPg(sql), p)).rows; },
    async run(sql, ...p) {
      let s = toPg(sql);
      const isInsert = /^\s*insert/i.test(s) && !/returning/i.test(s) && !/insert\s+into\s+(ws_tokens|user_sessions|login_throttle|chat_images|chat_mutes|announcement_reads|user_achievements|jump_scores)/i.test(s);
      if (isInsert) s += ' RETURNING id';
      const r = await q(s, p);
      return { changes: r.rowCount, lastInsertRowid: isInsert && r.rows[0] ? Number(r.rows[0].id) : undefined };
    },
  });

  backend = {
    ...make((s, p) => pool.query(s, p)),
    async init() {
      await pool.query(SCHEMA_PG);
      await pool.query(CHAT_SCHEMA_PG);
      await pool.query(ANNOUNCE_SCHEMA_PG);
      for (const [t, c, type] of NEW_COLUMNS) {
        await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} ${type}`);
      }
      for (const m of POST_MIGRATIONS) await pool.query(m);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(make((s, p) => client.query(s, p)));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
      } finally {
        client.release();
      }
    },
    pool,
  };
} else {
  const { DatabaseSync } = require('node:sqlite');
  const DATA_DIR = path.join(__dirname, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const sdb = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
  sdb.exec('PRAGMA journal_mode = WAL');

  const ops = {
    async get(sql, ...p) { return sdb.prepare(sql).get(...p); },
    async all(sql, ...p) { return sdb.prepare(sql).all(...p); },
    async run(sql, ...p) {
      const r = sdb.prepare(sql).run(...p);
      return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    },
  };
  let chain = Promise.resolve();
  backend = {
    ...ops,
    async init() {
      sdb.exec(SCHEMA_SQLITE);
      sdb.exec(CHAT_SCHEMA_SQLITE);
      sdb.exec(ANNOUNCE_SCHEMA_SQLITE);
      for (const [t, c, type] of NEW_COLUMNS) {
        const cols = sdb.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
        if (!cols.includes(c)) sdb.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`);
      }
      for (const m of POST_MIGRATIONS) sdb.exec(m);
    },
    // serialize transactions so concurrent async callers don't interleave
    transaction(fn) {
      const run = async () => {
        sdb.exec('BEGIN');
        try {
          const r = await fn(ops);
          sdb.exec('COMMIT');
          return r;
        } catch (e) {
          try { sdb.exec('ROLLBACK'); } catch (_) {}
          throw e;
        }
      };
      const p = chain.then(run, run);
      chain = p.catch(() => {});
      return p;
    },
  };
}

module.exports = { ...backend, isPg, NOW };
