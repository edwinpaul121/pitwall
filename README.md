# Pit Wall

A Formula 1 season dashboard and race predictor.

Demo hosted on github pages.
[site](https://edwinpaul121.github.io/pitwall/)

**Open `index.html` in a browser.** There are three pages: Overview, Live and News. No server or install needed. `dist/pitwall.html` is the same app in a single file you can share.

## What's on the page
- **Next race**: countdown, circuit map, lap length, laps, race distance, last winner and local start time.
- **The weekend**: every session in track time and your time, with the forecast for each one (or who was fastest, once it has run).
- **The forecast**: race-start conditions and an hour-by-hour race-day strip from Open-Meteo, plus last year's track and air temperatures from OpenF1.
- **The prediction**: predicted podium, odds for the whole grid (win, podium, points, expected points, DNF), pole favourite, safety-car chance, expected strategy, rain risk, a dark horse and the title picture. Tap a driver to see what goes into their numbers and their finishing-position spread.
- **Championship**: driver and constructor standings, wins, podiums and points gained at the last race.
- **Results**: every race, sprint, qualifying and practice session this season.
- **Calendar**: every round with its winner. Click a round to open its results.

## Live page (`js/live.js`)
- **Live mode** turns on automatically while a session is running (a red dot appears next to "Live" in the nav). It fetches gaps and positions every 8 seconds and everything else every 60 seconds (about 23 requests a minute, inside OpenF1's limit). The display updates every second.
- **Replay mode** is used the rest of the time. It plays back any race or sprint from this season, with play/pause, a scrubber and 1×–60× speed.
- **Timing tower**: position, then **Interval** (to the car ahead) or **Gap to leader**. Pick one with the toggle; your choice is remembered. Also last lap (fastest lap in purple, personal bests in green), tyre compound and age, stops, and PIT / OUT markers.
- **Gaps update about every 4 seconds**, using OpenF1's `intervals` stream. A whole race is about 4 MB, so replays load it in 5-minute windows around the playback point, plus the next window ahead. Until a window has loaded, gaps fall back to once-per-lap values worked out from when each car crosses the line.
- **Race updates**: plain-English updates built from race control (safety cars, flags, stewards' decisions), lead changes, overtakes in the top ten, pit stops with stop time and new tyres, fastest laps, rain, retirements, a summary every 10 laps, the finish, and team radio clips you can play. Filter by All / Key moments / Radio.
- OpenF1 only gives real-time data to paid accounts while a session is running. If a live request is refused, the page says so and shows a replay of the last race. The full data is usually free shortly after the session ends.

## News page (`js/news.js`)
- Headlines from Formula1.com, Autosport, Motorsport.com and BBC Sport. These sites don't allow browser pages to read their feeds directly, so the feeds are fetched through [rss2json](https://rss2json.com) and cached for 15 minutes.
- Each story is tagged with the drivers, teams, next race and most recent race it mentions. Filter with the tag chips or the All / race / Drivers / Teams toggle.
- Stories that appear on more than one site are shown once. A feed that fails is listed at the bottom instead of breaking the page.

## Prediction model (`js/predict.js`)
1. **Pace rating** per driver, measured in finishing positions, blended from: recent race form (34%, each older race counts 18% less, sprints count half), qualifying form (22%), team form (16%), history at this venue (16%, matched by driver code across seasons) and form on this type of circuit (12%). When there's little data, each part is pulled toward the driver's overall form.
2. **This weekend's sessions**: practice order is blended in at 18% once it exists, then the qualifying grid at 55%.
3. **Reliability**: each driver's DNF rate, smoothed toward an 8% average. It goes up on street circuits and in the wet.
4. **Monte Carlo**: 20,000 simulated races with random race-day variation. The variation is wider when rain is forecast and when this venue has a history of safety cars. The page also gives the chance that the title is decided at this race.

## Data sources
- [OpenF1](https://openf1.org): meetings, sessions, results, drivers, championship standings, race control (safety cars), stints and track weather.
- [Open-Meteo](https://open-meteo.com): 16-day hourly forecast, plus geocoding for any circuit missing from `js/circuits.js`.
- [rss2json](https://rss2json.com): fetches the news feeds for the browser (free tier).

Responses are cached in `localStorage` (about 20 minutes for the current season, 7 days for past years). Requests are spaced out to stay inside OpenF1's free-tier limits, and the page waits and retries when it gets an HTTP 429. Use the ↻ button in the nav bar to clear the cache and reload.

## Editing
The source is in `js/` (ES modules) and `css/styles.css`. After changing a JS file, rebuild:

```bash
python3 build.py
```
