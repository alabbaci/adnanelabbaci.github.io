import { setLang, getLang, t, tx, applyStatic, LANGS } from './i18n.js';
import { store } from './store.js';
import { loadCrops, getCrop, matchIssue, videoSearchUrl } from './knowledge.js';
import { listModels, diagnose, buildSystemPrompt, buildUserPrompt } from './gemini.js';
import { fileToPhoto, fileToVideo, overBudget, totalBytes, mb, thumbnail } from './capture.js';
import { GuidePlayer, cancelSpeech } from './guide.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const state = {
  crops: [],
  cropId: null,
  media: [],
  ctx: { organ: 'leaf', spread: 'patch', onset: 'weeks', irrigation: 'drip', region: '', age: '', notes: '' },
  result: null,
  demo: false
};

let guide = null;

// ───────────────────────── boot ─────────────────────────

init().catch(err => {
  document.body.insertAdjacentHTML('afterbegin', `<p class="err">${escape(err.message)}</p>`);
});

async function init() {
  setLang(store.lang() || navigator.language.slice(0, 2) || 'fr');
  applyStatic();
  markLang();

  state.crops = await loadCrops();
  renderCropGrid();
  renderLibrary();
  wireChrome();
  wireCapture();
  wireContext();
  wireSettings();
  loadSettingsIntoForm();

  window.addEventListener('online', updateOffline);
  window.addEventListener('offline', updateOffline);
  updateOffline();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is a bonus, not a requirement */ });
  }
}

// ───────────────────────── chrome ─────────────────────────

function wireChrome() {
  $$('.lang-switch button').forEach(b => b.addEventListener('click', () => {
    setLang(b.dataset.lang);
    store.setLang(getLang());
    applyStatic();
    markLang();
    renderCropGrid();
    renderLibrary();
    renderHistory();
    if (state.result) renderResult(state.result);
  }));

  $$('.tabbar button').forEach(b => b.addEventListener('click', () => {
    $$('.tabbar button').forEach(x => x.classList.toggle('active', x === b));
    const tab = b.dataset.tab;
    if (tab === 'diagnose') show(state.result ? 'result' : 'crop');
    else if (tab === 'history') { renderHistory(); show('history'); }
    else show(tab);
  }));

  $$('[data-go]').forEach(b => b.addEventListener('click', () => show(b.dataset.go)));
}

function markLang() {
  $$('.lang-switch button').forEach(b => b.classList.toggle('active', b.dataset.lang === getLang()));
}

function show(view) {
  cancelSpeech();
  $$('.view').forEach(v => { v.hidden = v.id !== `view-${view}`; });
  window.scrollTo(0, 0);
}

function updateOffline() {
  $('#offline-banner').hidden = navigator.onLine;
}

// ───────────────────────── crop picker ─────────────────────────

function renderCropGrid() {
  $('#crop-grid').innerHTML = state.crops.map(c => `
    <button class="crop-card" data-crop="${c.id}">
      <span class="crop-emoji" aria-hidden="true">${c.emoji}</span>
      <strong>${escape(tx(c.name))}</strong>
      <em>${escape(c.latin)}</em>
    </button>`).join('');

  $$('#crop-grid .crop-card').forEach(b => b.addEventListener('click', () => {
    state.cropId = b.dataset.crop;
    state.media = [];
    state.result = null;
    renderMedia();
    show('capture');
  }));
}

// ───────────────────────── capture ─────────────────────────

function wireCapture() {
  $('#in-camera').addEventListener('change', e => addFiles(e.target.files, 'image'));
  $('#in-gallery').addEventListener('change', e => addFiles(e.target.files, 'image'));
  $('#in-video').addEventListener('change', e => addFiles(e.target.files, 'video'));
  $('#to-context').addEventListener('click', () => show('context'));
}

async function addFiles(fileList, kind) {
  const err = $('#capture-err');
  err.hidden = true;
  for (const file of [...fileList].slice(0, 4)) {
    try {
      const item = kind === 'video' ? await fileToVideo(file) : await fileToPhoto(file);
      if (kind === 'video') state.media = state.media.filter(m => m.kind !== 'video');
      state.media.push(item);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  }
  if (overBudget(state.media)) {
    state.media.pop();
    err.textContent = `Trop de données (${mb(totalBytes(state.media))} Mo). Retirez une image ou la vidéo.`;
    err.hidden = false;
  }
  renderMedia();
}

function renderMedia() {
  const grid = $('#media-grid');
  grid.innerHTML = state.media.map((m, i) => `
    <figure class="media-item">
      ${m.kind === 'video'
        ? `<video src="${m.preview}" muted playsinline controls preload="metadata"></video>`
        : `<img src="${m.preview}" alt="">`}
      <button class="media-del" data-i="${i}" aria-label="${t('remove')}">✕</button>
    </figure>`).join('');

  $$('.media-del').forEach(b => b.addEventListener('click', () => {
    state.media.splice(Number(b.dataset.i), 1);
    renderMedia();
  }));

  const hasPhoto = state.media.some(m => m.kind === 'image');
  $('#to-context').disabled = !hasPhoto;
}

// ───────────────────────── context ─────────────────────────

function wireContext() {
  $$('.chip-row').forEach(row => {
    const field = row.dataset.field;
    row.querySelectorAll('button').forEach(b => {
      b.classList.toggle('on', b.dataset.v === state.ctx[field]);
      b.addEventListener('click', () => {
        state.ctx[field] = b.dataset.v;
        row.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      });
    });
  });
  $('#do-analyse').addEventListener('click', runAnalysis);
}

function readContext() {
  state.ctx.region = $('#in-region').value.trim();
  state.ctx.age = $('#in-age').value.trim();
  state.ctx.notes = $('#in-notes').value.trim();
  state.ctx.hasVideo = state.media.some(m => m.kind === 'video');
}

// ───────────────────────── analysis ─────────────────────────

async function runAnalysis() {
  const err = $('#context-err');
  err.hidden = true;
  readContext();

  if (!state.media.some(m => m.kind === 'image')) {
    err.textContent = t('err_noimg'); err.hidden = false; return;
  }

  const crop = getCrop(state.crops, state.cropId);
  const apiKey = store.apiKey();
  state.demo = !apiKey;

  show('loading');

  try {
    let result, usage = null, model = null;

    if (state.demo) {
      result = await loadDemo(state.cropId);
      await wait(900);
    } else {
      model = store.model() || (await pickDefaultModel(apiKey));
      const out = await diagnose({
        apiKey,
        model,
        media: state.media.map(m => ({ mime: m.mime, base64: m.base64 })),
        systemPrompt: buildSystemPrompt({
          lang: getLang(),
          crop,
          catalogue: crop.issues.map(i => ({ id: i.id, name: i.name.fr, latin: i.latin, type: i.type }))
        }),
        userPrompt: buildUserPrompt({ ctx: state.ctx, lang: getLang() })
      });
      result = out.result;
      usage = out.usage;
    }

    state.result = { crop, result, usage, model, demo: state.demo, at: Date.now() };
    renderResult(state.result);
    show('result');
    await saveToHistory(state.result);
  } catch (e) {
    err.innerHTML = `${escape(t('err_api'))}<br><span class="small">${escape(explain(e))}</span>`;
    err.hidden = false;
    show('context');
  }
}

async function pickDefaultModel(apiKey) {
  const cached = store.models();
  if (cached.length) return cached[0].id;
  const models = await listModels(apiKey);
  if (!models.length) throw Object.assign(new Error('err_nomodels'), { code: 'err_nomodels' });
  store.setModels(models);
  store.setModel(models[0].id);
  return models[0].id;
}

async function loadDemo(cropId) {
  const all = await fetch('data/demo.json').then(r => r.json());
  return all[cropId];
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// ───────────────────────── result ─────────────────────────

function renderResult(entry) {
  const { crop, result, usage, model, demo } = entry;
  const kb = result.kb_issue_id
    ? crop.issues.find(i => i.id === result.kb_issue_id) || matchIssue(crop, result.verdict)
    : matchIssue(crop, result.verdict);

  const conf = Math.round((Number(result.confidence) || 0) * 100);
  const sevKey = { low: 'sev_low', medium: 'sev_medium', high: 'sev_high', critical: 'sev_critical' }[result.severity] || 'sev_medium';
  const photo = state.media.find(m => m.kind === 'image');
  const video = state.media.find(m => m.kind === 'video');

  $('#view-result').innerHTML = `
    <button class="link-back" id="result-back">← <span>${escape(t('new_diagnosis'))}</span></button>
    ${demo ? `<p class="banner demo">${escape(t('demo_badge'))}</p>` : ''}

    <article class="verdict sev-${escape(result.severity || 'medium')}">
      <span class="verdict-crop">${crop.emoji} ${escape(tx(crop.name))}</span>
      <h1>${escape(result.verdict || '—')}</h1>
      ${result.verdict_latin ? `<em class="latin">${escape(result.verdict_latin)}</em>` : ''}
      <div class="meters">
        <div class="meter">
          <span>${escape(t('confidence'))}</span>
          <div class="bar"><i style="width:${conf}%"></i></div>
          <b>${conf}%</b>
        </div>
        <div class="meter">
          <span>${escape(t('severity'))}</span>
          <b class="sev-pill">${escape(t(sevKey))}</b>
        </div>
      </div>
      <button class="btn btn-ghost" id="speak-verdict">${escape(t('speak'))}</button>
    </article>

    ${result.needs_expert ? `
      <div class="callout warn">
        <strong>⚠️ ${escape(t('expert_flag'))}</strong>
        <p>${escape(result.needs_expert_reason || t('expert_why'))}</p>
      </div>` : ''}

    ${section(t('what_i_see'), list(result.observations))}

    ${result.differentials?.length ? section(t('differentials'), `
      <ul class="diffs">${result.differentials.map(d => `
        <li><strong>${escape(d.name)}</strong><span>${escape(d.how_to_tell)}</span></li>`).join('')}</ul>`) : ''}

    ${section(t('actions_now'), `<ol class="checklist">${(result.actions_now || [])
      .map((a, i) => `<li><label><input type="checkbox" data-act="${i}"><span>${escape(a)}</span></label></li>`).join('')}</ol>`)}

    ${section(t('treatment_bio'), `<p>${escape(result.treatment_organic || '—')}</p>`)}
    ${section(t('treatment_conv'), `<p>${escape(result.treatment_conventional || '—')}</p>`)}
    ${result.phi_warning ? `<div class="callout">⏳ ${escape(result.phi_warning)}</div>` : ''}
    ${section(t('prevention'), `<p>${escape(result.prevention || '—')}</p>`)}

    ${kb ? `<section class="card"><h2>${escape(t('guide_title'))}</h2><div id="guide-host"></div></section>` : ''}

    ${video ? `<section class="card"><h2>${escape(t('your_video'))}</h2>
      <video src="${video.preview}" controls playsinline class="result-video"></video></section>` : ''}

    <a class="btn btn-wide" target="_blank" rel="noopener"
       href="${videoSearchUrl(tx(crop.name), result.verdict || '', getLang())}">${escape(t('more_video'))} ↗</a>

    <p class="disclaimer">${escape(t('disclaimer'))}</p>
    ${usage ? `<p class="muted small">${escape(model || '')} · ${usage.totalTokenCount} tokens</p>` : ''}
  `;

  $('#result-back').addEventListener('click', () => {
    state.result = null; state.media = []; renderMedia(); show('crop');
  });
  $('#speak-verdict').addEventListener('click', () => {
    import('./guide.js').then(m => m.say(
      `${result.verdict}. ${(result.observations || []).join(' ')} ${(result.actions_now || []).join(' ')}`
    ));
  });

  if (kb) {
    guide = new GuidePlayer($('#guide-host'));
    guide.load(kb.guide, photo ? photo.preview : '');
  }
}

function section(title, inner) {
  return `<section class="card"><h2>${escape(title)}</h2>${inner}</section>`;
}
function list(items) {
  return `<ul class="bullets">${(items || []).map(i => `<li>${escape(i)}</li>`).join('')}</ul>`;
}

// ───────────────────────── library ─────────────────────────

function renderLibrary() {
  $('#library').innerHTML = state.crops.map(c => `
    <details class="crop-block">
      <summary><span aria-hidden="true">${c.emoji}</span> ${escape(tx(c.name))} <em>${escape(c.latin)}</em></summary>
      <p class="muted">${escape(tx(c.note))}</p>

      <h3>${escape(t('lib_calendar'))}</h3>
      <ul class="calendar">${c.calendar.map(k =>
        `<li><b>${escape(k.months)}</b><span>${escape(tx(k))}</span></li>`).join('')}</ul>

      ${c.issues.map(i => `
        <details class="issue type-${escape(i.type)}">
          <summary>${escape(tx(i.name))} <em>${escape(i.latin)}</em></summary>
          <h4>${escape(t('lib_signs'))}</h4>
          ${list(tx(i.signs))}
          <h4>${escape(t('lib_confusion'))}</h4>
          <p class="muted small">${escape((i.confusion || []).join(' · '))}</p>
          <h4>${escape(t('treatment_bio'))}</h4><p>${escape(tx(i.organic))}</p>
          <h4>${escape(t('treatment_conv'))}</h4><p>${escape(tx(i.conventional))}</p>
          <h4>${escape(t('prevention'))}</h4><p>${escape(tx(i.prevention))}</p>
        </details>`).join('')}
    </details>`).join('');
}

// ───────────────────────── history ─────────────────────────

async function saveToHistory(entry) {
  const photo = state.media.find(m => m.kind === 'image');
  store.addHistory({
    at: entry.at,
    crop: entry.crop.id,
    verdict: entry.result.verdict,
    confidence: entry.result.confidence,
    severity: entry.result.severity,
    demo: entry.demo,
    model: entry.model,
    thumb: photo ? await thumbnail(photo) : '',
    result: entry.result,
    context: { ...state.ctx }
  });
}

function renderHistory() {
  const items = store.history();
  const host = $('#history');
  if (!items.length) { host.innerHTML = `<p class="muted">${escape(t('history_empty'))}</p>`; return; }

  host.innerHTML = items.map(h => {
    const crop = getCrop(state.crops, h.crop);
    return `<article class="hist sev-${escape(h.severity || 'medium')}">
      ${h.thumb ? `<img src="${h.thumb}" alt="">` : '<span class="hist-nothumb" aria-hidden="true">🌳</span>'}
      <div>
        <strong>${escape(h.verdict || '—')}</strong>
        <span class="muted small">${crop ? crop.emoji + ' ' + escape(tx(crop.name)) : ''} · ${new Date(h.at).toLocaleDateString(LANGS[getLang()].locale)}
        ${h.demo ? ' · ' + escape(t('demo_badge')) : ''}</span>
      </div>
      <b>${Math.round((h.confidence || 0) * 100)}%</b>
    </article>`;
  }).join('');
}

// ───────────────────────── settings ─────────────────────────

function wireSettings() {
  $('#in-key').addEventListener('change', e => {
    store.setApiKey(e.target.value);
    store.setModels([]);
    flash('#settings-ok', t('saved'));
  });
  $('#in-model').addEventListener('change', e => {
    store.setModel(e.target.value);
    flash('#settings-ok', t('saved'));
  });
  $('#do-refresh-models').addEventListener('click', refreshModels);
  $('#do-export').addEventListener('click', exportHistory);
  $('#do-clear').addEventListener('click', () => {
    store.clearHistory(); renderHistory(); flash('#settings-ok', t('saved'));
  });
}

function loadSettingsIntoForm() {
  $('#in-key').value = store.apiKey();
  fillModelSelect(store.models(), store.model());
}

async function refreshModels() {
  const key = $('#in-key').value.trim() || store.apiKey();
  const err = $('#settings-err');
  err.hidden = true;
  if (!key) { err.textContent = t('err_nokey'); err.hidden = false; return; }
  try {
    store.setApiKey(key);
    const models = await listModels(key);
    store.setModels(models);
    if (!models.some(m => m.id === store.model())) store.setModel(models[0]?.id || '');
    fillModelSelect(models, store.model());
    flash('#settings-ok', `${models.length} ${t('models_found')}`);
  } catch (e) {
    err.textContent = explain(e); err.hidden = false;
  }
}

function fillModelSelect(models, selected) {
  const sel = $('#in-model');
  if (!models.length) {
    sel.innerHTML = `<option value="">—</option>`;
    return;
  }
  sel.innerHTML = models.map(m =>
    `<option value="${escape(m.id)}"${m.id === selected ? ' selected' : ''}>${escape(m.id)}</option>`).join('');
}

function exportHistory() {
  const blob = new Blob([JSON.stringify(store.history(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chajra-historique-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function flash(sel, msg) {
  const el = $(sel);
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 2200);
}

// ───────────────────────── util ─────────────────────────

// Coded API errors translate; anything else shows its own message.
function explain(e) {
  if (!e.code) return e.message;
  const label = t(e.code);
  return label === e.code ? e.message : label;
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
