/* Macro: an ordered list of actions run on the open image, or one after another on every selected image. */

const MACRO_DEFAULT = [{ type: 'detect_llm' }, { type: 'scene_caption' }, { type: 'scene_tags' }, { type: 'palette' },
  { type: 'item_text', scope: 'empty' }, { type: 'item_caption', scope: 'all', label: 'any' }, { type: 'item_tags', scope: 'all', label: 'any' }];
const macroCfg = (() => { try { return JSON.parse(localStorage.getItem('macro_cfg')) || {}; } catch { return {}; } })();
macroCfg.steps ||= clone(MACRO_DEFAULT);
const macroSave = () => { try { localStorage.setItem('macro_cfg', JSON.stringify(macroCfg)); } catch { /* storage unavailable */ } };
const macro = { running: false, stop: false, ctrl: null };

// Interrupt: LLM and detector requests made during a run can be aborted
const macroFetch = window.fetch;
window.fetch = (u, o = {}) => (macro.running && /^\/api\/(llm|yolo\/detect)/.test(String(u))) ? macroFetch(u, { signal: macro.ctrl.signal, ...o }) : macroFetch(u, o);

const macroMatch = (s, it) => !it.locked && (!s.label || s.label === 'any' || it.label === s.label);

async function macroItems(s, c, field, fn) {
  const todo = sceneData.items.filter(it => macroMatch(s, it) && (s.scope !== 'empty' || (field === 'caption' ? !it.caption?.trim() : field === 'text' ? !it.text?.trim() : !it.tags?.length)));
  for (const [k, it] of todo.entries()) {
    if (macro.stop) throw new Error('Interrupted');
    llmStatus(`\u23f3 Box ${k + 1}/${todo.length}\u2026`);
    await fn(it, c.img, c.alive);
  }
}

const MACRO_STEPS = {
  yolo: { name: '\ud83c\udfaf Boxes (YOLO)', run: (s, c) => yoloDetectCore(c.img, c.alive, null, false) },
  yolo_kw: { name: '\ud83d\udd24 Keywords (YOLO)', kw: true, run: (s, c) => {
    const k = yoloKeywords(s.keywords || '');
    if (!k.length) throw new Error('A Keywords (YOLO) step has no keywords.');
    return yoloDetectCore(c.img, c.alive, k, false);
  } },
  detect_llm: { name: '\ud83e\udd16 Boxes (LLM)', run: (s, c) => llmDetect(c.img, c.alive) },
  clear: { name: '\ud83d\uddd1 Remove boxes', label: true, run: s => { recordState(); sceneData.items = sceneData.items.filter(it => !macroMatch(s, it)); clearSelection(); renderAll(); } },
  scene_caption: { name: '\ud83d\udcdd Scene caption', run: (s, c) => llmSummaryCaption(c.img, c.alive) },
  scene_tags: { name: '\ud83c\udff7 Scene tags', run: (s, c) => llmSummaryTags(c.img, c.alive) },
  palette: { name: '\ud83c\udfa8 Palette', run: (s, c) => llmPalette(c.img, c.alive) },
  item_caption: { name: '\ud83d\udcdd Box captions', label: true, scope: true, run: (s, c) => macroItems(s, c, 'caption', llmItemCaption) },
  item_tags: { name: '\ud83c\udff7 Box tags', label: true, scope: true, run: (s, c) => macroItems(s, c, 'tags', llmItemTags) },
  item_text: { name: '🔠 Box text (OCR)', scope: true, run: (s, c) => macroItems({ ...s, label: 'text' }, c, 'text', llmItemText) }
};

const macroLabel = t => { const b = $('macro-stop'); if (b && !macro.stop) b.textContent = `\u23f9 Interrupt (${t})`; };

async function macroImage(steps, tag) { // runs the steps on the open image
  const scene = sceneData;
  const img = await llmImage();
  llmCur = img;
  const c = { img, alive: () => { if (sceneData !== scene) throw new Error('The image changed.'); } };
  for (const [n, s] of steps.entries()) {
    if (macro.stop) throw new Error('Interrupted');
    macroLabel(`${tag}step ${n + 1}/${steps.length}`);
    llmStatus(`\u25b6 ${MACRO_STEPS[s.type].name}\u2026`);
    try { await MACRO_STEPS[s.type].run(s, c); }
    catch (e) { if (macro.stop || !/found nothing|No boxes detected/.test(e.message)) throw e; } // finding no boxes is not a failure
  }
}

async function macroRun() {
  if (macro.running || llmBusy) return showToast('\u26a0\ufe0f Something is already running.', 'warn');
  const steps = macroCfg.steps.filter(s => s.enabled !== false && MACRO_STEPS[s.type]);
  if (!steps.length) return showToast('\u26a0\ufe0f The macro has no enabled steps. Open the macro settings.', 'warn');
  const multi = ds.active && ds.sel.size > 1;
  const targets = multi ? [...ds.sel].sort((a, b) => a - b) : [null];
  Object.assign(macro, { running: true, stop: false, ctrl: new AbortController() });
  llmBusy = true;
  const stopBtn = Object.assign(document.createElement('button'), { id: 'macro-stop', className: 'macro-stop', textContent: '\u23f9 Interrupt', onclick: macroInterrupt });
  document.body.appendChild(stopBtn);
  let done = 0, failed = 0;
  try {
    for (let k = 0; k < targets.length && !macro.stop; k++) {
      const i = targets[k], tag = multi ? `image ${k + 1}/${targets.length} \u00b7 ` : '';
      if (multi) {
        macroLabel(`image ${k + 1}/${targets.length}`);
        await selectDatasetImage(i, ds.filtered ? undefined : i);
        if (ds.index !== i) { failed++; continue; }
      }
      try { await macroImage(steps, tag); done++; }
      catch (e) { if (macro.stop) break; failed++; showToast(`\u26a0\ufe0f ${multi ? `Image ${k + 1}: ` : ''}${e.message}`, 'warn'); }
    }
  } finally {
    macro.running = false;
    llmBusy = false;
    stopBtn.remove();
    await flushSave();
    datasetSaveSoon(); // an aborted request must not leave the last edit unsaved
  }
  const msg = macro.stop ? `\u23f9 Interrupted after ${done} of ${targets.length} image(s)` : `\u2714 Macro finished: ${done} done${failed ? `, ${failed} failed` : ''}`;
  llmStatus(msg);
  showToast(msg, macro.stop || failed ? 'warn' : 'info');
}

function macroInterrupt() {
  macro.stop = true;
  macro.ctrl?.abort();
  const b = $('macro-stop');
  if (b) b.textContent = 'Stopping\u2026';
}

/* ---- Settings popup ---- */
function macroOpenSettings() {
  if (!$('macro-modal')) {
    document.body.insertAdjacentHTML('beforeend', `<div id="macro-modal" class="llm-modal"><div class="llm-dialog">
      <h3>\u25b6 Macro</h3>
      <p class="llm-hint">The steps run from top to bottom on the open image, or one image after another on all selected images (Ctrl+click or Shift+click in the image list). A detection step that finds nothing does not stop the macro; any other error skips the rest of that image. Example: Keywords (YOLO) "person", then Scene caption, then Box captions for character boxes.</p>
      <div id="macro-steps"></div>
      <div class="llm-row"><select id="macro-add">${Object.entries(MACRO_STEPS).map(([k, d]) => `<option value="${k}">${d.name}</option>`).join('')}</select>
        <button class="btn" onclick="macroAdd()">\uff0b Add step</button><button class="btn" onclick="macroCfg.steps = clone(MACRO_DEFAULT); macroSave(); macroRender();">Reset defaults</button>
        <span style="flex:1"></span><button class="btn" onclick="$('macro-modal').style.display='none'">Close</button></div>
    </div></div>`);
    $('macro-modal').addEventListener('change', e => {
      const t = e.target, s = macroCfg.steps[+t.dataset.i];
      if (!s || !t.dataset.k) return;
      s[t.dataset.k] = t.type === 'checkbox' ? t.checked : t.value;
      macroSave();
    });
    $('macro-modal').addEventListener('click', e => {
      const b = e.target.closest('[data-act]'), a = macroCfg.steps;
      if (!b) return;
      const i = +b.dataset.i;
      if (b.dataset.act === 'del') a.splice(i, 1);
      else {
        const j = i + (b.dataset.act === 'up' ? -1 : 1);
        if (j < 0 || j >= a.length) return;
        [a[i], a[j]] = [a[j], a[i]];
      }
      macroSave();
      macroRender();
    });
  }
  macroRender();
  $('macro-modal').style.display = 'flex';
}

function macroAdd() {
  macroCfg.steps.push({ type: $('macro-add').value, scope: 'all', label: 'any', keywords: '' });
  macroSave();
  macroRender();
}

function macroRender() {
  const sel = (i, k, opts, v) => `<select data-i="${i}" data-k="${k}">${opts.map(([val, txt]) => `<option value="${val}" ${val === v ? 'selected' : ''}>${txt}</option>`).join('')}</select>`;
  $('macro-steps').innerHTML = macroCfg.steps.map((s, i) => {
    const d = MACRO_STEPS[s.type];
    if (!d) return '';
    return `<div class="macro-step"><input type="checkbox" data-i="${i}" data-k="enabled" title="Enabled" ${s.enabled !== false ? 'checked' : ''}><b>${i + 1}. ${d.name}</b>`
      + (d.kw ? `<input type="text" data-i="${i}" data-k="keywords" value="${escapeHtml(s.keywords || '')}" placeholder="person, red car">` : '')
      + (d.scope ? sel(i, 'scope', [['all', 'all boxes'], ['empty', 'only empty']], s.scope || 'all') : '')
      + (d.label ? sel(i, 'label', ['any', 'character', 'object', 'text'].map(l => [l, l === 'any' ? 'any label' : l]), s.label || 'any') : '')
      + `<span style="flex:1"></span><button class="btn" data-act="up" data-i="${i}">\u2191</button><button class="btn" data-act="down" data-i="${i}">\u2193</button><button class="btn" data-act="del" data-i="${i}">\u2715</button></div>`;
  }).join('') || '<span class="llm-hint">No steps yet. Add one below.</span>';
}
