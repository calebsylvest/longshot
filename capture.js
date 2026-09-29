// Result page: pulls tiles from the service worker, stitches them on canvas,
// and offers Download / Copy. Nothing is sent anywhere.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// Chrome canvas limits: 32,767 px per side and ~268M px in area.
const MAX_SIDE = 32000;
const MAX_AREA = 268_000_000;

const send = (msg) => chrome.runtime.sendMessage(msg);

function loadImage(src) {
  const img = new Image();
  img.src = src;
  return img.decode().then(() => img);
}

function pad(n) { return String(n).padStart(2, '0'); }

function baseName(meta) {
  let host = 'page';
  try { host = new URL(meta.url).hostname.replace(/^www\./, ''); } catch (_) {}
  const d = new Date(meta.capturedAt);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${host.replace(/[^a-z0-9.-]/gi, '_')}_${stamp}`;
}

function showError(text) {
  $('title').textContent = 'Capture failed';
  $('status').textContent = text;
  $('status').classList.add('error');
}

async function stitch(id) {
  const meta = await send({ type: 'meta', id });
  if (!meta) {
    showError('This capture is no longer available. Run the capture again.');
    return;
  }
  $('title').textContent = meta.title || meta.url;
  $('sub').textContent = meta.url;
  document.title = `Longshot · ${meta.title || meta.url}`;

  const { rect, viewport } = meta;
  const n = meta.tileCount;
  let parts = null;
  let scale = 1;
  let outW = 0;
  let outH = 0;
  let lastY = 0;

  const drawTo = (img, sx, sy, sw, sh, dx, dy) => {
    if (sw <= 0 || sh <= 0) return;
    for (const p of parts) {
      if (dy + sh <= p.y0 || dy >= p.y0 + p.h) continue;
      p.ctx.drawImage(img, sx, sy, sw, sh, dx, dy - p.y0, sw, sh);
    }
  };

  for (let i = 0; i < n; i++) {
    $('status').textContent = `Stitching tile ${i + 1} of ${n}…`;
    const tile = await send({ type: 'tile', id, index: i });
    const img = await loadImage(tile.dataUrl);

    if (i === 0) {
      // Set up output canvases once we know the real pixel scale.
      scale = img.naturalWidth / viewport.width;
      outW = img.naturalWidth;
      // Height is final once the last tile is known; allocate for the planned max.
      const plannedH = Math.round((viewport.height + meta.maxScroll) * scale);
      const maxPartH = Math.min(MAX_SIDE, Math.floor(MAX_AREA / outW));
      parts = [];
      for (let y0 = 0; y0 < plannedH; y0 += maxPartH) {
        const h = Math.min(maxPartH, plannedH - y0);
        const canvas = new OffscreenCanvas(outW, h);
        const ctx = canvas.getContext('2d');
        // Fill with the page's own edge colour so gaps never show as white-on-dark.
        ctx.drawImage(img, 0, img.naturalHeight - 1, 1, 1, 0, 0, outW, h);
        parts.push({ canvas, ctx, y0, h });
      }
      // Areas outside an inner scroller (headers, sidebars) come from tile 0.
      const r = {
        l: Math.round(rect.left * scale), t: Math.round(rect.top * scale),
        w: Math.round(rect.width * scale), h: Math.round(rect.height * scale),
      };
      drawTo(img, 0, 0, outW, r.t, 0, 0);
      drawTo(img, 0, r.t, r.l, r.h, 0, r.t);
      drawTo(img, r.l + r.w, r.t, outW - r.l - r.w, r.h, r.l + r.w, r.t);
    }

    const sx = Math.round(rect.left * scale);
    const sy = Math.round(rect.top * scale);
    const sw = Math.round(rect.width * scale);
    const sh = Math.round(rect.height * scale);
    drawTo(img, sx, sy, sw, sh, sx, Math.round((rect.top + tile.y) * scale));
    lastY = tile.y;

    if (i === n - 1) {
      // Area below an inner scroller (footer) comes from the last tile.
      const below = img.naturalHeight - (sy + sh);
      drawTo(img, 0, sy + sh, outW, below, 0, Math.round((rect.top + rect.height + tile.y) * scale));
    }
  }
  send({ type: 'done', id });

  // Trim to the real height (a scroll-jacked page may stop early).
  outH = Math.round((viewport.height + lastY) * scale);
  const blobs = [];
  for (const p of parts) {
    if (p.y0 >= outH) break;
    let canvas = p.canvas;
    const h = Math.min(p.h, outH - p.y0);
    if (h < p.h) {
      canvas = new OffscreenCanvas(outW, h);
      canvas.getContext('2d').drawImage(p.canvas, 0, 0);
    }
    blobs.push(await canvas.convertToBlob({ type: 'image/png' }));
  }

  render(meta, blobs, outW, outH, scale);
}

function render(meta, blobs, w, h, scale) {
  const name = baseName(meta);
  const urls = blobs.map((b) => URL.createObjectURL(b));
  const mb = (blobs.reduce((s, b) => s + b.size, 0) / 1e6).toFixed(1);

  $('status').textContent =
    `${w} × ${h} px · ${scale}× · ${mb} MB` +
    (blobs.length > 1 ? ` · split into ${blobs.length} images (Chrome canvas limit)` : '');

  const preview = $('preview');
  preview.textContent = '';
  urls.forEach((u, i) => {
    const img = document.createElement('img');
    img.src = u;
    img.alt = `Capture part ${i + 1}`;
    preview.appendChild(img);
  });

  $('download').disabled = false;
  $('download').onclick = async () => {
    for (let i = 0; i < urls.length; i++) {
      const suffix = urls.length > 1 ? `_part${i + 1}` : '';
      await chrome.downloads.download({
        url: urls[i],
        filename: `Screenshots/${name}${suffix}.png`,
        conflictAction: 'uniquify',
      });
    }
  };

  $('copy').disabled = false;
  if (blobs.length > 1) $('copy').title = 'Copies the first part only';
  $('copy').onclick = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobs[0] })]);
      $('copy').textContent = 'Copied';
      setTimeout(() => ($('copy').textContent = 'Copy'), 1500);
    } catch (err) {
      $('copy').textContent = 'Copy failed';
      console.error(err);
    }
  };
}

if (params.get('error')) showError(params.get('error'));
else if (params.get('id')) stitch(params.get('id')).catch((e) => showError(String(e?.message || e)));
else showError('Nothing to show. Click the toolbar icon on a page to capture it.');
