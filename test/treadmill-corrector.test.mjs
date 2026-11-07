// Behaviour checks for the Treadmill Distance Corrector, run against the published script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = fs.readFileSync(path.join(root, 'scripts/intervals-treadmill-corrector/script.user.js'), 'utf8');
const start = code.indexOf('    function holdToRepeat(');
const helper = start < 0 ? '' : code.slice(start, code.indexOf('\n    }\n', start) + 7);

// A button with just enough of the DOM for the helper, plus a manual clock.
function setup() {
  let now = 0, nextId = 1;
  const timers = new Map();
  const schedule = (fn, ms, repeat) => { const id = nextId++; timers.set(id, { fn, at: now + ms, ms, repeat }); return id; };
  const clear = id => timers.delete(id);
  const advance = ms => {
    const end = now + ms;
    for (;;) {
      const [id, t] = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (!t) break;
      now = t.at;
      if (t.repeat) t.at += t.ms; else timers.delete(id);
      t.fn();
    }
    now = end;
  };
  const listeners = new Map();
  const button = {
    disabled: false, isConnected: true, style: {},
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  };
  const fire = (type, init = {}) => {
    const event = { button: 0, detail: 1, preventDefault() {}, ...init };
    button['on' + type]?.(event);
    for (const fn of listeners.get(type) ?? []) fn(event);
  };
  let steps = 0;
  const context = vm.createContext({ setTimeout: (fn, ms) => schedule(fn, ms, false), setInterval: (fn, ms) => schedule(fn, ms, true), clearTimeout: clear, clearInterval: clear, button, step: () => steps++ });
  vm.runInContext(helper + '\nholdToRepeat(button, step);', context);
  return { button, fire, advance, steps: () => steps };
}

test('the script defines a press-and-hold helper for the +/- buttons', () => {
  assert.ok(helper, 'holdToRepeat not found');
  assert.equal(code.match(/holdToRepeat\(el\(name\)/g)?.length, 1, 'distance +/- use it');
  assert.equal(code.match(/holdToRepeat\(row\.querySelector\("\.speed-" \+ direction\)/g)?.length, 1, 'stage speed +/- use it');
});

test('a short press steps once, including the click that follows it', () => {
  const { fire, advance, steps } = setup();
  fire('pointerdown');
  advance(100);
  fire('pointerup');
  fire('click');
  advance(2000);
  assert.equal(steps(), 1);
});

test('holding keeps stepping until release', () => {
  const { fire, advance, steps } = setup();
  fire('pointerdown');
  advance(399);
  assert.equal(steps(), 1, 'waits before repeating');
  advance(1);
  advance(600);
  const held = steps();
  assert.ok(held >= 10, `expected continuous steps, got ${held}`);
  fire('pointerup');
  advance(2000);
  assert.equal(steps(), held, 'stops on release');
});

test('repeat stops when the pointer leaves, is cancelled, or the button is disabled', () => {
  for (const end of ['pointerleave', 'pointercancel']) {
    const { fire, advance, steps } = setup();
    fire('pointerdown');
    advance(700);
    fire(end);
    const count = steps();
    advance(1000);
    assert.equal(steps(), count, end);
  }
  const { button, fire, advance, steps } = setup();
  fire('pointerdown');
  advance(700);
  button.disabled = true;
  advance(100);
  const count = steps();
  advance(1000);
  assert.equal(steps(), count, 'disabled');
});

test('keyboard activation steps once per click and ignores other mouse buttons', () => {
  const { fire, advance, steps } = setup();
  fire('click', { detail: 0 });
  assert.equal(steps(), 1);
  fire('pointerdown', { button: 2 });
  advance(1000);
  assert.equal(steps(), 1);
});
