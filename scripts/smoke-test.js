/**
 * API + WebSocket + security smoke test against a running deployment; cleans up its test data.
 * Usage: BASE_URL=https://xxx.onrender.com ADMIN_USERNAME=admin ADMIN_PASSWORD=... node scripts/smoke-test.js
 * Uses only throwaway test accounts for lockout tests (never locks the real admin).
 */
const WebSocket = require('ws');
const { authenticator } = require('otplib');
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
const HTTPS = BASE.startsWith('https');
const AU = process.env.ADMIN_USERNAME, AP = process.env.ADMIN_PASSWORD;
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond });
  console.log(cond ? '✓' : '✗', name, cond ? '' : String(extra).slice(0, 300));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(jar, method, p, body, { origin = ORIGIN, headers: extra = {} } = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (origin) headers.Origin = origin;
  if (jar.cookie) headers.Cookie = jar.cookie;
  const res = await fetch(BASE + p, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
  for (const c of res.headers.getSetCookie?.() || []) {
    if (c.startsWith('card.sid=')) { jar.cookie = c.split(';')[0]; jar.raw = c; }
  }
  return { status: res.status, data: await res.json().catch(() => ({})), headers: res.headers };
}
const login = (jar, username, password, totp) => api(jar, 'POST', '/api/login', { username, password, ...(totp ? { totp } : {}) });

function openWs(token, origin = ORIGIN) {
  const url = BASE.replace(/^http/, 'ws') + '/ws';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const msgs = [];
    ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('error', reject);
    ws.on('unexpected-response', (_q, r) => reject(new Error('ws rejected ' + r.statusCode)));
    const t = setInterval(() => { if (msgs.find((m) => m.type === 'auth_ok')) { clearInterval(t); resolve({ ws, msgs }); } }, 100);
    setTimeout(() => { clearInterval(t); reject(new Error('ws auth timeout')); }, 15000);
  });
}
const waitFor = (msgs, pred, ms = 10000) => new Promise((res) => {
  const t0 = Date.now();
  const t = setInterval(() => { const m = msgs.find(pred); if (m || Date.now() - t0 > ms) { clearInterval(t); res(m); } }, 100);
});

(async () => {
  const admin = {};
  const sfx = Math.random().toString(36).slice(2, 6);
  const created = { members: [], codes: [], announcements: [] };
  const PW = 'Test-pass-' + sfx + '9';

  // --- headers ---
  let r = await fetch(BASE + '/login');
  const csp = r.headers.get('content-security-policy') || '';
  check('CSP header present (script-src self, frame-ancestors none)', /script-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp), csp);
  check('X-Content-Type-Options nosniff', r.headers.get('x-content-type-options') === 'nosniff');
  if (HTTPS) check('HSTS header', /max-age=/.test(r.headers.get('strict-transport-security') || ''));
  check('no X-Powered-By', !r.headers.get('x-powered-by'));

  // --- admin ---
  r = await login(admin, AU, AP);
  check('admin login', r.status === 200 && r.data.user?.role === 'admin', JSON.stringify(r.data));
  check('session cookie HttpOnly + SameSite=Strict' + (HTTPS ? ' + Secure' : ''),
    /HttpOnly/i.test(admin.raw) && /SameSite=Strict/i.test(admin.raw) && (!HTTPS || /Secure/i.test(admin.raw)), admin.raw);
  const adminWs = await openWs(r.data.wsToken);
  check('admin WebSocket auth', true);

  // --- CSRF ---
  r = await api(admin, 'POST', '/api/admin/invites', { count: 1 }, { origin: null });
  check('CSRF: POST without Origin/Referer rejected', r.status === 403, r.status);
  r = await api(admin, 'POST', '/api/admin/invites', { count: 1 }, { origin: 'https://evil.example' });
  check('CSRF: POST from foreign Origin rejected', r.status === 403, r.status);
  r = await api(admin, 'POST', '/api/admin/invites', { count: 1 }, { headers: { 'Content-Type': 'text/plain' } });
  check('CSRF: non-JSON content type rejected', r.status === 415, r.status);
  const tok = (await api(admin, 'POST', '/api/ws-token', {})).data.token;
  let wsRejected = false;
  try { const x = await openWs(tok, 'https://evil.example'); x.ws.close(); } catch { wsRejected = true; }
  check('WebSocket from foreign Origin rejected', wsRejected);

  // --- invites with expiry/note ---
  r = await api(admin, 'POST', '/api/admin/invites', { count: 1, note: '测试-' + sfx });
  const codeA = r.data.codes?.[0]; created.codes.push(codeA);
  const days = (new Date(r.data.expiresAt.replace(' ', 'T') + 'Z') - Date.now()) / 86400000;
  check('invite default expiry ≈ 7 days', days > 6.9 && days < 7.1, r.data.expiresAt);
  r = await api(admin, 'POST', '/api/admin/invites', { count: 1, expiresInDays: 0.00001 }); // ~1 second
  const codeExp = r.data.codes?.[0]; created.codes.push(codeExp);
  r = await api(admin, 'POST', '/api/admin/invites', { count: 1, expiresInDays: 1 });
  const codeB = r.data.codes?.[0]; created.codes.push(codeB);
  await sleep(1500);
  r = await api({}, 'POST', '/api/register', { username: 'tx_' + sfx, password: PW, inviteCode: codeExp });
  check('expired invite code rejected', r.status === 400, JSON.stringify(r.data));
  const inv = (await api(admin, 'GET', '/api/admin/invites')).data.invites || [];
  check('invite list shows note + expired status',
    inv.some((i) => i.code === codeA && i.note === '测试-' + sfx) && inv.some((i) => i.code === codeExp && i.status === 'expired'));

  // --- register (password policy, XSS payload in display name) ---
  const XSS_NAME = '<svg/onload=alert()>'; // 20 chars (display-name max)
  const mA = {}, mA2 = {}, mB = {};
  const ua = 'ta_' + sfx, ub = 'tb_' + sfx;
  r = await api(mA, 'POST', '/api/register', { username: ua, password: 'short', inviteCode: codeA });
  check('password < 8 chars rejected', r.status === 400);
  r = await api(mA, 'POST', '/api/register', { username: ua, password: PW, inviteCode: codeA, displayName: '名'.repeat(21) });
  check('register: display name > 20 chars rejected', r.status === 400);
  r = await api(mA, 'POST', '/api/register', { username: ua, password: PW, inviteCode: codeA, displayName: XSS_NAME });
  const idA = r.data.user?.id; if (idA) created.members.push(idA);
  check('member A registers', r.status === 200 && idA, JSON.stringify(r.data));
  r = await api({}, 'POST', '/api/register', { username: 'tc_' + sfx, password: PW, inviteCode: codeA });
  check('used invite code rejected', r.status === 400);
  r = await api(mB, 'POST', '/api/register', { username: ub, password: PW, inviteCode: codeB });
  const idB = r.data.user?.id; if (idB) created.members.push(idB);
  check('member B registers', r.status === 200 && idB);

  // --- member invites: ONE active code per member, inviter tracking ---
  r = await api(mA, 'GET', '/api/my/invite');
  check('member A invitedBy = 管理员 (admin code)', r.status === 200 && r.data.invitedBy?.name === '管理员' && r.data.invite === null, JSON.stringify(r.data));
  const race = await Promise.all([1, 2, 3].map(() => api(mA, 'POST', '/api/my/invite', {})));
  const okRace = race.filter((x) => x.status === 200);
  check('concurrent member invite creation: exactly one succeeds, others 409',
    okRace.length === 1 && race.filter((x) => x.status === 409).length === 2, race.map((x) => x.status).join(','));
  const codeM1 = okRace[0]?.data.invite?.code; created.codes.push(codeM1);
  r = await api(mA, 'POST', '/api/my/invite', {});
  check('member cannot create a 2nd code while one is active (409, Chinese msg)', r.status === 409 && /只能有 1 个/.test(r.data.error || ''));
  r = await api(mA, 'POST', '/api/my/invite/revoke', {});
  check('member can revoke own active code', r.status === 200);
  r = await api(mA, 'POST', '/api/my/invite/revoke', {});
  check('revoking again -> 404', r.status === 404);
  r = await api({}, 'POST', '/api/register', { username: 'tr_' + sfx, password: PW, inviteCode: codeM1 });
  check('revoked member code cannot register', r.status === 400);
  r = await api(mA, 'POST', '/api/my/invite', {});
  const codeM2 = r.data.invite?.code; created.codes.push(codeM2);
  check('after revoke member can create a new code', r.status === 200 && codeM2 && codeM2 !== codeM1);
  r = await api(mB, 'POST', '/api/admin/invites', { count: 1 });
  check('member cannot use admin invite API', r.status === 403 || r.status === 401);
  const mC = {};
  r = await api(mC, 'POST', '/api/register', { username: 'td_' + sfx, password: PW, inviteCode: codeM2 });
  const idC = r.data.user?.id; if (idC) created.members.push(idC);
  check('member C registers with A\'s code', r.status === 200 && idC);
  r = await api(mA, 'GET', '/api/my/invite');
  check('A: code consumed, C listed as invited, can create again', r.data.invite === null && r.data.invitedMembers?.some((x) => x.id === idC));
  r = await api(mA, 'POST', '/api/my/invite', {});
  if (r.data.invite?.code) created.codes.push(r.data.invite.code);
  check('A can create a new code after the previous one was used', r.status === 200);
  await api(admin, 'PUT', `/api/admin/members/${idA}/name`, { displayName: '邀请人' + sfx });
  r = await api(mC, 'GET', '/api/my/invite');
  check('C profile shows inviter = A\'s CURRENT (renamed) name', r.data.invitedBy?.name === '邀请人' + sfx && r.data.invitedBy?.id === idA, JSON.stringify(r.data.invitedBy));
  r = await api(admin, 'GET', '/api/admin/members');
  const mm = r.data.members || [];
  check('admin member list: inviter column (A=管理员, C=A current name)',
    mm.find((x) => x.id === idA)?.invitedBy?.name === '管理员' && mm.find((x) => x.id === idC)?.invitedBy?.name === '邀请人' + sfx);
  check('admin member list: every member has an inviter field', mm.every((x) => x.invitedBy && x.invitedBy.name));
  r = await api(admin, 'GET', '/api/admin/invites');
  check('admin invites list shows creator name', (r.data.invites || []).some((x) => x.code === codeM2 && x.createdByName === '邀请人' + sfx));
  await api(admin, 'PUT', `/api/admin/members/${idA}/name`, { displayName: XSS_NAME });

  check('admin WS got member_joined', await waitFor(adminWs.msgs, (m) => m.type === 'member_joined'));

  // --- cards / isolation / live updates ---
  const memWs = await openWs((await api(mA, 'POST', '/api/ws-token', {})).data.token);
  r = await api(admin, 'PUT', `/api/admin/members/${idA}/card`, { rank: 'Q', suit: 'heart' });
  check('admin sets member card', r.status === 200);
  await api(admin, 'PUT', `/api/admin/members/${idB}/card`, { rank: 'joker_big' });
  const live = await waitFor(memWs.msgs, (m) => m.type === 'card_updated');
  check('member WS live card_updated', live && live.card?.rank === 'Q');
  r = await api(mA, 'GET', '/api/my/card');
  check('member sees own card Q♥', r.data.card?.rank === 'Q' && r.data.card?.suit === 'heart');
  check('member blocked from admin list', (await api(mA, 'GET', '/api/admin/members')).status === 403);
  check('member cannot set cards', (await api(mA, 'PUT', `/api/admin/members/${idB}/card`, { rank: 'A', suit: 'spade' })).status === 403);
  check('member cannot see audit log', (await api(mA, 'GET', '/api/admin/audit')).status === 403);

  // --- suggestions + XSS payload + rate limit ---
  const XSS_SUG = '<script>alert("x")</script><img src=x onerror=alert(2)> 测试 ' + sfx;
  r = await api(mA, 'POST', '/api/my/suggestions', { type: 'suggestion', content: XSS_SUG });
  check('member submits suggestion', r.status === 200);
  check('admin WS live new_suggestion', await waitFor(adminWs.msgs, (m) => m.type === 'new_suggestion'));
  r = await api(admin, 'GET', '/api/admin/suggestions');
  check('admin sees suggestion (stored verbatim, escaped at render)', (r.data.suggestions || []).some((s) => s.content === XSS_SUG));
  r = await api(mA, 'POST', '/api/my/suggestions', { type: 'suggestion', content: 'x'.repeat(2001) });
  check('suggestion > 2000 chars rejected', r.status === 400);
  let limited = false;
  for (let i = 0; i < 11 && !limited; i++) {
    const x = await api(mB, 'POST', '/api/my/suggestions', { type: 'request', content: 'rate ' + i });
    if (x.status === 429) limited = true;
  }
  check('suggestion rate limit (429 after 10 / 10 min)', limited);

  // --- admin renames member (display name only) ---
  r = await api(admin, 'PUT', `/api/admin/members/${idA}/name`, { displayName: '  小明 ' + sfx + '  ' });
  const NEWNAME = '小明 ' + sfx;
  check('admin renames member (trimmed)', r.status === 200 && r.data.member?.displayName === NEWNAME && r.data.changed, JSON.stringify(r.data));
  const pu = await waitFor(memWs.msgs, (m) => m.type === 'profile_updated', 5000);
  check('member WS live profile_updated', pu && pu.user?.displayName === NEWNAME);
  check('admin WS live member_updated', await waitFor(adminWs.msgs, (m) => m.type === 'member_updated' && m.memberId === idA, 5000));
  r = await api(mA, 'GET', '/api/me');
  check('member sees new name, login username unchanged', r.data.user?.displayName === NEWNAME && r.data.user?.username === ua);
  r = await api(admin, 'GET', '/api/admin/ranking');
  check('ranking shows new name', (r.data.ranking || []).some((x) => x.id === idA && x.displayName === NEWNAME) ||
    (r.data.ranking || []).some((x) => x.displayName === NEWNAME), JSON.stringify(r.data).slice(0, 200));
  r = await api(admin, 'GET', '/api/admin/suggestions');
  check('suggestions show new name', (r.data.suggestions || []).some((x) => x.content === XSS_SUG && x.displayName === NEWNAME));
  r = await api(admin, 'GET', '/api/admin/members');
  check('member list shows new name', (r.data.members || []).some((x) => x.id === idA && x.displayName === NEWNAME));
  check('rename: blank rejected', (await api(admin, 'PUT', `/api/admin/members/${idA}/name`, { displayName: '   ' })).status === 400);
  check('rename: 21 chars rejected', (await api(admin, 'PUT', `/api/admin/members/${idA}/name`, { displayName: '一'.repeat(21) })).status === 400);
  check('rename: non-string rejected', (await api(admin, 'PUT', `/api/admin/members/${idA}/name`, { displayName: { a: 1 } })).status === 400);
  r = await api(admin, 'PUT', `/api/admin/members/${idA}/name`, { displayName: '\u202e' + '二'.repeat(20) + '\u200b' });
  check('rename: 20 chars OK, invisible/bidi chars stripped', r.status === 200 && r.data.member?.displayName === '二'.repeat(20), JSON.stringify(r.data));
  r = await api(admin, 'PUT', `/api/admin/members/${idA}/name`, { displayName: XSS_NAME });
  check('rename: HTML stored verbatim (escaped at render)', r.status === 200 && r.data.member?.displayName === XSS_NAME);
  check('rename: CSRF (no Origin) rejected', (await api(admin, 'PUT', `/api/admin/members/${idA}/name`, { displayName: 'x' }, { origin: null })).status === 403);
  check('member cannot rename self', (await api(mA, 'PUT', `/api/admin/members/${idA}/name`, { displayName: '自改' })).status === 403);
  check('member cannot rename others', (await api(mA, 'PUT', `/api/admin/members/${idB}/name`, { displayName: '乱改' })).status === 403);
  const meAfter = (await api(mA, 'GET', '/api/me')).data.user;
  check('member name unchanged by member attempts', meAfter?.displayName === XSS_NAME);
  check('rename unknown member → 404', (await api(admin, 'PUT', '/api/admin/members/99999999/name', { displayName: 'x' })).status === 404);
  r = await api(admin, 'GET', '/api/admin/audit?limit=100');
  check('rename audit-logged with old → new detail', (r.data.audit || []).some((a) =>
    a.username === ua && a.reason === 'display_name_changed' && (a.detail || '').includes(NEWNAME)));
  await api(admin, 'PUT', `/api/admin/members/${idA}/name`, { displayName: NEWNAME });


  // --- anonymous chat ---
  {
    r = await api(mA, 'GET', '/api/chat/messages');
    // Regression: Postgres rejects `WHERE (? IS NULL OR …)` with null $1 → 500 "could not determine data type".
    check('chat: history without before= returns 200 (no PG null-param 500)', r.status === 200, JSON.stringify(r.data).slice(0, 200));
    const aliasA = r.data.alias;
    check('chat: member gets session alias', r.status === 200 && !!aliasA && aliasA !== '管理员', aliasA);
    r = await api(mA, 'GET', '/api/chat/messages?limit=10');
    check('chat: history with limit only still 200', r.status === 200);
    // after we have messages, pagination with before= should also work

    r = await api(mA, 'POST', '/api/chat/messages', { text: '匿名你好 🎴' });
    check('chat: text + emoji accepted', r.status === 200 && r.data.message?.text === '匿名你好 🎴' && r.data.message?.alias === aliasA && r.data.message?.userId === undefined);
    r = await api(mA, 'POST', '/api/chat/messages', { text: '加我微信wxid_test99' });
    check('chat: wechat-like text blocked', r.status === 400 && /联系方式|微信/.test(r.data.error || ''));
    r = await api(mA, 'POST', '/api/chat/messages', { text: 'mail me at a@b.com please' });
    check('chat: email blocked', r.status === 400);
    r = await api(mA, 'POST', '/api/chat/messages', { text: 'x'.repeat(501) });
    check('chat: oversized text rejected', r.status === 400);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    {
      const headers = { Origin: ORIGIN, 'Content-Type': 'image/png' };
      if (mA.cookie) headers.Cookie = mA.cookie;
      const res = await fetch(BASE + '/api/chat/images', { method: 'POST', headers, body: png });
      const data = await res.json().catch(() => ({}));
      check('chat: png upload ok, no identity in response', res.status === 200 && data.message?.type === 'image' && data.message?.imageKey && data.message?.userId === undefined && data.message?.username === undefined, JSON.stringify(data).slice(0, 200));
      const key = data.message?.imageKey;
      const resB = await fetch(BASE + '/api/chat/images/' + key, { headers: { Origin: ORIGIN, Cookie: mB.cookie || '' } });
      check('chat: other member can fetch image when authenticated', resB.status === 200 && (resB.headers.get('content-type') || '').startsWith('image/'));
      const resAnon = await fetch(BASE + '/api/chat/images/' + key, { headers: { Origin: ORIGIN } });
      check('chat: unauthenticated cannot fetch image', resAnon.status === 401 || resAnon.status === 403);
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const bad = await fetch(BASE + '/api/chat/images', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'image/png', Cookie: mA.cookie || '' }, body: svg });
      check('chat: SVG posing as png rejected', bad.status === 400);
    }
    r = await api(mB, 'GET', '/api/chat/messages');
    const leak = JSON.stringify(r.data).match(/"userId"|"username"|"displayName"|"invitedBy"/);
    check('chat: member history has no identity fields', r.status === 200 && !leak, leak && leak[0]);
    const chatWsA = await openWs((await api(mA, 'POST', '/api/ws-token', {})).data.token);
    const chatWsB = await openWs((await api(mB, 'POST', '/api/ws-token', {})).data.token);
    await api(mA, 'POST', '/api/chat/messages', { text: 'ws-ping-' + sfx });
    const got = await waitFor(chatWsB.msgs, (m) => m.type === 'chat_message' && m.message?.text === 'ws-ping-' + sfx);
    check('chat: realtime WS delivery to other member', !!got && got.message.alias === aliasA && got.message.userId === undefined);
    const mid = got?.message?.id;
    r = await api(admin, 'DELETE', `/api/admin/chat/messages/${mid}`);
    check('chat: admin can delete message', r.status === 200);
    const delEv = await waitFor(chatWsB.msgs, (m) => m.type === 'chat_deleted' && m.id === mid);
    check('chat: delete event reaches members', !!delEv);
    r = await api(mB, 'GET', '/api/chat/messages');
    check('chat: deleted message hidden from members', !(r.data.messages || []).some((x) => x.id === mid));
    r = await api(admin, 'POST', '/api/admin/chat/mutes', { userId: idA, minutes: 30 });
    check('chat: admin mute', r.status === 200);
    r = await api(mA, 'POST', '/api/chat/messages', { text: 'should fail' });
    check('chat: muted member cannot send', r.status === 403);
    r = await api(admin, 'DELETE', `/api/admin/chat/mutes/${idA}`);
    check('chat: unmute', r.status === 200);
    r = await api(mA, 'POST', '/api/chat/messages', { text: 'unmuted ok' });
    check('chat: unmuted can send again', r.status === 200);
    r = await api(mA, 'GET', '/api/chat/messages?limit=5');
    const newest = (r.data.messages || []).slice(-1)[0];
    if (newest?.id) {
      const page = await api(mA, 'GET', `/api/chat/messages?before=${newest.id}&limit=5`);
      check('chat: history with before= id returns 200', page.status === 200);
    } else {
      check('chat: history with before= id returns 200', false, 'no messages to page');
    }
    r = await api(admin, 'GET', '/api/chat/messages');
    check('chat: admin history includes identity mapping', (r.data.messages || []).some((x) => x.username === ua && x.alias));
    const aliasBefore = aliasA;
    await api(mA, 'POST', '/api/logout', {});
    const mArel = {};
    r = await login(mArel, ua, PW);
    check('chat: re-login yields alias (new session)', r.status === 200 && !!r.data.chatAlias);
    // alias should typically change; allow rare collision but require presence
    check('chat: new session alias is present for members', r.data.chatAlias && r.data.chatAlias !== '管理员');
    Object.assign(mA, mArel);
    r = await api(admin, 'POST', '/api/admin/chat/clear', {});
    check('chat: admin clear', r.status === 200);
    r = await api(mB, 'GET', '/api/chat/messages');
    check('chat: after clear members see no live messages', (r.data.messages || []).length === 0);
    chatWsA.ws.close(); chatWsB.ws.close();
  }

  // --- announcements + achievements ---
  {
    const XSS_ANN = '<script>alert(1)</script>公告 ' + sfx;
    const memWsAnn = await openWs((await api(mA, 'POST', '/api/ws-token', {})).data.token);
    r = await api(admin, 'POST', '/api/admin/announcements', {
      title: XSS_ANN, body: '正文 ' + XSS_ANN, pinned: true,
    });
    check('admin creates pinned announcement', r.status === 200 && r.data.announcement?.title === XSS_ANN && r.data.announcement?.pinned);
    const annId = r.data.announcement?.id;
    created.announcements = created.announcements || [];
    if (annId) created.announcements.push(annId);
    const pushed = await waitFor(memWsAnn.msgs, (m) => m.type === 'announcement' && m.announcement?.id === annId, 5000);
    check('member WS live announcement push', !!pushed && pushed.announcement?.title === XSS_ANN);
    r = await api(mA, 'GET', '/api/announcements');
    check('member sees announcement unread', r.status === 200 && (r.data.announcements || []).some((a) => a.id === annId && a.read === false) && r.data.unread >= 1);
    check('member cannot create announcement', (await api(mA, 'POST', '/api/admin/announcements', { title: 'x', body: 'y' })).status === 403);
    r = await api(mA, 'POST', `/api/announcements/${annId}/read`, {});
    check('member marks announcement read', r.status === 200);
    r = await api(mA, 'GET', '/api/announcements');
    check('announcement now read; unread decreases', (r.data.announcements || []).some((a) => a.id === annId && a.read === true));
    r = await api(admin, 'PUT', `/api/admin/announcements/${annId}`, { title: '更新' + sfx, body: '新正文' });
    check('admin edits announcement', r.status === 200 && r.data.announcement?.title === '更新' + sfx);
    r = await api(admin, 'POST', `/api/admin/announcements/${annId}/pin`, { pinned: false });
    check('admin unpins announcement', r.status === 200 && r.data.announcement?.pinned === false);
    r = await api(mA, 'GET', '/api/my/achievements');
    const badges = r.data.badges || [];
    const unlocked = Object.fromEntries(badges.filter((b) => b.unlocked).map((b) => [b.key, true]));
    check('achievements: catalog has 11 badges', badges.length === 11);
    check('achievements: first_login unlocked', !!unlocked.first_login);
    check('achievements: first_chat unlocked after text', !!unlocked.first_chat);
    check('achievements: image_master unlocked after image', !!unlocked.image_master);
    check('achievements: suggestion unlocked', !!unlocked.suggestion);
    check('achievements: high_card unlocked for Q+', !!unlocked.high_card);
    check('achievements: invite_1 unlocked after successful invite', !!unlocked.invite_1);
    check('achievements: locked badges still listed', badges.some((b) => !b.unlocked));
    r = await api(admin, 'GET', '/api/admin/members');
    const rowA = (r.data.members || []).find((m) => m.id === idA);
    check('admin member list shows achievement summary', !!rowA?.achievements && rowA.achievements.unlocked >= 5, JSON.stringify(rowA?.achievements));
    r = await api(admin, 'GET', `/api/admin/members/${idA}/achievements`);
    check('admin can view member achievements detail', r.status === 200 && (r.data.badges || []).length === 11);
    // cleanup announcements created here (soft-delete)
    for (const id of created.announcements || []) {
      await api(admin, 'DELETE', `/api/admin/announcements/${id}`);
    }
    r = await api(mA, 'GET', '/api/announcements');
    check('deleted announcements hidden from members', !(r.data.announcements || []).some((a) => (created.announcements || []).includes(a.id)));
    memWsAnn.ws.close();
  }

  // --- jump jump ---
  {
    r = await api(mA, 'GET', '/api/jump/me');
    check('jump: me returns best', r.status === 200 && r.data.best === 0);
    r = await api(mA, 'POST', '/api/jump/score', { score: 3, hops: 3, durationMs: 5000 });
    check('jump: accept modest score', r.status === 200 && r.data.best === 3 && r.data.isNewBest, JSON.stringify(r.data));
    r = await api(mA, 'GET', '/api/my/achievements');
    check('jump: newbie badge unlocked', (r.data.badges || []).some((b) => b.key === 'jump_newbie' && b.unlocked));
    r = await api(mA, 'POST', '/api/jump/score', { score: 9999, hops: 3, durationMs: 5000 });
    check('jump: absurd score rejected', r.status === 400);
    r = await api(mA, 'POST', '/api/jump/score', { score: 40, hops: 2, durationMs: 8000 });
    check('jump: score/hops mismatch rejected', r.status === 400);
    r = await api(mA, 'POST', '/api/jump/score', { score: 20, hops: 18, durationMs: 2000 });
    check('jump: too-fast high-ish score rejected', r.status === 400);
    // build toward pro without huge delta: 3 -> +120 max, so 50 needs steps... allow 3+40? delta 120 from 3 allows up to 123
    r = await api(mA, 'POST', '/api/jump/score', { score: 50, hops: 40, durationMs: 30000 });
    check('jump: score 50 accepted for pro badge', r.status === 200 && r.data.best === 50, JSON.stringify(r.data));
    r = await api(mA, 'GET', '/api/my/achievements');
    check('jump: pro badge unlocked at 50', (r.data.badges || []).some((b) => b.key === 'jump_pro' && b.unlocked));
    r = await api(mA, 'GET', '/api/jump/leaderboard');
    const row = (r.data.leaderboard || []).find((x) => x.me);
    check('jump: leaderboard shows me with alias only (no username)', r.status === 200 && row && row.score === 50 && row.alias && row.username === undefined);
    r = await api(admin, 'GET', '/api/jump/leaderboard');
    check('jump: admin leaderboard includes identity', (r.data.leaderboard || []).some((x) => x.username === ua && x.displayName));
    check('member cannot forge without auth', (await api({}, 'POST', '/api/jump/score', { score: 10, hops: 5, durationMs: 5000 })).status === 401);

    // multiplayer rooms
    r = await api(mA, 'POST', '/api/jump/rooms', {});
    check('jump room: create', r.status === 200 && r.data.room?.code && r.data.share?.url);
    const roomCode = r.data.room.code;
    r = await api(mB, 'POST', `/api/jump/rooms/${roomCode}/join`, {});
    check('jump room: join', r.status === 200 && (r.data.room.players || []).length === 2);
    r = await api(mB, 'POST', `/api/jump/rooms/${roomCode}/ready`, { ready: true });
    check('jump room: ready', r.status === 200);
    r = await api(mA, 'POST', `/api/jump/rooms/${roomCode}/start`, {});
    check('jump room: start', r.status === 200 && r.data.room.status === 'playing' && r.data.seed);
    const seed = r.data.seed;
    const plats = require('../jump-physics').generatePlatforms(seed, 30);
    const ideal0 = require('../jump-physics').idealPower(plats, 0);
    r = await api(mA, 'POST', `/api/jump/rooms/${roomCode}/jump`, { power: ideal0 });
    check('jump room: turn jump scores', r.status === 200 && r.data.event && !r.data.event.miss && r.data.event.score > 0);
    r = await api(mB, 'POST', `/api/jump/rooms/${roomCode}/jump`, { power: 0.5 });
    check('jump room: out-of-turn blocked', r.status === 403);
    check('jump room: share route', (await fetch(`${BASE}/jump/r/${roomCode}`)).status === 200);
    await api(mA, 'POST', `/api/jump/rooms/${roomCode}/leave`, {});
    await api(mB, 'POST', `/api/jump/rooms/${roomCode}/leave`, {});
  }

  // --- 抓大鹅 ---
  {
    const goose = require('../goose-logic');
    function solveGoose(seed) {
      const game = goose.createGame(seed, { triples: 12, typeCount: 6, layers: 4, cols: 6, rows: 6 });
      const seq = [];
      for (let i = 0; i < 500 && game.status === 'playing'; i++) {
        const free = goose.freeTiles(game.tiles);
        if (!free.length) break;
        const counts = {};
        for (const x of game.tray) counts[x] = (counts[x] || 0) + 1;
        free.sort((a, b) => (counts[b.type] || 0) - (counts[a.type] || 0));
        let chosen = null;
        for (const t of free) {
          const sim = goose.insertAndClear(game.tray.slice(), t.type);
          if (sim.tray.length < goose.TRAY_SIZE || sim.cleared) { chosen = t; break; }
        }
        if (!chosen) chosen = free[0];
        if (!goose.pickTile(game, chosen.id).ok) break;
        seq.push(chosen.id);
      }
      return { status: game.status, seq, moves: game.moves };
    }
    r = await api(mA, 'GET', '/api/goose/me');
    check('goose: me returns clears', r.status === 200 && r.data.clears === 0);
    r = await api(mA, 'POST', '/api/goose/score', { won: false, seed: 1, moves: 3, durationMs: 5000, pickSeq: [] });
    check('goose: loss still counted as played', r.status === 200 && r.data.won === false && r.data.gamesPlayed >= 1);
    const sol = solveGoose(42);
    check('goose: local solver wins seed 42', sol.status === 'won' && sol.seq.length >= 9, sol.status);
    r = await api(mA, 'POST', '/api/goose/score', {
      won: true, seed: 42, moves: sol.moves, durationMs: Math.max(8000, sol.moves * 200), pickSeq: sol.seq,
    });
    check('goose: accept validated clear', r.status === 200 && r.data.won && r.data.clears >= 1 && r.data.isNewBest, JSON.stringify(r.data));
    r = await api(mA, 'GET', '/api/my/achievements');
    check('goose: newbie badge unlocked', (r.data.badges || []).some((b) => b.key === 'goose_newbie' && b.unlocked));
    r = await api(mA, 'POST', '/api/goose/score', {
      won: true, seed: 42, moves: sol.moves, durationMs: 1000, pickSeq: sol.seq,
    });
    check('goose: too-fast clear rejected', r.status === 400);
    r = await api(mA, 'POST', '/api/goose/score', {
      won: true, seed: 42, moves: sol.moves, durationMs: 9000, pickSeq: sol.seq.slice(0, 5),
    });
    check('goose: incomplete seq rejected', r.status === 400);
    // two more clears for pro
    for (const seed of [1, 7]) {
      const s2 = solveGoose(seed);
      r = await api(mA, 'POST', '/api/goose/score', {
        won: true, seed, moves: s2.moves, durationMs: Math.max(8000, s2.moves * 200), pickSeq: s2.seq,
      });
    }
    check('goose: third clear accepted', r.status === 200 && r.data.clears >= 3, JSON.stringify(r.data));
    r = await api(mA, 'GET', '/api/my/achievements');
    check('goose: pro badge at 3 clears', (r.data.badges || []).some((b) => b.key === 'goose_pro' && b.unlocked));
    r = await api(mA, 'GET', '/api/goose/leaderboard');
    const grow = (r.data.leaderboard || []).find((x) => x.me);
    check('goose: leaderboard alias only for members', r.status === 200 && grow && grow.clears >= 3 && grow.alias && grow.username === undefined);
    r = await api(admin, 'GET', '/api/goose/leaderboard');
    check('goose: admin leaderboard includes identity', (r.data.leaderboard || []).some((x) => x.username === ua));
    check('goose: unauth score blocked', (await api({}, 'POST', '/api/goose/score', { won: true, seed: 1, moves: 36, durationMs: 9000, pickSeq: [] })).status === 401);
    check('goose: /games SPA route', (await fetch(BASE + '/games')).status === 200);
    check('goose: client asset', (await fetch(BASE + '/js/goose-game.js')).status === 200);
  }


  // --- session rotation ---
  const oldCookie = mA.cookie;
  r = await login(mA2, ua, PW);
  check('second login gets a different session id', r.status === 200 && mA2.cookie && mA2.cookie !== oldCookie);
  const relog = { cookie: oldCookie };
  await login(relog, ua, PW);
  check('login rotates session id (old cookie replaced)', relog.cookie !== oldCookie);
  check('rotated-away session id invalid', (await api({ cookie: oldCookie }, 'GET', '/api/me')).status === 401);
  mA.cookie = relog.cookie;

  // --- change password ---
  r = await api(mA, 'POST', '/api/me/password', { currentPassword: 'wrong-pass-1', newPassword: PW + 'X' });
  check('change password: wrong current rejected', r.status === 400);
  r = await api(mA, 'POST', '/api/me/password', { currentPassword: PW, newPassword: 'short' });
  check('change password: new < 8 rejected', r.status === 400);
  const PW2 = PW + 'X';
  r = await api(mA, 'POST', '/api/me/password', { currentPassword: PW, newPassword: PW2 });
  check('change password OK, other sessions closed', r.status === 200 && r.data.otherSessionsClosed >= 1, JSON.stringify(r.data));
  check('this device still logged in', (await api(mA, 'GET', '/api/me')).status === 200);
  check('other device logged out after password change', (await api(mA2, 'GET', '/api/me')).status === 401);
  check('old password no longer works', (await login({}, ua, PW)).status === 401);

  // --- 2FA ---
  r = await api(mA, 'POST', '/api/me/2fa/setup', {});
  const secret = r.data.secret;
  check('2FA setup returns QR + secret', r.status === 200 && /^data:image\/png;base64,/.test(r.data.qr || '') && secret);
  check('2FA enable rejects wrong code', (await api(mA, 'POST', '/api/me/2fa/enable', { code: '000000' })).status === 400);
  const code0 = authenticator.generate(secret);
  r = await api(mA, 'POST', '/api/me/2fa/enable', { code: code0 });
  check('2FA enable with valid TOTP', r.status === 200, JSON.stringify(r.data));
  r = await login({}, ua, PW2);
  check('login with 2FA but no code → TOTP_REQUIRED', r.status === 401 && r.data.code === 'TOTP_REQUIRED');
  r = await login({}, ua, PW2, code0);
  check('replayed TOTP code rejected', r.status === 401);
  const next = authenticator.clone({ epoch: Date.now() + 30000 }).generate(secret);
  const m2fa = {};
  r = await login(m2fa, ua, PW2, next);
  check('login with password + fresh TOTP succeeds', r.status === 200, JSON.stringify(r.data));
  r = await api(admin, 'POST', `/api/admin/members/${idA}/reset-2fa`, {});
  check('admin resets member 2FA', r.status === 200);
  r = await login({}, ua, PW2);
  check('after reset, password-only login works', r.status === 200);

  // --- admin sessions + force logout ---
  r = await api(admin, 'GET', '/api/admin/sessions');
  check('admin sees member sessions', (r.data.sessions || []).filter((s) => s.userId === idA).length >= 2);
  check('session list never exposes raw sid', !(r.data.sessions || []).some((s) => s.sid));
  const wsA = await openWs((await api(m2fa, 'POST', '/api/ws-token', {})).data.token);
  r = await api(admin, 'POST', `/api/admin/members/${idA}/logout`, {});
  check('admin force-logout member', r.status === 200 && r.data.closed >= 2, JSON.stringify(r.data));
  check('member sessions invalid after force logout',
    (await api(mA, 'GET', '/api/me')).status === 401 && (await api(m2fa, 'GET', '/api/me')).status === 401);
  check('member WS got force_logout', await waitFor(wsA.msgs, (m) => m.type === 'force_logout', 5000));
  check('member WS-token revoked', (await api(mA, 'POST', '/api/ws-token', {})).status === 401);

  // --- disable kills sessions ---
  check('member B logged in', (await api(mB, 'GET', '/api/me')).status === 200);
  await api(admin, 'POST', `/api/admin/members/${idB}/disable`, { disabled: true });
  check('disabling member kills its sessions', (await api(mB, 'GET', '/api/me')).status === 401);
  r = await login({}, ub, PW);
  check('disabled member cannot log in', r.status === 403);

  // --- lockout (test account only) + generic errors ---
  const r1 = await login({}, 'nouser_' + sfx, 'whatever-123');
  const r2 = await login({}, ua, 'wrong-pass-0');
  check('generic error: unknown user and wrong password look the same', r1.status === 401 && r2.status === 401 && r1.data.error === r2.data.error, r1.data.error + ' | ' + r2.data.error);
  for (let i = 0; i < 4; i++) await login({}, ua, 'wrong-pass-' + i);
  r = await login({}, ua, PW2);
  check('5 failures → account locked even with right password (429)', r.status === 429, JSON.stringify(r.data));
  r = await login({}, ua.toUpperCase(), PW2);
  check('lock applies case-insensitively', r.status === 429);
  await api(admin, 'POST', '/api/admin/unlock', { username: ua });
  r = await login({}, ua, PW2);
  check('admin unlock works', r.status === 200);
  check('real admin still logs in (IP not locked)', (await login({}, AU, AP)).status === 200);

  // --- logout other devices ---
  const d1 = {}, d2 = {};
  await login(d1, ua, PW2); await login(d2, ua, PW2);
  r = await api(d1, 'POST', '/api/me/sessions/logout-others', {});
  check('"logout other devices" keeps current, kills others',
    r.status === 200 && (await api(d1, 'GET', '/api/me')).status === 200 && (await api(d2, 'GET', '/api/me')).status === 401);

  // --- audit log ---
  r = await api(admin, 'GET', '/api/admin/audit?limit=200');
  const aud = r.data.audit || [];
  check('audit log has success + failure entries with IP/UA',
    aud.some((a) => a.username === ua && a.success && a.ip && a.userAgent !== undefined) &&
    aud.some((a) => a.username === ua && !a.success && a.reason === 'bad_password') &&
    aud.some((a) => a.username === ua && a.reason === 'locked'));

  // --- cleanup ---
  if (!process.env.KEEP_TEST_DATA) {
    for (const id of created.members) { const d = await api(admin, "DELETE", `/api/admin/members/${id}`); if (d.status !== 200) console.log("delete member", id, d.status, JSON.stringify(d.data)); }
    await api(admin, "POST", "/api/admin/chat/clear", {});
    const all = (await api(admin, 'GET', '/api/admin/invites')).data.invites || [];
    for (const i of all) if (created.codes.includes(i.code)) await api(admin, 'DELETE', `/api/admin/invites/${i.id}`);
    const m = await api(admin, 'GET', '/api/admin/members');
    const i2 = await api(admin, 'GET', '/api/admin/invites');
    const s = await api(admin, 'GET', '/api/admin/suggestions');
    check('cleanup: no test members/codes/suggestions left',
      !(m.data.members || []).some((x) => x.username.endsWith(sfx)) &&
      !(i2.data.invites || []).some((x) => created.codes.includes(x.code)) &&
      !(s.data.suggestions || []).some((x) => x.username && x.username.endsWith(sfx)));
  } else {
    console.log('KEEP_TEST_DATA set: test users', ua, ub, 'kept');
  }
  adminWs.ws.close(); memWs.ws.close(); wsA.ws.close();
  const passed = results.filter((x) => x.pass).length;
  console.log(`\npassed ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
