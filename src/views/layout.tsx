/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import { PressFeedbackStyle, PressFeedbackScript } from './feedback'
// The one app chrome (header + tab bar) — shared with the module shells.
import { CHROME_CSS, TAILWIND_CONFIG, HomeHeader, HomeTabBar, SOMPITRA_SECTIONS, SHELL_WIDTH, tabColorFor } from './app-chrome'

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
      <body class="min-h-full flex flex-col bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 transition-colors">

        {/* ── App Header — THE one chrome (app-chrome.tsx) ── */}
        <HomeHeader displayName={user?.display_name ?? null} active={activeTab} />

        {/* ── Sub-nav (desktop / tablet): Money section pages ── */}
        {user && moneyTabs.includes(activeTab as string) && (
          <nav class="hidden sm:block sticky top-12 z-40 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-sm">
            <div class={`${SHELL_WIDTH} mx-auto px-2 flex gap-1 py-1`}>
              {[
                { href: '/budget', label: 'Budget', tab: 'budget' },
                { href: '/kine',   label: 'Kiné',   tab: 'kine'   },
                { href: '/debts',  label: 'Debts',  tab: 'debts'  },
                { href: '/sales',  label: 'Sales',  tab: 'sales'  },
              ].map(item => (
                <a href={item.href} class={`whitespace-nowrap px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${activeTab === item.tab ? 'bg-green-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
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

export const Card: FC<{ title?: string; className?: string; noUppercase?: boolean; children?: any }> = ({ title, className = '', noUppercase, children }) => (
  <div class={`bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-4 sm:p-5 ${className}`}>
    {title && <h3 class={`text-xs sm:text-sm font-semibold text-gray-500 dark:text-gray-400 ${noUppercase ? '' : 'uppercase'} tracking-wide mb-3`}>{title}</h3>}
    {children}
  </div>
)

export const StatCard: FC<{ label: string; value: string; sub?: string; color?: string; children?: any }> = ({ label, value, sub, color = 'text-gray-900 dark:text-white' }) => (
  <div class="bg-white dark:bg-gray-800 rounded-xl sm:rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-3 sm:p-5 flex flex-col justify-center">
    <p class="text-[10px] sm:text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</p>
    <p class={`text-lg sm:text-2xl font-bold mt-0.5 sm:mt-1 truncate ${color}`}>{value}</p>
    {sub && <p class="text-[10px] sm:text-xs text-gray-400 mt-1 truncate">{sub}</p>}
  </div>
)

export const Badge: FC<{ text: string; color?: string; children?: any }> = ({ text, color = 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300' }) => (
  <span class={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>{text}</span>
)

// Tinted summary card (same look as the Budget summary cards).
export const TintStat: FC<{ label: string; value: string; tone: string; sub?: string }> = ({ label, value, tone, sub }) => (
  <div class={`rounded-2xl p-3 text-center border ${tone}`}>
    <p class="text-[10px] font-semibold uppercase tracking-wide opacity-80">{label}</p>
    <p class="text-base sm:text-xl font-bold truncate">{value}</p>
    {sub && <p class="text-[10px] opacity-70 mt-0.5 truncate">{sub}</p>}
  </div>
)

// Per-client Kiné summary: delivered (blue), paid (orange), due sessions (green/yellow/red)
export const KineClientStats: FC<{ delivered: number; paid: number; rate: number }> = ({ delivered, paid, rate }) => {
  const balance = rate > 0 ? Math.round(paid / rate) - delivered : 0
  let dueCls = 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400'
  let dueState = 'Balanced'
  let dueVal = '0'
  if (balance > 0) {
    dueCls = 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400'
    dueState = 'Prepaid · ' + (balance * rate).toLocaleString('en-US') + ' MGA'
    dueVal = '+' + balance
  } else if (balance < 0) {
    dueCls = 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400'
    dueState = 'Owes · ' + (Math.abs(balance) * rate).toLocaleString('en-US') + ' MGA'
    dueVal = '-' + Math.abs(balance)
  }
  return (
    <div class="grid grid-cols-3 gap-2">
      <div class="rounded-xl bg-blue-50 dark:bg-blue-900/20 p-2 text-center">
        <p class="text-[10px] font-semibold uppercase text-blue-600 dark:text-blue-400">Delivered</p>
        <p class="text-lg font-bold text-blue-600 dark:text-blue-400">{delivered}</p>
      </div>
      <div class="rounded-xl bg-orange-50 dark:bg-orange-900/20 p-2 text-center">
        <p class="text-[10px] font-semibold uppercase text-orange-600 dark:text-orange-400">Paid</p>
        <p class="text-sm sm:text-base font-bold text-orange-600 dark:text-orange-400">{paid.toLocaleString('en-US')} MGA</p>
      </div>
      <div class={`rounded-xl p-2 text-center ${dueCls}`}>
        <p class="text-[10px] font-semibold uppercase">Due</p>
        <p class="text-lg font-bold">{dueVal}</p>
        <p class="text-[9px] opacity-70 leading-tight">{dueState}</p>
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

