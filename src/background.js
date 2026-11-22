// OutboundXray service worker.
//
// Watches one tab at a time (per tab you start it on) through Chrome's DevTools
// protocol (chrome.debugger). That is what makes Chrome show its
// "OutboundXray started debugging this browser" bar: it is the only extension API
// that sees full request bodies, WebSocket messages and requests from
// cross-site iframes. Everything stays in this worker's memory.
//
// Background watch (src/autowatch.js) is the optional always-on, lighter view of
// every other tab, built from chrome.webRequest instead.

import { classify } from './lib/trackers.js';
import { createAutoWatch } from './autowatch.js';
import { hostOf } from './lib/domains.js';
import { summarize } from './lib/summary.js';
import {
  analyzeRequest, buildHaystack, buildNeedles, decodeBody, decodeBytes,
  extractFields, matchTyped, mergeTypedFindings,
} from './lib/analyze.js';

const DEBUG = false; // flip to true and filter the worker console by [OutboundXray]
const log = (...args) => { if (DEBUG) console.log('[OutboundXray]', ...args); };

const PROTOCOL_VERSION = '1.3';
const MAX_ENTRIES = 1000;
const MAX_TYPED = 30;
const MAX_INTERACTIONS = 200;
const MAX_WS_FRAMES = 50;
const MAX_PENDING_EXTRA = 500;
const PUSH_DELAY_MS = 300;
const WS_ANALYZE_DELAY_MS = 500;
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
const NETWORK_ENABLE = { maxPostDataSize: 1_000_000 };
const UNSEEN_SOCKET = 'A live connection opened before the scan';
const UNSEEN_SOCKET_URL = 'wss://unseen-connection.invalid/';

const tabs = new Map();   // tabId -> TabState
const panels = new Set(); // { port, tabId }

// -------------------------------------------------------------------- state

function newTabState(tabId, pageUrl = '') {
  return {
    tabId,
    watching: false,
    pageUrl,
    startedAt: Date.now(),
    mainFrameId: null,
    entries: [],
    byKey: new Map(),        // sessionId+requestId -> latest entry
    pendingExtra: new Map(), // extra-info events that arrived before their request
    sockets: new Map(),      // sessionId+requestId -> { url, entry }
    sessions: new Map(),     // child CDP sessions (iframes, workers)
    typed: [],
    interactions: [],
    seq: 0,
    dropped: 0,
    notice: null,
    error: null,
  };
}

function resetPage(st, url) {
  st.entries = [];
  st.byKey.clear();
  st.pendingExtra.clear();
  // Sockets can outlive the page (e.g. ones held by a worker): keep their
  // addresses so later messages are still attributed, but start new entries.
  for (const socket of st.sockets.values()) socket.entry = null;
  st.pageUrl = url;
  st.startedAt = Date.now();
  st.dropped = 0;
  st.notice = null;
}

function addEntry(st, entry) {
  st.entries.push(entry);
  st.byKey.set(entry.key, entry);
  if (st.entries.length > MAX_ENTRIES) {
    const old = st.entries.shift();
    if (st.byKey.get(old.key) === old) st.byKey.delete(old.key);
    st.dropped++;
  }
  markDirty(st);
}

function analyzeEntry(st, entry) {
  const bodyText = entry.body?.text || '';
  entry.haystack = buildHaystack(entry.url, bodyText);
  entry.findings = analyzeRequest(
    { url: entry.url, bodyText, haystack: entry.haystack, cookies: entry.cookies, party: entry.party },
    { pageUrl: st.pageUrl },
  );
  entry.typedFindings = matchTyped(entry.haystack, st.typed, entry.ts, st.interactions);
  markDirty(st);
}

function initiatorUrl(initiator) {
  if (!initiator) return null;
  return initiator.url || initiator.stack?.callFrames?.find((f) => f.url)?.url || null;
}

function makeEntry(st, sid, key, { url, method, type, ts, headers, initiator }) {
  const session = sid ? st.sessions.get(sid) : null;
  return {
    id: String(++st.seq),
    key,
    ts,
    url,
    method,
    type,
    host: hostOf(url),
    ...classify(hostOf(url), hostOf(st.pageUrl)),
    status: null,
    failed: null,
    headers: headers || {},
    cookies: [],
    body: null,
    initiator,
    frame: session ? session.type : 'page',
    frameUrl: session?.url,
    findings: [],
    typedFindings: [],
    haystack: '',
  };
}

// ----------------------------------------------------------- CDP handlers

async function onRequest(st, sid, p) {
  const { request } = p;
  if (!/^(https?|wss?):/i.test(request.url)) return;
  const key = sid + p.requestId;

  if (p.redirectResponse) {
    const prev = st.byKey.get(key);
    if (prev) prev.status = p.redirectResponse.status;
  } else if (!sid && p.type === 'Document' && p.frameId === st.mainFrameId) {
    resetPage(st, request.url); // a new page loaded in this tab
  }

  const entry = makeEntry(st, sid, key, {
    url: request.url,
    method: request.method,
    type: p.type || 'Other',
    ts: p.wallTime ? Math.round(p.wallTime * 1000) : Date.now(),
    headers: request.headers,
    initiator: initiatorUrl(p.initiator),
  });
  addEntry(st, entry);

  const extra = st.pendingExtra.get(key);
  if (extra) { applyExtra(entry, extra); st.pendingExtra.delete(key); }

  if (request.hasPostData) {
    entry.body = await decodeBody(request.postData, request.postDataEntries);
    if (!entry.body) {
      try {
        const res = await send(st.tabId, sid, 'Network.getRequestPostData', { requestId: p.requestId });
        entry.body = await decodeBody(res.postData);
      } catch (err) {
        log('post data unavailable', request.url, err.message);
      }
    }
  }
  analyzeEntry(st, entry);
}

function applyExtra(entry, p) {
  entry.cookies = (p.associatedCookies || [])
    .filter((c) => !c.blockedReasons?.length)
    .map((c) => ({ name: c.cookie.name, domain: c.cookie.domain }));
  if (p.headers) entry.headers = { ...entry.headers, ...p.headers };
}

function onExtraInfo(st, sid, p) {
  const key = sid + p.requestId;
  const entry = st.byKey.get(key);
  if (entry) {
    applyExtra(entry, p);
    analyzeEntry(st, entry);
  } else if (st.pendingExtra.size < MAX_PENDING_EXTRA) {
    st.pendingExtra.set(key, p);
  }
}

function onResponse(st, sid, p) {
  const entry = st.byKey.get(sid + p.requestId);
  if (entry) { entry.status = p.response.status; markDirty(st); }
}

function onFailed(st, sid, p) {
  const entry = st.byKey.get(sid + p.requestId);
  if (entry) {
    entry.failed = p.blockedReason ? `blocked (${p.blockedReason})` : (p.canceled ? 'canceled' : p.errorText);
    markDirty(st);
  }
}

// WebSockets: one entry per socket, holding its most recent outgoing messages.
async function onWsFrame(st, sid, p) {
  const key = sid + p.requestId;
  const socket = st.sockets.get(key) || { url: null, entry: null };
  st.sockets.set(key, socket);
  if (!socket.entry) {
    socket.entry = makeEntry(st, sid, `${key}:ws`, {
      url: socket.url || UNSEEN_SOCKET_URL, method: 'SEND', type: 'WebSocket', ts: Date.now(),
    });
    if (!socket.url) {
      // Opened before the scan started, so Chrome never told us its address.
      Object.assign(socket.entry, { party: 'unknown', category: 'unseen', owner: UNSEEN_SOCKET, company: UNSEEN_SOCKET, site: UNSEEN_SOCKET });
      log('[OX-WS] message on a socket opened before the scan', { sid, target: st.sessions.get(sid) || 'page' });
    }
    socket.entry.frames = [];
    socket.entry.frameCount = 0;
    addEntry(st, socket.entry);
  }
  const entry = socket.entry;
  const { opcode, payloadData = '' } = p.response;
  let text = payloadData;
  if (opcode === 2) {
    const decoded = await decodeBytes(Uint8Array.from(atob(payloadData), (c) => c.charCodeAt(0))).catch(() => null);
    text = decoded?.text || `[binary message, ${Math.round(payloadData.length * 0.75)} bytes]`;
  }
  entry.frames.push(text.slice(0, 8192));
  if (entry.frames.length > MAX_WS_FRAMES) entry.frames.shift();
  entry.frameCount++;
  entry.body = { text: entry.frames.join('\n'), encoding: 'text', size: (entry.body?.size || 0) + payloadData.length, truncated: entry.frameCount > MAX_WS_FRAMES };
  if (!entry.analyzeTimer) {
    entry.analyzeTimer = setTimeout(() => { entry.analyzeTimer = null; analyzeEntry(st, entry); }, WS_ANALYZE_DELAY_MS);
  }
}

async function onAttachedTarget(source, p) {
  const st = tabs.get(source.tabId);
  if (!st) return;
  const child = { tabId: source.tabId, sessionId: p.sessionId };
  st.sessions.set(p.sessionId, { type: p.targetInfo.type, url: p.targetInfo.url });
  try {
    await chrome.debugger.sendCommand(child, 'Network.enable', NETWORK_ENABLE);
    await chrome.debugger.sendCommand(child, 'Target.setAutoAttach', AUTO_ATTACH).catch(() => {});
  } catch (err) {
    log('could not watch child target', p.targetInfo.type, err.message);
  } finally {
    if (p.waitingForDebugger) chrome.debugger.sendCommand(child, 'Runtime.runIfWaitingForDebugger').catch(() => {});
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const st = tabs.get(source.tabId);
  if (!st?.watching) return;
  const sid = source.sessionId || '';
  switch (method) {
    case 'Network.requestWillBeSent': onRequest(st, sid, params).catch((e) => log('request error', e)); break;
    case 'Network.requestWillBeSentExtraInfo': onExtraInfo(st, sid, params); break;
    case 'Network.responseReceived': onResponse(st, sid, params); break;
    case 'Network.loadingFailed': onFailed(st, sid, params); break;
    case 'Network.webSocketCreated': st.sockets.set(sid + params.requestId, { url: params.url, entry: null }); break;
    case 'Network.webSocketFrameSent': onWsFrame(st, sid, params).catch((e) => log('ws error', e)); break;
    case 'Target.attachedToTarget': onAttachedTarget(source, params); break;
    case 'Target.detachedFromTarget': st.sessions.delete(params.sessionId); break;
    case 'Page.frameNavigated':
      if (!sid && !params.frame.parentId) { st.mainFrameId = params.frame.id; st.pageUrl = params.frame.url; markDirty(st); }
      break;
    case 'Page.navigatedWithinDocument':
      if (!sid && params.frameId === st.mainFrameId) { st.pageUrl = params.url; markDirty(st); }
      break;
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const st = tabs.get(source.tabId);
  if (!st || source.sessionId) return;
  stopLocally(st, reason === 'canceled_by_user'
    ? 'You closed Chrome’s debugging bar, so OutboundXray stopped watching.'
    : 'OutboundXray stopped watching (the tab was closed, replaced, or opened DevTools exclusively).');
});

// ------------------------------------------------------ start / stop

function send(tabId, sessionId, method, params) {
  const target = sessionId ? { tabId, sessionId } : { tabId };
  return chrome.debugger.sendCommand(target, method, params);
}

function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/chrome:\/\/|chrome-extension:|webstore|Cannot access|Cannot attach/i.test(msg)) {
    return 'Chrome does not let extensions look inside this page (built-in chrome:// pages, the Chrome Web Store, and other extensions are off-limits).';
  }
  if (/Another debugger/i.test(msg)) return 'Another extension or tool is already inspecting this tab. Close it and try again.';
  return `Could not start watching: ${msg}`;
}

async function startWatching(tabId, { reload = true } = {}) {
  auto.handOver(tabId);
  const tab = await chrome.tabs.get(tabId);
  const prev = tabs.get(tabId);
  const st = newTabState(tabId, tab.url);
  tabs.set(tabId, st);
  if (prev?.watching) st.watching = true; // re-start on an already attached tab

  try {
    if (!st.watching) await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    st.watching = true;
    await send(tabId, null, 'Network.enable', NETWORK_ENABLE);
    await send(tabId, null, 'Page.enable');
    const { frameTree } = await send(tabId, null, 'Page.getFrameTree');
    st.mainFrameId = frameTree.frame.id;
    await send(tabId, null, 'Target.setAutoAttach', AUTO_ATTACH).catch((e) => log('auto-attach unavailable', e.message));
    await saveWatchedTabs();
    notifyContent(tabId, true);
    if (reload) await send(tabId, null, 'Page.reload', {});
  } catch (err) {
    log('start failed', err);
    st.watching = false;
    st.error = friendlyError(err);
    chrome.debugger.detach({ tabId }).catch(() => {});
  }
  markDirty(st);
}

function stopLocally(st, notice) {
  st.watching = false;
  st.typed = [];          // forget typed values as soon as watching stops
  st.interactions = [];
  st.notice = notice || null;
  notifyContent(st.tabId, auto.isEnabled()); // background watch keeps listening if it's on
  saveWatchedTabs();
  markDirty(st);
}

async function stopWatching(tabId) {
  const st = tabs.get(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  if (st) stopLocally(st, null);
}

function notifyContent(tabId, watched) {
  chrome.tabs.sendMessage(tabId, { kind: 'watch', watched }).catch(() => {});
}

async function saveWatchedTabs() {
  const watched = [...tabs.values()].filter((s) => s.watching).map((s) => s.tabId);
  await chrome.storage.session.set({ watched }).catch(() => {});
}

// If Chrome restarted this worker while a tab was still attached, pick it back up.
async function restoreWatchedTabs() {
  const { watched = [] } = await chrome.storage.session.get('watched').catch(() => ({}));
  if (!watched.length) return;
  const targets = await chrome.debugger.getTargets();
  for (const tabId of watched) {
    if (!targets.some((t) => t.tabId === tabId && t.attached)) continue;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) continue;
    const st = newTabState(tabId, tab.url);
    st.watching = true;
    st.notice = 'OutboundXray restarted in the background; activity before that moment was cleared.';
    tabs.set(tabId, st);
    const { frameTree } = await send(tabId, null, 'Page.getFrameTree').catch(() => ({}));
    st.mainFrameId = frameTree?.frame?.id || null;
    markDirty(st);
  }
}

// ------------------------------------------------- typed values & clicks

async function onTyped(tabId, msg) {
  const st = tabs.get(tabId);
  if (!st?.watching) return;
  const value = String(msg.value || '').trim();
  if (value.length < 4 || value.length > 200 || st.typed.some((t) => t.value === value)) return;
  const typed = { value, field: String(msg.field || 'a text field').slice(0, 60), at: Date.now(), needles: await buildNeedles(value) };
  st.typed.push(typed);
  if (st.typed.length > MAX_TYPED) st.typed.shift();
  // Check requests that already left: keystroke recorders often send before we hear about the value.
  for (const entry of st.entries) {
    const hits = matchTyped(entry.haystack, [typed], entry.ts, st.interactions);
    if (hits.length) entry.typedFindings = mergeTypedFindings(entry.typedFindings, hits);
  }
  markDirty(st);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  const st = tabs.get(tabId);
  if (msg?.kind === 'hello') {
    auto.ready.then(() => sendResponse({ watched: !!st?.watching || auto.isEnabled() }));
    return true; // answered asynchronously
  } else if (msg?.kind === 'typed') {
    if (st?.watching) onTyped(tabId, msg); else auto.onTyped(tabId, msg);
  } else if (msg?.kind === 'interaction') {
    if (st?.watching) {
      st.interactions.push(Date.now());
      if (st.interactions.length > MAX_INTERACTIONS) st.interactions.shift();
    } else {
      auto.onInteraction(tabId);
    }
  }
});

// ---------------------------------------------------------- side panel

function lightEntry(e) {
  return {
    id: e.id,
    ts: e.ts,
    url: e.url.length > 400 ? `${e.url.slice(0, 400)}…` : e.url,
    method: e.method,
    type: e.type,
    host: e.host,
    site: e.site,
    party: e.party,
    company: e.company,
    owner: e.owner,
    category: e.category,
    status: e.status,
    failed: e.failed,
    size: e.body?.size || 0,
    cookieCount: e.cookies.length,
    frame: e.frame,
    frameCount: e.frameCount,
    findings: [...e.findings, ...e.typedFindings],
  };
}

function lightState(tabId) {
  const st = tabs.get(tabId);
  if (!st) return { watching: false, entries: [] };
  return {
    watching: st.watching,
    pageUrl: st.pageUrl,
    startedAt: st.startedAt,
    notice: st.notice,
    error: st.error,
    dropped: st.dropped,
    typedFields: [...new Set(st.typed.map((t) => t.field))],
    entries: st.entries.map(lightEntry),
  };
}

// Background watch keeps no bodies or headers; fields come from the address only.
function passiveDetail(e) {
  return { ...e, headers: {}, cookies: [], body: null, fields: extractFields(e.url, '').slice(0, 300) };
}

function fullEntry(e) {
  const { haystack, key, analyzeTimer, ...rest } = e;
  return { ...rest, findings: [...e.findings, ...e.typedFindings], fields: extractFields(e.url, e.body?.text).slice(0, 300) };
}

// The panel shows a tab's scan when it has one (running, or finished with
// results), and otherwise the background-watch view when that is on.
async function stateOf(tabId) {
  const st = tabs.get(tabId);
  const hasScan = !!st && (st.watching || st.entries.length || st.error || st.notice);
  const state = (!hasScan && await auto.stateFor(tabId)) || lightState(tabId);
  return { ...state, autoWatch: auto.isEnabled() };
}

const pushTimers = new Map(); // tabId -> pending push
function pushTab(tabId) {
  if (pushTimers.has(tabId)) return;
  pushTimers.set(tabId, setTimeout(async () => {
    pushTimers.delete(tabId);
    const state = await stateOf(tabId);
    for (const sub of panels) if (sub.tabId === tabId) sub.port.postMessage({ kind: 'state', tabId, state });
    updateBadge(tabId, state);
  }, PUSH_DELAY_MS));
}

function markDirty(st) {
  pushTab(st.tabId);
}

const BADGE_COLORS = { high: '#d93025', medium: '#e37400', low: '#5f6368', none: '#5f6368' };

// Scanning: number of other companies, coloured by the verdict. Background
// watch: the same, but no badge until some other company has received data.
function updateBadge(tabId, state) {
  const summary = (state.watching || state.passive) ? summarize(state) : null;
  if (!summary || (state.passive && !summary.totals.companies)) {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    return;
  }
  chrome.action.setBadgeText({ tabId, text: String(summary.totals.companies) }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLORS[summary.verdict.level] }).catch(() => {});
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'outboundxray-panel') return;
  const sub = { port, tabId: null };
  panels.add(sub);
  port.onDisconnect.addListener(() => panels.delete(sub));
  port.onMessage.addListener(async (msg) => {
    const st = tabs.get(msg.tabId);
    switch (msg.kind) {
      case 'subscribe':
        sub.tabId = msg.tabId;
        port.postMessage({ kind: 'state', tabId: msg.tabId, state: await stateOf(msg.tabId) });
        break;
      case 'setAuto':
        await setAutoWatch(!!msg.on);
        break;
      case 'start':
        await startWatching(msg.tabId, { reload: msg.reload !== false });
        break;
      case 'stop':
        await stopWatching(msg.tabId);
        break;
      case 'clear':
        if (st) { resetPage(st, st.pageUrl); markDirty(st); } else { auto.forget(msg.tabId); pushTab(msg.tabId); }
        break;
      case 'detail': {
        const entry = st?.entries.find((e) => e.id === msg.id);
        const passive = !entry && (await stateOf(msg.tabId)).passive
          ? (await auto.stateFor(msg.tabId))?.entries.find((e) => e.id === msg.id)
          : null;
        port.postMessage({ kind: 'detail', id: msg.id, entry: entry ? fullEntry(entry) : (passive ? passiveDetail(passive) : null) });
        break;
      }
      case 'export': {
        const state = await stateOf(msg.tabId);
        const requests = state.passive ? state.entries.map(passiveDetail) : (st?.entries.map(fullEntry) || []);
        port.postMessage({
          kind: 'export',
          data: requests.length || st ? { exportedAt: new Date().toISOString(), pageUrl: state.pageUrl, backgroundWatch: !!state.passive, requests } : null,
        });
        break;
      }
    }
  });
});

// ------------------------------------------------------------- lifecycle

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  auto.forget(tabId);
  saveWatchedTabs();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

restoreWatchedTabs().catch((e) => log('restore failed', e));

// ------------------------------------------------------- background watch

const auto = createAutoWatch({
  isScanning: (tabId) => !!tabs.get(tabId)?.watching,
  onChange: pushTab,
  log,
});

async function setAutoWatch(on) {
  await auto.setEnabled(on);
  // Tell every page's content script whether to report what you type.
  for (const tab of await chrome.tabs.query({})) notifyContent(tab.id, !!tabs.get(tab.id)?.watching || on);
  for (const sub of panels) if (sub.tabId != null) pushTab(sub.tabId);
}

// Registered at the top level so Chrome can wake this worker for it.
chrome.webRequest.onBeforeRequest.addListener((details) => {
  // A finished scan's results stay on screen until the tab moves to a new page.
  if (details.type === 'main_frame' && details.tabId >= 0 && auto.isEnabled() && tabs.get(details.tabId) && !tabs.get(details.tabId).watching) {
    tabs.delete(details.tabId);
  }
  auto.onBeforeRequest(details).catch((e) => log('[OX-AUTO] request error', e.message));
}, { urls: ['<all_urls>'] }, ['requestBody']);

chrome.notifications.onClicked.addListener(async (id) => {
  const tabId = Number(id.replace('outboundxray-', ''));
  chrome.notifications.clear(id).catch(() => {});
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
});

// Handle for debugging from the worker console and for automated tests.
globalThis.outboundXray = { tabs, startWatching, stopWatching, lightState, stateOf, auto };
