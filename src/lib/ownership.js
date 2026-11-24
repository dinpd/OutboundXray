// A site's own domains that the company list doesn't know (issue #1): ones that
// carry the site's name (zillowstatic.com on zillow.com), and ones the user
// said belong to it. Their requests count as the site's, not another company's.

import { hostOf, registrableDomain } from './domains.js';

const MIN_NAME_LENGTH = 4; // shorter site names ("cnn", "bbc") match too much by accident
const nameOf = (site) => site.split('.')[0];

export const siteOf = (pageUrl) => registrableDomain(hostOf(pageUrl));

// Why `site` is probably part of `pageSite`: 'marked' (the user said so),
// 'name' (it carries the site's name), or null.
export function ownReason(site, pageSite, marked = []) {
  if (!site || !pageSite || site === pageSite) return null;
  if (marked.includes(site)) return 'marked';
  const name = nameOf(pageSite);
  return name.length >= MIN_NAME_LENGTH && nameOf(site).includes(name) ? 'name' : null;
}

// The entries, with requests to the site's own unrecognised domains moved to the
// site. Recognised companies are never moved, so a known tracker can't be hidden.
export function withOwnDomains(entries, pageUrl, marked) {
  const pageSite = siteOf(pageUrl);
  return entries.map((e) => {
    if (e.party !== 'third' || e.category !== 'unknown') return e;
    const reason = ownReason(e.site, pageSite, marked);
    return reason ? { ...e, party: 'first', category: 'site', ownReason: reason } : e;
  });
}
