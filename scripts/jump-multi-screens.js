/**
 * Screenshots: jump-multi-lobby / play / share
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const phys = require('../jump-physics');

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const SCREEN_DIR = path.join(__dirname, '..', 'screens');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

function readAdmin() {
  const text = fs.readFileSync(path.join(__dirname, '..', 'ADMIN_CREDENTIALS.txt'), 'utf8');
  return {
    user: text.match(/用户名:\s*(.+)/)?.[1]?.trim(),
    pass: text.match(/密码:\s*(.+)/)?.[1]?.trim(),
  };
}

async function api(jar, method, urlPath, body) {
  const headers = { 'Content-Type': 'application/json', Origin: new URL(BASE).origin };
  if (jar.cookie) headers.Cookie = jar.cookie;
  const res = await fetch(`${BASE}${urlPath}`, {
    method, headers, body: body != null ? JSON.stringify(body) : undefined,
  });
  for (const c of (res.headers.getSetCookie?.() || [])) {
    if (c.startsWith('card.sid=')) jar.cookie = c.split(';')[0];
  }
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function contextFor(jar) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'zh-CN', hasTouch: true });
  const cookieVal = jar.cookie.replace(/^card.sid=/, '');
  await ctx.addCookies([{ name: 'card.sid', value: cookieVal, url: BASE }]);
  return { browser, ctx };
}

(async () => {
  const creds = readAdmin();
  const admin = {};
  await api(admin, 'POST', '/api/login', { username: creds.user, password: creds.pass });
  let r = await api(admin, 'POST', '/api/admin/invites', { count: 2 });
  const codes = r.data.codes;
  const sfx = Date.now().toString(36).slice(-4);
  const jars = [{}, {}];
  const ids = [];
  for (let i = 0; i < 2; i++) {
    r = await api(jars[i], 'POST', '/api/register', {
      username: 'js' + i + sfx, password: 'Test-pass-' + sfx + '9', inviteCode: codes[i], displayName: '截图玩家' + (i + 1),
    });
    ids.push(r.data.user.id);
  }

  // Host creates via API then open UI
  r = await api(jars[0], 'POST', '/api/jump/rooms', {});
  const code = r.data.room.code;
  await api(jars[1], 'POST', `/api/jump/rooms/${code}/join`, {});
  await api(jars[1], 'POST', `/api/jump/rooms/${code}/ready`, { ready: true });

  const host = await contextFor(jars[0]);
  const page = await host.ctx.newPage();
  await page.goto(`${BASE}/jump/r/${code}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.jmr-share-url', { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREEN_DIR, 'jump-multi-lobby.png'), fullPage: true });
  console.log('✓ jump-multi-lobby.png');

  // Share-focused crop: scroll to share box
  await page.locator('#jmrShareBox').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.locator('#jmrShareBox').screenshot({ path: path.join(SCREEN_DIR, 'jump-multi-share.png') });
  console.log('✓ jump-multi-share.png');

  // Start game
  await page.click('#jmrStart');
  await page.waitForSelector('#jmrGameRoot canvas', { timeout: 10000 });
  await page.waitForTimeout(600);

  // Do a couple ideal jumps via API then refresh state on page via WS
  r = await api(jars[0], 'GET', `/api/jump/rooms/${code}`);
  const seed = r.data.room.seed;
  // get platforms from start - re-fetch by simulating jumps
  // Use evaluate to trigger jumps through game if interactive
  for (let i = 0; i < 3; i++) {
    const st = await api(jars[0], 'GET', `/api/jump/rooms/${code}`);
    const plats = phys.generatePlatforms(st.data.room.seed, 40);
    // find current idx from score/hops roughly - use physics from hops
    const hops = st.data.room.players.find((p) => p.userId === ids[0])?.hops || 0;
    const ideal = phys.idealPower(plats, hops);
    await api(jars[0], 'POST', `/api/jump/rooms/${code}/jump`, { power: ideal });
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SCREEN_DIR, 'jump-multi-play.png'), fullPage: true });
  console.log('✓ jump-multi-play.png');

  await host.browser.close();
  for (const id of ids) await api(admin, 'DELETE', `/api/admin/members/${id}`);
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
