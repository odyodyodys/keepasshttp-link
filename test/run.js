// Test runner: starts the fake KeePassHttp server and the test pages, then
// drives Firefox (fresh temporary profile) with the extension from ../src
// loaded as a temporary add-on. DUMMY DATA ONLY.
//
// Usage:  npm test                       (all scenarios, headless)
//         HEADLESS=0 npm test            (visible window)
//         npm test -- single multi       (only some scenarios)
//         KPH_PORT=19465 NO_MOCK=1 npm test   (use the real test KeePass)
//
// Output: console report + test/artifacts/<scenario>.png + report.json

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
const EXT_ID = 'keepasshttp-connector@addons.brandt.tech';
const EXT_UUID = '5b0f6f0e-6b8e-4b7e-9d55-0c1a7e5b9a01'; // fixed so we can open extension pages
const EXT_BASE = `moz-extension://${EXT_UUID}`;
const USE_MOCK = process.env.NO_MOCK !== '1';
const KPH_PORT = Number(process.env.KPH_PORT || 19475);
const PAGES = 'http://{host}.localhost:8080';
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
    .setPreference('network.dns.localDomains', 'single.localhost,multi.localhost,bank.localhost,evilbank.localhost')
    .setPreference('signon.rememberSignons', process.env.FF_PWMGR === '1')
    .setPreference('signon.autofillForms', process.env.FF_PWMGR === '1')
    .setPreference('browser.shell.checkDefaultBrowser', false)
    .setPreference('datareporting.policy.dataSubmissionEnabled', false)
    .setPreference('app.update.auto', false);
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
      .then((s) => done(s && !('hostname' in s) ? true : 'hostname setting was not removed'),
        (e) => done(String(e)));
    // Item 2: an old remote "hostname" setting must be ignored and removed.
    // All scenarios still reach the server, so the request went to localhost.
  }, Object.assign({ hostname: 'remote.invalid', port: String(EXT_PORT) }, settingsPatch))
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

async function pageState(driver) {
  return driver.executeScript(function () {
    const vis = (el) => !!(el && el.offsetParent !== null);
    const items = [...document.querySelectorAll('ul.ui-autocomplete li')];
    return {
      events: (window.__kph && window.__kph.events) || [],
      autocompleteMenus: document.querySelectorAll('ul.ui-autocomplete').length,
      autocompleteItemsVisible: items.filter(vis).map((li) => li.textContent),
      genpwIcons: document.querySelectorAll('.cip-genpw-icon').length,
      usernameLen: (document.getElementById('username') || {}).value?.length ?? null,
      passwordLen: (document.getElementById('password') || {}).value?.length ?? null,
    };
  });
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
    await driver.get(PAGES.replace('{host}', 'single') + '/login.html');
    await sleep(4000);
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
    await driver.get(PAGES.replace('{host}', 'single') + '/login.html');
    await sleep(4000);
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
    await driver.get(PAGES.replace('{host}', 'multi') + '/login.html');
    await sleep(4000);
    const stats = await kphStats();
    await driver.findElement(By.id('username')).click();
    await sleep(1200);
    const s = await pageState(driver);
    return {
      getLoginsOnLoad: stats?.byType['get-logins'] ?? 'n/a',
      autocompleteItemsOnFocus: s.autocompleteItemsVisible,
      autocompleteMenus: s.autocompleteMenus,
      pass: stats?.byType['get-logins'] === 1 && s.autocompleteItemsVisible.length === 2,
    };
  },

  // Item 1: a key without keyGen (made by the old Math.random code) must be
  // removed and not used. Restores the valid key afterwards.
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
    return {
      weakKeyAccepted: !!(st.r && st.r.associated),
      keysLeftAfterLoad: Object.keys(after).length,
      validKeyAcceptedAgain: !!(back.r && back.r.associated),
      pass: !(st.r && st.r.associated) && Object.keys(after).length === 0 && !!(back.r && back.r.associated),
    };
  },

  // Item 3: every verified request carries Hmac; a successful response with a
  // missing or wrong Hmac is rejected (no fill), the key is kept, and normal
  // traffic works again afterwards. Tampering is done by the fake server or proxy.
  async hmac(driver) {
    const loadAndRead = async () => {
      await driver.get(PAGES.replace('{host}', 'single') + '/login.html');
      await sleep(3000);
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

  // Form appears after 2.5 s.
  async late(driver) {
    await configure(driver, { autoFillSingleEntry: false });
    await kphReset();
    await driver.get(PAGES.replace('{host}', 'single') + '/login-late.html');
    await sleep(6000);
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
    await driver.get(PAGES.replace('{host}', 'single') + '/login.html');
    await sleep(3000);
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
    // Counts dropdown items added to the page during one click on username.
    const rendersOnClick = async () => {
      await driver.executeScript(function () {
        window.__acAdded = 0;
        window.__acObs = new MutationObserver((ms) => {
          // Check the parent (m.target): a later render may already have removed n.
          for (const m of ms) for (const n of m.addedNodes) {
            if (n.nodeType === 1 && n.matches('li') && m.target.closest && m.target.closest('#kphc-ac-menu')) window.__acAdded++;
          }
        });
        window.__acObs.observe(document.body, { childList: true, subtree: true });
      });
      await driver.executeScript("document.getElementById('other').focus()");
      await sleep(300);
      await driver.findElement(By.id('username')).click();
      await sleep(1500);
      await driver.findElement(By.id('username')).sendKeys(Key.ESCAPE);
      return driver.executeScript('window.__acObs.disconnect(); return window.__acAdded;');
    };
    await configure(driver, { autoFillSingleEntry: false });
    await driver.get(PAGES.replace('{host}', 'single') + '/login.html');
    await sleep(3000);
    const fresh = await rendersOnClick();
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
    await sleep(1000);
    const afterRedetect = await rendersOnClick();
    return { tabsFound: sent, rendersFresh: fresh, rendersAfterRedetect: afterRedetect,
      pass: sent === 1 && fresh > 0 && afterRedetect === fresh };
  },
};

// ---------- main ----------
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
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.fatal ? 1 : 0);
}
