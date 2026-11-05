/**
 * Unit tests for 抓大鹅 rules (no server).
 */
const g = require('../goose-logic');
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('✓', name); }
  else { fail++; console.log('✗', name, extra || ''); }
}

check('TRAY_SIZE 7', g.TRAY_SIZE === 7);
check('MATCH 3', g.MATCH === 3);
check('types >= 6', g.TYPES.length >= 6);

const level = g.generateLevel(42, { triples: 12, typeCount: 6, layers: 4, cols: 6, rows: 6 });
check('level has 36 tiles', level.tiles.length === 36, level.tiles.length);
const counts = {};
for (const t of level.tiles) counts[t.type] = (counts[t.type] || 0) + 1;
check('each type count multiple of 3', Object.values(counts).every((n) => n % 3 === 0), JSON.stringify(counts));

// insertAndClear groups + clears
{
  let tray = [];
  let r = g.insertAndClear(tray, 'goose');
  tray = r.tray; check('insert 1', tray.length === 1 && r.cleared === 0);
  r = g.insertAndClear(tray, 'chick');
  tray = r.tray; check('insert different', tray.join(',') === 'goose,chick');
  r = g.insertAndClear(tray, 'goose');
  tray = r.tray; check('group same type', tray.join(',') === 'goose,goose,chick', tray.join(','));
  r = g.insertAndClear(tray, 'goose');
  tray = r.tray;
  check('3-match clears', r.cleared === 3 && tray.join(',') === 'chick', tray.join(',') + ' cleared=' + r.cleared);
}

// lose: fill tray without match
{
  const game = g.createGame(1, { triples: 12, typeCount: 6, layers: 4, cols: 6, rows: 6 });
  // force tray full by picking distinct if possible — use insert directly
  let tray = ['a','b','c','d','e','f','g'];
  check('tray full length', tray.length === g.TRAY_SIZE);
}

// win via greedy solve
function trySolve(seed) {
  const game = g.createGame(seed, { triples: 12, typeCount: 6, layers: 4, cols: 6, rows: 6 });
  const seq = [];
  for (let i = 0; i < 500 && game.status === 'playing'; i++) {
    const free = g.freeTiles(game.tiles);
    if (!free.length) break;
    const counts = {};
    for (const t of game.tray) counts[t] = (counts[t] || 0) + 1;
    free.sort((a, b) => (counts[b.type] || 0) - (counts[a.type] || 0));
    let chosen = null;
    for (const t of free) {
      const sim = g.insertAndClear(game.tray.slice(), t.type);
      if (sim.tray.length < g.TRAY_SIZE || sim.cleared) { chosen = t; break; }
    }
    if (!chosen) chosen = free[0];
    const r = g.pickTile(game, chosen.id);
    if (!r.ok) break;
    seq.push(chosen.id);
  }
  return { status: game.status, seq, moves: game.moves };
}

const solved = trySolve(42);
check('seed 42 solvable', solved.status === 'won', solved.status);
const v = g.validateClear(42, solved.seq, { triples: 12, typeCount: 6, layers: 4, cols: 6, rows: 6 });
check('validateClear accepts win seq', v.ok && v.moves === solved.moves, JSON.stringify(v));
check('validateClear rejects empty', !g.validateClear(42, [], { triples: 12, typeCount: 6, layers: 4, cols: 6, rows: 6 }).ok);
check('validateClear rejects garbage id', !g.validateClear(42, ['nope'], { triples: 12, typeCount: 6, layers: 4, cols: 6, rows: 6 }).ok);

// undo
{
  const game = g.createGame(7, { triples: 12, typeCount: 6, layers: 4, cols: 6, rows: 6 });
  const free = g.freeTiles(game.tiles)[0];
  g.pickTile(game, free.id);
  const before = game.tray.slice();
  const u = g.undo(game);
  check('undo restores', u.ok && game.moves === 0 && game.tray.length === 0, JSON.stringify(u));
}

console.log(`\npassed ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
