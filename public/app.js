import { total, targetOn, csv, validateState, emptyState } from '/domain.mjs';

const $ = (s, root = document) => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shiftDay = (day, n) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return localDay(d); };
const prettyDay = day => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const fmt = value => Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
const icons = {
  today: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  log: '<path d="M8 4h11a2 2 0 0 1 2 2v14H8a4 4 0 0 1-4-4V6a2 2 0 0 1 2-2h2v16M11 8h6M11 12h6"/>',
  trends: '<path d="M4 4v16h16M7 15l4-5 4 3 5-7"/>',
  goals: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  camera: '<path d="M8 6l2-3h4l2 3h4a2 2 0 0 1 2 2v11H2V8a2 2 0 0 1 2-2h4Z"/><circle cx="12" cy="12" r="4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', arrow: '<path d="m8 5 7 7-7 7"/>',
  leaf: '<path d="M6 18C1 8 10 3 20 3c0 10-5 19-14 15Zm-2 3L16 8"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>', check: '<path d="m5 12 4 4L20 5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>', lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.leaf}</svg>`;
const app = $('#app'); const dialog = $('#meal-dialog');
let config, state, revision = 0, demo = true, view = 'today', selectedDay = localDay(), logQuery = '', logFrom = '', logTo = '', draft, imageData = '', busy = false, saving = false, installPrompt;
let demoState;

function sampleState() {
  const today = localDay();
  const entries = [
    ['Breakfast', 'The usual, with a little crunch', [{ name: 'Greek yogurt', portion: '200 g', calories: 146, protein: 20, carbs: 8, fat: 4 }, { name: 'Oats & blueberries', portion: '40 g oats + 80 g berries', calories: 199, protein: 5.8, carbs: 36, fat: 3.3 }]],
    ['Lunch', 'A proper paneer lunch', [{ name: 'Paneer curry', portion: '150 g, estimated', calories: 360, protein: 22, carbs: 12, fat: 25 }, { name: 'Roti', portion: '2 medium', calories: 220, protein: 7, carbs: 44, fat: 3 }, { name: 'Cucumber salad', portion: '1 bowl', calories: 35, protein: 1, carbs: 7, fat: 0.3 }]],
    ['Snack', 'An afternoon reset', [{ name: 'Whey protein', portion: '1 scoop with water', calories: 120, protein: 24, carbs: 3, fat: 1.5 }, { name: 'Banana', portion: '1 medium', calories: 105, protein: 1.3, carbs: 27, fat: 0.4 }]]
  ];
  const meals = entries.map(([type, title, foods]) => ({ id: crypto.randomUUID(), date: today, type, title, foods, notes: 'Illustrative sample data. Edit any portion to explore.', source: 'manual' }));
  for (let i = 1; i < 7; i++) meals.push({ id: crypto.randomUUID(), date: shiftDay(today, -i), type: 'Dinner', title: 'Example daily intake', notes: 'Aggregated sample for the trend preview.', source: 'manual', foods: [{ name: 'Sample day total', portion: 'Illustrative only', calories: [0, 1890, 2040, 1810, 2180, 1950, 1870][i], protein: 100 + i * 6, carbs: 210, fat: 60 }] });
  return { meals, targets: [{ date: shiftDay(today, -30), maintenance: 2400, deficit: 400, protein: 140 }], weights: [{ date: shiftDay(today, -6), kg: 76.4 }, { date: shiftDay(today, -3), kg: 76.1 }, { date: today, kg: 76 }] };
}

function toast(message) {
  $('#toast').textContent = message; $('#toast').classList.add('visible');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('visible'), 5500);
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Request failed');
  return result;
}
async function persist(next) {
  if (saving) throw new Error('Another save is in progress. Please wait.');
  validateState(next); saving = true;
  try {
    if (demo) { demoState = structuredClone(next); state = next; }
    else { const result = await api('/api/state', { method: 'PUT', body: JSON.stringify({ revision, state: next }) }); state = result.state; revision = result.revision; }
  } finally { saving = false; }
}
function dailyFoods(day) { return state.meals.filter(m => m.date === day).flatMap(m => m.foods); }
function navigation() {
  return [['today', 'Today'], ['log', 'Food log'], ['trends', 'Trends'], ['goals', 'Goals']].map(([key, label]) => `<button class="nav-item ${view === key ? 'active' : ''}" data-view="${key}" ${view === key ? 'aria-current="page"' : ''}>${icon(key)}<span>${label}</span></button>`).join('');
}
function render() {
  app.innerHTML = `<aside class="sidebar"><a class="brand" href="/">${icon('leaf')}<span>MacroLens<span class="brand-dot">.</span></span></a><p class="sidebar-label">YOUR DAILY PRACTICE</p><nav aria-label="Main">${navigation()}</nav><div class="sidebar-bottom"><div class="small-note">A clearer picture.<br>A healthier everyday.</div><span class="version">PERSONAL JOURNAL · V0.1</span></div></aside>
    <div class="workspace"><header class="topbar"><span class="mobile-brand">${icon('leaf')}MacroLens.</span><span class="topbar-copy">A little awareness goes a long way.</span><div class="account"><span class="status-dot"></span>${demo ? 'Demo workspace' : 'Private journal'}<button class="text-button" data-action="${demo ? 'login' : 'logout'}">${demo ? (config.authenticated ? 'My journal' : config.authRequired ? 'Sign in' : 'Demo info') : 'Sign out'}</button></div></header>
    <main><div class="mode-banner">${icon(demo ? 'leaf' : 'lock')}<span>${demo ? 'You’re exploring sample data. Changes stay in this tab and reset on reload.' : 'Your private journal · Photos are sent for analysis only and are not saved.'}</span>${demo ? '' : '<button class="text-button" data-action="demo">Explore demo</button>'}</div>
    ${view === 'today' ? todayView() : view === 'log' ? logView() : view === 'trends' ? trendsView() : goalsView()}
    <footer>Made for your everyday. <span>Estimates are a starting point. Your review makes them useful.</span><button class="text-button" data-action="install">Install on Android ${icon('arrow')}</button></footer></main></div>
    <nav class="mobile-nav" aria-label="Mobile">${navigation()}</nav>`;
}
function pageHead(eyebrow, title, description, actions = '') {
  return `<div class="page-head"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="subtitle">${description}</p></div><div class="head-actions">${actions}</div></div>`;
}
function datePicker() { return `<label class="date-picker"><span class="sr-only">Journal date</span><input type="date" id="selected-day" value="${selectedDay}" required></label>`; }
function todayView() {
  const totals = total(dailyFoods(selectedDay)), target = targetOn(state.targets, selectedDay), goal = target ? target.maintenance - target.deficit : null;
  const remaining = goal === null ? null : goal - totals.calories;
  const ratio = goal ? Math.min(1, totals.calories / goal) : 0;
  const meals = state.meals.filter(m => m.date === selectedDay);
  return pageHead(prettyDay(selectedDay).toUpperCase(), 'Small choices.<br><em>Clearer progress.</em>', 'Your plate, your pace. Let’s make today count.', `${datePicker()}<button class="button primary" data-action="add">${icon('plus')} Log a meal</button>`) +
    `<section class="summary-grid" aria-label="Daily nutrition"><article class="card energy-card"><div class="card-label">DAILY ENERGY <span class="pill">${goal ? `${fmt(goal)} kcal target` : 'Set your target'}</span></div><div class="energy-body"><div class="ring"><svg viewBox="0 0 180 180" aria-hidden="true"><circle class="ring-track" cx="90" cy="90" r="76"/><circle class="ring-fill" cx="90" cy="90" r="76" stroke-dasharray="${ratio * 477.52} 477.52"/></svg><div class="ring-label"><strong>${fmt(totals.calories)}</strong><span>kcal eaten</span></div></div><div class="energy-copy"><span class="overline">${remaining === null ? 'YOUR NEXT STEP' : remaining >= 0 ? 'ROOM FOR MORE' : 'OVER YOUR TARGET'}</span><strong>${remaining === null ? 'Set a goal' : fmt(Math.abs(remaining))}<small>${remaining === null ? '' : ' kcal'}</small></strong><p>${remaining === null ? 'Choose your calorie and protein targets in Goals.' : remaining >= 0 ? 'calories remaining today' : 'calories above today’s target'}</p><button class="text-button" data-view="goals">View your targets ${icon('arrow')}</button></div></div><div class="energy-foot">${icon('check')} ${meals.length} meals logged <span>${target ? `${fmt(target.deficit)} kcal planned deficit` : 'Every meal is a fresh start'}</span></div></article>
    <article class="card macro-card"><div class="card-label">THE MACRO PICTURE <span class="muted">grams</span></div>${macro('Protein', totals.protein, target?.protein, 'protein')}${macro('Carbs', totals.carbs, null, 'carbs')}${macro('Fat', totals.fat, null, 'fat')}<p class="micro-note">${target ? `${fmt(Math.max(0, target.protein - totals.protein))} g protein to your daily target.` : 'Set a daily protein target in Goals.'}</p></article></section>
    <section class="lower-grid"><div><div class="section-heading"><h2>On your plate</h2><button class="text-button" data-view="log">Full food log ${icon('arrow')}</button></div><div class="meal-list">${meals.length ? meals.map(mealCard).join('') : empty('Your next meal starts here.', 'Take a photo or add foods manually to begin.', '<button class="button primary" data-action="add">Log your first meal</button>')}</div></div><aside class="card capture-card"><span class="capture-icon">${icon('camera')}</span><p class="eyebrow">LESS TYPING. MORE LIVING.</p><h2>Point. Snap.<br><em>Know your plate.</em></h2><p>Turn a food photo into an editable estimate. You bring the context; we’ll help with the numbers.</p><button class="button primary" data-action="photo">${icon('camera')} Add a food photo</button><p class="micro-note">${demo ? 'Try the sample estimate in demo mode.' : config.aiConfigured ? 'Always review portions before saving.' : 'Manual logging is ready. Photo analysis needs API setup.'}</p></aside></section>`;
}
function macro(label, value, target, kind) {
  return `<div class="macro ${kind}"><div><span><i></i>${label}</span><strong>${fmt(value)}<small> g${target ? ` / ${fmt(target)}` : ''}</small></strong></div><progress value="${target ? Math.min(value, target) : Math.min(value, kind === 'carbs' ? 300 : 100)}" max="${target || (kind === 'carbs' ? 300 : 100)}" aria-label="${label}${target ? ' target progress' : ' intake, decorative scale'}"></progress>${target ? '' : '<span class="scale-note">Intake only · no target set</span>'}</div>`;
}
function mealCard(meal) {
  const t = total(meal.foods);
  return `<article class="meal-card"><div class="meal-symbol ${meal.type.toLowerCase()}">${icon(meal.type === 'Snack' ? 'leaf' : 'log')}</div><div class="meal-info"><p class="meal-type">${esc(meal.type)} <span>${meal.source === 'ai-estimate' ? 'PHOTO ESTIMATE' : 'MANUAL ENTRY'}</span></p><h3>${esc(meal.title || meal.foods.map(f => f.name).join(', '))}</h3><p>${meal.foods.map(f => esc(f.name)).join(' · ')}</p><div class="meal-macros"><span>P ${fmt(t.protein)} g</span><span>C ${fmt(t.carbs)} g</span><span>F ${fmt(t.fat)} g</span></div></div><div class="meal-end"><strong>${fmt(t.calories)} <small>kcal</small></strong><button class="text-button" data-action="edit" data-id="${esc(meal.id)}">Edit ${icon('arrow')}</button></div></article>`;
}
function empty(title, description, button = '') { return `<div class="empty-state">${icon('leaf')}<h3>${title}</h3><p>${description}</p>${button}</div>`; }
function logView() {
  const meals = state.meals.filter(m => (!logFrom || m.date >= logFrom) && (!logTo || m.date <= logTo) && `${m.title} ${m.type} ${m.foods.map(f => f.name).join(' ')}`.toLowerCase().includes(logQuery.toLowerCase())).sort((a, b) => b.date.localeCompare(a.date));
  return pageHead('YOUR FOOD JOURNAL', 'Every plate.<br><em>All in one place.</em>', 'Review, refine, repeat. Your nutrition history belongs to you.', '<button class="button secondary" data-action="csv">' + icon('download') + ' Export CSV</button><button class="button primary" data-action="add">' + icon('plus') + ' Log a meal</button>') +
    `<div class="card log-filters"><label>Search foods<input id="log-query" type="search" placeholder="Paneer, breakfast, oats…" value="${esc(logQuery)}"></label><label>From<input id="log-from" type="date" value="${logFrom}"></label><label>To<input id="log-to" type="date" value="${logTo}"></label><button class="button secondary" data-action="filter">Apply</button><button class="text-button" data-action="clear-filter">Clear</button></div>
    <div class="card table-wrap"><table><caption class="sr-only">Food log with editable meals</caption><thead><tr><th>Date / meal</th><th>Food & portion</th><th>kcal</th><th>Protein</th><th>Carbs</th><th>Fat</th><th>Actions</th></tr></thead><tbody>${meals.map(m => m.foods.map((f, i) => `<tr><td>${i === 0 ? `<strong>${esc(m.date)}</strong><span>${esc(m.type)}</span>` : ''}</td><td><strong>${esc(f.name)}</strong><span>${esc(f.portion)} · ${m.source === 'ai-estimate' ? 'AI estimate' : 'Manual'}</span></td><td>${fmt(f.calories)}</td><td>${fmt(f.protein)} g</td><td>${fmt(f.carbs)} g</td><td>${fmt(f.fat)} g</td><td>${i === 0 ? `<button class="text-button" data-action="edit" data-id="${esc(m.id)}">Edit</button><button class="text-button" data-action="repeat" data-id="${esc(m.id)}">Repeat</button>` : ''}</td></tr>`).join('')).join('')}</tbody></table>${meals.length ? '' : empty('A little empty, for now.', 'Your saved meals will appear here.')}</div><p class="micro-note">${meals.length} meals shown. CSV exports the entire journal, one row per food.</p><button class="text-button" data-action="backup">${icon('download')} Download full JSON backup</button>`;
}
function trendsView() {
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(selectedDay, i - 6));
  const data = days.map(day => ({ day, t: total(dailyFoods(day)), logged: state.meals.some(m => m.date === day), target: targetOn(state.targets, day) }));
  const logged = data.filter(d => d.logged);
  const max = Math.max(2500, ...data.map(d => d.t.calories), ...data.map(d => d.target ? d.target.maintenance - d.target.deficit : 0));
  const bars = data.map((d, i) => { const height = d.t.calories / max * 160; const goal = d.target ? d.target.maintenance - d.target.deficit : null; return `<g><title>${esc(d.day)}: ${fmt(d.t.calories)} kcal${goal ? `; target ${fmt(goal)}` : ''}</title><rect class="chart-bar" x="${32 + i * 80}" y="${190 - height}" width="32" height="${height}" rx="6"/>${goal ? `<line class="chart-target" x1="${27 + i * 80}" x2="${69 + i * 80}" y1="${190 - goal / max * 160}" y2="${190 - goal / max * 160}"/>` : ''}<text x="${48 + i * 80}" y="216" text-anchor="middle">${new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}</text><text x="${48 + i * 80}" y="${Math.max(14, 180 - height)}" text-anchor="middle">${d.logged ? Math.round(d.t.calories) : '—'}</text></g>`; }).join('');
  const weights = [...state.weights].sort((a, b) => b.date.localeCompare(a.date));
  return pageHead('SEE THE BIGGER PICTURE', 'Progress has<br><em>a pattern.</em>', 'Seven days of context. One meal never tells the whole story.', datePicker()) +
    `<div class="trend-stats"><article class="card"><span class="overline">AVERAGE LOGGED CALORIES</span><strong>${logged.length ? fmt(logged.reduce((s, d) => s + d.t.calories, 0) / logged.length) : '—'} <small>kcal</small></strong><p>Across ${logged.length} days with entries; days may be incomplete.</p></article><article class="card"><span class="overline">AVERAGE LOGGED PROTEIN</span><strong>${logged.length ? fmt(logged.reduce((s, d) => s + d.t.protein, 0) / logged.length) : '—'} <small>g</small></strong><p>Based on meals you actually logged.</p></article><article class="card"><span class="overline">LATEST WEIGHT</span><strong>${weights.length ? fmt(weights[0].kg) : '—'} <small>kg</small></strong><p>${weights.length ? esc(weights[0].date) : 'Add a weigh-in in Goals.'}</p></article></div>
    <article class="card chart-card"><div class="section-heading"><h2>Your week in calories</h2><span class="chart-legend">Green: logged · Dash: target</span></div><svg viewBox="0 0 620 235" role="img" aria-label="Calories logged in the seven days ending ${selectedDay}. Missing days are shown with a dash.">${bars}</svg><p class="micro-note">Targets use the settings active on each day. Missing entries do not mean zero food eaten.</p></article><article class="card weight-history"><h2>Weight journal</h2>${weights.length ? `<div class="weight-pills">${weights.slice(0, 14).map(w => `<div><span>${esc(w.date)}</span><strong>${fmt(w.kg)} kg</strong></div>`).join('')}</div>` : '<p class="muted">No weigh-ins yet. Start whenever you’re ready.</p>'}</article>`;
}
function goalsView() {
  const target = targetOn(state.targets, selectedDay);
  return pageHead('GIVE YOUR DAY DIRECTION', 'Your goals.<br><em>Your own pace.</em>', 'Choose a starting point. Adjust as you learn what works for you.') +
    `<div class="goals-grid"><form id="goals-form" class="card form-card"><h2>Daily targets</h2><p class="muted">Enter your own maintenance estimate or a value agreed with your nutrition professional.</p><label>Effective from<input name="date" type="date" value="${selectedDay}" required></label><div class="two-col"><label>Estimated maintenance · kcal<input name="maintenance" type="number" min="500" max="10000" step="1" value="${target?.maintenance ?? ''}" placeholder="e.g. 2400" required></label><label>Planned deficit · kcal<input name="deficit" type="number" min="0" max="2000" step="1" value="${target?.deficit ?? 0}" required></label></div><label>Daily protein target · g<input name="protein" type="number" min="0" max="1000" step="0.1" value="${target?.protein ?? ''}" placeholder="Your chosen target" required></label><div class="goal-preview" id="goal-preview">${target ? `${fmt(target.maintenance - target.deficit)} kcal daily target` : 'Enter your values to see your daily target.'}</div><p class="micro-note">Maintenance − planned deficit = calorie target. This is an estimate, not a measurement of your energy expenditure.</p><button class="button primary" type="submit">${icon('check')} Save targets</button></form>
    <div class="goals-aside"><form id="weight-form" class="card form-card"><h2>A quick check-in</h2><p class="muted">Weight is one piece of the picture.</p><div class="two-col"><label>Date<input name="date" type="date" value="${selectedDay}" required></label><label>Weight · kg<input name="kg" type="number" min="10" max="600" step="0.1" required placeholder="e.g. 76.0"></label></div><button class="button secondary" type="submit">Save weigh-in</button></form><article class="card note-card"><span class="eyebrow">A NOTE ON THE NUMBERS</span><h2>Consistency over<br>perfect precision.</h2><p>Photos help you start. Weighed portions and nutrition labels help refine estimates. Hidden oil and mixed recipes can change the numbers.</p><p>Changing a target creates a dated entry, so earlier days keep the targets that applied then.</p></article></div></div>
    <article class="card target-history"><h2>Target history</h2>${state.targets.length ? `<div class="table-wrap"><table><thead><tr><th>Effective from</th><th>Maintenance</th><th>Deficit</th><th>Calorie target</th><th>Protein</th></tr></thead><tbody>${[...state.targets].sort((a, b) => b.date.localeCompare(a.date)).map(t => `<tr><td>${t.date}</td><td>${fmt(t.maintenance)}</td><td>${fmt(t.deficit)}</td><td>${fmt(t.maintenance - t.deficit)}</td><td>${fmt(t.protein)} g</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Your first target will appear here.</p>'}</article>`;
}
function foodRow(f = { name: '', portion: '', calories: 0, protein: 0, carbs: 0, fat: 0 }) {
  return `<div class="food-row"><div class="food-name-row"><label>Food<input name="food-name" value="${esc(f.name)}" maxlength="160" placeholder="e.g. Cooked rice" required></label><button type="button" class="icon-button" data-action="remove-food" aria-label="Remove food">${icon('close')}</button></div><label>Portion<input name="portion" value="${esc(f.portion)}" maxlength="160" placeholder="e.g. 150 g, cooked"></label><div class="macro-inputs">${['calories', 'protein', 'carbs', 'fat'].map(key => `<label>${key === 'calories' ? 'kcal' : key + ' · g'}<input name="${key}" type="number" value="${f[key]}" min="0" max="10000" step="0.1" required></label>`).join('')}</div></div>`;
}
function openMeal(meal, photo = false) {
  draft = meal ? structuredClone(meal) : { id: crypto.randomUUID(), date: selectedDay, type: 'Lunch', title: '', notes: '', source: 'manual', foods: [] };
  imageData = '';
  const editing = state.meals.some(m => m.id === draft.id);
  dialog.innerHTML = `<div class="dialog-header"><div><p class="eyebrow">${editing ? 'REFINE YOUR JOURNAL' : 'A LITTLE MORE AWARENESS'}</p><h2 id="meal-heading">${editing ? 'Edit your meal' : 'What’s on your plate?'}</h2></div><button class="icon-button" data-action="close-meal" aria-label="Close meal editor">${icon('close')}</button></div><form id="meal-form"><div class="dialog-scroll"><div class="photo-panel"><div class="photo-placeholder" id="photo-preview">${icon('camera')}<span>Good food. A quick photo.</span><small>JPEG, PNG, WebP · processed on your device before upload</small></div><div class="photo-actions"><label class="button secondary">${icon('camera')} Camera<input class="sr-only" id="camera-file" type="file" accept="image/jpeg,image/png,image/webp" capture="environment"></label><label class="button secondary">Choose photo<input class="sr-only" id="gallery-file" type="file" accept="image/jpeg,image/png,image/webp"></label><button class="button primary" type="button" data-action="analyse" id="analyse-button">${demo ? 'Try sample estimate' : 'Analyse photo'}</button></div><label>Photo context<input id="photo-notes" maxlength="2000" placeholder="e.g. 2 rotis, home-cooked paneer, ate half the rice"></label><div id="assumptions" class="assumptions" role="status">${draft.source === 'ai-estimate' ? 'Saved as an AI estimate. Review portions and macros when editing.' : 'Take a photo or start manually below. Nothing saves until you confirm.'}</div></div><div class="two-col"><label>Meal date<input type="date" name="date" value="${draft.date}" required></label><label>Meal<select name="type">${['Breakfast', 'Lunch', 'Dinner', 'Snack'].map(t => `<option ${draft.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div><label>Meal name<input name="title" value="${esc(draft.title)}" maxlength="160" placeholder="e.g. A proper paneer lunch"></label><div class="section-heading"><h3>Foods & portions</h3><span class="micro-note">Macros are for the whole portion.</span></div><div id="food-rows">${(draft.foods.length ? draft.foods : [undefined]).map(foodRow).join('')}</div><div class="editor-tools"><button class="text-button" type="button" data-action="add-food">${icon('plus')} Add food</button><div><select id="portion-scale" aria-label="Scale all portions"><option value="0.5">Half portions</option><option value="2">Double portions</option></select><button type="button" class="text-button" data-action="scale">Apply</button></div></div><label>Notes<textarea name="notes" maxlength="4000" rows="2" placeholder="Oil, recipe, label details…">${esc(draft.notes)}</textarea></label><p id="meal-error" class="form-error" role="alert"></p></div><div class="dialog-footer">${editing ? '<button type="button" class="text-button danger" data-action="delete">Delete meal</button>' : '<span class="micro-note">Review first. Save when ready.</span>'}<button type="submit" class="button primary" id="save-meal">${icon('check')} ${editing ? 'Save changes' : 'Save meal'}</button></div></form>`;
  dialog.showModal(); if (photo) $('#photo-notes').focus();
}
function collectFoods() {
  return [...dialog.querySelectorAll('.food-row')].map(row => ({ name: $('[name="food-name"]', row).value, portion: $('[name="portion"]', row).value, ...Object.fromEntries(['calories', 'protein', 'carbs', 'fat'].map(key => [key, Number($(`[name="${key}"]`, row).value)])) }));
}
async function loadImage(file) {
  if (!file) return;
  if (file.size > 20_000_000 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG, or WebP photo smaller than 20 MB.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  imageData = canvas.toDataURL('image/jpeg', 0.82);
  $('#photo-preview').innerHTML = '<img alt="Selected food photo, ready for analysis">'; $('#photo-preview img').src = imageData;
}
async function analysePhoto() {
  if (busy) return;
  if (!demo && !imageData) return toast('Choose or take a photo first.');
  if (!demo && !config.aiConfigured) return toast('Add OPENAI_API_KEY on the server to enable photo analysis.');
  if (collectFoods().some(f => f.name.trim()) && !confirm('Replace the foods in this draft with a new estimate? Your saved journal will not change.')) return;
  busy = true; $('#analyse-button').disabled = true; $('#save-meal').disabled = true;
  $('#assumptions').textContent = 'Looking at your plate… This can take a little while.';
  try {
    const result = demo ? { title: 'Paneer, roti & a little green', foods: sampleState().meals[1].foods, assumptions: ['Sample estimate for demonstration; your selected photo has not been analysed.', 'Assumes 150 g paneer curry, 2 medium rotis, and a small cucumber salad.', 'Oil and recipe can change these values. Adjust the foods before saving.'] } : await api('/api/analyse', { method: 'POST', body: JSON.stringify({ image: imageData, notes: $('#photo-notes').value }) });
    if (!result.foods.length) { $('#assumptions').textContent = result.assumptions.join(' ') || 'No food identified. Try another photo or enter the meal manually.'; return; }
    $('#food-rows').innerHTML = result.foods.map(foodRow).join(''); $('[name="title"]', dialog).value = result.title;
    draft.source = demo ? 'manual' : 'ai-estimate';
    $('#assumptions').textContent = result.assumptions.join(' ');
    $('[name="notes"]', dialog).value = [$('#photo-notes').value, ...result.assumptions].filter(Boolean).join('\n').slice(0, 4000);
    toast('Estimate ready. Review the portions and macros, then save.');
  } catch (e) { $('#assumptions').textContent = e.message; }
  finally { busy = false; $('#analyse-button').disabled = false; $('#save-meal').disabled = false; }
}
function download(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function personal() {
  config = await api('/api/config');
  if (config.authenticated) { const result = await api('/api/state'); state = result.state; revision = result.revision; demo = false; render(); }
  else if (config.authRequired) {
    $('#login-dialog').innerHTML = `<div class="dialog-header"><div><p class="eyebrow">YOUR PERSONAL SPACE</p><h2 id="login-heading">Open your journal.</h2></div><button class="icon-button" data-action="close-login" aria-label="Close sign in">${icon('close')}</button></div><form id="login-form" class="login-form"><label>App password<input name="password" type="password" autocomplete="current-password" required></label><p id="login-error" class="form-error" role="alert"></p><button class="button primary" type="submit">${icon('lock')} Sign in</button><p class="micro-note">Use the password configured on your own server.</p></form>`;
    $('#login-dialog').showModal();
  } else toast('This is the sample demo. Set APP_PASSWORD on your server to enable your private journal.');
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.view) { view = button.dataset.view; render(); window.scrollTo(0, 0); return; }
  const action = button.dataset.action; if (!action) return;
  try {
    if (action === 'add' || action === 'photo') openMeal(null, action === 'photo');
    if (action === 'edit') openMeal(state.meals.find(m => m.id === button.dataset.id));
    if (action === 'repeat') { const meal = structuredClone(state.meals.find(m => m.id === button.dataset.id)); meal.id = crypto.randomUUID(); meal.date = localDay(); openMeal(meal); }
    if (action === 'close-meal' && !busy && !saving) { dialog.close(); imageData = ''; }
    if (action === 'add-food') { if ($$('#food-rows .food-row').length >= 40) return toast('A meal can contain up to 40 foods.'); $('#food-rows').insertAdjacentHTML('beforeend', foodRow()); }
    if (action === 'remove-food') button.closest('.food-row').remove();
    if (action === 'scale') { const factor = Number($('#portion-scale').value); $('#food-rows').innerHTML = collectFoods().map(f => foodRow({ ...f, portion: `${factor} × (${f.portion})`.slice(0, 160), ...Object.fromEntries(['calories', 'protein', 'carbs', 'fat'].map(k => [k, Math.round(f[k] * factor * 10) / 10])) })).join(''); }
    if (action === 'analyse') await analysePhoto();
    if (action === 'delete' && confirm('Delete this meal from your journal?')) { await persist({ ...state, meals: state.meals.filter(m => m.id !== draft.id) }); dialog.close(); render(); toast('Meal deleted.'); }
    if (action === 'csv') download('\uFEFF' + csv(state), 'text/csv;charset=utf-8', `macrolens-${localDay()}.csv`);
    if (action === 'backup') download(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), state }, null, 2), 'application/json', `macrolens-backup-${localDay()}.json`);
    if (action === 'filter') { logQuery = $('#log-query').value; logFrom = $('#log-from').value; logTo = $('#log-to').value; render(); }
    if (action === 'clear-filter') { logQuery = logFrom = logTo = ''; render(); }
    if (action === 'login') await personal();
    if (action === 'close-login') $('#login-dialog').close();
    if (action === 'logout') { await api('/api/session', { method: 'DELETE', body: '{}' }); config.authenticated = false; demo = true; state = demoState ??= sampleState(); render(); }
    if (action === 'demo') { demo = true; state = demoState ??= sampleState(); render(); }
    if (action === 'reload') location.reload();
    if (action === 'install') {
      if (installPrompt) { await installPrompt.prompt(); installPrompt = null; }
      else toast('On Samsung: open this app’s HTTPS link in Chrome → menu ⋮ → Add to Home screen or Install app.');
    }
  } catch (e) { toast(e.message); }
});
function $$(s) { return [...document.querySelectorAll(s)]; }
document.addEventListener('change', async event => {
  if (event.target.id === 'selected-day' && event.target.value) { selectedDay = event.target.value; render(); }
  if (['camera-file', 'gallery-file'].includes(event.target.id)) { try { await loadImage(event.target.files[0]); } catch { toast('This photo could not be opened. Try a JPEG, PNG, or WebP photo under 20 MB.'); } }
});
document.addEventListener('input', event => {
  if (event.target.closest('#goals-form')) { const form = $('#goals-form'); const m = Number(form.maintenance.value), d = Number(form.deficit.value); $('#goal-preview').textContent = m > d ? `${fmt(m - d)} kcal daily target` : 'Maintenance must be greater than your deficit.'; }
});
document.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target;
  const button = $('button[type="submit"]', form); if (button) button.disabled = true;
  try {
    if (form.id === 'meal-form') {
      if (busy) return;
      const data = new FormData(form); const meal = { ...draft, date: data.get('date'), type: data.get('type'), title: data.get('title'), notes: data.get('notes'), foods: collectFoods() };
      await persist({ ...state, meals: [...state.meals.filter(m => m.id !== meal.id), meal] });
      selectedDay = meal.date; dialog.close(); imageData = ''; render(); toast(demo ? 'Saved in the demo sandbox.' : 'Meal saved to your journal.');
    }
    if (form.id === 'goals-form') {
      const data = new FormData(form); const target = { date: data.get('date'), maintenance: Number(data.get('maintenance')), deficit: Number(data.get('deficit')), protein: Number(data.get('protein')) };
      await persist({ ...state, targets: [...state.targets.filter(t => t.date !== target.date), target] }); render(); toast('Targets saved with their effective date.');
    }
    if (form.id === 'weight-form') {
      const data = new FormData(form), weight = { date: data.get('date'), kg: Number(data.get('kg')) };
      await persist({ ...state, weights: [...state.weights.filter(w => w.date !== weight.date), weight] }); render(); toast('Weigh-in saved.');
    }
    if (form.id === 'login-form') { await api('/api/session', { method: 'POST', body: JSON.stringify({ password: new FormData(form).get('password') }) }); await personal(); $('#login-dialog').close(); toast('Welcome to your journal.'); }
  } catch (e) {
    if (form.id === 'meal-form') $('#meal-error').textContent = e.message;
    else if (form.id === 'login-form') $('#login-error').textContent = e.message;
    else toast(e.message);
  } finally { if (button) button.disabled = false; }
});
dialog.addEventListener('cancel', event => { if (busy || saving) event.preventDefault(); else imageData = ''; });
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; });
try {
  config = await api('/api/config');
  if (config.authenticated) { const result = await api('/api/state'); state = result.state; revision = result.revision; demo = false; }
  else state = demoState = sampleState();
  render();
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
} catch { app.innerHTML = '<div class="connection-error"><h1>Your journal couldn’t connect.</h1><p>Check the server and your internet connection, then try again.</p><button class="button primary" data-action="reload">Try again</button></div>'; }
