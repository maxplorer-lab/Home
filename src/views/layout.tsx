/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import { PressFeedbackStyle, PressFeedbackScript } from './feedback'
// One money formatter for the whole app: a client's balance and the amount they
// paid are francs, and they read as francs ("Ar 45,000"), not as a bare number
// with "MGA" stuck on the end.
import { mga } from '../lib/utils'
// The one app chrome (header + tab bar) — shared with the module shells.
import { CHROME_CSS, TAILWIND_CONFIG, CHAT_UNREAD_SCRIPT, HomeHeader, HomeTabBar, SOMPITRA_SECTIONS, SHELL_WIDTH, BrandFontLinks, Icon, tabColorFor, tabInkFor } from './app-chrome'

interface LayoutProps {
  title?: string
  user?: { display_name: string } | null
  activeTab?: 'dashboard' | 'budget' | 'kine' | 'debts' | 'sales' | 'chat' | 'settings'
  /** Full-bleed pages (Chat) fill the exact space between header and tab
      bar instead of scrolling a centered column. */
  fullBleed?: boolean
  children?: any
}

export const Layout: FC<LayoutProps> = ({ title = 'Home', user, activeTab, fullBleed, children }) => {
  const moneyTabs = SOMPITRA_SECTIONS
  // Sompitra is its own tab now (Home is the dashboard), so its pages name the
  // module in the header exactly as WAY, Laoka and Chat already do.
  const badge = moneyTabs.includes(activeTab as string)
    ? { svg: 'money', label: 'Sompitra' }
    : undefined

  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="UTF-8" />
        {/* No maximum-scale / user-scalable=no: pinch-zoom is an accessibility
            feature, and blocking it is also what Lighthouse flags on Android.
            The layout is responsive, so zooming cannot break it. */}
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
        {/* Tinted per tab, so the browser chrome (and an installed app's status
            bar) matches the module you are actually in. */}
        <meta name="theme-color" content={tabColorFor(activeTab)} />
        <title>{title} – Home</title>
        {/* PWA */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/favicon-32.png" type="image/png" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Home" />
        {/* The one brand typeface — same family the module tabs load. */}
        <BrandFontLinks />
        {/* Every number box in the app is typed, never nudged — no spinner
            buttons, and a wheel over a focused box scrolls the page instead of
            stepping the value. One file, loaded by every document Home serves. */}
        <script src="/shared/number-entry.js" />
        {/* Tailwind CDN – replaced by build step in production */}
        <script src="https://cdn.tailwindcss.com" />
        <script dangerouslySetInnerHTML={{ __html: `
          ${TAILWIND_CONFIG}
          // Persist dark-mode preference
          if (localStorage.getItem('theme') === 'dark' ||
              (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            document.documentElement.classList.add('dark')
          }
        `}} />
        {/* Shared chrome CSS — see app-chrome.tsx */}
        <style dangerouslySetInnerHTML={{ __html: CHROME_CSS }} />
        {/* Tap feedback + pending state — shared with the auth pages */}
        <PressFeedbackStyle />
      </head>
      {/* min-h-full + flex-col: short pages still push the tab bar to the
          bottom; full-bleed children stretch between header and tab bar. */}
      {/* `--accent` / `--accent-ink` are the module's own colours, read from the
          same table as the tab bar (app-chrome.tsx). Everything on the page that
          wants to look "Sompitra" (heading glyphs, the section sub-nav) asks
          these two variables instead of hard-coding a hue, so the module you are
          in always agrees with the tab you tapped. */}
      <body
        style={{ '--accent': tabColorFor(activeTab), '--accent-ink': tabInkFor(activeTab) }}
        class="min-h-full flex flex-col transition-colors"
      >

        {/* ── App Header — THE one chrome (app-chrome.tsx) ── */}
        <HomeHeader displayName={user?.display_name ?? null} active={activeTab} badge={badge} />

        {/* ── Sub-nav: Money section pages ──
            Visible at EVERY width. It used to be `hidden sm:block`, which left
            Kiné, Debts and Sales with no route at all from the Sompitra tab on
            a phone — the sections live only here, and the phone is the shape
            most of this app is used in. Four short labels fit a 360px screen;
            the strip scrolls sideways if one cannot (`shrink-0` on the items,
            so a label is never squashed or clipped instead). */}
        {user && moneyTabs.includes(activeTab as string) && (
          <nav
            class="sticky top-12 sm:top-14 z-40 border-b"
            style={{ backgroundColor: 'var(--sheet)', borderColor: 'var(--rule)' }}
          >
            <div class={`${SHELL_WIDTH} mx-auto px-2 flex gap-1 py-1.5 overflow-x-auto`}>
              {[
                { href: '/budget', label: 'Budget', tab: 'budget' },
                { href: '/kine',   label: 'Kiné',   tab: 'kine'   },
                { href: '/debts',  label: 'Debts',  tab: 'debts'  },
                { href: '/sales',  label: 'Sales',  tab: 'sales'  },
              ].map(item => (
                <a
                  href={item.href}
                  style={activeTab === item.tab
                    ? { backgroundColor: 'var(--accent-ink)' }
                    : { color: 'var(--ink-2)' }}
                  class={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg text-[13px] transition-colors ${activeTab === item.tab ? 'text-white font-semibold shadow-sm' : 'font-medium hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                >
                  {item.label}
                </a>
              ))}
            </div>
          </nav>
        )}

        {/* ── Main Content ── */}
        <main class={fullBleed
          ? 'flex-1 min-h-0 flex flex-col px-3 pt-3 pb-2 sm:px-4 sm:pt-4 sm:pb-3'
          : `${SHELL_WIDTH} mx-auto w-full px-3 sm:px-4 lg:px-6 py-4 sm:py-6 fade-in flex-1`}>
          {children}
        </main>

        {/* ── Bottom Tab Bar — THE navigation of the super app ──
            sticky (not fixed) so it stays part of the flex column: full-bleed
            pages end exactly above it, scrolling pages keep it pinned. */}
        {user && <HomeTabBar active={activeTab} />}

        {/* Tap feedback + double-submit guard (see views/feedback.tsx).
            Navigation and submission still work exactly as before; this only
            proves the tap registered and stops the same action firing twice
            while the Worker is busy — a double submit would create a duplicate
            transaction/record. */}
        <PressFeedbackScript />

        {/* The Chat tab's unread dot — same script the module shells run, so the
            dot means one thing everywhere (see CHAT_UNREAD_SCRIPT). */}
        <script dangerouslySetInnerHTML={{ __html: CHAT_UNREAD_SCRIPT }} />

        {/* Register service worker for PWA offline support */}
        <script dangerouslySetInnerHTML={{ __html: `
          if ('serviceWorker' in navigator) {
            window.addEventListener('load', function() {
              navigator.serviceWorker.register('/sw.js').catch(function() {});
            });
          }
        `}} />
      </body>
    </html>
  )
}

// ─── Reusable UI Components ───────────────────────────────────

// `icon` names a glyph from app-chrome's ICONS, drawn in the screen's accent
// colour. It replaces the emoji that used to be glued onto the title text: an
// emoji is a fixed colour picture, so "🔔 Today's Activity" looked identical on
// the green Home tab and the teal Sompitra tab, and it changed shape and weight
// on every OS. The label itself stays ink-2 on purpose — tinting 12px text is
// how a heading becomes unreadable in dark mode (the tab tints needed a
// color-mix lift for exactly this reason).
//
// The panel is `.card` — one token surface (see CHROME_CSS), instead of every
// card carrying its own white/gray-800/rounded-2xl/shadow-sm class list.
export const Card: FC<{ title?: string; icon?: string; className?: string; children?: any }> = ({ title, icon, className = '', children }) => (
  <div class={`card p-4 sm:p-5 ${className}`}>
    {title && (
      <h3 class="flex items-center gap-2 mb-3.5 section-title">
        {icon && <span class="accent-mark flex shrink-0"><Icon name={icon} className="w-[15px] h-[15px]" /></span>}
        {title}
      </h3>
    )}
    {children}
  </div>
)

export const StatCard: FC<{ label: string; value: string; sub?: string; color?: string; children?: any }> = ({ label, value, sub, color = '' }) => (
  <div class="card p-3 sm:p-5 flex flex-col justify-center">
    <p class="t-label">{label}</p>
    <p class={`t-value text-lg sm:text-2xl mt-0.5 sm:mt-1 truncate ${color}`}>{value}</p>
    {sub && <p class="t-micro mt-1 truncate">{sub}</p>}
  </div>
)

export const Badge: FC<{ text: string; color?: string; children?: any }> = ({ text, color = 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300' }) => (
  <span class={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>{text}</span>
)

// A comparison bar for a ledger row (and the home anchor): label left, figure
// right, a hairline between rows. This used to be six equal pastel TILES on the
// dashboard — six boxes of identical size and saturation, so the one figure the
// household actually reads (cash on hand) carried exactly as much weight as the
// smallest fact on the screen. A row says the same thing and ranks it.
//
// `tone` is the FIGURE's colour, and it means what the money palette says it
// means: green = money in, red = money out, teal = a period's net result,
// orange = we owe, purple = owed to us.
//
// A LEDGER ROW is for facts the reader compares DOWN a list (the balances, one
// amount per account). When the facts are meant to be compared ACROSS, and live
// on one subject, they are `.tile`s instead — see `KineClientStats` below and
// the note on `.tile` in CHROME_CSS.
export const TintStat: FC<{ label: string; value: string; tone: string; sub?: string }> = ({ label, value, tone, sub }) => (
  <div class="flex items-baseline justify-between gap-3 py-2.5">
    <span class="min-w-0">
      <span class="t-label block">{label}</span>
      {sub && <span class="t-micro block">{sub}</span>}
    </span>
    <span class={`t-value shrink-0 ${tone}`}>{value}</span>
  </div>
)

export const KineClientStats: FC<{ delivered: number; paid: number; rate: number }> = ({ delivered, paid, rate }) => {
  const balance = rate > 0 ? Math.round(paid / rate) - delivered : 0
  let dueCls = 'text-green-600 dark:text-green-400'
  let dueState = 'balanced'
  let dueVal = '0'
  if (balance > 0) {
    dueCls = 'text-yellow-700 dark:text-yellow-400'
    dueState = 'prepaid · ' + mga(balance * rate)
    dueVal = '+' + balance
  } else if (balance < 0) {
    dueCls = 'text-red-600 dark:text-red-400'
    dueState = 'owes · ' + mga(Math.abs(balance) * rate)
    dueVal = '-' + Math.abs(balance)
  }
  // Three facts about ONE client, as three tiles side by side: sessions in,
  // money in, and where that leaves them. They are read against each other
  // ("nine sessions, four paid for"), so they belong across a line and not
  // down one — a flat "9 sessions · Ar 180,000 paid · −5 owes" sentence makes
  // the reader do the comparison, and the three pastel boxes that came before
  // it made the payment figure exactly as loud as the balance.
  //
  // The tile's SURFACE says which fact it is, and the FIGURE says how it is
  // doing — see the note on `.tile` in CHROME_CSS, which is the one place that
  // colour language is written down:
  //
  //   blue   sessions    a count, not money
  //   green  paid        money that came in
  //   orange the balance money still to settle, in either direction
  //   …and inside the balance tile the figure is yellow (paid ahead: the
  //   sessions are owed by us), red (delivered and unpaid) or green (settled).
  return (
    <div class="grid grid-cols-3 gap-2">
      <div class="tile tile-tint text-blue-600 dark:text-blue-400">
        <p class="t-label">Sessions</p>
        <p class="t-value">{delivered}</p>
      </div>
      <div class="tile tile-tint text-green-600 dark:text-green-400">
        <p class="t-label">Paid</p>
        <p class="t-value truncate" title={mga(paid)}>{mga(paid)}</p>
      </div>
      <div class="tile tile-tint text-orange-600 dark:text-orange-400">
        <p class="t-label">Due</p>
        <p class={`t-value ${dueCls}`}>{dueVal}</p>
        <p class="t-micro leading-tight">{dueState}</p>
      </div>
    </div>
  )
}

export const Btn: FC<{ href?: string; type?: string; color?: string; className?: string; children?: any }> = ({
  href, type = 'button', color = 'bg-green-600 hover:bg-green-700 text-white', className = '', children
}) => {
  if (href) return <a href={href} class={`inline-block px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${color} ${className}`}>{children}</a>
  return <button type={type as any} class={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${color} ${className}`}>{children}</button>
}

