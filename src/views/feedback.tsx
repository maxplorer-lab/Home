/** @jsxImportSource hono/jsx */
// ─── Tap feedback + double-submit guard ──────────────────────
// Shared by <Layout> (every signed-in page) AND the standalone auth
// pages in routes/auth.tsx, which render their own <html> shell.
//
// Why this exists: there is no SPA here — every tap is a full server
// round-trip and the Worker is CPU-limited, so without feedback the user
// taps again (or retypes the PIN), which for a form means a duplicate
// transaction. The press itself is pure CSS (:active fires before any JS);
// the pending state covers the wait that follows.
//
// AGENTS.md rule #3: this JS lives inside a server-side template literal,
// so it must never contain a dollar-brace interpolation.

import type { FC } from 'hono/jsx'

const PRESS_CSS = `
  /* ── Tap / press feedback ─────────────────────────────────────── */
  a, button, select, summary, input[type="submit"], [role="button"], [onclick] {
    touch-action: manipulation;   /* drop the 300ms double-tap-zoom wait */
    transition: transform .08s ease-out, opacity .08s ease-out, filter .08s ease-out,
                background-color .15s ease-out, border-color .15s ease-out, color .15s ease-out;
  }
  button:active, input[type="submit"]:active, [role="button"]:active,
  summary:active, select:active, [onclick]:active {
    transform: scale(.96);
    filter: brightness(.9);
  }
  a:active { transform: scale(.97); opacity: .55; }
  button:disabled, [aria-disabled="true"] { opacity: .5; cursor: not-allowed; }

  /* Top progress bar — the answer to "is it doing anything?" */
  @keyframes sompitra-spin { to { transform: rotate(360deg); } }
  @keyframes sompitra-bar { 0% { left: -45%; } 100% { left: 100%; } }
  #nav-progress { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 200;
                  display: none; overflow: hidden; pointer-events: none; }
  #nav-progress.on { display: block; }
  #nav-progress > i { position: absolute; top: 0; bottom: 0; width: 45%; border-radius: 999px;
                      background: linear-gradient(90deg, #22c55e, #15803d, #22c55e);
                      animation: sompitra-bar 1.1s ease-in-out infinite; }

  /* A control that was pressed and is now waiting on the server */
  .is-pending { opacity: .7; pointer-events: none; position: relative; }
  a.is-pending { opacity: .5; }
  /* Spinner only on controls wide enough to hold it without covering their
     label (added by JS, which can measure). */
  .spin::after { content: ''; position: absolute; right: 9px; top: 50%; width: 11px; height: 11px;
                 margin-top: -5.5px; border: 2px solid currentColor; border-top-color: transparent;
                 border-radius: 50%; animation: sompitra-spin .6s linear infinite; }
  html.sompitra-busy, html.sompitra-busy * { cursor: progress !important; }

  @media (prefers-reduced-motion: reduce) {
    a, button, select, summary, input[type="submit"], [role="button"], [onclick] { transition: none; }
    button:active, a:active, input[type="submit"]:active, [role="button"]:active,
    summary:active, select:active, [onclick]:active { transform: none; filter: brightness(.85); opacity: .7; }
    #nav-progress > i { animation: none; left: 0; width: 100%; }
    .spin::after { animation: none; border-top-color: currentColor; }
  }
`

const PRESS_JS = `
  (function () {
    var NAV_TIMEOUT = 15000;   // a stuck request must not kill the UI
    var busy = false;
    var timer = null;

    // iOS Safari only honours :active while a touchstart listener exists.
    document.addEventListener('touchstart', function () {}, { passive: true });

    var bar = document.createElement('div');
    bar.id = 'nav-progress';
    bar.innerHTML = '<i></i>';
    document.body.appendChild(bar);

    function spin(el, allowSpinner) {
      if (!el) return;
      el.classList.add('is-pending');
      // Only wide controls get the in-button spinner, so it can never sit on
      // top of a short label (e.g. the tiny delete buttons).
      if (allowSpinner && el.offsetWidth >= 110) el.classList.add('spin');
    }
    function start() {
      busy = true;
      bar.classList.add('on');
      document.documentElement.classList.add('sompitra-busy');
      clearTimeout(timer);
      timer = setTimeout(reset, NAV_TIMEOUT);
    }
    function reset() {
      busy = false;
      clearTimeout(timer);
      bar.classList.remove('on');
      document.documentElement.classList.remove('sompitra-busy');
      var els = document.querySelectorAll('.is-pending, .spin');
      for (var i = 0; i < els.length; i++) els[i].classList.remove('is-pending', 'spin');
    }
    function opensNewTab(el) {
      var t = el.getAttribute && el.getAttribute('target');
      return !!t && t !== '_self';
    }

    // Forms. Runs in the bubble phase, i.e. AFTER any inline
    // onsubmit="return confirm(...)" or page-level validation — so a
    // cancelled action never leaves the page stuck in a pending state.
    document.addEventListener('submit', function (ev) {
      if (ev.defaultPrevented) return;
      var form = ev.target;
      if (!form || form.tagName !== 'FORM') return;
      if (form.hasAttribute('data-no-pending') || opensNewTab(form)) return;
      if (busy) { ev.preventDefault(); return; }
      start();
      // ev.submitter is the button actually pressed (null when the form was
      // submitted with Enter in a text field, hence the fallback).
      spin(ev.submitter || form.querySelector('button[type="submit"], input[type="submit"], button:not([type])'), true);
    });

    // ── Dismiss guard ────────────────────────────────────────────
    // Any element carrying data-dismiss throws away the form it sits in, so it
    // must warn when that would lose typing. Initial values are snapshotted here,
    // before any user input. Hidden fields are ignored: they are derived (the
    // itemised total/notes) or switches like the quick/itemised mode, and neither
    // is "unsaved work" on its own.
    var snapshot = [];
    function snapshotFields() {
      var fields = document.querySelectorAll('input, select, textarea');
      for (var i = 0; i < fields.length; i++) {
        var el = fields[i];
        var type = (el.type || '').toLowerCase();
        if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'file' || type === 'reset') continue;
        snapshot.push({
          el: el,
          value: el.value,
          checked: el.checked,
        });
      }
    }
    function findForm(el) {
      var node = el;
      while (node && node.tagName !== 'FORM') node = node.parentNode;
      return node;
    }
    function isFormDirty(el) {
      var form = findForm(el);
      if (!form) return false;
      for (var i = 0; i < snapshot.length; i++) {
        var entry = snapshot[i];
        // Only fields belonging to THIS form count.
        var owner = findForm(entry.el);
        if (owner !== form) continue;
        if (entry.el.checked !== entry.checked) return true;
        if (entry.el.value !== entry.value) return true;
      }
      return false;
    }
    snapshotFields();

    // Links: same-origin navigations in this tab only.
    document.addEventListener('click', function (ev) {
      if (ev.defaultPrevented || ev.button !== 0) return;
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

      // data-dismiss first: a cancelled dismiss must leave no pending state and
      // must not navigate at all.
      var dismissEl = ev.target && ev.target.closest ? ev.target.closest('[data-dismiss]') : null;
      if (dismissEl) {
        if (isFormDirty(dismissEl)) {
          var message = dismissEl.getAttribute('data-dismiss') || 'Dismiss this entry? Everything typed will be lost.';
          if (!confirm(message)) { ev.preventDefault(); return; }
        }
      }

      var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#' || href.indexOf('javascript:') === 0) return;
      if (opensNewTab(a) || a.hasAttribute('download')) return;
      if (a.origin !== location.origin) return;
      if (busy) { ev.preventDefault(); return; }
      start();
      a.classList.add('is-pending');
    });

    // The budget period pickers navigate with this.form.submit(), which fires
    // no submit event at all — so they need their own hook. The request is
    // already in flight by the time this runs, so only the feedback (not the
    // guard) can apply here.
    document.addEventListener('change', function (ev) {
      var el = ev.target;
      if (!el || el.tagName !== 'SELECT') return;
      if ((el.getAttribute('onchange') || '').indexOf('submit') === -1) return;
      if (busy) return;
      start();
      spin(el, false);
    });
  })();
`

/** Put in <head> (or anywhere before the tap happens). */
export const PressFeedbackStyle: FC = () => (
  <style dangerouslySetInnerHTML={{ __html: PRESS_CSS }} />
)

/** Put at the end of <body>, after the content it decorates. */
export const PressFeedbackScript: FC = () => (
  <script dangerouslySetInnerHTML={{ __html: PRESS_JS }} />
)
