// Toolbar icon colors: only preset ids and "#rrggbb" are accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './helpers.js';

const { kphIcon } = loadBackground(['background/icon.js'], {}, ['kphIcon']);

test('preset ids, old "-inverse" names and hex colors are kept', () => {
  assert.equal(kphIcon.normalize('blue'), 'blue');
  assert.equal(kphIcon.normalize(' Green '), 'green');
  assert.equal(kphIcon.normalize('purple-inverse'), 'purple');
  assert.equal(kphIcon.normalize('#A1b2C3'), '#a1b2c3');
});

test('anything else falls back to the default', () => {
  for (const bad of [undefined, null, 42, {}, '', 'teal', '#fff', '#12345g', '#1234567',
    'red;background:url(x)', 'url(https://example.invalid/x.png)', '#ff00aa"><script>']) {
    assert.equal(kphIcon.normalize(bad), 'blue', String(bad));
  }
});

test('presets have a light and a dark tone; a custom color is the same on both', () => {
  assert.equal(kphIcon.colorFor('blue', false), '#1d4ed8');
  assert.equal(kphIcon.colorFor('blue', true), '#60a5fa');
  assert.equal(kphIcon.colorFor('#ff00aa', false), '#ff00aa');
  assert.equal(kphIcon.colorFor('#ff00aa', true), '#ff00aa');
  assert.equal(kphIcon.colorFor('bogus', false), '#1d4ed8');
});

test('every preset color is a valid hex color', () => {
  for (const p of kphIcon.presets) {
    assert.ok(kphIcon.isHex(p.light) && kphIcon.isHex(p.dark), p.id);
  }
});
