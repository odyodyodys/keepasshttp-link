// Settings page support: pairing reports a result, the connection check
// reports the state, and the save-offer "page changes" timer accepts 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './helpers.js';

function loadKeepass() {
  const stored = { keyRing: {} };
  const browser = { storage: { local: { get: async () => stored, set: async () => {}, remove: async () => {} } } };
  const page = { settings: { port: '19455' }, tabs: { 7: { errorMessage: null } }, debug() {}, clearAllLogins() {} };
  const browserAction = { show() {}, showDefault() {} };
  const { keepass } = loadBackground(
    ['background/cryptoHelpers.js', 'background/keepass.js'],
    { browser, page, browserAction, console: { log() {} } },
    ['keepass'],
  );
  // The ring object the start-up load will install; tests fill it.
  keepass.keyRing = stored.keyRing;
  return { keepass, page };
}

const tab = { id: 7 };
const call = (fn, ...args) => new Promise((resolve) => fn((r) => resolve(r), tab, ...args));

test('associate: already paired with the open database → ok false, reason "already", with the name', async () => {
  const { keepass } = loadKeepass();
  keepass.keyRing.h1 = { id: 'Laptop', key: 'k', keyGen: keepass.keyGeneration };
  keepass.databaseHash = 'h1';
  keepass.associated = { value: true, hash: 'h1' };
  const r = await call(keepass.associate);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'already');
  assert.equal(r.identifier, 'Laptop');
});

test('associate: plugin not reachable → reason "unavailable"; database locked → reason "locked"', async () => {
  const { keepass } = loadKeepass();
  keepass.getDatabaseHash = async () => { keepass.isKeePassHttpAvailable = false; keepass.isDatabaseClosed = false; return 'no-hash'; };
  let r = await call(keepass.associate);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unavailable');
  assert.match(r.error, /KeePass/);

  keepass.getDatabaseHash = async () => { keepass.isKeePassHttpAvailable = true; keepass.isDatabaseClosed = true; return 'no-hash'; };
  r = await call(keepass.associate);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'locked');
});

test('associate without a callback does not throw', async () => {
  const { keepass } = loadKeepass();
  keepass.keyRing.h1 = { id: 'A', key: 'k', keyGen: keepass.keyGeneration };
  keepass.databaseHash = 'h1';
  keepass.associated = { value: true, hash: 'h1' };
  assert.doesNotThrow(() => keepass.associate(undefined, tab));
});

test('checkConnection reports plugin, database, pairing, name and port', async () => {
  const { keepass, page } = loadKeepass();
  page.settings.port = '19465';
  keepass.keyRing.h1 = { id: 'Laptop', key: 'k', keyGen: keepass.keyGeneration, status: 'ok' };
  keepass.testAssociation = async (t, triggerUnlock) => {
    keepass.lastTrigger = triggerUnlock;
    keepass.isKeePassHttpAvailable = true;
    keepass.isDatabaseClosed = false;
    keepass.databaseHash = 'h1';
    keepass.currentKeePassHttp = { version: '2.3.1.0', versionParsed: 2310 };
    return true;
  };
  const r = await call(keepass.checkConnection, true);
  assert.equal(keepass.lastTrigger, true);
  assert.equal(r.busy, false);
  assert.equal(r.pairingInFlight, false);
  assert.equal(r.testedWith, '2.3.1.0');
  assert.equal(r.pluginAvailable, true);
  assert.equal(r.databaseClosed, false);
  assert.equal(r.paired, true);
  assert.equal(r.associated, true);
  assert.equal(r.identifier, 'Laptop');
  assert.equal(r.port, 19465);
  assert.equal(r.version, '2.3.1.0');
  assert.equal(r.hash, 'h1');

  // Not paired and no plugin: no name, no hash, unlock flag not passed.
  delete keepass.keyRing.h1;
  keepass.testAssociation = async (t, triggerUnlock) => {
    keepass.lastTrigger = triggerUnlock;
    keepass.isKeePassHttpAvailable = false;
    keepass.databaseHash = 'no-hash';
    return false;
  };
  const r2 = await call(keepass.checkConnection, false);
  assert.equal(keepass.lastTrigger, false);
  assert.equal(r2.pluginAvailable, false);
  assert.equal(r2.paired, false);
  assert.equal(r2.identifier, null);
  assert.equal(r2.hash, null);
});

function loadBrowserAction(settings) {
  const stored = { settings };
  const browser = {
    storage: { local: { get: async () => stored, set: async () => {} } },
    browserAction: { setIcon: () => Promise.resolve(), setPopup() {} },
  };
  const page = { currentTabId: 1, tabs: { 1: { stack: [], credentials: null } }, clearCredentials() {} };
  const keepass = { isConfigured: async () => true };
  const kphIcon = { STATES: ['normal', 'save', 'choose', 'off'], imageData: () => null };
  const { browserAction } = loadBackground(
    ['background/browserAction.js'],
    { browser, page, keepass, kphIcon, window: { matchMedia() { throw new Error('none'); } }, setTimeout: () => 0, clearTimeout() {}, Date, isNaN, parseInt, console },
    ['browserAction'],
  );
  return { browserAction, page };
}

async function rememberStack(settings) {
  const { browserAction, page } = loadBrowserAction(settings);
  browserAction.setRememberPopup(1, 'u', 'p', 'https://x', false, []);
  await new Promise((r) => setImmediate(r));
  return page.tabs[1].stack[page.tabs[1].stack.length - 1];
}

test('save offer: blinkMinTimeout -1 (default) → page changes never close it', async () => {
  const s = await rememberStack({ blinkTimeout: '7500', blinkMinTimeout: '-1', allowedRedirect: '1' });
  assert.equal(s.visibleForMilliSeconds, '7500');
  assert.equal(s.redirectOffset, -1);
});

test('save offer: blinkMinTimeout 0 → page changes count from now (offset is a time stamp)', async () => {
  const before = Date.now();
  const s = await rememberStack({ blinkTimeout: '7500', blinkMinTimeout: '0', allowedRedirect: '2' });
  assert.ok(s.redirectOffset >= before, 'offset is an absolute time');
  assert.equal(s.visibleForPageUpdates, '2');
});

test('save offer: blinkMinTimeout 2000 → page changes count after 2 s', async () => {
  const before = Date.now();
  const s = await rememberStack({ blinkTimeout: '7500', blinkMinTimeout: '2000', allowedRedirect: '1' });
  assert.ok(s.redirectOffset >= before + 2000);
});

// ---------- requests with a controllable XMLHttpRequest ----------

function loadWithXhr() {
  const sent = [];
  class FakeXHR {
    constructor() { sent.push(this); }
    open() {}
    setRequestHeader() {}
    send(body) { this.body = JSON.parse(body); }
    abort() { this.onabort && this.onabort(); }
    answer(status, obj) { this.status = status; this.responseText = JSON.stringify(obj || {}); this.onload(); }
  }
  const browser = { storage: { local: { get: async () => ({ keyRing: {} }), set: async () => {}, remove: async () => {} } } };
  const page = { settings: { port: '19455' }, tabs: { 7: { errorMessage: null } }, debug() {}, clearAllLogins() {} };
  const browserAction = { show() {}, showDefault() {} };
  const { keepass } = loadBackground(
    ['background/cryptoHelpers.js', 'background/keepass.js'],
    { browser, page, browserAction, XMLHttpRequest: FakeXHR, console: { log() {} }, Date, JSON, String, parseInt, Promise, setTimeout, btoa, atob },
    ['keepass'],
  );
  keepass.keyRing = {};
  return { keepass, page, sent };
}
const tick = () => new Promise((r) => setImmediate(r));
// Waits until n requests were sent (the crypto steps before a request are async).
async function waitSent(sent, n) {
  for (let i = 0; i < 500 && sent.length < n; i++) await tick();
  assert.ok(sent.length >= n, 'expected ' + n + ' requests, got ' + sent.length);
}

test('getDatabaseHash: connection refused with no tab entry still resolves, marks KeePass unavailable', async () => {
  const { keepass, sent } = loadWithXhr();
  keepass.isKeePassHttpAvailable = true;
  const p = keepass.getDatabaseHash({ id: 999 });
  sent[0].onerror();
  assert.equal(await p, 'no-hash');
  assert.equal(keepass.isKeePassHttpAvailable, false);
});

test('settings check: a time-out means "busy", the known state stays', async () => {
  const { keepass, sent } = loadWithXhr();
  keepass.isKeePassHttpAvailable = true;
  keepass.databaseHash = 'h1';
  const p = call(keepass.checkConnection, false);
  assert.equal(sent[0].timeout, keepass.checkTimeout);
  sent[0].ontimeout();
  const r = await p;
  assert.equal(r.busy, true);
  assert.equal(r.pluginAvailable, true);
  assert.equal(r.hash, 'h1');
});

test('settings check: the unlock request has no time limit and asks for the unlock window', async () => {
  const { keepass, sent } = loadWithXhr();
  call(keepass.checkConnection, true);
  await tick();
  assert.equal(sent[0].timeout, undefined);
  assert.equal(sent[0].body.TriggerUnlock, 'true');
});

test('settings check: the poll never asks for the unlock window', async () => {
  const { keepass, sent } = loadWithXhr();
  call(keepass.checkConnection, false);
  await tick();
  assert.equal(sent[0].body.TriggerUnlock, false);
});

function startPairing(keepass, sent, expectedHash) {
  const result = new Promise((resolve) => keepass.associate(resolve, tab, expectedHash));
  sent[0].answer(200, { Success: false, Hash: 'h1', Version: '2.3.1.0' }); // database hash
  return { result };
}

test('pairing: in flight while waiting, the check sends nothing, cancel ends it', async () => {
  const { keepass, sent } = loadWithXhr();
  const { result } = startPairing(keepass, sent);
  await waitSent(sent, 2);
  assert.equal(sent[1].body.RequestType, 'associate');
  assert.equal(sent[1].timeout, keepass.pairingTimeout);
  const r = await call(keepass.checkConnection, false);
  assert.equal(r.pairingInFlight, true);
  assert.equal(sent.length, 2, 'no request while KeePass shows its dialog');
  // A second pairing is refused while one runs.
  const second = await call(keepass.associate);
  assert.equal(second.reason, 'busy');
  keepass.cancelAssociate(() => {});
  const res = await result;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'cancelled');
  assert.equal(keepass.pairing, null);
});

test('pairing: no answer in 60 s → reason "timeout"', async () => {
  const { keepass, sent } = loadWithXhr();
  const { result } = startPairing(keepass, sent);
  await waitSent(sent, 2);
  sent[1].ontimeout();
  assert.equal((await result).reason, 'timeout');
});

test('give access again: the open database must be the expected one', async () => {
  const { keepass, sent } = loadWithXhr();
  const res = await startPairing(keepass, sent, 'other-hash').result;
  assert.equal(res.reason, 'not-active');
  assert.equal(sent.length, 1, 'no associate request');
});

test('getDatabaseHash: an error from a port that is no longer set is ignored', async () => {
  const { keepass, page, sent } = loadWithXhr();
  keepass.isKeePassHttpAvailable = true;
  keepass.databaseHash = 'h1';
  const p = keepass.getDatabaseHash(tab);
  page.settings.port = '19475'; // changed while the request was waiting
  sent[0].onerror();
  assert.equal(await p, 'h1');
  assert.equal(keepass.isKeePassHttpAvailable, true);
});

test('settings check "cached": answers at once from the known state, sends nothing', async () => {
  const { keepass, sent } = loadWithXhr();
  keepass.isKeePassHttpAvailable = true;
  keepass.isDatabaseClosed = false;
  keepass.databaseHash = 'h1';
  keepass.keyRing.h1 = { id: 'Work', key: 'k', keyGen: keepass.keyGeneration, status: 'ok' };
  keepass.associated = { value: true, hash: 'h1' };
  const r = await call(keepass.checkConnection, false, true);
  assert.equal(sent.length, 0);
  assert.equal(r.pluginAvailable, true);
  assert.equal(r.associated, true);
  assert.equal(r.identifier, 'Work');
});

test('settings check "cached": before the first answer the state is reported as not known', async () => {
  const { keepass, sent } = loadWithXhr();
  const r1 = await call(keepass.checkConnection, false, true);
  assert.equal(r1.known, false);
  assert.equal(sent.length, 0);
  const p = keepass.getDatabaseHash(tab);
  sent[0].onerror(); // refused: that is something seen
  await p;
  const r2 = await call(keepass.checkConnection, false, true);
  assert.equal(r2.known, true);
  assert.equal(r2.pluginAvailable, false);
});
