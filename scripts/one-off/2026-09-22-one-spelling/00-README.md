# One spelling, through the human door (2026-09-22)

**Status: SHIPPED in code, guarded, falsified. No SQL — no data needed moving.**

Rule 33 says a person's name is a KEY with exactly ONE spelling. The phone's door
was pinned on 2026-09-20 (`../2026-09-20-rename-niri-to-Niri/`); the browser's
door was not, and that is the one that broke in the field.

## What was wrong

A `way_user_session` lasts 30 days, so a browser that signed in **before** the
rename still holds a token saying `niri`. `/ws` forwarded that spelling verbatim
and the Durable Object stamps it onto everything it writes. Two symptoms, one
cause — both reported by the owner on 2026-09-22:

| Symptom | Why |
| --- | --- |
| Niri's messages arrived, MaxX's phone never rang | `notifyEvent` resolved the source with `u.username === sourceUsername` — an **exact** match. `niri` found no `Niri` row, so the frame routed to nobody. The chat row still landed, and `/debug-notify` still reported a send. |
| Her own bubbles rendered as someone else's | the row was stamped `niri` while `/way/api/users/me` (which reads the row by id) answered `Niri`. |

`niri` receives MaxX's messages because *his* socket is canonical: his session
was minted after the rename, so the exact match succeeded and the recipient
lookup — which is keyed by numeric id — worked.

## The fix (folds, at the points a spelling can decide an outcome)

1. `src/way/worker.ts` — the `/ws` upgrade resolves the **account** before it
   sets `X-WAY-Username` (same shape as `canonicalDeviceId` in the phone's door).
2. `src/way/do/FleetDO.ts` → `notifyEvent` — the source lookup folds case.
   It must: a tracking event's source is a **device id**, spelled independently
   of the users row.
3. `src/way/do/FleetDO.ts` → reaction toggle — an existing key that differs only
   by case is reused and rewritten under the current spelling, so one person is
   never counted twice.
4. `src/lib/share.ts` — both person lookups fold (a code minted as `niri` must
   still resolve).
5. `public/chat/index.html` — `sameName()` for "is this mine" and for the
   reaction pill, so rows and reactions written before the fix still read as
   theirs and still toggle off.

`DO_BUILD` moves to `notify-v16-one-spelling` (a stale instance routes nothing
for a differently-spelled source while still reporting a send).

## Falsifying it

```
npm run dev            # in one terminal (or the detached recipe in the run doc)
BASE_URL=http://127.0.0.1:8793 node scripts/one-off/2026-09-22-one-spelling/mutate.mjs
```

6/6 caught on the shipping source; the tree is restored (hash-verified) or the
run says `RESTORE FAILED`. `N1`/`N5` need `ws`, loaded from wrangler's own tree
(the live `/ws` handshake takes no credential but a Cookie header).

N5 is a **pair** fault on purpose: the socket fold and the lookup fold each route
a differently-spelled source on their own, so neither single revert turns the
live routing check red — that is defence in depth working, not a weak guard.

## Local residue

Each run sends one real chat message through the DO and leaves it in the local
DO's scrollback (it is flushed into local `messages` at the next midnight cron).
Chat history is append-only by contract — there is no delete route, deliberately,
so nothing in this folder can tidy it up. It is local-only state.
