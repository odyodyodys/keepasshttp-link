// Item 1 (migration): keys from the old Math.random() generator are removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './helpers.js';

function load() {
  const browser = { storage: { local: { get: async () => ({ keyRing: {} }), set: async () => {} } } };
  return loadBackground(
    ['background/aes.js', 'background/cryptoHelpers.js', 'background/keepass.js'],
    { browser, console: { log() {} } },
    ['keepass'],
  );
}

test('dropWeakKeys removes entries without the current keyGen', () => {
  const { keepass } = load();
  const ring = {
    old: { id: 'a', key: 'x' },
    oldGen1: { id: 'b', key: 'y', keyGen: 1 },
    good: { id: 'c', key: 'z', keyGen: keepass.keyGeneration },
    broken: null,
  };
  assert.equal(keepass.dropWeakKeys(ring), 3);
  assert.deepEqual(Object.keys(ring), ['good']);
});

test('dropWeakKeys tolerates empty or invalid input', () => {
  const { keepass } = load();
  assert.equal(keepass.dropWeakKeys({}), 0);
  assert.equal(keepass.dropWeakKeys(null), 0);
  assert.equal(keepass.dropWeakKeys(undefined), 0);
});

test('saveKey marks new keys with the current keyGen', () => {
  const { keepass } = load();
  keepass.keyRing = {};
  keepass.saveKey('hash1', 'id1', 'key1');
  assert.equal(keepass.keyRing.hash1.keyGen, keepass.keyGeneration);
  keepass.keyRing.hash1.keyGen = undefined; // simulate old entry being updated
  keepass.saveKey('hash1', 'id1', 'key2');
  assert.equal(keepass.keyRing.hash1.keyGen, keepass.keyGeneration);
});
