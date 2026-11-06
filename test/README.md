# Test harness (Firefox only, dummy data only)

Local tools to drive Firefox with the extension from `../src`. Nothing here is shipped.
All tools are installed locally (`node_modules/`, `.cache/`). No global installs.

## Parts

| Path | What |
|---|---|
| `run.js` | Starts servers, starts Firefox 159 with a fresh profile, loads `../src` as a temporary add-on, runs scenarios |
| `mock-keepasshttp/` | Fake KeePassHttp server on `127.0.0.1:19475`. No dialogs. Counts requests (`GET /__stats`) |
| `pages/` | Test pages on port 8080 for `single.localhost`, `multi.localhost`, `bank.localhost`, `evilbank.localhost` |
| `keepass/` | (git-ignored) Portable test KeePass + alan-null KeePassHttp plugin + dummy `test.kdbx` |
| `artifacts/` | (git-ignored) `report.json` and screenshots per scenario |
| `.cache/` | (git-ignored) geckodriver binary and temporary Firefox profiles |

## Run

```sh
cd test
npm run test:all                 # lint + unit tests + all scenarios on the fake server
npm test                         # all scenarios, headless, fake server
npm test -- autofill single      # some scenarios
npm run test:real                # all scenarios on the real test KeePass (see below)
node run.js --list               # list the scenario names
HEADLESS=0 npm test              # show the Firefox window
FF_PWMGR=1 npm test              # keep Firefox's built-in password manager on
SHOTS=1 npm test -- options toolbar   # also save screenshots of the extension pages
SHOTS=1 DARK=1 npm test -- options    # the same in dark mode
```

The runner prints one summary line and exits with code 1 if any scenario fails.
Details per scenario are in `artifacts/report.json`.

## Notes

- The test profile is always new and empty. The real Firefox profile is never used.
- geckodriver runs with `--allow-system-access` so the runner can open `moz-extension://` pages
  (options page) in the test profile. Do not reuse this setup for normal browsing.
- The extension UUID is fixed with the `extensions.webextensions.uuids` pref.
- `*.localhost` names are forced to loopback with `network.dns.localDomains`.

## Real test KeePass

- Portable KeePass 2.61.1 in `test/keepass/`, alan-null `KeePassHttp.plgx` v2.3.1.0 in `test/keepass/Plugins/`.
- Dummy database `test/keepass/test.kdbx` with the entries from `mock-keepasshttp/entries.json`.
- Plugin listens on `localhost:19465` (the default port 19455 stays free).
- Test KeePass settings: "Always allow access" on, "Limit to single instance" off, no auto-lock.
  Turn "Always allow updates" on before testing `set-login`.
- The extension talks to a logging proxy on `19466` (port + 1), which forwards to KeePass and
  logs request type / status / error only.

### Association (one time only)

The plugin always shows a modal "associate" dialog, and blocks all other requests while it is
open. So the runner associates **once** and then reuses that association:

```sh
SETUP=1 NO_MOCK=1 KPH_PORT=19465 node run.js autofill   # confirm the dialog in the TEST KeePass
npm run test:real                                      # all later runs: no dialog
```

- The setup run saves the extension's `keyRing` (key name + AES key) to
  `.cache/keyring-19465.json`. Every new profile gets it restored before tests start.
- Without `SETUP=1` the runner **never** sends `associate`; it stops with an error instead.
- If KeePass rejects the saved key (key deleted, other database), run the setup again.
- The saved key opens the **dummy test database only**. It is git-ignored. Never point this
  harness at a real database.
