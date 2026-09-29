// Page-side helpers for scroll-and-stitch capture.
// Injected into the active tab only when you start a capture (activeTab).
// Everything here is undone by restore().

(() => {
  const STYLE_ID = '__page-capture-style';
  const MAX_PRESCROLL_STEPS = 60;       // caps infinite-scroll pages
  const PRESCROLL_WAIT_MS = 120;
  const SETTLE_MS = 150;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = (n = 2) =>
    new Promise((r) => {
      const step = () => (--n <= 0 ? r() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });

  const state = {
    scroller: null,          // null = the window scrolls
    original: { x: 0, y: 0 },
    hidden: new Map(),       // element -> previous inline visibility value
  };

  // ---- scrolling -----------------------------------------------------------

  const getScroll = () =>
    state.scroller ? state.scroller.scrollTop : window.scrollY;

  const setScroll = (y) => {
    if (state.scroller) state.scroller.scrollTop = y;
    else window.scrollTo(window.scrollX, y);
  };

  // Find the element that actually scrolls on "app shell" pages, where the
  // document itself is only one screen tall.
  function findInnerScroller() {
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      if (el.clientHeight < window.innerHeight * 0.4) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      html, body, * { scroll-behavior: auto !important; }
      html { scrollbar-width: none !important; }
      html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  async function waitForImages(timeoutMs = 3000) {
    const pending = [...document.images].filter((img) => !img.complete);
    if (!pending.length) return;
    await Promise.race([
      Promise.all(
        pending.map(
          (img) =>
            new Promise((r) => {
              img.addEventListener('load', r, { once: true });
              img.addEventListener('error', r, { once: true });
            })
        )
      ),
      sleep(timeoutMs),
    ]);
  }

  // ---- fixed / sticky handling --------------------------------------------

  function showAll() {
    for (const [el, prev] of state.hidden) el.style.visibility = prev;
    state.hidden.clear();
  }

  function hide(el) {
    if (state.hidden.has(el)) return;
    state.hidden.set(el, el.style.visibility);
    el.style.setProperty('visibility', 'hidden', 'important');
  }

  // Top-pinned elements (nav bars) appear only in the first tile.
  // Bottom-pinned elements (cookie bars, chat buttons) appear only in the last.
  function applyPinnedRules(index, isLast) {
    showAll();
    const vh = window.innerHeight;
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (state.scroller && !state.scroller.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.top >= vh) continue;

      let topPinned = false;
      let bottomPinned = false;
      if (cs.position === 'fixed') {
        if (r.top + r.height / 2 < vh / 2) topPinned = true;
        else bottomPinned = true;
      } else {
        // sticky: only counts when it is currently stuck
        const t = parseFloat(cs.top);
        const b = parseFloat(cs.bottom);
        const box = state.scroller ? state.scroller.getBoundingClientRect() : { top: 0, bottom: vh };
        if (!Number.isNaN(t) && Math.abs(r.top - (box.top + t)) < 2 && getScroll() > 0) topPinned = true;
        else if (!Number.isNaN(b) && Math.abs(box.bottom - b - r.bottom) < 2) bottomPinned = true;
      }

      if ((topPinned && index > 0) || (bottomPinned && !isLast)) hide(el);
    }
  }

  // ---- public API ----------------------------------------------------------

  async function prepare() {
    state.original = { x: window.scrollX, y: window.scrollY };
    injectStyle();
    await frames();

    const doc = document.scrollingElement || document.documentElement;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    state.scroller = doc.scrollHeight - vh > 1 ? null : findInnerScroller();
    if (state.scroller) state.original.y = state.scroller.scrollTop;

    // Pre-scroll so lazy images and reveal-on-scroll content load.
    const stepH = state.scroller ? state.scroller.clientHeight : vh;
    const maxOf = () =>
      state.scroller
        ? state.scroller.scrollHeight - state.scroller.clientHeight
        : doc.scrollHeight - vh;
    for (let i = 1; i <= MAX_PRESCROLL_STEPS && i * stepH < maxOf() + stepH; i++) {
      setScroll(i * stepH);
      await sleep(PRESCROLL_WAIT_MS);
    }
    setScroll(0);
    await waitForImages();
    await sleep(300);
    await frames();

    let rect;
    if (state.scroller) {
      const b = state.scroller.getBoundingClientRect();
      const left = Math.max(0, b.left + state.scroller.clientLeft);
      const top = Math.max(0, b.top + state.scroller.clientTop);
      rect = {
        left,
        top,
        width: Math.min(state.scroller.clientWidth, vw - left),
        height: Math.min(state.scroller.clientHeight, vh - top),
      };
    } else {
      rect = { left: 0, top: 0, width: vw, height: vh };
    }

    const maxScroll = Math.min(maxOf(), MAX_PRESCROLL_STEPS * stepH);
    return {
      mode: state.scroller ? 'inner' : 'window',
      viewport: { width: vw, height: vh },
      dpr: window.devicePixelRatio || 1,
      rect,
      maxScroll: Math.max(0, Math.round(maxScroll)),
      title: document.title,
    };
  }

  async function scrollToTile(y, index, isLast) {
    setScroll(y);
    await frames();
    await sleep(SETTLE_MS);
    applyPinnedRules(index, isLast);
    await frames();
    return { y: Math.round(getScroll()) };
  }

  function restore() {
    showAll();
    document.getElementById(STYLE_ID)?.remove();
    if (state.scroller) state.scroller.scrollTop = state.original.y;
    window.scrollTo(state.original.x, state.scroller ? window.scrollY : state.original.y);
    state.scroller = null;
    return true;
  }

  window.__pageCapture = { prepare, scrollToTile, restore };
})();
