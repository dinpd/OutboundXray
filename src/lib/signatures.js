// Trackers sent through a domain the company list doesn't know, usually the
// site's own (shop.com/g/collect), recognised by what the request carries
// rather than where it goes (issue #18). Each signature names a domain in the
// company list that stands for the tracker, so its product, category and owner
// come from that list. Signatures need tracker-specific IDs (G-…, AW-…, a
// numeric pixel ID), so a site's own API calls don't match by accident.

import { extractFields } from './analyze.js';

const GA4_ID = /^G-[A-Z0-9]{4,}$/;
const ADS_ID = /^AW-\d{6,}$/;
const META_PIXEL_ID = /^\d{10,}$/;
const TIKTOK_PIXEL_ID = /^[A-Z0-9]{15,}$/;
const ADS_CONVERSION_PATH = /\/pagead\/(?:viewthrough|1p-)?conversion\/\d{6,}/;

// Query string and body fields, read the way the rest of the extension does
// (first value wins; nested JSON is flattened to dotted names).
function readRequest(url, bodyText) {
  let path;
  try { path = new URL(url).pathname.toLowerCase(); } catch { return null; }
  const params = new Map();
  for (const f of extractFields(url, bodyText)) if (!params.has(f.key)) params.set(f.key, f.value);
  return { path, params };
}

// [stand-in domain, test returning the evidence (field names) or null]
const SIGNATURES = [
  ['googleadservices.com', ({ path, params }) => {
    const conversion = path.match(ADS_CONVERSION_PATH)?.[0];
    if (conversion) return [conversion];
    return ADS_ID.test(params.get('tid') || '') ? [`tid=${params.get('tid')}`] : null;
  }],
  ['google-analytics.com', ({ params }) => (
    params.get('v') === '2' && GA4_ID.test(params.get('tid') || '') && (params.has('cid') || params.has('_p'))
      ? ['v=2', `tid=${params.get('tid')}`, params.has('cid') ? 'cid' : '_p']
      : null
  )],
  ['facebook.net', ({ path, params }) => {
    if (!META_PIXEL_ID.test(params.get('id') || '') || !params.has('ev')) return null;
    const extra = /\/tr\/?$/.test(path) ? 'path /tr' : ['fbp', 'dl', 'rl'].find((k) => params.has(k));
    return extra ? [`id=${params.get('id')}`, `ev=${params.get('ev')}`, extra] : null;
  }],
  ['tiktok.com', ({ params }) => {
    const code = params.get('context.pixel.code') || params.get('pixel_code') || '';
    const event = params.get('event');
    return TIKTOK_PIXEL_ID.test(code) && event ? [`pixel code ${code}`, `event=${event}`] : null;
  }],
];

// { domain: a company-list domain for the tracker, matched: evidence } or null.
export function proxiedTracker(url, bodyText) {
  const req = readRequest(url, bodyText);
  if (!req) return null;
  for (const [domain, test] of SIGNATURES) {
    const matched = test(req);
    if (matched) return { domain, matched };
  }
  return null;
}
