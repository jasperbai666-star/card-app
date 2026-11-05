/**
 * End-to-end test + screenshots for card-app
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const SCREEN_DIR = path.join(__dirname, '..', 'screens');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

function readAdminCreds() {
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) return { user: process.env.ADMIN_USERNAME, pass: process.env.ADMIN_PASSWORD };
  const text = fs.readFileSync(path.join(__dirname, '..', 'ADMIN_CREDENTIALS.txt'), 'utf8');
  const user = text.match(/用户名:\s*(.+)/)?.[1]?.trim();
  const pass = text.match(/密码:\s*(.+)/)?.[1]?.trim();
  if (!user || !pass) throw new Error('无法解析 ADMIN_CREDENTIALS.txt');
  return { user, pass };
}

async function api(cookieJar, method, urlPath, body) {
  const headers = { 'Content-Type': 'application/json', Origin: new URL(BASE).origin };
  if (cookieJar.cookie) headers.Cookie = cookieJar.cookie;
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of setCookie) {
    const part = c.split(';')[0];
    if (part.startsWith('card.sid=')) cookieJar.cookie = part;
  }
  if (!cookieJar.cookie) {
    const sc = res.headers.get('set-cookie');
    if (sc) cookieJar.cookie = sc.split(';')[0];
  }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  const results = [];
  const ok = (name) => { results.push({ name, pass: true }); console.log('✓', name); };
  const fail = (name, err) => { results.push({ name, pass: false, err: String(err) }); console.error('✗', name, err); };

  const creds = readAdminCreds();
  const adminJar = {};

  {
    const r = await api(adminJar, 'POST', '/api/login', { username: creds.user, password: creds.pass });
    if (r.status === 200 && r.data.user?.role === 'admin' && adminJar.cookie) ok('admin login');
    else fail('admin login', JSON.stringify(r));
  }

  let codes = [];
  {
    const r = await api(adminJar, 'POST', '/api/admin/invites', { count: 2 });
    if (r.status === 200 && r.data.codes?.length === 2) {
      codes = r.data.codes;
      ok('generate 2 invite codes');
    } else fail('generate 2 invite codes', JSON.stringify(r));
  }

  // Fresh members each run (unique suffix)
  const suffix = Date.now().toString(36).slice(-4);
  const m1user = `member_a_${suffix}`;
  const m2user = `member_b_${suffix}`;

  const m1Jar = {};
  {
    const r = await api(m1Jar, 'POST', '/api/register', {
      username: m1user,
      password: 'testpass1',
      inviteCode: codes[0],
      displayName: '阿尔法',
    });
    if (r.status === 200 && r.data.user?.role === 'member') ok('register member1 with code1');
    else fail('register member1 with code1', JSON.stringify(r));
  }

  {
    const r = await api({}, 'POST', '/api/register', {
      username: `reuse_${suffix}`,
      password: 'testpassX',
      inviteCode: codes[0],
    });
    if (r.status === 400) ok('reusing invite code fails');
    else fail('reusing invite code fails', JSON.stringify(r));
  }

  const m2Jar = {};
  {
    const r = await api(m2Jar, 'POST', '/api/register', {
      username: m2user,
      password: 'testpass2',
      inviteCode: codes[1],
      displayName: '贝塔',
    });
    if (r.status === 200 && r.data.user?.role === 'member') ok('register member2 with code2');
    else fail('register member2 with code2', JSON.stringify(r));
  }

  let m1Id, m2Id;
  {
    const r = await api(adminJar, 'GET', '/api/admin/members');
    const members = r.data.members || [];
    m1Id = members.find((m) => m.username === m1user)?.id;
    m2Id = members.find((m) => m.username === m2user)?.id;
    if (m1Id && m2Id) ok('admin lists members');
    else fail('admin lists members', JSON.stringify(r.data));
  }
  {
    const r1 = await api(adminJar, 'PUT', `/api/admin/members/${m1Id}/card`, { rank: 'joker_big' });
    const r2 = await api(adminJar, 'PUT', `/api/admin/members/${m2Id}/card`, { rank: 'K', suit: 'spade' });
    if (r1.status === 200 && r1.data.member?.card?.rank === 'joker_big' &&
        r2.status === 200 && r2.data.member?.card?.label === 'K') ok('admin sets cards');
    else fail('admin sets cards', JSON.stringify({ r1, r2 }));
  }

  {
    const r = await api(m1Jar, 'GET', '/api/my/card');
    if (r.status === 200 && r.data.card?.rank === 'joker_big') ok('member1 sees own card (大王)');
    else fail('member1 sees own card', JSON.stringify(r));
  }
  {
    const r = await api(m2Jar, 'GET', '/api/my/card');
    if (r.status === 200 && r.data.card?.rank === 'K') ok('member2 sees own card (K♠)');
    else fail('member2 sees own card', JSON.stringify(r));
  }

  {
    const r = await api(m1Jar, 'GET', '/api/admin/members');
    if (r.status === 403) ok('member blocked from /api/admin/members');
    else fail('member blocked from admin members', JSON.stringify(r));
  }
  {
    const r = await api(m1Jar, 'GET', '/api/admin/ranking');
    if (r.status === 403) ok('member blocked from /api/admin/ranking');
    else fail('member blocked from ranking', JSON.stringify(r));
  }
  {
    const r = await api(m1Jar, 'PUT', `/api/admin/members/${m2Id}/card`, { rank: 'A', suit: 'heart' });
    if (r.status === 403) ok('member cannot change others cards');
    else fail('member cannot change others cards', JSON.stringify(r));
  }

  {
    const r = await api(m1Jar, 'POST', '/api/my/suggestions', {
      type: 'suggestion',
      content: '希望下周活动安排大王对决',
    });
    if (r.status === 200 && r.data.suggestion?.id) ok('member submits suggestion');
    else fail('member submits suggestion', JSON.stringify(r));
  }

  {
    const r = await api(adminJar, 'GET', '/api/admin/suggestions?status=pending');
    const hit = (r.data.suggestions || []).find((s) => s.content.includes('大王对决'));
    if (r.status === 200 && hit) ok('admin sees suggestion');
    else fail('admin sees suggestion', JSON.stringify(r.data));
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // Login page (fresh context)
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#authForm');
    await page.screenshot({ path: path.join(SCREEN_DIR, 'login.png'), fullPage: true });
    ok('screenshot login.png');
    await ctx.close();
  }

  // Register page
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
    await page.waitForSelector('input[name="inviteCode"]');
    await page.screenshot({ path: path.join(SCREEN_DIR, 'register.png'), fullPage: true });
    ok('screenshot register.png');
    await ctx.close();
  }

  // Admin dashboard
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[name="username"]', creds.user);
    await page.fill('input[name="password"]', creds.pass);
    await Promise.all([
      page.waitForFunction(() => location.pathname === '/admin' || document.querySelector('.tabs')),
      page.click('button[type="submit"]'),
    ]);
    await page.waitForSelector('.tabs', { timeout: 10000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SCREEN_DIR, 'admin.png'), fullPage: true });
    ok('screenshot admin.png');
    await page.screenshot({ path: path.join(SCREEN_DIR, 'layout-admin.png'), fullPage: true });
    ok('screenshot layout-admin.png');
    await page.click('.tab[data-tab="goose"]');
    await page.waitForSelector('#gooseGameRoot, #tabBody .panel', { timeout: 10000 });
    await page.waitForTimeout(500);
    ok('admin goose tab opens');
    await ctx.close();
  }

  // Seed announcement for screenshots (fake data)
  let shotAnnId = null;
  {
    const r = await api(adminJar, 'POST', '/api/admin/announcements', {
      title: '欢迎加入卡牌俱乐部',
      body: '本周活动：周五晚 20:00 对决。请遵守匿名聊天规则，勿泄露联系方式。',
      pinned: true,
    });
    if (r.status === 200 && r.data.announcement?.id) {
      shotAnnId = r.data.announcement.id;
      ok('seed announcement for screenshots');
    } else fail('seed announcement for screenshots', JSON.stringify(r));
  }

  // Member view
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[name="username"]', m1user);
    await page.fill('input[name="password"]', 'testpass1');
    await Promise.all([
      page.waitForFunction(() => location.pathname === '/member' || document.querySelector('#myCard')),
      page.click('button[type="submit"]'),
    ]);
    await page.waitForSelector('#myCard', { timeout: 10000 });
    await page.waitForSelector('.mp-tabbar, .mp-side', { timeout: 10000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SCREEN_DIR, 'member.png'), fullPage: true });
    ok('screenshot member.png');
    await page.screenshot({ path: path.join(SCREEN_DIR, 'layout-member.png'), fullPage: true });
    ok('screenshot layout-member.png');
    await page.waitForSelector('#announcePanel .ann-item, #announcePanel .mp-empty', { timeout: 10000 });
    await page.locator('#announcePanel').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREEN_DIR, 'announcements.png'), fullPage: true });
    ok('screenshot announcements.png');
    // 我的 tab → achievements
    await page.locator('[data-mtab="me"]').first().click();
    await page.waitForSelector('#achievementsPanel .ach-card', { timeout: 10000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREEN_DIR, 'achievements.png'), fullPage: true });
    ok('screenshot achievements.png');
    // 游戏 tab → jump + goose
    await page.locator('[data-mtab="games"]').first().click();
    await page.waitForSelector('#jumpPanel', { timeout: 10000 });
    await page.evaluate(async () => {
      await fetch('/api/jump/score', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: 12, hops: 10, durationMs: 12000 }),
      });
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREEN_DIR, 'jump-game.png'), fullPage: true });
    ok('screenshot jump-game.png');
    await page.locator('#jumpBoard').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREEN_DIR, 'jump-leaderboard.png'), fullPage: true });
    ok('screenshot jump-leaderboard.png');
    await page.locator('.mp-game-tab[data-game="goose"]').click();
    await page.waitForSelector('#gooseGameRoot .gg-board', { timeout: 10000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREEN_DIR, 'goose-game.png'), fullPage: true });
    ok('screenshot goose-game.png');
    await page.evaluate(() => {
      const over = document.querySelector('#ggOver');
      if (!over) return;
      over.classList.remove('hidden');
      const t = document.querySelector('#ggOverTitle');
      const s = document.querySelector('#ggOverSub');
      if (t) t.textContent = '🦢 通关成功！';
      if (s) s.textContent = '用时 0:42 · 消除 36 · 36 步';
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREEN_DIR, 'goose-win.png'), fullPage: true });
    ok('screenshot goose-win.png');
    // chat tab exists
    await page.locator('[data-mtab="chat"]').first().click();
    await page.waitForSelector('#chatPanel', { timeout: 10000 });
    ok('member chat tab opens');
    await ctx.close();
  }

  // Admin announcements tab
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[name="username"]', creds.user);
    await page.fill('input[name="password"]', creds.pass);
    await Promise.all([
      page.waitForFunction(() => location.pathname === '/admin' || document.querySelector('.tabs')),
      page.click('button[type="submit"]'),
    ]);
    await page.waitForSelector('.tabs', { timeout: 10000 });
    await page.click('.tab[data-tab="announcements"]');
    await page.waitForSelector('#annForm', { timeout: 10000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREEN_DIR, 'announcements-admin.png'), fullPage: true });
    ok('screenshot announcements-admin.png');
    await ctx.close();
  }

  // Cleanup seeded announcement + e2e members so live/local aren't polluted when pointed at Render
  if (shotAnnId) await api(adminJar, 'DELETE', `/api/admin/announcements/${shotAnnId}`);
  if (m1Id) await api(adminJar, 'DELETE', `/api/admin/members/${m1Id}`);
  if (m2Id) await api(adminJar, 'DELETE', `/api/admin/members/${m2Id}`);

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log('\n==== SUMMARY ====');
  console.log(`passed: ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    failed.forEach((f) => console.log('FAIL:', f.name, f.err));
    process.exit(1);
  }
  console.log('All tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
