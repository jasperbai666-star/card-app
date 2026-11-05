/** Anonymous chat panel (member + admin). Relies on window helpers from app.js via opts. */
window.ChatUI = (() => {
  const state = {
    messages: [],
    alias: '',
    muted: false,
    unread: 0,
    open: false,
    emoji: [],
    lastId: 0,
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function imgUrl(key) {
    return `/api/chat/images/${encodeURIComponent(key)}`;
  }

  function formatTime(t) {
    if (!t) return '';
    try {
      const d = new Date(String(t).replace(' ', 'T') + 'Z');
      return d.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return t; }
  }

  function renderMsg(m, { admin = false } = {}) {
    const mine = false; // we don't mark mine by id (anonymous); match by alias+time is fragile — skip
    const isAdminMsg = m.role === 'admin';
    const alias = isAdminMsg ? '管理员' : esc(m.alias || '匿名');
    const deleted = admin && m.deletedAt;
    let body;
    if (m.type === 'image' && m.imageKey) {
      body = `<button type="button" class="ch-img" data-key="${esc(m.imageKey)}"><img src="${imgUrl(m.imageKey)}" alt="图片" loading="lazy" /></button>`;
    } else {
      body = `<div class="ch-text">${esc(m.text || '')}</div>`;
    }
    const meta = admin
      ? `<div class="ch-meta">${alias} · <span class="ch-id">@${esc(m.username || '')}</span> · ${esc(m.displayName || '')} · ${formatTime(m.createdAt)}</div>`
      : `<div class="ch-meta">${alias}<span>${formatTime(m.createdAt)}</span></div>`;
    const actions = admin && !deleted
      ? `<button type="button" class="ch-del" data-id="${m.id}" title="删除">删除</button>
         ${m.role !== 'admin' ? `<button type="button" class="ch-mute" data-uid="${m.userId}" data-name="${esc(m.displayName || m.username || '')}">禁言</button>` : ''}`
      : '';
    return `<li class="ch-msg ${isAdminMsg ? 'admin' : ''} ${deleted ? 'deleted' : ''}" data-id="${m.id}">
      <div class="ch-av ${isAdminMsg ? 'gold' : ''}">${isAdminMsg ? '管' : esc((m.alias || '?').slice(0, 1))}</div>
      <div class="ch-bubble">
        ${meta}
        ${deleted ? '<div class="ch-deleted-tag">已删除</div>' : body}
        ${actions ? `<div class="ch-actions">${actions}</div>` : ''}
      </div>
    </li>`;
  }

  async function loadHistory(api, { admin = false } = {}) {
    const data = await api('/api/chat/messages?limit=50');
    state.messages = data.messages || [];
    state.alias = data.alias || '';
    state.muted = !!data.muted;
    if (state.messages.length) state.lastId = state.messages[state.messages.length - 1].id;
    return data;
  }

  function paintList(el, { admin = false, stick = true } = {}) {
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (!state.messages.length) {
      el.innerHTML = `<div class="ch-empty"><div class="ch-empty-ico">✦</div><div>还没有人说话</div><div class="ch-fine">这里是匿名聊天室，彼此看不到真实身份。</div></div>`;
      return;
    }
    el.innerHTML = `<ul class="ch-list">${state.messages.map((m) => renderMsg(m, { admin })).join('')}</ul>`;
    if (stick || nearBottom) el.scrollTop = el.scrollHeight;
  }

  function pushMessage(m, { admin = false } = {}) {
    if (state.messages.some((x) => x.id === m.id)) return;
    state.messages.push(m);
    if (m.id > state.lastId) state.lastId = m.id;
    if (!state.open && !admin) state.unread += 1;
  }

  function removeMessage(id) {
    const i = state.messages.findIndex((m) => m.id === id);
    if (i >= 0) {
      if (arguments[1]?.admin) state.messages[i] = { ...state.messages[i], deletedAt: arguments[1].deletedAt || 'now', text: null, imageKey: null };
      else state.messages.splice(i, 1);
    }
  }

  function clearAll() { state.messages = []; state.unread = 0; }

  function memberShell() {
    return `
      <section class="mp-glass mp-wide ch-panel" id="chatPanel">
        <div class="mp-head">
          <h2>匿名聊天室</h2>
          <div class="ch-head-right">
            <span class="mp-chip gold" id="chatAliasChip">代号 …</span>
            <span class="ch-unread hidden" id="chatUnread">0</span>
          </div>
        </div>
        <p class="mp-fine ch-banner">你在此显示为随机代号，其他人看不到你的真实姓名与账号。请勿发送手机号、微信号或邮箱。</p>
        <div class="ch-stream" id="chatStream" aria-live="polite"></div>
        <div class="ch-muted hidden" id="chatMuted">你已被禁言，暂时无法发言</div>
        <div class="ch-compose" id="chatCompose">
          <div class="ch-tools">
            <button type="button" class="ch-tool" id="chatEmojiBtn" title="表情" aria-label="表情">😊</button>
            <button type="button" class="ch-tool" id="chatImgBtn" title="图片" aria-label="发送图片">🖼</button>
            <input type="file" id="chatFile" accept="image/jpeg,image/png,image/webp,image/gif" hidden />
          </div>
          <div class="ch-emoji hidden" id="chatEmoji" role="listbox" aria-label="表情"></div>
          <div class="ch-input-row">
            <textarea id="chatInput" maxlength="500" rows="1" placeholder="说点什么…（匿名）" aria-label="聊天内容"></textarea>
            <button type="button" class="mp-btn gold sm" id="chatSend">发送</button>
          </div>
          <div class="ch-preview hidden" id="chatPreview"></div>
        </div>
      </section>
      <div class="ch-lightbox hidden" id="chatLightbox" role="dialog" aria-modal="true"><img alt="预览" /><button type="button" class="ch-lb-close" aria-label="关闭">×</button></div>
    `;
  }

  function adminShell() {
    return `
      <div class="panel ch-admin">
        <div class="mp-head" style="margin-bottom:12px">
          <h2 style="margin:0">匿名聊天室 · 管理</h2>
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" id="chatRefresh">刷新</button>
            <button class="btn btn-danger btn-sm" id="chatClear">清空聊天</button>
          </div>
        </div>
        <p class="hint">成员互相看不到真实身份；此处可看到每条消息对应的真实成员，并可删除 / 禁言。</p>
        <div class="ch-stream admin" id="chatStream"></div>
        <div class="ch-compose">
          <div class="ch-input-row">
            <textarea id="chatInput" maxlength="500" rows="1" placeholder="以「管理员」身份发言…"></textarea>
            <button type="button" class="btn btn-primary btn-sm" id="chatSend">发送</button>
            <button type="button" class="btn btn-ghost btn-sm" id="chatEmojiBtn">表情</button>
            <button type="button" class="btn btn-ghost btn-sm" id="chatImgBtn">图片</button>
            <input type="file" id="chatFile" accept="image/jpeg,image/png,image/webp,image/gif" hidden />
          </div>
          <div class="ch-emoji hidden" id="chatEmoji"></div>
        </div>
        <h3 style="margin-top:18px">禁言名单</h3>
        <div id="chatMutes"><div class="empty">加载中…</div></div>
      </div>
      <div class="ch-lightbox hidden" id="chatLightbox" role="dialog" aria-modal="true"><img alt="预览" /><button type="button" class="ch-lb-close" aria-label="关闭">×</button></div>
    `;
  }

  function bind(root, api, toast, { admin = false } = {}) {
    state.open = true;
    state.unread = 0;
    const stream = root.querySelector('#chatStream');
    const input = root.querySelector('#chatInput');
    const sendBtn = root.querySelector('#chatSend');
    const emojiBtn = root.querySelector('#chatEmojiBtn');
    const emojiBox = root.querySelector('#chatEmoji');
    const imgBtn = root.querySelector('#chatImgBtn');
    const file = root.querySelector('#chatFile');
    const mutedEl = root.querySelector('#chatMuted');
    const compose = root.querySelector('#chatCompose');
    const aliasChip = root.querySelector('#chatAliasChip');
    const unreadEl = root.querySelector('#chatUnread');
    const lightbox = root.querySelector('#chatLightbox');

    const updateUnread = () => {
      if (!unreadEl) return;
      if (state.unread > 0) { unreadEl.textContent = String(state.unread > 99 ? '99+' : state.unread); unreadEl.classList.remove('hidden'); }
      else unreadEl.classList.add('hidden');
    };
    updateUnread();

    const refreshMuteUI = () => {
      if (mutedEl) mutedEl.classList.toggle('hidden', !state.muted);
      if (compose) compose.classList.toggle('is-muted', state.muted);
      if (sendBtn) sendBtn.disabled = state.muted;
      if (input) input.disabled = state.muted;
    };

    const paint = () => { paintList(stream, { admin, stick: true }); wireMsgActions(); };

    function wireMsgActions() {
      stream.querySelectorAll('.ch-img').forEach((btn) => {
        btn.onclick = () => {
          const img = lightbox.querySelector('img');
          img.src = imgUrl(btn.dataset.key);
          lightbox.classList.remove('hidden');
        };
      });
      if (!admin) return;
      stream.querySelectorAll('.ch-del').forEach((btn) => {
        btn.onclick = async () => {
          if (!confirm('删除这条消息？成员将不再看到它。')) return;
          try {
            await api(`/api/admin/chat/messages/${btn.dataset.id}`, { method: 'DELETE' });
            toast('已删除');
          } catch (ex) { toast(ex.message); }
        };
      });
      stream.querySelectorAll('.ch-mute').forEach((btn) => {
        btn.onclick = async () => {
          const mins = prompt(`禁言「${btn.dataset.name}」多少分钟？\n留空 = 永久禁言`, '60');
          if (mins === null) return;
          const body = { userId: Number(btn.dataset.uid) };
          if (String(mins).trim() !== '') body.minutes = Number(mins);
          try {
            await api('/api/admin/chat/mutes', { method: 'POST', body });
            toast('已禁言');
            loadMutes();
          } catch (ex) { toast(ex.message); }
        };
      });
    }

    async function loadMutes() {
      const box = root.querySelector('#chatMutes');
      if (!box) return;
      try {
        const { mutes } = await api('/api/admin/chat/mutes');
        if (!mutes.length) { box.innerHTML = '<div class="empty">暂无禁言</div>'; return; }
        box.innerHTML = `<table><thead><tr><th>成员</th><th>至</th><th>原因</th><th></th></tr></thead><tbody>
          ${mutes.map((m) => `<tr>
            <td>${esc(m.displayName)} <span class="muted-sm">@${esc(m.username)}</span></td>
            <td>${m.permanent ? '永久' : esc(m.mutedUntil)}</td>
            <td>${m.reason ? esc(m.reason) : '—'}</td>
            <td><button class="btn btn-ghost btn-sm unmute" data-uid="${m.userId}">解除</button></td>
          </tr>`).join('')}
        </tbody></table>`;
        box.querySelectorAll('.unmute').forEach((b) => {
          b.onclick = async () => {
            try { await api(`/api/admin/chat/mutes/${b.dataset.uid}`, { method: 'DELETE' }); toast('已解除禁言'); loadMutes(); }
            catch (ex) { toast(ex.message); }
          };
        });
      } catch (ex) { box.innerHTML = `<div class="empty">${esc(ex.message)}</div>`; }
    }

    async function sendText(text) {
      if (state.muted) return toast('你已被禁言');
      const t = String(text || '').trim();
      if (!t) return;
      sendBtn.disabled = true;
      try {
        await api('/api/chat/messages', { method: 'POST', body: { text: t } });
        input.value = '';
        input.style.height = 'auto';
      } catch (ex) { toast(ex.message); }
      finally { sendBtn.disabled = state.muted; }
    }

    sendBtn.onclick = () => sendText(input.value);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(input.value); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    // emoji
    (async () => {
      try {
        const meta = await api('/api/chat/meta');
        state.emoji = meta.emoji || [];
        emojiBox.innerHTML = state.emoji.map((e) => `<button type="button" class="ch-emo" data-e="${e}">${e}</button>`).join('');
        emojiBox.querySelectorAll('.ch-emo').forEach((b) => {
          b.onclick = () => { input.value += b.dataset.e; input.focus(); input.dispatchEvent(new Event('input')); };
        });
      } catch (_) {}
    })();
    emojiBtn.onclick = () => emojiBox.classList.toggle('hidden');

    imgBtn.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      if (!/^image\/(jpeg|png|webp|gif)$/.test(f.type)) return toast('仅支持 JPG / PNG / WebP / GIF');
      if (f.size > 1024 * 1024) return toast('图片过大（最大 1MB）');
      try {
        const buf = await f.arrayBuffer();
        const res = await fetch('/api/chat/images', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': f.type, Origin: location.origin },
          body: buf,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '上传失败');
        // realtime will append
      } catch (ex) { toast(ex.message || '上传失败'); }
    };

    if (lightbox) {
      lightbox.querySelector('.ch-lb-close').onclick = () => lightbox.classList.add('hidden');
      lightbox.onclick = (e) => { if (e.target === lightbox) lightbox.classList.add('hidden'); };
    }

    const clearBtn = root.querySelector('#chatClear');
    if (clearBtn) clearBtn.onclick = async () => {
      if (!confirm('确定清空聊天室？所有消息将对成员隐藏。')) return;
      try { await api('/api/admin/chat/clear', { method: 'POST', body: {} }); toast('已清空'); }
      catch (ex) { toast(ex.message); }
    };
    const refreshBtn = root.querySelector('#chatRefresh');
    if (refreshBtn) refreshBtn.onclick = () => boot();

    async function boot() {
      try {
        await loadHistory(api, { admin });
        if (aliasChip) aliasChip.textContent = '代号 ' + state.alias;
        refreshMuteUI();
        paint();
        if (admin) loadMutes();
      } catch (ex) {
        stream.innerHTML = `<div class="ch-empty">${esc(ex.message)}</div>`;
      }
    }
    boot();

    return {
      onEvent(msg) {
        if (msg.type === 'chat_message' && msg.message) {
          pushMessage(msg.message, { admin });
          if (state.open) { state.unread = 0; paint(); }
          updateUnread();
        } else if (msg.type === 'chat_deleted') {
          if (admin && msg.message) {
            const i = state.messages.findIndex((x) => x.id === msg.id);
            if (i >= 0) state.messages[i] = msg.message;
          } else {
            state.messages = state.messages.filter((x) => x.id !== msg.id);
          }
          paint();
        } else if (msg.type === 'chat_cleared') {
          clearAll(); paint();
        } else if (msg.type === 'chat_muted') {
          state.muted = true; refreshMuteUI();
        } else if (msg.type === 'chat_unmuted') {
          state.muted = false; refreshMuteUI();
        } else if (msg.type === 'chat_error') {
          toast(msg.error || '发送失败');
        }
      },
      markOpen() { state.open = true; state.unread = 0; updateUnread(); },
      getUnread: () => state.unread,
    };
  }

  return { memberShell, adminShell, bind, state };
})();
