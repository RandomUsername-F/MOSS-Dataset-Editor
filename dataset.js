/* Dataset mode: folder loading through server.py, virtualised image list, per-image JSON autosave. */

const ds = { active: false, count: 0, version: 0, index: -1, token: 0, items: new Map(), chunks: new Set(),
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
    Object.assign(ds, { active: true, count: info.count, version: info.version, index: -1, items: new Map(), chunks: new Set(), pending: null });
    $('ds-sidebar').style.display = 'flex';
    $('ds-info').textContent = `${info.count} images`;
    $('ds-list').scrollTop = 0;
    dsStatus('');
    dsRender();
    await selectDatasetImage(0);
  } catch (e) { showToast('⚠️ ' + e.message, 'warn'); }
}

async function leaveDataset() {
  if (!confirm('Leave dataset mode? The file you load will not be saved to the dataset.')) return false;
  await flushSave();
  Object.assign(ds, { active: false, exactDims: false, index: -1 });
  $('ds-sidebar').style.display = 'none';
  $('txt-caption').value = '';
  return true;
}

/* ---- Virtual list (only visible rows are in the DOM; names are fetched in chunks) ---- */
async function dsFetch(c) {
  if (ds.chunks.has(c)) return;
  ds.chunks.add(c);
  const v = ds.version;
  try {
    const r = await api(`/api/items?offset=${c * DS_CHUNK}&limit=${DS_CHUNK}`);
    if (v !== ds.version) return;
    r.items.forEach((it, k) => ds.items.set(c * DS_CHUNK + k, it));
    dsRender();
  } catch { ds.chunks.delete(c); }
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
    const el = Object.assign(document.createElement('div'), { className: `ds-row${i === ds.index ? ' active' : ''}` });
    el.style.top = `${i * DS_ROW}px`;
    el.innerHTML = `<img loading="lazy" alt="" src="/api/thumb?${dsQuery(i)}"><span title="${escapeHtml(it.rel)}">${escapeHtml(it.name)}</span>`;
    el.onclick = () => selectDatasetImage(i);
    box.appendChild(el);
    dsRows.set(i, el);
  }
}
$('ds-list').addEventListener('scroll', () => requestAnimationFrame(dsRender));
window.addEventListener('resize', () => requestAnimationFrame(dsRender));

/* ---- Selecting an image ---- */
async function selectDatasetImage(i) {
  if (!ds.active || i < 0 || i >= ds.count || i === ds.index) return;
  await flushSave();
  const token = ++ds.token;
  ds.loading = true;
  ds.index = i;
  dsRows.forEach((el, k) => el.classList.toggle('active', k === i));
  try {
    const url = `/api/image?${dsQuery(i)}`;
    const [side, img] = await Promise.all([
      api(`/api/sidecar?${dsQuery(i)}`),
      new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Image failed to load')); im.src = url; })
    ]);
    if (token !== ds.token) return;

    let schema = null;
    ds.readOnly = false;
    if (side.exists) {
      schema = side.invalid ? null : (Array.isArray(side.json?.items) ? side.json : deepSearchSchema(side.json));
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

    const bad = W % 16 || H % 16;
    $('ds-warn').textContent = bad ? `⚠ ${W}×${H} is not a multiple of 16` : '';
    if (bad) showToast(`⚠️ Image is ${W}×${H}: dimensions are not multiples of 16.`, 'warn');
    ds.lastSaved = side.exists ? JSON.stringify(sceneData, null, 2) : '';
    dsStatus(side.exists ? '' : '+ new JSON');
  } catch (e) { showToast('⚠️ ' + e.message, 'warn'); }
  finally {
    if (token === ds.token) { ds.loading = false; datasetSaveSoon(); } // creates the .json if missing
  }
}

/* ---- Autosave (debounced; flushed before switching images) ---- */
function datasetSaveSoon() {
  if (!ds.active || ds.loading || ds.readOnly || ds.index < 0) return;
  const body = JSON.stringify(sceneData, null, 2); // editor-only flags are non-enumerable; hidden boxes are kept
  if (body === ds.lastSaved || body === ds.pending?.body) return;
  ds.pending = { i: ds.index, v: ds.version, body };
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
      if (p.i === ds.index && p.v === ds.version) { ds.lastSaved = p.body; dsStatus('✔ saved'); }
    } catch (e) { dsStatus('✖ save failed'); showToast('⚠️ Save failed: ' + e.message, 'warn'); }
  });
  return ds.saving;
}
window.addEventListener('beforeunload', flushSave);
