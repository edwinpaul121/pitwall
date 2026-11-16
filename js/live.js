// Live timing + replay engine.
//
// A "feed" is every OpenF1 stream for one session. From it we can rebuild the
// state of the race at any instant t (order, gaps, tyres, pit stops, track
// status, weather) and a list of plain-English updates (commentary). Live mode
// polls OpenF1 and keeps t at "now"; replay mode moves t along a timeline.

import { of1, TTL } from './api.js';
import { shapeDriver, normaliseResult } from './data.js';
import { $, esc, icon, lapTime, shortName, trackTime } from './util.js';

const memo = new Map();

const ms = (s) => (s ? Date.parse(String(s).replace(/(\.\d{3})\d+/, '$1')) : NaN);
const cap = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : '');

/** Binary search: index of the last element with key(el) <= t, or -1. */
function lastLE(arr, t, key) {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// ------------------------------------------------------------------ loading

const STREAMS = ['laps', 'position', 'race_control', 'pit', 'stints', 'overtakes', 'team_radio', 'weather', 'drivers', 'session_result'];

/** Fetch every stream for a session. Throws err.status 401/403 when OpenF1 withholds live data. */
export async function loadFeed(session, { live = false } = {}) {
  if (!live && memo.has(session.key)) return memo.get(session.key);
  const q = `session_key=${session.key}`;
  const data = await Promise.all(STREAMS.map((s) => of1(s, q, TTL.none)));
  const feed = Object.fromEntries(STREAMS.map((s, i) => [s, data[i]]));
  feed.session = session;
  feed.fetchedAt = Date.now();
  if (!live) memo.set(session.key, feed);
  return feed;
}

/** Live mode: re-pull the small streams, and only recent laps. */
export async function refreshFeed(feed) {
  const q = `session_key=${feed.session.key}`;
  const lastLap = Math.max(0, ...feed.laps.map((l) => ms(l.date_start) || 0));
  const since = new Date((lastLap || Date.now()) - 6 * 60e3).toISOString();
  const small = ['position', 'race_control', 'pit', 'stints', 'overtakes', 'team_radio', 'weather'];
  const [recentLaps, ...rest] = await Promise.all([
    of1('laps', `${q}&date_start>=${since}`, TTL.none),
    ...small.map((s) => of1(s, q, TTL.none)),
  ]);
  small.forEach((s, i) => (feed[s] = rest[i]));
  const byKey = new Map(feed.laps.map((l) => [`${l.driver_number}:${l.lap_number}`, l]));
  recentLaps.forEach((l) => byKey.set(`${l.driver_number}:${l.lap_number}`, l));
  feed.laps = [...byKey.values()];
  feed.fetchedAt = Date.now();
  return feed;
}

// ------------------------------------------------------------------ model

export function buildModel(feed, { expectedLaps = null, live = false } = {}) {
  const isRace = /Race|Sprint$/.test(feed.session.name) && !/Qualifying/.test(feed.session.name);
  const drivers = new Map(feed.drivers.map((d) => [d.driver_number, shapeDriver(d)]));
  const result = feed.session_result.map(normaliseResult);
  const nums = [...new Set([...drivers.keys(), ...feed.laps.map((l) => l.driver_number)])];
  nums.forEach((n) => {
    if (!drivers.has(n)) drivers.set(n, { number: n, acronym: `#${n}`, name: `Car ${n}`, last: `#${n}`, team: '—', colour: '#86868b' });
  });

  // Laps & line crossings.
  const laps = new Map();
  for (const n of nums) laps.set(n, []);
  for (const l of feed.laps) laps.get(l.driver_number)?.push({ ...l, start: ms(l.date_start) });
  const cross = new Map(); // n -> [{k, t}] ascending
  const leaderCross = []; // k -> earliest crossing time
  const leaderStart = []; // k -> earliest start of lap k
  for (const [n, list] of laps) {
    list.sort((a, b) => a.lap_number - b.lap_number);
    const c = [];
    list.forEach((l, i) => {
      const next = list[i + 1];
      let t = NaN;
      if (next && next.lap_number === l.lap_number + 1 && next.start) t = next.start;
      else if (l.start && l.lap_duration) t = l.start + l.lap_duration * 1000;
      if (l.start && !(leaderStart[l.lap_number] <= l.start)) leaderStart[l.lap_number] = l.start;
      if (Number.isFinite(t)) {
        c.push({ k: l.lap_number, t, dur: l.lap_duration, pitOut: l.is_pit_out_lap });
        if (!(leaderCross[l.lap_number] <= t)) leaderCross[l.lap_number] = t;
      }
    });
    cross.set(n, c);
  }

  const positions = new Map(nums.map((n) => [n, []]));
  for (const p of feed.position) positions.get(p.driver_number)?.push({ t: ms(p.date), pos: p.position });
  positions.forEach((l) => l.sort((a, b) => a.t - b.t));

  const rc = feed.race_control.map((r) => ({ ...r, t: ms(r.date) })).sort((a, b) => a.t - b.t);
  const pits = feed.pit.map((p) => ({ ...p, t: ms(p.date) })).sort((a, b) => a.t - b.t);
  const weather = feed.weather.map((w) => ({ ...w, t: ms(w.date) })).sort((a, b) => a.t - b.t);
  const stints = feed.stints.slice().sort((a, b) => a.stint_number - b.stint_number);

  // Timeline bounds.
  const lap1 = leaderStart[1];
  const firstLap = Math.min(...feed.laps.map((l) => ms(l.date_start)).filter(Number.isFinite));
  const tStart = (isRace ? lap1 : firstLap) || ms(feed.session.start) || Date.now();
  const chequered = rc.find((r) => r.flag === 'CHEQUERED' && r.t > tStart);
  const lastCross = Math.max(tStart, ...[...cross.values()].flatMap((c) => c.map((x) => x.t)));
  const tEnd = live ? Date.now() : Math.max(lastCross, chequered?.t || 0) + 30e3;
  const totalLaps = Math.max(0, ...result.map((r) => r.number_of_laps || 0)) || expectedLaps || null;
  const dnf = new Set(result.filter((r) => r.dnf || r.dns || r.dsq).map((r) => r.driver_number));

  const model = {
    feed, isRace, live, drivers, laps, cross, leaderCross, leaderStart, positions, rc, pits, weather, stints,
    tStart, tEnd, totalLaps, chequered, result, dnf, nums,
  };
  model.events = buildEvents(model);
  model.ivl = new Map(nums.map((n) => [n, []])); // n -> [{t, gap, lapsDown, int}]
  model.ivlWindows = new Map(); // window index -> 'loading' | 'done' | retry-after timestamp
  model.ivlLatest = 0;
  return model;
}

// ------------------------------------------------------------------ intervals
// OpenF1's `intervals` stream has the official gap-to-leader and interval for
// every car about every 4 seconds. A whole race is ~4 MB, so replays load it in
// 5-minute windows around the playhead (and the next window ahead).

const IVL_WINDOW = 5 * 60e3;
const isoSec = (t) => new Date(t).toISOString().slice(0, 19);

export function addIntervals(model, rows) {
  const touched = new Set();
  for (const r of rows) {
    const list = model.ivl.get(r.driver_number);
    if (!list) continue;
    const g = r.gap_to_leader;
    const lap = typeof g === 'string' ? /(\d+)\s*LAP/i.exec(g) : null;
    const t = ms(r.date);
    list.push({ t, gap: typeof g === 'number' ? g : null, lapsDown: lap ? Number(lap[1]) : 0, int: typeof r.interval === 'number' ? r.interval : null });
    touched.add(list);
    if (t > model.ivlLatest) model.ivlLatest = t;
  }
  for (const list of touched) {
    list.sort((a, b) => a.t - b.t);
    for (let i = list.length - 1; i > 0; i--) if (list[i].t === list[i - 1].t) list.splice(i, 1);
  }
}

/** Make sure interval data around `t` is loaded. Returns true if the current window is ready. */
export function ensureIntervals(model, t, onLoad) {
  const base = model.tStart - 10 * 60e3;
  const idx = Math.floor((t - base) / IVL_WINDOW);
  // Also the previous window when we're near its end (samples just before t live there).
  const near = t - (base + idx * IVL_WINDOW) < 20e3;
  for (const i of near ? [idx, idx - 1, idx + 1] : [idx, idx + 1]) {
    const st = model.ivlWindows.get(i);
    if (i < 0 || st === 'loading' || st === 'done' || (typeof st === 'number' && Date.now() < st)) continue;
    const from = base + i * IVL_WINDOW;
    if (from > model.tEnd) continue;
    model.ivlWindows.set(i, 'loading');
    of1('intervals', `session_key=${model.feed.session.key}&date>=${isoSec(from)}&date<${isoSec(from + IVL_WINDOW)}`, TTL.none)
      .then((rows) => {
        addIntervals(model, rows);
        model.ivlWindows.set(i, 'done');
        onLoad?.();
      })
      .catch(() => model.ivlWindows.set(i, Date.now() + 15e3)); // retry later, don't hammer
  }
  return model.ivlWindows.get(idx) === 'done';
}

function posAt(model, n, t) {
  const list = model.positions.get(n) || [];
  const i = lastLE(list, t, (x) => x.t);
  return i >= 0 ? list[i].pos : null;
}

export function leaderLapAt(model, t) {
  let k = 0;
  model.leaderStart.forEach((s, lap) => {
    if (s <= t && lap > k) k = lap;
  });
  return k;
}

export function trackStatusAt(model, t) {
  if (t < model.tStart && model.isRace) return { key: 'pre', label: 'Pre-race' };
  let status = { key: 'green', label: 'Green flag' };
  for (const r of model.rc) {
    if (r.t > t || status.key === 'end') break;
    const m = r.message || '';
    if (/VIRTUAL SAFETY CAR DEPLOYED/.test(m)) status = { key: 'vsc', label: 'Virtual safety car' };
    else if (/SAFETY CAR DEPLOYED/.test(m)) status = { key: 'sc', label: 'Safety car' };
    else if (/\bRED FLAG/.test(m) || (r.flag === 'RED' && r.scope === 'Track')) status = { key: 'red', label: 'Red flag' };
    else if (r.flag === 'CHEQUERED' && r.t > model.tStart) status = { key: 'end', label: 'Chequered flag' };
    else if (/VIRTUAL SAFETY CAR ENDING|TRACK CLEAR/.test(m) || (r.flag === 'GREEN' && r.scope === 'Track'))
      status = status.key === 'end' ? status : { key: 'green', label: 'Green flag' };
  }
  return status;
}

export function weatherAtT(model, t) {
  const i = lastLE(model.weather, t, (w) => w.t);
  return i >= 0 ? model.weather[i] : model.weather[0] || null;
}

/** Full timing-tower state at instant t. */
export function stateAt(model, t) {
  const { cross, leaderCross } = model;
  let fastest = null;
  const rows = model.nums.map((n) => {
    const c = cross.get(n) || [];
    const ci = lastLE(c, t, (x) => x.t);
    const done = ci >= 0 ? c[ci] : null;
    const completed = done ? done.k : 0;
    let best = null;
    for (let i = 0; i <= ci; i++) {
      const d = c[i].dur;
      if (d && c[i].k > 1 && (best == null || d < best)) best = d;
    }
    if (best != null && (!fastest || best < fastest.time)) fastest = { n, time: best };
    let gap = null;
    let lapsDown = 0;
    if (done && leaderCross[completed]) {
      gap = (done.t - leaderCross[completed]) / 1000;
      for (let j = completed + 1; leaderCross[j] && leaderCross[j] <= done.t; j++) lapsDown++;
    }
    // Prefer the ~4-second interval stream when we have a recent sample.
    let liveInt = null;
    let sampleT = null;
    const il = model.ivl?.get(n);
    if (il?.length) {
      const k = lastLE(il, t, (x) => x.t);
      if (k >= 0 && t - il[k].t < (model.live ? 25e3 : 15e3)) {
        const x = il[k];
        lapsDown = x.lapsDown;
        gap = x.lapsDown ? null : x.gap;
        liveInt = x.int;
        sampleT = x.t;
      }
    }
    const started = (model.laps.get(n) || []).filter((l) => l.start && l.start <= t);
    const curLap = started.length ? started[started.length - 1].lap_number : 0;
    const stint = model.stints.filter((s) => s.driver_number === n && s.lap_start <= Math.max(1, curLap)).pop();
    const pitList = model.pits.filter((p) => p.driver_number === n && p.t <= t);
    const lastPit = pitList[pitList.length - 1];
    const inPit = lastPit && t - lastPit.t < (lastPit.pit_duration || lastPit.lane_duration || 22) * 1000;
    const lastActivity = done ? done.t : started.length ? started[started.length - 1].start : 0;
    const out =
      t > model.tStart + 120e3 &&
      ((model.dnf.has(n) && t > lastActivity + 150e3) ||
        (model.live && model.isRace && t - lastActivity > 300e3 && !model.chequered));
    return {
      n,
      d: model.drivers.get(n),
      pos: posAt(model, n, t),
      completed,
      lap: curLap,
      gap,
      lapsDown,
      liveInt,
      sampleT,
      last: done?.dur ?? null,
      best,
      compound: stint?.compound || null,
      tyreAge: stint ? (stint.tyre_age_at_start || 0) + Math.max(0, curLap - stint.lap_start) : null,
      pits: pitList.length,
      inPit,
      out,
    };
  });

  if (model.isRace) {
    rows.sort((a, b) => (a.out - b.out) || (a.pos ?? 99) - (b.pos ?? 99));
  } else {
    rows.sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99) || (a.best ?? 1e9) - (b.best ?? 1e9));
  }
  rows.forEach((r, i) => {
    const ahead = rows[i - 1];
    r.interval =
      r.liveInt != null
        ? r.liveInt
        : ahead && r.gap != null && ahead.gap != null && r.lapsDown === ahead.lapsDown
          ? r.gap - ahead.gap
          : null;
    r.fastest = fastest && fastest.n === r.n;
    if (!model.isRace && rows[0].best && r.best) r.gapBest = r.best - rows[0].best;
  });
  const samples = rows.map((r) => r.sampleT).filter(Boolean);
  return {
    rows,
    lap: leaderLapAt(model, t),
    status: trackStatusAt(model, t),
    weather: weatherAtT(model, t),
    liveGaps: samples.length >= rows.length / 2,
    gapsAt: samples.length ? Math.max(...samples) : null,
  };
}

// ------------------------------------------------------------------ commentary

function humanise(model, msg) {
  const names = [];
  let s = msg.replace(/\bCARS? (?=\d+ \()/g, '').replace(/(\d+) \(([A-Z]{3})\)/g, (_, n) => {
    names.push(model.drivers.get(Number(n))?.name || `Car ${n}`);
    return `@@${names.length - 1}@@`;
  });
  s = s.replace(/\s*\(\d{2}:\d{2}:\d{2}\)\s*$/, '').toLowerCase();
  s = s.charAt(0).toUpperCase() + s.slice(1);
  s = s
    .replace(/\b(fia|drs|vsc|sc|pu)\b/gi, (w) => w.toUpperCase())
    .replace(/\bturn (\d+)/g, 'Turn $1')
    .replace(/@@(\d+)@@/g, (_, i) => names[i]);
  return s.endsWith('.') ? s : `${s}.`;
}

function classifyRC(model, r) {
  const m = r.message || '';
  if (r.t < model.tStart - 5 * 60e3) return null;
  if (/CLEAR IN TRACK SECTOR|GRIP DELTA|PIT EXIT (OPEN|CLOSED)|YELLOW IN PIT LANE|RISK OF RAIN/.test(m)) return null;
  if (r.flag === 'BLUE' || (r.scope === 'Sector' && /YELLOW/.test(r.flag || ''))) return null;
  if (r.flag === 'CHEQUERED') return null; // handled by the finish event
  if (/TIME .* DELETED/.test(m)) return model.isRace ? null : { kind: 'penalty', text: humanise(model, m) };
  if (/VIRTUAL SAFETY CAR DEPLOYED/.test(m)) return { kind: 'sc', text: 'Virtual safety car deployed. Everyone slows to a set lap time.' };
  if (/VIRTUAL SAFETY CAR ENDING/.test(m)) return { kind: 'sc', text: 'The VSC is ending. Racing resumes shortly.' };
  if (/SAFETY CAR DEPLOYED/.test(m)) return { kind: 'sc', text: 'Safety car deployed. The field bunches up behind it.' };
  if (/SAFETY CAR IN THIS LAP/.test(m)) return { kind: 'sc', text: 'The safety car comes in at the end of this lap. Get ready for the restart.' };
  if (/\bRED FLAG/.test(m) || (r.flag === 'RED' && r.scope === 'Track')) return { kind: 'flag-red', text: 'Red flag. The session is suspended.' };
  if (/DRS ENABLED/.test(m)) return { kind: 'info', text: 'DRS enabled.' };
  if (/DRS DISABLED/.test(m)) return { kind: 'info', text: 'DRS disabled.' };
  if (r.flag === 'GREEN' && r.scope === 'Track') return { kind: 'flag', text: 'Green flag. The track is clear.' };
  if (/BLACK AND WHITE|PENALTY|DISQUALIFIED|REPRIMAND/.test(m) && !/NO FURTHER/.test(m))
    return { kind: 'penalty', text: humanise(model, m), major: true };
  if (/INVESTIGAT|NO FURTHER|NOTED/.test(m)) return { kind: 'penalty', text: humanise(model, m) };
  if (r.category === 'SafetyCar' || r.category === 'SessionStatus' || /RETIRED|STOPPED|INCIDENT/.test(m))
    return { kind: 'info', text: humanise(model, m) };
  return null;
}

function buildEvents(model) {
  const { drivers } = model;
  const name = (n) => drivers.get(n)?.name || `Car ${n}`;
  const last = (n) => shortName(drivers.get(n) || { name: `Car ${n}` });
  const ev = [];
  const push = (t, kind, text, extra = {}) => Number.isFinite(t) && ev.push({ t, kind, text, ...extra });

  // Race control.
  for (const r of model.rc) {
    const c = classifyRC(model, r);
    if (c) push(r.t, c.kind, c.text, { n: r.driver_number || null, major: !!c.major });
  }

  if (model.isRace && model.leaderStart[1]) {
    // Start + lead changes, from the P1 position stream.
    const p1 = [];
    model.positions.forEach((list, n) => list.forEach((p) => p.pos === 1 && p1.push({ t: p.t, n })));
    p1.sort((a, b) => a.t - b.t);
    const startLeader = p1.filter((x) => x.t <= model.tStart + 20e3).pop()?.n;
    const polesitter = p1.filter((x) => x.t <= model.tStart).pop()?.n;
    let text = 'Lights out and away we go!';
    if (startLeader != null)
      text += polesitter != null && polesitter !== startLeader
        ? ` ${name(startLeader)} jumps ${last(polesitter)} for the lead into Turn 1.`
        : ` ${name(startLeader)} leads into Turn 1 from pole.`;
    push(model.tStart, 'start', text, { n: startLeader });

    let cur = startLeader;
    for (const x of p1) {
      if (x.t <= model.tStart + 20e3 || x.n === cur) continue;
      if (model.chequered && x.t > model.chequered.t) break;
      const pitted = model.pits.some((p) => p.driver_number === cur && Math.abs(p.t - x.t) < 60e3);
      push(x.t, 'lead', pitted ? `${name(x.n)} inherits the lead as ${last(cur)} pits.` : `${name(x.n)} takes the lead from ${last(cur)}!`, { n: x.n });
      cur = x.n;
    }

    // Overtakes inside the top ten, ignoring pit-stop shuffles.
    for (const o of model.feed.overtakes) {
      const t = ms(o.date);
      if (o.position === 1 || o.position > 10 || t < model.tStart + 30e3) continue;
      if (model.chequered && t > model.chequered.t) continue;
      const nearPit = model.pits.some(
        (p) => (p.driver_number === o.overtaken_driver_number || p.driver_number === o.overtaking_driver_number) && Math.abs(p.t - t) < 45e3
      );
      if (nearPit) continue;
      push(t, 'overtake', `${name(o.overtaking_driver_number)} passes ${last(o.overtaken_driver_number)} for P${o.position}.`, {
        n: o.overtaking_driver_number,
      });
    }

    // Lap summaries every ten laps.
    const total = model.totalLaps;
    model.leaderStart.forEach((t, k) => {
      if (!t || k % 10 !== 0 || (total && k >= total)) return;
      const s = stateAt(model, t + 1);
      const [a, b, c] = s.rows;
      if (!a || !b) return;
      const gap = b.gap != null && b.lapsDown === 0 ? ` by ${b.gap.toFixed(1)}s` : '';
      push(t + 1, 'summary', `Lap ${k}${total ? ` of ${total}` : ''}: ${name(a.n)} leads ${last(b.n)}${gap}${c ? `, with ${last(c.n)} third` : ''}.`, { n: a.n });
    });

    // Retirements (known once a result exists).
    for (const n of model.dnf) {
      const list = model.laps.get(n) || [];
      const lastLap = list.filter((l) => l.start).pop();
      if (!lastLap) continue;
      const t = lastLap.start + (lastLap.lap_duration || 100) * 1000;
      const pos = posAt(model, n, lastLap.start);
      push(t, 'retire', `${name(n)} is out of the race${pos ? ` from P${pos}` : ''}.`, { n });
    }
  }

  // Pit stops.
  for (const p of model.pits) {
    if (p.t < model.tStart) continue;
    const pos = posAt(model, p.driver_number, p.t - 3000);
    const next = model.stints.find((s) => s.driver_number === p.driver_number && s.lap_start > (p.lap_number || 0) - 1 && s.stint_number > 1);
    const stop = p.stop_duration ? `${p.stop_duration.toFixed(1)}s stop` : p.pit_duration ? `${p.pit_duration.toFixed(1)}s in the pit lane` : '';
    const tyre = next?.compound ? `onto ${cap(next.compound)}s` : '';
    push(p.t, 'pit', `${name(p.driver_number)} pits${pos ? ` from P${pos}` : ''}${stop || tyre ? ': ' : '.'}${[stop, tyre].filter(Boolean).join(', ')}${stop || tyre ? '.' : ''}`, {
      n: p.driver_number,
    });
  }

  // Fastest-lap progression (from lap 3, so out-laps don't flood the feed).
  const allLaps = [];
  model.cross.forEach((list, n) => list.forEach((c) => c.dur && c.k >= 2 && !c.pitOut && allLaps.push({ ...c, n })));
  allLaps.sort((a, b) => a.t - b.t);
  // Improvements within two laps of the last announcement replace it, so a
  // drying track doesn't flood the feed.
  let best = Infinity;
  let lastFl = null;
  for (const l of allLaps) {
    if (l.dur < best - 0.001) {
      best = l.dur;
      if (l.k < 3 || (model.chequered && l.t > model.chequered.t + 60e3)) continue;
      const text = `Fastest lap: ${name(l.n)}, ${lapTime(l.dur)}${model.isRace ? ` on lap ${l.k}` : ''}.`;
      if (lastFl && model.isRace && l.k - lastFl.k < 3) Object.assign(lastFl.ev, { t: l.t, text, n: l.n });
      else {
        push(l.t, 'fastest', text, { n: l.n });
        lastFl = { k: l.k, ev: ev[ev.length - 1] };
      }
    }
  }

  // Rain on / off.
  let wet = null;
  for (const w of model.weather) {
    const isWet = w.rainfall > 0;
    if (wet !== null && isWet !== wet && w.t >= model.tStart) push(w.t, 'weather', isWet ? 'Rain is falling at the circuit.' : 'The rain has stopped.');
    wet = isWet;
  }

  // Team radio.
  for (const r of model.feed.team_radio) {
    const t = ms(r.date);
    if (t < model.tStart - 5 * 60e3) continue;
    push(t, 'radio', `Team radio: ${name(r.driver_number)}.`, { n: r.driver_number, audio: r.recording_url });
  }

  // Finish.
  if (model.isRace && model.chequered) {
    const order = model.result.length
      ? model.result.filter((r) => r.position).sort((a, b) => a.position - b.position).map((r) => r.driver_number)
      : stateAt(model, model.chequered.t + 30e3).rows.map((r) => r.n);
    const [w, s2, s3] = order;
    if (w != null)
      push(
        model.chequered.t,
        'finish',
        `Chequered flag! ${name(w)} wins the ${model.feed.session.meetingName || 'race'}${s2 != null ? `, ahead of ${last(s2)}` : ''}${s3 != null ? ` and ${last(s3)}` : ''}.`,
        { n: w }
      );
  }

  ev.sort((a, b) => a.t - b.t);
  ev.forEach((e) => (e.lap = leaderLapAt(model, e.t)));
  return ev;
}

// ------------------------------------------------------------------ UI

const TYRE = {
  SOFT: { c: '#e10600', l: 'S' },
  MEDIUM: { c: '#f5c400', l: 'M' },
  HARD: { c: '#a7a7ab', l: 'H' },
  INTERMEDIATE: { c: '#2fa84f', l: 'I' },
  WET: { c: '#1f6fd1', l: 'W' },
};
const KIND_ICON = {
  start: 'flag', finish: 'flag', flag: 'flag', 'flag-red': 'flag', sc: 'gauge', lead: 'gauge', overtake: 'gauge',
  pit: 'pit', fastest: 'stopwatch', radio: 'radio', penalty: 'alert', weather: 'drop', summary: 'list', retire: 'alert', info: 'info',
};
const KIND_LABEL = {
  start: 'Start', finish: 'Finish', flag: 'Flag', 'flag-red': 'Red flag', sc: 'Safety car', lead: 'Lead change', overtake: 'Overtake',
  pit: 'Pit stop', fastest: 'Fastest lap', radio: 'Team radio', penalty: 'Stewards', weather: 'Weather', summary: 'Order', retire: 'Retirement', info: 'Race control',
};
const STATUS_CLASS = { green: 'st-green', sc: 'st-yellow', vsc: 'st-yellow', red: 'st-red', end: 'st-end', pre: 'st-pre' };

const ui = {
  root: null, season: null, model: null, t: 0, playing: false, speed: 30, timer: null, poll: null,
  sessionKey: null, mode: 'replay', shownEvents: -1, notice: null, filter: 'all', fast: null,
  gapMode: readPref('pitwall:gapMode', 'interval'),
};

function readPref(k, d) {
  try {
    return localStorage.getItem(k) || d;
  } catch {
    return d;
  }
}
function writePref(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch { /* storage unavailable */ }
}

function replayable(season) {
  return season.gps
    .flatMap((m) => m.sessions.map((s) => ({ ...s, meetingName: m.name, meeting: m })))
    .filter((s) => (s.name === 'Race' || s.name === 'Sprint') && season.results.has(s.key))
    .sort((a, b) => b.start - a.start);
}

export function liveSessionNow(season, now = Date.now()) {
  for (const m of season.gps) {
    for (const s of m.sessions) {
      if (s.start - 10 * 60e3 <= now && now <= +s.end + 20 * 60e3 && !s.cancelled) return { ...s, meetingName: m.name, meeting: m };
    }
  }
  return null;
}

export function unmountLive() {
  clearInterval(ui.timer);
  clearInterval(ui.poll);
  clearInterval(ui.fast);
  ui.timer = ui.poll = ui.fast = null;
  ui.playing = false;
}

/** Render the Live page into `root`. */
export async function mountLive(root, season, { expectedLaps } = {}) {
  unmountLive();
  ui.root = root;
  ui.season = season;
  const live = liveSessionNow(season);
  const list = replayable(season);

  if (ui.sessionKey == null) {
    ui.sessionKey = live ? live.key : list[0]?.key;
    ui.mode = live ? 'live' : 'replay';
  }
  const session = (live && live.key === ui.sessionKey ? live : null) || list.find((s) => s.key === ui.sessionKey);
  if (!session) {
    root.innerHTML = `<section class="band band-white"><div class="wrap"><h1 class="headline">Live.</h1><p class="lede">No sessions to show yet this season.</p></div></section>`;
    return;
  }
  ui.mode = live && live.key === session.key ? 'live' : 'replay';
  root.innerHTML = shell(session, list, live);
  bindShell(root, season, expectedLaps);

  try {
    $('#live-loading').textContent = `Loading ${session.meetingName} ${session.name.toLowerCase()} timing data…`;
    const feed = await loadFeed(session, { live: ui.mode === 'live' });
    feed.session.meetingName = session.meetingName;
    if (ui.mode === 'live' && !feed.laps.length && !feed.position.length) throw Object.assign(new Error('No live data yet'), { status: 204 });
    start(feed, expectedLaps);
  } catch (err) {
    if (ui.mode === 'live') {
      // OpenF1 keeps real-time data for paying users while a session runs.
      ui.notice =
        err.status === 401 || err.status === 403
          ? 'OpenF1 only shares real-time data with paid accounts while a session is running. The full timing usually appears for free shortly after the session ends. Until then, here’s a replay of the last race.'
          : 'Live timing isn’t available yet for this session. Here’s a replay of the last race in the meantime.';
      ui.sessionKey = list[0]?.key;
      if (ui.sessionKey) return mountLive(root, season, { expectedLaps });
    }
    $('#live-loading').innerHTML = `<span class="error-card">Couldn’t load timing data (${esc(err.message)}).</span>`;
  }
}

function shell(session, list, live) {
  const isLive = ui.mode === 'live';
  const options = list
    .map((s) => `<option value="${s.key}" ${s.key === session.key ? 'selected' : ''}>${esc(s.meetingName.replace(' Grand Prix', ''))} · ${esc(s.name)}</option>`)
    .join('');
  return `
  <section class="band band-white live-top">
    <div class="wrap fade-in">
      ${ui.notice ? `<div class="card notice">${esc(ui.notice)}</div>` : ''}
      <div class="live-head">
        <div>
          <p class="badge-new">${isLive ? '<span class="dot-live"></span> Live now' : 'Replay'}</p>
          <h1 class="headline" style="margin:0">${esc(session.meetingName.replace(' Grand Prix', ''))}.</h1>
          <p class="lede" style="margin-top:8px">${esc(session.name)} · ${esc(trackTime(session.start, session.meeting.gmtOffset, { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
        </div>
        <div class="live-pick">
          ${live && !isLive ? `<button class="btn btn-primary" id="go-live">Watch ${esc(live.name)} live</button>` : ''}
          ${isLive ? '' : `<select class="select-pill" id="live-session" aria-label="Session to replay">${options}</select>`}
        </div>
      </div>
      <div class="live-status" id="live-status"><span class="muted" id="live-loading">Loading…</span></div>
      ${
        isLive
          ? `<p class="micro" id="live-updated" style="margin-top:12px"></p>`
          : `<div class="player" id="player" hidden>
              <button class="play" id="play" aria-label="Play">${playIcon(false)}</button>
              <input type="range" id="scrub" min="0" max="1000" value="0" aria-label="Race timeline">
              <span class="clock" id="clock">0:00</span>
              <div class="segmented" role="group" aria-label="Replay speed">
                ${[1, 10, 30, 60].map((x) => `<button data-speed="${x}" aria-pressed="${ui.speed === x}">${x}×</button>`).join('')}
              </div>
            </div>`
      }
    </div>
  </section>
  <section class="band band-gray live-body">
    <div class="wrap live-grid">
      <div class="card table-card" style="margin:0">
        <div class="table-head">
          <h3 class="subhead" style="margin:0">Timing.</h3>
          <div class="segmented small-seg" role="group" aria-label="Timing column" id="gap-mode">
            <button data-gap="interval" aria-pressed="${ui.gapMode === 'interval'}">Interval</button>
            <button data-gap="leader" aria-pressed="${ui.gapMode === 'leader'}">Gap to leader</button>
          </div>
        </div>
        <div class="tower-meta"><span class="micro" id="gap-note"></span><span class="micro" id="tower-note"></span></div>
        <div class="scroll-x"><table class="ptable tower" id="tower"></table></div>
      </div>
      <div class="card feed-card">
        <div class="feed-head">
          <h3 class="subhead" style="margin:0">Race updates.</h3>
          <div class="segmented small-seg" role="group" aria-label="Filter updates">
            ${[['all', 'All'], ['key', 'Key moments'], ['radio', 'Radio']].map(([k, l]) => `<button data-filter="${k}" aria-pressed="${ui.filter === k}">${l}</button>`).join('')}
          </div>
        </div>
        <ol class="feed" id="feed"></ol>
      </div>
    </div>
  </section>`;
}

const playIcon = (playing) =>
  playing
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5z"/></svg>';

function bindShell(root, season, expectedLaps) {
  root.querySelector('#live-session')?.addEventListener('change', (e) => {
    ui.sessionKey = Number(e.target.value);
    ui.notice = null;
    mountLive(root, season, { expectedLaps });
  });
  root.querySelector('#go-live')?.addEventListener('click', () => {
    ui.sessionKey = liveSessionNow(season)?.key;
    ui.notice = null;
    mountLive(root, season, { expectedLaps });
  });
  root.querySelectorAll('[data-gap]').forEach((b) =>
    b.addEventListener('click', () => {
      ui.gapMode = b.dataset.gap;
      writePref('pitwall:gapMode', ui.gapMode);
      root.querySelectorAll('[data-gap]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      if (ui.model) render();
    })
  );
  root.querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      ui.filter = b.dataset.filter;
      root.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      ui.shownEvents = -1;
      renderFeed(true);
    })
  );
}

function start(feed, expectedLaps) {
  const live = ui.mode === 'live';
  ui.model = buildModel(feed, { expectedLaps, live });
  ui.shownEvents = -1;
  if (live) {
    // Fast loop (8s): gaps + positions. Slow loop (60s): everything else.
    // Together ≈ 23 requests/minute, inside OpenF1's rate limit.
    const key = feed.session.key;
    const fastPoll = async () => {
      const m = ui.model;
      try {
        const since = isoSec((m.ivlLatest || Date.now() - 90e3) - 2000);
        const lastPos = Math.max(0, ...feed.position.map((p) => ms(p.date) || 0));
        const [ivl, pos] = await Promise.all([
          of1('intervals', `session_key=${key}&date>=${since}`, TTL.none),
          of1('position', `session_key=${key}&date>${isoSec((lastPos || Date.now() - 90e3) - 1000)}`, TTL.none),
        ]);
        addIntervals(m, ivl);
        const seen = new Set(feed.position.map((p) => `${p.driver_number}:${p.date}`));
        for (const p of pos) {
          if (seen.has(`${p.driver_number}:${p.date}`)) continue;
          feed.position.push(p);
          m.positions.get(p.driver_number)?.push({ t: ms(p.date), pos: p.position });
        }
        m.positions.forEach((l) => l.sort((a, b) => a.t - b.t));
        ui.lastFast = Date.now();
      } catch (e) {
        ui.lastError = e.message;
      }
    };
    const slowPoll = async () => {
      try {
        await refreshFeed(feed);
        const old = ui.model;
        ui.model = buildModel(feed, { expectedLaps, live: true });
        Object.assign(ui.model, { ivl: old.ivl, ivlLatest: old.ivlLatest });
        ui.shownEvents = -1;
        ui.lastError = null;
      } catch (e) {
        ui.lastError = e.message;
      }
    };
    ui.t = Date.now();
    fastPoll().then(render);
    ui.fast = setInterval(fastPoll, 8e3);
    ui.poll = setInterval(slowPoll, 60e3);
    ui.timer = setInterval(() => {
      ui.t = Date.now();
      render();
    }, 1000);
    render();
    return;
  }

  // Replay: begin a few seconds before lights out and play.
  ui.t = ui.model.tStart - 5e3;
  const player = $('#player');
  player.hidden = false;
  const scrub = $('#scrub');
  const span = ui.model.tEnd - (ui.model.tStart - 5e3);
  scrub.addEventListener('input', () => {
    ui.t = ui.model.tStart - 5e3 + (scrub.value / 1000) * span;
    ui.shownEvents = -1;
    render();
  });
  $('#play').addEventListener('click', () => setPlaying(!ui.playing));
  player.querySelectorAll('[data-speed]').forEach((b) =>
    b.addEventListener('click', () => {
      ui.speed = Number(b.dataset.speed);
      player.querySelectorAll('[data-speed]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    })
  );
  ensureIntervals(ui.model, ui.t, render);
  render();
  setPlaying(true);
}

function setPlaying(on) {
  ui.playing = on;
  const btn = $('#play');
  if (btn) {
    btn.innerHTML = playIcon(on);
    btn.setAttribute('aria-label', on ? 'Pause' : 'Play');
  }
  clearInterval(ui.timer);
  if (!on) return;
  if (ui.t >= ui.model.tEnd) {
    ui.t = ui.model.tStart - 5e3;
    ui.shownEvents = -1;
  }
  let lastTick = performance.now();
  ui.timer = setInterval(() => {
    const now = performance.now();
    ui.t += (now - lastTick) * ui.speed;
    lastTick = now;
    if (ui.t >= ui.model.tEnd) {
      ui.t = ui.model.tEnd;
      render();
      setPlaying(false);
      return;
    }
    render();
  }, 250);
}

function render() {
  const m = ui.model;
  if (!m || !document.body.contains(ui.root)) return unmountLive();
  if (ui.mode === 'replay') ensureIntervals(m, ui.t, () => !ui.playing && render());
  const s = stateAt(m, ui.t);
  renderStatus(m, s);
  renderTower(m, s);
  renderFeed();
  if (ui.mode === 'replay') {
    const span = m.tEnd - (m.tStart - 5e3);
    const scrub = $('#scrub');
    if (scrub && document.activeElement !== scrub) scrub.value = String(Math.round(((ui.t - (m.tStart - 5e3)) / span) * 1000));
    const el = Math.max(0, ui.t - m.tStart);
    const h = Math.floor(el / 36e5);
    const mi = Math.floor((el % 36e5) / 6e4);
    const se = Math.floor((el % 6e4) / 1000);
    $('#clock').textContent = `${h ? `${h}:` : ''}${String(mi).padStart(h ? 2 : 1, '0')}:${String(se).padStart(2, '0')}`;
  } else {
    const u = $('#live-updated');
    if (u)
      u.textContent = ui.lastError
        ? `Update failed (${ui.lastError}). Retrying…`
        : `Gaps refresh every 8 seconds, everything else every minute · race control ${new Date(m.feed.fetchedAt).toLocaleTimeString()}`;
  }
}

function renderStatus(m, s) {
  const w = s.weather;
  const lapText = m.isRace
    ? `<b>${s.lap ? `Lap ${Math.min(s.lap, m.totalLaps || s.lap)}` : 'Grid'}</b>${m.totalLaps ? `<span>/${m.totalLaps}</span>` : ''}`
    : `<b>${esc(m.feed.session.name)}</b>`;
  $('#live-status').innerHTML = `
    <div class="lap-count">${lapText}</div>
    <div class="status-pill ${STATUS_CLASS[s.status.key] || ''}"><i></i>${esc(s.status.label)}</div>
    ${
      w
        ? `<div class="mini-wx">
            <span>${icon('thermo', 16)} Air ${Math.round(w.air_temperature)}°</span>
            <span>Track ${Math.round(w.track_temperature)}°</span>
            <span>${icon('drop', 16)} ${w.rainfall > 0 ? 'Rain' : 'Dry'}</span>
            <span>${icon('wind', 16)} ${(w.wind_speed * 3.6).toFixed(0)} km/h</span>
          </div>`
        : ''
    }`;
}

function renderTower(m, s) {
  const race = m.isRace;
  const head = race
    ? `<tr><th>Pos</th><th>Driver</th><th class="num">${ui.gapMode === 'interval' ? 'Interval' : 'Gap to leader'}</th><th class="num hide-sm">Last lap</th><th class="num">Tyre</th><th class="num hide-md">Stops</th></tr>`
    : '<tr><th>Pos</th><th>Driver</th><th class="num">Best lap</th><th class="num">Gap</th><th class="num hide-sm">Last lap</th><th class="num">Tyre</th></tr>';
  const lapped = (r) => `+${r.lapsDown} lap${r.lapsDown > 1 ? 's' : ''}`;
  const fmtGap = (r, i) => {
    if (r.out) return '<span class="status-tag dnf">OUT</span>';
    if (r.inPit) return '<span class="pit-tag">PIT</span>';
    if (i === 0) return r.completed || r.sampleT ? '<span class="muted">Leader</span>' : '—';
    if (ui.gapMode === 'interval') {
      if (r.interval != null && r.interval >= 0) return `+${r.interval.toFixed(3)}`;
      return r.lapsDown ? lapped(r) : '<span class="muted">—</span>';
    }
    if (r.lapsDown) return lapped(r);
    return r.gap != null ? `+${r.gap.toFixed(3)}` : '—';
  };
  const tyre = (r) => {
    const t = TYRE[r.compound];
    if (!t) return '<span class="muted">—</span>';
    return `<span class="tyre" style="--tc:${t.c}" title="${esc(cap(r.compound))}">${t.l}</span><span class="tyre-age">${r.tyreAge ?? ''}</span>`;
  };
  const rows = s.rows
    .map((r, i) => {
      const d = r.d;
      const lastCls = r.last && r.best && Math.abs(r.last - r.best) < 0.0005 ? 'pb' : '';
      const nameCell = `<td><div class="driver-cell"><span class="team-bar" style="background:${d.colour}"></span><div><div class="nm">${esc(d.name)}</div><div class="tm">${esc(d.team)}</div></div></div></td>`;
      if (race)
        return `<tr class="${r.out ? 'is-out' : ''}">
          <td class="pos-cell">${r.out ? '—' : r.pos ?? i + 1}</td>${nameCell}
          <td class="num gapcell">${fmtGap(r, i)}</td>
          <td class="num hide-sm ${r.fastest ? 'purple' : lastCls}">${r.last ? lapTime(r.last) : '—'}</td>
          <td class="num"><div class="tyre-cell">${tyre(r)}</div></td>
          <td class="num hide-md">${r.pits}</td>
        </tr>`;
      return `<tr>
        <td class="pos-cell">${r.pos ?? i + 1}</td>${nameCell}
        <td class="num ${r.fastest ? 'purple' : ''}">${r.best ? lapTime(r.best) : '—'}</td>
        <td class="num">${i && r.gapBest != null ? `+${r.gapBest.toFixed(3)}` : '—'}</td>
        <td class="num hide-sm">${r.last ? lapTime(r.last) : '—'}</td>
        <td class="num"><div class="tyre-cell">${tyre(r)}</div></td>
      </tr>`;
    })
    .join('');
  $('#tower').innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;
  const fl = s.rows.find((r) => r.fastest);
  $('#tower-note').innerHTML = fl ? `Fastest lap <b class="purple">${lapTime(fl.best)}</b> · ${esc(shortName(fl.d))}` : '';
  const note = $('#gap-note');
  if (note && race) {
    if (s.liveGaps) {
      const age = ui.mode === 'live' && s.gapsAt ? Math.max(0, Math.round((Date.now() - s.gapsAt) / 1000)) : null;
      note.innerHTML = `<span class="dot-fresh"></span>Gaps update every ~4s${age != null ? ` · ${age}s ago` : ''}`;
    } else note.textContent = ui.t < m.tStart ? '' : 'Gaps update each lap · loading 4-second timing…';
  }
}

const KEY_KINDS = new Set(['start', 'finish', 'lead', 'sc', 'flag-red', 'retire', 'weather', 'summary']);
const isKey = (e) => KEY_KINDS.has(e.kind) || e.major;

function renderFeed(force = false) {
  const m = ui.model;
  const visible = m.events.filter(
    (e) => e.t <= ui.t && (ui.filter === 'all' || (ui.filter === 'key' ? isKey(e) : e.kind === 'radio'))
  );
  if (!force && visible.length === ui.shownEvents) return;
  ui.shownEvents = visible.length;
  const feed = $('#feed');
  if (!visible.length) {
    feed.innerHTML = `<li class="feed-empty">${ui.t < m.tStart ? 'The cars are on the grid. Updates appear here once the race starts.' : 'Nothing to report yet.'}</li>`;
    return;
  }
  const items = visible
    .slice(-150)
    .reverse()
    .map((e, i) => {
      const d = e.n != null ? m.drivers.get(e.n) : null;
      const ic = KIND_ICON[e.kind] || 'info';
      const off = m.feed.session.meeting?.gmtOffset ?? 0;
      return `<li class="feed-item k-${e.kind} ${i === 0 && ui.playing ? 'fresh' : ''}">
        <div class="feed-ic" style="${d ? `color:${d.colour}` : ''}">${icon(ic, 18)}</div>
        <div class="feed-body">
          <div class="feed-meta">${esc(KIND_LABEL[e.kind] || 'Update')}${m.isRace && e.lap ? ` · Lap ${e.lap}` : ''} · ${esc(trackTime(new Date(e.t), off, { hour: '2-digit', minute: '2-digit' }))}</div>
          <div class="feed-text">${esc(e.text)}</div>
          ${e.audio ? `<audio controls preload="none" src="${esc(e.audio)}"></audio>` : ''}
        </div>
      </li>`;
    })
    .join('');
  feed.innerHTML = items;
}
