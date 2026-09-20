// ─── The map background, in ONE place ─────────────────────────────
// Both maps read this file: the household's /way/ map and the outsider's
// /live share. It exists because a hardcoded tile URL is a dependency on
// someone else's policy, and on 2026-09-20 that policy moved under us.
//
// WHAT HAPPENED. The share pointed at OSM's standard tiles
// (tile.openstreetmap.org), a server run on donated hardware. OSM began
// answering every request that identified itself as this app with a BLANK
// 256x256 tile — and, in a browser, with https://osm.wiki/blocked ("this app is
// not following the tile usage policy of OpenStreetMap's volunteer-run
// servers"). The block is per-APP, not per-IP: the identical request sent with
// no Referer still returns a real tile, which is exactly how this looks fine in
// curl and broken on the phone that matters. A household app has no business on
// a donated server, so both maps now draw on Esri's ArcGIS Online rasters — the
// provider the household map already used, keyless, CDN-hosted, and (for the
// share) carrying the place names an outsider needs to read "where is she?".
//
// THE TRAP, and the reason this is a file and not two URLs: Esri's tile path is
// /tile/{z}/{y}/{x} — ROW before COLUMN, the reverse of OSM's {z}/{x}/{y} — so
// editing a URL by hand silently draws the wrong part of the world at the right
// zoom, which looks like "the map is wrong" rather than "the URL is wrong".
//
// Add a basemap by adding a key here; the household map's menu is generated
// from these keys, so a new one appears without touching the page.

window.HomeBasemaps = {
  // The household's default (`setLayer('lite')`): neutral and minimal, so
  // markers, tracks and geofences pop. This is the BASE canvas and carries no
  // labels — the badge is what says the address in words.
  lite: {
    label: 'LITE',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    maxNativeZoom: 16,
    attribution: '&copy; <a href="https://goto.arcgisonline.com/maps/World_Light_Gray_Base">Esri</a>, HERE, Garmin, &copy; OpenStreetMap contributors',
  },

  // The labelled street map, and the ONLY background an outsider gets on /live.
  // Place names are the point: a grey canvas with a dot on it answers "moving"
  // but not "where".
  streets: {
    label: 'STREETS',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    maxNativeZoom: 19,
    attribution: '&copy; <a href="https://goto.arcgisonline.com/maps/World_Street_Map">Esri</a>, HERE, Garmin, &copy; OpenStreetMap contributors',
  },
};
