// Video shrinking check (no network, no relay): runs the app's shrinkVideo() in headless Chrome on local test clips,
// saves the output for ffprobe. Run: node tests/shrink.cjs clip1.mp4 [clip2.mp4 ...]  (outputs -> OUT/<name>.shrunk.mp4)
let pw; try { pw = require('playwright-core'); } catch (_) { pw = require('/tmp/pw/node_modules/playwright-core'); }
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), OUT = process.env.SHOTS_DIR || '/tmp/botweb-shrink'; fs.mkdirSync(OUT, { recursive: true });
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', webmanifest: 'application/manifest+json', png: 'image/png' };
(async () => {
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  let saved = null;
  await ctx.route('https://botweb-relay.vercel.app/**', r => r.fulfill({ status: 401, body: '{}' }));
  await ctx.route('https://bradfuturez.github.io/botweb/**', route => {
    const req = route.request(), p = new URL(req.url()).pathname.replace(/^\/botweb\/?/, '') || 'index.html';
    if (p === '__save') { saved = req.postDataBuffer(); return route.fulfill({ status: 200, body: 'ok' }); }
    const f = path.join(ROOT, p);
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return route.fulfill({ status: 404, body: 'nf' });
    route.fulfill({ status: 200, contentType: TYPES[p.split('.').pop()] || 'application/octet-stream', body: fs.readFileSync(f) });
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (/warn|error/.test(m.type())) console.log('  console:', m.text().slice(0, 300)); });
  await page.goto('https://bradfuturez.github.io/botweb/');
  for (const clip of process.argv.slice(2)) {
    await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'tf'; document.body.appendChild(i); });
    await page.setInputFiles('#tf', clip);
    const r = await page.evaluate(async () => {
      const f = document.getElementById('tf').files[0], t0 = performance.now(), pcts = [];
      const out = await shrinkVideo(f, p => pcts.push(p));
      const res = { inSize: f.size, ms: Math.round(performance.now() - t0), progressCalls: pcts.length, ok: !!out };
      if (out) { Object.assign(res, { outSize: out.blob.size, w: out.w, h: out.h, opfs: !!out._opfs }); await fetch('/botweb/__save', { method: 'POST', body: out.blob }); await dropTemp([out]); }
      document.getElementById('tf').remove(); return res;
    });
    console.log(path.basename(clip), JSON.stringify(r));
    if (saved && r.ok) { fs.writeFileSync(path.join(OUT, path.basename(clip, '.mp4') + '.shrunk.mp4'), saved); saved = null; }
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
