// Item 3: Hmac on every request; required and checked on every successful response.
// Format (KeePassHttp 2.3.x Protocol.cs): Base64(HMAC-SHA256(key, IV bytes || Verifier bytes)).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadBackground } from './helpers.js';
import { tamper } from '../mock-keepasshttp/tamper.js';

const ID = 'test';
const KEY = crypto.randomBytes(32).toString('base64');

function load() {
  const browser = { storage: { local: { get: async () => ({ keyRing: {} }), set: async () => {}, remove: async () => {} } } };
  const page = { settings: {}, tabs: {} };
  const { keepass } = loadBackground(
    ['background/aes.js', 'background/cryptoHelpers.js', 'background/keepass.js'],
    { browser, page, btoa, atob, String, parseInt, Uint8Array, console: { log() {} } },
    ['keepass'],
  );
  keepass.databaseHash = 'h1';
  keepass.keyRing = { h1: { id: ID, key: KEY, keyGen: keepass.keyGeneration } };
  return keepass;
}

const nodeHmac = (key, iv, ct) => crypto.createHmac('sha256', Buffer.from(key, 'base64'))
  .update(Buffer.concat([Buffer.from(iv, 'base64'), Buffer.from(ct, 'base64')])).digest('base64');

// A valid response as the plugin builds it (SetResponseVerifier).
function serverResponse(key = KEY) {
  const iv = crypto.randomBytes(16).toString('base64');
  const c = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'base64'), Buffer.from(iv, 'base64'));
  const verifier = Buffer.concat([c.update(iv, 'utf8'), c.final()]).toString('base64');
  return { RequestType: 'test-associate', Success: true, Id: ID, Hash: 'h1', Nonce: iv, Verifier: verifier, Hmac: nodeHmac(key, iv, verifier) };
}

test('setVerifier adds a Hmac that matches the plugin formula', async () => {
  const keepass = load();
  const req = { RequestType: 'test-associate' };
  const [id, key] = await keepass.setVerifier(req);
  assert.equal(id, ID);
  assert.equal(key, KEY);
  assert.equal(req.Hmac, nodeHmac(KEY, req.Nonce, req.Verifier));
});

test('associate-style setVerifier (explicit key) also adds a Hmac', async () => {
  const keepass = load();
  const k = crypto.randomBytes(32).toString('base64');
  const req = { RequestType: 'associate', Key: k };
  await keepass.setVerifier(req, k);
  assert.equal(req.Hmac, nodeHmac(k, req.Nonce, req.Verifier));
});

test('valid response with valid Hmac is accepted', async () => {
  const keepass = load();
  const r = serverResponse();
  assert.equal(await keepass.verifyResponse(r, KEY, ID), true);
  assert.equal(r.integrityFailed, undefined);
});

for (const mode of ['hmac-missing', 'hmac-bad', 'nonce-swap']) {
  test(`response is rejected: ${mode}`, async () => {
    const keepass = load();
    const r = tamper(mode, serverResponse());
    assert.equal(await keepass.verifyResponse(r, KEY, ID), false);
    assert.equal(r.integrityFailed, true);
    assert.equal(keepass.isAssociated(), false);
  });
}

test('malformed Hmac / Nonce values are rejected, never throw', async () => {
  const keepass = load();
  const bad = [
    { Hmac: '' }, { Hmac: '!!!not-base64!!!' }, { Hmac: 'AAAA' }, { Hmac: 123 }, { Hmac: null },
    { Nonce: 'AAAA' }, { Nonce: undefined }, { Verifier: undefined },
  ];
  for (const patch of bad) {
    const r = Object.assign(serverResponse(), patch);
    assert.equal(await keepass.verifyResponse(r, KEY, ID), false, JSON.stringify(patch));
  }
});

test('Hmac made with another key is rejected', async () => {
  const keepass = load();
  const r = serverResponse(crypto.randomBytes(32).toString('base64'));
  assert.equal(await keepass.verifyResponse(r, KEY, ID), false);
  assert.equal(r.integrityFailed, true);
});

test('Success=false is not an integrity failure', async () => {
  const keepass = load();
  const r = { RequestType: 'get-logins', Success: false, Error: "Couldn't verify request" };
  assert.equal(await keepass.verifyResponse(r, KEY, ID), false);
  assert.equal(r.integrityFailed, undefined);
});
