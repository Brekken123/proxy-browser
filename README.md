# Proxy Browser

A minimal, modern web-based proxy browser built with **Node.js + Express**, **axios** and **cheerio**.
Type a URL (or a search) into the address bar and the server fetches the page, rewrites every link,
form, image, script and stylesheet so it keeps flowing through the proxy, and shows it inside a
browser-like interface.

## Features

- Browser chrome: address bar, Go, Back / Forward / Refresh / Home, current-URL bar, loading indicator
- HTTP and HTTPS sites, relative and absolute URLs, `<base href>`, `srcset`, inline styles, CSS `url()` / `@import`, meta refresh
- GET and POST forms keep working through the proxy
- Per-session cookie jar (cookies from sites are stored server-side, never mixed between users)
- Redirects followed server-side, each hop security-checked
- Dark mode, full-screen mode, open-in-new-tab
- Custom User-Agent, "Clear cookies & session" button
- Search Google or DuckDuckGo directly from the address bar
- Friendly error page when a site fails to load
- Mobile-responsive layout
- **SSRF protection**: blocks `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, link-local, CGNAT, multicast, IPv6 loopback/ULA/link-local, and IPv4-mapped IPv6 — checked after DNS resolution

## Setup

Requires **Node.js 18+**.

```bash
npm install
npm start
```

Open <http://localhost:3000>.

Environment variables (optional):

| Variable         | Default           | Purpose                           |
|------------------|-------------------|-----------------------------------|
| `PORT`           | `3000`            | Port to listen on                 |
| `SESSION_SECRET` | random per start  | Secret used to sign session cookies |

Deep link: `http://localhost:3000/?url=https://example.com`

## Project structure

```
proxy-browser/
├── server.js          # Express app, /proxy route, cookies, redirects, error page
├── lib/
│   ├── rewriter.js    # HTML/CSS rewriting (cheerio)
│   └── security.js    # Private-IP / localhost blocking
├── public/
│   ├── index.html     # Browser shell UI
│   ├── style.css      # Light/dark theme, responsive layout
│   └── app.js         # Navigation, history, settings
└── package.json
```

## How the proxy works

1. The UI loads `/proxy?url=<encoded target>` in a same-origin iframe.
2. The server validates the URL (protocol + DNS → blocks private IPs), attaches session cookies and
   the chosen User-Agent, and fetches it with axios (redirects handled manually).
3. HTML is parsed with cheerio; every `href`, `src`, `action`, `srcset`, `poster`, inline `style`
   and `<style>` block is resolved against the page URL and rewritten to `/proxy?url=...`.
   GET forms get a hidden `__proxy_url` field so their query string reaches the right target.
4. CSS responses get `url()` / `@import` rewritten. Other content (images, JS, fonts) is passed through.
5. Headers that would block framing or leak (`CSP`, `X-Frame-Options`, `Set-Cookie`, …) are stripped.

## Limitations

This is a learning-grade proxy. URLs built at runtime by JavaScript (`fetch`, XHR, WebSockets,
service workers) are not rewritten, so heavy single-page apps (YouTube, Google apps, etc.) may
partially break. Sites with bot protection may refuse proxied requests. Cookies live in memory and
reset when the server restarts. Don't expose it publicly without rate limiting and authentication.
