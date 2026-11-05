/**
 * Shared 跳一跳 physics (Node + browser-safe pure helpers).
 * Must stay in sync with public/js/jump-game.js tunables.
 */
'use strict';

const CHARGE_MS = 1000;
const JUMP_MS = 480;
const JUMP_HEIGHT = 1.35;
const MIN_JUMP = 0.55;
const MAX_JUMP = 4.6;
const GAP_MIN = 1.7;
const GAP_MAX = 3.2;
const SIZE_MIN = 0.9;
const SIZE_MAX = 1.25;
const CENTER_RATIO = 0.28;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

/** Mulberry32 seeded RNG → [0,1) */
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

function powerToDistance(pow) {
  const t = clamp(Number(pow) || 0, 0, 1);
  const eased = t * t * (3 - 2 * t);
  return lerp(MIN_JUMP, MAX_JUMP, eased);
}

function halfExtent(plat) {
  return plat.size * 0.5;
}

/** 0 = miss, 1 = land, 2 = perfect */
function landResult(plat, lx, lz) {
  const dx = lx - plat.x;
  const dz = lz - plat.z;
  const he = halfExtent(plat);
  if (plat.kind === 'cyl') {
    const dist = Math.hypot(dx, dz);
    if (dist > he) return 0;
    if (dist <= he * CENTER_RATIO) return 2;
    return 1;
  }
  if (Math.abs(dx) > he || Math.abs(dz) > he) return 0;
  if (Math.abs(dx) <= he * CENTER_RATIO && Math.abs(dz) <= he * CENTER_RATIO) return 2;
  return 1;
}

function colorize(plat) {
  const hue = plat.hue;
  return {
    ...plat,
    color: `hsl(${hue} 52% 38%)`,
    top: `hsl(${hue} 68% 56%)`,
    side: `hsl(${hue} 40% 26%)`,
  };
}

function makePlatformAt(rand, z, opts = {}) {
  const kinds = ['box', 'box', 'cyl', 'cyl'];
  const kind = opts.kind || kinds[(rand() * kinds.length) | 0];
  const size = opts.size != null ? opts.size : SIZE_MIN + rand() * (SIZE_MAX - SIZE_MIN);
  const hue = opts.hue != null ? opts.hue : 32 + rand() * 16;
  const x = opts.x != null ? opts.x : 0;
  return colorize({ x, z, size, kind, hue });
}

/**
 * Deterministic platform sequence from seed.
 * Index 0 = start pad; subsequent platforms extend along +z with lateral jitter.
 */
function generatePlatforms(seed, count = 80) {
  const rand = mulberry32(seed);
  const platforms = [];
  platforms.push(makePlatformAt(rand, 0, { x: 0, size: 1.15, kind: 'box', hue: 40 }));
  // first target moderate gap
  platforms.push(makePlatformAt(rand, 2.15, { x: 0.55, size: 1.1, kind: 'cyl', hue: 38 }));
  let last = platforms[1];
  for (let i = 2; i < count; i++) {
    const gap = GAP_MIN + rand() * (GAP_MAX - GAP_MIN);
    const lateral = (rand() < 0.5 ? -1 : 1) * (0.15 + rand() * 1.2);
    const nx = Math.max(-2.2, Math.min(2.2, last.x + lateral));
    const p = makePlatformAt(rand, last.z + gap, { x: nx });
    platforms.push(p);
    last = p;
  }
  return platforms;
}

/**
 * Resolve one jump from currentIdx with given power.
 * Returns { hit, add, score, hops, combo, currentIdx, miss, lx, lz }
 */
function resolveJump({ platforms, currentIdx, power, score, hops, combo }) {
  const cur = platforms[currentIdx];
  const next = platforms[currentIdx + 1];
  if (!cur || !next) {
    return { hit: 0, add: 0, score, hops, combo: 0, currentIdx, miss: true, lx: cur?.x || 0, lz: cur?.z || 0 };
  }
  const dx = next.x - cur.x;
  const dz = next.z - cur.z;
  const gap = Math.hypot(dx, dz) || 1;
  const dirX = dx / gap;
  const dirZ = dz / gap;
  const jumpDist = powerToDistance(power);
  const lx = cur.x + dirX * jumpDist;
  const lz = cur.z + dirZ * jumpDist;
  const hit = landResult(next, lx, lz);
  if (hit === 0) {
    return { hit: 0, add: 0, score, hops, combo: 0, currentIdx, miss: true, lx, lz };
  }
  let nextCombo = combo;
  let add;
  if (hit === 2) {
    nextCombo = combo + 1;
    add = nextCombo;
  } else {
    nextCombo = 0;
    add = 1;
  }
  return {
    hit,
    add,
    score: score + add,
    hops: hops + 1,
    combo: nextCombo,
    currentIdx: currentIdx + 1,
    miss: false,
    lx,
    lz,
  };
}

function idealPower(platforms, currentIdx) {
  const cur = platforms[currentIdx];
  const next = platforms[currentIdx + 1];
  if (!cur || !next) return 0.55;
  const dist = Math.hypot(next.x - cur.x, next.z - cur.z);
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (powerToDistance(mid) < dist) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

module.exports = {
  CHARGE_MS, JUMP_MS, JUMP_HEIGHT, MIN_JUMP, MAX_JUMP, GAP_MIN, GAP_MAX,
  SIZE_MIN, SIZE_MAX, CENTER_RATIO,
  clamp, lerp, mulberry32, powerToDistance, halfExtent, landResult,
  generatePlatforms, resolveJump, idealPower, colorize,
};
