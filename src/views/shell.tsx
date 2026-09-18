/** @jsxImportSource hono/jsx */
// ─── Module shell pages (the WAY / Laoka / Chat tabs) ─────────────
// A tiny host document: the Home frame (header + tab bar) with the
// module's own UI running inside it, chromeless.
//
// Why an iframe instead of a direct fetch-and-inline: the modules are
// full apps (WAY's map engine manages its own layout; Laoka is a
// complete SPA with its own routing). The frame keeps them working
// unmodified — same JS, same CSS — while the surrounding shell makes
// them feel like tabs of one app. Each module document detects the
// iframe itself and drops its own chrome before first paint.
//
// Chat is WAY's own chat drawer popped out (`/way/index.html?view=chat`
// skips the map/Honda HUD entirely and mounts the drawer full-screen) —
// it is the original realtime engine, not a re-implementation.
//
// The header and tab bar come from views/app-chrome.tsx — the SAME
// components Sompitra's pages use, so all six tabs share one chrome
// (and one set of real brand icons).
import { CHROME_CSS, TAILWIND_CONFIG, HomeHeader, HomeTabBar, TabSvg, type Badge } from './app-chrome'

type ModuleKind = 'way' | 'laoka' | 'chat'

interface ShellProps {
  kind: ModuleKind
  displayName: string
}

const MODULES: Record<ModuleKind, { label: string; badge: Badge; src: string }> = {
  way:   { label: 'WAY',   badge: { img: '/way/icon-512.png',   label: 'WAY'   }, src: '/way/index.html' },
  laoka: { label: 'Laoka', badge: { img: '/laoka/icon.svg',     label: 'Laoka' }, src: '/laoka/index.html' },
  chat:  { label: 'Chat',  badge: { svg: 'chat',                label: 'Chat'  }, src: '/chat/index.html' },
}

export function ModuleShell({ kind, displayName }: ShellProps) {
  const mod = MODULES[kind]
  return (
    <html lang="en" class="home-module">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
        <meta name="theme-color" content="#16a34a" />
        <title>{`${displayName} – ${mod.label} · Home`}</title>
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/favicon-32.png" type="image/png" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Home" />
        <script src="https://cdn.tailwindcss.com" />
        <script dangerouslySetInnerHTML={{ __html: `
          ${TAILWIND_CONFIG}
          // Same theme bootstrap as the rest of the app.
          if (localStorage.getItem('theme') === 'dark' ||
              (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            document.documentElement.classList.add('dark')
          }
        `}} />
        <style dangerouslySetInnerHTML={{ __html: `
          /* The frame must fill the viewport: header + module + tab bar stack
             to exactly 100% with no page scroll. */
          html, body { height: 100%; margin: 0; }
          #home-module-frame iframe { width: 100%; height: 100%; border: 0; display: block; background: transparent; }
        `}} />
        {/* Shared chrome CSS — same file the Sompitra pages use, so `.pb-safe`
            and friends can never go missing on a module tab. */}
        <style dangerouslySetInnerHTML={{ __html: CHROME_CSS }} />
      </head>
      {/* Chat's module document is a dark, full-bleed room — the shell host
          behind the transparent iframe edges must match it in both themes. */}
      <body class={`home-host flex flex-col ${kind === 'chat'
        ? 'bg-[#0a0a0c] text-gray-100'
        : 'bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100'}`}>
        {/* ── the one Home header ── */}
        <HomeHeader displayName={displayName} badge={mod.badge} />

        {/* ── the module, chromeless ── */}
        <div id="home-module-frame" class="flex-1 min-h-0 relative">
          <iframe id="module-frame" title={`${mod.label} module`} src={mod.src} />
          <div id="home-loading" class="absolute inset-0 flex items-center justify-center pointer-events-none">
            {mod.badge.img
              ? <img src={mod.badge.img} alt="" class="w-8 h-8 animate-pulse opacity-70" />
              : <span className="animate-pulse"><TabSvg name={mod.badge.svg ?? ''} className="w-8 h-8" /></span>}
          </div>
        </div>

        {/* ── the one Home tab bar ── */}
        <HomeTabBar active={kind} />

        {/* Fade the loader once the module starts painting. Each module's
            own head script detects the iframe and drops its chrome — the
            shell never needs to reach inside the frame. */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function () {
            var loader = document.getElementById('home-loading');
            var f = document.getElementById('module-frame');
            function done() { if (loader) loader.style.display = 'none'; }
            f.addEventListener('load', done);
            setTimeout(done, 4000); // never trap the user behind the loader
          })();
        `}} />
      </body>
    </html>
  )
}
