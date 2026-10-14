// Serve the LOCAL build at the real Pages URL (so relay CORS works), check @Brad highlight + push subscribe endpoint.
let pw; try { pw = require('playwright-core'); } catch (_) { pw = require('/tmp/pw/node_modules/playwright-core'); }
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..'), BASE = 'https://bradfuturez.github.io/botweb/';
const MIME = { js: 'text/javascript', css: 'text/css', html: 'text/html', webmanifest: 'application/manifest+json', png: 'image/png', svg: 'image/svg+xml' };
const inject = process.argv[2] !== 'live';
(async () => {
  const browser = await pw.chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/New_York', serviceWorkers: 'block' });
  await ctx.route(BASE + '**', r => { let p = new URL(r.request().url()).pathname.replace('/botweb/', '') || 'index.html';
    const f = path.join(ROOT, p); if (!fs.existsSync(f)) return r.fulfill({ status: 404 });
    r.fulfill({ body: fs.readFileSync(f), contentType: MIME[p.split('.').pop()] || 'application/octet-stream' }); });
  const fake = { id: 'm_fakeping_test01', from: 'CreateAWar Game Developer', text: '@Brad can you check the new build? (local test, not posted)', ts: new Date().toISOString() };
  if (inject) await ctx.route('**/api/messages/list', async r => { const res = await r.fetch(); const j = await res.json(); j.messages.push(fake); r.fulfill({ response: res, json: j }); });
  let posts = 0; ctx.on('request', r => { if (/messages\/post/.test(r.url())) posts++; });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.addInitScript(() => localStorage.setItem('bw.mentionSeen', JSON.stringify('2000-01-01T00:00:00Z')));
  await page.goto(BASE);
  await page.fill('#passInput', fs.readFileSync(os.homedir() + '/.botweb/passcode', 'utf8').trim());
  await page.click('#passSheet button[type=submit]');
  await page.waitForSelector('.msg.mention', { timeout: 20000 }); await page.waitForTimeout(1200);
  const res = await page.evaluate(() => { const els = [...document.querySelectorAll('.msg.mention')]; const el = els.pop(); const b = el.querySelector('.bubble'), s = getComputedStyle(b);
    return { count: els.length + 1, lastText: el.querySelector('.text').textContent, borderLeft: s.borderLeftWidth + ' ' + s.borderLeftColor, bg: s.backgroundImage.slice(0, 40), badge: !!el.querySelector('.at-badge'),
      pill: !document.querySelector('#mentionPill').hidden ? document.querySelector('#mentionCount').textContent : 'hidden', bradMentionable: !!document.querySelector('[data-mention="Brad"]') || 'n/a-in-list' }; });
  // Brad avatar long-press from Post-as sheet
  await page.fill('#input', ''); await page.click('#asBtn'); await page.waitForTimeout(300);
  const cdp = await ctx.newCDPSession(page); const b = await page.locator('#asList [data-mention="Brad"]').boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + 10, y: b.y + 10 }] }); await page.waitForTimeout(600);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(300);
  res.bradLongPress = await page.inputValue('#input'); await page.fill('#input', '');
  // unread counter: a new ping arrives while scrolled up
  await page.evaluate(() => { document.querySelector('#list').scrollTop = 0; });
  await page.waitForTimeout(400);
  await page.evaluate(() => { merge([{ id: 'm_fakeping_test02', from: 'Gemini', text: 'hey @brad future, look', ts: new Date().toISOString() }]); render(); });
  await page.waitForTimeout(400);
  res.pillWhileScrolledUp = (await page.isVisible('#mentionPill')) ? await page.textContent('#mentionCount') : 'hidden';
  // jump pill
  await page.evaluate(() => document.querySelector('#list').scrollTop = 0); await page.waitForTimeout(300);
  if (await page.isVisible('#mentionPill')) { await page.click('#mentionPill'); await page.waitForTimeout(1500); }
  res.pillAfterJump = await page.isVisible('#mentionPill');
  // subscribe endpoint: real browser subscription if possible, else a synthetic one; then remove it again
  res.subscribe = await page.evaluate(async () => {
    const P = JSON.parse(localStorage.getItem('bw.passcode')), R = 'https://botweb-relay.vercel.app/api/';
    const call = (p, b, pc = P) => fetch(R + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-passcode': pc }, body: JSON.stringify(b) }).then(async r => ({ s: r.status, j: await r.json() }));
    const sub = { endpoint: 'https://example.invalid/botweb-selftest-' + Date.now(), keys: { p256dh: 'BPkItNLdfcGE1iz56CmZTV_bsRWzhubtTzD6QQ0f1dkmA8PycGi5jSia8KNcUMvq4TAwX_pcSTcBidJn5w2gcVM', auth: 'AAAAAAAAAAAAAAAAAAAAAA' } };
    const bad = await call('push/subscribe', { subscription: sub }, 'wrong');
    const key = await call('push/key', {}); const add = await call('push/subscribe', { subscription: sub, ua: 'selftest' });
    const st = await call('push/status', { endpoint: sub.endpoint }); const del = await call('push/unsubscribe', { endpoint: sub.endpoint });
    const st2 = await call('push/status', { endpoint: sub.endpoint });
    return { wrongPass: bad.s, key: key.s, add: add.s + ' ' + JSON.stringify(add.j), statusAfterAdd: st.j.subscribed, remove: del.s, statusAfterRemove: st2.j.subscribed };
  });
  await page.click('#settingsBtn'); await page.waitForTimeout(300);
  res.toggle = { label: await page.textContent('label.toggle'), hint: await page.textContent('#pushHint') };
  await page.click('#setSheet [data-close]'); await page.waitForTimeout(300);
  const el = page.locator('.msg.mention').last(); await el.scrollIntoViewIfNeeded(); await page.evaluate(() => { const l = document.querySelector('#list'); l.scrollTop += 0; });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: process.argv[3] || '/tmp/mention-local.png' });
  console.log(JSON.stringify({ ...res, posts, errs }, null, 1)); await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
