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

function renderBadge(value, weekly, expected = null) {
  const attrs = new Map();
  const element = { style: {}, lastElementChild: { textContent: '' }, getAttribute: k => attrs.get(k), setAttribute: (k, v) => attrs.set(k, v) };
  const parent = { children: [], append: el => parent.children.push(el) };
  const native = { nativeColor: 'rgb(187, 146, 255)' };
  const calendar = { querySelector: () => ({ closest: () => native }), closest: () => null };
  const context = vm.createContext({ document: { createElement: () => element }, parent, calendar, getComputedStyle: el => ({ color: el.nativeColor }) });
  vm.runInContext(helpers + `\nbadge(parent, ${value}, "Average", ${weekly}, "1", null, calendar, ${JSON.stringify(expected)});`, context);
  return element.lastElementChild.textContent;
}

test('weekly average balance shows plain kcal, without /day', () => {
  assert.equal(renderBadge(426, true), '+426 kcal');
  assert.match(renderBadge(-120, true), /^\D120 kcal$/);
});

test('predicted weight change follows the kcal balance in brackets', () => {
  assert.equal(renderBadge(505, true, { value: 0.054 }), '+505 kcal (+0.05 kg)');
  assert.match(renderBadge(-300, true, { value: -0.27 }), /^\D300 kcal \(\D0\.27 kg\)$/);
});

function renderWeight(value, theme = null) {
  const element = { style: {}, lastElementChild: { textContent: '' }, attrs: {}, getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; } };
  const parent = { children: [], append: el => parent.children.push(el) };
  const calendar = { closest: selector => (theme === 'light' && selector.includes('light') ? {} : null), querySelector: () => null };
  const change = { value, span: 7, end: '2026-11-01', previousEnd: '2026-10-25', average: 80, count: 14, previousAverage: 80.3, previousCount: 14 };
  const context = vm.createContext({ document: { createElement: () => element }, parent, calendar, change });
  vm.runInContext(helpers + '\nweightBadge(parent, change, {value: 0.36}, "1", null, calendar);\nbalance_color = balanceColor(calendar);', context);
  return { element, balanceColor: context.balance_color };
}

test('weight shows an icon and the signed number, without a 14d label or the prediction', () => {
  const { element } = renderWeight(-0.348);
  assert.match(element.lastElementChild.textContent, /^\D0\.35 kg$/);
  assert.match(element.innerHTML, /mdi-scale-bathroom/);
  assert.match(element.title, /14-day average/);
  assert.match(element.title, /Real minus predicted/);
});

test('weight colour differs from the calorie colour in both themes', () => {
  for (const theme of ['dark', 'light']) {
    const { element, balanceColor } = renderWeight(0.2, theme);
    assert.ok(element.style.color);
    assert.notEqual(element.style.color, balanceColor);
  }
});

test('prediction does not need weigh-ins', () => {
  const end = '2026-10-25';
  const records = history(end, 20, () => ({ kcalConsumed: 2750 }));
  const span = run('weekSpan(days, currentDay)', { days: weekOf(end), currentDay: end });
  assert.deepEqual(span, { end, previousEnd: '2026-10-18', span: 7 });
  close(run('expectedWeightChange(records, calorieMap([]), end, 7, end)', { records, end }).value, 0.5);
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

function run(expression, vars) {
  const context = vm.createContext({ document: {}, ...vars });
  vm.runInContext(helpers + `\nresult = ${expression};`, context);
  return JSON.parse(JSON.stringify(context.result ?? null));
}
function addDays(date, count) {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
// Daily wellness records ending on `end`, oldest first; `make(daysAgo)` returns each record's fields.
const history = (end, length, make) => Array.from({ length }, (_, i) => ({ id: addDays(end, i - length + 1), ...make(length - 1 - i) }));
const weekOf = sunday => Array.from({ length: 7 }, (_, i) => ({ date: { toISODate: () => addDays(sunday, i - 6) } }));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test('a finished week compares its last 14-day average with the previous Sunday', () => {
  // Losing 0.1 kg/day: the average falls exactly 0.7 kg in 7 days.
  const records = history('2026-10-25', 21, ago => ({ weight: 80 + ago * 0.1 }));
  const change = run('weekWeightChange(days, records, currentDay)', { days: weekOf('2026-10-25'), records, currentDay: '2026-11-02' });
  close(change.value, -0.7);
  assert.equal(change.end, '2026-10-25');
  assert.equal(change.previousEnd, '2026-10-18');
  assert.equal(change.span, 7);
  assert.equal(change.count, 14);
  assert.equal(change.previousCount, 14);
});

test('the current week measures from last Sunday to today', () => {
  const records = history('2026-11-04', 21, ago => ({ weight: 80 + ago * 0.1 }));
  const change = run('weekWeightChange(days, records, currentDay)', { days: weekOf('2026-11-08'), records, currentDay: '2026-11-04' });
  assert.equal(change.end, '2026-11-04');
  assert.equal(change.previousEnd, '2026-11-01');
  assert.equal(change.span, 3);
  close(change.value, -0.3);
});

test('a future week has no weight change', () => {
  const records = history('2026-11-02', 21, () => ({ weight: 80 }));
  assert.equal(run('weekWeightChange(days, records, currentDay)', { days: weekOf('2026-11-15'), records, currentDay: '2026-11-02' }), null);
});

test('weight change needs 8 readings in both 14-day windows', () => {
  const end = '2026-10-25';
  const enough = history(end, 21, ago => (ago % 14 < 8 ? { weight: 80 } : {}));
  assert.equal(run('weekWeightChange(days, records, currentDay)', { days: weekOf(end), records: enough, currentDay: end }).count, 8);
  const sparse = history(end, 21, ago => (ago < 7 ? { weight: 80 } : { weight: null }));
  assert.equal(run('weekWeightChange(days, records, currentDay)', { days: weekOf(end), records: sparse, currentDay: end }), null);
});

test('temporary and non-positive weights are not readings', () => {
  const end = '2026-10-25';
  const records = history(end, 21, ago => ({ weight: ago === 0 ? 99 : ago === 1 ? 0 : 80, tempWeight: ago === 0 }));
  const change = run('weekWeightChange(days, records, currentDay)', { days: weekOf(end), records, currentDay: end });
  assert.equal(change.count, 12);
  close(change.value, 0);
});

test('a steady balance predicts 7 days of net calories at 7700 kcal/kg', () => {
  const end = '2026-10-25';
  const records = history(end, 21, () => ({ kcalConsumed: 1650 })); // 550 kcal/day below the 2200 base
  const expected = run('expectedWeightChange(records, calorieMap([]), end, 7, end)', { records, end });
  close(expected.value, -0.5);
  assert.equal(expected.count, 20);
});

test('prediction weights calories the way the 14-day average delays them', () => {
  // A surplus 10 days ago is fully inside the change; one 19 days ago has mostly left it, and today has barely entered.
  const end = '2026-10-25';
  const surplusOn = daysAgo => history(end, 20, ago => ({ kcalConsumed: ago === daysAgo ? 2200 + 7700 : 2200 }));
  const predict = daysAgo => run('expectedWeightChange(records, calorieMap([]), end, 7, end)', { records: surplusOn(daysAgo), end }).value;
  close(predict(10), 0.5);
  close(predict(19), 1 / 14);
  close(predict(0), 1 / 14);
});

test('prediction counts activity calories and fills a few unlogged days with the average', () => {
  const end = '2026-10-25';
  const records = history(end, 20, ago => (ago < 4 ? {} : { kcalConsumed: 3300 }));
  const activities = history(end, 20, () => ({ calories: 550 })).map((row, i) => ({ id: i, start_date_local: row.id + 'T07:00:00', calories: row.calories }));
  const expected = run('expectedWeightChange(records, calorieMap(activities), end, 7, end)', { records, activities, end });
  assert.equal(expected.count, 16);
  close(expected.value, 0.5);
});

test('prediction needs at least 14 of the 20 days logged', () => {
  const end = '2026-10-25';
  const records = history(end, 20, ago => (ago < 7 ? {} : { kcalConsumed: 2200 }));
  assert.equal(run('expectedWeightChange(records, calorieMap([]), end, 7, end)', { records, end }), null);
});

test('prediction covers only the days since last Sunday', () => {
  const end = '2026-11-04';
  const records = history(end, 15, () => ({ kcalConsumed: 1650 })); // 550 kcal/day below the 2200 base
  const expected = run('expectedWeightChange(records, calorieMap([]), end, 3, end)', { records, end });
  close(expected.value, -3 * 550 / 7700);
  assert.equal(expected.count, 15);
  assert.equal(expected.days, 16);
});

test('prediction on the first day of a week needs 70% of 14 days', () => {
  const end = '2026-11-02';
  const enough = history(end, 10, () => ({ kcalConsumed: 2750 }));
  const expected = run('expectedWeightChange(records, calorieMap([]), end, 1, end)', { records: enough, end });
  close(expected.value, 550 / 7700);
  assert.equal(run('expectedWeightChange(records, calorieMap([]), end, 1, end)', { records: enough.slice(1), end }), null);
});

// Firefox: a page array's own filter/map reject callbacks from the userscript sandbox.
test('page wellness arrays are read without passing them callbacks', () => {
  const end = '2026-10-25';
  const records = history(end, 21, ago => ({ weight: 80 + ago * 0.1, kcalConsumed: 2200 }));
  for (const method of ['filter', 'map', 'forEach', 'find', 'reduce', 'some', 'every']) {
    records[method] = () => { throw new Error('Permission denied to access object'); };
  }
  const change = run('weekWeightChange(days, records, currentDay)', { days: weekOf(end), records, currentDay: end });
  close(change.value, -0.7);
  close(run('expectedWeightChange(records, calorieMap([]), end, 7, end)', { records, end }).value, 0);
});

test('kg values are signed to two decimals without a negative zero', () => {
  assert.equal(run('formatKg(0.318)', {}), '+0.32 kg');
  assert.equal(run('formatKg(-0.25)', {}), '−0.25 kg');
  assert.equal(run('formatKg(-0.001)', {}), '0.00 kg');
});

function badgeRow(order) {
  const parent = { children: [], moves: 0 };
  parent.children = order.map(name => ({
    name,
    classList: { contains: value => value === name },
    get previousElementSibling() { return parent.children[parent.children.indexOf(this) - 1] ?? null; },
    insertAdjacentElement(position, node) {
      assert.equal(position, 'afterend');
      parent.moves++;
      parent.children.splice(parent.children.indexOf(node), 1);
      parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
    },
  }));
  vm.runInContext(helpers + '\norderBadges(parent);', vm.createContext({ document: {}, parent }));
  return parent;
}
const KCAL = 'icu-calorie-balance', MACROS = 'icu-week-macros', WEIGHT = 'icu-week-weight';

test('badges keep the kcal, macros, weight order whichever was created first', () => {
  for (const order of [[WEIGHT, KCAL, MACROS], [MACROS, WEIGHT, KCAL], [KCAL, WEIGHT, MACROS]]) {
    assert.deepEqual(badgeRow(['native', ...order]).children.map(el => el.name).slice(1), [KCAL, MACROS, WEIGHT]);
  }
});

test('badges already in order are not moved, so refreshes cause no page changes', () => {
  assert.equal(badgeRow(['native', KCAL, MACROS, WEIGHT]).moves, 0);
  assert.equal(badgeRow(['native', MACROS, WEIGHT]).moves, 0);
});

test('native summary elements stay ahead of the badges', () => {
  assert.equal(badgeRow(['native', WEIGHT, KCAL, MACROS]).children[0].name, 'native');
});
