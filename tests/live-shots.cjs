// Screenshots of the LIVE app (read-only: types the passcode from ~/.botweb/passcode into the prompt, posts nothing).
// Run: node tests/live-shots.cjs  -> /workspace/botweb-shots/live-chat.png, live-postas.png
let pw; try { pw = require('playwright-core'); } catch (_) { pw = require('/tmp/pw/node_modules/playwright-core'); }
const fs = require('fs'), os = require('os');
const OUT = process.env.SHOTS_DIR || '/workspace/botweb-shots';
(async () => {
  const browser = await pw.chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/New_York',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S938U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' });
  let posts = 0; ctx.on('request', r => { if (/messages\/post|participants\/save/.test(r.url())) posts++; });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('https://bradfuturez.github.io/botweb/?shot=' + Date.now());
  await page.waitForSelector('#passSheet:not([hidden])');
  await page.screenshot({ path: OUT + '/live-passcode.png' });
  await page.fill('#passInput', fs.readFileSync(os.homedir() + '/.botweb/passcode', 'utf8').trim());
  await page.click('#passSheet button[type=submit]');
  await page.waitForSelector('.msg', { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT + '/live-chat.png' });
  await page.click('#asBtn'); await page.waitForSelector('#asSheet:not([hidden])'); await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + '/live-postas.png' });
  const manifestOk = await page.evaluate(async () => { const m = await (await fetch('manifest.webmanifest')).json(); return m.display === 'standalone' && m.icons.length === 3; });
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!r; });
  console.log(JSON.stringify({ messages: await page.$$eval('.msg', n => n.length), welcome: await page.$$eval('.msg .text', n => n.map(x => x.textContent)), manifestOk, sw, writes: posts, errors: errs }));
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
