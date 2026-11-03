/* Ultralytics detector: creates boxes with local YOLO models (run by server.py in the system Python or a chosen venv).
   Models can be grouped (only one model per group runs), tagged (photo / illustration ...) and deactivated. */

const yoloCfg = (() => { try { return JSON.parse(localStorage.getItem('yolo_cfg')) || {}; } catch { return {}; } })();
Object.assign(yoloCfg, { folder: yoloCfg.folder || '', useVenv: !!yoloCfg.useVenv, venv: yoloCfg.venv || '', conf: yoloCfg.conf || 0.25, log: !!yoloCfg.log, models: yoloCfg.models || {}, groups: yoloCfg.groups || {} });
const yoloSave = () => { try { localStorage.setItem('yolo_cfg', JSON.stringify(yoloCfg)); } catch { /* storage unavailable */ } };
const yoloM = f => (yoloCfg.models[f] ||= { active: true, group: '', tags: [], open: /world/i.test(f) }); // open: open-vocabulary (YOLO-World) model
let yoloFiles = [], yoloRows = []; // scanned .pt files; the order shown in the table

/* ---- Model selection: active models, one per group (chosen by image type tag) ---- */
const yoloActive = (open = false) => yoloFiles.filter(f => { const m = yoloM(f); return !!m.open === open && m.active && (!m.group || yoloCfg.groups[m.group]?.active !== false); });

function yoloGroups(open) {
  const by = {};
  for (const f of yoloActive(open)) if (yoloM(f).group) (by[yoloM(f).group] ||= []).push(f);
  return Object.values(by);
}

function yoloPick(kind, open) {
  const picks = yoloActive(open).filter(f => !yoloM(f).group);
  for (const list of yoloGroups(open)) {
    const tagged = kind ? list.filter(f => yoloM(f).tags.includes(kind)) : [];
    const untagged = list.filter(f => !yoloM(f).tags.length);
    picks.push([tagged, untagged, list].find(l => l.length)[0]);
  }
  return picks;
}

async function yoloKind(img, alive, open) { // image type (photo / illustration): only needed when a group has several models with those tags
  const opts = [...new Set(yoloGroups(open).filter(l => l.length > 1).flatMap(l => l.flatMap(f => yoloM(f).tags)))];
  if (!opts.length) return '';
  const meta = sceneData.summary.meta.map(m => m.toLowerCase());
  const hit = opts.filter(t => meta.some(m => m.includes(t))); // summary.meta usually says "photograph" / "illustration"
  if (hit.length === 1) return hit[0];
  let answer = '';
  try { answer = (await llmAsk('image_type', { options: opts.join(', ') }, img)).toLowerCase(); } catch { /* LLM unavailable: fall back to untagged/first model */ }
  alive();
  return opts.find(t => answer.includes(t)) || '';
}

/* ---- Detection ---- */
const yoloDetect = (classes) => llmRun(async (img, alive) => { // classes: keywords for an open-vocabulary run
  if (!yoloCfg.folder) throw new Error('Set the models folder in the YOLO settings first.');
  if (!yoloFiles.length) await yoloScan();
  if (sceneData.items.length && !confirm(`This image already has ${sceneData.items.length} box(es). Detect and add more boxes?`)) return llmStatus('');
  llmStatus('⏳ Choosing detector models…');
  const open = !!classes;
  const kind = await yoloKind(img, alive, open);
  const models = yoloPick(kind, open);
  if (!models.length) throw new Error(open ? 'No active open-vocabulary models. Mark a model as 🔤 Open-vocab in the YOLO settings.' : 'No active detector models. Check the YOLO settings.');
  llmStatus(`⏳ Detecting with ${models.length} model(s)${kind ? ` (${kind})` : ''}…`);
  const full = Object.assign(document.createElement('canvas'), { width: img.el.naturalWidth, height: img.el.naturalHeight });
  full.getContext('2d').drawImage(img.el, 0, 0);
  llmSpin(1);
  let r;
  try { r = await api('/api/yolo/detect', jsonOpts('POST', JSON.stringify({ folder: yoloCfg.folder, models, conf: yoloCfg.conf, use_venv: yoloCfg.useVenv, venv: yoloCfg.venv, log: yoloCfg.log, classes, image: full.toDataURL('image/jpeg', 0.95) }))); }
  finally { llmSpin(-1); }
  alive();
  const W = sceneData.width, H = sceneData.height, sx = W / full.width, sy = H / full.height;
  const made = [];
  for (const d of r.boxes) {
    const [a, b, c, e] = d.bbox, bbox = [clamp(Math.round(a * sx), 0, W), clamp(Math.round(b * sy), 0, H), clamp(Math.round(c * sx), 0, W), clamp(Math.round(e * sy), 0, H)];
    if (bbox[2] - bbox[0] < 2 || bbox[3] - bbox[1] < 2) continue;
    const it = { label: d.label === 'person' ? 'character' : 'object', caption: '', bbox, tags: [d.label] }; // the YOLO class becomes the first tag
    attachEditorProperties(it);
    made.push(it);
  }
  if (!made.length) throw new Error('The detector found nothing.');
  llmSet(() => sceneData.items.push(...made));
  llmStatus(`✔ ${made.length} box(es) from ${models.length} model(s)`);
});

const yoloKeywords = s => [...new Set(s.split(',').map(x => x.trim()).filter(Boolean))]; // "a mug, a laptop" -> ["a mug", "a laptop"]

function yoloOpenPopover(btn) { // keyword box under the button; Send runs the open-vocabulary models
  let p = $('yolo-pop');
  if (p) return p.remove();
  p = Object.assign(document.createElement('div'), { id: 'yolo-pop', className: 'yolo-pop' });
  p.innerHTML = '<label>Keywords to detect, separated by commas</label><div class="llm-row"><input id="yolo-kw" type="text" spellcheck="false" placeholder="red coffee mug, blue laptop, safety helmet"><button class="btn" id="yolo-send">Send</button></div>';
  document.body.appendChild(p);
  const r = btn.getBoundingClientRect();
  p.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 380))}px`;
  p.style.top = `${r.bottom + 6}px`;
  const kw = $('yolo-kw');
  kw.value = yoloCfg.keywords || '';
  kw.focus();
  kw.select();
  const send = () => {
    const list = yoloKeywords(kw.value);
    if (!list.length) return showToast('⚠️ Enter at least one keyword.', 'warn');
    yoloCfg.keywords = kw.value.trim();
    yoloSave();
    p.remove();
    yoloDetect(list);
  };
  $('yolo-send').onclick = send;
  kw.onkeydown = e => { if (e.key === 'Enter') send(); else if (e.key === 'Escape') p.remove(); };
  setTimeout(() => document.addEventListener('mousedown', function off(e) { // click elsewhere closes it
    if (!p.contains(e.target) && e.target !== btn) { p.remove(); document.removeEventListener('mousedown', off); }
  }), 0);
}

/* ---- Settings popup ---- */
function yoloBuild() {
  const host = $('llm-tab-yolo');
  if (!host || host.dataset.built) return;
  host.dataset.built = '1';
  host.insertAdjacentHTML('beforeend', `
    <div class="llm-row"><span id="yolo-status" class="yolo-status"></span><span style="flex:1"></span><button class="btn" onclick="yoloCheck()">🔄 Re-check</button></div>
    <div class="llm-row"><label class="btn" style="margin:0;"><input type="checkbox" id="yolo-usevenv"> Use venv</label><input id="yolo-venv" type="text" spellcheck="false" placeholder="C:\\path\\to\\venv  (folder, or path to python.exe)"></div>
    <label>Models folder (Ultralytics .pt files)</label>
    <div class="llm-row"><input id="yolo-folder" type="text" spellcheck="false" placeholder="C:\\path\\to\\models"><button class="btn" onclick="yoloBrowse()">📁 Browse</button></div>
    <label>Models: put models that detect the same thing into one group (only one per group runs), tag them 📷 Photo and/or 🎨 Illustration so the one matching the image type is chosen (read from summary.meta, or asked from the LLM), and untick to disable a model or a whole group. Models marked 🔤 Open-vocab only run from the Keywords (YOLO) button.</label>
    <div id="yolo-groups" class="llm-row"></div>
    <div id="yolo-models" class="yolo-table"></div>
    <div class="llm-row"><label style="margin:0;">Min confidence <input id="yolo-conf" type="number" min="0.01" max="1" step="0.05" style="width:70px;"></label><button class="btn" onclick="yoloScan()">🔄 Rescan models</button><label class="btn" style="margin:0;" title="Print what the detector does, including Ultralytics output, in the server console"><input type="checkbox" id="yolo-log"> Log to console</label><span style="flex:1"></span><button class="btn" onclick="$('llm-modal').style.display='none'">Close</button></div>
    <datalist id="yolo-gl"></datalist>`);
  host.addEventListener('change', e => {
    const t = e.target, k = t.dataset.k;
    if (t.id === 'yolo-usevenv') yoloCfg.useVenv = t.checked;
    else if (t.id === 'yolo-venv') yoloCfg.venv = t.value.trim();
    else if (t.id === 'yolo-folder') { yoloCfg.folder = t.value.trim(); yoloSave(); return yoloScan(); }
    else if (t.id === 'yolo-conf') yoloCfg.conf = clamp(parseFloat(t.value) || 0.25, 0.01, 1);
    else if (t.id === 'yolo-log') yoloCfg.log = t.checked;
    else if (t.dataset.group !== undefined) (yoloCfg.groups[t.dataset.group] ||= {}).active = t.checked;
    else if (k) {
      const m = yoloM(yoloRows[+t.dataset.i]);
      if (k === 'active') m.active = t.checked;
      else if (k === 'group') m.group = t.value.trim();
      else if (k === 'open') m.open = t.checked;
      else { m.tags = m.tags.filter(x => x !== k); if (t.checked) m.tags.push(k); } // k is 'photo' or 'illustration'
      yoloSave();
      if (k === 'group') yoloRenderModels();
      return;
    }
    yoloSave();
    yoloShowStatus(); // flags a stale check when the venv settings changed
  });
}

function yoloOpenSettings() {
  yoloBuild();
  $('yolo-usevenv').checked = yoloCfg.useVenv;
  $('yolo-venv').value = yoloCfg.venv;
  $('yolo-folder').value = yoloCfg.folder;
  $('yolo-conf').value = yoloCfg.conf;
  $('yolo-log').checked = yoloCfg.log;
  yoloShowStatus();
  yoloScan();
}

const yoloSig = () => `${yoloCfg.useVenv ? 1 : 0}|${yoloCfg.venv}`;

function yoloShowStatus() { // last check result, kept between sessions; only Re-check runs a new check
  const r = yoloCfg.status, el = $('yolo-status');
  if (!r) { el.textContent = 'Not checked yet. Press Re-check.'; return; }
  el.innerHTML = (r.ok ? `✅ ultralytics ${escapeHtml(r.version)} is ready` : `❌ Not ready: ${escapeHtml(r.error)}<br><small>Install it with: pip install ultralytics (in that Python / venv)</small>`)
    + (r.python ? `<br><small>${escapeHtml(r.python)}</small>` : '')
    + (r.sig !== yoloSig() ? '<br><small>⚠ The venv settings changed since this check. Press Re-check.</small>' : '');
}

async function yoloCheck() {
  $('yolo-status').textContent = '⏳ Checking dependencies…';
  try { yoloCfg.status = { ...(await api('/api/yolo/check', jsonOpts('POST', JSON.stringify({ use_venv: yoloCfg.useVenv, venv: yoloCfg.venv })))), sig: yoloSig() }; }
  catch (e) { yoloCfg.status = { ok: false, error: e.message, sig: yoloSig() }; }
  yoloSave();
  yoloShowStatus();
}

async function yoloBrowse() {
  try {
    const r = await api('/api/pick-folder', jsonOpts('POST', '{}'));
    const path = r.manual ? prompt('Folder picker unavailable. Enter the models folder path:') : r.path;
    if (!path) return;
    $('yolo-folder').value = yoloCfg.folder = path;
    yoloSave();
    yoloScan();
  } catch (e) { showToast('⚠️ ' + e.message, 'warn'); }
}

async function yoloScan() {
  yoloFiles = [];
  if (yoloCfg.folder) {
    try { yoloFiles = (await api('/api/yolo/scan', jsonOpts('POST', JSON.stringify({ folder: yoloCfg.folder })))).models; }
    catch (e) { showToast('⚠️ ' + e.message, 'warn'); }
  }
  yoloRenderModels();
}

function yoloRenderModels() {
  if (!$('yolo-models')) return;
  const esc = escapeHtml;
  yoloRows = [...yoloFiles].sort((a, b) => (yoloM(a).group || '\uffff').localeCompare(yoloM(b).group || '\uffff') || a.localeCompare(b));
  const groups = [...new Set(yoloRows.map(f => yoloM(f).group).filter(Boolean))];
  $('yolo-gl').innerHTML = groups.map(g => `<option value="${esc(g)}">`).join('');
  $('yolo-groups').innerHTML = groups.map(g => `<label class="btn" style="margin:0;" title="Deactivate or activate the whole group"><input type="checkbox" data-group="${esc(g)}" ${yoloCfg.groups[g]?.active === false ? '' : 'checked'}> ${esc(g)}</label>`).join('')
    || '<span class="llm-hint">No groups yet: type a group name next to a model.</span>';
  $('yolo-models').innerHTML = yoloRows.length
    ? `<table><tr><th>On</th><th>Model</th><th>Group</th><th>Type</th></tr>${yoloRows.map((f, i) => { const m = yoloM(f); return `<tr><td><input type="checkbox" data-i="${i}" data-k="active" ${m.active ? 'checked' : ''}></td><td title="${esc(f)}">${esc(f)}</td><td><input list="yolo-gl" data-i="${i}" data-k="group" value="${esc(m.group)}" placeholder="group"></td><td><label class="btn" style="margin:0;"><input type="checkbox" data-i="${i}" data-k="photo" ${m.tags.includes('photo') ? 'checked' : ''}> 📷 Photo</label> <label class="btn" style="margin:0;"><input type="checkbox" data-i="${i}" data-k="illustration" ${m.tags.includes('illustration') ? 'checked' : ''}> 🎨 Illustration</label> <label class="btn" style="margin:0;" title="Open-vocabulary (YOLO-World): skipped by Boxes (YOLO), runs from Keywords (YOLO) with the keywords you enter"><input type="checkbox" data-i="${i}" data-k="open" ${m.open ? 'checked' : ''}> 🔤 Open-vocab</label></td></tr>`; }).join('')}</table>`
    : '<span class="llm-hint" style="padding:8px;display:block;">No .pt models found. Set the models folder above.</span>';
}
