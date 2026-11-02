/* LLM auto-annotation: boxes, captions and tags through an OpenAI-compatible chat endpoint.
   Requests go through server.py (/api/llm) so the browser never hits CORS limits. */

const LLM_DEFAULT_URL = 'http://localhost:1234/v1/chat/completions';
const LLM_DEFAULT_TEMPLATE = {
  model: 'local-model', temperature: 0.2, max_tokens: 1024,
  messages: [
    { role: 'system', content: '{{system}}' },
    { role: 'user', content: [{ type: 'text', text: '{{prompt}}' }, { type: 'image_url', image_url: { url: '{{image}}' } }, { type: 'image_url', image_url: { url: '{{crop}}' } }] }
  ]
};
const LLM_DEFAULT_PROMPTS = {
  system: 'You are an image annotation assistant. Follow the requested output format exactly and output nothing else.',
  bbox_scale: 1000, // 1000 = coordinates normalized to 0-1000, 0 = pixels of the image that is sent
  max_image_side: 1280,
  detect: 'Detect every distinct character (person or creature), object and visible text region in this {{width}}x{{height}} image. Return ONLY a JSON array: [{"label":"character|object|text","bbox":[x1,y1,x2,y2],"text":"literal text, only when label is text"}]. Coordinates are integers; x1,y1 is the top-left corner and x2,y2 the bottom-right corner.',
  scene_caption: 'Write one comprehensive paragraph describing the whole image as a scene: overall subject and what happens, atmosphere, visual style (for example photorealistic, anime, watercolor), camera perspective and framing, lighting and composition. The characters, objects and text listed in the context are annotated separately with their own detailed captions, so mention them only briefly (what they are and where they are or how they relate) and do not describe their appearance in detail or repeat their captions. Already annotated context (keep it consistent):\n{{context}}\nOutput only the description.',
  scene_tags: 'List 1-3 tags for the medium or format of this image only (for example: photograph, illustration, poster, 3D render, screenshot). Do not include visual styles such as photorealistic, anime or watercolor. Context:\n{{context}}\nReturn ONLY a JSON array of strings.',
  palette: 'List the 5 dominant colors of this image as hex codes. Return ONLY a JSON array such as ["#aabbcc"].',
  item_caption: 'You get two images. Image 1 is the full scene, given only as context. Image 2 is a crop of ONE {{label}} cut from that scene, and it is the only thing to caption. Describe only what is visible on the {{label}} itself: appearance, shape, colors, materials, clothing, pose and details. Do not describe perspective, camera angle, framing, cropping, scene lighting or composition, and never use phrases such as "close-up", "cropped", "partial view" or "in the image": those belong to the scene caption, not to an element. Do not describe the surroundings or other elements. The scene caption in the context already covers the overall scene: do not copy or paraphrase its sentences, write the caption from what you see in image 2. Start directly with the subject (for example "A woman in a red coat holding an umbrella") and never mention "image", "crop", "target" or "element". Element data:\n{{target}}\nScene context, for reference only (never copy it):\n{{context}}\nOutput only the caption text.',
  item_tags: 'You get two images. Image 1 is the full scene, given only as context. Image 2 is a crop of ONE {{label}} cut from that scene, and it is the only thing to tag. List 3-8 short descriptive tags for what is visible inside image 2 only, ignoring the surroundings and other elements. Do not use tags about perspective, framing or camera (such as close-up). Element data:\n{{target}}\nScene context, for reference only:\n{{context}}\nReturn ONLY a JSON array of strings.',
  image_type: 'Which single category best describes this image? Options: {{options}}. Return ONLY the option text, nothing else.',
  review: 'Review a response against the instructions it was given. You also get the same image(s). Instructions:\n"""\n{{instructions}}\n"""\nResponse:\n"""\n{{response}}\n"""\nDoes the response follow ALL of the instructions (required format, content limits, forbidden phrases and topics)? Return ONLY JSON: {"ok": true or false, "issues": "short list of the violated instructions, empty when ok"}.'
};

const llmCfg = (() => { try { return JSON.parse(localStorage.getItem('llm_cfg')) || {}; } catch { return {}; } })();
llmCfg.url ||= LLM_DEFAULT_URL;
llmCfg.template ||= clone(LLM_DEFAULT_TEMPLATE);
if (llmCfg.v !== 6) { // v6: box prompts avoid perspective and scene-caption duplication
  llmCfg.prompts = {};
  llmCfg.v = 6;
  if (!JSON.stringify(llmCfg.template).includes('{{crop}}')) llmCfg.template.messages?.findLast(m => Array.isArray(m.content))?.content.push({ type: 'image_url', image_url: { url: '{{crop}}' } });
}
llmCfg.prompts = { ...LLM_DEFAULT_PROMPTS, ...llmCfg.prompts };
llmCfg.timeout ||= 30;
llmCfg.retries ??= 2;
const llmSave = () => { try { localStorage.setItem('llm_cfg', JSON.stringify(llmCfg)); } catch { /* storage unavailable */ } };
$('llm-url').value = llmCfg.url;
$('llm-url').onchange = e => { llmCfg.url = e.target.value.trim() || LLM_DEFAULT_URL; llmSave(); };
// Hint: the companion field (tags for a caption request, caption for a tags request) is added as extra context
// (toggle: LLM request settings popup)
const llmHint = (what, val) => (llmCfg.hint && val?.length) ? `Existing ${what} (hint only, keep your answer consistent with it): ${JSON.stringify(val)}` : '';

/* ---- Request building ---- */
const fillText = (s, v) => s.replace(/\{\{(\w+)\}\}/g, (m, k) => v[k] ?? m);
const fillDeep = (o, v) => typeof o === 'string' ? fillText(o, v)
  : Array.isArray(o) ? o.filter(x => v.crop !== undefined || !(x === '{{crop}}' || x?.image_url?.url === '{{crop}}')).map(x => fillDeep(x, v)) // no crop: drop the crop entry
  : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, x]) => [k, fillDeep(x, v)])) : o;

function llmPrompt(task, vars, cfg = llmCfg) { // the exact prompt text of a task: special instructions and hint included
  const p = cfg.prompts[task], extra = [];
  const text = fillText(p, { width: sceneData.width, height: sceneData.height, special: cfg.special || '', ...vars });
  if (task !== 'review' && cfg.special?.trim() && !p.includes('{{special}}')) extra.push(`Special instructions from the user about this dataset (always follow them):\n${cfg.special.trim()}`);
  if (vars.hint && !p.includes('{{hint}}')) extra.push(vars.hint);
  return [text, ...extra].join('\n\n');
}

function llmBody(task, vars, image, cfg = llmCfg, crop) {
  const p = cfg.prompts;
  const prompt = llmPrompt(task, vars, cfg);
  return fillDeep(cfg.template, { system: p.system, prompt, image, crop });
}

let llmBusy = false, llmCur = { w: 1, h: 1 }; // llmCur = size of the image being sent
const llmStatus = t => { $('llm-status').textContent = t; };

const llmBox = b => { // canvas pixels -> model coordinates
  const sc = llmCfg.prompts.bbox_scale, W = sceneData.width, H = sceneData.height;
  return b.map((v, i) => Math.round(sc ? v / (i % 2 ? H : W) * sc : v * (i % 2 ? llmCur.h / H : llmCur.w / W)));
};
const llmUnbox = b => { // model coordinates -> canvas pixels
  const sc = llmCfg.prompts.bbox_scale, W = sceneData.width, H = sceneData.height;
  return b.map((v, i) => Math.round(sc ? v / sc * (i % 2 ? H : W) : v * (i % 2 ? H / llmCur.h : W / llmCur.w)));
};

function llmElem(it) {
  const o = { label: it.label, bbox: llmBox(it.bbox) };
  if (it.text) o.text = it.text;
  if (it.caption) o.caption = it.caption;
  if (it.tags?.length) o.tags = it.tags;
  return o;
}

function llmContext(skip, withScene = true) { // summary + other objects/characters/text boxes (withScene=false for scene-level requests)
  const s = sceneData.summary, o = {};
  if (withScene && s.caption) o.scene_caption = s.caption;
  if (withScene && s.meta.length) o.scene_tags = s.meta;
  const els = sceneData.items.filter(i => i !== skip).map(llmElem);
  if (els.length) o.elements = els;
  return JSON.stringify(o);
}

async function llmImage() {
  if (!backgroundImageDataUrl) throw new Error('Load an image first.');
  const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read the image.')); i.src = backgroundImageDataUrl; });
  const k = Math.min(1, (llmCfg.prompts.max_image_side || 1280) / Math.max(im.naturalWidth, im.naturalHeight));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(im.naturalWidth * k), height: Math.round(im.naturalHeight * k) });
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  return { url: c.toDataURL('image/jpeg', 0.92), w: c.width, h: c.height, el: im };
}

function llmCrop(it, img) { // only the pixels strictly inside the box, so nothing outside it can be described
  const im = img.el, sx = im.naturalWidth / sceneData.width, sy = im.naturalHeight / sceneData.height;
  const [x1, y1, x2, y2] = it.bbox, cw = Math.max(1, Math.round((x2 - x1) * sx)), ch = Math.max(1, Math.round((y2 - y1) * sy));
  const k = Math.min(1, (llmCfg.prompts.max_image_side || 1280) / Math.max(cw, ch));
  const c = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(cw * k)), height: Math.max(1, Math.round(ch * k)) });
  c.getContext('2d').drawImage(im, x1 * sx, y1 * sy, cw, ch, 0, 0, c.width, c.height);
  return { url: c.toDataURL('image/jpeg', 0.92), w: c.width, h: c.height };
}

/* ---- Response parsing ---- */
const llmClean = t => t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().replace(/^```\w*\n?|\n?```$/g, '').trim();
function llmJson(t) {
  const m = t.match(/[\[{][\s\S]*[\]}]/);
  if (!m) throw new Error('The LLM did not return JSON.');
  return JSON.parse(m[0]);
}
const llmList = t => { const a = llmJson(t); return (Array.isArray(a) ? a : []).map(x => String(x).trim()).filter(Boolean); };

let llmPending = 0;
const llmSpin = d => { llmPending += d; $('llm-spinner').style.display = llmPending > 0 ? 'inline-block' : 'none'; };
const llmStripLead = s => { s = s.replace(/^the (target )?(element|object|character|text|subject) (here )?(is|shows|depicts|appears to be|features)\s+/i, ''); return s.charAt(0).toUpperCase() + s.slice(1); };

const LLM_REVIEWED = new Set(['scene_caption', 'scene_tags', 'item_caption', 'item_tags']);

async function llmReview(task, vars, answer, img, crop) { // the model checks its own answer against the instructions
  const r = await llmSend('review', { instructions: llmPrompt(task, vars), response: answer }, img, crop);
  try { const v = llmJson(r); return { ok: v.ok === true || v.ok === 'true', issues: String(v.issues || '') }; } catch { return { ok: true, issues: '' }; }
}

async function llmAsk(task, vars, img, crop) { // with Auto-review: generate, review, retry up to llmCfg.retries times
  const retries = llmCfg.review && LLM_REVIEWED.has(task) ? llmCfg.retries : 0;
  let v = vars;
  for (let n = 0; ; n++) {
    const t = await llmSend(task, v, img, crop);
    if (n >= retries) return t;
    llmStatus('🔍 Reviewing…');
    const verdict = await llmReview(task, vars, t, img, crop);
    if (verdict.ok) return t;
    llmStatus(`↻ Retry ${n + 1}/${retries}…`);
    v = { ...vars, hint: [vars.hint, `Your previous answer was rejected by a review (${verdict.issues || 'it did not follow the instructions'}). Previous answer: "${t}". Answer again and follow every instruction.`].filter(Boolean).join('\n\n') };
  }
}

async function llmSend(task, vars, img, crop) {
  llmSpin(1);
  try {
    const r = await api('/api/llm', jsonOpts('POST', JSON.stringify({ url: llmCfg.url, timeout: llmCfg.timeout, body: llmBody(task, vars, img.url, llmCfg, crop?.url) })));
    const t = r.choices?.[0]?.message?.content;
    if (typeof t !== 'string') throw new Error('Unexpected response from the LLM server.');
    return llmClean(t);
  } finally { llmSpin(-1); }
}

/* ---- Steps (each overwrites only its own field) ---- */
const llmSet = fn => { recordState(); fn(); renderAll(); };

async function llmSummaryCaption(img, alive) {
  const t = await llmAsk('scene_caption', { context: llmContext(null, false), hint: llmHint('medium tags of this image', sceneData.summary.meta) }, img);
  alive();
  llmSet(() => { sceneData.summary.caption = t; });
}
async function llmSummaryTags(img, alive) {
  const list = llmList(await llmAsk('scene_tags', { context: llmContext(null, false), hint: llmHint('caption of this image', sceneData.summary.caption) }, img));
  alive();
  llmSet(() => { sceneData.summary.meta = list; });
}
async function llmPalette(img, alive) {
  const hex = llmList(await llmAsk('palette', {}, img)).map(h => h.match(/#[0-9a-f]{6}/i)?.[0].toLowerCase()).filter(Boolean);
  alive();
  if (!hex.length) throw new Error('The LLM returned no valid hex colors.');
  llmSet(() => { sceneData.summary.palette = hex.map(h => `${getClosestColorName(h)} ${h}`); });
}
const llmTarget = it => JSON.stringify((({ caption, tags, bbox, ...rest }) => rest)(llmElem(it)));
async function llmItemCaption(it, img, alive) {
  const t = llmStripLead(await llmAsk('item_caption', { label: it.label, target: llmTarget(it), context: llmContext(it), hint: llmHint('tags of this element', it.tags) }, img, llmCrop(it, img)));
  alive();
  if (sceneData.items.includes(it)) llmSet(() => { it.caption = t; });
}
async function llmItemTags(it, img, alive) {
  const list = llmList(await llmAsk('item_tags', { label: it.label, target: llmTarget(it), context: llmContext(it), hint: llmHint('caption of this element', it.caption) }, img, llmCrop(it, img)));
  alive();
  if (sceneData.items.includes(it)) llmSet(() => { it.tags = list; });
}

async function llmDetect(img, alive) {
  const parsed = llmJson(await llmAsk('detect', {}, img));
  alive();
  const list = Array.isArray(parsed) ? parsed : parsed.items || parsed.boxes || [];
  const made = [];
  for (const o of list) {
    const raw = (o.bbox || o.bbox_2d || []).map(Number);
    if (raw.length !== 4 || !raw.every(Number.isFinite)) continue;
    const [a, b, c, d] = llmUnbox(raw), W = sceneData.width, H = sceneData.height;
    const bbox = [clamp(Math.min(a, c), 0, W), clamp(Math.min(b, d), 0, H), clamp(Math.max(a, c), 0, W), clamp(Math.max(b, d), 0, H)];
    if (bbox[2] - bbox[0] < 2 || bbox[3] - bbox[1] < 2) continue;
    const label = LABELS[o.label] ? o.label : 'object';
    const it = { label, caption: '', bbox, tags: [] };
    if (label === 'text') it.text = String(o.text || '');
    attachEditorProperties(it);
    made.push(it);
  }
  if (!made.length) throw new Error('No boxes detected.');
  llmSet(() => sceneData.items.push(...made));
  return made;
}

/* ---- Entry points ---- */
async function llmRun(fn) {
  if (llmBusy) return showToast('⚠️ An LLM request is already running.', 'warn');
  llmBusy = true;
  const scene = sceneData;
  try {
    const img = await llmImage();
    llmCur = img;
    await fn(img, () => { if (sceneData !== scene) throw new Error('The image changed. Stopped.'); });
    llmStatus('✔ Done');
  } catch (e) { llmStatus('✖ ' + e.message); showToast('⚠️ ' + e.message, 'warn'); }
  finally { llmBusy = false; }
}

const llmFull = () => llmRun(async (img, alive) => {
  if (sceneData.items.length && !confirm(`This image already has ${sceneData.items.length} box(es). Detect and add more boxes?`)) return llmStatus('');
  llmStatus('⏳ Detecting boxes…');
  const made = await llmDetect(img, alive);
  llmStatus('⏳ Scene caption…'); await llmSummaryCaption(img, alive);
  llmStatus('⏳ Scene tags…'); await llmSummaryTags(img, alive);
  llmStatus('⏳ Palette…'); await llmPalette(img, alive);
  for (const [k, it] of made.entries()) {
    llmStatus(`⏳ Element ${k + 1}/${made.length}…`);
    await llmItemCaption(it, img, alive);
    await llmItemTags(it, img, alive);
  }
});

const llmEmpty = () => llmRun(async (img, alive) => {
  const todo = sceneData.items.filter(it => !it.locked && (!it.caption?.trim() || !it.tags?.length));
  if (!todo.length) return llmStatus('Nothing to fill: every unlocked element has a caption and tags.');
  for (const [k, it] of todo.entries()) {
    llmStatus(`⏳ Element ${k + 1}/${todo.length}…`);
    if (!it.caption?.trim()) await llmItemCaption(it, img, alive);
    if (!it.tags?.length) await llmItemTags(it, img, alive);
  }
});

function llmField(key) { // 'summary.caption' | 'summary.meta' | 'summary.palette' | 'item.<idx>.caption' | 'item.<idx>.tags'
  const [scope, a, b] = key.split('.');
  const it = scope === 'item' ? sceneData.items[+a] : null;
  if (scope === 'item' && (!it || it.locked)) return;
  llmStatus(`⏳ ${key}…`);
  return llmRun((img, alive) => {
    if (it) return b === 'caption' ? llmItemCaption(it, img, alive) : llmItemTags(it, img, alive);
    return { caption: llmSummaryCaption, meta: llmSummaryTags, palette: llmPalette }[a](img, alive);
  });
}

/* ---- Settings popup: editable template + prompts, with an exact preview ---- */
function llmOpenSettings() {
  if (!$('llm-modal')) {
    document.body.insertAdjacentHTML('beforeend', `<div id="llm-modal" class="llm-modal"><div class="llm-dialog">
      <h3>⚙️ Settings</h3>
      <div class="llm-row"><button class="btn" id="tabbtn-llm" onclick="llmTab('llm')">LLM request</button><button class="btn" id="tabbtn-yolo" onclick="llmTab('yolo')">🎯 Ultralytics detector</button></div>
      <div id="llm-tab-llm" style="display:flex; flex-direction:column; gap:6px;">
      <p class="llm-hint">Each request is POSTed to the server address by server.py. Template placeholders: <code>{{system}}</code> <code>{{prompt}}</code> <code>{{image}}</code> <code>{{crop}}</code> (box requests only, dropped otherwise). Prompt placeholders: <code>{{width}}</code> <code>{{height}}</code> <code>{{label}}</code> <code>{{target}}</code> <code>{{context}}</code>.</p>
      <label>Special instructions (theme of the dataset or unusual concepts the model may not recognize; added to every request)</label><textarea id="llm-special" rows="4" spellcheck="false" style="white-space:pre-wrap;" placeholder="Example: This dataset shows hand-drawn tarot cards. Name the cards by their traditional titles."></textarea>
      <label>Timeout (seconds to wait for each response)</label><input id="llm-timeout" type="number" min="1" step="1" style="width:90px;">
      <label>Auto-review: the model checks each caption/tags answer against its instructions and retries when it does not comply</label>
      <div class="llm-row"><label class="btn" style="margin:0;" title="Send the companion field as extra context: tags when asking for a caption, caption when asking for tags"><input type="checkbox" id="llm-hint"> Hint</label><label class="btn" style="margin:0;"><input type="checkbox" id="llm-review"> Auto-review</label><label style="margin:0;">Retries <input id="llm-retries" type="number" min="0" max="10" step="1" style="width:60px;"></label></div>
      <label>Request body template (JSON)</label><textarea id="llm-tpl" rows="12" spellcheck="false"></textarea>
      <label>Prompts and settings (JSON)</label><textarea id="llm-prm" rows="12" spellcheck="false"></textarea>
      <label>Preview: example requests for the scene caption and, if the image has boxes, the first box caption (image data shortened)</label>
      <textarea id="llm-prev" rows="10" readonly spellcheck="false"></textarea>
      <div class="llm-row"><button class="btn" onclick="llmPreview()">🔄 Refresh preview</button><button class="btn" onclick="llmFill(LLM_DEFAULT_TEMPLATE, LLM_DEFAULT_PROMPTS, 30, false, 2, false, '')">Reset defaults</button><span style="flex:1"></span><button class="btn" onclick="llmApply()">💾 Save</button><button class="btn" onclick="$('llm-modal').style.display='none'">Close</button></div>
      </div>
      <div id="llm-tab-yolo" style="display:none; flex-direction:column; gap:6px;"></div>
    </div></div>`);
  }
  llmFill(llmCfg.template, llmCfg.prompts, llmCfg.timeout, llmCfg.review, llmCfg.retries, llmCfg.hint, llmCfg.special);
  $('llm-modal').style.display = 'flex';
  llmTab('llm');
}

function llmTab(t) { // settings popup tabs: LLM request / Ultralytics detector
  $('llm-tab-llm').style.display = t === 'llm' ? 'flex' : 'none';
  $('llm-tab-yolo').style.display = t === 'yolo' ? 'flex' : 'none';
  for (const k of ['llm', 'yolo']) $(`tabbtn-${k}`).style.background = k === t ? 'var(--bg-card-hover)' : '';
  if (t === 'yolo') yoloOpenSettings();
}

function llmFill(tpl, prm, timeout, review, retries, hint, special) {
  $('llm-special').value = special || '';
  $('llm-hint').checked = !!hint;
  $('llm-review').checked = !!review;
  $('llm-retries').value = retries;
  $('llm-timeout').value = timeout;
  $('llm-tpl').value = JSON.stringify(tpl, null, 2);
  $('llm-prm').value = JSON.stringify(prm, null, 2);
  llmPreview();
}

function llmRead() {
  const template = JSON.parse($('llm-tpl').value), prompts = JSON.parse($('llm-prm').value);
  if (!template || typeof template !== 'object' || !Array.isArray(template.messages)) throw new Error('Template must be an object with a "messages" array.');
  return { url: $('llm-url').value, template, prompts: { ...LLM_DEFAULT_PROMPTS, ...prompts }, timeout: Math.max(1, parseFloat($('llm-timeout').value) || 30), special: $('llm-special').value.trim(), hint: $('llm-hint').checked, review: $('llm-review').checked, retries: clamp(parseInt($('llm-retries').value, 10) || 0, 0, 10) };
}

function llmPreviewItem(cfg) {
  const it = sceneData.items[0];
  if (!it) return '';
  const body = llmBody('item_caption', { label: it.label, target: llmTarget(it), context: llmContext(it), hint: llmHint('tags of this element', it.tags) }, 'data:image/jpeg;base64,<full image data>', cfg, 'data:image/jpeg;base64,<crop data>');
  return `\n\n----- element caption (first box) -----\n${JSON.stringify(body, null, 2)}`;
}

function llmPreview() {
  try {
    const cfg = llmRead(), saved = llmCfg.prompts, savedHint = llmCfg.hint;
    llmCfg.hint = cfg.hint; // the preview follows the popup's current toggle
    llmCfg.prompts = cfg.prompts; // llmBox/llmContext read the prompts settings
    llmCur = { w: sceneData.width, h: sceneData.height };
    try { $('llm-prev').value = `POST ${cfg.url} (timeout ${cfg.timeout} s)\n\n${JSON.stringify(llmBody('scene_caption', { context: llmContext(null, false), hint: llmHint('medium tags of this image', sceneData.summary.meta) }, 'data:image/jpeg;base64,<image data>', cfg), null, 2)}${llmPreviewItem(cfg)}`; }
    finally { llmCfg.prompts = saved; llmCfg.hint = savedHint; }
  } catch (e) { $('llm-prev').value = '⚠ ' + e.message; }
}

function llmApply() {
  try {
    const cfg = llmRead();
    Object.assign(llmCfg, { template: cfg.template, prompts: cfg.prompts, timeout: cfg.timeout, special: cfg.special, hint: cfg.hint, review: cfg.review, retries: cfg.retries });
    llmSave();
    $('llm-modal').style.display = 'none';
    showToast('✅ LLM settings saved.', 'info');
  } catch (e) { showToast('⚠️ ' + e.message, 'warn'); }
}
