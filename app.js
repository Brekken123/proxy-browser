/**
 * app.js — the browser shell. Drives an <iframe> that loads /proxy?url=...
 * Because the iframe is same-origin, we can use its history for Back/Forward.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const frame = $('frame'), home = $('home-page'), address = $('address');
  const progress = $('progress'), currentUrl = $('current-url'), lock = $('lock');
  let realUrl = null;

  const ENGINES = {
    duckduckgo: (q) => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  };

  /** Turn address-bar input into a URL, or a search if it doesn't look like one. */
  function toUrl(input) {
    const text = input.trim();
    if (!text) return null;
    if (/^https?:\/\//i.test(text)) return text;
    if (/^[^\s]+\.[a-z]{2,}(\/.*)?$/i.test(text) || /^[^\s]+:\d+/.test(text)) return 'https://' + text;
    const engine = localStorage.getItem('engine') || 'duckduckgo';
    return ENGINES[engine](text);
  }

  function startLoading() { progress.className = 'progress'; void progress.offsetWidth; progress.className = 'progress active'; }
  function stopLoading() { progress.className = 'progress done'; }

  function navigate(input) {
    const url = toUrl(input);
    if (!url) return;
    home.hidden = true; frame.hidden = false;
    startLoading();
    frame.src = '/proxy?url=' + encodeURIComponent(url);
    setUrl(url);
  }

  function setUrl(url) {
    realUrl = url;
    address.value = url || '';
    currentUrl.textContent = url || 'New tab';
    lock.textContent = !url ? '🔍' : url.startsWith('https:') ? '🔒' : '⚠️';
  }

  function showHome() {
    frame.hidden = true; frame.src = 'about:blank'; home.hidden = false;
    setUrl(null); document.title = 'Proxy Browser'; stopLoading();
  }

  /** Read the real URL out of the iframe's proxied location. */
  function syncFromFrame() {
    try {
      const loc = frame.contentWindow.location;
      if (loc.pathname !== '/proxy') return;
      const params = new URLSearchParams(loc.search);
      const injected = frame.contentWindow.__PROXY_REAL_URL__;
      setUrl(injected || params.get('url') || params.get('__proxy_url'));
      document.title = (frame.contentDocument.title || realUrl) + ' — Proxy Browser';
    } catch { /* cross-origin (should not happen) */ }
  }

  frame.addEventListener('load', () => {
    stopLoading();
    syncFromFrame();
    // Show progress again when the user clicks a link inside the page.
    try { frame.contentWindow.addEventListener('beforeunload', startLoading); } catch {}
  });

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'proxy:navigate' && e.data.url) setUrl(e.data.url);
  });

  // Toolbar
  $('address-form').addEventListener('submit', (e) => { e.preventDefault(); navigate(address.value); address.blur(); });
  $('home-form').addEventListener('submit', (e) => { e.preventDefault(); navigate($('home-input').value); });
  document.querySelectorAll('.shortcuts button').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.url)));
  address.addEventListener('focus', () => address.select());

  $('back').addEventListener('click', () => { if (!frame.hidden) frame.contentWindow.history.back(); });
  $('forward').addEventListener('click', () => { if (!frame.hidden) frame.contentWindow.history.forward(); });
  $('refresh').addEventListener('click', () => { if (!frame.hidden) { startLoading(); frame.contentWindow.location.reload(); } });
  $('home').addEventListener('click', showHome);

  $('newtab').addEventListener('click', () => {
    if (realUrl) window.open('/proxy?url=' + encodeURIComponent(realUrl), '_blank', 'noopener');
  });

  $('fullscreen').addEventListener('click', () => {
    const shell = $('shell');
    if (!document.fullscreenElement) {
      shell.classList.add('full');
      (document.documentElement.requestFullscreen || (() => Promise.resolve())).call(document.documentElement).catch(() => {});
    } else document.exitFullscreen();
  });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) $('shell').classList.remove('full'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('shell').classList.remove('full'); });

  // Dark mode (persisted)
  const applyTheme = (dark) => { document.body.classList.toggle('dark', dark); $('theme').innerHTML = dark ? '&#9728;' : '&#9790;'; };
  applyTheme(localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && matchMedia('(prefers-color-scheme: dark)').matches));
  $('theme').addEventListener('click', () => {
    const dark = !document.body.classList.contains('dark');
    localStorage.setItem('theme', dark ? 'dark' : 'light'); applyTheme(dark);
  });

  // Settings
  const msg = (t) => { $('settings-msg').textContent = t; };
  $('settings-btn').addEventListener('click', async () => {
    $('settings').hidden = false; msg('');
    $('engine').value = localStorage.getItem('engine') || 'duckduckgo';
    const r = await fetch('/api/user-agent').then((r) => r.json());
    $('ua').value = r.userAgent;
  });
  $('close-settings').addEventListener('click', () => { $('settings').hidden = true; });
  $('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('settings').hidden = true; });
  $('engine').addEventListener('change', (e) => localStorage.setItem('engine', e.target.value));
  $('save-ua').addEventListener('click', async () => {
    await fetch('/api/user-agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userAgent: $('ua').value }) });
    msg('User-Agent saved. Reload the page to apply it.');
  });
  $('clear').addEventListener('click', async () => {
    await fetch('/api/clear', { method: 'POST' });
    msg('Cookies and session cleared.');
  });

  // Support deep links: /?url=https://example.com
  const initial = new URLSearchParams(location.search).get('url');
  if (initial) navigate(initial);
})();
