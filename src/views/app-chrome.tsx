/** @jsxImportSource hono/jsx */
// ─── THE app chrome — one header, one tab bar ────────────────────
// WeChat model: every screen is a tab under the same chrome. This file
// is the single source of truth for it, used by BOTH
//   • src/views/layout.tsx  (Sompitra pages + any in-app route)
//   • src/views/shell.tsx   (the module tabs: WAY / Laoka / Chat)
//
// Why it lives here: the two hosts used to duplicate the header and the
// tab bar, and they drifted — the module shells kept EMOJI icons and had
// no dark-mode toggle or safe-area padding, so 3 of the 6 tabs looked
// like a different app. One component means they can never drift again.
//
// Icons are the real assets: Home's brand mark, WAY's pin, Laoka's pot;
// Sompitra / Chat / You use crisp inline SVG (no emoji — they render as
// blurry colour glyphs at tab-bar size and can't inherit the active tint).
//
// ── Two shapes, one definition ───────────────────────────────────
// The same tabs are rendered twice: a horizontal nav inside the header
// (md and up, where a phone-style bottom bar wastes the window) and the
// bottom bar itself (below md). Both come from HOME_TABS, so a tab can
// never exist in one place and not the other.
import type { FC } from 'hono/jsx'
import { userAccentColor } from '../lib/utils'

export interface Badge {
  img?: string
  svg?: string
  label: string
}

// ─── The brand typeface ──────────────────────────────────────────
// ONE face for the whole app. W.A.Y already shipped Plus Jakarta Sans
// (`public/way/index.html`), Laoka and Sompitra shipped Segoe UI, so the same
// screen could show two different typefaces depending on which tab you were on
// — the loudest "these are three apps" signal there is. The shell, Laoka and
// the chat room now load the same family; the system stack stays as the
// fallback, so a cold cache offline still renders in a real font.
export const BRAND_FONT_STACK = "'Plus Jakarta Sans', 'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif"

/** The dark palette: written ONCE, applied by ONE signal — the html.dark class
    the bootstraps set (see the note inside `CHROME_CSS` for why the OS media
    query must NOT carry a second copy of these values). */
const DARK_TOKENS = `
    color-scheme: dark;
    --paper:  #111827;
    --sheet:  #1f2937;
    --rule:   #374151;
    --ink:    #f3f4f6;
    --ink-2:  #a5aebc;
    --ink-3:  #8b94a3;
`

/** The one `@font-face` request, shared by every document we serve. */
export const BrandFontLinks = () => (
  <>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap"
    />
  </>
)

// ─── The icon set ────────────────────────────────────────────────
// The app's own glyphs, replacing the decorative emoji that used to prefix
// every card title (🔔 👐 💰 📋 🎯 …). Three reasons, in order of importance:
//   1. an emoji is a colour picture the OS picks — it cannot wear the screen's
//      accent colour, so the headings never belonged to the module they sat in;
//   2. they render at a different size and baseline on every platform (the 🔔
//      is a full-colour bitmap on Android and a thin line on Windows);
//   3. an SVG in `currentColor` can be tinted by `--accent`, which is what ties
//      a heading to the tab you are in (see `.accent-mark` in CHROME_CSS).
//
// Emoji that ENCODE something (the 🟢🟡🔴 Kiné legend, category icons, the
// per-user colour dots) are data, not decoration, and stay exactly as they are.
//
// Winding matters exactly as it does in TAB_SVGS: a sub-path that runs against
// its parent punches a hole (nonzero rule). Holes are used for the donut, the
// target rings, the padlock's shackle, the server's status lights and the pin's
// centre, so they read correctly on any background, in either theme.
export const ICONS: Record<string, string> = {
  // house — the household itself
  house: 'M12 2.6 2.8 10.2a1 1 0 0 0 .65 1.8H5V21h5v-5h4v5h5v-9.01h1.55a1 1 0 0 0 .65-1.79Z',
  // bell — the day's activity
  bell: 'M12 2.2a5.6 5.6 0 0 0-5.6 5.6v4.3L4.4 15.1a.9.9 0 0 0 .8 1.35h13.6a.9.9 0 0 0 .8-1.35l-2-3V7.8A5.6 5.6 0 0 0 12 2.2Zm-2.4 15.4a2.4 2.4 0 0 0 4.8 0Z',
  // pulse — Kiné (physio sessions), a heartbeat trace
  pulse: 'M3 12.6h3.2l2.3-6 3.4 11 2.3-7.3 1.6 2.3H21v2.4h-5.4l-1.2-1.7-2.3 7.3-3.4-11-1.4 3.6H3Z',
  // receipt — money out (same shape as the Sompitra tab)
  receipt: 'M7 2.9H17A1.5 1.5 0 0 1 18.5 4.4V20.3L16.3 18.6 14.1 20.3 11.9 18.6 9.7 20.3 7.5 18.6 5.5 20.3V4.4A1.5 1.5 0 0 1 7 2.9ZM8.6 6.4V8H15.4V6.4ZM8.6 9.6V11.2H15.4V9.6ZM8.6 12.8V14.4H13.2V12.8Z',
  // arrow into a tray — money in
  'arrow-in': 'M11 2.6h2v9.2l3.3-3.3 1.7 1.7L12 16.3 6 10.2l1.7-1.7L11 11.8ZM4 18.2h16v3.2H4Z',
  // donut — a breakdown by category
  donut: 'M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19Zm0 4a5.5 5.5 0 0 0 0 11 5.5 5.5 0 0 0 0-11Z',
  // target — progress against a budget
  target: 'M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19Zm0 3a6.5 6.5 0 0 0 0 13 6.5 6.5 0 0 0 0-13Zm0 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
  // list — rows of records
  list: 'M4 6.4h2.6v2.6H4Zm4.8 0H20v2.6H8.8ZM4 11h2.6v2.6H4Zm4.8 0H20v2.6H8.8ZM4 15.6h2.6V18H4Zm4.8 0H20V18H8.8Z',
  // swap — two directions (debts AND credits)
  swap: 'M7.4 3.6 3 8.1l4.4 4.5V9.4H20V6.8H7.4Zm9.2 8.2v3.2H4v2.6h12.6v3.2l4.4-4.5Z',
  // trend — income against expenses
  trend: 'M3 18.4 9.2 12.2l3.6 3.6 5.6-6.1H15V7.5h6v6h-2.2v-3.4l-6.4 6.9-3.6-3.6-4.2 4.2Z',
  // bars — a comparison
  bars: 'M3 4.4h4.6v17.2H3Zm6.7 6h4.6v11.2H9.7Zm6.7-6h4.6v17.2h-4.6Z',
  // person — one account
  person: 'M12 12a4.5 4.5 0 1 0-4.5-4.5A4.5 4.5 0 0 0 12 12Zm0 2c-3.6 0-7.5 1.8-7.5 4.5V20h15v-1.5c0-2.7-3.9-4.5-7.5-4.5Z',
  // people — the household
  people: 'M9.4 11.4a3.7 3.7 0 1 0 0-7.4 3.7 3.7 0 0 0 0 7.4Zm0 1.7c-3 0-6.4 1.5-6.4 3.8V19h12.8v-2.1c0-2.3-3.4-3.8-6.4-3.8Zm7-1.7a3.3 3.3 0 1 0 0-6.6v6.6Zm.9 1.9c2.3.4 4.3 1.7 4.3 3.6V19h-3.2v-2.1c0-1.4-.6-2.6-1.7-3.5Z',
  // plus — add a person / a record
  plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7Z',
  // padlock — credentials
  lock: 'M6.8 10.4h10.4v10H6.8Zm2-3.2a3.2 3.2 0 0 1 6.4 0h-2.1a1.1 1.1 0 0 0-2.2 0Zm0 0h2.1v3.2H8.8Z',
  // phone — install
  phone: 'M7 2h10a1.6 1.6 0 0 1 1.6 1.6v14.8A1.6 1.6 0 0 1 17 20H7a1.6 1.6 0 0 1-1.6-1.6V3.6A1.6 1.6 0 0 1 7 2Zm1.2 2.4v13.2h7.6V4.4ZM10.6 21h2.8v1.4h-2.8Z',
  // server rack — the notification server
  server: 'M3 3.6h18v6.6H3Zm0 9.4h18v6.6H3ZM6.2 5.8v2.2h2.2V5.8Zm0 9.4v2.2h2.2v-2.2Zm3.6-9.4v2.2H18V5.8Zm0 9.4v2.2H18v-2.2Z',
  // folder — categories & access
  folder: 'M2.6 5.4h6.6l2 2.4h10.2v10.8H2.6Zm2.2 4.6v6.4h14.4V10Z',
  // pin — tracking
  pin: 'M12 2.4a6.6 6.6 0 0 0-6.6 6.6c0 4.9 6.6 12.6 6.6 12.6s6.6-7.7 6.6-12.6A6.6 6.6 0 0 0 12 2.4Zm0 3.2a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4Z',
  // bowl — meal plans
  bowl: 'M2.6 11.2h18.8a9.4 9.4 0 0 1-18.8 0ZM10.8 2.4h2.4v3.2h-2.4Zm-3.4 1 2 2-1.7 1.7-2-2Zm6.8 0 1.7 1.7-2 2-1.7-1.7Z',
  // sliders — settings
  sliders: 'M3 6.6h7.4V8.8H3Zm11.6 0H21V8.8h-6.4ZM10.4 4.4h2.4v6.6h-2.4ZM3 15.2h4.4v2.2H3Zm8.6 0H21v2.2h-9.4ZM7.4 13h2.4v6.6H7.4Z',
  // chat bubble
  chat: 'M12 3C6.9 3 2.8 6.6 2.8 11c0 2.5 1.3 4.7 3.4 6.2-.2 1-.7 2-1.5 2.8 1.6-.1 3-.7 4.1-1.5 1 .3 2.1.4 3.2.4 5.1 0 9.2-3.6 9.2-8S17.1 3 12 3z',
  // clock — a period you look back at (the money history view)
  clock: 'M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19Zm0 3a6.5 6.5 0 0 0 0 13 6.5 6.5 0 0 0 0-13ZM11.2 6.6h1.6v5.7l3.6 2.1-.8 1.4-4.4-2.5Z',
  // chevrons — prev / next
  'chev-left': 'M14.7 4.4 16.3 6l-6 6 6 6-1.6 1.6L6.6 12Z',
  'chev-right': 'M9.3 4.4 7.7 6l6 6-6 6 1.6 1.6L17.4 12Z',
  // calendar — a period label
  calendar: 'M4 5.4h3V2.8h2.2v2.6h5.6V2.8H17v2.6h3v16.2H4Zm2.2 4.4v9.6h11.6V9.8Zm2 2h2.4v2.4H8.2Zm4.2 0h2.4v2.4h-2.4Zm-4.2 4h2.4v2.4H8.2Zm4.2 0h2.4v2.4h-2.4Z',
  // sun — switch to light
  sun: 'M12 7.4a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2ZM11 1.4h2v3.4h-2Zm0 17.8h2v3.4h-2ZM1.4 11h3.4v2H1.4Zm17.8 0h3.4v2h-3.4ZM4.1 6.9l1.4-1.4L7.9 7.9 6.5 9.3Zm12 12 1.4-1.4 2.4 2.4-1.4 1.4ZM16.1 7.9l2.4-2.4 1.4 1.4-2.4 2.5ZM6.5 14.7l1.4 1.4-2.4 2.5-1.4-1.5Z',
  // moon — switch to dark
  moon: 'M12.6 2.4a9.6 9.6 0 1 0 8.9 13A7.7 7.7 0 0 1 12.6 2.4Z',
}

/** One brand glyph, in `currentColor`, so a heading can tint it. */
export const Icon: FC<{ name: string; className?: string }> = ({ name, className = 'w-4 h-4' }) => {
  const d = ICONS[name]
  if (!d) return <span class={className} />
  return (
    <svg viewBox="0 0 24 24" class={className} fill="currentColor" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

// ─── The six tabs ────────────────────────────────────────────────
// One entry per tab, in bar order. `tab` is matched against the active
// key; the four Sompitra sections all light up the single Sompitra tab.
//
// `color` is the tab's OWN colour, and it is worn even when the tab is
// inactive: a person should be able to read the six modules by colour
// alone (green Home, teal money, violet chat, orange Laoka, sky map,
// slate You) instead of every inactive tab collapsing to the same grey.
// Where the module already owns a colour that colour is used verbatim
// (Laoka's orange, WAY's sky, the Home brand green, Sompitra's green
// family). The Chat tab is a Home-native tab on W.A.Y's engine, so it
// takes violet: it must not read as a second map tab.
//
// What marks the ACTIVE tab is therefore NOT "it is the only coloured
// one" but three cues that work together: a coloured pill behind the
// icon, a bar across the top of the tab, and a bold label in the tab's
// colour. Colour-blind reading still works because the cues are shape
// and weight, not hue.
// Each module therefore owns TWO values, and both come from here so no screen
// can invent its own:
//   color — the TINT: icons, marks, hairlines, tinted chips. Safe on white and
//           on #1f2937 (dark mode lifts it, see `.tab-tint` / `.accent-mark`).
//   ink   — the FILLED surface: a button or pill that carries white text. The
//           tint is too light for that (white on #0d9488 measures 3.9:1), so a
//           filled control uses the same hue one step down (white on #0f766e is
//           5.3:1). Using the tint as a button background is the trap here.
export const HOME_TABS = [
  { href: '/',         img: '/icon-64.png',      label: 'Home',     tab: 'dashboard', color: '#16a34a', ink: '#166534' },
  { href: '/budget',   svg: 'money',             label: 'Sompitra', tab: 'money',     color: '#0d9488', ink: '#0f766e' },
  { href: '/chat',     svg: 'chat',              label: 'Chat',     tab: 'chat',      color: '#7c3aed', ink: '#6d28d9' },
  { href: '/laoka/',   img: '/laoka/icon.svg',   label: 'Laoka',    tab: 'laoka',     color: '#ea580c', ink: '#c2410c' },
  { href: '/way/',     img: '/way/icon-64.png',  label: 'WAY',      tab: 'way',       color: '#0284c7', ink: '#0369a1' },
  { href: '/settings', svg: 'you',               label: 'You',      tab: 'settings',  color: '#475569', ink: '#334155' },
] as const

/** Sompitra sections that all belong to the one Sompitra tab. */
export const SOMPITRA_SECTIONS = ['budget', 'kine', 'debts', 'sales']

/** The theme/tab colour for an active key — used for `<meta theme-color>`
    so the browser chrome (and an installed app's status bar) matches the
    module you are in. */
export function tabColorFor(active?: string): string {
  return tabFor(active)?.color ?? '#16a34a'
}

/** The filled-surface variant of the active module's colour — for buttons and
    pills that carry white text (see the note on `HOME_TABS`). */
export function tabInkFor(active?: string): string {
  return tabFor(active)?.ink ?? '#166534'
}

/** The tab entry a module key belongs to (four Sompitra sections, one tab). */
function tabFor(active?: string) {
  return HOME_TABS.find(t => t.tab === active)
    ?? (SOMPITRA_SECTIONS.includes(active as string) ? HOME_TABS[1] : undefined)
}

/** The one width the chrome and the content column share, so the header,
    the tab bar and the page never disagree about where the edges are. */
export const SHELL_WIDTH = 'max-w-5xl lg:max-w-6xl'

const TAB_SVGS: Record<string, string> = {
  // receipt — an itemised slip with a torn bottom edge.
  //
  // This tab used to carry a wallet-ish card with a stripe, and at 24px it just
  // read as "a card": nothing about it said expenses. A receipt does, and it is
  // the one shape that survives being 24px tall with no colour — the three rule
  // lines and the tear stay legible, and it cannot be mistaken for any other tab
  // in the bar (the rest are a house, a bubble, a pot, a pin and a person).
  //
  // Winding matters: the body runs clockwise and the three rule lines run
  // counter-clockwise, which is what punches them out of the fill (nonzero rule).
  // Reverse either one and the lines disappear.
  money: 'M7 2.9H17A1.5 1.5 0 0 1 18.5 4.4V20.3L16.3 18.6 14.1 20.3 11.9 18.6 9.7 20.3 7.5 18.6 5.5 20.3V4.4A1.5 1.5 0 0 1 7 2.9ZM8.6 6.4V8H15.4V6.4ZM8.6 9.6V11.2H15.4V9.6ZM8.6 12.8V14.4H13.2V12.8Z',
  // speech bubble
  chat: 'M12 3C6.9 3 2.8 6.6 2.8 11c0 2.5 1.3 4.7 3.4 6.2-.2 1-.7 2-1.5 2.8 1.6-.1 3-.7 4.1-1.5 1 .3 2.1.4 3.2.4 5.1 0 9.2-3.6 9.2-8S17.1 3 12 3z',
  // person
  you: 'M12 12a4.5 4.5 0 1 0-4.5-4.5A4.5 4.5 0 0 0 12 12zm0 2c-3.6 0-7.5 1.8-7.5 4.5V20h15v-1.5c0-2.7-3.9-4.5-7.5-4.5z',
}

/** Inline SVG for a shell-native icon, in `currentColor`. */
export const TabSvg: FC<{ name: string; className?: string }> = ({ name, className = 'w-5 h-5' }) => {
  const d = TAB_SVGS[name]
  if (!d) return <span class="w-5 h-5" />
  return (
    <svg viewBox="0 0 24 24" class={className} fill="currentColor" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

/** Tab icon: a real image (its own colours, only dimmed when inactive) or
    an inline SVG that inherits the tab's colour from its wrapper.

    Images are never greyed or faded any more. Grayscaling every inactive tab
    is the thing that made five of the six modules look disabled, and even a
    light fade lands on the brand mark. The pill, the bar and the bold label
    carry the selection; the icon just stays the module's icon. */
export const TabIcon: FC<{
  item: { img?: string; svg?: string; color: string }
  className?: string
}> = ({ item, className = 'w-6 h-6' }) => {
  if (item.img) {
    return <img src={item.img} alt="" width={24} height={24}
      class={`${className} leading-none`} />
  }
  // The SVG inherits the tab tint from its wrapper (`--tab`, set by the bar
  // or the nav anchor); the PARENT does the dimming, so an icon can never be
  // dimmed twice as the bar and the nav differ in nesting depth.
  return (
    <span style={{ color: 'var(--tab)' }} class="flex">
      <TabSvg name={item.svg ?? ''} className={className} />
    </span>
  )
}

// ─── The chat unread dot ─────────────────────────────────────────
/** A 9px red dot on the Chat tab's icon, in BOTH bars (the script shows every
    `[data-chat-unread]` on the page). Chat is the one module that receives
    things while you are somewhere else -- a message from someone, or another
    module's system notification -- so the tab has to be able to say "there is
    something new" from any other tab. Just a dot, deliberately not a counter:
    a number would have to be kept in sync by whatever last saw the room, and
    being wrong is worse than being vague. See CHAT_UNREAD_SCRIPT for the
    state (one localStorage watermark + a poll of /way/api/chat/latest). */
export const ChatIconWithDot: FC<{ item: { img?: string; svg?: string; color: string } }> = ({ item }) => (
  <span class="chat-dot-wrap">
    <TabIcon item={item} />
    <span class="chat-unread-dot" data-chat-unread aria-hidden="true" />
  </span>
)

// ─── The desktop nav (md+) ───────────────────────────────────────
// Declared before the header that renders it: same tabs, horizontal.
export const HomeNav: FC<{ active?: string }> = ({ active }) => {
  const activeSompitra = SOMPITRA_SECTIONS.includes(active as string)
  return (
    <nav id="home-nav" class="hidden md:flex items-center gap-0.5 lg:gap-1.5">
      {HOME_TABS.map(item => {
        const isActive = active === item.tab || (item.tab === 'money' && activeSompitra)
        return (
          <a
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            class={`tab-tint flex items-center gap-1.5 px-2.5 lg:px-3 py-1.5 rounded-xl text-[13px] transition-all ${
              isActive ? 'is-active font-semibold' : 'font-medium hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
            // The colour comes from `--tab`, not a literal, so dark mode can
            // lift it (see `.tab-tint` in CHROME_CSS) — at 10–14px on the dark
            // bar the raw colours are unreadable. Same rule as the bottom bar,
            // so "colour = which module" holds at every width.
            style={{ '--tab': item.color, ...(isActive ? { backgroundColor: item.color + '1a' } : {}) }}
          >
            {item.tab === 'chat' ? <ChatIconWithDot item={item} /> : <TabIcon item={item} />}
            {item.label}
          </a>
        )
      })}
    </nav>
  )
}

// ─── Header ──────────────────────────────────────────────────────
// The one Home header. `badge` names the module you're inside (WAY /
// Laoka / Chat); Sompitra pages show nothing because Sompitra IS home.
export const HomeHeader: FC<{
  displayName?: string | null
  badge?: Badge
  active?: string
}> = ({ displayName, badge, active }) => (
  <header
    id="home-header"
    class="sticky top-0 z-50 flex-shrink-0 relative border-b"
    style={{ backgroundColor: 'var(--sheet)', borderColor: 'var(--rule)' }}
  >
    <div class={`${SHELL_WIDTH} mx-auto w-full px-3 sm:px-4 flex items-center justify-between gap-3 h-12 sm:h-14`}>
      <a href="/" class="flex items-center gap-2 shrink-0" aria-label="Home">
        <img src="/icon-128.png" alt="" width={26} height={26}
          class="w-[26px] h-[26px] rounded-lg ring-1 ring-black/5 dark:ring-white/10" />
        <span class="text-[20px] font-extrabold tracking-[-0.035em] text-green-600 dark:text-green-400">Home</span>
      </a>

      {/* Desktop nav (md+): the same six tabs as the bottom bar, which is
          hidden from md up — a phone bar pinned to the bottom of a 1280px
          window is the single biggest "this is a phone page" tell. */}
      <HomeNav active={active} />

      <div class="flex items-center gap-2 sm:gap-3 shrink-0">
        {badge && (
          <span class="hidden md:flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: 'var(--ink-2)' }}>
            {/* The module's own mark, tinted by the module's own colour — the
                label stays ink-2 so a 13px word is never painted in a colour
                that only clears 3:1 on a sheet. */}
            {badge.img
              ? <img src={badge.img} alt="" width={20} height={20} class="w-5 h-5" />
              : <span class="accent-mark flex"><TabSvg name={badge.svg ?? ''} /></span>}
            {badge.label}
          </span>
        )}
        {displayName && (
          <span class="flex items-center gap-1.5 text-xs sm:text-[13px]" style={{ color: 'var(--ink-2)' }}>
            <span class={`w-2 h-2 rounded-full ${userAccentColor(displayName)}`} />
            <strong class="font-semibold">{displayName}</strong>
          </span>
        )}
        {/* The theme switch wears the glyph of the theme you would GET, so its
            meaning is legible before you press it (it used to be 🌙 in both
            themes: in dark mode it labelled the state, not the action). Both
            glyphs are brand SVGs now, so it matches the headings' icon set. */}
        <button
          onclick="document.documentElement.classList.toggle('dark'); localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light')"
          class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          style={{ color: 'var(--ink-2)' }}
          title="Toggle dark mode"
          aria-label="Toggle dark mode"
        >
          <span class="block dark:hidden"><Icon name="moon" className="w-[18px] h-[18px]" /></span>
          <span class="hidden dark:block"><Icon name="sun" className="w-[18px] h-[18px]" /></span>
        </button>
      </div>
    </div>
    {/* The accent hairline: the chrome takes the colour of the module you are
        in, the same colour the bottom bar gives that tab (and the same value
        `<meta name="theme-color">` already advertises to Android). It is the
        one brand cue that is present at every width, including phones, where
        the header has no room for the module's name badge. */}
    <span class="absolute inset-x-0 -bottom-px h-[2px]" style={{ backgroundColor: tabColorFor(active) }} />
  </header>
)

// ─── The one tab bar (below md) ──────────────────────────────────
/** `active` is either a Sompitra activeTab ('budget' | 'kine' | …) or a
    module kind ('way' | 'laoka' | 'chat'). The four Sompitra sections all
    light up the single Sompitra tab.

    Hidden from md up, where `HomeNav` takes over, but still rendered: the
    markup is the app's single source of navigation truth (and `npm run
    smoke` asserts every tab links from it on every page). */
export const HomeTabBar: FC<{ active?: string; className?: string }> = ({ active, className = '' }) => {
  const activeSompitra = SOMPITRA_SECTIONS.includes(active as string)
  return (
    <nav
      id="home-tabbar"
      class={`md:hidden sticky bottom-0 z-50 border-t pb-safe flex-shrink-0 ${className}`}
      style={{ backgroundColor: 'var(--sheet)', borderColor: 'var(--rule)' }}
    >
      <div class={`${SHELL_WIDTH} mx-auto grid grid-cols-6`}>
        {HOME_TABS.map(item => {
          const isActive = active === item.tab || (item.tab === 'money' && activeSompitra)
          return (
            <a
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              class={`relative flex flex-col items-center pt-2 pb-1 text-[10px] leading-tight transition-colors ${
                isActive ? 'font-semibold' : 'font-medium active:bg-gray-100 dark:active:bg-gray-700/60'
              }`}
            >
              {/* the selected marker: a bar the width of the icon, ON the
                  top border — the cue that survives any colour choice */}
              <span
                class="absolute top-0 h-[3px] rounded-b-full transition-all"
                style={{ width: isActive ? 26 : 0, backgroundColor: item.color }}
              />
              <span
                class={`tab-tint rounded-xl px-3 py-1 transition-colors ${isActive ? 'is-active' : ''}`}
                style={{ '--tab': item.color, backgroundColor: isActive ? item.color + '1a' : 'transparent' }}
              >
                {item.tab === 'chat' ? <ChatIconWithDot item={item} /> : <TabIcon item={item} />}
              </span>
              {/* The label keeps the tab's colour even when inactive: the six
                  modules are meant to be readable by colour alone (design note
                  above). Selection is the bar + the pill + bold, never "the
                  only coloured tab", so an inactive label is dimmed, not
                  greyed — and in dark mode it is LIFTED, not dimmed into the
                  bar (slate measures 1.9:1 there). */}
              <span
                class={`tab-tint mt-0.5 ${isActive ? 'is-active' : ''}`}
                style={{ '--tab': item.color }}
              >{item.label}</span>
            </a>
          )
        })}
      </div>
    </nav>
  )
}

// ─── Shared chrome CSS ───────────────────────────────────────────
// Injected by both hosts. Keeping it here is what makes `.pb-safe` (iPhone
// home-bar inset) and the dark-mode bootstrap identical on every tab —
// the module shells previously shipped without `.pb-safe`, so the tab bar
// sat under the home bar on iOS.
export const CHROME_CSS = `
  /* ── The surface system ────────────────────────────────────────────
     Five named values decide every screen's colour, and they are the values
     the app already wore (Tailwind gray-900/gray-800 in dark, white sheets on
     a near-white table in light) — pinned down so a screen can ask for
     "paper", "sheet" or "a rule" instead of picking a grey off the shelf.

     Why: before this, every box on every page was the same white rounded-2xl
     with the same soft shadow and the same border-gray-100, so a ledger row,
     a stat tile and a page section all carried identical weight — and a
     caption in gray-400 (2.5:1 on white) was how "10px" became unreadable.

       --paper  the table the app is laid out on
       --sheet  a surface that sits on it (cards, rows, panels)
       --rule   the hairline between two pieces of information
       --ink    body text and every figure
       --ink-2  labels and titles        (>= 7:1 on the sheet)
       --ink-3  captions and hints       (>= 4.8:1 on the sheet, never gray-400)

     Radii are a scale too: rows are barely rounded, cards are softer, and
     only the one panel that leads a page gets the big radius. */
  :root {
    --paper:  #f7f8fa;
    --sheet:  #ffffff;
    --rule:   #e7e9ee;
    --ink:    #111827;
    --ink-2:  #4b5563;
    --ink-3:  #6b7280;
    --r-row:  10px;
    --r-card: 16px;
    --r-panel: 22px;
    color-scheme: light;
  }
  /* The dark palette, ONE signal: the html.dark class — never the OS.

     This was written the other way round first (a prefers-color-scheme copy
     alongside the class), on the premise that the Tailwind CDN ignores
     darkMode: 'class'. Probed in the browser, that premise is false HERE: an
     element carrying only the utility dark:bg-gray-700 computes transparent with no
     .dark ancestor and rgb(55,65,81) with one (the rule emitted is
     .dark\:bg-gray-700:is(.dark *)). So every dark: utility in every page
     follows the CLASS, and a second token copy following the OS is what split
     the app in half: with an explicit "light" choice stored on a dark-OS
     phone, the tokens went dark while the utilities stayed light — a
     bg-gray-100 box whose text colour is inherited --ink rendered
     light-on-light, i.e. invisible (found on /settings, both action links to
     Account). One signal is not a simplification here, it is the fix.

     html.dark already means "the effective theme is dark": the bootstrap in
     the head of every document that includes this stylesheet
     (views/layout.tsx, views/shell.tsx, routes/auth.tsx) sets it from the
     switch's stored choice, or from the OS when nothing is stored. So an
     explicit choice now contradicts nothing — the whole app moves with it.

     NOTE: no backticks in this file — it is one template literal. */
  html.dark {${DARK_TOKENS}  }

  /* ── The brand typeface ────────────────────────────────────────────
     One family for the whole super app (see BRAND_FONT_STACK). The system
     stack behind it means a cold cache or an offline PWA still renders in a
     real font instead of a serif default.

     The background and the text colour live HERE, not as Tailwind utilities on
     <body>: a class on the element would outrank this rule, and the sign-in
     page — which renders its own shell and includes this stylesheet — has to
     land on the same table as the app behind it. */
  body {
    font-family: ${BRAND_FONT_STACK};
    -webkit-tap-highlight-color: transparent;
    background: var(--paper);
    color: var(--ink);
  }

  /* ── Surfaces ──────────────────────────────────────────────────────
     .card is the one panel every page is built from; .card-lg is the panel
     that LEADS a page (the home anchor), so "the most important thing on this
     screen" is expressible in markup instead of in a one-off class list. */
  .card {
    background: var(--sheet);
    border: 1px solid var(--rule);
    border-radius: var(--r-card);
  }
  .card-lg { border-radius: var(--r-panel); }
  /* A hairline BETWEEN two pieces of information, not a box around one. */
  .hairline { border-top: 1px solid var(--rule); }
  /* A list of figures: every row but the first is separated by that hairline,
     so the rows read as one ruled column instead of N boxes. */
  .ledger > * + * { border-top: 1px solid var(--rule); }

  /* ── The type scale ────────────────────────────────────────────────
     Three jobs, three treatments, and money is the loudest of them:

       .t-anchor  the one figure a screen leads with (cash on hand)
       .t-value   any figure inside a row
       .t-label   what a figure or a card is about
       .t-micro   a caption or a hint

     Titles and labels are SENTENCE CASE on purpose. They used to be
     0.7rem/700/.08em/uppercase micro-type — the single loudest "generated
     dashboard" tell in the app, and the reason every card read as a form
     field rather than as a sentence about the household. */
  .t-anchor { font-size: clamp(1.75rem, 7vw, 2.35rem); line-height: 1.02; font-weight: 800; letter-spacing: -.035em; font-variant-numeric: tabular-nums; }
  .t-value  { font-size: 1rem; line-height: 1.25; font-weight: 750; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .t-label  { font-size: .8rem; line-height: 1.25; font-weight: 650; letter-spacing: -.008em; color: var(--ink-2); }
  .t-micro  { font-size: .72rem; line-height: 1.3; color: var(--ink-3); }

  /* ── One deliberate arrival ───────────────────────────────────────
     The anchor panel rises once, and the figure's proportion rule draws
     itself in — the only non-user-triggered motion in the app now. It used
     to be a 4px fade-and-slide-up on EVERY page load (and on every card on
     it), which is the generic default and says nothing about what changed. */
  .rise { animation: homeRise .5s cubic-bezier(.2,.7,.2,1) both; }
  @keyframes homeRise { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
  .draw { transform-origin: left center; animation: homeDraw .8s cubic-bezier(.2,.7,.2,1) .12s both; }
  @keyframes homeDraw { from { transform: scaleX(0) } to { transform: scaleX(1) } }

  /* ── Keyboard focus is visible, on every control, without touching
     fifty call sites. Inputs across the app carry Tailwind's
     focus:outline-none (which paints a TRANSPARENT outline and outranks
     this selector), so the ring rides on box-shadow instead — that
     property is free on the elements it matters for.

     NO BACKTICKS ANYWHERE IN THIS STYLESHEET: it is a template literal, so
     one stray backtick ends the string early and the build fails somewhere
     further down the file. */
  :focus-visible {
    box-shadow: 0 0 0 2px var(--sheet), 0 0 0 4px rgba(22,163,74,.55);
  }

  @media (prefers-reduced-motion: reduce) {
    .rise, .draw { animation: none !important; }
    .fade-in { animation: none !important; }
  }

  /* Money must line up in a column: proportional digits make "Ar 7,500" and
     "Ar 12,300" different widths, which is exactly what makes a column of
     amounts look hand-scattered. .num is applied to every money figure. */
  .num { font-variant-numeric: tabular-nums; font-feature-settings: 'tnum' 1; }

  /* ── The screen accent ─────────────────────────────────────────────
     --accent is set on <body> by the layout and by the module shell, from the
     SAME table the tab bar reads (HOME_TABS), so a page's headings can never
     disagree with the tab you tapped to get there. It colours the
     section-heading glyphs (.accent-mark) and nothing else: the labels stay
     grey, because a heading is read for its text, and tinting 10-12px text is
     how headings become unreadable in dark mode.

     Dark mode LIFTS the accent (color-mix toward white) for the same reason
     the tab tints are lifted: a solid brand colour at icon size on #1f2937
     falls under the 3:1 non-text contrast floor.

     NOTE: never put a backtick in this stylesheet. CHROME_CSS is a template
     literal, so one stray backtick ends the string early and the build fails
     with a syntax error somewhere further down the file. */
  .accent-mark { color: var(--accent, #16a34a); }
  html.dark .accent-mark { color: color-mix(in srgb, var(--accent, #16a34a) 80%, #ffffff); }

  /* Card titles. The class name is load-bearing (smoke reads it, and every
     card in the app wears it), but the treatment is the type scale's .t-label:
     sentence case, readable at 13px, no tracking games. */
  .section-title { font-size: .8rem; line-height: 1.25; font-weight: 700; letter-spacing: -.008em; color: var(--ink-2); }

  /* Page arrival: opacity only, and fast. The 4px slide this used to carry
     ran on every page and every card at once. */
  .fade-in { animation: fadeIn .18s ease-out; }
  @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }

  /* Hide scrollbar for top nav */
  .hide-scroll::-webkit-scrollbar { display: none; }
  .hide-scroll { -ms-overflow-style: none; scrollbar-width: none; }

  /* ── The tab tint: every module wears its OWN colour on its tab, active
     or not (the six modules are meant to be recognisable by colour alone).
     Selection is carried by the top bar + the pill + bold weight — shape and
     weight, never "it is the only coloured one" — so an inactive tab is
     dimmed, never greyed.

     The colour arrives as the --tab custom property rather than a literal
     color: because dark mode has to LIFT it: the raw tints measure 1.9:1
     (slate You) and 2.6:1 (violet Chat) on the #1f2937 bar, which is
     unreadable at tab-label size. color-mix() is the lift; a browser without
     it keeps the plain tint (progressive enhancement, never a missing rule).

     Note the dimming is dark-mode only. On white, these brand colours are
     already as dark as they get (2.9-4.1:1); dimming them further would be
     the very "inactive tabs fade out" look this rule exists to prevent. */
  .tab-tint { color: var(--tab); }
  html.dark .tab-tint { color: color-mix(in srgb, var(--tab) 58%, #ffffff); opacity: .92; }
  html.dark .tab-tint.is-active { opacity: 1; }
  .tab-tint:hover { opacity: 1; }

  /* ── The chat unread dot ───────
     Shown by CHAT_UNREAD_SCRIPT, which toggles the class .on on every
     [data-chat-unread] element on the page -- so the same dot exists in both
     bars and neither is the "real" one. The white ring is what keeps it
     legible where it overlaps the icon; dark mode swaps the ring for the bar
     colour rather than dropping it. */
  .chat-dot-wrap { position: relative; display: inline-flex; }
  .chat-unread-dot { position: absolute; top: -2px; right: -3px; width: 9px; height: 9px; border-radius: 9999px; background: #ef4444; box-shadow: 0 0 0 2px #ffffff; display: none; }
  html.dark .chat-unread-dot { box-shadow: 0 0 0 2px #1f2937; }
  .chat-unread-dot.on { display: block; }

  /* ── The Home page's unread card ───────
     Same watermark as the dot above, told at the size the home screen has room
     for: a dot where there is room for a dot, and what actually arrived where
     there is room for the lines. Hidden until there IS something to say -- an
     empty card under the month's own figure would be furniture, and it would
     push the three rooms down for nothing. Revealed by CHAT_UNREAD_SCRIPT, so
     these two states are the whole of its contract.

     One row per unread message, newest first: the sender at the label weight,
     the message behind it clipped to a SINGLE line so six messages cost six
     lines and not six paragraphs. The flex is what does the clipping -- a
     truncating child needs a shrinkable parent -- and flex: none on the
     sender is what stops the name itself being the thing that gets cut. The
     overflow row is a caption: it only says what the count above it already
     means, that not every line fits. */
  /* min-width: 0 because this card is a GRID ITEM, and a grid item's automatic
     minimum is its min-content width -- which for a row of nowrap text is the
     whole sentence. Without it the card did not clip: it widened its own track,
     and on a 390px phone the home page measured 498px wide with everything in
     the figure beside it pushed off the screen. The rows clip inside the card
     instead, which is what they are for. */
  .unread-card { display: none; min-width: 0; }
  .unread-card.on { display: flex; }
  .unread-rows:not(:empty) { margin-top: .3rem; display: block; }
  .unread-row { display: flex; align-items: baseline; gap: .3rem; font-size: .74rem; line-height: 1.45; min-width: 0; }
  .unread-row-who { flex: none; font-weight: 650; color: var(--ink-2); }
  .unread-row-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
  .unread-row-more { color: var(--ink-3); }
  /* ── The rooms row, and the card that can take its place ──────────
     The home page's first row is the month's figure and the three rooms side
     by side. When there IS something unread the card takes the slot beside the
     figure and the rooms become a row of three across the page; with nothing
     unread the card is gone from the grid entirely -- display: none removes it
     from auto-placement, not just from view -- and the rooms slide back into
     that slot, which is the layout this page had before the card existed.

     One sibling selector decides both, rather than two class lists that have to
     be kept in agreement: the rooms cannot end up full-width with no card above
     them, or narrow with one. */
  .rooms-grid { display: grid; gap: .5rem; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  @media (min-width: 1024px) {
    .rooms-grid { grid-template-columns: minmax(0, 1fr); }
    .unread-card.on ~ .rooms-card { grid-column: span 3; }
    .unread-card.on ~ .rooms-card .rooms-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }

  /* iPhone safe-area */
  .pb-safe { padding-bottom: env(safe-area-inset-bottom, 0px); }

  /* Category picker: make <optgroup> headers visually distinct */
  optgroup { background-color: #fed7aa; color: #7c2d12; font-weight: 700; font-style: normal; }
  html.dark optgroup { background-color: #7c2d12; color: #fdba74; }

  /* Install prompt card (You tab): the button is hidden until the browser
     says the app is installable, so it can never promise something the
     platform will refuse. */
  #install-app-card { display: none; }
  #install-app-card.available { display: block; }
`

// ─── The chat unread state: the nav dot, and Home's unread card ───
// ONE watermark in localStorage (the newest createdAt this device has laid
// eyes on) plus a poll of the DO's readout. It lives here so every document the
// app serves -- the Sompitra pages and the module shells -- runs the same code,
// and unread cannot mean two different things on two tabs. It drives TWO
// surfaces from that one fact, and deliberately not two facts: the dot in the
// tab bars ("something happened") and the card under the month's figure on Home
// ("this is what happened"). The card is not a second counter to keep in sync:
// its count and its lines come from one answer, so they cannot disagree.
//
// Why a poll rather than the socket the chat already has: the chat document
// only exists while you are IN the chat tab, which is precisely when the dot
// is not needed. The nav sits outside it, and the Sompitra pages have no
// socket at all.
//
// Worth keeping, the details that make it correct:
//   * On the chat tab everything counts as seen: the dot is never shown there,
//     and the watermark is advanced by the same poll.
//   * The FIRST poll on a device adopts whatever is already in the room as
//     seen -- otherwise a fresh install badges last night's backlog with no
//     way to clear it short of opening the chat.
//   * Both comparisons are plain string compares (createdAt is an ISO instant,
//     so it sorts). Keep that column ISO or this stops working silently.
//   * A failed fetch paints nothing: an unread dot that appears because the
//     network blipped is worse than no dot. The card is left exactly as it was
//     for the same reason.
//   * The card is not a second counter to keep in sync: the count and the lines
//     underneath it are the SAME answer from the same poll, so they cannot
//     disagree — and when the server bounded the list, the last row says how
//     many it left out instead of the count and the lines quietly differing.
//   * This is per DEVICE, not per person -- reading the room on a phone does
//     not clear a desktop. That is the dot's behaviour inherited, not a new
//     choice; making it per-account needs server-side read state, which is a
//     bigger change than a card (see AGENTS.md).
export const CHAT_UNREAD_SCRIPT = `
(function () {
  var KEY = 'chat_last_seen';
  var POLL_MS = 25000;
  var onChat = location.pathname === '/chat' || location.pathname.indexOf('/chat/') === 0;
  function paint(on) {
    var dots = document.querySelectorAll('[data-chat-unread]');
    for (var i = 0; i < dots.length; i++) dots[i].classList.toggle('on', !!on);
  }
  // The home screen's unread card: the SAME watermark, told at the size the home
  // screen has room for. Every page in the app runs this script and only one has
  // a card on it, so the lookup is the first thing it does. One row per line the
  // server sent, built as ELEMENTS and filled with textContent: the room carries
  // whatever anyone typed and a module's system notification carries a
  // transaction note, so this is the last place in the app where a string could
  // be handed to innerHTML.
  function paintCardRow(m, mine) {
    var row = document.createElement('span');
    row.className = 'unread-row';
    // A message with no sender is a module's SYSTEM row -- Sompitra's expenses
    // and WAY's arrivals post as these -- and the chat draws those with no name
    // at all, so the card does too instead of inventing one. Otherwise the
    // sender is named, with the chat's own rule for "is this mine": compare
    // names case-insensitively, exactly as sameName() does in the room.
    var sender = m && m.sender ? String(m.sender) : '';
    if (sender) {
      var who = document.createElement('span');
      who.className = 'unread-row-who';
      who.textContent = (sender.toLowerCase() === mine ? 'You' : sender) + ' ·';
      row.appendChild(who);
    }
    var text = document.createElement('span');
    text.className = 'unread-row-text';
    text.textContent = (m && m.message) || '';
    row.appendChild(text);
    return row;
  }
  function paintCard(data) {
    var card = document.querySelector('[data-chat-unread-card]');
    if (!card) return;
    var rows = card.querySelector('[data-unread-rows]');
    var count = card.querySelector('[data-unread-count]');
    var lines = (data && data.messages) || [];
    var n = (data && data.count > 0) ? data.count : 0;
    // Nothing unread, or nothing the server was willing to name: the card goes
    // away rather than sitting empty under the month's figure.
    if (!n || !lines.length || !rows) { card.classList.remove('on'); return; }
    if (count) count.textContent = n === 1 ? '1 new message' : n + ' new messages';
    var mine = (card.getAttribute('data-mine') || '').toLowerCase();
    // Repainted from scratch on every poll, so a message that arrives while the
    // page is open replaces the list rather than appending to it twice.
    while (rows.firstChild) rows.removeChild(rows.firstChild);
    for (var i = 0; i < lines.length; i++) rows.appendChild(paintCardRow(lines[i], mine));
    // The server bounds the list (CHAT_UNREAD_LINES), so more may have arrived
    // than there are lines for. Say so rather than let the count above disagree
    // with what is printed below it: the omitted ones are the OLDER ones -- the
    // server sends the newest -- so they are the earlier messages in the room.
    var rest = n - lines.length;
    if (rest > 0) {
      var more = document.createElement('span');
      more.className = 'unread-row unread-row-more';
      more.textContent = '+' + rest + ' earlier in the room';
      rows.appendChild(more);
    }
    card.classList.add('on');
  }
  function poll() {
    if (document.visibilityState === 'hidden') return;
    var seen = localStorage.getItem(KEY);
    // The watermark rides along as the count's lower bound: the server answers
    // "how many arrived since then" instead of the browser having to know which
    // of today's messages it has already been shown.
    var url = '/way/api/chat/latest' + (seen ? '?since=' + encodeURIComponent(seen) : '');
    fetch(url, { credentials: 'include' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.at) return;
        if (!seen) { localStorage.setItem(KEY, data.at); paint(false); paintCard(null); return; }
        if (onChat) {
          if (data.at > seen) localStorage.setItem(KEY, data.at);
          paint(false);
          paintCard(null);
          return;
        }
        paint(data.at > seen);
        paintCard(data);
      })
      .catch(function () {});
  }
  poll();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') poll();
  });
})();
`

export const TAILWIND_CONFIG = `
  tailwind.config = {
    darkMode: 'class',
    theme: {
      extend: {
        colors: {
          brand: { DEFAULT: '#16a34a', dark: '#15803d' },
          surface: { DEFAULT: '#ffffff', dark: '#1e1e2e' },
        }
      }
    }
  }
`
