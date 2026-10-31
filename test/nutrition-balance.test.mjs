// Behaviour checks for Nutrition Balance, run against the published script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = fs.readFileSync(path.join(root, 'scripts/intervals-nutrition-balance/script.user.js'), 'utf8');
// The feature's constants and helpers, without its start-up code.
const helpers = code.slice(code.indexOf('  const BASE'), code.indexOf('  let ccLastRender'));

function renderBadge(value, weekly) {
  const attrs = new Map();
  const element = { style: {}, lastElementChild: { textContent: '' }, getAttribute: k => attrs.get(k), setAttribute: (k, v) => attrs.set(k, v) };
  const parent = { children: [], append: el => parent.children.push(el) };
  const native = { nativeColor: 'rgb(187, 146, 255)' };
  const calendar = { querySelector: () => ({ closest: () => native }), closest: () => null };
  const context = vm.createContext({ document: { createElement: () => element }, parent, calendar, getComputedStyle: el => ({ color: el.nativeColor }) });
  vm.runInContext(helpers + `\nbadge(parent, ${value}, "Average", ${weekly}, "1", null, calendar);`, context);
  return element.lastElementChild.textContent;
}

test('weekly average balance shows plain kcal, without /day', () => {
  assert.equal(renderBadge(426, true), '+426 kcal');
  assert.match(renderBadge(-120, true), /^\D120 kcal$/);
});

test('daily balance keeps its kcal label', () => {
  assert.equal(renderBadge(250, false), '+250 kcal');
});
