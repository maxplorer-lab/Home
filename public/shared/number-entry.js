// ── HomeNumberEntry: a quantity or a price is TYPED, never nudged ───────────
//
// One rule for every `<input type="number">` in the whole app, loaded by every
// document Home serves (the Sompitra pages and the module shells via
// views/app-chrome's includes, and WAY, Laoka, Chat and the public live share as
// plain `<script src="/shared/number-entry.js">`).
//
// Why this exists at all: a number box has two ways of changing its value that
// nobody asked for, and both are dangerous here rather than merely annoying.
//
//   1. The browser's own up/down spinner buttons. On a phone they are a
//      mis-tap target next to a real keyboard, and on the to-buy list they sit
//      exactly where a thumb lands to scroll.
//   2. The mouse wheel / trackpad, which a FOCUSED number box turns into a step
//      instead of a scroll. On a long Laoka list that is the worst case in the
//      app: you scroll to the bottom, and every box the pointer crosses on the
//      way is silently restocked at the number under the cursor -- and in Laoka
//      those boxes commit on blur, so it is written to the trip, not just
//      displayed.
//
// What this file does NOT do:
//   * It never rewrites a value, clamps anything, or changes validation. Typing
//     works exactly as before; only nudging is gone.
//   * It does not swallow the scroll. A wheel over a number box cancels the
//     STEP and then performs the scroll by hand on the nearest scrollable
//     ancestor (or the window), because killing the page scroll to protect one
//     box is how you get the opposite bug -- a list you cannot move through.
//     (That has already happened once in this project: `overflow-x: hidden` on
//     the root in Laoka's embed CSS killed wheel scrolling outright.)
//   * Up/Down arrows are cancelled too. With the spinners gone there is no
//     affordance that says they step, and "hard keyboard entry" means the value
//     comes from typing. Every other key, including Home/End/Tab/Enter, is left
//     alone.
(function () {
  'use strict';

  // The spinner buttons, in every engine. `-moz-appearance: textfield` is what
  // Firefox uses; the two pseudo-elements are Blink/WebKit (Chrome, Brave,
  // Safari, Samsung, Edge). Setting the height to `auto` is deliberate: the
  // older WebKit rules in the wild use `height: 1em`, which is what makes the
  // inner button overlap text in a short box.
  var CSS = 'input[type="number"]{-moz-appearance:textfield;appearance:textfield;}' +
    'input[type="number"]::-webkit-outer-spin-button,' +
    'input[type="number"]::-webkit-inner-spin-button' +
    '{-webkit-appearance:none;appearance:none;margin:0;height:auto;}';

  function installCss() {
    if (document.getElementById('home-number-entry-css')) return;
    var head = document.head || document.documentElement;
    if (!head) return;
    var style = document.createElement('style');
    style.id = 'home-number-entry-css';
    style.textContent = CSS;
    head.appendChild(style);
  }

  installCss();
  // The Sompitra pages load this from <head>, so the style exists before any
  // box paints; a document that loads it late (or injects markup later) still
  // gets it, because a style element applies whenever it arrives.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installCss);

  function isNumberBox(node) {
    return !!node && node.nodeType === 1 && node.tagName === 'INPUT' && node.type === 'number';
  }

  // The nearest ancestor that can actually scroll vertically or horizontally --
  // Laoka scrolls `#view`, Chat scrolls its message list, Sompitra's pages
  // scroll the window. Without this the wheel would be dead over any box.
  function scrollerFor(node) {
    for (var n = node.parentElement; n; n = n.parentElement) {
      if (n === document.body || n === document.documentElement) break;
      var st = window.getComputedStyle(n);
      var y = /(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight;
      var x = /(auto|scroll|overlay)/.test(st.overflowX) && n.scrollWidth > n.clientWidth;
      if (y || x) return n;
    }
    return null;
  }

  // FireFox reports lines (1) and pages (2) rather than pixels (0); without this
  // normalising, a Linux/Firefox wheel over a box would move the list by 3px.
  function toPixels(delta, mode, axis) {
    if (mode === 1) return delta * 16;
    if (mode === 2) {
      var view = document.documentElement;
      return delta * (axis === 'y' ? view.clientHeight : view.clientWidth);
    }
    return delta;
  }

  document.addEventListener('wheel', function (ev) {
    var box = ev.target;
    if (!isNumberBox(box)) return;
    // A box that is not focused is not stepped by any engine, so leaving it
    // alone keeps the scroll untouched in the common case (flinging a list past
    // boxes you never tapped).
    if (document.activeElement !== box) return;
    ev.preventDefault();
    var dx = toPixels(ev.deltaX, ev.deltaMode, 'x');
    var dy = toPixels(ev.deltaY, ev.deltaMode, 'y');
    var scroller = scrollerFor(box);
    if (scroller) {
      if (dy) scroller.scrollTop += dy;
      if (dx) scroller.scrollLeft += dx;
    } else {
      window.scrollBy(dx, dy);
    }
  }, { passive: false });

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    if (!isNumberBox(ev.target)) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return; // never touch a shortcut
    ev.preventDefault();
  });
})();
