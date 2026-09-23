# Request data in module scope (2026-09-23)

**Status: SHIPPED in code, audited app-wide, guarded, falsified. No SQL — no data
needed moving, and nothing user-visible changed.**

Found by a code review of the whole tree and then hunted as a CLASS rather than an
instance: the review found one, and the useful question was whether there were
others. A compiler-based scope analysis over all 55 files in `src/` says there is
exactly one, and it is now impossible to reintroduce silently.

## What was wrong

`src/identity.ts` carried:

```ts
let lastPassword: string | null = null      // module scope
```

set by a wrapper (`ensureModuleAccountsWithPassword`) at login, read by
provisioning across several D1 round-trips, cleared in a `finally`. Every request
was individually correct — which is why it survived review, a rename and a merge.

It is wrong because one Worker isolate serves **concurrent** requests and
interleaves them at every `await`. Two overlapping logins (or an admin create
landing during a login) interleave inside `ensureModuleAccounts`, so request A
reads request B's password:

| Where it lands | Consequence |
| --- | --- |
| `way-db users.password_hash` | B's row is created hashing A's password — and in W.A.Y that same hash IS the **μlogger Basic-Auth credential** (rule 5), so one person's phone credential is attached to another account |
| `laoka users.password_hash` | same swap, module-native hash |
| nothing at all (lucky ordering) | the row is simply skipped and the repair path never retries it, because the account now exists |

No build would fail. No test would fail. There is no error, no log line, and no
symptom until two requests overlap — so the only reliable detector is reading the
code.

## The fix

The decision is now explicit at the call site, and there is nothing left to
interleave:

* `ensureModuleAccounts(env, user, password)` takes the password as a **required
  parameter with NO default**. A default would let a later caller silently land on
  the never-create path and leave a person without module accounts — the exact
  outcome the parameter exists to make visible.
* The two wrappers are gone. The login path passes the password; the auto-repair
  path passes `null` (it only repairs sessions for accounts that already exist).
* `admin.tsx`'s create path passes the password it just hashed into `home-db`.

## Eliminating the class, not the instance

`scripts/lib/module-state.mjs` parses every file under `src/` with the TypeScript
compiler and reports any module-scope binding that a function WRITES — reassigning
it, writing through it (`CACHE[k] = v`), or calling a mutator on it (`CACHE.set`,
`LIST.push`). Reads are ignored on purpose: `const CONFIG = …` read by a thousand
requests is correct, and a guard that flags it would be turned off within a week.

Three surfaces:

| Where | What it does |
| --- | --- |
| `npm run audit:module-state` | the answer, for a person or CI: read-only, exits 1 on a fault, no server needed |
| `npm run smoke` §24 | the same scan, plus the controls below, plus the instance pinned by name |
| `src/` only | `public/` keeps timers, drag state and in-flight flags in module scope deliberately: one page, one user, one thread |

### Why §24 has controls, not just a scan

A source scan's failure mode is **silence**: wrong folder, unresolvable
`typescript`, or a set of `SyntaxKind` NAMES compared against `node.kind` NUMBERS,
and it reports a green tree for the rest of the project's life. That third bug was
actually written while building this and caught by a probe file — which is why §24
requires the analyzer to (a) notice a synthetic reassigned `let` **and** a mutated
`Map` it is not currently looking at, and (b) stay quiet about a read-only
constant, before its clean verdict on `src/` is worth anything.

## Falsifying it

```
node scripts/one-off/2026-09-23-module-state/mutate.mjs
```

**No dev server needed** — every §24 check is a source read plus an in-memory
parse. 6/6 caught on the shipping source; the tree is restored (hash-verified) or
the run says `TREE NOT RESTORED`.

| | Mutation | Red |
| --- | --- | --- |
| M1 | a module-level field is written from inside provisioning again | the real-tree scan |
| M2 | the analyzer can no longer tell a function body from module scope | the positive control (the tree itself stays green — it IS clean) |
| M3 | the analyzer reports any two-operand expression as a write | the negative control (+ the real tree, since honest constants exist there too) |
| M4 | the password parameter grows a default | the no-default check |
| M5 | the admin create path stops stating the password | the call-site check |
| M6 | the module-level password field comes back, unused for now | the by-name check |

M2 and M3 are the interesting pair: they attack the analyzer rather than the
application, and only the controls notice. M6 pins a shape the scanner cannot see
by definition — an unused module field is harmless until the first write, and then
M1's check has to catch it.

## Residue

None. Nothing in this change writes data, and the driver touches only the files it
mutates and restores.
