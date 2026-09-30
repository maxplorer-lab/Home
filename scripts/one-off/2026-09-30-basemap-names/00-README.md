# The labelled map carries names (2026-09-30)

**Status: done, guarded, falsified. No SQL, no config, no secret, no account.**
The background of both maps is a VECTOR style now — MapLibre drawing
OpenFreeMap's tiles and style — and the label density is a file we own. Both keys
also print buildings FLAT (the household asked whether the map had 3D buildings
and, if so, for them to go), which is the second half of this change.

## What was wrong

Two complaints, a day apart, that turned out to be one finding:

1. *"esri is not detailed enough, just a colored version of the lite basemap"* —
   the labelled key drew Esri's `World_Street_Map`, and around this household
   (`CONFIG.MAP_DEFAULT_CENTER`, Antananarivo) that raster prints the same road
   network as `World_Light_Gray_Base`, tinted. Detail, not names, seemed missing.
2. *"you just bolded the street names, and very few places"* — after swapping in
   `World_Topo_Map` plus Esri's `Reference/World_Boundaries_and_Places` layer.
3. *"does it have 3d buildings? if yes, we should remove to make it lighter. 2d
   drawings is enough"* — asked of the vector map, and answered below: Liberty
   does, `building-3d` from z14, and the one-line delete would have removed the
   buildings rather than the 3D.

Measured at the household's own centre, that is what a raster does here: Esri's
name layer returns ~14 KB of labels at z16, **2.5 KB at z18 and 872 bytes at
z19**, while the roads behind it stay. Label density is a decision made *inside*
a style, so no choice of raster could fix it. Probed and rejected along the way:

| Candidate | What it actually serves here |
| --- | --- |
| `basemaps.cartocdn.com` (Voyager) | one identical 2049-byte tile for three different coordinates (ETag `wm-…-light`) — a block that answers `200 image/png` |
| `maps.wikimedia.org` | `403` |
| OSM-FR's `osmfr` / `hot` renders, FAU's `osmhd` | genuinely dense (13–32 KB per tile at z18, named streets, buildings, house numbers) — but OSM France's published tile policy requires *"une utilisation accessible au public (pas de login/pass)"*, which `/way/` is not, and reserves suspension *"sans préavis"*. The household's map is behind a login, so this is the same trade the OSM block already cost once |
| `World_Imagery` | every building, and rejected by the household: names were wanted, not pixels |

## The fix

| File | Owns |
| --- | --- |
| `public/shared/basemaps.js` | the keys: which style or raster, the zoom ceiling, the credit. `lite` = Positron (pale canvas), `streets` = Liberty with `dense: true` |
| `public/shared/basemap-style.js` | **what the map prints**: `DENSE` (the label layers the tuner rewrites and the zoom each should start at), `ROOMIER` (labels given more room so fewer are dropped by the style's own collision test), `FLAT` (which flat layer takes an extrusion's footprints over), `tune()` (pure; reports the ids upstream no longer has, and which 3D layers it dropped), `load()` (fetch + tune + cache, never rejects) |
| `public/shared/basemap-layer.js` | the ONE place a key becomes layers, for both maps: a vector key via `L.maplibreGL`, a raster key via tile layers, plus the credit on the map's attribution control while it is drawn |
| `public/way/index.html` | menu from the keys; `setLayer` is async and a draw that has been overtaken takes itself back off the map. `WAY_BUILD` → `2026-09-30.2-vector` |
| `public/live/index.html` | one call into the shared path, no layer of its own, no switch |
| `scripts/lib/basemap-record.mjs` | **the upstream, as a record**: the walk (a key's style → its vector sources → each TileJSON → one tile at the household's own view and one over open water), the copy on disk, the MVT reader that says what a tile carries, and the two reader seams (`recordReader` / `liveReader`) the three callers plug in |
| `scripts/fixtures/basemaps/` | the copy itself: `index.json` (url, kind, view, bytes, sha256, `recordedAt`) plus one file per URL — 5 entries at 369 KB |
| `scripts/basemap-record.mjs` | `npm run basemaps:record` — the ONLY thing here that talks to the tile host on purpose. Runs the guards' own walk with a recording reader, prints a per-URL diff by sha256, then judges what it recorded |
| `scripts/basemap-record-audit.mjs` | `npm run audit:basemaps` — the CI half: the same judgment, on the record, no server/database/network, with the recorded hosts REFUSED so a check that went back to fetching fails instead of passing |

Why a fetch-and-patch rather than a forked style checked in: a fork is a copy of
somebody's 43 KB of JSON that stops matching the day they rename a layer —
silently, because a style without `highway-name-minor` still renders perfectly.
The live style is fetched, `tune()`'s report is a guard, and a style that cannot
be fetched is drawn untuned rather than not at all.

## Flat, and why it was not a one-line delete

Upstream's labelled style (Liberty) draws exactly one 3D layer: `building-3d`, a
`fill-extrusion` on the `building` dataset, from z14 up, reading
`render_height`/`render_min_height` and shaded with `fill-extrusion-opacity`. The
household's ask — *"remove to make it lighter"* — is right about the cost:
extrusion is the most expensive layer type a style can ask for, since every
building is a triangulated, shaded, depth-sorted prism rebuilt as the map is
panned, and this map is read at a glance on a phone.

But deleting the layer would have taken the buildings with it. Upstream prints
buildings **flat** (`building`, a `fill` on the same dataset) with
`minzoom: 13, maxzoom: 14`, and the extrusion starts at z14 — the cap is exactly
where the 3D takes over, and **above z14 the extrusion is the only thing drawing
a building at all**. So:

* the extrusion is dropped by **TYPE**, not by id — so a 3D layer upstream adds
  later is flat too, and the flatness cannot drift;
* `FLAT` names the flat layer that takes the footprints over, and `tune()`
  deletes its `maxzoom` so the footprints survive at every zoom;
* `tune()` hands the footprints over *before* dropping anything, and reports a
  pair whose twin is missing as `missing` rather than silently taking a set of
  buildings off the map;
* the tile BYTES are unchanged — the same `building` data feeds the flat
  footprints — so the saving is per-frame drawing, not download. (Stated because
  "lighter" could be read either way.)

`public/sw.js`'s cache name went `home-v2` → `home-v3` with this: its entries are
keyed by URL, so a module rewritten at the same path would otherwise be drawn from
the cache once after deploy.

## The guards (smoke §9, plus the share's own section)

| Check | Fails when |
| --- | --- |
| `every basemap is https, and each one names who to credit` | a key's host is not in `hostCredit` (read the provider's terms and declare them), or its `attribution` stops naming the host or OpenStreetMap |
| `each basemap says how it is drawn, exactly once` | a key names no style/url, or two |
| `the labelled basemap asks for more names than the plain canvas` | `streets` asks for neither `dense: true` nor a reference layer — the complaint this whole change answers, drawn by a map that looks healthy |
| `every raster tile URL uses the placeholder order its own host declares` | a raster key's `{x}`/`{y}` are swapped, or its host is not in `tileOrderByHost` |
| `both maps draw the background through the one shared path` | either page carries its own `L.tileLayer`/`L.maplibreGL` call, or stops calling `HomeBasemapLayer.show(` |
| `the style each key draws still has the label layers the tuner rewrites` | the live style no longer has a declared layer id (upstream renamed it), the tuner's table is empty, or a tuned layer is not at the declared zoom. Fetches the live style; offline it says **NOT VERIFIED** instead of quietly passing |
| `a style draws no 3D, and loses no footprint with it` | the TUNED style, read back, still draws a `fill-extrusion`; or a dataset upstream drew as 3D is left drawn by nothing over the zoom range the extrusion covered (the capped-twin fault, which renders perfectly); or `FLAT` has been emptied; or no style draws 3D any more, so the declaration has lost its subject. Fetches the live style; offline it says **NOT VERIFIED** |
| `the basemap actually paints at the household's own street level` | one real tile, fetched at the view the served page declares (its own centre) and at the zoom the source calls its deepest, is EMPTY or not a vector tile, or carries none of `building`/`transportation`/`place`; or a key draws a background this check does not judge (a raster key, or a style that failed to load). The answer to "the style is fine, why is the screen blank" — offline it says **NOT VERIFIED** |
| `…and a tile with nothing in it fails that check` | the same source at the same zoom over open water carries any of the required layers, which would mean the requirement above is met by the reader rather than by the data |
| `the tiles a key's style draws come from a host we declare and credit` | the style's own `sources` point somewhere not in `hostCredit` |
| `the viewer's map has ONE background and no switch` (share section) | the share calls the shared path more than once, names no key, builds a layer of its own, or offers a switch |

## Falsified

`node scripts/one-off/2026-09-30-basemap-names/mutate.mjs` (needs the dev server;
runs the whole suite per mutation):

```
M1  caught=YES  restored=yes  reached9=yes  (the labelled key is a plain canvas again — no extra names asked for)
M2  caught=YES  restored=yes  reached9=yes  (the household map builds its own background, outside the shared path)
M3  caught=YES  restored=yes  reached9=yes  (the tuner has nothing left to look for, so it can report nothing)
M4  caught=YES  restored=yes  reached9=yes  (a key draws from a host nobody has read the terms of)
M5  caught=YES  restored=yes  reached9=yes  (buildings rise into 3D again — the extrusion is never dropped)
M6  caught=YES  restored=yes  reached9=yes  (the 3D goes and the flat twin keeps its cap: no buildings above z14)

all 6 mutations caught by the guard they attack; tree restored
```

The four checks this file gained from its own probing and from the record — the
paint check, its empty-tile control, and the two ways the fixture can lie — were
falsified the same way in a second run, because the driver takes mutation ids when
only one guard needs re-proving (`node
scripts/one-off/2026-09-30-basemap-names/mutate.mjs M7 M8 M9 M10`; no argument runs
all ten):

```
M7  caught=YES  restored=yes  reached9=yes  (the household's own view is moved to open water: a green suite drawing nothing)
M8  caught=YES  restored=yes  reached9=yes  (the paint requirement is emptied, so the check can never fail)
M9  caught=YES  restored=yes  reached9=yes  (the recorded TileJSON names a release the record has no bytes for)
M10 caught=YES  restored=yes  reached9=yes  (the record hands the open-water tile over as the household view)

all 4 mutation(s) caught by the guard they attack; tree restored
```

M9 and M10 change nothing a page can see — they edit the record — so `reached9` is
the only thing that separates "the guard bit" from "the suite never got there".
The record's own audit has a driver of its own, with no server and six faults in a
few seconds: `scripts/one-off/2026-09-30-basemap-record/mutate.mjs`.

`reached9` is evidence, not decoration: the suite logs a `9b.` banner after
section 9, and a run that never got there would otherwise read as "the guard
stayed green". Two of them were written *after* seeing a real failure: the
drift check's first live run reported that Positron has no `poi_r*` layers (it is
the pale style by design), which is why the tuner is only judged against the
keys that ask for it; and the emptied-table mutation is caught only because the
check asserts the table is non-empty, not just that nothing is missing.

## The part worth remembering

* **A screenshot cannot see a block.** Carto served one flat 2049-byte PNG for
  three coordinates — the same shape as the tile that started this file. Three
  coordinates and one md5 is what caught it; a size check would not have.
* **Two maps, one module, and one drawing.** The share and the household map now
  call the same `show()`; "the two maps disagree" stops being possible rather
  than being tested for, and a page that draws its own background is a failed
  check instead of a silent difference.
* **The service worker can show you yesterday's module — bump its cache name.**
  `public/sw.js` caches `script` requests stale-while-revalidate, keyed by URL, so
  a module rewritten at the same path is drawn from the cache once after deploy
  while the page's own bytes are new. `home-v3` is what evicts the old entries
  now (`activate` deletes every other cache); a device that has not taken the new
  worker yet still needs the reload twice, and the honest check is against the
  served file (`curl`), not the page. (This cost real debugging time here: a probe
  rendered the old raster keys from cache while `curl` showed the new vector ones.)
* **A guard about somebody else's server needs a copy — and the copy has to be the
  SUBJECT.** Fetching upstream inside the checks made one red answer two questions
  ("upstream changed" and "is the network up?") and made a green depend on the
  weather: the routine run, a phone hotspot and an offline laptop were three
  different tests wearing one name. The copy also has to be the subject rather
  than a fallback, or the answer changes shape depending on whether the fetch
  happened to work. So `scripts/fixtures/basemaps/` is what the checks judge,
  `npm run basemaps:record` is how a human changes it (printing what moved, by
  sha256), `SMOKE_LIVE=1` / `--live` is how you ask upstream directly when that IS
  the question, and record mode refuses the recorded hosts so "runs without
  network" is a property of the run. One walk, three callers — the recorder, the
  CI audit and smoke §9 all call `judgeBasemaps`, so the record cannot list a
  roster the guards do not read. The one thing a copy cannot be trusted about is
  its own age: past 120 days it is reported as stale rather than judged.
* **A `200` is not a payload, and a source's native zoom is a ceiling.** The paint
  check's fixture was probed before it was written, and the probe is why it is
  worth anything: OpenFreeMap answers a vector request PAST its native z14 with
  `200` and a ZERO-BYTE body — the same shape as the block that opened this file,
  a valid-looking response with nothing in it. So the check samples the zoom the
  source itself declares deepest (the data a street-level view overzooms) and
  judges the BYTES, and the suite's other, status-level checks would have read
  that empty map as perfectly healthy.
* **"Lighter" had two halves, and only one of them was a delete.** Dropping
  upstream's 3D layer costs no download at all — the building data is in the tiles
  the flat footprints already need — so the win is per-frame drawing. Checking
  what the layer was *for* before removing it is what turned a one-line delete
  into a pair: the zoom cap that had to move with it, and the guard that reads the
  tuned style back instead of trusting the report.
* **Raster is still a supported shape.** A key may name `url` (+ `overlays`)
  instead of a style — that is how a satellite or commercial background would
  arrive, and the raster-era guards stay live for it. No key uses it today.
* **Open gap, deliberately left:** `scripts/one-off/2026-09-24-meet-eta-lab/meet-map.html`
  still draws `L.tileLayer(base.url)`, which no longer exists on a vector key. It
  is an archived lab about meet maths; its header now says so.
