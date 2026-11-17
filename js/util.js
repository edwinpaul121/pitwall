// Shared formatting + icon helpers used by every page.
export const $ = (sel) => document.querySelector(sel);
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const pct = (p, digits = 0) => {
  if (p == null) return '—';
  const v = p * 100;
  if (v > 0 && v < 1) return '<1%';
  return `${v.toFixed(digits)}%`;
};
// Team-colour wash over the page colour, so tinted cards work in light and dark mode.
export const tint = (c, amt = 22) => `color-mix(in srgb, ${c} ${amt}%, var(--paper))`;

// Some team colours drift toward a neighbour's when lightened or darkened
// (Mercedes' teal reads as Aston Martin green, and goes murky in dark mode).
// Per-team overrides: h = pinned OKLCH hue; vivid = use the brighter
// --tint-*-vivid tokens so the card matches the team colour bar.
const TINT = { Mercedes: { h: 188, vivid: true } };

/**
 * Inline `background` for a team-tinted card. Built in OKLCH from the team
 * colour: keeps its hue (and some of its saturation) while setting lightness
 * per theme via --tint-l / --tint-c / --tint-cmax. Older browsers fall back to
 * the plain sRGB mix in the first declaration.
 */
export function tintBg(c, team) {
  const o = TINT[team] || {};
  const v = o.vivid ? '-vivid' : '';
  return (
    `background:${tint(c, 20)};` +
    `background:oklch(from ${c} var(--tint-l${v}) min(calc(c * var(--tint-c${v})), var(--tint-cmax${v})) ${o.h ?? 'h'})`
  );
}
export function trackTime(date, offsetMin, opts) {
  const shifted = new Date(date.getTime() + offsetMin * 60000);
  return shifted.toLocaleString(undefined, { timeZone: 'UTC', ...opts });
}
export const localTime = (date, opts) => date.toLocaleString(undefined, opts);
export const dateRange = (a, b) => {
  const sameMonth = a.getUTCMonth() === b.getUTCMonth();
  const m1 = a.toLocaleString(undefined, { month: 'short', timeZone: 'UTC' });
  const m2 = b.toLocaleString(undefined, { month: 'short', timeZone: 'UTC' });
  return sameMonth ? `${a.getUTCDate()}–${b.getUTCDate()} ${m1}` : `${a.getUTCDate()} ${m1} – ${b.getUTCDate()} ${m2}`;
};
export function meetingDates(m) {
  // Show the weekend in track-local dates.
  const s = new Date(m.start.getTime() + m.gmtOffset * 60000);
  const e = new Date(m.end.getTime() + m.gmtOffset * 60000);
  return dateRange(s, e);
}
export function lapTime(sec) {
  if (sec == null || Number.isNaN(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3).padStart(6, '0');
  return m ? `${m}:${s}` : s;
}
export function raceTime(sec) {
  if (sec == null) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(3).padStart(6, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
export const shortName = (d) => d.last || d.name?.split(' ').slice(-1)[0] || d.acronym;
export const firstName = (d) => d.first || d.name?.split(' ')[0] || '';
export const ordinal = (n) => `P${n}`;
export const KEEP_UPPER = new Set(['F1', 'MSC', 'AWS', 'DHL', 'TAG', 'STC', 'LV', 'UBS', 'MSC']);
export function prettyOfficial(s) {
  // "FORMULA 1 HEINEKEN LAS VEGAS GRAND PRIX 2026" -> "Formula 1 Heineken Las Vegas Grand Prix 2026"
  if (s !== s.toUpperCase()) return s;
  return s
    .split(' ')
    .map((w) => (KEEP_UPPER.has(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ');
}
export const ICON = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>',
  partly: '<path d="M12 3v1.5M5.6 5.6l1 1M3 12h1.5M17.4 5.6l-1 1"/><path d="M8.5 11a3.5 3.5 0 0 1 6.8-1"/><path d="M7 20h10a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9.6 1.4A3 3 0 0 0 7 20z"/>',
  cloud: '<path d="M7 19h10a4 4 0 0 0 .6-8A6 6 0 0 0 6 10.5 4.3 4.3 0 0 0 7 19z"/>',
  fog: '<path d="M4 10h16M3 14h18M6 18h12"/><path d="M7 6.5A5 5 0 0 1 16.5 7"/>',
  rain: '<path d="M7 15h10a4 4 0 0 0 .6-8A6 6 0 0 0 6 6.5 4.3 4.3 0 0 0 7 15z"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/>',
  snow: '<path d="M7 15h10a4 4 0 0 0 .6-8A6 6 0 0 0 6 6.5 4.3 4.3 0 0 0 7 15z"/><path d="M8 19h.01M12 20h.01M16 19h.01"/>',
  storm: '<path d="M7 15h10a4 4 0 0 0 .6-8A6 6 0 0 0 6 6.5 4.3 4.3 0 0 0 7 15z"/><path d="M12 15l-2 4h3l-2 4"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  thermo: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.5 18a9 9 0 1 1 17 0"/>',
  pit: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  stopwatch: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M10 2h4M12 2v3"/>',
  radio: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>',
  alert: '<path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  news: '<path d="M4 5h13v14H6a2 2 0 0 1-2-2z"/><path d="M17 9h3v8a2 2 0 0 1-2 2M8 9h5M8 13h5M8 17h3"/>',
};
export const icon = (name, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

export function wxInfo(code, night) {
  if (code == null) return { icon: 'cloud', text: 'Unavailable' };
  if (code === 0) return { icon: night ? 'moon' : 'sun', text: night ? 'Clear night' : 'Clear sky' };
  if (code <= 2) return { icon: night ? 'moon' : 'partly', text: 'Partly cloudy' };
  if (code === 3) return { icon: 'cloud', text: 'Overcast' };
  if (code <= 48) return { icon: 'fog', text: 'Fog' };
  if (code <= 57) return { icon: 'rain', text: 'Drizzle' };
  if (code <= 67) return { icon: 'rain', text: 'Rain' };
  if (code <= 77) return { icon: 'snow', text: 'Snow' };
  if (code <= 82) return { icon: 'rain', text: 'Showers' };
  if (code <= 86) return { icon: 'snow', text: 'Snow showers' };
  return { icon: 'storm', text: 'Thunderstorms' };
}
export const isNight = (date, offsetMin) => {
  const h = new Date(date.getTime() + offsetMin * 60000).getUTCHours();
  return h < 6 || h >= 19;
};
export const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg ?? 0) % 360) / 45) % 8];
export const driverCell = (d) =>
  `<td><div class="driver-cell"><span class="team-bar" style="background:${d.colour}"></span><div><div class="nm">${esc(d.name)}</div><div class="tm">${esc(d.team)}</div></div></div></td>`;


// ---------------------------------------------------------------- input safety
// Everything from third-party APIs is treated as untrusted. Text is escaped
// when rendered (esc); these helpers make sure values that end up in
// attributes — colours, numbers, URLs — can only ever be what they claim.

/** Return a normalised URL if it uses an allowed scheme (and host, if given), else null. */
export function safeUrl(value, { allowHttp = false, hosts = null } = {}) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const u = new URL(value);
    const ok = u.protocol === 'https:' || (allowHttp && u.protocol === 'http:');
    if (!ok) return null;
    if (hosts && !hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** A 6-digit hex colour (no #), or null. */
export const safeHex = (v) => (typeof v === 'string' && /^[0-9a-f]{6}$/i.test(v) ? v : null);

const NUMERIC_KEYS = new Set([
  'driver_number', 'session_key', 'meeting_key', 'circuit_key', 'country_key', 'year',
  'position', 'points', 'number_of_laps', 'lap_number', 'stint_number', 'lap_start', 'lap_end',
  'tyre_age_at_start', 'position_start', 'position_current', 'points_start', 'points_current',
  'overtaking_driver_number', 'overtaken_driver_number', 'lap_duration', 'duration',
  'duration_sector_1', 'duration_sector_2', 'duration_sector_3', 'i1_speed', 'i2_speed', 'st_speed',
  'stop_duration', 'pit_duration', 'lane_duration', 'interval', 'gap_to_leader',
  'air_temperature', 'track_temperature', 'humidity', 'pressure', 'rainfall', 'wind_speed', 'wind_direction',
]);
const BOOL_KEYS = new Set(['dnf', 'dns', 'dsq', 'is_pit_out_lap', 'is_cancelled']);
const URL_KEYS = {
  headshot_url: { hosts: ['formula1.com'] },
  country_flag: { hosts: ['formula1.com'] },
  circuit_image: { hosts: ['formula1.com'] },
  recording_url: { hosts: ['livetiming.formula1.com'] },
  circuit_info_url: {},
};
// A few numeric fields legitimately carry short status text.
const STATUS_TEXT = {
  position: /^[A-Z]{1,4}$/,
  gap_to_leader: /^\+?\d+\s*LAPS?$/i,
  interval: /^\+?\d+\s*LAPS?$/i,
};

function toNum(key, v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    if (v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return STATUS_TEXT[key]?.test(v.trim()) ? v.trim() : null;
  }
  return null;
}

/** Clean one OpenF1 row in place-safe fashion (returns a new object). */
export function sanitizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (NUMERIC_KEYS.has(k)) out[k] = Array.isArray(v) ? v.map((x) => toNum(k, x)) : v == null ? null : toNum(k, v);
    else if (BOOL_KEYS.has(k)) out[k] = v === true;
    else if (k === 'team_colour') out[k] = safeHex(v);
    else if (k in URL_KEYS) out[k] = safeUrl(v, URL_KEYS[k]);
    else if (v == null || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : null));
    else out[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return out;
}

export const sanitizeRows = (rows) => (Array.isArray(rows) ? rows.map(sanitizeRow).filter(Boolean) : []);
