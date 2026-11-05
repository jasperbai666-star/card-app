(() => {
  const app = document.getElementById('app');
  let state = {
    user: null,
    ws: null,
    wsConnected: false,
    meta: { ranks: [], suits: [] },
    tab: 'members',
    chatCtrl: null,
    jumpMulti: null,
  };

  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || '请求失败');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function connectWs(token) {
    if (state.ws) {
      try { state.ws.close(); } catch (_) {}
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    state.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'auth_ok') {
        state.wsConnected = true;
        updateLiveDot();
      } else if (msg.type === 'auth_fail') {
        state.wsConnected = false;
        updateLiveDot();
      } else if (msg.type === 'card_updated') {
        if (state.user?.role === 'member') {
          renderMemberCard(msg.card, true);
          toast('你的卡牌已更新');
        }
      } else if (msg.type === 'profile_updated') {
        if (msg.user && state.user && msg.user.id === state.user.id) {
          state.user = { ...state.user, displayName: msg.user.displayName };
          if (state.user.role === 'member') loadMyInvite();
          document.querySelectorAll('.who-name').forEach((el) => { el.textContent = msg.user.displayName; });
          toast('管理员已把你的姓名改为「' + msg.user.displayName + '」');
        }
      } else if (msg.type === 'invite_used') {
        if (state.user?.role === 'member') { toast('「' + msg.displayName + '」已用你的邀请码加入'); loadMyInvite(); }
      } else if (msg.type === 'chat_message' || msg.type === 'chat_deleted' || msg.type === 'chat_cleared' ||
                 msg.type === 'chat_muted' || msg.type === 'chat_unmuted' || msg.type === 'chat_error') {
        if (state.chatCtrl) state.chatCtrl.onEvent(msg);
        else if (msg.type === 'chat_message' && state.user?.role === 'member') {
          // badge on chat entry if panel not mounted yet
        }
      } else if (msg.type === 'achievement_unlocked') {
        if (state.user?.role === 'member' && msg.badge) {
          toast('🏅 解锁成就：' + msg.badge.name);
          loadMyAchievements();
        }
      } else if (msg.type === 'announcement' || msg.type === 'announcement_updated' || msg.type === 'announcement_deleted') {
        if (state.user?.role === 'member') {
          loadAnnouncements();
          if (msg.type === 'announcement' && msg.announcement) toast('📢 新公告：' + msg.announcement.title);
        }
        if (state.user?.role === 'admin' && state.tab === 'announcements') {
          if (state.editingName) state.pendingRefresh = true; else refreshAdminTab();
        }
      } else if (msg.type && String(msg.type).startsWith('jump_room_')) {
        if (state.jumpMulti) state.jumpMulti.onWsEvent(msg);
      } else if (msg.type === 'force_logout') {
        toast(msg.reason || '已被强制下线');
        logout();
      } else if (msg.type === 'new_suggestion' || msg.type === 'member_joined' ||
                 msg.type === 'member_card_updated' || msg.type === 'member_removed' || msg.type === 'member_updated' ||
                 msg.type === 'suggestion_updated' || msg.type === 'invites_changed' || msg.type === 'chat_message' || msg.type === 'chat_deleted' || msg.type === 'chat_cleared' ||
                 msg.type === 'announcement' || msg.type === 'announcement_updated' || msg.type === 'announcement_deleted') {
        if (state.user?.role === 'admin') {
          // don't wipe an inline name edit in progress; refresh once it closes
          if (state.editingName) state.pendingRefresh = true; else refreshAdminTab();
          if (msg.type === 'new_suggestion') toast('收到新的建议/要求');
        }
        if (state.user?.role === 'member' && msg.type === 'suggestion_updated') {
          loadMySuggestions();
          toast('管理员已处理你的提交');
        }
      }
    };
    ws.onclose = (ev) => {
      state.wsConnected = false;
      updateLiveDot();
      // reconnect after login still valid (not when the server forced logout)
      if (state.user && ev.code !== 4001 && state.ws === ws) {
        setTimeout(async () => {
          try {
            const { token } = await api('/api/ws-token', { method: 'POST', body: {} });
            connectWs(token);
          } catch (_) {}
        }, 2500);
      }
    };
  }

  function updateLiveDot() {
    document.querySelectorAll('.live-dot').forEach((d) => {
      d.classList.toggle('off', !state.wsConnected);
    });
  }

  async function bootstrap() {
    try {
      const meta = await api('/api/meta/cards');
      state.meta = meta;
    } catch (_) {}
    try {
      const { user } = await api('/api/me');
      state.user = user;
      const { token } = await api('/api/ws-token', { method: 'POST', body: {} });
      connectWs(token);
      const roomCode = pendingJumpRoomCode();
      if (location.pathname === '/settings') renderSettings();
      else if (roomCode) openJumpRoom(roomCode);
      else routeHome();
    } catch {
      const roomCode = pendingJumpRoomCode();
      if (roomCode) {
        try { sessionStorage.setItem('jumpRoomRedirect', roomCode); } catch (_) {}
      }
      renderAuth(location.pathname === '/register' ? 'register' : 'login');
    }
  }

  function routeHome() {
    if (!state.user) return renderAuth('login');
    if (state.user.role === 'admin') renderAdmin();
    else renderMember();
  }

  async function logout() {
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch (_) {}
    state.user = null;
    const ws = state.ws;
    state.ws = null;
    if (ws) try { ws.close(); } catch (_) {}
    renderAuth('login');
  }

  // ---------- Auth views ----------
  function renderAuth(mode) {
    history.replaceState(null, '', mode === 'register' ? '/register' : '/login');
    app.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <h1 class="glow-title">CARD RANK</h1>
          <p class="sub">${mode === 'register' ? '邀请码注册 · 成为成员' : '登录卡牌等级系统'}</p>
          <div class="error-box" id="err"></div>
          <form id="authForm">
            ${mode === 'register' ? `
              <label>邀请码</label>
              <input name="inviteCode" class="mono" placeholder="8位邀请码" required maxlength="16" autocomplete="off" />
              <label>姓名（可选）</label>
              <input name="displayName" placeholder="姓名（不填则用账号名）" maxlength="20" />
            ` : ''}
            <label>账号</label>
            <input name="username" placeholder="用户名" required maxlength="24" autocomplete="username" />
            <label>密码</label>
            <input name="password" type="password" placeholder="${mode === 'register' ? '至少 8 位' : '密码'}" required maxlength="72" autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}" />
            ${mode === 'login' ? `
              <div id="totpWrap" class="hidden">
                <label>两步验证码</label>
                <input name="totp" class="mono" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="身份验证器里的 6 位数字" autocomplete="one-time-code" />
              </div>
            ` : ''}
            <button class="btn btn-primary" type="submit">${mode === 'register' ? '注册并登录' : '登录'}</button>
          </form>
          <div class="link-row">
            ${mode === 'register'
              ? `已有账号？ <a href="#" id="switch">去登录</a>`
              : `有邀请码？ <a href="#" id="switch">注册加入</a>`}
          </div>
        </div>
      </div>
    `;
    document.getElementById('switch').onclick = (e) => {
      e.preventDefault();
      renderAuth(mode === 'register' ? 'login' : 'register');
    };
    document.getElementById('authForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = Object.fromEntries(fd.entries());
      if (!body.totp) delete body.totp;
      const err = document.getElementById('err');
      err.classList.remove('show');
      try {
        const path = mode === 'register' ? '/api/register' : '/api/login';
        const data = await api(path, { method: 'POST', body });
        state.user = data.user;
        connectWs(data.wsToken);
        toast(mode === 'register' ? '注册成功' : '登录成功');
        let pendingRoom = null;
        try { pendingRoom = sessionStorage.getItem('jumpRoomRedirect'); } catch (_) {}
        if (!pendingRoom) {
          const m = location.pathname.match(/^\/jump\/r\/([A-Za-z0-9]+)/i);
          if (m) pendingRoom = m[1];
        }
        if (pendingRoom) openJumpRoom(pendingRoom);
        else routeHome();
      } catch (ex) {
        if (ex.data?.code === 'TOTP_REQUIRED') {
          const w = document.getElementById('totpWrap');
          w.classList.remove('hidden');
          w.querySelector('input').focus();
        }
        err.textContent = ex.message;
        err.classList.add('show');
      }
    };
  }

  // ---------- Account security settings (all users) ----------
  async function renderSettings() {
    history.replaceState(null, '', '/settings');
    const u = state.user;
    app.innerHTML = `
      <div class="shell">
        <div class="topbar">
          <div>
            <h1 class="glow-title" style="font-size:1.2rem">安全设置</h1>
            <div class="who"><span class="who-name">${escapeHtml(u.displayName || u.username)}</span> · @${escapeHtml(u.username)}</div>
          </div>
          <button class="btn btn-ghost btn-sm" id="backBtn">返回</button>
        </div>
        <div class="grid-2">
          <div class="panel" id="pwPanel">
            <h2>修改密码</h2>
            <form id="pwForm">
              <label>当前密码</label>
              <input name="currentPassword" type="password" required maxlength="72" autocomplete="current-password" />
              <label>新密码（至少 8 位）</label>
              <input name="newPassword" type="password" required minlength="8" maxlength="72" autocomplete="new-password" />
              <label>确认新密码</label>
              <input name="confirm" type="password" required minlength="8" maxlength="72" autocomplete="new-password" />
              <button class="btn btn-primary" type="submit">保存新密码</button>
              <p class="hint">修改后，其他设备上的登录会全部失效。</p>
            </form>
          </div>
          <div class="panel" id="tfaPanel">
            <h2>两步验证（2FA）</h2>
            <div id="tfaBody"></div>
          </div>
        </div>
        <div class="panel">
          <h2>我的登录设备</h2>
          <button class="btn btn-ghost btn-sm" id="logoutOthers" style="margin-bottom:10px">退出其他所有设备</button>
          <div id="mySessions"><div class="empty">加载中…</div></div>
        </div>
      </div>
    `;
    document.getElementById('backBtn').onclick = routeHome;
    document.getElementById('pwForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (fd.get('newPassword') !== fd.get('confirm')) return toast('两次输入的新密码不一致');
      try {
        const r = await api('/api/me/password', {
          method: 'POST',
          body: { currentPassword: fd.get('currentPassword'), newPassword: fd.get('newPassword') },
        });
        e.target.reset();
        toast(`密码已修改${r.otherSessionsClosed ? `，已退出其他 ${r.otherSessionsClosed} 台设备` : ''}`);
        loadMySessions();
      } catch (ex) { toast(ex.message); }
    };
    renderTfa();
    loadMySessions();
  }

  function renderTfa() {
    const box = document.getElementById('tfaBody');
    if (!box) return;
    if (state.user.totpEnabled) {
      box.innerHTML = `
        <p><span class="badge badge-unused">已开启</span> 登录时需要输入身份验证器中的 6 位验证码。</p>
        <form id="tfaOff">
          <label>当前密码</label>
          <input name="password" type="password" required maxlength="72" autocomplete="current-password" />
          <label>当前验证码</label>
          <input name="code" class="mono" inputmode="numeric" maxlength="6" required />
          <button class="btn btn-danger" type="submit">关闭两步验证</button>
        </form>`;
      document.getElementById('tfaOff').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          await api('/api/me/2fa/disable', { method: 'POST', body: { password: fd.get('password'), code: fd.get('code') } });
          state.user.totpEnabled = false;
          toast('两步验证已关闭');
          renderTfa();
        } catch (ex) { toast(ex.message); }
      };
      return;
    }
    box.innerHTML = `
      <p class="hint">开启后，登录除了密码还需要手机身份验证器（Google Authenticator、Microsoft Authenticator、腾讯身份验证器等）里的 6 位动态码。</p>
      <button class="btn btn-primary" id="tfaStart">开始设置</button>`;
    document.getElementById('tfaStart').onclick = async () => {
      try {
        const { qr, secret } = await api('/api/me/2fa/setup', { method: 'POST', body: {} });
        box.innerHTML = `
          <p>1. 用身份验证器 App 扫描二维码：</p>
          <div class="qr-wrap"><img alt="2FA 二维码" id="tfaQr" /></div>
          <p class="hint">无法扫码？手动输入密钥：<span class="mono" id="tfaSecret"></span></p>
          <form id="tfaOn">
            <label>2. 输入 App 显示的 6 位验证码确认</label>
            <input name="code" class="mono" inputmode="numeric" maxlength="6" required autocomplete="one-time-code" />
            <button class="btn btn-primary" type="submit">确认开启</button>
          </form>`;
        document.getElementById('tfaQr').src = qr;
        document.getElementById('tfaSecret').textContent = secret;
        document.getElementById('tfaOn').onsubmit = async (e) => {
          e.preventDefault();
          try {
            await api('/api/me/2fa/enable', { method: 'POST', body: { code: new FormData(e.target).get('code') } });
            state.user.totpEnabled = true;
            toast('两步验证已开启');
            renderTfa();
          } catch (ex) { toast(ex.message); }
        };
      } catch (ex) { toast(ex.message); }
    };
  }

  async function loadMySessions() {
    const box = document.getElementById('mySessions');
    if (!box) return;
    try {
      const { sessions } = await api('/api/me/sessions');
      box.innerHTML = sessionsTable(sessions, false);
      const lo = document.getElementById('logoutOthers');
      if (lo) lo.onclick = async () => {
        if (!confirm('确定让其他设备全部退出登录？')) return;
        try {
          const r = await api('/api/me/sessions/logout-others', { method: 'POST', body: {} });
          toast(`已退出 ${r.closed} 个其他设备`);
          loadMySessions();
        } catch (ex) { toast(ex.message); }
      };
    } catch (ex) {
      box.innerHTML = `<div class="empty">${escapeHtml(ex.message)}</div>`;
    }
  }

  function shortUA(ua) {
    const s = String(ua || '');
    const os = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
    const br = /MicroMessenger/.test(s) ? '微信' : /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : '';
    return [os, br].filter(Boolean).join(' · ') || s.slice(0, 40) || '未知设备';
  }

  function sessionsTable(sessions, withUser) {
    if (!sessions.length) return '<div class="empty">暂无在线会话</div>';
    return `
      <div style="overflow-x:auto"><table>
        <thead><tr>${withUser ? '<th>账号</th>' : ''}<th>设备</th><th>IP</th><th>登录时间</th><th>最近活动</th>${withUser ? '<th>操作</th>' : ''}</tr></thead>
        <tbody>
          ${sessions.map((x) => `
            <tr>
              ${withUser ? `<td><strong>${escapeHtml(x.displayName || x.username)}</strong><div class="muted-sm">@${escapeHtml(x.username)}${x.role === 'admin' ? ' · 管理员' : ''}</div></td>` : ''}
              <td title="${escapeHtml(x.userAgent)}">${escapeHtml(shortUA(x.userAgent))}${x.current ? ' <span class="badge badge-unused">当前</span>' : ''}</td>
              <td class="mono">${escapeHtml(x.ip)}</td>
              <td class="muted-sm">${formatTime(x.createdAt)}</td>
              <td class="muted-sm">${formatTime(x.lastSeen)}</td>
              ${withUser ? `<td>${x.role === 'member' ? `<button class="btn btn-danger btn-sm kick" data-uid="${Number(x.userId)}">强制下线</button>` : '—'}</td>` : ''}
            </tr>`).join('')}
        </tbody>
      </table></div>`;
  }

  // ---------- Member (premium) ----------
  const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function renderMember() {
    history.replaceState(null, '', '/member');
    const name = state.user.displayName || state.user.username;
    app.innerHTML = `
      <div class="shell mp">
        <header class="mp-top">
          <div class="mp-brand">
            <div class="mp-logo" aria-hidden="true">♠</div>
            <div>
              <div class="mp-eyebrow">PRIVATE MEMBER</div>
              <div class="who mp-who"><span class="live-dot ${state.wsConnected ? '' : 'off'}"></span><span class="who-name">${escapeHtml(name)}</span></div>
            </div>
          </div>
          <div class="mp-actions">
            <button class="mp-icon-btn" id="settingsBtn" title="安全设置" aria-label="安全设置">⚙<span>安全</span></button>
            <button class="mp-icon-btn" id="logoutBtn" title="退出登录" aria-label="退出登录">⏻<span>退出</span></button>
          </div>
        </header>

        <section class="mp-hero">
          <div class="mp-stage" id="cardStage">
            <div class="mp-aura" aria-hidden="true"></div>
            <div id="myCard" class="mp-card-slot"></div>
          </div>
          <div class="mp-cardinfo" id="cardInfo">
            <div class="mp-skel"></div>
          </div>
          <p class="mp-note"><span class="mp-lock">🔒</span> 仅你可见 · 管理员调整后实时同步</p>
        </section>

        <section class="mp-glass mp-wide mp-announce" id="announcePanel">
          <div class="mp-head">
            <h2>公告栏</h2>
            <span class="mp-chip gold" id="announceUnread">0 条未读</span>
          </div>
          <div id="announceList"><div class="mp-skel"></div></div>
          <div class="mp-row" style="justify-content:flex-end;margin-top:8px">
            <button type="button" class="mp-btn ghost sm" id="announceReadAll">全部标为已读</button>
          </div>
        </section>

        <section class="mp-glass mp-wide mp-achievements" id="achievementsPanel">
          <div class="mp-head">
            <h2>成就勋章</h2>
            <span class="mp-chip gold" id="achCount">0 / 0</span>
          </div>
          <div class="ach-grid" id="achGrid"><div class="mp-skel"></div></div>
        </section>

        <section class="mp-glass mp-wide mp-jump" id="jumpPanel">
          <div class="mp-head">
            <h2>小游戏 · 跳一跳</h2>
            <span class="mp-chip gold" id="jumpBestChip">最佳 0</span>
          </div>
          <p class="mp-fine">按住蓄力、松手起跳。落在下一座平台得分，踩中圆心额外加分。排行榜对成员只显示匿名代号。</p>
          <div id="jumpMultiEntry"></div>
          <div id="jumpGameRoot" class="jg-root"></div>
          <div class="mp-head" style="margin-top:14px"><h2>排行榜</h2><span class="mp-chip">TOP 20</span></div>
          <div id="jumpBoard"><div class="mp-skel"></div></div>
        </section>

        <div class="mp-grid">
          ${window.ChatUI ? ChatUI.memberShell() : ''}
          <section class="mp-glass mp-inviter">
            <div class="mp-label">我的邀请人</div>
            <div class="mp-person" id="myInviter"><span class="mp-skel sm"></span></div>
          </section>

          <section class="mp-glass">
            <div class="mp-head">
              <h2>我的邀请码</h2>
              <span class="mp-chip">每人限 1 个</span>
            </div>
            <div id="myInvite"><div class="mp-skel"></div></div>
            <p class="mp-fine">同一时间只能持有 1 个有效邀请码（7 天有效）。被使用、过期或撤销后，才可生成新的。</p>
          </section>

          <section class="mp-glass">
            <div class="mp-head"><h2>我邀请的成员</h2><span class="mp-chip" id="invitedCount">0</span></div>
            <div id="myInvited"><div class="mp-skel"></div></div>
          </section>

          <section class="mp-glass mp-wide">
            <div class="mp-head"><h2>致管理员</h2><span class="mp-chip gold">建议 / 要求</span></div>
            <form id="sugForm" class="mp-form">
              <div class="mp-seg" role="radiogroup" aria-label="类型">
                <label><input type="radio" name="type" value="suggestion" checked /><span>💡 建议</span></label>
                <label><input type="radio" name="type" value="request" /><span>📌 要求</span></label>
              </div>
              <div class="mp-textarea">
                <textarea name="content" placeholder="写给管理员的内容…" required maxlength="2000" rows="4"></textarea>
                <span class="mp-count" id="sugCount">0 / 2000</span>
              </div>
              <button class="mp-btn gold" type="submit">提交给管理员</button>
            </form>
          </section>

          <section class="mp-glass mp-wide">
            <div class="mp-head"><h2>我的提交记录</h2></div>
            <div id="mySugs"><div class="mp-skel"></div></div>
          </section>
        </div>
      </div>
    `;
    document.getElementById('logoutBtn').onclick = logout;
    document.getElementById('settingsBtn').onclick = renderSettings;
    const form = document.getElementById('sugForm');
    const ta = form.querySelector('textarea');
    ta.oninput = () => { document.getElementById('sugCount').textContent = `${ta.value.length} / 2000`; };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api('/api/my/suggestions', {
          method: 'POST',
          body: { type: fd.get('type'), content: fd.get('content') },
        });
        e.target.reset();
        ta.oninput();
        toast('✓ 已送达管理员');
        loadMySuggestions();
      } catch (ex) {
        toast(ex.message);
      } finally { btn.disabled = false; }
    };
    setupTilt(document.getElementById('cardStage'));
    loadMyCard();
    loadMySuggestions();
    loadMyInvite();
    loadAnnouncements();
    loadMyAchievements();
    loadJumpGame();
    const readAllBtn = document.getElementById('announceReadAll');
    if (readAllBtn) readAllBtn.onclick = async () => {
      try {
        await api('/api/announcements/read-all', { method: 'POST', body: {} });
        toast('已全部标为已读');
        loadAnnouncements();
      } catch (ex) { toast(ex.message); }
    };
    if (window.ChatUI) {
      state.chatCtrl = ChatUI.bind(document.getElementById('chatPanel') || app, api, toast, { admin: false });
      state.chatCtrl.markOpen();
    }
  }

  function setupTilt(stage) {
    if (!stage || REDUCED_MOTION) return;
    const reset = () => { stage.style.setProperty('--rx', '0deg'); stage.style.setProperty('--ry', '0deg'); stage.style.setProperty('--mx', '50%'); stage.style.setProperty('--my', '30%'); };
    stage.addEventListener('pointermove', (e) => {
      const r = stage.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      stage.style.setProperty('--ry', `${(x - 0.5) * 18}deg`);
      stage.style.setProperty('--rx', `${(0.5 - y) * 14}deg`);
      stage.style.setProperty('--mx', `${x * 100}%`);
      stage.style.setProperty('--my', `${y * 100}%`);
    });
    stage.addEventListener('pointerleave', reset);
    reset();
  }

  async function loadMyCard() {
    try {
      const { card } = await api('/api/my/card');
      renderMemberCard(card, false);
    } catch (ex) {
      toast(ex.message);
    }
  }

  function premiumCardHtml(card) {
    if (!card) {
      return `<div class="pc pc-empty"><div class="pc-back"><div class="pc-back-mark">♠</div><div class="pc-back-txt">等待发牌</div></div></div>`;
    }
    const sheen = '<div class="pc-sheen" aria-hidden="true"></div>';
    if (card.isJoker) {
      const small = card.rank === 'joker_small';
      return `<div class="pc pc-joker ${small ? 'small' : 'big'}">
        <div class="pc-jk-corner">JOKER</div>
        <div class="pc-jk-art">${small ? '🃏' : '👑'}</div>
        <div class="pc-jk-tag">${escapeHtml(card.label)}</div>
        <div class="pc-jk-corner br">JOKER</div>${sheen}</div>`;
    }
    const color = card.color === 'red' ? 'red' : 'black';
    const corner = `<span class="r">${escapeHtml(card.label)}</span><span class="s">${card.symbol}</span>`;
    return `<div class="pc pc-${color}">
      <div class="pc-corner">${corner}</div>
      <div class="pc-center"><span>${card.symbol}</span></div>
      <div class="pc-corner br">${corner}</div>${sheen}</div>`;
  }

  function renderMemberCard(card, flip) {
    const el = document.getElementById('myCard');
    const info = document.getElementById('cardInfo');
    if (!el) return;
    const apply = () => {
      el.innerHTML = premiumCardHtml(card);
      if (info) {
        info.innerHTML = card
          ? `<div class="mp-rank">${escapeHtml(card.isJoker ? card.label : (card.suitLabel || '') + card.label)}</div>
             <div class="mp-level"><span>LEVEL</span><strong>${Number(card.level)}</strong><span>/ 15</span></div>
             <div class="mp-bar"><i style="width:${Math.round((Number(card.level) / 15) * 100)}%"></i></div>`
          : `<div class="mp-rank muted">尚未分配卡牌</div><div class="mp-fine">管理员发牌后，这里会实时亮起。</div>`;
      }
    };
    if (flip && !REDUCED_MOTION) {
      el.classList.remove('pc-in'); el.classList.add('pc-out');
      setTimeout(() => { apply(); el.classList.remove('pc-out'); void el.offsetWidth; el.classList.add('pc-in'); }, 320);
    } else {
      apply();
    }
  }

  async function loadMyInvite() {
    const box = document.getElementById('myInvite');
    const who = document.getElementById('myInviter');
    const invitedBox = document.getElementById('myInvited');
    if (!box) return;
    try {
      const r = await api('/api/my/invite');
      if (who) {
        const ib = r.invitedBy;
        const nm = ib ? ib.name : '未知';
        who.innerHTML = `<span class="mp-avatar ${ib && ib.role === 'admin' ? 'gold' : ''}">${escapeHtml((nm || '?').slice(0, 1))}</span>
          <span class="mp-person-name">${escapeHtml(nm)}</span>${ib && ib.role === 'admin' ? '<span class="mp-chip gold">管理员</span>' : ''}`;
      }
      if (invitedBox) {
        document.getElementById('invitedCount').textContent = String(r.invitedMembers.length);
        invitedBox.innerHTML = r.invitedMembers.length
          ? `<ul class="mp-list">${r.invitedMembers.map((m) => `<li><span class="mp-avatar">${escapeHtml(m.displayName.slice(0, 1))}</span><span>${escapeHtml(m.displayName)}</span><span class="mp-time">${formatTime(m.createdAt)}</span></li>`).join('')}</ul>`
          : `<div class="mp-empty"><div class="mp-empty-ico">✦</div><div>还没有邀请任何人</div><div class="mp-fine">生成邀请码发给朋友，他们加入后会出现在这里。</div></div>`;
      }
      const inv = r.invite && r.invite.status === 'unused' ? r.invite : null;
      box.innerHTML = inv
        ? `<div class="mp-ticket">
             <div class="mp-ticket-code mono">${escapeHtml(inv.code)}</div>
             <div class="mp-fine">有效期至 ${formatTime(inv.expiresAt)}</div>
             <div class="mp-row"><button class="mp-btn gold sm" id="copyInv">复制邀请码</button><button class="mp-btn ghost danger sm" id="revokeInv">撤销</button></div>
           </div>`
        : `<div class="mp-empty"><div class="mp-empty-ico">✉</div><div>当前没有有效邀请码</div>
             <button class="mp-btn gold sm" id="genInv">生成邀请码</button></div>`;
      const g = document.getElementById('genInv');
      if (g) g.onclick = async () => {
        g.disabled = true;
        try { await api('/api/my/invite', { method: 'POST', body: {} }); toast('✓ 已生成邀请码'); } catch (ex) { toast(ex.message); }
        loadMyInvite();
      };
      const rv = document.getElementById('revokeInv');
      if (rv) rv.onclick = async () => {
        if (!confirm('确定撤销这个邀请码？撤销后它将无法再使用。')) return;
        try { await api('/api/my/invite/revoke', { method: 'POST', body: {} }); toast('已撤销'); } catch (ex) { toast(ex.message); }
        loadMyInvite();
      };
      const cp = document.getElementById('copyInv');
      if (cp) cp.onclick = () => navigator.clipboard?.writeText(inv.code).then(() => toast('✓ 已复制'), () => toast(inv.code));
    } catch (ex) {
      box.innerHTML = `<div class="mp-empty">${escapeHtml(ex.message)}</div>`;
    }
  }

  async function loadMySuggestions() {
    const box = document.getElementById('mySugs');
    if (!box) return;
    try {
      const { suggestions } = await api('/api/my/suggestions');
      if (!suggestions.length) {
        box.innerHTML = '<div class="mp-empty"><div class="mp-empty-ico">✎</div><div>暂无提交记录</div><div class="mp-fine">你的建议和要求会在这里显示处理进度。</div></div>';
        return;
      }
      box.innerHTML = `<ul class="mp-sugs">${suggestions.map((s) => `
        <li class="${s.status === 'pending' ? 'pending' : 'done'}">
          <div class="mp-sug-head">
            <span class="mp-chip">${s.type === 'request' ? '📌 要求' : '💡 建议'}</span>
            <span class="badge ${s.status === 'pending' ? 'badge-pending' : 'badge-handled'}">${s.status === 'pending' ? '待处理' : '已处理'}</span>
          </div>
          <div class="mp-sug-body">${escapeHtml(s.content)}</div>
          <div class="mp-time">${formatTime(s.createdAt)}</div>
          ${s.adminReply ? `<div class="mp-reply"><span>管理员回复</span>${escapeHtml(s.adminReply)}</div>` : ''}
        </li>`).join('')}</ul>`;
    } catch (ex) {
      box.innerHTML = `<div class="mp-empty">${escapeHtml(ex.message)}</div>`;
    }
  }


  async function loadAnnouncements() {
    const box = document.getElementById('announceList');
    const badge = document.getElementById('announceUnread');
    if (!box) return;
    try {
      const r = await api('/api/announcements');
      const list = r.announcements || [];
      const unread = Number(r.unread || 0);
      if (badge) badge.textContent = unread ? (unread + ' 条未读') : '全部已读';
      if (!list.length) {
        box.innerHTML = `<div class="mp-empty"><div class="mp-empty-ico">📢</div><div>暂无公告</div><p class="mp-fine">管理员发布后会实时出现在这里</p></div>`;
        return;
      }
      box.innerHTML = `<ul class="ann-list">${list.map((a) => `
        <li class="ann-item ${a.pinned ? 'pinned' : ''} ${a.read ? 'read' : 'unread'}" data-id="${a.id}">
          <div class="ann-top">
            <div class="ann-title">${a.pinned ? '<span class="ann-pin" title="置顶">📌</span>' : ''}${escapeHtml(a.title)}${a.read ? '' : '<span class="ann-dot" aria-label="未读"></span>'}</div>
            <time class="mp-time">${formatTime(a.createdAt)}</time>
          </div>
          <div class="ann-body">${escapeHtml(a.body)}</div>
          ${a.expiresAt ? `<div class="ann-exp">有效至 ${escapeHtml(a.expiresAt)}</div>` : ''}
        </li>`).join('')}</ul>`;
      box.querySelectorAll('.ann-item.unread').forEach((el) => {
        el.addEventListener('click', async () => {
          const id = el.dataset.id;
          try {
            await api('/api/announcements/' + id + '/read', { method: 'POST', body: {} });
            el.classList.remove('unread'); el.classList.add('read');
            const dot = el.querySelector('.ann-dot'); if (dot) dot.remove();
            // refresh unread chip
            const still = box.querySelectorAll('.ann-item.unread').length;
            if (badge) badge.textContent = still ? (still + ' 条未读') : '全部已读';
          } catch (_) {}
        }, { once: true });
      });
    } catch (ex) {
      box.innerHTML = `<div class="empty">${escapeHtml(ex.message)}</div>`;
    }
  }

  async function loadMyAchievements() {
    const grid = document.getElementById('achGrid');
    const count = document.getElementById('achCount');
    if (!grid) return;
    try {
      const r = await api('/api/my/achievements');
      const badges = r.badges || [];
      if (count) count.textContent = `${r.unlocked || 0} / ${r.total || badges.length}`;
      grid.innerHTML = badges.map((b) => `
        <div class="ach-card ${b.unlocked ? 'on' : 'off'}" title="${escapeHtml(b.description)}">
          <div class="ach-medal" aria-hidden="true">
            <svg viewBox="0 0 64 64" width="48" height="48">
              <defs>
                <linearGradient id="g${b.key}" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stop-color="${b.unlocked ? '#fff1bf' : '#3a3f4d'}"/>
                  <stop offset="55%" stop-color="${b.unlocked ? '#c9a13b' : '#232833'}"/>
                  <stop offset="100%" stop-color="${b.unlocked ? '#8a6a1f' : '#151821'}"/>
                </linearGradient>
              </defs>
              <circle cx="32" cy="28" r="18" fill="url(#g${b.key})" stroke="${b.unlocked ? '#ffe9a0' : '#555'}" stroke-width="2"/>
              <path d="M22 44 L18 58 L32 50 L46 58 L42 44" fill="${b.unlocked ? '#c9a13b' : '#2a2f3d'}" opacity=".9"/>
              <text x="32" y="33" text-anchor="middle" font-size="14">${b.icon || '🏅'}</text>
            </svg>
          </div>
          <div class="ach-name">${escapeHtml(b.name)}</div>
          <div class="ach-desc">${escapeHtml(b.description)}</div>
          <div class="ach-state">${b.unlocked ? '已解锁 · ' + escapeHtml(formatTime(b.unlockedAt)) : '未解锁'}</div>
        </div>`).join('');
    } catch (ex) {
      grid.innerHTML = `<div class="empty">${escapeHtml(ex.message)}</div>`;
    }
  }



  function pendingJumpRoomCode() {
    const m = location.pathname.match(/^\/jump\/r\/([A-Za-z0-9]+)/i);
    if (m) return m[1].toUpperCase();
    const q = new URLSearchParams(location.search).get('room');
    if (q) return String(q).toUpperCase();
    try {
      const s = sessionStorage.getItem('jumpRoomRedirect');
      if (s) return String(s).toUpperCase();
    } catch (_) {}
    return null;
  }

  function ensureJumpMulti() {
    if (state.jumpMulti) return state.jumpMulti;
    if (!window.JumpMultiUI) return null;
    state.jumpMulti = JumpMultiUI.createController({
      api,
      toast,
      getWs: () => state.ws,
      getUser: () => state.user,
      navigate: (path) => {
        try { sessionStorage.removeItem('jumpRoomRedirect'); } catch (_) {}
        if (path === '/member' || path === '/admin') routeHome();
        else history.replaceState(null, '', path);
      },
    });
    return state.jumpMulti;
  }

  async function openJumpRoom(code) {
    try { sessionStorage.removeItem('jumpRoomRedirect'); } catch (_) {}
    const ctrl = ensureJumpMulti();
    if (!ctrl) { toast('联机模块未加载'); return routeHome(); }
    history.replaceState(null, '', '/jump/r/' + String(code).toUpperCase());
    app.innerHTML = `<div class="shell"><div id="jumpRoomPage" class="jmr-page"><div class="mp-skel"></div></div></div>`;
    await ctrl.openIn(document.getElementById('jumpRoomPage'), code);
  }

  async function loadJumpGame() {
    const root = document.getElementById('jumpGameRoot');
    const chip = document.getElementById('jumpBestChip');
    const board = document.getElementById('jumpBoard');
    if (!root || !window.JumpGame) return;
    let best = 0;
    try {
      const me = await api('/api/jump/me');
      best = Number(me.best || 0);
      if (chip) chip.textContent = '最佳 ' + best;
    } catch (_) {}
    if (root._jg) { try { root._jg.destroy(); } catch (_) {} }
    JumpGame.mount(root, {
      best,
      onGameOver: async ({ score, hops, durationMs }) => {
        try {
          const r = await api('/api/jump/score', {
            method: 'POST',
            body: { score, hops, durationMs },
          });
          if (chip) chip.textContent = '最佳 ' + r.best;
          if (root._jg) root._jg.setBest(r.best);
          if (r.isNewBest) toast('🏆 新纪录 ' + r.best);
          if (r.newBadges && r.newBadges.length) {
            r.newBadges.forEach((b) => toast('🏅 解锁成就：' + b.name));
            loadMyAchievements();
          }
          loadJumpBoard();
        } catch (ex) {
          toast(ex.message || '分数提交失败');
        }
      },
    });
    loadJumpBoard();
    wireJumpMultiEntry();
  }

  function wireJumpMultiEntry() {
    const box = document.getElementById('jumpMultiEntry');
    if (!box || !window.JumpMultiUI) return;
    box.innerHTML = JumpMultiUI.entryCardHtml();
    const form = box.querySelector('#jmrJoinForm');
    box.querySelector('#jmrCreateBtn').onclick = async () => {
      try {
        const ctrl = ensureJumpMulti();
        app.innerHTML = `<div class="shell"><div id="jumpRoomPage" class="jmr-page"><div class="mp-skel"></div></div></div>`;
        await ctrl.createAndOpen(document.getElementById('jumpRoomPage'));
      } catch (e) { toast(e.message); routeHome(); }
    };
    box.querySelector('#jmrJoinBtn').onclick = () => {
      form.classList.toggle('hidden');
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const code = new FormData(form).get('code');
      if (!code) return;
      openJumpRoom(String(code).trim());
    };
  }

  async function loadJumpBoard() {
    const board = document.getElementById('jumpBoard');
    if (!board) return;
    try {
      const r = await api('/api/jump/leaderboard?limit=20');
      const list = r.leaderboard || [];
      if (!list.length) {
        board.innerHTML = `<div class="mp-empty"><div class="mp-empty-ico">🕹️</div><div>暂无成绩</div><p class="mp-fine">完成一局后会出现在这里</p></div>`;
        return;
      }
      board.innerHTML = `<ol class="jg-board">${list.map((row) => `
        <li class="${row.me ? 'me' : ''}">
          <span class="jg-rank">${row.rank}</span>
          <span class="jg-alias">${escapeHtml(row.alias)}${row.me ? ' · 我' : ''}</span>
          <span class="jg-pts">${row.score}</span>
        </li>`).join('')}</ol>`;
    } catch (ex) {
      board.innerHTML = `<div class="empty">${escapeHtml(ex.message)}</div>`;
    }
  }

  // ---------- Admin ----------
  function renderAdmin() {
    history.replaceState(null, '', '/admin');
    app.innerHTML = `
      <div class="shell">
        <div class="topbar">
          <div>
            <h1 class="glow-title" style="font-size:1.2rem">管理控制台</h1>
            <div class="who"><span class="live-dot ${state.wsConnected ? '' : 'off'}"></span>管理员 · ${escapeHtml(state.user.username)}</div>
          </div>
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" id="settingsBtn">安全设置</button>
            <button class="btn btn-ghost btn-sm" id="logoutBtn">退出登录</button>
          </div>
        </div>
        <div class="tabs" id="tabs">
          <button class="tab active" data-tab="members">成员与卡牌</button>
          <button class="tab" data-tab="ranking">等级排行</button>
          <button class="tab" data-tab="suggestions">建议 / 要求</button>
          <button class="tab" data-tab="invites">邀请码</button>
          <button class="tab" data-tab="announcements">公告栏</button>
          <button class="tab" data-tab="jump">跳一跳</button>
          <button class="tab" data-tab="chat">匿名聊天</button>
          <button class="tab" data-tab="security">安全中心</button>
        </div>
        <div id="tabBody"></div>
      </div>
    `;
    document.getElementById('logoutBtn').onclick = logout;
    document.getElementById('settingsBtn').onclick = renderSettings;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
    document.getElementById('tabs').onclick = (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      state.tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
      refreshAdminTab();
    };
    refreshAdminTab();
  }

  function refreshAdminTab() {
    if (state.user?.role !== 'admin') return;
    state.editingName = false;
    state.pendingRefresh = false;
    const map = {
      members: renderMembersTab,
      ranking: renderRankingTab,
      suggestions: renderSuggestionsTab,
      invites: renderInvitesTab,
      announcements: renderAnnouncementsTab,
      jump: renderJumpAdminTab,
      chat: renderChatTab,
      security: renderSecurityTab,
    };
    (map[state.tab] || map.members)();
  }

  async function renderMembersTab() {
    const body = document.getElementById('tabBody');
    if (!body) return;
    body.innerHTML = `<div class="panel"><div class="empty">加载中…</div></div>`;
    try {
      const { members } = await api('/api/admin/members');
      const rankOpts = state.meta.ranks.map((r) =>
        `<option value="${r.id}">${r.label} (Lv.${r.level})</option>`
      ).join('');
      const suitOpts = state.meta.suits.map((s) =>
        `<option value="${s.id}">${s.symbol} ${s.label}</option>`
      ).join('');

      body.innerHTML = `
        <div class="panel">
          <h2>成员列表（共 ${members.length}）</h2>
          <div style="overflow-x:auto">
            <table>
              <thead>
                <tr><th>成员</th><th>邀请人</th><th>成就</th><th>当前牌</th><th>设置卡牌</th><th>状态</th><th>操作</th></tr>
              </thead>
              <tbody>
                ${members.map((m) => `
                  <tr data-id="${m.id}">
                    <td class="name-cell">
                      <div class="name-view">
                        <strong class="mem-name">${escapeHtml(m.displayName)}</strong>
                        <button class="btn btn-ghost btn-xs edit-name" title="修改姓名">修改姓名</button>
                      </div>
                      <form class="name-edit hidden">
                        <input class="name-input" maxlength="20" value="${escapeHtml(m.displayName)}" aria-label="新姓名" />
                        <button class="btn btn-primary btn-xs" type="submit">保存</button>
                        <button class="btn btn-ghost btn-xs name-cancel" type="button">取消</button>
                      </form>
                      <div style="font-size:.78rem;color:var(--muted)">@${escapeHtml(m.username)}</div>
                    </td>
                    <td class="inviter-cell">${m.invitedBy ? (m.invitedBy.role === 'admin' ? '<span class="badge badge-handled">管理员</span>' : escapeHtml(m.invitedBy.name)) : '未知'}</td>
                    <td class="ach-cell"><span class="badge badge-pending" title="${escapeHtml((m.achievements?.keys || []).join(', '))}">🏅 ${(m.achievements && m.achievements.unlocked) || 0}/${(m.achievements && m.achievements.total) || 0}</span></td>
                    <td>${CardsUI.mini(m.card)}</td>
                    <td>
                      <div class="form-inline">
                        <div class="field">
                          <select class="rank-sel">${rankOpts}</select>
                        </div>
                        <div class="field suit-wrap">
                          <select class="suit-sel">${suitOpts}</select>
                        </div>
                        <button class="btn btn-primary btn-sm set-card">设置</button>
                        <button class="btn btn-ghost btn-sm clear-card">清空</button>
                      </div>
                    </td>
                    <td>${m.disabled ? '<span class="badge badge-revoked">已停用</span>' : '<span class="badge badge-unused">正常</span>'}
                      ${m.totpEnabled ? '<span class="badge badge-handled">2FA</span>' : ''}</td>
                    <td class="row-actions">
                      <button class="btn btn-ghost btn-sm kick-mem">强制下线</button>
                      ${m.totpEnabled ? '<button class="btn btn-ghost btn-sm reset-2fa">重置2FA</button>' : ''}
                      <button class="btn btn-ghost btn-sm toggle-dis">${m.disabled ? '启用' : '停用'}</button>
                      <button class="btn btn-danger btn-sm del-mem">删除</button>
                    </td>
                  </tr>
                `).join('') || '<tr><td colspan="6" class="empty">暂无成员，请先生成邀请码</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      `;

      body.querySelectorAll('tr[data-id]').forEach((tr) => {
        const id = tr.dataset.id;
        const rankSel = tr.querySelector('.rank-sel');
        const suitWrap = tr.querySelector('.suit-wrap');
        const syncSuit = () => {
          const isJoker = rankSel.value.startsWith('joker');
          suitWrap.style.display = isJoker ? 'none' : '';
        };
        rankSel.onchange = syncSuit;
        // preselect current
        const m = members.find((x) => String(x.id) === id);
        if (m?.card) {
          rankSel.value = m.card.rank;
          if (m.card.suit) tr.querySelector('.suit-sel').value = m.card.suit;
        }
        syncSuit();

        tr.querySelector('.set-card').onclick = async () => {
          const rank = rankSel.value;
          const suit = tr.querySelector('.suit-sel').value;
          try {
            await api(`/api/admin/members/${id}/card`, {
              method: 'PUT',
              body: { rank, suit: rank.startsWith('joker') ? null : suit },
            });
            toast('卡牌已更新');
            refreshAdminTab();
          } catch (ex) { toast(ex.message); }
        };
        tr.querySelector('.clear-card').onclick = async () => {
          try {
            await api(`/api/admin/members/${id}/card`, { method: 'PUT', body: { rank: null } });
            toast('已清空');
            refreshAdminTab();
          } catch (ex) { toast(ex.message); }
        };
        const view = tr.querySelector('.name-view');
        const form = tr.querySelector('.name-edit');
        const input = tr.querySelector('.name-input');
        tr.querySelector('.edit-name').onclick = () => {
          state.editingName = true;
          view.classList.add('hidden'); form.classList.remove('hidden');
          input.value = m.displayName; input.focus(); input.select();
        };
        const closeEdit = () => {
          state.editingName = false;
          form.classList.add('hidden'); view.classList.remove('hidden');
          if (state.pendingRefresh) refreshAdminTab();
        };
        tr.querySelector('.name-cancel').onclick = closeEdit;
        input.onkeydown = (e) => { if (e.key === 'Escape') closeEdit(); };
        form.onsubmit = async (e) => {
          e.preventDefault();
          const name = input.value.trim();
          const len = [...name].length;
          if (len < 1 || len > 20) { toast('姓名需 1–20 个字'); return; }
          try {
            const r = await api(`/api/admin/members/${id}/name`, { method: 'PUT', body: { displayName: name } });
            closeEdit();
            toast(r.changed ? '姓名已修改' : '姓名未变化');
            refreshAdminTab();
          } catch (ex) { toast(ex.message); }
        };
        tr.querySelector('.toggle-dis').onclick = async () => {
          try {
            await api(`/api/admin/members/${id}/disable`, {
              method: 'POST',
              body: { disabled: !m.disabled },
            });
            refreshAdminTab();
          } catch (ex) { toast(ex.message); }
        };
        tr.querySelector('.kick-mem').onclick = async () => {
          try {
            const r = await api(`/api/admin/members/${id}/logout`, { method: 'POST', body: {} });
            toast(`已强制下线（关闭 ${r.closed} 个会话）`);
          } catch (ex) { toast(ex.message); }
        };
        const r2 = tr.querySelector('.reset-2fa');
        if (r2) r2.onclick = async () => {
          if (!confirm(`确认重置 ${m.username} 的两步验证？该成员下次登录只需密码。`)) return;
          try {
            await api(`/api/admin/members/${id}/reset-2fa`, { method: 'POST', body: {} });
            toast('已重置两步验证');
            refreshAdminTab();
          } catch (ex) { toast(ex.message); }
        };
        tr.querySelector('.del-mem').onclick = async () => {
          if (!confirm(`确认删除成员 ${m.username}？`)) return;
          try {
            await api(`/api/admin/members/${id}`, { method: 'DELETE' });
            toast('已删除');
            refreshAdminTab();
          } catch (ex) { toast(ex.message); }
        };
      });
    } catch (ex) {
      body.innerHTML = `<div class="panel"><div class="empty">${escapeHtml(ex.message)}</div></div>`;
    }
  }

  async function renderRankingTab() {
    const body = document.getElementById('tabBody');
    body.innerHTML = `<div class="panel"><div class="empty">加载中…</div></div>`;
    try {
      const { ranking } = await api('/api/admin/ranking');
      body.innerHTML = `
        <div class="panel">
          <h2>等级排行榜（高 → 低）</h2>
          <table>
            <thead><tr><th>#</th><th>成员</th><th>卡牌</th><th>等级</th></tr></thead>
            <tbody>
              ${ranking.map((r, i) => `
                <tr>
                  <td>${i + 1}</td>
                  <td>${escapeHtml(r.displayName)}</td>
                  <td>${CardsUI.mini(r.card)}</td>
                  <td>${r.level || '—'}</td>
                </tr>
              `).join('') || '<tr><td colspan="4" class="empty">暂无数据</td></tr>'}
            </tbody>
          </table>
        </div>
      `;
    } catch (ex) {
      body.innerHTML = `<div class="panel"><div class="empty">${escapeHtml(ex.message)}</div></div>`;
    }
  }

  async function renderSuggestionsTab() {
    const body = document.getElementById('tabBody');
    body.innerHTML = `<div class="panel"><div class="empty">加载中…</div></div>`;
    try {
      const { suggestions } = await api('/api/admin/suggestions');
      body.innerHTML = `
        <div class="panel">
          <h2>建议与要求</h2>
          ${suggestions.map((s) => `
            <div style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,.06)" data-sid="${s.id}">
              <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
                <div>
                  <strong>${escapeHtml(s.displayName || s.username)}</strong>
                  <span style="color:var(--muted);font-size:.85rem"> · ${s.type === 'request' ? '要求' : '建议'}</span>
                </div>
                <span class="badge ${s.status === 'pending' ? 'badge-pending' : 'badge-handled'}">${s.status === 'pending' ? '待处理' : '已处理'}</span>
              </div>
              <div style="margin:8px 0;white-space:pre-wrap">${escapeHtml(s.content)}</div>
              <div style="font-size:.78rem;color:var(--muted)">${formatTime(s.createdAt)}</div>
              ${s.adminReply ? `<div style="margin-top:6px;color:var(--neon)">回复：${escapeHtml(s.adminReply)}</div>` : ''}
              ${s.status === 'pending' ? `
                <div class="form-inline" style="margin-top:8px">
                  <div class="field" style="flex:2">
                    <input class="reply-inp" placeholder="可选回复" />
                  </div>
                  <button class="btn btn-primary btn-sm handle-btn">标记已处理</button>
                </div>
              ` : ''}
            </div>
          `).join('') || '<div class="empty">暂无提交</div>'}
        </div>
      `;
      body.querySelectorAll('.handle-btn').forEach((btn) => {
        btn.onclick = async () => {
          const wrap = btn.closest('[data-sid]');
          const id = wrap.dataset.sid;
          const reply = wrap.querySelector('.reply-inp')?.value || '';
          try {
            await api(`/api/admin/suggestions/${id}/handle`, { method: 'POST', body: { reply } });
            toast('已处理');
            refreshAdminTab();
          } catch (ex) { toast(ex.message); }
        };
      });
    } catch (ex) {
      body.innerHTML = `<div class="panel"><div class="empty">${escapeHtml(ex.message)}</div></div>`;
    }
  }

  async function renderInvitesTab() {
    const body = document.getElementById('tabBody');
    body.innerHTML = `<div class="panel"><div class="empty">加载中…</div></div>`;
    try {
      const { invites } = await api('/api/admin/invites');
      body.innerHTML = `
        <div class="panel">
          <h2>邀请码</h2>
          <div class="form-inline" style="margin-bottom:14px">
            <div class="field">
              <label>有效期</label>
              <select id="invDays">
                <option value="1">1 天</option>
                <option value="3">3 天</option>
                <option value="7" selected>7 天</option>
                <option value="30">30 天</option>
                <option value="0">永久有效</option>
              </select>
            </div>
            <div class="field" style="flex:2">
              <label>备注（发给谁，可选）</label>
              <input id="invNote" maxlength="50" placeholder="例如：小王" />
            </div>
            <button class="btn btn-primary btn-sm" id="gen1">生成 1 个</button>
            <button class="btn btn-ghost btn-sm" id="gen5">生成 5 个</button>
          </div>
          <div style="overflow-x:auto"><table>
            <thead><tr><th>邀请码</th><th>生成人</th><th>备注</th><th>状态</th><th>使用者</th><th>有效期至</th><th>操作</th></tr></thead>
            <tbody>
              ${invites.map((i) => `
                <tr>
                  <td class="mono">${escapeHtml(i.code)}</td>
                  <td>${escapeHtml(i.createdByName || '未知')}</td>
                  <td>${i.note ? escapeHtml(i.note) : '—'}</td>
                  <td><span class="badge badge-${escapeHtml(i.status)}">${statusLabel(i.status)}</span></td>
                  <td>${i.usedByUsername ? escapeHtml(i.usedByUsername) : '—'}</td>
                  <td class="muted-sm">${i.expiresAt ? formatTime(i.expiresAt) : '永久'}</td>
                  <td>
                    ${i.status === 'unused' ? `<button class="btn btn-danger btn-sm revoke" data-id="${i.id}">撤销</button>` : '—'}
                  </td>
                </tr>
              `).join('') || '<tr><td colspan="7" class="empty">暂无邀请码</td></tr>'}
            </tbody>
          </table></div>
        </div>
      `;
      const gen = async (n) => {
        try {
          const { codes } = await api('/api/admin/invites', {
            method: 'POST',
            body: {
              count: n,
              expiresInDays: Number(document.getElementById('invDays').value),
              note: document.getElementById('invNote').value.trim() || undefined,
            },
          });
          toast(`已生成：${codes.join(', ')}`);
          refreshAdminTab();
        } catch (ex) { toast(ex.message); }
      };
      document.getElementById('gen1').onclick = () => gen(1);
      document.getElementById('gen5').onclick = () => gen(5);
      body.querySelectorAll('.revoke').forEach((btn) => {
        btn.onclick = async () => {
          try {
            await api(`/api/admin/invites/${btn.dataset.id}/revoke`, { method: 'POST', body: {} });
            toast('已撤销');
            refreshAdminTab();
          } catch (ex) { toast(ex.message); }
        };
      });
    } catch (ex) {
      body.innerHTML = `<div class="panel"><div class="empty">${escapeHtml(ex.message)}</div></div>`;
    }
  }

  const AUDIT_REASON = {
    ok: '登录成功', ok_2fa: '登录成功（2FA）', register: '注册', bad_password: '密码错误', no_user: '账号不存在',
    bad_totp: '验证码错误', locked: '已锁定', disabled: '账号停用', pw_changed: '修改密码',
    pw_change_bad_current: '改密失败', '2fa_enabled': '开启2FA', '2fa_disabled': '关闭2FA',
    '2fa_reset_by_admin': '管理员重置2FA', forced_logout_by_admin: '被强制下线', unlocked_by_admin: '管理员解锁', display_name_changed: '修改姓名', member_invite_created: '成员生成邀请码', member_invite_revoked: '成员撤销邀请码', announcement_created: '发布公告', announcement_updated: '编辑公告', announcement_deleted: '删除公告', announcement_pinned: '置顶公告', announcement_unpinned: '取消置顶', logout_others: '退出其他设备',
  };



  async function renderJumpAdminTab() {
    const body = document.getElementById('tabBody');
    if (!body) return;
    body.innerHTML = `<div class="panel"><div class="empty">加载中…</div></div>`;
    try {
      const [me, board] = await Promise.all([
        api('/api/jump/me'),
        api('/api/jump/leaderboard?limit=30'),
      ]);
      body.innerHTML = `
        <div class="panel">
          <h2>跳一跳 · 管理端</h2>
          <p class="muted-sm">你可以自己玩；排行榜对你显示真实姓名。成员端仅见匿名代号。</p>
          <div class="mp-chip gold" style="display:inline-block;margin:8px 0">我的最佳 ${Number(me.best || 0)} · 已玩 ${Number(me.gamesPlayed || 0)} 局</div>
          <div id="jumpMultiEntry"></div>
          <div id="jumpGameRoot" class="jg-root"></div>
        </div>
        <div class="panel" style="margin-top:14px">
          <h2>排行榜（含身份）</h2>
          <div id="jumpBoardAdmin"></div>
        </div>`;
      const list = board.leaderboard || [];
      const box = document.getElementById('jumpBoardAdmin');
      box.innerHTML = list.length
        ? `<div style="overflow-x:auto"><table><thead><tr><th>#</th><th>代号</th><th>成员</th><th>分数</th><th>局数</th></tr></thead><tbody>
            ${list.map((row) => `<tr>
              <td>${row.rank}</td>
              <td>${escapeHtml(row.alias)}</td>
              <td>${escapeHtml(row.displayName || row.username || '—')}<div class="muted-sm">@${escapeHtml(row.username || '')}</div></td>
              <td><strong>${row.score}</strong></td>
              <td>${row.gamesPlayed || 0}</td>
            </tr>`).join('')}
          </tbody></table></div>`
        : '<div class="empty">暂无成绩</div>';
      const root = document.getElementById('jumpGameRoot');
      if (window.JumpGame && root) {
        JumpGame.mount(root, {
          best: me.best || 0,
          onGameOver: async ({ score, hops, durationMs }) => {
            try {
              const r = await api('/api/jump/score', { method: 'POST', body: { score, hops, durationMs } });
              toast(r.isNewBest ? '🏆 新纪录 ' + r.best : '已记录本局 ' + score);
              renderJumpAdminTab();
            } catch (ex) { toast(ex.message); }
          },
        });
      }
      wireJumpMultiEntry();
    } catch (ex) {
      body.innerHTML = `<div class="panel"><div class="empty">${escapeHtml(ex.message)}</div></div>`;
    }
  }

  async function renderAnnouncementsTab() {
    const body = document.getElementById('tabBody');
    if (!body) return;
    body.innerHTML = `<div class="panel"><div class="empty">加载中…</div></div>`;
    try {
      const { announcements } = await api('/api/admin/announcements');
      body.innerHTML = `
        <div class="panel">
          <h2>发布公告</h2>
          <form id="annForm" class="stack" style="gap:10px;max-width:640px">
            <div class="field"><label>标题</label><input name="title" maxlength="80" required placeholder="例如：本周活动说明" /></div>
            <div class="field"><label>正文</label><textarea name="body" rows="4" maxlength="4000" required placeholder="公告内容（纯文本，会安全转义）"></textarea></div>
            <div class="form-inline" style="gap:12px;flex-wrap:wrap">
              <label class="check"><input type="checkbox" name="pinned" /> 置顶</label>
              <div class="field" style="flex:1;min-width:180px"><label>过期时间（可选）</label><input name="expiresAt" type="datetime-local" /></div>
            </div>
            <button class="btn btn-primary" type="submit">发布公告</button>
          </form>
        </div>
        <div class="panel" style="margin-top:14px">
          <h2>公告列表（${(announcements || []).length}）</h2>
          <div id="adminAnnList">
            ${(announcements || []).length ? `<ul class="ann-admin-list">${announcements.map((a) => `
              <li data-id="${a.id}">
                <div class="ann-top">
                  <strong>${a.pinned ? '📌 ' : ''}${escapeHtml(a.title)}</strong>
                  <span class="muted-sm">${escapeHtml(a.createdAt || '')}${a.expiresAt ? ' · 过期 ' + escapeHtml(a.expiresAt) : ''}</span>
                </div>
                <div class="ann-body">${escapeHtml(a.body)}</div>
                <div class="row-actions" style="margin-top:8px;gap:6px;flex-wrap:wrap">
                  <button class="btn btn-ghost btn-sm pin" data-pinned="${a.pinned ? 1 : 0}">${a.pinned ? '取消置顶' : '置顶'}</button>
                  <button class="btn btn-ghost btn-sm edit">编辑</button>
                  <button class="btn btn-danger btn-sm del">删除</button>
                </div>
              </li>`).join('')}</ul>` : '<div class="empty">暂无公告</div>'}
          </div>
        </div>`;
      document.getElementById('annForm').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const expiresRaw = fd.get('expiresAt');
        try {
          await api('/api/admin/announcements', {
            method: 'POST',
            body: {
              title: fd.get('title'),
              body: fd.get('body'),
              pinned: !!fd.get('pinned'),
              expiresAt: expiresRaw ? String(expiresRaw).replace('T', ' ') + ':00' : null,
            },
          });
          toast('✓ 公告已发布');
          renderAnnouncementsTab();
        } catch (ex) { toast(ex.message); }
      };
      body.querySelectorAll('.ann-admin-list li').forEach((li) => {
        const id = li.dataset.id;
        li.querySelector('.pin').onclick = async () => {
          const pinned = li.querySelector('.pin').dataset.pinned === '1' ? false : true;
          try {
            await api(`/api/admin/announcements/${id}/pin`, { method: 'POST', body: { pinned } });
            renderAnnouncementsTab();
          } catch (ex) { toast(ex.message); }
        };
        li.querySelector('.del').onclick = async () => {
          if (!confirm('确认删除该公告？')) return;
          try {
            await api(`/api/admin/announcements/${id}`, { method: 'DELETE' });
            toast('已删除');
            renderAnnouncementsTab();
          } catch (ex) { toast(ex.message); }
        };
        li.querySelector('.edit').onclick = async () => {
          const title = prompt('新标题', li.querySelector('strong').textContent.replace(/^📌\s*/, ''));
          if (title == null) return;
          const bodyText = prompt('新正文', li.querySelector('.ann-body').textContent);
          if (bodyText == null) return;
          try {
            await api(`/api/admin/announcements/${id}`, { method: 'PUT', body: { title, body: bodyText } });
            toast('已更新');
            renderAnnouncementsTab();
          } catch (ex) { toast(ex.message); }
        };
      });
    } catch (ex) {
      body.innerHTML = `<div class="panel"><div class="empty">${escapeHtml(ex.message)}</div></div>`;
    }
  }

  async function renderChatTab() {
    const body = document.getElementById('tabBody');
    body.innerHTML = window.ChatUI ? ChatUI.adminShell() : '<div class="panel"><div class="empty">聊天模块未加载</div></div>';
    if (window.ChatUI) {
      state.chatCtrl = ChatUI.bind(body, api, toast, { admin: true });
      state.chatCtrl.markOpen();
    }
  }

  async function renderSecurityTab() {
    const body = document.getElementById('tabBody');
    body.innerHTML = `<div class="panel"><div class="empty">加载中…</div></div>`;
    try {
      const [{ sessions }, { audit }] = await Promise.all([api('/api/admin/sessions'), api('/api/admin/audit?limit=200')]);
      body.innerHTML = `
        <div class="panel">
          <h2>在线会话（${sessions.length}）</h2>
          ${sessionsTable(sessions, true)}
        </div>
        <div class="panel">
          <h2>登录日志（最近 200 条 · 北京时间）</h2>
          <form class="form-inline" id="unlockForm" style="margin-bottom:12px">
            <div class="field"><input name="username" maxlength="24" placeholder="被锁定的用户名" required /></div>
            <button class="btn btn-ghost btn-sm" type="submit">解除登录锁定</button>
          </form>
          <div style="overflow-x:auto"><table>
            <thead><tr><th>时间</th><th>账号</th><th>结果</th><th>IP</th><th>设备</th></tr></thead>
            <tbody>
              ${audit.map((a) => `
                <tr>
                  <td class="muted-sm">${formatTime(a.createdAt)}</td>
                  <td>${escapeHtml(a.username)}</td>
                  <td><span class="badge ${a.success ? 'badge-unused' : 'badge-revoked'}">${escapeHtml(AUDIT_REASON[a.reason] || a.reason || (a.success ? '成功' : '失败'))}</span>${a.detail ? `<div class="muted-sm">${escapeHtml(a.detail)}</div>` : ''}</td>
                  <td class="mono">${escapeHtml(a.ip)}</td>
                  <td title="${escapeHtml(a.userAgent)}">${escapeHtml(shortUA(a.userAgent))}</td>
                </tr>`).join('') || '<tr><td colspan="5" class="empty">暂无记录</td></tr>'}
            </tbody>
          </table></div>
        </div>`;
      document.getElementById('unlockForm').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/api/admin/unlock', { method: 'POST', body: { username: new FormData(e.target).get('username') } });
          toast('已解除锁定');
          e.target.reset();
        } catch (ex) { toast(ex.message); }
      };
      body.querySelectorAll('.kick').forEach((btn) => {
        btn.onclick = async () => {
          try {
            const r = await api(`/api/admin/members/${btn.dataset.uid}/logout`, { method: 'POST', body: {} });
            toast(`已强制下线（关闭 ${r.closed} 个会话）`);
            refreshAdminTab();
          } catch (ex) { toast(ex.message); }
        };
      });
    } catch (ex) {
      body.innerHTML = `<div class="panel"><div class="empty">${escapeHtml(ex.message)}</div></div>`;
    }
  }

  function statusLabel(s) {
    return { unused: '未使用', used: '已使用', revoked: '已撤销', expired: '已过期' }[s] || escapeHtml(s);
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTime(t) {
    if (!t) return '';
    // SQLite UTC-ish string → display as-is with note; convert if Z
    try {
      const d = new Date(t.includes('T') ? t : t.replace(' ', 'T') + 'Z');
      if (Number.isNaN(d.getTime())) return t;
      return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    } catch {
      return t;
    }
  }

  bootstrap();
})();
