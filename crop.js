/* Crop tool (dataset mode): manual frame or auto (floor to multiples of 16), confirm, then crop the file via server.py and shift boxes. */

const crop = { active: false, mode: 'manual', x: 0, y: 0, w: 0, h: 0, drag: null };
const CROP_MIN = 16;

function startCrop() {
  if (!ds.active || ds.index < 0 || ds.loading) return showToast('⚠️ Open a dataset image first.', 'warn');
  Object.assign(crop, { active: true, x: 0, y: 0, w: sceneData.width, h: sceneData.height, drag: null });
  $('crop-bar').style.display = 'flex';
  if (!$('crop-svg')) {
    const s = svgEl('svg', { id: 'crop-svg', preserveAspectRatio: 'none' });
    s.addEventListener('mousedown', e => {
      if (e.button !== 0) return; // middle / right button keep panning the canvas
      e.stopPropagation(); // also keeps boxes untouchable while cropping
      e.preventDefault();
      const mode = e.target.closest('[data-mode]')?.dataset.mode;
      if (!mode || (crop.mode === 'auto' && mode !== 'move')) return;
      crop.drag = { mode, sx: e.clientX, sy: e.clientY, x: crop.x, y: crop.y, w: crop.w, h: crop.h };
    });
    $('container').appendChild(s);
  }
  setCropMode('manual');
}

function setCropMode(mode) {
  const W = sceneData.width, H = sceneData.height;
  if (mode === 'auto') {
    const w = W - (W % 16), h = H - (H % 16);
    if (w < 16 || h < 16) { showToast('⚠️ Image is too small to crop to a multiple of 16.', 'warn'); mode = 'manual'; }
    else if (w === W && h === H) { showToast('✅ Image dimensions are already multiples of 16.', 'info'); mode = 'manual'; }
    else Object.assign(crop, { w, h, x: Math.floor((W - w) / 2), y: Math.floor((H - h) / 2) });
  }
  crop.mode = mode;
  for (const m of ['manual', 'auto']) $(`crop-mode-${m}`).style.background = m === mode ? 'var(--bg-card-hover)' : '';
  $('crop-w').disabled = $('crop-h').disabled = mode === 'auto';
  cropRender();
}

function cropRender() {
  const s = $('crop-svg'), W = sceneData.width, H = sceneData.height, { x, y, w, h } = crop;
  s.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const nodes = [
    svgEl('path', { d: `M0 0H${W}V${H}H0Z M${x} ${y}V${y + h}H${x + w}V${y}Z`, 'fill-rule': 'evenodd', class: 'crop-dim' }),
    svgEl('rect', { x, y, width: w, height: h, class: 'crop-frame', 'data-mode': 'move' })
  ];
  if (crop.mode === 'manual') {
    const edges = { n: [x, y, x + w, y], s: [x, y + h, x + w, y + h], w: [x, y, x, y + h], e: [x + w, y, x + w, y + h] };
    for (const [mode, [x1, y1, x2, y2]] of Object.entries(edges)) nodes.push(svgEl('line', { x1, y1, x2, y2, class: `edge ${mode}`, 'data-mode': mode }));
    for (const [mode, [fx, fy]] of Object.entries(HANDLE_POS)) {
      const g = svgEl('g', { class: `handle-g ${mode}`, 'data-mode': mode });
      g.style.cssText = `--hx:${x + w * fx}px;--hy:${y + h * fy}px`;
      g.append(svgEl('rect', { x: -8, y: -8, width: 16, height: 16, class: 'handle-hit' }), svgEl('rect', { x: -4, y: -4, width: 8, height: 8, class: 'handle' }));
      nodes.push(g);
    }
  }
  s.replaceChildren(...nodes);
  for (const k of ['x', 'y', 'w', 'h']) $(`crop-${k}`).value = crop[k];
  $('crop-info').textContent = `${W}×${H} → ${w}×${h}${w % 16 || h % 16 ? '  ⚠ not ×16' : ''}`;
}

function cropFromInputs() {
  const W = sceneData.width, H = sceneData.height, v = k => parseInt($(`crop-${k}`).value, 10) || 0;
  const w = crop.mode === 'auto' ? crop.w : clamp(v('w'), CROP_MIN, W);
  const h = crop.mode === 'auto' ? crop.h : clamp(v('h'), CROP_MIN, H);
  Object.assign(crop, { w, h, x: clamp(v('x'), 0, W - w), y: clamp(v('y'), 0, H - h) });
  cropRender();
}

window.addEventListener('mousemove', e => {
  const d = crop.drag;
  if (!d) return;
  const W = sceneData.width, H = sceneData.height;
  const dx = Math.round((e.clientX - d.sx) / zoom), dy = Math.round((e.clientY - d.sy) / zoom);
  if (d.mode === 'move') {
    Object.assign(crop, { x: clamp(d.x + dx, 0, W - d.w), y: clamp(d.y + dy, 0, H - d.h) });
  } else {
    let x1 = d.x, y1 = d.y, x2 = d.x + d.w, y2 = d.y + d.h;
    if (d.mode.includes('w')) x1 = clamp(x1 + dx, 0, x2 - CROP_MIN);
    if (d.mode.includes('e')) x2 = clamp(x2 + dx, x1 + CROP_MIN, W);
    if (d.mode.includes('n')) y1 = clamp(y1 + dy, 0, y2 - CROP_MIN);
    if (d.mode.includes('s')) y2 = clamp(y2 + dy, y1 + CROP_MIN, H);
    Object.assign(crop, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
  }
  cropRender();
});
window.addEventListener('mouseup', () => { crop.drag = null; });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && crop.active) cancelCrop(); });

function cancelCrop() {
  if (!crop.active) return;
  crop.active = false;
  crop.drag = null;
  $('crop-svg')?.remove();
  $('crop-bar').style.display = 'none';
}

async function confirmCrop() {
  const { x, y, w, h } = crop, W = sceneData.width, H = sceneData.height, i = ds.index;
  if (w === W && h === H) return showToast('⚠️ Crop frame covers the whole image.', 'warn');
  try {
    await flushSave();
    ds.loading = true; // blocks autosave until the new state is ready
    await api(`/api/crop?${dsQuery(i)}`, jsonOpts('POST', JSON.stringify({ x, y, w, h, backup: $('crop-backup').checked })));

    // Re-read the real size of the cropped file instead of trusting the requested frame
    const t = Date.now();
    ds.bust.set(i, t); // later selections of this image must not reuse the cached uncropped one
    const url = `/api/image?${dsQuery(i)}&t=${t}`;
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Cropped image failed to load')); im.src = url; });
    const nw = img.naturalWidth, nh = img.naturalHeight;

    let dropped = 0;
    sceneData.items = sceneData.items.filter(it => {
      const [a, b, c, d] = it.bbox;
      const box = [clamp(a - x, 0, nw), clamp(b - y, 0, nh), clamp(c - x, 0, nw), clamp(d - y, 0, nh)];
      if (box[2] - box[0] < 1 || box[3] - box[1] < 1) { dropped++; return false; } // fully outside the crop
      it.bbox = box;
      return true;
    });
    sceneData.width = nw;
    sceneData.height = nh;
    historyStack = []; // the image file changed, so earlier undo states no longer match it
    redoStack = [];
    clearSelection();
    cancelCrop();
    enforceSchemaIntegrity();
    setBackgroundImage(url);
    syncAll();
    fitToViewport();
    const thumb = dsRows.get(i)?.querySelector('img');
    if (thumb) thumb.src = `/api/thumb?${dsQuery(i)}&t=${t}`;
    dsWarnDims(nw, nh);
    showToast(`✅ Cropped to ${nw}×${nh}.${dropped ? ` ${dropped} box(es) outside the crop were removed.` : ''}`, 'info');
  } catch (e) { showToast('⚠️ ' + e.message, 'warn'); }
  finally { ds.loading = false; datasetSaveSoon(); }
}
