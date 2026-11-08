// Test runner: starts the fake KeePassHttp server and the test pages, then
// drives Firefox (fresh temporary profile) with the extension from ../src
// loaded as a temporary add-on. DUMMY DATA ONLY.
//
// Usage:  npm test                       (all scenarios, headless)
//         HEADLESS=0 npm test            (visible window)
//         npm test -- single multi       (only some scenarios)
//         npm run test:real              (use the test KeePass, port 19465)
//
// Output: one summary line (exit code 1 on any failure),
//         test/artifacts/report.json and <scenario>.png

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder, By, Key } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { download as downloadGeckodriver } from 'geckodriver';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..', 'src');
const ART = path.join(here, 'artifacts');
const CACHE = path.join(here, '.cache');
mkdirSync(ART, { recursive: true });
mkdirSync(path.join(CACHE, 'profiles'), { recursive: true });

const FIREFOX = process.env.FIREFOX_BIN || 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const GECKODRIVER_VERSION = '0.37.1';
const EXT_ID = 'keepasshttp-link@odyodyodys.github.io';
const EXT_UUID = '5b0f6f0e-6b8e-4b7e-9d55-0c1a7e5b9a01'; // fixed so we can open extension pages
const EXT_BASE = `moz-extension://${EXT_UUID}`;
// --real (or NO_MOCK=1): use the test KeePass (default port 19465) instead of the fake server.
const USE_MOCK = process.env.NO_MOCK !== '1' && !process.argv.includes('--real');
const KPH_PORT = Number(process.env.KPH_PORT || (USE_MOCK ? 19475 : 19465));
const PAGES = 'http://{host}.localhost:8080';
// Same server and port, over TLS (item 6: auto-fill only on https pages).
const PAGES_TLS = 'https://{host}.localhost:8080';
const HEADLESS = process.env.HEADLESS !== '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- servers ----------
// Mock: extension talks to the fake server directly.
// Real KeePass: extension talks to a logging proxy on KPH_PORT+1.
const EXT_PORT = USE_MOCK ? KPH_PORT : KPH_PORT + 1;
if (USE_MOCK) {
  process.env.MOCK_PORT = String(KPH_PORT);
  await import('./mock-keepasshttp/server.js');
} else {
  process.env.PROXY_PORT = String(EXT_PORT);
  process.env.PROXY_TARGET = `http://localhost:${KPH_PORT}`;
  await import('./mock-keepasshttp/proxy.js');
}
await import('./pages/server.js');
await sleep(300);

async function kphStats() {
  return (await fetch(`http://127.0.0.1:${EXT_PORT}/__stats`)).json();
}
async function kphReset() {
  await fetch(`http://127.0.0.1:${EXT_PORT}/__reset`, { method: 'POST' });
}
// Item 3: make the fake server / proxy tamper with successful responses.
async function setTamper(mode) {
  const r = await fetch(`http://127.0.0.1:${EXT_PORT}/__mode`, { method: 'POST', body: JSON.stringify({ tamper: mode }) });
  if (!r.ok) throw new Error('setTamper ' + mode + ': HTTP ' + r.status);
}

// ---------- Firefox ----------
async function startFirefox() {
  const driverPath = await downloadGeckodriver(GECKODRIVER_VERSION, CACHE);
  const opts = new firefox.Options()
    .setBinary(FIREFOX)
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ [EXT_ID]: EXT_UUID }))
    .setPreference('network.dns.localDomains', 'single.localhost,multi.localhost,bank.localhost,evilbank.localhost,utf8.localhost,save.localhost')
    .setPreference('signon.rememberSignons', process.env.FF_PWMGR === '1')
    .setPreference('signon.autofillForms', process.env.FF_PWMGR === '1')
    .setPreference('browser.shell.checkDefaultBrowser', false)
    // DARK=1: pages see prefers-color-scheme: dark (for visual checks with SHOTS=1).
    .setPreference('layout.css.prefers-color-scheme.content-override', process.env.DARK === '1' ? 0 : 1)
    .setPreference('datareporting.policy.dataSubmissionEnabled', false)
    .setPreference('app.update.auto', false)
    .setAcceptInsecureCerts(true); // self-signed test certificate (test profile only)
  if (HEADLESS) opts.addArguments('-headless');
  // --allow-system-access: needed to open moz-extension:// pages from the chrome context (test profile only).
  const service = new firefox.ServiceBuilder(driverPath).addArguments('--allow-system-access', '--profile-root', path.join(CACHE, 'profiles'));
  const driver = await new Builder().forBrowser('firefox')
    .setFirefoxOptions(opts).setFirefoxService(service).build();
  await driver.installAddon(SRC, true);
  return driver;
}

// Runs in an extension page (has browser.* APIs).
async function extCall(driver, action, args) {
  return driver.executeAsyncScript(function (action, args, done) {
    browser.runtime.sendMessage({ action, args }).then(
      (r) => done({ ok: true, r: r === undefined ? null : r }),
      (e) => done({ ok: false, e: String(e) }));
    setTimeout(() => done({ ok: false, e: 'timeout' }), 8000);
  }, action, args);
}

// geckodriver refuses driver.get() on moz-extension:// URLs, so open them as
// a tab from the chrome context, then switch to that tab. Reuses one tab.
let extHandle = null;
let webHandle = null;
async function openExtPage(driver, rel) {
  const url = `${EXT_BASE}/${rel}`;
  if (!webHandle) webHandle = await driver.getWindowHandle();
  if (extHandle) {
    await driver.switchTo().window(extHandle);
    await driver.executeScript(`location.href = ${JSON.stringify(url)}`);
  } else {
    const before = new Set(await driver.getAllWindowHandles());
    await driver.setContext(firefox.Context.CHROME);
    await driver.executeScript(function (u) {
      const w = Services.wm.getMostRecentWindow('navigator:browser');
      w.gBrowser.addTab(u, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    }, url);
    await driver.setContext(firefox.Context.CONTENT);
    for (let i = 0; i < 20 && !extHandle; i++) {
      await sleep(200);
      extHandle = (await driver.getAllWindowHandles()).find((h) => !before.has(h)) || null;
    }
    await driver.switchTo().window(extHandle);
  }
  await sleep(600);
}
async function toWebTab(driver) {
  await driver.switchTo().window(webHandle);
  // make it the selected tab so tab-activation logic behaves like a user
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript(function () {
    const w = Services.wm.getMostRecentWindow('navigator:browser');
    w.gBrowser.selectedTab = w.gBrowser.tabs[0];
  });
  await driver.setContext(firefox.Context.CONTENT);
}

async function configure(driver, settingsPatch) {
  await openExtPage(driver, 'options/options.html');
  await driver.executeAsyncScript(function (patch, done) {
    browser.storage.local.get({ settings: {} }).then((it) => {
      const s = Object.assign(it.settings, patch);
      return browser.storage.local.set({ settings: s });
    }).then(() => browser.runtime.sendMessage({ action: 'load_settings' }))
      .then((s) => done(!s ? 'no settings' : ('hostname' in s) ? 'hostname setting was not removed'
        : ('checkUpdateKeePassHttp' in s) ? 'checkUpdateKeePassHttp setting was not removed' : true),
        (e) => done(String(e)));
    // Item 2: an old remote "hostname" setting must be ignored and removed.
    // All scenarios still reach the server, so the request went to localhost.
    // Item 11: the old update-check setting must be removed too.
  }, Object.assign({ hostname: 'remote.invalid', checkUpdateKeePassHttp: 3, port: String(EXT_PORT) }, settingsPatch))
    .then((r) => { if (r !== true) throw new Error('configure: ' + r); });
  await toWebTab(driver);
  // Returning to the web tab makes the open page fetch again (its credentials
  // were cleared when it lost focus). Let that finish before a scenario counts.
  await sleep(1000);
}

// Real KeePass: the plugin always shows a modal "associate" dialog and blocks
// all other requests while it is open. So we associate ONCE (SETUP=1), save
// the extension's keyRing to test/.cache, and restore it into every new
// profile. The saved key is for the dummy test database only (git-ignored).
const KEYRING_FILE = path.join(CACHE, `keyring-${KPH_PORT}.json`);
const SETUP = process.env.SETUP === '1';

async function readKeyRing(driver) {
  return driver.executeAsyncScript(function (done) {
    browser.storage.local.get({ keyRing: {} }).then((it) => done(it.keyRing), () => done(null));
  });
}

async function restoreKeyRing(driver, keyRing) {
  return driver.executeAsyncScript(function (kr, done) {
    browser.storage.local.set({ keyRing: kr })
      .then(() => browser.runtime.sendMessage({ action: 'load_keyring' }))
      .then(() => done(true), (e) => done(String(e)));
  }, keyRing);
}

async function associate(driver) {
  // options.html, not popup.html: popup.js calls window.close() after "associate".
  await openExtPage(driver, 'options/options.html');
  const isOk = (s) => !!(s && s.ok && s.r && s.r.associated);

  if (!USE_MOCK && existsSync(KEYRING_FILE)) {
    await restoreKeyRing(driver, JSON.parse(readFileSync(KEYRING_FILE, 'utf8')));
  }
  let st = await extCall(driver, 'get_status');

  if (!isOk(st)) {
    if (!USE_MOCK && !SETUP) {
      await toWebTab(driver);
      throw new Error(existsSync(KEYRING_FILE)
        ? 'Saved test association was rejected (by the extension, e.g. an old weak key, or by KeePass). Run once with SETUP=1 to create a new one.'
        : 'No saved test association. Run once with SETUP=1 and confirm the KeePass dialog.');
    }
    if (!USE_MOCK) console.log('\n>>> Confirm the "associate" dialog in the TEST KeePass now (waiting up to 5 min) <<<\n');
    await driver.executeScript(function () { browser.runtime.sendMessage({ action: 'associate' }); });
    // Poll slowly: each get_status sends requests, and the plugin is blocked while the dialog is open.
    const step = USE_MOCK ? 500 : 3000;
    const tries = USE_MOCK ? 40 : 100;
    for (let i = 0; i < tries; i++) {
      await sleep(step);
      st = await extCall(driver, 'get_status');
      if (isOk(st)) break;
    }
    if (isOk(st) && !USE_MOCK) {
      writeFileSync(KEYRING_FILE, JSON.stringify(await readKeyRing(driver), null, 2));
      console.log(`[setup] test association "${st.r.identifier}" saved to ${KEYRING_FILE}`);
    }
  }
  await toWebTab(driver);
  if (!isOk(st)) throw new Error('association failed: ' + JSON.stringify(st));
  return st.r;
}

// Item 17a: the login dropdown is in a CLOSED shadow root. The page cannot
// see inside; WebDriver can (measured with geckodriver 0.37.1).
async function dropdownState(driver) {
  const hosts = await driver.findElements(By.id('kphc-ac-host'));
  const out = { hosts: hosts.length, open: false, items: [], warning: false, redMenu: false, pageSeesShadow: null };
  if (!hosts.length) return out;
  out.pageSeesShadow = await driver.executeScript("return document.getElementById('kphc-ac-host').shadowRoot !== null");
  out.open = await hosts[0].isDisplayed();
  if (!out.open) return out;
  const sr = await hosts[0].getShadowRoot();
  for (const li of await sr.findElements(By.css('li[role=option]'))) out.items.push(await li.getText());
  const warn = await sr.findElements(By.css('li[role=alert]'));
  out.warning = warn.length > 0 && await warn[0].isDisplayed();
  out.redMenu = (await (await sr.findElement(By.css('ul'))).getCssValue('border-top-color')) === 'rgb(176, 0, 32)';
  return out;
}
async function clickDropdownItem(driver, index = 0) {
  const sr = await (await driver.findElement(By.id('kphc-ac-host'))).getShadowRoot();
  await (await sr.findElements(By.css('li[role=option]')))[index].click();
}

// Polls fn() until it returns a truthy value or maxMs passes; returns the last value.
async function waitFor(fn, maxMs, stepMs = 100) {
  const end = Date.now() + maxMs;
  let v = await fn();
  while (!v && Date.now() < end) {
    await sleep(stepMs);
    v = await fn();
  }
  return v;
}

// Loads a page and waits until the extension's login lookup for it is done:
// a new get-logins request in the server/proxy log, then 400 ms without new
// requests. Pages that do no lookup wait the full maxMs (the old fixed sleep).
async function openPage(driver, url, maxMs = 4000) {
  const since = Date.now();
  await driver.get(url);
  await waitFor(async () => {
    const log = (await kphStats()).log.filter((l) => l.t >= since);
    return log.some((l) => l.type === 'get-logins') && Date.now() - log[log.length - 1].t >= 400;
  }, maxMs);
}

// Clicks a field and waits until the login dropdown shows items (max maxMs).
async function openDropdown(driver, id = 'username', maxMs = 1500) {
  await driver.findElement(By.id(id)).click();
  let d;
  await waitFor(async () => (d = await dropdownState(driver)).items.length > 0, maxMs);
  return d;
}

// Runs fn(extension, selectedTab, ...args) in Firefox's chrome context.
async function inChrome(driver, fn, ...args) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    return await driver.executeScript(`
      const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
      const [id, ...rest] = arguments;
      const ext = ExtensionParent.GlobalManager.getExtension(id);
      const tab = Services.wm.getMostRecentWindow('navigator:browser').gBrowser.selectedTab;
      return (${fn})(ext, tab, ExtensionParent, ...rest);`, EXT_ID, ...args);
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function pageState(driver) {
  const s = await driver.executeScript(function () {
    return {
      events: (window.__kph && window.__kph.events) || [],
      genpwIcons: document.querySelectorAll('kphc-key').length,
      usernameLen: (document.getElementById('username') || {}).value?.length ?? null,
      passwordLen: (document.getElementById('password') || {}).value?.length ?? null,
    };
  });
  const d = await dropdownState(driver);
  s.autocompleteMenus = d.hosts;
  s.autocompleteItemsVisible = d.items;
  s.insecureWarningVisible = d.warning;
  s.insecureMenu = d.redMenu;
  s.pageSeesDropdown = d.pageSeesShadow;
  return s;
}

// Mock request log, times relative to the first request (ms). No secrets.
function timeline(stats) {
  if (!stats || !stats.log.length) return [];
  const t0 = stats.log[0].t;
  return stats.log.map((l) => [
    `${l.t - t0}ms ${l.type}`,
    l.url ? l.url : '',
    l.status !== undefined ? `HTTP ${l.status}` : '',
    l.entries !== undefined ? `entries=${l.entries}` : '',
    l.verified ? '' : '(unverified)',
    l.error ? `ERROR: ${l.error.split(/\r?\n/)[0]}` : '',
  ].filter(Boolean).join(' '));
}
// Page events (untrusted = set by script), times = ms since page start.
function fillTimeline(events) {
  return events.filter((e) => !e.trusted && e.type === 'input').map((e) => `${e.t}ms ${e.field} len=${e.len}`);
}

function countEvents(events, field, type, since = 0) {
  return events.filter((e) => e.field === field && e.type === type && e.t >= since && !e.trusted).length;
}

// ---------- scenarios ----------
const scenarios = {
  // Default settings: autoFillSingleEntry=false -> autocomplete on username.
  async single(driver) {
    await configure(driver, { autoFillSingleEntry: false });
    await kphReset();
    await openPage(driver, PAGES.replace('{host}', 'single') + '/login.html', 4000);
    const afterLoad = await pageState(driver);
    const statsLoad = await kphStats();

    await driver.findElement(By.id('username')).click();
    await sleep(1200);
    const afterFocus = await pageState(driver);

    // Close the dropdown (it covers the next field), then blur username.
    await driver.findElement(By.id('username')).sendKeys(Key.ESCAPE);
    await sleep(300);
    await driver.findElement(By.id('other')).click();
    await sleep(2000);
    const afterBlur = await pageState(driver);
    const statsEnd = await kphStats();
    return {
      getLoginsOnLoad: statsLoad?.byType['get-logins'] ?? 'n/a',
      requestsOnLoad: statsLoad?.byType,
      autocompleteItemsOnFocus: afterFocus.autocompleteItemsVisible,
      autocompleteMenus: afterFocus.autocompleteMenus,
      getLoginsTotalAfterBlur: statsEnd?.byType['get-logins'] ?? 'n/a',
      genpwIcons: afterBlur.genpwIcons,
      untrustedInputEventsOnUsername: countEvents(afterBlur.events, 'username', 'input'),
      untrustedInputEventsOnPassword: countEvents(afterBlur.events, 'password', 'input'),
      afterLoad: { usernameLen: afterLoad.usernameLen, passwordLen: afterLoad.passwordLen },
      requestTimeline: timeline(statsEnd),
      fillTimeline: fillTimeline(afterBlur.events),
      // Item 4: one request per page load, none extra on focus/blur.
      pass: statsLoad?.byType['get-logins'] === 1 && statsEnd?.byType['get-logins'] === 1 &&
        afterFocus.autocompleteItemsVisible.length === 1,
    };
  },

  // autoFillSingleEntry=true -> fields filled on load. Expect exactly 1 fill.
  async autofill(driver) {
    await configure(driver, { autoFillSingleEntry: true });
    await kphReset();
    await openPage(driver, PAGES_TLS.replace('{host}', 'single') + '/login.html', 4000);
    const s = await pageState(driver);
    const stats = await kphStats();
    await configure(driver, { autoFillSingleEntry: false });
    return {
      getLoginsOnLoad: stats?.byType['get-logins'] ?? 'n/a',
      requestsOnLoad: stats?.byType,
      fillsUsername: countEvents(s.events, 'username', 'input'),
      fillsPassword: countEvents(s.events, 'password', 'input'),
      changeEventsPassword: countEvents(s.events, 'password', 'change'),
      filled: { usernameLen: s.usernameLen, passwordLen: s.passwordLen },
      requestTimeline: timeline(stats),
      fillTimeline: fillTimeline(s.events),
      // Item 4: exactly one request and one fill per field.
      pass: stats?.byType['get-logins'] === 1 && countEvents(s.events, 'username', 'input') === 1 &&
        countEvents(s.events, 'password', 'input') === 1 && s.passwordLen > 0,
    };
  },

  // Two entries -> dropdown should list each login once.
  async multi(driver) {
    await configure(driver, { autoFillSingleEntry: false });
    await kphReset();
    await openPage(driver, PAGES.replace('{host}', 'multi') + '/login.html', 4000);
    const stats = await kphStats();
    await driver.findElement(By.id('username')).click();
    await sleep(1200);
    const s = await pageState(driver);
    return {
      getLoginsOnLoad: stats?.byType['get-logins'] ?? 'n/a',
      autocompleteItemsOnFocus: s.autocompleteItemsVisible,
      autocompleteMenus: s.autocompleteMenus,
      pageSeesDropdown: s.pageSeesDropdown,
      pass: stats?.byType['get-logins'] === 1 && s.autocompleteItemsVisible.length === 2 && s.pageSeesDropdown === false,
    };
  },

  // Item 1: a key without keyGen (made by the old Math.random code) must not
  // be used. The entry stays, marked lost ("weak"), without its key.
  // Restores the valid key afterwards.
  async weakkey(driver) {
    await openExtPage(driver, 'options/options.html');
    const good = await readKeyRing(driver);
    const weak = JSON.parse(JSON.stringify(good));
    for (const h of Object.keys(weak)) delete weak[h].keyGen;
    await restoreKeyRing(driver, weak);
    const st = await extCall(driver, 'get_status');
    const after = await readKeyRing(driver);
    await restoreKeyRing(driver, good);
    const back = await extCall(driver, 'get_status');
    await toWebTab(driver);
    const entries = Object.values(after);
    const marked = entries.length === Object.keys(good).length &&
      entries.every((e) => e.status === 'lost' && e.lostReason === 'weak' && !('key' in e));
    return {
      weakKeyAccepted: !!(st.r && st.r.associated),
      entriesKeptAndMarked: marked,
      validKeyAcceptedAgain: !!(back.r && back.r.associated),
      pass: !(st.r && st.r.associated) && marked && !!(back.r && back.r.associated),
    };
  },

  // Item 3: every verified request carries Hmac; a successful response with a
  // missing or wrong Hmac is rejected (no fill), the key is kept, and normal
  // traffic works again afterwards. Tampering is done by the fake server or proxy.
  async hmac(driver) {
    const loadAndRead = async () => {
      await openPage(driver, PAGES_TLS.replace('{host}', 'single') + '/login.html', 3000);
      return pageState(driver);
    };
    await configure(driver, { autoFillSingleEntry: true });
    await setTamper('none');
    await kphReset();
    const base = await loadAndRead();
    const baseStats = await kphStats();
    const verifiedWithoutHmac = baseStats.log.filter((l) => l.verified && !l.hmac).length;
    const out = { baseline: { passwordLen: base.passwordLen, verifiedRequests: baseStats.log.filter((l) => l.verified).length, verifiedWithoutHmac } };
    let ok = base.passwordLen > 0 && verifiedWithoutHmac === 0 && out.baseline.verifiedRequests > 0;
    for (const mode of ['hmac-missing', 'hmac-bad', 'nonce-swap']) {
      await setTamper(mode);
      const s1 = await loadAndRead(); // cached association -> get-logins response tampered
      const s2 = await loadAndRead(); // test-associate response tampered
      await openExtPage(driver, 'options/options.html');
      const st = await extCall(driver, 'get_status');
      const ring = await readKeyRing(driver);
      await toWebTab(driver);
      const r = {
        filled: [s1.passwordLen, s2.passwordLen],
        associated: !!(st.r && st.r.associated),
        error: st.r && st.r.error,
        keysKept: Object.keys(ring).length,
      };
      r.pass = s1.passwordLen === 0 && s2.passwordLen === 0 && !r.associated &&
        /integrity check \(HMAC\)/.test(r.error || '') && r.keysKept === 1;
      ok = ok && r.pass;
      out[mode] = r;
    }
    await setTamper('none');
    const after = await loadAndRead();
    out.afterRestore = { passwordLen: after.passwordLen };
    ok = ok && after.passwordLen > 0;
    await configure(driver, { autoFillSingleEntry: false });
    out.pass = ok;
    return out;
  },

  // Item 5: HTTP Basic Auth. Default: auto-send off. Even when turned on,
  // nothing is sent automatically to an http:// page. (The https:// case is
  // covered by unit tests; the test pages have no TLS.)
  async basicauth(driver) {
    const basic = PAGES.replace('{host}', 'single');
    const stats = async () => (await fetch(basic + '/__basic')).json();
    const visit = async () => {
      await fetch(basic + '/__basic/reset', { method: 'POST' });
      // Not driver.get(): the auth prompt would block the page load.
      await driver.executeScript('location.href = arguments[0]', basic + '/basic');
      await sleep(3000);
      try { await driver.switchTo().alert().dismiss(); } catch { /* no prompt */ }
      await sleep(500);
      const s = await stats();
      await driver.get(basic + '/login.html').catch(() => {});
      return s;
    };
    await openExtPage(driver, 'options/options.html');
    const def = await driver.executeAsyncScript(function (done) {
      browser.storage.local.get({ settings: {} }).then((it) => done(it.settings.autoFillAndSend));
    });
    await toWebTab(driver);
    const off = await visit();
    await configure(driver, { autoFillAndSend: true });
    await openExtPage(driver, 'options/options.html');
    await extCall(driver, 'init_http_auth');
    await toWebTab(driver);
    const onHttp = await visit();
    await configure(driver, { autoFillAndSend: false });
    await openExtPage(driver, 'options/options.html');
    await extCall(driver, 'init_http_auth');
    await toWebTab(driver);
    return {
      defaultSetting: def,
      settingOff: off,
      settingOnHttp: onHttp,
      pass: def === false && off.withoutAuth >= 1 && off.withAuth === 0 && onHttp.withoutAuth >= 1 && onHttp.withAuth === 0,
    };
  },

  // Item 6 (measurement): does KeePass return the "bank.localhost" entry on
  // the look-alike host "evilbank.localhost"? Plugin host match has no dot boundary.
  async lookalike(driver) {
    await configure(driver, { autoFillSingleEntry: false });
    const out = {};
    for (const host of ['bank', 'evilbank']) {
      await kphReset();
      await openPage(driver, PAGES.replace('{host}', host) + '/login.html', 4000);
      const st = await kphStats();
      await driver.findElement(By.id('username')).click();
      await sleep(1200);
      const s = await pageState(driver);
      await driver.findElement(By.id('username')).sendKeys(Key.ESCAPE);
      out[host] = {
        entriesReturned: st.log.filter((l) => l.type === 'get-logins').map((l) => l.entries ?? (l.url ? 'mock' : null)),
        dropdown: s.autocompleteItemsVisible,
        requestTimeline: timeline(st),
      };
    }
    out.bankFound = out.bank.dropdown.length === 1;
    out.leak = out.evilbank.dropdown.length > 0;
    out.pass = out.bankFound && !out.leak;
    return out;
  },

  // Item 6: on a not-secure page (http, or https with a form posting to http)
  // nothing is auto-filled and the dropdown is red with a warning line. The
  // user can still choose the login. On https: no warning, auto-fill works.
  async insecure(driver) {
    await configure(driver, { autoFillSingleEntry: true });
    const check = async (url, pick) => {
      await openPage(driver, url, 3000);
      const loaded = await pageState(driver);
      await driver.executeScript("document.getElementById('other').focus()");
      await sleep(300);
      await driver.findElement(By.id('username')).click();
      await sleep(1200);
      const open = await pageState(driver);
      if (open.insecureWarningVisible && pick) {
        writeFileSync(path.join(ART, 'insecure-dropdown.png'), await driver.takeScreenshot(), 'base64');
      }
      let picked = null;
      if (pick && open.autocompleteItemsVisible.length) {
        await clickDropdownItem(driver, 0);
        await sleep(1000);
        picked = (await pageState(driver)).passwordLen;
      }
      await driver.findElement(By.id('username')).sendKeys(Key.ESCAPE).catch(() => {});
      return { autoFilledPasswordLen: loaded.passwordLen, items: open.autocompleteItemsVisible.length,
        warning: open.insecureWarningVisible, redMenu: open.insecureMenu, passwordLenAfterPick: picked };
    };
    const http = await check(PAGES.replace('{host}', 'single') + '/login.html', true);
    const httpAction = await check(PAGES_TLS.replace('{host}', 'single') + '/login-httpaction.html', false);
    const tls = await check(PAGES_TLS.replace('{host}', 'single') + '/login.html', false);
    await configure(driver, { autoFillSingleEntry: false });
    return {
      http, httpsFormToHttp: httpAction, https: tls,
      pass: http.autoFilledPasswordLen === 0 && http.warning && http.redMenu && http.items === 1 && http.passwordLenAfterPick > 0 &&
        httpAction.autoFilledPasswordLen === 0 && httpAction.warning &&
        tls.autoFilledPasswordLen > 0 && !tls.warning && !tls.redMenu,
    };
  },

  // Form appears after 2.5 s.
  async late(driver) {
    await configure(driver, { autoFillSingleEntry: false });
    await kphReset();
    await openPage(driver, PAGES.replace('{host}', 'single') + '/login-late.html', 6000);
    const stats = await kphStats();
    await driver.findElement(By.id('username')).click();
    await sleep(1200);
    const s = await pageState(driver);
    return {
      getLoginsTotal: stats?.byType['get-logins'] ?? 'n/a',
      requests: stats?.byType,
      autocompleteItemsOnFocus: s.autocompleteItemsVisible,
      pass: stats?.byType['get-logins'] === 1 && s.autocompleteItemsVisible.length === 1,
    };
  },

  // Item 4: switching to another tab and back must not fill again. Leaving a
  // tab clears its credentials, so at most one new request per return is OK.
  async tabswitch(driver) {
    await configure(driver, { autoFillSingleEntry: true });
    await kphReset();
    await openPage(driver, PAGES_TLS.replace('{host}', 'single') + '/login.html', 3000);
    const before = await kphStats();
    for (let i = 0; i < 2; i++) {
      await openExtPage(driver, 'options/options.html');
      await sleep(500);
      await toWebTab(driver);
      await sleep(1500);
    }
    const s = await pageState(driver);
    const after = await kphStats();
    await configure(driver, { autoFillSingleEntry: false });
    return {
      getLoginsOnLoad: before?.byType['get-logins'],
      getLoginsAfterSwitches: after?.byType['get-logins'],
      fillsPassword: countEvents(s.events, 'password', 'input'),
      pass: before?.byType['get-logins'] === 1 && after?.byType['get-logins'] <= 1 + 2 &&
        countEvents(s.events, 'password', 'input') === 1,
    };
  },

  // Item 4: re-detecting fields must not stack event handlers. One click on
  // the username field must render the dropdown as often after two
  // "redetect_fields" as on a fresh page (stacked focus/click handlers each
  // ran the search again).
  async stacking(driver) {
    // Item 17a: the dropdown is in a closed shadow root, so count effects:
    // one dropdown host, same items, and ONE password fill when the user types
    // the username and leaves the field (stacked handlers filled twice).
    const measure = async () => {
      await driver.executeScript("document.getElementById('other').focus()");
      await sleep(300);
      await driver.findElement(By.id('username')).click();
      await sleep(1200);
      const d = await dropdownState(driver);
      await driver.findElement(By.id('username')).sendKeys(Key.ESCAPE);
      const t0 = await driver.executeScript('return Math.round(performance.now())');
      await driver.findElement(By.id('username')).sendKeys('user-one');
      await driver.findElement(By.id('username')).sendKeys(Key.ESCAPE);
      await driver.findElement(By.id('username')).sendKeys(Key.TAB);
      await sleep(1500);
      const s = await pageState(driver);
      return { hosts: d.hosts, items: d.items.length, passwordFills: countEvents(s.events, 'password', 'input', t0) };
    };
    await configure(driver, { autoFillSingleEntry: false });
    await openPage(driver, PAGES.replace('{host}', 'single') + '/login.html', 3000);
    const fresh = await measure();
    await openPage(driver, PAGES.replace('{host}', 'single') + '/login.html', 3000);
    await openExtPage(driver, 'options/options.html');
    const sent = await driver.executeAsyncScript(function (done) {
      browser.tabs.query({ url: '*://single.localhost/*' }).then(async (tabs) => {
        for (let i = 0; i < 2; i++) {
          await browser.tabs.sendMessage(tabs[0].id, { action: 'redetect_fields' });
          await new Promise((r) => setTimeout(r, 1500));
        }
        done(tabs.length);
      }, (e) => done(String(e)));
    });
    await toWebTab(driver);
    await sleep(1500);
    const afterRedetect = await measure();
    return { tabsFound: sent, fresh, afterRedetect,
      pass: sent === 1 && fresh.hosts === 1 && afterRedetect.hosts === 1 && fresh.items > 0 &&
        afterRedetect.items === fresh.items && fresh.passwordFills === 1 && afterRedetect.passwordFills === 1 };
  },

  // Item 7 (B7): a login chosen in the login popup fills only the frame that
  // asked for the logins, not every frame of the tab. Runs the real popup page.
  async frames(driver) {
    await configure(driver, { autoFillSingleEntry: false });
    await openPage(driver, PAGES_TLS.replace('{host}', 'multi') + '/frames.html', 4000);
    // Open popup_login.html behind the web tab: it reads the active tab (the web tab) on load.
    const popup = await openTabBehind(driver, 'popups/popup_login.html');
    await sleep(1500);
    await driver.switchTo().window(popup);
    // Selecting this tab cleared the page credentials (by design). Let the page
    // fetch them again, as after a tab return, then click the first login.
    const res = await driver.executeAsyncScript(function (done) {
      browser.tabs.query({ url: '*://multi.localhost/*' }).then(async (tabs) => {
        await browser.tabs.sendMessage(tabs[0].id, { action: 'activated_tab' }).catch(() => {});
        await new Promise((r) => setTimeout(r, 2500));
        const bg = await browser.runtime.getBackgroundPage();
        const labels = [...document.querySelectorAll('#login-list a')].map((a) => a.textContent);
        const loginFrameId = bg.page.tabs[tabs[0].id].loginFrameId;
        const a = document.getElementById('0');
        if (a) a.click();
        done({ labels: labels.length, loginFrameId });
      }, (e) => done({ error: String(e) }));
    });
    await sleep(1500);
    await closeTabIfOpen(driver, popup);
    await toWebTab(driver);
    const top = await driver.executeScript("return document.getElementById('username').value.length + document.getElementById('password').value.length");
    await driver.switchTo().frame(await driver.findElement(By.id('frame')));
    const inner = await driver.executeScript("return document.getElementById('username').value.length + document.getElementById('password').value.length");
    await driver.switchTo().defaultContent();
    const filledFrames = (top > 0 ? 1 : 0) + (inner > 0 ? 1 : 0);
    // The same-origin iframe must have logins too (dropdown), or the check above proves nothing.
    const innerState = await frameState(driver);
    return { popup: res, topFilledChars: top, iframeFilledChars: inner, filledFrames, iframeDropdownItems: innerState.dropdownItems,
      pass: typeof res.loginFrameId === 'number' && filledFrames === 1 && (inner > 0 || innerState.dropdownItems === 2) &&
        ((res.loginFrameId === 0) === (top > 0)) };
  },

  // Item 7: "choose own credential fields" still saves, for this origin only,
  // through the new restricted message (content scripts may not save settings).
  async definefields(driver) {
    await configure(driver, { autoFillSingleEntry: false, 'defined-credential-fields': {
      'https://other.localhost:8080': { username: 'x', password: 'y', fields: [] } } });
    await openPage(driver, PAGES_TLS.replace('{host}', 'single') + '/login.html', 3000);
    await openExtPage(driver, 'options/options.html');
    await driver.executeAsyncScript(function (done) {
      browser.tabs.query({ url: '*://single.localhost/*' }).then((tabs) =>
        browser.tabs.sendMessage(tabs[0].id, { action: 'choose_credential_fields' })).then(() => done(), () => done());
    });
    await toWebTab(driver);
    await sleep(800);
    // Item 17c: the chooser is in a closed shadow root; real clicks through WebDriver.
    const chooser = async () => (await driver.findElement(By.css('kphc-chooser'))).getShadowRoot();
    const pageSeesChooser = await driver.executeScript("const h = document.querySelector('kphc-chooser'); return h ? h.shadowRoot !== null : null");
    // A page script clicking the chooser host does nothing.
    await driver.executeScript("document.querySelector('kphc-chooser').click()");
    const clickOverlay = async (n) => {
      const marks = await (await chooser()).findElements(By.css('[data-kphc-field]:not([data-kphc-chosen])'));
      if (!marks[n]) return false;
      await marks[n].click();
      return true;
    };
    const u = await clickOverlay(0);
    await sleep(300);
    const p = await clickOverlay(0);
    await sleep(300);
    for (const b of await (await chooser()).findElements(By.css('button'))) {
      if ((await b.getText()) === 'Confirm') { await b.click(); break; }
    }
    await sleep(1000);
    const chooserClosed = (await driver.findElements(By.css('kphc-chooser'))).length === 0;
    const readStored = async () => {
      await openExtPage(driver, 'options/options.html');
      const v = await driver.executeAsyncScript(function (done) {
        browser.storage.local.get({ settings: {} }).then((it) => done(it.settings['defined-credential-fields'] || {}));
      });
      await toWebTab(driver);
      return v;
    };
    const saved = await readStored();
    const own = saved['https://single.localhost:8080'];
    // The saved fields are used: reload, then the fill command fills them.
    await openPage(driver, PAGES_TLS.replace('{host}', 'single') + '/login.html', 3000);
    await driver.findElement(By.id('password')).click();
    await fireCommand(driver, 'fill-username-password');
    await sleep(1500);
    const ps = await pageState(driver);
    const filledWithDefined = [ps.usernameLen, ps.passwordLen];
    await configure(driver, { 'defined-credential-fields': {} });
    return { overlaysClicked: [u, p], pageSeesChooser, chooserClosed, savedOrigins: Object.keys(saved), own, filledWithDefined,
      pass: u && p && pageSeesChooser === false && chooserClosed && !!own && own.username === 'username' && own.password === 'password' &&
        !!saved['https://other.localhost:8080'] && filledWithDefined[0] > 0 && filledWithDefined[1] > 0 };
  },

  // Item 8: a cross-origin iframe (bank.localhost inside single.localhost)
  // gets no logins: no request for its URL, no auto-fill, no dropdown.
  async iframe(driver) {
    await configure(driver, { autoFillSingleEntry: true });
    await kphReset();
    await openPage(driver, PAGES_TLS.replace('{host}', 'single') + '/iframe.html', 4000);
    const stats = await kphStats();
    const inFrame = await frameState(driver);
    const bankRequests = (stats?.log || []).filter((l) => l.type === 'get-logins' && String(l.url).includes('bank')).length;
    return { bankRequests, iframe: inFrame, requestTimeline: timeline(stats),
      pass: bankRequests === 0 && inFrame.filledChars === 0 && inFrame.dropdownItems === 0 };
  },

  // Item 8: a sandboxed iframe (opaque origin) from the same host gets nothing.
  async sandbox(driver) {
    await configure(driver, { autoFillSingleEntry: true });
    await kphReset();
    await openPage(driver, PAGES_TLS.replace('{host}', 'single') + '/sandbox.html', 4000);
    const stats = await kphStats();
    const inFrame = await frameState(driver);
    const getLogins = stats?.byType['get-logins'] ?? 0;
    return { getLogins, iframe: inFrame, requestTimeline: timeline(stats),
      pass: getLogins === 0 && inFrame.filledChars === 0 && inFrame.dropdownItems === 0 };
  },
};

// Item 9: page scripts cannot make the extension fill (fake clicks or keys on
// the dropdown, or script focus()/blur() after setting a username).
// Real user actions (WebDriver input = trusted events) still fill.
scenarios.untrusted = async function (driver) {
  await configure(driver, { autoFillSingleEntry: false });
  await openPage(driver, PAGES_TLS.replace('{host}', 'multi') + '/login.html', 3500);
  const lens = () => driver.executeScript(
    "return [document.getElementById('username').value.length, document.getElementById('password').value.length]");
  // Fresh page for each case: a fill marks the password field as 'unchanged',
  // which a script reset of the values does not undo.
  const clear = async () => {
    await openPage(driver, PAGES_TLS.replace('{host}', 'multi') + '/login.html', 3500);
  };
  const out = {};

  // A: dropdown opened by a real click; page script clicks the first item.
  await driver.findElement(By.id('username')).click();
  await sleep(1000);
  // Item 17a: the items are in a closed shadow root. The page can only click the host.
  out.fakeClick = await driver.executeScript(function () {
    const h = document.getElementById('kphc-ac-host');
    if (!h) return 'no-host';
    if (h.shadowRoot) return 'shadow-visible';
    h.click();
    h.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    return 'clicked-host';
  });
  await sleep(1000);
  out.afterFakeClick = await lens();
  await clear();

  // B: page script sends ArrowDown + Enter key events to the username field.
  await driver.findElement(By.id('username')).click();
  await sleep(1000);
  await driver.executeScript(function () {
    const u = document.getElementById('username');
    for (const [key, keyCode] of [['ArrowDown', 40], ['Enter', 13]]) {
      u.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode, which: keyCode, bubbles: true, cancelable: true }));
    }
  });
  await sleep(1000);
  out.afterFakeKeys = await lens();
  await clear();

  // C: page script sets a username, then focus() + blur().
  await driver.executeScript("const u = document.getElementById('username'); u.value = 'bob-test'; u.dispatchEvent(new Event('input', { bubbles: true })); u.focus(); u.blur();");
  await sleep(2000);
  out.afterScriptBlur = await lens();
  await clear();

  // Positive D: real keys ArrowDown + Enter in the dropdown.
  await driver.findElement(By.id('username')).click();
  await sleep(1000);
  await driver.findElement(By.id('username')).sendKeys(Key.ARROW_DOWN);
  await sleep(300);
  await driver.findElement(By.id('username')).sendKeys(Key.ENTER);
  await sleep(1500);
  out.afterRealKeys = await lens();
  await clear();

  // Positive E: user types a username and leaves the field with Tab.
  await driver.findElement(By.id('username')).click();
  await sleep(500);
  await driver.findElement(By.id('username')).sendKeys(Key.ESCAPE);
  await driver.findElement(By.id('username')).sendKeys('bob-test');
  await sleep(500);
  await driver.findElement(By.id('username')).sendKeys(Key.ESCAPE);
  await driver.findElement(By.id('username')).sendKeys(Key.TAB);
  await sleep(2000);
  out.afterTypedTab = await lens();
  await clear();

  // F: page script clicks the password generator icon: no dialog, no request.
  // Item 17b: icon and dialog are in closed shadow roots (read with WebDriver).
  const genState = async () => {
    const hosts = await driver.findElements(By.css('kphc-pwgen'));
    if (!hosts.length) return { open: false, generatedLen: 0 };
    const sr = await hosts[0].getShadowRoot();
    if (!(await (await sr.findElement(By.css('[role=dialog]'))).isDisplayed())) return { open: false, generatedLen: 0 };
    const input = await sr.findElement(By.css('input[type=text]'));
    return { open: true, generatedLen: String(await input.getProperty('value')).length,
      pageSeesShadow: await driver.executeScript("return document.querySelector('kphc-pwgen').shadowRoot !== null") };
  };
  await kphReset();
  out.fakeIconClick = await driver.executeScript("const i = document.querySelector('kphc-key'); if (!i) return 'no-icon'; if (i.shadowRoot) return 'shadow-visible'; i.click(); i.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); return 'clicked';");
  await sleep(1500);
  out.afterFakeIconClick = Object.assign(await genState(), { requests: (await kphStats())?.byType['generate-password'] ?? 0 });
  // Positive G: real click on the icon opens the generator and generates.
  await driver.findElement(By.css('kphc-key')).click();
  await sleep(1500);
  out.afterRealIconClick = Object.assign(await genState(), { requests: (await kphStats())?.byType['generate-password'] ?? 0 });
  out.pass = out.fakeClick === 'clicked-host' && out.afterFakeClick[1] === 0 && out.afterFakeKeys[1] === 0 &&
    out.fakeIconClick === 'clicked' && !out.afterFakeIconClick.open && out.afterFakeIconClick.requests === 0 &&
    out.afterRealIconClick.open && out.afterRealIconClick.generatedLen > 0 && out.afterRealIconClick.pageSeesShadow === false &&
    out.afterScriptBlur[1] === 0 && out.afterRealKeys[1] > 0 && out.afterTypedTab[1] > 0;
  return out;
};

// Item 10: when KeePass gets locked (HTTP 503), pages drop their cached
// logins (with passwords). After unlock, a real focus fetches them again.
// The fake server / proxy answers 503 in mode "locked" (what KeePassHttp does
// for a locked database); a real lock needs the KeePass UI.
scenarios.lock = async function (driver) {
  await configure(driver, { autoFillSingleEntry: false });
  await setTamper('none');
  await openPage(driver, PAGES_TLS.replace('{host}', 'multi') + '/login.html', 3500);
  const items = async () => {
    await driver.findElement(By.id('other')).click();
    await sleep(300);
    await driver.findElement(By.id('username')).click();
    await sleep(1500);
    const n = (await dropdownState(driver)).items.length;
    await driver.findElement(By.id('username')).sendKeys(Key.ESCAPE);
    return n;
  };
  const out = {};
  out.before = await items();
  try {
    await setTamper('locked');
    // A real user action that makes the background talk to KeePass.
    await driver.findElement(By.css('kphc-key')).click();
    await sleep(1500);
    // Close the generator with Escape (its input inside the closed shadow root has the focus).
    const gsr = await (await driver.findElement(By.css('kphc-pwgen'))).getShadowRoot();
    await (await gsr.findElement(By.css('input[type=text]'))).sendKeys(Key.ESCAPE);
    await sleep(500);
    out.whileLocked = await items();
  } finally {
    await setTamper('none');
  }
  out.afterUnlock = await items();
  out.pass = out.before === 2 && out.whileLocked === 0 && out.afterUnlock === 2;
  return out;
};

// Item 11: options page without the online update check; it still shows the
// plugin version (asked from the local KeePassHttp).
scenarios.options = async function (driver) {
  await openExtPage(driver, 'options/options.html');
  await sleep(1500);
  const r = await driver.executeScript(function () {
    return {
      yourVersion: (document.querySelector('#tab-about em.versionKPH') || {}).textContent || null,
      updateRadios: document.querySelectorAll('input[name=checkUpdateKeePassHttp]').length,
      latestVersion: document.querySelectorAll('.latestVersion, .checkUpdateKeePassHttp').length,
    };
  });
  if (process.env.SHOTS) writeFileSync(path.join(ART, 'options-general.png'), await driver.takeScreenshot(), 'base64');
  await toWebTab(driver);
  r.pass = /^\d+(\.\d+)+$/.test(r.yourVersion || '') && r.updateRadios === 0 && r.latestVersion === 0;
  return r;
};

// Item 14: popup inserts error text as text (not HTML); an options change
// reaches the background (save waits for storage before the reload).
scenarios.smallbugs = async function (driver) {
  const out = {};
  await openExtPage(driver, 'popups/popup.html');
  await sleep(1000);
  out.popup = await driver.executeScript(function () {
    status_response({ keePassHttpAvailable: false, error: '<b id="injected">E</b>' });
    const a = document.getElementById('error-message').textContent;
    status_response({ keePassHttpAvailable: true, configured: true, associated: true, identifier: '<i id="injected2">x</i>' });
    return {
      injected: !!document.getElementById('injected') || !!document.getElementById('injected2'),
      errorText: a,
      identifierText: document.getElementById('associated-identifier').textContent,
    };
  });
  if (process.env.SHOTS) writeFileSync(path.join(ART, 'popup-main.png'), await driver.takeScreenshot(), 'base64');
  await openExtPage(driver, 'options/options.html');
  await sleep(1000);
  out.blink = await driver.executeAsyncScript(function (done) {
    const input = document.getElementById('opt-blinkTimeout');
    const set = (v) => { input.value = v; input.dispatchEvent(new Event('change', { bubbles: true })); };
    set('9.1');
    setTimeout(async () => {
      const bg = await browser.runtime.getBackgroundPage();
      const seen = String(bg.page.settings.blinkTimeout);
      set('7.5');
      setTimeout(() => done(seen), 500);
    }, 500);
  });
  await toWebTab(driver);
  out.pass = !out.popup.injected && out.popup.errorText === '<b id="injected">E</b>' &&
    out.popup.identifierText === '<i id="injected2">x</i>' && out.blink === '9100';
  return out;
};

// Item 17a: a page with a strict CSP (no inline styles) still gets a styled,
// working dropdown: styles are set with the CSSOM, which CSP does not block.
scenarios.csp = async function (driver) {
  await configure(driver, { autoFillSingleEntry: false });
  await openPage(driver, PAGES_TLS.replace('{host}', 'multi') + '/login-csp.html', 3500);
  await driver.findElement(By.id('username')).click();
  await sleep(1200);
  const d = await dropdownState(driver);
  const sr = await (await driver.findElement(By.id('kphc-ac-host'))).getShadowRoot();
  const border = await (await sr.findElement(By.css('ul'))).getCssValue('border-top-color');
  await clickDropdownItem(driver, 1);
  await sleep(1200);
  const s = await pageState(driver);
  // Proof that the CSP is enforced: an inline style attribute has no effect here.
  const cspActive = await driver.executeScript("const x = document.createElement('div'); x.setAttribute('style', 'color: rgb(1, 2, 3)'); document.body.appendChild(x); const c = getComputedStyle(x).color; x.remove(); return c !== 'rgb(1, 2, 3)';");
  return { cspActive, items: d.items, border, pageSeesShadow: d.pageSeesShadow, passwordLen: s.passwordLen,
    pass: cspActive && d.items.length === 2 && border === 'rgb(170, 170, 170)' && d.pageSeesShadow === false && s.passwordLen > 0 };
};

// Item 17b: password generator in closed shadow roots, on a strict-CSP page.
// Real clicks: open, generate, "Fill in & copy" fills the field and the clipboard.
async function readClipboard(driver) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    return await driver.executeAsyncScript(function (done) {
      navigator.clipboard.readText().then(done, (e) => done('ERR ' + e));
    });
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}
scenarios.generator = async function (driver) {
  await configure(driver, { autoFillSingleEntry: false });
  await openPage(driver, PAGES_TLS.replace('{host}', 'multi') + '/login-csp.html', 3500);
  const icon = await driver.findElement(By.css('kphc-key'));
  const iconSize = await icon.getRect();
  await icon.click();
  await sleep(1500);
  const sr = await (await driver.findElement(By.css('kphc-pwgen'))).getShadowRoot();
  const generated = String(await (await sr.findElement(By.css('input[type=text]'))).getProperty('value'));
  const buttons = await sr.findElements(By.css('button'));
  let fillBtn = null;
  for (const b of buttons) if ((await b.getText()).startsWith('Fill in')) fillBtn = b;
  await fillBtn.click();
  await sleep(800);
  const fieldValue = await driver.executeScript("return document.getElementById('password').value");
  const clip = await readClipboard(driver);
  return { iconSize: [iconSize.width, iconSize.height], generatedLen: generated.length,
    fieldMatches: fieldValue === generated, clipboardMatches: clip === generated,
    pass: iconSize.width === 16 && generated.length > 0 && fieldValue === generated && clip === generated };
};

// Values and dropdown inside #frame, after focusing its username field.
async function frameState(driver) {
  await driver.switchTo().frame(await driver.findElement(By.id('frame')));
  try {
    const filledChars = await driver.executeScript("return document.getElementById('username').value.length + document.getElementById('password').value.length");
    await driver.executeScript("document.getElementById('username').focus()");
    await sleep(1200);
    const dropdownItems = (await dropdownState(driver)).items.length;
    const origin = await driver.executeScript('return window.origin');
    return { filledChars, dropdownItems, origin };
  } finally {
    await driver.switchTo().defaultContent();
  }
}

// Opens an extension page in a new tab without selecting it.
async function openTabBehind(driver, rel) {
  const url = `${EXT_BASE}/${rel}`;
  if (!webHandle) webHandle = await driver.getWindowHandle();
  const before = new Set(await driver.getAllWindowHandles());
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript(function (u) {
    const w = Services.wm.getMostRecentWindow('navigator:browser');
    w.gBrowser.addTab(u, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
  }, url);
  await driver.setContext(firefox.Context.CONTENT);
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    const h = (await driver.getAllWindowHandles()).find((x) => !before.has(x) && x !== extHandle);
    if (h) return h;
  }
  throw new Error('tab did not open: ' + rel);
}
async function closeTabIfOpen(driver, handle) {
  if (!(await driver.getAllWindowHandles()).includes(handle)) return;
  await driver.switchTo().window(handle);
  await driver.close();
}

// Item 16/17d: "save this login?" after a form submit. The per-tab toolbar popup
// is read from the privileged test context (reading it from an extension page
// would switch tabs, which clears it).
async function toolbarPopup(driver) {
  return inChrome(driver, (ext, tab, EP) => {
    const url = String(EP.apiManager.global.browserActionFor(ext).action.getProperty(tab, 'popup') || '');
    return url.slice(url.lastIndexOf('/') + 1);
  });
}
scenarios.remember = async function (driver) {
  await configure(driver, { autoFillSingleEntry: false });
  const submit = async (user, pass, pick) => {
    await openPage(driver, PAGES_TLS.replace('{host}', 'single') + '/login.html', 3000);
    if (pick) {
      await driver.findElement(By.id('username')).click();
      await sleep(1000);
      await clickDropdownItem(driver, 0);
      await sleep(1000);
    } else {
      await driver.findElement(By.id('username')).sendKeys(user);
      await driver.findElement(By.id('password')).sendKeys(pass);
    }
    await driver.findElement(By.css('button[type=submit]')).click();
    await sleep(1500);
    return toolbarPopup(driver);
  };
  // Unchanged login from KeePass first (the save prompt of a new login stays for a while).
  const unchanged = await submit(null, null, true);
  const changed = await submit('new-user', 'New-Dummy-Pass-9', false);
  return { popupAfterUnchanged: unchanged, popupAfterNew: changed,
    pass: unchanged !== 'popup_remember.html' && changed === 'popup_remember.html' };
};

// Item 17d: the keyboard command "Insert username + password" (Alt+Shift+U) and
// "Insert a password" (Alt+Shift+P) fill the focused form (path fill_user_pass).
// Fires an extension keyboard command as Firefox does for the real shortcut
// (WebDriver key events are page events and do not reach browser shortcuts).
async function fireCommand(driver, name) {
  return inChrome(driver, (ext, tab, EP, name) => {
    try { ext.shortcuts.onCommand(name); return { fired: 'onCommand' }; } catch (e) { return { err: String(e) }; }
  }, name);
}
scenarios.shortcut = async function (driver) {
  await configure(driver, { autoFillSingleEntry: false });
  let probe = null;
  const press = async (letter) => {
    await openPage(driver, PAGES_TLS.replace('{host}', 'single') + '/login.html', 3000);
    await driver.findElement(By.id('password')).click();
    await sleep(300);
    probe = await fireCommand(driver, letter === 'u' ? 'fill-username-password' : 'fill-password');
    await sleep(1500);
    const s = await pageState(driver);
    return [s.usernameLen, s.passwordLen];
  };
  const both = await press('u');
  const passOnly = await press('p');
  return { command: probe, both, passOnly, pass: probe && probe.fired === 'onCommand' && both[0] > 0 && both[1] > 0 && passOnly[0] === 0 && passOnly[1] > 0 };
};

// Item 17d: option "respect maxlength" cuts the filled password to the field
// maxlength. Before, the fill threw ($.isNumeric, $ undefined in the content script).
scenarios.maxlength = async function (driver) {
  await configure(driver, { autoFillSingleEntry: false, respectMaxLength: true });
  try {
    await openPage(driver, PAGES_TLS.replace('{host}', 'single') + '/login-maxlength.html', 3000);
    await driver.findElement(By.id('username')).click();
    await sleep(1000);
    await clickDropdownItem(driver, 0);
    await sleep(1200);
    const s = await pageState(driver);
    return { usernameLen: s.usernameLen, passwordLen: s.passwordLen, pass: s.usernameLen > 0 && s.passwordLen === 6 };
  } finally {
    await configure(driver, { respectMaxLength: false });
  }
};

// Item 18: no polling. The key icon follows its field when the page layout
// changes (MutationObserver), and after a scroll.
scenarios.iconmove = async function (driver) {
  await configure(driver, { autoFillSingleEntry: false });
  await driver.get(PAGES_TLS.replace('{host}', 'single') + '/login-move.html');
  await sleep(800);
  const where = async () => {
    const f = await (await driver.findElement(By.id('password'))).getRect();
    const i = await (await driver.findElement(By.css('kphc-key'))).getRect();
    const inside = i.y >= f.y - 1 && i.y + i.height <= f.y + f.height + 1 && i.x >= f.x && i.x + i.width <= f.x + f.width + 1;
    return { fieldY: Math.round(f.y), iconY: Math.round(i.y), inside };
  };
  const before = await where();
  await sleep(2500); // banner inserted at 1.5 s
  const afterMove = await where();
  await driver.executeScript('window.scrollTo(0, 120)');
  await sleep(400);
  const afterScroll = await where();
  return { before, afterMove, afterScroll,
    pass: before.inside && afterMove.inside && afterMove.fieldY - before.fieldY >= 150 && afterScroll.inside };
};

// Item 19: "Copy to clipboard" in the generator; the clipboard is cleared after 30 s.
scenarios.clipboard = async function (driver) {
  await configure(driver, { autoFillSingleEntry: false });
  await openPage(driver, PAGES_TLS.replace('{host}', 'single') + '/login.html', 3000);
  await driver.findElement(By.css('kphc-key')).click();
  await sleep(1500);
  const sr = await (await driver.findElement(By.css('kphc-pwgen'))).getShadowRoot();
  const generated = String(await (await sr.findElement(By.css('input[type=text]'))).getProperty('value'));
  for (const b of await sr.findElements(By.css('button'))) {
    if ((await b.getText()) === 'Copy to clipboard') { await b.click(); break; }
  }
  await sleep(500);
  const message = await (await sr.findElement(By.css('[role=status]'))).getText();
  const afterCopy = await readClipboard(driver);
  await sleep(31500);
  const afterTimeout = await readClipboard(driver);
  const messageLater = await (await sr.findElement(By.css('[role=status]'))).getText();
  return { generatedLen: generated.length, copied: afterCopy === generated, message, clearedAfter30s: afterTimeout === '', messageLater,
    pass: generated.length > 0 && afterCopy === generated && /cleared in 30 seconds/.test(message) && afterTimeout === '' };
};

// Non-English entry in KeePass (dummy data): Greek username and password
// survive both directions (UTF-8) and fill exactly.
scenarios.utf8 = async function (driver) {
  await configure(driver, { autoFillSingleEntry: false });
  await openPage(driver, PAGES.replace('{host}', 'utf8') + '/login.html', 3000);
  await driver.findElement(By.id('username')).click();
  await sleep(1200);
  const d = await dropdownState(driver);
  await clickDropdownItem(driver, 0);
  await sleep(1200);
  const v = await driver.executeScript("return [document.getElementById('username').value, document.getElementById('password').value]");
  return { items: d.items, username: v[0], passwordMatches: v[1] === 'ασδασδασδασδ',
    pass: d.items.length === 1 && d.items[0] === 'τραλαλάκος (Single site UTF8)' && v[0] === 'τραλαλάκος' && v[1] === 'ασδασδασδασδ' };
};

// Saving a login to KeePass (set-login), on its own host so other tests are
// not touched. First run: a new entry; later runs: update of that entry
// (no KeePass dialog: "Always allow updating entries" is on in the test KeePass).
// The form submit and the save prompt are real. The popup's "New"/"Update"
// button is not clicked: an extension page opened as a tab reads the wrong tab,
// so the test sends the same message the popup sends (add_/update_credentials).
scenarios.save = async function (driver) {
  await configure(driver, { autoFillSingleEntry: false });
  const page = PAGES_TLS.replace('{host}', 'save') + '/login.html';
  const user = 'save-user-ä';
  const round = async () => {
    const password = 'Δοκιμή-' + Math.random().toString(16).slice(2, 10);
    await openPage(driver, page, 3000);
    const before = (await openDropdown(driver)).items;
    await driver.findElement(By.id('username')).sendKeys(Key.ESCAPE);
    await driver.executeScript("document.getElementById('username').value = ''");
    await driver.findElement(By.id('username')).sendKeys(user);
    // Leaving the username field may fill the stored password (by design):
    // wait for it, then type over it, as a user would.
    const pw = await driver.findElement(By.id('password'));
    await pw.click();
    await sleep(1200);
    await pw.clear();
    await pw.sendKeys(password);
    const typedOk = await driver.executeScript("return document.getElementById('password').value") === password;
    await driver.findElement(By.css('button[type=submit]')).click();
    await sleep(1500);
    const prompt = await toolbarPopup(driver);

    await openExtPage(driver, 'options/options.html');
    const found = await extCall(driver, 'retrieve_credentials', ['https://save.localhost:8080', null, true]);
    const existing = (found.r || []).find((e) => e.Login === user);
    const mode = existing ? 'update' : 'new';
    const result = existing
      ? await extCall(driver, 'update_credentials', [existing.Uuid, user, password, page])
      : await extCall(driver, 'add_credentials', [user, password, page]);
    await toWebTab(driver);

    // Read it back through the normal page flow.
    await openPage(driver, page, 3000);
    const after = (await openDropdown(driver)).items;
    const idx = after.findIndex((l) => l.startsWith(user + ' '));
    if (idx >= 0) await clickDropdownItem(driver, idx);
    await sleep(1200);
    const readBack = await driver.executeScript("return document.getElementById('password').value") === password;
    const ok = typedOk && prompt === 'popup_remember.html' && result.r === 'success' && readBack &&
      after.filter((l) => l.startsWith(user + ' ')).length === 1;
    return { mode, prompt, result: result.r, before: before.length, after: after.length, readBack, ok };
  };
  // Round 1 creates the entry (first run) or updates it; round 2 always updates.
  const r1 = await round();
  const r2 = await round();
  return { r1, r2, pass: r1.ok && r2.ok && r2.mode === 'update' };
};

// Toolbar button state per tab: with logins the popup is the login list and
// the icon shows "choose"; when KeePass is locked the icon shows "off".
// Icons are compared with each other, not with file names.
async function toolbarIcon(driver) {
  return inChrome(driver, (ext, tab, EP) =>
    JSON.stringify(EP.apiManager.global.browserActionFor(ext).action.getProperty(tab, 'icon') || null));
}
// SHOTS=1: screenshot of the browser window with its toolbar (chrome context).
async function shotChrome(driver, name) {
  await driver.setContext(firefox.Context.CHROME);
  try { writeFileSync(path.join(ART, name + '.png'), await driver.takeScreenshot(), 'base64'); }
  finally { await driver.setContext(firefox.Context.CONTENT); }
}
scenarios.toolbar = async function (driver) {
  await configure(driver, { autoFillSingleEntry: false });
  await setTamper('none');
  await openPage(driver, PAGES_TLS.replace('{host}', 'multi') + '/login.html');
  const withLogins = { popup: await toolbarPopup(driver), icon: await toolbarIcon(driver) };
  if (process.env.SHOTS) await shotChrome(driver, 'toolbar-choose');
  await setTamper('locked');
  await openPage(driver, PAGES_TLS.replace('{host}', 'multi') + '/login.html');
  await sleep(1500);
  const locked = { popup: await toolbarPopup(driver), icon: await toolbarIcon(driver) };
  await setTamper('none');
  const iconsDiffer = withLogins.icon !== locked.icon;

  if (process.env.SHOTS) writeFileSync(path.join(ART, 'toolbar-icons.json'), JSON.stringify({ choose: withLogins.icon, off: locked.icon }));
  return { withLogins: withLogins.popup, locked: locked.popup, iconsDiffer,
    pass: withLogins.popup === 'popup_login.html' && locked.popup === 'popup.html' && iconsDiffer };
};

// Settings page: "Remove" asks in a native <dialog>; Cancel keeps the row,
// "Yes, remove now" deletes it from the table and from storage.
scenarios.dialogs = async function (driver) {
  const url = 'https://dialog-test.localhost';
  await configure(driver, { 'defined-credential-fields': { [url]: { username: 'u', password: 'p', fields: [] } } });
  await openExtPage(driver, 'options/options.html');
  await driver.findElement(By.id('tabbtn-filling')).click();
  await sleep(300);
  const rowCount = async () => (await driver.findElements(By.css('#fields-table tbody tr[data-url]'))).length;
  const stored = async () => driver.executeAsyncScript(function (u, done) {
    browser.storage.local.get({ settings: {} }).then((it) => done(u in (it.settings['defined-credential-fields'] || {})));
  }, url);
  const rows0 = await rowCount();
  const openDialog = async () => {
    await driver.findElement(By.css('#fields-table tbody tr[data-url] button.delete')).click();
    await sleep(300);
    return driver.executeScript("const d = document.getElementById('dialogDeleteSpecifiedCredentialFields'); return { open: d.open, name: d.querySelector('.name').textContent }");
  };
  const d1 = await openDialog();
  await driver.findElement(By.css('#dialogDeleteSpecifiedCredentialFields button[value=cancel]')).click();
  await sleep(300);
  const afterCancel = { rows: await rowCount(), stored: await stored() };
  const d2 = await openDialog();
  await driver.findElement(By.css('#dialogDeleteSpecifiedCredentialFields button[value=yes]')).click();
  await sleep(500);
  const afterYes = { rows: await rowCount(), stored: await stored(),
    emptyShown: await driver.findElement(By.css('#fields-table tr.empty')).isDisplayed() };
  await toWebTab(driver);
  return { rows0, d1, afterCancel, d2, afterYes,
    pass: rows0 === 1 && d1.open && d1.name === url && afterCancel.rows === 1 && afterCancel.stored &&
      d2.open && afterYes.rows === 0 && !afterYes.stored && afterYes.emptyShown };
};

// Settings page: options save on change, seconds are stored as
// milliseconds, the alert option is shown inverted, child options follow
// their parent, the shortcuts are listed, the status card reports the state
// (connected: state C, one row "In use now", no button, no notice).
scenarios.settings = async function (driver) {
  await openExtPage(driver, 'options/options.html');
  await sleep(1500);
  const bgSettings = () => driver.executeAsyncScript(function (done) {
    browser.runtime.getBackgroundPage().then((bg) => done(JSON.parse(JSON.stringify(bg.page.settings))));
  });
  const click = async (id) => { await driver.findElement(By.id(id)).click(); await sleep(400); };
  const out = {};
  out.state = await driver.findElement(By.id('status-card')).getAttribute('data-state');
  out.headline = await driver.findElement(By.id('headline')).getText();
  out.inUse = (await driver.findElements(By.xpath("//li[contains(@class,'db-row')]//span[contains(@class,'status-word') and text()='In use now']"))).length;
  out.actionShown = await driver.findElement(By.id('card-action')).isDisplayed();
  out.kbd = (await driver.findElements(By.css('#shortcut-list kbd'))).length;
  out.commandsApi = await driver.executeScript("return { keys: Object.keys(browser.commands || {}), open: typeof (browser.commands || {}).openShortcutSettings, kbdText: [...document.querySelectorAll('#shortcut-list .keys')].map((k) => k.textContent) }");

  await click('details-toggle');
  out.details = await driver.findElement(By.id('details-line')).getText();
  // Pairing again while connected is refused with the name.
  out.pairAgain = await driver.executeAsyncScript(function (done) {
    browser.runtime.sendMessage({ action: 'associate' }).then((r) => done(r), (e) => done(String(e)));
  });

  // The options live on the Filling tab.
  await driver.findElement(By.id('tabbtn-filling')).click();
  await sleep(300);
  out.changeShortcutsButton = await driver.findElement(By.id('change-shortcuts')).isDisplayed();
  out.noticeInC = await driver.findElement(By.css('#tab-filling [data-notice]')).isDisplayed();
  // Inverted option: checked means supressAlerts === false (the new default).
  const s0 = await bgSettings();
  out.alertCheckedDefault = await driver.findElement(By.id('opt-supressAlerts')).isSelected();
  out.supressAlertsDefault = s0.supressAlerts;
  await driver.findElement(By.css('label[for="opt-supressAlerts"]')).click();
  await sleep(500);
  out.supressAlertsAfterClick = (await bgSettings()).supressAlerts;
  await driver.findElement(By.css('label[for="opt-supressAlerts"]')).click();
  await sleep(500);

  // Child options are disabled while the parent is off.
  await driver.findElement(By.css('label[for="opt-autoRetrieveCredentials"]')).click();
  await sleep(500);
  out.childDisabled = !(await driver.findElement(By.id('opt-autoFillSingleEntry')).isEnabled());
  out.parentOff = (await bgSettings()).autoRetrieveCredentials;
  await driver.findElement(By.css('label[for="opt-autoRetrieveCredentials"]')).click();
  await sleep(500);
  out.childEnabledAgain = await driver.findElement(By.id('opt-autoFillSingleEntry')).isEnabled();

  // Save offer: advanced toggle stores -1 / 2000, number fields validate.
  await driver.findElement(By.id('tabbtn-saving')).click();
  await driver.executeScript("document.querySelector('#tab-saving details.advanced').open = true");
  await sleep(200);
  out.offsetDefault = (await bgSettings()).blinkMinTimeout;
  await driver.findElement(By.css('label[for="opt-blinkMinTimeout-on"]')).click();
  await sleep(500);
  out.offsetOn = (await bgSettings()).blinkMinTimeout;
  out.offsetFieldEnabled = await driver.findElement(By.id('opt-blinkMinTimeout')).isEnabled();
  out.invalid = await driver.executeAsyncScript(function (done) {
    const input = document.getElementById('opt-allowedRedirect');
    input.value = '500';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    setTimeout(() => done(input.closest('.opt').querySelector('.save-state').textContent), 300);
  });
  out.allowedAfterInvalid = (await bgSettings()).allowedRedirect;
  await driver.findElement(By.css('label[for="opt-blinkMinTimeout-on"]')).click();
  await sleep(500);
  out.offsetOffAgain = (await bgSettings()).blinkMinTimeout;
  if (process.env.SHOTS) writeFileSync(path.join(ART, 'settings-saving.png'), await driver.takeScreenshot(), 'base64');
  await toWebTab(driver);

  out.pass = out.state === 'C' && /^Connected to .+\.$/.test(out.headline) && out.inUse === 1 && !out.actionShown &&
    /^Port \d+ · KeePassHttp \S+ \(tested with 2\.3\.1\.0\)$/.test(out.details) &&
    out.pairAgain && out.pairAgain.reason === 'already' && !out.noticeInC &&
    out.kbd === 6 && out.changeShortcutsButton && out.commandsApi.open === 'function' &&
    out.alertCheckedDefault === true && out.supressAlertsDefault === false && out.supressAlertsAfterClick === true &&
    out.childDisabled && out.parentOff === false && out.childEnabledAgain &&
    String(out.offsetDefault) === '-1' && String(out.offsetOn) === '2000' && out.offsetFieldEnabled &&
    /Not valid/.test(out.invalid) && String(out.allowedAfterInvalid) !== '500' && String(out.offsetOffAgain) === '-1';
  return out;
};

// Settings page: the KeePassHttp-Link and plugin boxes in the diagram open a
// short info popover. One at a time; Escape and a click outside close it.
scenarios.cardinfo = async function (driver) {
  await openExtPage(driver, 'options/options.html');
  // The card shows once the background knows the state (first check).
  await waitFor(() => driver.executeScript("return !document.getElementById('status-card').hidden"), 15000, 200);
  const pop = (id) => driver.executeScript(function (id) {
    const p = document.getElementById(id);
    const a = p.querySelector('a.pop-link');
    return { open: !p.hidden && p.offsetHeight > 0, title: p.querySelector('.pop-title').textContent,
      desc: p.querySelector('.pop-desc').textContent, link: a.textContent, href: a.href,
      newTab: a.target === '_blank' && a.rel.includes('noopener'),
      expanded: document.querySelector('[aria-controls="' + id + '"]').getAttribute('aria-expanded'),
      focusInside: p.contains(document.activeElement) };
  }, id);
  const out = {};
  out.closedAtStart = !(await pop('pop-plugin')).open && !(await pop('pop-ext')).open;
  await driver.findElement(By.css('.diagram button.d-plugin')).click();
  await sleep(200);
  out.plugin = await pop('pop-plugin');
  if (process.env.SHOTS) writeFileSync(path.join(ART, 'settings-popover-plugin.png'), await driver.takeScreenshot(), 'base64');
  await driver.actions().sendKeys(Key.ESCAPE).perform();
  await sleep(200);
  out.afterEscape = { open: (await pop('pop-plugin')).open,
    focusOnBox: await driver.executeScript("return document.activeElement.classList.contains('d-plugin')") };
  await driver.findElement(By.css('.diagram button.d-ext')).click();
  await sleep(200);
  out.ext = await pop('pop-ext');
  if (process.env.SHOTS) writeFileSync(path.join(ART, 'settings-popover-ext.png'), await driver.takeScreenshot(), 'base64');
  await driver.findElement(By.id('headline')).click();
  await sleep(200);
  out.afterOutsideClick = (await pop('pop-ext')).open;
  await toWebTab(driver);
  out.pass = out.closedAtStart &&
    out.plugin.open && out.plugin.title === 'KeePassHttp plugin' && out.plugin.desc === 'The KeePass side of this connection.' &&
    out.plugin.link.trim() === 'Download page' && out.plugin.href === 'https://keepass.info/plugins.html#keepasshttp' &&
    out.plugin.newTab && out.plugin.expanded === 'true' && out.plugin.focusInside &&
    !out.afterEscape.open && out.afterEscape.focusOnBox &&
    out.ext.open && out.ext.title === 'KeePassHttp-Link' && out.ext.link.trim() === 'Plugin page' &&
    out.ext.href === 'https://github.com/odyodyodys/keepasshttp-link' && out.ext.newTab &&
    !out.afterOutsideClick;
  return out;
};

// Settings page: the status card shows at once when the page opens, with the
// last state the background knows, also when KeePass answers slowly (the
// fake server waits 3 s). The real check follows and keeps the state.
scenarios.cardfast = async function (driver) {
  await setTamper('slow');
  const out = {};
  try {
    await openExtPage(driver, 'options/options.html'); // returns about 0.6 s after the page loaded
    out.first = await driver.executeScript(function () {
      const c = document.getElementById('status-card');
      return { visible: !c.hidden && c.offsetHeight > 0, state: c.dataset.state || null,
        msSincePageStart: Math.round(performance.now()), tabsVisible: document.querySelector('.tabs').offsetHeight > 0 };
    });
    await sleep(7000); // the slow real check ends
    out.after = await driver.executeScript("return document.getElementById('status-card').dataset.state");

    // As right after the extension started: the background has not seen
    // KeePass yet. The card must not show "not answering" (state A, with
    // its Help) for a moment; it waits for the real check.
    await driver.executeAsyncScript(function (done) {
      browser.runtime.getBackgroundPage().then((bg) => {
        bg.keepass.stateKnown = false;
        bg.keepass.isKeePassHttpAvailable = false;
        bg.keepass.associated = { value: false, hash: null };
        done(true);
      });
    });
    await openExtPage(driver, 'options/options.html');
    out.freshFirst = await driver.executeScript(function () {
      const c = document.getElementById('status-card');
      return { visible: !c.hidden, state: c.dataset.state || null, helpVisible: document.getElementById('help-body').offsetHeight > 0 };
    });
    await sleep(7000);
    out.freshAfter = await driver.executeScript("return document.getElementById('status-card').dataset.state");
  } finally {
    await setTamper('none');
  }
  await toWebTab(driver);
  out.pass = out.first.visible && out.first.state === 'C' && out.first.msSincePageStart < 2500 &&
    out.first.tabsVisible && out.after === 'C' &&
    out.freshFirst.state !== 'A' && !out.freshFirst.helpVisible && out.freshAfter === 'C';
  return out;
};

// Settings page, status card: it follows KeePass by itself (polling, no
// reload). Locked → A2 with "Unlock in KeePass", wrong port → A, back → C.
// Description edits are saved; "Remove" → "Keep" keeps the row.
scenarios.cardstates = async function (driver) {
  await openExtPage(driver, 'options/options.html');
  const card = async () => driver.executeScript(function () {
    const c = document.getElementById('status-card');
    const a = document.getElementById('card-action');
    return { state: c.dataset.state, headline: document.getElementById('headline').textContent,
      sub: document.getElementById('subline').textContent, action: a.hidden ? null : a.textContent,
      words: [...document.querySelectorAll('.db-row .status-word')].map((w) => w.textContent),
      notice: !document.querySelector('#tab-filling [data-notice]').hidden,
      settingsToggle: document.getElementById('help-toggle-row').offsetHeight > 0 ? document.getElementById('help-toggle-row').textContent : null,
      settingsVisible: document.getElementById('help-body').offsetHeight > 0 };
  });
  const waitState = async (want, ms = 8000) => {
    let c;
    for (let t = 0; t < ms; t += 300) { c = await card(); if (c.state === want) return c; await sleep(300); }
    return c;
  };
  const out = {};
  out.start = await waitState('C');
  await setTamper('locked');
  out.locked = await waitState('A2');
  await setTamper('none');
  out.back = await waitState('C');

  // Wrong port through Advanced: state A, the sentence names the port.
  await driver.findElement(By.id('advanced-toggle')).click();
  const port = await driver.findElement(By.id('advanced-port'));
  await port.clear();
  await port.sendKeys('19499');
  await driver.findElement(By.css('#advanced .port-save')).click();
  // A refused connection to localhost takes about 6.4 s in Firefox on Windows.
  out.wrongPort = await waitState('A', 15000);
  // Connection settings in the card: closed until opened.
  await driver.findElement(By.id('help-toggle-row')).click();
  await sleep(200);
  out.settingsOpened = await card();
  await driver.findElement(By.id('help-toggle-row')).click();
  // First run (no database yet): the block is closed too.
  const ring = await readKeyRing(driver);
  await restoreKeyRing(driver, {});
  await openExtPage(driver, 'options/options.html');
  out.firstRun = await waitState('A', 15000);
  out.firstRunNeed = await driver.executeScript("return document.getElementById('need').offsetHeight > 0");
  if (process.env.SHOTS) writeFileSync(path.join(ART, 'settings-card-A-first.png'), await driver.takeScreenshot(), 'base64');
  await restoreKeyRing(driver, ring);
  await openExtPage(driver, 'options/options.html');
  out.beforeToggle = await waitFor(() => driver.executeScript(
    "const t = document.getElementById('advanced-toggle'); return t.offsetHeight > 0 ? true : null"), 15000, 200) ||
    await driver.executeScript("return { ring: Object.keys(options.keyRing).length, more: document.getElementById('db-more').hidden, tab: location.hash }");
  await driver.findElement(By.id('advanced-toggle')).click();
  if (process.env.SHOTS) writeFileSync(path.join(ART, 'settings-card-A.png'), await driver.takeScreenshot(), 'base64');
  const port2 = await driver.findElement(By.id('advanced-port'));
  await port2.clear();
  await port2.sendKeys(String(EXT_PORT));
  await driver.findElement(By.css('#advanced .port-save')).click();
  // A check to the wrong port may still run (about 6.4 s) before the next one.
  out.portBack = await waitState('C', 15000);

  // Description: saved on Enter, kept in the key ring.
  const desc = await driver.findElement(By.css('.db-row input.db-desc'));
  await desc.clear();
  await desc.sendKeys('Dummy note', Key.ENTER);
  await sleep(500);
  out.description = Object.values(await readKeyRing(driver)).map((k) => k.description);

  // Remove asks first, Keep keeps the row.
  await driver.findElement(By.css('.db-row button.db-remove')).click();
  await sleep(300);
  out.dialogTitle = await driver.findElement(By.id('dialogRemoveDatabaseTitle')).getText();
  await driver.findElement(By.css('#dialogRemoveDatabase button[value=cancel]')).click();
  await sleep(300);
  out.rowsAfterKeep = (await driver.findElements(By.css('.db-row'))).length;
  await desc.clear();
  await desc.sendKeys(Key.ENTER);
  await sleep(300);
  if (process.env.SHOTS) writeFileSync(path.join(ART, 'settings-card-C.png'), await driver.takeScreenshot(), 'base64');
  await toWebTab(driver);

  out.pass = out.start.state === 'C' && out.start.words.includes('In use now') && !out.start.notice &&
    out.locked.state === 'A2' && out.locked.action === 'Unlock in KeePass' && out.locked.words.length === 0 && out.locked.notice &&
    out.back.state === 'C' &&
    out.wrongPort.state === 'A' && !out.wrongPort.settingsVisible && out.wrongPort.settingsToggle === 'Connection settings ▸' &&
    out.settingsOpened.settingsVisible && out.firstRun.state === 'A' && out.firstRunNeed &&
    !out.firstRun.settingsVisible && out.firstRun.settingsToggle === 'Connection settings ▸' && out.settingsOpened.settingsToggle === 'Connection settings ▾' &&
    out.wrongPort.headline === 'KeePass is not answering.' && out.wrongPort.sub.includes('port 19499') &&
    out.portBack.state === 'C' && out.description.includes('Dummy note') &&
    /^Remove .+ from Firefox\?$/.test(out.dialogTitle) && out.rowsAfterKeep >= 1;
  return out;
};

// A shortcut that cannot fill shows an in-page notification (closed shadow
// root, with the add-on icon), not a blocking alert. With the option off,
// nothing is shown.
scenarios.notify = async function (driver) {
  const probe = () => driver.executeScript(function () {
    const h = document.querySelector('kphc-notice');
    return { present: !!h, pageSeesShadow: h ? h.shadowRoot !== null : null, alertOverridden: false };
  });
  const run = async () => {
    await openPage(driver, PAGES_TLS.replace('{host}', 'multi') + '/login.html', 3000);
    await driver.findElement(By.id('other')).click();
    await sleep(300);
    // Two logins, no username typed: the fill cannot choose.
    await fireCommand(driver, 'fill-username-password');
    await sleep(1200);
    return probe();
  };
  await configure(driver, { autoFillSingleEntry: false, supressAlerts: false });
  const shown = await run();
  if (process.env.SHOTS) writeFileSync(path.join(ART, 'notify.png'), await driver.takeScreenshot(), 'base64');
  await sleep(7000);
  const later = await probe();
  await configure(driver, { supressAlerts: true });
  const hidden = await run();
  await configure(driver, { supressAlerts: false });
  return { shown, later, hidden,
    pass: shown.present && shown.pageSeesShadow === false && !later.present && !hidden.present };
};

// ---------- main ----------
if (process.argv.includes('--list')) { console.log(Object.keys(scenarios).join(' ')); process.exit(0); }
const wanted = process.argv.slice(2).filter((a) => scenarios[a]);
const names = wanted.length ? wanted : Object.keys(scenarios);
const report = { firefox: null, startedAt: new Date().toISOString(), mock: USE_MOCK, port: KPH_PORT, results: {} };
let driver;
try {
  driver = await startFirefox();
  const caps = await driver.getCapabilities();
  report.firefox = caps.get('browserVersion');
  await configure(driver, {});
  report.association = await associate(driver);
  for (const n of names) {
    try {
      report.results[n] = await scenarios[n](driver);
    } catch (e) {
      report.results[n] = { error: String(e && e.stack || e) };
    }
    try {
      writeFileSync(path.join(ART, `${n}.png`), await driver.takeScreenshot(), 'base64');
    } catch { /* ignore */ }
  }
} catch (e) {
  report.fatal = String(e && e.stack || e);
  try { report.requestTimeline = timeline(await kphStats()); } catch { /* ignore */ }
} finally {
  if (driver) await driver.quit().catch(() => {});
  writeFileSync(path.join(ART, 'report.json'), JSON.stringify(report, null, 2));
  // Short summary; details are in artifacts/report.json.
  const failed = Object.entries(report.results).filter(([, v]) => v.error || v.pass === false).map(([k]) => k);
  const secs = Math.round((Date.now() - Date.parse(report.startedAt)) / 1000);
  console.log(`${USE_MOCK ? 'fake server' : 'KeePass port ' + KPH_PORT}: ` +
    `${Object.keys(report.results).length - failed.length}/${names.length} passed in ${secs}s` +
    (failed.length ? `; FAILED: ${failed.join(', ')}` : '') + (report.fatal ? `; FATAL: ${report.fatal.split('\n')[0]}` : ''));
  process.exit(report.fatal || failed.length ? 1 : 0);
}
