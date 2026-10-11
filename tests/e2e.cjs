// BotWeb phone UI test with a MOCKED relay and DUMMY data only (no real chat, no secrets).
// Run: node tests/e2e.cjs   (screenshots -> SHOTS_DIR, default /workspace/botweb-shots/test)
let pw; try { pw = require('playwright-core'); } catch (_) { pw = require('/tmp/pw/node_modules/playwright-core'); }
const fs = require('fs'), path = require('path'), http = require('http');
const PORT = 8813, BASE = `http://127.0.0.1:${PORT}/botweb/`, ROOT = path.join(__dirname, '..');
const OUT = process.env.SHOTS_DIR || '/workspace/botweb-shots/test'; fs.mkdirSync(OUT, { recursive: true });
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL: ' + m); } else console.log('ok  - ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', webmanifest: 'application/manifest+json', png: 'image/png', svg: 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, BASE).pathname).replace(/^\/botweb\/?/, '') || 'index.html', f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': TYPES[p.split('.').pop()] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
const PASS = 'dummy-pass';
let people = null, messages = [
  { id: 'm_test000001', from: 'Dummy Bot One', text: 'Test message from a dummy bot. https://example.com', ts: new Date(Date.now() - 3600e3).toISOString() },
  { id: 'm_test000002', from: 'Brad', text: 'Dummy reply from Brad', ts: new Date(Date.now() - 1800e3).toISOString(), replyTo: 'm_test000001' },
];
const posts = [];
(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/Los_Angeles' });
  let online = true;
  await ctx.route('https://botweb-relay.vercel.app/api/**', async route => {
    const req = route.request(), op = new URL(req.url()).pathname.replace('/api/', '');
    if (!online) return route.abort('internetdisconnected');
    const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': 'content-type, x-passcode' } });
    if (req.headers()['x-passcode'] !== PASS) return route.fulfill({ status: 401, headers: cors, body: '{"error":"passcode"}' });
    const b = JSON.parse(req.postData() || '{}');
    let out;
    if (op === 'messages/list') out = { ok: true, messages: b.since ? messages.filter(m => m.ts >= b.since) : messages };
    else if (op === 'messages/post') { const m = { id: 'm_test' + String(100 + posts.length).padStart(6, '0'), from: b.from, text: b.text, ts: new Date().toISOString(), ...(b.replyTo ? { replyTo: b.replyTo } : {}) }; posts.push(m); messages.push(m); out = { ok: true, message: m }; }
    else if (op === 'participants/get') out = { ok: true, participants: people || [
      { id: 'brad', name: 'Brad', kind: 'human', color: '#4F9DFF', initial: 'B' }, { id: 'd1', name: 'Dummy Bot One', kind: 'bot', color: '#F5A623', initial: 'D' },
      { id: 'muse', name: 'Brainy Muse', kind: 'paste', color: '#FFD84D', initial: 'M' }] };
    else if (op === 'participants/save') { people = b.participants; out = { ok: true, participants: people }; }
    else return route.fulfill({ status: 404, headers: cors, body: '{}' });
    route.fulfill({ status: 200, headers: cors, body: JSON.stringify(out) });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => { fails++; console.error('PAGE ERROR', e.message); });
  await page.goto(BASE);
  ok(await page.isVisible('#passSheet'), 'passcode prompt on first use');
  await page.fill('#passInput', 'wrong'); await page.click('#passSheet button[type=submit]');
  await page.waitForSelector('#passMsg.bad'); ok(true, 'wrong passcode shows an error');
  await page.fill('#passInput', PASS); await page.click('#passSheet button[type=submit]');
  await page.waitForSelector('.msg[data-id="m_test000002"]');
  ok(await page.isHidden('#passSheet'), 'right passcode opens the chat');
  ok(await page.evaluate(() => localStorage.getItem('bw.passcode')) === JSON.stringify(PASS), 'passcode remembered');
  await sleep(400);
  ok((await page.textContent('.msg[data-id="m_test000001"] .who')).includes('Dummy Bot One'), 'sender name shown');
  ok(await page.$eval('.msg[data-id="m_test000001"] .av', e => e.textContent === 'D' && getComputedStyle(e).backgroundColor === 'rgb(245, 166, 35)'), 'colored initial avatar');
  ok((await page.textContent('.msg[data-id="m_test000002"] .quote')).includes('Test message from a dummy bot'), 'reply-to quote');
  ok(await page.$eval('.msg[data-id="m_test000002"]', e => e.classList.contains('me')), "Brad's message on the right");
  const t = await page.textContent('.msg[data-id="m_test000001"] time');
  const nyT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(messages[0].ts));
  ok(t === nyT, `time shown in New York time (${t}) even with a Los Angeles phone clock`);
  ok(await page.$eval('.msg[data-id="m_test000001"] .text a', a => a.href === 'https://example.com/'), 'links are clickable');
  // reply + send as Brad
  await page.click('.msg[data-id="m_test000001"] [data-reply]');
  ok(await page.isVisible('#replyBar'), 'reply bar shows');
  await page.fill('#input', 'Dummy test send'); await page.click('#sendBtn');
  await page.waitForFunction(() => document.querySelector('.msg[data-id="m_test000100"]'));
  ok(posts[0] && posts[0].from === 'Brad' && posts[0].replyTo === 'm_test000001', 'sent as Brad with replyTo');
  ok(await page.isHidden('#replyBar'), 'reply bar cleared after send');
  // post as Brainy Muse
  await page.click('#asBtn'); await page.waitForSelector('#asSheet:not([hidden])');
  ok((await page.$$('.as-row')).length === 3, 'post-as picker lists participants');
  await sleep(300); await page.screenshot({ path: path.join(OUT, 'test-postas.png') });
  await page.click('.as-row[data-as="Brainy Muse"]');
  ok(await page.isVisible('#asBanner') && (await page.textContent('#asBannerName')) === 'Brainy Muse', 'posting-as banner');
  await page.fill('#input', 'Dummy pasted Muse reply'); await page.press('#input', 'Control+Enter');
  await page.waitForFunction(() => document.querySelector('.msg[data-id="m_test000101"]'));
  ok(posts[1].from === 'Brainy Muse', 'pasted reply posted as Brainy Muse');
  await page.click('#asBack'); ok(await page.isHidden('#asBanner'), 'switch back to Brad');
  // polling picks up a bot message
  messages.push({ id: 'm_test000003', from: 'Dummy Bot One', text: 'New dummy bot message arrives by polling', ts: new Date().toISOString() });
  await page.waitForSelector('.msg[data-id="m_test000003"]', { timeout: 9000 }); ok(true, 'new messages arrive by polling');
  await page.screenshot({ path: path.join(OUT, 'test-chat.png') });
  // offline: draft + outbox survive a reload
  online = false; await ctx.setOffline(true);
  await page.fill('#input', 'Dummy offline message'); await page.click('#sendBtn'); await sleep(500);
  ok(await page.$('.msg.failed, .msg.pending'), 'offline message waits in the outbox');
  await page.fill('#input', 'half-typed draft');
  await ctx.setOffline(false); online = true;
  await page.reload(); await page.waitForSelector('.msg[data-id="m_test000003"]');
  ok((await page.inputValue('#input')) === 'half-typed draft', 'draft kept after reload');
  await page.waitForFunction(() => !document.querySelector('.msg.pending'), null, { timeout: 9000 });
  ok(posts.some(p => p.text === 'Dummy offline message'), 'outbox sent when back online');
  // participants editor
  await page.click('#settingsBtn'); await page.waitForSelector('#setSheet:not([hidden])');
  ok(await page.$eval('#setSheet .disabled', s => s.textContent.includes('Connect an AI with an API key') && [...s.querySelectorAll('input,button')].every(x => x.disabled)), 'API key section is there and disabled');
  await page.click('#addPerson'); const nm = await page.$$('#peopleEd input.nm'); await nm[nm.length - 1].fill('Dummy Paster');
  await page.screenshot({ path: path.join(OUT, 'test-settings.png') });
  await page.click('#savePeople'); await sleep(400);
  ok(people && people.some(p => p.name === 'Dummy Paster' && p.initial === 'D'), 'participants saved through the relay');
  ok(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8').includes('"display": "standalone"'), 'installable manifest');
  await browser.close(); server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
