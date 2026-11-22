// Turns a raw outgoing request into "findings": the kinds of information it
// carries (an ID, your device details, an email address, something you typed).

import { md5Hex, shaHex } from './hash.js';

export const MAX_BODY_CHARS = 64 * 1024;
const MAX_FIELDS = 400;
const MAX_JSON_DEPTH = 8;

// ---------------------------------------------------------------- body decoding

function base64ToBytes(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function inflate(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Response(stream).text();
}

function capped(text) {
  return text.length > MAX_BODY_CHARS
    ? { text: text.slice(0, MAX_BODY_CHARS), truncated: true }
    : { text, truncated: false };
}

const isGzip = (b) => b[0] === 0x1f && b[1] === 0x8b;
const isZlib = (b) => b[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(b[1]);

// Decodes raw request-body bytes: gzip/deflate-compressed bodies (common for
// session-recording tools) are decompressed so they can be read and searched.
export async function decodeBytes(bytes) {
  const size = bytes.length;
  for (const [test, format, encoding] of [[isGzip, 'gzip', 'gzip'], [isZlib, 'deflate', 'deflate']]) {
    if (!test(bytes)) continue;
    try {
      return { ...capped(await inflate(bytes, format)), encoding, size };
    } catch {
      // Not actually compressed; fall through.
    }
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ...(await maybeBase64Compressed(text)), size };
  } catch {
    const preview = Array.from(bytes.slice(0, 48), (b) => b.toString(16).padStart(2, '0')).join(' ');
    return { text: '', truncated: false, encoding: 'binary', size, preview };
  }
}

// Some trackers send compressed data as a base64 string.
async function maybeBase64Compressed(text) {
  if (text.length > 100 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(text.trim())) {
    try {
      const bytes = base64ToBytes(text.trim());
      if (isGzip(bytes) || isZlib(bytes)) {
        const inner = await inflate(bytes, isGzip(bytes) ? 'gzip' : 'deflate');
        return { ...capped(inner), encoding: 'base64+compressed' };
      }
    } catch {
      // Plain text that merely looks like base64.
    }
  }
  return { ...capped(text), encoding: 'text' };
}

// Accepts what Chrome's DevTools protocol reports for a request body.
export async function decodeBody(postData, postDataEntries) {
  if (postDataEntries?.length) {
    const parts = postDataEntries.map((e) => base64ToBytes(e.bytes || ''));
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) { bytes.set(p, offset); offset += p.length; }
    return decodeBytes(bytes);
  }
  if (typeof postData === 'string' && postData.length) {
    return { ...(await maybeBase64Compressed(postData)), size: postData.length };
  }
  return null;
}

// ------------------------------------------------------------ field extraction

export function leafName(key) {
  const parts = String(key).replace(/\]/g, '').split(/[.[]/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) if (!/^\d+$/.test(parts[i])) return parts[i].toLowerCase();
  return String(key).toLowerCase();
}

function pushField(out, key, value, source, depth) {
  if (out.length >= MAX_FIELDS) return;
  const str = value == null ? '' : String(value);
  out.push({ key, name: leafName(key), value: str.slice(0, 2000), source });
  const trimmed = str.trim();
  if (depth < 2 && trimmed.length > 1 && trimmed.length < 50000 && /^[[{]/.test(trimmed)) {
    try { flatten(JSON.parse(trimmed), key, out, source, depth + 1); } catch { /* not JSON */ }
  }
}

function flatten(node, prefix, out, source, depth) {
  const stack = [[node, prefix, 0]];
  while (stack.length && out.length < MAX_FIELDS) {
    const [value, path, level] = stack.pop();
    if (value && typeof value === 'object') {
      if (level >= MAX_JSON_DEPTH) continue;
      const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, v] = entries[i];
        stack.push([v, Array.isArray(value) ? `${path}[${k}]` : (path ? `${path}.${k}` : String(k)), level + 1]);
      }
    } else {
      pushField(out, path || '(value)', value, source, depth);
    }
  }
}

function parseText(text, out, source) {
  const t = text.trim();
  if (!t) return;
  if (/^[[{]/.test(t)) {
    try { flatten(JSON.parse(t), '', out, source, 0); return; } catch { /* not JSON */ }
  }
  if (/^[^\s=&]+=/.test(t)) {
    // URL-encoded, possibly several hits on separate lines (GA4 batches do this).
    for (const line of t.split(/\r?\n/)) {
      for (const [k, v] of new URLSearchParams(line)) pushField(out, k, v, source, 0);
    }
  }
}

// Lists the named values a request carries: URL query parameters plus the
// fields of a JSON or form-encoded body (nested JSON is flattened).
export function extractFields(url, bodyText) {
  const out = [];
  try {
    for (const [k, v] of new URL(url).searchParams) pushField(out, k, v, 'url', 0);
  } catch { /* not a URL */ }
  if (bodyText) parseText(bodyText, out, 'body');
  return out;
}

// ------------------------------------------------------------------- findings

const ID_KEY = /^(cid|uid|user_?id|anonymous_?id|client_?id|visitor_?id|vid|device_?id|distinct_?id|_?fbp|_?fbc|_ga|_gid|gclid|fbclid|msclkid|ttclid|_?ttp|sid|session_?id|external_?id|ajs_\w+|mid|guid|uuid|amp_?id|li_?fat_?id|cookie_?id|tuid|puid|xid|epik|_?uetsid|_?uetvid|ecid|mcid|marketing_?cloud_?visitor_?id|__user|c_user|account_?id|actor_?id|member_?id|customer_?id|profile_?id|viewer_?id)$/i;
// Short keys that are only an ID when the value is a long number (e.g. Facebook's `av`, your account number).
const NUMERIC_ID_KEY = /^(av|actor)$/i;
const DEVICE_KEY = /^(sr|vp|sd|ul|ua|user_?agent|screen\w*|resolution|viewport\w*|platform|os|os_?version|browser\w*|device_?(type|model|memory)?|language|lang|locale|tz|timezone|time_?zone|color_?depth|dpr|pixel_?ratio|hardware_?concurrency|cpu\w*|gpu\w*|webgl\w*|canvas\w*|plugins|fonts|connection\w*|uam|uafvl|uap|uapv|uaw)$/i;
const PAGE_KEY = /^(dl|dr|dp|dt|url|page_?url|page|location|href|referr?er|ref|rurl|page_?title|title|path|pathname|ourl|page_?location|page_?referrer|source_?url|current_?url)$/i;
const ACTIVITY_KEY = /^(en|ev|ea|ec|el|event|event_?name|action|events|clicks?|scroll\w*|mouse\w*|interaction\w*|engagement_?time_?msec|_et|hit_?type|event_?type)$/i;
const LOCATION_KEY = /^(lat|latitude|lng|lon|long|longitude|geo\w*|city|zip|zip_?code|postal_?code|postcode)$/i;
const EMAIL_KEY = /^(e_?mail(_?address)?|em|user_?email|customer_?email)$/i;
const PHONE_KEY = /^(phone(_?number)?|mobile|cell|tel(ephone)?|ph|msisdn)$/i;
const HASHED_KEY = /^(hashed_?\w+|sha256_?\w*|\w+_sha256|em|ph|fn|ln)$/i;
const HEX_HASH = /^([a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})$/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}\b/gi;
const FILE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|js|mjs|css|woff2?|ttf|ico|map|json|html?)$/i;

function safeDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

// Lower-cased searchable text of everything a request carries.
export function buildHaystack(url, bodyText) {
  const parts = [safeDecode(url)];
  if (bodyText) parts.push(bodyText, safeDecode(bodyText));
  return parts.join('\n').toLowerCase();
}

function findEmails(haystack, max = 3) {
  const found = new Set();
  for (const m of haystack.matchAll(EMAIL_RE)) {
    const email = m[0].replace(/^[._%+-]+/, '');
    if (!FILE_EXT.test(email) && !/@\d+x\./.test(email)) found.add(email);
    if (found.size >= max) break;
  }
  return [...found];
}

// Returns a list of { kind, detail } describing what a request carries.
// `req`: { url, bodyText, haystack, cookies, party }; `ctx`: { pageUrl }.
export function analyzeRequest(req, ctx = {}) {
  const findings = new Map();
  const add = (kind, detail) => {
    const f = findings.get(kind) || { kind, details: [] };
    if (detail && f.details.length < 5 && !f.details.includes(detail)) f.details.push(detail);
    findings.set(kind, f);
  };

  for (const field of extractFields(req.url, req.bodyText)) {
    const { name, value, key } = field;
    if (!value) continue;
    if ((HASHED_KEY.test(name) || EMAIL_KEY.test(name) || PHONE_KEY.test(name)) && HEX_HASH.test(value)) {
      add('hashedContact', key);
      continue;
    }
    if (PHONE_KEY.test(name) && (value.match(/\d/g) || []).length >= 7) add('phone', key);
    if ((ID_KEY.test(name) && value.length >= 6) || (NUMERIC_ID_KEY.test(name) && /^\d{6,}$/.test(value))) add('identifier', key);
    if (DEVICE_KEY.test(name)) add('device', key);
    if (PAGE_KEY.test(name) && (/^https?:/i.test(value) || value.startsWith('/'))) add('page', key);
    if (ACTIVITY_KEY.test(name)) add('activity', key);
    if (LOCATION_KEY.test(name)) add('location', key);
  }

  const haystack = req.haystack ?? buildHaystack(req.url, req.bodyText);
  for (const email of findEmails(haystack)) add('email', email);

  if (req.party === 'third') {
    try {
      const page = new URL(ctx.pageUrl);
      const path = page.pathname.toLowerCase();
      if (path.length > 1 && haystack.includes(path)) {
        add('page', page.pathname);
      }
    } catch { /* no page URL */ }
  }
  // Third-party cookies are tracking; the site's own are usually login and settings.
  if (req.cookies?.length) add(req.party === 'third' ? 'cookie' : 'siteCookie', req.cookies.slice(0, 5).map((c) => c.name).join(', '));

  return [...findings.values()];
}

// ------------------------------------------------------ typed-value matching

// Everything a typed value could look like once it leaves the page:
// as typed, lower-cased, digits only (phone numbers), and the MD5/SHA hashes
// that trackers use for "advanced matching".
export async function buildNeedles(value) {
  const raw = value.trim();
  const lower = raw.toLowerCase();
  const variants = new Set([lower, raw]);
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 7 && digits.length >= raw.replace(/[\s()+.-]/g, '').length * 0.8) variants.add(digits);

  const needles = [{ text: lower, hash: null }];
  if (digits !== lower && variants.has(digits)) needles.push({ text: digits, hash: null });
  for (const v of variants) {
    needles.push({ text: await shaHex('SHA-256', v), hash: 'SHA-256' });
    needles.push({ text: await shaHex('SHA-1', v), hash: 'SHA-1' });
    needles.push({ text: md5Hex(v), hash: 'MD5' });
  }
  return needles;
}

// Checks a request's haystack against values you typed. A match is flagged
// "before you pressed any button" when no click/Enter/submit happened between
// typing the value and the request leaving.
export function matchTyped(haystack, typedValues, requestTs, interactions = []) {
  if (!haystack) return [];
  const out = [];
  for (const typed of typedValues) {
    const hit = typed.needles.find((n) => n.text.length >= 4 && haystack.includes(n.text));
    if (!hit) continue;
    const windowStart = typed.at - 2000;
    const pressed = interactions.some((t) => t >= windowStart && t <= requestTs);
    out.push({
      kind: hit.hash ? 'typedHashed' : 'typed',
      details: [typed.field],
      field: typed.field,
      hash: hit.hash,
      beforeSubmit: !pressed,
    });
  }
  return out;
}

export function mergeTypedFindings(existing, added) {
  const seen = new Set(existing.map((f) => `${f.kind}|${f.field}`));
  return existing.concat(added.filter((f) => !seen.has(`${f.kind}|${f.field}`)));
}
