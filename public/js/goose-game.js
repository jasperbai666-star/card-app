/**
 * 抓大鹅 — 微信同款堆叠 UI（规则与 goose-logic.js 一致）
 */
(() => {
  const TYPES = [
    { id: 'goose', name: '大鹅', emoji: '🦢', color: '#e8f4ff' },
    { id: 'duck', name: '鸭子', emoji: '🦆', color: '#fff0c8' },
    { id: 'chick', name: '小鸡', emoji: '🐤', color: '#fff3c4' },
    { id: 'egg', name: '鸡蛋', emoji: '🥚', color: '#fffaf0' },
    { id: 'corn', name: '玉米', emoji: '🌽', color: '#ffe08a' },
    { id: 'hat', name: '草帽', emoji: '👒', color: '#f5e6c8' },
    { id: 'carrot', name: '萝卜', emoji: '🥕', color: '#ffd4b8' },
    { id: 'fish', name: '小鱼', emoji: '🐟', color: '#cfe8ff' },
    { id: 'leaf', name: '叶子', emoji: '🍃', color: '#d4f5d4' },
    { id: 'flower', name: '小花', emoji: '🌸', color: '#ffe0ef' },
    { id: 'bread', name: '面包', emoji: '🍞', color: '#f5e0c0' },
    { id: 'apple', name: '苹果', emoji: '🍎', color: '#ffd0d0' },
    { id: 'worm', name: '虫子', emoji: '🐛', color: '#e8f5c8' },
    { id: 'seed', name: '种子', emoji: '🌱', color: '#d8f5d8' },
    { id: 'bell', name: '铃铛', emoji: '🔔', color: '#fff3b0' },
  ];
  const TYPE_MAP = Object.fromEntries(TYPES.map((t) => [t.id, t]));
  const TRAY_SIZE = 7;
  const MATCH = 3;
  const SIDE_CAP = 3;
  const DEFAULT_OPTS = Object.freeze({
    triples: 40, typeCount: 12, width: 5.2, height: 6.2, layers: 9, overlap: 0.28,
  });

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
  function hashRot(id) {
    let h = 0; const s = String(id);
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return ((h % 11) - 5) * 1.2;
  }
  function covers(upper, lower, overlap) {
    if (upper.removed || lower.removed || upper.layer <= lower.layer) return false;
    const ox = Math.min(upper.x + 1, lower.x + 1) - Math.max(upper.x, lower.x);
    const oy = Math.min(upper.y + 1, lower.y + 1) - Math.max(upper.y, lower.y);
    return ox > overlap && oy > overlap;
  }
  function isFree(tiles, tile, overlap) {
    if (!tile || tile.removed) return false;
    for (const o of tiles) if (o.id !== tile.id && covers(o, tile, overlap)) return false;
    return true;
  }
  function insertAndClear(tray, item) {
    const type = item.type, id = item.id;
    let next = tray.map((x) => ({ ...x }));
    let insertAt = next.length;
    for (let i = next.length - 1; i >= 0; i--) if (next[i].type === type) { insertAt = i + 1; break; }
    next.splice(insertAt, 0, { type, id });
    let cleared = 0, changed = true;
    while (changed) {
      changed = false;
      const counts = {};
      for (const t of next) counts[t.type] = (counts[t.type] || 0) + 1;
      for (const [ty, n] of Object.entries(counts)) {
        if (n >= MATCH) {
          let left = MATCH;
          next = next.filter((x) => { if (x.type === ty && left > 0) { left--; return false; } return true; });
          cleared += MATCH; changed = true; break;
        }
      }
    }
    return { tray: next, cleared };
  }

  // --- level gen (mirrors goose-logic) ---
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
      let best = null, bestScore = -1e9;
      shuffleInPlace(available, rand);
      for (const t of available) {
        const sim = tray.slice(); sim.push(t);
        const counts = {};
        for (const x of sim) counts[x] = (counts[x] || 0) + 1;
        let cleared = false, len = sim.length;
        if ((counts[t] || 0) >= MATCH) { len -= MATCH; cleared = true; }
        if (len >= TRAY_SIZE && !cleared) continue;
        const inTray = tray.filter((x) => x === t).length;
        let score = rand() * 2;
        if (inTray === 2) score += 8;
        else if (inTray === 1) score += 3;
        else score += 1;
        if (tray.length >= 4 && inTray === 2) score += 6;
        if (tray.length <= 2 && inTray === 2 && rand() < 0.4) score -= 4;
        if (score > bestScore) { bestScore = score; best = t; }
      }
      if (!best) {
        best = available.sort((a, b) =>
          tray.filter((x) => x === b).length - tray.filter((x) => x === a).length
        )[0];
      }
      tray.push(best); rem[best]--; seq.push(best);
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
  function dealSolvableTypes(slots, typeSeq, rand, overlap) {
    const unfilled = slots.map((s) => ({ ...s, type: null, removed: false }));
    const placed = [];
    const solutionIds = new Array(typeSeq.length);
    for (let i = typeSeq.length - 1; i >= 0; i--) {
      const type = typeSeq[i];
      const freeSlots = unfilled.filter((s) => s.type == null && slotIsFree(placed, s, overlap));
      let slot;
      if (freeSlots.length) slot = freeSlots[(rand() * freeSlots.length) | 0];
      else {
        const empty = unfilled.filter((s) => s.type == null);
        slot = empty[(rand() * empty.length) | 0];
        const maxL = placed.reduce((m, p) => Math.max(m, p.layer), 0);
        slot.layer = maxL + 1;
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
  function generateLevel(seed, opts = {}) {
    const o = { ...DEFAULT_OPTS, ...opts };
    const rand = mulberry32(seed);
    const typeIds = TYPES.slice(0, Math.min(o.typeCount, TYPES.length)).map((t) => t.id);
    const total = o.triples * MATCH;
    const W = o.width, H = o.height, layers = o.layers, overlap = o.overlap;
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
      const cx = (W - spanX) / 2, cy = (H - spanY) / 2;
      const cols = Math.max(3, Math.round(Math.sqrt(n * (spanX / Math.max(spanY, 0.1)))));
      const rows = Math.max(2, Math.ceil(n / cols));
      let placedN = 0;
      for (let r = 0; r < rows && placedN < n && i < total; r++) {
        for (let c = 0; c < cols && placedN < n && i < total; c++) {
          const dens = 0.78 + L * 0.025;
          if (L > 0 && L < layers - 1 && rand() > dens) continue;
          slots.push({
            id: 't' + i, layer: L,
            x: cx + (c + 0.5) * (spanX / cols) + ox + (rand() - 0.5) * 0.38 - 0.5,
            y: cy + (r + 0.5) * (spanY / rows) + oy + (rand() - 0.5) * 0.38 - 0.5,
            rot: hashRot('t' + i),
          });
          i++; placedN++;
        }
      }
    }
    while (i < total) {
      slots.push({
        id: 't' + i, layer: layers + ((i * 3) % 3),
        x: W * 0.12 + rand() * W * 0.76,
        y: H * 0.12 + rand() * H * 0.76,
        rot: hashRot('t' + i),
      });
      i++;
    }
    const typeSeq = buildPressureSequence(o.triples, typeIds, rand);
    const dealt = dealSolvableTypes(slots, typeSeq, rand, overlap);
    return {
      seed, overlap, width: W, height: H,
      tiles: dealt.tiles.map((t) => ({
        id: t.id, type: t.type, layer: t.layer, x: t.x, y: t.y,
        rot: t.rot || hashRot(t.id), removed: false,
      })),
      solution: dealt.solutionIds.slice(),
    };
  }

  function formatMs(ms) {
    const s = Math.max(0, Math.round(Number(ms) / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
  }

  function mount(root, opts = {}) {
    if (!root) return null;
    if (root._goose) { try { root._goose.destroy(); } catch (_) {} }

    root.innerHTML = `
      <div class="gg-wrap gg-stacked">
        <div class="gg-hud">
          <div class="gg-stat">剩余 <strong id="ggRemain">0</strong></div>
          <div class="gg-stat">消除 <strong id="ggCleared">0</strong></div>
          <div class="gg-stat">用时 <strong id="ggTime">0s</strong></div>
          <div class="gg-stat">通关 <strong id="ggBest">${opts.bestClears != null ? opts.bestClears : '—'}</strong></div>
          <button type="button" class="jg-btn ghost" id="ggRestart">重开</button>
        </div>
        <p class="gg-hint">点亮着的牌才能抓。叠在下面的要先清开上层。槽满失败 · 清空通关。</p>
        <div class="gg-board gg-pile" id="ggBoard" role="application" aria-label="抓大鹅牌堆"></div>
        <div class="gg-side" id="ggSide" aria-label="移出区"></div>
        <div class="gg-tray" id="ggTray" aria-label="槽位"></div>
        <div class="gg-tools">
          <button type="button" class="mp-btn ghost" id="ggRemove">移出 (<span id="ggRemN">1</span>)</button>
          <button type="button" class="mp-btn ghost" id="ggUndo">撤回 (<span id="ggUndoN">1</span>)</button>
          <button type="button" class="mp-btn ghost" id="ggShuffle">洗牌 (<span id="ggShufN">1</span>)</button>
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
    const sideEl = root.querySelector('#ggSide');
    const overEl = root.querySelector('#ggOver');
    let game = null;
    let actions = [];
    let cell = 48;
    let timer = null;
    let lockedScroll = false;

    function lockScroll(on) {
      if (on && !lockedScroll) {
        document.documentElement.classList.add('gg-noscroll');
        lockedScroll = true;
      } else if (!on && lockedScroll) {
        document.documentElement.classList.remove('gg-noscroll');
        lockedScroll = false;
      }
    }

    function snap() {
      return {
        tiles: game.tiles.map((t) => ({ ...t })),
        tray: game.tray.map((x) => ({ ...x })),
        side: game.side.map((x) => ({ ...x })),
        moves: game.moves, cleared: game.cleared, status: game.status,
        undoLeft: game.undoLeft, removeLeft: game.removeLeft,
        shuffleLeft: game.shuffleLeft, shuffleCount: game.shuffleCount,
      };
    }

    function newGame(seed) {
      const s = seed != null ? seed : ((Math.random() * 1e9) | 0) || 1;
      const level = generateLevel(s, DEFAULT_OPTS);
      game = {
        seed: s,
        tiles: level.tiles,
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
        overlap: level.overlap,
      };
      actions = [];
      overEl.classList.add('hidden');
      lockScroll(true);
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        if (!game || game.status !== 'playing') return;
        const el = root.querySelector('#ggTime');
        if (el) el.textContent = formatMs(Date.now() - game.startedAt);
      }, 500);
      render();
    }

    function renderTray() {
      trayEl.innerHTML = '';
      for (let i = 0; i < TRAY_SIZE; i++) {
        const slot = document.createElement('div');
        slot.className = 'gg-slot' + (game.tray[i] ? ' filled' : '');
        if (game.tray[i]) {
          const meta = TYPE_MAP[game.tray[i].type];
          slot.innerHTML = `<span class="gg-emoji">${meta.emoji}</span>`;
          slot.style.background = meta.color;
        }
        trayEl.appendChild(slot);
      }
    }

    function renderSide() {
      sideEl.innerHTML = '';
      sideEl.classList.toggle('empty', !game.side.length);
      for (const item of game.side) {
        const meta = TYPE_MAP[item.type];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gg-side-tile';
        btn.style.background = meta.color;
        btn.innerHTML = `<span class="gg-emoji">${meta.emoji}</span>`;
        btn.setAttribute('aria-label', '取回' + meta.name);
        btn.onclick = () => onSide(item.id);
        sideEl.appendChild(btn);
      }
      if (!game.side.length) {
        sideEl.innerHTML = '<span class="gg-side-ph">移出区</span>';
      }
    }

    function renderBoard() {
      const pad = 10;
      const w = board.clientWidth || 320;
      const maxX = Math.max(...game.tiles.map((t) => t.x), game.width - 1);
      const maxY = Math.max(...game.tiles.map((t) => t.y), game.height - 1);
      cell = Math.min(54, Math.max(36, Math.floor((w - pad * 2) / (maxX + 1.15))));
      board.style.height = Math.ceil((maxY + 1.25) * cell + pad * 2 + 8) + 'px';
      board.innerHTML = '';
      const sorted = game.tiles.filter((t) => !t.removed)
        .slice()
        .sort((a, b) => a.layer - b.layer || (a.y + a.x) - (b.y + b.x));
      for (const t of sorted) {
        const free = isFree(game.tiles, t, game.overlap);
        const meta = TYPE_MAP[t.type] || { emoji: '❓', color: '#ccc', name: t.type };
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'gg-tile gg-card' + (free ? ' free' : ' blocked');
        el.style.left = (pad + t.x * cell) + 'px';
        el.style.top = (pad + t.y * cell) + 'px';
        el.style.width = (cell - 2) + 'px';
        el.style.height = (cell - 2) + 'px';
        el.style.zIndex = String(20 + t.layer * 3);
        el.style.background = meta.color;
        el.style.setProperty('--gg-rot', (t.rot || 0) + 'deg');
        el.style.setProperty('--gg-depth', String(t.layer));
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
      root.querySelector('#ggRemN').textContent = String(game.removeLeft);
      root.querySelector('#ggShufN').textContent = String(game.shuffleLeft);
      root.querySelector('#ggTime').textContent = formatMs(Date.now() - game.startedAt);
      root.querySelector('#ggRemove').disabled = game.removeLeft <= 0 || !game.tray.length;
      root.querySelector('#ggUndo').disabled = game.undoLeft <= 0 || !game.history;
      root.querySelector('#ggShuffle').disabled = game.shuffleLeft <= 0;
      renderBoard();
      renderTray();
      renderSide();
    }

    function finish() {
      lockScroll(false);
      if (timer) { clearInterval(timer); timer = null; }
      const ms = Date.now() - game.startedAt;
      const won = game.status === 'won';
      root.querySelector('#ggOverTitle').textContent = won ? '🦢 通关成功！' : '槽位满了…';
      root.querySelector('#ggOverSub').textContent = won
        ? `用时 ${formatMs(ms)} · 消除 ${game.cleared} · ${game.moves} 步`
        : '叠层很深，善用移出 / 撤回 / 洗牌再试';
      overEl.classList.remove('hidden');
      if (typeof opts.onGameOver === 'function') {
        opts.onGameOver({
          won,
          seed: game.seed,
          moves: game.moves,
          cleared: game.cleared,
          durationMs: ms,
          pickSeq: actions.filter((a) => a.op === 'pick').map((a) => a.id),
          actions: actions.slice(),
        });
      }
    }

    function afterMove() {
      const remain = game.tiles.some((t) => !t.removed);
      if (!remain && game.side.length === 0) game.status = 'won';
      else if (game.tray.length >= TRAY_SIZE) game.status = 'lost';
      render();
      if (game.status !== 'playing') finish();
    }

    function onPick(id) {
      if (!game || game.status !== 'playing') return;
      const tile = game.tiles.find((t) => t.id === id);
      if (!tile || tile.removed || !isFree(game.tiles, tile, game.overlap)) return;
      if (game.tray.length >= TRAY_SIZE) return;
      game.history = snap();
      tile.removed = true;
      const { tray, cleared } = insertAndClear(game.tray, { type: tile.type, id: tile.id });
      game.tray = tray;
      game.cleared += cleared;
      game.moves += 1;
      actions.push({ op: 'pick', id });
      afterMove();
    }

    function onSide(id) {
      if (!game || game.status !== 'playing') return;
      const idx = game.side.findIndex((s) => s.id === id);
      if (idx < 0 || game.tray.length >= TRAY_SIZE) return;
      game.history = snap();
      const [item] = game.side.splice(idx, 1);
      const { tray, cleared } = insertAndClear(game.tray, item);
      game.tray = tray;
      game.cleared += cleared;
      game.moves += 1;
      actions.push({ op: 'side', id });
      afterMove();
    }

    root.querySelector('#ggUndo').onclick = () => {
      if (!game || game.status !== 'playing' || game.undoLeft <= 0 || !game.history) return;
      const left = game.undoLeft - 1;
      const h = game.history;
      game.tiles = h.tiles.map((t) => ({ ...t }));
      game.tray = h.tray.map((x) => ({ ...x }));
      game.side = h.side.map((x) => ({ ...x }));
      game.moves = h.moves;
      game.cleared = h.cleared;
      game.removeLeft = h.removeLeft;
      game.shuffleLeft = h.shuffleLeft;
      game.shuffleCount = h.shuffleCount;
      game.undoLeft = left;
      game.history = null;
      actions.push({ op: 'undo' });
      render();
    };
    root.querySelector('#ggRemove').onclick = () => {
      if (!game || game.status !== 'playing' || game.removeLeft <= 0 || !game.tray.length) return;
      if (game.side.length >= SIDE_CAP) return;
      game.history = snap();
      const n = Math.min(SIDE_CAP - game.side.length, Math.min(3, game.tray.length));
      const moved = game.tray.splice(game.tray.length - n, n);
      game.side.push(...moved);
      game.removeLeft -= 1;
      actions.push({ op: 'remove' });
      render();
    };
    root.querySelector('#ggShuffle').onclick = () => {
      if (!game || game.status !== 'playing' || game.shuffleLeft <= 0) return;
      const remain = game.tiles.filter((t) => !t.removed);
      if (remain.length < 2) return;
      game.history = snap();
      const rand = mulberry32((game.seed ^ ((game.shuffleCount + 1) * 0x9e3779b9) ^ (game.moves * 9973)) >>> 0);
      const positions = remain.map((t) => ({ x: t.x, y: t.y, layer: t.layer, rot: t.rot }));
      shuffleInPlace(positions, rand);
      remain.forEach((t, i) => {
        t.x = positions[i].x; t.y = positions[i].y; t.layer = positions[i].layer;
        t.rot = hashRot(t.id + ':' + game.shuffleCount);
      });
      game.shuffleCount += 1;
      game.shuffleLeft -= 1;
      actions.push({ op: 'shuffle' });
      render();
    };
    root.querySelector('#ggRestart').onclick = () => newGame();
    root.querySelector('#ggAgain').onclick = () => newGame();

    // prevent touch scroll while dragging over board
    board.addEventListener('touchmove', (e) => { e.preventDefault(); }, { passive: false });

    const ro = new ResizeObserver(() => render());
    ro.observe(board);
    newGame(opts.seed);

    root._goose = {
      destroy() {
        if (timer) clearInterval(timer);
        lockScroll(false);
        ro.disconnect();
        root.innerHTML = '';
        delete root._goose;
      },
      restart: () => newGame(),
      getState: () => game && ({
        status: game.status, moves: game.moves, cleared: game.cleared,
        seed: game.seed, actions: actions.slice(),
      }),
    };
    return root._goose;
  }

  function unmount(root) {
    if (root && root._goose) root._goose.destroy();
  }

  window.GooseGame = { mount, unmount, TYPES, TRAY_SIZE, DEFAULT_OPTS };
})();
