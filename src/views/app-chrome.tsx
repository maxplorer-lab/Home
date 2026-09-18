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
export const HOME_TABS = [
  { href: '/',         img: '/icon-64.png',      label: 'Home',     tab: 'dashboard', color: '#16a34a' },
  { href: '/budget',   svg: 'money',             label: 'Sompitra', tab: 'money',     color: '#0d9488' },
  { href: '/chat',     svg: 'chat',              label: 'Chat',     tab: 'chat',      color: '#7c3aed' },
  { href: '/laoka/',   img: '/laoka/icon.svg',   label: 'Laoka',    tab: 'laoka',     color: '#ea580c' },
  { href: '/way/',     img: '/way/icon-64.png',  label: 'WAY',      tab: 'way',       color: '#0284c7' },
  { href: '/settings', svg: 'you',               label: 'You',      tab: 'settings',  color: '#475569' },
] as const

/** Sompitra sections that all belong to the one Sompitra tab. */
export const SOMPITRA_SECTIONS = ['budget', 'kine', 'debts', 'sales']

/** The theme/tab colour for an active key — used for `<meta theme-color>`
    so the browser chrome (and an installed app's status bar) matches the
    module you are in. */
export function tabColorFor(active?: string): string {
  const hit = HOME_TABS.find(t => t.tab === active)
    // The four Sompitra sections are one tab.
    ?? (SOMPITRA_SECTIONS.includes(active as string) ? HOME_TABS[1] : undefined)
  return hit?.color ?? '#16a34a'
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

// ─── The desktop nav (md+) ───────────────────────────────────────
// Declared before the header that renders it: same tabs, horizontal.
export const HomeNav: FC<{ active?: string }> = ({ active }) => {
  const activeSompitra = SOMPITRA_SECTIONS.includes(active as string)
  return (
    <nav id="home-nav" class="hidden md:flex items-center gap-1 lg:gap-1.5">
      {HOME_TABS.map(item => {
        const isActive = active === item.tab || (item.tab === 'money' && activeSompitra)
        return (
          <a
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            class={`tab-tint flex items-center gap-1.5 px-2.5 lg:px-3 py-1.5 rounded-xl text-sm transition-all ${
              isActive ? 'is-active font-semibold' : 'font-medium hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
            // The colour comes from `--tab`, not a literal, so dark mode can
            // lift it (see `.tab-tint` in CHROME_CSS) — at 10–14px on the dark
            // bar the raw colours are unreadable. Same rule as the bottom bar,
            // so "colour = which module" holds at every width.
            style={{ '--tab': item.color, ...(isActive ? { backgroundColor: item.color + '1a' } : {}) }}
          >
            <TabIcon item={item} />
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
  <header id="home-header" class="sticky top-0 z-50 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-sm flex-shrink-0">
    <div class={`${SHELL_WIDTH} mx-auto w-full px-3 sm:px-4 flex items-center justify-between gap-3 h-12`}>
      <a href="/" class="flex items-center gap-2 shrink-0">
        <img src="/icon-128.png" alt="Home" width={24} height={24} class="w-6 h-6 rounded-md" />
        <span class="text-lg font-extrabold tracking-tight text-green-600 dark:text-green-400">Home</span>
      </a>

      {/* Desktop nav (md+): the same six tabs as the bottom bar, which is
          hidden from md up — a phone bar pinned to the bottom of a 1280px
          window is the single biggest "this is a phone page" tell. */}
      <HomeNav active={active} />

      <div class="flex items-center gap-2 sm:gap-3 shrink-0">
        {badge && (
          <span class="hidden md:flex items-center gap-1.5 text-sm font-semibold text-gray-600 dark:text-gray-300">
            {badge.img
              ? <img src={badge.img} alt="" width={20} height={20} class="w-5 h-5" />
              : <TabSvg name={badge.svg ?? ''} />}
            {badge.label}
          </span>
        )}
        {displayName && (
          <span class="flex items-center gap-1.5 text-xs sm:text-sm text-gray-500 dark:text-gray-400">
            <span class={`w-2 h-2 rounded-full ${userAccentColor(displayName)}`} />
            <strong>{displayName}</strong>
          </span>
        )}
        <button
          onclick="document.documentElement.classList.toggle('dark'); localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light')"
          class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-lg transition-colors"
          title="Toggle dark mode"
        >🌙</button>
      </div>
    </div>
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
    <nav id="home-tabbar" class={`md:hidden sticky bottom-0 z-50 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 pb-safe shadow-[0_-2px_10px_rgba(0,0,0,0.05)] flex-shrink-0 ${className}`}>
      <div class={`${SHELL_WIDTH} mx-auto grid grid-cols-6`}>
        {HOME_TABS.map(item => {
          const isActive = active === item.tab || (item.tab === 'money' && activeSompitra)
          return (
            <a
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              class={`relative flex flex-col items-center pt-2 pb-1.5 text-[10px] leading-tight transition-colors ${
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
                class={`tab-tint rounded-xl px-2.5 py-0.5 transition-colors ${isActive ? 'is-active' : ''}`}
                style={{ '--tab': item.color, backgroundColor: isActive ? item.color + '1a' : 'transparent' }}
              >
                <TabIcon item={item} />
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
  body { font-family: 'Segoe UI', system-ui, sans-serif; -webkit-tap-highlight-color: transparent; }
  .fade-in { animation: fadeIn .2s ease-in; }
  @keyframes fadeIn { from { opacity:0; transform:translateY(4px) } to { opacity:1; transform:none } }

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
