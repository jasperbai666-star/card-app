/**
 * Anonymous chat: aliases, contact-info heuristics, message shaping.
 * Members never see real identities; admins see the mapping in the moderation view.
 */
const crypto = require('crypto');

const SUITS = [
  { id: 'heart', label: '红心' },
  { id: 'diamond', label: '方块' },
  { id: 'club', label: '梅花' },
  { id: 'spade', label: '黑桃' },
];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const CODENAMES = [
  '暗影', '金箔', '雾港', '星尘', '夜航', '霜刃', '青石', '琥珀',
  '银鸦', '赤焰', '墨兰', '雪原', '玄铁', '流萤', '孤舟', '残阳',
  '苍穹', '碧落', '玉衡', '天机', '隐川', '空庭', '折光', '无阶',
];

const MAX_TEXT_LEN = 500;
const MAX_IMAGE_BYTES = 1024 * 1024; // 1 MiB
const ALLOWED_IMAGE = {
  'image/jpeg': { ext: 'jpg', magics: [[0xff, 0xd8, 0xff]] },
  'image/png': { ext: 'png', magics: [[0x89, 0x50, 0x4e, 0x47]] },
  'image/webp': { ext: 'webp', magics: [[0x52, 0x49, 0x46, 0x46]] }, // RIFF....WEBP
  'image/gif': { ext: 'gif', magics: [[0x47, 0x49, 0x46, 0x38]] },
};

/** Stable-looking random alias for one login session. Admin always displays as 管理员. */
function generateAlias(role) {
  if (role === 'admin') return '管理员';
  if (crypto.randomInt(100) < 70) {
    const s = SUITS[crypto.randomInt(SUITS.length)];
    const r = RANKS[crypto.randomInt(RANKS.length)];
    return `${s.label}${r}`;
  }
  const name = CODENAMES[crypto.randomInt(CODENAMES.length)];
  const n = crypto.randomInt(10, 99);
  return `${name}${n}`;
}

function looksLikeContactInfo(text) {
  const t = String(text || '');
  // emails
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(t)) {
    return '消息疑似包含邮箱地址，匿名聊天室禁止交换联系方式';
  }
  // China mobile / landline-ish digit runs
  if (/(?:\+?86[-\s]?)?1[3-9]\d{9}/.test(t.replace(/[\s\-]/g, ''))) {
    return '消息疑似包含手机号码，匿名聊天室禁止交换联系方式';
  }
  if (/(?:微信|weixin|wechat|wx|qq|扣扣|企鹅号)\s*[:：=是]?\s*[a-zA-Z][a-zA-Z0-9_-]{5,19}/i.test(t)) {
    return '消息疑似包含微信号或其他联系方式，匿名聊天室禁止交换联系方式';
  }
  // bare wechat-like ids after 加/找
  if (/(?:加|找|联系)(?:我|下)?(?:的)?(?:微信|vx|wx)\s*[a-zA-Z0-9_-]{6,20}/i.test(t)) {
    return '消息疑似包含联系方式，匿名聊天室禁止交换联系方式';
  }
  return null;
}

function validateText(raw) {
  if (raw == null) return { ok: false, error: '请输入内容' };
  const text = String(raw).replace(/\r\n/g, '\n').trim();
  if (!text) return { ok: false, error: '请输入内容' };
  if (text.length > MAX_TEXT_LEN) return { ok: false, error: `消息过长（最多 ${MAX_TEXT_LEN} 字）` };
  const blocked = looksLikeContactInfo(text);
  if (blocked) return { ok: false, error: blocked };
  return { ok: true, text };
}

function sniffImage(buf, declaredType) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return { ok: false, error: '图片无效' };
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, error: '图片过大（最大 1MB）' };
  const type = String(declaredType || '').toLowerCase().split(';')[0].trim();
  const spec = ALLOWED_IMAGE[type];
  if (!spec) return { ok: false, error: '仅支持 JPG / PNG / WebP / GIF' };
  const match = spec.magics.some((m) => m.every((b, i) => buf[i] === b));
  if (!match) return { ok: false, error: '图片内容与类型不符' };
  if (type === 'image/webp' && buf.slice(8, 12).toString('ascii') !== 'WEBP') {
    return { ok: false, error: '图片内容与类型不符' };
  }
  // Reject SVG disguised somehow (text start)
  const head = buf.slice(0, 256).toString('utf8').toLowerCase();
  if (head.includes('<svg') || head.includes('<?xml') || head.includes('<html')) {
    return { ok: false, error: '不支持该图片格式' };
  }
  return { ok: true, mime: type, ext: spec.ext };
}

function newImageKey() {
  return crypto.randomBytes(18).toString('hex');
}

/** Shape a DB row for a member (no identity). */
function publicMessage(row) {
  const isAdmin = row.role === 'admin';
  return {
    id: row.id,
    alias: isAdmin ? '管理员' : row.alias,
    role: isAdmin ? 'admin' : 'member',
    type: row.msg_type,
    text: row.msg_type === 'image' ? null : row.content,
    imageKey: row.msg_type === 'image' ? row.image_key : null,
    createdAt: row.created_at,
  };
}

/** Shape a DB row for an admin (includes identity mapping). */
function adminMessage(row) {
  return {
    ...publicMessage(row),
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name || row.username,
    deletedAt: row.deleted_at || null,
  };
}

const EMOJI_PRESET = [
  '😀','😁','😂','🤣','😊','😍','😘','😎','🤩','🤗',
  '😏','😌','😴','🤔','🤨','😐','😑','😶','🙄','😮',
  '😲','😳','🥺','😢','😭','😤','😠','🤯','🥳','🤠',
  '🤡','👻','💀','👽','🤖','💩','🔥','✨','⭐','💯',
  '👍','👎','👏','🙌','🤝','✌️','🤞','👊','✊','💪',
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','💕',
  '♠️','♥️','♦️','♣️','🃏','🎴','🂡','🎯','🏆','🎲',
  '🎉','🎊','🎁','☕','🍺','🍾','🍕','🍰','🌙','☀️',
];

module.exports = {
  generateAlias,
  looksLikeContactInfo,
  validateText,
  sniffImage,
  newImageKey,
  publicMessage,
  adminMessage,
  EMOJI_PRESET,
  MAX_TEXT_LEN,
  MAX_IMAGE_BYTES,
  ALLOWED_IMAGE,
};
