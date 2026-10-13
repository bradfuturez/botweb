// LIVE end-to-end check of photo/video uploads: the local app files are served as https://bradfuturez.github.io/botweb/
// (so the relay's CORS sees the real origin), and talk to the REAL relay and the REAL private Blob store.
// It posts ONE test message; the ids/urls are written to OUT/live-media.json so they can be deleted afterwards.
// Run: node tests/live-media.cjs <image> <video>    (passcode from ~/.botweb/passcode, never printed)
let pw; try { pw = require('playwright-core'); } catch (_) { pw = require('/tmp/pw/node_modules/playwright-core'); }
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..'), OUT = process.env.SHOTS_DIR || '/workspace/botweb-shots/live'; fs.mkdirSync(OUT, { recursive: true });
const PASS = fs.readFileSync(path.join(os.homedir(), '.botweb/passcode'), 'utf8').trim();
const [IMG, VID] = process.argv.slice(2);
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL: ' + m); } else console.log('ok  - ' + m); };
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', webmanifest: 'application/manifest+json', png: 'image/png', svg: 'image/svg+xml' };
(async () => {
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx.route('https://bradfuturez.github.io/botweb/**', route => {
    const p = new URL(route.request().url()).pathname.replace(/^\/botweb\/?/, '') || 'index.html', f = path.join(ROOT, p);
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return route.fulfill({ status: 404, body: 'nf' });
    route.fulfill({ status: 200, contentType: TYPES[p.split('.').pop()] || 'application/octet-stream', body: fs.readFileSync(f) });
  });
  await ctx.addInitScript(p => { localStorage.setItem('bw.passcode', JSON.stringify(p)); }, PASS);
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('  console:', m.text().slice(0, 200)); });
  await page.goto('https://bradfuturez.github.io/botweb/');
  await page.waitForSelector('.msg', { timeout: 20000 }).catch(() => {});
  await page.setInputFiles('#fileInput', [IMG, VID]);
  ok(await page.locator('.tray-item').count() === 2, 'preview tray shows 2 picked files');
  ok(await page.locator('#origRow:not([hidden])').count() === 1, 'Original quality toggle shown for videos');
  await page.screenshot({ path: OUT + '/1-preview.png' });
  await page.fill('#input', '[test] media upload check, will be deleted');
  await page.click('#sendBtn');
  let sawBar = false;
  for (let i = 0; i < 100 && !sawBar; i++) { sawBar = await page.locator('#upBar:not([hidden])').count() > 0; if (!sawBar) await page.waitForTimeout(50); }
  ok(sawBar, 'progress bar shown while uploading');
  if (process.env.EXPECT_SHRINK) {
    let st = ''; for (let i = 0; i < 300 && !/Shrinking video/.test(st); i++) { st = await page.locator('#upText').textContent().catch(() => ''); if (!/Shrinking/.test(st)) await page.waitForTimeout(100); }
    ok(/Shrinking video… \d+%/.test(st), 'shrinking stage shown: ' + st); await page.screenshot({ path: OUT + '/2b-shrinking.png' });
    let up = ''; for (let i = 0; i < 1200 && !/→/.test(up); i++) { up = await page.locator('#upText').textContent().catch(() => ''); if (!/→/.test(up)) await page.waitForTimeout(100); }
    ok(/→/.test(up), 'before/after size shown: ' + up);
  }
  if (sawBar) await page.screenshot({ path: OUT + '/2-progress.png' });
  const msg = page.locator('.msg:not(.pending)', { hasText: '[test] media upload check' }).last();
  await msg.waitFor({ timeout: 900000 });
  await page.waitForFunction(() => { const m = [...document.querySelectorAll('.msg:not(.pending)')].pop(); const i = m && m.querySelector('img[src]'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 30000 });
  const info = await msg.evaluate(el => { const i = el.querySelector('img'), v = el.querySelector('video'); return { id: el.dataset.id, iw: i.naturalWidth, ih: i.naturalHeight, isrc: i.src, vsrc: v && v.src, pi: v && v.hasAttribute('playsinline'), ctl: v && v.controls }; });
  ok(info.iw > 0 && info.iw <= 2048, `photo renders inline, resized to ${info.iw}x${info.ih}`);
  ok(/\.private\.blob\.vercel-storage\.com\/media\//.test(info.isrc) && /vercel-blob-delegation=/.test(info.isrc), 'photo is served from the PRIVATE store with a signed link');
  ok(info.vsrc && info.pi && info.ctl, 'video element has src, controls, playsinline');
  const played = await msg.evaluate(el => new Promise(res => { const v = el.querySelector('video'); v.muted = true; const t = setTimeout(() => res({ t: v.currentTime, err: v.error && v.error.code }), 15000); v.ontimeupdate = () => { if (v.currentTime > 0.3) { clearTimeout(t); res({ t: v.currentTime, w: v.videoWidth }); } }; v.play().catch(e => res({ err: String(e) })); }));
  ok(played.t > 0.3, 'video plays inline (' + JSON.stringify(played) + ')');
  await page.screenshot({ path: OUT + '/3-in-chat.png' });
  await msg.locator('button.media').click();
  await page.waitForSelector('#viewer:not([hidden]) img[src]');
  ok(true, 'tapping the photo opens it full-screen'); await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '/4-viewer.png' });
  await page.click('#viewer'); ok(await page.locator('#viewer[hidden]').count() === 1, 'tap closes the viewer');
  // the stored message (raw blob urls) for cleanup
  const stored = await page.evaluate(id => JSON.parse(localStorage.getItem('bw.cache')).find(m => m.id === id), info.id);
  fs.writeFileSync(OUT + '/live-media.json', JSON.stringify(stored, null, 1));
  console.log('  message', stored.id, (stored.attachments || []).map(a => a.mime + ' ' + a.size + 'B ' + (a.w || '') + 'x' + (a.h || '')).join(', '));
  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
