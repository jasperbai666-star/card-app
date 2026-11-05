/**
 * Play-test 跳一跳: mount page, simulate ideal jumps, assert score rises, screenshot.
 * Usage: BASE_URL=http://127.0.0.1:3000 ADMIN_USERNAME=... ADMIN_PASSWORD=... node scripts/jump-play-test.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const SCREEN_DIR = path.join(__dirname, '..', 'screens');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

function readAdminCreds() {
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    return { user: process.env.ADMIN_USERNAME, pass: process.env.ADMIN_PASSWORD };
  }
  const text = fs.readFileSync(path.join(__dirname, '..', 'ADMIN_CREDENTIALS.txt'), 'utf8');
  const user = text.match(/用户名:\s*(.+)/)?.[1]?.trim();
  const pass = text.match(/密码:\s*(.+)/)?.[1]?.trim();
  if (!user || !pass) throw new Error('missing admin creds');
  return { user, pass };
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

(async () => {
  const creds = readAdminCreds();
  const admin = {};
  let r = await api(admin, 'POST', '/api/login', { username: creds.user, password: creds.pass });
  if (r.status !== 200) throw new Error('admin login failed');
  r = await api(admin, 'POST', '/api/admin/invites', { count: 1 });
  const code = r.data.codes?.[0];
  const sfx = Date.now().toString(36).slice(-4);
  const muser = 'jmp_' + sfx;
  const mjar = {};
  r = await api(mjar, 'POST', '/api/register', { username: muser, password: 'Test-pass-' + sfx + '9', inviteCode: code, displayName: '跳跳测试' });
  if (r.status !== 200) throw new Error('register failed ' + JSON.stringify(r.data));
  const mid = r.data.user.id;

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'zh-CN', hasTouch: true });
  // inject session cookie
  const cookieVal = mjar.cookie.replace(/^card.sid=/, '');
  await ctx.addCookies([{ name: 'card.sid', value: cookieVal, url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/member`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#jumpGameRoot', { timeout: 15000 });
  await page.locator('#jumpPanel').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  // Wait for JumpGame mount
  await page.waitForFunction(() => document.getElementById('jumpGameRoot')?._jg, null, { timeout: 10000 });

  const results = [];
  for (let i = 0; i < 8; i++) {
    const res = await page.evaluate(async () => {
      const g = document.getElementById('jumpGameRoot')._jg;
      return g.simulateJump('ideal');
    });
    results.push(res);
    console.log('jump', i + 1, res);
    if (res.state === 'over') break;
    await page.waitForTimeout(80);
  }

  const midScore = await page.evaluate(() => document.getElementById('jumpGameRoot')._jg.getState());
  console.log('mid state', midScore);
  if (!(midScore.score > 0)) {
    console.error('FAIL: score still 0 after ideal jumps');
    process.exit(1);
  }
  console.log('✓ scored', midScore.score, 'hops', midScore.hops);

  await page.screenshot({ path: path.join(SCREEN_DIR, 'jump-wechat-play.png'), fullPage: true });
  console.log('✓ screenshot jump-wechat-play.png');

  // Force a miss to get game-over screen
  await page.evaluate(async () => {
    const g = document.getElementById('jumpGameRoot')._jg;
    // tiny power = undershoot
    await g.simulateJump(0.05);
  });
  await page.waitForSelector('#jgOver:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SCREEN_DIR, 'jump-wechat-over.png'), fullPage: true });
  console.log('✓ screenshot jump-wechat-over.png');

  // Also verify internals: sweet-spot power lands within gap range
  const phys = await page.evaluate(() => {
    const I = window.JumpGame._internals;
    const mid = I.powerToDistance(0.6);
    return { mid, min: I.MIN_JUMP, max: I.MAX_JUMP, gapMin: I.GAP_MIN, gapMax: I.GAP_MAX };
  });
  console.log('physics', phys);
  if (!(phys.mid >= phys.gapMin && phys.mid <= phys.gapMax)) {
    console.error('FAIL: 60% charge distance not in typical gap range', phys);
    process.exit(1);
  }
  console.log('✓ charge-to-distance calibrated');

  await browser.close();

  // cleanup member
  await api(admin, 'DELETE', `/api/admin/members/${mid}`);
  console.log('All jump play tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
