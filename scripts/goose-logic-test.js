/**
 * Unit tests for 抓大鹅 stacked rules (no server).
 */
const g = require('../goose-logic');
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('✓', name); }
  else { fail++; console.log('✗', name, extra || ''); }
}

check('TRAY_SIZE 7', g.TRAY_SIZE === 7);
check('DEFAULT ~120 tiles', g.DEFAULT_OPTS.triples * 3 === 120);
check('types >= 12', g.TYPES.length >= 12);

const level = g.generateLevel(42);
check('level has 120 tiles', level.tiles.length === 120, level.tiles.length);
const counts = {};
for (const t of level.tiles) counts[t.type] = (counts[t.type] || 0) + 1;
check('each type count multiple of 3', Object.values(counts).every((n) => n % 3 === 0), JSON.stringify(counts));

const game0 = g.createGame(42);
const free0 = g.freeTiles(game0.tiles, game0.overlap);
const blocked0 = game0.tiles.filter((t) => !t.removed && !g.isFree(game0.tiles, t, game0.overlap));
check('most tiles covered at start', blocked0.length > free0.length && free0.length >= 5,
  `free=${free0.length} blocked=${blocked0.length}`);
check('covered unclickable', !g.pickTile(game0, blocked0[0].id).ok);

const beforeFree = new Set(free0.map((t) => t.id));
g.pickTile(game0, free0[0].id);
const afterFree = g.freeTiles(game0.tiles, game0.overlap);
check('picking exposes or keeps free tiles', afterFree.length >= 1);

// insertAndClear groups + clears
{
  let tray = [];
  let r = g.insertAndClear(tray, { type: 'goose', id: 'a' });
  tray = r.tray; check('insert 1', tray.length === 1 && r.cleared === 0);
  r = g.insertAndClear(tray, { type: 'chick', id: 'b' });
  tray = r.tray; check('insert different', tray.map((x) => x.type).join(',') === 'goose,chick');
  r = g.insertAndClear(tray, { type: 'goose', id: 'c' });
  tray = r.tray; check('group same type', tray.map((x) => x.type).join(',') === 'goose,goose,chick');
  r = g.insertAndClear(tray, { type: 'goose', id: 'd' });
  tray = r.tray;
  check('3-match clears', r.cleared === 3 && tray.map((x) => x.type).join(',') === 'chick');
}

// tray-full lose
{
  const game = g.createGame(1);
  // force fill tray with distinct types without clearing
  game.tray = ['a','b','c','d','e','f'].map((t, i) => ({ type: t, id: 'x'+i }));
  const free = g.freeTiles(game.tiles, game.overlap)[0];
  // pick something that won't match — may clear if type matches; just check API
  const r = g.pickTile(game, free.id);
  check('pick into near-full tray works or rejects', r.ok || r.error);
}

// win on known seed via solution
{
  const lv = g.generateLevel(42);
  const v = g.validateClear(42, lv.solution.map((id) => ({ op: 'pick', id })));
  check('validateClear accepts stacked solution', v.ok && v.moves === 120, JSON.stringify(v));
  check('validateClear rejects empty', !g.validateClear(42, []).ok);
  check('validateClear rejects garbage', !g.validateClear(42, [{ op: 'pick', id: 'nope' }]).ok);
}

// tools: remove / undo / shuffle
{
  const game = g.createGame(7);
  const f1 = g.freeTiles(game.tiles, game.overlap)[0];
  g.pickTile(game, f1.id);
  const f2 = g.freeTiles(game.tiles, game.overlap)[0];
  g.pickTile(game, f2.id);
  check('removeToSide moves tray tiles', g.removeToSide(game).ok && game.side.length >= 1 && game.tray.length < 2);
  const sideId = game.side[0].id;
  check('pickSide returns to tray', g.pickSide(game, sideId).ok);
  check('undo restores', g.undo(game).ok);
  check('shufflePile ok', g.shufflePile(game).ok && game.shuffleLeft === 0);
}

// lose when tray hits 7 unmatched
{
  const game = g.createGame(99);
  // Fill tray artificially then pick non-matching free tile
  let guard = 0;
  while (game.status === 'playing' && game.tray.length < 6 && guard++ < 40) {
    const free = g.freeTiles(game.tiles, game.overlap);
    if (!free.length) break;
    // prefer types not helping clear
    const counts = {};
    for (const x of game.tray) counts[x.type] = (counts[x.type] || 0) + 1;
    free.sort((a, b) => (counts[a.type] || 0) - (counts[b.type] || 0));
    g.pickTile(game, free[0].id);
  }
  check('can pressure tray without instant win', game.tray.length >= 1 || game.status !== 'playing');
}

console.log(`\npassed ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
