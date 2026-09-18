# Device redirect (desktop ⇄ mobile) — both directions ACTIVE

**Update (Sept 2026):** this project (`bds`) moved from `www.bdancestudio.com.my` to
`app.bdancestudio.com.my`. `www` (the bare domain) is now a separate `landing` project — the new
marketing/landing page (formerly `Test3D`), which links to this app for sign-in. The `www`↔canonical
references further below predate that move; read `www.bdancestudio.com.my` there as this project's
*old* address. `bdsmobile` and its phone/desktop redirect rules aren't in this upload, but they'll
need their own host checks and canonical tag updated to `app.bdancestudio.com.my` to match.

Three separate Vercel projects, three separate `vercel.json` files:
- **`landing`** → serves `www.bdancestudio.com.my` (and ideally the bare apex). The new marketing
  landing page.
- **`bds`** (this project) → now serves `app.bdancestudio.com.my` instead of `www`. Still redirects
  phones to mobile (see below) — worth a re-think now that `landing` is itself responsive.
- **`bdsmobile`** → serves `mobile.bdancestudio.com.my`. Redirects desktop/iPad to `app` (used to be `www`).

**Important dependency:** these redirects just send the browser to the other domain — they do
NOT control what's actually served there. Both domains need to already point to their own
deployed Vercel project (see "Before deploying" below).

## What was fixed (Aug 7, 2026)
This doc previously said the phone→mobile redirect was "ACTIVE", but the actual `vercel.json` in
this project no longer had the `redirects` block in it at all — it had been dropped at some point
(the same edit that also dropped the matching `rel="canonical"` tag from `index.html`, both on Aug
6). So phones visiting www were most likely NOT being redirected to mobile before this fix, despite
what this file claimed. Both have been restored, and the reverse direction (desktop/iPad → www),
which never existed on the `bdsmobile` side, has been added.

## What each rule does
- **Phone → mobile** (`bds/vercel.json`): matches common phone user-agents (iPhone, Android
  phones, BlackBerry, etc). iPads are intentionally NOT matched — modern iPadOS Safari reports
  itself as "Macintosh" by default, so tablets fall through to the second rule below, same as
  desktop.
- **Desktop/iPad → www** (`bdsmobile/vercel.json`): the mirror image — anything that does *not*
  match that same phone pattern gets sent to www. Since iPads don't match it, they land on www,
  same as any desktop browser.
- Both sides guard against redirect loops with a `missing: host` check, in case either domain
  ever ends up accidentally attached to the wrong Vercel project.
- `permanent: false` = a 302 (temporary) redirect on both sides, not 301 — deliberate, so it's
  still easy to walk back while this is fresh. Switch both to `true` together once you're
  confident it's staying put, for the SEO benefit of a permanent redirect.
- `/api/*` stays excluded from the desktop-side rule so the Supabase bridge function is never
  redirected. `bdsmobile` has no `/api` routes of its own, so its rule doesn't need that exclusion.

## Also fixed: canonical tags (SEO)
- `bds/index.html` → restored `<link rel="canonical" href="https://www.bdancestudio.com.my/"/>`
- `bdsmobile/index.html` → added the matching `<link rel="canonical" href="https://www.bdancestudio.com.my/"/>`
  pointing back to the desktop version (this one had never been added)

Together with the existing `rel="alternate"` tag already on the desktop page, this is what tells
Google the two domains are one site, not two — without it, both can get indexed as unrelated
listings (which the code comments say already happened once before).

## Before deploying, confirm
1. `mobile.bdancestudio.com.my`'s DNS actually resolves and something real is deployed there
   (not a placeholder / 404) — same for `www.bdancestudio.com.my` pointing at this (`bds`) project.
2. You've tested **both directions** — a phone hitting www, and a desktop/iPad hitting mobile —
   before trusting it in production. A UA override in devtools works fine for this; you don't
   need a second physical phone.
3. If you're re-testing on a phone/browser that already visited the site before, do a hard
   refresh or clear site data first — `sw.js` on the desktop site is network-first, so it
   shouldn't mask a redirect, but stale cache is the first thing to rule out if a test looks wrong.
4. Whether the bare apex domain (`bdancestudio.com.my`, no `www`) should also redirect to `www`
   is a separate, one-click setting in Vercel's own Domains dashboard — not something either
   `vercel.json` controls.
