// Item 7: the background trusts only Firefox's sender data, and content
// scripts may use only a small set of actions with checked arguments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './helpers.js';

const OWN_ID = 'keepasshttp-connector@test';
const OWN_BASE = 'moz-extension://11111111-2222-3333-4444-555555555555/';

function setup() {
  const sent = { invoked: [], logs: [] };
  const page = {
    currentTabId: 7,
    tabs: {},
    createTabEntry(id) { page.tabs[id] = { stack: [], errorMessage: null, loginList: {}, knownLogins: {} }; },
  };
  const browser = { runtime: { id: OWN_ID, getURL: (p) => OWN_BASE + p } };
  const { ctx, senderPolicy, cipevent } = loadBackground(['background/senderPolicy.js'], {
    URL, JSON, String, Object, page, browser,
    console: { log: (m) => sent.logs.push(m) },
  }, ['senderPolicy']);
  // Load only the message gate of event.js, with stub handlers.
  const fs = loadEventGate(ctx, sent);
  return { ctx, senderPolicy, page, sent, onMessage: fs };
}

import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { SRC } from './helpers.js';

function loadEventGate(ctx, sent) {
  const src = readFileSync(path.join(SRC, 'background/event.js'), 'utf8');
  const start = src.indexOf('cipevent.onMessage = function');
  const end = src.indexOf('/**', start);
  vm.runInContext('var cipevent = {};' + src.slice(start, end), ctx);
  const names = ['alert', 'associate', 'load_keyring', 'save_settings', 'retrieve_credentials',
    'set_remember_credentials', 'popup_login', 'load_settings', 'save_defined_credential_fields',
    'page_clear_logins', 'generate_password', 'show_default_browseraction', 'update_credentials'];
  ctx.cipevent.messageHandlers = {};
  for (const n of names) ctx.cipevent.messageHandlers[n] = n;
  ctx.cipevent.invoke = (handler, callback, tabId, args) => sent.invoked.push({ handler, callback, tabId, args });
  return (req, sender) => {
    const replies = [];
    const ret = ctx.cipevent.onMessage(req, sender, (v) => replies.push(v));
    return { ret, replies, last: sent.invoked[sent.invoked.length - 1] };
  };
}

// Tab URL = same origin as the frame (iframes here are same-origin; item 8 tests cross-origin).
const content = (url, frameId = 0) => ({ id: OWN_ID, url, frameId, tab: { id: 3, url } });
const popup = { id: OWN_ID, url: OWN_BASE + 'popups/popup.html' };
const plain = (v) => JSON.parse(JSON.stringify(v));

test('classify: own extension page, content script, foreign sender', () => {
  const { senderPolicy } = setup();
  assert.equal(senderPolicy.classify(popup, OWN_ID, OWN_BASE), 'extension');
  assert.equal(senderPolicy.classify(content('https://a.localhost/'), OWN_ID, OWN_BASE), 'content');
  assert.equal(senderPolicy.classify({ ...popup, id: 'other@ext' }, OWN_ID, OWN_BASE), null);
  assert.equal(senderPolicy.classify({ id: OWN_ID, url: 'moz-extension://other-uuid/x.html' }, OWN_ID, OWN_BASE), null);
});

test('content script cannot use privileged actions', () => {
  const { onMessage, sent } = setup();
  // save_settings no longer exists (item 14); here it stands for any privileged action.
  for (const action of ['associate', 'load_keyring', 'save_settings', 'update_credentials']) {
    const before = sent.invoked.length;
    onMessage({ action, args: [{ port: 1 }] }, content('https://evil.localhost/'));
    assert.equal(sent.invoked.length, before, action + ' must be refused');
  }
});

test('extension page may use privileged actions', () => {
  const { onMessage } = setup();
  const r = onMessage({ action: 'associate', args: [] }, popup);
  assert.equal(r.last.handler, 'associate');
  assert.equal(r.last.tabId, 7);
});

test('retrieve_credentials: URL comes from the sender, not from the message', () => {
  const { onMessage } = setup();
  const r = onMessage({ action: 'retrieve_credentials', args: ['https://bank.localhost', 'https://bank.localhost/login', 'yes', true] },
    content('https://evil.localhost:8080/page?x=1#y'));
  assert.deepEqual(plain(r.last.args), ['https://evil.localhost:8080', 'https://bank.localhost/login', true, true]);
});

test('retrieve_credentials: bad submit URL dropped; non-web frame gets nothing', () => {
  const { onMessage, sent } = setup();
  let r = onMessage({ action: 'retrieve_credentials', args: [null, 'javascript:alert(1)'] }, content('https://a.localhost/'));
  assert.equal(r.last.args[1], null);
  const before = sent.invoked.length;
  r = onMessage({ action: 'retrieve_credentials', args: [null, null] }, content('about:blank'));
  assert.equal(sent.invoked.length, before);
  assert.deepEqual(plain(r.replies), [[]]);
});

test('set_remember_credentials: URL and entry list come from the background', () => {
  const { onMessage, page } = setup();
  // The frame first receives one entry.
  let r = onMessage({ action: 'retrieve_credentials', args: [] }, content('https://a.localhost/login?token=secret', 2));
  r.last.callback([{ Login: 'user-one', Password: 'Dummy-Pass-1', Name: 'A', Uuid: 'u1' }]);
  assert.deepEqual(plain(page.tabs[3].knownLogins[2]), [{ Login: 'user-one', Name: 'A', Uuid: 'u1' }]);

  r = onMessage({ action: 'set_remember_credentials',
    args: ['user-one', 'New-Dummy-Pass', 'https://bank.localhost/', false, [{ Login: 'x', Name: 'Bank', Uuid: 'victim' }]] },
    content('https://a.localhost/login?token=secret#f', 2));
  assert.deepEqual(plain(r.last.args), ['user-one', 'New-Dummy-Pass', 'https://a.localhost/login', true,
    [{ Login: 'user-one', Name: 'A', Uuid: 'u1' }]]);

  // Another frame has no known entries.
  r = onMessage({ action: 'set_remember_credentials', args: ['u', 'p'] }, content('https://a.localhost/', 5));
  assert.deepEqual(plain(r.last.args[4]), []);
});

test('popup_login records the frame; labels are strings', () => {
  const { onMessage, page } = setup();
  const r = onMessage({ action: 'popup_login', args: [['a (A)', { toString: 1 }]] }, content('https://a.localhost/', 4));
  assert.equal(page.tabs[3].loginFrameId, 4);
  assert.equal(r.last.args[0].length, 2);
  assert.equal(typeof r.last.args[0][1], 'string');
});

test('load_settings: content gets only its own defined fields', () => {
  const { onMessage } = setup();
  const r = onMessage({ action: 'load_settings' }, content('https://a.localhost/x'));
  r.last.callback({ port: 19465, 'defined-credential-fields': {
    'https://a.localhost': { username: 'u', password: 'p', fields: [] },
    'https://other.localhost': { username: 'x', password: 'y', fields: [] } } });
  assert.deepEqual(Object.keys(r.replies[0]['defined-credential-fields']), ['https://a.localhost']);
});

test('save_defined_credential_fields: only for the sender origin, shape checked', () => {
  const { onMessage, sent } = setup();
  let r = onMessage({ action: 'save_defined_credential_fields', args: [{ username: 'id1', password: { x: 1 }, fields: ['f', {}], port: 1 }] },
    content('https://a.localhost/x'));
  assert.deepEqual(plain(r.last.args), ['https://a.localhost', { username: 'id1', password: null, fields: ['f'] }]);
  r = onMessage({ action: 'save_defined_credential_fields', args: [{ username: 42, password: 'cIPJQ2', fields: [7] }] },
    content('https://a.localhost/x'));
  assert.deepEqual(plain(r.last.args[1]), { username: 42, password: 'cIPJQ2', fields: [7] });
  r = onMessage({ action: 'save_defined_credential_fields', args: [null] }, content('https://a.localhost/x'));
  assert.deepEqual(plain(r.last.args), ['https://a.localhost', null]);
  const before = sent.invoked.length;
  onMessage({ action: 'save_defined_credential_fields', args: ['bad'] }, content('https://a.localhost/x'));
  assert.equal(sent.invoked.length, before);
});

test('unknown action and inherited names are ignored', () => {
  const { onMessage, sent } = setup();
  onMessage({ action: 'toString' }, popup);
  onMessage({ action: 'nope' }, popup);
  assert.equal(sent.invoked.length, 0);
});

// Item 8: cross-origin iframes get no logins and cannot save or show logins.
const frame = (url, top, frameId = 3) => ({ id: OWN_ID, url, frameId, tab: { id: 3, url: top } });

test('isCrossOriginFrame: top frame, same-origin and cross-origin iframes', () => {
  const { senderPolicy } = setup();
  assert.equal(senderPolicy.isCrossOriginFrame(frame('https://a.localhost/x', 'https://evil.localhost/', 0)), false);
  assert.equal(senderPolicy.isCrossOriginFrame(frame('https://a.localhost/x', 'https://a.localhost/y')), false);
  assert.equal(senderPolicy.isCrossOriginFrame(frame('https://a.localhost/x', 'https://evil.localhost/')), true);
  assert.equal(senderPolicy.isCrossOriginFrame(frame('https://a.localhost/x', 'http://a.localhost/')), true);
  assert.equal(senderPolicy.isCrossOriginFrame(frame('https://a.localhost:444/', 'https://a.localhost/')), true);
  assert.equal(senderPolicy.isCrossOriginFrame(frame('https://a.localhost/x', undefined)), true);
});

test('cross-origin iframe: retrieve gets [], popup_login and save are dropped', () => {
  const { onMessage, sent, page } = setup();
  const xo = frame('https://bank.localhost/login', 'https://evil.localhost/');
  const before = sent.invoked.length;
  const r = onMessage({ action: 'retrieve_credentials', args: [] }, xo);
  assert.deepEqual(plain(r.replies), [[]]);
  onMessage({ action: 'popup_login', args: [['x']] }, xo);
  onMessage({ action: 'set_remember_credentials', args: ['u', 'p'] }, xo);
  assert.equal(sent.invoked.length, before);
  assert.equal(page.tabs[3].loginFrameId, undefined);
  // same-origin iframe still works
  const so = onMessage({ action: 'retrieve_credentials', args: [] }, frame('https://a.localhost/login', 'https://a.localhost/'));
  assert.equal(so.last.args[0], 'https://a.localhost');
});
