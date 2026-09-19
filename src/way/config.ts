// config.ts
// All tunable constants for the GPS state machine + geofence engine, in
// one place. Edit values here and redeploy -- nothing else needs to change.
// Values and meanings are a 1:1 port of the equivalent constants in
// fleet_tracker.py.
//
// These are the tracking tunables only. Constants for persistence and
// notification policy live at the top of src/way/do/FleetDO.ts, and
// frontend-only constants in CONFIG in public/way/index.html (the document
// the Worker actually serves).

export const WAY_CONFIG = {
  // ---- Geofence entry/exit guards ----
  // Seconds a device must dwell inside a fence before entry is confirmed.
  ENTRY_GUARD_SECONDS: 30,
  // Seconds a device must be outside the (wider) exit radius before exit
  // is confirmed -- absorbs GPS boundary jitter.
  EXIT_GUARD_SECONDS: 30,
  // Fallback added to a geofence's entry radius to get its exit radius,
  // when the geofence row doesn't specify exit_radius_m explicitly.
  EXIT_RADIUS_BUFFER_M: 40.0,
  // Fallback entry radius (metres) for a geofence row with no radius_m set.
  DEFAULT_GEOFENCE_RADIUS_M: 50.0,

  // ---- Speed classification ----
  // Rolling average window size (number of pings) used to smooth speed
  // before classifying walking vs. driving.
  SPEED_BUFFER_SIZE: 3,
  // km/h -- at/above this, average speed counts as "moving with intent"
  // (used both for entry-guard speed gating and driving vs walking).
  WALKING_DRIVING_THRESHOLD: 10.0,
  // km/h -- below this, the device counts as stationary rather than
  // slow-moving/walking.
  STATIONARY_SPEED_THRESHOLD: 2.0,
  // km/h -- a ping implying speed above this is treated as a GPS glitch
  // and dropped before it reaches the state machine at all.
  PRE_FILTER_SPEED_LIMIT: 120.0,
  // ---- Device-REPORTED speed: when to believe it ----
  // Metres the device must have MOVED since the previous ping before µlogger's
  // speed field is believed. Indoors a parked phone's GNSS reports 5-30 km/h
  // while its coordinates jitter inside a few metres, and a report claiming
  // movement the coordinates do not show is what makes a phone on a table look
  // like it is driving: the point is persisted as a track dot, its distance
  // lands in the driven totals and the approach ETA is computed from it.
  // Deliberately the same order as ANCHOR_RADIUS_M -- this is the app's
  // existing unit of "that was real movement", not a new threshold.
  REPORTED_SPEED_MIN_MOVE_M: 20.0,
  // Seconds. Below this gap the coordinates cannot separate a crawl from a
  // jittering fix (5 m of jitter in 1 s IS 18 km/h), so the report stands:
  // there the phone is the better signal, not the positions.
  REPORTED_SPEED_MIN_GAP_S: 5.0,
  // Seconds a dip below WALKING_DRIVING_THRESHOLD must persist before a
  // driving leg is reclassified as walking (absorbs traffic/potholes).
  WALKING_GUARD_SECONDS: 30,

  // ---- Anchor-based stay/travel motion engine ----
  // Metres a device must move from its anchor point before a departure
  // is even considered (absorbs GPS bounce while parked/stationary).
  ANCHOR_RADIUS_M: 20.0,
  // Seconds a candidate departure must be sustained before it's confirmed
  // as real movement (vs. a brief wander back to the same spot).
  MOVEMENT_CONFIRM_SECONDS: 15,
  // Seconds a device must stay within ANCHOR_RADIUS_M of a candidate stop
  // point before a travel leg is confirmed ended. Reuses WALKING_GUARD_SECONDS
  // in the original Python; kept as its own named value here so it can be
  // tuned independently if you ever want that.
  STOP_CONFIRM_SECONDS: 30,
} as const;
