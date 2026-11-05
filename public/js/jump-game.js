/**
 * 跳一跳 — WeChat-style hold-to-charge jump mini-game (canvas, self-hosted).
 * Exposes window.JumpGame = { mount(el, opts), unmount() }
 */
(() => {
  const GOLD = '#c9a13b';
  const GOLD2 = '#f7d77a';
  const BG = '#0b0d14';
  const MAX_POWER = 1;
  const CHARGE_MS = 1100;
  const GRAVITY = 0.00135;
  const BASE_SPEED = 0.28;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function prefersReduced() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  }

  /** Project world (x,z) to screen with mild isometric tilt. */
  function project(x, z, w, h, camX, camZ) {
    const dx = x - camX;
    const dz = z - camZ;
    const sx = w * 0.5 + dx * 42 - dz * 22;
    const sy = h * 0.62 + dx * 18 + dz * 28;
    return { x: sx, y: sy };
  }

  function makePlatform(z, opts = {}) {
    const kinds = ['box', 'box', 'cyl'];
    const kind = opts.kind || kinds[Math.floor(Math.random() * kinds.length)];
    const size = opts.size != null ? opts.size : rand(0.85, 1.25);
    const hue = opts.hue != null ? opts.hue : rand(28, 48);
    return {
      x: opts.x != null ? opts.x : rand(-1.1, 1.1),
      z,
      size,
      kind,
      hue,
      color: `hsl(${hue} 55% 42%)`,
      top: `hsl(${hue} 70% 58%)`,
    };
  }

  function mount(root, opts = {}) {
    if (!root) return null;
    unmount();

    const reduced = prefersReduced();
    root.innerHTML = `
      <div class="jg-wrap">
        <div class="jg-hud">
          <div class="jg-score">得分 <strong id="jgScore">0</strong></div>
          <div class="jg-best">最佳 <strong id="jgBest">${Number(opts.best || 0)}</strong></div>
          <button type="button" class="jg-btn ghost" id="jgRestart">重开</button>
        </div>
        <canvas id="jgCanvas" class="jg-canvas" width="720" height="960" aria-label="跳一跳游戏画布"></canvas>
        <div class="jg-power"><i id="jgPower"></i></div>
        <p class="jg-hint" id="jgHint">按住蓄力，松手起跳 · 落到下一座平台得分</p>
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
    const powerEl = root.querySelector('#jgPower');
    const hintEl = root.querySelector('#jgHint');
    const overEl = root.querySelector('#jgOver');
    const finalEl = root.querySelector('#jgFinal');
    const overSub = root.querySelector('#jgOverSub');

    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 360, H = 480;
    let platforms = [];
    let current = 0;
    let score = 0;
    let best = Number(opts.best || 0);
    let combo = 0;
    let state = 'ready'; // ready | charging | flying | over
    let power = 0;
    let chargeStart = 0;
    let camX = 0, camZ = 0, camTX = 0, camTZ = 0;
    let particle = [];
    let char = { x: 0, z: 0, y: 0, vx: 0, vz: 0, vy: 0, facing: 0 };
    let startedAt = 0;
    let hops = 0;
    let raf = 0;
    let lastTs = 0;
    let pressId = null;
    let dead = false;

    function resize() {
      const rect = canvas.getBoundingClientRect();
      W = Math.max(280, Math.floor(rect.width));
      H = Math.max(360, Math.floor(rect.width * 1.25));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function resetGame() {
      platforms = [
        makePlatform(0, { x: 0, size: 1.15, kind: 'box', hue: 40 }),
        makePlatform(2.2, { size: 1.05 }),
      ];
      for (let i = 0; i < 4; i++) spawnNext();
      current = 0;
      score = 0;
      combo = 0;
      hops = 0;
      startedAt = 0;
      power = 0;
      state = 'ready';
      const p0 = platforms[0];
      char = { x: p0.x, z: p0.z, y: 0, vx: 0, vz: 0, vy: 0, facing: 0 };
      camX = camTX = p0.x; camZ = camTZ = p0.z;
      particle = [];
      overEl.classList.add('hidden');
      scoreEl.textContent = '0';
      powerEl.style.width = '0%';
      hintEl.textContent = '按住蓄力，松手起跳 · 落到下一座平台得分';
      dead = false;
    }

    function spawnNext() {
      const last = platforms[platforms.length - 1];
      const gap = rand(1.55, 2.55);
      const lateral = rand(-1.35, 1.35);
      platforms.push(makePlatform(last.z + gap, { x: clamp(last.x + lateral, -1.6, 1.6) }));
      if (platforms.length > 12) {
        platforms.shift();
        current = Math.max(0, current - 1);
      }
    }

    function landBonus(plat, lx, lz) {
      const dx = lx - plat.x;
      const dz = lz - plat.z;
      const dist = Math.hypot(dx, dz);
      const r = plat.size * 0.42;
      if (dist <= r * 0.28) return 2; // center
      if (dist <= r) return 1;
      return 0;
    }

    function endGame() {
      if (state === 'over') return;
      state = 'over';
      dead = true;
      finalEl.textContent = String(score);
      const isNew = score > best;
      if (isNew) {
        best = score;
        bestEl.textContent = String(best);
      }
      overSub.textContent = isNew ? '🎉 新纪录！' : (best ? `个人最佳 ${best}` : '再试一次更稳');
      overEl.classList.remove('hidden');
      hintEl.textContent = '游戏结束';
      const durationMs = startedAt ? Date.now() - startedAt : 0;
      if (typeof opts.onGameOver === 'function') {
        opts.onGameOver({ score, best, hops, durationMs, combo });
      }
    }

    function startCharge(id) {
      if (state !== 'ready' || dead) return;
      pressId = id;
      state = 'charging';
      chargeStart = performance.now();
      power = 0;
      if (!startedAt) startedAt = Date.now();
      hintEl.textContent = '蓄力中…';
    }

    function releaseJump(id) {
      if (state !== 'charging') return;
      if (pressId != null && id != null && pressId !== id) return;
      pressId = null;
      const p = platforms[current];
      const next = platforms[current + 1];
      if (!next) { endGame(); return; }
      const dx = next.x - p.x;
      const dz = next.z - p.z;
      const dist = Math.hypot(dx, dz) || 1;
      const dirX = dx / dist;
      const dirZ = dz / dist;
      const pow = clamp(power, 0.12, MAX_POWER);
      // Distance scales with power; perfect power ≈ platform gap
      const jumpDist = lerp(0.55, dist * 1.35, pow);
      char.vx = dirX * jumpDist * BASE_SPEED * 3.2;
      char.vz = dirZ * jumpDist * BASE_SPEED * 3.2;
      char.vy = 0.055 + pow * 0.045;
      char.facing = Math.atan2(dirX, dirZ);
      char.y = 0;
      state = 'flying';
      power = 0;
      powerEl.style.width = '0%';
      hintEl.textContent = '跳！';
    }

    function update(dt) {
      if (state === 'charging') {
        const t = (performance.now() - chargeStart) / CHARGE_MS;
        power = clamp(t, 0, MAX_POWER);
        powerEl.style.width = `${power * 100}%`;
        // breathe squash
        char.y = -power * 0.08;
      }

      if (state === 'flying') {
        char.x += char.vx * dt;
        char.z += char.vz * dt;
        char.vy -= GRAVITY * dt * (reduced ? 0.85 : 1);
        char.y += char.vy * dt;
        if (char.y <= 0) {
          char.y = 0;
          const next = platforms[current + 1];
          const hit = next ? landBonus(next, char.x, char.z) : 0;
          if (hit > 0) {
            current += 1;
            hops += 1;
            char.x = next.x;
            char.z = next.z;
            char.vx = char.vz = char.vy = 0;
            const add = hit === 2 ? 2 : 1;
            if (hit === 2) combo += 1; else combo = 0;
            score += add + (combo >= 2 ? 1 : 0);
            scoreEl.textContent = String(score);
            camTX = next.x; camTZ = next.z;
            spawnNext();
            state = 'ready';
            hintEl.textContent = hit === 2 ? '正中红心 +2！' : '稳！继续蓄力';
            // sparkles
            for (let i = 0; i < (reduced ? 4 : 10); i++) {
              particle.push({
                x: next.x, z: next.z, y: 0.2,
                vx: rand(-0.01, 0.01), vz: rand(-0.01, 0.01), vy: rand(0.01, 0.03),
                life: rand(300, 700),
              });
            }
          } else {
            // miss — fall a bit then over
            endGame();
          }
        }
      }

      // camera follow
      const k = reduced ? 0.12 : 0.08;
      camX = lerp(camX, camTX, 1 - Math.pow(1 - k, dt / 16));
      camZ = lerp(camZ, camTZ, 1 - Math.pow(1 - k, dt / 16));

      particle = particle.filter((p) => {
        p.life -= dt;
        p.x += p.vx * dt; p.z += p.vz * dt; p.y += p.vy * dt; p.vy -= 0.0002 * dt;
        return p.life > 0;
      });
    }

    function drawPlatform(p, alpha = 1) {
      const top = project(p.x, p.z, W, H, camX, camZ);
      const s = p.size * 38;
      ctx.save();
      ctx.globalAlpha = alpha;
      if (p.kind === 'cyl') {
        // ellipse cylinder
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(top.x, top.y + s * 0.35, s * 0.7, s * 0.28, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = p.top;
        ctx.beginPath();
        ctx.ellipse(top.x, top.y, s * 0.7, s * 0.28, 0, 0, Math.PI * 2);
        ctx.fill();
        // center target
        ctx.strokeStyle = 'rgba(255,230,150,.55)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(top.x, top.y, s * 0.18, s * 0.08, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // isometric box
        const hw = s * 0.7, hh = s * 0.45, hz = s * 0.55;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(top.x, top.y + hh);
        ctx.lineTo(top.x - hw, top.y + hh * 0.55);
        ctx.lineTo(top.x - hw, top.y + hh * 0.55 + hz);
        ctx.lineTo(top.x, top.y + hh + hz);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = `hsl(${p.hue} 40% 28%)`;
        ctx.beginPath();
        ctx.moveTo(top.x, top.y + hh);
        ctx.lineTo(top.x + hw, top.y + hh * 0.55);
        ctx.lineTo(top.x + hw, top.y + hh * 0.55 + hz);
        ctx.lineTo(top.x, top.y + hh + hz);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = p.top;
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(top.x + hw, top.y + hh * 0.55);
        ctx.lineTo(top.x, top.y + hh);
        ctx.lineTo(top.x - hw, top.y + hh * 0.55);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,230,150,.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(top.x, top.y + hh * 0.5, s * 0.14, s * 0.07, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      // gold rim
      ctx.strokeStyle = 'rgba(247,215,122,.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    function drawChar() {
      const squash = state === 'charging' ? 1 - power * 0.25 : 1;
      const stretch = state === 'flying' ? 1.15 : 1;
      const foot = project(char.x, char.z, W, H, camX, camZ);
      const yOff = -char.y * 90;
      const cx = foot.x;
      const cy = foot.y + yOff - 18;
      ctx.save();
      // shadow
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.beginPath();
      ctx.ellipse(foot.x, foot.y + 8, 14 * squash, 6 * squash, 0, 0, Math.PI * 2);
      ctx.fill();
      // body
      const grd = ctx.createLinearGradient(cx, cy - 22, cx, cy + 10);
      grd.addColorStop(0, GOLD2);
      grd.addColorStop(1, GOLD);
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 11 * squash, 16 * stretch * squash, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1205';
      ctx.beginPath();
      ctx.arc(cx - 3, cy - 4, 2, 0, Math.PI * 2);
      ctx.arc(cx + 4, cy - 4, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function draw(ts) {
      if (dead && state === 'over' && !overEl.classList.contains('hidden')) {
        // still draw frozen frame once in a while
      }
      const dt = lastTs ? clamp(ts - lastTs, 8, 40) : 16;
      lastTs = ts;
      if (state !== 'over') update(dt);

      ctx.clearRect(0, 0, W, H);
      // stage bg
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#12161f');
      bg.addColorStop(0.55, BG);
      bg.addColorStop(1, '#07080c');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      // vignette gold dust
      ctx.fillStyle = 'rgba(201,161,59,.05)';
      for (let i = 0; i < 12; i++) {
        ctx.beginPath();
        ctx.arc((i * 97 + camZ * 10) % W, (i * 53 + 40) % H, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // draw platforms back-to-front by z
      const order = platforms.map((p, i) => ({ p, i })).sort((a, b) => a.p.z - b.p.z);
      for (const { p, i } of order) {
        if (i < current - 1) continue;
        drawPlatform(p, i < current ? 0.45 : 1);
      }
      for (const pt of particle) {
        const s = project(pt.x, pt.z, W, H, camX, camZ);
        ctx.fillStyle = `rgba(247,215,122,${clamp(pt.life / 700, 0, 1)})`;
        ctx.fillRect(s.x, s.y - pt.y * 80, 3, 3);
      }
      drawChar();

      // charging ring
      if (state === 'charging') {
        const p = platforms[current];
        const s = project(p.x, p.z, W, H, camX, camZ);
        ctx.strokeStyle = `rgba(247,215,122,${0.3 + power * 0.6})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.x, s.y - 40, 10 + power * 28, 0, Math.PI * 2);
        ctx.stroke();
      }

      raf = requestAnimationFrame(draw);
    }

    // input
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
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

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
    };
    return root._jg;
  }

  function unmount(root) {
    const el = root || document.getElementById('jumpGameRoot');
    if (el && el._jg) el._jg.destroy();
  }

  window.JumpGame = { mount, unmount };
})();
