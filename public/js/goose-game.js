/**
 * 抓大鹅 — Canvas/DOM UI（自托管，对接 goose 规则）
 * 浏览器端内嵌精简逻辑副本，与 goose-logic.js 规则一致。
 */
(() => {
  const TYPES = [
    { id: 'goose', name: '大鹅', emoji: '🦢', color: '#e8f4ff' },
    { id: 'chick', name: '小鸡', emoji: '🐤', color: '#fff3c4' },
    { id: 'corn', name: '玉米', emoji: '🌽', color: '#ffe08a' },
    { id: 'egg', name: '鸡蛋', emoji: '🥚', color: '#fffaf0' },
    { id: 'hat', name: '草帽', emoji: '👒', color: '#f5e6c8' },
    { id: 'carrot', name: '萝卜', emoji: '🥕', color: '#ffd4b8' },
    { id: 'fish', name: '小鱼', emoji: '🐟', color: '#cfe8ff' },
    { id: 'leaf', name: '叶子', emoji: '🍃', color: '#d4f5d4' },
  ];
  const TYPE_MAP = Object.fromEntries(TYPES.map((t) => [t.id, t]));
  const TRAY_SIZE = 7;
  const MATCH = 3;

  function mulberry32(seed) {
    let t = (seed >>> 0) || 1;
    return function rand() {
      t |= 0; t = (t + 0x6d2b79f5) | 0;
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
  }
  function generateLevel(seed, opts = {}) {
    const rand = mulberry32(seed);
    const typeCount = opts.typeCount || 6;
    const triples = opts.triples || 12;
    const types = TYPES.slice(0, Math.min(typeCount, TYPES.length));
    const bag = [];
    for (let t = 0; t < triples; t++) {
      const type = types[(rand() * types.length) | 0].id;
      for (let k = 0; k < MATCH; k++) bag.push(type);
    }
    shuffleInPlace(bag, rand);
    const cols = opts.cols || 6, rows = opts.rows || 6, layers = opts.layers || 4;
    const tiles = [];
    let i = 0;
    for (let layer = 0; layer < layers && i < bag.length; layer++) {
      const ox = (layer % 2) * 0.35, oy = (layer % 2) * 0.35;
      const dens = 0.55 + layer * 0.08;
      for (let r = 0; r < rows && i < bag.length; r++) {
        for (let c = 0; c < cols && i < bag.length; c++) {
          if (rand() > dens && layer > 0) continue;
          tiles.push({ id: 't' + i, type: bag[i], layer, x: c + ox, y: r + oy, removed: false });
          i++;
        }
      }
    }
    while (i < bag.length) {
      tiles.push({ id: 't' + i, type: bag[i], layer: layers, x: rand() * (cols - 1), y: rand() * (rows - 1), removed: false });
      i++;
    }
    return { seed, tiles, cols, rows };
  }
  function covers(upper, lower) {
    if (upper.removed || lower.removed || upper.layer <= lower.layer) return false;
    const overlapX = Math.min(upper.x + 1, lower.x + 1) - Math.max(upper.x, lower.x);
    const overlapY = Math.min(upper.y + 1, lower.y + 1) - Math.max(upper.y, lower.y);
    return overlapX > 0.35 && overlapY > 0.35;
  }
  function isFree(tiles, tile) {
    if (!tile || tile.removed) return false;
    for (const o of tiles) if (o.id !== tile.id && covers(o, tile)) return false;
    return true;
  }
  function insertAndClear(tray, type) {
    let next = tray.slice();
    let insertAt = next.length;
    for (let i = next.length - 1; i >= 0; i--) if (next[i] === type) { insertAt = i + 1; break; }
    next.splice(insertAt, 0, type);
    let cleared = 0, changed = true;
    while (changed) {
      changed = false;
      const counts = {};
      for (const t of next) counts[t] = (counts[t] || 0) + 1;
      for (const [ty, n] of Object.entries(counts)) {
        if (n >= MATCH) {
          let left = MATCH;
          next = next.filter((x) => { if (x === ty && left > 0) { left--; return false; } return true; });
          cleared += MATCH; changed = true; break;
        }
      }
    }
    return { tray: next, cleared };
  }

  function mount(root, opts = {}) {
    if (!root) return null;
    if (root._goose) { try { root._goose.destroy(); } catch (_) {} }

    root.innerHTML = `
      <div class="gg-wrap">
        <div class="gg-hud">
          <div class="gg-stat">剩余 <strong id="ggRemain">0</strong></div>
          <div class="gg-stat">消除 <strong id="ggCleared">0</strong></div>
          <div class="gg-stat">最佳通关 <strong id="ggBest">${opts.bestClears != null ? opts.bestClears : (opts.bestMs ? formatMs(opts.bestMs) : '—')}</strong></div>
          <button type="button" class="jg-btn ghost" id="ggRestart">重开</button>
        </div>
        <p class="gg-hint">点可点击的牌进入下方槽位，三个相同消除。槽满未消则失败。</p>
        <div class="gg-board" id="ggBoard" role="application" aria-label="抓大鹅牌堆"></div>
        <div class="gg-tray" id="ggTray" aria-label="槽位"></div>
        <div class="gg-tools">
          <button type="button" class="mp-btn ghost" id="ggUndo">撤销 (<span id="ggUndoN">1</span>)</button>
          <button type="button" class="mp-btn ghost" id="ggShuffle">打乱槽位 (<span id="ggShufN">1</span>)</button>
        </div>
        <div class="gg-over hidden" id="ggOver">
          <div class="gg-over-card">
            <div class="gg-over-title" id="ggOverTitle">通关！</div>
            <div class="gg-over-sub" id="ggOverSub"></div>
            <button type="button" class="mp-btn gold" id="ggAgain">再来一局</button>
          </div>
        </div>
      </div>`;

    const board = root.querySelector('#ggBoard');
    const trayEl = root.querySelector('#ggTray');
    const overEl = root.querySelector('#ggOver');
    let game = null;
    let pickSeq = [];
    let cell = 52;

    function formatMs(ms) {
      const s = Math.max(0, Math.round(Number(ms) / 1000));
      const m = Math.floor(s / 60);
      const r = s % 60;
      return m ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
    }

    function newGame(seed) {
      const s = seed != null ? seed : ((Math.random() * 1e9) | 0);
      const level = generateLevel(s, { triples: 12, typeCount: 6, layers: 4, cols: 6, rows: 6 });
      game = {
        seed: s,
        tiles: level.tiles,
        tray: [],
        status: 'playing',
        moves: 0,
        cleared: 0,
        startedAt: Date.now(),
        undoLeft: 1,
        shuffleLeft: 1,
        history: null,
        cols: level.cols,
        rows: level.rows,
      };
      pickSeq = [];
      overEl.classList.add('hidden');
      render();
    }

    function snap() {
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

    function renderTray() {
      trayEl.innerHTML = '';
      for (let i = 0; i < TRAY_SIZE; i++) {
        const slot = document.createElement('div');
        slot.className = 'gg-slot' + (game.tray[i] ? ' filled' : '');
        if (game.tray[i]) {
          const meta = TYPE_MAP[game.tray[i]];
          slot.innerHTML = `<span class="gg-emoji">${meta.emoji}</span>`;
          slot.style.background = meta.color;
        }
        trayEl.appendChild(slot);
      }
    }

    function renderBoard() {
      const maxX = Math.max(...game.tiles.map((t) => t.x), game.cols - 1);
      const maxY = Math.max(...game.tiles.map((t) => t.y), game.rows - 1);
      const pad = 8;
      const w = board.clientWidth || 320;
      cell = Math.min(56, Math.floor((w - pad * 2) / (maxX + 1.2)));
      board.style.height = Math.ceil((maxY + 1.2) * cell + pad * 2) + 'px';
      board.innerHTML = '';
      const sorted = game.tiles.filter((t) => !t.removed).slice().sort((a, b) => a.layer - b.layer || (a.y + a.x) - (b.y + b.x));
      for (const t of sorted) {
        const free = isFree(game.tiles, t);
        const meta = TYPE_MAP[t.type];
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'gg-tile' + (free ? ' free' : ' blocked');
        el.style.left = (pad + t.x * cell) + 'px';
        el.style.top = (pad + t.y * cell) + 'px';
        el.style.width = (cell - 4) + 'px';
        el.style.height = (cell - 4) + 'px';
        el.style.zIndex = String(10 + t.layer);
        el.style.background = meta.color;
        el.disabled = !free || game.status !== 'playing';
        el.innerHTML = `<span class="gg-emoji">${meta.emoji}</span>`;
        el.setAttribute('aria-label', meta.name + (free ? '' : '（被压住）'));
        el.onclick = () => onPick(t.id);
        board.appendChild(el);
      }
    }

    function render() {
      if (!game) return;
      const remain = game.tiles.filter((t) => !t.removed).length;
      root.querySelector('#ggRemain').textContent = String(remain);
      root.querySelector('#ggCleared').textContent = String(game.cleared);
      root.querySelector('#ggUndoN').textContent = String(game.undoLeft);
      root.querySelector('#ggShufN').textContent = String(game.shuffleLeft);
      renderBoard();
      renderTray();
    }

    function finish() {
      const ms = Date.now() - game.startedAt;
      const won = game.status === 'won';
      root.querySelector('#ggOverTitle').textContent = won ? '🦢 通关成功！' : '槽位满了…';
      root.querySelector('#ggOverSub').textContent = won
        ? `用时 ${formatMs(ms)} · 消除 ${game.cleared} · ${game.moves} 步`
        : '整理一下再开一局吧';
      overEl.classList.remove('hidden');
      if (typeof opts.onGameOver === 'function') {
        opts.onGameOver({
          won,
          seed: game.seed,
          moves: game.moves,
          cleared: game.cleared,
          durationMs: ms,
          pickSeq: pickSeq.slice(),
        });
      }
    }

    function onPick(id) {
      if (!game || game.status !== 'playing') return;
      const tile = game.tiles.find((t) => t.id === id);
      if (!tile || tile.removed || !isFree(game.tiles, tile)) return;
      if (game.tray.length >= TRAY_SIZE) return;
      game.history = snap();
      tile.removed = true;
      const { tray, cleared } = insertAndClear(game.tray, tile.type);
      game.tray = tray;
      game.cleared += cleared;
      game.moves += 1;
      pickSeq.push(id);
      const remain = game.tiles.some((t) => !t.removed);
      if (!remain) game.status = 'won';
      else if (game.tray.length >= TRAY_SIZE) game.status = 'lost';
      render();
      if (game.status !== 'playing') finish();
    }

    root.querySelector('#ggUndo').onclick = () => {
      if (!game || game.status !== 'playing' || game.undoLeft <= 0 || !game.history) return;
      const left = game.undoLeft - 1;
      const h = game.history;
      game.tiles = h.tiles.map((t) => ({ ...t }));
      game.tray = h.tray.slice();
      game.moves = h.moves;
      game.cleared = h.cleared;
      game.undoLeft = left;
      game.shuffleLeft = h.shuffleLeft;
      game.history = null;
      pickSeq.pop();
      render();
    };
    root.querySelector('#ggShuffle').onclick = () => {
      if (!game || game.status !== 'playing' || game.shuffleLeft <= 0 || !game.tray.length) return;
      game.history = snap();
      const rand = mulberry32(Date.now() % 1e9);
      shuffleInPlace(game.tray, rand);
      game.shuffleLeft -= 1;
      render();
    };
    root.querySelector('#ggRestart').onclick = () => newGame();
    root.querySelector('#ggAgain').onclick = () => newGame();

    const ro = new ResizeObserver(() => render());
    ro.observe(board);
    newGame(opts.seed);

    root._goose = {
      destroy() { ro.disconnect(); root.innerHTML = ''; delete root._goose; },
      restart: () => newGame(),
      getState: () => game && ({ status: game.status, moves: game.moves, cleared: game.cleared, seed: game.seed, pickSeq: pickSeq.slice() }),
    };
    return root._goose;
  }

  function unmount(root) {
    if (root && root._goose) root._goose.destroy();
  }

  window.GooseGame = { mount, unmount, TYPES, TRAY_SIZE };
})();
