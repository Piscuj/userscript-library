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

function weekBalance(days, activities, currentDay) {
  const context = vm.createContext({ document: {} });
  vm.runInContext(helpers + '\nresult = weekBalance(days, calorieMap(activities), currentDay);', Object.assign(context, { days, activities, currentDay }));
  return context.result;
}
// Intervals passes Luxon DateTime objects; the script reads them via toISODate().
const day = (date, kcalConsumed) => ({ date: { toISODate: () => date }, wellness: { kcalConsumed } });

test('weekly balance averages every logged day of the week, including today', () => {
  // Monday: 2700 in, 300 out → +200. Tuesday: 2600 in, 0 out → +400. Wednesday (today): 3000 in, 0 out → +800.
  const days = [day('2026-10-26', 2700), day('2026-10-27', 2600), day('2026-10-28', 3000)];
  const activities = [{ id: 1, start_date_local: '2026-10-26T07:00:00', calories: 300 }];
  const summary = weekBalance(days, activities, '2026-10-28');
  assert.equal(summary.count, 3);
  assert.equal(summary.value, 1400 / 3);
});

test('weekly balance counts today when it is the only logged day', () => {
  assert.deepEqual({ ...weekBalance([day('2026-10-28', 3000)], [], '2026-10-28') }, { value: 800, count: 1 });
});

test('weekly balance leaves out future days', () => {
  const days = [day('2026-10-28', 3000), day('2026-10-29', 2500)];
  assert.equal(weekBalance(days, [], '2026-10-28').count, 1);
});

test('past weeks still average every logged day', () => {
  const days = [day('2026-10-19', 2400), day('2026-10-25', 2000)];
  assert.equal(weekBalance(days, [], '2026-10-28').count, 2);
});
