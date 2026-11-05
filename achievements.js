/**
 * Achievement badges — awarded server-side only; never trust the client.
 * Keys are stable; Chinese names/descriptions are what members see.
 */
const { levelOf } = require('./cards');

const BADGES = [
  {
    key: 'first_login',
    name: '新成员报到',
    description: '完成首次登录，正式加入卡牌俱乐部。',
    icon: '👋',
  },
  {
    key: 'first_chat',
    name: '首次发言',
    description: '在匿名聊天室发出过一条文字消息。',
    icon: '💬',
  },
  {
    key: 'image_master',
    name: '图片达人',
    description: '在匿名聊天室成功发送过一张图片。',
    icon: '🖼️',
  },
  {
    key: 'invite_1',
    name: '邀请先锋',
    description: '成功邀请 1 位新成员加入。',
    icon: '🎟️',
  },
  {
    key: 'invite_3',
    name: '人脉扩展',
    description: '成功邀请 3 位新成员加入。',
    icon: '🌐',
  },
  {
    key: 'suggestion',
    name: '建言献策',
    description: '向管理员提交过建议或要求。',
    icon: '📝',
  },
  {
    key: 'high_card',
    name: '高阶牌面',
    description: '当前牌面达到 Q / K / 小王 / 大王。',
    icon: '👑',
  },
];

const BADGE_MAP = Object.fromEntries(BADGES.map((b) => [b.key, b]));

/** Q=12 and above count as 高阶牌面. */
const HIGH_CARD_LEVEL = 12;

function publicBadge(def, unlockedAt = null) {
  return {
    key: def.key,
    name: def.name,
    description: def.description,
    icon: def.icon,
    unlocked: !!unlockedAt,
    unlockedAt: unlockedAt || null,
  };
}

/**
 * Award zero or more badges. Returns only the newly unlocked ones (public shape).
 * @param {import('./db')} db
 * @param {number} userId
 * @param {string[]} keys
 */
async function award(db, userId, keys) {
  const uniq = [...new Set((keys || []).filter((k) => BADGE_MAP[k]))];
  if (!userId || !uniq.length) return [];
  const newly = [];
  for (const key of uniq) {
    try {
      const existing = await db.get(
        'SELECT badge_key, unlocked_at FROM user_achievements WHERE user_id = ? AND badge_key = ?',
        userId,
        key
      );
      if (existing) continue;
      await db.run(
        `INSERT INTO user_achievements (user_id, badge_key, unlocked_at) VALUES (?, ?, ${db.NOW})`,
        userId,
        key
      );
      const row = await db.get(
        'SELECT unlocked_at FROM user_achievements WHERE user_id = ? AND badge_key = ?',
        userId,
        key
      );
      newly.push(publicBadge(BADGE_MAP[key], row?.unlocked_at || true));
    } catch (e) {
      // Unique race: treat as already owned.
      if (!/unique|duplicate/i.test(String(e.message || e))) throw e;
    }
  }
  return newly;
}

/** Full catalog for one user: locked + unlocked. */
async function listForUser(db, userId) {
  const rows = await db.all(
    'SELECT badge_key, unlocked_at FROM user_achievements WHERE user_id = ?',
    userId
  );
  const have = Object.fromEntries(rows.map((r) => [r.badge_key, r.unlocked_at]));
  return BADGES.map((b) => publicBadge(b, have[b.key] || null));
}

/** Compact summary for admin member list. */
async function summaryForUsers(db, userIds) {
  const out = {};
  for (const id of userIds) out[id] = { unlocked: 0, total: BADGES.length, keys: [] };
  if (!userIds.length) return out;
  // Fetch in one query; build IN list carefully (ints only).
  const ids = userIds.map(Number).filter((n) => Number.isFinite(n));
  if (!ids.length) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT user_id, badge_key FROM user_achievements WHERE user_id IN (${placeholders})`,
    ...ids
  );
  for (const r of rows) {
    const s = out[r.user_id];
    if (!s) continue;
    if (!BADGE_MAP[r.badge_key]) continue;
    s.unlocked += 1;
    s.keys.push(r.badge_key);
  }
  return out;
}

/**
 * Idempotent backfill from existing data. Only writes achievement rows.
 * @returns {{ awarded: number }}
 */
async function backfillAll(db) {
  const members = await db.all("SELECT id, card_rank FROM users WHERE role = 'member'");
  let awarded = 0;

  for (const m of members) {
    const keys = [];
    // Any existing member has "logged in" enough to count as 新成员报到.
    keys.push('first_login');

    const textMsg = await db.get(
      `SELECT id FROM chat_messages WHERE user_id = ? AND msg_type = 'text' AND deleted_at IS NULL LIMIT 1`,
      m.id
    );
    if (textMsg) keys.push('first_chat');

    const imgMsg = await db.get(
      `SELECT id FROM chat_messages WHERE user_id = ? AND msg_type = 'image' AND deleted_at IS NULL LIMIT 1`,
      m.id
    );
    if (imgMsg) keys.push('image_master');

    const inviteCount = await db.get(
      `SELECT COUNT(*) AS c FROM users WHERE invited_by = ? AND role = 'member'`,
      m.id
    );
    const n = Number(inviteCount?.c || 0);
    if (n >= 1) keys.push('invite_1');
    if (n >= 3) keys.push('invite_3');

    const sug = await db.get(`SELECT id FROM suggestions WHERE user_id = ? LIMIT 1`, m.id);
    if (sug) keys.push('suggestion');

    if (levelOf(m.card_rank) >= HIGH_CARD_LEVEL) keys.push('high_card');

    const neu = await award(db, m.id, keys);
    awarded += neu.length;
  }
  return { awarded, members: members.length };
}

module.exports = {
  BADGES,
  BADGE_MAP,
  HIGH_CARD_LEVEL,
  publicBadge,
  award,
  listForUser,
  summaryForUsers,
  backfillAll,
};
