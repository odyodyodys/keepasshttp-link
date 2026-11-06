// Fake KeePassHttp server for local tests. DUMMY DATA ONLY.
// Speaks the subset of the KeePassHttp protocol (alan-null v2.3.x) that the
// extension uses: test-associate, associate, get-logins, get-logins-count,
// generate-password, set-login. No dialogs: every association is accepted.
//
// Listens on 127.0.0.1 only. Extra test-only endpoints:
//   GET  /__stats  -> request counters + request log (no secrets)
//   POST /__reset  -> clear counters and log (keeps associations)
//   POST /__mode   -> {"tamper": mode} response tampering (see tamper.js)
//
// Env: MOCK_PORT (default 19475), MOCK_LOOSE_MATCH=1 to copy the real
// server's loose host matching (EndsWith/Contains, no dot boundary).

import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tamper, parseMode } from './tamper.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_PORT || 19475);
const LOOSE = process.env.MOCK_LOOSE_MATCH === '1';
const VERSION = '2.3.1.0';
const DB_HASH = crypto.createHash('sha1').update('mock-test-database').digest('hex');

const entries = JSON.parse(readFileSync(path.join(here, 'entries.json'), 'utf8'));
const keys = new Map(); // Id -> base64 AES key
let stats = { total: 0, byType: {}, log: [] };
let tamperMode = 'none';

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

function encrypt(text, keyB64, ivB64) {
  const c = crypto.createCipheriv('aes-256-cbc', unb64(keyB64), unb64(ivB64));
  return b64(Buffer.concat([c.update(Buffer.from(String(text), 'utf8')), c.final()]));
}

function decrypt(dataB64, keyB64, ivB64) {
  const d = crypto.createDecipheriv('aes-256-cbc', unb64(keyB64), unb64(ivB64));
  return Buffer.concat([d.update(unb64(dataB64)), d.final()]).toString('utf8');
}

function hmac(keyB64, ivB64, cipherB64) {
  return b64(crypto.createHmac('sha256', unb64(keyB64))
    .update(Buffer.concat([unb64(ivB64), unb64(cipherB64)])).digest());
}

// Like the plugin (Protocol.cs): Hmac is optional, but if present it must match
// (checked first, constant time), then the Verifier must decrypt to the Nonce.
function verifyRequest(r, keyB64) {
  try {
    if (!r.Nonce || !r.Verifier || !keyB64) return false;
    if (r.Hmac) {
      const want = unb64(hmac(keyB64, r.Nonce, r.Verifier));
      const got = unb64(r.Hmac);
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;
    }
    return decrypt(r.Verifier, keyB64, r.Nonce) === r.Nonce;
  } catch {
    return false;
  }
}

function baseResponse(type) {
  return { RequestType: type, Success: false, Version: VERSION, Hash: DB_HASH };
}

function signResponse(res, id, keyB64) {
  const iv = b64(crypto.randomBytes(16));
  res.Success = true;
  res.Id = id;
  res.Nonce = iv;
  res.Verifier = encrypt(iv, keyB64, iv);
  res.Hmac = hmac(keyB64, iv, res.Verifier);
  return iv;
}

function hostOf(u) {
  try { return new URL(u).host.toLowerCase(); } catch { return ''; }
}

function matches(entry, pageUrl) {
  const pageHost = hostOf(pageUrl);
  const entryHost = hostOf(entry.url);
  if (!pageHost || !entryHost) return false;
  if (LOOSE) return pageHost.endsWith(entryHost) || pageHost.includes(entry.title);
  return pageHost === entryHost || pageHost.endsWith('.' + entryHost);
}

function encEntry(e, keyB64, iv) {
  return {
    Name: encrypt(e.title, keyB64, iv),
    Login: encrypt(e.login, keyB64, iv),
    Password: encrypt(e.password, keyB64, iv),
    Uuid: encrypt(e.uuid, keyB64, iv),
    Group: { Name: encrypt('Test', keyB64, iv), Uuid: encrypt('00000000000000000000000000000000', keyB64, iv) },
    StringFields: null,
  };
}

function handle(r) {
  const type = r.RequestType;
  const res = baseResponse(type);
  const logItem = { t: Date.now(), type, verified: false, hmac: typeof r.Hmac === 'string' && r.Hmac.length > 0 };
  stats.total++;
  stats.byType[type] = (stats.byType[type] || 0) + 1;
  stats.log.push(logItem);

  if (type === 'associate') {
    if (!verifyRequest(r, r.Key)) return [200, res];
    const id = 'test-client-' + (keys.size + 1);
    keys.set(id, r.Key);
    logItem.verified = true;
    signResponse(res, id, r.Key);
    return [200, res];
  }

  const key = keys.get(r.Id);
  if (!verifyRequest(r, key)) {
    // Unverified test-associate is how the client reads the DB hash.
    if (type !== 'test-associate') res.Error = "Couldn't verify request";
    return [200, res];
  }
  logItem.verified = true;

  switch (type) {
    case 'test-associate':
      signResponse(res, r.Id, key);
      return [200, res];
    case 'get-logins':
    case 'get-logins-count': {
      const url = decrypt(r.Url, key, r.Nonce);
      logItem.url = url;
      const found = entries.filter((e) => matches(e, url));
      const iv = signResponse(res, r.Id, key);
      res.Count = found.length;
      if (type === 'get-logins') res.Entries = found.map((e) => encEntry(e, key, iv));
      return [200, res];
    }
    case 'generate-password': {
      const iv = signResponse(res, r.Id, key);
      const pw = b64(crypto.randomBytes(15));
      res.Entries = [encEntry({ title: '', login: '120', password: pw, uuid: '' }, key, iv)];
      return [200, res];
    }
    case 'set-login':
      signResponse(res, r.Id, key);
      return [200, res];
    default:
      return [400, { Error: 'Unknown command' }];
  }
}

const server = http.createServer((req, resp) => {
  const send = (code, obj) => {
    resp.writeHead(code, { 'Content-Type': 'application/json' });
    resp.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url === '/__stats') return send(200, stats);
  if (req.method === 'POST' && req.url === '/__reset') {
    stats = { total: 0, byType: {}, log: [] };
    return send(200, { ok: true });
  }
  if (req.method !== 'POST') return send(405, { Error: 'POST only' });
  if (req.url === '/__mode') {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      try { tamperMode = parseMode(b); send(200, { tamper: tamperMode }); } catch (e) { send(400, { Error: e.message }); }
    });
    return;
  }

  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 1e6) req.destroy();
  });
  req.on('end', () => {
    let r;
    try { r = JSON.parse(body); } catch { return send(400, { Error: 'Bad JSON' }); }
    const [code, out] = handle(r);
    send(code, tamper(tamperMode, out));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-keepasshttp] listening on http://127.0.0.1:${PORT} (loose match: ${LOOSE})`);
});

export default server;
