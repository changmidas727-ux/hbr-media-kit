// Snapshot pages of https://www.hbrtaiwan.com/ as static HTML that keeps the live layout on desktop and mobile.
//
//   node capture.mjs <outDir> [page ...]
//   node capture.mjs D:/2026/hbr_廣告 home latest magazine video-and-podcast podcast
//
// page: "home", a site path without the leading slash ("latest"), or a full https://www.hbrtaiwan.com/ URL.
// Each page is captured twice (desktop 1440px, iPhone 390px) and merged into one hbr_<page>.html: the parts the
// site renders differently per device carry data-snap-variant="desktop|mobile" and switch at 1024px, like the site.
// All pages share one hbr_assets/ folder. Needs Node 22+ and Google Chrome.
// Set CAPTURE_TMP to choose where the temporary Chrome profiles go.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SITE = 'https://www.hbrtaiwan.com';
const SITE_HOST = new URL(SITE).host;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ASSET_DIR = 'hbr_assets';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DEVICES = {
  desktop: {
    ua: DESKTOP_UA, touch: false,
    metrics: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  },
  mobile: {
    touch: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    metrics: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  },
};

const [OUT_DIR, ...pageArgs] = process.argv.slice(2);
if (!OUT_DIR) {
  console.error('usage: node capture.mjs <outDir> [page ...]');
  process.exit(1);
}
const toPage = (arg) => {
  const url = /^https?:\/\//.test(arg) ? new URL(arg) : new URL(arg === 'home' ? '/' : `/${arg.replace(/^\/+/, '')}`, SITE);
  if (url.host !== SITE_HOST) throw new Error(`not a ${SITE_HOST} page: ${arg}`);
  return { url: url.href, name: url.pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '_') || 'home' };
};
const pages = (pageArgs.length ? pageArgs : ['home']).map(toPage);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Chrome / CDP ----------
async function openBrowser() {
  const profile = await fs.mkdtemp(path.join(process.env.CAPTURE_TMP || os.tmpdir(), 'hbr-capture-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,900',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  let ws;
  const close = async () => {
    try { ws?.close(); } catch { /* already closed */ }
    chrome.kill();
    await sleep(1000);
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  try {
    let wsUrl;
    for (let i = 0; i < 60 && !wsUrl; i++) {
      try {
        const port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim();
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
      } catch { /* not up yet */ }
      if (!wsUrl) await sleep(500);
    }
    if (!wsUrl) throw new Error('Chrome DevTools endpoint did not come up');
    ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  } catch (e) {
    await close();
    throw e;
  }
  let msgId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      listeners.get(msg.method)(msg.params);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const once = (method, timeout) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeout);
    listeners.set(method, (p) => { clearTimeout(t); listeners.delete(method); resolve(p); });
  });
  const evaluate = async (fn, arg) => {
    const expression = `(${fn.toString()})(${JSON.stringify(arg ?? null)})`;
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 240000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, once, evaluate, close };
}

// ---------- in-page steps ----------
// Resolve once the page has stopped changing; ads, carousels and chat widgets animate forever and are ignored.
const waitForQuiet = async ({ quietMs, maxMs }) => {
  const ignored = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !el || !!el.closest('iframe, script, .gpt-ad-slot, [id^="google_ads"], [aria-roledescription="carousel"], #botbonnie-chatbox');
  };
  let last = performance.now();
  const observer = new MutationObserver((records) => { if (records.some((r) => !ignored(r.target))) last = performance.now(); });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const start = performance.now();
  while (performance.now() - last < quietMs && performance.now() - start < maxMs) await new Promise((r) => setTimeout(r, 100));
  observer.disconnect();
  return Math.round(performance.now() - start);
};

// Visit the whole page so lazily rendered sections exist, then return to the top.
const scrollThrough = async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let y = 0; y < document.documentElement.scrollHeight; y += 400) { window.scrollTo(0, y); await wait(250); }
  await wait(2000);
  window.scrollTo(0, 0);
  await wait(1500);
  return document.documentElement.scrollHeight;
};

// Give every rendered ad slot a chance to receive its creative iframe (or to be reported empty by the site).
const waitForAds = async ({ maxMs }) => {
  const start = performance.now();
  const pendingSlots = () => [...document.querySelectorAll('.gpt-ad-slot')]
    .filter((slot) => slot.getClientRects().length > 0 && !slot.closest('.empty-ad')
      && !slot.querySelector('iframe[id^="google_ads_iframe_"]'));
  while (pendingSlots().length && performance.now() - start < maxMs) await new Promise((r) => setTimeout(r, 250));
  return pendingSlots().map((slot) => slot.id);
};

// Stylesheets and inline-CSS assets that Node has to download before finalize().
const collectAssets = () => {
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
  const inlineUrls = new Set();
  const collect = (css) => {
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      if (!/^(data:|#|about:)/i.test(m[1])) { const u = abs(m[1]); if (u) inlineUrls.add(u); }
    }
  };
  document.querySelectorAll('style').forEach((s) => collect(s.textContent));
  document.querySelectorAll('[style*="url("]').forEach((el) => collect(el.getAttribute('style')));
  return {
    sheets: [...document.querySelectorAll('link[rel~="stylesheet"]')].map((l) => l.href),
    inlineUrls: [...inlineUrls],
  };
};

// Turn the live DOM into the static snapshot and serialise it. Deliberately synchronous: the page's own
// timers (carousel autoplay, ad refresh) cannot run between these edits and the serialisation.
const finalize = ({ sheetMap, assetMap }) => {
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
  const absCssUrls = (css) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) =>
    /^(data:|#|about:)/i.test(u) ? m : `url(${q}${abs(u)}${q})`);
  const localCss = (css) => {
    let out = absCssUrls(css);
    for (const [from, to] of Object.entries(assetMap)) out = out.split(from).join(to);
    return out;
  };

  // 1. ad slots -> sized placeholders. A served creative is a cross-origin iframe and cannot be kept; a slot that
  //    happened to get no ad during the capture gets the first size GPT declares for it at this viewport.
  const declared = new Map();
  try {
    for (const s of window.googletag.pubads().getSlots()) {
      const sizes = (s.getSizes(window.innerWidth, window.innerHeight) || [])
        .filter((z) => typeof z === 'object' && z.getWidth() > 1 && z.getHeight() > 1)
        .map((z) => `${z.getWidth()}x${z.getHeight()}`);
      declared.set(s.getSlotElementId(), { path: s.getAdUnitPath(), sizes: [...new Set(sizes)] });
    }
  } catch { /* GPT did not load: only the rendered iframes are known */ }
  const ads = [];
  const placeholder = ({ path, w, h, sizes, display, verticalAlign, filled }) => {
    const [unit, slot = unit.split('/').pop()] = path.split('*');
    const ph = document.createElement('div');
    ph.className = 'ad-placeholder';
    ph.dataset.adUnit = unit;
    ph.dataset.adSlot = slot;
    if (sizes.length) ph.dataset.adSizes = sizes.join(',');
    ph.style.cssText = [
      `display:${display}`, `vertical-align:${verticalAlign}`,
      `width:${w}px`, `height:${h}px`, 'box-sizing:border-box', 'flex-direction:column',
      'align-items:center', 'justify-content:center', 'gap:4px', 'border:1px dashed #b5b5b5',
      'background:repeating-linear-gradient(45deg,#f4f4f4 0 10px,#ececec 10px 20px)',
      'color:#888', 'font:12px/1.2 Arial,sans-serif', 'text-align:center', 'overflow:hidden',
    ].join(';');
    ph.innerHTML = `<strong style="font-weight:600">AD · ${slot}</strong><span>${w} × ${h}</span>`;
    ads.push({ slot, unit, w, h, sizes, filled });
    return ph;
  };
  document.querySelectorAll('iframe[id^="google_ads_iframe_"]').forEach((f) => {
    const r = f.getBoundingClientRect();
    const w = parseInt(f.getAttribute('width'), 10) || Math.round(r.width);
    const h = parseInt(f.getAttribute('height'), 10) || Math.round(r.height);
    if (w <= 1 || h <= 1) { f.remove(); return; }
    const m = f.id.match(/^google_ads_iframe_(.*)_\d+$/);
    const slotEl = f.closest('.gpt-ad-slot');
    const cs = getComputedStyle(f);
    f.replaceWith(placeholder({
      path: m ? m[1] : f.id, w, h, sizes: (slotEl && declared.get(slotEl.id)?.sizes) || [],
      display: cs.display === 'block' ? 'flex' : 'inline-flex', verticalAlign: cs.verticalAlign, filled: true,
    }));
  });
  document.querySelectorAll('.gpt-ad-slot').forEach((el) => {
    const slotInfo = declared.get(el.id);
    if (el.querySelector('.ad-placeholder') || !slotInfo || !slotInfo.sizes.length) return;
    const [w, h] = slotInfo.sizes[0].split('x').map(Number);
    const container = el.querySelector('[id$="__container__"]') || el;
    if (container !== el) container.setAttribute('style', 'border: 0pt;');
    container.replaceChildren(placeholder({ path: slotInfo.path, w, h, sizes: slotInfo.sizes, display: 'inline-flex', verticalAlign: 'bottom', filled: false }));
    el.style.removeProperty('display');
    if (!el.getAttribute('style')) el.removeAttribute('style');
    el.closest('.ad-wrapper')?.classList.remove('empty-ad');
  });

  // 2. autoplaying carousels stop wherever they happened to be: put each back on its first slide
  document.querySelectorAll('[aria-roledescription="carousel"]').forEach((carousel) => {
    const slides = carousel.querySelectorAll('[aria-roledescription="slide"]');
    slides.forEach((s) => {
      s.style.removeProperty('transform');
      if (!s.getAttribute('style')) s.removeAttribute('style');
    });
    if (slides[0]) slides[0].parentElement.style.transform = 'translate3d(0px, 0px, 0px)';
    carousel.querySelectorAll('button[aria-label^="Go to slide"]').forEach((dot, i) => {
      dot.classList.toggle('bg-inverted', i === 0);
      dot.classList.toggle('bg-accented', i !== 0);
    });
  });

  // 3. drop scripts and third-party / runtime-only DOM
  document.querySelectorAll('script, noscript, template').forEach((el) => el.remove());
  document.querySelectorAll('link[rel~="modulepreload"], link[rel~="preload"], link[rel~="prefetch"], link[rel~="dns-prefetch"], link[rel~="preconnect"]').forEach((el) => el.remove());
  ['#botbonnie-chatbox', '#instag-mod-webmsg', '.cookie-banner', 'base'].forEach((s) => document.querySelectorAll(s).forEach((el) => el.remove()));
  document.querySelectorAll('iframe').forEach((f) => {
    const r = f.getBoundingClientRect();
    if (f.hidden || getComputedStyle(f).display === 'none' || r.width * r.height <= 1 || f.id === 'bb-iframe') f.remove();
  });
  document.querySelectorAll('style').forEach((s) => { if (/^\s*(@keyframes\s+)?\.?aiq-/.test(s.textContent)) s.remove(); });
  for (const el of [document.documentElement, document.body]) {
    if (el.style.overflow === 'hidden') el.style.removeProperty('overflow');
    if (el.style.touchAction) el.style.removeProperty('touch-action');
  }

  // 4. absolute URLs everywhere, local copies for the site's CSS and the assets it references
  const skip = (v) => !v || /^(#|javascript:|data:|blob:|mailto:|tel:)/i.test(v.trim());
  for (const attr of ['src', 'href', 'poster', 'action', 'data-src', 'xlink:href']) {
    document.querySelectorAll(`[${attr.replace(':', '\\:')}]`).forEach((el) => {
      const v = el.getAttribute(attr);
      if (!skip(v)) el.setAttribute(attr, abs(v));
    });
  }
  document.querySelectorAll('[srcset]').forEach((el) => {
    el.setAttribute('srcset', el.getAttribute('srcset').split(',').map((part) => {
      const [u, ...rest] = part.trim().split(/\s+/);
      return [skip(u) ? u : abs(u), ...rest].join(' ');
    }).join(', '));
  });
  document.querySelectorAll('img[data-src]:not([src])').forEach((img) => img.setAttribute('src', img.dataset.src));
  document.querySelectorAll('[style*="url("]').forEach((el) => el.setAttribute('style', localCss(el.getAttribute('style'))));
  document.querySelectorAll('style').forEach((s) => { if (s.textContent.includes('url(')) s.textContent = localCss(s.textContent); });
  // local copies must not be CORS requests, or they fail when the page is opened via file://
  document.querySelectorAll('link[rel~="stylesheet"]').forEach((l) => {
    if (!sheetMap[l.href]) return;
    l.setAttribute('href', sheetMap[l.href]);
    l.removeAttribute('crossorigin');
    l.removeAttribute('integrity');
  });

  return { ads, html: `<!DOCTYPE html>\n${document.documentElement.outerHTML}` };
};

// Merge the desktop and mobile snapshots of a page into one document. Elements present in both stay once;
// the rest are kept with data-snap-variant and switched by a media query at the site's 1024px breakpoint.
const mergeVariants = ({ desktopHtml, mobileHtml }) => {
  const parse = (h) => new DOMParser().parseFromString(h, 'text/html');
  const D = parse(desktopHtml);
  const M = parse(mobileHtml);
  // attributes the snapshot script rewrites at runtime, or that change on every page load
  const RUNTIME_STYLE = '.nav-outside, #footer-bottom-bar, .header-banner-container';
  const IGNORED_ATTRS = new Set(['data-google-query-id']);
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').replace(/\s+/g, ' ').trim();
  const attrKey = (el) => [...el.attributes]
    .filter((a) => !IGNORED_ATTRS.has(a.name) && !(a.name === 'style' && (!a.value.trim() || el.matches(RUNTIME_STYLE))))
    .map((a) => `${a.name}=${a.name === 'class' ? a.value.split(/\s+/).filter(Boolean).sort().join(' ') : a.value.replace(/\s+/g, ' ').trim()}`)
    .sort().join('\u0001');
  const keys = new WeakMap();
  const key = (el) => {
    if (!keys.has(el)) keys.set(el, `${el.tagName}\u0002${attrKey(el)}\u0002${ownText(el)}`);
    return keys.get(el);
  };
  const lcs = (a, b) => {
    const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    const pairs = [];
    for (let i = 0, j = 0; i < a.length && j < b.length;) {
      if (a[i] === b[j]) pairs.push([i++, j++]);
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return pairs;
  };
  let variantCount = 0;
  const mergeChildren = (dEl, mEl) => {
    const dc = [...dEl.children];
    const mc = [...mEl.children];
    const steps = [];
    let i = 0;
    let j = 0;
    for (const [pi, pj] of [...lcs(dc.map(key), mc.map(key)), [dc.length, mc.length]]) {
      while (i < pi) steps.push(['desktop', dc[i++]]);
      while (j < pj) steps.push(['mobile', mc[j++]]);
      if (pi < dc.length) steps.push(['both', dc[i++], mc[j++]]);
    }
    let cursor = null;
    for (const [kind, d, m] of steps) {
      if (kind === 'both') { mergeChildren(d, m); cursor = d; continue; }
      const node = kind === 'desktop' ? d : D.importNode(d, true);
      node.setAttribute('data-snap-variant', kind);
      if (kind === 'mobile') { if (cursor) cursor.after(node); else dEl.prepend(node); }
      cursor = node;
      variantCount++;
    }
  };

  // <head>: union of both (a hidden <style> would still apply, so nothing there is marked)
  const headKeys = new Set([...D.head.children].map(key));
  for (const el of M.head.children) if (!headKeys.has(key(el))) D.head.appendChild(D.importNode(el, true));
  mergeChildren(D.body, M.body);

  const css = D.createElement('style');
  css.id = 'snapshot-variants';
  css.textContent = [
    '/* desktop / mobile variants of this snapshot: the site switches its JS-rendered parts at 1024px */',
    '@media (max-width: 1023.98px) { [data-snap-variant="desktop"] { display: none !important; } }',
    '@media (min-width: 1024px) { [data-snap-variant="mobile"] { display: none !important; } }',
    '/* HeaderBanner drops its background image at 393px and below */',
    '@media (max-width: 393px) { .header-banner-container { background-image: none !important; } }',
  ].join('\n');
  D.head.appendChild(css);
  return { variantCount, html: `<!DOCTYPE html>\n${D.documentElement.outerHTML}` };
};

// ---------- scroll behaviour shipped inside the snapshot ----------
// The site's Nuxt JS is stripped, so this re-implements the scroll-driven parts of NavigationBar, the default
// layout, MobileNav and FooterBottomBar (/_nuxt/Cki-zw4Y.js) with the same rules.
const snapshotBehavior = () => {
  const navOutside = document.querySelector('.nav-outside');
  const nav = navOutside && navOutside.querySelector('.nav-container');
  if (!nav) return;
  const logo = nav.querySelector('.logo');
  const menu = nav.querySelector('.menu.pc');
  const bar = document.getElementById('footer-bottom-bar');
  const mobileNav = document.querySelector('.mobile-nav');
  const DESKTOP_MIN_WIDTH = 1024;
  const BAR_MIN_SCROLL = 300;
  const BAR_DIRECTION_SLOP = 5;
  const MOBILE_NAV_DIRECTION_SLOP = 2;
  const BAR_SHOWN = ['opacity-100', 'translate-y-0', 'pointer-events-auto'];
  const BAR_HIDDEN = ['opacity-0', 'translate-y-full', 'pointer-events-none'];

  let adHeight = 0;
  let scrolled = false;
  let layoutFrame = 0;
  let barLastY = window.scrollY;
  let barScrollingUp = true;
  let barDismissed = false;
  let mobileNavLastY = 0;
  let mobileNavShown = true;

  const isDesktop = () => window.innerWidth >= DESKTOP_MIN_WIDTH;
  // height of the top ad currently shown (desktop and mobile variants may both be in the page)
  const measureAd = () => {
    const ad = [...navOutside.querySelectorAll('.ad-wrapper')]
      .find((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
    return ad ? ad.offsetHeight : 0;
  };

  // At the top of the page on desktop, the menu moves to its own row when it cannot fit beside the logo.
  const layoutMenu = () => {
    let separate = false;
    if (isDesktop() && !scrolled && logo && menu) {
      menu.classList.add('menu-pc--measure-row');
      const needed = menu.getBoundingClientRect().width;
      menu.classList.remove('menu-pc--measure-row');
      const room = Math.max(0, nav.getBoundingClientRect().right - logo.getBoundingClientRect().right);
      separate = room <= 0 || needed > room;
    }
    navOutside.classList.toggle('separateMenu', separate);
  };
  const scheduleLayout = () => {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; layoutMenu(); });
  };

  const trackBar = (y) => {
    if (y <= 0) { barScrollingUp = true; barLastY = 0; return; }
    if (y > barLastY + BAR_DIRECTION_SLOP) barScrollingUp = false;
    else if (y < barLastY - BAR_DIRECTION_SLOP) barScrollingUp = true;
    barLastY = y;
  };
  // the mobile bottom nav hides while scrolling down and returns when scrolling up or back at the top
  const trackMobileNav = (y) => {
    if (isDesktop()) { mobileNavLastY = y; return; }
    if (y <= 0) { mobileNavShown = true; mobileNavLastY = 0; return; }
    if (y > mobileNavLastY + MOBILE_NAV_DIRECTION_SLOP) mobileNavShown = false;
    else if (y < mobileNavLastY - MOBILE_NAV_DIRECTION_SLOP) mobileNavShown = true;
    mobileNavLastY = y;
  };

  const render = () => {
    const y = window.scrollY;
    // the fixed header follows the bottom edge of the top ad until the ad has scrolled away
    navOutside.style.setProperty('--nav-sticky-top', `${Math.max(0, adHeight - y)}px`);
    navOutside.style.setProperty('--ad-shift-y', `${-Math.min(y, adHeight)}px`);
    if ((y > 0) !== scrolled) {
      scrolled = y > 0;
      nav.classList.toggle('scroll', scrolled);
      scheduleLayout();
    }
    if (mobileNav) mobileNav.classList.toggle('hidden', isDesktop() || !mobileNavShown);
    if (bar) {
      const show = !barDismissed && y > BAR_MIN_SCROLL && barScrollingUp;
      bar.classList.remove(...(show ? BAR_HIDDEN : BAR_SHOWN));
      bar.classList.add(...(show ? BAR_SHOWN : BAR_HIDDEN));
      const navVisible = mobileNav && !isDesktop() && !mobileNav.classList.contains('hidden') && getComputedStyle(mobileNav).display !== 'none';
      bar.style.bottom = `${navVisible ? mobileNav.offsetHeight : 0}px`;
    }
  };

  const onScroll = () => {
    const y = window.scrollY;
    trackBar(y);
    trackMobileNav(y);
    render();
  };
  const remeasureAd = () => { adHeight = measureAd(); render(); };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => { trackMobileNav(window.scrollY); remeasureAd(); scheduleLayout(); });
  window.addEventListener('load', scheduleLayout);
  if (document.fonts) document.fonts.ready.then(scheduleLayout);
  if ('ResizeObserver' in window) {
    new ResizeObserver(remeasureAd).observe(navOutside);
    const layoutObserver = new ResizeObserver(scheduleLayout);
    [nav, logo, menu].forEach((el) => el && layoutObserver.observe(el));
  }
  const closeBar = bar && bar.querySelector('button');
  if (closeBar) closeBar.addEventListener('click', () => { barDismissed = true; render(); });

  trackMobileNav(window.scrollY);
  remeasureAd();
  scheduleLayout();
};

const withBehavior = (html) => {
  const tag = `<script>\n// Header / bottom-bar scroll behaviour, re-implemented because the site's own JS is not in this snapshot.\n(${snapshotBehavior.toString()})();\n</script>\n`;
  const at = html.lastIndexOf('</body>');
  return at === -1 ? html + tag : html.slice(0, at) + tag + html.slice(at);
};

// ---------- shared assets ----------
const failures = [];
const isSiteAsset = (u) => { try { return new URL(u).host === SITE_HOST; } catch { return false; } };
const assetPath = (u) => {
  const p = new URL(u).pathname;
  if (/\.(woff2?|ttf|otf|eot)$/i.test(p)) return `fonts/${path.posix.basename(p)}`;
  return `media/${p.replace(/^\/+/, '').replace(/\//g, '_') || 'index'}`;
};
const downloads = new Map();
function download(u) {
  if (!downloads.has(u)) {
    downloads.set(u, (async () => {
      const rel = assetPath(u);
      const res = await fetch(u, { headers: { 'User-Agent': DESKTOP_UA } });
      if (!res.ok) throw new Error(`${res.status} ${u}`);
      const file = path.join(OUT_DIR, ASSET_DIR, rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      return rel;
    })());
  }
  return downloads.get(u);
}
const sheets = new Map();
function localSheet(href) {
  if (!sheets.has(href)) {
    sheets.set(href, (async () => {
      const res = await fetch(href, { headers: { 'User-Agent': DESKTOP_UA } });
      if (!res.ok) throw new Error(`${res.status} ${href}`);
      let css = await res.text();
      const urls = new Set([...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]).filter((u) => !/^(data:|#)/i.test(u)));
      for (const u of urls) {
        const full = new URL(u, href).href;
        let replacement = full;
        if (isSiteAsset(full)) {
          try { replacement = `../${await download(full)}`; } catch (e) { failures.push(e.message); }
        }
        const escaped = u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        css = css.replace(new RegExp(`url\\(\\s*(['"]?)${escaped}\\1\\s*\\)`, 'g'), `url($1${replacement}$1)`);
      }
      const name = path.posix.basename(new URL(href).pathname);
      await fs.mkdir(path.join(OUT_DIR, ASSET_DIR, 'css'), { recursive: true });
      await fs.writeFile(path.join(OUT_DIR, ASSET_DIR, 'css', name), css);
      return `${ASSET_DIR}/css/${name}`;
    })());
  }
  return sheets.get(href);
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// ---------- capture one page on one device ----------
async function capture(page, deviceName) {
  const device = DEVICES[deviceName];
  const browser = await openBrowser();
  try {
    await browser.send('Page.enable');
    await browser.send('Runtime.enable');
    await browser.send('Network.enable');
    await browser.send('Emulation.setDeviceMetricsOverride', device.metrics);
    await browser.send('Emulation.setTouchEmulationEnabled', { enabled: device.touch, maxTouchPoints: device.touch ? 5 : 1 });
    await browser.send('Network.setUserAgentOverride', { userAgent: device.ua });
    const loaded = browser.once('Page.loadEventFired', 90000);
    await browser.send('Page.navigate', { url: page.url });
    await loaded;
    await browser.evaluate(waitForQuiet, { quietMs: 2500, maxMs: 20000 });
    const height = await browser.evaluate(scrollThrough);
    await browser.evaluate(waitForQuiet, { quietMs: 1500, maxMs: 15000 });
    const adsMissing = await browser.evaluate(waitForAds, { maxMs: 12000 });

    const { sheets: sheetHrefs, inlineUrls } = await browser.evaluate(collectAssets);
    const sheetMap = {};
    await pool(sheetHrefs.filter(isSiteAsset), 6, async (href) => {
      try { sheetMap[href] = await localSheet(href); } catch (e) { failures.push(e.message); }
    });
    const assetMap = {};
    await pool(inlineUrls.filter(isSiteAsset), 6, async (u) => {
      try { assetMap[u] = `${ASSET_DIR}/${await download(u)}`; } catch (e) { failures.push(e.message); }
    });

    const { ads, html } = await browser.evaluate(finalize, { sheetMap, assetMap });
    return { html, height, ads, adsMissing };
  } finally {
    await browser.close();
  }
}

async function merge(desktopHtml, mobileHtml) {
  const browser = await openBrowser();
  try {
    await browser.send('Runtime.enable');
    return await browser.evaluate(mergeVariants, { desktopHtml, mobileHtml });
  } finally {
    await browser.close();
  }
}

// ---------- run ----------
await fs.mkdir(path.join(OUT_DIR, ASSET_DIR), { recursive: true });
const adIndexFile = path.join(OUT_DIR, ASSET_DIR, 'ad-slots.json');
let adIndex = {};
try { adIndex = JSON.parse(await fs.readFile(adIndexFile, 'utf8')); } catch { /* first run */ }
for (const k of Object.keys(adIndex)) if (k.endsWith('_mobile.html') || Array.isArray(adIndex[k])) delete adIndex[k]; // older layout
const describe = (r) => {
  const slots = r.ads.map((a) => `${a.slot} ${a.w}x${a.h}${a.filled ? '' : '*'}`).join(', ') || 'no ads';
  return `${r.height}px, ${slots}${r.adsMissing.length ? ` (still loading: ${r.adsMissing.join(', ')})` : ''}`;
};

for (const page of pages) {
  const file = `hbr_${page.name}.html`;
  try {
    const desktop = await capture(page, 'desktop');
    const mobile = await capture(page, 'mobile');
    const { html, variantCount } = await merge(desktop.html, mobile.html);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const banner = `Static snapshot of ${page.url} captured ${stamp} UTC: desktop (1440px) and mobile (390px) layouts, switching at 1024px. `
      + 'Site scripts removed (scroll behaviour re-implemented at the end of <body>); ad slots replaced by .ad-placeholder boxes.';
    await fs.writeFile(path.join(OUT_DIR, file), withBehavior(html.replace(/^<!DOCTYPE html>\n/, `<!DOCTYPE html>\n<!-- ${banner} -->\n`)));
    adIndex[file] = { desktop: desktop.ads, mobile: mobile.ads };
    console.log(`${file}: desktop ${describe(desktop)} | mobile ${describe(mobile)} | ${variantCount} device-specific blocks`);
  } catch (e) {
    failures.push(`${page.url}: ${e.message}`);
    console.log(`FAILED ${page.url}: ${e.message}`);
  }
}
await fs.writeFile(adIndexFile, JSON.stringify(adIndex, null, 2));
console.log('* no ad was served for this slot during the capture; the placeholder uses its first declared size');
console.log(`${downloads.size} assets, ${sheets.size} stylesheets in ${ASSET_DIR}/`);
if (failures.length) {
  console.log('FAILURES:\n' + [...new Set(failures)].join('\n'));
  process.exitCode = 1;
}
