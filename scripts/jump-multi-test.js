/**
 * API + light WS test for jump multiplayer rooms.
 * Usage: BASE_URL=http://127.0.0.1:3000 node scripts/jump-multi-test.js
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const phys = require('../jump-physics');

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const origin = new URL(BASE).origin;

function readAdmin() {
  const text = fs.readFileSync(path.join(__dirname, '..', 'ADMIN_CREDENTIALS.txt'), 'utf8');
  return {
    user: text.match(/用户名:\s*(.+)/)?.[1]?.trim(),
    pass: text.match(/密码:\s*(.+)/)?.[1]?.trim(),
  };
}

async function api(jar, method, urlPath, body) {
  const headers = { 'Content-Type': 'application/json', Origin: origin };
  if (jar.cookie) headers.Cookie = jar.cookie;
  const res = await fetch(`${BASE}${urlPath}`, {
    method, headers, body: body != null ? JSON.stringify(body) : undefined,
  });
  const raw = res.headers.getSetCookie?.() || [];
  for (const c of raw) if (c.startsWith('card.sid=')) jar.cookie = c.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function check(name, ok, detail) {
  if (ok) console.log('✓', name);
  else { console.error('✗', name, detail || ''); process.exitCode = 1; }
}

function wsAuth(jar) {
  return new Promise(async (resolve, reject) => {
    const tok = await api(jar, 'POST', '/api/ws-token', {});
    if (tok.status !== 200) return reject(new Error('ws token'));
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws', { origin });
    const timer = setTimeout(() => reject(new Error('ws timeout')), 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: tok.data.token })));
    ws.on('message', (buf) => {
      const msg = JSON.parse(String(buf));
      if (msg.type === 'auth_ok') { clearTimeout(timer); resolve({ ws, inbox: [] }); }
      if (msg.type === 'auth_fail') { clearTimeout(timer); reject(new Error('auth_fail')); }
    });
    ws.on('error', reject);
  });
}

(async () => {
  const creds = readAdmin();
  const admin = {};
  let r = await api(admin, 'POST', '/api/login', { username: creds.user, password: creds.pass });
  check('admin login', r.status === 200);
  r = await api(admin, 'POST', '/api/admin/invites', { count: 2 });
  const codes = r.data.codes || [];
  check('invites', codes.length >= 2);

  const sfx = Date.now().toString(36).slice(-5);
  const jars = [{}, {}];
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const u = 'jm' + i + '_' + sfx;
    r = await api(jars[i], 'POST', '/api/register', {
      username: u, password: 'Test-pass-' + sfx + '9', inviteCode: codes[i], displayName: '联机' + (i + 1),
    });
    check('register ' + i, r.status === 200, JSON.stringify(r.data));
    ids.push(r.data.user.id);
  }

  // create room as player0
  r = await api(jars[0], 'POST', '/api/jump/rooms', {});
  check('create room', r.status === 200 && r.data.room?.code && r.data.share?.url, JSON.stringify(r.data));
  const code = r.data.room.code;
  check('share text has url+code', r.data.share.text.includes(code) && r.data.share.url.includes('/jump/r/' + code));
  check('SPA route', (await fetch(`${BASE}/jump/r/${code}`)).status === 200);

  r = await api(jars[1], 'POST', `/api/jump/rooms/${code}/join`, {});
  check('join room', r.status === 200 && r.data.room.players.length === 2);

  r = await api(jars[1], 'POST', `/api/jump/rooms/${code}/ready`, { ready: true });
  check('ready', r.status === 200 && r.data.room.players.every((p) => p.ready));

  // unauth cannot join
  check('guest blocked', (await api({}, 'POST', `/api/jump/rooms/${code}/join`, {})).status === 401);

  r = await api(jars[0], 'POST', `/api/jump/rooms/${code}/start`, {});
  check('start', r.status === 200 && r.data.room.status === 'playing' && r.data.seed && r.data.platforms?.length > 5);
  const seed = r.data.seed;
  const platforms = phys.generatePlatforms(seed, r.data.platforms.length);
  check('seed matches first platforms', Math.abs(platforms[1].z - r.data.platforms[1].z) < 1e-9);

  const turn0 = r.data.room.turnUserId;
  check('first turn is host/p0', turn0 === ids[0]);

  // p1 cannot jump out of turn
  r = await api(jars[1], 'POST', `/api/jump/rooms/${code}/jump`, { power: 0.5 });
  check('out-of-turn rejected', r.status === 403);

  // p0 ideal jumps a few times then miss
  let roomState = null;
  for (let i = 0; i < 5; i++) {
    const ideal = phys.idealPower(platforms, i);
    r = await api(jars[0], 'POST', `/api/jump/rooms/${code}/jump`, { power: ideal });
    check('p0 jump ' + (i + 1), r.status === 200 && r.data.event && !r.data.event.miss, JSON.stringify(r.data));
    roomState = r.data.room;
  }
  check('score > 0 after lands', roomState.players.find((p) => p.userId === ids[0]).score > 0);

  // miss
  r = await api(jars[0], 'POST', `/api/jump/rooms/${code}/jump`, { power: 0.05 });
  check('p0 miss ends turn', r.status === 200 && r.data.event.miss && r.data.event.turnEnded);
  check('turn passes to p1', r.data.room.turnUserId === ids[1], JSON.stringify(r.data.room));

  // p1 miss immediately → round finished
  r = await api(jars[1], 'POST', `/api/jump/rooms/${code}/jump`, { power: 0.05 });
  check('p1 miss finishes round', r.status === 200 && r.data.event.roundEnded && r.data.room.status === 'finished');
  check('winner is p0', r.data.room.winnerUserId === ids[0]);

  // rematch
  r = await api(jars[0], 'POST', `/api/jump/rooms/${code}/rematch`, {});
  check('rematch waiting', r.status === 200 && r.data.room.status === 'waiting');

  // cleanup
  await api(jars[0], 'POST', `/api/jump/rooms/${code}/leave`, {});
  await api(jars[1], 'POST', `/api/jump/rooms/${code}/leave`, {});
  for (const id of ids) await api(admin, 'DELETE', `/api/admin/members/${id}`);
  console.log(process.exitCode ? 'FAILED' : 'All jump-multi API tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
