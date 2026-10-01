/**
 * `src/way/lib/export.ts` — the CSV/KML builders — under `node --test`.
 *
 * Home is the deployable Worker, so this is the copy that actually serves the
 * household; it is the mirror of `../W.A.Y/tests/export.test.mjs`; keep the two
 * in step. (Unlike the tracking engine, this file is still byte-identical to
 * W.A.Y's.)
 *
 * These are the download formats, not just a formatting convenience: the CSV
 * header order is the fleet_tracker.py contract the household's spreadsheets
 * were built against, and the null/zero/bool rendering is where a small edit
 * silently corrupts an export instead of failing loudly. One real bug already
 * lived next door (W-A3: the dashboard asked for a UTC day instead of a
 * Nairobi day, so "Sep 30" exported 03:00-03:00 — see way-export-window.test.mjs).
 *
 * The TS is imported directly: `npm test` preloads scripts/way-ts-hooks.mjs so
 * the Worker's extensionless imports resolve.
 *
 * No dev server, no database, no mocks — unlike `npm run smoke`.
 * Run: `npm test`. `npm run verify` = check + test + smoke.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCsv, buildKml } from '../src/way/lib/export.ts'

const HEADER =
  'timestamp,latitude,longitude,altitude,speed_kmh,is_driving,is_stationary,is_inside_geofence,geofence_name,distance_km'

/** A complete GpsPingRow; per-case tests override only the fields they care about. */
function ping(overrides = {}) {
  return {
    id: 1,
    device_id: 'alice',
    timestamp: '2026-10-01T06:30:00Z',
    latitude: -18.8792,
    longitude: 47.5079,
    altitude: 1285,
    speed: 42.5,
    speed_avg_30s: 40,
    is_inside_geofence: 0,
    geofence_name: null,
    is_driving: 1,
    distance_km: 5.25,
    is_stationary: 0,
    is_keep_alive: null,
    battery: null,
    accuracy: null,
    leg_id: null,
    created_at: '2026-10-01T06:30:05Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------- CSV contract

test('the CSV header is the fixed column contract, in order', () => {
  assert.equal(buildCsv([]), HEADER)
})

test('a full CSV row renders every field in column order', () => {
  const [, row] = buildCsv([ping()]).split('\n')
  assert.deepEqual(row.split(','), [
    '2026-10-01T06:30:00Z', '-18.8792', '47.5079', '1285', '42.5',
    'true', 'false', 'false', '', '5.25',
  ])
})

test("SQLite's 0/1 flags render as false/true", () => {
  const [, row] = buildCsv([
    ping({ is_driving: 0, is_stationary: 1, is_inside_geofence: 1 }),
  ]).split('\n')
  assert.deepEqual(row.split(',').slice(5, 8), ['false', 'true', 'true'])
})

test('nulls become empty fields, but 0 stays 0', () => {
  const [, nullRow, zeroRow] = buildCsv([
    ping({ altitude: null, speed: null, distance_km: null }),
    ping({ altitude: 0, speed: 0, distance_km: 0 }),
  ]).split('\n')
  assert.deepEqual(nullRow.split(',').slice(3, 5), ['', ''])
  assert.deepEqual(nullRow.split(',').slice(9), [''])
  assert.deepEqual(zeroRow.split(',').slice(3, 5), ['0', '0'])
  assert.deepEqual(zeroRow.split(',').slice(9), ['0'])
})

test('a geofence name is always quoted, and inner quotes are doubled', () => {
  const csv = buildCsv([
    ping({ geofence_name: 'Home' }),
    ping({ geofence_name: 'Home "gate"' }),
    ping({ geofence_name: 'Beans, dry' }),
  ])
  assert.ok(csv.includes(',"Home",'), 'plain name: quoted')
  assert.ok(csv.includes('"Home ""gate""'), 'inner quotes: doubled')
  assert.ok(csv.includes('"Beans, dry"'), 'a comma inside stays one field')
})

test('rows are LF-joined; this format is not the CRLF household CSV', () => {
  // Laoka's shopping-list hand-off is CRLF on purpose; this one is consumed
  // by spreadsheet imports and the dashboard's own download, and is LF.
  const csv = buildCsv([ping(), ping({ timestamp: '2026-10-01T06:31:00Z' })])
  assert.equal(csv.includes('\r'), false)
  assert.equal(csv.split('\n').length, 3)
})

// ------------------------------------------------------------------ KML shape

test('KML coordinates are longitude,latitude,altitude with null altitude as 0', () => {
  const kml = buildKml('alice', [
    ping({ longitude: 47.5, latitude: -18.88, altitude: 1285 }),
    ping({ longitude: 47.6, latitude: -18.89, altitude: null }),
  ])
  assert.ok(kml.includes('47.5,-18.88,1285\n47.6,-18.89,0'))
})

test('KML escapes XML special characters in the device id (both names)', () => {
  const kml = buildKml('a&b<c>d"e', [])
  assert.ok(kml.includes('<name>a&amp;b&lt;c&gt;d&quot;e track</name>'))
  assert.ok(kml.includes('<name>a&amp;b&lt;c&gt;d&quot;e</name>'))
  assert.equal(kml.includes('a&b'), false, 'the raw id never reaches the XML')
})

test('KML keeps its envelope for a device with no pings', () => {
  const kml = buildKml('alice', [])
  assert.ok(kml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
  assert.ok(kml.includes('<kml xmlns="http://www.opengis.net/kml/2.2">'))
  assert.ok(kml.includes('<LineString>'))
  assert.ok(kml.includes('<tessellate>1</tessellate>'))
  assert.ok(kml.includes('<coordinates>') && kml.includes('</coordinates>'))
  assert.ok(kml.trimEnd().endsWith('</kml>'))
})
