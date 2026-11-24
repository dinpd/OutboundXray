import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownReason, withOwnDomains } from '../src/lib/ownership.js';
import { summarize } from '../src/lib/summary.js';

const PAGE = 'https://www.zillow.com/homes/';
const req = (site, over = {}) => ({
  host: `api.${site}`, site, party: 'third', owner: site, company: site, category: 'unknown', size: 0, findings: [{ kind: 'identifier' }], ...over,
});

test('an unrecognised domain carrying the site name is the site’s own', () => {
  assert.equal(ownReason('zillowstatic.com', 'zillow.com'), 'name');
  assert.equal(ownReason('nytimes-cdn.com', 'nytimes.com'), 'name');
  assert.equal(ownReason('zg-api.com', 'zillow.com'), null);
  assert.equal(ownReason('cnnx.com', 'cnn.com'), null, 'short site names are not matched');
  assert.equal(ownReason('zg-api.com', 'zillow.com', ['zg-api.com']), 'marked');
});

test('recognised companies are never moved to the site, even if the name matches', () => {
  const [e] = withOwnDomains([req('zillowads.com', { category: 'ads' })], PAGE, ['zillowads.com']);
  assert.equal(e.party, 'third');
});

test('the site’s own domains leave the company count and the grade, and are listed with why', () => {
  const entries = [req('zillowstatic.com'), req('zg-api.com'), req('zg-int.net')];
  const before = summarize({ pageUrl: PAGE, fromStart: true, entries });
  assert.equal(before.totals.companies, 2, 'zillowstatic.com already counts as the site');

  const s = summarize({ pageUrl: PAGE, fromStart: true, entries, ownDomains: ['zg-api.com', 'zg-int.net'] });
  assert.equal(s.totals.companies, 0);
  assert.equal(s.grade, 'A');
  const site = s.groups.find((g) => g.party === 'first');
  assert.deepEqual(site.related, [
    { site: 'zillowstatic.com', reason: 'name' },
    { site: 'zg-api.com', reason: 'marked' },
    { site: 'zg-int.net', reason: 'marked' },
  ]);
});

test('personal information sent to the site’s own domain is not a leak to another company', () => {
  const email = [{ kind: 'email', details: ['a@b.c'] }];
  const s = summarize({ pageUrl: PAGE, fromStart: true, entries: [req('zillowstatic.com', { findings: email })] });
  assert.equal(s.grade, 'A');
  assert.equal(s.alerts.filter((a) => a.severity === 'high').length, 0);
});
