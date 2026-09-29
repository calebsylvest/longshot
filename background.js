// Service worker: runs a scroll-and-stitch capture of the active tab, then
// hands the tiles to capture.html, which stitches and saves them.
// No network access, no storage of page content beyond this session.

const CAPTURE_GAP_MS = 550; // Chrome allows 2 captureVisibleTab calls per second
const captures = new Map(); // id -> { meta, tiles: [{ y, dataUrl }] }
const busyTabs = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RESTRICTED = [
  /^chrome:/, /^edge:/, /^about:/, /^view-source:/, /^devtools:/,
  /^chrome-extension:/, /^https:\/\/chromewebstore\.google\.com/,
  /^https:\/\/chrome\.google\.com\/webstore/,
];

chrome.action.onClicked.addListener((tab) => {
  if (busyTabs.has(tab.id)) return;
  runCapture(tab).catch((err) => console.error('[longshot]', err));
});

async function inTab(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

async function badge(tabId, text, color = '#555') {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
  } catch (_) { /* tab may be gone */ }
}

async function captureWithRetry(windowId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(err))) throw err;
      await sleep(CAPTURE_GAP_MS);
    }
  }
  throw new Error('Chrome kept rate-limiting captures.');
}

function openResult(params) {
  const q = new URLSearchParams(params).toString();
  return chrome.tabs.create({ url: chrome.runtime.getURL(`capture.html?${q}`) });
}

async function runCapture(tab) {
  const tabId = tab.id;
  if (!tab.url || RESTRICTED.some((re) => re.test(tab.url))) {
    await openResult({ error: 'Chrome does not let extensions capture this page (browser pages, the Web Store and other extensions are blocked).' });
    return;
  }

  busyTabs.add(tabId);
  await badge(tabId, '…');
  let injected = false;

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    injected = true;

    const meta = await inTab(tabId, () => window.__pageCapture.prepare());
    const { rect, maxScroll } = meta;

    // Tile positions: one per scroller height, last one flush with the bottom.
    const ys = [];
    for (let y = 0; y < maxScroll; y += rect.height) ys.push(y);
    if (!ys.length || ys[ys.length - 1] !== maxScroll) ys.push(maxScroll);

    const tiles = [];
    let lastShot = 0;
    for (let i = 0; i < ys.length; i++) {
      const isLast = i === ys.length - 1;
      const { y } = await inTab(
        tabId,
        (yy, idx, last) => window.__pageCapture.scrollToTile(yy, idx, last),
        [ys[i], i, isLast]
      );
      // Scroll-jacked page or content stopped growing: stop at the last real position.
      if (tiles.length && y <= tiles[tiles.length - 1].y) {
        if (!isLast) continue;
        break;
      }

      const current = await chrome.tabs.get(tabId);
      if (!current.active) throw new Error('Capture stopped because you switched tabs.');

      const wait = CAPTURE_GAP_MS - (Date.now() - lastShot);
      if (wait > 0) await sleep(wait);
      const dataUrl = await captureWithRetry(tab.windowId);
      lastShot = Date.now();
      tiles.push({ y, dataUrl });
      await badge(tabId, `${Math.round(((i + 1) / ys.length) * 100)}`);
    }

    const id = crypto.randomUUID();
    captures.set(id, {
      meta: { ...meta, url: tab.url, capturedAt: Date.now(), tileCount: tiles.length },
      tiles,
    });
    await openResult({ id });
  } catch (err) {
    await openResult({ error: String(err?.message || err) });
  } finally {
    if (injected) {
      try { await inTab(tabId, () => window.__pageCapture?.restore()); } catch (_) {}
    }
    busyTabs.delete(tabId);
    await badge(tabId, '');
  }
}

// capture.html pulls the tiles one message at a time (keeps each message small).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  const cap = captures.get(msg?.id);
  if (msg?.type === 'meta') sendResponse(cap ? cap.meta : null);
  else if (msg?.type === 'tile') sendResponse(cap?.tiles[msg.index] ?? null);
  else if (msg?.type === 'done') { captures.delete(msg.id); sendResponse(true); }
});
