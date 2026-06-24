'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  config: null,
  text: '',
  spans: [],        // spans[offset] = <span class="ch"> (null for newlines)
  editing: false,
  ocrBusy: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3400);
}

function setStatus(el, html) {
  if (html == null) { el.hidden = true; el.innerHTML = ''; }
  else { el.hidden = false; el.innerHTML = html; }
}
const spinner = (text) => `<span class="spinner"></span><span>${escapeHtml(text)}</span>`;

function cleanJp(text) {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/([^\x00-\x7F])\s+(?=[^\x00-\x7F])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderFurigana(tokens) {
  let html = '';
  for (const t of tokens) {
    for (const part of t.ruby) {
      html += part.rt
        ? `<ruby>${escapeHtml(part.base)}<rt>${escapeHtml(part.rt)}</rt></ruby>`
        : escapeHtml(part.base);
    }
  }
  return html;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
async function loadConfig() {
  try { state.config = await (await fetch('/api/config')).json(); }
  catch { state.config = { serverOcr: false, ocrEngine: null, googleTranslate: false }; }
  const badge = $('engine');
  const names = { 'apple-vision': 'Apple Vision OCR', 'google-vision': 'Google Vision OCR' };
  const ocr = names[state.config.ocrEngine] || 'On-device OCR';
  badge.textContent = state.config.googleTranslate ? ocr + ' + Translate' : ocr;
  if (state.config.ocrEngine) badge.classList.add('on');
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------
function fileToDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
function shrinkDataURL(dataURL, maxDim = 2200) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      if (scale === 1) return resolve(dataURL);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => resolve(dataURL);
    img.src = dataURL;
  });
}

let tessWorker = null;
async function tesseractOcr(dataURL) {
  if (typeof Tesseract === 'undefined') throw new Error('OCR library failed to load');
  if (!tessWorker) {
    setStatus($('ocr-status'), spinner('Loading Japanese OCR model (first run, ~15 MB)…'));
    tessWorker = await Tesseract.createWorker('jpn', 1, {
      logger: (m) => { if (m.status === 'recognizing text') setStatus($('ocr-status'), spinner(`Reading… ${Math.round(m.progress * 100)}%`)); },
    });
  }
  setStatus($('ocr-status'), spinner('Reading text…'));
  const { data } = await tessWorker.recognize(dataURL);
  return data.text || '';
}

async function runOcr(dataURL) {
  if (state.config && state.config.serverOcr) {
    const label = state.config.ocrEngine === 'apple-vision' ? 'Apple Vision' : 'Google Vision';
    setStatus($('ocr-status'), spinner(`Reading text with ${label}…`));
    try {
      const res = await fetch('/api/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataURL }) });
      if (res.ok) { const j = await res.json(); if (!j.needFallback) return j.text || ''; }
      else { const j = await res.json().catch(() => ({})); toast(`${label} failed, using on-device OCR. ` + (j.error || '')); }
    } catch (e) { toast(`${label} unreachable, using on-device OCR.`); }
  }
  return tesseractOcr(dataURL);
}

async function handleFile(file) {
  if (!file || state.ocrBusy) return;
  state.ocrBusy = true;
  try {
    const raw = await fileToDataURL(file);
    $('preview').src = raw;
    $('preview-wrap').hidden = false;

    const small = await shrinkDataURL(raw);
    let text = cleanJp(await runOcr(small));

    setStatus($('ocr-status'), null);
    $('capture-card').classList.add('compact');
    $('reader-card').hidden = false;
    setReaderText(text);

    if (!text) toast('No text detected. Try a sharper, closer photo — or tap Edit to type it.');
    else $('reader-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    setStatus($('ocr-status'), null);
    toast('OCR error: ' + err.message);
  } finally {
    state.ocrBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Reader rendering
// ---------------------------------------------------------------------------
function setReaderText(text) {
  state.text = text;
  const reader = $('reader');
  reader.innerHTML = '';
  state.spans = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') { frag.appendChild(document.createElement('br')); state.spans[i] = null; continue; }
    const span = document.createElement('span');
    span.className = 'ch';
    span.dataset.off = i;
    span.textContent = ch;
    state.spans[i] = span;
    frag.appendChild(span);
  }
  reader.appendChild(frag);
}

// ---------------------------------------------------------------------------
// Custom selection + floating bubbles
// ---------------------------------------------------------------------------
const sel = { active: false, deciding: false, touchId: null, startX: 0, startY: 0, startOff: null, a: -1, b: -1, lastA: -1, lastB: -1, current: '' };

function charFromPoint(x, y) {
  let parent = null;
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) { const n = r.startContainer; parent = n.nodeType === 3 ? n.parentElement : n; }
  } else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) { const n = p.offsetNode; parent = n.nodeType === 3 ? n.parentElement : n; }
  }
  if (parent && parent.classList && parent.classList.contains('ch')) return +parent.dataset.off;
  const el = document.elementFromPoint(x, y);
  if (el && el.classList && el.classList.contains('ch')) return +el.dataset.off;
  return null;
}

function clearHighlight() {
  if (sel.lastA < 0) return;
  for (let i = sel.lastA; i <= sel.lastB; i++) {
    const s = state.spans[i];
    if (s) s.classList.remove('sel', 'sel-start', 'sel-end');
  }
  sel.lastA = sel.lastB = -1;
}

function applyHighlight(a, b) {
  if (a === sel.lastA && b === sel.lastB) return;
  clearHighlight();
  for (let i = a; i <= b; i++) { const s = state.spans[i]; if (s) s.classList.add('sel'); }
  if (state.spans[a]) state.spans[a].classList.add('sel-start');
  if (state.spans[b]) state.spans[b].classList.add('sel-end');
  sel.lastA = a; sel.lastB = b;
}

function selectionRect(a, b) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let i = a; i <= b; i++) {
    const s = state.spans[i];
    if (!s) continue;
    const r = s.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    left = Math.min(left, r.left); top = Math.min(top, r.top);
    right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
  }
  if (left === Infinity) return null;
  return { left, top, right, bottom, cx: (left + right) / 2 };
}

function placeBubble(el, cx, desiredTop) {
  const vw = window.innerWidth, vh = window.innerHeight, margin = 8;
  const w = el.offsetWidth, h = el.offsetHeight;
  const left = Math.max(margin, Math.min(Math.round(cx - w / 2), vw - w - margin));
  const top = Math.round(Math.max(margin, Math.min(desiredTop, vh - h - margin)));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

// Stack both bubbles above the phrase: [ translation ] / [ furigana ] / phrase.
// If there isn't room above, stack below — translation still just above furigana.
function positionBubbles(a, b) {
  const rect = selectionRect(a, b);
  if (!rect) return;
  const furi = $('bubble-furi'), trans = $('bubble-trans');
  const gap = 10, pair = 8, margin = 8;
  const fH = furi.offsetHeight, tH = trans.offsetHeight;
  const unit = tH + pair + fH;
  let furiTop, transTop;
  if (rect.top - gap - unit >= margin) {
    furiTop = rect.top - gap - fH;
    transTop = furiTop - pair - tH;
  } else {
    transTop = rect.bottom + gap;
    furiTop = transTop + tH + pair;
  }
  placeBubble(furi, rect.cx, furiTop);
  placeBubble(trans, rect.cx, transTop);
}

let showFrame;
function showBubbles() {
  const furi = $('bubble-furi'), trans = $('bubble-trans');
  furi.hidden = false; trans.hidden = false;
  cancelAnimationFrame(showFrame);
  showFrame = requestAnimationFrame(() => { furi.classList.add('show'); trans.classList.add('show'); });
}
let hideTimer;
function hideBubbles() {
  const furi = $('bubble-furi'), trans = $('bubble-trans');
  furi.classList.remove('show'); trans.classList.remove('show');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { furi.hidden = true; trans.hidden = true; }, 140);
}

// ----- content + debounced data fetching -----
const furiCache = new Map();
const meanCache = new Map();
let furiCtl = null, meanCtl = null, furiTimer = 0, meanTimer = 0;

function renderFuri(text, html) {
  $('bubble-furi').innerHTML = `<div class="furi">${html != null ? html : escapeHtml(text)}</div>`;
}
function renderTrans(meaning) {
  const bot = $('bubble-trans');
  if (!meaning) { bot.innerHTML = `<div class="b-translation loading">…</div>`; bot.hidden = false; return; }
  let parts = '';
  if (meaning.translation) parts += `<div class="b-translation">${escapeHtml(meaning.translation)}</div>`;
  const words = (meaning.words || []).slice(0, 2);
  if (words.length) {
    const rows = words.map((w) => {
      const r = w.reading ? `<span class="r">（${escapeHtml(w.reading)}）</span>` : '';
      const def = (w.senses[0] && w.senses[0].definitions.slice(0, 3).join('; ')) || '';
      return `<div class="b-word"><b>${escapeHtml(w.word)}</b>${r} ${escapeHtml(def)}</div>`;
    }).join('');
    parts += `<div class="b-words">${rows}</div>`;
  }
  if (!parts) parts = `<div class="b-hint">${state.config.googleTranslate ? 'No definition found.' : 'No dictionary match.'}</div>`;
  bot.innerHTML = parts;
}

function requestData(text) {
  // Furigana — fast, local.
  clearTimeout(furiTimer);
  if (furiCache.has(text)) renderFuri(text, furiCache.get(text));
  else {
    renderFuri(text, null);
    furiTimer = setTimeout(async () => {
      try {
        if (furiCtl) furiCtl.abort();
        furiCtl = new AbortController();
        const res = await fetch('/api/furigana', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: furiCtl.signal });
        if (!res.ok) return;
        const j = await res.json();
        const html = renderFurigana(j.tokens);
        furiCache.set(text, html);
        if (sel.current === text) { renderFuri(text, html); positionBubbles(sel.a, sel.b); }
      } catch (e) { if (e.name !== 'AbortError') console.warn('furigana', e.message); }
    }, 80);
  }

  // Meaning — slower, network.
  clearTimeout(meanTimer);
  if (meanCache.has(text)) renderTrans(meanCache.get(text));
  else {
    renderTrans(null);
    meanTimer = setTimeout(async () => {
      try {
        if (meanCtl) meanCtl.abort();
        meanCtl = new AbortController();
        const res = await fetch('/api/meaning', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: meanCtl.signal });
        if (!res.ok) return;
        const j = await res.json();
        meanCache.set(text, j);
        if (sel.current === text) { renderTrans(j); positionBubbles(sel.a, sel.b); }
      } catch (e) { if (e.name !== 'AbortError') console.warn('meaning', e.message); }
    }, 300);
  }
}

function updateSelection(off) {
  const a = Math.min(sel.startOff, off);
  const b = Math.max(sel.startOff, off);
  sel.a = a; sel.b = b;
  applyHighlight(a, b);
  // Multi-line phrase: drop line breaks so the reading/translation treat it as one phrase.
  const text = state.text.slice(a, b + 1).replace(/\n/g, '').trim();
  if (text && text !== sel.current) { sel.current = text; requestData(text); }
  positionBubbles(a, b); // after content is set, so width/height are measured correctly
}

// ----- gesture layer -----
// Mouse: any drag selects. Touch: a horizontal drag selects; a vertical drag falls
// through to the browser's native (momentum) scrolling. We use touch events rather
// than pointer events because preventDefault() on the first horizontal touchmove
// reliably locks the gesture to selection, while never touching vertical scrolls —
// so normal scrolling keeps its native feel and selection never breaks.

function beginSelecting() {
  if (sel.startOff == null) sel.startOff = charFromPoint(sel.startX, sel.startY);
  if (sel.startOff == null) return false;
  sel.deciding = false;
  sel.active = true;
  sel.current = '';
  renderFuri('', null);
  renderTrans(null);
  showBubbles();
  return true;
}

function endGesture(wasSelecting) {
  sel.active = false; sel.deciding = false; sel.touchId = null; sel.startOff = null;
  sel.a = sel.b = -1; sel.current = '';
  if (wasSelecting) { hideBubbles(); clearHighlight(); }
}

// --- mouse ---
function onMouseDown(e) {
  if (state.editing || e.button !== 0 || sel.active || sel.deciding) return;
  sel.deciding = true;
  sel.startX = e.clientX; sel.startY = e.clientY;
  sel.startOff = charFromPoint(e.clientX, e.clientY);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}
function onMouseMove(e) {
  if (sel.deciding) {
    if (Math.abs(e.clientX - sel.startX) + Math.abs(e.clientY - sel.startY) < 4) return;
    if (!beginSelecting()) return onMouseUp();
  }
  if (sel.active) { const off = charFromPoint(e.clientX, e.clientY); if (off != null) updateSelection(off); }
}
function onMouseUp() {
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
  endGesture(sel.active);
}

// --- touch ---
function trackedTouch(e) {
  for (const t of e.changedTouches) if (t.identifier === sel.touchId) return t;
  return null;
}
function onTouchStart(e) {
  if (state.editing || sel.active || sel.deciding) return;
  const t = e.changedTouches[0];
  sel.touchId = t.identifier;
  sel.deciding = true;
  sel.startX = t.clientX; sel.startY = t.clientY;
  sel.startOff = charFromPoint(t.clientX, t.clientY);
}
function onTouchMove(e) {
  if (!sel.deciding && !sel.active) return;
  const t = trackedTouch(e);
  if (!t) return;
  if (sel.deciding) {
    const dx = t.clientX - sel.startX, dy = t.clientY - sel.startY;
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (Math.abs(dx) > Math.abs(dy)) {            // horizontal → select
      if (!beginSelecting()) { sel.deciding = false; sel.touchId = null; return; }
    } else {                                       // vertical → let the browser scroll natively
      sel.deciding = false; sel.touchId = null;
      return;
    }
  }
  if (sel.active) {
    e.preventDefault();                            // keep the page from scrolling while selecting
    const off = charFromPoint(t.clientX, t.clientY);
    if (off != null) updateSelection(off);
  }
}
function onTouchEnd(e) {
  if (sel.touchId == null || !trackedTouch(e)) return;
  const wasSelecting = sel.active;
  if (wasSelecting) e.preventDefault();            // suppress the synthesized ghost click
  endGesture(wasSelecting);
}

// ---------------------------------------------------------------------------
// Edit / retake wiring
// ---------------------------------------------------------------------------
function toggleEdit() {
  const reader = $('reader'), editor = $('editor'), btn = $('edit-toggle');
  if (!state.editing) {
    state.editing = true;
    hideBubbles(); clearHighlight();
    editor.value = state.text;
    editor.hidden = false;
    reader.style.display = 'none';
    btn.textContent = 'Done';
    editor.focus();
  } else {
    state.editing = false;
    editor.hidden = true;
    reader.style.display = '';
    btn.textContent = 'Edit';
    setReaderText(editor.value);
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
$('file').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
$('retake').addEventListener('click', () => $('file').click());
$('edit-toggle').addEventListener('click', toggleEdit);
$('reader').addEventListener('mousedown', onMouseDown);
$('reader').addEventListener('touchstart', onTouchStart, { passive: true });
$('reader').addEventListener('touchmove', onTouchMove, { passive: false });
$('reader').addEventListener('touchend', onTouchEnd);
$('reader').addEventListener('touchcancel', onTouchEnd);
$('reader').addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('resize', () => { if (sel.active) positionBubbles(sel.a, sel.b); });

loadConfig();
