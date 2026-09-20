// Maps the B Dance Studio admin database onto the shapes this landing page renders.
//
// Real contract (bds/api/db.js): an anonymous GET to /api/db?type=config returns
//   { data: JSON.stringify({ db: publicSlice(config), nid: {} }), scope: 'public' }
// so the studio tables live one JSON.parse deep, under `.db`. publicSlice() exposes
// exactly four keys — no student, payment or attendance data ever reaches this page:
//   places  {id, name, address}
//   teachers{id, name, photo, specs[], quote, instagram, xiaohongshu, video, status}
//   classes {id, name, style, day, start, end, placeId, teacherId, room, max, level}
//   intro   {events:[{badge,title,lead,date,time,venue,cats,regUrl,poster}], ...}
// Teachers arrive pre-sorted by the admin app's own arrange screen (sort_order), so
// array order is preserved rather than re-sorted here.

const STYLE_ZH = {
  'Hip-hop': '嘻哈', 'K-pop': '韩舞', 'Street Jazz': '街舞爵士', 'Popping': '机械舞',
  'Kid Dance': '儿童舞蹈', 'Waacking': '甩手舞', 'Dancehall': '雷鬼舞', 'Choreography': '编舞',
  'Locking': '锁舞', 'Breaking': '地板舞', 'Jazz Funk': '爵士放克', 'Urban': '都市舞',
  'Heels': '高跟舞', 'Contemporary': '现代舞', 'Ballet': '芭蕾', 'Zumba': '尊巴'
};
// Fallback bios, keyed off a teacher's first speciality — only used when the admin
// record has no `quote` of its own.
const BIO_EN = {
  'Hip-hop': 'Leads hip-hop training that starts with groove and musicality long before tricks.',
  'Popping': 'Popping specialist who breaks technique into drills you can practise at home.',
  'Street Jazz': 'Brings a street jazz background to sharpen performance quality for our crews.',
  'K-pop': 'Runs our K-pop cover track — clean formations, sharp counts, full stage energy.',
  'Kid Dance': 'Makes a first dance class fun and confidence-building.',
  'Dancehall': 'Teaches authentic dancehall foundations and musicality, not just viral moves.',
  'Waacking': 'Focuses on the arm technique and musicality waacking is built on.',
  'Choreography': 'Builds performance-ready routines for competition and showcase crews.'
};
const BIO_ZH = {
  'Hip-hop': '带领的嘻哈训练从律动与音乐性开始，而不是急着练招式。',
  'Popping': '机械舞专精导师，擅长把技巧拆解成可以在家练习的训练。',
  'Street Jazz': '以街舞爵士的底子打磨比赛团队的表演质感。',
  'K-pop': '负责韩舞翻跳路线——干净的队形、精准的拍点与十足的舞台能量。',
  'Kid Dance': '让孩子的第一堂舞蹈课既好玩又建立自信。',
  'Dancehall': '教的是正统雷鬼舞基础与音乐性，而不只是网络流行动作。',
  'Waacking': '专注于甩手舞赖以成立的手臂技巧与音乐性。',
  'Choreography': '为比赛与表演团队编排可直接上台的舞码。'
};
const NOTE_ZH = {
  'Hip-hop': '律动、基础，以及自由发挥的自信。', 'K-pop': '翻跳、队形与舞台排练。',
  'Street Jazz': '线条、力度与表演质感。', 'Popping': '顶点、波浪与肌肉控制训练。',
  'Kid Dance': '4 至 11 岁。先玩乐，再数拍。', 'Waacking': '手臂技巧、造型与音乐性。',
  'Dancehall': '节奏、弹动与正统基础。', 'Choreography': '需甄选的团队与比赛路线。'
};
const LEVEL_ZH = {
  'Beginner': '初级', 'Intermediate': '中级', 'Advanced': '进阶',
  'All Levels': '不限程度', 'Kids': '儿童', 'Open': '公开班'
};

const uniq = (a) => [...new Set(a.filter(Boolean))];
const zhList = (a) => a.join('、');

// Same URL shapes the admin app's own videoEmbedHTML() recognises (index.html) — a YouTube,
// Vimeo or Instagram link needs an iframe embed, everything else (a direct .mp4/.webm, or an
// Instagram reel already imported to a permanent Supabase file) plays in a plain <video>.
export function classifyVideoUrl(url) {
  url = (url || '').trim();
  if (!url) return null;
  let m;
  if ((m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{6,})/))) {
    return { kind: 'embed', embedUrl: 'https://www.youtube.com/embed/' + m[1] };
  }
  if ((m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/))) {
    return { kind: 'embed', embedUrl: 'https://player.vimeo.com/video/' + m[1] };
  }
  if ((m = url.match(/instagram\.com\/(reels?|p|tv)\/([A-Za-z0-9_-]+)/i))) {
    const type = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
    return { kind: 'embed', embedUrl: 'https://www.instagram.com/' + type + '/' + m[2] + '/embed' };
  }
  return { kind: 'file', fileUrl: url };
}

export async function fetchDb(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const sep = url.indexOf('?') > -1 ? '&' : '?';
    const res = await fetch(url + sep + 'type=config', {
      signal: ctrl.signal,
      headers: { accept: 'application/json' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const payload = await res.json();
    // The studio tables are a JSON string under `data`, wrapping { db, nid }.
    const inner = typeof payload.data === 'string' ? JSON.parse(payload.data) : payload.data;
    const db = (inner && inner.db) || inner || payload;
    if (!db || typeof db !== 'object') throw new Error('bad payload');
    return db;
  } finally {
    clearTimeout(timer);
  }
}

// Returns null when the payload has nothing worth showing, so the caller keeps its static copy.
export function mapDb(db) {
  const places = Array.isArray(db.places) ? db.places : [];
  const teachers = Array.isArray(db.teachers) ? db.teachers : [];
  const classes = Array.isArray(db.classes) ? db.classes : [];
  if (!teachers.length && !classes.length && !places.length) return null;

  const placeName = (id) => (places.find((p) => p.id === id) || {}).name || '';
  const publicClasses = classes.filter((c) => c.difficulty !== 'Private' && c.level !== 'Private');
  // The admin app marks instructors Active / On Leave / Inactive. Anything not
  // explicitly retired still shows, so a record with no status set isn't dropped.
  const activeTeachers = teachers.filter((t) => t.name && t.status !== 'Inactive');

  const roster = activeTeachers.map((t) => {
    const mine = publicClasses.filter((c) => c.teacherId === t.id);
    const specs = Array.isArray(t.specs) && t.specs.length
      ? t.specs
      : uniq(mine.map((c) => c.style));
    const spec = specs[0] || '';
    const levels = uniq(mine.map((c) => c.level || c.difficulty));
    const branches = uniq(mine.map((c) => placeName(c.placeId)));
    const days = uniq(mine.map((c) => c.day));
    const onLeave = t.status === 'On Leave';
    const specsZh = specs.map((s) => STYLE_ZH[s] || s);
    return {
      name: t.name,
      nameZh: t.name,
      photo: t.photo || '',
      video: t.video || '',
      instagram: t.instagram || '',
      xiaohongshu: t.xiaohongshu || '',
      onLeave: onLeave,
      spec: spec,
      specZh: STYLE_ZH[spec] || spec,
      specShort: spec,
      specs: specs,
      specsLabel: specs.join(' · '),
      specsLabelZh: zhList(specsZh),
      level: onLeave ? 'On leave' : (levels.join(' · ') || 'All levels'),
      levelZh: onLeave ? '休假中' : (zhList(levels.map((l) => LEVEL_ZH[l] || l)) || '不限程度'),
      classes: mine.length,
      places: branches.join(', ') || '—',
      placesZh: zhList(branches) || '—',
      days: days.join(', ') || '—',
      // A teacher's own quote from the admin app is their real bio. Left empty when they
      // have none — the landing page then shows its "new coming teacher" note rather than
      // inventing a biography for them.
      body: t.quote || '',
      bodyZh: t.quote || ''
    };
  });

  // Dance styles. `db.styles` is the studio's canonical list from the admin Styles screen —
  // authoritative name AND order, and it includes a style with no class scheduled yet.
  // publicSlice() currently withholds it from anonymous callers, so fall back to the distinct
  // styles found on the class list, ordered by how many classes run each week.
  const canon = Array.isArray(db.styles) ? db.styles.filter((s) => typeof s === 'string' && s.trim()) : [];
  const fromClasses = uniq(publicClasses.map((c) => c.style));
  const styleNames = canon.length
    ? uniq(canon.concat(fromClasses))
    : fromClasses.slice();

  let styles = styleNames.map((name) => {
    const mine = publicClasses.filter((c) => c.style === name);
    const branches = uniq(mine.map((c) => placeName(c.placeId)));
    const taught = activeTeachers.filter(
      (t) => (Array.isArray(t.specs) ? t.specs : []).indexOf(name) > -1
    ).length;
    const note = mine.length
      ? mine.length + (mine.length === 1 ? ' class a week · ' : ' classes a week · ') +
        (branches.join(', ') || '—')
      : (taught
        ? taught + (taught === 1 ? ' instructor · ask for dates' : ' instructors · ask for dates')
        : 'Ask us about upcoming dates');
    const noteZh = mine.length
      ? (NOTE_ZH[name] || ('每周 ' + mine.length + ' 堂课 · ' + (zhList(branches) || '—')))
      : (taught ? (taught + ' 位导师 · 开课时间请洽询') : '开课时间请洽询');
    return {
      name: name,
      cn: STYLE_ZH[name] || name,
      count: mine.length,
      teachers: taught,
      note: note,
      noteZh: noteZh
    };
  });
  // Canonical order is the studio's own; derived order is busiest-first.
  if (!canon.length) styles.sort((a, b) => b.count - a.count);

  const branches = places.filter((pl) => pl.name).map((pl) => {
    const mine = publicClasses.filter((c) => c.placeId === pl.id);
    return {
      name: pl.name,
      address: pl.address || '',
      addressZh: pl.address || '',
      classes: mine.length,
      styles: uniq(mine.map((c) => c.style))
    };
  });

  const events = (db.intro && Array.isArray(db.intro.events) ? db.intro.events : [])
    .filter((e) => e && (e.title || e.date || e.poster))
    .map((e) => ({
      badge: e.badge || '',
      title: e.title || '',
      lead: e.lead || '',
      when: [e.date, e.time, e.venue].filter(Boolean).join(' · ').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim(),
      cats: e.cats || '',
      regUrl: e.regUrl || '',
      poster: e.poster || ''
    }));

  // Highlight Video — set on the admin's Edit Intro Page screen ("Highlight Video" section),
  // stored as db.intro.videoUrl/videoEyebrow/videoTitle and already public via publicSlice().
  const introCfg = db.intro || {};
  const highlightVideo = classifyVideoUrl(introCfg.videoUrl);
  const highlight = highlightVideo ? {
    eyebrow: introCfg.videoEyebrow || '',
    title: introCfg.videoTitle || '',
    kind: highlightVideo.kind,
    fileUrl: highlightVideo.fileUrl || '',
    embedUrl: highlightVideo.embedUrl || ''
  } : null;

  return {
    roster: roster.length ? roster : null,
    styles: styles.length ? styles : null,
    branches: branches.length ? branches : null,
    events: events.length ? events : null,
    highlight: highlight,
    styleZh: STYLE_ZH
  };
}
