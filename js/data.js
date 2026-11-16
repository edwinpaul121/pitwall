// Assembles OpenF1 responses into a season model the UI and predictor use.
import { of1, TTL, forecast } from './api.js';
import { CIRCUITS, locate } from './circuits.js';

export const RACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
export const SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1];

export function parseOffset(gmt) {
  // "-08:00:00" -> -480 minutes
  if (!gmt) return 0;
  const neg = gmt.startsWith('-');
  const [h, m] = gmt.replace(/^[-+]/, '').split(':').map(Number);
  return (neg ? -1 : 1) * (h * 60 + (m || 0));
}

const isTesting = (m) => /testing/i.test(m.meeting_name);

function shapeMeeting(m) {
  return {
    key: m.meeting_key,
    name: m.meeting_name,
    official: m.meeting_official_name,
    location: m.location,
    country: m.country_name,
    countryCode: m.country_code,
    flag: m.country_flag,
    circuitKey: m.circuit_key,
    circuitShort: m.circuit_short_name,
    circuitType: m.circuit_type || 'Permanent',
    circuitImage: m.circuit_image,
    gmtOffset: parseOffset(m.gmt_offset),
    start: new Date(m.date_start),
    end: new Date(m.date_end),
    cancelled: !!m.is_cancelled,
    testing: isTesting(m),
    year: m.year,
    sessions: [],
  };
}

function shapeSession(s) {
  return {
    key: s.session_key,
    name: s.session_name,
    type: s.session_type,
    start: new Date(s.date_start),
    end: new Date(s.date_end),
    meetingKey: s.meeting_key,
    cancelled: !!s.is_cancelled,
  };
}

export function shapeDriver(d) {
  return {
    number: d.driver_number,
    acronym: d.name_acronym,
    name: d.full_name ? titleCase(d.full_name) : d.broadcast_name,
    first: d.first_name,
    last: d.last_name,
    team: d.team_name || '—',
    colour: d.team_colour ? `#${d.team_colour}` : '#86868b',
    headshot: d.headshot_url ? d.headshot_url.replace('/1col/', '/2col/') : null,
  };
}

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());
}

/** Core season data: calendar, results, drivers, standings. */
export async function loadSeason(progress = () => {}) {
  const now = new Date();
  let year = now.getUTCFullYear();

  progress('Loading the calendar');
  const [rawMeetings, rawSessions] = await Promise.all([
    of1('meetings', `year=${year}`, TTL.short),
    of1('sessions', `year=${year}`, TTL.short),
  ]);

  const meetings = rawMeetings.map(shapeMeeting).sort((a, b) => a.start - b.start);
  const byKey = new Map(meetings.map((m) => [m.key, m]));
  for (const s of rawSessions) {
    const m = byKey.get(s.meeting_key);
    if (m) m.sessions.push(shapeSession(s));
  }
  meetings.forEach((m) => m.sessions.sort((a, b) => a.start - b.start));

  // Round numbers count only Grands Prix that actually take place.
  let round = 0;
  for (const m of meetings) {
    if (m.testing || m.cancelled) continue;
    m.round = ++round;
  }

  const gps = meetings.filter((m) => !m.testing);
  for (const m of gps) {
    if (m.cancelled) m.status = 'cancelled';
    else if (m.end < now) m.status = 'done';
    else if (m.start <= now) m.status = 'live';
    else m.status = 'upcoming';
  }
  const next = gps.find((m) => !m.cancelled && m.end >= now) || null;
  if (next) next.isNext = true;

  // All results of completed sessions in a single ranged request.
  progress('Loading every result this season');
  const doneSessions = gps
    .filter((m) => !m.cancelled)
    .flatMap((m) => m.sessions)
    .filter((s) => s.end < now && !s.cancelled);
  const results = new Map();
  if (doneSessions.length) {
    const keys = doneSessions.map((s) => s.key);
    const lo = Math.min(...keys);
    const hi = Math.max(...keys);
    const rows = await of1('session_result', `session_key>=${lo}&session_key<=${hi}`, TTL.short);
    for (const r of rows.map(normaliseResult)) {
      if (!results.has(r.session_key)) results.set(r.session_key, []);
      results.get(r.session_key).push(r);
    }
    for (const list of results.values()) list.sort(byPosition);
  }

  // The most recent completed race anchors drivers and standings.
  const raceSessions = gps
    .flatMap((m) => m.sessions.map((s) => ({ s, m })))
    .filter(({ s }) => s.name === 'Race' && results.has(s.key))
    .sort((a, b) => a.s.start - b.s.start);
  const lastRace = raceSessions[raceSessions.length - 1] || null;

  progress('Loading drivers and standings');
  const drivers = new Map();
  let standings = { drivers: [], teams: [] };
  if (lastRace) {
    const [rawDrivers, champD, champT] = await Promise.all([
      of1('drivers', `session_key=${lastRace.s.key}`, TTL.short),
      of1('championship_drivers', `session_key=${lastRace.s.key}`, TTL.short),
      of1('championship_teams', `session_key=${lastRace.s.key}`, TTL.short),
    ]);
    rawDrivers.forEach((d) => drivers.set(d.driver_number, shapeDriver(d)));
    standings = {
      drivers: champD
        .map((r) => ({
          number: r.driver_number,
          position: r.position_current,
          points: r.points_current,
          delta: (r.position_start ?? r.position_current) - r.position_current,
          gained: r.points_current - (r.points_start ?? r.points_current),
        }))
        .sort((a, b) => a.position - b.position),
      teams: champT
        .map((r) => ({
          team: r.team_name,
          position: r.position_current,
          points: r.points_current,
          delta: (r.position_start ?? r.position_current) - r.position_current,
          gained: r.points_current - (r.points_start ?? r.points_current),
        }))
        .sort((a, b) => a.position - b.position),
    };
  }

  // Wins / podiums tallies from race results.
  const tally = new Map();
  for (const { s } of raceSessions) {
    for (const r of results.get(s.key) || []) {
      const t = tally.get(r.driver_number) || { wins: 0, podiums: 0, dnfs: 0, starts: 0 };
      t.starts++;
      if (r.position === 1) t.wins++;
      if (r.position && r.position <= 3) t.podiums++;
      if (r.dnf || r.dns) t.dnfs++;
      tally.set(r.driver_number, t);
    }
  }

  return { year, now, meetings, gps, next, lastRace, results, drivers, standings, tally };
}

/** OpenF1 occasionally reports a status string (e.g. "RT") in `position`. */
export function normaliseResult(r) {
  if (Number.isFinite(r.position)) return r;
  const status = typeof r.position === 'string' ? r.position : null;
  return { ...r, position: null, status, dnf: r.dnf || status === 'RT' };
}

export function byPosition(a, b) {
  const pa = a.position ?? 999;
  const pb = b.position ?? 999;
  return pa - pb;
}

/** Find a driver for a number; fetch the session's lineup lazily if unknown. */
export async function ensureDrivers(season, sessionKey, numbers) {
  if (numbers.every((n) => season.drivers.has(n))) return;
  const raw = await of1('drivers', `session_key=${sessionKey}`, TTL.long);
  raw.forEach((d) => {
    if (!season.drivers.has(d.driver_number)) season.drivers.set(d.driver_number, shapeDriver(d));
  });
}

/** Per-meeting results grouped by session name, in chronological order. */
export function seasonEvents(season) {
  return season.gps
    .filter((m) => m.status === 'done' || m.status === 'live' || m.isNext)
    .map((m) => {
      const pick = (name) => {
        const s = m.sessions.find((x) => x.name === name);
        return s && season.results.has(s.key) ? season.results.get(s.key) : null;
      };
      return {
        meeting: m,
        round: m.round,
        circuitType: m.circuitType,
        race: pick('Race'),
        sprint: pick('Sprint'),
        quali: pick('Qualifying'),
        sprintQuali: pick('Sprint Qualifying'),
        practice: ['Practice 1', 'Practice 2', 'Practice 3'].map(pick).filter(Boolean),
      };
    });
}

/** Everything specific to the next Grand Prix: history at the venue + weather. */
export async function loadNextContext(season, progress = () => {}) {
  const m = season.next;
  if (!m) return null;

  const circuit = await locate(m.circuitKey, m.location, m.country);

  progress('Looking back at previous editions');
  // Every call below is optional: if one fails the page still renders
  // and the model falls back to priors.
  const safe = (p, fallback = []) => p.catch((e) => (console.warn(e), fallback));
  const pastRaces = (await safe(of1('sessions', `circuit_key=${m.circuitKey}&session_name=Race`, TTL.long)))
    .map(shapeSession)
    .filter((s) => s.end < season.now && !s.cancelled && new Date(s.start).getUTCFullYear() < season.year)
    .sort((a, b) => b.start - a.start)
    .slice(0, 3);

  const history = await Promise.all(
    pastRaces.map(async (s) => {
      const [res, drv, rc] = await Promise.all([
        safe(of1('session_result', `session_key=${s.key}`, TTL.long)),
        safe(of1('drivers', `session_key=${s.key}`, TTL.long)),
        safe(of1('race_control', `session_key=${s.key}&category=SafetyCar`, TTL.long), null),
      ]);
      const dmap = new Map(drv.map((d) => [d.driver_number, shapeDriver(d)]));
      const sc = (rc || []).filter((x) => /DEPLOYED/i.test(x.message || ''));
      return {
        year: s.start.getUTCFullYear(),
        sessionKey: s.key,
        results: res.map(normaliseResult).sort(byPosition).map((r) => ({ ...r, driver: dmap.get(r.driver_number) })),
        safetyCars: sc.filter((x) => !/VIRTUAL/i.test(x.message)).length,
        virtualSafetyCars: sc.filter((x) => /VIRTUAL/i.test(x.message)).length,
        laps: Math.max(0, ...res.map((r) => r.number_of_laps || 0)),
        raceControlKnown: rc !== null,
      };
    })
  ).then((list) => list.filter((h) => h.results.length));

  // Strategy + track conditions from the most recent edition.
  let strategy = null;
  let lastConditions = null;
  if (pastRaces[0]) {
    progress('Reading last year’s strategy and track temperatures');
    const [stints, wx] = await Promise.all([
      safe(of1('stints', `session_key=${pastRaces[0].key}`, TTL.long)),
      safe(of1('weather', `session_key=${pastRaces[0].key}`, TTL.long)),
    ]);
    strategy = summariseStints(stints, history[0]);
    lastConditions = summariseWeather(wx);
  }

  progress('Fetching the forecast');
  let weather = null;
  if (circuit) {
    try {
      weather = await forecast(circuit.lat, circuit.lon);
    } catch {
      weather = null;
    }
  }

  return { meeting: m, circuit, history, strategy, lastConditions, weather };
}

function summariseStints(stints, edition) {
  if (!stints.length) return null;
  const byDriver = new Map();
  for (const s of stints) {
    if (!byDriver.has(s.driver_number)) byDriver.set(s.driver_number, []);
    byDriver.get(s.driver_number).push(s);
  }
  // Only count drivers who finished, so retirements don't skew stop counts.
  const finishers = new Set(
    (edition?.results || []).filter((r) => r.position && !r.dnf && !r.dns && !r.dsq).map((r) => r.driver_number)
  );
  const stops = [];
  const starts = {};
  const compounds = {};
  for (const [num, list] of byDriver) {
    list.sort((a, b) => a.stint_number - b.stint_number);
    if (list[0]?.compound) starts[list[0].compound] = (starts[list[0].compound] || 0) + 1;
    for (const s of list) {
      if (!s.compound) continue;
      const laps = (s.lap_end || 0) - (s.lap_start || 0) + 1;
      compounds[s.compound] = (compounds[s.compound] || 0) + Math.max(0, laps);
    }
    if (finishers.size === 0 || finishers.has(num)) stops.push(list.length - 1);
  }
  stops.sort((a, b) => a - b);
  const median = stops.length ? stops[Math.floor(stops.length / 2)] : null;
  const dist = {};
  stops.forEach((n) => (dist[n] = (dist[n] || 0) + 1));

  // Winner's strategy
  const winner = edition?.results?.find((r) => r.position === 1);
  const winnerStints = winner ? (byDriver.get(winner.driver_number) || []).map((s) => s.compound) : [];

  return {
    medianStops: median,
    stopDistribution: dist,
    startCompound: topKey(starts),
    lapsByCompound: compounds,
    winnerStints,
    winner: winner?.driver,
  };
}

function topKey(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function summariseWeather(rows) {
  if (!rows.length) return null;
  const avg = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length;
  const max = (k) => Math.max(...rows.map((r) => r[k] || 0));
  const min = (k) => Math.min(...rows.map((r) => r[k] ?? Infinity));
  return {
    air: avg('air_temperature'),
    track: avg('track_temperature'),
    trackMax: max('track_temperature'),
    trackMin: min('track_temperature'),
    humidity: avg('humidity'),
    wind: avg('wind_speed'),
    rained: rows.some((r) => r.rainfall > 0),
  };
}

/** Hourly forecast slice at a given UTC instant. */
export function weatherAt(weather, date) {
  if (!weather?.hourly?.time) return null;
  const t = weather.hourly.time;
  const iso = new Date(date);
  iso.setUTCMinutes(0, 0, 0);
  const key = iso.toISOString().slice(0, 13) + ':00';
  const i = t.indexOf(key);
  if (i < 0) return null;
  const h = weather.hourly;
  // Peak rain chance across the session's ~2h window.
  const window = [i, i + 1, i + 2].filter((j) => j < t.length);
  return {
    temp: h.temperature_2m[i],
    rain: Math.max(...window.map((j) => h.precipitation_probability[j] ?? 0)),
    precip: window.reduce((s, j) => s + (h.precipitation[j] || 0), 0),
    code: h.weather_code[i],
    wind: h.wind_speed_10m[i],
    windDir: h.wind_direction_10m[i],
    humidity: h.relative_humidity_2m[i],
    cloud: h.cloud_cover[i],
  };
}

/** Max points still available after a given meeting (inclusive when `inclusive`). */
export function pointsRemaining(season, fromMeeting, inclusive = true) {
  let races = 0;
  let sprints = 0;
  for (const m of season.gps) {
    if (m.cancelled) continue;
    if (m.start < fromMeeting.start) continue;
    if (!inclusive && m.key === fromMeeting.key) continue;
    for (const s of m.sessions) {
      if (season.results.has(s.key)) continue;
      if (s.name === 'Race') races++;
      if (s.name === 'Sprint') sprints++;
    }
  }
  return {
    races,
    sprints,
    driver: races * RACE_POINTS[0] + sprints * SPRINT_POINTS[0],
    team: races * (RACE_POINTS[0] + RACE_POINTS[1]) + sprints * (SPRINT_POINTS[0] + SPRINT_POINTS[1]),
  };
}
