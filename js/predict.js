// Race prediction model.
//
// 1. Build a "pace rating" for each driver, expressed in finishing-position
//    units (lower is better), from a weighted blend of:
//      - recent race form (exponentially decayed, sprints at half weight)
//      - recent qualifying form
//      - team form (both cars)
//      - form on this circuit type (street / permanent / road)
//      - history at this venue (matched by driver code across seasons)
//    Each component is shrunk toward the driver's overall form when samples
//    are thin, so one lucky result doesn't dominate.
// 2. If this weekend's sessions have run, blend in practice order and, once
//    known, the qualifying grid.
// 3. Reliability: a Beta-smoothed DNF rate per driver, nudged up on street
//    circuits and by the venue's safety-car history.
// 4. Monte Carlo: simulate the race N times with Gaussian race-day noise whose
//    spread grows with rain probability and safety-car likelihood, plus random
//    retirements. Tally win / podium / points probabilities and expected points.

import { RACE_POINTS } from './data.js';

const DECAY = 0.82;
const DEFAULT_POS = 15;
const SIMS = 20000;

export const WEIGHTS = {
  form: 0.34,
  quali: 0.22,
  team: 0.16,
  track: 0.12,
  history: 0.16,
};

function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function weightedMean(samples, fallback) {
  let sw = 0;
  let s = 0;
  for (const { v, w } of samples) {
    s += v * w;
    sw += w;
  }
  return sw > 0 ? s / sw : fallback;
}

function shrink(samples, prior, k) {
  // Bayesian-ish shrinkage: k pseudo-observations at the prior.
  const n = samples.length;
  const sum = samples.reduce((a, b) => a + b, 0);
  return (sum + k * prior) / (n + k);
}

/**
 * @param {object} p
 * @param {Array} p.drivers           current grid [{number, acronym, team, ...}]
 * @param {Array} p.events            seasonEvents() output, chronological
 * @param {object} p.next             next meeting
 * @param {Array} p.history           previous editions at this venue
 * @param {number} p.rainProb         0..1 rain probability at race time
 * @param {number} p.scProb           0..1 likelihood of a safety car
 * @param {object} p.championship     {leader, rivals:[{number, points}], maxAfter}
 */
export function predict({ drivers, events, next, history, rainProb = 0, scProb = 0.5, championship }) {
  const completed = events.filter((e) => e.meeting.key !== next.key && e.race);
  const weekend = events.find((e) => e.meeting.key === next.key) || null;
  const nRaces = completed.length;

  // ---- 1. Per-driver raw signals -------------------------------------------
  const sig = new Map();
  for (const d of drivers) {
    sig.set(d.number, {
      race: [],
      quali: [],
      track: [],
      starts: 0,
      dnfs: 0,
    });
  }

  completed.forEach((e, idx) => {
    const age = nRaces - 1 - idx;
    const w = DECAY ** age;
    const sameType = e.circuitType === next.circuitType;

    for (const r of e.race || []) {
      const s = sig.get(r.driver_number);
      if (!s) continue;
      s.starts++;
      if (r.dnf || r.dns || r.dsq || !r.position) {
        s.dnfs++;
        continue;
      }
      s.race.push({ v: r.position, w });
      if (sameType) s.track.push(r.position);
    }
    for (const r of e.sprint || []) {
      const s = sig.get(r.driver_number);
      if (s && r.position && !r.dnf) s.race.push({ v: r.position, w: w * 0.5 });
    }
    for (const r of e.quali || []) {
      const s = sig.get(r.driver_number);
      if (s && r.position) s.quali.push({ v: r.position, w });
    }
    for (const r of e.sprintQuali || []) {
      const s = sig.get(r.driver_number);
      if (s && r.position) s.quali.push({ v: r.position, w: w * 0.5 });
    }
  });

  // History by driver acronym (numbers change between seasons).
  const histByCode = new Map();
  history.forEach((ed, i) => {
    const w = 1 / (1 + i * 0.5); // most recent edition counts most
    for (const r of ed.results) {
      const code = r.driver?.acronym;
      if (!code) continue;
      const pos = r.dnf || r.dns || r.dsq || !r.position ? 16 : r.position;
      if (!histByCode.has(code)) histByCode.set(code, []);
      histByCode.get(code).push({ v: pos, w });
    }
  });

  // ---- 2. Ratings ----------------------------------------------------------
  const rows = drivers.map((d) => {
    const s = sig.get(d.number);
    const form = weightedMean(s.race, DEFAULT_POS);
    const formN = s.race.length;
    const quali = weightedMean(s.quali, form);
    const track = shrink(s.track, form, 3);
    const histSamples = histByCode.get(d.acronym) || [];
    const histRaw = weightedMean(histSamples, form);
    const history = (histRaw * histSamples.length + form * 2) / (histSamples.length + 2);
    return { d, s, form, formN, quali, track, history, histN: histSamples.length };
  });

  // Team form = mean of teammates' form.
  const teamForm = new Map();
  for (const r of rows) {
    const t = teamForm.get(r.d.team) || [];
    t.push(r.form);
    teamForm.set(r.d.team, t);
  }

  for (const r of rows) {
    const tf = teamForm.get(r.d.team);
    r.team = tf.reduce((a, b) => a + b, 0) / tf.length;
    r.base =
      WEIGHTS.form * r.form +
      WEIGHTS.quali * r.quali +
      WEIGHTS.team * r.team +
      WEIGHTS.track * r.track +
      WEIGHTS.history * r.history;
    r.rating = r.base;
  }

  // ---- 3. This weekend's live data -----------------------------------------
  const stage = { practice: false, quali: false };
  if (weekend) {
    const practicePos = new Map();
    for (const session of weekend.practice) {
      for (const res of session) {
        if (!res.position) continue;
        const list = practicePos.get(res.driver_number) || [];
        list.push(res.position);
        practicePos.set(res.driver_number, list);
      }
    }
    if (practicePos.size) {
      stage.practice = true;
      for (const r of rows) {
        const list = practicePos.get(r.d.number);
        if (!list) continue;
        r.practice = list.reduce((a, b) => a + b, 0) / list.length;
        r.rating = 0.82 * r.rating + 0.18 * r.practice;
      }
    }
    if (weekend.quali) {
      stage.quali = true;
      const grid = new Map(weekend.quali.map((q) => [q.driver_number, q.position]));
      for (const r of rows) {
        const g = grid.get(r.d.number);
        if (!g) continue;
        r.grid = g;
        r.rating = 0.45 * r.rating + 0.55 * g;
      }
    }
  }

  for (const r of rows) if (!Number.isFinite(r.rating)) r.rating = DEFAULT_POS;

  // ---- 4. Reliability ------------------------------------------------------
  const street = /street/i.test(next.circuitType);
  for (const r of rows) {
    const base = (r.s.dnfs + 0.8) / (r.s.starts + 10); // Beta(0.8, 9.2) prior ≈ 8%
    r.dnfProb = Math.min(0.35, base * (street ? 1.25 : 1) * (1 + 0.3 * rainProb));
  }

  // ---- 5. Monte Carlo ------------------------------------------------------
  const sigma = 2.3 * (1 + 0.7 * rainProb) * (1 + 0.25 * scProb) * (street ? 1.1 : 1);
  const n = rows.length;
  const finishCounts = rows.map(() => new Float64Array(n));
  const dnfCounts = new Float64Array(n);
  const pointsSum = new Float64Array(n);
  const rankSum = new Float64Array(n);
  let clinchCount = 0;

  const champIdx = championship ? rows.findIndex((r) => r.d.number === championship.leader) : -1;
  const rivalIdx = championship
    ? championship.rivals.map((rv) => ({ idx: rows.findIndex((r) => r.d.number === rv.number), pts: rv.points }))
    : [];

  const perf = new Float64Array(n);
  const order = new Int32Array(n);
  const points = new Float64Array(n);
  for (let sim = 0; sim < SIMS; sim++) {
    for (let i = 0; i < n; i++) {
      const out = Math.random() < rows[i].dnfProb;
      perf[i] = rows[i].rating + gaussian() * sigma + (out ? 1000 : 0);
      order[i] = i;
    }
    order.sort((a, b) => perf[a] - perf[b]);
    points.fill(0);
    for (let pos = 0; pos < n; pos++) {
      const i = order[pos];
      rankSum[i] += pos + 1;
      if (perf[i] >= 500) {
        dnfCounts[i]++;
        continue;
      }
      finishCounts[i][pos]++;
      const pts = RACE_POINTS[pos] || 0;
      points[i] = pts;
      pointsSum[i] += pts;
    }
    if (champIdx >= 0) {
      const leaderPts = championship.leaderPoints + points[champIdx];
      let clinched = true;
      for (const rv of rivalIdx) {
        const rp = rv.pts + (rv.idx >= 0 ? points[rv.idx] : 0);
        if (leaderPts - rp <= championship.maxAfter) {
          clinched = false;
          break;
        }
      }
      if (clinched) clinchCount++;
    }
  }

  const out = rows.map((r, i) => {
    const fc = finishCounts[i];
    const sum = (a, b) => {
      let s = 0;
      for (let k = a; k < Math.min(b, n); k++) s += fc[k];
      return s / SIMS;
    };
    let mode = 0;
    for (let k = 1; k < n; k++) if (fc[k] > fc[mode]) mode = k;
    return {
      ...r,
      win: sum(0, 1),
      podium: sum(0, 3),
      points: sum(0, 10),
      dnf: dnfCounts[i] / SIMS,
      expPoints: pointsSum[i] / SIMS,
      meanRank: rankSum[i] / SIMS,
      likely: mode + 1,
      distribution: Array.from(fc, (c) => c / SIMS),
    };
  });
  // Predicted order = expected points (ties broken by mean finishing rank),
  // which keeps the order consistent with the win / podium odds.
  out.sort((a, b) => b.expPoints - a.expPoints || a.meanRank - b.meanRank);
  out.forEach((r, i) => (r.predicted = i + 1));

  // ---- 6. Qualifying / pole -------------------------------------------------
  const pole = predictPole(out, weekend);

  return {
    rows: out,
    pole,
    sigma,
    stage,
    sims: SIMS,
    racesUsed: nRaces,
    clinchProb: champIdx >= 0 ? clinchCount / SIMS : null,
  };
}

function predictPole(rows, weekend) {
  if (weekend?.quali) {
    const p = weekend.quali.find((q) => q.position === 1);
    return { actual: true, number: p?.driver_number, probs: [] };
  }
  const n = rows.length;
  const wins = new Float64Array(n);
  const N = 8000;
  const ratings = rows.map((r) => 0.6 * r.quali + 0.25 * r.team + 0.15 * (r.practice ?? r.form));
  for (let s = 0; s < N; s++) {
    let best = -1;
    let bestV = Infinity;
    for (let i = 0; i < n; i++) {
      const v = ratings[i] + gaussian() * 1.9;
      if (v < bestV) {
        bestV = v;
        best = i;
      }
    }
    wins[best]++;
  }
  const probs = rows
    .map((r, i) => ({ number: r.d.number, p: wins[i] / N }))
    .sort((a, b) => b.p - a.p);
  return { actual: false, number: probs[0]?.number, probs };
}

/** Safety-car likelihood from venue history, shrunk toward the F1-wide ~55%. */
export function safetyCarProbability(history) {
  const prior = 0.55;
  const k = 2;
  const known = history.filter((h) => h.raceControlKnown !== false);
  const hits = known.filter((h) => h.safetyCars + h.virtualSafetyCars > 0).length;
  return (hits + prior * k) / (known.length + k);
}
