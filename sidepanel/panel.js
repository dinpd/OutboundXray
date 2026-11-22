import { summarize, KINDS, PERSONAL, TRACKING, plural, groupKey } from '../src/lib/summary.js';
import { CATEGORIES } from '../src/lib/trackers.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ?tab=<id> pins the panel to one tab (used when opened as a normal page, e.g. in tests).
const pinnedTab = new URLSearchParams(location.search).has('tab')
  ? Number(new URLSearchParams(location.search).get('tab'))
  : null;

const HIGH_KINDS = new Set(PERSONAL);
const MEDIUM_KINDS = new Set(TRACKING);
const RESTRICTED = /^(chrome|edge|about|chrome-extension|devtools|view-source|chrome-search):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

let port = null;
let tabId = null;
let tabUrl = '';
let state = null;
const details = new Map();
const ui = {
  view: 'summary',
  openGroups: new Set(),
  openRows: new Set(),
  filter: { text: '', third: false, data: false, flagged: false, group: null },
};

// ------------------------------------------------------------ messaging

function connect() {
  port = chrome.runtime.connect({ name: 'outboundxray-panel' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    // The service worker restarted; reconnect.
    port = null;
    setTimeout(() => { connect(); subscribe(); }, 300);
  });
}

function post(msg) {
  if (!port) connect();
  port.postMessage({ tabId, ...msg });
}

function subscribe() {
  if (tabId != null) post({ kind: 'subscribe' });
}

function onMessage(msg) {
  if (msg.kind === 'state' && msg.tabId === tabId) {
    state = msg.state;
    if (state.pageUrl) tabUrl = state.pageUrl;
    scheduleRender();
  } else if (msg.kind === 'detail') {
    details.set(msg.id, msg.entry);
    scheduleRender();
  } else if (msg.kind === 'export' && msg.data) {
    const blob = new Blob([JSON.stringify(msg.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `outboundxray-${hostname(msg.data.pageUrl) || 'page'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}

// ----------------------------------------------------------- tab tracking

function setTab(tab) {
  if (!tab) return;
  if (tab.id !== tabId) {
    state = null;
    details.clear();
    ui.openGroups.clear();
    ui.openRows.clear();
    ui.filter.group = null;
  }
  tabId = tab.id;
  tabUrl = tab.url || tab.pendingUrl || '';
  subscribe();
  scheduleRender();
}

async function init() {
  connect();
  if (pinnedTab != null) {
    setTab(await chrome.tabs.get(pinnedTab));
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    setTab(tab);
    const win = await chrome.windows.getCurrent();
    chrome.tabs.onActivated.addListener(async (info) => {
      if (info.windowId === win.id) setTab(await chrome.tabs.get(info.tabId));
    });
  }
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (id === tabId && info.url) { tabUrl = info.url; scheduleRender(); }
  });
}

// --------------------------------------------------------------- render

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    // Don't wipe out a text selection the user is making; try again shortly.
    if (String(window.getSelection()).length) { setTimeout(scheduleRender, 1000); return; }
    render();
  });
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function render() {
  const watching = !!state?.watching;
  const entries = state?.entries || [];
  const summary = summarize({ pageUrl: tabUrl, entries });

  $('#status').className = `status${watching ? ' on' : ''}`;
  $('#status').innerHTML = `<span class="dot"></span>${watching ? 'Scanning' : 'Not scanning'}`;

  const restricted = RESTRICTED.test(tabUrl);
  $('#site').innerHTML = `
    <span class="host" title="${esc(tabUrl)}">${esc(hostname(tabUrl) || 'No page')}</span>
    ${watching
      ? '<button class="btn" data-act="stop">Stop</button>'
      : (entries.length && !restricted ? '<button class="btn primary" data-act="start">Scan again</button>' : '')}`;

  $('#detailsCount').textContent = entries.length ? `(${entries.length})` : '';
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === ui.view));
  $('#summaryView').hidden = ui.view !== 'summary';
  $('#detailsView').hidden = ui.view !== 'details';

  if (ui.view === 'summary') $('#summaryView').innerHTML = renderSummary(summary, watching, restricted);
  else renderDetails(summary);
}

function renderMessages() {
  return (state?.error ? `<div class="error">${esc(state.error)}</div>` : '') +
    (state?.notice ? `<div class="notice">${esc(state.notice)}</div>` : '');
}

function renderIntro(restricted) {
  if (restricted) {
    return `<div class="card intro"><h2>This page can’t be scanned</h2>
      <p>Chrome doesn’t let extensions look inside its own pages (like settings, new tabs or the Web Store). Open a normal website to use OutboundXray.</p></div>`;
  }
  return `<div class="card intro">
    <h2>See what this page sends about you</h2>
    <p>OutboundXray reloads the page and watches every piece of data it sends out: to the site itself, and to advertisers, analytics tools and other companies hidden in the page.</p>
    <button class="btn primary big" data-act="start">Start scanning (reloads the page)</button>
    <div class="note"><strong>About the bar at the top of Chrome:</strong> while scanning, Chrome shows “OutboundXray started debugging this browser”. That is expected; it is how OutboundXray can read the data. Everything stays on your computer. Click <em>Stop</em> (or <em>Cancel</em> on that bar) to end the scan.</div>
    <div class="center"><button class="link" data-act="start-noreload">Start without reloading</button></div>
  </div>`;
}

function renderSummary(summary, watching, restricted) {
  const entries = state?.entries || [];
  if (!watching && !entries.length) return renderMessages() + renderIntro(restricted);

  const level = summary.verdict.level;
  const typedNote = watching && state.typedFields?.length
    ? ` · checking ${plural(state.typedFields.length, 'thing')} you typed`
    : '';

  let html = renderMessages() + `
    <div class="card">
      <span class="verdict lvl-${level}">${esc(summary.verdict.text)}</span>
      <p class="headline">${esc(summary.headline)}</p>
      <div class="stats">${summary.totals.requests} pieces of data sent · ${summary.totals.thirdPartyRequests} to other companies${typedNote}</div>
    </div>`;

  if (summary.alerts.length) {
    html += '<h3>Worth knowing</h3>' + summary.alerts.map((a) => `
      <div class="alert lvl-${a.severity}">
        <span class="icon">!</span>
        <span>${esc(a.text)}</span>
        ${a.group ? `<button class="link" data-act="show-group" data-group="${esc(a.group)}">Details</button>` : ''}
      </div>`).join('');
  }

  html += renderOverview(summary.overview);

  const third = summary.groups.filter((g) => g.party === 'third');
  const site = summary.groups.find((g) => g.party === 'first');
  if (third.length) html += '<h3>Who received data</h3>' + third.map(renderGroup).join('');
  const unseen = summary.groups.filter((g) => g.party === 'unknown');
  if (unseen.length) html += '<h3>Couldn’t tell who received this</h3>' + unseen.map(renderGroup).join('');
  if (site) html += '<h3>The website itself</h3>' + renderGroup(site);

  html += `<p class="ip-note">Every company the page contacts can see your IP address, which reveals your rough location and internet provider.</p>`;
  return html;
}

const requestsText = (n) => plural(n, 'request');

// One "What they received" line: the kind, then how many requests carried it
// and which fields (names only, never values).
function renderReceived(item) {
  const fields = item.fields?.length
    ? item.fields.join(', ') + (item.moreFields ? ` +${item.moreFields} more` : '')
    : '';
  const meta = [item.requests ? requestsText(item.requests) : '', fields].filter(Boolean).join(' · ');
  return `<li>${esc(item.text)}${meta ? `<small class="evidence">${esc(meta)}</small>` : ''}</li>`;
}

function renderOverview(overview) {
  if (!overview.length) return '';
  return '<h3>What left this page</h3><div class="card overview"><ul>' + overview.map((o) => `
    <li>
      <span class="sev sev-${o.severity}"></span>
      <span class="kind">${esc(o.label)}<small>to ${esc(o.to)} · ${esc(requestsText(o.requests))}</small></span>
    </li>`).join('') + '</ul></div>';
}

function renderGroup(g) {
  const sub = g.party === 'first'
    ? requestsText(g.requests)
    : [g.products.join(', '), requestsText(g.requests)].filter(Boolean).join(' · ');
  return `
    <details class="card group" data-group="${esc(g.key)}" ${ui.openGroups.has(g.key) ? 'open' : ''}>
      <summary>
        <span class="sev sev-${g.severity}"></span>
        <span class="gname">${esc(g.name)}<small>${esc(sub)}</small></span>
        <span class="cat">${esc(g.categoryLabel)}</span>
      </summary>
      <div class="gbody">
        <p>${esc(g.categoryPlain)}</p>
        <strong>What they received</strong>
        <ul class="received">${g.received.map(renderReceived).join('')}</ul>
        <button class="link" data-act="show-group" data-group="${esc(g.key)}">See the ${requestsText(g.requests)} →</button>
      </div>
    </details>`;
}

// -------------------------------------------------------------- details

function matchesFilter(e) {
  const f = ui.filter;
  if (f.group && groupKey(e) !== f.group) return false;
  if (f.third && e.party !== 'third') return false;
  if (f.data && !e.findings.length) return false;
  if (f.flagged && !e.findings.some((x) => HIGH_KINDS.has(x.kind))) return false;
  if (f.text) {
    const hay = `${e.url} ${e.company} ${e.owner} ${e.type} ${e.findings.map((x) => KINDS[x.kind]?.short).join(' ')}`.toLowerCase();
    if (!hay.includes(f.text)) return false;
  }
  return true;
}

function flagClass(kind) {
  return HIGH_KINDS.has(kind) ? 'f-high' : MEDIUM_KINDS.has(kind) ? 'f-medium' : '';
}

function renderDetails(summary) {
  const entries = state?.entries || [];
  const groupName = ui.filter.group && summary.groups.find((g) => g.key === ui.filter.group)?.name;
  $('#groupChip').innerHTML = groupName
    ? `<button class="chip active" data-act="clear-group">${esc(groupName)} ✕</button>`
    : '';

  const shown = entries.filter(matchesFilter);
  if (!entries.length) {
    $('#rows').innerHTML = `<div class="empty">${state?.watching ? 'Waiting for the page to send something…' : 'Start a scan from the Summary tab to see each request here.'}</div>`;
    return;
  }
  if (!shown.length) {
    $('#rows').innerHTML = '<div class="empty">No requests match these filters.</div>';
    return;
  }
  const start = state.startedAt || entries[0].ts;
  $('#rows').innerHTML = shown.slice().reverse().map((e) => renderRow(e, start)).join('') +
    (state.dropped ? `<div class="empty">${state.dropped} older requests were dropped to save memory.</div>` : '');
}

function renderRow(e, start) {
  const open = ui.openRows.has(e.id);
  const t = `+${Math.max(0, (e.ts - start) / 1000).toFixed(1)}s`;
  let path = e.url;
  try { const u = new URL(e.url); path = u.host + u.pathname; } catch { /* keep raw */ }
  const who = e.party === 'first' ? 'this site' : e.company;
  const flags = e.findings
    .slice()
    .sort((a, b) => (KINDS[b.kind]?.rank || 0) - (KINDS[a.kind]?.rank || 0))
    .map((f) => `<span class="flag ${flagClass(f.kind)}">${esc(KINDS[f.kind]?.short || f.kind)}${f.field ? `: ${esc(f.field)}` : ''}</span>`)
    .join('');
  const method = e.type === 'WebSocket' ? `WS ×${e.frameCount || 0}` : e.method;
  return `
    <div class="row ${e.party}${e.failed ? ' failed' : ''}" data-id="${esc(e.id)}">
      <div class="row-head" data-act="toggle-row" data-id="${esc(e.id)}">
        <span class="t">${t}</span>
        <span class="addr" title="${esc(e.url)}"><span class="m">${esc(method)}</span>${esc(path)}</span>
        <span class="who">${esc(who)}</span>
        ${flags ? `<span class="flags">${flags}</span>` : ''}
      </div>
      ${open ? renderDetail(e) : ''}
    </div>`;
}

function prettyBody(body) {
  if (!body) return null;
  if (body.encoding === 'binary') return `[binary data, ${body.size} bytes]\n${body.preview || ''}`;
  try { return JSON.stringify(JSON.parse(body.text), null, 2); } catch { return body.text; }
}

function renderDetail(light) {
  const d = details.get(light.id);
  if (!d) return '<div class="detail">Loading…</div>';
  const cat = CATEGORIES[d.category];
  const plainFindings = d.findings.map((f) => KINDS[f.kind]?.label + (f.field ? ` (“${f.field}”${f.hash ? `, as ${f.hash} hash` : ''})` : '')).filter(Boolean);
  const to = d.party === 'first' ? 'the website itself' : `${d.company}${d.owner && d.owner !== d.company ? ` (${d.owner})` : ''}`;

  const flaggedKeys = new Set(d.findings.flatMap((f) => f.details || []));
  const fields = d.fields?.length
    ? `<table class="kv">${d.fields.map((f) => `<tr class="${flaggedKeys.has(f.key) ? 'hit' : ''}"><td>${esc(f.key)}</td><td>${esc(f.value)}</td></tr>`).join('')}</table>`
    : '<p class="plain">No named fields.</p>';
  const body = prettyBody(d.body);
  const headers = Object.entries(d.headers || {})
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(/^cookie$/i.test(k) ? `${String(v).split(';').length} cookie(s), values hidden` : v)}</td></tr>`).join('');

  return `<div class="detail">
    <h4>In plain words</h4>
    <p class="plain">Sent to <strong>${esc(to)}</strong>${cat ? ` · ${esc(cat.label)}` : ''}.
      ${plainFindings.length ? `It carried: ${esc(plainFindings.join('; '))}.` : 'Nothing identifying was spotted in it.'}</p>
    <h4>Address</h4>
    <pre class="code">${esc(d.url)}</pre>
    <h4>Status</h4>
    <p class="plain">${esc(d.failed || d.status || 'pending')} · ${esc(d.type)}${d.frame !== 'page' ? ` · from a ${esc(d.frame)}${d.frameUrl ? ` (${esc(hostname(d.frameUrl))})` : ''}` : ''}</p>
    ${d.initiator ? `<h4>Sent by script</h4><pre class="code">${esc(d.initiator)}</pre>` : ''}
    <h4>Data fields</h4>
    ${fields}
    ${body != null ? `<h4>Body${d.body.encoding !== 'text' ? ` (${esc(d.body.encoding)}, decoded)` : ''}${d.body.truncated ? ', truncated' : ''}</h4><pre class="code">${esc(body)}</pre>` : ''}
    ${d.cookies?.length ? `<h4>Cookies sent</h4><p class="plain">${esc(d.cookies.map((c) => c.name).join(', '))}</p>` : ''}
    ${headers ? `<h4>Request headers</h4><table class="kv">${headers}</table>` : ''}
  </div>`;
}

// --------------------------------------------------------------- events

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act], .tabs button');
  if (!el) return;
  if (el.matches('.tabs button')) { ui.view = el.dataset.view; render(); return; }
  switch (el.dataset.act) {
    case 'start': post({ kind: 'start', reload: true }); break;
    case 'start-noreload': post({ kind: 'start', reload: false }); break;
    case 'stop': post({ kind: 'stop' }); break;
    case 'show-group':
      ev.preventDefault();
      ui.filter.group = el.dataset.group;
      ui.view = 'details';
      render();
      window.scrollTo(0, 0);
      break;
    case 'clear-group': ui.filter.group = null; render(); break;
    case 'toggle-row': {
      const id = el.dataset.id;
      if (ui.openRows.has(id)) ui.openRows.delete(id);
      else { ui.openRows.add(id); post({ kind: 'detail', id }); }
      render();
      break;
    }
  }
});

// Remember which company cards are expanded across re-renders.
document.addEventListener('toggle', (ev) => {
  const g = ev.target.closest?.('details.group');
  if (!g) return;
  if (g.open) ui.openGroups.add(g.dataset.group); else ui.openGroups.delete(g.dataset.group);
}, true);

$('#search').addEventListener('input', (ev) => { ui.filter.text = ev.target.value.trim().toLowerCase(); render(); });
for (const [id, key] of [['#fThird', 'third'], ['#fData', 'data'], ['#fFlagged', 'flagged']]) {
  $(id).addEventListener('change', (ev) => {
    ui.filter[key] = ev.target.checked;
    ev.target.closest('.chip').classList.toggle('active', ev.target.checked);
    render();
  });
}
$('#exportBtn').addEventListener('click', () => post({ kind: 'export' }));
$('#clearBtn').addEventListener('click', () => { details.clear(); ui.openRows.clear(); post({ kind: 'clear' }); });

init();
