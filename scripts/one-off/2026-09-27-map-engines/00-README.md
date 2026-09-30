# The map's engines are files (2026-09-27)

**Status: done, guarded, falsified. No SQL, no config, no new secret.** Four new
files under `public/shared/`, one-line delegations in the page, one include in the
share, smoke §15 rewired onto the files, and the three docs that described the engines
as page code corrected.

## What was wrong

The map's arithmetic — how far, which way, are these two about to cross, what a
day adds up to — lived inside `public/way/index.html`, and the page is served
verbatim, so the test suite could only reach it by **rebuilding it**:

* `meetStripScale` was stitched out of the served HTML with `new Function`, and
  its memory had to be re-declared by hand in the string —
  `let meetStripScaleIdx = 0; let meetStripScaleKey = null;` — in **three**
  different places, because the ruler's remembered rung is page state.
* `COMPASS_POINTS` was pulled out with a regex over the page.
* the ladder's bands were recovered by bracket-walking the `CONFIG` literal, and
  the shrink factor by a regex over prose.
* `rangeRateKmh` / `computeLegsForDay` ran through a hand-listed dependency map.

A check that restates a module's internals cannot notice when the internals
change — the same shape as the 1.8-vs-0.9 km day, paid for once already. The
share had drifted the same way: `public/live/index.html` carried its own
haversine, in the *other* algebraic form (asin here, atan2 on the map), so two
pages could disagree about the same road.

## The fix

| File | Owns | Callers |
| --- | --- | --- |
| `public/shared/geo.js` (`HomeGeo`) | distance, bearing, the eight cardinals, the angular gap | the map's delegations, the share's `distanceM`, the bar's subject half |
| `public/shared/meet.js` (`HomeMeet`) | the ONE crossing verdict (`create()` takes the page's reads as accessors; `decision`, `etaFor`, `participantVelocity`) and `rangeRateKmh` | the pill and the bar's tick, so they cannot disagree about a pair they share |
| `public/shared/meet-strip.js` (`HomeMeetStrip`) | the ruler as an INSTANCE — `createScale()` returns `{ scale, index, reset }` — plus the bar's subject half: the pick, the nearest, the trend, the bar's own crossing, the picker's rows | `renderMeetStrip`, the picker panel, the direction chip |
| `public/shared/trip-legs.js` (`HomeTripLegs`) | what counts as a stored point, and what a day adds up to | the day's km on the HUD and the Trips card, the month's totals, the GPX |

The page keeps the names it always used as **one-line returns** into them
(`distanceMeters`, `bearingDegrees`, `compassPoint`, `angularDiff`,
`shouldDrawPoint`, `computeLegsForDay`), and its `CONFIG` now *reads* the numbers
it still needs out of `HomeMeet.CONFIG` instead of restating them.

The suite got the gain that motivated the move: smoke §15 evaluates the same four files
the page loads into a bare `window` and **calls** them, so the arithmetic has one
definition and a test surface that cannot drift from it. `WAY_BUILD` moved to
`2026-09-27.1-engines`; the share loads `/shared/geo.js` above its own script.

## The guards (smoke §15)

| Check | Fails when |
| --- | --- |
| `the map's engines are files that load into a bare window, and the page keeps no copy of them` | an engine body is pasted back into the page (`function meetEtaFor`, `function meetStripScale`, `function stripRefTarget`, `function meetStripLadder`, a private `COMPASS_POINTS`, the asin form of the distance once again), or a shared file stops loading |
| `the names the page still calls are one line each, into the shared engines` | one of the six delegations grows past a single `return` |
| `the public share measures with the same geometry as the map` | `/live/` drops the include or carries its own haversine again |

## Falsified

`node scripts/one-off/2026-09-27-map-engines/mutate.mjs` (needs the dev server;
runs the whole suite per mutation):

```
M1  caught=YES  restored=yes  (the ruler is page code again, next to the DOM half that reads it)
M2  caught=YES  restored=yes  (a page name stops being a one-line return and starts working things out)
M3  caught=YES  restored=yes  (the share measures with its own haversine again)
```

Each mutation left the tree byte-identical (sha256 per file, printed as
`restored`), so a mutation cannot leak into a later run.

## The part worth remembering

The reason to move code was the *test*, not the page: the page was readable, and
the suite was the thing restating it by hand. A guard that forbids an absence
("no engine body in the page") is exactly the kind that passes while looking in
the wrong place, which is what the driver above is for.

One honest gap, deliberately left: `src/way/lib/geofence.ts` holds the Durable
Object's own copy of the distance arithmetic. It is TypeScript, it runs in the
Worker, and it is not a page file — but it is still a second implementation of
"how far", and the only reason it is out of scope here is that a DO cannot load
`/shared/*`.
