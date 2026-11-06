// Item 1: key and IV must come from a CSPRNG, never Math.random().
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadBackground } from './helpers.js';

function load() {
  // Math.random must not be used for key material: make it throw.
  const math = Object.create(Math);
  math.random = () => { throw new Error('Math.random used'); };
  return loadBackground(['background/aes.js', 'background/cryptoHelpers.js'], { Math: math },
    ['slowAES', 'cryptoHelpers']);
}

test('randomBytes returns the requested number of bytes in 0..255', () => {
  const { cryptoHelpers } = load();
  for (const n of [1, 16, 32]) {
    const b = cryptoHelpers.randomBytes(n);
    assert.equal(b.length, n);
    assert.ok(b.every((x) => Number.isInteger(x) && x >= 0 && x <= 255));
  }
});

test('randomBytes does not use Math.random and does not repeat', () => {
  const { cryptoHelpers } = load();
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(cryptoHelpers.randomBytes(16).join(','));
  assert.equal(seen.size, 1000);
});

test('randomBytes rejects invalid sizes', () => {
  const { cryptoHelpers } = load();
  for (const bad of [0, -1, 1.5, '16', 70000, undefined]) {
    assert.throws(() => cryptoHelpers.randomBytes(bad));
  }
});

test('old insecure generator is gone', () => {
  const { cryptoHelpers } = load();
  assert.equal(cryptoHelpers.generateSharedKey, undefined);
  assert.equal(cryptoHelpers.getRandom, undefined);
});

test('32-byte key + 16-byte IV work with AES-256-CBC as the plugin uses it', () => {
  const { cryptoHelpers, slowAES } = load();
  const key = cryptoHelpers.randomBytes(32);
  const iv = cryptoHelpers.randomBytes(16);
  const nonce = Buffer.from(iv).toString('base64');
  const plain = cryptoHelpers.convertStringToByteArray(nonce);
  const ct = Buffer.from(slowAES.encrypt(plain, slowAES.modeOfOperation.CBC, key, iv));
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(iv));
  assert.equal(Buffer.concat([d.update(ct), d.final()]).toString('utf8'), nonce);
});
