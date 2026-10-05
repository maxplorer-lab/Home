// ─── Client-state convergence: the facts, and their carriers ─────
//
// Answers ONE question about the whole super app: **for every fact a client
// caches from the server, is there a way for a change made somewhere else to
// reach it?**
//
// Why this exists. Two outages in this app's history are one bug wearing
// different clothes:
//
//   * a pause flipped on the PC read as Live on a phone opened later — the
//     state lived in the Durable Object, and broadcast frames only reach
//     sockets that are ALREADY open, so a page opened afterwards never learned
//     it (fixed by putting it in the connect snapshot);
//   * a fence added on the PC stayed invisible on the phone until a reload —
//     the rows live in D1 and are read when a page opens, so a SIGNAL was sent
//     to nobody (fixed by the config-change signal, rule 46).
//
// Both are the same question, asked of one fact at a time: what does a client
// hold, and what carries a change to it? Answering it per fact is what this
// file is, and the point of writing it DOWN is that the app's next fact gets
// asked the question too. The three carriers available are:
//
//   connect   the fact arrives when a client connects (the WS snapshot, or the
//             page's boot fetch of the API that owns it). Covers a client that
//             was not there when the change happened.
//   change    a change reaches clients that ARE there: a WS frame carrying the
//             data, a WS frame carrying a TOPIC (the client re-reads the slice),
//             or a module's own fan-out (Laoka's Lobby).
//   resync    a catch-all: re-read when the socket reconnects and when the page
//             becomes visible again, which is what makes the two above
//             best-effort instead of load-bearing.
//
// A fact with neither a change carrier nor a resync is a fault, and so is a
// declared carrier whose code has gone: a fact that quietly loses its carrier
// is exactly the failure this registry exists to make loud. Facts that are
// client-owned (a localStorage preference) or genuinely request-scoped (a trip
// list fetched when you open it) declare that instead, with the reason — a
// declared answer, not an omission.
//
// It is READ-ONLY: it parses sources and writes nothing, so it is safe to run
// anywhere, and it exits 1 on a finding so it can gate a release.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, extname } from 'node:path'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * Every fact a client caches from the server, and what carries a change to it.
 *
 * Fields (all checked against the tree unless the entry is `declared`):
 *   fact     what a person would call it, in the words a reader uses
 *   owner    where the truth lives
 *   clients  the files that cache it
 *   connect  { snapshot: ['key'] }  a key of the DO's connect snapshot, or
 *            { boot: ['function'] }  the client function that loads it at boot
 *   change   { frame, topic, signal }  how a LIVE client hears about a change
 *   resync   event names the client re-reads on (['visibilitychange', 'online'])
 *   declared a reason this fact needs no live carrier (client-owned, or
 *            fetched per request) — printed, never silently accepted
 */
export const CLIENT_STATE = [
  {
    fact: 'each device\'s control toggles (forced mode, recording pause)',
    owner: 'FleetDO device_state, carried on the connect snapshot',
    clients: ['public/way/index.html'],
    connect: { snapshot: ['controls'], reads: ['data.controls'] },
    change: { frame: 'deviceControlState' },
  },
  {
    fact: 'the live feed (positions, today\'s tracks, approach pulses, chat + reactions)',
    owner: 'FleetDO (its own tables), the write path of the whole system',
    clients: ['public/way/index.html', 'public/chat/index.html'],
    connect: { snapshot: ['devices', 'tracks', 'chat', 'approaches'] },
    change: { frame: 'position' },
    resync: ['visibilitychange'],
  },
  {
    fact: 'the devices (name, emoji, colour)',
    owner: 'way-db users (read as the dashboard\'s device list)',
    clients: ['public/way/index.html'],
    connect: { boot: ['loadDevicesAndGeofences'] },
    change: { topic: 'devices' },
    resync: ['visibilitychange'],
  },
  {
    fact: 'the geofences (name, display name, category, radii)',
    owner: 'way-db geofences',
    clients: ['public/way/index.html'],
    connect: { boot: ['loadDevicesAndGeofences'] },
    change: { topic: 'fences' },
    resync: ['visibilitychange'],
  },
  {
    fact: 'the live-share grants (and the one pin that is shown once)',
    owner: 'home-db shares, minted and revoked through the Worker',
    clients: ['public/way/index.html'],
    connect: { boot: ['loadShareState'] },
    change: { topic: 'shares' },
    resync: ['visibilitychange'],
  },
  {
    fact: 'the invite codes',
    owner: 'way-db invite_codes',
    clients: ['public/way/index.html'],
    connect: { boot: ['loadInviteCodes'] },
    change: { topic: 'invites' },
    resync: ['visibilitychange'],
  },
  {
    fact: 'the notification config (the subscription grid, quiet hours)',
    owner: 'way-db notification subs + home-db channels',
    clients: ['public/way/index.html'],
    connect: { boot: ['loadNotifConfig'] },
    change: { topic: 'notifications' },
    resync: ['visibilitychange'],
  },
  {
    fact: 'the push server (the household\'s ntfy root)',
    owner: 'home-db home_settings.ntfy_server',
    clients: ['public/way/index.html'],
    connect: { boot: ['loadAdminUsers'] },
    change: { topic: 'settings' },
    resync: ['visibilitychange'],
  },
  {
    fact: 'a person\'s profile and map preferences (role, follow zoom, home fence)',
    owner: 'way-db users + home-db users',
    clients: ['public/way/index.html'],
    connect: { boot: ['loadCurrentUser'] },
    change: { topic: 'profile' },
    resync: ['visibilitychange'],
  },
  {
    fact: 'Laoka\'s weeks, planned days, shopping lines and pantry',
    owner: 'laoka-db, fanned out by the Lobby DO',
    clients: ['public/laoka/app.js'],
    connect: { boot: ['softRefresh'] },
    change: { signal: 'notifyAsync', in: 'src/laoka/routes' },
    resync: ['visibilitychange', 'online'],
  },
  {
    fact: 'the chat scrollback and its unread lines',
    owner: 'FleetDO chat_messages (flushed to way-db nightly)',
    clients: ['public/chat/index.html'],
    connect: { boot: ['connectWebSocket'] },
    change: { frame: 'chat' },
    declared: 'unread is a WATERMARK in the browser by design (rule 24): the count and the lines are the server\'s answer to it, so there is nothing to carry but the frames themselves',
  },
  {
    fact: 'a trip, a day\'s track and the monthly totals',
    owner: 'way-db gps_pings',
    clients: ['public/way/index.html'],
    declared: 'request-scoped: fetched when a date is opened or a total is drawn, and never cached beyond the view that asked — the day being viewed is re-read on every selection',
  },
  {
    fact: 'the map\'s own preferences (pace, the bar\'s target, follow device, hidden tracks)',
    owner: 'this browser\'s localStorage',
    clients: ['public/way/index.html'],
    declared: 'client-owned: a preference about THIS device, deliberately not shared (one phone\'s map pace must not move another\'s)',
  },
  {
    fact: 'Sompitra\'s pages (budget, debts, Kiné, categories)',
    owner: 'sompitra-db, rendered per request',
    clients: ['src/routes/budget.tsx'],
    declared: 'server-rendered per request and read by one person at a time on a phone: a page left open shows the numbers it was drawn with, and the next navigation re-reads them. Named here rather than left out, because it is the one surface with no live carrier (see the report)',
  },
]

/** The minimum number of facts a working scan must find — a scan whose input
 *  silently emptied reports green forever (the failure `rule-guards.mjs` and
 *  `do-state.mjs` both guard against). */
export const MIN_FACTS = 10

const SOURCE_FILES = {
  do: 'src/way/do/FleetDO.ts',
  topics: 'src/way/lib/config-topics.ts',
  wayRoutes: 'src/way/routes/dashboard-api.ts',
  homeSettings: 'src/routes/settings.tsx',
  wayClient: 'public/way/index.html',
  chatClient: 'public/chat/index.html',
  laokaClient: 'public/laoka/app.js',
  laokaNotify: 'src/laoka/lib/notify.js',
}

/** Every file the registry might need, as text. Injectable so smoke §30 can run
 *  the scan over fixtures that exist only in memory. */
export function loadSources(root = REPO_ROOT) {
  const read = (rel) => readFileSync(isAbsolute(rel) ? rel : join(root, rel), 'utf8')
  const out = { root }
  for (const [key, rel] of Object.entries(SOURCE_FILES)) {
    try { out[key] = read(rel) } catch { out[key] = null }
  }
  // Every source under src/laoka/routes — where a mutation must announce itself.
  out.laokaRoutes = []
  try {
    const dir = join(root, 'src/laoka/routes')
    for (const name of readdirSync(dir)) {
      if (!['.js', '.mjs', '.ts'].includes(extname(name))) continue
      out.laokaRoutes.push({ path: `src/laoka/routes/${name}`, text: read(join(dir, name)) })
    }
  } catch { /* a missing directory is reported as a finding by the scan */ }
  out.waySources = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (['.ts', '.tsx'].includes(extname(name))) out.waySources.push({ path: full.replace(root, '').replace(/\\/g, '/').replace(/^\//, ''), text: read(full) })
    }
  }
  try { walk(join(root, 'src/way')) } catch { /* reported by the scan */ }
  return out
}

function isAbsolute(p) {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p)
}

/**
 * Check every declared fact against the code.
 *
 * Returns { facts, faults } — `facts` is the inventory (each fact with the
 * carriers it declares, so a caller can print what IS there), `faults` the
 * findings, each with a `code` and the declared fact it belongs to.
 */
export function scanClientState({ root = REPO_ROOT, sources = null, registry = CLIENT_STATE } = {}) {
  const s = sources ?? loadSources(root)
  const faults = []
  const facts = []

  if (!s.do || !s.topics || !s.wayRoutes || !s.wayClient) {
    return {
      facts,
      faults: [{
        code: 'sources-unreadable',
        fact: '(any)',
        detail: `one of the registry's sources could not be read (FleetDO=${!!s.do}, config-topics=${!!s.topics}, dashboard-api=${!!s.wayRoutes}, way client=${!!s.wayClient}) — nothing below was checked, and a clean report here would mean nothing`,
      }],
    }
  }

  const has = (text, needle) => typeof text === 'string' && text.includes(needle)
  const topics = new Set(
    [...s.topics.matchAll(/^\s*'([a-z-]+)',?\s*$/gm)].map((m) => m[1])
  )
  // The client's own table: `topic: function() { … }` inside CONFIG_SLICES.
  const slices = new Set(
    [...s.wayClient.matchAll(/^\s{4}([a-z-]+):\s+function\(\)/gm)].map((m) => m[1])
  )

  for (const entry of registry) {
    const row = { fact: entry.fact, owner: entry.owner, carriers: [], declared: entry.declared ?? null }
    facts.push(row)
    const bad = (code, detail) => faults.push({ code, fact: entry.fact, detail })

    // ── connect ──
    if (entry.connect?.snapshot) {
      for (const key of entry.connect.snapshot) {
        if (!new RegExp(`\\b${key}:`, '').test(s.do)) bad('snapshot-key-missing', `the connect snapshot no longer carries \`${key}\` in FleetDO.buildSnapshot`)
        row.carriers.push(`connect: snapshot.${key}`)
      }
    }
    for (const read of entry.connect?.reads ?? []) {
      if (!has(s.wayClient, read)) bad('client-read-missing', `the dashboard no longer reads \`${read}\` from the snapshot`)
    }
    for (const fn of entry.connect?.boot ?? []) {
      const files = entry.clients.filter((c) => c.endsWith('.html') || c.endsWith('.js'))
      const found = files.some((cl) => has(clientText(s, cl), fn))
      if (!found) bad('boot-loader-missing', `no client of this fact still loads it at boot (looked for \`${fn}\` in ${files.join(', ')})`)
      row.carriers.push(`connect: boot ${fn}()`)
    }

    // ── change ──
    const c = entry.change ?? {}
    if (c.frame) {
      if (!has(s.do, `type: "${c.frame}"`)) bad('frame-not-broadcast', `nothing in FleetDO broadcasts a \`${c.frame}\` frame`)
      const handled = entry.clients.some((cl) => has(clientText(s, cl), `'${c.frame}'`))
      if (!handled) bad('frame-not-handled', `no client of this fact handles a \`${c.frame}\` frame`)
      row.carriers.push(`change: ${c.frame} frame`)
    }
    if (c.topic) {
      if (!topics.has(c.topic)) bad('topic-unknown', `\`${c.topic}\` is not in CONFIG_TOPICS (src/way/lib/config-topics.ts)`)
      if (slices.size && !slices.has(c.topic)) bad('client-slice-missing', `the dashboard's CONFIG_SLICES has no \`${c.topic}\` row, so the signal would be ignored`)
      // Signalled where it is written: either the DO's own reload route
      // broadcasts it (a fact the DO caches), or a route calls the signal.
      const broadcastByDo = new RegExp(`broadcast\\(\\{ type: "config", topic: "${c.topic}" \\}\\)`).test(s.do)
      // The writer may be W.A.Y's own API or Home's /settings (the household
      // push server is written there), so both are searched.
      const signalled = broadcastByDo
        || has(s.wayRoutes, `signalConfigChange(env, "${c.topic}")`)
        || has(s.homeSettings, `signalConfigChange(c.env, '${c.topic}')`)
      if (!signalled) bad('no-signal', `nothing signals \`${c.topic}\`: neither FleetDO's reload routes nor a dashboard-api write announces it`)
      row.carriers.push(`change: config signal '${c.topic}'`)
    }
    if (c.signal) {
      const helper = c.signal === 'notifyAsync'
        ? s.laokaNotify
        : null
      if (!has(helper, `export function ${c.signal}`)) bad('signal-helper-missing', `${c.signal}() is not exported by ${SOURCE_FILES.laokaNotify}`)
      const files = (s.laokaRoutes ?? []).filter((f) => has(f.text, `${c.signal}(`))
      const calls = files.reduce((n, f) => n + (f.text.match(new RegExp(`${c.signal}\\(`, 'g')) ?? []).length, 0)
      if (calls < 3) bad('signal-unused', `only ${calls} mutation site(s) under ${c.in} announce a change through ${c.signal}() — the fan-out is there but nothing rings it`)
      row.carriers.push(`change: ${c.signal}() fan-out (${calls} calls in ${files.length} file(s))`)
    }

    // ── resync ──
    for (const ev of entry.resync ?? []) {
      const files = entry.clients.filter((cl) => cl.endsWith('.html') || cl.endsWith('.js'))
      const found = files.some((cl) => has(clientText(s, cl), ev))
      if (!found) bad('resync-missing', `no client of this fact re-reads on \`${ev}\``)
      row.carriers.push(`resync: ${ev}`)
    }

    // ── declared, or covered ──
    const live = row.carriers.some((x) => x.startsWith('change:'))
    if (!live && !entry.declared && !row.carriers.some((x) => x.startsWith('connect:') && x.includes('boot'))) {
      bad('no-carrier', 'this fact has no change carrier and no declared reason — a change made elsewhere would never reach an open page')
    }
  }

  // Injectable so the control in smoke §30 can hand in a one-fact registry: a
  // scan that stopped LOOKING must not be able to report a clean tree.
  if (registry.length < MIN_FACTS) {
    faults.push({
      code: 'registry-thin', fact: '(any)',
      detail: `the registry declares ${registry.length} fact(s), fewer than the ${MIN_FACTS} a working scan must find — a scan that stopped looking reports green forever`,
    })
  }

  return { facts, faults }
}

/** The client text a declared path refers to (the way-dashboard, the chat page,
 *  a module's own script). */
function clientText(s, path) {
  if (path === 'public/way/index.html') return s.wayClient
  if (path === 'public/chat/index.html') return s.chatClient
  if (path === 'public/laoka/app.js') return s.laokaClient
  return null
}

export function formatFaults(faults) {
  return faults.map((f) => `[${f.code}] ${f.fact} — ${f.detail}`)
}
