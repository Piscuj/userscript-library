const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Loaded as a classic script, exactly as the page does.
const context = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../site/model.js'), 'utf8'), context);
const model = context.LibraryModel;

const origin = 'https://piscuj.github.io';
const self = {};
const reply = (fields = {}, event = {}) => ({
  origin, source: self,
  data: 'userscript-control:' + JSON.stringify({ channel: 'userscript-control-response', schema: 1, requestId: 'req-12345678', scriptId: 'a', version: '1.2.0', reports: [], capabilities: ['openUpdates'], ...fields }),
  ...event,
});

test('versions compare numerically across differing lengths', () => {
  assert.equal(model.compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(model.compareVersions('1.2', '1.2.0'), 0);
  assert.equal(model.compareVersions('0.7.8', '0.7.9'), -1);
  assert.equal(model.compareVersions('x', '1.0'), null);
});

test('row states cover checking, missing, update, current, ahead and waiting', () => {
  assert.equal(model.rowState({ installed: null, library: '1.0', checking: true }), 'checking');
  assert.equal(model.rowState({ installed: null, library: '1.0', checking: false }), 'missing');
  assert.equal(model.rowState({ installed: '0.9', library: '1.0' }), 'update');
  assert.equal(model.rowState({ installed: '1.0', library: '1.0' }), 'current');
  assert.equal(model.rowState({ installed: '1.1', library: '1.0' }), 'ahead');
  assert.equal(model.rowState({ installed: '0.9', library: '1.0', waiting: true }), 'waiting');
});

test('only states that need the user show an action', () => {
  assert.equal(model.ACTIONS.missing, 'Install');
  assert.equal(model.ACTIONS.update, 'Update');
  assert.equal(model.ACTIONS.current, undefined);
  assert.equal(model.ACTIONS.checking, undefined);
});

test('summary counts updates and undetected scripts', () => {
  assert.equal(model.summaryText(['current', 'current'], false), 'All 2 scripts up to date');
  assert.equal(model.summaryText(['update', 'missing', 'current'], false), '3 scripts · 1 update available · 1 not detected');
  assert.equal(model.summaryText(['checking'], true), 'Checking installed versions…');
});

test('version text shows the upgrade path only when versions differ', () => {
  assert.equal(model.versionText('update', '0.7.8', '0.7.9'), 'v0.7.8 → v0.7.9');
  assert.equal(model.versionText('current', '0.7.9', '0.7.9'), 'v0.7.9');
  assert.equal(model.versionText('missing', null, '0.7.9'), 'v0.7.9');
});

test('a valid reply is parsed, including the Update all capability', () => {
  assert.deepEqual({ ...model.parseReply(reply(), { origin, self }) }, { requestId: 'req-12345678', scriptId: 'a', version: '1.2.0', canOpenUpdates: true });
});

test('Firefox null-source replies are accepted at the exact origin', () => {
  assert.ok(model.parseReply(reply({}, { source: null }), { origin, self }));
});

test('foreign origins, foreign windows and malformed replies are rejected', () => {
  assert.equal(model.parseReply(reply({}, { origin: 'https://evil.example' }), { origin, self }), null);
  assert.equal(model.parseReply(reply({}, { source: {} }), { origin, self }), null);
  assert.equal(model.parseReply(reply({}, { data: 'userscript-control:{bad' }), { origin, self }), null);
  assert.equal(model.parseReply(reply({}, { data: { channel: 'userscript-control-response' } }), { origin, self }), null);
  assert.equal(model.parseReply(reply({ channel: 'userscript-control-request' }), { origin, self }), null);
  assert.equal(model.parseReply(reply({ version: '<b>1</b>' }), { origin, self }), null);
});

test('requests use the string wire format the bundled reporters expect', () => {
  const wire = model.request('updates', 'a', 'req-12345678', { ids: ['b'] });
  assert.ok(wire.startsWith('userscript-control:'));
  assert.deepEqual(JSON.parse(wire.slice('userscript-control:'.length)), { channel: 'userscript-control-request', schema: 1, requestId: 'req-12345678', action: 'updates', scriptId: 'a', ids: ['b'] });
});
