import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { md5Hex, shaHex } from '../src/lib/hash.js';
import { registrableDomain } from '../src/lib/domains.js';
import { classify } from '../src/lib/trackers.js';
import {
  analyzeRequest, buildHaystack, buildNeedles, decodeBody, extractFields, matchTyped,
} from '../src/lib/analyze.js';

const kinds = (findings) => findings.map((f) => f.kind).sort();

test('md5 matches known vectors', () => {
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5Hex('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
  assert.equal(md5Hex('a'.repeat(100)), '36a92cc94a9e0fa21f625f8bfb007adf');
});

test('registrable domain handles common suffixes', () => {
  assert.equal(registrableDomain('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
  assert.equal(registrableDomain('user.github.io'), 'user.github.io');
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
});

test('classify separates the site, its owner and third parties', () => {
  assert.equal(classify('cdn.shop.com', 'www.shop.com').party, 'first');
  const ga = classify('www.google-analytics.com', 'www.shop.com');
  assert.deepEqual([ga.party, ga.owner, ga.category], ['third', 'Google', 'analytics']);
  // Google Analytics on YouTube belongs to the same owner.
  assert.equal(classify('www.google-analytics.com', 'www.youtube.com').party, 'first');
  const unknown = classify('api.random-thing.io', 'www.shop.com');
  assert.deepEqual([unknown.party, unknown.category, unknown.owner], ['third', 'unknown', 'random-thing.io']);
});

test('extractFields reads query strings, JSON, nested JSON strings and GA4 batches', () => {
  const fields = extractFields(
    'https://t.example/collect?cid=123.456&sr=1920x1080',
    JSON.stringify({ user: { email: 'a@b.com' }, events: [{ name: 'click' }], props: '{"plan":"pro"}' }),
  );
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f.value]));
  assert.equal(byKey.cid, '123.456');
  assert.equal(byKey['user.email'], 'a@b.com');
  assert.equal(byKey['events[0].name'], 'click');
  assert.equal(byKey['props.plan'], 'pro');

  const batch = extractFields('https://x/g/collect', 'en=page_view&dl=https%3A%2F%2Fshop.com%2Fcart\nen=scroll&epn.percent=90');
  assert.deepEqual(batch.filter((f) => f.name === 'en').map((f) => f.value), ['page_view', 'scroll']);
});

test('analyzeRequest spots IDs, device info, page, activity, email and cookies', () => {
  const findings = analyzeRequest({
    url: 'https://www.google-analytics.com/g/collect?cid=555.666&sr=1440x900&ul=en-us&en=page_view&dl=https%3A%2F%2Fshop.com%2Fcheckout',
    bodyText: '',
    cookies: [{ name: '_ga', domain: '.google-analytics.com' }],
    party: 'third',
  }, { pageUrl: 'https://shop.com/checkout' });
  assert.deepEqual(kinds(findings), ['activity', 'cookie', 'device', 'identifier', 'page']);

  const email = analyzeRequest({ url: 'https://t.co/i?u=jane.doe%40mail.com', party: 'third' }, {});
  assert.ok(kinds(email).includes('email'));

  const notEmail = analyzeRequest({ url: 'https://cdn.x.com/logo@2x.png', party: 'third' }, {});
  assert.ok(!kinds(notEmail).includes('email'));
});

test('hashed contact details (Meta advanced matching) are flagged', async () => {
  const em = await shaHex('SHA-256', 'jane@mail.com');
  const findings = analyzeRequest({ url: `https://www.facebook.com/tr?id=1&ev=PageView&ud[em]=${em}`, party: 'third' }, {});
  assert.ok(kinds(findings).includes('hashedContact'));
});

test('gzip bodies are decompressed', async () => {
  const bytes = gzipSync(Buffer.from('{"keys":"hello world"}'));
  const body = await decodeBody(undefined, [{ bytes: bytes.toString('base64') }]);
  assert.equal(body.encoding, 'gzip');
  assert.equal(body.text, '{"keys":"hello world"}');
});

test('typed values are found raw or hashed, with before-submit detection', async () => {
  const typed = { value: 'Jane@Mail.com', field: 'Email', at: 1000, needles: await buildNeedles('Jane@Mail.com') };
  const sha = await shaHex('SHA-256', 'jane@mail.com');

  const raw = matchTyped(buildHaystack('https://x/rec', '{"k":"jane@mail.com"}'), [typed], 1500, []);
  assert.deepEqual([raw[0].kind, raw[0].field, raw[0].beforeSubmit], ['typed', 'Email', true]);

  const hashed = matchTyped(buildHaystack(`https://x/tr?em=${sha}`, ''), [typed], 5000, [3000]);
  assert.deepEqual([hashed[0].kind, hashed[0].hash, hashed[0].beforeSubmit], ['typedHashed', 'SHA-256', false]);

  assert.deepEqual(matchTyped(buildHaystack('https://x/other', ''), [typed], 1500, []), []);
});

test('phone numbers match on digits only', async () => {
  const typed = { value: '+1 (555) 010-9999', field: 'Phone', at: 0, needles: await buildNeedles('+1 (555) 010-9999') };
  const digitsHash = await shaHex('SHA-256', '15550109999');
  assert.equal(matchTyped(buildHaystack(`https://x/?ph=${digitsHash}`, ''), [typed], 10, [])[0].kind, 'typedHashed');
  assert.equal(matchTyped(buildHaystack('https://x/?p=15550109999', ''), [typed], 10, [])[0].kind, 'typed');
});

test('account IDs are recognised, and the site’s own cookies are reported separately', () => {
  const findings = analyzeRequest({
    url: 'https://www.facebook.com/api/graphql/',
    bodyText: '__user=100012345678&av=100012345678&__a=1&fb_api_req_friendly_name=Feed',
    cookies: [{ name: 'c_user', domain: '.facebook.com' }, { name: 'xs', domain: '.facebook.com' }],
    party: 'first',
  }, { pageUrl: 'https://www.facebook.com/' });
  const byKind = Object.fromEntries(findings.map((f) => [f.kind, f.details]));
  assert.deepEqual(byKind.identifier, ['__user', 'av']);
  assert.deepEqual(byKind.siteCookie, ['c_user, xs']);
  assert.equal(byKind.cookie, undefined);
});

test('short ID keys only count when the value is a long number', () => {
  const findings = analyzeRequest({ url: 'https://x.com/a?av=10.4.12&__user=0', party: 'third' });
  assert.ok(!findings.some((f) => f.kind === 'identifier'));
});
