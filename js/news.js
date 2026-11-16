// News: pulls several F1 RSS feeds and tags each article with the drivers,
// teams and race it mentions, so the News page can filter by them.
import { rssFeed } from './api.js';
import { safeUrl } from './util.js';

export const FEEDS = [
  { source: 'Formula1.com', url: 'https://www.formula1.com/en/latest/all.xml' },
  { source: 'Autosport', url: 'https://www.autosport.com/rss/f1/news/' },
  { source: 'Motorsport.com', url: 'https://www.motorsport.com/rss/f1/news/' },
  { source: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/formula1/rss.xml' },
];

// Extra ways each team is written in headlines.
const TEAM_ALIASES = {
  'Red Bull Racing': ['Red Bull'],
  'Racing Bulls': ['Racing Bulls', 'VCARB'],
  'Haas F1 Team': ['Haas'],
  'Aston Martin': ['Aston Martin'],
  Audi: ['Audi', 'Sauber'],
  Mercedes: ['Mercedes'],
  Ferrari: ['Ferrari'],
  McLaren: ['McLaren'],
  Williams: ['Williams'],
  Alpine: ['Alpine'],
  Cadillac: ['Cadillac'],
};

function decode(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function firstImage(html) {
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html || '');
  return m ? m[1] : null;
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(+d) ? null : d;
}

function shape(item, source, index) {
  const enc = item.enclosure && !Array.isArray(item.enclosure) ? item.enclosure : null;
  const image =
    (enc?.link && (!enc.type || enc.type.startsWith('image')) ? enc.link : null) ||
    item.thumbnail ||
    firstImage(item.content) ||
    firstImage(item.description) ||
    null;
  let excerpt = decode(item.description || item.content);
  if (excerpt.length > 240) excerpt = `${excerpt.slice(0, 237).replace(/\s+\S*$/, '')}…`;
  return {
    id: item.guid || item.link,
    title: decode(item.title),
    link: safeUrl(item.link, { allowHttp: true }),
    source,
    date: parseDate(item.pubDate),
    feedIndex: index,
    // Only plain web addresses survive: no javascript:, data: or other schemes.
    image: safeUrl(typeof image === 'string' ? image.replace(/^http:/, 'https:') : null),
    excerpt,
  };
}

const normTitle = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/** Fetch every feed; a feed that fails is skipped rather than failing the page. */
export async function loadNews() {
  const settled = await Promise.allSettled(FEEDS.map((f) => rssFeed(f.url)));
  const articles = [];
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      failed.push(FEEDS[i].source);
      return;
    }
    (r.value.items || []).forEach((item, idx) => articles.push(shape(item, FEEDS[i].source, idx)));
  });

  // Same story syndicated across sister sites → keep the first copy.
  const seen = new Set();
  const unique = articles.filter((a) => {
    const k = normTitle(a.title);
    if (!a.title || !a.link || seen.has(k)) return false; // drop stories without a safe link
    seen.add(k);
    return true;
  });

  // Newest first. Formula1.com's feed has no dates, so its stories (already
  // newest-first) are woven in every third slot rather than guessed a time.
  const dated = unique.filter((a) => a.date).sort((a, b) => b.date - a.date);
  const undated = unique.filter((a) => !a.date).sort((a, b) => a.feedIndex - b.feedIndex);
  const merged = [];
  while (dated.length || undated.length) {
    merged.push(...dated.splice(0, 2));
    if (undated.length) merged.push(undated.shift());
  }
  return { articles: merged, failed };
}

const wordRe = (w) => new RegExp(`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'iu');

/**
 * Tag articles with what they mention.
 * @param drivers  [{number, last, name, team, colour, acronym}]
 * @param races    [{key, meeting}] — e.g. the next and the most recent Grand Prix
 */
export function tagArticles(articles, drivers, races = []) {
  const driverMatchers = drivers
    .filter((d) => d.last)
    .map((d) => ({ d, re: wordRe(d.last) }));
  const teams = [...new Set(drivers.map((d) => d.team))];
  const teamMatchers = teams.map((t) => ({
    team: t,
    colour: drivers.find((d) => d.team === t)?.colour,
    res: (TEAM_ALIASES[t] || [t]).map(wordRe),
  }));
  const deaccent = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const raceMatchers = races.map(({ key, meeting: m }) => {
    const words = [m.name.replace(/ Grand Prix$/, ''), m.location, m.circuitShort].filter(Boolean);
    return { key, label: m.name, res: [...new Set(words.flatMap((w) => [w, deaccent(w)]))].map(wordRe) };
  });

  for (const a of articles) {
    const text = `${a.title} ${a.excerpt}`;
    a.tags = [];
    for (const r of raceMatchers) {
      if (r.res.some((re) => re.test(text))) a.tags.push({ type: 'race', key: r.key, label: r.label });
    }
    for (const { d, re } of driverMatchers) {
      if (re.test(text)) a.tags.push({ type: 'driver', key: `d${d.number}`, label: d.last, colour: d.colour });
    }
    for (const t of teamMatchers) {
      if (t.res.some((re) => re.test(text))) a.tags.push({ type: 'team', key: `t${t.team}`, label: t.team, colour: t.colour });
    }
  }
  return articles;
}

/** Most-mentioned drivers and teams, for the filter chips. */
export function topTags(articles, limit = 12) {
  const counts = new Map();
  for (const a of articles) {
    for (const t of a.tags) {
      if (t.type === 'race') continue;
      const c = counts.get(t.key) || { ...t, count: 0 };
      c.count++;
      counts.set(t.key, c);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
