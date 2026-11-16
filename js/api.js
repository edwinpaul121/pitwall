// Thin, rate-limited, cached client for OpenF1 and Open-Meteo.
// OpenF1's free tier allows a few requests per second, so requests are
// spaced out by reserving start slots, and responses are cached in
// localStorage so reloads are instant.

import { sanitizeRows } from './util.js';

const OPENF1 = 'https://api.openf1.org/v1';
const MIN_GAP_MS = 380;
const CACHE_PREFIX = 'pitwall:v1:';

let nextSlot = 0;
const inflight = new Map();
let onThrottle = null;
/** Register a callback fired with the wait (seconds) when OpenF1 rate-limits us. */
export function setThrottleListener(fn) {
  onThrottle = fn;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cacheGet(key, ttl) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (Date.now() - t > ttl) return null;
    return v;
  } catch {
    return null;
  }
}

function cacheSet(key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
  } catch {
    // Quota exceeded or storage blocked: drop old entries and carry on uncached.
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(CACHE_PREFIX))
        .slice(0, 20)
        .forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  }
}

async function throttledFetch(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + MIN_GAP_MS;
    if (slot > now) await sleep(slot - now);

    const res = await fetch(url);
    if (res.status === 429) {
      // Honour Retry-After when present, otherwise back off exponentially
      // (≈2s → 32s) so we ride out OpenF1's per-minute window.
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
      nextSlot = Math.max(nextSlot, Date.now() + wait);
      onThrottle?.(Math.round(wait / 1000));
      await sleep(wait);
      continue;
    }
    // OpenF1 answers 404 + {"detail":"No results found."} for empty sets.
    if (res.status === 404) return [];
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json())?.detail || '';
      } catch { /* not JSON */ }
      const err = new Error(`${res.status} ${detail || res.statusText}`);
      err.status = res.status;
      err.detail = detail;
      throw err;
    }
    return res.json();
  }
  throw new Error(`Rate limited — ${url}`);
}

const MIN = 60 * 1000;
export const TTL = {
  none: 0, // never stored in localStorage (large or real-time payloads)
  live: 5 * MIN,
  short: 20 * MIN,
  long: 7 * 24 * 60 * MIN,
};

/** GET an OpenF1 endpoint. `query` is a raw query string (supports >=, <= operators). */
export function of1(endpoint, query = '', ttl = TTL.short) {
  const url = `${OPENF1}/${endpoint}${query ? `?${query}` : ''}`;
  const key = `${endpoint}?${query}`;
  // Cached copies are cleaned again too, in case they predate a sanitiser change.
  const cached = ttl ? cacheGet(key, ttl) : null;
  if (cached) return Promise.resolve(sanitizeRows(cached));
  if (inflight.has(key)) return inflight.get(key);

  const p = throttledFetch(url)
    .then((data) => {
      const arr = sanitizeRows(data);
      if (ttl) cacheSet(key, arr);
      return arr;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Open-Meteo hourly forecast in UTC for a coordinate. */
export async function forecast(lat, lon) {
  const key = `meteo:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = cacheGet(key, 30 * MIN);
  if (cached) return cleanForecast(cached);
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: [
      'temperature_2m',
      'precipitation_probability',
      'precipitation',
      'weather_code',
      'wind_speed_10m',
      'wind_direction_10m',
      'relative_humidity_2m',
      'cloud_cover',
    ].join(','),
    daily: 'sunrise,sunset',
    timezone: 'GMT',
    forecast_days: '16',
    wind_speed_unit: 'kmh',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Weather ${res.status}`);
  const data = cleanForecast(await res.json());
  cacheSet(key, data);
  return data;
}

/** Keep only well-formed forecast arrays: ISO time strings and finite numbers. */
function cleanForecast(data) {
  const clean = (block) => {
    if (!block || typeof block !== 'object') return {};
    const out = {};
    for (const [k, arr] of Object.entries(block)) {
      if (!Array.isArray(arr)) continue;
      out[k] = /^(time|sunrise|sunset)$/.test(k)
        ? arr.map((t) => (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(t) ? t : null))
        : arr.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
    }
    return out;
  };
  return { hourly: clean(data?.hourly), daily: clean(data?.daily), utc_offset_seconds: Number(data?.utc_offset_seconds) || 0 };
}

/**
 * Read an RSS feed through rss2json (news sites don't send CORS headers, so a
 * browser page can't fetch their XML directly). Cached for 15 minutes.
 */
export async function rssFeed(feedUrl) {
  const key = `rss:${feedUrl}`;
  const cached = cacheGet(key, 15 * MIN);
  if (cached) return cached;
  const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`);
  if (!res.ok) throw new Error(`News feed ${res.status}`);
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(data.message || 'News feed unavailable');
  cacheSet(key, data);
  return data;
}
