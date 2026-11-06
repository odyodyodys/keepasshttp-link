// Item 5: HTTP auth auto-send is off by default, and never automatic over http:// or for proxies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './helpers.js';

const LOGIN = { Login: 'user-one', Password: 'Dummy-Pass-1', Name: 'Single site' };

function loadAuth(autoFillAndSend) {
  const calls = { popup: 0 };
  const { httpAuth } = loadBackground(['background/httpauth.js'], {
    page: { settings: { autoFillAndSend }, tabs: { 1: {} } },
    cipevent: { onHTTPAuthPopup: () => { calls.popup++; } },
    utils: { isFirefox: true },
    URL,
  }, ['httpAuth']);
  return { httpAuth, calls };
}

function decide(autoFillAndSend, details, logins = [LOGIN]) {
  const { httpAuth, calls } = loadAuth(autoFillAndSend);
  const out = { resolved: null, rejected: false };
  httpAuth.loginOrShowCredentials(logins, Object.assign({ tabId: 1 }, details),
    (v) => { out.resolved = v; }, () => { out.rejected = true; });
  out.popup = calls.popup;
  return out;
}

test('setting off: never sends, Firefox shows its own dialog', () => {
  const r = decide(false, { url: 'https://single.localhost/basic', searchUrl: 'https://single.localhost/basic' });
  assert.equal(r.resolved, null);
  assert.equal(r.rejected, true);
});

test('setting on + https + one login: sent automatically', () => {
  const r = decide(true, { url: 'https://single.localhost/basic' });
  assert.deepEqual(JSON.parse(JSON.stringify(r.resolved)), { authCredentials: { username: 'user-one', password: 'Dummy-Pass-1' } });
});

test('setting on + http: not sent automatically, user must choose in the popup', () => {
  const r = decide(true, { url: 'http://single.localhost:8080/basic' });
  assert.equal(r.resolved, null);
  assert.equal(r.popup, 1);
});

test('setting on + proxy auth: not sent automatically', () => {
  const r = decide(true, { url: 'https://single.localhost/', isProxy: true, proxyUrl: 'proxy.example' });
  assert.equal(r.resolved, null);
  assert.equal(r.popup, 1);
});

test('setting on + invalid URL: not sent automatically', () => {
  const r = decide(true, { url: 'not a url' });
  assert.equal(r.resolved, null);
});

test('no logins: rejected', () => {
  const r = decide(true, { url: 'https://single.localhost/' }, []);
  assert.equal(r.rejected, true);
});

async function initSettings(stored) {
  let saved = null;
  const browser = { storage: { local: {
    get: async () => ({ settings: JSON.parse(JSON.stringify(stored)) }),
    set: async (o) => { saved = o.settings; },
  } } };
  const keepass = { parsePort: () => 19455, defaultPort: 19455 };
  const { page } = loadBackground(['background/page.js'], { browser, keepass, String }, ['page']);
  const s = await page.initSettings();
  return { s, saved };
}

test('new install: auto-send off', async () => {
  const { s } = await initSettings({});
  assert.equal(s.autoFillAndSend, false);
});

test('old settings with auto-send on (old default): turned off once', async () => {
  const { s, saved } = await initSettings({ autoFillAndSend: true });
  assert.equal(s.autoFillAndSend, false);
  assert.equal(saved.httpAuthDefaultOff, true);
});

test('user turned it on again after the migration: kept on', async () => {
  const { s } = await initSettings({ autoFillAndSend: true, httpAuthDefaultOff: true });
  assert.equal(s.autoFillAndSend, true);
});
