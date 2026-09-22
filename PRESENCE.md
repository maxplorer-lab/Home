# Presence: telling "parked but online" from "no word from the phone"

**Status: PLAN ONLY — nothing in this file is implemented.**

Scope narrowed on 2026-09-21 by the owner, and this file now says exactly that and
nothing more:

> *"What we want is just a proof that the device can access the internet, but it
> stands still. So it can stand still for hours, but our dashboard shows exactly:
> I received a signal from it that it has access to internet, but nothing to
> register — or it is inside a geofence. While the '1 min ago' / timestamp of
> last online shows up when the server actually got no signal from the device at
> all for a while, so either μlogger killed or out of network. No need to
> differentiate. What we need is: still online without movement, or completely
> offline and we don't know what is happening now."*

**Two states. Not a five-rung ladder.** An earlier draft of this file proposed
`live / idle / quiet / silent / unknown` with battery and network payloads; that
is dropped. It answers a question nobody asked and it would have put more words
on a card that is already crowded.

| State | Means | The tell |
| --- | --- | --- |
| **A · Online, standing still** | the device reached us, and it has nothing to record — parked, or sitting inside a fence | freshness is **contact** age: something arrived from that phone seconds ago |
| **B · No word** | nothing at all arrived for a while — μlogger killed, no network, powered off, location off. We do not know which, and we will not claim to | freshness is the **last time we heard anything**, shown as a time |

Both are already nearly true in the data (see §2). What is missing is one stamp
that survives a *dropped* ping, and one setting on the phone that lets a parked
phone speak at all.

---

## 1. The real cause: the phone is silent when standing still

Verified in μlogger's source, not assumed:

* `utils/LocationHelper.java` → `requestProviderUpdates()` passes
  `minTimeMillis, minDistance` straight into
  `locationManager.requestLocationUpdates(...)` — **the distance gate is handed to
  Android itself**, so with a distance set, a parked phone gets no location
  callback at all.
* The same file's `hasRequiredDistance()` re-checks it in-app (`distance >=
  minDistance`), and `services/LoggerService.java` → `meetsCriteria()` refuses to
  record unless distance **and** accuracy pass. Only then does `DbAccess.writeLocation`
  run — i.e. nothing is queued, so nothing is uploaded.

The app's own suggested starting profile for motorbiking is "1 minute / 500 m".
**With any distance gate set, a parked phone produces no points at all.** The
stream is not lossy; the phone simply has nothing to say.

**And the one setting that fixes it:** `minDistance = 0` makes the distance test
a tautology (`distance >= 0`), so the `Time` interval alone decides. From that
moment a parked phone uploads one fix per interval — which is precisely the
"proof it can access the internet" the owner is asking for. Everything the
backend already does with a parked fix (§2) then keeps the map clean.

Residual case, stated honestly: with `minDistance = 0` the phone still uploads
**nothing** when it cannot get a fix good enough for its own accuracy gate
(indoors, no sky view). There, state B is unavoidable without a beacon that needs
no GNSS at all — §5. That is a *later* decision; it is not needed for the
"parked at home / parked at the destination" case.

## 2. What the code already gives us (verified)

* **The intake already counts every arrival before any gate.** `FleetDO.handleIngest`
  calls `this.countGate("received", …)` at the entry to intake, and the ledger's
  own doc-comment insists `received` must equal `accuracy + glitch + accepted`.
  So "the phone spoke" is *already* a recorded fact — it is just never surfaced as
  a clock. **`seen_at` is stamped right there**, which is why the server half of
  this needs no phone change and no new gate.
* **An accepted-but-not-stored ping already moves the badge.** `device_state`
  updates "on every ping regardless of the throttle or the pause flag" — the
  `saveDeviceState` call carries the fresh `lastStatus` and runs on the same path
  whether the ping goes on to be drawn, collapsed, or paused
  (`FleetDO.handleIngest`, immediately after the persistence decision). A
  stationary ping is counted `collapsed`, writes no track row, and still freshens
  `lastStatus` — which the badge reads over the WS snapshot (`buildSnapshot() →
  devices[deviceId]`) and the HTTP status endpoint reads straight out of the row
  (`dashboard-api.ts`). A parked phone that uploads therefore already reads as
  fresh **today**, with no changes at all.
* **The gap is exactly the dropped ping.** The accuracy gate and the glitch
  filter `return` before `lastStatus` is touched, so a phone indoors whose fixes
  all rate worse than 10 m — or whose fixes all imply impossible speed — is
  invisible even though it is uploading every minute. `seen_at` at the entry to
  intake closes that hole and nothing else needs to move.
* **What the badge says today** is one ladder on the *fix* age
  (`renderBadges`): `<2 min` → `Live`, `<60 min` → `N Min Ago`, else the clock
  time in the offline style. `Live` conflates "moving" with "fresh", and a phone
  parked since 14:00 is indistinguishable from a phone that died at 14:00.
* **What the share says today** (`public/live/index.html` → `ago()`): `live · 12s
  ago` / `last seen 25 min ago`. **What the HUD says** (`hud-cadence`, plus the
  `fresh` readout): `12s ago` / `25m ago`.
* Nothing here is durable in `way-db`: `device_state` is one JSON blob in the DO's
  own SQLite. That is fine — presence is a *live* readout, and the ledger already
  carries the durable history of arrivals.

## 3. The change, smallest first

**Step 1 — the stamp (server only, no phone change, no new surface).**
Add `seenAt` to the device state, stamped where `countGate("received", …)` already
runs, so it survives accuracy drops, glitch drops, collapses, pauses and
unwitnessed exits alike. Carry it in the existing status payload and WS snapshot.
Then the three readouts switch to the two states:

| Readout | State A (contact fresh) | State B (no contact) |
| --- | --- | --- |
| badge status row | `Online · 40s ago` (existing live colour) | `No signal since 21:40` |
| badge activity row | unchanged (`At Home`, `Stationary`, `42 km/h`, `Walking`) | `Last known: At Home` |
| HUD cadence | `12s ago` — unchanged, it is the same clock | `25m ago` — unchanged |
| share | `live · 12s ago` | `last seen 25 min ago` — unchanged, plus the word `no signal` |

The activity row already carries "inside a fence" (`At Home`), so state A with
`At Home` *is* the owner's sentence: *"I received a signal, but there is nothing
to register, or it is inside a geofence."* Presence replaces wording in rows that
already exist; it **adds no row**.

**Step 2 — the phone setting (one field, two phones).** μlogger → Settings →
Recording: **Distance = 0**, Time unchanged (60 s recommended for a crisp
presence, 120 s to be kinder to the battery), Accuracy left at 10 m. Nothing in
the backend changes for this to work; the parked fixes are collapsed or dropped
inside the fence exactly as they are today, and §2's stamp is what turns them
into "online".

**Step 3 — optional, only if Step 1+2 prove insufficient indoors.** A beacon with
no GNSS at all — §5. Decide after watching real data (§4), not before.

Thresholds (`PRESENCE_ONLINE_WINDOW_MIN`, and the wording) belong in
`src/way/config.ts` and are mirrored on the page and smoke-checked, the way
`PRE_FILTER_SPEED_LIMIT` and the approach thresholds already are.

## 4. Watch this before touching any threshold

With `minDistance = 0`, a parked phone becomes a stream of jitter fixes. The
backend is already built for it: inside a fence nothing is drawn at all, and away
from a fence a departure needs `ANCHOR_RADIUS_M` (20 m) sustained for
`MOVEMENT_CONFIRM_SECONDS` (15 s). But two fixes each rated ≤10 m can legitimately
sit ~20 m apart while the phone is on a table — exactly at that anchor radius — so
**parked outside a fence is the one place a micro-leg could appear.** Watch for it
in the ledger and in a reviewed day; if it shows up, the knob is
`ANCHOR_RADIUS_M`, and it should be raised on evidence from real pings rather than
guessed at today.

The same applies to the accuracy gate: `minDistance = 0` will produce many
over-limit fixes indoors, which the intake drops **silently, as designed**. That
drop is now visible as `received` minus `accepted` in the ledger — which is the
whole reason `seen_at` is taken before the gate rather than after it.

## 5. The beacon — what it costs, and why not μlogger's external commands

μlogger's "allow external commands" switch accepts broadcasts to
`ExternalCommandReceiver` with `command` being exactly **`start logger`**,
**`start new logger`** (extra `overwrite`), **`stop logger`** or **`start
upload`** — case-sensitive, gated behind `KEY_ALLOW_EXTERNAL` (source:
`ExternalCommandReceiver.java`). There is **no "log a point now"**, so none of
them can be the presence heartbeat:

* both `start logger` and `start new logger` begin a **new track**
  (`DbAccess.newAutoTrack` / `newTrack`) — they fragment the phone's own track
  history, and if the previous track is overwritten it can discard points that
  had not yet been uploaded;
* neither forces a fix past the distance or accuracy gates;
* `start upload` runs only when `DbAccess.needsSync` is already true, so it
  pushes *what is queued* and creates nothing.

`start upload` is genuinely useful for one unrelated thing — forcing a catch-up
flush after an offline spell — and worth keeping in the toolbox for that reason
alone.

A true beacon is therefore a small authenticated `POST /way/api/beacon` (per-device
token, no position required) triggered by something on the phone that can make an
HTTP request on a schedule — an automation app, not μlogger. It would cover the
one case Step 1+2 cannot: *online, indoors, with no usable fix*. Cost of adding it
later: one endpoint, one token, one phone recipe. Deliberately **not** part of this
scope until the data says it is needed.

## 6. What must not break

* Presence is **metadata about the link**, never a data point. It must not enter
  the track, the trips, the driven/walked distances, the geofence engine or the
  chat volume. A parked phone's pings stay collapsed/dropped exactly as they are.
* **Never print "offline" as a fact.** Powered off, out of coverage, location
  off and μlogger killed are indistinguishable; the words are `no signal since
  …`, which is what is actually known.
* The stamp is taken **before** the gates, so it can never be a claim about
  position — only about contact.
* Free tier: the stamp lives in the DO's in-memory state with the existing
  state write, not one D1 row per contact. A parked phone at 60 s adds ~1,440
  arrivals/day/device at the intake (already counted today) and **zero** new D1
  rows.
* The badge keeps its one-row discipline: the approach pulse already borrows the
  status row, and presence must not become a second thing fighting for it.

## 7. Decisions this plan needs from the owner

1. **When does B begin?** No contact for 5 minutes is proposed (a 60 s cadence
   gives five misses of slack).
2. **Do the words read right?** `Online · 40s ago` for A, and `No signal since
   21:40` for B, are the proposal.
3. **Does the share show A as well as B?** (An outsider watching a parked car
   benefits from both halves of this.)
4. **Step 2 now or after Step 1 ships?** They are independent: the setting alone
   makes the ledger show arrivals while parked, the stamp alone makes the badge
   honest about a phone that is already uploading.
