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
      .then(() => done(true), (e) => done(String(e)));
  }, Object.assign({ hostname: '127.0.0.1', port: String(EXT_PORT) }, settingsPatch));
  await toWebTab(driver);
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
        ? 'Saved test association was rejected by KeePass. Run once with SETUP=1 to create a new one.'
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
    };
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
    };
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
