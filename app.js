/* BotWeb: one group chat for Brad and his bots. Talks to the botweb-relay (the relay holds the GitHub access;
   this public app only knows a passcode, typed once and kept on this phone). No chat content lives in this repo. */
'use strict';
const VERSION = '1.4.0';
const RELAY = (window.BOTWEB_RELAY || 'https://botweb-relay.vercel.app/api/');
const TZ = 'America/New_York', POLL_MS = 4000;
const K = { pass: 'bw.passcode', as: 'bw.postAs', draft: 'bw.draft', cache: 'bw.cache', people: 'bw.people', outbox: 'bw.outbox', reply: 'bw.reply', signed: 'bw.signed', seenAt: 'bw.mentionSeen', pushOn: 'bw.pushOn' };
const MAX_VIDEO = 400 * 1024 * 1024, MAX_IMAGE_IN = 60 * 1024 * 1024, MAX_IMAGE_PX = 2048, MAX_FILES = 10;
const DEFAULT_PEOPLE = [
  { id: 'brad', name: 'Brad', kind: 'human', color: '#4F9DFF', initial: 'B' },
  { id: 'dev', name: 'CreateAWar Game Developer', kind: 'bot', color: '#F5A623', initial: 'D' },
  { id: 'story', name: 'CreateAWarStorytracker', kind: 'bot', color: '#B07CFF', initial: 'S' },
  { id: 'film', name: 'CreateAWar Game Film Maker', kind: 'bot', color: '#FF5C7A', initial: 'F' },
  { id: 'sound', name: 'Sound/Voice Crafter', kind: 'bot', color: '#3EC6E0', initial: 'V' },
  { id: 'muse', name: 'Brainy Muse', kind: 'paste', color: '#FFD84D', initial: 'M' },
  { id: 'chatgpt', name: 'ChatGPT', kind: 'paste', color: '#3DDC84', initial: 'C' },
  { id: 'gemini', name: 'Gemini', kind: 'bot', color: '#4285F4', initial: 'G' },
];
const ME = 'Brad';
const $ = s => document.querySelector(s);
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }, del(k) { try { localStorage.removeItem(k); } catch (_) {} } };

let pass = ls.get(K.pass, null);
let people = ls.get(K.people, null) || DEFAULT_PEOPLE;
let postAs = ls.get(K.as, ME);
let msgs = new Map((ls.get(K.cache, []) || []).map(m => [m.id, m]));
let outbox = ls.get(K.outbox, []);
let replyTo = ls.get(K.reply, null);
let lastOk = 0, polling = false, pollTimer = null, flushing = false;

/* ---------- helpers ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = s => esc(s).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const fmtFull = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const fmtDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtDayLabel = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric' });
function dayLabel(d) {
  const k = fmtDayKey.format(d), today = fmtDayKey.format(new Date()), yest = fmtDayKey.format(new Date(Date.now() - 864e5));
  return k === today ? 'Today' : k === yest ? 'Yesterday' : fmtDayLabel.format(d);
}
function hashColor(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 70% 65%)`; }
function person(name) {
  const p = people.find(x => x.name.toLowerCase() === String(name || '').toLowerCase());
  return p || { name: name || '?', kind: 'other', color: hashColor(name || '?'), initial: (String(name || '?').trim()[0] || '?').toUpperCase() };
}
const KIND_LABEL = { human: 'You', bot: 'Bot', paste: 'Paste-in', other: '' };
const KIND_LONG = { human: 'You, from this phone', bot: 'Bot on the box', paste: 'Paste-in: paste their reply', other: '' };
const isBot = p => p && (p.kind === 'bot' || p.kind === 'paste');
const canMention = p => p && p.name && p.name !== '?';
const avatar = (p, cls = 'av') => `<span class="${cls}${canMention(p) ? ' mentionable' : ''}"${canMention(p) ? ` data-mention="${esc(p.name)}"` : ''} style="background:${esc(p.color)}">${esc(p.initial || '?')}</span>`;
let toastT;
function toast(html, ms = 3200) { const t = $('#toast'); t.innerHTML = html; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms); }
const snip = m => m.text ? m.text : (m.attachments || []).map(a => /^video\//.test(a.mime || '') ? '🎬 Video' : /^image\//.test(a.mime || '') ? '📷 Photo' : '📎 ' + a.name).join(' ') || '';
const sorted = () => [...msgs.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
/* ---------- @Brad attention pings ---------- */
const MENTION_RE = /(^|[^\w@])@brad(\s+future)?(?![\w])/i;
const isPing = m => !!m && !m._pending && typeof m.text === 'string' && MENTION_RE.test(m.text) && String(m.from || '').trim().toLowerCase() !== ME.toLowerCase();
let seenAt = ls.get(K.seenAt, null); // ISO ts: pings at or before this are read
if (!seenAt) { seenAt = new Date().toISOString(); ls.set(K.seenAt, seenAt); } // first run: older pings count as read
const unreadPings = () => sorted().filter(m => isPing(m) && m.ts > seenAt);
function markSeen(ts) { if (ts > seenAt) { seenAt = ts; ls.set(K.seenAt, ts); renderMentionPill(); } }
function renderMentionPill() {
  const n = unreadPings().length, b = $('#mentionPill');
  b.hidden = !n; $('#mentionCount').textContent = n > 99 ? '99+' : String(n);
  document.title = n ? `(${n}) BotWeb` : 'BotWeb';
  try { if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch (_) {}
}
function jumpTo(id) {
  const el = document.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  const m = msgs.get(id); if (m && isPing(m)) markSeen(m.ts);
  return true;
}
const seenObs = 'IntersectionObserver' in window ? new IntersectionObserver(es => {
  if (document.hidden) return;
  for (const e of es) if (e.isIntersecting) { const m = msgs.get(e.target.dataset.id); if (m) markSeen(m.ts); seenObs.unobserve(e.target); }
}, { threshold: 0.6 }) : null;
let audioCtx = null;
function pingAlert() { // in-app fallback when phone push isn't on
  try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch (_) {}
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [880, 1320].forEach((f, i) => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.16); g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.16 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.15);
      o.connect(g).connect(audioCtx.destination); o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.16); });
  } catch (_) {}
}
['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, () => { try { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch (_) {} }, { passive: true }));
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushActive = () => pushSupported() && ls.get(K.pushOn, false) && Notification.permission === 'granted';

function saveCache() { ls.set(K.cache, sorted().slice(-400)); }

/* ---------- relay ---------- */
class RelayError extends Error { constructor(kind, msg, status) { super(msg || kind); this.kind = kind; this.status = status; } }
async function api(path, body, code = pass) {
  let r;
  try {
    r = await fetch(RELAY + path, { method: 'POST', body: JSON.stringify(body || {}), headers: { 'content-type': 'application/json', 'x-passcode': code || '' } });
  } catch (e) { throw new RelayError(navigator.onLine ? 'network' : 'offline'); }
  let d = null; try { d = await r.json(); } catch (_) {}
  if (r.status === 401) throw new RelayError('passcode', 'Wrong passcode', 401);
  if (!r.ok) throw new RelayError('server', (d && d.message) || ('Error ' + r.status), r.status);
  return d;
}
function setConn(ok) {
  $('#dot').className = 'dot ' + (ok ? 'ok' : 'bad');
  $('#dot').title = ok ? 'Connected' : 'Not connected';
  $('#offline').hidden = navigator.onLine;
}

/* ---------- media: private Blob files are shown through short-lived signed links from the relay ---------- */
const PRIV = /^https:\/\/[a-z0-9]+\.private\.blob\.vercel-storage\.com\//;
let signedCache = ls.get(K.signed, {}) || {};
for (const [u, v] of Object.entries(signedCache)) if (!v || v.until - Date.now() < 30 * 60e3) delete signedCache[u];
const kindOf = a => /^image\//.test(a.mime || '') || (!a.mime && /\.(jpe?g|png|gif|webp|heic|avif)$/i.test(a.name || '')) ? 'image'
  : /^video\//.test(a.mime || '') || (!a.mime && /\.(mp4|mov|m4v|webm)$/i.test(a.name || '')) ? 'video' : 'file';
function srcFor(url) { if (!PRIV.test(url)) return url; const h = signedCache[url]; return h && h.until - Date.now() > 10 * 60e3 ? h.url : ''; }
function attHtml(a) {
  if (!a.url) return `<span class="att">📎 ${esc(a.name)}</span>`;
  const k = kindOf(a), src = srcFor(a.url), ar = a.w && a.h ? ` style="aspect-ratio:${+a.w}/${+a.h}"` : '';
  const s = src ? ` src="${esc(src)}"` : '';
  if (k === 'image') return `<button type="button" class="media" data-view="${esc(a.url)}" aria-label="Open photo ${esc(a.name)}"><img data-blob="${esc(a.url)}"${s}${ar} alt="${esc(a.name)}" loading="lazy" decoding="async"></button>`;
  if (k === 'video') return `<div class="media"><video data-blob="${esc(a.url)}"${s}${ar} controls playsinline preload="metadata"></video></div>`;
  if (PRIV.test(a.url)) return `<button type="button" class="att" data-open="${esc(a.url)}">📎 ${esc(a.name)}</button>`;
  return `<a class="att" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">📎 ${esc(a.name)}</a>`;
}
let signing = null;
async function signUrls(urls) {
  urls = [...new Set(urls)].filter(u => PRIV.test(u) && !srcFor(u));
  if (!urls.length || !pass) return;
  const d = await api('files/sign', { urls });
  for (const [u, s] of Object.entries(d.urls || {})) signedCache[u] = { url: s, until: d.validUntil || Date.now() + 6 * 3600e3 };
  ls.set(K.signed, Object.fromEntries(Object.entries(signedCache).slice(-300)));
}
let hydrateAgain = false;
async function hydrateMedia() {
  if (signing) { hydrateAgain = true; return; }
  const els = [...document.querySelectorAll('#list [data-blob]:not([src])')]; if (!els.length) return;
  signing = signUrls(els.map(e => e.dataset.blob)).catch(() => {});
  await signing; signing = null;
  for (const e of els) { const s = srcFor(e.dataset.blob); if (s) e.src = s; }
  if (hydrateAgain) { hydrateAgain = false; hydrateMedia(); }
}
async function openViewer(url) {
  await signUrls([url]).catch(() => {});
  const s = srcFor(url); if (!s) { toast("Couldn't open that photo"); return; }
  $('#viewerImg').src = s; $('#viewer').hidden = false;
}
$('#viewer').addEventListener('click', () => { $('#viewer').hidden = true; $('#viewerImg').removeAttribute('src'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#viewer').hidden) $('#viewer').click(); });

/* ---------- rendering ---------- */
let rendered = '';
function nearBottom() { const l = $('#list'); return l.scrollHeight - l.scrollTop - l.clientHeight < 120; }
function scrollBottom() { const l = $('#list'); l.scrollTop = l.scrollHeight; $('#newPill').hidden = true; }
function render(force) {
  const list = sorted();
  const pend = outbox.map(o => ({ id: o.tmp, from: o.from, text: o.text, ts: o.at, replyTo: o.replyTo, attachments: o.attachments, _pending: true, _failed: o.failed }));
  const all = list.concat(pend);
  const sig = all.map(m => m.id + (m._failed ? 'f' : '')).join(',') + '|' + people.map(p => p.name + p.color + p.initial).join(',');
  if (!force && sig === rendered) return;
  const wasBottom = nearBottom() || !rendered, prevCount = rendered ? rendered.split(',').length : 0;
  rendered = sig;
  const box = $('#list'), frag = document.createDocumentFragment();
  let lastDay = '', prev = null;
  for (const m of all) {
    const d = new Date(m.ts), dk = fmtDayKey.format(d);
    if (dk !== lastDay) { const s = document.createElement('div'); s.className = 'day'; s.innerHTML = `<span>${esc(dayLabel(d))}</span>`; frag.appendChild(s); lastDay = dk; prev = null; }
    const p = person(m.from), me = m.from === ME;
    const cont = prev && prev.from === m.from && d - new Date(prev.ts) < 5 * 60e3 && !m.replyTo;
    const key = m.id + (isPing(m) ? '@' : '') + '|' + (cont ? 1 : 0) + '|' + (m._pending ? (m._failed ? 'f' : 'p') : '') + '|' + (m.replyTo && msgs.has(m.replyTo) ? 1 : 0) + '|' + p.color + p.initial;
    const old = !force && box.querySelector(`.msg[data-key="${CSS.escape(key)}"]`);
    if (old) { frag.appendChild(old); prev = m; continue; }
    const el = document.createElement('div');
    el.dataset.key = key;
    el.className = 'msg' + (me ? ' me' : '') + (cont ? ' cont' : '') + (m._pending ? ' pending' : '') + (m._failed ? ' failed' : '') + (isPing(m) ? ' mention' : '');
    el.dataset.id = m.id;
    let quote = '';
    if (m.replyTo) {
      const q = msgs.get(m.replyTo), qp = q ? person(q.from) : null;
      quote = `<button class="quote" data-jump="${esc(m.replyTo)}" style="--qc:${esc(qp ? qp.color : '#8C99AB')}"><b>${esc(q ? q.from : 'Earlier message')}</b><span>${esc(q ? snip(q).slice(0, 200) : 'Not loaded')}</span></button>`;
    }
    const att = (m.attachments || []).map(attHtml).join('');
    const status = m._pending ? (m._failed ? '<span>Not sent · tap to retry</span>' : '<span>Sending…</span>') : `<button class="rep" data-reply="${esc(m.id)}">Reply</button>`;
    el.innerHTML = `${avatar(p)}<div class="bubble">`
      + `<div class="who" style="color:${esc(p.color)}">${esc(m.from)}${KIND_LABEL[p.kind] && p.kind !== 'human' ? `<span class="tag">${KIND_LABEL[p.kind]}</span>` : ''}</div>`
      + (isPing(m) ? '<span class="at-badge" title="Mentions you">@</span>' : '')
      + quote + att + (m.text ? `<div class="text">${linkify(m.text).replace(/(^|[^\w@])(@brad(?:\s+future)?)(?![\w])/gi, '$1<b class="at-me">$2</b>')}</div>` : '')
      + `<div class="meta">${status}<time datetime="${esc(m.ts)}" title="${esc(fmtFull.format(d))}">${esc(fmtTime.format(d))}</time></div></div>`;
    frag.appendChild(el); prev = m;
    if (seenObs && isPing(m) && m.ts > seenAt) seenObs.observe(el);
  }
  box.querySelectorAll('.day,.msg').forEach(n => n.remove());
  box.appendChild(frag);
  hydrateMedia();
  $('#empty').hidden = all.length > 0;
  renderMentionPill();
  if (wasBottom) scrollBottom();
  else if (all.length > prevCount) $('#newPill').hidden = false;
}
function renderHeader() {
  const bots = people.filter(p => p.kind === 'bot').length, others = people.filter(p => p.kind === 'paste').length;
  $('#sub').textContent = `Brad · ${bots} bot${bots === 1 ? '' : 's'} · ${others} paste-in`;
}
function renderAs() {
  if (!people.some(p => p.name === postAs)) postAs = ME;
  const p = person(postAs);
  $('#asAv').textContent = p.initial; $('#asAv').style.background = p.color;
  $('#asBtn').setAttribute('aria-label', 'Post as ' + p.name);
  const other = postAs !== ME;
  $('#asBanner').hidden = !other;
  if (other) { $('#asBannerName').textContent = p.name; $('#asBanner').style.setProperty('--asc', p.color); }
  $('#input').placeholder = other ? `Paste ${p.name}'s reply` : 'Message';
}
function renderReply() {
  const m = replyTo && (msgs.get(replyTo) || null);
  $('#replyBar').hidden = !m;
  if (!m) return;
  const p = person(m.from);
  $('#replyBar').style.setProperty('--qc', p.color);
  $('#rbWho').textContent = 'Replying to ' + m.from; $('#rbSnip').textContent = snip(m).slice(0, 160);
}
function setReply(id) { replyTo = id; ls.set(K.reply, id); renderReply(); if (id) $('#input').focus(); }

/* ---------- sync ---------- */
let booted = false;
function merge(list) {
  let changed = false, fresh = false;
  for (const m of list || []) if (m && m.id && !msgs.has(m.id)) { msgs.set(m.id, m); changed = true; if (booted && isPing(m) && Date.now() - new Date(m.ts) < 10 * 60e3) fresh = true; }
  booted = true;
  if (fresh && !pushActive()) pingAlert();
  if (changed) saveCache();
  return changed;
}
async function poll(manual) {
  if (!pass || polling) return;
  polling = true;
  if (manual) $('#refreshBtn').classList.add('spin');
  try {
    const last = sorted().pop();
    const body = last && !manual ? { since: new Date(new Date(last.ts).getTime() - 2000).toISOString() } : {};
    const d = await api('messages/list', body);
    lastOk = Date.now(); setConn(true);
    if (merge(d.messages)) render();
    if (outbox.length) flushOutbox();
    if (manual) toast('Up to date');
  } catch (e) {
    setConn(false);
    if (e.kind === 'passcode') { pass = null; ls.del(K.pass); askPass(true); }
    else if (manual) toast(e.kind === 'offline' ? "You're offline" : "Couldn't reach the chat. Trying again soon.");
  } finally { polling = false; $('#refreshBtn').classList.remove('spin'); }
}
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
}
async function loadPeople() {
  try {
    const d = await api('participants/get');
    if (d && Array.isArray(d.participants) && d.participants.length) { people = d.participants; ls.set(K.people, people); renderHeader(); renderAs(); render(true); }
  } catch (_) {}
}

/* ---------- sending (outbox survives going offline / closing the app) ---------- */
let picked = [], uploading = false, keepOriginal = false; // [{file, kind, url (preview object URL)}]
async function send(text) {
  text = text.trim(); if ((!text && !picked.length) || uploading) return;
  let attachments;
  if (picked.length) {
    if (!pass) { askPass(false); return; }
    try { attachments = await uploadAll(); } catch (e) {
      toast(e.kind === 'offline' ? "You're offline. Your photos are still here; send again when you're back." : esc(e.message || "Upload failed. Try again."), 5000); return;
    }
    clearPicked();
  }
  outbox.push({ tmp: 'tmp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), from: postAs, text, replyTo: replyTo || undefined, attachments, at: new Date().toISOString() });
  ls.set(K.outbox, outbox);
  $('#input').value = ''; ls.del(K.draft); autoGrow(); updateSend();
  setReply(null);
  render(); scrollBottom();
  flushOutbox();
}
async function flushOutbox() {
  if (flushing || !pass || !outbox.length) return;
  flushing = true;
  try {
    while (outbox.length) {
      const o = outbox[0];
      try {
        const d = await api('messages/post', { from: o.from, text: o.text, replyTo: o.replyTo, attachments: o.attachments });
        outbox.shift(); ls.set(K.outbox, outbox);
        merge([d.message]); setConn(true); render();
      } catch (e) {
        if (e.kind === 'passcode') { pass = null; ls.del(K.pass); askPass(true); break; }
        if (e.kind === 'server' && e.status >= 400 && e.status < 500) { // the relay refused it (too long, empty…): put it back in the box
          outbox.shift(); ls.set(K.outbox, outbox);
          if (!$('#input').value) { $('#input').value = o.text; ls.set(K.draft, o.text); autoGrow(); updateSend(); }
          toast(esc(e.message)); render(); continue;
        }
        o.failed = true; ls.set(K.outbox, outbox); setConn(false); render(true);
        break;
      }
    }
  } finally { flushing = false; }
}

/* ---------- sheets ---------- */
function showSheet(sel) { document.querySelectorAll('.sheet').forEach(s => { s.hidden = s !== $(sel); }); $('#scrim').hidden = false; }
function closeSheet() { if (!pass && !$('#passSheet').hidden) return; document.querySelectorAll('.sheet').forEach(s => { s.hidden = true; }); $('#scrim').hidden = true; }
function askPass(wrong) {
  $('#passMsg').textContent = wrong ? "That passcode didn't work. Please check it and try again." : 'Type the BotWeb passcode. You only need to do this once on this phone.';
  $('#passMsg').classList.toggle('bad', !!wrong);
  $('#passInput').value = '';
  showSheet('#passSheet');
  setTimeout(() => $('#passInput').focus(), 200);
}
$('#passShow').addEventListener('change', e => { $('#passInput').type = e.target.checked ? 'text' : 'password'; });
$('#passSheet').addEventListener('submit', async e => {
  e.preventDefault();
  const v = $('#passInput').value.trim(); if (!v) return;
  const btn = $('#passSheet button[type=submit]'); btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const d = await api('messages/list', {}, v);
    pass = v; ls.set(K.pass, v);
    document.querySelectorAll('.sheet').forEach(s => { s.hidden = true; }); $('#scrim').hidden = true;
    merge(d.messages); render(true); setConn(true); loadPeople(); flushOutbox();
  } catch (err) {
    if (err.kind === 'passcode') askPass(true);
    else { $('#passMsg').textContent = err.kind === 'offline' ? "You're offline. Connect and try again." : "Couldn't reach the chat right now. Try again in a moment."; $('#passMsg').classList.add('bad'); }
  } finally { btn.disabled = false; btn.textContent = 'Open the chat'; }
});

function renderAsList() {
  $('#asList').innerHTML = people.map(p => `<button class="as-row${p.name === postAs ? ' sel' : ''}" data-as="${esc(p.name)}">${avatar(p)}<span class="nm"><b style="color:${esc(p.color)}">${esc(p.name)}</b><small>${KIND_LONG[p.kind] || ''}</small></span><span class="tick">${p.name === postAs ? '✓' : ''}</span></button>`).join('');
}
$('#asBtn').addEventListener('click', () => { renderAsList(); showSheet('#asSheet'); });
$('#asList').addEventListener('click', e => {
  const b = e.target.closest('[data-as]'); if (!b) return;
  postAs = b.dataset.as; ls.set(K.as, postAs); renderAs(); closeSheet(); $('#input').focus();
});
$('#asBack').addEventListener('click', () => { postAs = ME; ls.set(K.as, ME); renderAs(); });
$('#asEdit').addEventListener('click', openSettings);

/* settings: participant editor */
let draftPeople = [];
function renderPeopleEd() {
  $('#peopleEd').innerHTML = draftPeople.map((p, i) => `<div class="ped" data-i="${i}">
    <input type="color" value="${esc(/^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : '#8A94A6')}" aria-label="Color for ${esc(p.name)}" data-f="color">
    <input type="text" class="ini" maxlength="2" value="${esc(p.initial || '')}" aria-label="Avatar letter" data-f="initial">
    <input type="text" class="nm" maxlength="60" value="${esc(p.name)}" placeholder="Name" aria-label="Name" data-f="name">
    <button type="button" class="del" aria-label="Remove ${esc(p.name)}" data-del="${i}">✕</button>
    <span></span><select data-f="kind" aria-label="Type">${['human', 'bot', 'paste'].map(k => `<option value="${k}"${p.kind === k ? ' selected' : ''}>${{ human: 'Person (Brad)', bot: 'Bot on the box', paste: 'Paste-in (Muse, ChatGPT…)' }[k]}</option>`).join('')}</select>
  </div>`).join('');
}
function openSettings() {
  renderPushToggle();
  draftPeople = people.map(p => ({ ...p }));
  renderPeopleEd();
  $('#aboutLine').textContent = `BotWeb ${VERSION}. Times are shown in New York time. ${pass ? 'Passcode saved on this phone.' : 'No passcode saved.'}`;
  showSheet('#setSheet');
}
$('#settingsBtn').addEventListener('click', openSettings);
$('#peopleEd').addEventListener('input', e => {
  const row = e.target.closest('.ped'), f = e.target.dataset.f; if (!row || !f) return;
  draftPeople[+row.dataset.i][f] = e.target.value;
});
$('#peopleEd').addEventListener('click', e => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  const p = draftPeople[+b.dataset.del];
  if (p.name === ME) { toast("Brad stays in the chat"); return; }
  draftPeople.splice(+b.dataset.del, 1); renderPeopleEd();
});
$('#addPerson').addEventListener('click', () => {
  const palette = ['#FF8A3D', '#5EE6B0', '#E879F9', '#A3E635', '#60A5FA', '#F472B6'];
  draftPeople.push({ name: '', kind: 'paste', color: palette[draftPeople.length % palette.length], initial: '' });
  renderPeopleEd(); const ins = $('#peopleEd').querySelectorAll('input.nm'); ins[ins.length - 1].focus();
});
$('#savePeople').addEventListener('click', async () => {
  const list = draftPeople.map(p => ({ ...p, name: (p.name || '').trim(), initial: (p.initial || (p.name || '?').trim()[0] || '?').toUpperCase() })).filter(p => p.name);
  if (!list.some(p => p.name === ME)) { toast('Keep Brad in the list'); return; }
  const btn = $('#savePeople'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const d = await api('participants/save', { participants: list });
    people = d.participants; ls.set(K.people, people);
    renderHeader(); renderAs(); render(true); closeSheet(); toast('Participants saved');
  } catch (e) { toast(e.kind === 'offline' ? "You're offline. Try again when connected." : "Couldn't save: " + esc(e.message)); }
  finally { btn.disabled = false; btn.textContent = 'Save participants'; }
});
$('#changePass').addEventListener('click', () => { pass = null; ls.del(K.pass); askPass(false); });
$('#forgetPass').addEventListener('click', () => { if (!confirm('Forget the passcode on this phone? You will need to type it again.')) return; pass = null; ls.del(K.pass); askPass(false); });
document.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });
$('#scrim').addEventListener('click', closeSheet);

/* ---------- message list interactions ---------- */
$('#list').addEventListener('click', e => {
  const r = e.target.closest('[data-reply]'); if (r) { setReply(r.dataset.reply); return; }
  const v = e.target.closest('[data-view]'); if (v) { openViewer(v.dataset.view); return; }
  const fo = e.target.closest('[data-open]'); if (fo) { const w = window.open('', '_blank'); signUrls([fo.dataset.open]).then(() => { const s = srcFor(fo.dataset.open); if (s && w) w.location = s; else if (w) w.close(); }); return; }
  const j = e.target.closest('[data-jump]');
  if (j) { const el = document.querySelector(`.msg[data-id="${CSS.escape(j.dataset.jump)}"]`); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } else toast('That message is older than what is loaded'); return; }
  const f = e.target.closest('.msg.failed'); if (f) { outbox.forEach(o => { o.failed = false; }); render(true); flushOutbox(); }
});
$('#list').addEventListener('scroll', () => { if (nearBottom()) $('#newPill').hidden = true; }, { passive: true });
$('#newPill').addEventListener('click', scrollBottom);
$('#replyX').addEventListener('click', () => setReply(null));
$('#refreshBtn').addEventListener('click', () => { if (!pass) { askPass(false); return; } poll(true); loadPeople(); });

/* ---------- attachments: pick, preview, shrink photos, upload straight to the private store with progress ---------- */
const fmtMB = n => n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
function addFiles(list) {
  for (const f of list) {
    const kind = /^video\//.test(f.type) || /\.(mov|mp4|m4v|webm)$/i.test(f.name) ? 'video' : /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name) ? 'image' : null;
    if (!kind) { toast(esc(f.name) + ' is not a photo or video'); continue; }
    if (kind === 'video' && f.size > MAX_VIDEO) { toast(`That video is ${fmtMB(f.size)}. Videos can be up to 400 MB. Try trimming it or sending a shorter clip.`, 6000); continue; }
    if (kind === 'image' && f.size > MAX_IMAGE_IN) { toast(`That photo is ${fmtMB(f.size)}, too big to send.`, 5000); continue; }
    if (picked.length >= MAX_FILES) { toast(`Up to ${MAX_FILES} at a time`); break; }
    picked.push({ file: f, kind, url: URL.createObjectURL(f) });
  }
  renderTray(); updateSend();
}
function clearPicked() { picked.forEach(p => URL.revokeObjectURL(p.url)); picked = []; keepOriginal = false; renderTray(); updateSend(); }
function renderTray() {
  $('#tray').hidden = !picked.length;
  $('#trayItems').innerHTML = picked.map((p, i) => `<div class="tray-item">${p.kind === 'video' ? `<video src="${p.url}#t=0.1" muted playsinline preload="metadata"></video><span class="vbadge">▶ ${fmtMB(p.file.size)}</span>` : `<img src="${p.url}" alt="">`}<button type="button" class="rm" data-rm="${i}" aria-label="Remove">✕</button></div>`).join('');
  const vids = picked.filter(p => p.kind === 'video');
  $('#origRow').hidden = !vids.length;
  $('#origChk').checked = keepOriginal;
  $('#origHint').textContent = keepOriginal ? 'Sends the full file (slower)' : 'Videos are shrunk to 720p first (faster)';
}
$('#origChk').addEventListener('change', e => { keepOriginal = e.target.checked; renderTray(); });
$('#attachBtn').addEventListener('click', () => { if (!uploading) $('#fileInput').click(); });
$('#fileInput').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
$('#trayItems').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (!b || uploading) return; const [p] = picked.splice(+b.dataset.rm, 1); URL.revokeObjectURL(p.url); renderTray(); updateSend(); });
$('#input').addEventListener('paste', e => { const fs = [...(e.clipboardData && e.clipboardData.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } });

function loadImage(file) {
  return new Promise((res, rej) => { const u = URL.createObjectURL(file), i = new Image(); i.onload = () => res({ img: i, w: i.naturalWidth, h: i.naturalHeight, done: () => URL.revokeObjectURL(u) }); i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('bad image')); }; i.src = u; });
}
// Photos and screenshots are resized to at most 2048 px on the long side (JPEG); GIFs and small files go as they are.
async function prepImage(file) {
  const base = (file.name || 'photo').replace(/\.[^.]+$/, '') || 'photo';
  if (/gif|svg/.test(file.type)) return { blob: file, name: file.name, type: file.type };
  let im; try { im = await loadImage(file); } catch (_) { return { blob: file, name: file.name, type: file.type || 'image/jpeg' }; }
  const { w, h } = im, scale = Math.min(1, MAX_IMAGE_PX / Math.max(w, h));
  if (scale === 1 && file.size < 1.5 * 1048576 && /^image\/(jpeg|png|webp)$/.test(file.type)) { im.done(); return { blob: file, name: file.name, type: file.type, w, h }; }
  const cw = Math.round(w * scale), chh = Math.round(h * scale), c = document.createElement('canvas'); c.width = cw; c.height = chh;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cw, chh); g.drawImage(im.img, 0, 0, cw, chh); im.done();
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
  if (!blob || (scale === 1 && blob.size >= file.size && /^image\/(jpeg|png|webp)$/.test(file.type))) return { blob: file, name: file.name, type: file.type, w, h };
  return { blob, name: base + '.jpg', type: 'image/jpeg', w: cw, h: chh };
}
function videoInfo(url) {
  return new Promise(res => { const v = document.createElement('video'); const t = setTimeout(() => res({}), 4000);
    v.preload = 'metadata'; v.muted = true; v.onloadedmetadata = () => { clearTimeout(t); res({ w: v.videoWidth || undefined, h: v.videoHeight || undefined, dur: isFinite(v.duration) ? v.duration : undefined }); }; v.onerror = () => { clearTimeout(t); res({}); }; v.src = url; });
}
function putFile(url, blob, type, onProgress) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest(); x.open('PUT', url); x.setRequestHeader('content-type', type);
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded); };
    x.onload = () => { let d = null; try { d = JSON.parse(x.responseText); } catch (_) {}
      if (x.status >= 200 && x.status < 300 && d && d.url) res(d); else rej(new RelayError('server', (d && d.error && d.error.message) || 'Upload failed (' + x.status + ')', x.status)); };
    x.onerror = () => rej(new RelayError(navigator.onLine ? 'network' : 'offline', 'Upload failed. Check your connection and try again.'));
    x.send(blob);
  });
}
// Vercel Blob client upload (vendored SDK). Files over 8 MB go multipart: parallel 8 MB parts, failed parts retried.
let blobSdk = null;
const rndHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const safeName = n => (String(n || 'file').normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'file').slice(-80);
async function blobUpload(it, onProgress) {
  if (!navigator.onLine) throw new RelayError('offline');
  try { blobSdk = blobSdk || await import('./vendor/blob-client-2.8.1.js'); } catch (_) { throw new RelayError('network', "Couldn't load the uploader. Check your connection and try again."); }
  const pathname = `media/${new Date().toISOString().slice(0, 7)}/${rndHex(12)}/${safeName(it.name)}`;
  try {
    return await blobSdk.upload(pathname, it.blob, { access: 'private', contentType: it.type, multipart: it.blob.size > 8 * 1048576,
      handleUploadUrl: RELAY + 'files/client-token', headers: { 'x-passcode': pass || '' }, clientPayload: JSON.stringify({ type: it.type }),
      onUploadProgress: e => onProgress(e.loaded) });
  } catch (e) {
    if (!navigator.onLine) throw new RelayError('offline');
    throw new RelayError('server', 'Upload failed: ' + String(e && e.message || e).replace(/^Vercel Blob: /, '').slice(0, 160));
  }
}
/* Video shrinking: WebCodecs (hardware encoder on Android Chrome) via the vendored Mediabunny library. It reads the file
   in slices and encodes frame by frame, so long clips don't fill memory; output goes to a temp file in the browser's
   private storage (OPFS) when available. Skipped for small/low-res clips; any failure means the original is sent. */
const SHRINK_MIN_BYTES = 15 * 1048576, SHRINK_LONG = 1280, SHRINK_VBR = 2_300_000, SHRINK_ABR = 128_000;
let mbLib = null;
async function shrinkVideo(file, onPct) {
  if (file.size < SHRINK_MIN_BYTES || typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return null;
  let input, conv, opfsName, dir;
  try {
    mbLib = mbLib || await import('./vendor/mediabunny-1.61.4.js');
    const M = mbLib;
    input = new M.Input({ source: new M.BlobSource(file), formats: M.ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack(); if (!vt) return null;
    const W = vt.displayWidth, H = vt.displayHeight, long = Math.max(W, H);
    if (long <= SHRINK_LONG) return null; // already 720p or smaller
    const sc = SHRINK_LONG / long, even = n => Math.max(2, Math.round(n / 2) * 2), w = even(W * sc), h = even(H * sc);
    if (!(await M.canEncodeVideo('avc', { width: w, height: h, bitrate: SHRINK_VBR }))) return null;
    const dur = await input.computeDuration().catch(() => 0);
    // write to OPFS when we can (keeps RAM flat on long clips), else to memory with the index up front
    let target, fileHandle;
    try {
      dir = await navigator.storage.getDirectory(); opfsName = 'bw-shrink-' + rndHex(6) + '.mp4';
      fileHandle = await dir.getFileHandle(opfsName, { create: true });
      target = new M.StreamTarget(await fileHandle.createWritable(), { chunked: true });
    } catch (_) { fileHandle = null; opfsName = null; target = new M.BufferTarget(); }
    const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: fileHandle ? false : 'in-memory' }), target });
    conv = await M.Conversion.init({ input, output, showWarnings: false,
      video: { width: w, height: h, fit: 'contain', codec: 'avc', bitrate: SHRINK_VBR },
      audio: async t => t.codec === 'aac' ? {} : (await M.canEncodeAudio('aac')) ? { codec: 'aac', bitrate: SHRINK_ABR } : { codec: 'opus', bitrate: SHRINK_ABR } });
    if (!conv.isValid || conv.discardedTracks.length) {
      if (conv.discardedTracks.length) console.warn('shrink: would lose a track', conv.discardedTracks.map(d => d.reason)); return null;
    }
    conv.onProgress = f => onPct(Math.min(0.99, f));
    await conv.execute();
    const out = fileHandle ? await fileHandle.getFile() : new Blob([target.buffer], { type: 'video/mp4' });
    onPct(1);
    if (!out.size || out.size > file.size * 0.8) return null; // not worth it
    return { blob: out, w, h, dur: dur || undefined, _opfs: opfsName };
  } catch (e) { console.warn('shrink failed, sending original', e); try { conv && await conv.cancel(); } catch (_) {} return null; }
  finally { try { input && input.dispose && input.dispose(); } catch (_) {} }
}
async function dropTemp(items) { try { const dir = await navigator.storage.getDirectory(); for (const i of items) if (i._opfs) await dir.removeEntry(i._opfs).catch(() => {}); } catch (_) {} }
async function uploadAll() {
  uploading = true; updateSend(); $('#tray').classList.add('busy'); $('#upBar').hidden = false;
  const items = [];
  const bar = (f, t) => { $('#upFill').style.width = Math.round(f * 100) + '%'; $('#upText').textContent = t; };
  try {
    bar(0, 'Preparing…');
    for (const p of picked) {
      if (p.kind === 'image') items.push({ ...(await prepImage(p.file)), kind: 'image' });
      else {
        const it = { blob: p.file, name: p.file.name || 'video.mp4', type: p.file.type || (/\.mov$/i.test(p.file.name) ? 'video/quicktime' : 'video/mp4'), kind: 'video', orig: p.file.size };
        if (!keepOriginal) {
          const n = picked.filter(q => q.kind === 'video').length, k = items.filter(q => q.kind === 'video').length + 1;
          const sh = await shrinkVideo(p.file, f => bar(f, `Shrinking video${n > 1 ? ` ${k} of ${n}` : ''}… ${Math.round(f * 100)}%`));
          if (sh) Object.assign(it, sh, { name: it.name.replace(/\.[^.]+$/, '') + '.mp4', type: 'video/mp4' });
        }
        if (!it.w) Object.assign(it, await videoInfo(p.url));
        items.push(it);
      }
    }
    const total = items.reduce((n, i) => n + i.blob.size, 0) || 1; let doneBytes = 0; const out = [];
    const shrunk = items.filter(i => i.orig && i.blob.size < i.orig), was = shrunk.reduce((n, i) => n + i.orig, 0), now = shrunk.reduce((n, i) => n + i.blob.size, 0);
    const sizeNote = shrunk.length ? ` · video ${fmtMB(was)} → ${fmtMB(now)}` : '';
    for (const [i, it] of items.entries()) {
      const label = items.length > 1 ? `Uploading ${i + 1} of ${items.length}` : 'Uploading';
      bar(doneBytes / total, `${label}… ${Math.round(doneBytes / total * 100)}%`);
      const r = await blobUpload(it, n => { const f = (doneBytes + n) / total; bar(f, `${label}… ${Math.round(f * 100)}% · ${fmtMB(doneBytes + n)} of ${fmtMB(total)}${sizeNote}`); });
      doneBytes += it.blob.size;
      out.push({ name: it.name, url: r.url, mime: it.type, size: it.blob.size, w: it.w, h: it.h, dur: it.dur });
    }
    bar(1, 'Sent');
    if (shrunk.length) toast(`Video shrunk from ${fmtMB(was)} to ${fmtMB(now)}`, 4000);
    return out;
  } finally { uploading = false; updateSend(); $('#tray').classList.remove('busy'); $('#upBar').hidden = true; dropTemp(items); }
}

/* ---------- phone notifications (Web Push) when a bot @mentions Brad ---------- */
const b64u = s => { const p = '='.repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function renderPushToggle() {
  const chk = $('#pushChk'), hint = $('#pushHint');
  if (!pushSupported()) {
    chk.checked = false; chk.disabled = true;
    hint.textContent = isIOS && !standalone() ? 'On iPhone, add BotWeb to your Home Screen (Share → Add to Home Screen) and open it from there to get alerts. Until then you get a sound and buzz while the app is open.'
      : 'This browser can\'t do push alerts. You still get a sound and buzz while BotWeb is open.';
    return;
  }
  chk.disabled = false; chk.checked = pushActive();
  hint.textContent = Notification.permission === 'denied' ? 'Notifications are blocked for BotWeb. Allow them in your phone settings, then turn this on.'
    : chk.checked ? 'On: you get a phone alert when a bot writes @Brad, even with BotWeb closed (at most one every 20 seconds).'
    : 'Get a phone notification when a bot writes @Brad, even when BotWeb is closed.';
}
async function enablePush() {
  if (!pass) throw new Error('Type the passcode first');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked. Allow them in settings.' : 'Notifications not allowed');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('push/key', {});
  let sub = await reg.pushManager.getSubscription();
  if (sub) { const cur = sub.options && sub.options.applicationServerKey; if (cur && btoa(String.fromCharCode(...new Uint8Array(cur))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== publicKey) { await sub.unsubscribe(); sub = null; } }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(publicKey) });
  await api('push/subscribe', { subscription: sub.toJSON(), ua: navigator.userAgent.slice(0, 120) });
  ls.set(K.pushOn, true);
}
async function disablePush() {
  ls.set(K.pushOn, false);
  try { const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    if (sub) { await api('push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); } } catch (_) {}
}
$('#pushChk').addEventListener('change', async e => {
  const on = e.target.checked; e.target.disabled = true;
  try { if (on) { await enablePush(); toast('Alerts on. Bots that @ you will reach your phone.'); } else { await disablePush(); toast('Alerts off'); } }
  catch (err) { ls.set(K.pushOn, false); toast(esc(err.message || 'Could not turn on alerts')); if (err.kind === 'passcode') askPass(true); }
  finally { renderPushToggle(); }
});
$('#mentionPill').addEventListener('click', () => { const m = unreadPings()[0] || sorted().filter(isPing).pop(); if (m) jumpTo(m.id); });
// opened from a notification: #m=<id> in the URL, or a message from the service worker
function jumpFromHash() {
  const id = (/[#&]m=([^&]+)/.exec(location.hash) || [])[1]; if (!id) return;
  const want = decodeURIComponent(id); let tries = 0;
  const go = () => { if (jumpTo(want)) { history.replaceState(null, '', location.pathname + location.search); return; } if (++tries < 20) { if (tries === 3) poll(true); setTimeout(go, 700); } };
  go();
}
window.addEventListener('hashchange', jumpFromHash);
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'jump' && e.data.id) { poll(); setTimeout(() => jumpTo(e.data.id) || (location.hash = 'm=' + e.data.id), 400); } });

/* ---------- long-press a bot's avatar to @mention it ---------- */
function insertMention(name) {
  const t = $('#input'), v = t.value, a = t.selectionStart ?? v.length, b = t.selectionEnd ?? v.length;
  const pre = v.slice(0, a), ins = (pre && !/\s$/.test(pre) ? ' ' : '') + '@' + name + ' ';
  t.value = pre + ins + v.slice(b); const c = a + ins.length;
  ls.set(K.draft, t.value); autoGrow(); updateSend();
  t.focus(); try { t.setSelectionRange(c, c); } catch (_) {}
  try { navigator.vibrate && navigator.vibrate(15); } catch (_) {}
  toast(esc('@' + name) + ' added', 1600);
}
let lp = null, lpFired = 0;
const LP_MS = 450, LP_MOVE = 10;
function lpCancel() { if (lp) { clearTimeout(lp.t); lp = null; } }
document.addEventListener('pointerdown', e => {
  const av = e.target.closest('[data-mention]'); lpCancel();
  if (!av || (e.pointerType === 'mouse' && e.button !== 0)) return;
  lp = { x: e.clientX, y: e.clientY, id: e.pointerId, t: setTimeout(() => {
    lp = null; lpFired = Date.now();
    if (av.closest('#asSheet')) closeSheet();
    insertMention(av.dataset.mention);
  }, LP_MS) };
}, true);
document.addEventListener('pointermove', e => { if (lp && e.pointerId === lp.id && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > LP_MOVE) lpCancel(); }, true);
['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, lpCancel, true));
document.addEventListener('scroll', lpCancel, true);
// after a long press, swallow the click that follows so a normal tap's action doesn't also run
document.addEventListener('click', e => { if (Date.now() - lpFired < 700 && e.target.closest('[data-mention]')) { e.preventDefault(); e.stopPropagation(); } }, true);
// the finger lifting off a non-focusable avatar would blur the composer: cancel that and keep focus on the box
['touchend', 'mouseup'].forEach(t => document.addEventListener(t, e => { if (Date.now() - lpFired < 700) { if (e.cancelable) e.preventDefault(); setTimeout(() => $('#input').focus(), 0); } }, { capture: true, passive: false }));
document.addEventListener('contextmenu', e => { if (e.target.closest('[data-mention]')) e.preventDefault(); });

/* ---------- composer (draft is kept on the phone, even offline) ---------- */
function autoGrow() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, window.innerHeight * 0.4) + 'px'; }
function updateSend() { $('#sendBtn').disabled = uploading || (!$('#input').value.trim() && !picked.length); }
$('#input').addEventListener('input', () => { ls.set(K.draft, $('#input').value); autoGrow(); updateSend(); });
$('#composer').addEventListener('submit', e => { e.preventDefault(); send($('#input').value); $('#input').focus(); });
$('#input').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send($('#input').value); } });

window.addEventListener('online', () => { setConn(true); poll(); flushOutbox(); });
window.addEventListener('offline', () => setConn(false));
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

/* ---------- start ---------- */
$('#input').value = ls.get(K.draft, '') || '';
autoGrow(); updateSend(); renderHeader(); renderAs(); render(true); renderReply();
$('#offline').hidden = navigator.onLine;
if (!pass) askPass(false); else { poll(); loadPeople(); flushOutbox(); }
startPolling();
jumpFromHash();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js?v=' + VERSION).catch(() => {});
