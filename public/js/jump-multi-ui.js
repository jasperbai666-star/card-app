/**
 * 跳一跳联机房间 UI（微信式分享 + 轮流连续跳）
 */
(() => {
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function statusLabel(st) {
    if (st === 'waiting') return '等待中';
    if (st === 'playing') return '对局中';
    if (st === 'finished') return '已结束';
    return st || '—';
  }

  /**
   * @param {object} deps
   * @param {(path:string, opts?:object)=>Promise<any>} deps.api
   * @param {(msg:string)=>void} deps.toast
   * @param {()=>any} deps.getWs
   * @param {()=>any} deps.getUser
   * @param {(path:string)=>void} [deps.navigate]
   */
  function createController(deps) {
    const { api, toast, getWs, getUser, navigate } = deps;
    let room = null;
    let share = null;
    let platforms = null;
    let game = null;
    let rootEl = null;
    let pendingJump = null; // resolve when our jump event returns
    let animating = false;

    function codeFromLocation() {
      const m = location.pathname.match(/^\/jump\/r\/([A-Za-z0-9]+)/i);
      if (m) return m[1].toUpperCase();
      const q = new URLSearchParams(location.search).get('room');
      return q ? String(q).toUpperCase() : null;
    }

    async function copyShare() {
      if (!share) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(share.text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = share.text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        toast('已复制分享文案，可粘贴到微信群');
      } catch (_) {
        toast('复制失败，请手动选中链接');
      }
    }

    function playerListHtml(r) {
      const turn = r.turnUserId;
      return `<ul class="jmr-players">${(r.players || []).map((p) => `
        <li class="${p.userId === turn ? 'turn' : ''} ${p.finished ? 'done' : ''}">
          <span class="jmr-alias">${esc(p.alias)}${p.isHost ? ' · 房主' : ''}${p.userId === r.me?.userId ? ' · 我' : ''}</span>
          <span class="jmr-meta">${r.status === 'waiting' ? (p.ready ? '已准备' : '未准备') : `得分 ${p.score}`}${p.finished ? ' · 结束' : ''}</span>
          ${r.me?.isHost && r.status === 'waiting' && !p.isHost ? `<button type="button" class="jg-btn ghost sm" data-kick="${p.userId}">踢出</button>` : ''}
        </li>`).join('')}</ul>`;
    }

    function renderShell() {
      if (!rootEl || !room) return;
      const r = room;
      const canStart = r.me?.isHost && r.status === 'waiting' && (r.players || []).length >= (r.minStart || 2)
        && (r.players || []).every((p) => p.ready);
      rootEl.innerHTML = `
        <div class="jmr-wrap">
          <div class="jmr-top">
            <button type="button" class="jg-btn ghost" id="jmrBack">← 返回</button>
            <div class="jmr-title">联机房间 <strong class="mono">${esc(r.code)}</strong></div>
            <span class="mp-chip gold">${esc(statusLabel(r.status))}</span>
          </div>
          <div class="jmr-rules">
            <strong>${esc(r.rules?.title || '规则')}</strong>
            <p>${esc(r.rules?.body || '')}</p>
          </div>
          <div class="jmr-share" id="jmrShareBox">
            <div class="jmr-share-label">分享到微信群</div>
            <div class="jmr-share-url mono" id="jmrShareUrl">${esc(share?.url || '')}</div>
            <div class="jmr-share-actions">
              <button type="button" class="mp-btn gold" id="jmrCopy">一键复制邀请</button>
              <button type="button" class="jg-btn ghost" id="jmrCopyCode">复制房间码</button>
            </div>
            <p class="mp-fine">仅本站已登录成员可加入（需邀请码注册）。</p>
          </div>
          <div class="jmr-body">
            <div class="jmr-side">
              <div class="mp-head"><h3>玩家</h3><span class="mp-chip">${(r.players||[]).length}/${r.maxPlayers || 8}</span></div>
              ${playerListHtml(r)}
              <div class="jmr-actions">
                ${r.status === 'waiting' && r.me && !r.me.isHost ? `<button type="button" class="mp-btn ${r.me.ready ? 'ghost' : 'gold'}" id="jmrReady">${r.me.ready ? '取消准备' : '准备'}</button>` : ''}
                ${r.me?.isHost && r.status === 'waiting' ? `<button type="button" class="mp-btn gold" id="jmrStart" ${canStart ? '' : 'disabled'}>开始游戏</button>` : ''}
                ${r.me?.isHost && r.status === 'finished' ? `<button type="button" class="mp-btn gold" id="jmrRematch">再来一局</button>` : ''}
                <button type="button" class="jg-btn ghost" id="jmrLeave">离开房间</button>
              </div>
              ${r.status === 'finished' ? `<div class="jmr-winner">🏆 本局最高分：${esc((r.players||[]).slice().sort((a,b)=>b.score-a.score)[0]?.alias || '—')}（${(r.players||[]).slice().sort((a,b)=>b.score-a.score)[0]?.score ?? 0}）</div>` : ''}
            </div>
            <div class="jmr-game">
              <div id="jmrGameRoot" class="jg-root"></div>
              <div class="jmr-turn" id="jmrTurnHint"></div>
            </div>
          </div>
        </div>`;

      rootEl.querySelector('#jmrBack').onclick = () => {
        leaveSilent();
        if (navigate) navigate('/member');
        else history.replaceState(null, '', '/member');
      };
      rootEl.querySelector('#jmrCopy').onclick = copyShare;
      rootEl.querySelector('#jmrCopyCode').onclick = async () => {
        try {
          await navigator.clipboard.writeText(r.code);
          toast('房间码已复制');
        } catch (_) { toast(r.code); }
      };
      const readyBtn = rootEl.querySelector('#jmrReady');
      if (readyBtn) readyBtn.onclick = async () => {
        try {
          const out = await api(`/api/jump/rooms/${r.code}/ready`, { method: 'POST', body: { ready: !r.me.ready } });
          applyRoom(out.room);
        } catch (e) { toast(e.message); }
      };
      const startBtn = rootEl.querySelector('#jmrStart');
      if (startBtn) startBtn.onclick = async () => {
        try {
          const out = await api(`/api/jump/rooms/${r.code}/start`, { method: 'POST', body: {} });
          platforms = out.platforms;
          applyRoom(out.room);
          mountGame();
        } catch (e) { toast(e.message); }
      };
      const rematchBtn = rootEl.querySelector('#jmrRematch');
      if (rematchBtn) rematchBtn.onclick = async () => {
        try {
          const out = await api(`/api/jump/rooms/${r.code}/rematch`, { method: 'POST', body: {} });
          platforms = null;
          applyRoom(out.room, out.share);
          mountGame();
        } catch (e) { toast(e.message); }
      };
      rootEl.querySelector('#jmrLeave').onclick = async () => {
        await leaveSilent();
        if (navigate) navigate('/member');
      };
      rootEl.querySelectorAll('[data-kick]').forEach((btn) => {
        btn.onclick = async () => {
          try {
            await api(`/api/jump/rooms/${r.code}/kick`, { method: 'POST', body: { userId: Number(btn.dataset.kick) } });
          } catch (e) { toast(e.message); }
        };
      });

      updateTurnHint();
      mountGame();
    }

    function updateTurnHint() {
      const el = rootEl?.querySelector('#jmrTurnHint');
      if (!el || !room) return;
      if (room.status === 'waiting') {
        el.textContent = '邀请好友加入后，全员准备，房主开局';
      } else if (room.status === 'finished') {
        el.textContent = '本局结束 · 房主可再来一局';
      } else if (room.me?.isMyTurn) {
        el.textContent = '🎯 轮到你了！连续跳，踩空则换人';
      } else {
        const cur = (room.players || []).find((p) => p.userId === room.turnUserId);
        el.textContent = `观战中 · 当前：${cur?.alias || '—'}`;
      }
    }

    function mountGame() {
      const host = rootEl?.querySelector('#jmrGameRoot');
      if (!host || !window.JumpGame) return;
      if (game) { try { game.destroy(); } catch (_) {} game = null; }
      const myTurn = !!(room && room.status === 'playing' && room.me?.isMyTurn);
      game = JumpGame.mount(host, {
        mode: 'multi',
        interactive: myTurn,
        hudLabel: room?.status === 'playing' ? (myTurn ? '你的回合' : '观战') : statusLabel(room?.status),
        platforms: platforms || undefined,
        onJumpRequest: async (power) => {
          if (!room || !room.me?.isMyTurn || animating) return;
          animating = true;
          try {
            // Prefer WS; fallback REST
            const ws = getWs && getWs();
            if (ws && ws.readyState === 1) {
              pendingJump = {};
              const wait = new Promise((resolve, reject) => {
                pendingJump.resolve = resolve;
                pendingJump.reject = reject;
                setTimeout(() => reject(new Error('同步超时')), 8000);
              });
              ws.send(JSON.stringify({ type: 'jump_room_jump', code: room.code, power }));
              await wait;
            } else {
              const out = await api(`/api/jump/rooms/${room.code}/jump`, { method: 'POST', body: { power } });
              await handleJumpEvent(out.event, { localPower: power });
              if (out.room) applyRoom(out.room, null, { soft: true });
            }
          } catch (e) {
            toast(e.message || '跳跃失败');
            if (game) game.setInteractive(!!room?.me?.isMyTurn);
          } finally {
            animating = false;
            pendingJump = null;
          }
        },
      });
      if (platforms && platforms.length) game.loadWorld(platforms, 0);
      syncGameInteractive();
    }

    function syncGameInteractive() {
      if (!game || !room) return;
      const myTurn = room.status === 'playing' && room.me?.isMyTurn;
      game.setInteractive(!!myTurn);
      game.setHudLabel(room.status === 'playing' ? (myTurn ? '你的回合' : '观战') : statusLabel(room.status));
      if (room.status === 'playing' && myTurn) {
        // ensure at start of our turn world resets
        const me = (room.players || []).find((p) => p.userId === room.me.userId);
        if (me && me.score === 0 && me.hops === 0 && !animating) {
          game.resetToStart();
          game.setScore(0, 0);
        }
      }
      updateTurnHint();
    }

    async function handleJumpEvent(ev, { localPower } = {}) {
      if (!ev || !game) return;
      if (pendingJump && pendingJump.resolve && ev.userId === getUser()?.id) {
        const r = pendingJump.resolve;
        pendingJump = null;
        // continue below then resolve after anim
        await game.playRemoteJump(ev.power, {
          miss: ev.miss,
          score: ev.score,
          hops: ev.hops,
          combo: ev.combo,
          currentIdx: ev.currentIdx,
        });
        r(ev);
        return;
      }
      // remote player jump (or REST path already animated? for remote always animate)
      if (ev.userId !== getUser()?.id) {
        animating = true;
        try {
          // If new turn just started for someone else after miss, reset world first when turnEnded and not miss of spectator view
          if (ev.miss) {
            await game.playRemoteJump(ev.power, { miss: true, score: ev.score, hops: ev.hops, combo: 0, currentIdx: ev.currentIdx });
            // next player starts from origin
            game.resetToStart();
            game.setScore(0, 0);
          } else {
            await game.playRemoteJump(ev.power, {
              miss: false,
              score: ev.score,
              hops: ev.hops,
              combo: ev.combo,
              currentIdx: ev.currentIdx,
            });
          }
        } finally { animating = false; }
      } else if (localPower != null) {
        await game.playRemoteJump(localPower, {
          miss: ev.miss,
          score: ev.score,
          hops: ev.hops,
          combo: ev.combo,
          currentIdx: ev.currentIdx,
        });
        if (ev.miss) {
          game.setHint('踩空 · 本回合结束');
        }
      }
    }

    function applyRoom(r, sh, { soft } = {}) {
      room = r;
      if (sh) share = sh;
      const uid = getUser()?.id;
      if (room && uid != null) {
        const self = (room.players || []).find((p) => p.userId === uid);
        if (self) {
          room.me = {
            userId: self.userId,
            ready: !!self.ready,
            isHost: !!self.isHost,
            isMyTurn: room.status === 'playing' && room.turnUserId === self.userId && !self.finished,
            score: self.score,
            finished: !!self.finished,
          };
        }
      }
      if (room && room.me) {
        room.me.isMyTurn = room.status === 'playing' && room.turnUserId === room.me.userId && !room.me.finished;
      }
      if (!soft) renderShell();
      else {
        // light update player list / hints without remounting canvas mid-jump
        const listHost = rootEl?.querySelector('.jmr-side');
        if (listHost) {
          const side = listHost;
          const head = `<div class="mp-head"><h3>玩家</h3><span class="mp-chip">${(room.players||[]).length}/${room.maxPlayers || 8}</span></div>`;
          // keep actions; replace only list — simpler to full re-render when not animating
          if (!animating) renderShell();
          else updateTurnHint();
        }
        syncGameInteractive();
      }
    }

    async function leaveSilent() {
      if (!room) return;
      const code = room.code;
      try { await api(`/api/jump/rooms/${code}/leave`, { method: 'POST', body: {} }); } catch (_) {}
      const ws = getWs && getWs();
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'jump_room_unsubscribe' }));
      if (game) { try { game.destroy(); } catch (_) {} game = null; }
      room = null;
    }

    function onWsEvent(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'jump_room_state' && msg.room) {
        if (room && msg.room.code !== room.code) return;
        // preserve share
        applyRoom(msg.room, share, { soft: animating });
        if (msg.room.status === 'playing' && !platforms && msg.room.seed != null) {
          // platforms may arrive via jump_room_started
        }
      } else if (msg.type === 'jump_room_started') {
        if (room && msg.room?.code !== room.code) return;
        platforms = msg.platforms;
        applyRoom(msg.room, share);
        mountGame();
      } else if (msg.type === 'jump_room_jump') {
        if (room && msg.code !== room.code) return;
        handleJumpEvent(msg).then(() => {
          // state also arrives separately
        });
      } else if (msg.type === 'jump_room_kicked') {
        toast('你已被房主移出房间');
        room = null;
        if (navigate) navigate('/member');
      } else if (msg.type === 'jump_room_closed') {
        toast('房间已关闭');
        if (navigate) navigate('/member');
      } else if (msg.type === 'jump_room_error') {
        toast(msg.error || '房间错误');
        if (pendingJump && pendingJump.reject) {
          pendingJump.reject(new Error(msg.error || '跳跃失败'));
          pendingJump = null;
        }
      }
    }

    async function openIn(el, code) {
      rootEl = el;
      const c = (code || codeFromLocation() || '').toUpperCase();
      if (!c) {
        el.innerHTML = `<div class="empty">缺少房间码</div>`;
        return;
      }
      history.replaceState(null, '', `/jump/r/${c}`);
      // join (idempotent if already in)
      try {
        let out;
        try {
          out = await api(`/api/jump/rooms/${c}/join`, { method: 'POST', body: {} });
        } catch (e) {
          if (e.status === 409) {
            out = await api(`/api/jump/rooms/${c}`);
          } else throw e;
        }
        applyRoom(out.room, out.share);
        const ws = getWs && getWs();
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'jump_room_subscribe', code: c }));
        }
        if (out.room.status === 'playing') {
          // fetch full state — platforms only on start; re-fetch start payload not available.
          // Ask server room; platformsPreview is short — for mid-game join we blocked joins.
        }
      } catch (e) {
        el.innerHTML = `<div class="jmr-wrap"><div class="empty">${esc(e.message)}</div>
          <button type="button" class="mp-btn gold" id="jmrGoHome">回首页</button></div>`;
        el.querySelector('#jmrGoHome').onclick = () => navigate && navigate('/member');
      }
    }

    async function createAndOpen(el) {
      rootEl = el;
      const out = await api('/api/jump/rooms', { method: 'POST', body: {} });
      applyRoom(out.room, out.share);
      history.replaceState(null, '', `/jump/r/${out.room.code}`);
      const ws = getWs && getWs();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'jump_room_subscribe', code: out.room.code }));
      }
      return out;
    }

    return {
      openIn,
      createAndOpen,
      onWsEvent,
      codeFromLocation,
      copyShare,
      getRoom: () => room,
      destroy: () => { leaveSilent(); rootEl = null; },
    };
  }

  function entryCardHtml() {
    return `
      <div class="jmr-entry">
        <div class="jmr-entry-text">
          <strong>联机对战</strong>
          <p class="mp-fine">创建房间、分享链接到微信群，好友登录后轮流跳，最高分获胜。</p>
        </div>
        <div class="jmr-entry-actions">
          <button type="button" class="mp-btn gold" id="jmrCreateBtn">创建联机房间</button>
          <button type="button" class="jg-btn ghost" id="jmrJoinBtn">输入房间码</button>
        </div>
        <form id="jmrJoinForm" class="jmr-join-form hidden">
          <input name="code" class="mono" maxlength="8" placeholder="房间码" autocomplete="off" required />
          <button class="mp-btn gold" type="submit">加入</button>
        </form>
      </div>`;
  }

  window.JumpMultiUI = { createController, entryCardHtml, statusLabel };
})();
