// Runs only with PETAL_SELFTEST=1. Clicks through the UI, saves screenshots, never deletes anything (main fakes clean).
(async () => {
  const t = window.petal.selftest;
  window.addEventListener('error', (e) => t.log('PAGE ERROR', e.message));
  window.addEventListener('unhandledrejection', (e) => t.log('PAGE REJECTION', String(e.reason && e.reason.stack || e.reason)));
  const log = (...a) => t.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await wait(150); } throw new Error('timeout'); };
  try {
    await until(() => state.loaded.desktop && state.loaded.store);
    if ((await t.info()).target === 'e2e') { await e2e(); t.quit(); return; }
    log('desktop', state.apps.desktop.length, 'store', state.apps.store.length);
    await wait(1500);
    applyTheme('dark');
    const rowsWithIcons = $$('.row img').length;
    log('rows', $$('.row').length, 'icons', rowsWithIcons);
    await t.shot('01-main-dark');

    const pick = rendered.filter((a) => a.installLocation).slice(0, 3);
    pick.forEach((a) => toggleCheck(a, true));
    focusApp(pick[0], true);
    await wait(300);
    await t.shot('02-selection-details');

    focusApp(pick[0], true);
    const row = $('.row.focused');
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 260, clientY: r.top + 20 }));
    await wait(200);
    await t.shot('03-context-menu');
    closeMenu();

    search.value = 'micro'; search.dispatchEvent(new Event('input'));
    await wait(300);
    log('search micro ->', rendered.length);
    await t.shot('04-search');
    search.value = ''; search.dispatchEvent(new Event('input'));

    // Batch confirm dialog
    $('#btn-uninstall-sel').click();
    await wait(300);
    await t.shot('05-batch-confirm');
    $('[data-r="0"]').click();
    await wait(200);

    // Real (read-only) leftover scan on the chosen apps, then fake delete
    const target = await process_env_target(pick);
    log('scan target', target.map((a) => a.name));
    const job = startJob(target, 'scan');
    await until(() => $('#lo-del') || $('#job-done'), 120000);
    await wait(1200);
    const items = $$('.left').map((el) => el.title.split('\n')[0]);
    log('leftovers found', items.length, items);
    await t.shot('06-leftovers');
    if ($('#lo-del')) {
      $('#lo-del').click();
      await until(() => $('#sum-ok'));
      await wait(200);
      await t.shot('07-summary');
      $('#sum-ok').click();
    } else $('#job-done').click();
    await job;

    applyTheme('light');
    await wait(300);
    await t.shot('08-main-light');
    switchKind('store');
    await wait(1500);
    await t.shot('09-store-light');
    applyTheme('dark');
    log('DONE');
  } catch (e) {
    log('SELFTEST FAILED', e.message, e.stack);
  }
  t.quit();

  // Real uninstall + force removal of the two fake apps made by scripts/make-test-apps.ps1
  async function e2e() {
    const find = (n) => state.apps.desktop.find((a) => a.name === n);
    const review = async (label) => {
      await until(() => $('#lo-del') || $('#job-done'), 120000);
      const items = $$('.left').map((el) => el.title.split('\n')[0]);
      log(label, 'leftovers', items);
      await t.shot('e2e-' + label + '-review');
      $('#lo-del').click();
      await until(() => $('#sum-ok'), 120000);
      log(label, 'summary', $('#modal .modal-head h2').textContent, $$('.stat b').map((b) => b.textContent));
      await t.shot('e2e-' + label + '-summary');
      $('#sum-ok').click();
    };
    const a = find('Petal Test App 1.0');
    log('test app present', !!a);
    store.set('recycle', true);
    let job = startJob([a], 'uninstall');
    await review('uninstall');
    await job;
    const b = find('Petal Broken App');
    log('broken app present', !!b, 'hasUninstaller', b && b.hasUninstaller);
    store.set('recycle', false);
    job = startJob([b], 'force');
    await until(() => $('[data-r="1"]'));
    await t.shot('e2e-force-confirm');
    $('[data-r="1"]').click();
    await review('force');
    await job;
    await wait(2500);
    log('after: test app listed', !!find('Petal Test App 1.0'), 'broken listed', !!find('Petal Broken App'));
    store.set('recycle', true);
  }

  async function process_env_target(pick) {
    const want = ((await t.info()).target || '').toLowerCase();
    const all = state.apps.desktop;
    const hit = want && all.filter((a) => a.name.toLowerCase().includes(want));
    return hit && hit.length ? hit.slice(0, 2) : pick.slice(0, 2);
  }
})();
