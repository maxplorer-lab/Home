// ─── What the vector map PRINTS, in one place ─────────────────────
// The household's map and the share draw a vector background: OpenFreeMap serves
// both the tiles and the styles (keyless, no registration, no request limit, MIT
// styles forked from OpenMapTiles'), and this file is the part a raster could
// never give us — HOW MANY NAMES, AND FROM WHICH ZOOM.
//
// Why this exists. A raster bakes its labels into pixels, so the only way to get
// more of them is to change host, and in this household's part of the world
// (Antananarivo) every commercial raster was thin: "just a colored version of the
// lite basemap", then "you just bolded the street names, and very few places". In
// a style, label density is a handful of numbers — `DENSE` below — and they are
// ours. The upstream styles were written for the world's well-mapped cities; the
// labels this household needs (minor street names, the first neighbourhood
// places) start a zoom later there than they have to.
//
// Why a fetch and a patch, and not a forked style checked in. A fork is a copy
// of somebody's 43 KB of JSON that stops matching the day they rename a layer —
// silently, because a style that no longer has `highway-name-minor` still
// renders perfectly, just without the density anyone came for. So the upstream
// style is fetched and patched at RUN TIME, the ids this file rewrites are
// declared in `DENSE`, `tune()` reports which of them upstream no longer has, and
// `npm run smoke` fetches the live style and fails if that report is non-empty.
// The map still draws if the fetch fails: it falls back to the style URL itself,
// drawn by MapLibre with upstream density.
//
// Flat is enough. The household asked whether the map drew 3D buildings and, if
// so, whether they could go. They can, and they do: this map is read at a glance,
// on a phone, and `fill-extrusion` is the most expensive thing a style can ask
// for — every building a triangulated, shaded, depth-sorted prism, rebuilt as the
// map is panned. So no extrusion is drawn here, on EITHER key, and that is a
// property of the tuned OUTPUT rather than a promise in a comment: `tune()` drops
// every layer of that type by TYPE, so a 3D layer upstream adds later is dropped
// too. Two things this must not cost, and the reason it is not a one-line delete:
// the tile BYTES are unchanged (upstream's `building` data is in the same tiles
// the flat footprints need, so the saving is per-frame drawing, not download), and
// upstream prints buildings flat below z14 and then ONLY as extrusions — so
// dropping one deletes the buildings a viewer is looking at that closely. `FLAT`
// below names the flat layer that takes the footprints over, `tune()` lifts its
// zoom cap, and `npm run smoke` fails if a style, after tuning, still draws a
// `fill-extrusion` or leaves an extrusion's source-layer drawn by nothing at the
// zooms that extrusion covered.
//
// The styles are OpenFreeMap's, forked from OpenMapTiles', MIT-licensed. The
// credit their licence requires lives in /shared/basemaps.js.

window.HomeBasemapStyle = {
  // Upstream label layer id -> the zoom it should start printing at HERE.
  // Every id is one this file would silently lose if upstream renamed it, which
  // is why `tune()` reports the ones it could not find.
  DENSE: {
    'highway-name-minor': 14, // was 15: minor street names, the ones a viewer needs
    'highway-name-path': 15,  // was 15.5
    'poi_r1': 14,             // was 15: the first neighbourhood places
    'poi_r7': 15,             // was 16
    'poi_r20': 16,            // was 17
  },
  // Layers whose labels are given more room, so more of them survive the style's
  // own collision test at the zooms this household watches: a line label repeats
  // every 250px by default and two labels 2px apart are treated as colliding.
  ROOMIER: {
    'highway-name-minor': { 'text-padding': 1, 'symbol-spacing': 200 },
    'poi_r1': { 'text-padding': 1 },
  },
  // 3D layer id upstream draws -> the flat layer that takes its footprints over,
  // uncapped so they do not vanish with the 3D: upstream's `building` fill stops
  // at z14, exactly where `building-3d` starts. An id here that a style never had
  // is not a fault (the pale key is 2D throughout); a pair whose twin is gone is,
  // because then nothing draws those footprints and no declaration says so.
  FLAT: {
    'building-3d': 'building',
  },

  /** The style, tuned. Pure: the fetched style goes in, a patched copy comes
   *  out. `dense` (true unless explicitly false) asks for the tuned label set,
   *  which only the labelled key wants — the pale key's style is a deliberately
   *  smaller set of layers. Flatness is NOT one of those choices: every extrusion
   *  goes, on either key. `missing` names every declared layer id upstream no
   *  longer has — a signal rather than a silence, because the map looks fine
   *  either way; `flattened` names the 3D layers actually dropped. */
  tune(style, dense) {
    const tuned = JSON.parse(JSON.stringify(style))
    const missing = []
    const flattened = []
    if (dense !== false) {
      for (const [id, minzoom] of Object.entries(this.DENSE)) {
        const layer = (tuned.layers || []).find((l) => l.id === id)
        if (!layer) { missing.push(id); continue }
        layer.minzoom = minzoom
      }
      for (const [id, layout] of Object.entries(this.ROOMIER)) {
        const layer = (tuned.layers || []).find((l) => l.id === id)
        if (!layer) { missing.push(id); continue }
        layer.layout = Object.assign({}, layer.layout, layout)
      }
    }
    // Hand the footprints over BEFORE dropping anything: a twin that is missing,
    // or that draws a different dataset than the layer it replaces, is reported
    // instead of silently taking a set of buildings off the map.
    for (const [threeD, flat] of Object.entries(this.FLAT)) {
      const doomed = (tuned.layers || []).filter((l) => l.id === threeD)
      if (!doomed.length) continue
      const twin = (tuned.layers || []).find((l) => l.id === flat)
      if (!twin || twin['source-layer'] !== doomed[0]['source-layer']) { missing.push(flat); continue }
      delete twin.maxzoom
    }
    // …and then every extrusion, by TYPE rather than by the ids above, so one
    // upstream adds later is flat as well. An extrusion whose footprints nothing
    // took over is still dropped — 3D must not return by accident — which is
    // exactly what the suite then reports against the live style.
    tuned.layers = (tuned.layers || []).filter((l) => {
      if (l.type !== 'fill-extrusion') return true
      flattened.push(l.id)
      return false
    })
    return { style: tuned, missing, flattened }
  },

  _pending: {},

  /** The style for `url`: flattened always, and tuned when the key asks for it
   *  (`dense: true`). Never rejects: a style that cannot be fetched is returned
   *  as the URL, which MapLibre will fetch itself — an untuned map is a worse
   *  map, not a broken one. */
  load(url, dense) {
    const key = url + (dense ? ' #dense' : '')
    if (this._pending[key]) return this._pending[key]
    this._pending[key] = fetch(url, { credentials: 'omit' })
      .then((res) => { if (!res.ok) throw new Error(`${res.status} from ${url}`); return res.json() })
      .then((upstream) => {
        const { style, missing, flattened } = this.tune(upstream, !!dense)
        if (missing.length) {
          console.warn(`HomeBasemapStyle: upstream style no longer has ${missing.join(', ')} — those declarations had no effect`)
        }
        if (flattened.length) {
          console.warn(`HomeBasemapStyle: dropped ${flattened.join(', ')} (no 3D here)`)
        }
        return style
      })
      .catch((err) => {
        console.warn(`HomeBasemapStyle: ${err.message} — drawing the upstream style untuned`)
        return url
      })
    return this._pending[key]
  },
}
