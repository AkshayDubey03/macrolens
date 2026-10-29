import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total, targetOn, validateState, emptyState, csv, date } from '../lib/domain.mjs';

const rice = { name: 'Cooked rice', portion: '150 g', calories: 195, protein: 4, carbs: 42, fat: 0.5 };
const meal = { id: 'meal-1', date: '2026-10-29', title: 'Lunch', type: 'Lunch', notes: '', source: 'manual', foods: [rice] };
test('totals use full-portion values and round floating-point sums', () => {
  assert.deepEqual(total([rice, { ...rice, calories: 0.1, protein: 0.1, carbs: 0.2, fat: 0.1 }]), { calories: 195.1, protein: 4.1, carbs: 42.2, fat: 0.6 });
  assert.deepEqual(total([]), { calories: 0, protein: 0, carbs: 0, fat: 0 });
});
test('target changes preserve historical goals and future targets do not leak backward', () => {
  const old = { date: '2026-10-01', maintenance: 2400, deficit: 400, protein: 140 };
  const next = { ...old, date: '2026-11-01', deficit: 200 };
  assert.deepEqual(targetOn([next, old], '2026-10-29'), old);
  assert.deepEqual(targetOn([old, next], '2026-11-01'), next);
  assert.equal(targetOn([old], '2026-09-30'), null);
});
test('validation rejects invalid numbers, duplicate IDs, invalid dates, and impossible targets', () => {
  assert.deepEqual(validateState({ ...emptyState(), meals: [meal] }).meals, [meal]);
  for (const value of [-1, Infinity, NaN, '100']) assert.throws(() => validateState({ ...emptyState(), meals: [{ ...meal, foods: [{ ...rice, calories: value }] }] }));
  assert.throws(() => validateState({ ...emptyState(), meals: [meal, meal] }));
  for (const day of ['2026-02-30', '2026-99-01', 'today', '']) assert.throws(() => date(day));
  assert.throws(() => validateState({ ...emptyState(), targets: [{ date: '2026-10-29', maintenance: 500, deficit: 600, protein: 100 }] }));
});
test('CSV escapes commas, quotes, newlines, and formula injection', () => {
  const result = csv({ meals: [{ ...meal, notes: ' =HYPERLINK("bad")', foods: [{ ...rice, name: 'Rice, "steamed"\nwhite' }] }] });
  assert.match(result, /"Rice, ""steamed""\nwhite"/);
  assert.match(result, /"' =HYPERLINK\(""bad""\)"/);
  assert.equal(result.split('\r\n').length, 2);
});
