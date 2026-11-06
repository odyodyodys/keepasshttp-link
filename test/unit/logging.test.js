// Item 12: logs never contain keys, passwords, usernames, URLs or protocol
// payloads, also with debug mode on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadBackground, SRC } from './helpers.js';

test('debug mode: sendAsync logs only request type, status and size', async () => {
  const logs = [];
  let xhr;
  class FakeXHR {
    constructor() { xhr = this; }
    open() {}
    setRequestHeader() {}
    send(body) { this.sent = body; }
  }
  const browser = { storage: { local: { get: async () => ({ keyRing: {} }), set: async () => {}, remove: async () => {} } } };
  const page = { settings: { port: '19455' }, debug: (...a) => logs.push(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')) };
  const { keepass } = loadBackground(
    ['background/cryptoHelpers.js', 'background/keepass.js'],
    { browser, page, console: { log: (m) => logs.push(String(m)) }, String, parseInt, XMLHttpRequest: FakeXHR, Promise, JSON },
    ['keepass'],
  );
  const secretKey = 'S3cretKeyDummyBase64AAAAAAAAAAAAAAAAAAAAAAA=';
  const p = keepass.sendAsync({ RequestType: 'associate', Key: secretKey, Url: 'https://dummy-site.localhost/login' });
  assert.ok(xhr.sent.includes(secretKey)); // it is sent to KeePass...
  xhr.status = 200;
  xhr.responseText = JSON.stringify({ Success: true, Entries: [{ Login: 'dummy-user', Password: 'Dummy-Pass-1' }] });
  xhr.onload();
  await p;
  const all = logs.join('\n');
  assert.ok(all.includes('associate'), all);  // ...but logs show only the type,
  for (const secret of [secretKey, 'dummy-site', 'dummy-user', 'Dummy-Pass-1', 'Entries']) {
    assert.ok(!all.includes(secret), `log contains ${secret}: ${all}`);
  }
});

function ownJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...ownJsFiles(p));
    else if (name.endsWith('.js') && !name.endsWith('.min.js')) out.push(p);
  }
  return out;
}

test('no log call passes credentials, URLs or payload variables', () => {
  const forbidden = /\b(username|password|passwordValue|usernameValue|url|submiturl|submitUrl|responseText|request|r|entries|credentials|Login|Password|Key|key|keyRing|settings)\b/;
  const bad = [];
  for (const f of ownJsFiles(SRC)) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      const m = line.match(/(console\.(log|warn|error|info|debug)|page\.debug)\((.*)\)/);
      if (!m) return;
      const args = m[3].replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
      // Allowed: only the message type and sizes, e.g. request.action, entries.length.
      const safe = args.replace(/\b[A-Za-z_]+\.(action|length|RequestType)\b/g, 'SAFE');
      if (forbidden.test(safe)) bad.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});
