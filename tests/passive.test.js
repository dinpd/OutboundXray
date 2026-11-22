import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passiveEntry, formDataText, carriesPersonalInfo } from '../src/lib/passive.js';
import { buildNeedles } from '../src/lib/analyze.js';
import { summarize } from '../src/lib/summary.js';

const page = 'https://www.shop.com/signup';

test('requests to the site itself are not kept', () => {
  assert.equal(passiveEntry({ id: 1, url: 'https://cdn.shop.com/app.js', method: 'GET', type: 'script', ts: 1, pageUrl: page }), null);
});

test('a request to another company becomes a light entry with what it carries', () => {
  const { entry, haystack } = passiveEntry({
    id: 7, url: 'https://www.google-analytics.com/g/collect?cid=123456.789&en=page_view&dl=https%3A%2F%2Fwww.shop.com%2Fsignup',
    method: 'POST', type: 'ping', ts: 1000, pageUrl: page,
  });
  assert.equal(entry.id, '7');
  assert.equal(entry.party, 'third');
  assert.equal(entry.owner, 'Google');
  assert.deepEqual(entry.findings.map((f) => f.kind).sort(), ['activity', 'identifier', 'page']);
  assert.ok(haystack.includes('cid=123456.789'));
  assert.equal(carriesPersonalInfo(entry), false);
});

test('what you typed, hashed, going to another company is personal info', async () => {
  const typed = [{ value: 'me@example.com', field: 'Email', at: 900, needles: await buildNeedles('me@example.com') }];
  const hashed = typed[0].needles.find((n) => n.hash === 'SHA-256').text;
  const { entry } = passiveEntry({
    id: 2, url: 'https://www.facebook.com/tr/', method: 'POST', type: 'xmlhttprequest', ts: 1000, pageUrl: page,
    bodyText: formDataText({ ev: ['Lead'], 'ud[em]': [hashed] }), typed,
  });
  assert.ok(carriesPersonalInfo(entry));
  const s = summarize({ pageUrl: page, entries: [entry] });
  assert.equal(s.verdict.level, 'high');
  assert.match(s.alerts[0].text, /^Meta .* received what you typed into “Email” \(scrambled.*before you pressed any button\.$/);
});

test('form bodies are flattened like a query string', () => {
  assert.equal(formDataText({ a: ['1', '2'], b: ['x y'] }), 'a=1&a=2&b=x+y');
  assert.equal(formDataText(undefined), '');
});
