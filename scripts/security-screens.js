/**
 * Browser check: XSS payloads render as inert text, no CSP violations; screenshots of security pages.
 * Usage: BASE_URL=... ADMIN_USERNAME=... ADMIN_PASSWORD=... node scripts/security-screens.js
 * Creates a throwaway member (with an XSS display name + suggestion) and deletes it at the end.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
const AU = process.env.ADMIN_USERNAME, AP = process.env.ADMIN_PASSWORD;
const OUT = path.join(__dirname, '..', 'screens');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (n, c, x = '') => { results.push(!!c); console.log(c ? '✓' : '✗', n, c ? '' : x); };

async function api(jar, method, p, body) {
  const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };
  if (jar.cookie) headers.Cookie = jar.cookie;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('card.sid=')) jar.cookie = c.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

(async () => {
  const admin = {}, mem = {};
  const sfx = Math.random().toString(36).slice(2, 6);
  const uname = 'xss_' + sfx, pw = 'Xss-pass-' + sfx + '1';
  await api(admin, 'POST', '/api/login', { username: AU, password: AP });
  const inv = await api(admin, 'POST', '/api/admin/invites', { count: 1, expiresInDays: 3, note: '截图演示' });
  const code = inv.data.codes[0];
  await api(admin, 'POST', '/api/admin/invites', { count: 1, expiresInDays: 0.00001, note: '已过期示例' });
  const reg = await api(mem, 'POST', '/api/register', { username: uname, password: pw, inviteCode: code, displayName: '<img src onerror=f>' });
  const id = reg.data.user.id;
  await api(admin, 'PUT', `/api/admin/members/${id}/card`, { rank: 'A', suit: 'spade' });
  await api(mem, 'POST', '/api/my/suggestions', { type: 'suggestion', content: '<script>window.__xss=2</script><img src=x onerror="window.__xss=3"> XSS 测试' });
  await api({}, 'POST', '/api/login', { username: '<svg onload="window.__xss=4">', password: 'nope-nope' });
  // enable 2FA on the TEST member only (to screenshot the 2FA login step)
  const setup = await api(mem, 'POST', '/api/me/2fa/setup', {});
  await api(mem, 'POST', '/api/me/2fa/enable', { code: authenticator.generate(setup.data.secret) });

  const browser = await chromium.launch();
  const issues = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('dialog', (d) => { issues.push('dialog:' + d.message()); d.dismiss(); });
  page.on('console', (m) => { if (m.type() === 'error') issues.push('console:' + m.text()); });
  page.on('pageerror', (e) => issues.push('pageerror:' + e.message));

  // member 2FA login step
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.fill('input[name=username]', uname);
  await page.fill('input[name=password]', pw);
  await page.click('button[type=submit]');
  await page.waitForSelector('#totpWrap:not(.hidden)', { timeout: 10000 });
  check('login form reveals 2FA code field', true);
  await page.screenshot({ path: path.join(OUT, 'security-login-2fa.png') });
  await ctx.clearCookies();

  // admin
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.fill('input[name=username]', AU);
  await page.fill('input[name=password]', AP);
  await page.click('button[type=submit]');
  await page.waitForURL('**/admin', { timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, 'security-members.png') });
  check('members tab: XSS display name shown as text', (await page.content()).includes('&lt;img src onerror=f&gt;'));

  // --- admin renames the test member inline; member's open page updates live ---
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mpage = await mctx.newPage();
  mpage.on('pageerror', (e) => issues.push('member pageerror:' + e.message));
  // member has 2FA on: log in via API in the browser context is simpler -> disable 2FA first via admin reset
  await api(admin, 'POST', `/api/admin/members/${id}/reset-2fa`, {});
  await mpage.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await mpage.fill('input[name=username]', uname);
  await mpage.fill('input[name=password]', pw);
  await mpage.click('button[type=submit]');
  await mpage.waitForURL('**/member', { timeout: 15000 });
  await mpage.waitForSelector('.live-dot:not(.off)', { timeout: 10000 }).catch(() => {});
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(1000);
  const row = page.locator('tr', { hasText: '@' + uname });
  await row.locator('.edit-name').click();
  await row.locator('.name-input').fill('张三 · 新名字');
  await page.waitForTimeout(300);
  await row.screenshot({ path: path.join(OUT, 'rename-row.png') }).catch(() => {});
  await row.scrollIntoViewIfNeeded();
  await page.locator('.panel').first().screenshot({ path: path.join(OUT, 'rename.png') });
  await row.locator('.name-edit button[type=submit]').click();
  await page.waitForFunction((u) => [...document.querySelectorAll('tr')].some((tr) => tr.textContent.includes('@' + u) && tr.querySelector('.mem-name')?.textContent === '张三 · 新名字'), uname, { timeout: 10000 }).then(() => check('admin inline rename saved', true), () => check('admin inline rename saved', false));
  await mpage.waitForFunction(() => document.querySelector('.who-name')?.textContent === '张三 · 新名字', null, { timeout: 10000 })
    .then(() => check('member page header updated live via WebSocket', true), () => check('member page header updated live via WebSocket', false));
  await mpage.screenshot({ path: path.join(OUT, 'rename-member-view.png') });
  await mctx.close();
  // inline validation: blank name is refused client-side
  await row.locator('.edit-name').click();
  await row.locator('.name-input').fill('   ');
  await row.locator('.name-edit button[type=submit]').click();
  await page.waitForTimeout(500);
  check('blank name refused, still in edit mode', await row.locator('.name-edit').isVisible());
  await row.locator('.name-cancel').click();
  await page.click('.tab[data-tab=suggestions]'); await page.waitForTimeout(800);
  check('suggestions tab: XSS shown as text', (await page.textContent('body')).includes('<script>window.__xss=2</script>'));
  await page.click('.tab[data-tab=invites]'); await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'security-invites.png') });
  await page.click('.tab[data-tab=security]'); await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, 'security-center.png'), fullPage: true });
  check('security center lists audit log', (await page.textContent('body')).includes('登录日志'));
  check('no injected <img src=x>/<svg onload> elements', (await page.$$('img[src="x"], svg[onload], img[onerror], .mem-name *')).length === 0);
  check('no XSS executed', !(await page.evaluate(() => window.__xss)));
  await page.click('#settingsBtn'); await page.waitForURL('**/settings'); await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'security-settings.png'), fullPage: true });
  check('settings page renders', (await page.textContent('body')).includes('两步验证'));
  // mobile view of security center
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await ctx.storageState() });
  const mp = await m.newPage();
  await mp.goto(BASE + '/admin', { waitUntil: 'networkidle' });
  await mp.click('.tab[data-tab=security]'); await mp.waitForTimeout(1200);
  await mp.screenshot({ path: path.join(OUT, 'security-center-mobile.png') });
  const relevant = issues.filter((i) => !/favicon|status of 401/.test(i));
  check('no dialogs / CSP violations / JS errors', relevant.length === 0, relevant.join(' | '));
  await browser.close();

  // cleanup
  await api(admin, 'DELETE', `/api/admin/members/${id}`);
  const all = (await api(admin, 'GET', '/api/admin/invites')).data.invites || [];
  for (const i of all) if (i.note === '截图演示' || i.note === '已过期示例') await api(admin, 'DELETE', `/api/admin/invites/${i.id}`);
  console.log(`\npassed ${results.filter(Boolean).length}/${results.length}`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
