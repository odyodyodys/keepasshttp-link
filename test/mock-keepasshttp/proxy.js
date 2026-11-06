// Logging proxy between the extension and a real (test) KeePassHttp.
// Logs request type, HTTP status, Success and Error text only — never
// keys, verifiers or entry data. Same /__stats, /__reset and /__mode endpoints
// as the fake server, so run.js can count requests.
//
// Env: PROXY_PORT (listen, 127.0.0.1), PROXY_TARGET (e.g. http://localhost:19465)

import http from 'node:http';
import { tamper, parseMode } from './tamper.js';

const PORT = Number(process.env.PROXY_PORT || 19466);
const TARGET = process.env.PROXY_TARGET || 'http://localhost:19465';
let stats = { total: 0, byType: {}, log: [] };
let tamperMode = 'none';

http.createServer(async (req, resp) => {
  const send = (code, obj) => {
    resp.writeHead(code, { 'Content-Type': 'application/json' });
    resp.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url === '/__stats') return send(200, stats);
  if (req.method === 'POST' && req.url === '/__reset') {
    stats = { total: 0, byType: {}, log: [] };
    return send(200, { ok: true });
  }
  let body = '';
  for await (const c of req) body += c;
  if (req.method === 'POST' && req.url === '/__mode') {
    try { tamperMode = parseMode(body); return send(200, { tamper: tamperMode }); } catch (e) { return send(400, { Error: e.message }); }
  }
  let type = '?';
  let sentHmac = false;
  try { const q = JSON.parse(body); type = q.RequestType; sentHmac = typeof q.Hmac === 'string' && q.Hmac.length > 0; } catch { /* ignore */ }
  const item = { t: Date.now(), type, hmac: sentHmac };
  stats.total++;
  stats.byType[type] = (stats.byType[type] || 0) + 1;
  stats.log.push(item);
  try {
    const r = await fetch(TARGET + req.url, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: req.method === 'POST' ? body : undefined,
    });
    let text = await r.text();
    item.status = r.status;
    try {
      const j = JSON.parse(text);
      item.verified = j.Success === true;
      if (j.Error) item.error = String(j.Error).slice(0, 300);
      if (Array.isArray(j.Entries)) item.entries = j.Entries.length;
      item.respHmac = typeof j.Hmac === 'string';
      if (tamperMode !== 'none') text = JSON.stringify(tamper(tamperMode, j));
    } catch { /* not JSON */ }
    resp.writeHead(r.status, { 'Content-Type': 'application/json' });
    resp.end(text);
  } catch (e) {
    item.status = 0;
    item.error = 'proxy: ' + e.message;
    resp.writeHead(502);
    resp.end();
  }
  console.log(`[proxy] ${type} -> ${item.status}${item.error ? ' ' + item.error.split('\n')[0] : ''}`);
}).listen(PORT, '127.0.0.1', () => console.log(`[proxy] 127.0.0.1:${PORT} -> ${TARGET}`));
