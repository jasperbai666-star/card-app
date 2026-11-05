/**
 * 跳一跳 — WeChat Jump Jump style (Canvas 2D, self-hosted).
 *
 * Physics model (matches classic 跳一跳 feel):
 *  - Hold to charge 0..1; character squashes; power bar fills.
 *  - Release jumps on a fixed-duration parabolic arc toward the next platform.
 *  - Horizontal distance = f(power), calibrated so ~55–65% charge lands on a
 *    typical next platform, short charge undershoots, full charge overshoots.
 *  - Landing uses world-space hitboxes (circle for cylinder, square for box)
 *    that match the drawn platform tops — not screen pixels.
 *
 * Exposes window.JumpGame = { mount, unmount }
 */
(() => {
  const GOLD = '#c9a13b';
  const GOLD2 = '#f7d77a';
  const BG_TOP = '#141821';
  const BG_BOT = '#07090f';

  // ---- Tunable world units (keep hitbox + spawn + charge in sync) ----
  const CHARGE_MS = 1000;          // full power hold time
  const JUMP_MS = 480;             // flight duration (constant like WeChat)
  const JUMP_HEIGHT = 1.35;        // peak arc height in world units
  const MIN_JUMP = 0.55;           // power=0 distance (barely leave pad)
  const MAX_JUMP = 4.6;            // power=1 distance
  const GAP_MIN = 1.7;
  const GAP_MAX = 3.2;             // max gap < MAX_JUMP so full power can clear
  const SIZE_MIN = 0.9;
  const SIZE_MAX = 1.25;
  const CENTER_RATIO = 0.28;       // fraction of half-extent for "perfect"

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function prefersReduced() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  }

  /** Classic mild isometric: +z goes down-right, +x goes down-left. */
  function project(x, z, w, h, camX, camZ) {
    const dx = x - camX;
    const dz = z - camZ;
    const scale = Math.min(w, h) * 0.11;
    return {
      x: w * 0.5 + (dx - dz) * scale * 0.85,
      y: h * 0.58 + (dx + dz) * scale * 0.48,
      scale,
    };
  }

  function halfExtent(plat) {
    // World half-size of the walkable top. Drawn size uses the same value.
    return plat.size * 0.5;
  }

  /** 0 = miss, 1 = land, 2 = perfect center */
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
    // axis-aligned square top in xz
    if (Math.abs(dx) > he || Math.abs(dz) > he) return 0;
    if (Math.abs(dx) <= he * CENTER_RATIO && Math.abs(dz) <= he * CENTER_RATIO) return 2;
    return 1;
  }

  function makePlatform(z, opts = {}) {
    const kinds = ['box', 'box', 'cyl', 'cyl'];
    const kind = opts.kind || kinds[(Math.random() * kinds.length) | 0];
    const size = opts.size != null ? opts.size : rand(SIZE_MIN, SIZE_MAX);
    const hue = opts.hue != null ? opts.hue : rand(32, 48);
    return {
      x: opts.x != null ? opts.x : 0,
      z,
      size,
      kind,
      hue,
      color: `hsl(${hue} 52% 38%)`,
      top: `hsl(${hue} 68% 56%)`,
      side: `hsl(${hue} 40% 26%)`,
    };
  }

  function mount(root, opts = {}) {
    if (!root) return null;
    unmount(root);

    const reduced = prefersReduced();
    root.innerHTML = `
      <div class="jg-wrap">
        <div class="jg-hud">
          <div class="jg-score">得分 <strong id="jgScore">0</strong></div>
          <div class="jg-combo hidden" id="jgCombo">连击 ×<strong>1</strong></div>
          <div class="jg-best">最佳 <strong id="jgBest">${Number(opts.best || 0)}</strong></div>
          <button type="button" class="jg-btn ghost" id="jgRestart">重开</button>
        </div>
        <canvas id="jgCanvas" class="jg-canvas" width="720" height="900" aria-label="跳一跳"></canvas>
        <div class="jg-power"><i id="jgPower"></i></div>
        <p class="jg-hint" id="jgHint">按住蓄力，松手起跳 · 踩中圆心可连击加分</p>
        <div class="jg-over hidden" id="jgOver">
          <div class="jg-over-card">
            <div class="jg-over-title">本局结束</div>
            <div class="jg-over-score">得分 <strong id="jgFinal">0</strong></div>
            <div class="jg-over-sub" id="jgOverSub"></div>
            <button type="button" class="jg-btn gold" id="jgAgain">再来一局</button>
          </div>
        </div>
      </div>`;

    const canvas = root.querySelector('#jgCanvas');
    const ctx = canvas.getContext('2d');
    const scoreEl = root.querySelector('#jgScore');
    const bestEl = root.querySelector('#jgBest');
    const comboEl = root.querySelector('#jgCombo');
    const powerEl = root.querySelector('#jgPower');
    const hintEl = root.querySelector('#jgHint');
    const overEl = root.querySelector('#jgOver');
    const finalEl = root.querySelector('#jgFinal');
    const overSub = root.querySelector('#jgOverSub');

    let dpr = 1;
    let W = 360, H = 480;
    let platforms = [];
    let current = 0;
    let score = 0;
    let best = Number(opts.best || 0);
    let combo = 0;
    let state = 'ready'; // ready | charging | flying | falling | over
    let power = 0;
    let chargeStart = 0;
    let camX = 0, camZ = 0, camTX = 0, camTZ = 0;
    let particles = [];
    let floatTexts = [];
    let char = { x: 0, z: 0, y: 0, squash: 1 };
    let flight = null; // { t0, dur, x0,z0,x1,z1 }
    let fall = null;
    let startedAt = 0;
    let hops = 0;
    let raf = 0;
    let lastTs = 0;
    let pressId = null;
    let nextDir = 1; // alternate left/right branch like WeChat

    function resize() {
      const parent = canvas.parentElement || canvas;
      const rect = parent.getBoundingClientRect();
      W = Math.max(280, Math.floor(rect.width || 360));
      H = Math.max(380, Math.floor(W * 1.2));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function updateComboHud() {
      if (combo >= 2) {
        comboEl.classList.remove('hidden');
        comboEl.querySelector('strong').textContent = String(combo);
      } else {
        comboEl.classList.add('hidden');
      }
    }

    function spawnNext() {
      const last = platforms[platforms.length - 1];
      const gap = rand(GAP_MIN, GAP_MAX);
      // WeChat-style: next platform is roughly along +z with a lateral offset
      nextDir = Math.random() < 0.5 ? -1 : 1;
      const lateral = nextDir * rand(0.15, 1.35);
      const nx = clamp(last.x + lateral, -2.2, 2.2);
      platforms.push(makePlatform(last.z + gap, { x: nx }));
      while (platforms.length > 10) {
        platforms.shift();
        current = Math.max(0, current - 1);
      }
    }

    function resetGame() {
      platforms = [
        makePlatform(0, { x: 0, size: 1.15, kind: 'box', hue: 40 }),
      ];
      // First target: moderate gap so ~60% charge lands
      platforms.push(makePlatform(2.15, { x: 0.55, size: 1.1, kind: 'cyl', hue: 38 }));
      for (let i = 0; i < 5; i++) spawnNext();
      current = 0;
      score = 0;
      combo = 0;
      hops = 0;
      startedAt = 0;
      power = 0;
      state = 'ready';
      flight = null;
      fall = null;
      const p0 = platforms[0];
      char = { x: p0.x, z: p0.z, y: 0, squash: 1 };
      camX = camTX = p0.x;
      camZ = camTZ = p0.z;
      particles = [];
      floatTexts = [];
      overEl.classList.add('hidden');
      scoreEl.textContent = '0';
      powerEl.style.width = '0%';
      hintEl.textContent = '按住蓄力，松手起跳 · 踩中圆心可连击加分';
      updateComboHud();
    }

    function endGame() {
      if (state === 'over') return;
      state = 'over';
      finalEl.textContent = String(score);
      const isNew = score > best;
      if (isNew) {
        best = score;
        bestEl.textContent = String(best);
      }
      overSub.textContent = isNew ? '🎉 新纪录！' : (best ? `个人最佳 ${best}` : '掌握蓄力节奏就能连跳');
      overEl.classList.remove('hidden');
      hintEl.textContent = '游戏结束';
      const durationMs = startedAt ? Date.now() - startedAt : 0;
      if (typeof opts.onGameOver === 'function') {
        opts.onGameOver({ score, best, hops, durationMs, combo });
      }
    }

    function startCharge(id) {
      if (state !== 'ready') return;
      pressId = id;
      state = 'charging';
      chargeStart = performance.now();
      power = 0;
      if (!startedAt) startedAt = Date.now();
      hintEl.textContent = '蓄力中…松手起跳';
    }

    function powerToDistance(pow) {
      // Ease slightly so mid-range is forgiving (WeChat-like sweet spot)
      const t = clamp(pow, 0, 1);
      const eased = t * t * (3 - 2 * t); // smoothstep
      return lerp(MIN_JUMP, MAX_JUMP, eased);
    }

    /** Ideal power to land on next platform center (for tests / assist). */
    function idealPowerForNext() {
      const cur = platforms[current];
      const next = platforms[current + 1];
      if (!cur || !next) return 0.55;
      const dist = Math.hypot(next.x - cur.x, next.z - cur.z);
      // invert smoothstep roughly via binary search
      let lo = 0, hi = 1;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        if (powerToDistance(mid) < dist) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    }

    function beginJump(pow) {
      const cur = platforms[current];
      const next = platforms[current + 1];
      if (!cur || !next) { endGame(); return; }
      const dx = next.x - cur.x;
      const dz = next.z - cur.z;
      const gap = Math.hypot(dx, dz) || 1;
      const dirX = dx / gap;
      const dirZ = dz / gap;
      const jumpDist = powerToDistance(pow);
      const x1 = cur.x + dirX * jumpDist;
      const z1 = cur.z + dirZ * jumpDist;
      flight = {
        t0: performance.now(),
        dur: reduced ? JUMP_MS * 0.85 : JUMP_MS,
        x0: cur.x,
        z0: cur.z,
        x1,
        z1,
      };
      char.squash = 1;
      state = 'flying';
      power = 0;
      powerEl.style.width = '0%';
      hintEl.textContent = '跳！';
    }

    function releaseJump(id) {
      if (state !== 'charging') return;
      if (pressId != null && id != null && pressId !== id) return;
      pressId = null;
      const held = performance.now() - chargeStart;
      const pow = clamp(held / CHARGE_MS, 0.05, 1);
      beginJump(pow);
    }

    function onLanded(hit, lx, lz) {
      const next = platforms[current + 1];
      if (hit === 0 || !next) {
        // fall off
        fall = {
          t0: performance.now(),
          x: lx,
          z: lz,
          y: 0,
        };
        state = 'falling';
        hintEl.textContent = '没踩稳…';
        return;
      }
      current += 1;
      hops += 1;
      char.x = next.x;
      char.z = next.z;
      char.y = 0;
      char.squash = 1;
      camTX = next.x;
      camTZ = next.z;

      let add;
      if (hit === 2) {
        combo += 1;
        add = combo; // WeChat: perfect gives combo points (1,2,3…)
        hintEl.textContent = combo >= 2 ? `完美落地！连击 ×${combo}` : '完美落地！';
        floatTexts.push({ text: combo >= 2 ? `×${combo}` : '+1 完美', x: next.x, z: next.z, life: 700 });
      } else {
        combo = 0;
        add = 1;
        hintEl.textContent = '稳！继续蓄力';
        floatTexts.push({ text: '+1', x: next.x, z: next.z, life: 600 });
      }
      score += add;
      scoreEl.textContent = String(score);
      updateComboHud();
      spawnNext();
      state = 'ready';

      const n = reduced ? 5 : 12;
      for (let i = 0; i < n; i++) {
        particles.push({
          x: next.x, z: next.z, y: 0.15,
          vx: rand(-0.008, 0.008), vz: rand(-0.008, 0.008), vy: rand(0.012, 0.028),
          life: rand(280, 650),
        });
      }
    }

    function update(now, dt) {
      if (state === 'charging') {
        power = clamp((now - chargeStart) / CHARGE_MS, 0, 1);
        powerEl.style.width = `${power * 100}%`;
        char.squash = 1 - power * 0.35;
        char.y = 0;
      }

      if (state === 'flying' && flight) {
        const u = clamp((now - flight.t0) / flight.dur, 0, 1);
        char.x = lerp(flight.x0, flight.x1, u);
        char.z = lerp(flight.z0, flight.z1, u);
        char.y = Math.sin(u * Math.PI) * JUMP_HEIGHT;
        char.squash = 1 + Math.sin(u * Math.PI) * 0.12;
        if (u >= 1) {
          const lx = flight.x1;
          const lz = flight.z1;
          flight = null;
          const next = platforms[current + 1];
          const hit = next ? landResult(next, lx, lz) : 0;
          onLanded(hit, lx, lz);
        }
      }

      if (state === 'falling' && fall) {
        const t = now - fall.t0;
        char.x = fall.x;
        char.z = fall.z;
        char.y = -t * 0.004;
        char.squash = 1;
        if (t > 420) endGame();
      }

      const k = reduced ? 0.16 : 0.1;
      camX = lerp(camX, camTX, 1 - Math.pow(1 - k, dt / 16));
      camZ = lerp(camZ, camTZ, 1 - Math.pow(1 - k, dt / 16));

      particles = particles.filter((p) => {
        p.life -= dt;
        p.x += p.vx * dt; p.z += p.vz * dt; p.y += p.vy * dt; p.vy -= 0.00018 * dt;
        return p.life > 0;
      });
      floatTexts = floatTexts.filter((f) => {
        f.life -= dt;
        return f.life > 0;
      });
    }

    function drawPlatform(p, alpha) {
      const pr = project(p.x, p.z, W, H, camX, camZ);
      const s = halfExtent(p) * 2 * pr.scale; // full width in px roughly
      const he = s * 0.55;
      const ve = s * 0.32;
      const depth = s * 0.42;
      ctx.save();
      ctx.globalAlpha = alpha;

      if (p.kind === 'cyl') {
        // body
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(pr.x, pr.y + depth * 0.55, he, ve, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(pr.x - he, pr.y, he * 2, depth * 0.55);
        ctx.fillStyle = p.side;
        ctx.beginPath();
        ctx.ellipse(pr.x, pr.y + depth * 0.55, he, ve, 0, 0, Math.PI);
        ctx.fill();
        // top
        ctx.fillStyle = p.top;
        ctx.beginPath();
        ctx.ellipse(pr.x, pr.y, he, ve, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,232,160,.7)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(pr.x, pr.y, he * CENTER_RATIO, ve * CENTER_RATIO, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const hw = he, hh = ve, hz = depth;
        // left face
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(pr.x, pr.y + hh);
        ctx.lineTo(pr.x - hw, pr.y + hh * 0.45);
        ctx.lineTo(pr.x - hw, pr.y + hh * 0.45 + hz);
        ctx.lineTo(pr.x, pr.y + hh + hz);
        ctx.closePath();
        ctx.fill();
        // right face
        ctx.fillStyle = p.side;
        ctx.beginPath();
        ctx.moveTo(pr.x, pr.y + hh);
        ctx.lineTo(pr.x + hw, pr.y + hh * 0.45);
        ctx.lineTo(pr.x + hw, pr.y + hh * 0.45 + hz);
        ctx.lineTo(pr.x, pr.y + hh + hz);
        ctx.closePath();
        ctx.fill();
        // top diamond
        ctx.fillStyle = p.top;
        ctx.beginPath();
        ctx.moveTo(pr.x, pr.y);
        ctx.lineTo(pr.x + hw, pr.y + hh * 0.45);
        ctx.lineTo(pr.x, pr.y + hh);
        ctx.lineTo(pr.x - hw, pr.y + hh * 0.45);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,232,160,.65)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(pr.x, pr.y + hh * 0.45, he * CENTER_RATIO * 0.9, ve * CENTER_RATIO, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawChar() {
      const pr = project(char.x, char.z, W, H, camX, camZ);
      const yOff = -char.y * pr.scale * 0.95;
      const squash = char.squash;
      const cx = pr.x;
      const cy = pr.y + yOff - 10;
      // shadow on ground
      const ground = project(char.x, char.z, W, H, camX, camZ);
      ctx.fillStyle = 'rgba(0,0,0,.4)';
      ctx.beginPath();
      ctx.ellipse(ground.x, ground.y + 6, 12 / squash, 5 * squash, 0, 0, Math.PI * 2);
      ctx.fill();
      // body (chess-piece / WeChat-like stubby figure)
      const grd = ctx.createLinearGradient(cx, cy - 20, cx, cy + 12);
      grd.addColorStop(0, GOLD2);
      grd.addColorStop(1, GOLD);
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 12 * squash, 15 / squash, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1205';
      ctx.beginPath();
      ctx.arc(cx - 3.5, cy - 3, 2.1, 0, Math.PI * 2);
      ctx.arc(cx + 4, cy - 3, 2.1, 0, Math.PI * 2);
      ctx.fill();
    }

    function draw(ts) {
      const dt = lastTs ? clamp(ts - lastTs, 8, 34) : 16;
      lastTs = ts;
      if (state !== 'over') update(ts, dt);

      ctx.clearRect(0, 0, W, H);
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, BG_TOP);
      bg.addColorStop(1, BG_BOT);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // floor grid hint
      ctx.strokeStyle = 'rgba(247,215,122,.05)';
      ctx.lineWidth = 1;
      for (let i = -6; i <= 10; i++) {
        const a = project(-3, camZ + i * 0.8, W, H, camX, camZ);
        const b = project(3, camZ + i * 0.8, W, H, camX, camZ);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }

      const order = platforms
        .map((p, i) => ({ p, i }))
        .filter(({ i }) => i >= current - 1)
        .sort((a, b) => (a.p.x + a.p.z) - (b.p.x + b.p.z));
      for (const { p, i } of order) {
        drawPlatform(p, i < current ? 0.4 : 1);
      }

      for (const pt of particles) {
        const s = project(pt.x, pt.z, W, H, camX, camZ);
        ctx.fillStyle = `rgba(247,215,122,${clamp(pt.life / 650, 0, 1)})`;
        ctx.fillRect(s.x - 1.5, s.y - pt.y * 70, 3, 3);
      }

      drawChar();

      for (const f of floatTexts) {
        const s = project(f.x, f.z, W, H, camX, camZ);
        const age = 1 - f.life / 700;
        ctx.globalAlpha = clamp(f.life / 400, 0, 1);
        ctx.fillStyle = GOLD2;
        ctx.font = 'bold 16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(f.text, s.x, s.y - 40 - age * 28);
        ctx.globalAlpha = 1;
      }

      if (state === 'charging') {
        const p = platforms[current];
        const s = project(p.x, p.z, W, H, camX, camZ);
        ctx.strokeStyle = `rgba(247,215,122,${0.35 + power * 0.55})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y - 36, 8 + power * 30, 0, Math.PI * 2);
        ctx.stroke();
      }

      raf = requestAnimationFrame(draw);
    }

    // ---- Input (pointer = mouse + touch) ----
    const onDown = (e) => {
      e.preventDefault();
      const id = e.pointerId != null ? e.pointerId : 'm';
      try { canvas.setPointerCapture(id); } catch (_) {}
      startCharge(id);
    };
    const onUp = (e) => {
      e.preventDefault();
      const id = e.pointerId != null ? e.pointerId : 'm';
      releaseJump(id);
    };
    canvas.addEventListener('pointerdown', onDown, { passive: false });
    canvas.addEventListener('pointerup', onUp, { passive: false });
    canvas.addEventListener('pointercancel', onUp, { passive: false });
    canvas.addEventListener('lostpointercapture', onUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Prevent iOS long-press / scroll while playing
    canvas.style.touchAction = 'none';
    canvas.style.webkitUserSelect = 'none';
    canvas.style.userSelect = 'none';

    root.querySelector('#jgRestart').onclick = () => resetGame();
    root.querySelector('#jgAgain').onclick = () => resetGame();

    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas.parentElement || canvas);
    resize();
    resetGame();
    raf = requestAnimationFrame(draw);

    root._jg = {
      destroy() {
        cancelAnimationFrame(raf);
        ro.disconnect();
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        root.innerHTML = '';
        delete root._jg;
      },
      setBest(n) {
        best = Number(n) || 0;
        bestEl.textContent = String(best);
      },
      /** Test/automation: jump with given power (0..1) or ideal power. Returns promise of {hit, score, hops, state}. */
      async simulateJump(powerOrIdeal = 'ideal') {
        if (state !== 'ready') return { ok: false, reason: 'busy', state };
        const pow = powerOrIdeal === 'ideal' ? idealPowerForNext() : clamp(Number(powerOrIdeal), 0.05, 1);
        beginJump(pow);
        const t0 = performance.now();
        while (state === 'flying' || state === 'falling') {
          await new Promise((r) => setTimeout(r, 16));
          if (performance.now() - t0 > 3000) break;
        }
        // allow fall→over
        if (state === 'falling') {
          await new Promise((r) => setTimeout(r, 500));
        }
        return { ok: true, score, hops, state, combo };
      },
      getState: () => ({ score, hops, state, combo, current, platforms: platforms.length }),
      idealPowerForNext,
    };
    return root._jg;
  }

  function unmount(root) {
    const el = root || document.getElementById('jumpGameRoot');
    if (el && el._jg) el._jg.destroy();
  }

  // Pure helpers exported for node unit test via vm if needed
  window.JumpGame = {
    mount,
    unmount,
    _internals: { powerToDistance: (pow) => {
      const t = clamp(pow, 0, 1);
      const eased = t * t * (3 - 2 * t);
      return lerp(MIN_JUMP, MAX_JUMP, eased);
    }, landResult, halfExtent, MIN_JUMP, MAX_JUMP, GAP_MIN, GAP_MAX },
  };
})();
