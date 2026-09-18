# AGENTS.md — Home (family super app)

Guidance for coding agents working in this repository.

## What this is

ONE Cloudflare Worker containing three modules with a single shared login.
The identity engine and admin console are the only "super app" code; the
modules themselves are the original standalone apps, barely modified.

```
src/
  index.tsx          merged Worker entry: mounts, repair middleware, cron
  identity.ts        ⭐ central login, password hashing, provisioning,
                     module-cookie minting, auto-repair helpers
  env.ts             all bindings (HOME_DB, DB, WAY_DB, LAOKA_DB, FLEET_DO,
                     LOBBY, ASSETS, secrets)
  routes/            Sompitra pages (auth.tsx also holds /bootstrap,
                     /change-password, /logout; admin.tsx is the console)
  way/               W.A.Y module (worker.ts adapts its entry; DB → WAY_DB)
  laoka/             Laoka module (worker.ts adapts its entry; DB → LAOKA_DB)
  db/schema.ts       Sompitra table types
  views/app-chrome.tsx ⭐ THE header + tab bar — both hosts import it
  views/layout.tsx     Sompitra page chrome + Card/StatCard/Btn
  views/shell.tsx      module tab host (iframe around WAY / Laoka / Chat)
public/
  way/               W.A.Y PWA shell + assets (namespaced)
  laoka/             Laoka SPA (namespaced: /laoka-ws, /laoka/api/…)
scripts/smoke.mjs    `npm run smoke` — dependency-free end-to-end checks
migrations-home/     home-db schema (the ONLY db Home owns)
migrations-sompitra|way|laoka/   the modules' original migrations
```

Original standalone projects live outside this repo: `../Sompitra`,
`../W.A.Y`, `../Laoka` — consult them for module history, never edit them
expecting it to affect Home.

## Commands

```bash
npm run check          # tsc --noEmit (must pass before you claim done)
npm run smoke          # 36 end-to-end checks against a RUNNING dev server
npm run verify         # check + smoke — what "tested locally" means here
npm run deploy:dry-run # builds + resolves bindings without deploying
npm run dev            # wrangler dev on :8787 (use another port if taken)
npm run deploy         # wrangler deploy (see rule 14 first)
```

`npm run smoke` needs the server up first; point it at another port with
`BASE_URL=http://127.0.0.1:8793 npm run smoke`. It exits non-zero on any
regression, so it is safe to gate a deploy on. Defaults to the local dev
seed account (`maxx`); override with `SMOKE_USER` / `SMOKE_PASS`. Set
`SMOKE_ADMIN=0` when testing with a non-admin account.

Local DB setup (first time only):

```bash
npx wrangler d1 execute HOME_DB      --local --file=migrations-home/0001_identity.sql
npx wrangler d1 execute DB           --local --file=migrations-sompitra/0001_initial_schema.sql   # + 0002…0009
npx wrangler d1 execute WAY_DB       --local --file=migrations-way/0000_baseline.sql              # + 0001…0007
npx wrangler d1 execute LAOKA_DB     --local --file=migrations-laoka/0001_init.sql                # + 0002…0008
```

## Non-obvious rules (violating these has caused real bugs)

1. **Mount order in `src/index.tsx`**: module mounts MUST be registered
   before Sompitra's routes — its `use('*', requireAuth)` catches everything.
2. **Cookie retries must join with `"; "`, never `Headers.append`** (which
   joins with `", "` and produces unreadable Cookie headers). See
   `withRepair` in `src/index.tsx`.
3. **Response headers are immutable** once a handler returns; mint fresh
   `new Response(res.body, res)` before touching headers.
4. **Post-`next()` header mutation in Hono must use
   `c.header('Set-Cookie', v, { append: true })`** — reassigning `c.res` or
   returning from middleware silently drops the mutation.
5. **W.A.Y-provisioned passwords must use W.A.Y's own hash format**
   (`salt:hash` hex, PBKDF2-100k) because the same hash authenticates
   μlogger Basic Auth. Everything else uses the peppered Laoka format.
6. **Laoka's embedded auth endpoints are intentionally 403'd**
   (`src/laoka/worker.ts`). Don't "fix" that; it enforces one identity.
7. **Cron `0 21 * * *` is W.A.Y's midnight** (UTC+3). Don't move it.
8. **`AUTH_PEPPER` is required** for any login/creation; ≥16 chars. For dev
   it's in `.dev.vars`; in prod `wrangler secret put AUTH_PEPPER`.
9. `public/` is served static-first by the edge — API-ish new paths must be
   added to `run_worker_first` in `wrangler.jsonc` or they'll 404 on the
   assets layer. The module shells rely on this: `/way/`, `/laoka/`,
   `/way/index.html`, `/laoka/index.html` are all in the list so the
   Worker can session-gate the module documents.
10. **The parent page cannot style iframe content** — even same-origin. The
    WAY/Laoka embed chrome-hiding lives in each module's own head script
    (`window.self !== window.top`). If a module UI changes, check its embed
    script still matches its selectors.
11. Chat lives in WAY's document, not Sompitra's: `/chat` is a ModuleShell
    around `/way/index.html?view=chat`. Any function in WAY's dashboard that
    touches `map` must stay `CHAT_MODE`-guarded (see `const map = CHAT_MODE ?
    null : L.map(...)`); Sompitra's old chat route is deleted on purpose.
    The shell host body is forced dark (`bg-[#0a0a0c]`) for the chat tab so
    the iframe's transparent edges never show a light seam.
12. Don't rename the D1 binding `DB` (Sompitra) — Laoka's standalone code
    reads `env.DB` and the adapter remaps it to `LAOKA_DB` explicitly.
13. **One chrome, one place**: the header and the tab bar are ONLY defined in
    `src/views/app-chrome.tsx` (`HomeHeader`, `HomeTabBar`, `CHROME_CSS`).
    `views/layout.tsx` (Sompitra pages) and `views/shell.tsx` (module tabs)
    both import them. Never re-implement the tab bar in a page — the two hosts
    drifted once and the module tabs ended up with emoji icons, no dark-mode
    toggle and no `.pb-safe`. Tab-bar icons are the real assets plus inline
    SVG (`TabSvg`); no emoji in the bar (content emoji is fine).
14. `HOME_DB`'s `database_id` is still the **placeholder**
    `00000000-0000-0000-0000-000000000000`. `wrangler deploy --dry-run` passes
    anyway. Create `home-db` and paste the real id BEFORE `npm run deploy`,
    otherwise the deployed Worker has a dead identity database.

## Smoke test (local, after any identity change)

```bash
# in another terminal; B=http://127.0.0.1:<port>
curl -d "username=maxx&password=…" $B/login -c jar -o /dev/null -w "%{http_code} %{redirect_url}\n"
curl -b jar $B/                     -o /dev/null -w "dashboard %{http_code}\n"
curl -b jar $B/way/api/devices      -o /dev/null -w "way %{http_code}\n"
curl -b jar $B/laoka/api/bootstrap  -o /dev/null -w "laoka %{http_code}\n"
curl -b jar $B/admin                -o /dev/null -w "admin %{http_code}\n"
```

Expect 302→`/` on login and 200 everywhere else. With ONLY a `home_session`
cookie in the jar, each of those should still return 200 via auto-repair.
`npm run smoke` automates all of the above plus the gates, the chrome
consistency and the repair path — prefer it over hand-rolled curl.

## Troubleshooting map

`D:\Freebuff\Home` is its own git repository (initialised `master`,
baseline commit "Checkpoint the merged Home super app under version
control"). Use `git diff` / `git status` freely — but note that no remote
is configured, so nothing is pushed anywhere. The three standalone sources
under `../Sompitra`, `../W.A.Y`, `../Laoka` have their own separate
repositories and their own history.

| Symptom | Look at |
| --- | --- |
| Login works but a module shows its own login screen | that module's`app.js`/head script bounces to `/login` when a fetch 401s; `src/identity.ts` repair helpers |
| A module 404s on an `/api/…` path | `run_worker_first` in `wrangler.jsonc` — asset paths are served by the edge before the Worker |
| Tab bar looks different on some tabs | both hosts must render `HomeTabBar` from `views/app-chrome.tsx` — a second, local tab bar is the bug |
| Module still shows its own header/nav inside a tab | the module's own `window.self !== window.top` embed script — selectors drift when its UI changes |
| Map/speedometer crashes in the Chat tab | a `map`-touching function in `public/way/index.html` lost its `CHAT_MODE` guard |
| Only some tabs render the same icons | `HomeTabBar` / `TabIcon` in `app-chrome.tsx`; assets under `public/` |
| Identity/login behaves oddly after a schema change | `migrations-home/0001_identity.sql` + the local D1 in `.wrangler/state` |
| Nothing seems to happen when editing a module UI | you are editing a file the Worker does not serve — see below |

### What is actually served

The assets binding is `./public` **only** (`wrangler.jsonc`). W.A.Y's live
document is `public/way/index.html`; Laoka's is `public/laoka/index.html`.
The root `dashboard/` (an older copy of W.A.Y's frontend) and the empty
`sql/` were deleted for exactly this reason — they were never served, and
editing them for a "fix that did nothing" was a real false lead. Don't
reintroduce a second copy of a served file anywhere in the root.
