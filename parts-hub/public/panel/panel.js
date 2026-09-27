// STAR Parts panel: runs in Onshape's right panel (an iframe) inside an assembly.
import { buildIndex, formatCost, search } from './shared/search.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const ctx = {
  documentId: params.get('documentId') ?? '',
  wvm: params.get('workspaceOrVersion') ?? '',
  wvmId: params.get('workspaceOrVersionId') ?? '',
  elementId: params.get('elementId') ?? '',
};
const canInsert = ctx.wvm === 'w' && ctx.documentId && ctx.wvmId && ctx.elementId;

const state = {
  parts: [],
  index: [],
  results: [],
  byId: new Map(),
  category: '',
  active: -1, // highlighted card
  gridMode: false, // arrow keys move the highlight left/right instead of the caret
  drawerPart: null,
  busy: new Set(),
};

// ---- storage (partitioned in the iframe; may be unavailable) -------------------

const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {}
  },
};
const SESSION_KEY = 'sph.session';
const RECENT_KEY = 'sph.recent';
let session = null;

function takeSession() {
  const fromHash = /session=([\w-]+)/.exec(location.hash)?.[1];
  if (fromHash) {
    store.set(SESSION_KEY, fromHash);
    history.replaceState(null, '', location.pathname + location.search);
    sessionStorage.removeItem('sph.signinTries');
  }
  session = fromHash ?? store.get(SESSION_KEY);
}

function signIn() {
  store.set(SESSION_KEY, null);
  const url = `oauth/start?${params.toString()}`;
  // Guard against a redirect loop if sign-in keeps failing: then ask for a click.
  const tries = Number(sessionStorage.getItem('sph.signinTries') ?? 0);
  if (tries < 2) {
    sessionStorage.setItem('sph.signinTries', String(tries + 1));
    location.href = url;
  } else {
    $('signin-link').href = url;
    $('signin-link').onclick = () => sessionStorage.removeItem('sph.signinTries');
    $('signin').hidden = false;
  }
}

async function api(path, body) {
  const res = await fetch(`api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${session}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    signIn();
    throw new Error('Signing in to Onshape…');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

// ---- DOM helpers ----------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const initials = (name) => name.split(/\s+/).filter((w) => /[a-z]/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

function thumb(part, cls = 'thumb') {
  return h('div', { class: cls }, part.thumbUrl ? h('img', { src: part.thumbUrl, alt: '', loading: 'lazy' }) : h('span', { class: 'ph' }, initials(part.name)));
}

function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, message);
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 2500);
}

// ---- rendering ----------------------------------------------------------------

function renderChips() {
  const cats = [...new Set(state.parts.map((p) => p.category).filter(Boolean))].sort();
  $('chips').replaceChildren(
    ...['', ...cats].map((c) =>
      h('button', {
        class: 'chip',
        'aria-pressed': String(state.category === c),
        onclick: () => {
          state.category = state.category === c ? '' : c;
          renderChips();
          update();
        },
      }, c || 'All'),
    ),
  );
  $('chips').hidden = cats.length < 2;
}

function renderRecent() {
  const ids = JSON.parse(store.get(RECENT_KEY) ?? '[]');
  const recent = ids.map((id) => state.byId.get(id)).filter(Boolean);
  const show = recent.length && !$('search').value.trim() && !state.category;
  $('recent-wrap').hidden = !show;
  if (!show) return;
  $('recent').replaceChildren(
    ...recent.map((p) =>
      h('button', { title: `Insert ${p.name}`, 'aria-label': `Insert ${p.name}`, onclick: () => insert(p) },
        p.thumbUrl ? h('img', { src: p.thumbUrl, alt: '' }) : initials(p.name)),
    ),
  );
}

function renderGrid() {
  const grid = $('grid');
  grid.replaceChildren(
    ...state.results.map((p, i) => {
      const card = h('div', {
        class: `card${i === state.active ? ' active' : ''}${state.busy.has(p.id) ? ' busy' : ''}`,
        role: 'option',
        'aria-selected': String(i === state.active),
        onclick: () => insert(p),
        onmouseenter: (e) => schedulePopover(p, e.currentTarget),
        onmouseleave: hidePopover,
      },
      thumb(p),
      h('div', { class: 'name' }, p.name),
      h('button', {
        class: 'info',
        'aria-label': `Details for ${p.name}`,
        title: 'Details',
        onclick: (e) => {
          e.stopPropagation();
          openDrawer(p);
        },
        onmouseenter: (e) => { e.stopPropagation(); hidePopover(); },
      }, 'i'));
      card.dataset.index = i;
      return card;
    }),
  );
  const q = $('search').value.trim();
  $('empty').hidden = state.results.length > 0;
  $('empty').textContent = state.parts.length === 0 ? 'No parts in the library yet.' : q ? `No parts match “${q}”.` : 'No parts in this category.';
}

function update({ keepActive = false } = {}) {
  const q = $('search').value;
  state.results = search(state.index, q, { category: state.category });
  if (!keepActive) state.active = q.trim() && state.results.length ? 0 : -1;
  renderRecent();
  renderGrid();
}

function setActive(i) {
  if (!state.results.length) return;
  state.active = Math.max(0, Math.min(state.results.length - 1, i));
  document.querySelectorAll('.card').forEach((c) => {
    const on = Number(c.dataset.index) === state.active;
    c.classList.toggle('active', on);
    c.setAttribute('aria-selected', String(on));
    if (on) c.scrollIntoView({ block: 'nearest' });
  });
}

// ---- hover popover (quick info) ---------------------------------------------------

let popoverTimer = 0;
function schedulePopover(part, card) {
  clearTimeout(popoverTimer);
  popoverTimer = setTimeout(() => showPopover(part, card), 400);
}
function hidePopover() {
  clearTimeout(popoverTimer);
  $('popover').hidden = true;
}
function showPopover(part, card) {
  const rows = [
    ['Part #', part.partNumber],
    ['Vendor', part.vendor],
    ['Cost', formatCost(part.unitCost)],
    ['Category', part.category],
  ].filter(([, v]) => v);
  if (!rows.length || !$('drawer').hidden) return;
  const pop = $('popover');
  pop.replaceChildren(h('dl', {}, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
  pop.hidden = false;
  const r = card.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const left = Math.max(6, Math.min(r.left + r.width / 2 - pw / 2, innerWidth - pw - 6));
  const below = r.bottom - 18 + ph < innerHeight - 6;
  pop.style.left = `${left}px`;
  pop.style.top = `${below ? r.bottom - 18 : r.top - ph + 18}px`;
}

// ---- details drawer --------------------------------------------------------------

function openDrawer(part) {
  hidePopover();
  state.drawerPart = part;
  const facts = [
    ['Part #', part.partNumber],
    ['Vendor', part.vendor],
    ['Category', part.category],
    ['Cost', [formatCost(part.unitCost), part.costNote].filter(Boolean).join(' · ')],
  ].filter(([, v]) => v);
  const section = (title, ...content) => [h('h3', {}, title), ...content];
  $('drawer-body').replaceChildren(...[
    h('div', { class: 'hero' }, part.thumbUrl ? h('img', { src: part.thumbUrl, alt: '' }) : null),
    h('h1', {}, part.name),
    facts.length ? h('dl', {}, facts.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])) : null,
    part.tags?.length ? section('Tags', h('div', { class: 'tags' }, part.tags.map((t) => h('span', { class: 'tag' }, t)))) : null,
    part.links?.length
      ? section('Links', h('ul', {}, part.links.map((l) => h('li', {}, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.label || l.url)))))
      : null,
    part.customFields?.length ? section('Specs', h('dl', {}, part.customFields.map((f) => [h('dt', {}, f.key), h('dd', {}, f.value)]))) : null,
    part.description ? section('Description', h('p', {}, part.description)) : null,
    part.notes ? section('Notes', h('p', {}, part.notes)) : null,
    h('a', { class: 'hub-link', href: part.hubUrl, target: '_blank', rel: 'noopener' }, 'Open in Parts Hub ↗'),
  ].flat().filter(Boolean));
  $('drawer-insert').disabled = !canInsert;
  $('drawer').hidden = false;
  $('drawer-close').focus();
}

function closeDrawer() {
  $('drawer').hidden = true;
  state.drawerPart = null;
  $('search').focus();
}

// ---- insert ---------------------------------------------------------------------

async function insert(part) {
  hidePopover();
  if (!canInsert) {
    toast('Open an assembly workspace to insert', 'err');
    return;
  }
  if (state.busy.has(part.id)) return;
  state.busy.add(part.id);
  renderGrid();
  try {
    await api('insert', { partId: part.id, documentId: ctx.documentId, workspaceId: ctx.wvmId, elementId: ctx.elementId });
    toast(`Inserted ${part.name}`, 'ok');
    const ids = JSON.parse(store.get(RECENT_KEY) ?? '[]').filter((id) => id !== part.id);
    store.set(RECENT_KEY, JSON.stringify([part.id, ...ids].slice(0, 8)));
    renderRecent();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    state.busy.delete(part.id);
    renderGrid();
  }
}

// ---- keyboard -------------------------------------------------------------------

function onKey(e) {
  if (e.key === 'Escape') {
    if (!$('drawer').hidden) closeDrawer();
    else if ($('search').value) {
      $('search').value = '';
      state.gridMode = false;
      update();
    }
    hidePopover();
    return;
  }
  if (!$('drawer').hidden || e.target !== $('search')) return;
  const cols = 2;
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      state.gridMode = true;
      setActive(state.active < 0 ? 0 : state.active + cols);
      break;
    case 'ArrowUp':
      e.preventDefault();
      state.gridMode = true;
      setActive(state.active - cols);
      break;
    case 'ArrowRight':
    case 'ArrowLeft':
      if (!state.gridMode) return; // move the caret instead
      e.preventDefault();
      setActive(state.active + (e.key === 'ArrowRight' ? 1 : -1));
      break;
    case 'Enter': {
      const part = state.results[state.active];
      if (part) {
        e.preventDefault();
        insert(part);
      }
      break;
    }
  }
}

// ---- boot -----------------------------------------------------------------------

function tellOnshapeWereReady() {
  // Onshape client messaging: only talk to an Onshape origin.
  const server = params.get('server');
  if (!server || !/^https:\/\/[\w.-]+\.onshape\.com$/.test(server) || window.parent === window) return;
  window.parent.postMessage({ documentId: ctx.documentId, workspaceId: ctx.wvmId, elementId: ctx.elementId, messageName: 'applicationInit' }, server);
}

async function boot() {
  takeSession();
  if (!session) return signIn();
  if (!canInsert) {
    $('banner').textContent = ctx.wvm === 'v' ? 'Viewing a version. Open an assembly workspace to insert.' : 'Open an assembly workspace to insert.';
    $('banner').hidden = false;
  }
  $('search').addEventListener('input', () => {
    state.gridMode = false;
    hidePopover();
    update();
  });
  document.addEventListener('keydown', onKey);
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-insert').addEventListener('click', () => state.drawerPart && insert(state.drawerPart));
  $('main').addEventListener('scroll', hidePopover, { passive: true });
  $('search').focus();
  tellOnshapeWereReady();

  try {
    state.parts = await api('catalog');
  } catch (err) {
    $('empty').hidden = false;
    $('empty').textContent = err.message;
    return;
  }
  state.byId = new Map(state.parts.map((p) => [p.id, p]));
  state.index = buildIndex(state.parts);
  renderChips();
  update();
}

boot();
