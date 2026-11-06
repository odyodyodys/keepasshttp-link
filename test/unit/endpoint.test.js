// Item 2: the KeePassHttp endpoint is fixed to localhost; only the port is configurable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './helpers.js';

function load(settings) {
  const browser = { storage: { local: { get: async () => ({ keyRing: {} }), set: async () => {} } } };
  const page = { settings };
  return loadBackground(
    ['background/aes.js', 'background/cryptoHelpers.js', 'background/keepass.js'],
    { browser, page, console: { log() {} }, String, parseInt },
    ['keepass'],
  );
}

test('host is always localhost, even with an old remote hostname setting', () => {
  for (const hostname of ['evil.example', '192.168.1.10', '127.0.0.1', '', undefined]) {
    const { keepass } = load({ hostname, port: '19455' });
    assert.equal(keepass.getPluginUrl(), 'http://localhost:19455/');
  }
});

test('valid custom port is used', () => {
  assert.equal(load({ port: '19465' }).keepass.getPluginUrl(), 'http://localhost:19465/');
  assert.equal(load({ port: 65535 }).keepass.getPluginUrl(), 'http://localhost:65535/');
});

test('invalid port falls back to the default 19455', () => {
  const bad = ['', ' ', '0', '80', '1024', '65536', '99999', '19455@evil.example', '19455/x', '1e4', '-1', 'abc', null, undefined, {}];
  for (const port of bad) {
    assert.equal(load({ port }).keepass.getPluginUrl(), 'http://localhost:19455/', 'port=' + String(port));
  }
});
