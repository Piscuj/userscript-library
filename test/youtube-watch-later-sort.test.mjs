// Behaviour checks for YouTube Watch Later Sort, run against the published script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = fs.readFileSync(path.join(root, 'scripts/youtube-watch-later-sort/script.user.js'), 'utf8');
const helpers = code.slice(code.indexOf('// pure:start'), code.indexOf('// pure:end'));
const context = vm.createContext({});
vm.runInContext(helpers + '\nthis.api = { parseDuration, parsePlaylistPage, sortByLength, planMoves };', context);
const { parseDuration, parsePlaylistPage, sortByLength, planMoves } = context.api;
// Values made in the script's context have a different Array prototype.
const plain = value => JSON.parse(JSON.stringify(value));

const lockup = (id, badge, setVideoId = 'set-' + id) => ({ lockupViewModel: {
  contentId: id,
  contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
  contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: badge } }] } }] } },
  rendererContext: setVideoId ? { commandContext: { onTap: { innertubeCommand: { playlistEditEndpoint: { actions: [{ setVideoId }] } } } } } : {},
} });
const item = (id, seconds) => ({ videoId: id, setVideoId: id, seconds });

// Applies moves the way YouTube does: each goes straight after its predecessor, or to the top.
function applyMoves(items, moves) {
  const order = items.map(entry => entry.setVideoId);
  for (const move of moves) {
    order.splice(order.indexOf(move.setVideoId), 1);
    const after = move.movedSetVideoIdPredecessor;
    order.splice(after ? order.indexOf(after) + 1 : 0, 0, move.setVideoId);
  }
  return order;
}

test('badge durations become seconds, anything else has no length', () => {
  assert.equal(parseDuration('0:06'), 6);
  assert.equal(parseDuration('12:34'), 754);
  assert.equal(parseDuration('1:02:03'), 3723);
  for (const text of ['LIVE', 'SHORTS', 'UPCOMING', '', null, undefined, '1:2']) assert.equal(parseDuration(text), null);
});

test('reads lockup items and the next page token', () => {
  const parsed = plain(parsePlaylistPage({ contents: { list: { contents: [
    lockup('a', '1:00'),
    lockup('b', 'LIVE'),
    { continuationItemViewModel: { continuationCommand: { token: 'next-page' } } },
  ] } } }));
  assert.deepEqual(parsed.items, [
    { videoId: 'a', setVideoId: 'set-a', seconds: 60 },
    { videoId: 'b', setVideoId: 'set-b', seconds: null },
  ]);
  assert.equal(parsed.continuation, 'next-page');
});

test('reads older playlistVideoRenderer items and a page with no more results', () => {
  const parsed = plain(parsePlaylistPage({ contents: [
    { playlistVideoRenderer: { videoId: 'a', setVideoId: 'set-a', lengthSeconds: '90' } },
    { playlistVideoRenderer: { videoId: 'b', setVideoId: 'set-b', lengthText: { simpleText: '2:00' } } },
  ] }));
  assert.deepEqual(parsed.items.map(entry => entry.seconds), [90, 120]);
  assert.equal(parsed.continuation, null);
});

test('ignores non-video lockups and reports a missing set id instead of inventing one', () => {
  const parsed = plain(parsePlaylistPage({ contents: [
    { lockupViewModel: { contentId: 'PL1', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' } },
    lockup('a', '1:00', null),
  ] }));
  assert.deepEqual(parsed.items, [{ videoId: 'a', setVideoId: null, seconds: 60 }]);
});

test('sorts shortest first, keeps ties in order and puts unknown lengths last', () => {
  const sorted = sortByLength([item('live', null), item('long', 300), item('tie1', 60), item('zero', 0), item('tie2', 60)]);
  assert.deepEqual(plain(sorted.map(entry => entry.videoId)), ['zero', 'tie1', 'tie2', 'long', 'live']);
});

test('moves produce the sorted order, including to the top of the list', () => {
  const cases = [
    [item('c', 30), item('a', 10), item('b', 20)],
    [item('d', 40), item('c', 30), item('b', 20), item('a', 10)],
    [item('b', 20), item('x', null), item('a', 10), item('c', 30)],
  ];
  for (const items of cases) {
    assert.deepEqual(applyMoves(items, plain(planMoves(items))), plain(sortByLength(items).map(entry => entry.setVideoId)));
  }
});

test('randomised lists always end up sorted', () => {
  let seed = 7;
  const next = limit => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % limit;
  for (let run = 0; run < 200; run++) {
    const items = Array.from({ length: next(40) + 1 }, (_, index) => item('v' + index, next(8) === 0 ? null : next(20)));
    assert.deepEqual(applyMoves(items, plain(planMoves(items))), plain(sortByLength(items).map(entry => entry.setVideoId)));
  }
});

test('only out-of-place videos move, and a sorted list needs no moves', () => {
  assert.equal(planMoves([item('a', 10), item('b', 20), item('c', null)]).length, 0);
  const moves = plain(planMoves([item('z', 90), item('a', 10), item('b', 20), item('c', 30)]));
  assert.deepEqual(moves, [{ action: 'ACTION_MOVE_VIDEO_AFTER', setVideoId: 'z', movedSetVideoIdPredecessor: 'c' }]);
  assert.deepEqual(plain(planMoves([item('b', 20), item('c', 30), item('a', 10)])), [{ action: 'ACTION_MOVE_VIDEO_AFTER', setVideoId: 'a' }]);
});

// Firefox's userscript world has no base URL for relative fetches, and page code
// can't read objects the script owns, so requests must go through the page's own fetch.
function firefoxLikeRequest(respond) {
  const network = code.slice(code.indexOf('  const pause=ms'), code.indexOf('  async function readWatchLater'));
  const pageOwned = new WeakSet(), calls = [];
  const page = {
    JSON: { parse: text => { const value = JSON.parse(text); pageOwned.add(value); return value; } },
    ytcfg: { get: key => ({ INNERTUBE_CONTEXT: { client: {} }, LOGGED_IN: true, SESSION_INDEX: 0 })[key] },
    fetch: async (url, init) => {
      if (!pageOwned.has(init)) throw Error('Permission denied to access property');
      calls.push({ url: String(new URL(url)), init });
      return respond();
    },
  };
  const sandbox = vm.createContext({
    page, TextEncoder, crypto: globalThis.crypto, setTimeout,
    location: { origin: 'https://www.youtube.com' },
    document: { cookie: 'SAPISID=test' },
    fetch: url => { new URL(url); throw Error('Used the userscript world fetch'); },
  });
  vm.runInContext('const RETRY_DELAYS_MS=[];\n' + network + '\nthis.callYouTube = callYouTube;', sandbox);
  return { call: sandbox.callYouTube, calls };
}

test('requests use the page fetch, an absolute URL and a page-owned init', async () => {
  const { call, calls } = firefoxLikeRequest(() => ({ ok: true, status: 200, text: async () => '{"status":"STATUS_SUCCEEDED"}' }));
  const result = await call('browse', { browseId: 'VLWL' });
  assert.equal(result.status, 'STATUS_SUCCEEDED');
  assert.equal(calls[0].url, 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.match(calls[0].init.headers.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
  assert.equal(JSON.parse(calls[0].init.body).browseId, 'VLWL');
});

async function until(condition) {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
}

// Runs the whole feature against a small fake page and a fake YouTube playlist.
function fakeYouTube(lengths, respond = () => null) {
  let order = lengths.map((seconds, index) => ({ id: 'v' + index, seconds }));
  const buttons = [], edits = [];
  let reloads = 0;
  const element = () => {
    const node = {
      style: {}, listeners: {}, append() {},
      remove() { this.removed = true; },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      replaceChildren(...children) { buttons.length = 0; buttons.push(...children); },
    };
    return node;
  };
  const created = [];
  const page = {
    JSON,
    ytcfg: { get: key => ({ INNERTUBE_CONTEXT: { client: {} }, LOGGED_IN: true, SESSION_INDEX: 0 })[key] },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      const failure = respond(url);
      if (failure) return failure;
      if (url.includes('edit_playlist')) {
        edits.push(body.actions);
        for (const move of body.actions) {
          if (move.action === 'ACTION_REMOVE_VIDEO') { order = order.filter(video => 'set-' + video.id !== move.setVideoId); continue; }
          const [moved] = order.splice(order.findIndex(video => 'set-' + video.id === move.setVideoId), 1);
          const after = move.movedSetVideoIdPredecessor;
          order.splice(after ? order.findIndex(video => 'set-' + video.id === after) + 1 : 0, 0, moved);
        }
        return { ok: true, status: 200, text: async () => '{"status":"STATUS_SUCCEEDED"}' };
      }
      const contents = order.map(video => ({ playlistVideoRenderer: { videoId: video.id, setVideoId: 'set-' + video.id, lengthSeconds: String(video.seconds) } }));
      return { ok: true, status: 200, text: async () => JSON.stringify({ contents }) };
    },
  };
  const documentStub = {
    cookie: 'SAPISID=test',
    body: { append(node) { node.parentElement = documentStub.body; } },
    querySelectorAll: selector => (selector.includes('play-menu') ? menus : rows),
    createElement: () => { const node = element(); created.push(node); return node; },
    createElementNS: () => element(),
  };
  // YouTube keeps a wide and a small header; only one is displayed at a time.
  const playMenu = visible => ({
    visible,
    getClientRects() { return this.visible ? [{}] : []; },
    after(node) { this.nextElementSibling = node; node.parentElement = this; },
  });
  const menus = [playMenu(true), playMenu(false)];
  // Video rows as YouTube renders them: a title link and a #meta block under it.
  const row = id => {
    const meta = {
      children: [],
      append(node) { this.children.push(node); node.remove = () => { this.children.splice(this.children.indexOf(node), 1); }; },
      querySelector() { return this.children[0] ?? null; },
    };
    return {
      href: '/watch?v=' + id + '&list=WL&index=1', dataset: {}, style: {}, meta,
      querySelector(selector) { return selector === '#meta' ? meta : { getAttribute: () => this.href }; },
      button() { return meta.children[0]; },
    };
  };
  const rows = order.map(video => row(video.id));
  let tick = () => {};
  const location = { origin: 'https://www.youtube.com', pathname: '/playlist', search: '?list=WL', reload: () => { reloads++; } };
  const start = code.indexOf("  'use strict';\n  const page=typeof unsafeWindow");
  const feature = code.slice(start, code.lastIndexOf('})();\n})();'));
  vm.runInNewContext('(function () {\n' + feature + '})();', { unsafeWindow: page, window: page, document: documentStub, location, URL, URLSearchParams, TextEncoder, crypto: globalThis.crypto, setTimeout: fn => setTimeout(fn, 0), setInterval: fn => { tick = fn; } });
  const status = created.find(node => node.role === 'status');
  return {
    buttons, edits, menus, location, rows,
    panel: () => created.find(node => node.role === 'group'),
    body: documentStub.body,
    tick: () => tick(),
    label: () => buttons.map(node => node.textContent),
    status: () => status.textContent,
    click: name => buttons.find(node => node.textContent === name).listeners.click(),
    until,
    settled: () => until(() => reloads || buttons.some(node => node.textContent === 'Close')),
    reloads: () => reloads,
    order: () => order.map(video => video.seconds),
    ids: () => order.map(video => video.id),
  };
}

test('the button sits below the displayed Play all row and follows it when the layout changes', () => {
  const youtube = fakeYouTube([10]);
  const [wide, small] = youtube.menus;
  assert.equal(wide.nextElementSibling, youtube.panel());
  wide.visible = false;
  small.visible = true;
  youtube.tick();
  assert.equal(small.nextElementSibling, youtube.panel());
});

test('the button appears once YouTube has rendered Play all, and only on Watch Later', () => {
  const youtube = fakeYouTube([10]);
  youtube.location.search = '?list=PL123';
  youtube.tick();
  assert.equal(youtube.panel().removed, true);

  const late = fakeYouTube([10]);
  const [wide] = late.menus;
  wide.nextElementSibling = null;
  wide.visible = false;
  late.tick();
  assert.equal(wide.nextElementSibling, null);
  wide.visible = true;
  late.tick();
  assert.equal(wide.nextElementSibling, late.panel());
});

test('a running sort stays visible and does not reload a page you moved to', async () => {
  const youtube = fakeYouTube([30, 10, 20]);
  youtube.click('Sort by length');
  youtube.location.pathname = '/watch';
  youtube.location.search = '?v=x';
  youtube.tick();
  assert.equal(youtube.panel().parentElement, youtube.body);
  assert.equal(youtube.panel().style.position, 'fixed');
  await youtube.until(() => youtube.panel().removed);
  assert.deepEqual(youtube.order(), [10, 20, 30]);
  assert.equal(youtube.reloads(), 0);
});

test('one click sorts and reloads, with no confirmation or video counts', async () => {
  const youtube = fakeYouTube([30, 10, 20]);
  assert.deepEqual(youtube.label(), ['Sort by length']);
  youtube.click('Sort by length');
  assert.doesNotMatch(youtube.status(), /\d/);
  await youtube.settled();
  assert.deepEqual(youtube.order(), [10, 20, 30]);
  assert.equal(youtube.reloads(), 1);
});

test('an already sorted list just reloads without moving anything', async () => {
  const youtube = fakeYouTube([10, 20, 30]);
  youtube.click('Sort by length');
  await youtube.settled();
  assert.equal(youtube.edits.length, 0);
  assert.equal(youtube.reloads(), 1);
});

test('a failure stays on screen instead of reloading', async () => {
  const youtube = fakeYouTube([30, 10], url => (url.includes('edit_playlist') ? { ok: false, status: 403, text: async () => '' } : null));
  youtube.click('Sort by length');
  await youtube.settled();
  assert.equal(youtube.reloads(), 0);
  assert.match(youtube.status(), /HTTP 403/);
  assert.deepEqual(youtube.label(), ['Close']);
});

test('a refused request reports its status', async () => {
  const { call } = firefoxLikeRequest(() => ({ ok: false, status: 403, text: async () => '' }));
  await assert.rejects(call('browse', { browseId: 'VLWL' }), /HTTP 403/);
});

const press = node => node.listeners.click({ preventDefault() {}, stopPropagation() {} });

test('each video gets a Remove from Watch Later button that removes it and hides the row', async () => {
  const youtube = fakeYouTube([30, 10, 20]);
  const [, middle] = youtube.rows;
  assert.ok(youtube.rows.every(entry => entry.button()));
  press(middle.button());
  await youtube.until(() => middle.style.display === 'none');
  assert.deepEqual(youtube.edits.at(-1), [{ action: 'ACTION_REMOVE_VIDEO', setVideoId: 'set-v1' }]);
  assert.deepEqual(youtube.ids(), ['v0', 'v2']);
  youtube.tick();
  assert.equal(middle.style.display, 'none');
  assert.equal(middle.meta.children.length, 1);
});

test('a row YouTube reuses for another video shows again, and buttons leave other playlists', async () => {
  const youtube = fakeYouTube([30, 10]);
  const [first] = youtube.rows;
  press(first.button());
  await youtube.until(() => first.style.display === 'none');
  first.href = '/watch?v=other&list=WL&index=1';
  youtube.tick();
  assert.equal(first.style.display, '');
  youtube.location.search = '?list=PL123';
  youtube.tick();
  assert.ok(youtube.rows.every(entry => !entry.button()));
});

test('a failed removal keeps the video and says so on the button', async () => {
  const youtube = fakeYouTube([30, 10], url => (url.includes('edit_playlist') ? { ok: false, status: 403, text: async () => '' } : null));
  const [first] = youtube.rows;
  press(first.button());
  await youtube.until(() => first.button().title);
  assert.match(first.button().title, /HTTP 403/);
  assert.notEqual(first.style.display, 'none');
  assert.deepEqual(youtube.ids(), ['v0', 'v1']);
});
