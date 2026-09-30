// ─── One way to draw a background, for both maps ──────────────────
// A key in /shared/basemaps.js says WHAT the background is; a style in
// /shared/basemap-style.js says what it prints; this file is the only code that
// turns either into layers on a Leaflet map. Both maps call it — the household's
// /way/ map when the menu picks a key, the public /live share when it makes its
// one background — so a page cannot draw a background of its own, and the two
// maps cannot disagree about what "LITE" or "STREETS" means.
//
// It draws a VECTOR key as MapLibre GL (through a Leaflet layer, so every
// marker, track, fence and label this app already owns stays a Leaflet layer in
// its own pane, untouched) and a RASTER key as ordinary Leaflet tile layers.
// The raster branch is here because that is the shape a commercial or satellite
// background arrives in, and because the one host that has never blocked this
// app is a raster one.
//
// The credit is part of the drawing, not a decoration added at the call site: a
// key's `attribution` is put on the map's attribution control while the key is
// drawn and taken off when it goes, which is a condition of using somebody
// else's tiles.
//
// Not here on purpose: which key is the default (the household map's CONFIG owns
// that) and when to switch (the page's menu owns that).

window.HomeBasemapLayer = {
  /** Draw `key` onto `map`. Async, because a vector key's style is fetched and
   *  tuned first (see /shared/basemap-style.js). An unknown key draws the first
   *  declared one rather than nothing: a typo must not leave the household, or
   *  an outsider, staring at an empty map. Returns what it drew, so the caller
   *  can hand it back with `end()`. */
  async show(key, map) {
    const keys = window.HomeBasemaps || {}
    const chosen = keys[key] ? key : Object.keys(keys)[0]
    const base = keys[chosen] || {}
    const layers = []

    if (base.style) {
      const style = await window.HomeBasemapStyle.load(base.style, !!base.dense)
      layers.push(window.L.maplibreGL({ style: style }))
    } else if (base.url) {
      const opts = { maxZoom: 20, maxNativeZoom: base.maxNativeZoom, minZoom: 3 }
      layers.push(window.L.tileLayer(base.url, opts))
      ;(base.overlays || []).forEach(function (url) {
        layers.push(window.L.tileLayer(url, opts))
      })
    }

    layers.forEach(function (layer) { layer.addTo(map) })
    if (base.attribution && map.attributionControl) {
      map.attributionControl.addAttribution(base.attribution)
    }
    return { key: chosen, layers: layers, credit: base.attribution || '' }
  },

  /** Take a drawn background back off the map — credit included. A name layer
   *  left behind keeps naming the places of the background the user just left,
   *  printed over the one they chose, with nothing on screen saying which is
   *  which. */
  end(shown, map) {
    if (!shown) return
    shown.layers.forEach(function (layer) { if (map.hasLayer(layer)) map.removeLayer(layer) })
    if (shown.credit && map.attributionControl) {
      map.attributionControl.removeAttribution(shown.credit)
    }
  },
}
