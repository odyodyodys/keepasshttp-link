// Item 11: the extension talks only to the local KeePassHttp. No online update
// check, no request code anywhere else, no permission for GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { SRC } from './helpers.js';

function ownJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...ownJsFiles(p));
    else if (name.endsWith('.js') && !name.endsWith('.min.js')) out.push(p);
  }
  return out;
}

test('only keepass.js makes HTTP requests (one XMLHttpRequest, no fetch)', () => {
  const hits = [];
  for (const f of ownJsFiles(SRC)) {
    const src = readFileSync(f, 'utf8');
    for (const re of [/new XMLHttpRequest\s*\(/g, /\bfetch\s*\(/g, /navigator\.sendBeacon/g, /new WebSocket/g]) {
      for (const _ of src.matchAll(re)) hits.push(path.relative(SRC, f).replace(/\\/g, '/') + ' ' + re.source);
    }
  }
  assert.deepEqual(hits, ['background/keepass.js new XMLHttpRequest\\s*\\(']);
});

test('no update-check code or GitHub request URL is left', () => {
  for (const f of ownJsFiles(SRC)) {
    const src = readFileSync(f, 'utf8');
    for (const word of ['latestVersionUrl', 'checkForNewKeePassHttpVersion', 'raw.githubusercontent', 'raw.github.com', 'update_available_keepasshttp', 'check_update_keepasshttp']) {
      assert.ok(!src.includes(word), `${path.relative(SRC, f)} contains ${word}`);
    }
  }
});

test('manifest has no permission for GitHub', () => {
  const m = JSON.parse(readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  assert.ok(!m.permissions.some((p) => /github/i.test(p)), JSON.stringify(m.permissions));
});

// Item 13: manifest uses browser_specific_settings, states that no data is
// collected, and asks only for the permissions the code uses.
test('manifest: no deprecated key, no data collection, minimal permissions', () => {
  const m = JSON.parse(readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  assert.equal(m.applications, undefined);
  assert.deepEqual(m.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
  assert.deepEqual([...m.permissions].sort(), [
    'clipboardWrite',      // item 19: password generator copy / clear
    'contextMenus',        // "Fill User + Pass" menu
    'http://*/*',          // content pages, tab URLs, HTTP auth, local KeePassHttp
    'https://*/*',
    'storage',
    'webRequest',          // HTTP Basic Auth (onAuthRequired)
    'webRequestBlocking',
  ]);
  // Item 17: no file is page-accessible (the page UI is in closed shadow roots,
  // icons are inline SVG), so pages cannot load extension files or learn its URL.
  assert.equal(m.web_accessible_resources, undefined);
  // Content script: no jQuery (item 17d), no injected CSS.
  const cs = m.content_scripts[0];
  assert.deepEqual(cs.js, ['kphc.js']);
  assert.equal(cs.css, undefined);
});
