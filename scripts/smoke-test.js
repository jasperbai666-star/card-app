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
  const created = { members: [], codes: [] };
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
