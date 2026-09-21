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
import { CHROME_CSS, TAILWIND_CONFIG, CHAT_UNREAD_SCRIPT, HomeHeader, HomeTabBar, TabSvg, BrandFontLinks, tabColorFor, tabInkFor, type Badge } from './app-chrome'

type ModuleKind = 'way' | 'laoka' | 'chat'

interface ShellProps {
  kind: ModuleKind
  displayName: string
}

const MODULES: Record<ModuleKind, { label: string; badge: Badge; src: string }> = {
  // The badge renders at 20px, and WAY's icon-512.png is a 1MB 1254px source:
  // icon-64.png is the same mark cropped to its pin and scaled (≈10KB).
  way:   { label: 'WAY',   badge: { img: '/way/icon-64.png',    label: 'WAY'   }, src: '/way/index.html' },
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
        {/* Matches the tab you are in — an installed app's status bar then
            follows the module instead of always showing Home green. */}
        <meta name="theme-color" content={tabColorFor(kind)} />
        <title>{`${displayName} – ${mod.label} · Home`}</title>
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/favicon-32.png" type="image/png" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Home" />
        {/* Same brand typeface as the Sompitra pages — every document the app
            serves loads this one family, so a tab cannot render in a different
            face than the page you arrived from. */}
        <BrandFontLinks />
        {/* Same typed-entry rule as the Sompitra pages (views/layout.tsx): the
            shell's own documents are chromeless, but the shared include lives in
            both heads so a number box can never arrive unguarded. */}
        <script src="/shared/number-entry.js" />
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
          /* The module STAGE: the module runs inset inside a rounded, framed
             panel instead of bleeding to the window edges.

             Why it matters: a module that touches all four edges reads as a
             separate app the chrome happens to sit on top of — which is exactly
             how the Chat tab looked (a black room jammed under a white header,
             one hard seam and no shared edge). Insetting it by 8px and rounding
             it makes the module a panel OF Home, the way a mini-program sits
             inside its host. The ring is the panel's edge in both themes. */
          #home-module-stage { padding: 8px 8px 6px; }
          @media (min-width: 640px) { #home-module-stage { padding: 12px 12px 8px; } }
          #home-module-frame {
            position: relative; height: 100%; overflow: hidden;
            border-radius: 16px;
            box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px -12px rgba(0,0,0,.25);
            outline: 1px solid rgba(0,0,0,.06);
            outline-offset: 0;
          }
          html.dark #home-module-frame { outline-color: rgba(255,255,255,.10); }
        `}} />
        {/* Shared chrome CSS — same file the Sompitra pages use, so `.pb-safe`
            and friends can never go missing on a module tab. */}
        <style dangerouslySetInnerHTML={{ __html: CHROME_CSS }} />
      </head>
      {/* Chat's module document is a dark room: the ring around the stage is the
          only place the host background shows, so it stays the app's own surface
          (not the room's black) — that frame is what keeps Chat reading as a
          panel of Home rather than a separate dark app. */}
      <body
        style={{ '--accent': tabColorFor(kind), '--accent-ink': tabInkFor(kind) }}
        class="home-host flex flex-col bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100"
      >
        {/* ── the one Home header ── */}
        <HomeHeader displayName={displayName} badge={mod.badge} active={kind} />

        {/* ── the module, chromeless, inside its stage (CSS above) ── */}
        <div id="home-module-stage" class="flex-1 min-h-0">
          <div id="home-module-frame">
            <iframe id="module-frame" title={`${mod.label} module`} src={mod.src} />
            {/* `class`, not `className`: hono/jsx is not React and writes the
                attribute verbatim, so `className` produced a literal
                className="animate-pulse" — an attribute no browser styles, i.e.
                the Chat tab's loader was the one tab that never pulsed. */}
            <div id="home-loading" class="absolute inset-0 flex items-center justify-center pointer-events-none">
              {mod.badge.img
                ? <img src={mod.badge.img} alt="" class="w-8 h-8 animate-pulse opacity-70" />
                : <span class="animate-pulse"><TabSvg name={mod.badge.svg ?? ''} className="w-8 h-8" /></span>}
            </div>
          </div>
        </div>

        {/* ── the one Home tab bar (hidden from md up, where the header nav
               takes over) ── */}
        <HomeTabBar active={kind} />

        {/* Register the app-wide service worker HERE too. Only the Sompitra
            pages used to do it, so the tabs people actually install from (the
            map, Laoka, the chat) were the ones with no offline shell — and a
            service worker is part of what makes the app installable. */}
        <script dangerouslySetInnerHTML={{ __html: `
          if ('serviceWorker' in navigator) {
            window.addEventListener('load', function () {
              navigator.serviceWorker.register('/sw.js').catch(function () {});
            });
          }
        `}} />

        {/* The Chat tab's unread dot — the same script the Sompitra pages run,
            so sitting on the map or in Laoka still shows "someone wrote". */}
        <script dangerouslySetInnerHTML={{ __html: CHAT_UNREAD_SCRIPT }} />

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
