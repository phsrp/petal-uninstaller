// Petal Uninstaller - window logic.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const icon = (n, cls = '') => `<span class="i ${cls}">${svg(n)}</span>`;
const svg = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${window.TABLER[n] || ''}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hydrateIcons(root = document) {
  for (const el of $$('.i[data-i]', root)) { el.innerHTML = svg(el.dataset.i); el.removeAttribute('data-i'); }
}

const state = {
  // Desktop programs and Store apps are scanned separately but shown as one list.
  apps: { desktop: [], store: [] },
  loaded: { desktop: false, store: false },
  checked: new Set(),
  focused: null,
  query: '',
  sort: { key: 'name', dir: 1 },
  icons: new Map(),
  busy: false,
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('petal.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('petal.' + k, JSON.stringify(v)); } catch {} },
};

// ---------- formatting ----------
function fmtBytes(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${u[i]}`;
}
const fmtKB = (kb) => fmtBytes((kb || 0) * 1024);
function fmtDate(d) {
  if (!/^\d{8}$/.test(d || '')) return '';
  const dt = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
  return isNaN(dt) ? '' : dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function highlight(text, q) {
  const t = esc(text);
  if (!q) return t;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t;
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#btn-theme').innerHTML = icon(t === 'light' ? 'moon' : 'sun');
  const cs = getComputedStyle(document.documentElement);
  window.petal.titlebar({ color: cs.getPropertyValue('--surface').trim(), symbol: cs.getPropertyValue('--subtle').trim() });
  store.set('theme', t);
}

// ---------- data ----------
async function load(kind, { quiet = false } = {}) {
  if (!quiet) $('#loading').hidden = false;
  try {
    const list = await window.petal.list(kind);
    state.apps[kind] = list;
    state.loaded[kind] = true;
    const ids = new Set(allApps().map((a) => a.id));
    for (const id of [...state.checked]) if (!ids.has(id)) state.checked.delete(id);
    const n = allApps().length;
    $('#app-count').textContent = `${n} app${n === 1 ? '' : 's'}`;
  } catch (e) {
    toast('Could not read installed programs: ' + e.message, true);
  }
  if (kind === 'desktop') $('#loading').hidden = true;
  if (state.loaded.desktop) render();
}
const allApps = () => [...state.apps.desktop, ...state.apps.store];
const loadAll = (opts) => Promise.all([load('desktop', opts), load('store', { quiet: true })]);

function visible() {
  const q = state.query.trim().toLowerCase();
  let list = allApps();
  if (q) list = list.filter((a) => a.name.toLowerCase().includes(q) || (a.publisher || '').toLowerCase().includes(q));
  const { key, dir } = state.sort;
  return [...list].sort((a, b) => {
    let x = a[key], y = b[key];
    if (key === 'sizeKB' || key === 'installDate') {
      x = key === 'sizeKB' ? x || 0 : +x || 0; y = key === 'sizeKB' ? y || 0 : +y || 0;
      if (!x !== !y) return x ? -1 : 1; // empty values always last
      return (x - y) * dir;
    }
    return String(x || '').localeCompare(String(y || ''), undefined, { sensitivity: 'base', numeric: true }) * dir || a.name.localeCompare(b.name);
  });
}
const byId = (id) => state.apps.desktop.find((a) => a.id === id) || state.apps.store.find((a) => a.id === id);

// ---------- list rendering ----------
let rendered = [];
function render() {
  rendered = visible();
  const checked = state.checked;
  const q = state.query.trim();
  $('#list').innerHTML = rendered.map((a, i) => `
    <div class="row${checked.has(a.id) ? ' checked' : ''}${state.focused === a.id ? ' focused' : ''}" data-i="${i}">
      <label class="cb"><input type="checkbox" ${checked.has(a.id) ? 'checked' : ''} tabindex="-1"><span></span></label>
      <span class="app-icon ${a.kind}" data-icon="${i}">${iconHtml(a)}</span>
      <span class="cell name"><span class="t">${highlight(a.name, q)}</span>${a.kind === 'store' ? '<span class="pill store" title="Microsoft Store app (Windows package)">Store</span>' : ''}${a.isNew ? '<span class="pill new">New</span>' : ''}${a.kind === 'desktop' && !a.hasUninstaller ? '<span class="pill warn" title="No uninstaller registered">Broken</span>' : ''}</span>
      <span class="cell pub">${highlight(a.publisher || '', q)}</span>
      <span class="cell num">${fmtKB(a.sizeKB)}</span>
      <span class="cell num date">${fmtDate(a.installDate)}</span>
    </div>`).join('');
  const empty = !rendered.length && state.loaded.desktop;
  $('#empty').hidden = !empty;
  $('#empty-text').textContent = state.query ? 'Nothing matches your search.' : 'No programs found.';
  $$('.list-head .sort').forEach((s) => (s.innerHTML = ''));
  const sh = $(`.col[data-sort="${state.sort.key}"] .sort`);
  if (sh) sh.innerHTML = icon(state.sort.dir > 0 ? 'arrow-up' : 'arrow-down');
  updateSelection();
  loadIcons();
}
function iconHtml(a) {
  const u = state.icons.get(a.id);
  return u ? `<img src="${u}" alt="">` : icon(a.kind === 'store' ? 'brand-windows' : 'package');
}
let iconQueue = 0;
async function loadIcons() {
  const run = ++iconQueue;
  const todo = rendered.map((a, i) => [a, i]).filter(([a]) => !state.icons.has(a.id));
  const worker = async () => {
    while (todo.length && run === iconQueue) {
      const [a] = todo.shift();
      const url = await window.petal.icon(a);
      state.icons.set(a.id, url);
      if (!url) continue;
      const idx = rendered.indexOf(a);
      const el = idx >= 0 && $(`.app-icon[data-icon="${idx}"]`);
      if (el) el.innerHTML = `<img src="${url}" alt="">`;
      if (state.focused === a.id) { const d = $('.d-icon'); if (d) d.innerHTML = `<img src="${url}" alt="">`; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

function updateSelection() {
  const checked = state.checked;
  const sel = allApps().filter((a) => checked.has(a.id));
  const n = sel.length;
  $('#sel-count').textContent = n;
  const kb = sel.reduce((s, a) => s + (a.sizeKB || 0), 0);
  $('#sel-size').textContent = kb ? '· ' + fmtKB(kb) : '';
  $('#btn-uninstall-sel').disabled = !n || state.busy;
  $('#btn-force-sel').disabled = !n || state.busy;
  $('#btn-clear-sel').disabled = !n;
  $('#btn-uninstall-sel').lastChild.textContent = n > 1 ? `Uninstall ${n}` : 'Uninstall';
  const all = $('#check-all');
  const visChecked = rendered.filter((a) => checked.has(a.id)).length;
  all.checked = !!rendered.length && visChecked === rendered.length;
  all.indeterminate = visChecked > 0 && visChecked < rendered.length;
}

function toggleCheck(a, force) {
  const set = state.checked;
  const on = force ?? !set.has(a.id);
  on ? set.add(a.id) : set.delete(a.id);
  const idx = rendered.indexOf(a);
  const row = idx >= 0 && $(`.row[data-i="${idx}"]`);
  if (row) { row.classList.toggle('checked', on); $('input', row).checked = on; }
  updateSelection();
}

function focusApp(a, scroll = false) {
  state.focused = a ? a.id : null;
  $$('.row.focused').forEach((r) => r.classList.remove('focused'));
  const idx = a ? rendered.indexOf(a) : -1;
  const row = idx >= 0 && $(`.row[data-i="${idx}"]`);
  if (row) { row.classList.add('focused'); if (scroll) row.scrollIntoView({ block: 'nearest' }); }
  renderDetails(a);
}

// ---------- details panel ----------
function renderDetails(a) {
  const d = $('#details');
  if (!a) {
    d.innerHTML = `<div class="details-empty">${icon('package', 'big')}<p>Pick a program to see its details.</p><p class="hint">Tick several to uninstall them in one go.</p></div>`;
    return;
  }
  const facts = [
    ['versions', 'Version', a.version],
    ['ruler', 'Size', fmtKB(a.sizeKB)],
    ['calendar', 'Installed', fmtDate(a.installDate)],
    ['folder', 'Location', a.installLocation, a.installLocation ? 'open' : null],
    a.kind === 'desktop' ? ['hierarchy-2', 'Registry key', a.id, 'reg'] : ['archive', 'Package', a.id],
    a.kind === 'desktop' ? ['player-play', 'Uninstaller', a.uninstallString || 'None registered'] : null,
    a.kind === 'desktop' ? ['info-circle', 'Type', [a.msi ? 'Windows Installer (MSI)' : 'Setup program', a.arch === 'x86' ? '32-bit' : a.arch === 'user' ? 'Current user only' : '64-bit'].join(' · ')] : null,
  ].filter((f) => f && f[2]);
  d.innerHTML = `
    <div class="d-head"><div class="d-icon ${a.kind}">${iconHtml(a)}</div>
      <div><div class="d-name">${esc(a.name)}</div><div class="d-pub">${esc(a.publisher || 'Unknown publisher')}</div></div></div>
    <div class="d-actions">
      <button class="btn primary wide" data-act="uninstall">${icon('trash')}Uninstall</button>
      <button class="btn danger-ghost" data-act="force" title="Skip the uninstaller and delete everything it left">${icon('bolt')}Force remove</button>
      <button class="btn" data-act="leftovers" title="Look for leftover files and registry keys without uninstalling">${icon('spray')}Leftovers</button>
    </div>
    <div class="facts">${facts.map(([ic, k, v, act]) => `
      <div class="fact">${icon(ic)}<div><div class="k">${k}</div><div class="v${act ? ' link' : ''}" ${act ? `data-act="${act}"` : ''}>${esc(v)}</div></div></div>`).join('')}
    </div>
    <div class="links">
      <button class="btn small" data-act="web">${icon('world-search')}Search web</button>
      ${a.urlInfo || a.helpLink ? `<button class="btn small" data-act="site">${icon('external-link')}Website</button>` : ''}
      ${a.kind === 'desktop' ? `<button class="btn small" data-act="entry" title="Remove this program from the list without touching its files">${icon('eraser')}Remove entry</button>` : ''}
    </div>`;
  d.onclick = (e) => { const b = e.target.closest('[data-act]'); if (b) doAction(b.dataset.act, a); };
}

async function doAction(act, a) {
  const p = window.petal;
  switch (act) {
    case 'uninstall': return startJob([a], 'uninstall');
    case 'force': return startJob([a], 'force');
    case 'leftovers': return startJob([a], 'scan');
    case 'entry': return removeEntry(a);
    case 'open': if ((await p.open(a.installLocation)) === 'missing') toast('That folder no longer exists.', true); return;
    case 'reg': return p.regedit(a.id);
    case 'web': return p.url('https://www.google.com/search?q=' + encodeURIComponent(a.name + ' ' + (a.publisher || '')));
    case 'site': return p.url(a.urlInfo || a.helpLink);
    case 'copy': navigator.clipboard.writeText(a.name); return toast('Name copied');
    case 'check': return toggleCheck(a);
  }
}

// ---------- context menu ----------
function openMenu(x, y, a) {
  const m = $('#menu');
  const items = [
    ['trash', 'Uninstall', 'uninstall', 'Del'],
    ['bolt', 'Force remove', 'force', 'Shift+Del', 'danger'],
    ['spray', 'Find leftovers', 'leftovers'],
    a.kind === 'desktop' ? ['eraser', 'Remove entry only', 'entry'] : null,
    '-',
    ['folder-open', 'Open install folder', 'open', '', '', !a.installLocation],
    a.kind === 'desktop' ? ['hierarchy-2', 'Open in Registry Editor', 'reg'] : null,
    ['world-search', 'Search the web', 'web'],
    a.urlInfo || a.helpLink ? ['external-link', 'Program website', 'site'] : null,
    '-',
    ['copy', 'Copy name', 'copy'],
    ['check', state.checked.has(a.id) ? 'Untick' : 'Tick', 'check', 'Space'],
  ].filter(Boolean);
  m.innerHTML = items.map((it) => it === '-' ? '<hr>' :
    `<button data-act="${it[2]}" class="${it[4] || ''}" ${it[5] ? 'disabled' : ''}>${icon(it[0])}${it[1]}${it[3] ? `<kbd>${it[3]}</kbd>` : ''}</button>`).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  m.onclick = (e) => { const b = e.target.closest('button[data-act]'); if (!b) return; m.hidden = true; doAction(b.dataset.act, a); };
}
const closeMenu = () => ($('#menu').hidden = true);

// ---------- toasts ----------
function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.innerHTML = icon(err ? 'alert-triangle' : 'circle-check') + `<span>${esc(msg)}</span>`;
  $('#toasts').append(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = 0; setTimeout(() => t.remove(), 300); }, err ? 6000 : 3200);
}

// ---------- modal helpers ----------
function modal(html, cls = '') {
  $('#modal').className = 'modal ' + cls;
  $('#modal').innerHTML = html;
  $('#overlay').hidden = false;
  return $('#modal');
}
const closeModal = () => { $('#overlay').hidden = true; $('#modal').innerHTML = ''; };
function confirmBox({ title, text, iconName = 'alert-triangle', danger = false, ok = 'Continue', list = null, extra = '' }) {
  return new Promise((resolve) => {
    const m = modal(`
      <div class="modal-head">${icon(iconName, danger ? 'danger' : '')}<h2>${esc(title)}</h2></div>
      <div class="modal-sub">${text}</div>
      ${list ? `<div class="modal-body"><ul class="app-list">${list.map((a) => `<li><span class="app-icon ${a.kind}">${iconHtml(a)}</span>${esc(a.name)}<span class="muted">${fmtKB(a.sizeKB)}</span></li>`).join('')}</ul>${extra}</div>` : extra ? `<div class="modal-body">${extra}</div>` : ''}
      <div class="modal-foot"><div class="spacer"></div><button class="btn ghost" data-r="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div>`, 'narrow');
    m.onclick = (e) => { const b = e.target.closest('[data-r]'); if (b) { const v = b.dataset.r === '1'; if (!v) closeModal(); resolve(v); } };
    $('[data-r="1"]', m).focus();
  });
}

// ---------- jobs: uninstall / force / scan ----------
async function startJob(apps, mode) {
  if (state.busy) return;
  closeMenu();
  if (mode === 'force') {
    const ok = await confirmBox({
      title: apps.length > 1 ? `Force remove ${apps.length} programs?` : `Force remove ${apps[0].name}?`, danger: true, iconName: 'bolt', ok: 'Find everything',
      text: 'This skips the program\'s own uninstaller. Petal closes the program, then finds its folders, shortcuts and registry keys so you can delete them. You review the list first. Use it for programs that are broken or will not uninstall.',
      list: apps.length > 1 ? apps : null,
    });
    if (!ok) return;
  } else if (mode === 'uninstall' && apps.length > 1) {
    const ok = await confirmBox({
      title: `Uninstall ${apps.length} programs?`, iconName: 'trash', ok: `Uninstall ${apps.length}`,
      text: $('#quiet').checked ? 'Quiet uninstall is on, so programs that support it uninstall without a wizard. Others open their own uninstaller one after another.'
        : 'Each program\'s uninstaller opens one after another. Afterwards Petal scans for anything they left behind.',
      list: apps,
    });
    if (!ok) return;
  }
  state.busy = true;
  updateSelection();
  try { await runJob(apps, mode); } finally { state.busy = false; updateSelection(); }
}

async function runJob(apps, mode) {
  let stop = false;
  const titles = { uninstall: apps.length > 1 ? `Uninstalling ${apps.length} programs` : `Uninstalling ${apps[0].name}`, force: 'Force removal', scan: 'Looking for leftovers' };
  const m = modal(`
    <div class="modal-head">${icon(mode === 'force' ? 'bolt' : mode === 'scan' ? 'spray' : 'trash', mode === 'force' ? 'danger' : '')}<h2>${esc(titles[mode])}</h2></div>
    <div class="modal-sub" id="job-sub">Working through the list. Keep this window open.</div>
    <div class="modal-body"><div class="steps">${apps.map((a, i) => `
      <div class="step" data-s="${i}"><span class="state wait">${icon('clock')}</span><span class="app-icon ${a.kind}">${iconHtml(a)}</span>
      <span class="nm">${esc(a.name)}</span><span class="msg">Waiting</span></div>`).join('')}</div></div>
    <div class="modal-foot"><div class="spacer"></div><button class="btn ghost" id="job-stop">${apps.length > 1 ? 'Stop after this one' : 'Cancel'}</button></div>`);
  $('#job-stop', m).onclick = () => { stop = true; $('#job-stop', m).disabled = true; $('#job-stop', m).textContent = 'Stopping'; };

  const setStep = (i, st, msg, actions) => {
    const el = $(`.step[data-s="${i}"]`, m);
    const ic = { wait: 'clock', run: 'loader-2', ok: 'circle-check', fail: 'circle-x', skip: 'alert-triangle' }[st];
    $('.state', el).className = 'state ' + st;
    $('.state', el).innerHTML = icon(ic, st === 'run' ? 'spin' : '');
    el.classList.toggle('active', st === 'run' || !!actions);
    const msgEl = $('.msg', el);
    if (actions) {
      msgEl.outerHTML = `<span class="inline-actions msg">${actions.map(([k, label, cls]) => `<button class="btn small ${cls || ''}" data-k="${k}">${label}</button>`).join('')}</span>`;
      return new Promise((res) => { $('.inline-actions', el).onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) res(b.dataset.k); }; });
    }
    if (!msgEl.classList.contains('inline-actions')) { msgEl.textContent = msg; msgEl.title = msg; }
    else msgEl.outerHTML = `<span class="msg" title="${esc(msg)}">${esc(msg)}</span>`;
  };

  const found = []; // { app, items }
  const outcome = new Map();
  for (let i = 0; i < apps.length; i++) {
    if (stop) { setStep(i, 'skip', 'Skipped'); continue; }
    const a = apps[i];
    let doForce = mode === 'force';
    if (mode === 'uninstall' || (doForce && a.kind === 'store')) {
      setStep(i, 'run', a.kind === 'store' ? 'Removing app' : 'Uninstaller is running');
      const r = await window.petal.uninstall(a, { quiet: $('#quiet').checked });
      let still = await window.petal.exists(a);
      while (still && !doForce) {
        const why = r.missing ? 'Uninstaller missing' : r.ok ? 'Still installed' : `Uninstaller failed (${r.code ?? 'error'})`;
        const pick = await setStep(i, 'skip', '', [['skip', 'Skip'], ['retry', 'Check again'], ['force', why + ' · Force remove', 'danger-ghost']]);
        if (pick === 'skip') break;
        if (pick === 'force') { doForce = true; break; }
        setStep(i, 'run', 'Checking');
        await sleep(800);
        still = await window.petal.exists(a);
      }
      if (still && !doForce) { setStep(i, 'skip', 'Left installed'); outcome.set(a.id, 'kept'); continue; }
      outcome.set(a.id, 'removed');
    }
    setStep(i, 'run', 'Scanning for leftovers');
    const items = await window.petal.leftovers(a, { includeEntry: true });
    if (doForce) items.forEach((it) => { if (it.confidence === 'high') it.force = true; });
    found.push({ app: a, items, force: doForce });
    const n = items.length;
    setStep(i, 'ok', n ? `${n} leftover${n > 1 ? 's' : ''} found` : mode === 'scan' ? 'Nothing found' : 'Clean, nothing left');
  }

  const anyLeft = found.some((f) => f.items.length);
  if (!anyLeft) {
    $('#job-sub', m).textContent = mode === 'scan' ? 'No leftovers found.' : 'All done. Nothing was left behind.';
    $('.modal-foot', m).innerHTML = `<div class="spacer"></div><button class="btn primary" id="job-done">Done</button>`;
    await new Promise((r) => ($('#job-done', m).onclick = r));
    closeModal();
    refreshAfterJob(outcome);
    return;
  }
  await sleep(250);
  await reviewLeftovers(found, mode);
  refreshAfterJob(outcome);
}

function refreshAfterJob(outcome) {
  for (const [id, o] of outcome) if (o === 'removed') state.checked.delete(id);
  loadAll({ quiet: true });
}

const typeIcon = { folder: 'folder', file: 'file', key: 'key', value: 'key' };
async function reviewLeftovers(found, mode) {
  const groups = found.filter((f) => f.items.length);
  let flat = [];
  groups.forEach((g, gi) => g.items.forEach((it) => { it.g = gi; it.on = it.confidence === 'high'; flat.push(it); }));
  flat.forEach((it, i) => (it.i = i));
  const m = modal(`
    <div class="modal-head">${icon('spray')}<h2>Leftovers found</h2></div>
    <div class="modal-sub">Tick what to delete. Items marked <span class="pill high">Sure</span> clearly belong to the program. Check items marked <span class="pill low">Check</span> before deleting them. Registry keys are backed up first.</div>
    <div class="modal-body">${groups.map((g, gi) => `
      <div class="group">
        <div class="group-head"><label class="cb"><input type="checkbox" data-g="${gi}"><span></span></label><span class="app-icon ${g.app.kind}">${iconHtml(g.app)}</span>${esc(g.app.name)}
          <span class="muted">${g.items.length} item${g.items.length > 1 ? 's' : ''}</span></div>
        ${g.items.map((it) => `
          <label class="left" data-l="${it.i}" title="${esc(it.path + (it.value ? ' → ' + it.value : ''))}\n${esc(it.why)}">
            <span class="cb"><input type="checkbox" data-it="${it.i}" ${it.on ? 'checked' : ''}><span></span></span>
            ${icon(typeIcon[it.type])}
            <span class="p"><bdi>${esc(it.path)}${it.value ? ' → ' + esc(it.value) : ''}</bdi></span>
            <span class="pill ${it.confidence}">${it.confidence === 'high' ? 'Sure' : 'Check'}</span>
            <span class="sz">${it.type === 'key' || it.type === 'value' ? 'Registry' : fmtBytes(it.bytes) || '0 B'}</span>
          </label>`).join('')}
      </div>`).join('')}</div>
    <div class="modal-foot">
      <label class="toggle"><input type="checkbox" id="recycle" ${store.get('recycle', true) ? 'checked' : ''}><span class="track"></span>Move files to Recycle Bin</label>
      <div class="spacer"></div>
      <button class="btn ghost" id="lo-skip">Keep all</button>
      <button class="btn danger" id="lo-del">${icon('trash')}<span class="lbl">Delete</span></button>
    </div>`);
  const sync = () => {
    const on = flat.filter((it) => it.on);
    const bytes = on.reduce((s, it) => s + (it.bytes || 0), 0);
    $('#lo-del .lbl', m).textContent = on.length ? `Delete ${on.length}${bytes ? ' · ' + fmtBytes(bytes) : ''}` : 'Delete';
    $('#lo-del', m).disabled = !on.length;
    groups.forEach((g, gi) => {
      const c = $(`input[data-g="${gi}"]`, m);
      const n = g.items.filter((it) => it.on).length;
      c.checked = n === g.items.length; c.indeterminate = n > 0 && n < g.items.length;
    });
  };
  m.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.it != null) flat[+t.dataset.it].on = t.checked;
    if (t.dataset.g != null) { groups[+t.dataset.g].items.forEach((it) => { it.on = t.checked; $(`input[data-it="${it.i}"]`, m).checked = t.checked; }); }
    if (t.id === 'recycle') store.set('recycle', t.checked);
    sync();
  });
  sync();
  const choice = await new Promise((r) => { $('#lo-skip', m).onclick = () => r(false); $('#lo-del', m).onclick = () => r(true); });
  if (!choice) { closeModal(); return; }

  const items = flat.filter((it) => it.on).map(({ type, path, value }) => ({ type, path, value }));
  $('.modal-foot', m).innerHTML = `<span class="i spin">${svg('loader-2')}</span><span class="muted">Deleting. Windows may ask for permission.</span>`;
  const res = await window.petal.clean(items, { recycle: $('#recycle', m)?.checked ?? store.get('recycle', true) });
  if (res.cancelled) {
    toast('Cleanup cancelled. Nothing was deleted.', true);
    closeModal();
    return;
  }
  const failed = res.results.filter((r) => !r.ok);
  const okBytes = flat.filter((it) => it.on && res.results.find((r) => r.ok && r.path === it.path && (r.value || null) == (it.value || null))).reduce((s, it) => s + (it.bytes || 0), 0);
  modal(`
    <div class="modal-head">${icon(failed.length ? 'alert-triangle' : 'circle-check')}<h2>${failed.length ? 'Mostly cleaned up' : 'All cleaned up'}</h2></div>
    <div class="modal-body">
      <div class="summary">
        <div class="stat"><b>${res.results.length - failed.length}</b><span>items removed</span></div>
        <div class="stat"><b>${fmtBytes(okBytes) || '0 B'}</b><span>space freed${$('#recycle')?.checked ?? store.get('recycle', true) ? ' (in Recycle Bin)' : ''}</span></div>
        <div class="stat"><b>${res.killed || 0}</b><span>processes closed</span></div>
      </div>
      ${failed.length ? `<div class="notice">${icon('alert-triangle')}<div>These could not be removed, usually because a file is in use. Restart Windows and run Force remove again.</div></div>
        ${failed.map((f) => `<div class="left failed" title="${esc(f.error)}">${icon(typeIcon[f.type])}<span></span><span class="p"><bdi>${esc(f.path)}</bdi></span><span class="why">${esc(f.error || 'Failed')}</span><span></span></div>`).join('')}` : ''}
      ${res.selftest ? '<div class="notice">Self-test mode: nothing was really deleted.</div>' : ''}
    </div>
    <div class="modal-foot"><button class="btn ghost" id="sum-bak">${icon('history')}Registry backups</button><div class="spacer"></div><button class="btn primary" id="sum-ok">Done</button></div>`);
  $('#sum-bak').onclick = () => window.petal.backups();
  await new Promise((r) => ($('#sum-ok').onclick = r));
  closeModal();
}

async function removeEntry(a) {
  const ok = await confirmBox({
    title: 'Remove entry only?', iconName: 'eraser', ok: 'Remove entry',
    text: `This removes <b>${esc(a.name)}</b> from the installed programs list (and from Windows Settings) without touching its files. Use it for entries left behind by programs that are already gone. The registry key is backed up first.`,
  });
  if (!ok) return;
  const res = await window.petal.clean([{ type: 'key', path: a.id }]);
  closeModal();
  if (res.cancelled) return toast('Cancelled.', true);
  if (res.results[0]?.ok) { toast(`${a.name} removed from the list`); if (state.focused === a.id) focusApp(null); loadAll({ quiet: true }); }
  else toast('Could not remove the entry: ' + (res.results[0]?.error || 'unknown error'), true);
}

// ---------- events ----------
function checkedApps() { return allApps().filter((a) => state.checked.has(a.id)); }

$('#list').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const a = rendered[+row.dataset.i];
  if (e.target.closest('.cb')) { e.preventDefault(); toggleCheck(a); return; }
  if (e.ctrlKey) { toggleCheck(a); }
  else if (e.shiftKey && state.focused) {
    const from = rendered.findIndex((x) => x.id === state.focused);
    const to = +row.dataset.i;
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) toggleCheck(rendered[i], true);
  }
  focusApp(a);
});
$('#list').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.row');
  if (row && !e.target.closest('.cb')) startJob([rendered[+row.dataset.i]], 'uninstall');
});
$('#list').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  const a = rendered[+row.dataset.i];
  focusApp(a);
  openMenu(e.clientX, e.clientY, a);
});
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu')) closeMenu(); });
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
$('#list').addEventListener('scroll', closeMenu);

$('#check-all').addEventListener('change', (e) => { rendered.forEach((a) => toggleCheck(a, e.target.checked)); });
$$('.col[data-sort]').forEach((c) => c.addEventListener('click', () => {
  const k = c.dataset.sort;
  state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: k === 'name' || k === 'publisher' ? 1 : -1 };
  store.set('sort', state.sort);
  render();
}));
const search = $('#search');
search.addEventListener('input', () => { state.query = search.value; search.parentElement.classList.toggle('has-text', !!search.value); render(); $('#list').scrollTop = 0; });
$('#clear-search').addEventListener('click', () => { search.value = ''; search.dispatchEvent(new Event('input')); search.focus(); });
$('#btn-refresh').addEventListener('click', () => loadAll());
$('#btn-theme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
$('#btn-backups').addEventListener('click', () => window.petal.backups());
$('#btn-export').addEventListener('click', async () => {
  const rows = visible().map((a) => ({ name: a.name + (a.kind === 'store' ? ' (Store)' : ''), publisher: a.publisher, version: a.version, size: fmtKB(a.sizeKB), date: fmtDate(a.installDate) }));
  if (await window.petal.exportHtml(rows, 'Installed programs')) toast('List exported');
});
$('#btn-admin').addEventListener('click', () => window.petal.relaunchAdmin());
$('#btn-uninstall-sel').addEventListener('click', () => startJob(checkedApps(), 'uninstall'));
$('#btn-force-sel').addEventListener('click', () => startJob(checkedApps(), 'force'));
$('#btn-clear-sel').addEventListener('click', () => { state.checked.clear(); render(); });
$('#quiet').addEventListener('change', (e) => store.set('quiet', e.target.checked));
$('#overlay').addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('[data-r="0"]', $('#modal'))) $('[data-r="0"]', $('#modal')).click(); });

document.addEventListener('keydown', (e) => {
  if (!$('#overlay').hidden) return;
  if (e.key === 'Escape') { closeMenu(); if (state.query) { $('#clear-search').click(); } return; }
  if (e.key === 'F5') { e.preventDefault(); loadAll(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); search.focus(); search.select(); return; }
  const inSearch = document.activeElement === search;
  const cur = rendered.findIndex((a) => a.id === state.focused);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = Math.max(0, Math.min(rendered.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
    if (rendered[n]) focusApp(rendered[n], true);
    if (inSearch) search.blur();
    return;
  }
  if (inSearch) { if (e.key === 'Enter' && rendered.length) { search.blur(); focusApp(rendered[0], true); } return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'a') { e.preventDefault(); rendered.forEach((a) => toggleCheck(a, true)); return; }
  const a = rendered[cur];
  if (e.key === ' ' && a) { e.preventDefault(); toggleCheck(a); return; }
  if (e.key === 'Delete') {
    const sel = checkedApps();
    const targets = sel.length ? sel : a ? [a] : [];
    if (targets.length) startJob(targets, e.shiftKey ? 'force' : 'uninstall');
    return;
  }
  if (e.key === 'Enter' && a) { startJob([a], 'uninstall'); return; }
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && /\S/.test(e.key)) { search.focus(); }
});

// ---------- start ----------
(async function init() {
  hydrateIcons();
  applyTheme(store.get('theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  state.sort = store.get('sort', state.sort);
  $('#quiet').checked = store.get('quiet', false);
  $('#admin-banner').hidden = await window.petal.isAdmin();
  await loadAll();
  const st = await window.petal.selftest.info();
  if (st.on) { const s = document.createElement('script'); s.src = 'selftest.js'; document.body.append(s); }
})();
