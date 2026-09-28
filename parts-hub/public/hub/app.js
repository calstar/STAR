// STAR Parts Hub: list / detail+edit / upload, as a tiny hash-routed single page.
import { buildIndex, formatCost, search } from '/shared/search.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

// ---- helpers --------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** replaceChildren that skips null/false and flattens arrays, like h(). */
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/hub/${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3000);
}

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const initials = (name) => name.split(/\s+/).filter((w) => /[a-z]/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const thumbImg = (p, cls) => (p.thumbUrl ? h('img', { class: cls, src: p.thumbUrl, alt: '', loading: 'lazy' }) : h('span', { class: 'ph' }, initials(p.name)));
const statusBadge = (p) =>
  p.archived ? h('span', { class: 'status archived' }, 'archived')
  : p.status !== 'ready' ? h('span', { class: `status ${p.status}` }, { staged: 'not in Onshape yet', pending: 'adding to Onshape', failed: 'failed' }[p.status])
  : null;

const prefs = {
  get: (k, d) => { try { return localStorage.getItem(`hub.${k}`) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`hub.${k}`, v); } catch {} },
};

let me = null;
let categories = [];
let pollTimer = 0;
let leaveGuard = null; // returns true if it's OK to leave the current page

// ---- router -----------------------------------------------------------------------

async function route() {
  clearTimeout(pollTimer);
  const hash = location.hash || '#/';
  const m = /^#\/parts\/(\d+)/.exec(hash);
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('current', a.dataset.nav === (hash.startsWith('#/upload') ? 'upload' : m ? '' : 'list')));
  leaveGuard = null;
  window.scrollTo(0, 0);
  try {
    if (m) await detailPage(Number(m[1]));
    else if (hash.startsWith('#/upload')) await uploadPage();
    else await listPage();
  } catch (err) {
    fill(view, h('p', { class: 'empty' }, err.message));
  }
}

let lastHash = location.hash;
window.addEventListener('hashchange', (e) => {
  if (leaveGuard && !leaveGuard()) {
    history.replaceState(null, '', lastHash || '#/');
    return;
  }
  lastHash = location.hash;
  route();
});
window.addEventListener('beforeunload', (e) => {
  if (leaveGuard && !leaveGuard()) e.preventDefault();
});

// ---- list page ------------------------------------------------------------------------

async function listPage() {
  const state = {
    q: sessionStorage.getItem('hub.q') ?? '',
    category: sessionStorage.getItem('hub.category') ?? '',
    archived: sessionStorage.getItem('hub.archived') === '1',
    layout: prefs.get('layout', 'table'),
    parts: [],
    index: [],
  };

  const searchBox = h('input', { class: 'search', type: 'search', placeholder: 'Search name, part #, vendor, tags, notes, specs…', value: state.q, 'aria-label': 'Search parts' });
  const catSelect = h('select', { 'aria-label': 'Category' });
  const archivedBox = h('input', { type: 'checkbox', checked: state.archived || null });
  const layoutBtns = ['table', 'grid'].map((l) =>
    h('button', { 'aria-pressed': String(state.layout === l), onclick: () => { state.layout = l; prefs.set('layout', l); layoutBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.textContent.toLowerCase() === l))); render(); } }, l[0].toUpperCase() + l.slice(1)),
  );
  const importBtn = h('button', { class: 'btn small', onclick: startCheck, title: 'Find parts someone imported straight into the STAR Parts Library document in Onshape' }, 'Check Onshape for new parts');
  const meta = h('div', { class: 'meta-line' });
  const syncBar = h('div', { class: 'sync-bar', hidden: true });
  const importStatus = h('span');
  const results = h('div');

  fill(view,
    h('div', { class: 'toolbar' },
      searchBox, catSelect,
      h('label', { class: 'check' }, archivedBox, 'Show archived'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Layout' }, layoutBtns),
    ),
    syncBar,
    meta,
    results,
  );

  function renderCategories() {
    const cats = [...new Set([...state.parts.map((p) => p.category).filter(Boolean)])].sort();
    fill(catSelect, h('option', { value: '' }, 'All categories'), cats.map((c) => h('option', { value: c }, c)));
    catSelect.value = cats.includes(state.category) ? state.category : '';
  }

  function render() {
    const list = search(state.index, state.q, { category: catSelect.value });
    fill(meta,
      h('span', {}, `${list.length} of ${state.parts.filter((p) => !p.archived).length} parts`),
      importBtn, importStatus,
      me.mock ? null : h('span', { class: 'api-usage', title: 'Onshape counts these against STAR\'s annual API allowance: Onshape updates and inserts from the panel.' },
        `Onshape API calls by the hub: ${me.apiCalls.last30Days} in the last 30 days · ${me.apiCalls.thisYear} this year`),
    );
    if (!list.length) {
      fill(results, h('p', { class: 'empty' }, state.parts.length ? 'No parts match.' : 'No parts yet. Upload some, or import them into the Onshape library and press Check Onshape for new parts.'));
      return;
    }
    const open = (p) => (location.hash = `#/parts/${p.id}`);
    if (state.layout === 'grid') {
      fill(results, h('div', { class: 'cards' }, list.map((p) =>
        h('a', { class: `card${p.archived ? ' archived-row' : ''}`, href: `#/parts/${p.id}` },
          h('div', { class: 'img' }, thumbImg(p)),
          h('div', { class: 'body' },
            h('div', { class: 'title' }, p.name, ' ', statusBadge(p)),
            h('div', { class: 'sub' }, [p.partNumber, p.vendor].filter(Boolean).join(' · ')),
            p.unitCost != null ? h('div', { class: 'sub' }, formatCost(p.unitCost)) : null)))));
    } else {
      fill(results, h('table', { class: 'parts' },
        h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, 'Name'), h('th', {}, 'Part #'), h('th', { class: 'hide-sm' }, 'Vendor'), h('th', { class: 'hide-sm' }, 'Category'), h('th', { class: 'num' }, 'Cost'))),
        h('tbody', {}, list.map((p) =>
          h('tr', { class: p.archived ? 'archived-row' : '', onclick: () => open(p), tabindex: 0, onkeydown: (e) => e.key === 'Enter' && open(p) },
            h('td', {}, p.thumbUrl ? h('img', { class: 'tiny-thumb', src: p.thumbUrl, alt: '', loading: 'lazy' }) : h('div', { class: 'tiny-thumb' })),
            h('td', {}, h('strong', {}, p.name), ' ', statusBadge(p)),
            h('td', { class: 'mono' }, p.partNumber),
            h('td', { class: 'hide-sm' }, p.vendor),
            h('td', { class: 'hide-sm' }, p.category),
            h('td', { class: 'num' }, formatCost(p.unitCost)))))));
    }
  }

  async function load() {
    [state.parts, me] = await Promise.all([api(`parts${state.archived ? '?archived=1' : ''}`), api('me')]);
    state.index = buildIndex(state.parts);
    renderCategories();
    render();
    const [job, sync] = await Promise.all([api('check-onshape'), api('sync')]);
    renderImportJob(job);
    renderSync(sync);
    // Keep polling while something is being added or drawn.
    const busy = job.running || sync.job.running || state.parts.some((p) => p.status === 'pending' || p.rendering);
    if (busy) pollTimer = setTimeout(load, 3000);
  }

  let lastSyncShown = null;
  function renderSync({ job, waiting, estimatedCalls }) {
    syncBar.hidden = false;
    if (job.running) {
      fill(syncBar, h('span', { class: 'spinner' }), h('strong', {}, `Adding ${job.parts} part(s) to Onshape`), ` · ${job.step ?? ''}…`);
    } else if (waiting) {
      fill(syncBar,
        h('div', { class: 'grow' },
          h('strong', {}, `${waiting} part${waiting === 1 ? '' : 's'} waiting for Onshape.`),
          ' They are saved here but not in the Onshape panel yet. Upload the rest of your batch, then update once.'),
        h('button', { class: 'btn primary small', onclick: startSync }, 'Update Onshape'),
        h('span', { class: 'hint' }, `about ${estimatedCalls} API calls`));
    } else if (job.error) {
      fill(syncBar, h('span', { class: 'status failed' }, 'Update failed'), ' ', job.error);
    } else {
      syncBar.hidden = true;
    }
    // Announce a finished update once.
    if (!job.running && job.result && lastSyncShown === true) {
      toast(`Added ${job.result.added} part(s) to Onshape${job.result.failed ? `, ${job.result.failed} failed` : ''}`, job.result.failed ? 'err' : 'ok');
    }
    lastSyncShown = job.running;
  }

  async function startSync() {
    try {
      await api('sync', { method: 'POST' });
      lastSyncShown = true;
      clearTimeout(pollTimer);
      load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function renderImportJob(job) {
    importBtn.disabled = job.running;
    if (job.running) fill(importStatus, h('span', { class: 'spinner' }), 'Checking the Onshape library for new parts…');
    else if (job.error) fill(importStatus, h('span', { class: 'status failed' }, 'Check failed'), ' ', job.error);
    else if (job.result) importStatus.textContent = job.result.created ? `Found ${job.result.created} new part(s) in Onshape. Add their details.` : 'No new parts in Onshape.';
    else importStatus.textContent = '';
  }

  async function startCheck() {
    if (!confirm('Look for parts that were imported straight into the STAR Parts Library document in Onshape?\n\nUses about 5 Onshape API calls, plus 1 per new part for its picture.')) return;
    try {
      renderImportJob(await api('check-onshape', { method: 'POST' }));
      clearTimeout(pollTimer);
      pollTimer = setTimeout(load, 1500);
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  searchBox.addEventListener('input', () => {
    state.q = searchBox.value;
    sessionStorage.setItem('hub.q', state.q);
    render();
  });
  catSelect.addEventListener('change', () => {
    state.category = catSelect.value;
    sessionStorage.setItem('hub.category', state.category);
    render();
  });
  archivedBox.addEventListener('change', () => {
    state.archived = archivedBox.checked;
    sessionStorage.setItem('hub.archived', state.archived ? '1' : '0');
    clearTimeout(pollTimer);
    load();
  });
  searchBox.focus();
  await load();
}

// ---- part form (shared by detail and upload) -------------------------------------------------

function partForm(part, onChange) {
  const field = (label, input, { full = false, hint = '', required = false } = {}) =>
    h('div', { class: full ? 'full' : '' }, h('label', {}, label, required ? h('span', { class: 'req' }, ' *') : null), input, hint ? h('div', { class: 'hint' }, hint) : null);

  const inputs = {
    name: h('input', { value: part.name ?? '', required: true, maxlength: 200, placeholder: 'e.g. 1/4 Tube Union SS' }),
    partNumber: h('input', { value: part.partNumber ?? '', placeholder: 'e.g. SS-400-6' }),
    vendor: h('input', { value: part.vendor ?? '', list: 'vendor-list', placeholder: 'e.g. Swagelok' }),
    category: h('input', { value: part.category ?? '', list: 'category-list', placeholder: 'Choose or type a new one' }),
    tags: h('input', { value: (part.tags ?? []).join(', '), placeholder: 'comma, separated' }),
    unitCost: h('input', { value: part.unitCost != null ? Number(part.unitCost).toFixed(2) : '', inputmode: 'decimal', placeholder: '0.00' }),
    costNote: h('input', { value: part.costNote ?? '', placeholder: 'e.g. qty 10 price, quoted 2026-08' }),
    description: h('textarea', {}, part.description ?? ''),
    notes: h('textarea', {}, part.notes ?? ''),
  };
  const links = rowsEditor(part.links ?? [], [['label', 'Label (e.g. Datasheet)'], ['url', 'https://…']], '+ Add link', '');
  const custom = rowsEditor(part.customFields ?? [], [['key', 'Field (e.g. Max pressure)'], ['value', 'Value (e.g. 5000 psi)']], '+ Add field', 'kv');

  const vendors = [...new Set(allParts.map((p) => p.vendor).filter(Boolean))].sort();
  const nameField = field('Display name', inputs.name, { full: true, required: true, hint: 'The only name shown in the Onshape catalog.' });
  const el = h('div', { class: 'form' },
    h('datalist', { id: 'category-list' }, categories.map((c) => h('option', { value: c }))),
    h('datalist', { id: 'vendor-list' }, vendors.map((v) => h('option', { value: v }))),
    nameField,
    field('Part number', inputs.partNumber),
    field('Vendor', inputs.vendor),
    field('Category', inputs.category),
    field('Tags', inputs.tags),
    field('Cost (USD, per unit)', h('div', { class: 'cost' }, inputs.unitCost, inputs.costNote), { full: true }),
    field('Links', links.el, { full: true }),
    field('Custom fields', custom.el, { full: true, hint: 'Anything else worth knowing: material, pressure rating, thread, …' }),
    field('Description', inputs.description, { full: true }),
    field('Notes', inputs.notes, { full: true }),
  );
  el.addEventListener('input', () => onChange?.());
  el.addEventListener('click', (e) => e.target.closest('.x, .link-btn') && setTimeout(() => onChange?.()));

  return {
    el,
    nameField,
    focus: () => inputs.name.focus(),
    setNameIfEmpty(name) {
      if (!inputs.name.value.trim()) inputs.name.value = name;
    },
    read: () => ({
      name: inputs.name.value.trim(),
      partNumber: inputs.partNumber.value,
      vendor: inputs.vendor.value,
      category: inputs.category.value,
      tags: inputs.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      unitCost: inputs.unitCost.value.trim() === '' ? null : inputs.unitCost.value,
      costNote: inputs.costNote.value,
      description: inputs.description.value,
      notes: inputs.notes.value,
      links: links.read(),
      customFields: custom.read(),
    }),
  };
}

function rowsEditor(initial, cols, addLabel, cls) {
  const list = h('div', { class: 'rows' });
  const addRow = (values = {}) => {
    const inputs = cols.map(([key, ph]) => h('input', { value: values[key] ?? '', placeholder: ph, 'data-key': key }));
    const row = h('div', { class: `row ${cls}` }, inputs, h('button', { type: 'button', class: 'x', 'aria-label': 'Remove', onclick: () => row.remove() }, '✕'));
    list.append(row);
    return inputs[0];
  };
  initial.forEach(addRow);
  const el = h('div', {}, list, h('button', { type: 'button', class: 'link-btn', onclick: () => addRow().focus() }, addLabel));
  return {
    el,
    read: () =>
      [...list.children]
        .map((row) => Object.fromEntries([...row.querySelectorAll('input')].map((i) => [i.dataset.key, i.value.trim()])))
        .filter((r) => Object.values(r).some(Boolean)),
  };
}

// ---- detail page ---------------------------------------------------------------------------

async function detailPage(id) {
  let part = await api(`parts/${id}`);
  let saved = null; // JSON of the last saved form state
  const saveBtn = h('button', { class: 'btn primary', type: 'submit', disabled: true }, 'Save changes');
  const saveMsg = h('span', { class: 'msg' });
  const form = partForm(part, () => {
    const dirty = JSON.stringify(form.read()) !== saved;
    saveBtn.disabled = !dirty;
    saveMsg.textContent = dirty ? 'Unsaved changes' : '';
  });
  saved = JSON.stringify(form.read());
  leaveGuard = () => JSON.stringify(form.read()) === saved || confirm('Discard unsaved changes?');

  const side = h('div', { class: 'side' });
  const history = h('section', { class: 'history panel' });
  const title = h('h1', {}, part.name);

  fill(view,
    h('a', { class: 'back', href: '#/' }, '← All parts'),
    h('div', { class: 'page-head' }, title),
    h('div', { class: 'detail' },
      side,
      h('div', {},
        h('form', {
          class: 'panel',
          onsubmit: async (e) => {
            e.preventDefault();
            saveBtn.disabled = true;
            saveMsg.textContent = 'Saving…';
            try {
              part = await api(`parts/${id}`, { method: 'PATCH', body: form.read() });
              saved = JSON.stringify(form.read());
              saveMsg.textContent = 'Saved';
              title.textContent = part.name;
              renderSide();
              loadHistory();
            } catch (err) {
              saveBtn.disabled = false;
              saveMsg.textContent = '';
              toast(err.message, 'err');
            }
          },
        }, form.el, h('div', { class: 'savebar' }, saveBtn, saveMsg)),
        history)),
  );

  async function act(path, body, okMessage) {
    try {
      part = await api(`parts/${id}/${path}`, { method: 'POST', body: body ?? {} });
      if (okMessage) toast(okMessage, 'ok');
      renderSide();
      loadHistory();
      poll();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function renderSide() {
    let statusBox = null;
    if (part.status === 'staged') {
      statusBox = h('div', { class: 'status-box pending' }, h('strong', {}, 'Not in Onshape yet.'),
        h('div', {}, 'Saved on the server. It joins the Onshape panel at the next ', h('a', { href: '#/' }, 'Update Onshape'), ', together with everything else waiting.'));
    } else if (part.status === 'pending') {
      statusBox = h('div', { class: 'status-box pending' }, h('span', { class: 'spinner' }), h('strong', {}, 'Adding to Onshape'), h('div', {}, part.statusDetail));
    } else if (part.status === 'failed') {
      statusBox = h('div', { class: 'status-box failed' },
        h('strong', {}, 'Could not add to Onshape'), h('div', {}, part.statusDetail),
        h('button', { class: 'btn small', onclick: () => act('retry', null, 'Will try again at the next update') }, 'Try again at next update'));
    }
    fill(side,
      h('div', { class: 'hero' }, part.rendering ? h('span', { class: 'drawing' }, h('span', { class: 'spinner' }), 'Drawing picture…') : thumbImg(part)),
      part.archived ? h('div', { class: 'status-box pending' }, h('strong', {}, 'Archived.'), ' Hidden from the hub list and the Onshape panel.') : null,
      statusBox,
      h('div', { class: 'actions' },
        part.hasOriginal ? h('a', { class: 'btn', href: `/api/hub/parts/${id}/original` }, 'Download original file') : null,
        part.onshapeUrl ? h('a', { class: 'btn', href: part.onshapeUrl, target: '_blank', rel: 'noopener' }, 'Open in Onshape ↗') : null,
        (part.hasOriginal || part.versionId) && !part.rendering
          ? h('button', { class: 'btn', onclick: () => act('refresh-thumbnail', null, 'Picture redrawn') }, 'Redraw picture')
          : null,
        part.archived
          ? h('button', { class: 'btn', onclick: () => act('archive', { archived: false }, 'Restored') }, 'Restore')
          : h('button', { class: 'btn danger', onclick: () => confirm(`Archive "${part.name}"? It will be hidden from the hub and the Onshape panel. Existing assemblies are not affected.`) && act('archive', { archived: true }, 'Archived') }, 'Archive'),
      ),
      h('div', { class: 'facts' },
        part.originalFilename ? h('div', {}, 'File: ', part.originalFilename) : null,
        h('div', {}, `Added by ${part.createdBy} · ${when(part.createdAt)}`),
        h('div', {}, `Last edited by ${part.updatedBy} · ${when(part.updatedAt)}`),
      ),
    );
  }

  async function loadHistory() {
    const { history: entries } = await api(`parts/${id}`);
    fill(history, h('h2', {}, 'History'), h('ol', {}, entries.map((e) => h('li', {},
      h('div', {}, h('strong', {}, e.action), ' · ', e.user, ' · ', h('span', { class: 'when' }, when(e.at))),
      describeChange(e)))));
  }

  function poll() {
    clearTimeout(pollTimer);
    if (part.status !== 'pending' && !part.rendering) return;
    pollTimer = setTimeout(async () => {
      const fresh = await api(`parts/${id}`).catch(() => null);
      if (fresh && ['status', 'statusDetail', 'thumbUrl', 'rendering'].some((k) => fresh[k] !== part[k])) {
        const was = part.status;
        part = fresh;
        renderSide();
        if (was === 'pending' && part.status !== 'pending') {
          loadHistory();
          toast(part.status === 'ready' ? `${part.name} is in the Onshape panel now` : 'Could not add to Onshape', part.status === 'ready' ? 'ok' : 'err');
        }
      }
      poll();
    }, 2000);
  }

  renderSide();
  loadHistory();
  poll();
}

function describeChange(entry) {
  const d = entry.detail;
  if (!d) return null;
  const show = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? Object.values(x).join(': ') : x)).join(', ') : v ?? '');
  if (entry.action === 'Edited') {
    return h('div', { class: 'changes' }, Object.entries(d).map(([k, { from, to }]) =>
      h('div', {}, `${k}: `, show(from) === '' ? '(empty)' : `“${show(from)}”`, ' → ', show(to) === '' ? '(empty)' : `“${show(to)}”`)));
  }
  const text = Object.entries(d).map(([k, v]) => `${k}: ${show(v)}`).join(' · ');
  return text ? h('div', { class: 'changes' }, text) : null;
}

// ---- upload page -------------------------------------------------------------------------------

const FORMATS = 'STEP/STP preferred · IGES, Parasolid, SolidWorks, Inventor, CATIA, Creo, NX, JT, ACIS, Rhino, STL, OBJ, 3MF';

async function uploadPage() {
  let files = [];
  const form = partForm({}, null);
  const fileInput = h('input', { type: 'file', hidden: true, multiple: true });
  const drop = h('div', { class: 'dropzone', tabindex: 0, role: 'button', onclick: () => fileInput.click(), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && fileInput.click() },
    h('div', { class: 'file' }, 'Drop CAD files here, or click to choose'),
    h('div', { class: 'formats' }, FORMATS, ' · several files at once is fine'), fileInput);
  const batchList = h('div', { class: 'batch', hidden: true });
  const progress = h('progress', { max: 100, value: 0, hidden: true });
  const progressText = h('span', { class: 'msg' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Upload');
  const title = h('h1', {}, 'Upload parts');
  const nameOf = (f) => f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();

  function renderFiles() {
    const many = files.length > 1;
    form.nameField.hidden = many;
    batchList.hidden = !many;
    submit.textContent = files.length > 1 ? `Upload ${files.length} parts` : 'Upload';
    if (files.length === 1) form.setNameIfEmpty(nameOf(files[0].file));
    fill(drop.firstChild, files.length === 1 ? `${files[0].file.name} · ${(files[0].file.size / 1024 / 1024).toFixed(1)} MB` : files.length ? `${files.length} files` : 'Drop CAD files here, or click to choose');
    if (!many) return;
    fill(batchList,
      h('label', {}, 'Display names', h('span', { class: 'req' }, ' *')),
      files.map((f, i) => h('div', { class: 'row' },
        h('input', { value: f.name, 'aria-label': `Display name for ${f.file.name}`, oninput: (e) => (f.name = e.target.value) }),
        h('div', { class: 'batch-file' }, f.file.name, ` · ${(f.file.size / 1024 / 1024).toFixed(1)} MB`),
        h('button', { type: 'button', class: 'x', 'aria-label': 'Remove', onclick: () => { files.splice(i, 1); renderFiles(); } }, '✕'))),
      h('div', { class: 'hint' }, 'The fields below apply to every file. Edit each part afterwards for anything specific.'));
  }
  const choose = (list) => {
    for (const file of list) files.push({ file, name: nameOf(file) });
    renderFiles();
  };
  fileInput.addEventListener('change', () => choose(fileInput.files));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); choose(e.dataTransfer.files); });

  leaveGuard = () => !files.length || submit.dataset.done === '1' || confirm('Discard this upload?');

  // XHR (not fetch) for upload progress on big files.
  const send = (file, meta, onProgress) => new Promise((resolve, reject) => {
    const body = new FormData();
    body.append('meta', JSON.stringify(meta));
    body.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/hub/parts');
    xhr.upload.onprogress = (ev) => ev.lengthComputable && onProgress(ev.loaded / ev.total);
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || '{}');
      xhr.status < 300 ? resolve(data) : reject(new Error(`${file.name}: ${data.error ?? `upload failed (${xhr.status})`}`));
    };
    xhr.onerror = () => reject(new Error(`${file.name}: network error`));
    xhr.send(body);
  });

  fill(view,
    h('a', { class: 'back', href: '#/' }, '← All parts'),
    h('div', { class: 'page-head' }, title),
    h('p', { class: 'intro' }, 'Uploads are saved here and get a picture right away. They reach the Onshape panel when someone presses ', h('strong', {}, 'Update Onshape'), ' on the parts list, which sends everything waiting in one batch.'),
    h('form', {
      class: 'panel',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!files.length) return toast('Choose a CAD file first', 'err');
        const shared = form.read();
        const jobs = files.length === 1 ? [{ file: files[0].file, meta: shared }] : files.map((f) => ({ file: f.file, meta: { ...shared, name: f.name.trim() } }));
        if (jobs.some((j) => !j.meta.name)) return toast('Every part needs a display name', 'err');
        submit.disabled = true;
        progress.hidden = false;
        const done = [];
        try {
          for (const [i, j] of jobs.entries()) {
            progressText.textContent = jobs.length > 1 ? `Uploading ${i + 1} of ${jobs.length}` : 'Uploading';
            done.push(await send(j.file, j.meta, (f) => (progress.value = ((i + f) / jobs.length) * 100)));
          }
        } catch (err) {
          toast(done.length ? `${err.message} (${done.length} uploaded before this)` : err.message, 'err');
          files = files.slice(done.length);
          renderFiles();
          submit.disabled = false;
          progress.hidden = true;
          progressText.textContent = '';
          return;
        }
        submit.dataset.done = '1';
        toast(`Uploaded ${done.length} part${done.length === 1 ? '' : 's'}. Press Update Onshape when your batch is ready.`, 'ok');
        location.hash = done.length === 1 ? `#/parts/${done[0].id}` : '#/';
      },
    }, drop, batchList, form.el, h('div', { class: 'savebar' }, submit, progressText), progress),
  );
}

// ---- boot ------------------------------------------------------------------------------------

let allParts = [];
async function boot() {
  try {
    [me, categories, allParts] = await Promise.all([api('me'), api('categories'), api('parts?archived=1')]);
  } catch (err) {
    fill(view, h('p', { class: 'empty' }, err.message));
    return;
  }
  fill($('#user'), me.email, me.mock ? h('span', { class: 'badge-mock' }, 'mock Onshape') : null);
  route();
}
boot();
