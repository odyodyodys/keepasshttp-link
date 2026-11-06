// Item 15: AES-256-CBC with WebCrypto, compatible with the plugin (.NET Aes,
// PKCS#7, UTF-8 text). Node's own AES is the reference.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadBackground } from './helpers.js';

function load() {
  const logs = [];
  const browser = { storage: { local: { get: async () => ({ keyRing: {} }), set: async () => {}, remove: async () => {} } } };
  const { keepass } = loadBackground(['background/cryptoHelpers.js', 'background/keepass.js'],
    { browser, page: { settings: {} }, console: { log: (m) => logs.push(String(m)) }, String, parseInt, btoa, atob },
    ['keepass']);
  return { keepass, logs };
}

const b64 = (b) => Buffer.from(b).toString('base64');
function nodeEncrypt(text, key, iv) {
  const c = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'base64'), Buffer.from(iv, 'base64'));
  return b64(Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()]));
}
function nodeDecrypt(data, key, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'base64'), Buffer.from(iv, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

// Dummy values only. Non-ASCII text checks UTF-8 on both sides.
const SAMPLES = ['', 'a', 'user-one', 'exactly-16-bytes', 'Dummy-Pass-1 with spaces',
  'Pässwörd-ÄÖÜ-ß', 'Ελληνικά', 'Français: été, œuvre', '测试-密码', 'emoji 🔑', 'https://ex.localhost/π?q=ü'];

test('encrypt matches Node AES-256-CBC (same key and IV give the same ciphertext)', async () => {
  const { keepass } = load();
  const key = b64(crypto.randomBytes(32));
  const iv = b64(crypto.randomBytes(16));
  for (const s of SAMPLES) {
    assert.equal(await keepass.encrypt(s, key, iv), nodeEncrypt(s, key, iv), s);
  }
});

test('decrypt reads Node AES-256-CBC output, including UTF-8', async () => {
  const { keepass } = load();
  const key = b64(crypto.randomBytes(32));
  const iv = b64(crypto.randomBytes(16));
  for (const s of SAMPLES) {
    assert.equal(await keepass.decrypt(nodeEncrypt(s, key, iv), key, iv), s);
    assert.equal(nodeDecrypt(await keepass.encrypt(s, key, iv), key, iv), s);
  }
});

test('decrypt rejects a wrong key (bad padding) instead of returning garbage', async () => {
  const { keepass } = load();
  const iv = b64(crypto.randomBytes(16));
  const ct = nodeEncrypt('Dummy-Pass-1', b64(crypto.randomBytes(32)), iv);
  let wrongResults = 0;
  for (let i = 0; i < 20; i++) {
    try { await keepass.decrypt(ct, b64(crypto.randomBytes(32)), iv); wrongResults++; } catch { /* expected */ }
  }
  // A random wrong key gives valid PKCS#7 padding by chance about 1 in 256 times.
  assert.ok(wrongResults <= 2, 'wrong key accepted ' + wrongResults + ' times');
});

test('decryptEntries: all fields decrypted; one bad field rejects all entries', async () => {
  const { keepass, logs } = load();
  const key = b64(crypto.randomBytes(32));
  const iv = b64(crypto.randomBytes(16));
  const enc = (s) => nodeEncrypt(s, key, iv);
  const make = () => [
    { Name: enc('Bank (dummy)'), Login: enc('user-ä'), Password: enc('Pässwörd-1'), Uuid: enc('0123abcd'),
      StringFields: [{ Key: enc('KPH: otp'), Value: enc('123') }] },
    { Name: enc('Second'), Login: enc('user-two'), Password: enc('Dummy-Pass-2'), Uuid: enc('ffff0000') },
  ];
  const ok = await keepass.decryptEntries(make(), key, iv);
  assert.deepEqual(JSON.parse(JSON.stringify(ok)), [
    { Name: 'Bank (dummy)', Login: 'user-ä', Password: 'Pässwörd-1', Uuid: '0123abcd',
      StringFields: [{ Key: 'KPH: otp', Value: '123' }] },
    { Name: 'Second', Login: 'user-two', Password: 'Dummy-Pass-2', Uuid: 'ffff0000' },
  ]);

  const bad = make();
  bad[1].Password = b64(crypto.randomBytes(15)); // not a whole AES block
  assert.equal(await keepass.decryptEntries(bad, key, iv), null);
  assert.ok(logs.some((l) => l.includes('could not be decrypted')));
  assert.ok(!logs.join(' ').includes('Pässwörd'), 'no secrets in logs');
  assert.equal(await keepass.decryptEntries(undefined, key, iv), null);
});

test('setVerifier: Verifier = AES(Nonce) that the plugin can read back', async () => {
  const { keepass } = load();
  const key = b64(crypto.randomBytes(32));
  const request = { RequestType: 'test-associate' };
  await keepass.setVerifier(request, key);
  assert.equal(nodeDecrypt(request.Verifier, key, request.Nonce), request.Nonce);
});
