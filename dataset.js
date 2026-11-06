/* Dataset mode: folder loading through server.py, virtualised image list, per-image JSON autosave. */

const ds = { active: false, count: 0, total: 0, pos: -1, gen: 0, filtered: false, version: 0, index: -1, token: 0, bust: new Map(), items: new Map(), chunks: new Map(),
  loading: false, readOnly: false, exactDims: false, lastSaved: '', pending: null, timer: null, saving: Promise.resolve() };
const DS_ROW = 44, DS_CHUNK = 200;
const dsRows = new Map();

async function api(url, opts) {
  let r;
  try { r = await fetch(url, opts); } catch { throw new Error('Server unreachable. Run server.py and open http://127.0.0.1:5000'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
const jsonOpts = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body });
const dsQuery = i => `v=${ds.version}&i=${i}`;
const dsStatus = t => { $('ds-status').textContent = t; };
// The editor canvas uses the exact image size, but a saved layout must use multiples of 16 (MOSS-Image Layout rule).
const dsRound16 = v => Math.max(16, Math.round(v / 16) * 16);
const dsDraft = () => { // saved layout: canvas rounded to 16, boxes kept inside it
  const W = dsRound16(sceneData.width), H = dsRound16(sceneData.height);
  // An image whose size is not a multiple of 16 can be larger than its rounded canvas (e.g. 1010 -> 1008): a box touching the edge
  // would then be "outside the canvas". Clamp such boxes to the saved canvas.
  const items = sceneData.items.map(it => ({ ...it, bbox: [clamp(it.bbox[0], 0, W), clamp(it.bbox[1], 0, H), clamp(it.bbox[2], 0, W), clamp(it.bbox[3], 0, H)] }));
  return { ...sceneData, width: W, height: H, items };
};
const dsSerialize = () => { // compiled when Auto is on or the file is already compiled (it never decompiles by itself), else the draft
  const draft = dsDraft();
  ds.fallback = '';
  ds.outCompiled = false;
  if ($('ds-compiled').checked || ds.compiled) {
    try { ds.outCompiled = true; return dsCompile(draft) + '\n'; } catch (e) { ds.fallback = e.message; ds.outCompiled = false; } // not compilable: keep the draft so no edit is lost
  }
  return JSON.stringify(draft, null, 2);
};

function dsCompile(d) { // port of compile_prompt.py (dataset-image-annotator skill)
  const need = (ok, msg) => { if (!ok) throw new Error(msg); };
  const txt = (v, loc) => need(typeof v === 'string' && v.trim() !== '', `${loc} is empty`);
  const strs = (v, loc) => { need(Array.isArray(v), `${loc} must be a list`); v.forEach((s, i) => txt(s, `${loc} #${i + 1}`)); };
  const { width: W, height: H, summary: s, items } = d;
  txt(s.caption, 'summary caption');
  for (const k of ['meta', 'palette']) if (s[k] !== undefined) strs(s[k], `summary ${k}`);
  need(Array.isArray(items) && items.length > 0, 'no boxes');
  const out = items.map((it, i) => {
    const loc = `box ${i + 1}`;
    need(['object', 'character', 'text'].includes(it.label), `${loc} has an invalid label`);
    txt(it.caption, `${loc} caption`);
    if (it.label === 'text') need(it.text !== undefined, `${loc} text is missing`);
    if (it.text !== undefined) txt(it.text, `${loc} text`);
    for (const k of ['tags', 'palette']) if (it[k] !== undefined) strs(it[k], `${loc} ${k}`);
    const [x1, y1, x2, y2] = it.bbox;
    need(x1 < x2 && y1 < y2 && x1 >= 0 && y1 >= 0 && x2 <= W && y2 <= H, `${loc} is outside the ${W}x${H} canvas`);
    const cy = Math.floor(H / 2), cx = Math.floor(W / 2);
    return { ...it, bbox: [Math.floor(y1) - cy, Math.floor(x1) - cx, Math.ceil(y2) - cy, Math.ceil(x2) - cx] };
  });
  return JSON.stringify({ summary: s, items: out, bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx' });
}

function dsDecompile(j, imgW, imgH) { // compiled file -> editable draft (canvas = image size rounded to 16)
  const W = dsRound16(imgW), H = dsRound16(imgH), cx = Math.floor(W / 2), cy = Math.floor(H / 2);
  return { width: W, height: H, bbox_coord_space: 'abs', bbox_format: 'xyxy', summary: j.summary, items: j.items.map(it => { const [y1, x1, y2, x2] = it.bbox; return { ...it, bbox: [x1 + cx, y1 + cy, x2 + cx, y2 + cy] }; }) };
}
try { $('ds-compiled').checked = localStorage.getItem('ds_compiled') === '1'; } catch { /* storage unavailable */ }
$('ds-compiled').onchange = e => {
  try { localStorage.setItem('ds_compiled', e.target.checked ? '1' : '0'); } catch { /* storage unavailable */ }
  if (e.target.checked && ds.active && !ds.loading && !ds.readOnly) { ds.lastSaved = ''; datasetSaveSoon(); } // re-save the open image in the new format
};
// Compile notices: a large box at the top right of the canvas. It does not expire; click it or change image to dismiss.
function dsNotice(text, kind = 'warn') {
  let el = $('ds-notice');
  if (!el) {
    el = Object.assign(document.createElement('div'), { id: 'ds-notice' });
    el.onclick = dsNoticeClear;
    el.addEventListener('mousedown', e => e.stopPropagation()); // do not start a pan or marquee underneath
    $('viewport').appendChild(el);
  }
  el.className = `ds-notice ${kind}`;
  el.innerHTML = `${escapeHtml(text)}<small>Click to dismiss</small>`;
  ds.noticeKind = kind;
}
function dsNoticeClear() { $('ds-notice')?.remove(); ds.noticeKind = ''; }

const dsReady = () => ds.active && !ds.loading && !ds.readOnly && ds.index >= 0;
function dsCompileNow() { // manual: compile this image's JSON now
  if (!dsReady()) return showToast('⚠️ Open a dataset image first.', 'warn');
  try { dsCompile(dsDraft()); } catch (e) { return dsNotice(`Not compiled: ${e.message}`, 'warn'); }
  ds.compiled = true; // from now on this file stays compiled while editing
  ds.lastSaved = '';
  datasetSaveSoon();
  dsNotice('Compiled.', 'ok');
}
function dsDecompileNow() { // manual only: write this image's JSON back as the editable draft
  if (!dsReady()) return showToast('⚠️ Open a dataset image first.', 'warn');
  ds.pending = { i: ds.index, v: ds.version, body: JSON.stringify(dsDraft(), null, 2), note: '', compiled: false };
  flushSave();
  dsNotice($('ds-compiled').checked ? 'Decompiled. Auto is on, so the next edit compiles it again.' : 'Decompiled to the editable draft.', 'ok');
}
const dsInfo = () => { $('ds-info').textContent = ds.filtered ? `${ds.count} / ${ds.total} images` : `${ds.total} images`; };

/* ---- Loading ---- */
async function loadDataset() {
  try {
    const pick = await api('/api/pick-folder', jsonOpts('POST', '{}'));
    let path = pick.path;
    if (pick.manual) path = prompt('Folder picker unavailable. Enter dataset folder path:');
    if (!path) return;
    await flushSave();
    showToast('Scanning folder…', 'info');
    const info = await api('/api/dataset', jsonOpts('POST', JSON.stringify({ path, recursive: $('ds-recursive').checked })));
    if (!info.count) return showToast('⚠️ No images found in that folder.', 'warn');
    if (info.truncated) showToast(`⚠️ Scan capped at ${info.count} images.`, 'warn');
    dsRows.forEach(el => el.remove());
    dsRows.clear();
    Object.assign(ds, { active: true, count: info.count, total: info.count, pos: -1, gen: ds.gen + 1, filtered: false, version: info.version, index: -1, bust: new Map(), items: new Map(), chunks: new Map(), pending: null });
    $('ds-search').value = '';
    dsLastQuery = '';
    $('ds-sidebar').style.display = 'flex';
    $('ds-apply-meta').style.display = '';
    $('ds-copy-txt').style.display = '';
    $('ds-crop-btn').style.display = '';
    dsInfo();
    $('ds-list').scrollTop = 0;
    dsStatus('');
    dsRender();
    await selectDatasetImage(0, 0);
  } catch (e) { showToast('⚠️ ' + e.message, 'warn'); }
}

async function leaveDataset() {
  if (!confirm('Leave dataset mode? The file you load will not be saved to the dataset.')) return false;
  await flushSave();
  Object.assign(ds, { active: false, exactDims: false, index: -1 });
  $('ds-sidebar').style.display = 'none';
  $('ds-apply-meta').style.display = 'none';
  $('ds-copy-txt').style.display = 'none';
  $('ds-crop-btn').style.display = 'none';
  cancelCrop();
  $('txt-caption').value = '';
  return true;
}

/* ---- Virtual list (only visible rows are in the DOM; names are fetched in chunks) ---- */
function dsFetch(c) {
  if (ds.chunks.has(c)) return ds.chunks.get(c);
  const gen = ds.gen;
  const p = api(`/api/items?offset=${c * DS_CHUNK}&limit=${DS_CHUNK}${ds.filtered ? '&view=1' : ''}`)
    .then(r => {
      if (gen !== ds.gen) return;
      r.items.forEach((it, k) => ds.items.set(c * DS_CHUNK + k, it));
      dsRender();
    })
    .catch(() => { if (gen === ds.gen) ds.chunks.delete(c); });
  ds.chunks.set(c, p);
  return p;
}

function dsRender() {
  if (!ds.active) return;
  const box = $('ds-list');
  $('ds-spacer').style.height = `${ds.count * DS_ROW}px`;
  const first = Math.max(0, Math.floor(box.scrollTop / DS_ROW) - 6);
  const last = Math.min(ds.count - 1, Math.ceil((box.scrollTop + box.clientHeight) / DS_ROW) + 6);
  for (const [i, el] of dsRows) if (i < first || i > last) { el.remove(); dsRows.delete(i); }
  for (let i = first; i <= last; i++) {
    if (dsRows.has(i)) continue;
    const it = ds.items.get(i);
    if (!it) { dsFetch(Math.floor(i / DS_CHUNK)); continue; }
    const el = Object.assign(document.createElement('div'), { className: `ds-row${it.i === ds.index ? ' active' : ''}` });
    el.style.top = `${i * DS_ROW}px`;
    el.innerHTML = `<img loading="lazy" alt="" src="/api/thumb?${dsQuery(it.i)}&t=${ds.bust.get(it.i) || 0}"><span title="${escapeHtml(it.rel)}">${escapeHtml(it.name)}</span>`;
    el.onclick = () => selectDatasetImage(it.i, i);
    box.appendChild(el);
    dsRows.set(i, el);
  }
}
$('ds-list').addEventListener('scroll', () => requestAnimationFrame(dsRender));
window.addEventListener('resize', () => requestAnimationFrame(dsRender));

function dsWarnDims(W, H, toast = false) {
  const bad = W % 16 || H % 16;
  $('ds-warn').textContent = bad ? `⚠ ${W}×${H} is not a multiple of 16` : '';
  if (bad && toast) showToast(`⚠️ Image is ${W}×${H}: dimensions are not multiples of 16.`, 'warn');
}

/* ---- Selecting an image ---- */
async function selectDatasetImage(i, pos) {
  if (!ds.active || i < 0 || i >= ds.total || i === ds.index) return;
  await flushSave();
  cancelCrop();
  dsNoticeClear();
  const token = ++ds.token;
  ds.loading = true;
  ds.index = i;
  if (pos !== undefined) ds.pos = pos;
  dsRows.forEach((el, r) => el.classList.toggle('active', ds.items.get(r)?.i === i));
  try {
    const url = `/api/image?${dsQuery(i)}&t=${ds.bust.get(i) || 0}`; // t defeats the browser's in-page image cache after a crop
    const [side, img] = await Promise.all([
      api(`/api/sidecar?${dsQuery(i)}`),
      new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Image failed to load')); im.src = url; })
    ]);
    if (token !== ds.token) return;

    let schema = null;
    ds.readOnly = false;
    if (side.exists) {
      const json = Array.isArray(side.json?.items) && side.json.bbox_coord_space === 'abs_centralized'
        ? dsDecompile(side.json, img.naturalWidth, img.naturalHeight) : side.json; // compiled files are decompiled for editing
      schema = side.invalid ? null : (Array.isArray(json?.items) ? json : deepSearchSchema(json));
      if (!schema) { ds.readOnly = true; showToast('⚠️ Existing JSON is not a valid schema. Autosave disabled for this image.', 'warn'); }
    }
    const W = img.naturalWidth, H = img.naturalHeight;
    sceneData = schema || clone(BLANK_SCHEMA);
    sceneData.width = W;
    sceneData.height = H;
    ds.exactDims = true;
    historyStack = [];
    redoStack = [];
    clearSelection();
    enforceSchemaIntegrity();
    setBackgroundImage(url);
    syncAll();
    fitToViewport();
    $('txt-caption').value = side.txt ?? '';

    dsWarnDims(W, H, true);
    const wasCompiled = side.json?.bbox_coord_space === 'abs_centralized';
    ds.compiled = wasCompiled; // a compiled file stays compiled while editing
    ds.lastSaved = side.exists ? dsSerialize() : '';
    if ($('ds-compiled').checked && side.exists && !wasCompiled && !ds.readOnly) { // compile mode: try to compile drafts on load
      if (ds.fallback) dsNotice(`Not compiled: ${ds.fallback}`, 'warn'); // stays a draft until fixed
      else { ds.lastSaved = ''; dsNotice('Converted to compiled JSON.', 'ok'); } // the save after loading writes it
    }
    dsStatus(side.exists ? '' : '+ new JSON');
  } catch (e) { showToast('⚠️ ' + e.message, 'warn'); }
  finally {
    if (token === ds.token) { ds.loading = false; datasetSaveSoon(); } // creates the .json if missing
  }
}

/* ---- Page Up / Page Down (not while typing) or Ctrl+Up / Ctrl+Down (always): previous / next image ---- */
window.addEventListener('keydown', async e => {
  if (!ds.active) return;
  const ctrlNav = e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown');
  const pageNav = (e.key === 'PageUp' || e.key === 'PageDown') && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (!ctrlNav && !pageNav) return;
  e.preventDefault();
  const step = e.key === 'PageDown' || e.key === 'ArrowDown' ? 1 : -1;
  const r = ds.pos < 0 ? (step > 0 ? 0 : ds.count - 1) : ds.pos + step; // position in the (filtered) list
  if (r < 0 || r >= ds.count) return;
  ds.pos = r;
  const box = $('ds-list'), top = r * DS_ROW; // keep the selected row visible
  if (top < box.scrollTop) box.scrollTop = top;
  else if (top + DS_ROW > box.scrollTop + box.clientHeight) box.scrollTop = top + DS_ROW - box.clientHeight;
  await dsFetch(Math.floor(r / DS_CHUNK));
  const it = ds.items.get(r);
  if (it) selectDatasetImage(it.i, r);
});

/* ---- Search: matches captions, tags, labels and the .txt; a leading - shows non-matching images ---- */
let dsLastQuery = '';
$('ds-search').addEventListener('keydown', e => { if (e.key === 'Enter') applyDsSearch(true); }); // Enter always re-runs
$('ds-search').addEventListener('blur', () => applyDsSearch(false)); // losing focus runs it only if the text changed

async function applyDsSearch(force) {
  if (!ds.active) return;
  const q = $('ds-search').value;
  if (!force && q === dsLastQuery) return;
  dsLastQuery = q;
  const mine = ++ds.gen;
  try {
    await flushSave();
    const r = await api('/api/search', jsonOpts('POST', JSON.stringify({ v: ds.version, q, current: ds.index })));
    if (mine !== ds.gen) return;
    Object.assign(ds, { count: r.count, total: r.total, pos: r.pos, filtered: r.filtered, gen: ds.gen + 1, items: new Map(), chunks: new Map() });
    dsRows.forEach(el => el.remove());
    dsRows.clear();
    $('ds-list').scrollTop = r.pos >= 0 ? Math.max(0, r.pos * DS_ROW - 100) : 0;
    dsInfo();
    dsRender();
  } catch (e) {
    if (mine === ds.gen) ds.chunks = new Map();
    showToast('⚠️ ' + e.message, 'warn');
  }
}

/* ---- Text caption -> summary.caption ---- */
function copyTxtToSummary() {
  const text = $('txt-caption').value.trim();
  if (!text) return showToast('⚠️ No .txt caption to copy.', 'warn');
  $('sum-caption').value = text;
  updateSummaryField('caption', text);
  showToast('✅ Caption copied to summary.', 'info');
}

/* ---- Dataset-wide summary.meta ---- */
async function applyMetaToDataset() {
  if (!ds.active) return;
  const meta = clone(sceneData.summary.meta || []);
  if (!confirm(`Set summary.meta to [${meta.join(', ') || 'empty'}] on all ${ds.total} images?\nExisting meta in every JSON is overwritten; missing JSONs are created.`)) return;
  try {
    await flushSave();
    showToast('Applying meta to dataset…', 'info');
    const r = await api('/api/apply-meta', jsonOpts('POST', JSON.stringify({ v: ds.version, meta })));
    ds.lastSaved = dsSerialize();
    showToast(`✅ Meta applied: ${r.updated} updated, ${r.created} created, ${r.skipped} skipped.`, 'info');
  } catch (e) { showToast('⚠️ ' + e.message, 'warn'); }
}

/* ---- Autosave (debounced; flushed before switching images) ---- */
function datasetSaveSoon() {
  if (!ds.active || ds.loading || ds.readOnly || ds.index < 0) return;
  const body = dsSerialize(); // editor-only flags are non-enumerable; hidden boxes are kept
  if (body === ds.lastSaved || body === ds.pending?.body) return;
  ds.pending = { i: ds.index, v: ds.version, body, note: ds.fallback, compiled: ds.outCompiled };
  dsStatus('● editing');
  clearTimeout(ds.timer);
  ds.timer = setTimeout(flushSave, 300);
}

function flushSave() {
  clearTimeout(ds.timer);
  const p = ds.pending;
  if (!p) return ds.saving;
  ds.pending = null;
  ds.saving = ds.saving.then(async () => {
    try {
      await api(`/api/json?v=${p.v}&i=${p.i}`, { ...jsonOpts('PUT', p.body), keepalive: p.body.length < 60000 });
      if (p.i === ds.index && p.v === ds.version) {
        ds.lastSaved = p.body;
        ds.compiled = p.compiled;
        dsStatus(p.note ? '⚠ saved as draft' : '✔ saved');
        if (p.note) dsNotice(`Not compiled, saved as draft: ${p.note}`, 'warn');
        else if (ds.noticeKind === 'warn') dsNoticeClear();
      }
    } catch (e) { dsStatus('✖ save failed'); showToast('⚠️ Save failed: ' + e.message, 'warn'); }
  });
  return ds.saving;
}
window.addEventListener('beforeunload', flushSave);
