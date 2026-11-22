// Background watch ("auto-on"): a lighter, always-on view of every tab, built
// from chrome.webRequest so Chrome's "debugging this browser" bar never shows.
// It sees request addresses and bodies (enough to spot what you typed, emails
// and IDs going to other companies) but not cookies, WebSocket messages or
// responses; a full scan still covers those, on demand.
//
// State is kept in memory and mirrored to chrome.storage.session (memory-only,
// cleared when Chrome quits) so it survives the service worker going to sleep.

import { passiveEntry, formDataText, carriesPersonalInfo, MAX_PASSIVE_ENTRIES } from './lib/passive.js';
import { concatBytes, decodeBytes, matchTyped, mergeTypedFindings, newTypedValue, MAX_TYPED, MAX_INTERACTIONS } from './lib/analyze.js';
import { summarize } from './lib/summary.js';

const SETTING = 'autoWatch';
const SAVE_DELAY_MS = 2000;
const storageKey = (tabId) => `auto:${tabId}`;
const NOTIFICATION_PREFIX = 'outboundxray-';
export const notificationId = (tabId) => `${NOTIFICATION_PREFIX}${tabId}`;
export const tabIdOfNotification = (id) => Number(id.replace(NOTIFICATION_PREFIX, ''));

// `isScanning(tabId)`: a full scan owns that tab, so stay out of its way.
// `onChange(tabId)`: push fresh state to the panel and the toolbar badge.
export function createAutoWatch({ isScanning, onChange, log }) {
  let enabled = false;
  const tabs = new Map();      // tabId -> { pageUrl, entries, haystacks, typed, interactions, seq, notified }
  const saveTimers = new Map();

  const ready = chrome.storage.local.get(SETTING)
    .then((s) => { enabled = !!s[SETTING]; })
    .catch(() => {});

  function newTab(pageUrl = '') {
    return { pageUrl, entries: [], haystacks: new Map(), typed: [], interactions: [], seq: 0, notified: false };
  }

  async function getTab(tabId) {
    let t = tabs.get(tabId);
    if (t) return t;
    const saved = (await chrome.storage.session.get(storageKey(tabId)).catch(() => ({})))[storageKey(tabId)];
    t = tabs.get(tabId); // another event may have created it meanwhile
    if (t) return t;
    t = saved ? { ...newTab(), ...saved, haystacks: new Map() } : newTab();
    if (!t.pageUrl) t.pageUrl = (await chrome.tabs.get(tabId).catch(() => null))?.url || '';
    tabs.set(tabId, t);
    return t;
  }

  function save(tabId) {
    if (saveTimers.has(tabId)) return;
    saveTimers.set(tabId, setTimeout(() => {
      saveTimers.delete(tabId);
      const t = tabs.get(tabId);
      if (!t) return;
      const { haystacks, ...rest } = t;
      chrome.storage.session.set({ [storageKey(tabId)]: rest }).catch((e) => log('[OX-AUTO] save failed', e.message));
    }, SAVE_DELAY_MS));
  }

  function forget(tabId) {
    tabs.delete(tabId);
    clearTimeout(saveTimers.get(tabId));
    saveTimers.delete(tabId);
    chrome.storage.session.remove(storageKey(tabId)).catch(() => {});
  }

  function changed(tabId) {
    save(tabId);
    onChange(tabId);
  }

  // One notification per tab per page, the first time personal info leaves it.
  function maybeNotify(tabId, t) {
    if (t.notified || !t.entries.some(carriesPersonalInfo)) return;
    t.notified = true;
    const summary = summarize({ pageUrl: t.pageUrl, entries: t.entries });
    const alert = summary.alerts.find((a) => a.severity === 'high');
    chrome.notifications.create(notificationId(tabId), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Personal information left this page',
      message: alert?.text || `${summary.siteName} shared personal information with another company.`,
      contextMessage: summary.siteName,
      priority: 1,
    }).catch((e) => log('[OX-AUTO] notification failed', e.message));
  }

  async function onBeforeRequest(details) {
    await ready;
    if (!enabled || details.tabId < 0 || isScanning(details.tabId)) return;
    const { tabId, url } = details;
    if (!/^https?:/i.test(url)) return;

    if (details.type === 'main_frame') {
      // A new page in this tab starts a fresh picture (typed values carry over,
      // so "thank you" pages that send your email after a form are still caught).
      const prev = tabs.get(tabId) || await getTab(tabId);
      const t = newTab(url);
      t.typed = prev.typed;
      tabs.set(tabId, t);
      chrome.notifications.clear(notificationId(tabId)).catch(() => {});
      changed(tabId);
      return;
    }

    let bodyText = '';
    let size = 0;
    const body = details.requestBody;
    if (body?.formData) {
      bodyText = formDataText(body.formData);
      size = bodyText.length;
    } else if (body?.raw?.length) {
      const bytes = concatBytes(body.raw.filter((p) => p.bytes).map((p) => new Uint8Array(p.bytes)));
      size = bytes.length;
      if (size) bodyText = (await decodeBytes(bytes).catch(() => null))?.text || '';
    }

    const t = await getTab(tabId);
    const made = passiveEntry({
      id: ++t.seq, url, method: details.method, type: details.type, ts: Math.round(details.timeStamp),
      bodyText, size, pageUrl: t.pageUrl, typed: t.typed, interactions: t.interactions,
    });
    if (!made) return;
    t.entries.push(made.entry);
    t.haystacks.set(made.entry.id, made.haystack);
    if (t.entries.length > MAX_PASSIVE_ENTRIES) t.haystacks.delete(t.entries.shift().id);
    maybeNotify(tabId, t);
    changed(tabId);
  }

  async function onTyped(tabId, msg) {
    await ready;
    if (!enabled) return;
    const t = await getTab(tabId);
    const typed = await newTypedValue(msg, t.typed);
    if (!typed) return;
    t.typed.push(typed);
    if (t.typed.length > MAX_TYPED) t.typed.shift();
    // Keystroke recorders often send before we hear about the value: re-check what already left.
    for (const entry of t.entries) {
      const hits = matchTyped(t.haystacks.get(entry.id), [typed], entry.ts, t.interactions);
      if (hits.length) entry.findings = mergeTypedFindings(entry.findings, hits);
    }
    maybeNotify(tabId, t);
    changed(tabId);
  }

  async function onInteraction(tabId) {
    if (!enabled) return;
    const t = await getTab(tabId);
    t.interactions.push(Date.now());
    if (t.interactions.length > MAX_INTERACTIONS) t.interactions.shift();
  }

  async function setEnabled(on) {
    enabled = !!on;
    await chrome.storage.local.set({ [SETTING]: enabled });
    if (!enabled) {
      // Forget everything background watch collected, including typed values.
      const known = new Set([...tabs.keys()]);
      const all = await chrome.storage.session.get(null).catch(() => ({}));
      for (const key of Object.keys(all)) if (key.startsWith('auto:')) known.add(Number(key.slice(5)));
      for (const tabId of known) {
        forget(tabId);
        chrome.notifications.clear(notificationId(tabId)).catch(() => {});
        onChange(tabId);
      }
    }
    log('[OX-AUTO] background watch', enabled ? 'on' : 'off');
  }

  // What the panel shows for a tab that isn't being fully scanned.
  async function stateFor(tabId) {
    await ready;
    if (!enabled) return null;
    const t = await getTab(tabId);
    return {
      watching: false,
      passive: true,
      pageUrl: t.pageUrl,
      typedFields: [...new Set(t.typed.map((x) => x.field))],
      entries: t.entries,
    };
  }

  // A full scan is taking over this tab: its own data replaces the background view.
  function handOver(tabId) {
    forget(tabId);
  }

  return {
    ready,
    isEnabled: () => enabled,
    setEnabled,
    onBeforeRequest,
    onTyped,
    onInteraction,
    stateFor,
    forget,
    handOver,
  };
}
