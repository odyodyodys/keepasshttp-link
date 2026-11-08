// Key ring: entries are marked, never removed silently. Only "Remove" deletes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './helpers.js';

function load() {
  const saved = [];
  // get() never answers: the start-up load must not replace the ring a test sets.
  const browser = { storage: { local: { get: () => new Promise(() => {}), set: async (v) => { saved.push(v); }, remove: async () => {} } } };
  const { keepass } = loadBackground(
    ['background/cryptoHelpers.js', 'background/keepass.js'],
    { browser, console: { log() {} }, Date },
    ['keepass'],
  );
  return { keepass, saved };
}

test('markWeakKeys marks old-generation entries lost ("weak"), keeps them, drops their key', () => {
  const { keepass } = load();
  const ring = {
    old: { id: 'a', key: 'x', description: 'Office' },
    oldGen1: { id: 'b', key: 'y', keyGen: 1 },
    good: { id: 'c', key: 'z', keyGen: keepass.keyGeneration, status: 'ok' },
    broken: null,
  };
  assert.equal(keepass.markWeakKeys(ring), 3);
  assert.deepEqual([...Object.keys(ring)].sort(), ['good', 'old', 'oldGen1']);
  assert.equal(ring.old.status, 'lost');
  assert.equal(ring.old.lostReason, 'weak');
  assert.equal(ring.old.key, undefined);
  assert.equal(ring.old.description, 'Office');
  assert.equal(ring.good.status, 'ok');
  assert.equal(ring.good.key, 'z');
  // Marking twice changes nothing.
  assert.equal(keepass.markWeakKeys(ring), 0);
});

test('markWeakKeys tolerates empty or invalid input', () => {
  const { keepass } = load();
  assert.equal(keepass.markWeakKeys({}), 0);
  assert.equal(keepass.markWeakKeys(null), 0);
  assert.equal(keepass.markWeakKeys(undefined), 0);
});

test('saveKey: new entry has status ok, addedAt, keyGen, and the one-time note', () => {
  const { keepass } = load();
  keepass.keyRing = {};
  keepass.saveKey('hash1', 'Work', 'key1');
  const e = keepass.keyRing.hash1;
  assert.equal(e.keyGen, keepass.keyGeneration);
  assert.equal(e.status, 'ok');
  assert.equal(typeof e.addedAt, 'number');
  assert.equal(e.lastUsedAt, undefined);
  assert.equal(e.firstFillNote, true);
});

test('give access again: saveKey on a lost entry keeps addedAt and description, clears the mark', () => {
  const { keepass } = load();
  keepass.keyRing = { h: { id: 'Work', status: 'lost', lostReason: 'rejected', addedAt: 1000, description: 'Office laptop' } };
  keepass.saveKey('h', 'Work', 'newkey');
  const e = keepass.keyRing.h;
  assert.equal(e.status, 'ok');
  assert.equal(e.lostReason, undefined);
  assert.equal(e.addedAt, 1000);
  assert.equal(e.description, 'Office laptop');
  assert.equal(e.key, 'newkey');
});

test('a key KeePass rejects is marked lost, not deleted; a lost entry is never used', () => {
  const { keepass } = load();
  keepass.keyRing = { h: { id: 'Work', key: 'k', keyGen: keepass.keyGeneration, status: 'ok', description: 'd' } };
  keepass.databaseHash = 'h';
  assert.deepEqual([...keepass.getCryptoKey()], ['Work', 'k']);
  keepass.markKeyLost('h', 'rejected');
  assert.ok('h' in keepass.keyRing);
  assert.equal(keepass.keyRing.h.status, 'lost');
  assert.equal(keepass.keyRing.h.lostReason, 'rejected');
  assert.equal(keepass.keyRing.h.description, 'd');
  assert.equal(keepass.getCryptoKey(), null);
});

test('updateLastUsed: a fill clears the one-time note, a save does not', () => {
  const { keepass } = load();
  keepass.keyRing = { h: { id: 'W', key: 'k', firstFillNote: true } };
  keepass.updateLastUsed('h', false);
  assert.equal(typeof keepass.keyRing.h.lastUsedAt, 'number');
  assert.equal(keepass.keyRing.h.firstFillNote, true);
  keepass.updateLastUsed('h', true);
  assert.equal(keepass.keyRing.h.firstFillNote, undefined);
});

test('removeKey deletes the entry and the association', async () => {
  const { keepass } = load();
  keepass.keyRing = { h: { id: 'W', key: 'k' }, g: { id: 'P', key: 'k2' } };
  keepass.associated = { value: true, hash: 'h' };
  await keepass.removeKey('h');
  assert.deepEqual([...Object.keys(keepass.keyRing)], ['g']);
  assert.equal(keepass.associated.value, false);
});

test('updateKeyEntry: description is trimmed, empty removes it, the note can be dismissed', async () => {
  const { keepass } = load();
  keepass.keyRing = { h: { id: 'W', key: 'k', firstFillNote: true } };
  await keepass.updateKeyEntry('h', { description: '  Office  ' });
  assert.equal(keepass.keyRing.h.description, 'Office');
  await keepass.updateKeyEntry('h', { description: '' });
  assert.equal(keepass.keyRing.h.description, undefined);
  await keepass.updateKeyEntry('h', { dismissFirstFillNote: true });
  assert.equal(keepass.keyRing.h.firstFillNote, undefined);
  assert.equal(await keepass.updateKeyEntry('missing', { description: 'x' }), false);
});

test('publicKeyRing (for the settings page) never contains the keys', () => {
  const { keepass } = load();
  keepass.keyRing = { h: { id: 'W', key: 'SECRET', keyGen: 2, status: 'ok', addedAt: 5, description: 'd' } };
  const pub = keepass.publicKeyRing();
  assert.ok(!JSON.stringify(pub).includes('SECRET'));
  assert.deepEqual(JSON.parse(JSON.stringify(pub.h)), { id: 'W', status: 'ok', lostReason: null, addedAt: 5, lastUsedAt: null, description: 'd', firstFillNote: false });
});
