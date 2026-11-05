/**
 * 抓大鹅 — 三消堆叠逻辑（Node 可测，与前端共享规则）
 *
 * 规则：
 *  - 牌堆多层叠放；仅未被遮挡的牌可点。
 *  - 点中后进入 7 格槽位；同类型尽量并拢；凑齐 3 个同类型立即消除。
 *  - 槽位满且无法消除 → 失败；牌堆清空 → 胜利。
 *  - 道具：撤销一步、打乱槽位（各有限次）。
 */
'use strict';

const TYPES = [
  { id: 'goose', name: '大鹅', emoji: '🦢' },
  { id: 'chick', name: '小鸡', emoji: '🐤' },
  { id: 'corn', name: '玉米', emoji: '🌽' },
  { id: 'egg', name: '鸡蛋', emoji: '🥚' },
  { id: 'hat', name: '草帽', emoji: '👒' },
  { id: 'carrot', name: '萝卜', emoji: '🥕' },
  { id: 'fish', name: '小鱼', emoji: '🐟' },
  { id: 'leaf', name: '叶子', emoji: '🍃' },
];

const TRAY_SIZE = 7;
const MATCH = 3;

function mulberry32(seed) {
  let t = (seed >>> 0) || 1;
  return function rand() {
    t |= 0;
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Build a solvable-ish level: counts of each type are multiples of 3.
 * Layout: several layers on a grid with slight offsets so upper tiles cover lower.
 */
function generateLevel(seed = Date.now(), opts = {}) {
  const rand = mulberry32(seed);
  const typeCount = opts.typeCount || 6;
  const triples = opts.triples || 12; // 12*3 = 36 tiles
  const types = TYPES.slice(0, Math.min(typeCount, TYPES.length));
  const bag = [];
  for (let t = 0; t < triples; t++) {
    const type = types[(rand() * types.length) | 0].id;
    for (let k = 0; k < MATCH; k++) bag.push(type);
  }
  shuffleInPlace(bag, rand);

  const cols = opts.cols || 6;
  const rows = opts.rows || 6;
  const layers = opts.layers || 4;
  const tiles = [];
  let i = 0;
  for (let layer = 0; layer < layers && i < bag.length; layer++) {
    const ox = (layer % 2) * 0.35;
    const oy = (layer % 2) * 0.35;
    const dens = 0.55 + layer * 0.08; // denser on top? actually more coverage lower
    for (let r = 0; r < rows && i < bag.length; r++) {
      for (let c = 0; c < cols && i < bag.length; c++) {
        if (rand() > dens && layer > 0) continue;
        tiles.push({
          id: `t${i}`,
          type: bag[i],
          layer,
          x: c + ox,
          y: r + oy,
          removed: false,
        });
        i++;
      }
    }
  }
  // leftover into top-ish scatter
  while (i < bag.length) {
    tiles.push({
      id: `t${i}`,
      type: bag[i],
      layer: layers,
      x: rand() * (cols - 1),
      y: rand() * (rows - 1),
      removed: false,
    });
    i++;
  }
  return { seed, tiles, cols, rows, types: types.map((t) => t.id) };
}

function tileBounds(t) {
  // unit square roughly 1x1; overlap if centers close and higher layer
  return { x: t.x, y: t.y, w: 1, h: 1 };
}

function covers(upper, lower) {
  if (upper.removed || lower.removed) return false;
  if (upper.layer <= lower.layer) return false;
  const a = tileBounds(upper);
  const b = tileBounds(lower);
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapX > 0.35 && overlapY > 0.35;
}

function isFree(tiles, tile) {
  if (!tile || tile.removed) return false;
  for (const o of tiles) {
    if (o.id === tile.id) continue;
    if (covers(o, tile)) return false;
  }
  return true;
}

function freeTiles(tiles) {
  return tiles.filter((t) => !t.removed && isFree(tiles, t));
}

function regroupTray(tray) {
  // Keep order but group identical types together when inserting — classic: new tile inserts next to same type
  return tray;
}

/**
 * Insert type into tray: place after last same-type, else append.
 * Then eliminate any 3-of-a-kind (repeat until stable).
 */
function insertAndClear(tray, type) {
  let next = tray.slice();
  let insertAt = next.length;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] === type) { insertAt = i + 1; break; }
  }
  next.splice(insertAt, 0, type);

  let cleared = 0;
  let changed = true;
  while (changed) {
    changed = false;
    const counts = {};
    for (const t of next) counts[t] = (counts[t] || 0) + 1;
    for (const [ty, n] of Object.entries(counts)) {
      if (n >= MATCH) {
        let left = MATCH;
        next = next.filter((x) => {
          if (x === ty && left > 0) { left--; return false; }
          return true;
        });
        cleared += MATCH;
        changed = true;
        break;
      }
    }
  }
  return { tray: next, cleared };
}

function createGame(seed, opts) {
  const level = generateLevel(seed, opts);
  return {
    seed: level.seed,
    tiles: level.tiles.map((t) => ({ ...t })),
    tray: [],
    status: 'playing', // playing | won | lost
    moves: 0,
    cleared: 0,
    startedAt: Date.now(),
    undoLeft: opts?.undoLeft ?? 1,
    shuffleLeft: opts?.shuffleLeft ?? 1,
    history: null, // snapshot for undo
    cols: level.cols,
    rows: level.rows,
  };
}

function snapshot(game) {
  return {
    tiles: game.tiles.map((t) => ({ ...t })),
    tray: game.tray.slice(),
    moves: game.moves,
    cleared: game.cleared,
    status: game.status,
    undoLeft: game.undoLeft,
    shuffleLeft: game.shuffleLeft,
  };
}

function restore(game, snap) {
  Object.assign(game, {
    tiles: snap.tiles.map((t) => ({ ...t })),
    tray: snap.tray.slice(),
    moves: snap.moves,
    cleared: snap.cleared,
    status: snap.status,
    undoLeft: snap.undoLeft,
    shuffleLeft: snap.shuffleLeft,
  });
}

function pickTile(game, tileId) {
  if (game.status !== 'playing') return { ok: false, error: '对局已结束' };
  const tile = game.tiles.find((t) => t.id === tileId);
  if (!tile || tile.removed) return { ok: false, error: '无效的牌' };
  if (!isFree(game.tiles, tile)) return { ok: false, error: '被压住了' };
  if (game.tray.length >= TRAY_SIZE) return { ok: false, error: '槽位已满' };

  game.history = snapshot(game);
  tile.removed = true;
  const { tray, cleared } = insertAndClear(game.tray, tile.type);
  game.tray = tray;
  game.cleared += cleared;
  game.moves += 1;

  const remain = game.tiles.some((t) => !t.removed);
  if (!remain) {
    game.status = 'won';
  } else if (game.tray.length >= TRAY_SIZE) {
    // check if any clear possible — insertAndClear already ran; if still full → lose
    game.status = 'lost';
  }
  return { ok: true, game: publicState(game), cleared };
}

function undo(game) {
  if (game.status !== 'playing') return { ok: false, error: '对局已结束' };
  if (game.undoLeft <= 0) return { ok: false, error: '撤销次数用尽' };
  if (!game.history) return { ok: false, error: '没有可撤销的操作' };
  const hist = game.history;
  const left = game.undoLeft - 1;
  restore(game, hist);
  game.undoLeft = left;
  game.history = null;
  return { ok: true, game: publicState(game) };
}

function shuffleTray(game) {
  if (game.status !== 'playing') return { ok: false, error: '对局已结束' };
  if (game.shuffleLeft <= 0) return { ok: false, error: '移出次数用尽' };
  if (!game.tray.length) return { ok: false, error: '槽位是空的' };
  game.history = snapshot(game);
  // "shuffle" tool in WeChat-like games often removes/reorders — we shuffle tray order
  const rand = mulberry32(Date.now() % 1e9);
  shuffleInPlace(game.tray, rand);
  game.shuffleLeft -= 1;
  return { ok: true, game: publicState(game) };
}

function publicState(game) {
  const remaining = game.tiles.filter((t) => !t.removed).length;
  return {
    seed: game.seed,
    status: game.status,
    tray: game.tray.slice(),
    traySize: TRAY_SIZE,
    moves: game.moves,
    cleared: game.cleared,
    remaining,
    undoLeft: game.undoLeft,
    shuffleLeft: game.shuffleLeft,
    tiles: game.tiles.map((t) => ({
      id: t.id,
      type: t.type,
      layer: t.layer,
      x: t.x,
      y: t.y,
      removed: t.removed,
      free: !t.removed && isFree(game.tiles, t),
    })),
    cols: game.cols,
    rows: game.rows,
    durationMs: Date.now() - game.startedAt,
  };
}

function typeMeta(id) {
  return TYPES.find((t) => t.id === id) || { id, name: id, emoji: '❓' };
}

/** Validate a client-reported win: seed + sequence of tile ids must reproduce win. */
function validateClear(seed, pickIds, opts) {
  if (!Array.isArray(pickIds) || pickIds.length > 400) return { ok: false, error: '步骤无效' };
  const game = createGame(Number(seed) || 1, opts || {});
  for (const id of pickIds) {
    const r = pickTile(game, String(id));
    if (!r.ok) return { ok: false, error: r.error || '步骤无法重放' };
    if (game.status === 'lost') return { ok: false, error: '该局实际已失败' };
  }
  if (game.status !== 'won') return { ok: false, error: '牌堆尚未清空' };
  return {
    ok: true,
    moves: game.moves,
    cleared: game.cleared,
    durationMs: game.durationMs || (Date.now() - game.startedAt),
  };
}

module.exports = {
  TYPES, TRAY_SIZE, MATCH,
  generateLevel, createGame, pickTile, undo, shuffleTray, publicState,
  freeTiles, isFree, insertAndClear, typeMeta, validateClear, mulberry32,
};
