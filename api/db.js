// B Dance Studio — Supabase bridge (secure; your SECRET key stays on the server).
// Vercel serverless function (api/db.js), served at /api/db.
//
// ── No more JSON blob ────────────────────────────────────────────────────
// This file used to store the WHOLE studio database as one JSON row in an
// "app_state" table (column: data jsonb) and read/write that single row on
// every request. That's gone. Every entity now lives in its own real
// Supabase table (places, teachers, classes, students, payments,
// attendance, credit_usages, rewards, accounts), each with a native
// Postgres identity primary key — see 001_schema.sql / 002_migrate_from_blob.sql.
// This file never touches the old "app_state" table again; it's left in
// place, untouched, as a historical fallback until you're ready to drop it.
//
// The browser (index.html) is UNCHANGED and still talks the same JSON
// shape it always has ({ data: JSON.stringify({db:{...}, nid:{...}}) }) —
// this file is the only thing that changed, translating that shape to and
// from the real tables underneath it.
//
// Vercel → Project → Settings → Environment Variables:
//   SUPABASE_URL = https://YOURPROJECT.supabase.co
//   SUPABASE_KEY = your SECRET key  (sb_secret_...  or legacy service_role)
//                  (server-side only — never the publishable/anon key)
//
// After adding/changing these, ALWAYS redeploy — Vercel does not hot-apply env
// var changes to existing deployments (Deployments → ⋯ → Redeploy).

const URL_ENV = () => (process.env.SUPABASE_URL || '').trim();
const KEY_ENV = () => (process.env.SUPABASE_KEY || '').trim();
const SETTINGS_ROW_ID = 'main'; // the one row in app_settings holding site content/paymentInfo/styles/etc.
const BUCKET = 'media'; // Supabase Storage bucket holding uploaded instructor videos — see supabase_setup.sql
const IG_ID = () => (process.env.IG_USER_ID || '').trim();     // studio's Instagram Business account id
const IG_TOKEN = () => (process.env.IG_TOKEN || '').trim();    // long-lived / system-user access token
const GRAPH = 'https://graph.facebook.com/v21.0';        // Facebook-Login route (needs IG_USER_ID)
const IG_GRAPH = 'https://graph.instagram.com';           // Instagram-Login route (token only)
const TIMEOUT_MS = 7000; // never hang: a stuck request becomes a clean 504 instead of a platform timeout
function isAbortError(e) {
  return !!(e && (e.name === 'AbortError' || String(e).toLowerCase().includes('abort')));
}
// NOTE: this file deliberately does NOT retry a timed-out request on its own. index.html's own
// CLOUD_TIMEOUT_MS (10s) fires independently of this file's TIMEOUT_MS (7s), and index.html already
// has its own retry (a second attempt with its own fresh timeout) built into every important call —
// requireConnection(), claimServerIds(), commitSave()'s pull-before-save, etc. A retry HERE on top of
// that would make a slow Supabase moment take up to ~2x as long server-side, which risks the browser's
// 10s client-side abort firing while this function is still working — the browser gives up and (for
// saveStudent()) rolls back its local optimistic changes, while this function keeps running in the
// background and can still finish the write, leaving the two sides disagreeing about what was saved.
// A clean, fast failure that the client's own retry logic handles is safer than a server-side retry
// racing a client timeout it doesn't know about.

// ── Optional read cache (Upstash Redis) ──────────────────────────────
// Every signed-in device polls GET roughly every 45s, plus a 4s save-or-pull tick, and every
// landing-page visitor hits GET once on load — all reading the same assembled snapshot. This sits
// in front of the table reads only. It never touches writes, session tokens, logins, or Instagram
// import.
//
// Split into two independently-cached groups instead of one blob, because they change at very
// different rates:
//   - CONFIG group (places, teachers, classes, rewards, app_settings): edited rarely — adding a
//     class, tweaking site copy/pricing, updating a teacher's bio.
//   - DATA group (students, payments, attendance, credit_usages, accounts): changes constantly
//     during business hours — every enrolment, payment, and check-in. Kept at the original short
//     TTL so a genuinely-missed invalidation (e.g. a Redis DEL that itself timed out) self-heals
//     quickly rather than serving stale data for up to an hour.
//
// CONFIG_CACHE_TTL_S used to be 3600 (1h) on the reasoning that every write path already calls
// invalidateConfigCache() the moment it succeeds, so the TTL was "only a fallback for a change made
// OUTSIDE this API." That reasoning assumed every BROWSER TAB is always running code that bypasses
// the cache (`?fresh=1`) on the read it does just before merging and saving. In practice, a tab left
// open across a deploy keeps running its OLD JS — which does a plain cache-first GET before its
// merge — until it's manually closed/reloaded, and this app has no way to force that across every
// device in the field (2026-08-22 incident: classes' difficulty and teacher fields silently reverted
// studio-wide, traced to exactly this — an old tab's pre-save pull read a stale CONFIG snapshot and
// pushed it back over genuinely newer data). Shortening the TTL to 20s (same as DATA) bounds the
// worst case to "at most 20 seconds stale" regardless of which JS version any given device is
// running, closing the gap without depending on every device staying up to date.
//
// Configure by setting UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel. Leave them
// unset and every one of these calls is a no-op: reads go straight to Supabase exactly as they do
// today. Same if Upstash times out or errors — this never makes a request slower or less reliable
// than without it.
const REDIS_URL = () => (process.env.UPSTASH_REDIS_REST_URL || '').trim();
const REDIS_TOKEN = () => (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const REDIS_TIMEOUT_MS = 1500;
// v3 / split into two keys — bumped from the old single "bdance:app_state:v2" key so a stale
// pre-split entry (the whole-snapshot shape) can never be misread as one of the new group shapes.
const CONFIG_CACHE_KEY = 'bdance:cache:config:v3';   // places, teachers, classes, rewards, settings
const CONFIG_CACHE_TTL_S = 20;                       // was 3600 (1h) — see comment above (2026-08-22)
const DATA_CACHE_KEY = 'bdance:cache:data:v3';       // students, payments, attendance, creditUsages, accounts
const DATA_CACHE_TTL_S = 20;                         // unchanged — high-churn data, self-heals fast
// Bumped by invalidateConfigCache() every time it runs — see getConfigGroup()'s race-guard comment
// below for why this exists (2026-08-20): a plain DEL-then-later-SETEX cache had a lost-update race
// where a concurrent read that started before an invalidation could still overwrite the cache with
// stale data after that invalidation completed.
const CONFIG_GEN_KEY = 'bdance:cache:config:gen';
// Same race, same fix, for the DATA cache — see CONFIG_GEN_KEY's comment above. Added after tracing a
// "deleted an attendance record, it's gone, then refresh and it's back" report: attendance is by far
// the highest-churn table in the app (marked constantly, by several counters, all day), which is
// exactly the traffic pattern that turns this from theoretical into routine. Without this, a concurrent
// read already in flight when a delete's invalidateDataCache() runs can still write its now-stale
// result back into the cache a moment later, resurrecting the just-deleted row for up to
// DATA_CACHE_TTL_S seconds on the next GET (a page refresh, another device's poll, anything).
const DATA_GEN_KEY = 'bdance:cache:data:gen';

async function redisCmd(args) {
  const url = REDIS_URL(), token = REDIS_TOKEN();
  if (!url || !token) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REDIS_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: ac.signal,
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j ? j.result : null;
  } catch (e) { return null; }
  finally { clearTimeout(timer); }
}
const configCacheGetRaw = () => redisCmd(['GET', CONFIG_CACHE_KEY]);
const configCacheSetRaw = (value) => redisCmd(['SETEX', CONFIG_CACHE_KEY, String(CONFIG_CACHE_TTL_S), value]);
// Called immediately after any write that can touch places/teachers/classes/rewards/app_settings —
// see saveWholeDb() and the 'restore-teacher-photos-from-backup' handler below. Also bumps
// CONFIG_GEN_KEY (see getConfigGroup()) so an in-flight read from just before this invalidation can
// detect it was overtaken and skip resurrecting stale data into the cache.
const invalidateConfigCache = () => Promise.all([
  redisCmd(['DEL', CONFIG_CACHE_KEY]),
  redisCmd(['INCR', CONFIG_GEN_KEY]),
]);
const dataCacheGetRaw = () => redisCmd(['GET', DATA_CACHE_KEY]);
const dataCacheSetRaw = (value) => redisCmd(['SETEX', DATA_CACHE_KEY, String(DATA_CACHE_TTL_S), value]);
// Called immediately after any write that can touch students/payments/attendance/creditUsages/accounts —
// see saveWholeDb() and the 'update-student' handler below. Also bumps DATA_GEN_KEY (see
// getDataGroup()'s race-guard) so an in-flight read from just before this invalidation can detect it
// was overtaken and skip resurrecting stale data into the cache.
const invalidateDataCache = () => Promise.all([
  redisCmd(['DEL', DATA_CACHE_KEY]),
  redisCmd(['INCR', DATA_GEN_KEY]),
]);
// Whole-database save can touch tables in BOTH groups in the same request (saveWholeDb() always
// reconciles every table, whether or not that particular table's data actually changed this time) —
// so it must clear both, every time, to stay correct.
const invalidateAllCaches = () => Promise.all([invalidateConfigCache(), invalidateDataCache()]);

function headers(extra) {
  const k = KEY_ENV();
  return { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json', ...(extra || {}) };
}
function apiBase() {
  let u = URL_ENV();
  try { u = new URL(u).origin; }
  catch (e) { u = u.replace(/\/+$/, '').replace(/\/rest\/v1$/i, ''); }
  return u;
}
async function fetchWithTimeout(url, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ac.signal, headers: { ...headers(opts.headers) } });
  } finally {
    clearTimeout(timer);
  }
}
async function rawFetch(url, opts = {}, ms = TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(timer); }
}
function igShortcode(u) {
  const m = String(u || '').match(/instagram\.com\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : '';
}
function rest(pathAndQuery, opts = {}) {
  return fetchWithTimeout(apiBase() + '/rest/v1/' + pathAndQuery, opts);
}

// ══════════════════════════════════════════════════════════════════════════
// ── Table layer — translates between the JSON shape index.html expects
//    (camelCase keys, one array per entity) and the real Supabase tables
//    (snake_case columns) underneath. ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
const TABLE_NAME = {
  places: 'places', teachers: 'teachers', classes: 'classes', students: 'students',
  payments: 'payments', attendance: 'attendance', creditUsages: 'credit_usages',
  rewards: 'rewards', accounts: 'accounts',
};
// [jsKey, dbColumn] per entity. Any key on the JS object NOT listed here rides along in the
// table's `meta` jsonb column instead of being dropped — so a field this list doesn't yet know
// about is never silently lost, it just isn't queryable as its own column.
const FIELD_MAPS = {
  places: [['id','id'],['name','name'],['address','address'],['introLink','intro_link']],
  // 'sortOrder' added 2026-08-25 as a REAL column (sort_order) instead of riding along in `meta` —
  // see the migration SQL and fetchConfigGroup()'s comment near CONFIG_CACHE_KEY for why. Once it's
  // a mapped column here, toRow()/toRowFull()/fromRow() all treat it exactly like any other teacher
  // field automatically — no other code changes needed; the JS-side key is still `sortOrder`
  // everywhere (saveArrangeTeachers() in index.html, the sort in fetchConfigGroup() below, etc.).
  teachers: [['id','id'],['name','name'],['phone','phone'],['email','email'],['specs','specs'],
             ['status','status'],['photo','photo'],['instagram','instagram'],
             ['xiaohongshu','xiaohongshu'],['video','video'],['quote','quote'],
             ['sortOrder','sort_order']],
  classes: [['id','id'],['name','name'],['style','style'],['difficulty','difficulty'],
            ['placeId','place_id'],['teacherId','teacher_id'],['day','day'],['start','start_time'],
            ['end','end_time'],['room','room'],['max','max_students']],
  students: [['id','id'],['name','name'],['age','age'],['parent','parent'],['phone','phone'],
             ['email','email'],['classIds','class_ids'],['fee','fee'],['join','join_date'],
             ['notes','notes'],['styleGrades','style_grades'],['birthday','birthday'],
             ['tshirtRedeemed','tshirt_redeemed'],['placeId','place_id'],['credits','credits'],
             ['creditExpiry','credit_expiry'],['pointsAdjust','points_adjust']],
  payments: [['id','id'],['studentId','student_id'],['classId','class_id'],['kind','kind'],
             ['month','month'],['amount','amount'],['status','status'],['date','date'],
             ['method','method'],['notes','notes'],['earnedDate','earned_date'],
             ['creditPkg','credit_pkg'],['billCycle','bill_cycle'],['trialName','trial_name'],
             ['privateName','private_name']],
  attendance: [['id','id'],['classId','class_id'],['studentId','student_id'],['date','date'],
               ['status','status'],['single','is_single'],['bonus','is_bonus'],
               ['bonusMonth','bonus_month'],['paidByCredit','paid_by_credit'],['extra','is_extra'],
               ['dur','duration'],['creditCost','credit_cost']],
  creditUsages: [['id','id'],['studentId','student_id'],['classId','class_id'],['date','date']],
  rewards: [['id','id'],['icon','icon'],['name','name'],['cost','cost']],
  // accounts didn't carry an `id` field on the JS side historically (only `user`, the natural key),
  // but it's now round-tripped (see upsertAccountsReconcile below) so existing rows can be saved
  // WITHOUT re-triggering Postgres's identity default every time — see that function's comment.
  accounts: [['id','id'],['user','user'],['pass','pass'],['role','role'],['name','name'],
             ['ref','ref'],['placeId','place_id'],['passwordChangedAt','password_changed_at']],
};
function toRow(entity, obj) {
  const map = FIELD_MAPS[entity];
  const known = new Set(map.map(m => m[0]));
  const row = {};
  map.forEach(([jsKey, dbCol]) => { if (obj[jsKey] !== undefined) row[dbCol] = obj[jsKey]; });
  const meta = {};
  Object.keys(obj || {}).forEach(k => { if (!known.has(k)) meta[k] = obj[k]; });
  if (Object.keys(meta).length) row.meta = meta;
  return row;
}
// Same idea as toRow(), but guarantees every row it produces has the EXACT same set of keys
// (missing fields become explicit null instead of being left out). Required because Supabase's
// bulk insert rejects a batch where different rows have different key sets — real records
// accumulated over months as the app grew new fields, so older students/teachers/etc. genuinely
// don't have some newer keys at all, which is exactly what triggered "PGRST102: All object keys
// must match" on the very first whole-database save after cutover. Only used for the bulk
// whole-table upsert path (upsertReconcile below); update-student's single-row PATCH still uses
// the sparse toRow() above, where omitting a key correctly means "leave this column alone".
function toRowFull(entity, obj) {
  const map = FIELD_MAPS[entity];
  const known = new Set(map.map(m => m[0]));
  const row = {};
  map.forEach(([jsKey, dbCol]) => { row[dbCol] = obj[jsKey] !== undefined ? obj[jsKey] : null; });
  // classFromRow() (below) closed this off on the READ side — every class always comes OUT of
  // Postgres with a real difficulty. But saveWholeDb()'s bulk classes upsert goes through THIS
  // function, on a plain in-memory `obj` that never passed through classFromRow() at all, so it
  // was never protected the same way. Any class object missing `difficulty` at push time — e.g. a
  // CSV re-import via combinedCSVtoDB() in index.html, where coerce() treats a blank spreadsheet
  // cell as "field not present" rather than "field is empty" — hits the `?? null` above just like
  // every other missing field, and every whole-database save (including the unconditional 4s
  // autosave) writes that null straight into the real column for however many class rows the
  // import touched at once. That's a genuine, current mass-loss, not stale legacy data: it can
  // erase a difficulty an admin set correctly minutes earlier, for many classes in one shot — and
  // once it's null in Postgres, the backfill repair can only restore a generic 'All Levels', never
  // the specific value (Beginner/Advanced/etc.) that was actually there. Guard it here too, so the
  // bulk path can never write null for this column no matter what produced the incoming object.
  if (entity === 'classes' && (row.difficulty == null || row.difficulty === '')) row.difficulty = 'All Levels';
  const meta = {};
  Object.keys(obj || {}).forEach(k => { if (!known.has(k)) meta[k] = obj[k]; });
  row.meta = meta; // always present (possibly {}) — same uniform-keys reasoning as above
  return row;
}
function fromRow(entity, row) {
  const map = FIELD_MAPS[entity];
  const obj = { ...(row.meta || {}) };
  map.forEach(([jsKey, dbCol]) => { if (row[dbCol] !== undefined && row[dbCol] !== null) obj[jsKey] = row[dbCol]; });
  return obj;
}
// A `classes` row with a NULL `difficulty` column comes back from fromRow() with the key simply
// missing (`undefined`) — which index.html's own diffOf() has always papered over locally by
// falling back to 'All Levels' when it draws the badge. That fallback is exactly the problem: it's
// applied independently, in-memory, on whatever device happens to be looking at the class right
// then. Two clients (desktop admin, mobile) can each silently invent their own 'All Levels' for the
// SAME null class without either ever writing a real value back — which is indistinguishable from
// "the difficulty reverted" no matter how solid the save-merge logic is, since there was never a
// real value in Postgres to protect in the first place (see the backfill-class-difficulty repair
// below, and the 2026-08-19/2026-08-22 incidents referenced near CONFIG_CACHE_TTL_S above).
// Fixing it HERE — the one place every class row passes through on its way out of Postgres, for
// every caller (config-cache GET, the fresh read inside save-class, any future client) — means every
// device that loads the app sees the exact same real value, not five different local guesses. It
// also makes legacy rows self-heal: 'All Levels' is now a genuine (truthy) value on the object, so
// the very next ordinary edit of that class (see save-class's fallbackDifficulty below) writes it
// back into the column for real, instead of leaving Postgres NULL forever.
function classFromRow(row) {
  const obj = fromRow('classes', row);
  if (obj.difficulty == null || obj.difficulty === '') obj.difficulty = 'All Levels';
  return obj;
}
// PostgREST/Supabase caps how many rows a single request can return (a project-level "Max Rows"
// setting — 1000 by default, but can be lower). A single unpaginated `select=*` silently gets cut
// off at that cap with NO error — the request still comes back 200 OK, just short — so a studio
// that grows past it (this table's row count, not just the student count: attendance and payments
// grow far faster than students do) would start silently losing the tail end of its own data with
// no indication anything was wrong. Paginate every table read so growth can never trigger that:
// keep asking for the next page by offset until the `Content-Range` header (which PostgREST always
// returns, and always reports the TRUE total via `Prefer: count=exact`, regardless of what any
// project's row cap trims a single page down to) says there's nothing left.
async function fetchTable(entity) {
  const PAGE = 500;
  const table = TABLE_NAME[entity];
  let offset = 0, total = null, all = [];
  for (;;) {
    const r = await rest(table + '?select=*&order=id.asc&offset=' + offset + '&limit=' + PAGE,
      { headers: { Prefer: 'count=exact' } });
    if (!r.ok) throw new Error('Failed to read ' + entity + ': ' + (await r.text().catch(() => '')));
    const page = await r.json();
    all = all.concat(page);
    const cr = r.headers && r.headers.get ? r.headers.get('content-range') : null; // "0-499/1234" or "*/0"
    const m = cr && /\/(\d+)$/.exec(cr);
    if (m) total = parseInt(m[1], 10);
    offset += page.length;
    if (page.length === 0) break; // safety net — never spin forever on an empty/short page
    if (total !== null) { if (offset >= total) break; }
    else if (page.length < PAGE) break; // no usable total (older PostgREST) — a short page means "done"
  }
  return all;
}
async function fetchAllColumn(table, column) {
  const PAGE = 1000;
  let offset = 0, total = null, all = [];
  for (;;) {
    const r = await rest(table + '?select=' + column + '&offset=' + offset + '&limit=' + PAGE,
      { headers: { Prefer: 'count=exact' } });
    if (!r.ok) throw new Error('Failed to read ' + table + ' ids: ' + (await r.text().catch(() => '')));
    const page = await r.json();
    all = all.concat(page.map(row => row[column]));
    const cr = r.headers && r.headers.get ? r.headers.get('content-range') : null;
    const m = cr && /\/(\d+)$/.exec(cr);
    if (m) total = parseInt(m[1], 10);
    offset += page.length;
    if (page.length === 0) break;
    if (total !== null) { if (offset >= total) break; }
    else if (page.length < PAGE) break;
  }
  return all;
}
async function fillFromExisting(entity, rows, conflictKey) {
  if (!rows || !rows.length) return rows || [];
  const existingRows = await fetchTable(entity);
  const existingByKey = new Map(existingRows.map(r => [r[conflictKey], fromRow(entity, r)]));
  const fields = FIELD_MAPS[entity].map(m => m[0]);
  return rows.map(o => {
    const existing = existingByKey.get(o[conflictKey]);
    if (!existing) return o;
    let merged = null;
    fields.forEach(jsKey => {
      if (o[jsKey] === undefined && existing[jsKey] !== undefined) {
        if (!merged) merged = { ...o };
        merged[jsKey] = existing[jsKey];
      }
    });
    return merged || o;
  });
}
// Reads the rarely-changing tables (places/teachers/classes/rewards/settings) straight from Supabase —
// only called on a CONFIG cache miss. See the CONFIG/DATA split comment above the cache constants.
async function fetchConfigGroup() {
  const [places, teachers, classes, rewards, settingsRows] = await Promise.all([
    fetchTable('places'), fetchTable('teachers'), fetchTable('classes'), fetchTable('rewards'),
    rest('app_settings?id=eq.' + SETTINGS_ROW_ID + '&select=*').then(r => r.ok ? r.json() : []),
  ]);
  const settings = settingsRows[0] || {};
  // teachers always come back from fetchTable() in `id.asc` order — that ORDER BY is there for stable
  // pagination across every table, not to reflect the admin's chosen display order. The "Arrange Order"
  // screen (saveArrangeTeachers() in index.html) writes a `sortOrder` number onto each teacher record —
  // its own real `sort_order` column as of 2026-08-25 (FIELD_MAPS.teachers), not the `meta` jsonb blob
  // it used to ride in. Re-sort by it here, once, so every caller (admin GET, public GET, cached or
  // not) sees the arranged order instead of raw id order. A teacher with no sortOrder yet (never been
  // through Arrange Order — e.g. just added) sorts after every teacher that has one, tie-broken by id,
  // so a brand-new teacher lands at the end instead of a random position.
  const teachersSorted = teachers.map(r => fromRow('teachers', r)).sort((a, b) => {
    const av = typeof a.sortOrder === 'number' ? a.sortOrder : Infinity;
    const bv = typeof b.sortOrder === 'number' ? b.sortOrder : Infinity;
    if (av !== bv) return av - bv;
    return (a.id || 0) - (b.id || 0);
  });
  return {
    places: places.map(r => fromRow('places', r)),
    teachers: teachersSorted,
    classes: classes.map(r => classFromRow(r)),
    rewards: rewards.map(r => fromRow('rewards', r)),
    paymentInfo: settings.payment_info || {},
    intro: settings.intro || {},
    styles: settings.styles || [],
    suppressedStudentRefs: settings.suppressed_student_refs || [],
    suppressedTeacherRefs: settings.suppressed_teacher_refs || [],
  };
}
// Reads the high-churn tables (students/payments/attendance/creditUsages/accounts) straight from
// Supabase — only called on a DATA cache miss.
async function fetchDataGroup() {
  const [students, payments, attendance, creditUsages, accounts] = await Promise.all([
    fetchTable('students'), fetchTable('payments'), fetchTable('attendance'),
    fetchTable('creditUsages'), fetchTable('accounts'),
  ]);
  return {
    students: students.map(r => fromRow('students', r)),
    payments: payments.map(r => fromRow('payments', r)),
    attendance: attendance.map(r => fromRow('attendance', r)),
    creditUsages: creditUsages.map(r => fromRow('creditUsages', r)),
    accounts: accounts.map(r => fromRow('accounts', r)),
  };
}
// `bypassCache` (2026-08-19): when true, skips the cache READ and goes straight to Supabase, but
// still writes the fresh result back to the cache afterward (so normal cache-first callers still
// benefit). Added specifically for the whole-database save's pre-push "pull fresh and merge" step
// (see index.html's _cloudSaveInner) — that step used to be a plain cache-first read, which meant a
// class/teacher/place/reward/setting edited DIRECTLY in the Supabase Table Editor (bypassing this
// API entirely, so nothing ever called invalidateConfigCache() for it) could sit correctly in
// Postgres while this cache still held the pre-edit snapshot for up to CONFIG_CACHE_TTL_S (1h). Any
// save that ran during that window would merge against the STALE cached copy and treat the field as
// "unchanged", which pushes that stale (pre-edit) value right back over the real one in Postgres —
// silently reverting a hand-edit for real, not just delaying its display (see item 13's caveat,
// which flagged the display-delay risk but not this stronger case: the edit gets overwritten, not
// just slow to show). Bypassing the cache for exactly this one read closes that permanently, at the
// cost of one extra small Supabase read (5 lightweight config tables) per save instead of a cache
// hit — deliberately NOT applied to getDataGroup(), since students/payments/etc already refresh
// every 20s regardless and are far more expensive tables to read uncached on every single save.
async function getConfigGroup(bypassCache) {
  if (!bypassCache) {
    const cached = await configCacheGetRaw();
    if (cached) { try { return JSON.parse(cached); } catch (e) { /* fall through to a fresh read */ } }
  }
  // Race guard (2026-08-20, found chasing "I just set a class's difficulty, signed out, signed back
  // in, and it's gone again" — a repro fast enough that a stale browser tab couldn't explain it).
  // Without this, two concurrent requests could interleave as: (1) this request starts reading
  // Supabase for its own cache-miss/bypass fetch, (2) meanwhile someone else's save writes the real
  // change to Postgres and calls invalidateConfigCache(), (3) this request's fetch finishes — with
  // data from BEFORE step 2 — and unconditionally SETEXes it into the cache, silently resurrecting
  // the stale pre-save snapshot for up to another CONFIG_CACHE_TTL_S. A busy front desk with several
  // devices polling every 45s makes this a real, not theoretical, race. Fix: snapshot the invalidation
  // generation before fetching, and only write the result back if nothing invalidated us while our
  // fetch was in flight. If the generation moved (or can't be read at all — stay conservative), skip
  // the write-back; the next reader just does one more real Supabase fetch instead of trusting a
  // cache we can no longer vouch for.
  let genBefore = null;
  try { genBefore = await redisCmd(['GET', CONFIG_GEN_KEY]); } catch (e) { /* unknown — stays null, guard below skips the write */ }
  const fresh = await fetchConfigGroup();
  try {
    if (genBefore !== null) {
      const genAfter = await redisCmd(['GET', CONFIG_GEN_KEY]);
      if (genAfter === genBefore) await configCacheSetRaw(JSON.stringify(fresh)); // nothing invalidated us mid-flight — safe to cache
    }
  } catch (e) { /* best-effort — a failed check just means we skip caching this round, not a hard failure */ }
  return fresh;
}
async function getDataGroup() {
  const cached = await dataCacheGetRaw();
  if (cached) { try { return JSON.parse(cached); } catch (e) { /* fall through to a fresh read */ } }
  // Same race guard as getConfigGroup() above, mirrored for the DATA cache — see DATA_GEN_KEY's
  // comment for what this closes. Snapshot the invalidation generation before fetching Supabase, and
  // only write the result back to the cache if nothing invalidated us while the fetch was in flight.
  let genBefore = null;
  try { genBefore = await redisCmd(['GET', DATA_GEN_KEY]); } catch (e) { /* unknown — stays null, guard below skips the write */ }
  const fresh = await fetchDataGroup();
  try {
    if (genBefore !== null) {
      const genAfter = await redisCmd(['GET', DATA_GEN_KEY]);
      if (genAfter === genBefore) await dataCacheSetRaw(JSON.stringify(fresh)); // nothing invalidated us mid-flight — safe to cache
    }
  } catch (e) { /* best-effort — a failed check just means we skip caching this round, not a hard failure */ }
  return fresh;
}
// Reads every table and assembles exactly the { db, nid } shape the browser has always received —
// this is the one place that stands in for the old "SELECT data FROM app_state" single-row read.
// The two groups are fetched (from cache or Supabase, independently) in parallel — a DATA cache miss
// never waits on a CONFIG read or vice versa. `bypassConfigCache` forwards to getConfigGroup() — see
// its comment above.
async function assembleDb(bypassConfigCache) {
  const [config, data] = await Promise.all([getConfigGroup(bypassConfigCache), getDataGroup()]);
  const db = { ...config, ...data };
  // `nid` is kept only for backward-compat display / as a floor sent back up via claim-ids's p_min —
  // the real source of truth for "next id" is now each table's own identity sequence.
  const maxId = arr => (arr || []).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
  const nid = {
    teachers: maxId(db.teachers) + 1, classes: maxId(db.classes) + 1, students: maxId(db.students) + 1,
    payments: maxId(db.payments) + 1, attendance: maxId(db.attendance) + 1, creditUsages: maxId(db.creditUsages) + 1,
  };
  return { db, nid };
}
// Upserts every row in `rows` into `entity`'s table (keyed on `conflictKey`), then deletes any row
// that's on the server but missing from `rows` — replicating the old "the array you send is the
// complete truth for this table" rule, now against a real table instead of one JSON field. The
// to-delete set is computed as a difference in JS (not a giant SQL "not.in.(...)" over every kept
// id) so the DELETE request stays small — normally 0 or 1 ids — instead of listing hundreds of ids
// in a query string on every single save.
async function upsertReconcile(entity, rows, conflictKey, opts) {
  const table = TABLE_NAME[entity];
  // Never prune off an empty array — a genuine "delete every row in this table" is not a real
  // action anywhere in this app, so an empty incoming array is treated as an incomplete/defensive
  // payload rather than an instruction to wipe the table.
  if (!rows || !rows.length) return;
  const sourceRows = (opts && opts.protectExisting) ? await fillFromExisting(entity, rows, conflictKey) : rows;
  const dbRows = sourceRows.map(o => toRowFull(entity, o));

  // The upsert (adds/updates only rows in dbRows) and the existing-ids read (used only to find rows
  // to prune) don't depend on each other's result — the upsert can never touch a row outside dbRows,
  // so "what ids currently exist" is accurate to read before, during, or after it. Running them
  // concurrently instead of sequentially roughly halves this table's contribution to save latency,
  // which matters more now that saveWholeDb() fires several tables per save (see there) — a slow
  // save was the main driver of the 500s some saves were hitting under any Supabase latency spike.
  const [upsertRes, existingIds] = await Promise.all([
    rest(table + '?on_conflict=' + conflictKey, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(dbRows),
    }),
    fetchAllColumn(table, conflictKey),
  ]);
  if (!upsertRes.ok) throw new Error(entity + ': ' + (await upsertRes.text().catch(() => '')));

  const keepSet = new Set(dbRows.map(r => r[conflictKey]));
  const toDelete = existingIds.filter(id => !keepSet.has(id));
  if (toDelete.length) {
    const list = toDelete.map(v => typeof v === 'string' ? '"' + String(v).replace(/"/g, '\\"') + '"' : v).join(',');
    const dr = await rest(table + '?' + conflictKey + '=in.(' + list + ')', {
      method: 'DELETE', headers: { Prefer: 'return=minimal' },
    });
    if (!dr.ok) throw new Error(entity + ' prune: ' + (await dr.text().catch(() => '')));
  }
}
// `accounts` is the one table whose `id` is a native Postgres identity column that the browser side
// never assigns itself — new logins are minted by createStudentLogin()/createTeacherLogin() in
// index.html with no `id` at all (only `user`, the natural/login key). Every whole-database save
// resends the COMPLETE accounts list (all ~250 rows), including an unconditional background sync
// every 4 seconds — so the generic upsertReconcile() above, which uses toRowFull() to force every
// missing field to an explicit `null` (so every row in one PostgREST bulk-insert batch has identical
// keys), would send `"id": null` for every account whose id this particular browser tab doesn't know.
// Postgres evaluates the identity column's DEFAULT for a row BEFORE it checks ON CONFLICT, so that
// happens for every single row on every single save regardless of whether anything actually changed —
// silently burning that many values off accounts_id_seq each time. That's why a brand-new account's
// own id was jumping into the thousands within a day (e.g. 14143) even though there are only ~250 real
// accounts: the counter was tracking save cycles, not accounts. (The `ref` column — the actual link to
// the student's own id — was never affected; it's supplied explicitly on every save, just like this
// fix now does for accounts' own `id`.)
//
// Fix: split the batch. Rows that already know their real id (round-tripped from a prior GET, now that
// FIELD_MAPS.accounts includes `id`) send it explicitly, so Postgres never touches the identity default
// for them — an update, not a fresh nextval(). Only rows that have never been assigned one (created
// this session, not yet round-tripped) omit the `id` key entirely and let the identity default do its
// job — exactly one sequence value consumed per genuine new account. A newly-created account keeps
// omitting `id` on its own subsequent saves until this tab's next full GET/refresh brings the real id
// back down (periodic ~45s poll, or the next manual refresh) — a small, self-healing window, not the
// unbounded growth this replaces.
function toAccountRow(obj) {
  const map = FIELD_MAPS.accounts;
  const known = new Set(map.map(m => m[0]));
  const row = {};
  map.forEach(([jsKey, dbCol]) => {
    if (jsKey === 'id') return; // handled below — must never be forced to an explicit null
    row[dbCol] = obj[jsKey] !== undefined ? obj[jsKey] : null;
  });
  const meta = {};
  Object.keys(obj || {}).forEach(k => { if (!known.has(k)) meta[k] = obj[k]; });
  row.meta = meta;
  const hasId = Number.isFinite(obj.id);
  if (hasId) row.id = obj.id;
  return { row, hasId };
}
async function upsertAccountsReconcile(rows) {
  const table = TABLE_NAME.accounts;
  if (!rows || !rows.length) return; // same "never prune an empty array" rule as upsertReconcile

  const withId = [], withoutId = [];
  rows.forEach(o => {
    const { row, hasId } = toAccountRow(o);
    (hasId ? withId : withoutId).push(row);
  });
  // Two separate bulk posts — PostgREST requires every object within ONE batch to share the same key
  // set, and that's exactly the split we want anyway (with-id rows never touch the identity default;
  // without-id rows always do, on purpose, for genuinely new accounts). Neither batch, nor the
  // existing-users read used for pruning below, depends on the others' result, so fire all of them
  // together instead of one after another.
  const puts = [withId, withoutId]
    .filter(batch => batch.length)
    .map(batch => rest(table + '?on_conflict=user', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(batch),
    }));
  const [putResults, existingUsers] = await Promise.all([Promise.all(puts), fetchAllColumn(table, 'user')]);
  for (const r of putResults) {
    if (!r.ok) throw new Error('accounts: ' + (await r.text().catch(() => '')));
  }

  const keepSet = new Set(rows.map(o => o.user));
  const toDelete = existingUsers.filter(u => !keepSet.has(u));
  if (toDelete.length) {
    const list = toDelete.map(v => '"' + String(v).replace(/"/g, '\\"') + '"').join(',');
    const dr = await rest(table + '?user=in.(' + list + ')', {
      method: 'DELETE', headers: { Prefer: 'return=minimal' },
    });
    if (!dr.ok) throw new Error('accounts prune: ' + (await dr.text().catch(() => '')));
  }
}
async function saveSettings(db) {
  const settings = {
    id: SETTINGS_ROW_ID,
    payment_info: db.paymentInfo || {},
    intro: db.intro || {},
    styles: db.styles || [],
    suppressed_student_refs: db.suppressedStudentRefs || [],
    suppressed_teacher_refs: db.suppressedTeacherRefs || [],
    updated_at: new Date().toISOString(),
  };
  const r = await rest('app_settings?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([settings]),
  });
  if (!r.ok) throw new Error('settings: ' + (await r.text().catch(() => '')));
}
// Stands in for the old "PUT the whole app_state row" — reconciles every table against the
// browser's merged snapshot. Grouped into stages so tables with no foreign-key relationship to each
// other save concurrently instead of one-at-a-time — a save used to be 9 sequential table round trips
// (18+ HTTP requests back to back), which is exactly the kind of thing that stacks up past a Supabase
// slow moment and turns one transient blip into a failed save. Ordering BETWEEN stages is still
// parent-before-child so foreign keys never trip:
//   1. places / teachers / rewards / settings — no FK relationship to anything, safe together.
//   2. classes — needs places + teachers to already exist.
//   3. students — needs places to already exist (kept after classes, matching the original safe
//      ordering, since student.classIds isn't confirmed FK-free against the classes table).
//   4. payments / attendance / creditUsages — each only references students/classes, never each other.
//   5. accounts — references students/teachers via `ref`, so it goes last.
async function saveWholeDb(db) {
  // places/teachers/classes/rewards are the low-churn CONFIG tables (see the CONFIG/DATA cache split
  // above) — cheap to fully re-read before every save, so they get protectExisting: true. That fills
  // any field missing from this device's in-memory copy of a record with whatever's already stored in
  // Postgres, instead of toRowFull()'s null/default placeholder — see the 2026-08-22 difficulty
  // incident and the 2026-09 sort_order incident for what happens otherwise. The high-churn DATA
  // tables (students/payments/attendance/creditUsages) don't get this — they already get a full GET
  // every ~4s regardless, and a full re-read before every save of the fastest-growing tables would be
  // a real latency cost for a class of bug that hasn't shown up there.
  await Promise.all([
    upsertReconcile('places', db.places, 'id', { protectExisting: true }),
    upsertReconcile('teachers', db.teachers, 'id', { protectExisting: true }),
    upsertReconcile('rewards', db.rewards, 'id', { protectExisting: true }),
    saveSettings(db),
  ]);
  await upsertReconcile('classes', db.classes, 'id', { protectExisting: true });
  await upsertReconcile('students', db.students, 'id');
  await Promise.all([
    upsertReconcile('payments', db.payments, 'id'),
    upsertReconcile('attendance', db.attendance, 'id'),
    upsertReconcile('creditUsages', db.creditUsages, 'id'),
  ]);
  await upsertAccountsReconcile(db.accounts);
}

// ── Session tokens ───────────────────────────────────────────────────
// Credentials are checked HERE, on the server, instead of in the browser. The caller gets back a
// short signed token describing who they are — never the account list.
const crypto = require('crypto');
const SESSION_HOURS = 12;
const secretKey = () => (process.env.SESSION_SECRET || '').trim() || KEY_ENV();
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', secretKey()).update(body).digest());
  return body + '.' + sig;
}
function readToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const expected = b64u(crypto.createHmac('sha256', secretKey()).update(parts[0]).digest());
  const a = Buffer.from(parts[1]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); }
  catch (e) { return null; }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}
// ── What an unauthenticated visitor is allowed to see ────────────────
function publicSlice(db) {
  const d = db && typeof db === 'object' ? db : {};
  const teachers = Array.isArray(d.teachers) ? d.teachers.map(t => ({
    id: t.id, name: t.name, photo: t.photo, specs: t.specs,
    quote: t.quote, instagram: t.instagram, xiaohongshu: t.xiaohongshu,
    video: t.video, status: t.status, color: t.color,
  })) : [];
  const classes = Array.isArray(d.classes) ? d.classes.map(c => ({
    id: c.id, name: c.name, style: c.style, day: c.day, start: c.start, end: c.end,
    placeId: c.placeId, teacherId: c.teacherId, room: c.room, max: c.max, level: c.level,
  })) : [];
  return {
    intro: d.intro || {},
    places: Array.isArray(d.places) ? d.places : [],
    teachers,
    classes,
  };
}
function bearerToken(req) {
  const raw = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1] : '';
}
function sameSecret(a, b) {
  const x = Buffer.from(String(a == null ? '' : a));
  const y = Buffer.from(String(b == null ? '' : b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
  // This endpoint is the live database, not a static asset — its content changes every time
  // anyone saves (a new teacher photo, a new student, a payment). With no Cache-Control at all,
  // browsers and any CDN in front of this domain are free to cache a response and later serve it
  // back via a 304 revalidation instead of asking Supabase again — which is exactly how a teacher
  // photo (or any other edit) that's genuinely saved and correct in Supabase can still show as
  // missing/stale in a visitor's browser indefinitely, surviving even a hard refresh (hard-reload
  // only forces the page navigation to bypass cache, not fetch() calls the page's own JS makes
  // afterward). Explicitly forbidding storage/reuse here — on every response, success or error —
  // makes that class of "fixed in the database but still broken on the site" bug impossible.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const ok = (obj) => res.status(200).json(obj);
  const fail = (code, msg) => res.status(code).json({ error: String(msg) });

  try {
    if (req.method === 'OPTIONS') return res.status(204).end();

    if (req.method === 'GET' && req.query && req.query.health) {
      let bucket = 'unknown';
      if (URL_ENV() && KEY_ENV()) {
        try {
          const b = await fetchWithTimeout(apiBase() + '/storage/v1/bucket/' + BUCKET);
          bucket = b.ok ? 'ok' : (b.status === 404 ? 'missing — run supabase_setup.sql' : 'HTTP ' + b.status);
        } catch (e) { bucket = String((e && e.message) || e); }
      }
      let tables = 'unknown';
      if (URL_ENV() && KEY_ENV()) {
        try {
          const t = await rest('students?select=id&limit=1');
          tables = t.ok ? 'ok' : (t.status === 404 || t.status === 400 ? 'missing — run 001_schema.sql' : 'HTTP ' + t.status);
        } catch (e) { tables = String((e && e.message) || e); }
      }
      let cache = 'not configured — add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN';
      if (REDIS_URL() && REDIS_TOKEN()) {
        const probeKey = 'bdance:health-check:' + Date.now();
        try {
          const setResult = await redisCmd(['SET', probeKey, 'ok']);
          const getResult = await redisCmd(['GET', probeKey]);
          await redisCmd(['DEL', probeKey]);
          cache = (setResult === 'OK' && getResult === 'ok')
            ? 'connected'
            : 'configured but round-trip failed — check the URL/token are correct and unexpired';
        } catch (e) {
          cache = 'error: ' + String((e && e.message) || e);
        }
      }
      return ok({ ok: true, hasUrl: !!URL_ENV(), hasKey: !!KEY_ENV(), base: apiBase() || null, bucket, tables, cache,
        instagram: IG_TOKEN()
          ? ('configured (' + (IG_ID() ? 'facebook-login route' : 'instagram-login route') + ')')
          : 'not configured — add IG_TOKEN' });
    }

    if (!URL_ENV() || !KEY_ENV())
      return fail(500, 'Missing SUPABASE_URL or SUPABASE_KEY — add both in Vercel → Project → Settings → Environment Variables, then redeploy.');

    if (req.method === 'GET') {
      const reqType = req.query && (req.query.type === 'config' || req.query.type === 'data') ? req.query.type : null;
      const reader = readToken(bearerToken(req));

      // ── Partial fetch: ?type=config or ?type=data ───────────────────────────
      // Lets a caller ask for just one of the two cache groups (see the CONFIG/DATA split comment
      // near the cache constants above) instead of always assembling both. Added for index.html's
      // background 45s poll (setInterval in the boot code) — that poll runs for EVERY open tab,
      // including anonymous visitors just sitting on the public marketing/branch-picker page, who
      // can only ever end up using the CONFIG-derived publicSlice() anyway (no student/payment data
      // is ever shown to them) — so there's no reason that poll should also make this function
      // assemble the DATA group (students/payments/attendance/creditUsages/accounts) internally on
      // every single tick, even though the *response* to an anonymous caller has always discarded
      // that DATA content before sending it. Currently only the anonymous/public branch of
      // index.html's poll actually uses this — see that change for why the staff/signed-in branch
      // deliberately still requests the full snapshot (a partial *authenticated* response needs a
      // matching change in `_cloudLoadInner()`'s merge/lastSyncedDB-baseline logic that hasn't been
      // made yet; sending one without that change risks the exact "3-way merge thinks a table was
      // deleted" class of bug this app has already been hardened against elsewhere).
      if (reqType === 'config') {
        const config = await getConfigGroup();
        if (reader) return ok({ data: JSON.stringify({ db: config, nid: { teachers: 0, classes: 0 } }), scope: 'config' });
        // Unauthenticated + type=config: same publicSlice() trim, same 'public' scope, as the
        // unauthenticated default response below — index.html's existing scope==='public' handling
        // in _cloudLoadInner() already treats this as a partial, non-authoritative snapshot (it never
        // touches lastSyncedDB/lastCloudPush for it), so this needs no frontend changes to be safe.
        return ok({ data: JSON.stringify({ db: publicSlice(config), nid: {} }), scope: 'public' });
      }
      if (reqType === 'data') {
        // The DATA group is students/payments/attendance/creditUsages/accounts — always sensitive,
        // never served to an unauthenticated caller (same rule as the full snapshot below).
        if (!reader) return fail(401, 'Sign in again — your session has expired or is missing.');
        const data = await getDataGroup();
        const maxId = arr => (arr || []).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
        const nid = {
          students: maxId(data.students) + 1, payments: maxId(data.payments) + 1,
          attendance: maxId(data.attendance) + 1, creditUsages: maxId(data.creditUsages) + 1,
        };
        return ok({ data: JSON.stringify({ db: data, nid }), scope: 'data' });
      }

      // ── Default: full assembled snapshot ─────────────────────────────────────
      // assembleDb() itself is cache-aware now (CONFIG group at 1h TTL, DATA group at 20s TTL — see
      // the cache constants near the top of this file), so there's no separate whole-snapshot cache
      // wrapper here anymore. A GET that hits both groups warm is just as fast as the old single-key
      // cache was; a GET that only misses DATA (the common case — CONFIG rarely expires) now avoids
      // re-fetching CONFIG's 5 tables it didn't need to.
      // `?fresh=1` bypasses the CONFIG cache read (see getConfigGroup()'s comment) — used by
      // index.html's pre-save merge pull so a save can never merge against a stale cached config
      // snapshot and blindly write it back over a real edit made outside the app.
      const bypassConfigCache = !!(req.query && (req.query.fresh === '1' || req.query.fresh === 'true'));
      const assembled = await assembleDb(bypassConfigCache);
      if (reader) return ok({ data: JSON.stringify(assembled), scope: 'full' });
      return ok({
        data: JSON.stringify({ db: publicSlice(assembled.db), nid: {} }),
        scope: 'public',
      });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (body.action === 'mirror') return ok({ ok: true }); // no-op — real tables need no separate mirroring step

      if (body.action === 'login') {
        const user = String(body.user || '').trim();
        const pass = String(body.pass == null ? '' : body.pass);
        const wantRole = String(body.role || '').trim();
        if (!user || !pass) return fail(400, 'Missing username or password');
        let q = 'accounts?user=eq.' + encodeURIComponent(user) + '&select=*';
        if (wantRole) q += '&role=eq.' + encodeURIComponent(wantRole);
        const r = await rest(q);
        if (!r.ok) return res.status(r.status).send(await r.text());
        const rows = await r.json();
        const acc = rows.find(a => sameSecret(a.pass, pass));
        if (!acc) return ok({ ok: false, error: 'Invalid username or password' });
        const payload = { u: acc.user, r: acc.role, ref: acc.ref == null ? null : acc.ref,
                          placeId: acc.place_id == null ? null : acc.place_id,
                          exp: Date.now() + SESSION_HOURS * 3600 * 1000 };
        return ok({ ok: true, token: signToken(payload), account: {
          user: acc.user, role: acc.role, ref: acc.ref == null ? null : acc.ref,
          placeId: acc.place_id == null ? null : acc.place_id, name: acc.name || '',
        } });
      }
      if (body.action === 'session') {
        const payload = readToken(body.token);
        return ok({ ok: !!payload, account: payload ? {
          user: payload.u, role: payload.r, ref: payload.ref, placeId: payload.placeId,
        } : null });
      }

      if (body.action === 'update-student') {
        const idNum = Number(body.id);
        if (!Number.isFinite(idNum)) return fail(400, 'Missing or bad student id');
        const who = readToken(bearerToken(req));
        if (!who) return fail(401, 'Sign in again — your session has expired or is missing.');
        const isStaff = ['admin', 'counter', 'teacher'].includes(String(who.r));
        if (!isStaff && Number(who.ref) !== idNum) return fail(403, 'You can only update your own record.');
        const patch = (body.patch && typeof body.patch === 'object') ? body.patch : {};

        // Fetch the current `meta` first so unrecognized fields in the patch MERGE into it instead
        // of replacing the whole jsonb column — otherwise a patch touching only one unmapped field
        // would silently blank out every other unmapped field already stored there.
        const cur = await rest('students?id=eq.' + idNum + '&select=meta');
        if (!cur.ok) return fail(cur.status, await cur.text());
        const curRows = await cur.json();
        if (!curRows.length) return fail(404, 'That student no longer exists.');
        const row = toRow('students', patch);
        if (row.meta) row.meta = { ...(curRows[0].meta || {}), ...row.meta };
        row.updated_at = new Date().toISOString();

        const r = await rest('students?id=eq.' + idNum, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(row),
        });
        if (!r.ok) return fail(r.status, await r.text());
        await invalidateDataCache(); // students live in the DATA group — no need to touch CONFIG's 1h cache
        return ok({ ok: true });
      }

      // A teacher patching their OWN public-profile fields (photo/instagram/xiaohongshu/video/quote)
      // from the mobile app. Added 2026-08-23 to replace bdsmobile's old saveTeacherProfile(), which
      // used the shared fetch-whole-db → splice in my fields → push-whole-db-back pattern (see
      // saveWholeDb()/fetchFreshDb() in bdsmobile/index.html) with NO merge against what changed on
      // the server in between — that pattern's own code comment already admitted the risk ("could be
      // overwritten... fine for an occasional action"). Concretely, it meant any teacher hitting Save
      // on their phone could silently push back a stale snapshot of teachers (or any other config/data
      // table it happened to fetch) over a genuinely newer edit made elsewhere in that same window —
      // e.g. an admin's "Arrange Order" teacher reordering on desktop, reverted by a teacher's routine
      // profile save on their phone shortly after. A scoped single-row PATCH, mirroring
      // 'update-student' above, makes that impossible: this can only ever touch the 5 listed columns
      // on ONE teacher row, never any other teacher, table, or field.
      // All 5 fields are real mapped columns on `teachers` (see FIELD_MAPS), not `meta` — so unlike
      // update-student/update-payment-receipt this needs no meta pre-fetch/merge, a plain PATCH is safe.
      if (body.action === 'update-teacher-profile') {
        const idNum = Number(body.id);
        if (!Number.isFinite(idNum)) return fail(400, 'Missing or bad teacher id');
        const who = readToken(bearerToken(req));
        if (!who) return fail(401, 'Sign in again — your session has expired or is missing.');
        const isStaff = ['admin', 'counter'].includes(String(who.r));
        // A teacher may only patch their OWN profile via this action — admin/counter may patch any
        // teacher's profile fields through it too (handy for front-desk fixing a photo on someone's
        // behalf), but this deliberately does NOT open up name/phone/email/specs/status — those still
        // only go through the desktop Add/Edit Teacher screen's full merge-protected whole-DB save.
        if (!isStaff && !(String(who.r) === 'teacher' && Number(who.ref) === idNum)) {
          return fail(403, 'You can only update your own profile.');
        }
        const ALLOWED = ['photo', 'instagram', 'xiaohongshu', 'video', 'quote'];
        const rawPatch = (body.patch && typeof body.patch === 'object') ? body.patch : {};
        const patch = {};
        ALLOWED.forEach(k => { if (Object.prototype.hasOwnProperty.call(rawPatch, k)) patch[k] = rawPatch[k]; });
        if (!Object.keys(patch).length) return fail(400, 'Nothing to update.');

        const row = toRow('teachers', patch);
        const r = await rest('teachers?id=eq.' + idNum, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(row),
        });
        if (!r.ok) return fail(r.status, await r.text());
        await invalidateConfigCache(); // teachers live in the CONFIG group
        return ok({ ok: true });
      }

      // Adds or updates ONE class row. Added 2026-08-23, same reason as 'update-teacher-profile'
      // above: bdsmobile's saveClassNow() used to fetch the whole database, splice one class into
      // `db.classes` locally, and push the WHOLE database back with no merge — so creating or editing
      // ANY one class could silently drag every OTHER class (difficulty included — this table has
      // already had a studio-wide difficulty-reverting incident, see the CONFIG_CACHE_TTL_S comment
      // near the top of this file) back to whatever stale snapshot that particular save happened to
      // fetch. This action only ever writes the ONE class row being created/edited.
      // The room/teacher clash check is re-done here against a FRESH read of the classes table
      // (never the CONFIG cache, never whatever the client last saw) — the whole point of moving this
      // server-side is that two staff members creating/editing classes around the same time can't
      // both pass a check against data that's already stale the moment either of them writes.
      if (body.action === 'save-class') {
        const who = readToken(bearerToken(req));
        if (!who) return fail(401, 'Sign in again — your session has expired or is missing.');
        if (!['admin', 'counter', 'teacher'].includes(String(who.r))) return fail(403, 'Only staff can manage classes.');
        const v = (body.vals && typeof body.vals === 'object') ? body.vals : {};
        const editId = body.id != null ? Number(body.id) : null;
        if (body.id != null && !Number.isFinite(editId)) return fail(400, 'Bad class id');
        const name = String(v.name || '').trim();
        if (!name) return fail(400, 'Missing class name');
        const day = String(v.day || '');
        const toMin = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? (Number(m[1]) * 60 + Number(m[2])) : null; };
        const sMin = toMin(v.start), eMin = toMin(v.end);
        if (sMin == null || eMin == null) return fail(400, 'Missing or bad start/end time');
        if (eMin <= sMin) return fail(400, 'End time must be after start time');
        const placeId = Number(v.placeId), teacherId = Number(v.teacherId);
        if (!Number.isFinite(placeId)) return fail(400, 'Missing place');
        if (!Number.isFinite(teacherId)) return fail(400, 'Missing teacher');
        const room = String(v.room || 'Big Room');

        const rows = await fetchTable('classes');
        const mapped = rows.map(r => classFromRow(r));
        const others = mapped.filter(c => editId == null || c.id !== editId);
        // The class row being edited (undefined when creating a new one) — used below so a falsy/
        // missing `difficulty` in the incoming payload falls back to whatever's already stored instead
        // of silently nulling it out. A caller only means to clear difficulty by sending 'All Levels'
        // explicitly (a real, truthy string); it should never be able to do so by omission.
        const existingCls = editId != null ? mapped.find(c => c.id === editId) : null;
        const overlaps = c => {
          const cs = toMin(c.start), ce = toMin(c.end);
          return c.day === day && cs != null && ce != null && sMin < ce && cs < eMin;
        };
        // 409s carry a machine-readable `conflict` alongside the plain-English `error`, so the client
        // can still show its own localized/translated clash message (it already has one) instead of
        // this raw English string, while server logs and any non-mobile caller still get something
        // readable without needing to know the `conflict` shape.
        const roomClash = others.find(c => overlaps(c) && Number(c.placeId) === placeId && String(c.room || '').trim().toLowerCase() === room.trim().toLowerCase());
        if (roomClash) return res.status(409).json({ error: 'Room clash with "' + roomClash.name + '"', conflict: { type: 'room', room: roomClash.room, name: roomClash.name } });
        const teacherClash = others.find(c => overlaps(c) && Number(c.teacherId) === teacherId);
        if (teacherClash) return res.status(409).json({ error: 'Teacher clash with "' + teacherClash.name + '"', conflict: { type: 'teacher', name: teacherClash.name } });

        // Was `v.difficulty || null` — nulled the column on ANY save (even one that has nothing to do
        // with difficulty, e.g. just moving a class to a different room) whenever the incoming payload's
        // difficulty happened to be falsy. Both current clients (admin's readSelectSafe()/setSelectValueSafe()
        // in index.html, mobile's classForm seeding in bdsmobile) already guard against sending a falsy
        // value, but this was still the one place a bug in either client — or any future caller of this
        // action — could silently wipe a class's difficulty. Now: an edit with a real (truthy) difficulty
        // in the payload uses it; an edit that omits/blanks it keeps whatever's already stored instead of
        // clearing it; only a brand-new class with no prior row falls back to null.
        const fallbackDifficulty = existingCls ? existingCls.difficulty : null;
        const vals = {
          name, style: v.style || '',
          difficulty: (v.difficulty != null && v.difficulty !== '') ? v.difficulty : fallbackDifficulty,
          placeId, teacherId, day, room,
          start: v.start, end: v.end, max: (Number.isFinite(Number(v.max)) && Number(v.max) > 0) ? Number(v.max) : 15,
        };
        let idOut = editId;
        if (editId != null) {
          const row = toRow('classes', vals);
          const r = await rest('classes?id=eq.' + editId, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
          if (!r.ok) return fail(r.status, await r.text());
        } else {
          // Same race-safe id allocator 'claim-ids' uses (claim_next_id RPC) — never a client-computed
          // "max id + 1", which two people creating a class within the same fetch window could collide on.
          const idR = await rest('rpc/claim_next_id', { method: 'POST', body: JSON.stringify({ p_name: 'classes', p_min: 0 }) });
          if (!idR.ok) return fail(idR.status, await idR.text());
          const newId = await idR.json().catch(() => null);
          if (typeof newId !== 'number') return fail(502, 'Could not allocate a class id');
          idOut = newId;
          const row = toRow('classes', { id: newId, ...vals });
          const r = await rest('classes', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
          if (!r.ok) return fail(r.status, await r.text());
        }
        await invalidateConfigCache(); // classes live in the CONFIG group
        return ok({ ok: true, id: idOut });
      }

      // Deletes ONE class row. Added 2026-08-23 alongside 'save-class', same reasoning — replaces
      // bdsmobile's deleteClassNow(), which filtered one class out of the whole classes array locally
      // and pushed the WHOLE database back.
      if (body.action === 'delete-class') {
        const who = readToken(bearerToken(req));
        if (!who) return fail(401, 'Sign in again — your session has expired or is missing.');
        if (!['admin', 'counter', 'teacher'].includes(String(who.r))) return fail(403, 'Only staff can manage classes.');
        const idNum = Number(body.id);
        if (!Number.isFinite(idNum)) return fail(400, 'Missing or bad class id');
        const r = await rest('classes?id=eq.' + idNum, { method: 'DELETE' });
        if (!r.ok) return fail(r.status, await r.text());
        await invalidateConfigCache(); // classes live in the CONFIG group
        return ok({ ok: true });
      }

      // Adds or removes ONE class from ONE student's enrollment. Added 2026-08-23 alongside
      // 'save-class'/'delete-class' — replaces bdsmobile's toggleEnrollmentNow(), which fetched the
      // whole database, spliced this one student's classIds locally, and pushed the whole thing back.
      // Reads this student's CURRENT classIds fresh (never a client-supplied copy) immediately before
      // writing, so the add/remove toggle is computed from real data, then patches only that one
      // student's own classIds column — every other student, and every other table, is untouched.
      //
      // 2026-08-25: this only ever patched class_ids — it never recomputed the student's monthly `fee`
      // or created/cancelled the Unpaid class-fee bill that index.html's own toggleEnrollment() always
      // does for the exact same action (same button, same 1-class-RM160/2+-classes-RM130-each rule).
      // Result: a counter adding a 2nd (or 3rd+) monthly class to a student via this endpoint — i.e.
      // from the mobile app, which is all this endpoint is used by — silently never billed the new
      // class at all, and the student's `fee` stayed stuck at whatever it was before. Fixed by mirroring
      // toggleEnrollment()'s rate/fee/bill/cancel rules here exactly, so desktop and mobile can never
      // disagree on what a class-enrollment change bills: private classes are excluded from both the
      // tier count and billing (they're billed per-session, not monthly), a NEWLY added regular class
      // gets a fresh Unpaid bill at whatever rate now applies, and a REMOVED class's own Unpaid bill (if
      // any) is cancelled since it's no longer a real debt.
      if (body.action === 'toggle-class-enrollment') {
        const who = readToken(bearerToken(req));
        if (!who) return fail(401, 'Sign in again — your session has expired or is missing.');
        if (!['admin', 'counter', 'teacher'].includes(String(who.r))) return fail(403, 'Only staff can manage enrollment.');
        const studentId = Number(body.studentId), classId = Number(body.classId);
        if (!Number.isFinite(studentId) || !Number.isFinite(classId)) return fail(400, 'Missing or bad student/class id');
        const cur = await rest('students?id=eq.' + studentId + '&select=class_ids');
        if (!cur.ok) return fail(cur.status, await cur.text());
        const curRows = await cur.json();
        if (!curRows.length) return fail(404, 'That student no longer exists.');
        const classIds = Array.isArray(curRows[0].class_ids) ? curRows[0].class_ids.slice() : [];
        const at = classIds.indexOf(classId);
        const added = at === -1;
        if (added) classIds.push(classId); else classIds.splice(at, 1);

        // Same 1-class-RM160 / 2+-classes-RM130-each tiers as index.html's calcMonthlyFee(), and the
        // same private-class exclusion as its classRateFor() — fetched fresh (not trusted from the
        // request) so a difficulty change made moments ago is never missed.
        const clsRows = classIds.length
          ? await rest('classes?id=in.(' + classIds.join(',') + ')&select=id,name,difficulty')
          : null;
        if (clsRows && !clsRows.ok) return fail(clsRows.status, await clsRows.text());
        const clsList = clsRows ? await clsRows.json() : [];
        const clsById = new Map(clsList.map(c => [Number(c.id), c]));
        const regularCount = classIds.filter(id => (clsById.get(Number(id)) || {}).difficulty !== 'Private').length;
        const newFee = regularCount === 0 ? 0 : regularCount === 1 ? 160 : regularCount * 130;

        const r = await rest('students?id=eq.' + studentId, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ class_ids: classIds, fee: newFee }),
        });
        if (!r.ok) return fail(r.status, await r.text());

        let createdPayment = null, cancelledPaymentIds = [];
        if (added) {
          const toggledCls = clsById.get(classId);
          if (toggledCls && toggledCls.difficulty !== 'Private') {
            const rate = regularCount <= 1 ? 160 : 130;
            const idR = await rest('rpc/claim_next_id', { method: 'POST', body: JSON.stringify({ p_name: 'payments', p_min: 0 }) });
            if (!idR.ok) return fail(idR.status, await idR.text());
            const pid = await idR.json().catch(() => null);
            if (typeof pid !== 'number') return fail(502, 'Could not allocate a payment id');
            // Server runs in UTC — shift by the studio's own UTC+8 so "today"/"this month" match the
            // counter's real clock, not the server's, right around midnight either side of that offset.
            const localNow = new Date(Date.now() + 8 * 3600 * 1000);
            const month = localNow.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
            const earnedDate = localNow.toISOString().slice(0, 10);
            createdPayment = {
              id: pid, studentId, classId, kind: 'class', month, amount: rate, status: 'Unpaid',
              date: '', method: '', notes: `New class fee for ${toggledCls.name} — must be paid before joining`,
              earnedDate,
            };
            const pr = await rest('payments', {
              method: 'POST', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify(toRow('payments', createdPayment)),
            });
            if (!pr.ok) return fail(pr.status, await pr.text());
          }
        } else {
          // Mirrors index.html's toggleEnrollment(): an Unpaid bill for a class she's no longer on
          // isn't a real debt — cancel it rather than leave it stranded on that teacher's roster.
          const sel = await rest('payments?student_id=eq.' + studentId + '&class_id=eq.' + classId + '&status=eq.Unpaid&select=id');
          if (!sel.ok) return fail(sel.status, await sel.text());
          const toCancel = (await sel.json()).map(row => row.id);
          if (toCancel.length) {
            const dr = await rest('payments?id=in.(' + toCancel.join(',') + ')', { method: 'DELETE' });
            if (!dr.ok) return fail(dr.status, await dr.text());
            cancelledPaymentIds = toCancel;
          }
        }

        await invalidateDataCache(); // students AND payments both live in the DATA group
        return ok({ ok: true, added, fee: newFee, payment: createdPayment, cancelledPaymentIds });
      }

      // A student attaching a bank-transfer receipt photo to ONE SPECIFIC bill (payments row), so the
      // counter can review it against that exact bill instead of a generic per-student pile. Mirrors
      // 'update-student' above (self-patch, merges into the row's `meta` jsonb — payments has no
      // dedicated receipt columns, so receiptUrl/receiptUploadedAt/receiptStatus all ride along in
      // meta via toRow()'s normal "unmapped key" behaviour), but is deliberately much more locked down
      // on WHICH fields a student is allowed to touch: a student can attach/replace their own receipt
      // proof, but can never use this endpoint to change amount/status/method/etc — only staff
      // (counter/admin/teacher) may additionally set receiptStatus, to mark a receipt reviewed.
      if (body.action === 'update-payment-receipt') {
        const idNum = Number(body.id);
        if (!Number.isFinite(idNum)) return fail(400, 'Missing or bad payment id');
        const who = readToken(bearerToken(req));
        if (!who) return fail(401, 'Sign in again — your session has expired or is missing.');
        const isStaff = ['admin', 'counter', 'teacher'].includes(String(who.r));
        const patch = (body.patch && typeof body.patch === 'object') ? body.patch : {};
        const allowed = new Set(isStaff
          ? ['receiptUrl', 'receiptUploadedAt', 'receiptStatus']
          : ['receiptUrl', 'receiptUploadedAt']);
        const safePatch = {};
        Object.keys(patch).forEach(k => { if (allowed.has(k)) safePatch[k] = patch[k]; });
        if (!Object.keys(safePatch).length) return fail(400, 'Nothing to update');

        const cur = await rest('payments?id=eq.' + idNum + '&select=student_id,meta');
        if (!cur.ok) return fail(cur.status, await cur.text());
        const curRows = await cur.json();
        if (!curRows.length) return fail(404, 'That bill no longer exists.');
        if (!isStaff && Number(who.ref) !== Number(curRows[0].student_id))
          return fail(403, 'You can only attach a receipt to your own bill.');

        // A fresh upload always resets review status back to pending, even if staff had previously
        // marked an older receipt on this same bill as reviewed — a NEW photo needs a fresh look.
        if (!isStaff && safePatch.receiptUrl) safePatch.receiptStatus = 'pending';

        const row = toRow('payments', safePatch);
        row.meta = { ...(curRows[0].meta || {}), ...(row.meta || {}) };
        const r = await rest('payments?id=eq.' + idNum, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(row),
        });
        if (!r.ok) return fail(r.status, await r.text());
        await invalidateDataCache(); // payments live in the DATA group — no need to touch CONFIG's 1h cache
        return ok({ ok: true });
      }

      // ── Atomic id issuance — stops two branch counters colliding on the same id ──
      // claim_next_id() now pulls straight from each real table's own Postgres identity sequence
      // (e.g. students_id_seq) instead of a hand-rolled counter table — nextval() on a sequence is
      // itself atomic under concurrency, so two simultaneous claims are guaranteed two different
      // numbers, and the number handed out here is drawn from the exact same sequence that a
      // matching INSERT into that table would use. See the updated claim_next_id() SQL.
      if (body.action === 'claim-ids') {
        const claimer = readToken(bearerToken(req));
        if (!claimer) return fail(401, 'Sign in again — your session has expired or is missing.');
        if (!['admin', 'counter', 'teacher'].includes(String(claimer.r))) return fail(403, 'This account is not allowed to create records.');
        const names = Array.isArray(body.names) ? body.names.map(n => String(n || '').trim()).filter(Boolean) : [];
        if (!names.length) return fail(400, 'Missing names');
        const mins = (body.mins && typeof body.mins === 'object') ? body.mins : {};
        const ids = {};
        for (const name of names) {
          // 'student_login_id' (the 6-digit number, e.g. 600234, shown on the QR/login screen — NOT
          // the internal student record id) goes through a SEPARATE function, claim_student_login_id().
          // Unlike every other name here, which is deliberately monotonic (drawn straight from a real
          // table's own never-reused identity sequence, so two branches can never collide on an id),
          // this one is a number handed to an actual person, so a freed one (a student who left) gets
          // reused for the next new student instead of leaving a permanent gap. See
          // 004_claim_student_login_id.sql — it's additive and atomic (advisory-locked) in its own
          // right; it doesn't touch claim_next_id() or any of the ids that function still manages.
          const isLoginId = name === 'student_login_id';
          const pMin = Number(mins[name]) || 0;
          const r = await rest(isLoginId ? 'rpc/claim_student_login_id' : 'rpc/claim_next_id', {
            method: 'POST',
            body: isLoginId ? '{}' : JSON.stringify({ p_name: name, p_min: pMin }),
          });
          if (!r.ok) {
            const t = await r.text().catch(() => '');
            if (r.status === 404 || /function .* does not exist/i.test(t))
              return fail(404, isLoginId
                ? 'claim_student_login_id is not set up in Supabase yet — run 004_claim_student_login_id.sql.'
                : 'claim_next_id is not set up in Supabase yet — run the updated claim_next_id() SQL.');
            return fail(r.status, t || ('HTTP ' + r.status));
          }
          const v = await r.json().catch(() => null);
          if (typeof v !== 'number') return fail(502, 'Supabase did not return a usable id for "' + name + '"');
          ids[name] = v;
        }
        return ok({ ok: true, ids });
      }

      if (body.action === 'ig-import') {
        if (!IG_TOKEN())
          return fail(400, 'Instagram import is not set up — add IG_TOKEN in Vercel → Project → Settings → Environment Variables, then redeploy.');
        const code = igShortcode(body.url);
        if (!code) return fail(400, 'That does not look like an Instagram reel link.');

        const FIELDS = 'fields=id,media_type,media_url,permalink&limit=100&access_token=';
        let next = IG_ID()
          ? (GRAPH + '/' + IG_ID() + '/media?' + FIELDS + encodeURIComponent(IG_TOKEN()))
          : (IG_GRAPH + '/me/media?' + FIELDS + encodeURIComponent(IG_TOKEN()));
        let hit = null;
        for (let page = 0; page < 4 && next && !hit; page++) {
          const r = await rawFetch(next);
          const j = await r.json().catch(() => ({}));
          if (!r.ok || j.error) {
            const m = (j.error && j.error.message) || ('HTTP ' + r.status);
            return fail(502, 'Instagram rejected the request: ' + m + ' — the token has probably expired (they last 60 days). Regenerate it in the Meta App Dashboard and update IG_TOKEN in Vercel.');
          }
          hit = (j.data || []).find((it) => igShortcode(it.permalink) === code) || null;
          next = (j.paging && j.paging.next) || null;
        }
        if (!hit)
          return fail(404, 'That reel is not on the studio’s Instagram account. The Graph API can only fetch media from the account the token belongs to — reels on a personal account cannot be imported.');
        if (!hit.media_url)
          return fail(422, 'Instagram returned no video file for that post (is it a photo?).');

        const dl = await rawFetch(hit.media_url, {}, 8000);
        if (!dl.ok) return fail(502, 'Could not download the video from Instagram (HTTP ' + dl.status + ')');
        const buf = Buffer.from(await dl.arrayBuffer());
        if (!buf.length) return fail(502, 'Instagram returned an empty video file');

        const path = Date.now().toString(36) + '-ig-' + code + '.mp4';
        const up = await rawFetch(apiBase() + '/storage/v1/object/' + BUCKET + '/' + path, {
          method: 'POST',
          headers: { apikey: KEY_ENV(), Authorization: 'Bearer ' + KEY_ENV(), 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
          body: buf,
        }, 20000);
        if (!up.ok) {
          const t = await up.text().catch(() => '');
          if (up.status === 404) return fail(404, 'Storage bucket "' + BUCKET + '" not found — run supabase_setup.sql.');
          return fail(up.status, t || ('HTTP ' + up.status));
        }
        return ok({
          publicUrl: apiBase() + '/storage/v1/object/public/' + BUCKET + '/' + path,
          bytes: buf.length,
        });
      }

      if (body.action === 'delete-object') {
        const path = String(body.path || '').replace(/^\/+/, '');
        if (!path || path.indexOf('..') !== -1) return fail(400, 'Bad object path');
        const r = await fetchWithTimeout(apiBase() + '/storage/v1/object/' + BUCKET + '/' + path, { method: 'DELETE' });
        if (!r.ok && r.status !== 404) {
          const t = await r.text().catch(() => '');
          return fail(r.status, t || ('HTTP ' + r.status));
        }
        return ok({ ok: true, deleted: path });
      }

      // ── One-off repair: restore teacher photos from teacher_photos_backup ──────────────
      // teacher_photos_backup (teacher_id, teacher_name, photo [base64 data URL], backed_up_at)
      // holds the pre-migration inline-base64 photos that were saved off before teachers.photo
      // was switched over to Supabase Storage URLs — but the follow-through step (upload each one
      // to Storage and write the resulting URL back onto teachers.photo) never happened, which is
      // why teachers.photo has sat empty since. This re-does that step: decode each backup row's
      // base64 image, upload it to the same 'media' bucket the normal photo-upload flow uses, and
      // PATCH the matching teachers row's photo column to the new public URL. Safe to run more than
      // once — 'x-upsert' lets a re-run overwrite its own prior upload rather than erroring.
      if (body.action === 'restore-teacher-photos-from-backup') {
        const writer = readToken(bearerToken(req));
        if (!writer) return fail(401, 'Sign in again — your session has expired or is missing.');
        if (!['admin', 'counter'].includes(String(writer.r))) return fail(403, 'Only an admin/counter account can run this repair.');

        const br = await rest('teacher_photos_backup?select=*');
        if (!br.ok) return fail(br.status, await br.text().catch(() => ''));
        const rows = await br.json();
        const results = [];
        for (const row of rows) {
          const teacherId = Number(row.teacher_id);
          const dataUrl = String(row.photo || '');
          const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
          if (!Number.isFinite(teacherId) || !m) {
            results.push({ teacherId: row.teacher_id, name: row.teacher_name, ok: false, error: 'no usable base64 photo in backup row' });
            continue;
          }
          const mime = m[1];
          const ext = (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
          const buf = Buffer.from(m[2], 'base64');
          const path = 'restored-teacher-' + teacherId + '.' + ext;
          try {
            const up = await rawFetch(apiBase() + '/storage/v1/object/' + BUCKET + '/' + path, {
              method: 'POST',
              headers: { apikey: KEY_ENV(), Authorization: 'Bearer ' + KEY_ENV(), 'Content-Type': mime, 'x-upsert': 'true' },
              body: buf,
            }, 20000);
            if (!up.ok) {
              const t = await up.text().catch(() => '');
              results.push({ teacherId, name: row.teacher_name, ok: false, error: 'upload failed: ' + (t || up.status) });
              continue;
            }
            const publicUrl = apiBase() + '/storage/v1/object/public/' + BUCKET + '/' + path;
            const pr = await rest('teachers?id=eq.' + teacherId, {
              method: 'PATCH',
              headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ photo: publicUrl }),
            });
            if (!pr.ok) {
              const t = await pr.text().catch(() => '');
              results.push({ teacherId, name: row.teacher_name, ok: false, error: 'teachers update failed: ' + (t || pr.status) });
              continue;
            }
            results.push({ teacherId, name: row.teacher_name, ok: true, publicUrl });
          } catch (e) {
            results.push({ teacherId, name: row.teacher_name, ok: false, error: String((e && e.message) || e) });
          }
        }
        await invalidateConfigCache(); // teachers live in the CONFIG group
        return ok({ ok: true, restored: results.filter(r => r.ok).length, total: rows.length, results });
      }

      // One-off repair (2026-08-19): older classes migrated before the "Difficulty" field existed
      // have difficulty=NULL in Postgres. The app already shows "All Levels" for those as a display
      // FALLBACK (see diffOf() in index.html), which looks fine on screen but leaves the real column
      // empty — and editing it straight in the Supabase Table Editor risks the stale-cache revert
      // described above getConfigGroup(). This does the equivalent of
      // `UPDATE classes SET difficulty='All Levels' WHERE difficulty IS NULL` through the same
      // PostgREST path every other write in this file uses (so it's covered by the usual
      // Prefer/return handling), then immediately invalidates the CONFIG cache so the fix is visible
      // everywhere right away instead of waiting up to CONFIG_CACHE_TTL_S. Only ever touches rows
      // that are genuinely NULL — never overwrites a class that already has a real difficulty
      // (including 'Private', which billing logic depends on).
      if (body.action === 'backfill-class-difficulty') {
        const writer = readToken(bearerToken(req));
        if (!writer) return fail(401, 'Sign in again — your session has expired or is missing.');
        if (String(writer.r) !== 'admin') return fail(403, 'Only an admin account can run this repair.');
        const pr = await rest('classes?difficulty=is.null', {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ difficulty: 'All Levels' }),
        });
        if (!pr.ok) return fail(pr.status, await pr.text().catch(() => ''));
        const updated = await pr.json().catch(() => []);
        await invalidateConfigCache(); // classes live in the CONFIG group
        return ok({ ok: true, updated: Array.isArray(updated) ? updated.length : null });
      }

      if (body.action === 'sign-upload') {
        const safe = String(body.name || 'file').toLowerCase()
          .replace(/[^a-z0-9.\-]+/g, '-').replace(/^-+|-+$/g, '').slice(-60) || 'file';
        const path = Date.now().toString(36) + '-' + safe;
        const r = await fetchWithTimeout(apiBase() + '/storage/v1/object/upload/sign/' + BUCKET + '/' + path, {
          method: 'POST',
          body: '{}',
        });
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          if (r.status === 404)
            return fail(404, 'Storage bucket "' + BUCKET + '" not found — run the media bucket section of supabase_setup.sql in your Supabase SQL Editor.');
          return fail(r.status, t || ('HTTP ' + r.status));
        }
        const j = await r.json();
        if (!j || !j.url) return fail(502, 'Supabase did not return a signed upload URL');
        return ok({
          uploadUrl: apiBase() + '/storage/v1' + j.url,
          publicUrl: apiBase() + '/storage/v1/object/public/' + BUCKET + '/' + path,
        });
      }

      // ── Whole-database save — staff only ─────────────────────────
      // Reconciles every real table against the browser's already-merged snapshot (see
      // saveWholeDb()/upsertReconcile() above) instead of overwriting one JSON row.
      // Students never come through here; they patch their own record via 'update-student' above.
      const writer = readToken(bearerToken(req));
      if (!writer) return fail(401, 'Sign in again to save — your session has expired or is missing.');
      if (!['admin', 'counter', 'teacher'].includes(String(writer.r))) return fail(403, 'This account is not allowed to save studio data.');

      const payload = typeof body.data === 'string' ? body.data : JSON.stringify(body.data || {});
      let obj; try { obj = JSON.parse(payload); } catch (e) { obj = {}; }
      if (!obj || !obj.db || typeof obj.db !== 'object' || !Object.keys(obj.db).length)
        return fail(400, 'Refusing to save an empty database.');
      if (!Array.isArray(obj.db.accounts) || obj.db.accounts.length === 0)
        return fail(400, 'Refused to save: no accounts in the payload — reload and sign in again before making changes.');

      try {
        await saveWholeDb(obj.db);
      } catch (e) {
        // Match GET's handling: a timeout is a Supabase-side slowness problem, not a bad save — say
        // so plainly instead of the generic "Save failed" wording, which previously made a transient
        // timeout look like a real data error.
        if (isAbortError(e))
          return fail(504, 'Supabase did not respond in time — check that SUPABASE_URL is correct and the project is not paused.');
        return fail(500, 'Save failed: ' + (e && e.message ? e.message : e));
      }
      // saveWholeDb() unconditionally reconciles every table (places/teachers/classes/rewards/
      // settings AND students/payments/attendance/creditUsages/accounts) on every call, whether or
      // not that particular table's data actually changed this time — so both cache groups must be
      // cleared, every time, to stay correct. Done immediately after the write succeeds, before
      // responding "ok" to the browser, so the next GET (this device's own confirm-pull, another
      // device's poll, or a fresh visitor) can never observe stale CONFIG or DATA.
      await invalidateAllCaches();
      return ok({ ok: true });
    }

    return fail(405, 'Method not allowed');
  } catch (e) {
    if (e && (e.name === 'AbortError' || String(e).includes('aborted')))
      return fail(504, 'Supabase did not respond in time — check that SUPABASE_URL is correct and the project is not paused.');
    return fail(500, e && e.message ? e.message : e);
  }
};
