// Pure logic for the library page; loaded in the browser and in node tests.
(function (root) {
  'use strict';
  const WIRE = 'userscript-control:';
  const VERSION_PATTERN = /^\d+(?:\.\d+)*$/;

  function compareVersions(a, b) {
    if (!VERSION_PATTERN.test(a) || !VERSION_PATTERN.test(b)) return null;
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
    }
    return 0;
  }

  // checking | missing | update | current | ahead | waiting
  function rowState({ installed, library, checking, waiting }) {
    if (waiting) return 'waiting';
    if (!installed) return checking ? 'checking' : 'missing';
    const comparison = compareVersions(installed, library);
    if (comparison === -1) return 'update';
    if (comparison === 1) return 'ahead';
    return comparison === 0 ? 'current' : 'update';
  }

  const LABELS = {
    checking: 'Checking…',
    missing: 'Not detected',
    update: 'Update available',
    current: 'Up to date',
    ahead: 'Newer than library',
    waiting: 'Confirm in Tampermonkey…',
  };
  const ACTIONS = { missing: 'Install', update: 'Update', waiting: 'Open Again' };

  function versionText(state, installed, library) {
    if (state === 'update' || state === 'ahead' || (state === 'waiting' && installed)) return 'v' + installed + ' → v' + library;
    if (state === 'current') return 'v' + installed;
    return 'v' + library;
  }

  function summaryText(states, checking) {
    if (checking) return 'Checking installed versions…';
    const count = state => states.filter(s => s === state).length;
    const parts = [states.length + (states.length === 1 ? ' script' : ' scripts')];
    const updates = count('update');
    if (updates) parts.push(updates + (updates === 1 ? ' update available' : ' updates available'));
    const missing = count('missing');
    if (missing) parts.push(missing + ' not detected');
    if (!updates && !missing && count('current') === states.length) return 'All ' + parts[0] + ' up to date';
    return parts.join(' · ');
  }

  function request(action, scriptId, requestId, extra) {
    return WIRE + JSON.stringify({ channel: 'userscript-control-request', schema: 1, requestId, action, scriptId, ...extra });
  }

  // Returns {requestId, scriptId, version, canOpenUpdates} for a valid script reply, else null.
  function parseReply(event, { origin, self }) {
    if (event.origin !== origin) return null;
    // Firefox extension worlds can deliver a null source; anything else must be this window.
    if (event.source !== null && event.source !== self) return null;
    if (typeof event.data !== 'string' || !event.data.startsWith(WIRE) || event.data.length > 65536) return null;
    let data;
    try { data = JSON.parse(event.data.slice(WIRE.length)); } catch { return null; }
    if (data?.channel !== 'userscript-control-response' || data.schema !== 1) return null;
    if (typeof data.requestId !== 'string' || typeof data.scriptId !== 'string') return null;
    if (typeof data.version !== 'string' || data.version.length > 40 || !VERSION_PATTERN.test(data.version)) return null;
    const capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
    return { requestId: data.requestId, scriptId: data.scriptId, version: data.version, canOpenUpdates: capabilities.includes('openUpdates') };
  }

  const api = { compareVersions, rowState, LABELS, ACTIONS, versionText, summaryText, request, parseReply };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LibraryModel = api;
})(globalThis);
