(() => {
  const app = document.getElementById('app');
  let state = {
    user: null,
    ws: null,
    wsConnected: false,
    meta: { ranks: [], suits: [] },
    tab: 'members',
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
      } else if (msg.type === 'force_logout') {
        toast(msg.reason || '已被强制下线');
        logout();
      } else if (msg.type === 'new_suggestion' || msg.type === 'member_joined' ||
                 msg.type === 'member_card_updated' || msg.type === 'member_removed' ||
                 msg.type === 'suggestion_updated') {
        if (state.user?.role === 'admin') {
          refreshAdminTab();
          if (msg.type === 'new_suggestion') toast('收到新的建议/要求');
        }
        if (state.user?.role === 'member' && msg.type === 'suggestion_updated') {
          loadMySuggestions();
          toast('管理员已处理你的提交');
        }
      }
    };
    ws.onclose = () => {
      state.wsConnected = false;
      updateLiveDot();
      // reconnect after login still valid
      if (state.user) {
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
      routeHome();
    } catch {
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
    if (state.ws) try { state.ws.close(); } catch (_) {}
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
              <input name="inviteCode" class="mono" placeholder="8位邀请码" required autocomplete="off" />
              <label>显示名称（可选）</label>
              <input name="displayName" placeholder="昵称" maxlength="24" />
            ` : ''}
            <label>账号</label>
            <input name="username" placeholder="用户名" required autocomplete="username" />
            <label>密码</label>
            <input name="password" type="password" placeholder="密码" required autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}" />
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
      const err = document.getElementById('err');
      err.classList.remove('show');
      try {
        const path = mode === 'register' ? '/api/register' : '/api/login';
        const data = await api(path, { method: 'POST', body });
        state.user = data.user;
        connectWs(data.wsToken);
        toast(mode === 'register' ? '注册成功' : '登录成功');
        routeHome();
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.add('show');
      }
    };
  }

  // ---------- Member ----------
  function renderMember() {
    history.replaceState(null, '', '/member');
    app.innerHTML = `
      <div class="shell">
        <div class="topbar">
          <div>
            <h1 class="glow-title" style="font-size:1.2rem">我的卡牌</h1>
            <div class="who"><span class="live-dot ${state.wsConnected ? '' : 'off'}"></span>${escapeHtml(state.user.displayName || state.user.username)}</div>
          </div>
          <button class="btn btn-ghost btn-sm" id="logoutBtn">退出登录</button>
        </div>
        <div class="panel member-hero">
          <div id="myCard"></div>
          <p class="hint">仅你可见 · 管理员变更后将实时刷新</p>
        </div>
        <div class="grid-2">
          <div class="panel">
            <h2>提交建议 / 要求</h2>
            <form id="sugForm">
              <label>类型</label>
              <select name="type">
                <option value="suggestion">建议</option>
                <option value="request">要求</option>
              </select>
              <label>内容</label>
              <textarea name="content" placeholder="写给管理员的内容…" required maxlength="2000"></textarea>
              <button class="btn btn-primary" type="submit">提交</button>
            </form>
          </div>
          <div class="panel">
            <h2>我的提交记录</h2>
            <div id="mySugs"></div>
          </div>
        </div>
      </div>
    `;
    document.getElementById('logoutBtn').onclick = logout;
    document.getElementById('sugForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/my/suggestions', {
          method: 'POST',
          body: { type: fd.get('type'), content: fd.get('content') },
        });
        e.target.reset();
        toast('已提交');
        loadMySuggestions();
      } catch (ex) {
        toast(ex.message);
      }
    };
    loadMyCard();
    loadMySuggestions();
  }

  async function loadMyCard() {
    try {
      const { card } = await api('/api/my/card');
      renderMemberCard(card, false);
    } catch (ex) {
      toast(ex.message);
    }
  }

  function renderMemberCard(card, flip) {
    const el = document.getElementById('myCard');
    if (el) CardsUI.render(el, card, { flip });
  }

  async function loadMySuggestions() {
    const box = document.getElementById('mySugs');
    if (!box) return;
    try {
      const { suggestions } = await api('/api/my/suggestions');
      if (!suggestions.length) {
        box.innerHTML = '<div class="empty">暂无记录</div>';
        return;
      }
      box.innerHTML = suggestions.map((s) => `
        <div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)">
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
            <strong>${s.type === 'request' ? '要求' : '建议'}</strong>
            <span class="badge ${s.status === 'pending' ? 'badge-pending' : 'badge-handled'}">${s.status === 'pending' ? '待处理' : '已处理'}</span>
          </div>
          <div style="margin:6px 0;white-space:pre-wrap">${escapeHtml(s.content)}</div>
          <div style="font-size:.78rem;color:var(--muted)">${formatTime(s.createdAt)}</div>
          ${s.adminReply ? `<div style="margin-top:6px;color:var(--neon);font-size:.9rem">回复：${escapeHtml(s.adminReply)}</div>` : ''}
        </div>
      `).join('');
    } catch (ex) {
      box.innerHTML = `<div class="empty">${escapeHtml(ex.message)}</div>`;
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
          <button class="btn btn-ghost btn-sm" id="logoutBtn">退出登录</button>
        </div>
        <div class="tabs" id="tabs">
          <button class="tab active" data-tab="members">成员与卡牌</button>
          <button class="tab" data-tab="ranking">等级排行</button>
          <button class="tab" data-tab="suggestions">建议 / 要求</button>
          <button class="tab" data-tab="invites">邀请码</button>
        </div>
        <div id="tabBody"></div>
      </div>
    `;
    document.getElementById('logoutBtn').onclick = logout;
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
    const map = {
      members: renderMembersTab,
      ranking: renderRankingTab,
      suggestions: renderSuggestionsTab,
      invites: renderInvitesTab,
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
                <tr><th>成员</th><th>当前牌</th><th>设置卡牌</th><th>状态</th><th>操作</th></tr>
              </thead>
              <tbody>
                ${members.map((m) => `
                  <tr data-id="${m.id}">
                    <td>
                      <strong>${escapeHtml(m.displayName)}</strong>
                      <div style="font-size:.78rem;color:var(--muted)">@${escapeHtml(m.username)}</div>
                    </td>
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
                    <td>${m.disabled ? '<span class="badge badge-revoked">已停用</span>' : '<span class="badge badge-unused">正常</span>'}</td>
                    <td class="row-actions">
                      <button class="btn btn-ghost btn-sm toggle-dis">${m.disabled ? '启用' : '停用'}</button>
                      <button class="btn btn-danger btn-sm del-mem">删除</button>
                    </td>
                  </tr>
                `).join('') || '<tr><td colspan="5" class="empty">暂无成员，请先生成邀请码</td></tr>'}
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
        tr.querySelector('.toggle-dis').onclick = async () => {
          try {
            await api(`/api/admin/members/${id}/disable`, {
              method: 'POST',
              body: { disabled: !m.disabled },
            });
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
            <button class="btn btn-primary btn-sm" id="gen1">生成 1 个</button>
            <button class="btn btn-ghost btn-sm" id="gen5">生成 5 个</button>
          </div>
          <table>
            <thead><tr><th>邀请码</th><th>状态</th><th>使用者</th><th>创建时间</th><th>操作</th></tr></thead>
            <tbody>
              ${invites.map((i) => `
                <tr>
                  <td class="mono">${escapeHtml(i.code)}</td>
                  <td><span class="badge badge-${i.status}">${statusLabel(i.status)}</span></td>
                  <td>${i.usedByUsername ? escapeHtml(i.usedByUsername) : '—'}</td>
                  <td style="font-size:.82rem;color:var(--muted)">${formatTime(i.createdAt)}</td>
                  <td>
                    ${i.status === 'unused' ? `<button class="btn btn-danger btn-sm revoke" data-id="${i.id}">撤销</button>` : '—'}
                  </td>
                </tr>
              `).join('') || '<tr><td colspan="5" class="empty">暂无邀请码</td></tr>'}
            </tbody>
          </table>
        </div>
      `;
      const gen = async (n) => {
        try {
          const { codes } = await api('/api/admin/invites', { method: 'POST', body: { count: n } });
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

  function statusLabel(s) {
    return { unused: '未使用', used: '已使用', revoked: '已撤销' }[s] || s;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
