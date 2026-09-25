# The meeting-ETA lab (throwaway)

Answers one question with numbers instead of intuition:

> Should the map's `heading toward <fence> — ~5m` pill become **"here is when you
> two will cross"**, and which rules does that actually need?

It is not shipped, not imported by the app, and has no build step. Five files,
plus the dataset they read:

| file | what it is |
| --- | --- |
| `build-data.mjs` | writes the dataset (`tracks.js`) — a synthetic demo, or real pings out of way-db |
| `meet-maths.js` | the geometry, CPA/TCA evaluation, gates and pill phrasing, shared by the two views |
| `meet-lab.html` | the schematic lab: tables, gate ablation, events, SVG plots, raw steps |
| `meet-map.html` | the same maths on real map tiles, with the pill and a play-through |
| `check-maths.mjs` | headless: re-proves what the demo is supposed to say |
| `tracks.js` | **generated, gitignored** — with `--source` it is real family location history |

Why two views of one dataset: the schematic lab is where the maths is arguable
(the ablation, the truth columns), and the map is where the *decision* is
arguable (two tracks on real terrain, a fence at its real radius, a pill on top
of them). Three ways to look at one thing only pay off if they cannot disagree,
so the maths lives in one file and `check-maths.mjs` asserts against it.

## Run it

```bash
# 1. data (demo first: the geometry is known by construction)
node scripts/one-off/2026-09-24-meet-eta-lab/build-data.mjs --demo
# ... or only the interesting 120 s of it, which still contains both meets:
node scripts/one-off/2026-09-24-meet-eta-lab/build-data.mjs --demo --minutes 2

# 2. serve it, then open http://127.0.0.1:8793/meet-lab.html
python -m http.server 8793 --bind 127.0.0.1 \
  --directory scripts/one-off/2026-09-24-meet-eta-lab
```

Serve the folder rather than opening the file directly: the pages load their
dataset as a sibling `<script>`, which browsers restrict under `file://`.

### The map view

`meet-map.html` (http://127.0.0.1:8793/meet-map.html) draws the selected pair on
Leaflet tiles, plays the window at 5x, and shows the pill where the HUD would
put it — plus a strip along the bottom showing when the pill is up at all, with
the true closest approach marked in red. That strip is the reason the view
exists: a 15 s flicker in the middle of a meet is invisible while watching a dot
crawl, and obvious as a gap in a bar.

Its panel has the same controls as the lab's, including `fenceMode` — switch it
while the window plays and the 15 s hole in the strip appears or disappears
under you, which is the fastest way to see what that rule actually does.

It deliberately does **not** carry a tile URL. It loads the app's own
`/shared/basemaps.js` — the module both real maps read, and the file that
explains why there is exactly one place a tile URL may live. Since that file is
served out of `public/`, the map view needs a second server on that folder:

```bash
python -m http.server 8794 --bind 127.0.0.1 --directory public
# then http://127.0.0.1:8793/meet-map.html  (a script tag is not CORS-restricted)
# ... or point it elsewhere: meet-map.html?basemaps=http://host/shared/basemaps.js
```

Without it the page refuses to draw and says so, rather than falling back to a
hardcoded URL.

### Re-proving it

```bash
node scripts/one-off/2026-09-24-meet-eta-lab/check-maths.mjs
```

Runs the same functions the pages call (no browser) and prints one line per
pinned conclusion — 45 of them: the meet opening at t+45 s, the three steps
`bothOutside` silences, which gate off adds how many events, both readings of
the fence rule, and the two facts about the fixture that make an ablation row
mean less than it looks (Solo's gap is under the staleness cap, so `fresh`
cannot fire here). Regenerating the demo with different seeds means re-reading
the numbers in this file and re-pinning them, which is the point: a silent
change in them is the failure it exists to catch.

## The demo's ground truth

Five devices, 5 s cadence, Antananarivo — ten minutes by default, two with
`--minutes 2` (see "A 120 s cut"). Position noise is ~6 m per
fix (a decent phone) and every speed is derived from the fixes, never from the
values the devices report — the reported ones are shown side by side so a phone
whose speed column lies is visible.

| what happens | when | what it tests |
| --- | --- | --- |
| Niri (40 km/h south) and MaxX (40 km/h north) pass nose to nose | 06:01:40Z | the case the concept exists for: 73 m predicted 46 s out, tightening to 4 m; they actually came within 30 m |
| Niri and Kofi close head-on on two roads 473 m apart | 06:01:40Z | a heading-only gate lets this through; the *miss distance* is what kills it (they never come closer than 464 m) |
| MaxX catches and overtakes Solo (40 vs 25 km/h, same road) | 06:00:05Z | range closes with only ONE of them pointed at the other — this is why the heading gate is not redundant |
| Niri drives straight past Aina's parked position, 8 m away | 06:01:00Z | Niri × Aina has *real* geometry and is still suppressed, because Aina is inside her fence |
| Solo closes on Aina, parked **inside** a geofence | 06:04:05Z | the cost of the `bothOutside` rule: a mover converging on a parked peer, 47 converging steps, all suppressed |
| Niri carries a 380 m teleport, MaxX a 400 m one, Solo a 90 s gap | — | the teleport and freshness guards |

Expected reading: two meeting events, both true meets, each starting while the
pair is still ~1.1 km apart; every other pair silent, and the ablation table
saying exactly which rule is responsible for each silence.

Two caveats the numbers below make concrete. Solo's 90 s hole is **shorter than
the 180 s staleness cap**, so the `fresh` gate cannot fire on this dataset at
all — lengthen the gap past three minutes to exercise it. And the demo's
teleports are the only thing that ever produces an *unusable* row, so the guard
that rejects them is exercised on this data and only on this data.

## What it already said

1. **The true meets fire correctly.** MaxX's event opens at 09:00:45 — the pair
   still 1,195 m apart — predicting a 73 m miss 46 s out, tightens to 4 m, and
   the truth was 30 m at 09:01:40: the t+95 s ground truth, to the second, once
   six metres of per-fix noise is allowed for. The estimate is right in the mean
   and noisy in the instant. The second true meet (Niri x Solo, who pass 31 m
   apart at 09:02:10) opens predicting 235 m and is off by 204 m at the first
   step — a reminder that the first number the pill shows is the worst one.
2. **A heading gate alone is not enough.** Niri x Kofi closes at 80 km/h with
   both headings pointed at each other inside any reasonable cone, and they pass
   464 m apart. Only the miss-distance number separates that from a meeting.
3. **The heading gate is not redundant either.** Turning it off adds two
   meetings: MaxX overtaking Solo (closing at 15 km/h with MaxX pointed straight
   at him) and MaxX x Kofi, who are on parallel roads 446 m apart.
4. **At long range the estimate is a lie.** With the `settled` gate off, Niri x
   Kofi fires at 1,944 m apart predicting a 215 m miss, and they never come
   closer than 464 m. Cause: ±6 m per fix at a 5 s cadence is ±20 deg of heading
   and ±9 km/h of speed at 40 km/h, and extrapolating that over two minutes
   swings the miss distance by hundreds of metres. **The pill should only
   appear once the pair is close**, which is what `settled` (default 1,200 m)
   does — it delays the true meets to ~45 s out and they stay correct.
5. **Some gates earn nothing.** With the rest on, `relative`, `closing`, `speed`
   and `notTogether` each hide nothing at all on this data; `dcpa` and `settled`
   hide one false positive each, `heading` two. A gate that changes no decision
   should be deleted, not shipped — but note two of the four are structural
   rather than proven harmless: `notTogether` can never fire because rows inside
   the together radius are already handed to the peer pill, and `closing` is
   implied by the "is this a pass at all" test that produces the verdict.
6. **`bothOutside` is a real cost, and it is not only a cost.** Turning it off
   adds four meetings, three of them pure long-range noise (a parked peer ~1 km
   away, off by 100-700 m from what actually happened). The fourth, Niri x Aina,
   has real geometry — Niri drives past Aina's parked spot 8 m away — and is
   still rightly suppressed, because Aina is *home*. Neither the miss-distance
   number nor the heading test can tell those two cases apart; the fence can.
7. **The same gate punches a hole in a true meet.** Niri x MaxX is silenced at
   09:00:55, 09:01:00 and 09:01:05 — fifteen seconds in the middle of a real
   meet — because Niri is driving through her own home fence on the way out.
   Any driver is inside their home fence for the first minute of a trip, so
   "both peers outside every fence" blinks the pill off exactly when the ETA is
   first becoming useful. The `fenceMode` control exists to price that.
8. **Relaxing the rule costs nothing measurable on this data.** Under the other
   reading — a peer inside a fence counts as being *home* only if it is also not
   moving — the hole closes, and nothing else moves with it:

   | | either peer's fence (strict) | only a parked peer's |
   | --- | --- | --- |
   | lit steps of the true meet | 7 | **10** |
   | steps silenced mid-meet | 3 | **0** |
   | meeting events | 2 | 2 |
   | Niri x Aina (she is parked at home) | suppressed | **suppressed** |
   | meetings the gate hides when switched off entirely | 4 | 4 |

   The rule the gate exists for — do not announce a meet with somebody sitting
   at home — never needed the *moving* peer's fence, so the strict reading was
   buying a 15 s hole for nothing. The trade it does make: a peer stopped
   anywhere inside any fence now reads as home, so a phone idling in traffic
   inside a shop's fence would be suppressed like one parked in a driveway.
   Both readings are pinned in `check-maths.mjs`, so flipping this back is a
   visible change rather than a silent one.
9. **Two ways to compute the closing rate agree by construction here and are a
   cross-check on real data.** In the demo both devices report on the same
   cadence, so the analytic rate and the differenced one are identical; real
   way-db rows have uneven gaps, and there they diverge when a fix is missing.

## A 120 s cut

`--minutes 2` shortens the demo to 120 seconds. It is a **cut, not a
compression**: each device keeps its seed, its start and its speed, so every
ping in the short file is byte-identical to the same ping in the long one, and
the head-on meet stays at t+95 s. What is left in the window: both true meets
(Niri x MaxX passing 30 m apart at t+100 s, Niri x Solo converging), the
Niri x Kofi false positive that the miss-distance number has to kill, and the
fence argument above. What the cut drops: Solo's 47 converging steps on Aina
(06:04), both teleports, Solo's 90 s gap — i.e. the guard scenarios.

The reason to cut is that the conclusion does not change. Every row of the
ablation table on the 120 s window is the same decision as on the full ten
minutes; the remaining eight minutes only add evidence for the two guards, and
neither of them changes a verdict there either.

| | 10 minutes | 120 s cut |
| --- | --- | --- |
| meeting events | 2 | 2 |
| closest true pass | 30 m at 09:01:40 | 30 m at 09:01:40 |
| gates that hide nothing | `relative`, `closing`, `speed`, `notTogether` | same four |
| gates that hide a false positive | `dcpa`, `settled`, `heading` | same three |

Use the long window when you are arguing about the guards (the teleport and
staleness rules need rows the cut does not have); use the cut when you are
arguing about the pill.

## Pointing it at real trips

```bash
# local dev database (safe, no production)
node scripts/one-off/2026-09-24-meet-eta-lab/build-data.mjs --source local --days 7

# production way-db, last 3 days  -- read-only SELECT, but it IS production
node scripts/one-off/2026-09-24-meet-eta-lab/build-data.mjs --source remote --days 3
node scripts/one-off/2026-09-24-meet-eta-lab/build-data.mjs --source remote --devices Niri,MaxX
```

Both are read-only. Two things to know about the data:

- `gps_pings` is flushed from the fleet DO **once a night at 21:00 UTC**, so
  today's tracks may be missing or short until then. The DO holds them, not D1.
- One phone is a real state (`--source local` finds exactly that on a dev
  database). The page says so instead of rendering empty tables.

## What it does not do

No push, no UI, no app wiring; it does not touch the DO, the pill's placement,
the `#peer-pill` handoff, or accuracy weighting. It answers the geometry
question only — which is the part that was arguable.

`meet-map.html` is **not** the app's map. It reuses one file from it
(`/shared/basemaps.js`) and draws its own Leaflet canvas, so nothing here can
change what /way/ renders. That is deliberate: the pill's placement and the
handoff to `#peer-pill` are decisions to make after this one.
