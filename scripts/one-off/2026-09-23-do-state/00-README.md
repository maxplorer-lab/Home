# Request data on a Durable Object's `this` (2026-09-23)

**Status: audited, DECLARED, guarded, falsified. No SQL — and no behaviour
changed.** The deliverable is a registry plus a check, not a fix: the audit found
no unsafe field.

This extends the module-scope audit from the same day (`../2026-09-23-module-state/`,
rule 38) one level down, into the Durable Object — where the same family of bug
hides behind the opposite intuition.

## Why the DO case is subtler

A Worker isolate is obviously shared, so nobody parks request data in module scope
on purpose. A Durable Object *feels* private: it belongs to one entity, and it is
single-threaded. But single-threaded means **no two instructions overlap**, and
says nothing about two **requests**, which interleave at every `await`:

```ts
this.currentDevice = body.deviceId   // request A
... await ...                        // request B assigns the same field
use(this.currentDevice)              // A now acts on B's device
```

No error, no log line, no failing test — the same invisibility as rule 38, with
one crucial difference: `this` is where a DO's state BELONGS. A geofence cache, a
cooldown map and the daily push ledger are all correct there. So the rule cannot
be "no state on `this`"; it has to be *every field declared, and written the way
it says it is written*.

## What the audit found

An inventory, plus one genuine judgement that had been implicit:

| Field | Declared kind | Why it is safe |
| --- | --- | --- |
| `FleetDO.sql` | handle | the SQLite handle, set in the constructor |
| `FleetDO.geofenceCache` | db-cache | refilled from way-db, invalidated to null |
| `FleetDO.notifyCache` | db-cache | topics + grid + resolved server, same shape |
| `FleetDO.notifyCooldowns` | keyed | `person:event:fence` stamps |
| `FleetDO.notifyDaily` | keyed | per person, a day and a count |
| `FleetDO.approachFired` | keyed | per `device:fence`, thresholds announced |
| `FleetDO.approachPulses` | keyed | per device, the badge's in-flight pulse |
| `FleetDO.lastNotify` | **diagnostics** | holds request data — see below |
| `Lobby.ctx` / `Lobby.env` | handle | the DO context and bindings |

**`lastNotify` was the one real finding.** It is assigned from request data
(`sourceUsername`, `eventType`, the routing outcome) inside `notifyEvent` and read
by a *later* request — `/debug-notify`'s payload in `fetch`. That is exactly the
shape this audit exists to flag, and it is fine for one reason: **it decides
nothing**. No branch anywhere consults it; it exists so a routing failure is
readable without a live tail.

Rather than refactor a debug slot that works, the audit *records* that: the
registry entry names the single method allowed to read the field. So the claim
"it decides nothing" is now checkable — the day another method reads it, §25 goes
red, because that is the moment the value starts deciding something and belongs in
a parameter like any other request data. Three checks in the section hold the
whole family to that standard:

| Finding | Meaning |
| --- | --- |
| `undeclared` | a new field arrived with nobody writing down what it is |
| `wrong-write` | a field is written in a way its declared kind forbids (a cache fed from request data, a handle written outside the constructor) |
| `read-after-await` | assigned from request data and read past an await — the interleaving window |
| `cross-request` | assigned from request data and read by a different method |
| `undeclared-reader` | a `diagnostics` field read somewhere its entry did not name |
| `missing-class` | `wrangler.jsonc` names a DO the source does not have |
| `config-unreadable` | the config could not be parsed, so the DO list is unknown |

Scope comes from `wrangler.jsonc`'s `durable_objects` bindings rather than
`extends DurableObject`: Laoka's `Lobby` is a plain class and a DO all the same.
That file is JSONC containing `"https://…"`, so its reader is a real scanner — a
`//` regex eats the rest of that line, and the nearest failure is a config that
does not parse, which would leave the whole section checking nothing.

## Three analyzer bugs caught while building it

Each of these made the scan report a **permanently green tree**, which is why §25
carries controls rather than only a verdict:

1. **Kind NAMES vs kind NUMBERS.** The module-state analyzer built its set of
   function kinds from strings and compared them against `node.kind`. Nothing
   ever matched, so no write was ever attributed to a function.
2. **The method's own parameters were never seeded.** The walk starts inside the
   method body, so the node that would have pushed them is never visited —
   request data classified as "an unknown local" and every check went quiet.
3. **A stack of name-lists compared against bare names.** `paramStack` holds one
   list per enclosing function; comparing names against the stack instead of its
   flattened contents matched nothing. Same symptom as (2).

## Falsifying it

```
node scripts/one-off/2026-09-23-do-state/mutate.mjs
```

**No dev server needed.** 9/9 caught on the shipping source; the tree is restored
(hash-verified) or the run says `TREE NOT RESTORED`.

| | Mutation | Red |
| --- | --- | --- |
| M1 | request data parked on `this` in `fetch` and read past an await | the interleaving check |
| M2 | a new instance field nobody declared | the registry check |
| M3 | the geofence cache declared a handle | the write-conformance check |
| M4 | the diagnostics slot gains a reader in another method | the reader pin |
| M5 | a registry entry stops stating a reason | the "state a reason" check |
| M6 | `wrangler.jsonc` names a class that does not exist | the "every DO is analyzed" check |
| M7 | the analyzer stops seeding a method's parameters | the positive control |
| M8 | the analyzer stops accepting database caches | the negative control (+ the real tree's two caches) |
| M9 | the jsonc reader stops tracking strings | the URL control (+ the DO list empties) |

**M7 is the one to read.** It disarms the analyzer so thoroughly that the
diagnostics-reader check goes green *for the wrong reason* — with no
request-classified writes, it never runs. Only the positive control notices. That
is the entire argument for the controls existing.

## Residue

None. Nothing here writes data, and the driver touches only the three files it
mutates and restores.
