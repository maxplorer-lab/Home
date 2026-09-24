# One theme signal (2026-09-23)

**Status: fixed, guarded, falsified. No SQL, no config, no new secret.** Three
files changed: the token block in `views/app-chrome.tsx`, the §26 guards in
`scripts/smoke.mjs`, and the two docs that asserted the old premise.

## What was wrong

Dark mode had **two** signals. The tokens were emitted twice — once under
`html.dark`, once inside `@media (prefers-color-scheme: dark)` — while every
`dark:` utility in the app followed only the class. The stated reason was that
the Tailwind CDN ignores `tailwind.config`, so `darkMode: 'class'` is a no-op and
the utilities follow the OS instead.

**That premise is false in this build, and the browser says so.** With a `.dark`
ancestor absent, an element carrying only `dark:bg-gray-700` computes
`rgba(0,0,0,0)`; add the class to a parent and the same element computes
`rgb(55,65,81)`. The emitted rule is `.dark\:bg-gray-700:is(.dark *)` — the class
strategy, honoured. So the two signals were pulling in opposite directions, and
the second token copy was not belt-and-braces, it was the split.

The visible result: an explicit **"light"** choice stored on a dark-OS phone gave
dark tokens (the media query fired) with light utilities (no class). On
`/settings`, both action links on the Account card — `bg-gray-100`, text colour
inherited from `--ink` — rendered at **1.0:1**: light grey on light grey,
invisible. The same shape hits any unconditional `bg-white`/`bg-gray-100` box
whose text comes from the tokens.

## The fix

`html.dark` is now the only carrier of the dark palette, and it already means
"the effective theme is dark": the bootstrap in `views/layout.tsx`,
`views/shell.tsx` and `routes/auth.tsx` sets it from the switch's stored choice,
or from the OS when nothing is stored. So an explicit choice contradicts nothing
— the whole app moves with it, which is what the old comment promised and the
old code could not deliver.

Verified live, both directions, on `/settings`: with `theme=light` stored on a
dark-OS browser the page is light and the links measure **16.1:1**; toggle to
dark and both the tokens and the utilities flip together
(utility probe `rgb(55,65,81)`, `--paper #111827`). `color-scheme` was added to
each block so native controls and scrollbars follow the same signal.

## The guards (smoke §26)

| Check | Fails when |
| --- | --- |
| `the dark palette answers the class only — no second, OS-driven copy` | a `@media (prefers-color-scheme: dark) { :root { … } }` token copy returns, or `html.dark` loses its values |
| `every document that carries the tokens also sets the class they wait for` | `/`, `/login` or `/way/` ships `CHROME_CSS` without a `classList.add('dark')` bootstrap |

Both are text-level checks over the **served** documents, so both are paired with
the section's existing controls. Falsified by
`node scripts/one-off/2026-09-23-theme-signal/mutate.mjs` (needs the dev server;
runs the full suite per mutation):

```
M1  caught=YES  restored=yes  (a second, OS-driven copy of the dark tokens is back)
M2  caught=YES  restored=yes  (the shell ships the tokens but never sets the class they wait for)
```

## The part worth remembering

This was found by loading the page, not by reading it: the code comment explained
the two-signal design confidently and the guard *enforced* it. A text-level guard
cannot tell you its premise is wrong — it was written to match the comment, so it
agreed with it. The test that settled it was a five-line probe in the browser
(`dark:` utility with and without a `.dark` ancestor), and the honest fix was to
delete the mechanism rather than add a third copy of the tokens.
