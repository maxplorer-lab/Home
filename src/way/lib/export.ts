// export.ts
// KML/CSV generation from synced GpsPingRow history. Direct port of
// fleet_tracker.py's export feature -- same columns, same simple track
// (LineString) + placemark shape, just built from D1 rows instead of
// local SQLite.

import { GpsPingRow } from "../types";

export function buildCsv(pings: GpsPingRow[]): string {
  const header = [
    "timestamp", "latitude", "longitude", "altitude", "speed_kmh",
    "is_driving", "is_stationary", "is_inside_geofence", "geofence_name", "distance_km",
  ].join(",");

  const rows = pings.map((p) =>
    [
      p.timestamp,
      p.latitude,
      p.longitude,
      p.altitude ?? "",
      p.speed ?? "",
      p.is_driving ? "true" : "false",
      p.is_stationary ? "true" : "false",
      p.is_inside_geofence ? "true" : "false",
      p.geofence_name ? `"${p.geofence_name.replace(/"/g, '""')}"` : "",
      p.distance_km ?? "",
    ].join(",")
  );

  return [header, ...rows].join("\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildKml(deviceId: string, pings: GpsPingRow[]): string {
  const coordinates = pings.map((p) => `${p.longitude},${p.latitude},${p.altitude ?? 0}`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(deviceId)} track</name>
    <Placemark>
      <name>${escapeXml(deviceId)}</name>
      <LineString>
        <tessellate>1</tessellate>
        <coordinates>
${coordinates}
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
}
