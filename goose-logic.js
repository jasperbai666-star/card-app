/**
 * 抓大鹅 — 微信同款堆叠三消（Node 可测，与前端规则一致）
 *
 * - 多层交错叠放，仅未被更高层遮挡的牌可点
 * - 7 槽；同类型并拢；三消；槽满失败；清空胜利
 * - 道具：撤回×1、移出×1（槽内最多 3 张移到侧栏，可再点回）、洗牌×1（重排剩余堆）
 */
'use strict';

const TYPES = [
  { id: 'goose', name: '大鹅', emoji: '🦢' },
  { id: 'duck', name: '鸭子', emoji: '🦆' },
  { id: 'chick', name: '小鸡', emoji: '🐤' },
  { id: 'egg', name: '鸡蛋', emoji: '🥚' },
  { id: 'corn', name: '玉米', emoji: '🌽' },
  { id: 'hat', name: '草帽', emoji: '👒' },
  { id: 'carrot', name: '萝卜', emoji: '🥕' },
  { id: 'fish', name: '小鱼', emoji: '🐟' },
  { id: 'leaf', name: '叶子', emoji: '🍃' },
  { id: 'flower', name: '小花', emoji: '🌸' },
  { id: 'bread', name: '面包', emoji: '🍞' },
  { id: 'apple', name: '苹果', emoji: '🍎' },
  { id: 'worm', name: '虫子', emoji: '🐛' },
  { id: 'seed', name: '种子', emoji: '🌱' },
  { id: 'bell', name: '铃铛', emoji: '🔔' },
];

const TRAY_SIZE = 7;
const MATCH = 3;
const SIDE_CAP = 3;

/** Production difficulty — ~120 tiles, dense pile */
const DEFAULT_OPTS = Object.freeze({
  triples: 40,
  typeCount: 12,
  width: 5.2,
  height: 6.2,
  layers: 9,
  overlap: 0.28,
});

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

function hashRot(id) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return ((h % 11) - 5) * 1.2; // -6..6 deg-ish
}

/**
 * Build a dense irregular pile: many layers, staggered offsets so lower cards peek out.
 * Positions are continuous (not a flat sparse grid).
 */
/**
 * Build a high-pressure but solvable pick-type sequence (tray never overflows if followed).
 * Keeps 4–6 in tray often so blind play is hard.
 */
function buildPressureSequence(triples, typeIds, rand) {
  const rem = {};
  for (let i = 0; i < triples; i++) {
    const t = typeIds[(rand() * typeIds.length) | 0];
    rem[t] = (rem[t] || 0) + MATCH;
  }
  const seq = [];
  const tray = [];
  const left = () => Object.values(rem).reduce((a, b) => a + b, 0);
  while (left() > 0) {
    const available = Object.keys(rem).filter((t) => rem[t] > 0);
    // score candidates: prefer extending pairs, avoid instant lose, delay easy clears sometimes
    let best = null;
    let bestScore = -1e9;
    shuffleInPlace(available, rand);
    for (const t of available) {
      const sim = tray.slice();
      sim.push(t);
      // pretend clear
      const counts = {};
      for (const x of sim) counts[x] = (counts[x] || 0) + 1;
      let cleared = false;
      let len = sim.length;
      if ((counts[t] || 0) >= MATCH) { len -= MATCH; cleared = true; }
      if (len >= TRAY_SIZE && !cleared) continue; // would lose
      const inTray = tray.filter((x) => x === t).length;
      let score = rand() * 2;
      if (inTray === 2) score += 8; // complete match when needed
      else if (inTray === 1) score += 3;
      else score += 1;
      if (tray.length >= 4 && inTray === 2) score += 6;
      if (tray.length <= 2 && inTray === 2 && rand() < 0.4) score -= 4; // sometimes delay clear
      if (score > bestScore) { bestScore = score; best = t; }
    }
    if (!best) {
      // forced: pick any that clears or least damage
      best = available.sort((a, b) => {
        const ca = tray.filter((x) => x === a).length;
        const cb = tray.filter((x) => x === b).length;
        return cb - ca;
      })[0];
    }
    tray.push(best);
    rem[best]--;
    seq.push(best);
    // clear
    const counts = {};
    for (const x of tray) counts[x] = (counts[x] || 0) + 1;
    for (const [ty, n] of Object.entries(counts)) {
      if (n >= MATCH) {
        let leftN = MATCH;
        for (let i = tray.length - 1; i >= 0 && leftN > 0; i--) {
          if (tray[i] === ty) { tray.splice(i, 1); leftN--; }
        }
      }
    }
  }
  return seq;
}

function slotIsFree(placed, slot, overlap) {
  for (const o of placed) {
    if (o.id === slot.id) continue;
    if (covers(o, slot, overlap)) return false;
  }
  return true;
}

/** Reverse-deal types onto stacked slots. Returns { tiles, solutionIds }. */
function dealSolvableTypes(slots, typeSeq, rand, overlap) {
  const unfilled = slots.map((s) => ({ ...s, type: null, removed: false }));
  const placed = [];
  const solutionIds = new Array(typeSeq.length);
  for (let i = typeSeq.length - 1; i >= 0; i--) {
    const type = typeSeq[i];
    const freeSlots = unfilled.filter((s) => s.type == null && slotIsFree(placed, s, overlap));
    let slot;
    if (freeSlots.length) {
      // Prefer placing with some coverage potential: toward center
      slot = freeSlots[(rand() * freeSlots.length) | 0];
    } else {
      const empty = unfilled.filter((s) => s.type == null);
      if (!empty.length) throw new Error('dealSolvable: no empty slot');
      slot = empty[(rand() * empty.length) | 0];
      const maxL = placed.reduce((m, p) => Math.max(m, p.layer), 0);
      slot.layer = maxL + 1;
      // nudge over a random placed tile to restore cover
      if (placed.length) {
        const under = placed[(rand() * placed.length) | 0];
        slot.x = under.x + (rand() - 0.5) * 0.3;
        slot.y = under.y + (rand() - 0.5) * 0.3;
      }
    }
    slot.type = type;
    solutionIds[i] = slot.id;
    placed.push(slot);
  }
  return { tiles: unfilled, solutionIds };
}

function generateLevel(seed = Date.now(), opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const rand = mulberry32(seed);
  const typeCount = Math.min(o.typeCount, TYPES.length);
  const triples = o.triples;
  const typeIds = TYPES.slice(0, typeCount).map((t) => t.id);
  const total = triples * MATCH;

  const W = o.width;
  const H = o.height;
  const layers = o.layers;
  const overlap = o.overlap;

  // --- build stacked slot geometry (no types yet) ---
  const slots = [];
  const weights = [];
  for (let L = 0; L < layers; L++) weights.push(Math.max(0.45, 1.15 - L * 0.06));
  const wSum = weights.reduce((a, b) => a + b, 0);
  const perLayer = weights.map((w) => Math.max(4, Math.round((w / wSum) * total)));
  let assigned = perLayer.reduce((a, b) => a + b, 0);
  perLayer[perLayer.length - 1] += total - assigned;

  let i = 0;
  for (let L = 0; L < layers && i < total; L++) {
    const n = Math.min(perLayer[L], total - i);
    const ox = (L % 2 === 0 ? 0 : 0.4) + (rand() - 0.5) * 0.1;
    const oy = (L % 2 === 0 ? 0 : 0.34) + (rand() - 0.5) * 0.1;
    const spanX = W * (0.94 - L * 0.045);
    const spanY = H * (0.94 - L * 0.04);
    const cx = (W - spanX) / 2;
    const cy = (H - spanY) / 2;
    const cols = Math.max(3, Math.round(Math.sqrt(n * (spanX / Math.max(spanY, 0.1)))));
    const rows = Math.max(2, Math.ceil(n / cols));
    let placedN = 0;
    for (let r = 0; r < rows && placedN < n && i < total; r++) {
      for (let c = 0; c < cols && placedN < n && i < total; c++) {
        const dens = 0.78 + L * 0.025;
        if (L > 0 && L < layers - 1 && rand() > dens) continue;
        const jitterX = (rand() - 0.5) * 0.38;
        const jitterY = (rand() - 0.5) * 0.38;
        slots.push({
          id: `t${i}`,
          layer: L,
          x: cx + (c + 0.5) * (spanX / cols) + ox + jitterX - 0.5,
          y: cy + (r + 0.5) * (spanY / rows) + oy + jitterY - 0.5,
          rot: hashRot(`t${i}`),
        });
        i++;
        placedN++;
      }
    }
  }
  while (i < total) {
    slots.push({
      id: `t${i}`,
      layer: layers + ((i * 3) % 3),
      x: W * 0.12 + rand() * W * 0.76,
      y: H * 0.12 + rand() * H * 0.76,
      rot: hashRot(`t${i}`),
    });
    i++;
  }

  const typeSeq = buildPressureSequence(triples, typeIds, rand);
  const dealt = dealSolvableTypes(slots, typeSeq, rand, overlap);
  const tiles = dealt.tiles.map((t) => ({
    id: t.id,
    type: t.type,
    layer: t.layer,
    x: t.x,
    y: t.y,
    rot: t.rot || hashRot(t.id),
    removed: false,
  }));
  const solution = dealt.solutionIds.slice();

  return {
    seed,
    tiles,
    width: W,
    height: H,
    cols: W,
    rows: H,
    types: typeIds,
    overlap,
    opts: { ...o },
    solution, // pick ids that win without tools if followed
  };
}

function covers(upper, lower, overlap = DEFAULT_OPTS.overlap) {
  if (upper.removed || lower.removed) return false;
  if (upper.layer <= lower.layer) return false;
  const overlapX = Math.min(upper.x + 1, lower.x + 1) - Math.max(upper.x, lower.x);
  const overlapY = Math.min(upper.y + 1, lower.y + 1) - Math.max(upper.y, lower.y);
  return overlapX > overlap && overlapY > overlap;
}

function isFree(tiles, tile, overlap = DEFAULT_OPTS.overlap) {
  if (!tile || tile.removed) return false;
  for (const o of tiles) {
    if (o.id === tile.id) continue;
    if (covers(o, tile, overlap)) return false;
  }
  return true;
}

function freeTiles(tiles, overlap = DEFAULT_OPTS.overlap) {
  return tiles.filter((t) => !t.removed && isFree(tiles, t, overlap));
}

/**
 * Tray items are { type, id }. Insert after last same type, then clear 3-of-a-kind.
 */
function insertAndClear(tray, item) {
  const type = typeof item === 'string' ? item : item.type;
  const id = typeof item === 'string' ? null : item.id;
  let next = tray.map((x) => (typeof x === 'string' ? { type: x, id: null } : { ...x }));
  let insertAt = next.length;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].type === type) { insertAt = i + 1; break; }
  }
  next.splice(insertAt, 0, { type, id });

  let cleared = 0;
  let changed = true;
  while (changed) {
    changed = false;
    const counts = {};
    for (const t of next) counts[t.type] = (counts[t.type] || 0) + 1;
    for (const [ty, n] of Object.entries(counts)) {
      if (n >= MATCH) {
        let left = MATCH;
        next = next.filter((x) => {
          if (x.type === ty && left > 0) { left--; return false; }
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

function trayTypes(tray) {
  return tray.map((x) => (typeof x === 'string' ? x : x.type));
}

function snapshot(game) {
  return {
    tiles: game.tiles.map((t) => ({ ...t })),
    tray: game.tray.map((x) => ({ ...x })),
    side: game.side.map((x) => ({ ...x })),
    moves: game.moves,
    cleared: game.cleared,
    status: game.status,
    undoLeft: game.undoLeft,
    removeLeft: game.removeLeft,
    shuffleLeft: game.shuffleLeft,
    shuffleCount: game.shuffleCount,
  };
}

function restore(game, snap) {
  Object.assign(game, {
    tiles: snap.tiles.map((t) => ({ ...t })),
    tray: snap.tray.map((x) => ({ ...x })),
    side: snap.side.map((x) => ({ ...x })),
    moves: snap.moves,
    cleared: snap.cleared,
    status: snap.status,
    undoLeft: snap.undoLeft,
    removeLeft: snap.removeLeft,
    shuffleLeft: snap.shuffleLeft,
    shuffleCount: snap.shuffleCount,
  });
}

function createGame(seed, opts) {
  const level = generateLevel(seed, opts);
  const overlap = level.overlap;
  return {
    seed: level.seed,
    tiles: level.tiles.map((t) => ({ ...t })),
    tray: [],
    side: [],
    status: 'playing',
    moves: 0,
    cleared: 0,
    startedAt: Date.now(),
    undoLeft: 1,
    removeLeft: 1,
    shuffleLeft: 1,
    shuffleCount: 0,
    history: null,
    width: level.width,
    height: level.height,
    cols: level.width,
    rows: level.height,
    overlap,
    levelOpts: level.opts,
  };
}

function pickTile(game, tileId) {
  if (game.status !== 'playing') return { ok: false, error: '对局已结束' };
  const tile = game.tiles.find((t) => t.id === tileId);
  if (!tile || tile.removed) return { ok: false, error: '无效的牌' };
  if (!isFree(game.tiles, tile, game.overlap)) return { ok: false, error: '被压住了' };
  if (game.tray.length >= TRAY_SIZE) return { ok: false, error: '槽位已满' };

  game.history = snapshot(game);
  tile.removed = true;
  const { tray, cleared } = insertAndClear(game.tray, { type: tile.type, id: tile.id });
  game.tray = tray;
  game.cleared += cleared;
  game.moves += 1;

  const remain = game.tiles.some((t) => !t.removed);
  if (!remain && game.side.length === 0) game.status = 'won';
  else if (game.tray.length >= TRAY_SIZE) game.status = 'lost';
  return { ok: true, cleared };
}

/** Click a side (移出) tile back into tray */
function pickSide(game, sideId) {
  if (game.status !== 'playing') return { ok: false, error: '对局已结束' };
  const idx = game.side.findIndex((s) => s.id === sideId);
  if (idx < 0) return { ok: false, error: '侧栏没有这张牌' };
  if (game.tray.length >= TRAY_SIZE) return { ok: false, error: '槽位已满' };
  game.history = snapshot(game);
  const [item] = game.side.splice(idx, 1);
  const { tray, cleared } = insertAndClear(game.tray, item);
  game.tray = tray;
  game.cleared += cleared;
  game.moves += 1;
  const remain = game.tiles.some((t) => !t.removed);
  if (!remain && game.side.length === 0) game.status = 'won';
  else if (game.tray.length >= TRAY_SIZE) game.status = 'lost';
  return { ok: true, cleared };
}

function undo(game) {
  if (game.status !== 'playing') return { ok: false, error: '对局已结束' };
  if (game.undoLeft <= 0) return { ok: false, error: '撤回次数用尽' };
  if (!game.history) return { ok: false, error: '没有可撤回的操作' };
  const hist = game.history;
  const left = game.undoLeft - 1;
  restore(game, hist);
  game.undoLeft = left;
  game.history = null;
  return { ok: true };
}

/** 移出：最多 3 张从槽位移到侧栏 */
function removeToSide(game) {
  if (game.status !== 'playing') return { ok: false, error: '对局已结束' };
  if (game.removeLeft <= 0) return { ok: false, error: '移出次数用尽' };
  if (!game.tray.length) return { ok: false, error: '槽位是空的' };
  if (game.side.length >= SIDE_CAP) return { ok: false, error: '侧栏已满' };
  game.history = snapshot(game);
  const n = Math.min(SIDE_CAP - game.side.length, Math.min(3, game.tray.length));
  const moved = game.tray.splice(game.tray.length - n, n);
  game.side.push(...moved);
  game.removeLeft -= 1;
  return { ok: true };
}

/** 洗牌：确定性重排剩余牌的位置（不改类型/id） */
function shufflePile(game) {
  if (game.status !== 'playing') return { ok: false, error: '对局已结束' };
  if (game.shuffleLeft <= 0) return { ok: false, error: '洗牌次数用尽' };
  const remain = game.tiles.filter((t) => !t.removed);
  if (remain.length < 2) return { ok: false, error: '没有可洗的牌' };
  game.history = snapshot(game);
  const rand = mulberry32((game.seed ^ ((game.shuffleCount + 1) * 0x9e3779b9) ^ (game.moves * 9973)) >>> 0);
  const positions = remain.map((t) => ({ x: t.x, y: t.y, layer: t.layer, rot: t.rot }));
  shuffleInPlace(positions, rand);
  remain.forEach((t, i) => {
    t.x = positions[i].x;
    t.y = positions[i].y;
    t.layer = positions[i].layer;
    t.rot = hashRot(t.id + ':' + game.shuffleCount);
  });
  game.shuffleCount += 1;
  game.shuffleLeft -= 1;
  return { ok: true };
}

/** @deprecated name kept — was tray shuffle; now pile shuffle */
function shuffleTray(game) {
  return shufflePile(game);
}

function publicState(game) {
  const remaining = game.tiles.filter((t) => !t.removed).length;
  return {
    seed: game.seed,
    status: game.status,
    tray: trayTypes(game.tray),
    trayItems: game.tray.map((x) => ({ ...x })),
    side: game.side.map((x) => ({ ...x })),
    traySize: TRAY_SIZE,
    moves: game.moves,
    cleared: game.cleared,
    remaining,
    undoLeft: game.undoLeft,
    removeLeft: game.removeLeft,
    shuffleLeft: game.shuffleLeft,
    tiles: game.tiles.map((t) => ({
      id: t.id,
      type: t.type,
      layer: t.layer,
      x: t.x,
      y: t.y,
      rot: t.rot || 0,
      removed: t.removed,
      free: !t.removed && isFree(game.tiles, t, game.overlap),
    })),
    width: game.width,
    height: game.height,
    cols: game.width,
    rows: game.height,
    durationMs: Date.now() - game.startedAt,
  };
}

function typeMeta(id) {
  return TYPES.find((t) => t.id === id) || { id, name: id, emoji: '❓' };
}

/**
 * Replay actions to validate a win.
 * actions: [{op:'pick',id}|{op:'side',id}|{op:'undo'}|{op:'remove'}|{op:'shuffle'}, ...]
 * Legacy: pickIds string[] still accepted as pure picks.
 */
function validateClear(seed, actionsOrPicks, opts) {
  const levelOpts = { ...DEFAULT_OPTS, ...(opts || {}) };
  const game = createGame(Number(seed) || 1, levelOpts);
  let actions = actionsOrPicks;
  if (!Array.isArray(actions)) return { ok: false, error: '步骤无效' };
  if (actions.length > 800) return { ok: false, error: '步骤过多' };
  // legacy pick id list
  if (actions.length && (typeof actions[0] === 'string' || actions[0] == null)) {
    actions = actions.filter(Boolean).map((id) => ({ op: 'pick', id: String(id) }));
  }
  for (const a of actions) {
    if (!a || !a.op) return { ok: false, error: '步骤无效' };
    let r;
    if (a.op === 'pick') r = pickTile(game, String(a.id));
    else if (a.op === 'side') r = pickSide(game, String(a.id));
    else if (a.op === 'undo') r = undo(game);
    else if (a.op === 'remove') r = removeToSide(game);
    else if (a.op === 'shuffle') r = shufflePile(game);
    else return { ok: false, error: '未知操作' };
    if (!r.ok) return { ok: false, error: r.error || '步骤无法重放' };
    if (game.status === 'lost') return { ok: false, error: '该局实际已失败' };
  }
  if (game.status !== 'won') return { ok: false, error: '牌堆尚未清空' };
  return {
    ok: true,
    moves: game.moves,
    cleared: game.cleared,
    durationMs: Date.now() - game.startedAt,
  };
}

module.exports = {
  TYPES, TRAY_SIZE, MATCH, SIDE_CAP, DEFAULT_OPTS,
  generateLevel, buildPressureSequence, dealSolvableTypes, createGame, pickTile, pickSide, undo, removeToSide,
  shufflePile, shuffleTray, publicState,
  freeTiles, isFree, covers, insertAndClear, trayTypes, typeMeta,
  validateClear, mulberry32, hashRot,
};
