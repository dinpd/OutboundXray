// Background watch ("auto-on"): what can be learned about one outgoing request
// from chrome.webRequest alone, without chrome.debugger and its "debugging this
// browser" bar. Only requests to other companies are kept: that is what the
// toolbar count and colour describe.

import { classify } from './trackers.js';
import { hostOf } from './domains.js';
import { analyzeRequest, buildHaystack, matchTyped } from './analyze.js';
import { PERSONAL } from './summary.js';

export const MAX_PASSIVE_ENTRIES = 300;
// Kept in memory only, to match typed values that arrive after the request left.
const MAX_HAYSTACK_CHARS = 32 * 1024;
const MAX_URL_CHARS = 400;

// chrome.webRequest gives form posts as { name: [values] }.
export function formDataText(formData) {
  const params = new URLSearchParams();
  for (const [name, values] of Object.entries(formData || {})) {
    for (const value of [].concat(values)) params.append(name, String(value));
  }
  return params.toString();
}

// Builds a light entry (the same shape the panel gets from a full scan) for a
// request to another company, or returns null for requests to the site itself.
// `typed`/`interactions` are what the content script reported for this tab.
export function passiveEntry({ id, url, method, type, ts, bodyText = '', size = 0, pageUrl, typed = [], interactions = [] }) {
  const host = hostOf(url);
  const pageHost = hostOf(pageUrl);
  if (!host || !pageHost) return null;
  const who = classify(host, pageHost);
  if (who.party !== 'third') return null;

  const haystack = buildHaystack(url, bodyText);
  const findings = [
    ...analyzeRequest({ url, bodyText, haystack, party: 'third' }, { pageUrl }),
    ...matchTyped(haystack, typed, ts, interactions),
  ];
  return {
    entry: {
      id: String(id),
      ts,
      url: url.length > MAX_URL_CHARS ? `${url.slice(0, MAX_URL_CHARS)}…` : url,
      method,
      type,
      host,
      ...who,
      status: 'sent (seen by background watch)',
      failed: null,
      size,
      cookieCount: 0,
      frame: 'page',
      findings,
    },
    haystack: haystack.slice(0, MAX_HAYSTACK_CHARS),
  };
}

// True when an entry carries personal information (what you typed, an email,
// a phone number or a hashed contact): the case worth a notification.
export function carriesPersonalInfo(entry) {
  return entry.party === 'third' && entry.findings.some((f) => PERSONAL.includes(f.kind));
}
