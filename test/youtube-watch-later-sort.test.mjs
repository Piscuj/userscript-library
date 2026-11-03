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
