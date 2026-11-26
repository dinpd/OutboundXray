import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/lib/trackers.js';
import { passiveEntry } from '../src/lib/passive.js';
import { summarize } from '../src/lib/summary.js';
import { hostOf } from '../src/lib/domains.js';

const PAGE = 'https://www.shop.com/checkout';
const who = (url, bodyText = '', page = PAGE) => classify(hostOf(url), hostOf(page), { url, bodyText });

test('known trackers sent through the site’s own domain count as their company', () => {
  const ga = who('https://www.shop.com/metrics/g/collect?v=2&tid=G-AB12CD34&cid=123.456&en=page_view');
  assert.deepEqual([ga.party, ga.company, ga.owner, ga.category], ['third', 'Google Analytics', 'Google', 'analytics']);
  assert.deepEqual(ga.proxy, { via: 'shop.com', viaSite: true, matched: ['v=2', 'tid=G-AB12CD34', 'cid'] });

  const meta = who('https://sgtm.shop.com/tr?id=1234567890123&ev=PageView&dl=https%3A%2F%2Fwww.shop.com%2F');
  assert.equal(meta.owner, 'Meta (Facebook, Instagram)');
  const metaPost = who('https://www.shop.com/px', 'id=1234567890123&ev=Purchase&fbp=fb.1.2.3');
  assert.equal(metaPost.company, 'Meta Pixel');

  const tiktok = who('https://www.shop.com/tt/events', JSON.stringify({ event: 'ViewContent', context: { pixel: { code: 'C4ABCDEFGHIJKLMNOP12' } } }));
  assert.equal(tiktok.owner, 'TikTok');

  const ads = who('https://www.shop.com/pagead/conversion/123456789/?label=abc');
  assert.equal(ads.company, 'Google Ads');
  assert.equal(who('https://www.shop.com/ccm/collect?tid=AW-123456789&en=conversion').company, 'Google Ads');
});

test('a tracker on another unrecognised domain is named too, as sent through that domain', () => {
  const ga = who('https://collect.some-proxy.io/g/collect?v=2&tid=G-AB12CD34&cid=1');
  assert.deepEqual([ga.owner, ga.proxy.via, ga.proxy.viaSite], ['Google', 'some-proxy.io', false]);
});

test('the site’s ordinary requests are not mistaken for trackers', () => {
  for (const [url, body] of [
    ['https://www.shop.com/api/items?v=2&id=1234567890&tid=abc', ''],
    ['https://www.shop.com/api/track?ev=click&id=42', ''],
    ['https://www.shop.com/api/log', JSON.stringify({ event: 'click', pixel_code: 'abc' })],
    ['https://www.shop.com/collect?v=2&tid=G-AB12CD34', ''], // no client ID: not a GA4 hit
    ['https://www.shop.com/tr?id=1234567890123', ''], // no event
    ['https://www.shop.com/orders/conversion/123456789', ''],
  ]) {
    const r = who(url, body);
    assert.equal(r.party, 'first', url);
    assert.equal(r.proxy, undefined, url);
  }
});

test('recognised hosts and same-owner pages are unchanged', () => {
  const direct = who('https://www.google-analytics.com/g/collect?v=2&tid=G-AB12CD34&cid=1');
  assert.deepEqual([direct.party, direct.proxy], ['third', undefined]);
  const onYouTube = who('https://www.youtube.com/g/collect?v=2&tid=G-AB12CD34&cid=1', '', 'https://www.youtube.com/watch');
  assert.equal(onYouTube.party, 'first', 'Google Analytics on a Google site is the site’s owner');
});

test('background watch records a proxied tracker, which it skips for the site’s own requests', () => {
  const made = passiveEntry({ id: 1, url: 'https://www.shop.com/g/collect?v=2&tid=G-AB12CD34&cid=1', method: 'POST', type: 'ping', ts: 1, pageUrl: PAGE });
  assert.equal(made.entry.owner, 'Google');
  assert.equal(made.entry.proxy.via, 'shop.com');
  assert.equal(passiveEntry({ id: 2, url: 'https://www.shop.com/api/cart', method: 'GET', type: 'xhr', ts: 1, pageUrl: PAGE }), null);
});

test('direct and proxied requests to one tracker are one company, counted in the grade', () => {
  const entry = (url) => ({ ...who(url), host: hostOf(url), size: 0, findings: [{ kind: 'identifier', details: ['cid'] }] });
  const entries = [
    entry('https://www.google-analytics.com/g/collect?v=2&tid=G-AB12CD34&cid=1'),
    entry('https://www.shop.com/g/collect?v=2&tid=G-AB12CD34&cid=1'),
    entry('https://www.shop.com/g/collect?v=2&tid=G-AB12CD34&cid=1'),
  ];
  const s = summarize({ pageUrl: PAGE, fromStart: true, entries });
  assert.equal(s.totals.companies, 1);
  const google = s.groups.find((g) => g.key === 'Google');
  assert.equal(google.requests, 3);
  assert.deepEqual(google.proxied, [{ via: 'shop.com', viaSite: true, product: 'Google Analytics', requests: 2, matched: ['v=2', 'tid=G-AB12CD34', 'cid'] }]);

  const proxiedOnly = summarize({ pageUrl: PAGE, fromStart: true, entries: entries.slice(1) });
  assert.equal(proxiedOnly.totals.companies, 1, 'hidden behind the site, it still counts');
  assert.notEqual(proxiedOnly.grade, 'A');
  const received = (sum) => sum.groups.find((g) => g.key === 'Google').received.map((r) => r.text).join(' | ');
  assert.match(received(proxiedOnly), /went to the server in between/, 'only proxied: Google didn’t see the IP itself');
  assert.match(received(s), /plus your IP address/, 'reached directly too: Google saw the IP');
});

test('marking a domain as the site’s own does not hide a tracker recognised on it', () => {
  const url = 'https://collect.some-proxy.io/g/collect?v=2&tid=G-AB12CD34&cid=1';
  const s = summarize({ pageUrl: PAGE, fromStart: true, ownDomains: ['some-proxy.io'], entries: [{ ...who(url), host: hostOf(url), size: 0, findings: [] }] });
  assert.equal(s.totals.companies, 1);
});
