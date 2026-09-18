// ── Offline shell for the B Dance studio app ──────────────────────────────────────────────────
// The whole app is one big index.html fetched fresh on every reload. That means a flaky moment on
// the counter's iPad — a dropped WiFi frame, a captive portal, a request that reaches Netlify too
// garbled to be matched to a site — locks the front desk out of the app entirely, usually showing
// Netlify's own "Site not found" page.
//
// Strategy: NETWORK FIRST, cache only as the safety net.
//   online  → always the freshest deploy, so a drag-and-drop upload shows up on the next reload
//             and there is no stale-version trap
//   trouble → the last known-good copy off the device, so a reload always lands in the app
//
// The important subtlety: Netlify's "Site not found" arrives as a perfectly successful HTTP
// response carrying a 404. fetch() does NOT throw on it. So a plain try/catch fallback would hand
// that 404 straight to the screen — exactly the bug this exists to kill. Anything that isn't a 200
// is therefore treated as a failure and falls through to the cache, and is never cached itself.

const CACHE = 'bdance-shell-v2';
const SHELL = '/index.html';
const NET_TIMEOUT = 6000; // a reload shouldn't hang on a stalled network — fall back well before that

self.addEventListener('install', e => {
  self.skipWaiting(); // a new deploy takes over on the next reload rather than waiting for every tab to close
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function handleNav(req) {
  const cache = await caches.open(CACHE);

  // redirect: 'manual' — a phone hitting the desktop domain gets a 307 to the mobile site. Reading
  // or following that redirect ourselves would mean an extra cross-origin DNS+TLS+HTTP round trip
  // happening INSIDE this fetch, on top of the original one, easily blowing past NET_TIMEOUT on a
  // slow connection — and when that timeout fires, the code below falls back to the cached shell,
  // which for a phone on this domain is the desktop page. The fix is to never attempt to resolve
  // the redirect here at all: hand the opaque redirect response straight back to the browser, which
  // then follows it itself, natively and instantly, exactly as it would with no service worker.
  const net = fetch(req, { redirect: 'manual' })
    .then(async res => {
      if (res && res.type === 'opaqueredirect') return res;   // pass through untouched — never cache
      // Only a genuinely healthy page is worth keeping. Never cache a 404 / 5xx, or we'd persist
      // Netlify's error page as "the app" and serve it back forever.
      if (res && res.status === 200) {
        try { await cache.put(SHELL, res.clone()); } catch (e) { /* cache full / opaque — not fatal */ }
      }
      return res;
    })
    .catch(() => null); // hard network failure

  let timer;
  const slow = new Promise(r => { timer = setTimeout(() => r('timeout'), NET_TIMEOUT); });
  const first = await Promise.race([net, slow]);
  clearTimeout(timer);

  // the normal, healthy, online path — including a redirect, which resolves near-instantly since
  // nothing above waits on the redirect target at all
  if (first && first !== 'timeout' && (first.type === 'opaqueredirect' || first.status === 200)) return first;

  // network failed, stalled, or answered with something that isn't the app — use the device copy
  const cached = await cache.match(SHELL);
  if (cached) return cached;

  // nothing cached yet (very first visit, and it went wrong) — pass the real answer through so the
  // underlying problem stays visible instead of being masked by a blank screen
  const settled = (first && first !== 'timeout') ? first : await net;
  return settled || new Response(
    'No connection, and no offline copy saved yet. Reconnect and reload once to store one.',
    { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
  );
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.mode !== 'navigate') return; // page loads only — never touch data traffic

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Supabase, uploads, anything third-party
  if (url.pathname.startsWith('/api/')) return; // the cloud database function must stay live

  // Real iOS/iPadOS Safari has a long-standing bug where a service worker resolving a NAVIGATION
  // with an opaque-redirect Response (exactly what handleNav() above does for a phone, on purpose)
  // fails instead of following the redirect — it errors internally ("Response served by service
  // worker has redirections") rather than actually going to the mobile site. Chrome's device-mode
  // UA-spoofing doesn't reproduce this because it's still Chromium underneath, not real WebKit —
  // which is exactly why this can pass every desktop devtools check and still fail on a real iPhone.
  // A phone hitting this domain is always about to be redirected away by vercel.json anyway, so
  // there's nothing to gain by intercepting its navigation here — bail out and let the browser's
  // own, un-intercepted fetch handle it, exactly as if this service worker didn't exist. That path
  // has no such bug on any browser.
  const PHONE_UA = /iPhone|iPod|Android.*Mobile|BlackBerry|IEMobile|Opera Mini|Windows Phone|Mobile Safari/;
  if (PHONE_UA.test(self.navigator.userAgent || '')) return;

  e.respondWith(handleNav(req));
});
