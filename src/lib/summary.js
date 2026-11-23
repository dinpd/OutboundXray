// Builds the plain-language summary: who received data from this page, what
// kind of data, and which things deserve your attention.

import { CATEGORIES } from './trackers.js';
import { leafName } from './analyze.js';

export const KINDS = {
  typed:         { rank: 10, short: 'typed text', label: 'Something you typed' },
  typedHashed:   { rank: 9,  short: 'hashed typed text', label: 'A scrambled (hashed) copy of something you typed' },
  email:         { rank: 8,  short: 'email', label: 'An email address' },
  phone:         { rank: 8,  short: 'phone', label: 'A phone number' },
  hashedContact: { rank: 7,  short: 'hashed contact', label: 'A hashed email, phone number or name, used to match you to a real person' },
  location:      { rank: 6,  short: 'location', label: 'Your location' },
  identifier:    { rank: 5,  short: 'ID', label: 'An ID that can recognise you on later visits' },
  cookie:        { rank: 5,  short: 'cookies', label: 'Cookies that can recognise your browser' },
  siteCookie:    { rank: 4,  short: 'site cookies', label: 'Your own cookies for this site (login, settings)' },
  page:          { rank: 3,  short: 'page address', label: 'Which page you are looking at' },
  activity:      { rank: 3,  short: 'activity', label: 'What you do on the page (clicks, scrolls, events)' },
  device:        { rank: 2,  short: 'device info', label: 'Details about your device and browser' },
};

// Kinds that are personal information, and the tracking kinds; the panel colours request flags by these.
export const PERSONAL = ['typed', 'typedHashed', 'email', 'phone', 'hashedContact'];
export const TRACKING = ['identifier', 'cookie', 'location'];
// Contact kinds that "Something you typed" already covers more precisely.
const CONTACT = ['email', 'phone', 'hashedContact'];
// Kinds whose finding details are field names (not values), so they can be
// shown as evidence without echoing your data back. Email details are the
// addresses themselves; typed kinds name the form field separately.
const FIELD_KINDS = new Set(['identifier', 'cookie', 'siteCookie', 'location', 'page', 'activity', 'device', 'phone', 'hashedContact']);
const MAX_FIELDS_SHOWN = 4;
const IP_LINE = 'That you visited this site, plus your IP address (which reveals your rough location)';
const PROFILING_CATEGORIES = new Set(['ads', 'replay', 'social', 'marketing']);
const SEVERITY_RANK = { high: 3, medium: 2, low: 1, none: 0 };

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const weight = (cat) => CATEGORIES[cat]?.weight ?? 0;

function listNames(names, max = 3) {
  if (names.length <= max) return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, max).join(', ')} and ${plural(names.length - max, 'other')}`;
}

// Key of the company card a request belongs to (all first-party requests share one).
export const groupKey = (e) => (e.party === 'first' ? '__site' : (e.owner || e.site || e.host));

function newGroup(key, entry, siteName) {
  const first = entry.party === 'first';
  return {
    key,
    name: first ? siteName : (entry.owner || entry.site || entry.host),
    party: entry.party,
    category: entry.category,
    products: new Set(),
    hosts: new Set(),
    requests: 0,
    bytes: 0,
    kinds: new Map(),
    typed: new Map(),
  };
}

// Field names a finding points at, e.g. "events[0].user_id" -> "user_id",
// and cookie details ("a, b") -> ["a", "b"]. Page-path matches ("/checkout")
// are values, not field names, so they are left out.
function fieldNames(finding) {
  if (!FIELD_KINDS.has(finding.kind)) return [];
  const details = finding.details || [];
  if (finding.kind === 'cookie' || finding.kind === 'siteCookie') return details.flatMap((d) => String(d).split(', '));
  return details.filter((d) => d && !String(d).startsWith('/')).map(leafName);
}

// Adds one request's findings to its group. Each kind counts once per request.
function addFindings(group, findings) {
  const seen = new Set();
  for (const finding of findings) {
    if (finding.kind === 'typed' || finding.kind === 'typedHashed') {
      const t = group.typed.get(finding.field) || { field: finding.field, raw: false, hashed: false, beforeSubmit: false };
      if (finding.kind === 'typed') t.raw = true; else t.hashed = true;
      if (finding.beforeSubmit) t.beforeSubmit = true;
      group.typed.set(finding.field, t);
    }
    const k = group.kinds.get(finding.kind) || { requests: 0, fields: new Set() };
    if (!seen.has(finding.kind)) { k.requests++; seen.add(finding.kind); }
    for (const name of fieldNames(finding)) k.fields.add(name);
    group.kinds.set(finding.kind, k);
  }
}

function severityOf(group) {
  const has = (k) => group.kinds.has(k);
  if (group.party === 'first') {
    return [...group.typed.values()].some((t) => t.beforeSubmit) ? 'medium' : 'none';
  }
  if (PERSONAL.some(has)) return 'high';
  if (PROFILING_CATEGORIES.has(group.category) || TRACKING.some(has)) return 'medium';
  return 'low';
}

// Kinds the summary describes for a group, most sensitive first.
// "Something you typed" already says it more precisely than "an email address".
function visibleKinds(group) {
  const covered = new Set(group.typed.size ? CONTACT : []);
  return [...group.kinds.keys()]
    .filter((k) => KINDS[k] && !covered.has(k))
    .sort((a, b) => KINDS[b].rank - KINDS[a].rank);
}

// "What they received": [{ text, requests?, fields? }] for one group.
function whatTheyGot(group) {
  const typed = [...group.typed.values()];
  const items = visibleKinds(group).map((k) => {
    const { requests, fields } = group.kinds.get(k);
    if (k === 'typed' || k === 'typedHashed') {
      const names = typed.filter((t) => (k === 'typed' ? t.raw : t.hashed)).map((t) => `“${t.field}”`);
      return { text: `${KINDS[k].label}${names.length ? `: ${names.join(', ')}` : ''}`, requests };
    }
    return { text: KINDS[k].label, requests, fields: [...fields].slice(0, MAX_FIELDS_SHOWN), moreFields: Math.max(0, fields.size - MAX_FIELDS_SHOWN) };
  });
  if (group.category === 'replay') items.unshift({ text: 'Possibly a recording of your visit' });
  if (group.party === 'third') items.push({ text: IP_LINE });
  else if (group.party === 'first' && !items.length) items.push({ text: 'Requests for the page and its files, with nothing about you found in them' });
  return items;
}

// "What left this page": each kind, who got it, across all groups.
function overviewOf(list, siteName) {
  const byKind = new Map();
  for (const g of list) {
    for (const k of g.kindKeys) {
      const o = byKind.get(k) || { kind: k, label: KINDS[k].label, companies: [], toSite: false, requests: 0 };
      if (g.party === 'first') o.toSite = true; else o.companies.push(g.name);
      o.requests += g.kindRequests[k];
      byKind.set(k, o);
    }
  }
  return [...byKind.values()]
    .sort((a, b) => KINDS[b.kind].rank - KINDS[a.kind].rank || b.companies.length - a.companies.length)
    .map((o) => {
      const who = [...o.companies];
      if (o.toSite) who.push(`${siteName} itself`);
      return { ...o, severity: o.companies.length ? (PERSONAL.includes(o.kind) ? 'high' : 'medium') : 'none', to: listNames(who) };
    });
}

function typedSentence(name, t) {
  const form = t.raw && t.hashed
    ? ' (as typed, and scrambled into a code that still identifies it)'
    : (t.hashed ? ' (scrambled into a code that still identifies it)' : '');
  return `${name} received what you typed into “${t.field}”${form}` +
    (t.beforeSubmit ? ', before you pressed any button.' : '.');
}

// The page's grade, A (private) to F. Personal information reaching another
// company fails it outright; otherwise each other company costs points by what
// it is, and the total picks the letter. `color` is shared by the panel and the toolbar badge.
const GRADE_POINTS = { replay: 20, profiling: 10, tracking: 5, technical: 1 };
const GRADE_BANDS = [[4, 'A'], [14, 'B'], [39, 'C'], [Infinity, 'D']];
export const GRADES = {
  A: { color: '#188038', level: 'low', text: (companies) => (companies ? 'Light: only technical services' : 'Only talks to the site itself') },
  B: { color: '#4d7c0f', level: 'low', text: () => 'Some tracking' },
  C: { color: '#b45309', level: 'medium', text: () => 'Tracked' },
  D: { color: '#c2410c', level: 'medium', text: () => 'Heavily tracked' },
  F: { color: '#d93025', level: 'high', text: () => 'Personal information left this page' },
};

function companyPoints(g) {
  if (g.category === 'replay') return GRADE_POINTS.replay;
  if (PROFILING_CATEGORIES.has(g.category)) return GRADE_POINTS.profiling;
  if (TRACKING.some((k) => g.kinds.includes(k))) return GRADE_POINTS.tracking;
  return GRADE_POINTS.technical;
}

function gradeOf(third, site) {
  if (third.some((g) => g.severity === 'high')) return 'F';
  const points = third.reduce((sum, g) => sum + companyPoints(g), 0) +
    (site?.typed.some((t) => t.beforeSubmit) ? GRADE_POINTS.tracking : 0);
  return GRADE_BANDS.find(([max]) => points <= max)[1];
}

// `state`: { pageUrl, passive?, fromStart?, entries: [{ party, owner, company, site, host, category, size, findings }] }
export function summarize(state) {
  const entries = state?.entries || [];
  let siteName = 'This site';
  try { siteName = new URL(state.pageUrl).hostname.replace(/^www\./, ''); } catch { /* no page URL */ }

  const groups = new Map();
  for (const e of entries) {
    const key = groupKey(e);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = newGroup(key, e, siteName)));
    g.requests++;
    g.bytes += e.size || 0;
    g.hosts.add(e.host);
    if (e.company && e.company !== g.name && e.party === 'third') g.products.add(e.company);
    if (weight(e.category) > weight(g.category)) g.category = e.category;
    addFindings(g, e.findings || []);
  }

  const list = [...groups.values()].map((g) => ({
    key: g.key,
    name: g.name,
    party: g.party,
    category: g.category,
    categoryLabel: CATEGORIES[g.category]?.label || g.category,
    categoryPlain: CATEGORIES[g.category]?.plain || '',
    products: [...g.products],
    hosts: [...g.hosts],
    requests: g.requests,
    bytes: g.bytes,
    kinds: [...g.kinds.keys()],
    kindKeys: visibleKinds(g),
    kindRequests: Object.fromEntries([...g.kinds].map(([k, v]) => [k, v.requests])),
    typed: [...g.typed.values()],
    severity: severityOf(g),
    received: whatTheyGot(g),
  }));

  list.sort((a, b) =>
    (a.party === 'first') - (b.party === 'first') ||
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    weight(b.category) - weight(a.category) ||
    b.requests - a.requests);

  const third = list.filter((g) => g.party === 'third');
  const site = list.find((g) => g.party === 'first');
  const alerts = [];

  for (const g of third) {
    for (const t of g.typed) alerts.push({ severity: 'high', group: g.key, text: typedSentence(g.name, t) });
    if (!g.typed.length) {
      for (const k of CONTACT) {
        if (g.kinds.includes(k)) alerts.push({ severity: 'high', group: g.key, text: `${g.name} received ${KINDS[k].label.charAt(0).toLowerCase()}${KINDS[k].label.slice(1)}.` });
      }
    }
  }
  for (const t of site?.typed || []) {
    if (t.beforeSubmit) alerts.push({ severity: 'medium', group: '__site', text: typedSentence(`${siteName} itself`, t) });
  }
  for (const g of third.filter((x) => x.category === 'replay')) {
    alerts.push({ severity: 'medium', group: g.key, text: `${g.name} records sessions: it can replay your mouse movements, clicks and scrolling on this page.` });
  }
  const advertisers = third.filter((g) => g.category === 'ads');
  if (advertisers.length) {
    alerts.push({
      severity: 'medium',
      text: `${plural(advertisers.length, 'advertising company', 'advertising companies')} ${advertisers.length === 1 ? 'was' : 'were'} told you are on this page: ${listNames(advertisers.map((g) => g.name))}.`,
    });
  }

  const grade = gradeOf(third, site);
  // A grade needs the whole page load; personal information reaching another
  // company fails it whatever came before.
  const passive = !!state?.passive;
  const graded = (entries.length > 0 || passive) && (!!state?.fromStart || grade === 'F');
  const verdict = graded
    ? { level: GRADES[grade].level, text: GRADES[grade].text(third.length) }
    : { level: 'none', text: entries.length || passive ? 'Not graded: reload the page to check it from the start' : 'Nothing sent yet' };

  const headline = third.length
    ? `This page shared information about your visit with ${plural(third.length, 'other company', 'other companies')}.`
    : passive
      ? (graded ? 'No other company received data from this page.' : 'No other company has received data from this page so far.')
      : entries.length
        ? `So far, this page has only talked to ${siteName} itself.`
        : 'Nothing has been sent yet. Use the page as normal and OutboundXray will show what leaves it.';

  return {
    siteName,
    headline,
    grade: graded ? grade : null,
    verdict,
    alerts,
    overview: overviewOf(list, siteName),
    groups: list,
    totals: {
      requests: entries.length,
      thirdPartyRequests: entries.filter((e) => e.party === 'third').length,
      companies: third.length,
    },
  };
}
