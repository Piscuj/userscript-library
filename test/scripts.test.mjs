// Runs each published script's bundled reporter at the library URL and checks
// that the library page can detect it and trigger updates safely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readTag, splitHeader } from '../tools/retarget-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8'));
const WIRE = 'userscript-control:';

function runAtLibrary(id, { pathname = catalog.basePath } = {}) {
  const code = fs.readFileSync(path.join(root, 'scripts', id, 'script.user.js'), 'utf8');
  const version = readTag(splitHeader(code).header, 'version');
  const listeners = [], sent = [], opened = [];
  const store = new Map();
  const win = {
    crypto: { randomUUID: () => 'tab-12345678' },
    navigator: { locks: { request: async (_k, fn) => fn() } },
    location: { origin: catalog.origin, pathname, href: catalog.origin + pathname },
    document: { querySelectorAll: () => [] },
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: (value, target) => sent.push({ value, target }),
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    indexedDB: undefined,
  };
  const GM = {
    getValue: async (k, d) => (store.has(k) ? store.get(k) : d),
    setValue: async (k, v) => { store.set(k, v); },
    openInTab: async url => { opened.push(url); },
  };
  // Browser globals the scripts reference at load time; timers never fire here.
  const timers = { setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {} };
  const sandbox = { window: win, ...timers, GM, GM_info: { script: { version } }, GM_getValue: (k, d) => (store.has(k) ? store.get(k) : d), GM_setValue: (k, v) => store.set(k, v), unsafeWindow: win, Date, JSON, Promise, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: id + '.user.js' });
  const message = async (action, extra = {}) => {
    const data = WIRE + JSON.stringify({ channel: 'userscript-control-request', schema: 1, requestId: 'request-' + action + '-' + sent.length, action, scriptId: id, ...extra });
    for (const fn of listeners) await fn({ origin: catalog.origin, source: null, data });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { version, listeners, sent, opened, message };
}

for (const { id } of catalog.scripts) {
  test(id + ': answers the library page with its installed version', async () => {
    const run = runAtLibrary(id);
    assert.equal(run.listeners.length, 1, 'reporter should listen on the library page');
    await run.message('snapshot');
    assert.equal(run.sent.length, 1);
    assert.equal(run.sent[0].target, catalog.origin);
    const reply = JSON.parse(run.sent[0].value.slice(WIRE.length));
    assert.equal(reply.channel, 'userscript-control-response');
    assert.equal(reply.scriptId, id);
    assert.equal(reply.version, run.version);
    assert.deepEqual(reply.capabilities, ['openUpdates']);
  });

  test(id + ': Update all opens only valid library script URLs', async () => {
    const run = runAtLibrary(id);
    await run.message('updates', { ids: ['pomelo-fitatu', '../evil', 'https://evil.example/x', 42, 'intervals-liftosaur-details'] });
    assert.deepEqual(run.opened, [
      catalog.origin + catalog.basePath + 'scripts/pomelo-fitatu/script.user.js',
      catalog.origin + catalog.basePath + 'scripts/intervals-liftosaur-details/script.user.js',
    ]);
  });

  test(id + ': Update all without ids opens nothing', async () => {
    const run = runAtLibrary(id);
    await run.message('updates');
    assert.deepEqual(run.opened, []);
  });

  test(id + ': requests from other origins are ignored', async () => {
    const run = runAtLibrary(id);
    for (const fn of run.listeners) await fn({ origin: 'https://evil.example', source: null, data: WIRE + JSON.stringify({ channel: 'userscript-control-request', schema: 1, requestId: 'request-evil-1', action: 'updates', scriptId: id, ids: ['pomelo-fitatu'] }) });
    assert.equal(run.sent.length, 0);
    assert.deepEqual(run.opened, []);
  });

  test(id + ': header points at this library and keeps its identity', () => {
    const { header } = splitHeader(fs.readFileSync(path.join(root, 'scripts', id, 'script.user.js'), 'utf8'));
    const base = catalog.origin + catalog.basePath;
    assert.equal(readTag(header, 'downloadURL'), base + 'scripts/' + id + '/script.user.js');
    assert.equal(readTag(header, 'updateURL'), base + 'scripts/' + id + '/script.meta.js');
    assert.match(header, new RegExp('^// @match\\s+' + base.replace(/[./]/g, '\\$&') + '\\*$', 'm'));
    assert.ok(readTag(header, 'name') && readTag(header, 'namespace'));
  });
}
