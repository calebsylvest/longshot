# Longshot

A private full-page screenshot extension for Chrome. Scroll-and-stitch capture,
no network access, no analytics, nothing leaves your machine.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder.
3. Pin the extension from the puzzle-piece menu.

After editing any file, click the reload arrow on the extension's card.

## Use

- Click the toolbar icon, or press **Option+Shift+P** (change it at `chrome://extensions/shortcuts`).
- Keep the tab in front while the badge counts up. Switching tabs stops the capture.
- A preview tab opens. **Download PNG** saves to `Downloads/Screenshots/` as
  `domain_YYYY-MM-DD_HHMM.png`. **Copy** puts it on the clipboard.

## What it handles

- Lazy-loaded images and reveal-on-scroll sections (pre-scrolls the page first).
- Sticky and fixed headers (shown once, at the top).
- Fixed bottom bars such as cookie banners (shown once, at the bottom).
- App-shell pages where an inner panel scrolls instead of the page.
- Retina displays (output at native pixel density).
- Very tall pages (split into parts past Chrome's canvas limit).

## Known limits

- Captures take about half a second per screen (Chrome's 2-per-second capture limit).
- Scroll-jacking sites (Lenis, Locomotive Scroll, GSAP ScrollSmoother) may stop early.
- Infinite-scroll pages stop after 60 screens.
- Chrome blocks capture on `chrome://` pages, the Web Store, and other extensions' pages.
- Light and Dark mode: switch macOS appearance or the site's toggle, then capture each.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Permissions: `activeTab`, `scripting`, `downloads` only. Strict CSP, `connect-src 'none'`. |
| `background.js` | Service worker. Runs the scroll/capture loop and hands tiles to the preview page. |
| `content.js` | Injected on click. Pre-scrolls, finds the scroller, hides pinned elements, restores the page. |
| `capture.html/.js/.css` | Preview page. Stitches tiles on canvas, Download and Copy. |
| `icons/` | Toolbar icons. |

## Privacy checklist

- No `host_permissions`, no `<all_urls>`, no `tabs`: access only to the tab you click on, only at that moment.
- No `fetch`, no remote scripts, and the CSP blocks network connections from extension pages.
- Captured tiles live in memory until the preview page is stitched, then are discarded.
