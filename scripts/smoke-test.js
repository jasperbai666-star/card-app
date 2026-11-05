/**
 * API + WebSocket smoke test against a running deployment, then cleans up test data.
 * Usage: BASE_URL=https://xxx.onrender.com ADMIN_USERNAME=admin ADMIN_PASSWORD=... node scripts/smoke-test.js
 */
const WebSocket = require('ws');
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const AU = process.env.ADMIN_USERNAME, AP = process.env.ADMIN_PASSWORD;
const results = [];
const check = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(cond ? '✓' : '✗', name, cond ? '' : extra); };

async function api(jar, method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (jar.cookie) headers.Cookie = jar.cookie;
  const res = await fetch(BASE + p, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
  for (const c of res.headers.getSetCookie?.() || []) {
    if (c.startsWith('card.sid=')) { jar.cookie = c.split(';')[0]; jar.raw = c; }
  }
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function openWs(token) {
  const url = BASE.replace(/^http/, 'ws') + '/ws';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const msgs = [];
    ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('error', reject);
    const t = setInterval(() => { if (msgs.find((m) => m.type === 'auth_ok')) { clearInterval(t); resolve({ ws, msgs }); } }, 100);
    setTimeout(() => { clearInterval(t); reject(new Error('ws auth timeout')); }, 15000);
  });
}
const waitFor = (msgs, pred, ms = 10000) => new Promise((res) => {
  const t0 = Date.now(); const t = setInterval(() => { const m = msgs.find(pred); if (m || Date.now() - t0 > ms) { clearInterval(t); res(m); } }, 100);
});

(async () => {
  const admin = {}, mem = {}, other = {};
  const sfx = Math.random().toString(36).slice(2, 6);
  let r = await api(admin, 'POST', '/api/login', { username: AU, password: AP });
  check('admin login', r.status === 200 && r.data.user?.role === 'admin');
  if (BASE.startsWith('https')) check('session cookie is Secure+HttpOnly', /Secure/i.test(admin.raw || '') && /HttpOnly/i.test(admin.raw || ''), admin.raw);
  const adminWs = await openWs(r.data.wsToken); check('admin WebSocket (wss) auth', true);

  r = await api(admin, 'POST', '/api/admin/invites', { count: 2 });
  const [code, code2] = r.data.codes || [];
  check('create invite codes', code && code2);
  r = await api(mem, 'POST', '/api/register', { username: 'test_' + sfx, password: 'testpass1', inviteCode: code });
  const memId = r.data.user?.id; check('member registers with code', r.status === 200 && memId);
  r = await api(other, 'POST', '/api/register', { username: 'test2_' + sfx, password: 'testpass1', inviteCode: code });
  check('same code rejected 2nd time', r.status === 400);
  r = await api(other, 'POST', '/api/register', { username: 'test2_' + sfx, password: 'testpass1', inviteCode: code2 });
  const otherId = r.data.user?.id; check('second member registers', r.status === 200 && otherId);
  check('admin WS got member_joined', await waitFor(adminWs.msgs, (m) => m.type === 'member_joined'));

  const memWs = await openWs(r.status && (await api(mem, 'POST', '/api/ws-token', {})).data.token);
  r = await api(admin, 'PUT', `/api/admin/members/${memId}/card`, { rank: 'Q', suit: 'heart' });
  check('admin sets member card', r.status === 200);
  await api(admin, 'PUT', `/api/admin/members/${otherId}/card`, { rank: 'joker_big' });
  const live = await waitFor(memWs.msgs, (m) => m.type === 'card_updated');
  check('member WS live card_updated', live && live.card?.rank === 'Q');
  r = await api(mem, 'GET', '/api/my/card');
  check('member sees own card Q♥', r.data.card?.rank === 'Q' && r.data.card?.suit === 'heart');
  r = await api(mem, 'GET', '/api/admin/members');
  check('member blocked from admin members list', r.status === 403);
  r = await api(mem, 'PUT', `/api/admin/members/${otherId}/card`, { rank: 'A', suit: 'spade' });
  check('member cannot set cards', r.status === 403);
  r = await api(mem, 'POST', '/api/my/suggestions', { type: 'suggestion', content: '测试建议 ' + sfx });
  check('member submits suggestion', r.status === 200);
  check('admin WS live new_suggestion', await waitFor(adminWs.msgs, (m) => m.type === 'new_suggestion'));
  r = await api(admin, 'GET', '/api/admin/suggestions');
  check('admin sees suggestion', (r.data.suggestions || []).some((s) => s.content === '测试建议 ' + sfx));

  // cleanup
  for (const id of [memId, otherId]) await api(admin, 'DELETE', `/api/admin/members/${id}`);
  r = await api(admin, 'GET', '/api/admin/invites');
  for (const inv of r.data.invites || []) if ([code, code2].includes(inv.code)) await api(admin, 'DELETE', `/api/admin/invites/${inv.id}`);
  const m = await api(admin, 'GET', '/api/admin/members');
  const i = await api(admin, 'GET', '/api/admin/invites');
  const s = await api(admin, 'GET', '/api/admin/suggestions');
  check('cleanup: no test members/codes/suggestions left',
    !(m.data.members || []).some((x) => x.username.endsWith(sfx)) &&
    !(i.data.invites || []).some((x) => [code, code2].includes(x.code)) &&
    !(s.data.suggestions || []).some((x) => x.content.endsWith(sfx)));
  adminWs.ws.close(); memWs.ws.close();
  const passed = results.filter((x) => x.pass).length;
  console.log(`\npassed ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
