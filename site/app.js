// Library page: asks installed scripts for their versions and drives installs/updates.
// Each installed script @matches this page and answers through its bundled reporter.
(function () {
  'use strict';
  const model = LibraryModel;
  const catalog = JSON.parse(document.getElementById('catalog-data').textContent);
  const RETRY_DELAYS = [400, 1200, 3000];
  const FINISH_DELAY = 5000;

  const rows = new Map();
  for (const item of catalog.scripts) {
    const el = document.querySelector('[data-script="' + item.id + '"]');
    if (!el) continue;
    rows.set(item.id, {
      item,
      el,
      pill: el.querySelector('[data-role="pill"]'),
      versions: el.querySelector('[data-role="versions"]'),
      action: el.querySelector('[data-role="action"]'),
      installed: null,
      canOpenUpdates: false,
      waiting: false,
    });
  }
  const summary = document.getElementById('summary');
  const notice = document.getElementById('notice');
  const hint = document.getElementById('hint');
  const updateAll = document.getElementById('update-all');
  const recheck = document.getElementById('recheck');

  let round = 0, checking = false, updateStarted = false, leftPage = false;
  const pending = new Map();

  function stateOf(row) {
    return model.rowState({ installed: row.installed, library: row.item.version, checking, waiting: row.waiting });
  }

  function render() {
    const states = [];
    let updatable = 0, canUpdateAll = false;
    for (const row of rows.values()) {
      const state = stateOf(row);
      states.push(row.waiting ? model.rowState({ installed: row.installed, library: row.item.version, checking }) : state);
      row.el.dataset.state = state;
      row.pill.textContent = model.LABELS[state];
      row.versions.textContent = model.versionText(state, row.installed, row.item.version);
      const label = model.ACTIONS[state];
      row.action.hidden = !label;
      if (label) row.action.textContent = label;
      row.action.classList.toggle('button-primary', state === 'update');
      if (state === 'update') updatable++;
      if (row.installed && row.canOpenUpdates) canUpdateAll = true;
    }
    summary.textContent = model.summaryText(states, checking);
    updateAll.hidden = !(canUpdateAll && updatable > 0);
    updateAll.textContent = 'Update All (' + updatable + ')';
    hint.hidden = checking || !states.includes('missing');
    recheck.disabled = checking;
  }

  function send(action, scriptId, extra) {
    const requestId = crypto.randomUUID();
    pending.set(requestId, scriptId);
    window.postMessage(model.request(action, scriptId, requestId, extra), location.origin);
  }

  function check() {
    const current = ++round;
    pending.clear();
    checking = true;
    for (const row of rows.values()) { row.installed = null; row.canOpenUpdates = false; }
    render();
    const ask = () => { for (const [id, row] of rows) if (!row.installed) send('snapshot', id); };
    ask();
    for (const delay of RETRY_DELAYS) setTimeout(() => { if (current === round) ask(); }, delay);
    setTimeout(() => { if (current === round) { checking = false; render(); } }, FINISH_DELAY);
  }

  window.addEventListener('message', event => {
    const reply = model.parseReply(event, { origin: location.origin, self: window });
    if (!reply || pending.get(reply.requestId) !== reply.scriptId) return;
    const row = rows.get(reply.scriptId);
    if (!row) return;
    row.installed = reply.version;
    row.canOpenUpdates = reply.canOpenUpdates;
    if ([...rows.values()].every(r => r.installed)) checking = false;
    render();
  });

  function showNotice(text) {
    notice.textContent = text;
    notice.hidden = !text;
  }

  function startUpdate(rowsToUpdate) {
    updateStarted = true;
    for (const row of rowsToUpdate) row.waiting = true;
    render();
  }

  for (const row of rows.values()) {
    // A plain link: Tampermonkey intercepts the .user.js navigation in the new tab,
    // which avoids popup blocking and any guessing about which tab to close.
    row.action.addEventListener('click', () => {
      startUpdate([row]);
      showNotice('Confirm the ' + (row.installed ? 'update' : 'installation') + ' in the Tampermonkey tab. Versions refresh when you come back.');
    });
  }

  updateAll.addEventListener('click', () => {
    const helper = [...rows.values()].find(row => row.installed && row.canOpenUpdates);
    const targets = [...rows.values()].filter(row => stateOf(row) === 'update');
    if (!helper || !targets.length) return;
    // Opened by an installed script via GM.openInTab, so no popup blocker applies.
    send('updates', helper.item.id, { ids: targets.map(row => row.item.id) });
    startUpdate(targets);
    showNotice('Opened ' + targets.length + (targets.length === 1 ? ' Tampermonkey tab' : ' Tampermonkey tabs') + ' in the background. Confirm each update there, then come back to this tab.');
  });

  recheck.addEventListener('click', () => {
    for (const row of rows.values()) row.waiting = false;
    showNotice('');
    check();
  });

  // Updated scripts only report their new version from a fresh page load.
  const away = () => { if (updateStarted) leftPage = true; };
  const back = () => { if (updateStarted && leftPage && document.visibilityState === 'visible') location.reload(); };
  document.addEventListener('visibilitychange', () => (document.hidden ? away() : back()));
  window.addEventListener('blur', away);
  window.addEventListener('focus', back);
  window.addEventListener('pageshow', event => { if (event.persisted) check(); });

  check();
})();
