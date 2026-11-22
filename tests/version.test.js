import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

test('manifest.json and package.json carry the same version', () => {
  assert.equal(read('manifest.json').version, read('package.json').version);
});
