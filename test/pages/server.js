// Static test pages for the extension. DUMMY DATA ONLY.
// Listens on 127.0.0.1 and ::1 (port PAGES_PORT, default 8080). The same
// pages answer for any host name, so Firefox can use different
// *.localhost names (set via the network.dns.localDomains pref) to get
// different origins.
//   /basic  -> HTTP Basic Auth (user "basic-user" / "Dummy-Basic-Pass")
//   GET /__basic, POST /__basic/reset -> counts of /basic requests with and
//            without an Authorization header (counts only, no values)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'public');
const PORT = Number(process.env.PAGES_PORT || 8080);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
const BASIC = 'Basic ' + Buffer.from('basic-user:Dummy-Basic-Pass').toString('base64');
let basicStats = { withAuth: 0, withoutAuth: 0 };

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__basic') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(basicStats));
  }
  if (url.pathname === '/__basic/reset' && req.method === 'POST') {
    basicStats = { withAuth: 0, withoutAuth: 0 };
    res.writeHead(200);
    return res.end();
  }
  if (url.pathname === '/basic') {
    if (req.headers.authorization) basicStats.withAuth++; else basicStats.withoutAuth++;
    if (req.headers.authorization !== BASIC) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="kph-test"' });
      return res.end('auth required');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<h1 id="ok">Basic auth OK</h1>');
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

for (const host of ['127.0.0.1', '::1']) {
  http.createServer(handler)
    .on('error', (e) => console.error(`[pages] ${host}: ${e.message}`))
    .listen(PORT, host, () => console.log(`[pages] listening on ${host}:${PORT}`));
}
