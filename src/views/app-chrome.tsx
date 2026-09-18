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
export const HOME_TABS = [
  { href: '/',         img: '/icon-64.png',      label: 'Home',     tab: 'dashboard' },
  { href: '/budget',   svg: 'money',             label: 'Sompitra', tab: 'money'     },
  { href: '/chat',     svg: 'chat',              label: 'Chat',     tab: 'chat'      },
  { href: '/laoka/',   img: '/laoka/icon.svg',   label: 'Laoka',    tab: 'laoka'     },
  { href: '/way/',     img: '/way/icon-512.png', label: 'WAY',      tab: 'way'       },
  { href: '/settings', svg: 'you',               label: 'You',      tab: 'settings'  },
] as const

/** Sompitra sections that all belong to the one Sompitra tab. */
export const SOMPITRA_SECTIONS = ['budget', 'kine', 'debts', 'sales']

const TAB_SVGS: Record<string, string> = {
  // wallet
  money: 'M2 6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6zm2.5-.5v2h12v-2h-12zm0 10.5h12v-2h-12v2z M17 10.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
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

/** Tab-bar icon: a real image, dimmed when inactive, or an inline SVG
    that inherits the tab's active/inactive text colour. */
export const TabIcon: FC<{ item: { img?: string; svg?: string }; active: boolean }> = ({ item, active }) => {
  if (item.img) {
    return <img src={item.img} alt="" class={`w-6 h-6 leading-none ${active ? '' : 'opacity-60 grayscale'}`} />
  }
  return <TabSvg name={item.svg ?? ''} className="w-6 h-6 leading-none" />
}

// ─── Header ──────────────────────────────────────────────────────
// The one Home header. `badge` names the module you're inside (WAY /
// Laoka / Chat); Sompitra pages show nothing because Sompitra IS home.
export const HomeHeader: FC<{
  displayName?: string | null
  badge?: Badge
}> = ({ displayName, badge }) => (
  <header id="home-header" class="sticky top-0 z-50 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-sm flex-shrink-0">
    <div class="max-w-5xl mx-auto w-full px-3 sm:px-4 flex items-center justify-between h-12">
      <a href="/" class="flex items-center gap-2">
        <img src="/icon-128.png" alt="Home" class="w-6 h-6 rounded-md" />
        <span class="text-lg font-extrabold tracking-tight text-green-600 dark:text-green-400">Home</span>
      </a>
      <div class="flex items-center gap-2 sm:gap-3">
        {badge && (
          <span class="flex items-center gap-1.5 text-sm font-semibold text-gray-600 dark:text-gray-300">
            {badge.img
              ? <img src={badge.img} alt="" class="w-5 h-5" />
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
          class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-lg"
          title="Toggle dark mode"
        >🌙</button>
      </div>
    </div>
  </header>
)

// ─── The one tab bar ─────────────────────────────────────────────
/** `active` is either a Sompitra activeTab ('budget' | 'kine' | …) or a
    module kind ('way' | 'laoka' | 'chat'). The four Sompitra sections all
    light up the single Sompitra tab. */
export const HomeTabBar: FC<{ active?: string; className?: string }> = ({ active, className = '' }) => {
  const activeSompitra = SOMPITRA_SECTIONS.includes(active as string)
  return (
    <nav id="home-tabbar" class={`sticky bottom-0 z-50 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 pb-safe shadow-[0_-2px_10px_rgba(0,0,0,0.05)] flex-shrink-0 ${className}`}>
      <div class="max-w-5xl mx-auto grid grid-cols-6">
        {HOME_TABS.map(item => {
          const isActive = active === item.tab || (item.tab === 'money' && activeSompitra)
          return (
            <a
              href={item.href}
              class={`flex flex-col items-center py-1.5 text-[10px] font-medium leading-tight transition-colors ${isActive ? 'text-green-600 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}`}
            >
              <TabIcon item={item} active={isActive} />
              <span class="mt-1">{item.label}</span>
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

  /* iPhone safe-area */
  .pb-safe { padding-bottom: env(safe-area-inset-bottom, 0px); }

  /* Category picker: make <optgroup> headers visually distinct */
  optgroup { background-color: #fed7aa; color: #7c2d12; font-weight: 700; font-style: normal; }
  html.dark optgroup { background-color: #7c2d12; color: #fdba74; }
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
