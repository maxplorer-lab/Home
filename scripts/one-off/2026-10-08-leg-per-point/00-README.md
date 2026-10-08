# 2026-10-08 — `stationary = true` is unqueryable, and the legs say why

One-off diagnostic. Nothing here runs in production; `src/` is untouched.

## What the query returns

Asked for: every `stationary = true` in the last 2-3 days, with timestamps.

```
SELECT is_stationary, COUNT(*), MIN(timestamp), MAX(timestamp) FROM gps_pings GROUP BY 1
```

| is_stationary | rows | first | last |
| --- | --- | --- | --- |
| 0 | 45 241 | 2026-08-27T18:13:08Z | 2026-10-07T13:51:10Z |
| 1 | **3** | 2026-08-27T18:19:13Z | 2026-08-27T18:30:29Z |

All three are MaxX, all within the table's first twenty minutes, at
`-19.8797, 47.0307` at 2.2 and 0 km/h:

```
2026-08-27T18:19:13Z  speed 2.2  is_driving 0
2026-08-27T18:19:18Z  speed 0
2026-08-27T18:30:29Z  speed 0
```

Those two rows carry `created_at` of 18:33:22 — fourteen minutes AFTER their own
timestamp — while the table's first rows carry `created_at` equal to their
timestamp. So the door closed early: `shouldPersistTrackPoint` is
`!isInside && !isStationary`, so a ping the engine calls stationary is now
counted as `collapsed` and never written at all. `is_stationary` is a column
that can only ever hold 0. (Which commit closed it cannot be dated from this
clone: `git log -S` finds nothing before the 2026-09-18 checkpoint that starts
the history.)

**So there is no historical record of a stop firing, and there never can be from
this table.** The nearest thing is the leg boundary: a stop closes the open leg
and the next departure mints a new one, so `leg_id` is the trace.

## What the legs say

Points per leg, per device per day (`gps_pings`, `leg_id` is non-null since it
shipped):

| day | device | legs | points | 1-point legs | points/leg |
| --- | --- | --- | --- | --- | --- |
| 2026-09-30 | Niri | 6 | 851 | 0 | 141.8 |
| 2026-10-01 | Niri | 6 | 688 | 0 | 114.7 |
| 2026-10-02 | Niri | 17 | 925 | 3 | 54.4 |
| 2026-10-04 | Niri | 74 | 74 | **74** | **1.00** |
| 2026-10-05 | Niri | 2373 | 2376 | **2370** | **1.00** |
| 2026-10-06 | Niri | 855 | 860 | **850** | **1.01** |
| 2026-10-07 | Niri | 977 | 982 | **972** | **1.01** |

From 2026-10-04 every stored point is its own leg, while `is_driving = 1`,
`is_inside_geofence = 0` and the device is moving 20-30 m every 3 s. In ingest
order 972 of ~982 leg ids are exactly `previous + 1`, so one counter is being
bumped once per ping.

## Why the engine is not the cause

`replay.mjs` feeds the real 243-point stream (04:01-04:20 on 2026-10-07, dumped
from production) back through `processPing`:

```
engine legs opened over the slice: 2      (one per point would be 243)
```

The legs' own logic is sound. So the state handed to the engine differs from
what the engine would have produced.

## The cause

`src/way/do/FleetDO.ts`, the ingest handler's re-read before the save:

```ts
const controls = this.loadDeviceState(ping.deviceId);
if (controls.motion.pendingLegCut) newMotion.pendingLegCut = true;
this.saveDeviceState(ping.deviceId, { motion: newMotion, ... });
```

`controls` is read from the row as the PREVIOUS ping left it. `processPing` has
just spent this ping's cut (`legId += 1`, `pendingLegCut = false`) — but only in
memory, because this ping has not saved yet. So the re-read sees the old `true`
and writes it straight back. The one-shot break becomes a **latch**: from the
first arm onward every ping that measures movement mints a leg, forever, with no
pause in sight.

It can only be armed by the dashboard's pause switch (`applyRecordingPause`,
which arms the cut only when a leg is OPEN — `8127cce`, 2026-10-02). That is why
Niri is latched and MaxX is not (MaxX 2026-10-07: 15 legs, 125 points, 8.33
points/leg).

## The reproduction

`reproduce.mjs` models the DO's loop (a JSON row, load → processPing → re-read →
carry → save) over one 20 km/h drive and one pause/resume:

| case | points | legs | latch left in the state |
| --- | --- | --- | --- |
| A. production (blanket carry) | 54 | **53** | true |
| B. no carry at all | 54 | 2 | false |
| C. candidate fix | 54 | 2 | false |
| D. production, pause lands MID-HANDLER | 54 | 53 | true |
| E. candidate fix, pause lands MID-HANDLER | 54 | 2 | false |

The candidate fix carries only an arm NEWER than the state the ping started
from:

```ts
if (controls.motion.pendingLegCut && !stored.motion.pendingLegCut) {
  newMotion.pendingLegCut = true;
}
```

Case E is the point: the race the line exists for — a pause that lands while the
handler awaits the geofence list — still survives the save (`YES`) and is still
honoured as exactly one leg cut (`YES`). Narrowing the carry does not lose the
pause it was written to protect.

## Run

```
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/way-ts-hooks.mjs scripts/one-off/2026-10-08-leg-per-point/reproduce.mjs
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/way-ts-hooks.mjs scripts/one-off/2026-10-08-leg-per-point/diagnose.mjs
```

`replay.mjs` additionally needs `out/slice.json`, which is a production dump and
is gitignored — refetch it with the query in that file's header.

## Still open

The latch is durable state, so a deploy alone does not clear it for Niri: the
state row keeps `pendingLegCut: true` until a ping saves it false, which the fix
does on the next movement. Worth confirming against the next flush.
