# The walking anchor (2026-09-21)

`probe.mjs` is not a data change and not part of `npm run smoke` — it is the
**measurement** behind one line of `src/way/lib/state-machine.ts`, kept so the
claim in the docs can be re-run instead of believed.

## What was wrong

`computeDriving`'s walking return stores `distance: 0` on purpose: a walking
row's kilometre is never a stored quantity, the page measures a walking leg's
geometry instead (`computeLegsForDay`). But that branch also has to move
`lastRecordedPoint`, because that anchor is where the NEXT driving segment
measures from. It did not, so it stayed at the last driving point and the drive
after a walk was charged the whole walked stretch — a walk to the shop and back
became part of the drive home, in `gps_pings.distance_km`.

## Run it

```bash
cd D:\Freebuff\Home
node scripts/one-off/2026-09-21-walking-anchor/probe.mjs   # exit 0 = as expected
```

It copies `config.ts`, `geofence.ts` and `state-machine.ts` into a temp directory
with `.ts` specifiers (Node's type stripping runs the module directly), drives
the REAL engine over a synthetic drive → walk → drive, and prints the distance
charged to each row.

Expected: the walk row stores `0`, and the resumed drive charges **one** drive
step (`0.10520 km`) — not that step plus the walk (`0.11572 km`).

## The mutation it catches

Delete the `s.lastRecordedPoint = [lat, lon, dt];` line from either walking
return and re-run: the resumed row goes to `0.11572 km` and the probe exits 1.
`npm run smoke` §15 catches the same thing structurally (it counts both walking
returns and requires each to re-anchor first), which is the guard that runs on
every change — this file is what proves the guard is guarding something real.
