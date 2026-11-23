import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/lib/summary.js';

const entry = (over) => ({
  host: 'shop.com', site: 'shop.com', party: 'first', owner: 'shop.com', company: 'shop.com',
  category: 'site', size: 0, findings: [], ...over,
});

test('empty page has a friendly headline', () => {
  const s = summarize({ pageUrl: 'https://shop.com/', entries: [] });
  assert.equal(s.verdict.level, 'none');
  assert.match(s.headline, /Nothing has been sent yet/);
});

test('groups by owner and raises plain-language alerts', () => {
  const s = summarize({
    pageUrl: 'https://www.shop.com/checkout',
    entries: [
      entry({}),
      entry({ host: 'www.google-analytics.com', site: 'google-analytics.com', party: 'third', owner: 'Google', company: 'Google Analytics', category: 'analytics', findings: [{ kind: 'identifier' }] }),
      entry({ host: 'googleads.g.doubleclick.net', site: 'doubleclick.net', party: 'third', owner: 'Google', company: 'Google Ads (DoubleClick)', category: 'ads', findings: [{ kind: 'cookie' }] }),
      entry({ host: 'www.facebook.com', site: 'facebook.com', party: 'third', owner: 'Meta (Facebook, Instagram)', company: 'Meta Pixel', category: 'ads', findings: [{ kind: 'typedHashed', field: 'Email', hash: 'SHA-256', beforeSubmit: true }] }),
      entry({ host: 'in.hotjar.com', site: 'hotjar.com', party: 'third', owner: 'Hotjar', company: 'Hotjar', category: 'replay' }),
    ],
  });

  assert.equal(s.totals.companies, 3);
  assert.match(s.headline, /3 other companies/);
  assert.equal(s.verdict.level, 'high');

  const google = s.groups.find((g) => g.name === 'Google');
  assert.equal(google.category, 'ads'); // most significant product wins
  assert.deepEqual(google.products.sort(), ['Google Ads (DoubleClick)', 'Google Analytics']);

  assert.equal(s.groups[0].name, 'Meta (Facebook, Instagram)'); // most severe first
  const texts = s.alerts.map((a) => a.text);
  assert.ok(texts.some((t) => /Meta .* received what you typed into “Email” \(scrambled.*before you pressed any button/.test(t)));
  assert.ok(texts.some((t) => /Hotjar records sessions/.test(t)));
  assert.ok(texts.some((t) => /^2 advertising companies were told you are on this page: Meta \(Facebook, Instagram\) and Google\.$/.test(t)));
  assert.equal(s.groups.at(-1).party, 'first');
});

test('a field leaked both raw and hashed is described once, with both forms', () => {
  const s = summarize({
    pageUrl: 'https://shop.com/',
    entries: [
      entry({ host: 'rec.io', site: 'rec.io', party: 'third', owner: 'rec.io', category: 'unknown', findings: [{ kind: 'typed', field: 'Email', beforeSubmit: true }, { kind: 'email' }] }),
      entry({ host: 'rec.io', site: 'rec.io', party: 'third', owner: 'rec.io', category: 'unknown', findings: [{ kind: 'typedHashed', field: 'Email', hash: 'SHA-256' }, { kind: 'hashedContact' }] }),
    ],
  });
  const g = s.groups[0];
  assert.deepEqual(g.received.slice(0, 2).map((r) => r.text), ['Something you typed: “Email”', 'A scrambled (hashed) copy of something you typed: “Email”']);
  assert.ok(!g.received.some((r) => /email address|hashed email/i.test(r.text)));
  assert.deepEqual(s.alerts.map((a) => a.text), ['rec.io received what you typed into “Email” (as typed, and scrambled into a code that still identifies it), before you pressed any button.']);
});

test('a site that only talks to itself reads as light, with grade A', () => {
  const s = summarize({ pageUrl: 'https://shop.com/', fromStart: true, entries: [entry({}), entry({})] });
  assert.equal(s.totals.companies, 0);
  assert.match(s.headline, /only talked to shop\.com itself/);
  assert.equal(s.verdict.level, 'low');
  assert.equal(s.grade, 'A');
});

const company = (owner, category, findings = []) =>
  entry({ host: `x.${owner}.com`, site: `${owner}.com`, party: 'third', owner, company: owner, category, findings });
const gradeFor = (entries, more = {}) => summarize({ pageUrl: 'https://shop.com/', fromStart: true, entries, ...more }).grade;

test('the grade weighs companies by what they are and what they got', () => {
  const cdns = ['a', 'b', 'c', 'd'].map((n) => company(`cdn${n}`, 'cdn'));
  assert.equal(gradeFor(cdns), 'A', 'up to four technical services');
  assert.equal(gradeFor([...cdns, company('cdne', 'cdn')]), 'B');
  assert.equal(gradeFor([company('ga', 'analytics', [{ kind: 'identifier' }])]), 'B', 'one company with an ID');
  assert.equal(gradeFor([company('ads1', 'ads'), company('ads2', 'ads')]), 'C');
  assert.equal(gradeFor([company('rec', 'replay')]), 'C', 'a session recorder');
  assert.equal(gradeFor(['1', '2', '3', '4'].map((n) => company(`ads${n}`, 'ads'))), 'D');
  assert.equal(gradeFor([company('fb', 'social', [{ kind: 'email', details: ['a@b.c'] }])]), 'F');
});

test('a background-watched page with no other companies gets A, said plainly', () => {
  const s = summarize({ pageUrl: 'https://shop.com/', passive: true, fromStart: true, entries: [] });
  assert.equal(s.grade, 'A');
  assert.match(s.headline, /No other company received data/);
});

test('a page not watched from its load is not graded, unless personal info already left', () => {
  const s = summarize({ pageUrl: 'https://shop.com/', passive: true, entries: [] });
  assert.equal(s.grade, null);
  assert.match(s.verdict.text, /reload/i);
  assert.match(s.headline, /so far/);
  assert.equal(gradeFor([company('ads1', 'ads')], { fromStart: false }), null);
  assert.equal(gradeFor([company('fb', 'social', [{ kind: 'phone', details: ['tel'] }])], { fromStart: false }), 'F');
});

test('each kind of data says how many requests carried it and in which fields', () => {
  const ga = (findings) => entry({ host: 'www.google-analytics.com', site: 'google-analytics.com', party: 'third', owner: 'Google', company: 'Google Analytics', category: 'analytics', findings });
  const s = summarize({
    pageUrl: 'https://shop.com/checkout',
    entries: [
      ga([{ kind: 'identifier', details: ['cid'] }, { kind: 'device', details: ['sr', 'ul'] }]),
      ga([{ kind: 'identifier', details: ['events[0].user_id'] }, { kind: 'page', details: ['dl', '/checkout'] }]),
      ga([{ kind: 'cookie', details: ['_ga, _gid'] }, { kind: 'email', details: ['me@example.com'] }]),
    ],
  });
  const google = s.groups.find((g) => g.name === 'Google');
  const line = (label) => google.received.find((r) => r.text === label);
  assert.deepEqual(line('An ID that can recognise you on later visits'), { text: 'An ID that can recognise you on later visits', requests: 2, fields: ['cid', 'user_id'], moreFields: 0 });
  assert.deepEqual(line('Which page you are looking at').fields, ['dl']); // the page path is a value, not a field
  assert.deepEqual(line('Cookies that can recognise your browser').fields, ['_ga', '_gid']);
  assert.deepEqual(line('An email address').fields, []); // never echo the address itself
  assert.equal(google.received.at(-1).text, 'That you visited this site, plus your IP address (which reveals your rough location)');
});

test('the website itself lists the kinds of data it received, like any company', () => {
  const s = summarize({
    pageUrl: 'https://shop.com/',
    entries: [entry({ findings: [{ kind: 'activity', details: ['event'] }] }), entry({})],
  });
  const site = s.groups.find((g) => g.party === 'first');
  assert.deepEqual(site.received.map((r) => r.text), ['What you do on the page (clicks, scrolls, events)']);

  const quiet = summarize({ pageUrl: 'https://shop.com/', entries: [entry({})] }).groups[0];
  assert.match(quiet.received[0].text, /nothing about you found/);
});

test('the overview lists each kind of data once, with who received it', () => {
  const s = summarize({
    pageUrl: 'https://shop.com/',
    entries: [
      entry({ findings: [{ kind: 'identifier', details: ['uid'] }] }),
      entry({ host: 'www.google-analytics.com', site: 'google-analytics.com', party: 'third', owner: 'Google', category: 'analytics', findings: [{ kind: 'identifier', details: ['cid'] }, { kind: 'device', details: ['sr'] }] }),
      entry({ host: 'ct.pinterest.com', site: 'pinterest.com', party: 'third', owner: 'Pinterest', category: 'ads', findings: [{ kind: 'identifier', details: ['epik'] }] }),
    ],
  });
  assert.deepEqual(s.overview.map((o) => [o.label, o.to, o.requests, o.severity]), [
    ['An ID that can recognise you on later visits', 'Pinterest, Google and shop.com itself', 3, 'medium'],
    ['Details about your device and browser', 'Google', 1, 'medium'],
  ]);
});

test('a connection with an unseen address is not counted as a company', () => {
  const name = 'A live connection opened before the scan';
  const s = summarize({
    pageUrl: 'https://shop.com/',
    entries: [entry({}), entry({ host: 'unseen-connection.invalid', party: 'unknown', owner: name, company: name, site: name, category: 'unseen', findings: [{ kind: 'activity', details: ['event'] }] })],
  });
  assert.equal(s.totals.companies, 0);
  assert.match(s.headline, /only talked to shop\.com itself/);
  const g = s.groups.find((x) => x.party === 'unknown');
  assert.equal(g.name, name);
  assert.deepEqual(g.received.map((r) => r.text), ['What you do on the page (clicks, scrolls, events)']);
});

test('the site’s own cookies get their own line with cookie names', () => {
  const s = summarize({
    pageUrl: 'https://www.facebook.com/',
    entries: [entry({ findings: [{ kind: 'siteCookie', details: ['c_user, xs'] }, { kind: 'identifier', details: ['__user'] }] })],
  });
  const site = s.groups[0];
  assert.deepEqual(site.received.map((r) => [r.text, r.fields]), [
    ['An ID that can recognise you on later visits', ['__user']],
    ['Your own cookies for this site (login, settings)', ['c_user', 'xs']],
  ]);
  assert.equal(site.severity, 'none');
  assert.ok(s.overview.every((o) => o.severity === 'none'));
});
