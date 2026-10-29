export const macroKeys = ['calories', 'protein', 'carbs', 'fat'];
export function assert(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { status: 400 });
}
export function number(value, label, min = 0, max = 10000) {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `Invalid ${label}`);
  return Math.round(value * 10) / 10;
}
export function text(value, label, max = 1000) {
  assert(typeof value === 'string' && value.length <= max, `Invalid ${label}`);
  return value.trim();
}
export function date(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Invalid date');
  const parsed = new Date(`${value}T12:00:00Z`);
  assert(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value, 'Invalid date');
  return value;
}
export function food(value) {
  assert(value && typeof value === 'object', 'Invalid food');
  const result = { name: text(value.name, 'food name', 160), portion: text(value.portion, 'portion', 160) };
  assert(result.name.length > 0, 'Food name is required');
  for (const key of macroKeys) result[key] = number(value[key], key);
  return result;
}
export function total(foods) {
  return Object.fromEntries(macroKeys.map(key => [key, Math.round(foods.reduce((sum, item) => sum + item[key], 0) * 10) / 10]));
}
export function targetOn(targets, day) {
  return [...targets].filter(t => t.date <= day).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}
export function emptyState() { return { meals: [], targets: [], weights: [] }; }
export function validateState(input) {
  assert(input && typeof input === 'object', 'Invalid journal');
  assert(Array.isArray(input.meals) && input.meals.length <= 20000, 'Invalid meals');
  assert(Array.isArray(input.targets) && input.targets.length <= 2000, 'Invalid targets');
  assert(Array.isArray(input.weights) && input.weights.length <= 10000, 'Invalid weights');
  const ids = new Set();
  const meals = input.meals.map(meal => {
    const id = text(meal.id, 'meal id', 100);
    assert(id.length > 0 && !ids.has(id), 'Duplicate or empty meal id'); ids.add(id);
    assert(['Breakfast', 'Lunch', 'Dinner', 'Snack'].includes(meal.type), 'Invalid meal type');
    assert(Array.isArray(meal.foods) && meal.foods.length > 0 && meal.foods.length <= 40, 'A meal needs 1–40 foods');
    assert(['manual', 'ai-estimate'].includes(meal.source), 'Invalid meal source');
    return { id, date: date(meal.date), type: meal.type, title: text(meal.title, 'meal title', 160), notes: text(meal.notes, 'notes', 4000), source: meal.source, foods: meal.foods.map(food) };
  });
  const targets = input.targets.map(t => ({ date: date(t.date), maintenance: number(t.maintenance, 'maintenance', 500, 10000), deficit: number(t.deficit, 'deficit', 0, 2000), protein: number(t.protein, 'protein', 0, 1000) }));
  assert(new Set(targets.map(t => t.date)).size === targets.length, 'Duplicate target date');
  for (const t of targets) assert(t.maintenance - t.deficit > 0, 'Calorie target must be positive');
  const weights = input.weights.map(w => ({ date: date(w.date), kg: number(w.kg, 'weight', 10, 600) }));
  assert(new Set(weights.map(w => w.date)).size === weights.length, 'Duplicate weight date');
  return { meals, targets, weights };
}
export function csv(state) {
  const rows = [['Date', 'Meal', 'Title', 'Food', 'Portion', 'Calories (kcal)', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Source', 'Notes']];
  for (const meal of [...state.meals].sort((a, b) => a.date.localeCompare(b.date)))
    for (const f of meal.foods) rows.push([meal.date, meal.type, meal.title, f.name, f.portion, f.calories, f.protein, f.carbs, f.fat, meal.source, meal.notes]);
  // Neutralize spreadsheet formulas in user-controlled cells, including leading whitespace.
  return rows.map(row => row.map(value => {
    let s = String(value);
    if (/^[\s]*[=+@-]/.test(s)) s = `'${s}`;
    return `"${s.replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n');
}
