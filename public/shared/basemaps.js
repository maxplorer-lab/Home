// ─── The map background, in ONE place ─────────────────────────────
// Both maps read this file: the household's /way/ map and the outsider's /live
// share — and nothing draws a background of its own (/shared/basemap-layer.js is
// the only code that turns a key into a Leaflet layer). It exists because a
// hardcoded tile URL is a dependency on somebody else's policy, and this app has
// now been on the wrong end of that twice.
//
// 2026-09-20 — the block that started this file. The share pointed at OSM's
// standard tiles (tile.openstreetmap.org), a server run on donated hardware. OSM
// began answering every request that identified itself as this app with a BLANK
// 256x256 tile — and, in a browser, with https://osm.wiki/blocked ("this app is
// not following the tile usage policy of OpenStreetMap's volunteer-run
// servers"). The block is per-APP, not per-IP: the identical request sent with
// no Referer still returns a real tile, which is exactly how this looks fine in
// curl and broken on the phone that matters. A household app has no business on
// a donated server, so both maps moved to Esri's ArcGIS Online rasters: keyless,
// CDN-hosted, commercial, and (for the share) carrying the place names an
// outsider needs to read "where is she?".
//
// 2026-09-30 — why choosing better rasters could not fix it. The household's
// words about the labelled map were "esri is not detailed enough, just a colored
// version of the lite basemap", and after swapping in Esri's topographic raster
// plus its place-name reference layer: "you just bolded the street names, and
// very few places". Both are the same finding. A raster bakes its labels in, so
// the only lever left is WHICH raster — and in this household's part of the
// world (Antananarivo) every Esri style prints the same roads with almost no
// names, thinning fast as you zoom in: its name layer returns ~14 KB of labels
// at z16, 2.5 KB at z18 and under 1 KB at z19, while the roads behind them stay.
// Label density is a decision made INSIDE a style, so the map now draws a VECTOR
// background — MapLibre GL, tiles and styles from OpenFreeMap (keyless, no
// registration, no request limit, commercial use allowed, MIT styles) — and that
// decision is ours: /shared/basemap-style.js holds it, and `dense: true` below is
// the key it applies to. The same file also decides that buildings print FLAT, on
// both keys: an extrusion is the heaviest thing a style can draw and this map is
// read at a glance, on a phone.
//
// What a key is now. `style` is a vector style URL: MapLibre draws the map, and
// the labels are re-laid-out at every zoom instead of being pixels. `url` is a
// raster tile template, kept because it is the shape a commercial or satellite
// background arrives in — and because Esri's is the one background that has
// never blocked this app. Esri's path is /tile/{z}/{y}/{x}: ROW before COLUMN,
// the reverse of OSM's {z}/{x}/{y}, and swapping them by hand draws the right
// zoom of the wrong place, which reads as "the map is wrong" rather than "the
// URL is wrong". Every key must also say who to credit: that is a condition of
// using somebody else's tiles, not decoration.
//
// Add a basemap by adding a key here; the household map's menu is generated from
// these keys, so a new one appears without touching the page.

window.HomeBasemaps = {
  // The household's default (`setLayer('lite')`): the pale canvas, so markers,
  // tracks and geofences pop instead of competing with the map.
  lite: {
    label: 'LITE',
    style: 'https://tiles.openfreemap.org/styles/positron',
    // Vector tiles are native to z14 and drawn OVERZOOMED past it, with labels
    // laid out fresh at every zoom — so this ceiling is the map's, not a host's.
    maxNativeZoom: 20,
    attribution: 'OpenFreeMap &copy; OpenMapTiles — data &copy; OpenStreetMap contributors',
  },

  // The labelled map, and the ONLY background an outsider gets on /live. Place
  // names are the point: a pale canvas with a dot on it answers "moving" but not
  // "where". This is the key `dense: true` applies the tuned label density to —
  // street names and neighbourhood places a zoom earlier than upstream prints
  // them, which is the whole reason the map stopped being a raster. Its buildings
  // are drawn flat (upstream's own would rise into 3D from z14), with the flat
  // footprints kept at every zoom — see `FLAT` in /shared/basemap-style.js.
  streets: {
    label: 'STREETS',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    dense: true,
    maxNativeZoom: 20,
    attribution: 'OpenFreeMap &copy; OpenMapTiles — data &copy; OpenStreetMap contributors',
  },
};
