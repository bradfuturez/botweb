/* BotWeb: one group chat for Brad and his bots. Talks to the botweb-relay (the relay holds the GitHub access;
   this public app only knows a passcode, typed once and kept on this phone). No chat content lives in this repo. */
'use strict';
const VERSION = '1.0.0';
const RELAY = (window.BOTWEB_RELAY || 'https://botweb-relay.vercel.app/api/');
const TZ = 'America/New_York', POLL_MS = 4000;
const K = { pass: 'bw.passcode', as: 'bw.postAs', draft: 'bw.draft', cache: 'bw.cache', people: 'bw.people', outbox: 'bw.outbox', reply: 'bw.reply' };
const DEFAULT_PEOPLE = [
  { id: 'brad', name: 'Brad', kind: 'human', color: '#4F9DFF', initial: 'B' },
  { id: 'dev', name: 'CreateAWar Game Developer', kind: 'bot', color: '#F5A623', initial: 'D' },
  { id: 'story', name: 'CreateAWarStorytracker', kind: 'bot', color: '#B07CFF', initial: 'S' },
  { id: 'film', name: 'CreateAWar Game Film Maker', kind: 'bot', color: '#FF5C7A', initial: 'F' },
  { id: 'sound', name: 'Sound/Voice Crafter', kind: 'bot', color: '#3EC6E0', initial: 'V' },
  { id: 'muse', name: 'Brainy Muse', kind: 'paste', color: '#FFD84D', initial: 'M' },
  { id: 'chatgpt', name: 'ChatGPT', kind: 'paste', color: '#3DDC84', initial: 'C' },
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
const avatar = (p, cls = 'av') => `<span class="${cls}" style="background:${esc(p.color)}">${esc(p.initial || '?')}</span>`;
let toastT;
function toast(html, ms = 3200) { const t = $('#toast'); t.innerHTML = html; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms); }
const sorted = () => [...msgs.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
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

/* ---------- rendering ---------- */
let rendered = '';
function nearBottom() { const l = $('#list'); return l.scrollHeight - l.scrollTop - l.clientHeight < 120; }
function scrollBottom() { const l = $('#list'); l.scrollTop = l.scrollHeight; $('#newPill').hidden = true; }
function render(force) {
  const list = sorted();
  const pend = outbox.map(o => ({ id: o.tmp, from: o.from, text: o.text, ts: o.at, replyTo: o.replyTo, _pending: true, _failed: o.failed }));
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
    const el = document.createElement('div');
    el.className = 'msg' + (me ? ' me' : '') + (cont ? ' cont' : '') + (m._pending ? ' pending' : '') + (m._failed ? ' failed' : '');
    el.dataset.id = m.id;
    let quote = '';
    if (m.replyTo) {
      const q = msgs.get(m.replyTo), qp = q ? person(q.from) : null;
      quote = `<button class="quote" data-jump="${esc(m.replyTo)}" style="--qc:${esc(qp ? qp.color : '#8C99AB')}"><b>${esc(q ? q.from : 'Earlier message')}</b><span>${esc(q ? q.text.slice(0, 200) : 'Not loaded')}</span></button>`;
    }
    const att = (m.attachments || []).map(a => a.url ? `<a class="att" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">📎 ${esc(a.name)}</a>` : `<span class="att">📎 ${esc(a.name)}</span>`).join('');
    const status = m._pending ? (m._failed ? '<span>Not sent · tap to retry</span>' : '<span>Sending…</span>') : `<button class="rep" data-reply="${esc(m.id)}">Reply</button>`;
    el.innerHTML = `${avatar(p)}<div class="bubble">`
      + `<div class="who" style="color:${esc(p.color)}">${esc(m.from)}${KIND_LABEL[p.kind] && p.kind !== 'human' ? `<span class="tag">${KIND_LABEL[p.kind]}</span>` : ''}</div>`
      + quote + `<div class="text">${linkify(m.text)}</div>${att}`
      + `<div class="meta">${status}<time datetime="${esc(m.ts)}" title="${esc(fmtFull.format(d))}">${esc(fmtTime.format(d))}</time></div></div>`;
    frag.appendChild(el); prev = m;
  }
  box.querySelectorAll('.day,.msg').forEach(n => n.remove());
  box.appendChild(frag);
  $('#empty').hidden = all.length > 0;
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
  $('#rbWho').textContent = 'Replying to ' + m.from; $('#rbSnip').textContent = m.text.slice(0, 160);
}
function setReply(id) { replyTo = id; ls.set(K.reply, id); renderReply(); if (id) $('#input').focus(); }

/* ---------- sync ---------- */
function merge(list) {
  let changed = false;
  for (const m of list || []) if (m && m.id && !msgs.has(m.id)) { msgs.set(m.id, m); changed = true; }
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
function send(text) {
  text = text.trim(); if (!text) return;
  outbox.push({ tmp: 'tmp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), from: postAs, text, replyTo: replyTo || undefined, at: new Date().toISOString() });
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
        const d = await api('messages/post', { from: o.from, text: o.text, replyTo: o.replyTo });
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
  const j = e.target.closest('[data-jump]');
  if (j) { const el = document.querySelector(`.msg[data-id="${CSS.escape(j.dataset.jump)}"]`); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } else toast('That message is older than what is loaded'); return; }
  const f = e.target.closest('.msg.failed'); if (f) { outbox.forEach(o => { o.failed = false; }); render(true); flushOutbox(); }
});
$('#list').addEventListener('scroll', () => { if (nearBottom()) $('#newPill').hidden = true; }, { passive: true });
$('#newPill').addEventListener('click', scrollBottom);
$('#replyX').addEventListener('click', () => setReply(null));
$('#refreshBtn').addEventListener('click', () => { if (!pass) { askPass(false); return; } poll(true); loadPeople(); });

/* ---------- composer (draft is kept on the phone, even offline) ---------- */
function autoGrow() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, window.innerHeight * 0.4) + 'px'; }
function updateSend() { $('#sendBtn').disabled = !$('#input').value.trim(); }
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
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js?v=' + VERSION).catch(() => {});
