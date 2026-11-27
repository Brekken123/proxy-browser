/**
 * server.js — Express entry point for the proxy browser.
 *
 *   GET  /            → browser shell UI (public/index.html)
 *   ALL  /proxy?url=  → fetches the target, rewrites it, streams it back
 *   POST /api/clear   → clears the session's cookie jar
 */
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { CookieJar } = require('tough-cookie');
const { assertSafeUrl } = require('./lib/security');
const { rewriteHtml, rewriteCss, proxify } = require('./lib/rewriter');

const PORT = process.env.PORT || 3000;
const MAX_REDIRECTS = 10;
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const app = express();

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: true,
  cookie: { httpOnly: true, sameSite: 'lax' },
}));

/** In-memory cookie jars, one per browser session (keyed by session id). */
const jars = new Map();
function getJar(req) {
  if (!jars.has(req.sessionID)) jars.set(req.sessionID, new CookieJar());
  return jars.get(req.sessionID);
}

app.use(express.static(path.join(__dirname, 'public')));

/** Raw body for proxied POST/PUT requests (forms, fetch, etc.). */
app.use('/proxy', express.raw({ type: () => true, limit: '10mb' }));

app.post('/api/clear', (req, res) => {
  jars.delete(req.sessionID);
  req.session.regenerate(() => res.json({ ok: true }));
});

app.post('/api/user-agent', express.json(), (req, res) => {
  const ua = String((req.body && req.body.userAgent) || '').slice(0, 500);
  req.session.userAgent = ua || null;
  res.json({ ok: true, userAgent: req.session.userAgent || DEFAULT_UA });
});

app.get('/api/user-agent', (req, res) => res.json({ userAgent: req.session.userAgent || DEFAULT_UA }));

/** Work out the real target URL from the query string (incl. rewritten GET forms). */
function resolveTarget(req) {
  const q = { ...req.query };
  if (q.__proxy_url) {
    const target = new URL(q.__proxy_url);
    delete q.__proxy_url;
    target.search = new URLSearchParams(q).toString();
    return target.href;
  }
  return q.url;
}

function errorPage(res, status, title, detail, url) {
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  res.status(status).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f6f6f8;color:#222}
.c{max-width:460px;text-align:center;padding:24px}h1{font-size:22px}p{color:#666;line-height:1.5}code{background:#e9e9ee;padding:2px 6px;border-radius:4px;word-break:break-all}
@media(prefers-color-scheme:dark){body{background:#17171b;color:#eee}p{color:#aaa}code{background:#2a2a30}}</style></head>
<body><div class="c"><div style="font-size:44px">⚠️</div><h1>${esc(title)}</h1><p>${esc(detail)}</p>${url ? `<p><code>${esc(url)}</code></p>` : ''}
<script>window.parent!==window&&window.parent.postMessage({type:'proxy:error',url:${JSON.stringify(url || '')}},'*')</script></div></body></html>`);
}

/** Request headers we never forward to the target. */
const HOP_HEADERS = new Set(['host', 'cookie', 'connection', 'content-length', 'accept-encoding', 'origin', 'referer', 'upgrade', 'te', 'trailer', 'transfer-encoding', 'keep-alive', 'proxy-authorization']);
/** Response headers we never forward back to the browser. */
const STRIP_RESPONSE = new Set(['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'set-cookie', 'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'strict-transport-security', 'location', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy']);

app.all('/proxy', async (req, res) => {
  let target;
  try {
    target = resolveTarget(req);
    if (!target) return errorPage(res, 400, 'No URL given', 'Enter an address in the address bar.');
  } catch {
    return errorPage(res, 400, 'Invalid address', 'That URL could not be understood.', req.query.url);
  }

  const jar = getJar(req);
  const userAgent = req.session.userAgent || DEFAULT_UA;
  let method = req.method;
  let body = ['GET', 'HEAD'].includes(method) ? undefined : req.body;

  // Follow redirects manually so every hop is security-checked and cookies are stored.
  try {
    let upstream;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertSafeUrl(target);

      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k) && !k.startsWith('sec-')) headers[k] = v;
      headers['user-agent'] = userAgent;
      headers['accept-encoding'] = 'gzip, deflate, br';
      const cookie = await jar.getCookieString(target);
      if (cookie) headers.cookie = cookie;
      const refererReal = req.query.__ref;
      if (refererReal) headers.referer = refererReal;

      upstream = await axios.request({
        url: target, method, headers, data: body,
        responseType: 'arraybuffer', maxRedirects: 0, validateStatus: () => true,
        timeout: 20000, maxContentLength: 50 * 1024 * 1024, decompress: true,
      });

      // Save cookies set by the target into the session jar.
      const setCookie = upstream.headers['set-cookie'] || [];
      for (const c of setCookie) { try { await jar.setCookie(c, target); } catch {} }

      const loc = upstream.headers.location;
      if (upstream.status >= 300 && upstream.status < 400 && loc) {
        target = new URL(loc, target).href;
        if (upstream.status === 303 || ((upstream.status === 301 || upstream.status === 302) && method === 'POST')) {
          method = 'GET'; body = undefined;
        }
        continue;
      }
      break;
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      return errorPage(res, 508, 'Too many redirects', 'The site redirected too many times.', target);
    }

    // Copy safe response headers.
    for (const [k, v] of Object.entries(upstream.headers)) if (!STRIP_RESPONSE.has(k)) res.setHeader(k, v);
    res.status(upstream.status);

    const type = String(upstream.headers['content-type'] || '').toLowerCase();
    const buf = Buffer.from(upstream.data);

    if (type.includes('text/html') || type.includes('application/xhtml')) {
      res.type('html').send(rewriteHtml(buf.toString('utf8'), target));
    } else if (type.includes('text/css')) {
      res.send(rewriteCss(buf.toString('utf8'), target));
    } else {
      res.send(buf); // images, scripts, fonts, JSON… passed through as-is
    }
  } catch (err) {
    const msg = err.code === 'ENOTFOUND' ? 'The server could not be found. Check the address.'
      : err.code === 'ECONNABORTED' ? 'The site took too long to respond.'
      : err.code === 'ECONNREFUSED' ? 'The connection was refused.'
      : err.message || 'Unknown error';
    errorPage(res, 502, "This site can't be reached", msg, target);
  }
});

app.listen(PORT, () => console.log(`Proxy browser running at http://localhost:${PORT}`));

module.exports = { app, proxify };
