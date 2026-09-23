# Home 🏠

One app for the whole household — a family super app in the WeChat style.
**Home** runs three modules inside a single Cloudflare Worker at a single
domain, behind **one login per person**: one username, one password, created
by an admin.

| Tab | What it does | Where | Database |
| --- | --- | --- | --- |
| 🏠 **Home** | The household dashboard: this month at a glance, today's activity, Kiné, cash flow | `/` | `sompitra-db` |
| 💰 **Sompitra** | Budget, Kiné, Debts & Credits, Sales & Stock | `/budget` | `sompitra-db` |
| 💬 **Chat** | THE family chat **and the app's activity feed** (W.A.Y's FleetDO) | `/chat` | `way-db` |
| 🍲 **Laoka** | Weekly dinner planner with a shared shopping list | `/laoka/` | `laoka` |
| 📍 **W.A.Y** | Live GPS tracking, geofences, μlogger ingest | `/way/` | `way-db` |
| ⚙️ **You** | Settings: your account, your two notification channels, the module panels | `/settings` | `home-db` |
| 👥 **Accounts** | The one login: sign in (`/login`), first-run claim, admin console (`/admin`) | — | `home-db` |
| 🩺 **Diagnostics** | Everything the app fails *silently* at, on purpose: the tracking intake's gate counters and every notification that never reached a phone (`/admin/diagnostics`, admin-only) | — | `home-db` + the FleetDO |

Each module keeps its own database and its own palette. Inside Home they run
as **chromeless tabs under one shared chrome** — one header with the Home
brand mark, one bottom tab bar (Home · Sompitra · Chat · Laoka · WAY · You),
WeChat-style. **Chat is WAY's own chat engine**, moved out of the dashboard
into its own page (`/chat/`) — it shares the same realtime socket and the
same FleetDO as the map, so history, replies and reactions are one stream.
WAY itself has no chat any more. Visited standalone (outside the shell), the
modules keep their original UI.

The navigation is **one list with two shapes**: the phone tab bar below 768px,
and the same six tabs laid out horizontally in the header from 768px up (a
phone bar pinned to the bottom of a desktop window is the biggest "this is a
phone page" tell). The icons are the modules' own marks, and Sompitra's is a
receipt — the one shape that still says *expenses* at 20px with no colour
behind it. Every tab keeps **its own colour whether or not it is the
one you are on** — green Home, teal Sompitra, violet Chat, orange Laoka, sky
WAY, slate You — and being *on* a tab is shown by a marker bar, a tinted pill
and a bold label, never by draining the colour out of the other five. Both
shapes come from one list, so a tab cannot exist in one and not the other. On
Android (Chrome/Brave) it installs as a real app: a proper manifest, a
spec-correct maskable icon and a service worker that caches static assets
only — never a page or an API response, because this is a household app on
possibly shared devices. There are **two** installable scopes: the app itself
at `/`, and WAY's map at `/way/` (its own manifest and worker, for the one
screen that is worth full-screen). Each file must exist at exactly the size its
manifest advertises — a wrong-size icon is rejected silently, and WAY's used to
be 1254×1254 files declaring `512x512`, which put ~2 MB of icon in every
install's precache.

## One app, one look

Three things make the six tabs read as one product rather than three apps in a
coat:

* **One typeface.** Plus Jakarta Sans, loaded by every document including the
  sign-in screen, with the system stack behind it as the offline fallback.
  Before this, W.A.Y shipped Jakarta while Sompitra, Laoka and the chat shipped
  Segoe UI — two typefaces, two tabs.
* **One accent per screen, taken from the tab you tapped.** The screen's colour
  (`--accent`) and its filled-surface variant (`--accent-ink`) come from the
  same table the tab bar renders, so a Sompitra screen is teal inside and out:
  the heading glyphs, the settings section, the money sub-nav's active pill and
a 2px hairline under the header all follow it. Dark mode lifts the tint
  (slate on the dark bar is otherwise 1.9:1, i.e. invisible).
* **Brand glyphs, not decorative emoji.** Card headings wear an icon from the
  app's own set, in the screen's accent. Emoji could never do that — they are
  colour pictures the OS chooses, at a different size on every platform. Emoji
  that encode data (the Kiné legend, category icons, per-person dots) stay.

An embedded module (WAY, Laoka, Chat) runs inside a **framed stage** — inset,
rounded, with a hairline ring — so it reads as a panel *of* Home instead of a
separate app the header happens to sit on. And **the Chat tab carries an unread
dot**: chat is the only module that receives things while you are somewhere
else (a message, or another module's activity line), so a red dot on that tab
says "there is something new" from any screen. It is a dot rather than a count
— a count has to be owned by whoever last read the room, and a wrong number is
worse than a vague dot. Money keeps one meaning on every money screen:
**green in, red out, teal a period's net result, orange what we owe, purple
what is owed to us**, and every amount is tabular so columns line up. Cash on
hand is the one deliberate exception — it is a *health reading* rather than a
direction, so it uses Sompitra's balance scale (red under zero, then yellow,
blue, green as the balance grows). Kiné's own tiles keep Sompitra's original
colours too: they count sessions, not money. `npm run smoke` section 18 fails if
a money colour drifts — it reads the **served pages**, so a blue "Net" or a blue
"owed to us" cannot come back unnoticed.

That one chat is also **where the app reports activity**, so the household
does not have to watch each module to know what happened. WAY's arrivals and
departures were always system rows in it; now Sompitra's money events appear
there too, each in its own colour — 💸 **red** for an expense, 💰 **green**
for income, 🩺 violet for a Kiné event, alongside 📍 green arrivals and 🚪
grey departures. Money in and money out are deliberately different event
types, so a salary landing never reads like a spending row:

```
       10:57 AM
  💸 MaxX - Expense - Gas · Ar 45 000 - Fuel        (red)
       10:58 AM
  💰 MaxX - Income - Salary · Ar 1 500 000          (green)
       10:59 AM
  🩺 New client - Rakoto - Added                    (violet)
```

These are system messages, never attributed to a person, and they arrive with
or without ntfy configured — the chat is the record, ntfy is for reaching
someone who is not looking. One scrollback tells the whole story of the day.

## The week's shopping list becomes one expense

Laoka ends where Sompitra begins: a planned week is priced during the shop,
and the total belongs in the budget. That last step is a **button**, not a
file — in Laoka's export sheet, **Send to Sompitra** posts the priced lines
straight into Sompitra as **one itemized expense** (dated today, filed under
the Groceries category when one exists). No download, no "Import CSV", no
picking a file in a modal.

| | |
| --- | --- |
| `GET /budget/laoka-import?week=N` | Was this week already sent, and to which expense |
| `POST /budget/import-laoka` `{week:N}` | Create it, or refresh the expense this week already owns |

It is **idempotent by construction**: `home-db` keeps one ledger row per
Laoka week (`laoka_imports`, week id is the key), so pressing send twice
cannot charge the budget twice — the second press updates the same expense,
and even a re-import after the expense was deleted in Sompitra is handled
(a fresh one is created and the ledger re-pointed). Once the expense exists,
the household's own edits win: a re-send refreshes the **amount and items**
but never overwrites the description, date or category someone chose by hand.

The itemized list is the same shape the CSV imported into, so Sompitra
renders it as items with a total rather than a paragraph of text. The CSV
download is still there for anyone who wants the file.

## The pantry: the second shopping list

Laoka's catalogue is two domains, and the split is deliberate:

* **Meals** — Protein, Sides and Raw Salad. The planner draws a week from them,
the week's list prices them, and that list becomes one expense (above).
* **Pantry** — spices, oils, condiments, dry staples, and whatever the household
adds (toilet paper, soap, batteries). Never planned, never on a week's list.

The **🧺 Pantry** tab is the whole pantry: count what is at home with − and +,
and anything **below its own reorder level** (2 by default; milk reorders at 1,
rice at 5) appears on the **to-buy** list by itself. Nothing here changes on its
own — cooking does not eat a shelf and shopping does not fill one — so the count
is always the household's own statement. An item you never count stays out of it
entirely.

Each row carries its own ✏️ and 🗑: the sheet holds the item's **name**, the
**category** it is filed under, how many are at home and when to reorder, and the
bin removes that one item — a *category* is removed from its heading, never from
a row. Renaming or re-filing an item used to mean removing it, count and price
included, because the sheet was counts-only.

Home ends on the same shape in one line: the dashboard's **Pantry** card shows
how many items, how many categories and how many are to buy — straight from the
pantry's own queries — and tapping it opens the Pantry tab directly.

Going shopping is a **trip**, not a week: each row takes a **quantity** and the
**price of one**, the restock price (their product) appears as you type, and the
trip total is the sum of those. Then **send it to Sompitra**, which opens the same
add-expense form meals use with the trip's lines and total already in it — you
pick the category, and nothing is written until you save. Sending twice corrects
the same expense instead of creating a second one. Stopped halfway through?
*Clear the prices* walks away from the trip without touching a single count.

Three small rules hold that together, and each one is a bug somebody hit: a price
of **zero** is an emptied box rather than a free item (every reader of a line
asks `price > 0`, so a stored 0 is money that draws nowhere); removing an item
clears its price and the trip that price opened, exactly as removing a whole
category does; and a price reply **repaints only the total**, never the list — a
price commits when you leave the box, so the answer arrives while you are already
typing in the next one, and rebuilding the list there used to take the half-typed
number with it.

Every number box in the app — these two included — is **typed, never nudged**: no
spinner arrows, and the mouse wheel scrolls the list instead of stepping the value
under the pointer (Laoka's prices commit when the box loses focus, so a wheel step
used to *write* a price nobody typed). See rule 37 in `AGENTS.md`.

And what you type means what you meant: money and counts are whole, so a typed
**"1250.75" is 1,250 Ariary** — the cells are cut at the decimal and thousands
separators are ignored, for every money box in the app (one helper, not five).

Categories are managed right here — **New category**, and ✏️ / 🗑 on each
heading. Removing one takes its items with it (the confirm says how many), and
an empty category still shows, so nothing you make is ever out of reach. The meal
Catalog deliberately knows nothing about any of it.

## A planned week can be forgotten

Until it is confirmed, a week is a **proposal** — so an unwanted one has to be
walkable-away-from rather than merely replaceable. In Laoka's **Plan** tab, the
"This is the template" card ends with **🗑 Discard the template**: it forgets the
saved plan, every price typed into the list it produced, and the pending draft,
leaving the week open and empty so a fresh plan can be drawn for it. Anything
already sent to Sompitra **stays in the budget** — money recorded is not
un-recorded by re-planning. (The **pantry is not part of a week's list** at all —
it has its own tab and its own to-buy list — so a discarded template can never
touch it.) A **confirmed** week refuses: it is settled, and the way out of a
settled week is single-day swaps or archiving.

## Settings & notifications

**`/settings`** is the one settings surface, organised by who a setting
belongs to: **you** (name, password), **notifications**, then a section per
module. Module panels are still being folded in; the W.A.Y and Laoka sections
link into their own UIs until then.

Notifications are **two ntfy topics per person**, both owned by `home-db` —
not a topic per app, and not one topic doing two jobs:

| Topic | Carries | Who decides what arrives |
| --- | --- | --- |
| 💬 **Money & chat feed** | Sompitra expenses, income and Kiné — in the same wording the chat shows | Nobody. Every active person gets every event, **including the one they recorded themselves** |
| 📍 **W.A.Y tracking** | Arrivals, departures, movement, chat messages | W.A.Y's own notification grid: who you follow, and which activities. **Nobody is notified about their own events**, and quiet hours apply only here |

So on your phone, one subscription is the household's money and the other is
where people are — you can mute tracking at night without also going deaf to
the budget, and vice versa. An admin sets the household ntfy server once, and
can generate, rotate or turn off either topic for anyone; each person can see,
copy, test and rotate their own in **You → Notifications**.

When a notification does not arrive, the page says why instead of leaving you
to guess: **Send a test** reports what the ntfy server actually answered
(`ntfy accepted it (200)`, `ntfy refused it (401)`, `could not reach …`); the
📍 card states your **quiet hours** and whether they are on right now (inside
them only chat reaches you); and the admin's household card warns when W.A.Y
has activity to send someone who has no tracking topic at all — a person who
is subscribed on paper and hears nothing.

W.A.Y's existing topics were **adopted** into the tracking channel (never
overwriting a topic someone already follows), so a phone in the field keeps
working — **Adopt W.A.Y's tracking topics** re-runs that for anyone added
later. Every tracking write is also mirrored back into `way-db`, so a rollback
to the standalone W.A.Y Worker (`CUTOVER.md` §6) publishes to the topic the
phone is actually following rather than to the one it replaced.

## The W.A.Y map

The map is drawn on a **playback clock** rather than ping by ping: the marker
trails live by ~25 s and glides between positions instead of hopping to each
one, and the camera works in **cycles** rather than chasing it — the device
roams a **circle** in the middle of the screen (70% of the width on a phone)
while the map sits still, shoves a beat past that circle's edge, and is then
swept across to the **opposite edge** in one elastic pull. It keeps being drawn
while it is swept, so its heading is never lost, and because it lands on the far
side it has the whole diameter to cross before the camera moves again — the map
is therefore still for most of every cycle, and the device is never left parked
against the edge. **The dot is the position; the emoji is a label.** The
colour-coded dot is the head of the trail and the only thing that says moving,
stationary or slow (it is simply absent inside a fence), so the Settings emoji
(🛵 🏍️ 🚗) floats *above* it instead of sitting on it — otherwise the icon you
chose buries the marker that answers "where, and doing what". What W.A.Y records is
unaffected — the same points, the same classifications, the same colours, dash
and stationary dots, the same **Flush now**. The HUD is live while the map is
behind, and the one line that names the lag sits under the pace pills in
**Settings → Map** (blue, shown on Smooth and removed on Live), and the Trips
summary keeps reading the database, so "driven this month" is unchanged. **All
of it reads one number one way**: the HUD's "km today" is recomputed from the day's
rows through the same function the Trips card and the monthly line use
(`computeLegsForDay` — the geometry between consecutive stored points, split into
driven and walked), where it used to add each ping's stored per-row distance as it
arrived and could read a different figure for the same day than the card beside
it. A reviewed past day is drawn by the live trail's own rules too, so a walking
stretch stays the thin dashed line it was — and the GPX export for that day holds
the whole day, not only the driving parts.

The trade the lag buys: motion you can actually watch. The cost: a just-arrived
position reaches the map half a minute later — so the pace is a **switch**, in
**Settings → Map**: **Smooth** keeps the 25 s of buffer, **Live** draws the
newest ping the moment it lands. It is per device, remembered on that phone, and
changes nothing about what W.A.Y records, stores or notifies.

**The background has one definition** — `public/shared/basemaps.js` — read by
this map *and* by the public live share, so neither page names a tile server of
its own. **LITE** (the default) is Esri's neutral grey canvas, which lets
markers, tracks and fences stand out; **STREETS** adds place names for when you
are looking at somewhere you do not know. The share always gets **STREETS**,
with no switch to make. This is not fussiness: the share used to point straight
at OpenStreetMap's standard tiles, and in September 2026 that volunteer-run
server began refusing this app — blank tiles on the page that mattered, while
the household map (already on Esri) looked perfect.

**Approaching home sends up a flare.** The "about a minute / 30 seconds away"
push is easy to miss, and being at the gate is not — so the same thresholds that
send it also mark the map: that device's **badge card** is banded in colour — a
thick line drawn *inside* the card, and its status line becomes the countdown
(`→ Home1 · ~30s`) instead of growing one of its own — while a **radar sweeps
out of the card across the whole map** and fades as it travels: **yellow** from
the 60 s trigger, **red** from the 30 s one (faster, and brighter). It stops on its own if nothing follows (60 s with no 30 s trigger,
then 60 s with no arrival) and at once if the car arrives or turns away. Both
come from the same threshold crossing in the Durable Object, and the pulse is
armed even when the push is suppressed (quiet hours, nobody subscribed) — which
is exactly when the map is all you have. The sweeps are read as distance from
the card, so they are drawn in their own layer over the map rather than inside
the scrollable badge strip, which clipped the first version down to a ~170 px
smudge.

The same crossing **also writes a row in the chat** (`⏳ MaxX is ~30s from Home`,
amber, `eventType: approach`), because that is the household's record of what
happened — the push is the alert, the row is what you can still read after it
has scrolled off a phone. It is written unconditionally, like the `arrived` and
`left` rows, so an approach during quiet hours still leaves a trace. (The
`moving again` and `stopped at …` pushes stay push-only on purpose: they fire on
every trip segment and would bury the rows that matter.)

## Showing someone the map (the live share)

An admin can hand a relative a **6-digit code** for **one person**: they open
`/live`, type it, and watch that person drive on a full-bleed map until
**midnight UTC**. Nothing to install, no account for them — and nothing else
visible: not the other device, not the chat, not the household's other names.
The page names the person it is showing, and that name is theirs: the code is
bound to a device that has an account, and the name is read from it, so there is
no text box anywhere that could put one person's name over another's map. A
person can have **one** live code at a time — making a new one replaces it.

It opens at **street level** (zoom 17) and Recentre returns there: the viewer's
question is "which street is she on", which an overview cannot answer. Rural
areas can look thin at that level in the provider's street raster — that is the
provider's data density, not a fault, and the answer is not to point the page at
another tile server. The viewer sees where the device is **now** and where it has been **since the code was created** — never the whole day, so an outsider handed a code at 14:00 cannot see the morning. Their lower badge is the household map's HUD, speedometer included: the **live** speed as a large figure coloured by the same ramp the household trail uses, then the street and number, suburb and first division (Nominatim, refreshed on a 10 s clock of its own). The map moves exactly like the household's — the same fluid cursor and follow camera from one shared engine, with no live/real-time switch — so the numbers are live while the dot glides about 25 s behind.

Mint from **WAY → Settings → Map**, under the *Map pace* switch: pick the person
there (until you do, it offers the device the map is following), the button names
them, and the code is shown **once** with a copy-link button, and
puts **Stop sharing** right there. The household-wide card — every open code,
what ended, and **Revoke all** ("she has arrived") — stays in **Home → You →
Console** (`/admin`). Both doors ask the same authority before minting, so they
cannot disagree about who may hand out a code. The code is shown
**once** — it is stored only as a hash, so there is no "show it again" that could
be honest — and the link the card copies carries it in the fragment
(`/live#123456`) so it stays out of logs. What ended stays listed, saying whether
an admin or midnight ended it, and the viewer's page says the link has ended on
its next poll. Ten wrong tries an hour lock a caller out, and every refusal is
recorded in **`/admin/diagnostics`**, so "somebody is guessing codes" is
something you can find afterwards.

`migrations-home/0006_share_links.sql` has to be applied (locally and in
production) or the card lists nothing. The map shows the device's *newest* fix,
not the household's smoothed cursor — someone asking "is she nearly here" wants
the live dot.

## One login, how it works

* An admin creates each person at **`/admin`** (username + password + role), and
watches the parts of the app that are built to fail quietly at
**`/admin/diagnostics`** (see [project.md](./project.md) → "The diagnostics
ledger" for what each number means and its three limits).
  The account is provisioned into Sompitra, W.A.Y and Laoka immediately.
* **`/login`** checks the password once (against the central `home-db`) and
  mints every module's native session cookie. No module ever shows a login
  screen.
* If a module cookie goes stale, the next 401 transparently re-mints it —
  you never notice.
* **One spelling per person.** Names are matched ignoring case everywhere — the
  login, the per-module provisioning, and the GPS tracker's own credential
  check — and the tracker stores the account's spelling rather than whatever
  the phone's app happens to say. So a phone configured before a rename keeps
  uploading, under one name (see `CUTOVER.md` §1f for the 2026-09-20 cleanup
  that made `Niri` the only spelling in the data).
* `/logout` signs you out of everything. `/change-password` changes it
  everywhere at once.
* The very first deployment is claimed at **`/bootstrap`**: the first account
  created becomes the admin. (Optional `SETUP_TOKEN` secret protects that
  window.)

Databases are the original ones — no data migration, module code reads its
own tables as before. `home-db` is new and holds only people + sessions.

## Local development

```bash
npm install
# one-time: apply migrations to the four local D1 databases (see AGENTS.md)
npm run dev            # wrangler dev on :8787 (pass another port if busy)
```

Test before you deploy (the server must be running):

```bash
npm run check                                  # tsc --noEmit
npm run smoke                                  # end-to-end checks, exit 0 = green
BASE_URL=http://127.0.0.1:8793 npm run smoke   # non-default port
npm run verify                                 # both, in order
npm run audit:remote                           # the four REMOTE dbs vs migrations-* (read-only)
npm run audit:module-state                     # request state in module scope, in src/ (read-only)
npm run audit:do-state                         # request data parked on a DO's `this` (read-only)
npm run deploy:dry-run                         # builds + resolves bindings
```

`npm run audit:remote` answers the one question the local suite cannot:
**did every migration actually reach the real databases?** Those files are
applied by hand, per environment, and nothing in a build or a deploy touches
them — so the code can be live and correct while the table it writes does not
exist, silently (this is how live shares were un-mintable in production on
2026-09-20). It reads only, is safe against production, and exits non-zero on a
gap — run it before a release, and after adding any `migrations-*/*.sql`.

`npm run audit:module-state` answers the other question reading the code
decides: **is any module-scope binding written by a request?** One Worker
isolate serves concurrent requests and interleaves them at every `await`, so
such a binding is shared state between unrelated people — it is only visible by
reading the code, since it throws nothing and needs a second request to
trigger. `npm run smoke` §24 runs the same scan (so `npm run verify` covers it)
and holds the guard to its own controls.

`npm run audit:do-state` is its sibling one level down, and answers the
question a single-threaded object invites you to get wrong: a Durable Object
serializes INSTRUCTIONS, not REQUESTS, and two requests interleave at every
`await` — so a field assigned from one request and read past an await carries
that request's data into another's turn. It reads the Durable Objects named in
`wrangler.jsonc` and requires every field on `this` to be declared with the
reason it is object state, which is how `FleetDO`'s two caches, four keyed Maps
and one deliberately-exempt diagnostics slot stay accounted for.

`npm run smoke` logs in once through `/login` and then proves: all four
session cookies are minted, every tab and module API answers 200, the
module documents are session-gated, bad credentials are rejected without
setting a cookie, the tab bar is identical (real icons, no emoji) on every
tab, each tab keeps its own colour whether or not it is active, both shapes
carry the same six tabs, a jar holding only `home_session` self-repairs on all
three modules, the live share hands out exactly one device (mint → wrong code
refused and receipted → resolve → revoke), and the install assets are genuinely
installable (manifest fields, icon sizes that match the files, a maskable icon
that is not a copy of the plain one, a service worker that handles fetches) — in
both installable scopes, `/` and `/way/`. It also holds the map to the engine
rather than to a drawing of it: a fence is drawn at **its own** exit radius,
the month totals km through the same rule as the day — the HUD's "km today" and
the reviewed day's walking dashes and GPX included — a walking fix moves the
distance anchor so the drive after it is not charged the walk, the share follows
at a zoom its one background can serve, the HUD's arrival ETA uses
the same thresholds as the push that announces it, both inline page scripts
compile, and the build marker is never older than the page it labels. It exits
non-zero on any regression.

Secrets live in `.dev.vars` (never committed): `AUTH_PEPPER` (required,
≥16 chars) and `SESSION_SECRET` (signs W.A.Y tokens). First run: open
`/bootstrap`, claim the admin, then add people at `/admin`.

## Deploy

Deploying Home itself is one command — `wrangler.jsonc` already carries the real
`home-db` id and the four production database bindings, and the databases are
already migrated:

```bash
npm run deploy            # or connect the repo in Cloudflare; it builds from main
```

Three secrets must exist for a deploy to be usable. They are set ONCE per Worker
and survive later deploys:

```bash
wrangler secret put SETUP_TOKEN      # FIRST — closes the /bootstrap claim window
wrangler secret put AUTH_PEPPER      # required, ≥16 random chars
wrangler secret put SESSION_SECRET   # signs W.A.Y device tokens / module sessions
```

A fourth, `NTFY_TOKEN`, is needed **only** when the household's ntfy instance
requires auth — see [`CUTOVER.md`](./CUTOVER.md) §2.

`SETUP_TOKEN` first is deliberate: `/bootstrap` becomes claimable the moment a
pepper exists, so on a public hostname the token is what stops a stranger
becoming admin. Without `AUTH_PEPPER` the app deploys **inert, not open** —
`/login` redirects with `err=no_pepper` and `/bootstrap` refuses.

**A fresh environment** (new Cloudflare account, or a second identity database)
is the only case that needs the schema steps — do not re-run them against the
live `home-db`, which would create a second, empty identity database:

```bash
wrangler d1 create home-db     # paste the id into wrangler.jsonc (HOME_DB)
for f in migrations-home/000{1,2,3,4,5,6}*.sql; do
  wrangler d1 execute HOME_DB --remote --file="$f"
done
```

Then open `<your-worker>/bootstrap` once to create the admin, and add the
household at `/admin`.

### Cutover from the three standalone apps

**Full runbook: [`CUTOVER.md`](./CUTOVER.md).** The shape of it:

* Module data needs **no migration** — the Worker binds the same databases
  (`sompitra-db`, `way-db`, `laoka`) the standalone apps used, and Sompitra's
  existing accounts are matched **by username and left alone**, so every
  transaction keeps its attribution.
* Existing **W.A.Y** users whose username matches the new Home username are
  linked automatically (their password/μlogger credential is untouched);
  unknown names get fresh rows on first Home login.
* Two traps worth reading the runbook for:
  * Sompitra's `users.is_admin` is **never** re-derived on provisioning, so the
    Home admin does not automatically become the Sompitra admin. Set the flag by
    hand for a clean state (`CUTOVER.md` §1c) — though the app no longer *needs*
    it: `/settings`' household card (and with it the links to `/admin` and
    `/admin/diagnostics`) follows the **central role** first and keeps the
    module flag only as a fallback, so a Home admin cannot be locked out of the
    console by a module row that predates the merge.
  * `way-db` must still contain the `devices` table. It is the FK parent of
    `messages.device_id`, and without it the DO's flush fails **as a whole**
    while the live chat keeps working — so chat history and map tracks go
    quietly empty.
* **The three old Workers are gone** (deleted 2026-09-19, after the phones
  were verified to be posting to Home's `/ulogger`): two cron flushes of the
  same `way-db` and a second stale view of the same phones was the risk.
  Rollback is still one `wrangler deploy` per module repo — D1 is bound by id
  and never owned by a Worker, so a redeploy finds every row where Home left
  it. What a rollback cannot recover is a deleted Durable Object's storage,
  which is why the old `way` DO's chat backlog was flushed into `way-db`
  (466 messages) before the deletion.
* Sompitra's old PIN logins stop working (by design — the password replaces
  the PIN); sessions minted after the cutover are normal.

## Layout

See `project.md` for the full architecture and `AGENTS.md` for the
engineering gotchas (mount order, cookie-join bug class, hash formats, cron).
`CUTOVER.md` is the runbook from the three standalone Workers to this one, and
`DB-REDESIGN.md` is the *proposal* for what the schemas would look like if they
were redrawn — read it as future work, not as a description of today's tables.
