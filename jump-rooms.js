/**
 * Multiplayer 跳一跳 rooms — WeChat party style.
 *
 * Rules (documented in UI):
 *  - Shared seeded map for the round (everyone faces the same platforms).
 *  - Continuous-until-miss: on your turn you keep jumping; miss ends your turn.
 *  - Next player then starts from the same map origin (fair comparison).
 *  - When every player has finished their turn → finished; highest score wins.
 *  - Rematch: new seed, scores reset, lobby waiting.
 */
'use strict';

const crypto = require('crypto');
const phys = require('./jump-physics');

const MAX_PLAYERS = 8;
const MIN_START = 2;
const CODE_LEN = 6;
const IDLE_MS = 30 * 60 * 1000; // expire after 30 min idle
const PLATFORM_COUNT = 120;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

/** @type {Map<string, object>} */
const rooms = new Map();

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function makeCode() {
  let s = '';
  const bytes = crypto.randomBytes(CODE_LEN);
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

function publicPlayer(p, { isAdmin = false } = {}) {
  const out = {
    userId: p.userId,
    alias: p.alias,
    role: p.role,
    ready: !!p.ready,
    score: p.score,
    hops: p.hops,
    finished: !!p.finished,
    online: !!p.online,
    isHost: !!p.isHost,
  };
  if (isAdmin) {
    out.username = p.username;
    out.displayName = p.displayName;
  }
  return out;
}

function roomPublic(room, viewer = null) {
  const isAdmin = viewer && viewer.role === 'admin';
  const players = room.players.map((p) => publicPlayer(p, { isAdmin }));
  const me = viewer ? room.players.find((p) => p.userId === viewer.id) : null;
  return {
    code: room.code,
    status: room.status, // waiting | playing | finished
    hostId: room.hostId,
    seed: room.seed,
    turnUserId: room.turnUserId,
    turnOrder: room.turnOrder,
    maxPlayers: MAX_PLAYERS,
    minStart: MIN_START,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    players,
    winnerUserId: room.winnerUserId || null,
    rules: {
      title: '轮流上场 · 连续跳到踩空',
      body: '全员共用同一张地图。轮到你时连续蓄力跳跃，踩空则本回合结束，换下一位从起点再跳。全部跳完后最高分获胜。',
    },
    me: me ? {
      userId: me.userId,
      ready: me.ready,
      isHost: me.isHost,
      isMyTurn: room.status === 'playing' && room.turnUserId === me.userId && !me.finished,
      score: me.score,
      finished: me.finished,
    } : null,
    // enough platforms for clients to render ahead
    platformsPreview: room.platforms ? room.platforms.slice(0, 16).map((pl) => ({
      x: pl.x, z: pl.z, size: pl.size, kind: pl.kind, hue: pl.hue,
    })) : null,
  };
}

function touch(room) {
  room.updatedAt = nowIso();
  room._lastActive = Date.now();
}

function getRoom(code) {
  if (!code) return null;
  return rooms.get(String(code).toUpperCase()) || null;
}

function findUserRoom(userId) {
  for (const room of rooms.values()) {
    if (room.players.some((p) => p.userId === userId && p.online !== false)) return room;
  }
  return null;
}

async function persistRoom(db, room) {
  if (!db) return;
  const expires = new Date(Date.now() + IDLE_MS).toISOString().replace('T', ' ').slice(0, 19);
  const existing = await db.get('SELECT code FROM jump_rooms WHERE code = ?', room.code);
  if (!existing) {
    await db.run(
      `INSERT INTO jump_rooms (code, host_id, status, seed, turn_user_id, max_players, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      room.code, room.hostId, room.status, room.seed, room.turnUserId, MAX_PLAYERS,
      room.createdAt, room.updatedAt, expires
    );
  } else {
    await db.run(
      `UPDATE jump_rooms SET host_id = ?, status = ?, seed = ?, turn_user_id = ?, updated_at = ?, expires_at = ?
       WHERE code = ?`,
      room.hostId, room.status, room.seed, room.turnUserId, room.updatedAt, expires, room.code
    );
  }
  for (const p of room.players) {
    const row = await db.get(
      'SELECT user_id FROM jump_room_players WHERE room_code = ? AND user_id = ?',
      room.code, p.userId
    );
    if (!row) {
      await db.run(
        `INSERT INTO jump_room_players (room_code, user_id, alias, role, ready, score, hops, finished, is_host, joined_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        room.code, p.userId, p.alias, p.role, p.ready ? 1 : 0, p.score, p.hops,
        p.finished ? 1 : 0, p.isHost ? 1 : 0, p.joinedAt, room.updatedAt
      );
    } else {
      await db.run(
        `UPDATE jump_room_players SET alias = ?, ready = ?, score = ?, hops = ?, finished = ?, is_host = ?, updated_at = ?
         WHERE room_code = ? AND user_id = ?`,
        p.alias, p.ready ? 1 : 0, p.score, p.hops, p.finished ? 1 : 0, p.isHost ? 1 : 0,
        room.updatedAt, room.code, p.userId
      );
    }
  }
}

async function createRoom(db, { user, alias }) {
  // leave any other room first
  const existing = findUserRoom(user.id);
  if (existing) await leaveRoom(db, existing.code, user.id);

  let code = makeCode();
  for (let i = 0; i < 8 && rooms.has(code); i++) code = makeCode();
  if (rooms.has(code)) throw Object.assign(new Error('房间码冲突，请重试'), { status: 503 });

  const ts = nowIso();
  const room = {
    code,
    hostId: user.id,
    status: 'waiting',
    seed: null,
    platforms: null,
    turnUserId: null,
    turnOrder: [],
    winnerUserId: null,
    createdAt: ts,
    updatedAt: ts,
    _lastActive: Date.now(),
    _turnState: null, // { currentIdx, score, hops, combo } for active turn
    players: [{
      userId: user.id,
      alias: user.role === 'admin' ? '管理员' : (alias || '匿名玩家'),
      role: user.role,
      username: user.username,
      displayName: user.display_name || user.username,
      ready: true, // host auto-ready
      score: 0,
      hops: 0,
      finished: false,
      online: true,
      isHost: true,
      joinedAt: ts,
    }],
  };
  rooms.set(code, room);
  try { await persistRoom(db, room); } catch (e) { console.error('persist create room', e.message); }
  return room;
}

async function joinRoom(db, code, { user, alias }) {
  const room = getRoom(code);
  if (!room) throw Object.assign(new Error('房间不存在或已过期'), { status: 404 });
  touch(room);
  if (room.status === 'finished') throw Object.assign(new Error('本局已结束，请让房主再来一局'), { status: 409 });

  const already = room.players.find((p) => p.userId === user.id);
  if (already) {
    already.online = true;
    already.alias = user.role === 'admin' ? '管理员' : (alias || already.alias);
    already.username = user.username;
    already.displayName = user.display_name || user.username;
    try { await persistRoom(db, room); } catch (_) {}
    return room;
  }

  // leave other room
  const other = findUserRoom(user.id);
  if (other && other.code !== room.code) await leaveRoom(db, other.code, user.id);

  if (room.status === 'playing') throw Object.assign(new Error('对局已开始，无法中途加入'), { status: 409 });
  if (room.players.length >= MAX_PLAYERS) throw Object.assign(new Error('房间已满'), { status: 409 });

  const ts = nowIso();
  room.players.push({
    userId: user.id,
    alias: user.role === 'admin' ? '管理员' : (alias || '匿名玩家'),
    role: user.role,
    username: user.username,
    displayName: user.display_name || user.username,
    ready: false,
    score: 0,
    hops: 0,
    finished: false,
    online: true,
    isHost: false,
    joinedAt: ts,
  });
  try { await persistRoom(db, room); } catch (_) {}
  return room;
}

async function leaveRoom(db, code, userId) {
  const room = getRoom(code);
  if (!room) return null;
  touch(room);
  const idx = room.players.findIndex((p) => p.userId === userId);
  if (idx < 0) return room;
  const wasHost = room.players[idx].isHost;
  room.players.splice(idx, 1);

  if (db) {
    try { await db.run('DELETE FROM jump_room_players WHERE room_code = ? AND user_id = ?', room.code, userId); } catch (_) {}
  }

  if (!room.players.length) {
    rooms.delete(room.code);
    if (db) {
      try {
        await db.run('DELETE FROM jump_room_players WHERE room_code = ?', room.code);
        await db.run('DELETE FROM jump_rooms WHERE code = ?', room.code);
      } catch (_) {}
    }
    return null;
  }

  if (wasHost || room.hostId === userId) {
    room.players[0].isHost = true;
    room.players[0].ready = true;
    room.hostId = room.players[0].userId;
  }

  // if playing and leaver was current turn → advance
  if (room.status === 'playing') {
    room.turnOrder = room.turnOrder.filter((id) => id !== userId);
    if (room.turnUserId === userId) advanceTurn(room);
    if (room.players.every((p) => p.finished) || !room.turnOrder.length) finishRound(room);
  }

  try { await persistRoom(db, room); } catch (_) {}
  return room;
}

async function setReady(db, code, userId, ready) {
  const room = getRoom(code);
  if (!room) throw Object.assign(new Error('房间不存在'), { status: 404 });
  if (room.status !== 'waiting') throw Object.assign(new Error('对局进行中'), { status: 409 });
  const p = room.players.find((x) => x.userId === userId);
  if (!p) throw Object.assign(new Error('你不在此房间'), { status: 403 });
  p.ready = !!ready;
  if (p.isHost) p.ready = true;
  touch(room);
  try { await persistRoom(db, room); } catch (_) {}
  return room;
}

async function kick(db, code, hostId, targetId) {
  const room = getRoom(code);
  if (!room) throw Object.assign(new Error('房间不存在'), { status: 404 });
  if (room.hostId !== hostId) throw Object.assign(new Error('只有房主可以踢人'), { status: 403 });
  if (targetId === hostId) throw Object.assign(new Error('不能踢自己'), { status: 400 });
  if (room.status === 'playing') throw Object.assign(new Error('对局中无法踢人'), { status: 409 });
  return leaveRoom(db, code, targetId);
}

function beginTurn(room, userId) {
  room.turnUserId = userId;
  room._turnState = { currentIdx: 0, score: 0, hops: 0, combo: 0 };
  const p = room.players.find((x) => x.userId === userId);
  if (p) {
    p.score = 0;
    p.hops = 0;
    p.finished = false;
  }
}

function nextUnfinishedAfter(room, afterId) {
  const order = room.turnOrder;
  const start = Math.max(0, order.indexOf(afterId));
  for (let i = 1; i <= order.length; i++) {
    const id = order[(start + i) % order.length];
    const pl = room.players.find((p) => p.userId === id);
    if (pl && !pl.finished) return id;
  }
  return null;
}

function advanceTurn(room) {
  const nextId = nextUnfinishedAfter(room, room.turnUserId);
  if (!nextId) {
    room.turnUserId = null;
    room._turnState = null;
    return false;
  }
  beginTurn(room, nextId);
  return true;
}

function finishRound(room) {
  room.status = 'finished';
  room.turnUserId = null;
  room._turnState = null;
  let best = -1;
  let winner = null;
  for (const p of room.players) {
    if (p.score > best) { best = p.score; winner = p.userId; }
  }
  room.winnerUserId = winner;
  touch(room);
}

async function startGame(db, code, hostId) {
  const room = getRoom(code);
  if (!room) throw Object.assign(new Error('房间不存在'), { status: 404 });
  if (room.hostId !== hostId) throw Object.assign(new Error('只有房主可以开始'), { status: 403 });
  if (room.status !== 'waiting') throw Object.assign(new Error('已经开始或已结束'), { status: 409 });
  if (room.players.length < MIN_START) throw Object.assign(new Error(`至少 ${MIN_START} 人才能开始`), { status: 400 });
  const notReady = room.players.filter((p) => !p.ready);
  if (notReady.length) throw Object.assign(new Error('还有玩家未准备'), { status: 400 });

  room.seed = (crypto.randomBytes(4).readUInt32BE(0) % 2147483646) + 1;
  room.platforms = phys.generatePlatforms(room.seed, PLATFORM_COUNT).map(phys.colorize);
  room.status = 'playing';
  room.winnerUserId = null;
  room.turnOrder = room.players.map((p) => p.userId);
  for (const p of room.players) {
    p.score = 0;
    p.hops = 0;
    p.finished = false;
  }
  beginTurn(room, room.turnOrder[0]);
  touch(room);
  try { await persistRoom(db, room); } catch (_) {}
  return room;
}

/**
 * Submit a jump (server-authoritative).
 * @returns {{ room, result, event }}
 */
async function submitJump(db, code, userId, power) {
  const room = getRoom(code);
  if (!room) throw Object.assign(new Error('房间不存在'), { status: 404 });
  if (room.status !== 'playing') throw Object.assign(new Error('对局未进行'), { status: 409 });
  if (room.turnUserId !== userId) throw Object.assign(new Error('还没轮到你'), { status: 403 });
  const p = room.players.find((x) => x.userId === userId);
  if (!p || p.finished) throw Object.assign(new Error('你的回合已结束'), { status: 403 });

  const pow = phys.clamp(Number(power), 0.05, 1);
  if (!Number.isFinite(pow)) throw Object.assign(new Error('蓄力无效'), { status: 400 });

  const ts = room._turnState || { currentIdx: 0, score: 0, hops: 0, combo: 0 };
  const resolved = phys.resolveJump({
    platforms: room.platforms,
    currentIdx: ts.currentIdx,
    power: pow,
    score: ts.score,
    hops: ts.hops,
    combo: ts.combo,
  });

  room._turnState = {
    currentIdx: resolved.currentIdx,
    score: resolved.score,
    hops: resolved.hops,
    combo: resolved.combo,
  };
  p.score = resolved.score;
  p.hops = resolved.hops;

  let turnEnded = false;
  let roundEnded = false;
  if (resolved.miss) {
    p.finished = true;
    turnEnded = true;
    const nextId = nextUnfinishedAfter(room, userId);
    if (!nextId) {
      finishRound(room);
      roundEnded = true;
    } else {
      beginTurn(room, nextId);
    }
  }

  touch(room);
  try { await persistRoom(db, room); } catch (_) {}

  const event = {
    type: 'jump_room_jump',
    code: room.code,
    userId,
    alias: p.alias,
    power: pow,
    hit: resolved.hit,
    add: resolved.add,
    miss: resolved.miss,
    score: p.score,
    hops: p.hops,
    combo: resolved.miss ? 0 : resolved.combo,
    currentIdx: resolved.miss ? ts.currentIdx : resolved.currentIdx,
    turnEnded,
    roundEnded,
    turnUserId: room.turnUserId,
    status: room.status,
    winnerUserId: room.winnerUserId,
    players: room.players.map((pl) => publicPlayer(pl)),
  };
  return { room, result: resolved, event };
}

async function rematch(db, code, hostId) {
  const room = getRoom(code);
  if (!room) throw Object.assign(new Error('房间不存在'), { status: 404 });
  if (room.hostId !== hostId) throw Object.assign(new Error('只有房主可以再来一局'), { status: 403 });
  room.status = 'waiting';
  room.seed = null;
  room.platforms = null;
  room.turnUserId = null;
  room.turnOrder = [];
  room.winnerUserId = null;
  room._turnState = null;
  for (const p of room.players) {
    p.score = 0;
    p.hops = 0;
    p.finished = false;
    p.ready = p.isHost;
  }
  touch(room);
  try { await persistRoom(db, room); } catch (_) {}
  return room;
}

function expireIdle() {
  const now = Date.now();
  const gone = [];
  for (const [code, room] of rooms) {
    if (now - (room._lastActive || 0) > IDLE_MS) {
      rooms.delete(code);
      gone.push(code);
    }
  }
  return gone;
}

function shareText(room, baseUrl) {
  const url = `${baseUrl.replace(/\/$/, '')}/jump/r/${room.code}`;
  return {
    code: room.code,
    url,
    text: `【跳一跳联机】来一起玩！房间码 ${room.code}\n${url}`,
  };
}

async function loadFromDb(db) {
  // optional warm — rooms are primarily in-memory; expired rows cleaned
  try {
    await db.run(`DELETE FROM jump_rooms WHERE expires_at IS NOT NULL AND expires_at < ${require('./db').NOW}`);
  } catch (_) {}
}

module.exports = {
  MAX_PLAYERS, MIN_START, IDLE_MS,
  rooms, getRoom, findUserRoom, roomPublic, createRoom, joinRoom, leaveRoom,
  setReady, kick, startGame, submitJump, rematch, expireIdle, shareText, loadFromDb,
  persistRoom,
};
