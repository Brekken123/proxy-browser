/**
 * rewriter.js — rewrites HTML and CSS so that every resource keeps flowing through the proxy.
 */
const cheerio = require('cheerio');

const PROXY_PATH = '/proxy';

/** Build a proxied URL for an absolute target URL. */
function proxify(target) {
  return `${PROXY_PATH}?url=${encodeURIComponent(target)}`;
}

/**
 * Resolve `value` relative to `base` and return its proxied form.
 * Leaves data:, blob:, javascript:, mailto:, tel: and fragment-only links untouched.
 */
function rewriteUrl(value, base) {
  if (!value) return value;
  const v = value.trim();
  if (!v || v.startsWith('#') || /^(data|blob|javascript|mailto|tel|about):/i.test(v)) return value;
  try {
    const abs = new URL(v, base);
    if (!['http:', 'https:'].includes(abs.protocol)) return value;
    return proxify(abs.href);
  } catch {
    return value;
  }
}

/** Rewrite a srcset attribute ("a.png 1x, b.png 2x"). */
function rewriteSrcset(value, base) {
  return value
    .split(',')
    .map((part) => {
      const [url, ...desc] = part.trim().split(/\s+/);
      return [rewriteUrl(url, base), ...desc].join(' ');
    })
    .join(', ');
}

/** Rewrite url(...) and @import inside CSS text. */
function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => `url(${q}${rewriteUrl(u, base)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import ${q}${rewriteUrl(u, base)}${q}`);
}

/** Small script injected into every page: reports the real URL to the browser shell. */
function injectedScript(pageUrl) {
  return `<script>(function(){try{
  var real=${JSON.stringify(pageUrl)};
  window.__PROXY_REAL_URL__=real;
  if(window.parent!==window){window.parent.postMessage({type:'proxy:navigate',url:real,title:document.title},'*');
  document.addEventListener('DOMContentLoaded',function(){window.parent.postMessage({type:'proxy:title',title:document.title},'*');});}
  // Catch links added dynamically by scripts after rewriting.
  document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;
    var h=a.getAttribute('href');if(!h||h.indexOf('${PROXY_PATH}?url=')===0||/^(#|javascript:|mailto:|tel:)/i.test(h))return;
    try{var abs=new URL(h,real);if(/^https?:$/.test(abs.protocol)){a.setAttribute('href','${PROXY_PATH}?url='+encodeURIComponent(abs.href));}}catch(_){}} ,true);
  }catch(_){}})();</script>`;
}

/** Attributes that contain a single URL, per tag selector. */
const URL_ATTRS = [
  ['a, area, link', 'href'],
  ['img, script, iframe, frame, embed, source, track, audio, video, input[type=image]', 'src'],
  ['video', 'poster'],
  ['object', 'data'],
  ['form', 'action'],
  ['button[formaction], input[formaction]', 'formaction'],
];

/**
 * Rewrite a full HTML document.
 * @param {string} html  raw HTML
 * @param {string} pageUrl final URL of the page (after redirects)
 */
function rewriteHtml(html, pageUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Respect <base href>, then remove it (all URLs become absolute-through-proxy).
  let base = pageUrl;
  const baseHref = $('base[href]').attr('href');
  if (baseHref) { try { base = new URL(baseHref, pageUrl).href; } catch {} }
  $('base').remove();

  // Remove things that would break or escape the proxy.
  $('meta[http-equiv="Content-Security-Policy" i]').remove();
  $('script[integrity], link[integrity]').removeAttr('integrity');
  $('[crossorigin]').removeAttr('crossorigin');
  $('a[target], form[target]').removeAttr('target'); // keep navigation inside the frame

  for (const [selector, attr] of URL_ATTRS) {
    $(selector).each((_, el) => {
      const val = $(el).attr(attr);
      if (val !== undefined) $(el).attr(attr, rewriteUrl(val, base));
    });
  }

  // GET forms drop the action's query string, so carry the target in a hidden field.
  $('form').each((_, el) => {
    const $f = $(el);
    const method = ($f.attr('method') || 'get').toLowerCase();
    const original = $f.attr('action');
    let target = base;
    if (original && original.startsWith(PROXY_PATH + '?url=')) {
      target = decodeURIComponent(original.slice((PROXY_PATH + '?url=').length));
    }
    if (method === 'get') {
      $f.attr('action', PROXY_PATH);
      $f.prepend(`<input type="hidden" name="__proxy_url" value="${target.replace(/"/g, '&quot;')}">`);
    } else if (!original) {
      $f.attr('action', proxify(target));
    }
  });

  $('[srcset]').each((_, el) => $(el).attr('srcset', rewriteSrcset($(el).attr('srcset'), base)));
  $('[style]').each((_, el) => $(el).attr('style', rewriteCss($(el).attr('style'), base)));
  $('style').each((_, el) => $(el).html(rewriteCss($(el).html() || '', base)));

  // <meta http-equiv="refresh" content="5; url=/next">
  $('meta[http-equiv="refresh" i]').each((_, el) => {
    const c = $(el).attr('content') || '';
    const m = c.match(/^(\s*\d+\s*;\s*url\s*=\s*)(.+)$/i);
    if (m) $(el).attr('content', m[1] + rewriteUrl(m[2].replace(/['"]/g, ''), base));
  });

  const script = injectedScript(pageUrl);
  if ($('head').length) $('head').prepend(script);
  else $.root().prepend(script);

  return $.html();
}

module.exports = { rewriteHtml, rewriteCss, rewriteUrl, proxify, PROXY_PATH };
