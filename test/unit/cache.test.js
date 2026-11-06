// Item 10: login caches are dropped on origin change, on lock, and the
// "save this login?" password has a hard time limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './helpers.js';

function load() {
  const sent = [];
  const browser = {
    runtime: { id: 'x', getURL: (p) => 'moz-extension://u/' + p },
    tabs: {
      query: async () => [{ id: 1 }, { id: 2 }],
      sendMessage: (id, msg) => { sent.push({ id, msg }); return Promise.resolve(); },
    },
    storage: { local: { get: async () => ({}) } },
  };
  const env = loadBackground(['background/senderPolicy.js', 'background/page.js', 'background/browserAction.js'],
    { URL, JSON, String, Object, browser, isFinite, Promise, setTimeout }, ['page', 'browserAction']);
  return { ...env, sent };
}

test('origin change drops the login lists of the old site, keeps "save login" data', () => {
  const { page } = load();
  page.createTabEntry(5);
  const t = page.tabs[5];
  t.origin = 'https://a.localhost';
  t.loginList = ['alice (A)'];
  t.loginFrameId = 0;
  t.knownLogins = { 0: [{ Login: 'alice', Name: 'A', Uuid: 'u' }] };
  t.credentials = { username: 'alice', password: 'Dummy-Pass-1' };

  page.onTabUrlChanged(5, 'https://a.localhost/next#x');      // same origin (SPA route)
  assert.equal(t.loginList.length, 1);

  page.onTabUrlChanged(5, 'https://other.localhost/');        // new site
  assert.equal(t.loginList.length, 0);
  assert.equal(t.loginFrameId, undefined);
  assert.deepEqual(Object.keys(t.knownLogins), []);
  assert.equal(t.credentials.password, 'Dummy-Pass-1');
  assert.equal(t.origin, 'https://other.localhost');

  page.onTabUrlChanged(99, 'https://x.localhost/');           // unknown tab: no error
});

test('clearAllLogins empties every tab and tells every tab (reason: locked)', async () => {
  const { page, sent } = load();
  page.createTabEntry(1);
  page.createTabEntry(2);
  page.tabs[1].loginList = ['a'];
  page.tabs[2].knownLogins = { 0: [{ Login: 'b' }] };
  page.clearAllLogins();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(page.tabs[1].loginList.length, 0);
  assert.deepEqual(Object.keys(page.tabs[2].knownLogins), []);
  assert.deepEqual(sent.map((s) => s.id), [1, 2]);
  assert.ok(sent.every((s) => s.msg.action === 'clear_credentials' && s.msg.reason === 'locked'));
});

test('rememberMaxMillis: blink time + 60 s, bad values use the default, at most 10 min', () => {
  const { browserAction } = load();
  assert.equal(browserAction.rememberMaxMillis(7500), 67500);
  assert.equal(browserAction.rememberMaxMillis('abc'), 67500);
  assert.equal(browserAction.rememberMaxMillis(-5), 67500);
  assert.equal(browserAction.rememberMaxMillis(10 * 60 * 1000), 600000);
});
