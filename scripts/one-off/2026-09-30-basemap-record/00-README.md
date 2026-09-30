# The map's upstream is a record now (2026-09-30)

**Status: done, guarded, falsified. No SQL, no config, no secret, no account.**
Smoke §9's third-party checks — the two style JSONs, their TileJSON and one real
tile — no longer fetch the tile host while they run. They judge a copy of it,
`scripts/fixtures/basemaps/`, written by `npm run basemaps:record` and judged in
CI by `npm run audit:basemaps`.

## What was wrong

One red answered two questions. A style that upstream had renamed, a CDN blip and
a laptop on a train all printed the same failing checks, and the fix is different
in each case: re-record upstream, wait, or plug the laptop in. The green was worse
— a suite that fetches to answer also passes *because* it fetched, so the same
command in two places was two different tests:

* `npm run smoke` on the machine with the good connection: judged the real thing.
* the same command in CI, or on a phone hotspot: judged nothing, or judged a stale
  cached response, and said "green".

The checks in question are about somebody else's server by nature, so this was not
a bug in them — it was a missing seam. As long as the network was inside the
check, no amount of care in the check could make it deterministic.

## The fix

| File | Owns |
| --- | --- |
| `scripts/lib/basemap-record.mjs` | **the upstream, as a record**: the walk (a declared key's style → its vector sources → each source's TileJSON → one tile at the household's own view, at the zoom the source calls deepest, plus one over open water as the control), the copy on disk, the MVT reader that says which layers a tile carries, and the two reader seams (`recordReader` / `liveReader`) the callers plug in |
| `scripts/fixtures/basemaps/` | the copy itself: `index.json` (url, kind, view, bytes, sha256, `recordedAt`) plus one file per URL — 5 entries, 369 KB |
| `scripts/basemap-record.mjs` | `npm run basemaps:record` — the ONLY thing in this repo that talks to the tile host on purpose. Runs the guards' own walk with a recording reader, prints a per-URL diff (same / changed / new / removed, by sha256), then judges what it recorded |
| `scripts/basemap-record-audit.mjs` | `npm run audit:basemaps` — the CI half: the same judgment on the record, read-only, and the recorded hosts are REFUSED, so a check that quietly went back to fetching fails instead of passing |
| `scripts/smoke.mjs` (smoke §9) | the same walk and judgment, against the record; `SMOKE_LIVE=1 npm run smoke` asks the real servers instead |
| `.github/workflows/gates.yml` | the audit joins the `gates` job (offline, seconds) and its driver joins the `guards` job |

One walk, three callers. That is the load-bearing decision: the recorder builds the
record by running the SAME walk the checks run, so the record cannot list a roster
the checks do not read, and a key whose URL nobody recorded is a failed check
rather than a silently unchecked background. The reader is the only seam:

```
read(url, meta) -> { bytes, contentType, status }      recordReader: from the copy
                                                       liveReader:   the real thing
                                                       (and the recorder's sink)
```

## The rules the record is held to

| Rule | Why |
| --- | --- |
| **The copy is the SUBJECT, not a fallback** | a guard that prefers the network answers a different question depending on the weather. Live is asked for out loud (`SMOKE_LIVE=1`, `--live`) |
| **The wall is shown to hold** | record mode replaces `fetch` with a refusal for the recorded hosts, and the audit asks for one on purpose: if the ban did not bite, that is a finding, because "runs without network" is otherwise a claim nobody tests |
| **A walk that missed something writes nothing** | a transient failure must never drop an entry, or a missing entry reads as "upstream stopped serving this" instead of "the laptop was on a train" |
| **A copy knows its own age** | past `STALE_DAYS` (120) it is reported rather than judged — the CI audit treats it as a fault, an interactive smoke run prints it as a note |
| **The diff is printed where a person is looking** | `basemaps:record` says what changed, by sha256, before it judges: refreshing upstream is the moment it gets to change its mind |

## The guards

* `npm run audit:basemaps` — the whole third-party block in CI: no record, a stale
  record, a declared key with no recorded bytes, a recorded style that loses the
  tuned label layers, a recorded style still drawing 3D or losing footprints, an
  empty tile at the household's own view, a missing `building`/`transportation`/
  `place`, a control tile that carries them, or a disarmed offline ban.
* smoke §9's four checks — the same judgments with the served pages in hand:
  `the style each key draws still has the label layers the tuner rewrites`,
  `a style draws no 3D, and loses no footprint with it`,
  `the basemap actually paints at the household's own street level`,
  `…and a tile with nothing in it fails that check`.

## Falsified

Two drivers, because the two surfaces need different things:

`node scripts/one-off/2026-09-30-basemap-record/mutate.mjs` — the audit's own six,
with no server at all (seconds):

```
R1  caught=YES  exit=  1  restored=yes  (the record is gone, so there is nothing to answer about)
R2  caught=YES  exit=  1  restored=yes  (the recorded TileJSON names a release the record has no bytes for)
R3  caught=YES  exit=  1  restored=yes  (the household view is handed the open-water payload)
R4  caught=YES  exit=  1  restored=yes  (the paint requirement is emptied, so the check can never fail)
R5  caught=YES  exit=  1  restored=yes  (the record is older than the staleness bound and judged anyway)
R6  caught=YES  exit=  1  restored=yes  (the offline ban is disarmed, so the audit could answer from the network)

all 6 mutations caught by the audit they attack; tree restored
```

`node scripts/one-off/2026-09-30-basemap-names/mutate.mjs M7 M8 M9 M10` — the
half that needs the running app, because smoke §9 reads the SERVED documents
(whole suite per mutation, ~7 minutes each):

```
M7  caught=YES  restored=yes  reached9=yes  (the household's own view is moved to open water: a green suite drawing nothing)
M8  caught=YES  restored=yes  reached9=yes  (the paint requirement is emptied, so the check can never fail)
M9  caught=YES  restored=yes  reached9=yes  (the recorded TileJSON names a release the record has no bytes for)
M10 caught=YES  restored=yes  reached9=yes  (the record hands the open-water tile over as the household view)

all 4 mutation(s) caught by the guard they attack; tree restored
```

`reached9` matters more than usual here: M9 and M10 change nothing a page can see,
so a run that never got past smoke §9 would otherwise read as "the guard stayed
green".

## The part worth remembering

* **A copy is only worth having as the subject.** The first draft of this idea was
  "fetch, and fall back to a recorded response when offline" — which keeps the
  network in the answer, and therefore keeps the flakiness. The subject is the
  record; the network is a mode you ask for.
* **The recorder must walk the guards' walk.** Anything else is two rosters that
  drift: the record would grow entries nobody judges, and the checks would miss
  URLs nobody recorded. Sharing one module is what makes "record a new provider"
  impossible to do halfway.
* **A `read` seam is what makes three callers cheap.** The recorder, the audit and
  the suite differ only in which function answers `read(url)`; the walk, the
  judgments and the messages are one implementation, so a fix in one is a fix in
  all three (this change found its own bug exactly once, in the ban control — see
  below).
* **A control that runs after its own subject is restored proves nothing.** The
  audit's "the ban bit" check was written *after* the ban was lifted, so it asked
  the network and reported that the ban was blind. It now runs inside the ban —
  and R6 exists so that a future edit cannot quietly move it back out.
* **`process.exit()` with a fetch in flight is a crash on Windows.** The audit's
  fault path aborts (`UV_HANDLE_CLOSING`) when it hard-exits right after a refused
  fetch, printing a stack under a finding that was correct. `process.exitCode` and
  a natural exit is the whole fix, and R6 is what caught it.
* **A driver has to survive being stopped.** The suite-per-mutation driver was
  interrupted mid-run while its fault was applied; the tree kept
  `MAP_DEFAULT_CENTER` over open water (and the emptied paint requirement from a
  second attempt), which made every *other* mutation's suite fail the paint check
  and read as "caught". It now restores the in-flight mutation on SIGINT/SIGTERM/
  SIGHUP, prints which file it put back, and `--` the lesson — a falsification
  harness that can leave the tree mutated is testing a different tree than the one
  you think.
* **The record is a binary in the repo, on purpose.** 271 KB of vector tile is the
  whole point: the checks judge the bytes, not a summary somebody could regenerate
  differently. `.gitignore` does not cover `scripts/fixtures/`, and the index's
  sha256 is what makes a refresh reviewable.
