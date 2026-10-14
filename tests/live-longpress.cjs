// LIVE check: long-press a bot avatar -> @mention in the composer. Posts nothing.
let pw; try { pw = require('playwright-core'); } catch (_) { pw = require('/tmp/pw/node_modules/playwright-core'); }
const fs = require('fs'), os = require('os');
(async () => {
  const browser = await pw.chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/New_York' });
  let posts = 0; ctx.on('request', r => { if (/messages\/post|participants\/save/.test(r.url())) posts++; });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('https://bradfuturez.github.io/botweb/?lp=' + Date.now());
  await page.waitForSelector('#passSheet:not([hidden])');
  await page.fill('#passInput', fs.readFileSync(os.homedir() + '/.botweb/passcode', 'utf8').trim());
  await page.click('#passSheet button[type=submit]');
  await page.waitForSelector('.msg [data-mention]', { timeout: 20000 }); await page.waitForTimeout(1500);
  const cdp = await ctx.newCDPSession(page);
  const press = async (sel, ms, dy = 0) => { const el = page.locator(sel).last(); await el.scrollIntoViewIfNeeded(); const b = await el.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    if (dy) { await page.waitForTimeout(80); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + dy }] }); }
    await page.waitForTimeout(ms); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(250); };
  const val = () => page.inputValue('#input');
  await page.fill('#input', '');
  await press('.msg [data-mention]', 150); const tap = await val();
  await press('.msg [data-mention]', 600, 40); const scrolled = await val();
  const name = await page.locator('.msg [data-mention]').last().getAttribute('data-mention');
  await press('.msg [data-mention]', 600); const afterMsg = await val(); const focusMsg = await page.evaluate(() => document.activeElement.id);
  const toastTxt = await page.textContent('#toast');
  const css = await page.locator('.msg [data-mention]').last().evaluate(e => { const s = getComputedStyle(e); return { callout: s.webkitTouchCallout, us: s.userSelect }; });
  await page.screenshot({ path: '/workspace/deliverables/botweb/longpress-mention.png' });
  await page.click('#asBtn'); await page.waitForSelector('#asSheet:not([hidden])'); await page.waitForTimeout(300);
  await press('#asList [data-mention="Gemini"]', 600); const afterList = await val();
  const sheetClosed = await page.isHidden('#asSheet'), postAs = await page.evaluate(() => localStorage.getItem('bw.postAs'));
  const focused = await page.evaluate(() => document.activeElement.id);
  console.log(JSON.stringify({ name, tap, scrolled, afterMsg, toastTxt, focusMsg, css, afterList, sheetClosed, postAs, focused, writes: posts, errs }));
  await page.fill('#input', ''); await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
