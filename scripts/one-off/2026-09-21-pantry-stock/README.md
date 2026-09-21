# One-off: the pantry, its trip, and typed numbers (2026-09-21)

Tooling for the change that split Laoka's catalogue in two (meals vs pantry), gave
the pantry its own shopping list, its own trip and its own categories, and made
every number box in the app typed rather than nudged. Rule 35 and rule 37 in
`AGENTS.md` are the invariants; smoke sections 22 and 23 are the guards.

| File | What it is |
| --- | --- |
| `mutate.mjs` | **The one to run.** The mutation driver: it extracts sections 22 and 23 out of `scripts/smoke.mjs`, applies one plausible fault at a time, and reports which check each one turns red. A guard that cannot go red is decoration, so this is how a change to the pantry or to the entry rule is verified — 30 mutations, ~5 s each. |
| `section22.mjs` | The text the new §22 was written as, before it was spliced into the suite. **Stale by design: do not edit it and do not run it** — the shipping copy is `scripts/smoke.mjs`, and a second copy of a guard is exactly how two guards drift apart. Kept as the record of what was installed. |
| `splice.mjs` | The one-shot that replaced §22 in `scripts/smoke.mjs`. It refuses to write unless both banners appear exactly once. Already used; kept for the same reason. |

## Running the driver

```bash
# a dev server must be up (see the run doc); the default base is 8793
node scripts/one-off/2026-09-21-pantry-stock/mutate.mjs          # all 30, ~10 min
node scripts/one-off/2026-09-21-pantry-stock/mutate.mjs M1 M9    # a subset
```

Pass ids in batches if you are on a clock: 30 mutations at once runs past ten
minutes and a killed run is worth nothing (the driver restores every file in a
`finally`, but a `SIGKILL` does not run it — if you ever interrupt it, check the
tree with `git diff` before believing anything).

Two things it does to your LOCAL dev database, both harmless and both local-only:

* it counts a pantry item down (and back up) so the trip half has something to buy,
* it creates and deletes a throwaway MEAL group (soft delete) while proving the
  pantry cannot rename or delete a meal group.
