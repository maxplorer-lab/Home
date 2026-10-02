# Context

The words this project uses, kept current as they get sharpened. When a term
here and a conversation disagree, this file is what a change should follow.

## Kiné — the practice's ledger

The household's Kiné practice. One practitioner, a small set of clients, each
with contracts and sessions, paid in francs.

| Term | Means |
| --- | --- |
| **client** | A person (`customers`). Their `default_rate` is what a session bills at when a contract does not name its own. |
| **contract** | A `service_contracts` row for one client: `session_rate`, `total_scheduled`, and a status of active / completed / cancelled. A client may have ended contracts and one active one. |
| **session**, **delivered** | A tick in `attendance_ticks` with `is_delivered = 1`. There is no un-delivered tick: unticking deletes the row. |
| **payment**, **paid** | A `client_payments` row — money received against one contract, optionally synced into Sompitra income. |
| **rate** | What one session bills at, resolved once: `session_rate ?? default_rate ?? 0`. A screen never carries a second rate. |
| **billed** | `delivered × rate`. |
| **balance** | `billed − paid`, in francs, **exact**. The one figure that says where a client stands. |
| **owes** / **prepaid** / **balanced** | The sign of the balance: the client owes us / we hold sessions they paid for / nothing outstanding. |
| **sessionBalance** | `balance ÷ rate` — the balance as sessions, a label for the balance tile only, never an input to anything. |
| **the week** | Saturday to Friday, `currentWeekBounds`. |
| **the ledger** | `src/kine/ledger.ts`: the two row expressions (`DELIVERED_COUNT_SQL`, `PAID_SQL`), `clientLedger`, and `weekLedger`. Every Kiné figure on every screen goes through it; a route writes its own Kiné arithmetic only if this module cannot answer. |

## Home — the session-repair rule

One login for the whole super app. A person holds a **Home session**; each
module keeps its own native session, and any of them can be rebuilt from the
Home session alone.

| Term | Means |
| --- | --- |
| **Home session** | The central session (`home_session`, home-db). Its being live is the ONLY thing that authorises a repair. |
| **module session** | A module's own cookie and row/token: Sompitra's `session`, W.A.Y's `way_user_session`, Laoka's `laoka_session`. |
| **session repair** | `src/lib/session-repair.ts`: given a request, a target and a live Home session, mint the module's cookie and say how to finish the request. One rule, adapted by every surface. |
| **repair plan** | What the rule returns: `{ homeUser, token, setCookie, retryRequest }` — or null when this request cannot be repaired. The retry's Cookie header is joined with `"; "` (rule 2). |
| **adapter** | What a surface does with a plan — `withRepair` (`src/index.tsx`) retries a module API once; `requireAuth` (`src/lib/middleware.ts`) sets the cookie and redirects Sompitra pages. A signed-out response's SHAPE belongs to the adapter (401 / `200 {ok:false,user:null}` / redirect), never to the rule. |
| **the cookie vocabulary** | `src/lib/cookies.ts`: the one parser (RFC 2109 quotes stripped — μlogger's form), Set-Cookie builder, clear builder and secure-request rule. W.A.Y's `lib/session.ts` re-exports it under its own names. |

## Home — what a guard is

A numbered rule in `AGENTS.md` is a promise; a **guard** is the thing in the repo
that fails when the promise breaks. Prose cannot go stale loudly, so the promises
are declared as data (rule 44) and `npm run audit:rules` reads them.

| Term | Means |
| --- | --- |
| **rule** | One numbered entry in `AGENTS.md`'s non-obvious rules. Its NUMBER is what citations in prose, code comments and CI point at, so renumbering moves the meaning of every one behind it — the audit checks that the numbers run `1..N` in order for exactly that reason. |
| **guard** | A NAME the suite can resolve: a smoke section, an `audit:` script, or a falsification driver. Not a sentence, and never a promise the scanner cannot read. |
| **falsifier** | The driver that proves a guard can still go red. A guard whose falsifier is missing is a guard nobody has seen fail. |
| **the map** | `AGENTS.md`'s "The rule → guard map": one row per (rule, guard) edge, plus the sections that guard no numbered rule. Written there because that is where a maintainer reads the rules. |
| **excused** | A smoke section that guards the RUN rather than a promise (currently smoke §1, the harness's own prerequisite). Being listed is a declaration; a section that is neither claimed nor listed is a fault. |
| **a § citation** | A reference to a section, namespaced by the document that owns the numbering: `smoke` (whose numbers are a contract), `CUTOVER`, `DB-REDESIGN`, `PRESENCE`. Bare is legal only inside the owning document, or as the second half of a same-line chain; anywhere else it names no document, which is a fault. |
| **a check fragment** | The optional quoted string in a guard cell that the named section must still contain — what stays red when a section survives but the check inside it is renamed away. |

## Home — the JavaScript type pass

`npm run check` compiles `src/` strictly and stops at the extension: `checkJs` is
off, so `.js` files were parsed, imported and never looked at. The pass below is
the other half, and these are the words it uses.

| Term | Means |
| --- | --- |
| **the checked set** | Every `.js`/`.mjs`/`.cjs` under `src/` — a WALK, not a declared list, so a new file is inside the gate the moment it lands. `public/` is out of scope on purpose: browser scripts want the DOM lib and a declaration of the engines' `window.Home*` globals. |
| **the relaxation** | `noImplicitAny: false`, and nothing else. In unannotated JavaScript every parameter is implicitly `any`, so full strictness reports 285 faults that say nothing about behaviour; this one flag leaves the ten that do. |
| **pinned** | The pass asserts its own effective option set (strict, strictNullChecks, noImplicitThis, useUnknownInCatchVariables and the rest all on) BEFORE it reads a file, and refuses to answer if any of them moved. Loosening a check to hide a fault is a finding, not a workaround. |
| **a fault** | One compiler diagnostic in a checked file. The first run found ten, and fixing the last one exposed a real defect: `readImage`'s inferred union had widened its discriminant, so two admin handlers could resolve to `undefined` — a route returning no response at all. Declaring the two shapes the function's own comment already described is the fix. |

## W.A.Y — the map's words

The household map, and the public share it hands out. The engines named here are
files under `public/shared/`, loaded by the page with a plain `<script>` and
imported by the test suite; the page keeps one-line delegations under the names
it always used (AGENTS.md rule 41).

| Term | Means |
| --- | --- |
| **a ping / a fix** | One stored position for one device. `gps_pings.distance_km` is the engine's own segment distance, a *different* quantity from a day's km (rule 34). |
| **a stored point** | A ping the map is allowed to draw, by `HomeTripLegs.shouldDrawPoint`. Collapsed and non-moving fixes are not points, which is why a day's km is computed rather than summed. |
| **a leg** | The run between two *consecutive stored points*, split by classification; a change of mode breaks the line exactly where a gap does. |
| **a backend leg** | The engine's own movement episode (`legId` / `legOpen` in `state-machine.ts`), written onto every stored point as `leg_id` and what a day's drawing and totals split at: opened by a confirmed departure or a fence exit, closed by a stop, a fence arrival — or a **recording pause**, which also leaves the break pending so the resumed drive opens a NEW leg even though the device never stopped. |
| **the verdict** | `HomeMeet.decision` — one answer for one pair, asked by both the pill and the bar, so they cannot disagree. Its gates are `HomeMeet.CONFIG`. |
| **the pill** | The live meeting ETA on the map (`meetEtaFor`): a promise about the next few seconds, so it goes dark on a stale fix. |
| **the bar / the gauge** | The distance ruler under the map (`HomeMeetStrip`), which measures to one **subject**: a picked person or place, else the nearest on the current source. |
| **the ruler, the rung, the ladder** | The bar's scale: the smallest rung that still contains the distance, from a ladder built out of `HomeMeetStrip.CONFIG.BANDS_M`. The remembered rung belongs to a ruler *instance* (`createScale()`), not to the page. |
| **closeness** | How far *into its rung* a distance sits — a different quantity from the fill, and the one the colour reads. |
| **the pick** | A reference the user pinned on the bar (`map_strip_ref`), which beats the pill's peer and the nearest one, and persists across reloads. |
| **the share** | The public live page (`/live/`), which measures and moves with the same engines as the household map. |

## Home — the basemap record

The map's background belongs to somebody else's server (OpenFreeMap's styles and
tiles), and those checks do not fetch it per run: they judge a copy of it, so a
red means upstream or this repo changed rather than that the machine was offline.

| Term | Means |
| --- | --- |
| **the record** | `scripts/fixtures/basemaps/` — one file per upstream URL plus `index.json` (url, kind, view, bytes, sha256, `recordedAt`). What smoke §9 and `npm run audit:basemaps` judge. |
| **the walk** | `scripts/lib/basemap-record.mjs`: a declared key's style → its vector sources → each source's TileJSON → one tile at the household's own view, at the zoom the source itself calls deepest, plus one over open water as the control. One walk, three callers (the recorder, the CI audit, smoke §9), so the record cannot list a roster the checks do not read. |
| **refresh** | `npm run basemaps:record` — the only thing in this repo that talks to the tile host on purpose. It prints a per-URL diff (same / changed / new / removed, by sha256) and then judges what it recorded, so upstream changing its mind becomes visible where a person is looking. |
| **live mode** | `SMOKE_LIVE=1 npm run smoke`, `npm run audit:basemaps --live` — judge what the servers serve RIGHT NOW. Record mode refuses the recorded hosts, so "the suite runs without network" is a property of the run rather than a hope about the machine. |
| **a stale record** | Older than **120 days** (`STALE_DAYS`). Reported rather than judged, because a guard answered by a copy has to know its copy is old: the CI audit treats it as a fault, an interactive smoke run prints it as a note. |
| **the paint requirement** | `building` / `transportation` / `place` in the tile at the household's own view — the layers a street-level map is made of. A request PAST a source's native zoom is answered `200` with a zero-byte body, which is why the walk samples the source's own ceiling and reads the payload instead of trusting a status code. |
