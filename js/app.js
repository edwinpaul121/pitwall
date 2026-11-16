import {
  loadSeason,
  loadNextContext,
  seasonEvents,
  weatherAt,
  pointsRemaining,
  ensureDrivers,
  RACE_POINTS,
} from './data.js';
import { predict, safetyCarProbability, WEIGHTS } from './predict.js';
import { setThrottleListener } from './api.js';
import { CIRCUITS } from './circuits.js';
import { loadNews, tagArticles, topTags } from './news.js';
import { mountLive, unmountLive, liveSessionNow } from './live.js';
import {
  esc,
  pct,
  tint,
  trackTime,
  localTime,
  dateRange,
  meetingDates,
  lapTime,
  raceTime,
  shortName,
  firstName,
  ordinal,
  KEEP_UPPER,
  prettyOfficial,
  ICON,
  icon,
  wxInfo,
  isNight,
  compass,
  driverCell,
  $,
} from './util.js';

const state = { season: null, ctx: null, prediction: null, resultsMeeting: null, resultsSession: 'Race', standingsView: 'drivers' };

// ---------------------------------------------------------------- helpers
const driver = (n) =>
  state.season.drivers.get(n) || { number: n, acronym: `#${n}`, name: `Car ${n}`, team: '—', colour: '#86868b', headshot: null, last: `#${n}` };


function progress(msg) {
  const el = $('#progress');
  if (el) el.textContent = `${msg}…`;
  $('#ribbon').textContent = `${msg}…`;
}

// ---------------------------------------------------------------- icons

// ---------------------------------------------------------------- boot
async function main(force = false) {
  const btn = $('#refresh');
  btn.classList.add('spinning');
  if (force) {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('pitwall:'))
        .forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  }
  try {
    const season = await loadSeason(progress);
    state.season = season;
    markLive();
    if (state.page !== 'overview') route();
    if (!state.resultsMeeting) {
      const done = season.gps.filter((m) => m.status === 'done');
      state.resultsMeeting = done[done.length - 1]?.key ?? null;
    }
    renderHero();
    renderStandings();
    renderResults();
    renderCalendar();

    if (season.next) {
      skeleton('#weekend');
      skeleton('#weather');
      skeleton('#prediction');
      state.ctx = await loadNextContext(season, progress);
      renderHero();
      renderWeekend();
      renderWeather();
      runPrediction();
      if (state.page === 'news' && state.news) renderNews();
    }
    const n = season.next;
    $('#ribbon').innerHTML = n
      ? `Next up: ${esc(n.name)}, ${esc(meetingDates(n))}. <a href="#prediction">See who’s favourite ›</a>`
      : `The ${season.year} season is complete. <a href="#standings">Final standings ›</a>`;
    $('#updated').textContent = `Updated ${new Date().toLocaleString()}.`;
  } catch (err) {
    console.error(err);
    $('#ribbon').innerHTML = `Couldn’t reach OpenF1 (${esc(err.message)}). <a href="#" id="retry">Try again ›</a>`;
    $('#retry')?.addEventListener('click', (e) => {
      e.preventDefault();
      main(true);
    });
  } finally {
    btn.classList.remove('spinning');
  }
}

function skeleton(sel) {
  const el = $(sel);
  el.hidden = false;
  if (!el.innerHTML.trim()) el.innerHTML = `<div class="wrap"><div class="skeleton"></div></div>`;
}

// ---------------------------------------------------------------- hero
let countdownTimer = null;
function renderHero() {
  const { season, ctx } = state;
  const m = season.next;
  const el = $('#hero');
  if (!m) {
    const champ = season.standings.drivers[0];
    const d = champ ? driver(champ.number) : null;
    el.innerHTML = `<div class="wrap hero-loading fade-in">
      <p class="eyebrow">${season.year} season</p>
      <h1 class="display">That’s a wrap.</h1>
      ${d ? `<p class="hero-sub">${esc(d.name)} is the ${season.year} World Champion with ${champ.points} points.</p>` : ''}
    </div>`;
    return;
  }
  const race = m.sessions.find((s) => s.name === 'Race');
  const totalRounds = season.gps.filter((g) => !g.cancelled).length;
  const circuit = ctx?.circuit || CIRCUITS[m.circuitKey];
  const laps = ctx?.history?.find((h) => h.laps)?.laps;
  const lastWinner = ctx?.history?.[0]?.results?.find((r) => r.position === 1)?.driver;
  const sprint = m.sessions.some((s) => s.name === 'Sprint');
  const titleWord = m.name.replace(/ Grand Prix$/, '');

  el.innerHTML = `
    <div class="wrap fade-in">
      <p class="badge-new">${m.status === 'live' ? 'Live this weekend' : 'Next race'}</p>
      <p class="eyebrow">Round ${m.round} of ${totalRounds}${sprint ? ' · Sprint weekend' : ''}</p>
      <h1 class="display">${esc(titleWord)}.</h1>
      <p class="hero-sub">${esc(prettyOfficial(m.official || m.name))}<br>${esc(circuit?.name || m.circuitShort)} · ${esc(meetingDates(m))}</p>
      <div class="countdown" id="countdown" aria-live="off"></div>
      <div class="hero-cta">
        <a class="btn btn-primary" href="#prediction">See the prediction</a>
        <a class="arrow-link" href="#weekend">Weekend schedule</a>
      </div>
    </div>
    <div class="hero-stage fade-in">
      <div class="hero-visual">
        ${m.circuitImage ? `<img src="${esc(m.circuitImage)}" alt="${esc(m.circuitShort)} circuit layout" loading="eager">` : '<div></div>'}
        <div class="facts">
          <div class="fact"><b>${circuit?.length ? `${circuit.length.toFixed(3)} km` : '—'}</b><span>Lap length</span></div>
          <div class="fact"><b>${laps || '—'}</b><span>Race laps${laps ? '' : ' (TBC)'}</span></div>
          <div class="fact"><b>${laps && circuit?.length ? `${(laps * circuit.length).toFixed(1)} km` : '—'}</b><span>Race distance</span></div>
          <div class="fact"><b>${esc(m.circuitType.replace('Temporary - ', ''))}</b><span>Circuit type</span></div>
          <div class="fact"><b>${lastWinner ? esc(shortName(lastWinner)) : ctx ? 'New venue' : '—'}</b><span>${lastWinner ? `Won here in ${ctx.history[0].year}` : 'Last winner'}</span></div>
          <div class="fact"><b>${race ? esc(trackTime(race.start, m.gmtOffset, { hour: '2-digit', minute: '2-digit' })) : '—'}</b><span>Race start, local time</span></div>
        </div>
      </div>
    </div>`;

  clearInterval(countdownTimer);
  const target = race?.start || m.start;
  const tick = () => {
    const box = $('#countdown');
    if (!box) return clearInterval(countdownTimer);
    let ms = Math.max(0, target - Date.now());
    const d = Math.floor(ms / 864e5);
    ms -= d * 864e5;
    const h = Math.floor(ms / 36e5);
    ms -= h * 36e5;
    const mi = Math.floor(ms / 6e4);
    const s = Math.floor((ms - mi * 6e4) / 1000);
    box.innerHTML = [
      [d, 'Days'],
      [h, 'Hours'],
      [mi, 'Minutes'],
      [s, 'Seconds'],
    ]
      .map(([v, l]) => `<div><b>${String(v).padStart(2, '0')}</b><span>${l}</span></div>`)
      .join('');
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

// ---------------------------------------------------------------- weekend
function renderWeekend() {
  const { season, ctx } = state;
  const m = season.next;
  const el = $('#weekend');
  el.hidden = false;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cards = m.sessions
    .map((s) => {
      const wx = weatherAt(ctx?.weather, s.start);
      const info = wx ? wxInfo(wx.code, isNight(s.start, m.gmtOffset)) : null;
      const res = season.results.get(s.key);
      const top = res?.find((r) => r.position === 1);
      const done = s.end < season.now;
      const live = s.start <= season.now && !done;
      return `<div class="card session-card ${done ? 'done' : ''}">
        <div class="name">${esc(s.name)}${live ? ' · <span class="state">Live</span>' : ''}</div>
        <div class="day">${esc(trackTime(s.start, m.gmtOffset, { weekday: 'long' }))}</div>
        <div class="time">${esc(trackTime(s.start, m.gmtOffset, { hour: '2-digit', minute: '2-digit' }))}–${esc(trackTime(s.end, m.gmtOffset, { hour: '2-digit', minute: '2-digit' }))} <span class="muted small">local</span></div>
        <div class="yours">${esc(localTime(s.start, { weekday: 'short', hour: '2-digit', minute: '2-digit' }))} your time</div>
        ${
          top
            ? `<div class="winner">Fastest: <b>${esc(shortName(driver(top.driver_number)))}</b></div>`
            : info
              ? `<div class="wx">${icon(info.icon, 22)}<span>${Math.round(wx.temp)}° · ${wx.rain}% rain</span></div>`
              : `<div class="wx muted">${icon('cloud', 22)}<span>Forecast soon</span></div>`
        }
      </div>`;
    })
    .join('');
  el.innerHTML = `<div class="wrap fade-in">
    <div class="section-head">
      <h2 class="headline">The weekend.</h2>
      <p>Every session at ${esc(m.circuitShort)}, in track time and yours (${esc(tz.replace(/_/g, ' '))}).</p>
    </div>
    <div class="grid grid-${Math.min(5, m.sessions.length)}">${cards}</div>
  </div>`;
}

// ---------------------------------------------------------------- weather
function renderWeather() {
  const { season, ctx } = state;
  const m = season.next;
  const el = $('#weather');
  el.hidden = false;
  const race = m.sessions.find((s) => s.name === 'Race');
  const wx = race ? weatherAt(ctx?.weather, race.start) : null;
  const last = ctx?.lastConditions;
  const night = race ? isNight(race.start, m.gmtOffset) : false;
  const info = wx ? wxInfo(wx.code, night) : null;
  const lastYear = ctx?.history?.[0]?.year;

  let hourly = '';
  if (ctx?.weather?.hourly && race) {
    const h = ctx.weather.hourly;
    const raceHour = new Date(race.start);
    raceHour.setUTCMinutes(0, 0, 0);
    const startIdx = h.time.indexOf(new Date(raceHour - 5 * 36e5).toISOString().slice(0, 13) + ':00');
    if (startIdx >= 0) {
      const cells = [];
      for (let i = startIdx; i < Math.min(h.time.length, startIdx + 10); i++) {
        const t = new Date(h.time[i] + 'Z');
        const isRace = t >= raceHour && t < new Date(race.end);
        const ic = wxInfo(h.weather_code[i], isNight(t, m.gmtOffset));
        cells.push(`<div class="hour ${isRace ? 'race' : ''}">
          <span class="t">${isRace && +t === +raceHour ? 'Lights out' : esc(trackTime(t, m.gmtOffset, { hour: 'numeric' }))}</span>
          ${icon(ic.icon, 22)}
          <b>${Math.round(h.temperature_2m[i])}°</b>
          <span class="rain">${h.precipitation_probability[i] ? `${h.precipitation_probability[i]}%` : ''}</span>
        </div>`);
      }
      hourly = `<div class="card" style="margin-top:20px">
        <h3 class="subhead" style="font-size:21px;margin-bottom:12px">Race day, hour by hour.</h3>
        <div class="hourly">${cells.join('')}</div>
        <p class="micro" style="margin:8px 0 0">Track-local time. Highlighted hours cover the race.</p>
      </div>`;
    }
  }

  const main = wx
    ? `<div class="card wx-main">
        <div>
          <div class="muted small">Race start · ${esc(trackTime(race.start, m.gmtOffset, { weekday: 'long', hour: '2-digit', minute: '2-digit' }))}</div>
          <div style="margin-top:20px;color:var(--deep-gray)">${icon(info.icon, 56)}</div>
        </div>
        <div>
          <div class="wx-temp">${Math.round(wx.temp)}°</div>
          <div class="wx-desc">${esc(info.text)} in ${esc(m.location)}.</div>
        </div>
      </div>`
    : `<div class="card wx-main">
        <div class="muted small">Race-day forecast</div>
        <div>
          <div class="wx-temp" style="font-size:56px">Too early to call.</div>
          <div class="wx-desc">The 16-day forecast doesn’t reach race day yet. Here’s what conditions were like last time.</div>
        </div>
      </div>`;

  const stats = [];
  if (wx) {
    stats.push(stat('drop', 'Chance of rain', `${wx.rain}%`, wx.precip ? `${wx.precip.toFixed(1)} mm expected` : 'Dry race expected'));
    stats.push(stat('wind', 'Wind', `${Math.round(wx.wind)} km/h`, `From the ${compass(wx.windDir)}`));
    stats.push(stat('cloud', 'Humidity', `${Math.round(wx.humidity)}%`, `${Math.round(wx.cloud)}% cloud cover`));
  }
  if (last) {
    stats.push(
      stat('thermo', `Track temp, ${lastYear}`, `${Math.round(last.track)}°`, `${Math.round(last.trackMin)}–${Math.round(last.trackMax)}° range · air ${Math.round(last.air)}°`)
    );
    if (!wx) {
      stats.push(stat('drop', `Rain in ${lastYear}`, last.rained ? 'Yes' : 'None', last.rained ? 'Rain fell during the race' : 'A dry race'));
      stats.push(stat('wind', `Wind, ${lastYear}`, `${(last.wind * 3.6).toFixed(0)} km/h`, `Humidity ${Math.round(last.humidity)}%`));
    }
  }

  el.innerHTML = `<div class="wrap fade-in">
    <div class="section-head">
      <h2 class="headline">The forecast.</h2>
      <p>Live forecast for ${esc(ctx?.circuit?.name || m.circuitShort)} from Open-Meteo, with last year’s on-track readings from OpenF1.</p>
    </div>
    <div class="wx-hero">
      ${main}
      <div class="card wx-stats">${stats.join('') || '<p class="muted">No weather data available.</p>'}</div>
    </div>
    ${hourly}
  </div>`;
}
const stat = (ic, label, value, note) =>
  `<div class="wx-stat"><span class="label">${icon(ic, 16)} ${esc(label)}</span><b>${esc(value)}</b><span class="note">${esc(note)}</span></div>`;

// ---------------------------------------------------------------- prediction
function runPrediction() {
  const { season, ctx } = state;
  const m = season.next;
  const events = seasonEvents(season);
  const drivers = [...season.drivers.values()].filter((d) =>
    season.lastRace ? (season.results.get(season.lastRace.s.key) || []).some((r) => r.driver_number === d.number) : true
  );
  const race = m.sessions.find((s) => s.name === 'Race');
  const wx = race ? weatherAt(ctx?.weather, race.start) : null;
  const rainProb = wx ? wx.rain / 100 : ctx?.lastConditions?.rained ? 0.3 : 0.1;
  const scProb = safetyCarProbability(ctx?.history || []);

  // Championship maths.
  const st = season.standings.drivers;
  const remIncl = pointsRemaining(season, m, true);
  const remAfter = pointsRemaining(season, m, false);
  let champ = null;
  let champStatus = null;
  if (st.length >= 2) {
    const leader = st[0];
    const gap = leader.points - st[1].points;
    if (gap > remIncl.driver) {
      champStatus = { type: 'decided', leader, gap };
    } else {
      const rivals = st.slice(1).filter((r) => r.points + remIncl.driver >= leader.points);
      champ = { leader: leader.number, leaderPoints: leader.points, rivals, maxAfter: remAfter.driver };
      champStatus = { type: 'open', leader, gap, rivals, remIncl };
    }
  }

  const result = predict({ drivers, events, next: m, history: ctx?.history || [], rainProb, scProb, championship: champ });
  state.prediction = { result, rainProb, scProb, champStatus, remIncl };
  renderPrediction();
}

function renderPrediction() {
  const { season, ctx } = state;
  const { result, rainProb, scProb, champStatus } = state.prediction;
  const m = season.next;
  const el = $('#prediction');
  el.hidden = false;
  const rows = result.rows;
  const podiumByRank = rows.slice(0, 3);

  const stageText = result.stage.quali
    ? 'Updated with the qualifying grid'
    : result.stage.practice
      ? 'Updated with this weekend’s practice'
      : 'Pre-weekend model';

  const podiumCard = (r, place) => {
    const d = r.d;
    return `<div class="podium-card p${place}" style="background:${tint(d.colour, 20)}">
      <div class="pos">Predicted ${ordinal(place)}</div>
      <div class="who">${esc(firstName(d))}<br>${esc(shortName(d))}</div>
      <div class="team">${esc(d.team)}</div>
      <div class="prob">
        <div><b>${pct(r.win)}</b><span>Win</span></div>
        <div><b>${pct(r.podium)}</b><span>Podium</span></div>
        <div><b>${r.expPoints.toFixed(1)}</b><span>Exp. points</span></div>
      </div>
      ${d.headshot ? `<img src="${esc(d.headshot)}" alt="${esc(d.name)}" loading="lazy">` : ''}
    </div>`;
  };

  // Insights
  const poleD = result.pole.number != null ? driver(result.pole.number) : null;
  const poleP = result.pole.probs[0]?.p;
  const hist = ctx?.history || [];
  const scDetail = hist.length
    ? hist.map((h) => `${h.year}: ${h.safetyCars ? `${h.safetyCars} SC` : ''}${h.safetyCars && h.virtualSafetyCars ? ' + ' : ''}${h.virtualSafetyCars ? `${h.virtualSafetyCars} VSC` : ''}${!h.safetyCars && !h.virtualSafetyCars ? 'none' : ''}`).join(' · ')
    : 'No previous races here, so this uses the F1-wide average.';
  const strat = ctx?.strategy;
  const stratValue = strat?.medianStops != null ? `${strat.medianStops} stop${strat.medianStops === 1 ? '' : 's'}` : '—';
  const cap = (s) => (s ? s[0] + s.slice(1).toLowerCase() : '');
  const stratNote = strat
    ? `Most cars started on ${cap(strat.startCompound)} in ${hist[0]?.year}. ${strat.winner ? `${shortName(strat.winner)} won with ${strat.winnerStints.map(cap).join(' → ')}.` : ''}`
    : 'No strategy data from a previous edition.';
  const darkHorse = rows
    .slice(3)
    .filter((r) => r.podium > 0)
    .sort((a, b) => b.podium - a.podium)[0];
  let champValue = '—';
  let champNote = '';
  if (champStatus?.type === 'decided') {
    champValue = `${shortName(driver(champStatus.leader.number))} is champion`;
    champNote = `${champStatus.gap} points clear with only ${state.prediction.remIncl.driver} left to play for.`;
  } else if (champStatus?.type === 'open') {
    champValue = result.clinchProb ? `${pct(result.clinchProb)} title tonight` : 'Title stays open';
    champNote = `${shortName(driver(champStatus.leader.number))} leads by ${champStatus.gap}. ${champStatus.rivals.length} driver${champStatus.rivals.length === 1 ? '' : 's'} can still catch them.`;
  }

  const insights = [
    {
      label: result.pole.actual ? 'Pole position' : 'Pole favourite',
      value: poleD ? shortName(poleD) : '—',
      note: result.pole.actual ? 'Confirmed in qualifying.' : poleP ? `${pct(poleP)} chance of pole, from qualifying form and team pace.` : '',
    },
    { label: 'Safety car', value: `${pct(scProb)} likely`, note: scDetail },
    { label: 'Expected strategy', value: stratValue, note: stratNote },
    {
      label: 'Rain risk',
      value: pct(rainProb),
      note: rainProb > 0.3 ? 'Wet weather widens the field — the model adds extra randomness.' : 'Dry conditions favour the form book.',
    },
    {
      label: 'Dark horse',
      value: darkHorse ? shortName(darkHorse.d) : '—',
      note: darkHorse ? `${pct(darkHorse.podium)} podium chance from P${darkHorse.predicted} on the predicted order.` : '',
    },
    { label: 'Championship', value: champValue, note: champNote },
  ];

  const tableRows = rows
    .map((r) => {
      const d = r.d;
      const bar = (p) =>
        `<div class="probcell"><span class="bar hide-sm"><i style="width:${Math.min(100, p * 100)}%;background:${d.colour}"></i></span><span>${pct(p)}</span></div>`;
      return `<tr class="expandable" data-num="${d.number}">
        <td class="pos-cell">${r.predicted}</td>
        <td><div class="driver-cell"><span class="team-bar" style="background:${d.colour}"></span><div><div class="nm">${esc(d.name)}</div><div class="tm">${esc(d.team)}</div></div></div></td>
        <td class="num">${bar(r.win)}</td>
        <td class="num">${bar(r.podium)}</td>
        <td class="num hide-md">${pct(r.points)}</td>
        <td class="num">${r.expPoints.toFixed(1)}</td>
        <td class="num hide-sm">${pct(r.dnf)}</td>
      </tr>`;
    })
    .join('');

  const weights = [
    ['Recent race form', WEIGHTS.form],
    ['Qualifying pace', WEIGHTS.quali],
    ['Team strength', WEIGHTS.team],
    ['Venue history', WEIGHTS.history],
    [`${m.circuitType.replace('Temporary - ', '')} circuit form`, WEIGHTS.track],
  ];

  el.innerHTML = `<div class="wrap fade-in">
    <div class="section-head">
      <p class="badge-new" style="margin-bottom:8px">${esc(stageText)}</p>
      <h2 class="headline">The prediction.</h2>
      <p>${result.sims.toLocaleString()} simulated ${esc(m.name)}s, built from ${result.racesUsed} races of ${season.year} form, ${hist.length} previous edition${hist.length === 1 ? '' : 's'} at ${esc(m.circuitShort)} and the race-day forecast.</p>
    </div>

    <div class="podium">
      ${podiumByRank[1] ? podiumCard(podiumByRank[1], 2) : ''}
      ${podiumByRank[0] ? podiumCard(podiumByRank[0], 1) : ''}
      ${podiumByRank[2] ? podiumCard(podiumByRank[2], 3) : ''}
    </div>

    <div class="grid grid-3 insights">
      ${insights
        .map(
          (i) => `<div class="card insight"><span class="label">${esc(i.label)}</span><b>${esc(i.value)}</b><p>${esc(i.note)}</p></div>`
        )
        .join('')}
    </div>

    <div class="card table-card">
      <div class="table-head">
        <h3 class="subhead" style="margin:0">Full grid odds.</h3>
        <span class="micro">Tap a driver to see what drives their number.</span>
      </div>
      <div class="scroll-x">
        <table class="ptable" id="ptable">
          <thead><tr><th>Pred.</th><th>Driver</th><th class="num">Win</th><th class="num">Podium</th><th class="num hide-md">Points</th><th class="num">Exp. pts</th><th class="num hide-sm">DNF</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>

    <div class="card method">
      <div>
        <h3 class="subhead">How it works.</h3>
        <ol>
          <li>Each driver gets a pace rating in finishing-position units, blended from the factors on the right. Recent races count most — each older race is worth 18% less.</li>
          <li>Thin data is shrunk toward the driver’s overall form, so one lucky result can’t dominate. Venue history is matched by driver code across seasons.</li>
          <li>As the weekend runs, practice order and then the qualifying grid are blended in automatically.</li>
          <li>Reliability is a smoothed DNF rate per driver, raised on street circuits and in the wet.</li>
          <li>The race is simulated ${result.sims.toLocaleString()} times with race-day randomness of ±${result.sigma.toFixed(1)} positions — wider when rain or safety cars are likely.</li>
        </ol>
      </div>
      <div class="weights">
        <h3 class="subhead" style="margin-bottom:4px">What matters.</h3>
        ${weights
          .map(
            ([label, w]) =>
              `<div class="weight-row"><span>${esc(label)}</span><span class="bar"><i style="width:${(w / 0.34) * 100}%"></i></span><span class="num">${Math.round(w * 100)}%</span></div>`
          )
          .join('')}
        <p class="micro" style="margin-top:8px">Practice: 18% of the final rating once available. Qualifying grid: 55% once set.</p>
      </div>
    </div>
  </div>`;

  $('#ptable').addEventListener('click', (e) => {
    const tr = e.target.closest('tr.expandable');
    if (!tr) return;
    const next = tr.nextElementSibling;
    if (next?.classList.contains('detail')) {
      next.remove();
      return;
    }
    const r = rows.find((x) => x.d.number === Number(tr.dataset.num));
    const detail = document.createElement('tr');
    detail.className = 'detail';
    const maxP = Math.max(...r.distribution, 0.0001);
    const chips = [
      ['Race form', `P${r.form.toFixed(1)}`, `${r.formN} results`],
      ['Qualifying', `P${r.quali.toFixed(1)}`, ''],
      ['Team', `P${r.team.toFixed(1)}`, ''],
      ['Circuit type', `P${r.track.toFixed(1)}`, ''],
      ['At this venue', r.histN ? `P${r.history.toFixed(1)}` : 'No data', r.histN ? `${r.histN} starts` : ''],
      r.practice != null ? ['Practice avg', `P${r.practice.toFixed(1)}`, ''] : null,
      r.grid != null ? ['Grid', `P${r.grid}`, ''] : null,
      ['Retirement risk', pct(r.dnfProb, 1), ''],
      ['Most likely finish', `P${r.likely}`, ''],
    ].filter(Boolean);
    detail.innerHTML = `<td colspan="7">
      <div class="chips">${chips.map(([k, v, n]) => `<span class="chip">${esc(k)} <b>${esc(v)}</b>${n ? ` · ${esc(n)}` : ''}</span>`).join('')}</div>
      <div class="dist">${r.distribution.map((p, i) => `<i style="height:${Math.max(1, (p / maxP) * 40)}px;background:${r.d.colour}" title="P${i + 1}: ${pct(p, 1)}"></i>`).join('')}</div>
      <div class="dist-axis">${r.distribution.map((_, i) => `<span>${(i + 1) % 5 === 0 || i === 0 ? i + 1 : ''}</span>`).join('')}</div>
      <p class="micro" style="padding:4px 16px 12px;margin:0">Finishing-position distribution across ${result.sims.toLocaleString()} simulations.</p>
    </td>`;
    tr.after(detail);
  });
}

// ---------------------------------------------------------------- standings
function renderStandings() {
  const { season } = state;
  const el = $('#standings');
  const st = season.standings;
  if (!st.drivers.length) return;
  el.hidden = false;
  const view = state.standingsView;
  const leader = st.drivers[0];
  const rem = season.next ? pointsRemaining(season, season.next, true) : { driver: 0, team: 0 };
  const decided = st.drivers[1] && leader.points - st.drivers[1].points > rem.driver;
  const teamColour = (team) => [...season.drivers.values()].find((d) => d.team === team)?.colour || '#86868b';

  let banner = '';
  if (decided) {
    const d = driver(leader.number);
    banner = `<div class="card champ-banner" style="background:${tint(d.colour, 18)}">
      <div class="txt">
        <div class="k">${season.next ? 'Mathematically confirmed' : `${season.year} World Champion`}</div>
        <h3>${esc(d.name)} is the ${season.year} World Champion.</h3>
        <div class="small" style="color:var(--deep-gray)">${leader.points} points · ${leader.points - st.drivers[1].points} clear with ${rem.driver} left to play for.</div>
      </div>
      ${d.headshot ? `<img src="${esc(d.headshot)}" alt="">` : ''}
    </div>`;
  }

  let body;
  if (view === 'drivers') {
    const cards = st.drivers
      .slice(0, 3)
      .map((r) => {
        const d = driver(r.number);
        return `<div class="leader-card" style="background:${tint(d.colour, 17)}">
          <div class="pos">${ordinal(r.position)} · ${esc(d.team)}</div>
          <div class="who">${esc(d.name)}</div>
          <div class="pts">${r.points}<small> pts</small></div>
          ${d.headshot ? `<img src="${esc(d.headshot)}" alt="" loading="lazy">` : ''}
        </div>`;
      })
      .join('');
    const rows = st.drivers
      .map((r) => {
        const d = driver(r.number);
        const t = season.tally.get(r.number) || { wins: 0, podiums: 0 };
        const gap = leader.points - r.points;
        return `<tr>
          <td class="pos-cell">${r.position}</td>
          <td><div class="driver-cell"><span class="team-bar" style="background:${d.colour}"></span><div><div class="nm">${esc(d.name)}</div><div class="tm">${esc(d.team)}</div></div></div></td>
          <td class="num"><b>${r.points}</b></td>
          <td class="num hide-sm">${gap ? `−${gap}` : '—'}</td>
          <td class="num">${t.wins}</td>
          <td class="num hide-sm">${t.podiums}</td>
          <td class="num hide-md">${r.gained ? `+${r.gained}` : '—'} ${r.delta > 0 ? `<span class="delta-up">▲${r.delta}</span>` : r.delta < 0 ? `<span class="delta-down">▼${-r.delta}</span>` : ''}</td>
        </tr>`;
      })
      .join('');
    body = `<div class="leader-cards">${cards}</div>
      <div class="card table-card" style="margin-top:0"><div class="scroll-x"><table class="ptable">
        <thead><tr><th>Pos</th><th>Driver</th><th class="num">Points</th><th class="num hide-sm">Gap</th><th class="num">Wins</th><th class="num hide-sm">Podiums</th><th class="num hide-md">Last race</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`;
  } else {
    const max = st.teams[0]?.points || 1;
    const rows = st.teams
      .map((r) => {
        const c = teamColour(r.team);
        const gap = st.teams[0].points - r.points;
        return `<tr>
          <td class="pos-cell">${r.position}</td>
          <td><div class="driver-cell"><span class="team-bar" style="background:${c}"></span><div class="nm">${esc(r.team)}</div></div></td>
          <td class="hide-sm" style="width:40%"><span class="gap-bar" style="width:${(r.points / max) * 100}%;background:${c}"></span></td>
          <td class="num"><b>${r.points}</b></td>
          <td class="num hide-sm">${gap ? `−${gap}` : '—'}</td>
          <td class="num hide-md">${r.gained ? `+${r.gained}` : '—'}</td>
        </tr>`;
      })
      .join('');
    body = `<div class="card table-card" style="margin-top:0"><div class="scroll-x"><table class="ptable">
      <thead><tr><th>Pos</th><th>Team</th><th class="hide-sm"></th><th class="num">Points</th><th class="num hide-sm">Gap</th><th class="num hide-md">Last race</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
  }

  el.innerHTML = `<div class="wrap fade-in">
    <div class="section-head">
      <h2 class="headline">The championship.</h2>
      <p>Standings after the ${esc(season.lastRace?.m.name || 'latest race')}. ${rem.races ? `${rem.races} race${rem.races === 1 ? '' : 's'}${rem.sprints ? ` and ${rem.sprints} sprint${rem.sprints === 1 ? '' : 's'}` : ''} to go — ${rem.driver} points still available.` : ''}</p>
    </div>
    ${banner}
    <div style="margin-bottom:24px" class="segmented" role="group" aria-label="Standings view">
      <button data-view="drivers" aria-pressed="${view === 'drivers'}">Drivers</button>
      <button data-view="teams" aria-pressed="${view === 'teams'}">Constructors</button>
    </div>
    ${body}
  </div>`;
  el.querySelectorAll('.segmented button').forEach((b) =>
    b.addEventListener('click', () => {
      state.standingsView = b.dataset.view;
      renderStandings();
    })
  );
}

// ---------------------------------------------------------------- results
const SESSION_ORDER = ['Race', 'Sprint', 'Qualifying', 'Sprint Qualifying', 'Practice 3', 'Practice 2', 'Practice 1'];

async function renderResults() {
  const { season } = state;
  const el = $('#results');
  const done = season.gps.filter((m) => m.sessions.some((s) => season.results.has(s.key)));
  if (!done.length) return;
  el.hidden = false;
  const m = done.find((x) => x.key === state.resultsMeeting) || done[done.length - 1];
  const available = SESSION_ORDER.filter((n) => m.sessions.some((s) => s.name === n && season.results.has(s.key)));
  if (!available.includes(state.resultsSession)) state.resultsSession = available[0];
  const session = m.sessions.find((s) => s.name === state.resultsSession);
  const rows = season.results.get(session.key) || [];
  await ensureDrivers(season, session.key, rows.map((r) => r.driver_number));

  const kind = /Qualifying/.test(session.name) ? 'quali' : /Practice/.test(session.name) ? 'practice' : 'race';
  const winner = rows.find((r) => r.position === 1);

  const fmtGap = (r) => {
    if (r.dsq) return '<span class="status-tag dnf">DSQ</span>';
    if (r.dns) return '<span class="status-tag dnf">DNS</span>';
    if (r.dnf) return '<span class="status-tag dnf">DNF</span>';
    if (r.position === 1) return kind === 'race' ? raceTime(r.duration) : lapTime(r.duration);
    const g = r.gap_to_leader;
    if (typeof g === 'number') return `+${g.toFixed(3)}s`;
    return esc(g ?? '—');
  };

  let head;
  let body;
  if (kind === 'quali') {
    head = `<th>Pos</th><th>Driver</th><th class="num">Q1</th><th class="num">Q2</th><th class="num">Q3</th>`;
    body = rows
      .map((r) => {
        const d = driver(r.driver_number);
        const t = Array.isArray(r.duration) ? r.duration : [r.duration];
        return `<tr><td class="pos-cell">${r.position ?? '—'}</td>${driverCell(d)}
          ${[0, 1, 2].map((i) => `<td class="num">${t[i] ? lapTime(t[i]) : '<span class="muted">—</span>'}</td>`).join('')}</tr>`;
      })
      .join('');
  } else if (kind === 'practice') {
    head = `<th>Pos</th><th>Driver</th><th class="num">Best lap</th><th class="num">Gap</th><th class="num hide-sm">Laps</th>`;
    body = rows
      .map((r) => {
        const d = driver(r.driver_number);
        const g = r.gap_to_leader;
        return `<tr><td class="pos-cell">${r.position ?? '—'}</td>${driverCell(d)}
          <td class="num">${lapTime(r.duration)}</td><td class="num">${r.position === 1 ? '—' : typeof g === 'number' ? `+${g.toFixed(3)}` : esc(g ?? '—')}</td>
          <td class="num hide-sm">${r.number_of_laps ?? '—'}</td></tr>`;
      })
      .join('');
  } else {
    head = `<th>Pos</th><th>Driver</th><th class="num hide-sm">Laps</th><th class="num">Time / gap</th><th class="num">Points</th>`;
    body = rows
      .map((r) => {
        const d = driver(r.driver_number);
        return `<tr><td class="pos-cell">${r.position ?? '—'}</td>${driverCell(d)}
          <td class="num hide-sm">${r.number_of_laps ?? '—'}</td><td class="num">${fmtGap(r)}</td><td class="num"><b>${r.points || ''}</b></td></tr>`;
      })
      .join('');
  }

  const dnfs = rows.filter((r) => r.dnf || r.dns || r.dsq).length;
  const meta =
    kind === 'race' && winner
      ? `<div class="result-meta">
          <div class="fact"><b>${esc(shortName(driver(winner.driver_number)))}</b><span>Winner · ${esc(driver(winner.driver_number).team)}</span></div>
          <div class="fact"><b>${raceTime(winner.duration)}</b><span>Race time</span></div>
          <div class="fact"><b>${winner.number_of_laps}</b><span>Laps</span></div>
          <div class="fact"><b>${dnfs}</b><span>Retirements</span></div>
        </div>`
      : '';

  el.innerHTML = `<div class="wrap fade-in">
    <div class="section-head">
      <h2 class="headline">Results.</h2>
      <p>Every classified session of the ${season.year} season. Pick a Grand Prix, then a session.</p>
    </div>
    <div class="results-controls">
      <select class="select-pill" id="res-meeting" aria-label="Grand Prix">
        ${done
          .slice()
          .reverse()
          .map((x) => `<option value="${x.key}" ${x.key === m.key ? 'selected' : ''}>Round ${x.round} · ${esc(x.name)}</option>`)
          .join('')}
      </select>
      <div class="segmented" role="group" aria-label="Session">
        ${available.map((n) => `<button data-s="${esc(n)}" aria-pressed="${n === session.name}">${esc(n.replace('Practice ', 'FP').replace('Sprint Qualifying', 'Sprint Quali'))}</button>`).join('')}
      </div>
    </div>
    <div class="card table-card" style="margin-top:0">
      ${meta}
      <div class="scroll-x"><table class="ptable"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    </div>
  </div>`;

  $('#res-meeting').addEventListener('change', (e) => {
    state.resultsMeeting = Number(e.target.value);
    renderResults();
  });
  el.querySelectorAll('.segmented button').forEach((b) =>
    b.addEventListener('click', () => {
      state.resultsSession = b.dataset.s;
      renderResults();
    })
  );
}
// ---------------------------------------------------------------- calendar
function renderCalendar() {
  const { season } = state;
  const el = $('#calendar');
  el.hidden = false;
  const doneCount = season.gps.filter((m) => m.status === 'done').length;
  const total = season.gps.filter((m) => !m.cancelled).length;
  const cards = season.gps
    .map((m) => {
      const race = m.sessions.find((s) => s.name === 'Race');
      const win = race && season.results.get(race.key)?.find((r) => r.position === 1);
      const d = win ? driver(win.driver_number) : null;
      const cls = m.cancelled ? 'cancelled' : m.isNext ? 'next' : '';
      const sprint = m.sessions.some((s) => s.name === 'Sprint');
      let foot = '';
      if (m.cancelled) foot = '<span class="muted">Cancelled</span>';
      else if (d) foot = `<span class="team-bar" style="background:${d.colour}"></span><span>${esc(shortName(d))}</span>`;
      else if (m.isNext) foot = '<span>Next race ›</span>';
      else foot = `<span class="muted">${esc(m.circuitType.replace('Temporary - ', ''))}</span>`;
      return `<button class="cal-card ${cls}" data-key="${m.key}" ${m.cancelled ? 'disabled' : ''}>
        <div class="rd"><span>${m.round ? `Round ${m.round}` : '—'}${sprint ? ' · Sprint' : ''}</span>${m.flag ? `<img class="flag" src="${esc(m.flag)}" alt="" loading="lazy">` : ''}</div>
        <div class="nm">${esc(m.name.replace(' Grand Prix', ''))}</div>
        <div class="dt muted">${esc(meetingDates(m))} · ${esc(m.location)}</div>
        ${m.circuitImage ? `<img class="track" src="${esc(m.circuitImage)}" alt="" loading="lazy">` : ''}
        <div class="win">${foot}</div>
      </button>`;
    })
    .join('');
  el.innerHTML = `<div class="wrap fade-in">
    <div class="section-head">
      <h2 class="headline">The calendar.</h2>
      <p>${doneCount} of ${total} rounds complete. Choose a finished race to see its results.</p>
    </div>
    <div class="cal">${cards}</div>
  </div>`;
  el.querySelectorAll('.cal-card').forEach((c) =>
    c.addEventListener('click', () => {
      const key = Number(c.dataset.key);
      const m = season.gps.find((x) => x.key === key);
      if (m.isNext) {
        $('#hero').scrollIntoView({ behavior: 'smooth' });
        return;
      }
      if (!m.sessions.some((s) => season.results.has(s.key))) return;
      state.resultsMeeting = key;
      state.resultsSession = 'Race';
      renderResults().then(() => $('#results').scrollIntoView({ behavior: 'smooth' }));
    })
  );
}

// ---------------------------------------------------------------- router
// Three pages: the overview (all the sections above), Live and News.
// Section anchors like #weekend belong to the overview.
state.page = 'overview';

let currentHash = location.hash;

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Navigate inside the app. Falls back gracefully where the URL can't change (e.g. sandboxed previews). */
function go(hash) {
  currentHash = hash;
  try {
    if (location.hash !== hash) history.pushState(null, '', hash);
  } catch { /* URL can't be updated here; routing still works */ }
  route();
}

function route() {
  const h = currentHash;
  const page = h === '#live' ? 'live' : h === '#news' ? 'news' : 'overview';
  const changed = page !== state.page;
  state.page = page;
  $('#top').hidden = page !== 'overview';
  $('#view-live').hidden = page !== 'live';
  $('#view-news').hidden = page !== 'news';
  document.querySelectorAll('[data-page]').forEach((a) => a.toggleAttribute('aria-current', a.dataset.page === page));
  document.title = { overview: 'Pit Wall — F1 Season & Race Predictor', live: 'Live — Pit Wall', news: 'News — Pit Wall' }[page];

  if (page !== 'live') unmountLive();
  if (page === 'live') {
    if (!state.season) {
      $('#view-live').innerHTML = loadingBand('Live.', 'Loading the season…');
      $('#view-live').dataset.loading = '1';
    }
    else if (changed || !$('#view-live').innerHTML || $('#view-live').dataset.loading) {
      delete $('#view-live').dataset.loading;
      mountLive($('#view-live'), state.season, { expectedLaps: state.ctx?.history?.find((x) => x.laps)?.laps });
    }
  }
  if (page === 'news') showNews();
  if (changed) window.scrollTo(0, 0);
  // getElementById, not querySelector: the hash comes from the URL and may not be a valid selector.
  if (page === 'overview' && h && h !== '#top') document.getElementById(safeDecode(h.slice(1)))?.scrollIntoView({ behavior: changed ? 'auto' : 'smooth' });
  else if (page === 'overview' && h === '#top' && !changed) window.scrollTo({ top: 0, behavior: 'smooth' });
}

const loadingBand = (title, msg) =>
  `<section class="band band-white"><div class="wrap"><h1 class="headline">${esc(title)}</h1><p class="lede">${esc(msg)}</p></div></section>`;

function markLive() {
  const live = state.season && liveSessionNow(state.season);
  ['#nav-live-dot', '#tab-live-dot'].forEach((id) => ($(id).hidden = !live));
}

// ---------------------------------------------------------------- news
state.news = null;
state.newsFilter = 'all';
let newsLoading = null;

async function showNews() {
  const root = $('#view-news');
  if (!state.news) {
    if (!root.innerHTML) root.innerHTML = loadingBand('News.', 'Gathering the latest headlines…');
    newsLoading ||= loadNews()
      .then((n) => (state.news = n))
      .catch((e) => {
        root.innerHTML = loadingBand('News.', `Couldn’t load the news right now (${e.message}).`);
        newsLoading = null;
      });
    await newsLoading;
    if (!state.news) return;
  }
  renderNews();
}

function timeAgo(d) {
  if (!d) return '';
  const s = (Date.now() - d) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 3600) return rtf.format(-Math.max(1, Math.round(s / 60)), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 7 * 86400) return rtf.format(-Math.round(s / 86400), 'day');
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function renderNews() {
  if (state.page !== 'news') return;
  const root = $('#view-news');
  const { articles, failed } = state.news;
  const drivers = state.season ? [...state.season.drivers.values()] : [];
  const next = state.season?.next || null;
  const lastGp = state.season?.lastRace?.m || null;
  const races = [
    next && { key: 'race:next', meeting: next },
    lastGp && lastGp.key !== next?.key && { key: 'race:last', meeting: lastGp },
  ].filter(Boolean);
  tagArticles(articles, drivers, races);
  const chips = topTags(articles);
  const f = state.newsFilter;
  const match = (a) =>
    f === 'all' ||
    (f === 'drivers' && a.tags.some((t) => t.type === 'driver')) ||
    (f === 'teams' && a.tags.some((t) => t.type === 'team')) ||
    a.tags.some((t) => t.key === f);
  const list = articles.filter(match);
  const raceCount = (key) => articles.filter((a) => a.tags.some((t) => t.key === key)).length;
  const gpLabel = (m) => m.name.replace(' Grand Prix', ' GP');
  const featured = list.find((a) => a.image) || list[0];
  const rest = list.filter((a) => a !== featured);

  const tagLine = (a) =>
    a.tags
      .filter((t) => t.type !== 'race')
      .slice(0, 3)
      .map((t) => `<span class="ntag"><i style="background:${t.colour || '#86868b'}"></i>${esc(t.label)}</span>`)
      .join('');
  const meta = (a) => {
    const r = a.tags.find((t) => t.type === 'race');
    return `<span class="nsrc">${esc(a.source)}</span>${a.date ? ` · ${esc(timeAgo(a.date))}` : ''}${r ? ` · <span class="nrace">${esc(r.label.replace(' Grand Prix', ' GP'))}</span>` : ''}`;
  };
  const visual = (a, cls) =>
    a.image
      ? `<div class="${cls}"><img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback></div>`
      : `<div class="${cls} noimg"><span>${esc(a.source)}</span></div>`;

  const card = (a) => `<a class="ncard ${a.image ? '' : 'text-only'}" href="${esc(a.link)}" target="_blank" rel="noopener">
      ${a.image ? visual(a, 'nimg') : ''}
      <div class="nbody">
        <div class="nmeta">${meta(a)}</div>
        <h3>${esc(a.title)}</h3>
        ${a.excerpt ? `<p>${esc(a.excerpt)}</p>` : ''}
        <div class="ntags">${tagLine(a)}</div>
      </div>
    </a>`;

  const pill = (key, label) => `<button data-nf="${esc(key)}" aria-pressed="${f === key}">${esc(label)}</button>`;
  root.innerHTML = `
  <section class="band band-white">
    <div class="wrap fade-in">
      <div class="section-head">
        <h1 class="headline">News.</h1>
        <p>The latest from Formula1.com, Autosport, Motorsport.com and BBC Sport. Each story is tagged with the drivers, teams and race it mentions.</p>
      </div>
      <div class="news-filters">
        <div class="segmented" role="group" aria-label="Filter news">
          ${pill('all', `All ${articles.length}`)}
          ${races.filter((r) => raceCount(r.key)).map((r) => pill(r.key, `${gpLabel(r.meeting)} ${raceCount(r.key)}`)).join('')}
          ${pill('drivers', 'Drivers')}
          ${pill('teams', 'Teams')}
        </div>
        <div class="chip-row">
          ${chips.map((c) => `<button class="fchip" data-nf="${esc(c.key)}" aria-pressed="${f === c.key}"><i style="background:${c.colour || '#86868b'}"></i>${esc(c.label)} <span>${c.count}</span></button>`).join('')}
        </div>
      </div>
      ${
        featured
          ? `<a class="nfeature" href="${esc(featured.link)}" target="_blank" rel="noopener">
              ${visual(featured, 'nfimg')}
              <div class="nfbody">
                <div class="nmeta">${meta(featured)}</div>
                <h2>${esc(featured.title)}</h2>
                ${featured.excerpt ? `<p>${esc(featured.excerpt)}</p>` : ''}
                <div class="ntags">${tagLine(featured)}</div>
                <span class="arrow-link">Read on ${esc(featured.source)}</span>
              </div>
            </a>`
          : '<p class="lede">No stories match this filter.</p>'
      }
    </div>
  </section>
  ${
    rest.length
      ? `<section class="band band-gray"><div class="wrap"><div class="news-grid">${rest.map(card).join('')}</div></div></section>`
      : ''
  }
  <section class="band band-white news-foot"><div class="wrap">
    <p class="micro">Headlines and summaries belong to their publishers. Tap a story to read it on their site.${failed.length ? ` Couldn’t reach: ${esc(failed.join(', '))}.` : ''}</p>
  </div></section>`;

  root.querySelectorAll('[data-nf]').forEach((b) =>
    b.addEventListener('click', () => {
      state.newsFilter = state.newsFilter === b.dataset.nf && b.classList.contains('fchip') ? 'all' : b.dataset.nf;
      renderNews();
    })
  );
}

// ---------------------------------------------------------------- go
setThrottleListener((sec) => {
  $('#ribbon').textContent = `OpenF1 is busy — retrying in ${sec}s…`;
});
$('#refresh').addEventListener('click', () => {
  if (state.page === 'news') {
    state.news = null;
    newsLoading = null;
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('pitwall:v1:rss:')).forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
    showNews();
    return;
  }
  if (state.page === 'live') {
    $('#view-live').innerHTML = '';
    route();
    return;
  }
  main(true);
});
// Broken news images fall back to the source-name tile. (No inline onerror
// handlers, so the Content Security Policy can forbid inline script.)
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (img?.tagName === 'IMG' && img.hasAttribute('data-fallback')) {
      img.parentNode?.classList.add('noimg');
      img.remove();
    }
  },
  true
);
window.addEventListener('hashchange', () => {
  currentHash = location.hash;
  route();
});
window.addEventListener('popstate', () => {
  currentHash = location.hash;
  route();
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || e.metaKey || e.ctrlKey) return;
  const hash = a.getAttribute('href');
  if (hash === '#') return;
  e.preventDefault();
  go(hash);
});
route();
main();
