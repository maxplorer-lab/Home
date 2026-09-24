# The Home page's unread card (2026-09-23)

The chat's unread cue was a **dot** on the Chat tab. This work promoted it to a
**card** under the month's figure on Home — and then, in the same day, from a
single preview line to **the unread lines themselves**: one clipped row per
message, newest first, with the count above them and a `+N earlier in the room`
row when the server bounded the list.

## What the guards protect

`npm run smoke` section 5 grew, in two passes:

| Claim | Why a guard, not a comment |
| --- | --- |
| the card is the **SECOND** box | the CSS index for `rooms-card` sits in the `<head>`, so an index taken from the top of the document reports the card "before the figure" however the markup is ordered |
| it ships **hidden**, with the slots the script fills | an already-shown card would let the server decide what is unread, and there would be no fetch |
| the readout carries the **lines**, one per unread message, **newest first**, **clipped** | the bug being replaced answered with ONE line however many had arrived, and the card's `+N earlier` row is only true if the omitted ones are the *older* ones |
| the card paints them as **text**, never markup | the room carries whatever anyone typed, and a module's system row carries a transaction note |
| the card carries **`min-width: 0`** | it is a grid item holding nowrap rows; a grid item's automatic minimum is its min-content width, so without it the card widens the track instead of clipping — measured at **498 px on a 390 px phone**, with the figure beside it pushed off screen |

## Why the guards need a driver

Every check here is either a claim about a **server-rendered document** or a
**CSS rule**, and three of them were green on the first run for a reason other
than the thing they claim:

* the position check sliced the document at the first `<body` — which is a CSS
  **comment** ("not as Tailwind utilities on `<body>`"), so the rooms' index came
  out before the figure it must follow;
* the same check would have passed with the card **anywhere in the head**,
  because `.unread-card` is a CSS rule there too;
* the "painted as text" check turned **red on the script's own comment** ("Text
  goes in with textContent and never innerHTML"), i.e. it read prose.

## Running it

```bash
npm run dev                                 # one terminal
node scripts/one-off/2026-09-23-unread-card/mutate.mjs          # all eight
node scripts/one-off/2026-09-23-unread-card/mutate.mjs M5 M6    # just these
```

`BASE_URL` selects the server (default `http://127.0.0.1:8793`). One suite run
per mutation — **~3 minutes each**, so the full set is ~25 minutes. The tree is
restored after every mutation (and on `SIGINT`/`SIGTERM`: a 10-minute tool
timeout once killed this driver mid-run and left `const qs = ""` in the route,
which is a real, silent behaviour change). It exits non-zero if any mutation
survives its guard.

| Mutation | Fault it injects | Guard that must go red |
| --- | --- | --- |
| M1 | the card is moved below the room doorways | the **SECOND** box |
| M2 | a chat line is injected as markup | never markup |
| M3 | the caller's watermark is dropped | narrows to what arrived after |
| M4 | the card renders already-shown | ships hidden |
| M5 | one line for the count, whatever the count is | one line per unread message |
| M6 | the lines come back oldest-first | arrive newest first |
| M7 | the clip is dropped | clipped before it leaves the DO |
| M8 | `min-width: 0` is removed from the card | cannot widen its own grid track |

`smoke section 5` is the only place these run; there is no framework.
