// Macros — a macro tracker that lives on the home screen.
// All data stays in this browser's localStorage; use Goals → Export to back it up.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
const MACROS = [
  ['p', 'Protein', '--protein', 4],
  ['c', 'Carbs', '--carbs', 4],
  ['f', 'Fat', '--fat', 9],
];
const NUTRIENTS = ['kcal', 'p', 'c', 'f', 'fib'];
const STORE = 'macros.v1';
const USDA_API = 'https://api.nal.usda.gov/fdc/v1/foods/search';

// ---------------------------------------------------------------- storage

const defaults = () => ({
  goals: { kcal: 2000, p: 150, c: 200, f: 67, fib: 0 }, // fib 0 = no fiber goal
  usdaKey: '',
  log: {}, // { 'YYYY-MM-DD': [entry] }
  myFoods: [], // saved + custom foods
  recents: [], // most recent first
  weights: {}, // { 'YYYY-MM-DD': kg }
  goalWeight: 0, // kg; 0 = no goal weight
  weightUnit: /-(US|LR|MM)$/i.test(navigator.language) ? 'lb' : 'kg',
  liftUnit: /-(US|LR|MM)$/i.test(navigator.language) ? 'lb' : 'kg',
  exercises: [], // custom exercises
  routines: [],
  workouts: [], // finished workouts, newest first
  active: null, // workout in progress
});

let db = load();

function load() {
  try {
    return Object.assign(defaults(), JSON.parse(localStorage.getItem(STORE)) || {});
  } catch {
    return defaults();
  }
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(db));
  } catch {
    toast('Could not save. Storage may be full.');
  }
}

navigator.storage?.persist?.();

// ---------------------------------------------------------------- helpers

const dkey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const noon = (d = new Date()) => { const x = new Date(d); x.setHours(12, 0, 0, 0); return x; };

const kc = (x) => Math.round(x).toLocaleString();
const gr = (x) => (Math.abs(x) < 10 ? Math.round(x * 10) / 10 : Math.round(x)).toLocaleString();

function parseQty(s) {
  s = String(s).trim().replace(',', '.');
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return +m[1] + m[2] / m[3];
  m = s.match(/^(\d*\.?\d+)\/(\d*\.?\d+)$/);
  if (m) return m[1] / m[2];
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : NaN;
}

function amountText(qty, label) {
  const q = Math.round(qty * 100) / 100;
  if (/^(g|oz|ml)$/.test(label)) return `${q} ${label}`;
  if (label.startsWith('1 ')) return q === 1 ? label : `${q} × ${label.slice(2)}`;
  return q === 1 ? label : `${q} × ${label}`;
}

function totalsOf(item, qty = item.qty, unit = item.unit) {
  const mult = (item.units[unit]?.mult ?? 1) * qty;
  const o = {};
  for (const k of NUTRIENTS) o[k] = (item.n[k] || 0) * mult;
  return o;
}

function sumAll(entries) {
  const o = { kcal: 0, p: 0, c: 0, f: 0, fib: 0 };
  for (const e of entries) {
    const t = totalsOf(e);
    for (const k of NUTRIENTS) o[k] += t[k];
  }
  return o;
}

const titleCase = (s) =>
  String(s || '').toLowerCase().replace(/(^|[\s(/&-])([a-z])/g, (_, a, b) => a + b.toUpperCase());

const pcf = (t) => `<span class="pcf">P <b>${gr(t.p)}</b> · C <b>${gr(t.c)}</b> · F <b>${gr(t.f)}</b></span>`;

function defaultMeal() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  return h < 10.5 ? 'Breakfast' : h < 15 ? 'Lunch' : h < 21 ? 'Dinner' : 'Snacks';
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if ($(`script[src="${src}"]`)) return res();
    const s = Object.assign(document.createElement('script'), { src, onload: res, onerror: rej });
    document.head.append(s);
  });
}

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (action ? `<button>${esc(action.label)}</button>` : '');
  if (action) t.querySelector('button').onclick = () => { action.run(); t.classList.remove('show'); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 4500 : 2200);
}

// ---------------------------------------------------------------- sheets

function openSheet({ title, body, short = false, onMount, onClose }) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="sheet-backdrop"></div>
    <section class="sheet ${short ? 'short' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="sheet-body">${body}</div>
    </section>`;
  $('#sheets').append(wrap);
  document.body.style.overflow = 'hidden';
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose?.();
    wrap.remove();
    if (!$('#sheets').children.length) document.body.style.overflow = '';
  };
  wrap.querySelector('.sheet-backdrop').onclick = close;
  wrap.querySelector('[data-close]').onclick = close;
  const api = { el: wrap.querySelector('.sheet'), body: wrap.querySelector('.sheet-body'), close };
  onMount?.(api);
  return api;
}

// ---------------------------------------------------------------- food sources

// Foods are { key, name, brand, src, n: nutrients per 1 base unit, units: [{label, mult}], def: {unit, qty} }.
// For gram-based foods the base unit is 1 g; for custom foods it is 1 serving; for recipes it is the whole batch.

const gramUnits = [{ label: 'g', mult: 1 }, { label: 'oz', mult: 28.3495 }];
const per100 = (o) => Object.fromEntries(NUTRIENTS.map((k) => [k, (o[k] || 0) / 100]));

let usdaRows;
function loadUsda() {
  usdaRows ??= fetch('data/usda-foods.json')
    .then((r) => r.json())
    .then((rows) => rows.map((r) => ({ r, lc: r[1].toLowerCase() })));
  return usdaRows;
}

function fromUsdaRow([id, name, kcal, p, c, f, fib, portions]) {
  const units = [...portions.map(([label, mult]) => ({ label, mult })), ...gramUnits];
  return {
    key: 'usda:' + id, name, brand: '', src: 'USDA',
    n: per100({ kcal, p, c, f, fib }),
    units,
    def: portions.length ? { unit: Math.max(0, portions.findIndex(([l]) => /\bmedium\b/i.test(l))), qty: 1 } : { unit: units.length - 2, qty: 100 },
  };
}

function searchTerms(q) {
  return q.toLowerCase().split(/[\s,]+/).filter(Boolean).map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

// Rank so "egg" finds "Egg, whole" before "Eggplant", and plain everyday foods beat
// baby food, restaurant items and long, specific variants.
function scoreName(lc, terms) {
  let sc = 0;
  for (const t of terms) {
    const re = new RegExp(`(^|[^a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(e?s)?(?![a-z])`);
    if (re.test(lc)) sc += 5; // whole word (plural ok)
    else {
      const i = lc.indexOf(t);
      if (i < 0) return -1;
      sc += i === 0 || /[^a-z]/.test(lc[i - 1]) ? 1 : 0;
    }
  }
  const head = lc.split(',')[0].trim();
  const words = head.split(/\s+/);
  const is = (w, t) => w === t || w === t + 's' || w === t + 'es';
  if (words.some((w) => is(w, terms[0]))) sc += 4;
  if (words.length === 1 && terms.some((t) => is(words[0], t))) sc += 2;
  sc += (lc.match(/\b(raw|whole|fresh|cooked|plain|all commercial varieties|fluid|meat only)\b/g) || []).length * 0.8;
  if (/baby food|infant|toddler|school lunch|restaurant|fast foods?|^[a-z' ]+'s,/.test(lc)) sc -= 4;
  return sc - (lc.split(',').length - 1) * 0.35 - lc.length / 80;
}

async function searchLocal(q) {
  const terms = searchTerms(q);
  if (!terms.length) return [];
  const mine = [];
  const seen = new Set();
  for (const f of [...db.myFoods, ...db.recents]) {
    if (seen.has(f.key)) continue;
    const s = scoreName(`${f.name} ${f.brand || ''}`.toLowerCase(), terms);
    if (s >= 0) { seen.add(f.key); mine.push([s + 10, f]); }
  }
  const rows = await loadUsda();
  const hits = [];
  for (const x of rows) {
    const s = scoreName(x.lc, terms);
    if (s >= 0 && !seen.has('usda:' + x.r[0])) hits.push([s, x.r]);
  }
  hits.sort((a, b) => b[0] - a[0]);
  mine.sort((a, b) => b[0] - a[0]);
  return [...mine.map((m) => m[1]), ...hits.slice(0, 40).map((h) => fromUsdaRow(h[1]))];
}

function fromUsdaApi(f) {
  const n = {};
  const ids = { 1008: 'kcal', 1003: 'p', 1005: 'c', 1004: 'f', 1079: 'fib' };
  for (const x of f.foodNutrients || []) {
    const k = ids[x.nutrientId];
    if (k && !(k === 'kcal' && x.unitName !== 'KCAL')) n[k] = x.value || 0;
  }
  const units = [...gramUnits];
  let def = { unit: 0, qty: 100 };
  const ss = f.servingSize, su = (f.servingSizeUnit || '').toLowerCase();
  if (ss && /^(g|grm|ml|mlt)$/.test(su)) {
    const unit = su.startsWith('m') ? 'ml' : 'g';
    const hh = f.householdServingFullText?.trim();
    units.unshift({ label: `1 serving (${hh ? hh + ', ' : ''}${Math.round(ss * 10) / 10} ${unit})`, mult: ss });
    def = { unit: 0, qty: 1 };
  }
  return {
    key: 'fdc:' + f.fdcId, name: titleCase(f.description), brand: titleCase(f.brandName || f.brandOwner || ''),
    src: 'USDA', n: per100(n), units, def, barcode: f.gtinUpc || undefined,
  };
}

async function searchBranded(q) {
  const params = new URLSearchParams({ api_key: db.usdaKey || 'DEMO_KEY', query: q, dataType: 'Branded', pageSize: '40' });
  const res = await fetch(`${USDA_API}?${params}`);
  if (res.status === 429) throw new Error(db.usdaKey ? 'USDA rate limit hit. Try again in a bit.' : 'The shared demo key is out of searches. Add your free USDA key under Goals.');
  if (res.status === 403) throw new Error('USDA rejected the API key. Check it under Goals.');
  if (!res.ok) throw new Error(`USDA search failed (${res.status}).`);
  const data = await res.json();
  return (data.foods || []).map(fromUsdaApi).filter((f) => f.n.kcal || f.n.p || f.n.c || f.n.f);
}

const normCode = (c) => String(c || '').replace(/\D/g, '').replace(/^0+/, '');

async function lookupBarcode(code) {
  const mine = db.myFoods.find((f) => f.barcode && normCode(f.barcode) === normCode(code));
  if (mine) return mine;

  try {
    const fields = 'code,product_name,brands,nutriments,serving_size,serving_quantity';
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${fields}`);
    const d = res.ok ? await res.json() : null;
    const p = d?.status === 1 ? d.product : null;
    const nm = p?.nutriments || {};
    if (p && (nm['energy-kcal_100g'] != null || nm['energy-kcal_serving'] != null)) {
      const pick = (suffix) => ({
        kcal: nm['energy-kcal' + suffix], p: nm['proteins' + suffix], c: nm['carbohydrates' + suffix],
        f: nm['fat' + suffix], fib: nm['fiber' + suffix],
      });
      const sq = parseFloat(p.serving_quantity);
      const base = {
        key: 'off:' + p.code, name: p.product_name || 'Scanned food', brand: (p.brands || '').split(',')[0].trim(),
        src: 'Open Food Facts', barcode: p.code,
      };
      if (nm['energy-kcal_100g'] != null) {
        const units = [...gramUnits];
        let def = { unit: 0, qty: 100 };
        if (sq > 0) {
          const ss = p.serving_size || `${sq} g`;
          units.unshift({ label: /^\d|serving/i.test(ss) ? ss : `1 serving (${ss})`, mult: sq });
          def = { unit: 0, qty: 1 };
        }
        return { ...base, n: per100(pick('_100g')), units, def };
      }
      const n = Object.fromEntries(NUTRIENTS.map((k) => [k, pick('_serving')[k] || 0]));
      return { ...base, n, units: [{ label: `1 serving${p.serving_size ? ` (${p.serving_size})` : ''}`, mult: 1 }], def: { unit: 0, qty: 1 } };
    }
  } catch { /* fall through to USDA */ }

  try {
    const hits = await searchBranded(code);
    const hit = hits.find((f) => normCode(f.barcode) === normCode(code));
    if (hit) return hit;
  } catch { /* not found */ }
  return null;
}

// ---------------------------------------------------------------- mutations

function addEntry(food, { meal, qty, unit, date = viewDate }) {
  const key = dkey(date);
  const entry = {
    id: uid(), meal, name: food.name, brand: food.brand || '', src: food.src, key: food.key,
    n: food.n, units: food.units, unit, qty,
  };
  (db.log[key] ||= []).push(entry);
  if (food.key && food.src !== 'Quick') {
    const { key: fk } = food;
    db.recents = [{ ...food, def: { unit, qty } }, ...db.recents.filter((f) => f.key !== fk)].slice(0, 60);
  }
  save();
  render();
  return { key, entry };
}

function removeEntry(dateKey, id) {
  const list = db.log[dateKey] || [];
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return;
  const [removed] = list.splice(i, 1);
  if (!list.length) delete db.log[dateKey];
  save();
  render();
  toast(`Removed ${removed.name}`, {
    label: 'Undo',
    run: () => { (db.log[dateKey] ||= []).splice(i, 0, removed); save(); render(); },
  });
}

const isSaved = (key) => db.myFoods.some((f) => f.key === key);

function toggleSaved(food) {
  if (isSaved(food.key)) db.myFoods = db.myFoods.filter((f) => f.key !== food.key);
  else db.myFoods.unshift({ ...food });
  save();
}

// Create or update a custom food or recipe in My foods.
function putMyFood(next) {
  const i = db.myFoods.findIndex((f) => f.key === next.key);
  if (i >= 0) db.myFoods[i] = next;
  else db.myFoods.unshift(next);
  db.recents = db.recents.map((f) => (f.key === next.key ? next : f));
  save();
}

function deleteMyFood(key) {
  db.myFoods = db.myFoods.filter((f) => f.key !== key);
  db.recents = db.recents.filter((f) => f.key !== key);
  save();
}

// ---------------------------------------------------------------- app shell

let viewDate = noon();
let today = dkey(new Date());
let tab = 'diary';

function render() {
  // Trends opens from the Diary as its own screen, with the previous-day arrow turned into a back arrow.
  const bar = $('.topbar');
  bar.classList.toggle('no-nav', tab !== 'diary' && tab !== 'trends');
  bar.classList.toggle('back', tab === 'trends');
  $('#prev-day').setAttribute('aria-label', tab === 'trends' ? 'Back to diary' : 'Previous day');
  if (tab === 'diary') {
    const k = dkey(viewDate);
    const rel = { [dkey(new Date())]: 'Today', [dkey(addDays(new Date(), -1))]: 'Yesterday', [dkey(addDays(new Date(), 1))]: 'Tomorrow' }[k];
    $('#date-label').textContent = rel || viewDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  } else {
    $('#date-label').textContent = { trends: 'Trends', workout: 'Workout', foods: 'My foods', settings: 'Goals & data' }[tab];
  }
  $$('.tabbar [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === (tab === 'trends' ? 'diary' : tab)));
  ({ diary: renderDiary, trends: renderTrends, workout: renderWorkout, foods: renderFoods, settings: renderSettings })[tab]();
  updateWkBar();
}

$('#prev-day').onclick = () => {
  if (tab === 'trends') { tab = 'diary'; render(); window.scrollTo(0, 0); return; }
  viewDate = addDays(viewDate, -1);
  render();
};
$('#next-day').onclick = () => { viewDate = addDays(viewDate, 1); render(); };
$('#date-label').onclick = () => { if (tab === 'diary') { viewDate = noon(); render(); } };
$$('.tabbar [data-tab]').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));

// Keep "today" in sync if the app is left open overnight.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = dkey(new Date());
  if (now !== today) {
    if (dkey(viewDate) === today) viewDate = noon();
    today = now;
    render();
  }
});

// Swipe left/right on the diary to change days.
(() => {
  let x0 = null, y0 = 0;
  const main = $('#view');
  main.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  main.addEventListener('touchend', (e) => {
    if (x0 == null || tab !== 'diary') return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) {
      viewDate = addDays(viewDate, dx < 0 ? 1 : -1);
      render();
    }
  });
})();

// ---------------------------------------------------------------- diary

function macroMeter(k, name, color, eaten, goal) {
  const pct = goal ? Math.min(100, (eaten / goal) * 100) : 0;
  const left = goal - eaten;
  return `
    <div class="macro" style="--c: var(${color})">
      <div class="name">${name}</div>
      <div class="val">${gr(eaten)} <small>/ ${gr(goal)} g</small></div>
      <div class="meter" role="meter" aria-label="${name}" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${Math.round(eaten)}"><i style="width:${pct}%"></i></div>
      <div class="left ${left < 0 ? 'over' : ''}">${left < 0 ? `▲ ${gr(-left)} g over` : `${gr(left)} g left`}</div>
    </div>`;
}

// Fiber is a minimum, so going past the goal is good, not "over".
function fiberMeter(eaten, goal) {
  const pct = Math.min(100, (eaten / goal) * 100);
  const left = goal - eaten;
  return `
    <div class="macro fiber" style="--c: var(--fiber)">
      <div class="name">Fiber</div>
      <div class="val">${gr(eaten)} <small>/ ${gr(goal)} g</small></div>
      <div class="meter" role="meter" aria-label="Fiber" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${Math.round(eaten)}"><i style="width:${pct}%"></i></div>
      <div class="left ${left <= 0 ? 'met' : ''}">${left <= 0 ? '✓ Goal met' : `${gr(left)} g to go`}</div>
    </div>`;
}

function renderDiary() {
  const key = dkey(viewDate);
  const entries = db.log[key] || [];
  const t = sumAll(entries);
  const G = db.goals;
  const rem = G.kcal - t.kcal;
  const prevKey = dkey(addDays(viewDate, -1));
  const prev = db.log[prevKey] || [];

  let html = `
    <div class="trends-link"><button class="link-btn" id="open-trends">▥ Trends ›</button></div>
    <section class="card card-pad" aria-label="Daily summary">
      <div class="cal-eq">
        <div><div class="num">${kc(G.kcal)}</div><div class="lbl">Goal</div></div>
        <div class="op">−</div>
        <div><div class="num">${kc(t.kcal)}</div><div class="lbl">Food</div></div>
        <div class="op">=</div>
        <div class="remaining ${rem < 0 ? 'over' : ''}"><div class="num">${kc(Math.abs(rem))}</div><div class="lbl">${rem < 0 ? '▲ Over' : 'Remaining'}</div></div>
      </div>
      <div class="meter cal" role="meter" aria-label="Calories" aria-valuemin="0" aria-valuemax="${G.kcal}" aria-valuenow="${Math.round(t.kcal)}"><i style="width:${Math.min(100, (t.kcal / G.kcal) * 100 || 0)}%"></i></div>
      <div class="macros">${MACROS.map(([k, name, color]) => macroMeter(k, name, color, t[k], G[k])).join('')}${G.fib ? fiberMeter(t.fib, G.fib) : ''}</div>
    </section>`;

  for (const meal of MEALS) {
    const list = entries.filter((e) => e.meal === meal);
    const mt = sumAll(list);
    const prevMeal = prev.filter((e) => e.meal === meal);
    html += `
      <section class="card">
        <div class="meal-head">
          <div><h2>${meal}</h2>${list.length ? pcf(mt) : ''}</div>
          <span class="kcal">${list.length ? kc(mt.kcal) : ''}</span>
        </div>
        ${list.map((e) => {
          const et = totalsOf(e);
          return `
          <button class="entry" data-entry="${e.id}">
            <div class="main">
              <div class="title">${esc(e.name)}</div>
              <div class="sub">${esc(amountText(e.qty, e.units[e.unit]?.label || ''))}${e.brand ? ' · ' + esc(e.brand) : ''}</div>
            </div>
            <div style="text-align:right"><div class="kcal">${kc(et.kcal)}</div>${pcf(et)}</div>
          </button>`;
        }).join('')}
        <div class="meal-actions">
          <button data-add="${meal}">+ Add food</button>
          ${!list.length && prevMeal.length ? `<button data-copy="${meal}">Copy from ${key === today ? 'yesterday' : 'previous day'}</button>` : ''}
        </div>
      </section>`;
  }
  if (t.fib && !G.fib) html += `<p class="muted small" style="text-align:center">Fiber ${gr(t.fib)} g</p>`;

  const view = $('#view');
  view.innerHTML = html;
  $('#open-trends', view).onclick = () => { tab = 'trends'; render(); window.scrollTo(0, 0); };
  $$('[data-add]', view).forEach((b) => (b.onclick = () => openAddSheet(b.dataset.add)));
  $$('[data-entry]', view).forEach((b) => (b.onclick = () => {
    const e = entries.find((x) => x.id === b.dataset.entry);
    openFoodSheet({ food: e, meal: e.meal, entry: e, dateKey: key });
  }));
  $$('[data-copy]', view).forEach((b) => (b.onclick = () => {
    const meal = b.dataset.copy;
    const copies = prev.filter((e) => e.meal === meal).map((e) => ({ ...e, id: uid() }));
    (db.log[key] ||= []).push(...copies);
    save();
    render();
    toast(`Copied ${copies.length} item${copies.length > 1 ? 's' : ''} to ${meal}`, {
      label: 'Undo',
      run: () => {
        const ids = new Set(copies.map((c) => c.id));
        db.log[key] = db.log[key].filter((e) => !ids.has(e.id));
        if (!db.log[key].length) delete db.log[key];
        save();
        render();
      },
    });
  }));
}

// ---------------------------------------------------------------- add food sheet

function foodRow(f, i) {
  const t = totalsOf(f, f.def.qty, f.def.unit);
  const amt = amountText(f.def.qty, f.units[f.def.unit]?.label || '');
  return `
    <button class="row-btn" data-i="${i}">
      <div class="main">
        <div class="title">${esc(f.name)}${isSaved(f.key) ? '<span class="tag">★</span>' : ''}</div>
        <div class="sub">${kc(t.kcal)} kcal · ${esc(amt)}${f.brand ? ' · ' + esc(f.brand) : ''}</div>
      </div>
      <span class="add" data-quick="${i}" role="button" aria-label="Quick add ${esc(f.name)}">+</span>
    </button>`;
}

// With onIngredient, the sheet picks a recipe ingredient instead of logging to a meal.
function openAddSheet(meal, onIngredient) {
  let mode = 'recent';
  let results = [];
  let q = '';
  let seq = 0;

  const sheet = openSheet({
    title: onIngredient ? 'Add ingredient' : `Add to ${meal}`,
    body: `
      <form class="search" id="search-form" autocomplete="off">
        <input type="search" id="q" placeholder="Search foods" enterkeyhint="search" aria-label="Search foods">
      </form>
      <div class="quick-row" ${onIngredient ? 'style="grid-template-columns:repeat(2, 1fr)"' : ''}>
        <button class="btn" id="scan"><span aria-hidden="true">▦</span>Scan</button>
        ${onIngredient ? '' : '<button class="btn" id="quick"><span aria-hidden="true">⚡</span>Quick add</button>'}
        <button class="btn" id="create"><span aria-hidden="true">✚</span>Create food</button>
      </div>
      <div class="seg" id="seg">
        <button data-mode="recent" class="active">Recent</button>
        <button data-mode="mine">My foods</button>
      </div>
      <div id="results" class="list"></div>`,
  });
  const body = sheet.body;
  const input = $('#q', body);
  const out = $('#results', body);

  const pick = (food) => openFoodSheet(onIngredient
    ? { food, ingredient: { onSave: (amt) => { onIngredient(food, amt); sheet.close(); } } }
    : { food, meal, onAdded: sheet.close });

  function show(list, extra = '') {
    results = list;
    out.innerHTML = list.map(foodRow).join('') + extra;
    $$('[data-i]', out).forEach((b) => (b.onclick = (ev) => {
      const f = results[+b.dataset.i];
      if (ev.target.closest('[data-quick]')) {
        if (onIngredient) {
          onIngredient(f, { qty: f.def.qty, unit: f.def.unit });
          toast(`Added ${f.name}`);
        } else {
          const { key, entry } = addEntry(f, { meal, qty: f.def.qty, unit: f.def.unit });
          toast(`Added ${f.name}`, { label: 'Undo', run: () => removeEntrySilently(key, entry.id) });
        }
        b.querySelector('.add').textContent = '✓';
      } else pick(f);
    }));
    $('#branded', out)?.addEventListener('click', runBranded);
  }

  function showTab() {
    $('#seg', body).style.display = '';
    const list = mode === 'recent' ? db.recents : db.myFoods;
    show(list, list.length ? '' : `<div class="empty">${mode === 'recent'
      ? 'Foods you log show up here.<br>Search, scan a barcode, or create a food.'
      : 'Nothing saved yet. Tap ☆ on any food to save it,<br>or create your own.'}</div>`);
  }

  const brandedBtn = (label) => `<div style="padding:14px 16px"><button class="btn block" id="branded">${label}</button></div>`;

  async function runLocal() {
    const my = ++seq;
    q = input.value.trim();
    if (!q) return showTab();
    $('#seg', body).style.display = 'none';
    if (!usdaRows) out.innerHTML = '<div class="empty">Loading food database…</div>';
    const list = await searchLocal(q);
    if (my !== seq) return;
    show(list, (list.length ? '' : '<div class="empty">No matches in the built-in database.</div>') +
      brandedBtn(`Search brands &amp; restaurants for “${esc(q)}”`));
  }

  async function runBranded() {
    const my = ++seq;
    q = input.value.trim();
    if (!q) return;
    input.blur();
    const btn = $('#branded', out);
    if (btn) { btn.disabled = true; btn.textContent = 'Searching USDA branded foods…'; }
    try {
      const list = await searchBranded(q);
      if (my !== seq) return;
      const local = results.filter((f) => f.src !== 'USDA' || f.key.startsWith('usda:'));
      show([...list, ...local], list.length ? '' : '<div class="empty">No branded matches.</div>');
      if (list.length) out.insertAdjacentHTML('afterbegin', '<div class="section-label" style="padding:0 16px">Branded</div>');
    } catch (e) {
      if (my !== seq) return;
      if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
      toast(navigator.onLine ? e.message : 'You are offline.');
    }
  }

  let debounce;
  input.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(runLocal, 150); });
  $('#search-form', body).onsubmit = (e) => { e.preventDefault(); clearTimeout(debounce); runLocal().then(runBranded); };
  $$('#seg button', body).forEach((b) => (b.onclick = () => {
    mode = b.dataset.mode;
    $$('#seg button', body).forEach((x) => x.classList.toggle('active', x === b));
    showTab();
  }));
  $('#scan', body).onclick = () => openScanner(async (code) => {
    toast('Looking up ' + code + '…');
    const food = await lookupBarcode(code);
    if (food) pick(food);
    else openCreateFood({ barcode: code, meal, onSaved: (f) => pick(f), notFound: true });
  });
  $('#quick', body)?.addEventListener('click', () => openQuickAdd(meal, sheet.close));
  $('#create', body).onclick = () => openCreateFood({ meal, onSaved: (f) => { if (mode === 'mine' && !q) showTab(); pick(f); } });

  showTab();
  loadUsda(); // warm the database in the background
}

function removeEntrySilently(dateKey, id) {
  db.log[dateKey] = (db.log[dateKey] || []).filter((e) => e.id !== id);
  if (!db.log[dateKey].length) delete db.log[dateKey];
  save();
  render();
}

// ---------------------------------------------------------------- food detail

// With ingredient: { onSave, onRemove }, the sheet sets a recipe ingredient's amount instead of logging.
function openFoodSheet({ food, meal, entry, dateKey, onAdded, ingredient }) {
  let unit = entry ? entry.unit : food.def?.unit ?? 0;
  let qty = entry ? entry.qty : food.def?.qty ?? 1;
  let selMeal = meal;
  const canSave = !ingredient && food.src !== 'Quick' && food.key;

  const sheet = openSheet({
    title: ingredient ? (entry ? 'Edit ingredient' : 'Add ingredient') : entry ? 'Edit entry' : 'Add food',
    body: `
      <div class="food-title">${esc(food.name)}</div>
      <div class="muted small">${esc([food.brand, food.src].filter(Boolean).join(' · '))}</div>
      <div class="field">
        <span>Amount</span>
        <div class="amount-row">
          <input id="qty" inputmode="decimal" value="${Math.round(qty * 100) / 100}" aria-label="Amount">
          <select id="unit" aria-label="Unit">${food.units.map((u, i) => `<option value="${i}" ${i === unit ? 'selected' : ''}>${esc(u.label)}</option>`).join('')}</select>
        </div>
      </div>
      <div class="nutri" id="nutri"></div>
      <div class="split" id="split" aria-hidden="true"></div>
      ${ingredient ? '' : `
      <div class="field">
        <span>Meal</span>
        <div class="meal-pick">${MEALS.map((m) => `<button data-meal="${m}" class="${m === selMeal ? 'active' : ''}">${m}</button>`).join('')}</div>
      </div>`}
      <div class="btn-row" style="margin-top:20px">
        ${canSave ? `<button class="btn" id="star">${isSaved(food.key) ? '★ Saved' : '☆ Save'}</button>` : ''}
        <button class="btn primary" id="go">${entry ? 'Save' : ingredient ? 'Add to recipe' : 'Add'}</button>
      </div>
      ${entry ? `<button class="btn danger block" id="del" style="margin-top:8px">${ingredient ? 'Remove ingredient' : 'Delete entry'}</button>` : ''}`,
  });
  const b = sheet.body;

  function update() {
    const v = parseQty($('#qty', b).value);
    qty = v;
    const ok = Number.isFinite(v) && v > 0;
    $('#go', b).disabled = !ok;
    const t = ok ? totalsOf(food, v, unit) : { kcal: 0, p: 0, c: 0, f: 0 };
    $('#nutri', b).innerHTML = `
      <div><div class="n">${kc(t.kcal)}</div><div class="l">kcal</div></div>
      ${MACROS.map(([k, name, color]) => `<div style="--c: var(${color})"><div class="n">${gr(t[k])}</div><div class="l"><i></i>${name}</div></div>`).join('')}`;
    const cals = MACROS.map(([k, , , m]) => t[k] * m);
    const tot = cals.reduce((a, x) => a + x, 0);
    $('#split', b).innerHTML = tot ? MACROS.map(([k, name, color], i) =>
      cals[i] ? `<i style="--c: var(${color}); flex:${cals[i]}" title="${name} ${Math.round((cals[i] / tot) * 100)}%"></i>` : '').join('') : '';
  }

  $('#qty', b).addEventListener('input', update);
  $('#qty', b).addEventListener('focus', (e) => e.target.select());
  $('#unit', b).onchange = (e) => {
    // Keep the same weight when switching units, rounded sensibly.
    const next = +e.target.value;
    const grams = qty * food.units[unit].mult;
    unit = next;
    const q = grams / food.units[unit].mult;
    const nice = q >= 10 ? Math.round(q) : Math.round(q * 4) / 4 || Math.round(q * 100) / 100;
    if (Number.isFinite(q)) $('#qty', b).value = nice;
    update();
  };
  $$('[data-meal]', b).forEach((x) => (x.onclick = () => {
    selMeal = x.dataset.meal;
    $$('[data-meal]', b).forEach((y) => y.classList.toggle('active', y === x));
  }));
  $('#star', b)?.addEventListener('click', (e) => {
    toggleSaved({ ...food, def: { unit, qty }, id: undefined, meal: undefined, qty: undefined, unit: undefined });
    e.target.textContent = isSaved(food.key) ? '★ Saved' : '☆ Save';
    if (tab === 'foods') render();
  });
  $('#go', b).onclick = () => {
    if (ingredient) {
      sheet.close();
      ingredient.onSave({ qty, unit });
    } else if (entry) {
      Object.assign(entry, { qty, unit, meal: selMeal });
      save();
      render();
      sheet.close();
    } else {
      addEntry(food, { meal: selMeal, qty, unit });
      toast(`Added to ${selMeal}`);
      sheet.close();
      onAdded?.();
    }
  };
  $('#del', b)?.addEventListener('click', () => {
    sheet.close();
    if (ingredient) ingredient.onRemove();
    else removeEntry(dateKey, entry.id);
  });
  update();
}

// ---------------------------------------------------------------- quick add

function openQuickAdd(meal, onDone) {
  let selMeal = meal;
  const sheet = openSheet({
    title: 'Quick add',
    short: true,
    body: `
      <div class="field"><span>Label (optional)</span><input id="qa-name" placeholder="Quick add"></div>
      <div class="grid4">
        <label class="field"><span>kcal</span><input id="qa-kcal" inputmode="decimal" placeholder="auto"></label>
        ${MACROS.map(([k, name]) => `<label class="field"><span>${name} g</span><input id="qa-${k}" inputmode="decimal" placeholder="0"></label>`).join('')}
      </div>
      <p class="muted small">Leave calories blank to calculate them from the macros.</p>
      <div class="field"><span>Meal</span><div class="meal-pick">${MEALS.map((m) => `<button data-meal="${m}" class="${m === selMeal ? 'active' : ''}">${m}</button>`).join('')}</div></div>
      <button class="btn primary block" id="qa-go" style="margin-top:12px">Add</button>`,
  });
  const b = sheet.body;
  $$('[data-meal]', b).forEach((x) => (x.onclick = () => {
    selMeal = x.dataset.meal;
    $$('[data-meal]', b).forEach((y) => y.classList.toggle('active', y === x));
  }));
  $('#qa-go', b).onclick = () => {
    const num = (id) => { const v = parseQty($(id, b).value); return Number.isFinite(v) && v > 0 ? v : 0; };
    const n = { p: num('#qa-p'), c: num('#qa-c'), f: num('#qa-f'), fib: 0 };
    n.kcal = num('#qa-kcal') || n.p * 4 + n.c * 4 + n.f * 9;
    if (!n.kcal) return toast('Enter calories or macros.');
    addEntry({ name: $('#qa-name', b).value.trim() || 'Quick add', src: 'Quick', n, units: [{ label: '1 serving', mult: 1 }] }, { meal: selMeal, qty: 1, unit: 0 });
    toast(`Added to ${selMeal}`);
    sheet.close();
    onDone?.();
  };
}

// ---------------------------------------------------------------- create / edit food

function openCreateFood({ food, barcode, onSaved, notFound } = {}) {
  const s = food?.serving || {};
  const per = food?.n || {};
  const sheet = openSheet({
    title: food ? 'Edit food' : 'Create food',
    body: `
      ${notFound ? `<div class="hint">No match for barcode <b>${esc(barcode)}</b>. Enter it from the label once and it will be found next time you scan.</div>` : ''}
      <label class="field"><span>Name</span><input id="cf-name" value="${esc(food?.name)}" placeholder="e.g. Protein bar"></label>
      <label class="field"><span>Brand (optional)</span><input id="cf-brand" value="${esc(food?.brand)}"></label>
      <div class="grid2">
        <label class="field"><span>Serving size</span><input id="cf-serving" value="${esc(s.label || '1 serving')}"></label>
        <label class="field"><span>Serving weight g (optional)</span><input id="cf-grams" inputmode="decimal" value="${s.grams || ''}"></label>
      </div>
      <div class="section-label">Per serving</div>
      <div class="grid4">
        ${MACROS.map(([k, name]) => `<label class="field"><span>${name} g</span><input id="cf-${k}" inputmode="decimal" value="${per[k] ?? ''}"></label>`).join('')}
        <label class="field"><span>kcal</span><input id="cf-kcal" inputmode="decimal" value="${per.kcal ?? ''}" placeholder="auto"></label>
      </div>
      <p class="muted small" style="margin:0">Calories fill in from the macros. Type over them if the label says something different.</p>
      <label class="field" style="max-width:25%"><span>Fiber g</span><input id="cf-fib" inputmode="decimal" value="${per.fib || ''}"></label>
      <label class="field"><span>Barcode (optional)</span><input id="cf-barcode" inputmode="numeric" value="${esc(food?.barcode || barcode || '')}"></label>
      <button class="btn primary block" id="cf-go" style="margin-top:12px">${food ? 'Save changes' : 'Save food'}</button>
      ${food ? '<button class="btn danger block" id="cf-del" style="margin-top:8px">Delete food</button>' : ''}`,
  });
  const b = sheet.body;
  const num = (id) => { const v = parseQty($(id, b).value); return Number.isFinite(v) && v >= 0 ? v : 0; };
  const kcalFromMacros = () => Math.round(MACROS.reduce((a, [k, , , m]) => a + num(`#cf-${k}`) * m, 0));
  for (const [k] of MACROS) $(`#cf-${k}`, b).addEventListener('input', () => { $('#cf-kcal', b).value = kcalFromMacros() || ''; });
  $('#cf-go', b).onclick = () => {
    const name = $('#cf-name', b).value.trim();
    if (!name) return toast('Give the food a name.');
    const n = { kcal: num('#cf-kcal'), p: num('#cf-p'), c: num('#cf-c'), f: num('#cf-f'), fib: num('#cf-fib') };
    if (!$('#cf-kcal', b).value.trim()) n.kcal = kcalFromMacros();
    const label = $('#cf-serving', b).value.trim() || '1 serving';
    const grams = num('#cf-grams');
    const units = [{ label: /^\d/.test(label) ? label : `1 ${label}`, mult: 1 }];
    if (grams) units.push({ label: 'g', mult: 1 / grams }, { label: 'oz', mult: 28.3495 / grams });
    const next = {
      key: food?.key || 'my:' + uid(), name, brand: $('#cf-brand', b).value.trim(), src: 'My food', custom: true,
      n, units, def: { unit: 0, qty: 1 }, serving: { label, grams: grams || undefined },
      barcode: $('#cf-barcode', b).value.trim() || undefined,
    };
    putMyFood(next);
    sheet.close();
    render();
    toast(food ? 'Food updated' : 'Food saved to My foods');
    onSaved?.(next);
  };
  $('#cf-del', b)?.addEventListener('click', () => {
    if (!confirm(`Delete “${food.name}” from My foods? Past diary entries are kept.`)) return;
    deleteMyFood(food.key);
    sheet.close();
    render();
  });
}

// ---------------------------------------------------------------- recipes

// A recipe is a custom food built from ingredients. Its nutrients are for the whole batch, so it
// can be logged by the piece ("1 egg cup") and, when the batch weight is known, by the gram.

// Weight in grams of an ingredient, or null if the food has no gram unit.
function gramsOf(item) {
  const g = item.units.find((u) => u.label === 'g');
  return g ? (item.qty * (item.units[item.unit]?.mult ?? 1)) / g.mult : null;
}

function batchGrams(items) {
  let sum = 0;
  for (const it of items) {
    const g = gramsOf(it);
    if (g == null) return null;
    sum += g;
  }
  return sum || null;
}

function recipeFood({ key, name, items, servings, servingName, grams }) {
  const weight = grams || batchGrams(items);
  const each = servingName || 'serving';
  const units = [];
  if (servings) units.push({ label: /^\d/.test(each) ? each : `1 ${each}`, mult: 1 / servings });
  if (weight) units.push({ label: 'g', mult: 1 / weight }, { label: 'oz', mult: 28.3495 / weight });
  units.push({ label: '1 batch', mult: 1 });
  return {
    key: key || 'my:' + uid(), name, brand: '', src: 'Recipe', custom: true,
    n: sumAll(items), units, def: { unit: 0, qty: !servings && weight ? 100 : 1 },
    recipe: { items, servings: servings || undefined, servingName, grams: grams || undefined },
  };
}

function openRecipe({ food } = {}) {
  const r = food?.recipe || {};
  const items = (r.items || []).map((it) => ({ ...it }));
  const sheet = openSheet({
    title: food ? 'Edit recipe' : 'Create recipe',
    body: `
      <label class="field"><span>Name</span><input id="rc-name" value="${esc(food?.name)}" placeholder="e.g. Chicken soup"></label>
      <div class="section-label">Ingredients</div>
      <div class="list" id="rc-items"></div>
      <button class="btn block" id="rc-add" style="margin-top:12px">✚ Add ingredient</button>
      <div class="section-label">Batch size</div>
      <div class="grid2">
        <label class="field"><span>Makes (optional)</span><input id="rc-servings" inputmode="decimal" value="${r.servings || ''}" placeholder="e.g. 12"></label>
        <label class="field"><span>Each one is called</span><input id="rc-serving" value="${esc(r.servingName)}" placeholder="e.g. egg cup" autocapitalize="off"></label>
      </div>
      <label class="field"><span>Cooked weight g (optional)</span><input id="rc-grams" inputmode="decimal" value="${r.grams || ''}"><small class="muted" id="rc-grams-hint"></small></label>
      <div class="hint" id="rc-summary"></div>
      <button class="btn primary block" id="rc-go" style="margin-top:12px">${food ? 'Save changes' : 'Save recipe'}</button>
      ${food ? '<button class="btn danger block" id="rc-del" style="margin-top:8px">Delete recipe</button>' : ''}`,
  });
  const b = sheet.body;

  const read = () => {
    const num = (id) => { const v = parseQty($(id, b).value); return Number.isFinite(v) && v > 0 ? v : 0; };
    return recipeFood({
      key: food?.key, name: $('#rc-name', b).value.trim(), items,
      servings: num('#rc-servings'), servingName: $('#rc-serving', b).value.trim(), grams: num('#rc-grams'),
    });
  };

  function summary() {
    const f = read();
    const sum = batchGrams(items);
    $('#rc-grams', b).placeholder = sum ? Math.round(sum) : '';
    $('#rc-grams-hint', b).textContent = sum
      ? `Leave blank to use the ingredients' total (${kc(sum)} g). Weigh the finished batch if water was added or cooked off.`
      : items.length
        ? 'Some ingredients have no gram weight. Enter the weight of the finished batch to log it by the gram.'
        : 'Weigh the finished batch if water was added or cooked off.';
    const line = (label, t) => `<div><b>${esc(label)}</b> · ${kc(t.kcal)} kcal · ${pcf(t)}</div>`;
    const gi = f.units.findIndex((u) => u.label === 'g');
    $('#rc-summary', b).innerHTML = line('Whole batch', f.n) +
      (f.recipe.servings ? line(f.units[0].label, totalsOf(f, 1, 0)) : '') +
      (gi >= 0 ? line('100 g', totalsOf(f, 100, gi)) : '');
  }

  function refresh() {
    const out = $('#rc-items', b);
    out.innerHTML = items.length ? items.map((it, i) => {
      const t = totalsOf(it);
      return `
        <button class="entry" data-i="${i}">
          <div class="main">
            <div class="title">${esc(it.name)}</div>
            <div class="sub">${esc(amountText(it.qty, it.units[it.unit]?.label || ''))}${it.brand ? ' · ' + esc(it.brand) : ''}</div>
          </div>
          <div style="text-align:right"><div class="kcal">${kc(t.kcal)}</div>${pcf(t)}</div>
        </button>`;
    }).join('') : '<div class="empty">Add everything that goes into the batch.</div>';
    $$('[data-i]', out).forEach((x) => (x.onclick = () => {
      const i = +x.dataset.i;
      openFoodSheet({
        food: items[i], entry: items[i],
        ingredient: {
          onSave: (amt) => { Object.assign(items[i], amt); refresh(); },
          onRemove: () => { items.splice(i, 1); refresh(); },
        },
      });
    }));
    summary();
  }

  $('#rc-add', b).onclick = () => openAddSheet(null, (f, amt) => {
    items.push({ name: f.name, brand: f.brand || '', src: f.src, key: f.key, n: f.n, units: f.units, ...amt });
    refresh();
  });
  for (const id of ['#rc-servings', '#rc-serving', '#rc-grams']) $(id, b).addEventListener('input', summary);
  $('#rc-go', b).onclick = () => {
    const next = read();
    if (!next.name) return toast('Give the recipe a name.');
    if (!items.length) return toast('Add at least one ingredient.');
    putMyFood(next);
    sheet.close();
    render();
    toast(food ? 'Recipe updated' : 'Recipe saved to My foods');
  };
  $('#rc-del', b)?.addEventListener('click', () => {
    if (!confirm(`Delete “${food.name}” from My foods? Past diary entries are kept.`)) return;
    deleteMyFood(food.key);
    sheet.close();
    render();
  });
  refresh();
}

// ---------------------------------------------------------------- barcode scanner

function openScanner(onCode) {
  let stream, reader, stopped = false, timer;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    try { reader?.reset(); } catch { /* already stopped */ }
    stream?.getTracks().forEach((t) => t.stop());
  };
  const sheet = openSheet({
    title: 'Scan barcode',
    onClose: stop,
    body: `
      <div class="scanner"><video playsinline muted autoplay></video><div class="reticle"></div></div>
      <p class="muted small" id="scan-status">Starting camera…</p>
      <form class="field" id="manual">
        <span>Or type the barcode number</span>
        <div class="search"><input inputmode="numeric" id="manual-code" placeholder="e.g. 012345678905" aria-label="Barcode number"><button class="btn primary">Look up</button></div>
      </form>`,
  });
  const b = sheet.body;
  const video = $('video', b);
  const status = $('#scan-status', b);
  const done = (code) => {
    if (stopped) return;
    navigator.vibrate?.(60);
    sheet.close();
    onCode(code);
  };
  $('#manual', b).onsubmit = (e) => {
    e.preventDefault();
    const code = $('#manual-code', b).value.replace(/\D/g, '');
    if (code.length >= 6) done(code);
  };

  (async () => {
    try {
      const native = 'BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('ean_13');
      if (native) {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) return stop();
        video.srcObject = stream;
        await video.play();
        const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
        status.textContent = 'Point the camera at a barcode.';
        const tick = async () => {
          if (stopped) return;
          try {
            const [hit] = await det.detect(video);
            if (hit) return done(hit.rawValue);
          } catch { /* frame not ready */ }
          timer = setTimeout(tick, 120);
        };
        tick();
      } else {
        await loadScript('vendor/zxing.min.js');
        if (stopped) return;
        const Z = window.ZXing;
        const hints = new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]]]);
        reader = new Z.BrowserMultiFormatReader(hints, 150);
        await reader.decodeFromConstraints({ video: { facingMode: 'environment' }, audio: false }, video, (res) => { if (res) done(res.getText()); });
        if (stopped) return stop();
        stream = video.srcObject;
        status.textContent = 'Point the camera at a barcode.';
      }
    } catch (e) {
      status.textContent = e?.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow it in your browser settings, or type the number below.'
        : 'Camera unavailable. Type the barcode number below.';
    }
  })();
}

// ---------------------------------------------------------------- my foods

function renderFoods() {
  const view = $('#view');
  view.innerHTML = `
    <div class="btn-row" style="margin-top:12px">
      <button class="btn primary" id="new-food">✚ Create food</button>
      <button class="btn primary" id="new-recipe">✚ Create recipe</button>
    </div>
    <button class="btn block" id="import-food" style="margin-top:8px">Import a shared food</button>
    <section class="card" style="margin-top:12px">
      ${db.myFoods.length ? db.myFoods.map((f, i) => {
        const t = totalsOf(f, f.def.qty, f.def.unit);
        return `
          <button class="row-btn" data-i="${i}">
            <div class="main">
              <div class="title">${esc(f.name)}${f.recipe ? '<span class="tag">Recipe</span>' : ''}</div>
              <div class="sub">${kc(t.kcal)} kcal · ${esc(amountText(f.def.qty, f.units[f.def.unit]?.label || ''))}${f.brand ? ' · ' + esc(f.brand) : ''}</div>
              ${pcf(t)}
            </div>
            <span class="muted small">${f.custom ? 'Edit' : 'Log'}</span>
            <span class="add" data-share role="button" aria-label="Share ${esc(f.name)}">${SHARE_ICON}</span>
          </button>`;
      }).join('') : '<div class="empty">Save foods you eat often with ☆, create your own from a nutrition label, or build a recipe from its ingredients.</div>'}
    </section>`;
  $('#new-food', view).onclick = () => openCreateFood({});
  $('#new-recipe', view).onclick = () => openRecipe();
  $('#import-food', view).onclick = openImport;
  $$('[data-i]', view).forEach((b) => (b.onclick = (ev) => {
    const f = db.myFoods[+b.dataset.i];
    if (ev.target.closest('[data-share]')) openShare(f);
    else if (f.custom) openFoodActions(f);
    else { viewDate = noon(); openFoodSheet({ food: f, meal: defaultMeal() }); }
  }));
}

function openFoodActions(f) {
  const sheet = openSheet({
    title: f.name,
    short: true,
    body: `
      <div class="btn-row" style="flex-direction:column">
        <button class="btn primary" id="fa-log">Log it today</button>
        <button class="btn" id="fa-edit">${f.recipe ? 'Edit recipe' : 'Edit food'}</button>
      </div>`,
  });
  $('#fa-log', sheet.body).onclick = () => { sheet.close(); viewDate = noon(); openFoodSheet({ food: f, meal: defaultMeal() }); };
  $('#fa-edit', sheet.body).onclick = () => { sheet.close(); (f.recipe ? openRecipe : openCreateFood)({ food: f }); };
}

// ---------------------------------------------------------------- sharing

// A shared food travels inside a link: #food=<version digit><base64url JSON>, deflated when version is 1.
// Nothing is uploaded; whoever opens or pastes the link gets their own copy.

const SHARE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/></svg>';

// Trim a food to what the other person needs, to keep the link short.
function packFood(f) {
  const sig = (x) => +(+x || 0).toPrecision(6);
  const nutrients = (n) => Object.fromEntries(NUTRIENTS.map((k) => [k, sig(n[k])]));
  const unit = (u) => ({ label: u.label, mult: sig(u.mult) });
  const o = {
    key: f.key, name: f.name, brand: f.brand || undefined, src: f.src, custom: f.custom,
    n: nutrients(f.n), units: f.units.map(unit), def: f.def, serving: f.serving, barcode: f.barcode,
  };
  if (f.recipe) {
    o.recipe = {
      ...f.recipe,
      items: f.recipe.items.map((it) => {
        const keep = it.units.filter((u, i) => i === it.unit || u.label === 'g');
        return {
          name: it.name, brand: it.brand || undefined, n: nutrients(it.n),
          units: keep.map(unit), unit: keep.indexOf(it.units[it.unit]), qty: it.qty,
        };
      }),
    };
  }
  return o;
}

// Rebuild a food from untrusted shared data, keeping only well-formed fields. Throws if it is not a food.
function cleanFood(x) {
  const str = (s, max = 120) => String(s ?? '').slice(0, max);
  const pos = (v) => (Number.isFinite(+v) && +v >= 0 ? +v : 0);
  const nutrients = (n) => Object.fromEntries(NUTRIENTS.map((k) => [k, pos(n?.[k])]));
  const units = (list) => {
    if (!Array.isArray(list) || !list.length || list.length > 40) throw new Error('units');
    return list.map((u) => {
      const label = str(u?.label, 80), mult = +u?.mult;
      if (!label || !(mult > 0) || !Number.isFinite(mult)) throw new Error('unit');
      return { label, mult };
    });
  };
  const amount = (us, unit, qty) => ({ unit: Number.isInteger(unit) && us[unit] ? unit : 0, qty: pos(qty) || 1 });

  const name = str(x?.name).trim();
  if (!name) throw new Error('name');
  const us = units(x.units);
  const food = {
    key: typeof x.key === 'string' && /^[\w:.-]{1,80}$/.test(x.key) ? x.key : 'my:' + uid(),
    name, brand: str(x.brand), src: str(x.src, 40) || 'Shared',
    n: nutrients(x.n), units: us, def: amount(us, x.def?.unit, x.def?.qty),
  };
  if (x.custom || x.recipe) food.custom = true;
  if (x.barcode) food.barcode = str(x.barcode, 40);
  if (x.serving) food.serving = { label: str(x.serving.label, 80), grams: pos(x.serving.grams) || undefined };
  if (x.recipe) {
    if (!Array.isArray(x.recipe.items) || x.recipe.items.length > 100) throw new Error('items');
    food.recipe = {
      items: x.recipe.items.map((it) => {
        const iu = units(it?.units);
        return { name: str(it.name), brand: str(it.brand), n: nutrients(it.n), units: iu, ...amount(iu, it.unit, it.qty) };
      }),
      servings: pos(x.recipe.servings) || undefined,
      servingName: str(x.recipe.servingName, 80),
      grams: pos(x.recipe.grams) || undefined,
    };
  }
  return food;
}

const b64url = {
  enc: (bytes) => btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};
const pipeBytes = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

async function shareLink(food) {
  const raw = new TextEncoder().encode(JSON.stringify(packFood(food)));
  const code = typeof CompressionStream === 'undefined'
    ? '0' + b64url.enc(raw)
    : '1' + b64url.enc(await pipeBytes(raw, new CompressionStream('deflate-raw')));
  return `${new URL('./', location.href).href}#food=${code}`;
}

// Accepts a share link, a message containing one, or the bare code.
async function readShared(text) {
  text = String(text).trim();
  const code = (text.match(/food=([\w-]+)/) || text.match(/^([\w-]+)$/))?.[1];
  if (!code || code.length > 40000) throw new Error('code');
  let bytes = b64url.dec(code.slice(1));
  if (code[0] === '1') bytes = await pipeBytes(bytes, new DecompressionStream('deflate-raw'));
  else if (code[0] !== '0') throw new Error('version');
  return cleanFood(JSON.parse(new TextDecoder().decode(bytes)));
}

function openShare(f) {
  const kind = f.recipe ? 'recipe' : 'food';
  let url;
  const sheet = openSheet({
    title: `Share ${kind}`,
    short: true,
    body: `
      <div class="food-title">${esc(f.name)}</div>
      <p class="muted small" style="margin:4px 0 0">Sends a copy of this ${kind} as a link. If it opens in their browser instead of their installed app, they can copy the link and paste it under My foods → Import a shared food.</p>
      <label class="field"><span>Link</span><input id="sh-link" readonly placeholder="Making link…"></label>
      <div class="btn-row">
        ${navigator.share ? '<button class="btn primary" id="sh-share" disabled>Share link</button>' : ''}
        <button class="btn ${navigator.share ? '' : 'primary'}" id="sh-copy" disabled>Copy link</button>
      </div>`,
  });
  const b = sheet.body;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
      sheet.close();
    } catch {
      $('#sh-link', b).select();
      toast('Copy the link from the box.');
    }
  };
  $('#sh-link', b).addEventListener('focus', (e) => e.target.select());
  $('#sh-copy', b).onclick = copy;
  $('#sh-share', b)?.addEventListener('click', async () => {
    try {
      await navigator.share({ title: f.name, text: `${f.name} (Macros ${kind})`, url });
      sheet.close();
    } catch (e) {
      if (e.name !== 'AbortError') copy();
    }
  });
  shareLink(f).then((link) => {
    url = link;
    $('#sh-link', b).value = link;
    $$('.btn', b).forEach((x) => (x.disabled = false));
  });
}

function openImport() {
  const sheet = openSheet({
    title: 'Import a shared food',
    short: true,
    body: `
      <form class="field" id="im-form">
        <span>Paste the link someone sent you</span>
        <div class="search"><input id="im-text" placeholder="https://…#food=…" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Share link"><button class="btn primary">Import</button></div>
      </form>`,
  });
  $('#im-form', sheet.body).onsubmit = async (e) => {
    e.preventDefault();
    if (await openShared($('#im-text', sheet.body).value)) sheet.close();
  };
}

// Preview a shared food and offer to add it. Resolves false if the text is not a valid share.
async function openShared(text) {
  let f;
  try {
    f = await readShared(text);
  } catch {
    toast('That is not a Macros share link.');
    return false;
  }
  const kind = f.recipe ? 'recipe' : 'food';
  const mine = db.myFoods.find((x) => x.key === f.key);
  const t = totalsOf(f, f.def.qty, f.def.unit);
  const sheet = openSheet({
    title: `Shared ${kind}`,
    short: true,
    body: `
      <div class="food-title">${esc(f.name)}</div>
      <div class="muted small">${kc(t.kcal)} kcal · ${esc(amountText(f.def.qty, f.units[f.def.unit].label))}${f.brand ? ' · ' + esc(f.brand) : ''} · ${pcf(t)}</div>
      ${f.recipe ? `<p class="muted small" style="margin:8px 0 0">${esc(f.recipe.items.map((it) => it.name).join(' · '))}</p>` : ''}
      ${mine ? `<div class="hint">You already have ${mine.name === f.name ? `this ${kind}` : `this ${kind} as “${esc(mine.name)}”`}. Adding it replaces your copy.</div>` : ''}
      <button class="btn primary block" id="sf-go" style="margin-top:16px">${mine ? 'Replace my copy' : 'Add to My foods'}</button>`,
  });
  $('#sf-go', sheet.body).onclick = () => {
    putMyFood(f);
    sheet.close();
    tab = 'foods';
    render();
    toast(`${f.name} added to My foods`);
  };
  return true;
}

// Opening a share link lands here, on launch or while the app is already open.
function checkSharedLink() {
  const hash = location.hash;
  if (!/food=/.test(hash)) return;
  history.replaceState(null, '', location.pathname + location.search);
  openShared(hash);
}
window.addEventListener('hashchange', checkSharedLink);

// ---------------------------------------------------------------- trends

let trendRange = 7;
let trendSel = null;

function renderTrends() {
  const end = noon();
  const days = Array.from({ length: trendRange }, (_, i) => {
    const d = addDays(end, i - trendRange + 1);
    const k = dkey(d);
    const entries = db.log[k] || [];
    return { d, k, logged: entries.length > 0, t: sumAll(entries) };
  });
  const G = db.goals;
  const max = Math.max(G.kcal, ...days.map((x) => x.t.kcal)) * 1.1;
  const logged = days.filter((x) => x.logged);
  const avg = { kcal: 0, p: 0, c: 0, f: 0, fib: 0 };
  for (const x of logged) for (const k in avg) avg[k] += x.t[k] / logged.length;

  const label = (x, i) => trendRange === 7
    ? x.d.toLocaleDateString(undefined, { weekday: 'narrow' })
    : (i % 5 === 4 || i === trendRange - 1 ? x.d.getDate() : '');

  const view = $('#view');
  view.innerHTML = `
    <div class="seg" style="margin-top:12px">
      <button data-range="7" class="${trendRange === 7 ? 'active' : ''}">7 days</button>
      <button data-range="30" class="${trendRange === 30 ? 'active' : ''}">30 days</button>
    </div>
    <section class="card card-pad">
      <h2>Calories</h2>
      <div class="chart" role="group" aria-label="Calories per day">
        <div class="goal-line" style="bottom:${(G.kcal / max) * 100}%"><span>Goal ${kc(G.kcal)}</span></div>
        ${days.map((x, i) => `
          <button class="col ${x.logged ? '' : 'none'} ${trendSel === x.k ? 'sel' : ''}" data-k="${x.k}"
            aria-label="${x.d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}: ${x.logged ? kc(x.t.kcal) + ' kcal' : 'nothing logged'}">
            <div class="bar" style="height:${(x.t.kcal / max) * 100}%"></div>
          </button>`).join('')}
      </div>
      <div class="axis" aria-hidden="true">${days.map((x, i) => `<span>${label(x, i)}</span>`).join('')}</div>
      <div class="tip" id="tip" style="margin-top:10px"></div>
    </section>
    <section class="card card-pad">
      <h2>Daily average</h2>
      <p class="muted small" style="margin:4px 0 8px">${logged.length} of ${trendRange} days logged${logged.length ? '. Days with nothing logged are left out.' : ''}</p>
      ${logged.length ? `
      <table class="avg">
        <thead><tr><th></th><th>Average</th><th>Goal</th><th>Difference</th></tr></thead>
        <tbody>
          <tr><td>Calories</td><td>${kc(avg.kcal)}</td><td>${kc(G.kcal)}</td><td>${diff(avg.kcal - G.kcal, '')}</td></tr>
          ${MACROS.map(([k, name, color]) => `<tr><td><span class="swatch" style="--c: var(${color})"></span>${name}</td><td>${gr(avg[k])} g</td><td>${gr(G[k])} g</td><td>${diff(avg[k] - G[k], ' g')}</td></tr>`).join('')}
          ${G.fib ? `<tr><td><span class="swatch" style="--c: var(--fiber)"></span>Fiber</td><td>${gr(avg.fib)} g</td><td>${gr(G.fib)} g</td><td>${avg.fib >= G.fib ? '<span class="muted">✓ met</span>' : `▼ ${gr(G.fib - avg.fib)} g under`}</td></tr>` : ''}
        </tbody>
      </table>` : ''}
    </section>`;

  function showTip(k) {
    const x = days.find((y) => y.k === k);
    const tip = $('#tip', view);
    if (!x) { tip.innerHTML = '<span class="muted">Tap a bar to see that day.</span>'; return; }
    const date = x.d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    tip.innerHTML = x.logged
      ? `<b>${date}</b> · ${kc(x.t.kcal)} kcal<br>${pcf(x.t)} <button class="btn" style="padding:4px 10px;margin-left:6px;font-size:13px" id="open-day">Open day</button>`
      : `<b>${date}</b> · <span class="muted">nothing logged</span>`;
    $('#open-day', tip)?.addEventListener('click', () => { viewDate = noon(x.d); tab = 'diary'; render(); });
  }
  $$('.col', view).forEach((c) => (c.onclick = () => {
    trendSel = c.dataset.k;
    $$('.col', view).forEach((y) => y.classList.toggle('sel', y === c));
    showTip(trendSel);
  }));
  $$('[data-range]', view).forEach((b) => (b.onclick = () => { trendRange = +b.dataset.range; trendSel = null; render(); }));
  showTip(trendSel);
}

function diff(v, unit) {
  const r = unit ? gr(Math.abs(v)) : kc(Math.abs(v));
  if (r === '0') return '<span class="muted">on target</span>';
  return v > 0 ? `▲ ${r}${unit} over` : `▼ ${r}${unit} under`;
}

// ---------------------------------------------------------------- settings

function renderSettings() {
  const G = { ...db.goals };
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const view = $('#view');
  view.innerHTML = `
    ${standalone ? '' : `<div class="hint"><b>Install:</b> on iPhone, tap Share → <b>Add to Home Screen</b>. On Android, open the ⋮ menu → <b>Add to Home screen</b>.</div>`}
    <section class="card card-pad">
      <h2>Daily goals</h2>
      <p class="muted small" style="margin:6px 0 0">Enter your macros in grams. Calories are worked out from them: 4 per gram of protein or carbs, 9 per gram of fat.</p>
      <div class="grid3">
        ${MACROS.map(([k, name, color]) => `
          <label class="field"><span><span class="swatch" style="--c: var(${color})"></span>${name} (g)</span><input id="g-${k}" inputmode="decimal" value="${G[k]}"><small class="muted" id="g-${k}-pct"></small></label>`).join('')}
      </div>
      <div class="goal-total"><span>Daily calories</span><b id="g-kcal"></b></div>
      <div class="split" id="g-split"></div>
      <label class="field"><span><span class="swatch" style="--c: var(--fiber)"></span>Fiber (g) <span class="muted">· optional</span></span><input id="g-fib" inputmode="decimal" value="${G.fib || ''}" placeholder="No fiber goal"><small class="muted">A minimum to reach. It doesn't change your calories, since fiber is already part of carbs.</small></label>
      <button class="btn primary block" id="g-save">Save goals</button>
    </section>

    <section class="card card-pad" id="weight-card"></section>

    <section class="card card-pad">
      <h2>Workouts</h2>
      <div class="field" style="margin-bottom:0"><span>Units for lifts</span><div class="seg" style="margin:0">
        <button data-lunit="lb" class="${db.liftUnit === 'lb' ? 'active' : ''}">lb</button>
        <button data-lunit="kg" class="${db.liftUnit === 'kg' ? 'active' : ''}">kg</button>
      </div></div>
    </section>

    <section class="card card-pad">
      <h2>Food search</h2>
      <p class="muted small" style="margin:6px 0 0">About 7,800 common foods are built in and work offline. Brand-name and barcode searches use USDA FoodData Central and Open Food Facts. A <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener">free USDA API key</a> raises the brand-search limit from a few per hour to 1,000.</p>
      <label class="field"><span>USDA API key</span><input id="usda-key" value="${esc(db.usdaKey)}" placeholder="Using shared DEMO_KEY" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
    </section>

    <section class="card card-pad">
      <h2>Your data</h2>
      <p class="muted small" style="margin:6px 0 12px">Everything is stored only on this device, in this browser. Export a backup now and then. If you clear Safari or Chrome website data, your log is erased.</p>
      <div class="btn-row">
        <button class="btn" id="export">Export backup</button>
        <button class="btn" id="import">Import backup</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
      <p class="muted small" style="margin:12px 0 0">${Object.keys(db.log).length} days logged · ${db.myFoods.length} saved foods · ${db.workouts.length} workouts</p>
    </section>`;

  const inp = (id) => $(id, view);
  const read = (id) => { const v = parseQty(inp(id).value); return Number.isFinite(v) && v >= 0 ? v : 0; };

  const kcalFromMacros = () => Math.round(MACROS.reduce((a, [k, , , m]) => a + read(`#g-${k}`) * m, 0));
  function update() {
    const kcal = kcalFromMacros();
    inp('#g-kcal').textContent = `${kc(kcal)} kcal`;
    inp('#g-split').innerHTML = MACROS.map(([k, , color, m]) => `<i style="--c: var(${color}); flex: ${read(`#g-${k}`) * m}"></i>`).join('');
    for (const [k, , , m] of MACROS) inp(`#g-${k}-pct`).textContent = kcal ? `${Math.round((read(`#g-${k}`) * m / kcal) * 100)}% of calories` : '';
  }
  for (const [k] of MACROS) inp(`#g-${k}`).addEventListener('input', update);
  update();
  inp('#g-save').onclick = () => {
    const kcal = kcalFromMacros();
    if (!kcal) return toast('Enter your macro goals.');
    db.goals = { kcal, p: read('#g-p'), c: read('#g-c'), f: read('#g-f'), fib: read('#g-fib') };
    save();
    toast('Goals saved');
  };
  renderWeight(inp('#weight-card'));
  $$('[data-lunit]', view).forEach((b) => (b.onclick = () => {
    db.liftUnit = b.dataset.lunit;
    save();
    $$('[data-lunit]', view).forEach((x) => x.classList.toggle('active', x === b));
  }));
  inp('#usda-key').addEventListener('change', (e) => { db.usdaKey = e.target.value.trim(); save(); toast('API key saved'); });

  inp('#export').onclick = async () => {
    const name = `macros-backup-${dkey(new Date())}.json`;
    const file = new File([JSON.stringify(db)], name, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], title: name });
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  inp('#import').onclick = () => inp('#import-file').click();
  inp('#import-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || typeof data.log !== 'object') throw new Error();
      if (!confirm('Replace everything on this device with this backup?')) return;
      db = Object.assign(defaults(), data);
      save();
      render();
      toast('Backup restored');
    } catch {
      toast('That file is not a Macros backup.');
    }
  };
}

// ---------------------------------------------------------------- weight

// Weights are stored in kg and shown in the chosen unit.
const LB = 0.45359237;
const toUnit = (kg) => (db.weightUnit === 'lb' ? kg / LB : kg);
const fromUnit = (v) => (db.weightUnit === 'lb' ? v * LB : v);
const wt = (kg) => (Math.round(toUnit(kg) * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1 });
const SVG_NS = 'http://www.w3.org/2000/svg';

let weightRange = 90;
let weightSel = null;

function renderWeight(card) {
  const u = db.weightUnit;
  const all = Object.entries(db.weights).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, kg]) => ({ k, kg, d: noon(new Date(k + 'T12:00')) }));
  const start = weightRange ? dkey(addDays(new Date(), -weightRange + 1)) : '';
  const pts = all.filter((x) => x.k >= start);
  const latest = all[all.length - 1];
  const goal = db.goalWeight;

  let summary = '';
  if (latest) {
    const first = pts[0];
    const change = pts.length > 1 ? latest.kg - first.kg : null;
    const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');
    summary = `
      <div class="weight-stats">
        <div><span>Latest</span><b>${wt(latest.kg)} ${u}</b></div>
        ${change != null ? `<div><span>Change</span><b>${sign(change)}${wt(Math.abs(change))} ${u}</b></div>` : ''}
        ${goal ? `<div><span>To goal</span><b>${Math.abs(toUnit(latest.kg - goal)) < 0.05 ? 'Reached' : `${wt(Math.abs(latest.kg - goal))} ${u}`}</b></div>` : ''}
      </div>`;
  }

  card.innerHTML = `
    <h2>Weight</h2>
    <div class="weight-log">
      <label class="field"><span>Date</span><input id="w-date" type="date" value="${today}" max="${today}"></label>
      <label class="field"><span>Weight (${u})</span><input id="w-val" inputmode="decimal" value="${db.weights[today] ? wt(db.weights[today]) : ''}" placeholder="${latest ? wt(latest.kg) : ''}"></label>
    </div>
    <button class="btn primary block" id="w-log">Log weight</button>
    ${summary}
    ${all.length ? `
    <div class="seg">
      ${[[30, '30 days'], [90, '90 days'], [365, 'Year'], [0, 'All']].map(([r, l]) => `<button data-wrange="${r}" class="${weightRange === r ? 'active' : ''}">${l}</button>`).join('')}
    </div>
    <div class="wchart" id="w-chart"></div>
    <div class="tip" id="w-tip"></div>` : '<p class="muted small" style="margin:0 0 8px">Log your weight to see it graphed over time.</p>'}
    <div class="grid2">
      <label class="field"><span>Goal weight (${u})</span><input id="w-goal" inputmode="decimal" value="${goal ? wt(goal) : ''}" placeholder="Optional"></label>
      <div class="field"><span>Units</span><div class="seg" style="margin:0">
        <button data-unit="lb" class="${u === 'lb' ? 'active' : ''}">lb</button>
        <button data-unit="kg" class="${u === 'kg' ? 'active' : ''}">kg</button>
      </div></div>
    </div>`;

  const rerender = () => renderWeight(card);
  const dateIn = $('#w-date', card), valIn = $('#w-val', card);
  dateIn.onchange = () => { const kg = db.weights[dateIn.value]; valIn.value = kg ? wt(kg) : ''; };
  const log = () => {
    const v = parseQty(valIn.value);
    if (!dateIn.value) return toast('Pick a date.');
    if (!(v > 0)) return toast('Enter your weight.');
    db.weights[dateIn.value] = fromUnit(v);
    save();
    weightSel = dateIn.value;
    rerender();
    toast('Weight logged');
  };
  $('#w-log', card).onclick = log;
  valIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') log(); });
  $('#w-goal', card).addEventListener('change', (e) => {
    const v = parseQty(e.target.value);
    db.goalWeight = v > 0 ? fromUnit(v) : 0;
    save();
    rerender();
  });
  $$('[data-unit]', card).forEach((b) => (b.onclick = () => { db.weightUnit = b.dataset.unit; save(); rerender(); }));
  $$('[data-wrange]', card).forEach((b) => (b.onclick = () => { weightRange = +b.dataset.wrange; rerender(); }));

  if (!all.length) return;
  const tip = $('#w-tip', card);
  function showTip(k) {
    const x = pts.find((y) => y.k === k);
    if (!x) { tip.innerHTML = `<span class="muted">${pts.length ? 'Tap the graph to see a day.' : 'Nothing logged in this range.'}</span>`; return; }
    const date = x.d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: x.d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
    tip.innerHTML = `<b>${date}</b> · ${wt(x.kg)} ${u} <button class="btn" style="padding:4px 10px;margin-left:6px;font-size:13px" id="w-del">Delete</button>`;
    $('#w-del', tip).onclick = () => {
      delete db.weights[x.k];
      save();
      weightSel = null;
      rerender();
      toast('Weight deleted', { label: 'Undo', run: () => { db.weights[x.k] = x.kg; save(); weightSel = x.k; rerender(); } });
    };
  }
  drawWeightChart($('#w-chart', card), pts, goal, (k) => { weightSel = k; showTip(k); });
  showTip(weightSel);
}

// A line chart of weight over time, with the goal as a dashed line. Days are spaced by date, not by entry.
function drawWeightChart(box, pts, goal, onSelect) {
  if (!pts.length) { box.innerHTML = ''; return; }
  const W = box.clientWidth || 320, H = 180;
  const pad = { l: 40, r: 10, t: 12, b: 22 };
  const vals = pts.map((x) => toUnit(x.kg));
  if (goal) vals.push(toUnit(goal));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(hi - lo, db.weightUnit === 'lb' ? 4 : 2);
  const mid = (hi + lo) / 2;
  lo = mid - span * 0.6; hi = mid + span * 0.6;
  // Round the axis to a tidy step so gridlines land on whole numbers.
  const step = [0.5, 1, 2, 5, 10, 20, 50].find((s) => (hi - lo) / s <= 4) || 100;
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;

  const t0 = pts[0].d.getTime(), t1 = pts[pts.length - 1].d.getTime();
  const x = (d) => pad.l + (t1 === t0 ? (W - pad.l - pad.r) / 2 : ((d.getTime() - t0) / (t1 - t0)) * (W - pad.l - pad.r));
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const fmtDate = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  let grid = '';
  for (let v = lo; v <= hi + 1e-9; v += step) {
    grid += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="g"/>
      <text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${+v.toFixed(1)}</text>`;
  }
  const xs = pts.length > 1 ? [[pts[0].d, 'start'], [pts[pts.length - 1].d, 'end']] : [[pts[0].d, 'middle']];
  const xlabels = xs.map(([d, a]) => `<text x="${x(d)}" y="${H - 4}" text-anchor="${a}">${fmtDate(d)}</text>`).join('');
  const goalLine = goal
    ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(toUnit(goal))}" y2="${y(toUnit(goal))}" class="goal"/>
       <text x="${W - pad.r}" y="${y(toUnit(goal)) - 5}" text-anchor="end" class="goal-label">Goal ${wt(goal)}</text>`
    : '';
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.d).toFixed(1)},${y(toUnit(p.kg)).toFixed(1)}`).join('');
  // Dots only when there are few enough to tell apart; the selected day always gets one.
  const dots = pts.length <= 40 ? pts.map((p) => `<circle cx="${x(p.d)}" cy="${y(toUnit(p.kg))}" r="3" class="dot"/>`).join('') : '';

  box.innerHTML = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight over time, ${pts.length} entries">
      ${grid}${goalLine}${xlabels}
      <path d="${path}" class="line"/>
      ${dots}
      <line class="cross" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
      <circle class="sel" r="5" visibility="hidden"/>
      <rect x="0" y="0" width="${W}" height="${H}" fill="transparent" class="hit"/>
    </svg>`;

  const svg = $('svg', box), cross = $('.cross', svg), sel = $('.sel', svg);
  const mark = (k) => {
    const p = pts.find((q) => q.k === k);
    if (!p) { cross.setAttribute('visibility', 'hidden'); sel.setAttribute('visibility', 'hidden'); return; }
    const cx = x(p.d), cy = y(toUnit(p.kg));
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
    sel.setAttribute('cx', cx); sel.setAttribute('cy', cy); sel.setAttribute('visibility', 'visible');
  };
  const pick = (e) => {
    const r = svg.getBoundingClientRect(), px = e.clientX - r.left;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.d) - px) < Math.abs(x(best.d) - px)) best = p;
    mark(best.k);
    onSelect(best.k);
  };
  svg.addEventListener('pointerdown', pick);
  svg.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || e.buttons) pick(e); });
  mark(weightSel);
}

// Redraw the weight graph at the new width when the screen rotates or the window resizes.
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { const c = $('#weight-card'); if (c && tab === 'settings') renderWeight(c); }, 150);
});

// ---------------------------------------------------------------- workouts

// Routines are saved plans; db.workouts is what was actually done; db.active is the workout in progress,
// saved as you go so closing the app mid-workout loses nothing.
// An exercise item is { ex, name, type, rest (s), ss (superset id or null), sets: [{ w (kg), r, t (s), done }] }.
// Items in the same superset sit next to each other; the rest timer runs after the last one in the group.

const EX_TYPES = { weight: 'Weight × reps', reps: 'Reps', time: 'Time' };
const FIELDS = { weight: ['w', 'r'], reps: ['r'], time: ['t'] };
const MUSCLES = ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Glutes', 'Core', 'Cardio', 'Full body'];
const REST_OPTIONS = [0, 30, 45, 60, 90, 120, 150, 180, 240, 300];
const SS_COLORS = ['--accent', '--carbs', '--fat', '--fiber'];
const TIMER_ICON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9.5M9.5 2.5h5"/></svg>';

// Built-in exercises by muscle group. A ":r" suffix means reps only, ":t" means timed; the rest are weight × reps.
const LIBRARY = Object.entries({
  Chest: 'Bench Press (Barbell)|Bench Press (Dumbbell)|Bench Press (Smith Machine)|Incline Bench Press (Barbell)|Incline Bench Press (Dumbbell)|Decline Bench Press (Barbell)|Chest Press (Machine)|Incline Chest Press (Machine)|Chest Fly (Dumbbell)|Incline Chest Fly (Dumbbell)|Pec Deck (Machine)|Cable Fly Crossovers|Low to High Cable Fly|Dumbbell Pullover|Push Up:r|Incline Push Up:r|Decline Push Up:r|Chest Dip:r',
  Back: 'Deadlift (Barbell)|Bent Over Row (Barbell)|Bent Over Row (Dumbbell)|Single Arm Row (Dumbbell)|Pendlay Row (Barbell)|T-Bar Row|Seated Cable Row|Seated Row (Machine)|Chest Supported Row (Dumbbell)|Lat Pulldown (Cable)|Close Grip Lat Pulldown (Cable)|Single Arm Lat Pulldown (Cable)|Straight Arm Pulldown (Cable)|Pull Up:r|Chin Up:r|Weighted Pull Up|Assisted Pull Up (Machine)|Inverted Row:r|Rack Pull (Barbell)|Shrug (Barbell)|Shrug (Dumbbell)|Back Extension:r|Superman:r',
  Shoulders: 'Overhead Press (Barbell)|Overhead Press (Dumbbell)|Seated Shoulder Press (Dumbbell)|Shoulder Press (Machine)|Arnold Press (Dumbbell)|Push Press (Barbell)|Landmine Press|Lateral Raise (Dumbbell)|Lateral Raise (Cable)|Lateral Raise (Machine)|Front Raise (Dumbbell)|Front Raise (Plate)|Rear Delt Fly (Dumbbell)|Reverse Fly (Machine)|Face Pull (Cable)|Upright Row (Barbell)|Pike Push Up:r|Handstand Push Up:r',
  Arms: 'Bicep Curl (Barbell)|Bicep Curl (Dumbbell)|Bicep Curl (Cable)|EZ Bar Curl|Hammer Curl (Dumbbell)|Hammer Curl (Cable)|Preacher Curl (EZ Bar)|Preacher Curl (Machine)|Incline Curl (Dumbbell)|Concentration Curl (Dumbbell)|Spider Curl (Dumbbell)|Reverse Curl (Barbell)|Triceps Pushdown (Cable)|Triceps Rope Pushdown (Cable)|Overhead Triceps Extension (Cable)|Overhead Triceps Extension (Dumbbell)|Skullcrusher (EZ Bar)|Close Grip Bench Press (Barbell)|Triceps Kickback (Dumbbell)|Triceps Dip:r|Bench Dip:r|Wrist Curl (Dumbbell)',
  Legs: 'Squat (Barbell)|Front Squat (Barbell)|Goblet Squat (Dumbbell)|Hack Squat (Machine)|Smith Machine Squat|Leg Press (Machine)|Bulgarian Split Squat (Dumbbell)|Lunge (Dumbbell)|Walking Lunge (Dumbbell)|Reverse Lunge (Dumbbell)|Step Up (Dumbbell)|Leg Extension (Machine)|Lying Leg Curl (Machine)|Seated Leg Curl (Machine)|Romanian Deadlift (Barbell)|Romanian Deadlift (Dumbbell)|Stiff Leg Deadlift (Barbell)|Sumo Deadlift (Barbell)|Trap Bar Deadlift|Good Morning (Barbell)|Hip Adduction (Machine)|Standing Calf Raise (Machine)|Seated Calf Raise (Machine)|Calf Raise (Dumbbell)|Bodyweight Squat:r|Jump Squat:r|Pistol Squat:r|Nordic Hamstring Curl:r|Wall Sit:t',
  Glutes: 'Hip Thrust (Barbell)|Hip Thrust (Machine)|Glute Bridge (Barbell)|Glute Bridge:r|Single Leg Glute Bridge:r|Cable Kickback|Glute Kickback (Machine)|Hip Abduction (Machine)|Cable Pull Through|Frog Pump:r',
  Core: 'Plank:t|Side Plank:t|Hollow Hold:t|Crunch:r|Bicycle Crunch:r|Sit Up:r|Decline Crunch:r|Cable Crunch|Hanging Leg Raise:r|Hanging Knee Raise:r|Lying Leg Raise:r|Russian Twist:r|Ab Wheel Rollout:r|Dead Bug:r|Mountain Climber:r|Toes to Bar:r|V Up:r|Pallof Press (Cable)|Woodchopper (Cable)',
  Cardio: 'Treadmill:t|Running:t|Walking:t|Incline Walk:t|Cycling:t|Stationary Bike:t|Elliptical:t|Rowing Machine:t|Stair Climber:t|Jump Rope:t|Swimming:t|Hiking:t|HIIT:t',
  'Full body': 'Kettlebell Swing|Power Clean (Barbell)|Clean and Jerk (Barbell)|Snatch (Barbell)|Thruster (Barbell)|Dumbbell Snatch|Turkish Get Up (Kettlebell)|Burpee:r|Box Jump:r|Battle Ropes:t|Farmers Walk:t|Sled Push:t',
}).flatMap(([muscle, list]) => list.split('|').map((x) => {
  const [name, t] = x.split(':');
  return { id: 'lib:' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name, muscle, type: { r: 'reps', t: 'time' }[t] || 'weight' };
}));
const LIB_BY_ID = new Map(LIBRARY.map((x) => [x.id, x]));

const exInfo = (id) => db.exercises.find((x) => x.id === id) || LIB_BY_ID.get(id);
const exName = (it) => exInfo(it.ex)?.name || it.name || 'Exercise';

// Lifts are stored in kg and shown in db.liftUnit. Values typed in the current unit come back exactly;
// converted ones round to the nearest half so 100 kg shows as 220.5 lb, not 220.46.
const toLift = (kg) => (db.liftUnit === 'lb' ? kg / LB : kg);
const fromLift = (v) => (db.liftUnit === 'lb' ? v * LB : v);
function lw(kg) {
  const v = toLift(kg), q = Math.round(v * 4) / 4;
  return String(Math.abs(v - q) < 0.01 ? q : Math.round(v * 2) / 2);
}

const fmtDur = (sec) => { sec = Math.round(sec); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600);
  return h ? `${h}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : fmtDur(s);
}
function fmtMinutes(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
function fmtRest(sec) {
  if (!sec) return 'Off';
  const m = Math.floor(sec / 60), s = sec % 60;
  return [m && `${m}min`, (s || !m) && `${s}s`].filter(Boolean).join(' ');
}

// Times are typed as m:ss (or m.ss on a number pad), or as plain seconds.
function parseTime(s) {
  const m = s.match(/^(\d+)[:.,](\d{1,2})$/);
  const v = m ? +m[1] * 60 + +m[2] : /^\d+$/.test(s) ? +s : NaN;
  return v > 0 ? v : null;
}

function readField(f, s) {
  s = s.trim();
  if (!s) return null;
  if (f === 't') return parseTime(s);
  const v = parseQty(s);
  if (f === 'w') return Number.isFinite(v) && v >= 0 ? fromLift(v) : null;
  return v > 0 ? Math.round(v) : null;
}
const fieldVal = (f, v) => (v == null ? '' : f === 'w' ? lw(v) : f === 't' ? fmtDur(v) : String(v));
const fmtSet = (type, s) => (type === 'weight' ? `${lw(s.w ?? 0)} × ${s.r ?? '–'}` : type === 'reps' ? `${s.r ?? '–'} reps` : fmtDur(s.t ?? 0));

// The sets from the most recent finished workout that included this exercise.
function lastSets(ex) {
  for (const w of db.workouts) {
    const it = w.items.find((x) => x.ex === ex);
    if (it) return { when: w.start, sets: it.sets };
  }
  return null;
}

function wkStats(items, doneOnly) {
  let sets = 0, vol = 0;
  for (const it of items) {
    for (const s of it.sets) {
      if (doneOnly && !s.done) continue;
      sets++;
      if (it.type === 'weight') vol += (s.w || 0) * (s.r || 0);
    }
  }
  return { sets, vol };
}

const statBoxes = (ms, { sets, vol }, elapsedId) => `
  <div class="weight-stats">
    <div><span>Duration</span><b ${elapsedId ? `id="${elapsedId}"` : ''}>${elapsedId ? fmtClock(ms) : fmtMinutes(ms)}</b></div>
    <div><span>Volume</span><b>${kc(toLift(vol))} ${db.liftUnit}</b></div>
    <div><span>Sets</span><b>${sets}</b></div>
  </div>`;

// A new exercise in a routine starts from what you did last time; in a live workout it starts empty,
// with last time shown alongside each set.
function newItem(id, live) {
  const x = exInfo(id);
  const last = lastSets(id);
  const sets = (last?.sets || [{}, {}, {}]).map((s) => (live
    ? { w: null, r: null, t: null, done: false }
    : { w: s.w ?? null, r: s.r ?? null, t: s.t ?? null }));
  return { ex: id, name: x.name, type: x.type, rest: x.muscle === 'Cardio' ? 0 : 90, ss: null, sets };
}

// The shape a routine stores: the plan without check marks.
const routineItem = (it) => ({
  ex: it.ex, name: exName(it), type: it.type, rest: it.rest ?? 0, ss: it.ss || null,
  sets: it.sets.map((s) => ({ w: s.w ?? null, r: s.r ?? null, t: s.t ?? null })),
});

// A superset needs at least two exercises side by side; drop the link from any left on its own.
function normalizeSS(items) {
  items.forEach((it, i) => {
    if (it.ss && items[i - 1]?.ss !== it.ss && items[i + 1]?.ss !== it.ss) it.ss = null;
  });
}

function lastLine(it) {
  const last = lastSets(it.ex);
  if (!last) return '';
  const d = new Date(last.when).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<div class="ex-meta">Last · ${d} · ${esc(last.sets.map((s) => fmtSet(it.type, s)).join(', '))}</div>`;
}

// Exercise cards with their sets. Modes: 'edit' (routine editor), 'live' (workout in progress),
// 'plan' (a routine, read-only) and 'done' (a finished workout).
function blocksHtml(items, mode) {
  const live = mode === 'live', edit = mode === 'edit' || live;
  const groups = [...new Set(items.map((it) => it.ss).filter(Boolean))];
  const heads = { w: db.liftUnit, r: 'Reps', t: 'Time' };
  return items.map((it, i) => {
    const fields = FIELDS[it.type];
    const linkedNext = it.ss && items[i + 1]?.ss === it.ss;
    const linkedPrev = it.ss && items[i - 1]?.ss === it.ss;
    const color = it.ss ? `--ss: var(${SS_COLORS[groups.indexOf(it.ss) % SS_COLORS.length]})` : '';
    const last = live ? lastSets(it.ex) : null;
    const grid = ['32px', live && 'minmax(0,1.3fr)', ...fields.map(() => 'minmax(0,1fr)'), live && '40px'].filter(Boolean).join(' ');
    const restText = `${TIMER_ICON}Rest timer: ${fmtRest(it.rest)}${it.ss && it.rest ? ' after each round' : ''}`;
    const rest = linkedNext || mode === 'done' ? ''
      : edit ? `<button class="rest-btn" data-rest="${i}">${restText}</button>` : `<div class="rest-btn">${restText}</div>`;
    const cell = (s, j, f) => {
      if (!edit) return `<span>${s[f] == null ? '–' : esc(fieldVal(f, s[f]))}</span>`;
      const ph = last?.sets[j]?.[f] != null ? fieldVal(f, last.sets[j][f]) : f === 't' ? '0:00' : '–';
      return `<input data-s="${i}.${j}" data-f="${f}" inputmode="${f === 'r' ? 'numeric' : 'decimal'}" value="${esc(fieldVal(f, s[f]))}" placeholder="${esc(ph)}" aria-label="Set ${j + 1} ${heads[f]}">`;
    };
    return `
      <div class="ex-block ${it.ss ? 'ss' : ''} ${linkedNext ? 'ss-next' : ''} ${linkedPrev ? 'ss-prev' : ''}" style="${color}">
        <div class="ex-head">
          <div class="ex-name">${esc(exName(it))}</div>
          ${edit ? `<button class="icon-btn" data-menu="${i}" aria-label="Options for ${esc(exName(it))}">⋯</button>` : ''}
        </div>
        ${it.ss && !linkedPrev ? '<div class="ss-label">Superset</div>' : ''}
        ${mode === 'edit' || mode === 'plan' ? lastLine(it) : ''}
        ${rest}
        <div class="sets" style="--grid: ${grid}">
          <div class="set-row head"><span>Set</span>${live ? '<span class="prev">Previous</span>' : ''}${fields.map((f) => `<span>${heads[f]}</span>`).join('')}${live ? '<span>✓</span>' : ''}</div>
          ${it.sets.map((s, j) => `
            <div class="set-row ${s.done ? 'done' : ''}">
              <span class="set-n">${j + 1}</span>
              ${live ? `<span class="prev">${last?.sets[j] ? esc(fmtSet(it.type, last.sets[j])) : '–'}</span>` : ''}
              ${fields.map((f) => cell(s, j, f)).join('')}
              ${live ? `<button class="check" data-check="${i}.${j}" aria-label="Set ${j + 1} done" aria-pressed="${!!s.done}">✓</button>` : ''}
            </div>`).join('')}
        </div>
        ${edit ? `<div class="set-actions"><button data-addset="${i}">+ Add set</button>${it.sets.length > 1 ? `<button data-rmset="${i}">− Remove set</button>` : ''}</div>` : ''}
      </div>`;
  }).join('');
}

// changed() runs after every edit (to save); refresh() redraws after a change to the structure.
function bindBlocks(root, items, { live, changed, refresh }) {
  const at = (el, k) => el.dataset[k].split('.').map(Number);
  $$('input[data-s]', root).forEach((inp) => {
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('input', () => {
      const [i, j] = at(inp, 's');
      items[i].sets[j][inp.dataset.f] = readField(inp.dataset.f, inp.value);
      changed();
    });
  });
  $$('[data-check]', root).forEach((b) => (b.onclick = () => toggleSet(...at(b, 'check'))));
  $$('[data-addset]', root).forEach((b) => (b.onclick = () => {
    const sets = items[+b.dataset.addset].sets, l = sets[sets.length - 1] || {};
    sets.push({ w: l.w ?? null, r: l.r ?? null, t: l.t ?? null, ...(live ? { done: false } : {}) });
    changed();
    refresh();
  }));
  $$('[data-rmset]', root).forEach((b) => (b.onclick = () => {
    items[+b.dataset.rmset].sets.pop();
    changed();
    refresh();
  }));
  $$('[data-rest]', root).forEach((b) => (b.onclick = () => {
    const it = items[+b.dataset.rest];
    openRestPicker(it.rest, (sec) => { it.rest = sec; changed(); refresh(); });
  }));
  $$('[data-menu]', root).forEach((b) => (b.onclick = () => openExMenu(items, +b.dataset.menu, live, () => { changed(); refresh(); })));
}

function openRestPicker(cur, onPick) {
  const sheet = openSheet({
    title: 'Rest timer',
    short: true,
    body: `
      <p class="muted small" style="margin:0 0 12px">Counts down when you check off a set.</p>
      <div class="meal-pick">${REST_OPTIONS.map((s) => `<button data-sec="${s}" class="${s === cur ? 'active' : ''}">${fmtRest(s)}</button>`).join('')}</div>`,
  });
  $$('[data-sec]', sheet.body).forEach((b) => (b.onclick = () => { sheet.close(); onPick(+b.dataset.sec); }));
}

function openExMenu(items, i, live, done) {
  const it = items[i], next = items[i + 1];
  const acts = [
    ['replace', 'Replace exercise'],
    i > 0 && ['up', 'Move up'],
    next && ['down', 'Move down'],
    next && !(it.ss && next.ss === it.ss) && ['link', `Superset with ${exName(next)}`],
    it.ss && ['unlink', 'Remove from superset'],
    ['remove', 'Remove exercise'],
  ].filter(Boolean);
  const sheet = openSheet({
    title: exName(it),
    short: true,
    body: `<div class="menu-list">${acts.map(([k, l]) => `<button class="btn block ${k === 'remove' ? 'danger' : ''}" data-act="${k}">${esc(l)}</button>`).join('')}</div>`,
  });
  $$('[data-act]', sheet.body).forEach((b) => (b.onclick = () => {
    sheet.close();
    const k = b.dataset.act;
    if (k === 'replace') {
      return openExercisePicker({
        single: true,
        onPick: ([id]) => {
          const fresh = newItem(id, live);
          Object.assign(it, { ex: id, name: fresh.name, type: fresh.type, sets: fresh.sets });
          done();
        },
      });
    }
    if (k === 'up' || k === 'down') {
      const j = k === 'up' ? i - 1 : i + 1;
      [items[i], items[j]] = [items[j], items[i]];
    }
    if (k === 'link') {
      const id = it.ss || uid(), old = next.ss;
      for (const x of items) if (old && x.ss === old) x.ss = id;
      it.ss = next.ss = id;
    }
    if (k === 'unlink') it.ss = null;
    if (k === 'remove') items.splice(i, 1);
    normalizeSS(items);
    done();
  }));
}

// ---------------------------------------------------------------- exercise library

function openExercisePicker({ single = false, onPick }) {
  let muscle = '';
  const picked = [];
  const sheet = openSheet({
    title: single ? 'Replace exercise' : 'Add exercises',
    body: `
      <div class="search"><input type="search" id="xp-q" placeholder="Search exercises" aria-label="Search exercises" autocomplete="off"></div>
      <div class="chips">${['', ...MUSCLES].map((m) => `<button data-m="${m}" class="${m ? '' : 'active'}">${m || 'All'}</button>`).join('')}</div>
      <button class="btn block" id="xp-new" style="margin-bottom:8px">✚ Create exercise</button>
      <div class="list" id="xp-list"></div>
      ${single ? '' : '<div class="picker-go"><button class="btn primary block" id="xp-go" disabled>Add exercises</button></div>'}`,
  });
  const b = sheet.body, out = $('#xp-list', b), input = $('#xp-q', b);

  const row = (x) => {
    const on = picked.includes(x.id);
    return `
      <button class="row-btn ex-row ${on ? 'sel' : ''}" data-id="${x.id}">
        <div class="main">
          <div class="title">${esc(x.name)}${x.custom ? '<span class="tag">Custom</span>' : ''}</div>
          <div class="sub">${esc(x.muscle)} · ${EX_TYPES[x.type]}</div>
        </div>
        ${x.custom ? '<span class="muted small" data-edit role="button">Edit</span>' : ''}
        <span class="add">${on ? '✓' : '+'}</span>
      </button>`;
  };

  function list() {
    const terms = searchTerms(input.value);
    const all = [...db.exercises, ...LIBRARY].filter((x) => !muscle || x.muscle === muscle);
    let html;
    if (terms.length) {
      const hits = all.map((x) => [scoreName(x.name.toLowerCase(), terms), x]).filter(([s]) => s >= 0).sort((a, c) => c[0] - a[0]);
      html = hits.length ? hits.map(([, x]) => row(x)).join('') : '<div class="empty">No matches. Create it as your own exercise.</div>';
    } else {
      // Recently done exercises first, then everything A–Z.
      const recent = muscle ? [] : [...new Set(db.workouts.flatMap((w) => w.items.map((it) => it.ex)))].map(exInfo).filter(Boolean).slice(0, 8);
      const rest = all.filter((x) => !recent.includes(x)).sort((a, c) => a.name.localeCompare(c.name));
      html = (recent.length ? `<div class="section-label" style="padding:0 16px">Recent</div>${recent.map(row).join('')}<div class="section-label" style="padding:0 16px">All exercises</div>` : '') + rest.map(row).join('');
    }
    out.innerHTML = html;
    const go = $('#xp-go', b);
    if (go) {
      go.disabled = !picked.length;
      go.textContent = picked.length ? `Add ${picked.length} exercise${picked.length > 1 ? 's' : ''}` : 'Add exercises';
    }
    $$('[data-id]', out).forEach((r) => (r.onclick = (ev) => {
      const x = exInfo(r.dataset.id);
      if (ev.target.closest('[data-edit]')) return openCreateExercise({ ex: x, onChange: list });
      if (single) { sheet.close(); onPick([x.id]); return; }
      const k = picked.indexOf(x.id);
      if (k >= 0) picked.splice(k, 1);
      else picked.push(x.id);
      list();
    }));
  }

  let debounce;
  input.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(list, 120); });
  $$('[data-m]', b).forEach((c) => (c.onclick = () => {
    muscle = c.dataset.m;
    $$('[data-m]', b).forEach((y) => y.classList.toggle('active', y === c));
    list();
  }));
  $('#xp-new', b).onclick = () => openCreateExercise({
    name: input.value.trim(), muscle,
    onChange: (x) => {
      if (!x) return list();
      if (single) { sheet.close(); onPick([x.id]); return; }
      picked.push(x.id);
      input.value = '';
      list();
    },
  });
  $('#xp-go', b)?.addEventListener('click', () => { sheet.close(); onPick(picked); });
  list();
}

function openCreateExercise({ ex, name = '', muscle = '', onChange }) {
  let type = ex?.type || 'weight';
  const sheet = openSheet({
    title: ex ? 'Edit exercise' : 'Create exercise',
    short: true,
    body: `
      <label class="field"><span>Name</span><input id="ce-name" value="${esc(ex?.name ?? name)}" placeholder="e.g. Sled Pull"></label>
      <label class="field"><span>Muscle group</span><select id="ce-muscle">${MUSCLES.map((m) => `<option ${m === (ex?.muscle || muscle || 'Chest') ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <div class="field"><span>Track</span><div class="seg" style="margin:0">${Object.entries(EX_TYPES).map(([k, l]) => `<button data-type="${k}" class="${k === type ? 'active' : ''}">${l}</button>`).join('')}</div></div>
      <button class="btn primary block" id="ce-go" style="margin-top:8px">${ex ? 'Save changes' : 'Save exercise'}</button>
      ${ex ? '<button class="btn danger block" id="ce-del" style="margin-top:8px">Delete exercise</button>' : ''}`,
  });
  const b = sheet.body;
  $$('[data-type]', b).forEach((x) => (x.onclick = () => {
    type = x.dataset.type;
    $$('[data-type]', b).forEach((y) => y.classList.toggle('active', y === x));
  }));
  $('#ce-go', b).onclick = () => {
    const nm = $('#ce-name', b).value.trim();
    if (!nm) return toast('Give the exercise a name.');
    const dupe = [...db.exercises, ...LIBRARY].find((x) => x.id !== ex?.id && x.name.toLowerCase() === nm.toLowerCase());
    if (dupe) return toast(`“${dupe.name}” is already in the library.`);
    const next = { id: ex?.id || 'ex:' + uid(), name: nm, muscle: $('#ce-muscle', b).value, type, custom: true };
    if (ex) {
      Object.assign(ex, next);
      for (const r of db.routines) for (const it of r.items) if (it.ex === ex.id) Object.assign(it, { name: nm, type });
    } else db.exercises.unshift(next);
    save();
    sheet.close();
    render();
    onChange?.(ex ? null : next);
  };
  $('#ce-del', b)?.addEventListener('click', () => {
    if (!confirm(`Delete “${ex.name}”? Past workouts keep it, but it will be taken out of your routines.`)) return;
    db.exercises = db.exercises.filter((x) => x.id !== ex.id);
    for (const r of db.routines) {
      r.items = r.items.filter((it) => it.ex !== ex.id);
      normalizeSS(r.items);
    }
    save();
    sheet.close();
    render();
    onChange?.(null);
  });
}

// ---------------------------------------------------------------- workout tab

let historyAll = false;

function renderWorkout() {
  const view = $('#view');
  if (db.active) return renderActive(view);
  const hist = historyAll ? db.workouts : db.workouts.slice(0, 10);
  view.innerHTML = `
    <div class="btn-row" style="margin-top:12px">
      <button class="btn primary" id="wk-empty">Start empty workout</button>
      <button class="btn" id="wk-new">✚ New routine</button>
    </div>
    <div class="section-label">Routines</div>
    <section class="card" style="margin-top:6px">
      ${db.routines.length ? db.routines.map((r, i) => `
        <button class="row-btn" data-r="${i}">
          <div class="main">
            <div class="title">${esc(r.name)}</div>
            <div class="sub">${esc(r.items.map(exName).join(', ') || 'No exercises')}</div>
          </div>
          <span class="start" data-start role="button" aria-label="Start ${esc(r.name)}">Start</span>
        </button>`).join('') : '<div class="empty">Save a routine for workouts you repeat, like “Push day”.<br>Starting it fills in your exercises and sets.</div>'}
    </section>
    <div class="section-label">History</div>
    <section class="card" style="margin-top:6px">
      ${hist.length ? hist.map((w) => {
        const { sets, vol } = wkStats(w.items);
        const d = new Date(w.start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        return `
          <button class="row-btn" data-w="${w.id}">
            <div class="main">
              <div class="title">${esc(w.name)}</div>
              <div class="sub">${d} · ${fmtMinutes(w.end - w.start)} · ${sets} set${sets === 1 ? '' : 's'}${vol ? ` · ${kc(toLift(vol))} ${db.liftUnit}` : ''}</div>
            </div>
          </button>`;
      }).join('') : '<div class="empty">Finished workouts show up here.</div>'}
      ${!historyAll && db.workouts.length > 10 ? `<div class="meal-actions"><button id="wk-more">Show all ${db.workouts.length}</button></div>` : ''}
    </section>`;

  $('#wk-empty', view).onclick = () => startWorkout();
  $('#wk-new', view).onclick = () => openRoutineEditor();
  $('#wk-more', view)?.addEventListener('click', () => { historyAll = true; render(); });
  $$('[data-r]', view).forEach((b) => (b.onclick = (ev) => {
    const r = db.routines[+b.dataset.r];
    if (ev.target.closest('[data-start]')) startWorkout(r);
    else openRoutine(r);
  }));
  $$('[data-w]', view).forEach((b) => (b.onclick = () => openWorkout(db.workouts.find((w) => w.id === b.dataset.w))));
}

function openRoutine(r) {
  const sheet = openSheet({
    title: 'Routine',
    body: `
      <div class="food-title">${esc(r.name)}</div>
      <button class="btn primary block" id="rd-start" style="margin:12px 0 4px">Start routine</button>
      ${blocksHtml(r.items, 'plan') || '<div class="empty">No exercises yet.</div>'}
      <button class="btn block" id="rd-edit" style="margin-top:12px">Edit routine</button>`,
  });
  $('#rd-start', sheet.body).onclick = () => { sheet.close(); startWorkout(r); };
  $('#rd-edit', sheet.body).onclick = () => { sheet.close(); openRoutineEditor(r); };
}

function openRoutineEditor(r) {
  const items = structuredClone(r?.items || []);
  const sheet = openSheet({
    title: r ? 'Edit routine' : 'New routine',
    body: `
      <label class="field"><span>Name</span><input id="re-name" value="${esc(r?.name)}" placeholder="e.g. Push day"></label>
      <div id="re-blocks"></div>
      <button class="btn block" id="re-add" style="margin-top:4px">✚ Add exercises</button>
      <button class="btn primary block" id="re-save" style="margin-top:12px">${r ? 'Save changes' : 'Save routine'}</button>
      ${r ? '<button class="btn danger block" id="re-del" style="margin-top:8px">Delete routine</button>' : ''}`,
  });
  const b = sheet.body;
  const refresh = () => {
    const box = $('#re-blocks', b);
    box.innerHTML = blocksHtml(items, 'edit') || '<div class="empty">Add the exercises for this routine.<br>Sets fill in from the last time you did each one.</div>';
    bindBlocks(box, items, { live: false, changed: () => {}, refresh });
  };
  $('#re-add', b).onclick = () => openExercisePicker({ onPick: (ids) => { items.push(...ids.map((id) => newItem(id, false))); refresh(); } });
  $('#re-save', b).onclick = () => {
    const name = $('#re-name', b).value.trim();
    if (!name) return toast('Give the routine a name.');
    if (!items.length) return toast('Add at least one exercise.');
    const next = { id: r?.id || uid(), name, items: items.map(routineItem) };
    const i = db.routines.findIndex((x) => x.id === next.id);
    if (i >= 0) db.routines[i] = next;
    else db.routines.push(next);
    save();
    sheet.close();
    render();
    toast(r ? 'Routine updated' : 'Routine saved');
  };
  $('#re-del', b)?.addEventListener('click', () => {
    if (!confirm(`Delete the routine “${r.name}”? Past workouts are kept.`)) return;
    db.routines = db.routines.filter((x) => x.id !== r.id);
    save();
    sheet.close();
    render();
  });
  refresh();
}

function startWorkout(r) {
  if (db.active && !confirm('A workout is already in progress. Discard it and start a new one?')) {
    tab = 'workout';
    render();
    return;
  }
  const h = new Date().getHours();
  db.active = {
    id: uid(), routineId: r?.id || null, start: Date.now(), restEnd: null, restFor: 0,
    name: r?.name || (h < 12 ? 'Morning workout' : h < 17 ? 'Afternoon workout' : 'Evening workout'),
    items: (r?.items || []).map((it) => ({
      ...structuredClone(it), name: exName(it), type: exInfo(it.ex)?.type || it.type,
      sets: it.sets.map((s) => ({ ...s, done: false })),
    })),
  };
  save();
  tab = 'workout';
  render();
  window.scrollTo(0, 0);
}

function renderActive(view) {
  const a = db.active;
  view.innerHTML = `
    <section class="card card-pad">
      <div class="wk-title">
        <input id="wk-name" value="${esc(a.name)}" aria-label="Workout name">
        <button class="btn primary sm" id="wk-finish">Finish</button>
      </div>
      ${statBoxes(Date.now() - a.start, wkStats(a.items, true), 'wk-elapsed')}
    </section>
    <div id="wk-blocks">${blocksHtml(a.items, 'live') || '<div class="empty">Add exercises from the library to get going.</div>'}</div>
    <button class="btn block" id="wk-add">✚ Add exercises</button>
    <button class="btn danger block" id="wk-discard" style="margin-top:8px">Discard workout</button>`;
  bindBlocks($('#wk-blocks', view), a.items, { live: true, changed: save, refresh: render });
  $('#wk-name', view).addEventListener('input', (e) => { a.name = e.target.value; save(); });
  $('#wk-add', view).onclick = () => openExercisePicker({ onPick: (ids) => { a.items.push(...ids.map((id) => newItem(id, true))); save(); render(); } });
  $('#wk-discard', view).onclick = () => {
    if (!confirm('Discard this workout? Nothing from it will be saved.')) return;
    db.active = null;
    save();
    render();
  };
  $('#wk-finish', view).onclick = openFinish;
}

// Checking off a set fills any empty box from last time (or the set above), then starts the rest timer.
function toggleSet(i, j) {
  const a = db.active, it = a.items[i], s = it.sets[j];
  if (s.done) s.done = false;
  else {
    const last = lastSets(it.ex)?.sets[j], above = it.sets[j - 1];
    for (const f of FIELDS[it.type]) s[f] ??= last?.[f] ?? above?.[f] ?? null;
    const missing = FIELDS[it.type].find((f) => s[f] == null || (f !== 'w' && !(s[f] > 0)));
    if (missing) return toast({ w: 'Enter the weight first.', r: 'Enter the reps first.', t: 'Enter the time first.' }[missing]);
    s.done = true;
    navigator.vibrate?.(30);
    unlockAudio();
    const inGroup = it.ss && a.items[i + 1]?.ss === it.ss;
    if (!inGroup && it.rest) { a.restEnd = Date.now() + it.rest * 1000; a.restFor = it.rest; }
  }
  save();
  render();
}

function openFinish() {
  const a = db.active;
  const done = a.items
    .map((it) => ({ ...it, sets: it.sets.filter((s) => s.done).map(({ w, r, t }) => ({ w, r, t })) }))
    .filter((it) => it.sets.length);
  if (!done.length) {
    if (confirm('No sets are checked off, so there is nothing to save. Discard this workout?')) { db.active = null; save(); render(); }
    return;
  }
  const stats = wkStats(done);
  const skipped = wkStats(a.items).sets - stats.sets;
  const routine = db.routines.find((r) => r.id === a.routineId);
  const plan = a.items.map(routineItem);
  const changed = routine && JSON.stringify(plan) !== JSON.stringify(routine.items.map(routineItem));
  const sheet = openSheet({
    title: 'Finish workout',
    short: true,
    body: `
      ${statBoxes(Date.now() - a.start, stats)}
      <label class="field"><span>Name</span><input id="fw-name" value="${esc(a.name)}"></label>
      ${skipped ? `<p class="muted small">${skipped} set${skipped > 1 ? 's' : ''} not checked off won't be saved.</p>` : ''}
      ${changed ? `<label class="check-line"><input type="checkbox" id="fw-update" checked>Update “${esc(routine.name)}” with today's exercises and sets</label>` : ''}
      ${routine ? '' : '<label class="check-line"><input type="checkbox" id="fw-routine">Also save as a routine</label>'}
      <button class="btn primary block" id="fw-go" style="margin-top:8px">Save workout</button>`,
  });
  $('#fw-go', sheet.body).onclick = () => {
    const name = $('#fw-name', sheet.body).value.trim() || a.name;
    db.workouts.unshift({
      id: a.id, name, routineId: a.routineId, start: a.start, end: Date.now(),
      items: done.map((it) => ({ ex: it.ex, name: exName(it), type: it.type, rest: it.rest, ss: it.ss || null, sets: it.sets })),
    });
    if ($('#fw-update', sheet.body)?.checked) routine.items = plan;
    if ($('#fw-routine', sheet.body)?.checked) db.routines.push({ id: uid(), name, items: plan });
    db.active = null;
    save();
    sheet.close();
    render();
    window.scrollTo(0, 0);
    toast('Workout saved');
  };
}

function openWorkout(w) {
  const d = new Date(w.start);
  const sheet = openSheet({
    title: 'Workout',
    body: `
      <div class="food-title">${esc(w.name)}</div>
      <div class="muted small">${d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</div>
      ${statBoxes(w.end - w.start, wkStats(w.items))}
      ${blocksHtml(w.items, 'done')}
      <button class="btn block" id="wd-routine" style="margin-top:12px">Save as routine</button>
      <button class="btn danger block" id="wd-del" style="margin-top:8px">Delete workout</button>`,
  });
  $('#wd-routine', sheet.body).onclick = () => {
    db.routines.push({ id: uid(), name: w.name, items: w.items.map(routineItem) });
    save();
    sheet.close();
    render();
    toast(`Saved “${w.name}” to routines`);
  };
  $('#wd-del', sheet.body).onclick = () => {
    if (!confirm('Delete this workout from your history?')) return;
    const i = db.workouts.indexOf(w);
    db.workouts.splice(i, 1);
    save();
    sheet.close();
    render();
    toast('Workout deleted', { label: 'Undo', run: () => { db.workouts.splice(i, 0, w); save(); render(); } });
  };
}

// ---------------------------------------------------------------- rest timer

// The bar above the tabs shows the rest countdown on the Workout tab, and a way back to the
// workout from any other tab. It is rebuilt only when its mode changes so taps aren't lost mid-press.
let wkBarMode = '';

function updateWkBar() {
  const el = $('#wk-bar'), a = db.active;
  const rest = a?.restEnd ? Math.max(0, Math.ceil((a.restEnd - Date.now()) / 1000)) : 0;
  const mode = !a ? '' : tab !== 'workout' ? 'mini' : rest ? 'rest' : '';
  if (mode !== wkBarMode) {
    wkBarMode = mode;
    el.hidden = !mode;
    document.body.classList.toggle('has-wkbar', !!mode);
    el.innerHTML = mode === 'rest'
      ? '<div class="wk-rest"><div class="meter"><i></i></div><span class="t"></span><button data-adj="-15">−15</button><button data-adj="15">+15</button><button data-adj="skip">Skip</button></div>'
      : mode === 'mini' ? '<button class="wk-mini" data-adj="open"><span class="dot"></span><span class="n"></span><span class="r"></span><span class="t"></span></button>' : '';
  }
  if (mode === 'rest') {
    $('.t', el).textContent = `Rest ${fmtDur(rest)}`;
    $('.meter i', el).style.width = `${Math.min(100, (rest / a.restFor) * 100)}%`;
  } else if (mode === 'mini') {
    $('.n', el).textContent = a.name || 'Workout';
    $('.r', el).textContent = rest ? `Rest ${fmtDur(rest)}` : '';
    $('.t', el).textContent = fmtClock(Date.now() - a.start);
  }
}

$('#wk-bar').onclick = (e) => {
  const v = e.target.closest('[data-adj]')?.dataset.adj, a = db.active;
  if (!v || !a) return;
  if (v === 'open') { tab = 'workout'; render(); window.scrollTo(0, 0); return; }
  if (v === 'skip') a.restEnd = null;
  else if (a.restEnd) {
    a.restEnd = Math.max(Date.now(), a.restEnd + v * 1000);
    a.restFor = Math.max(1, a.restFor + +v);
  }
  save();
  updateWkBar();
};

// A short beep when rest is over. Audio has to be started from a tap, so checking a set unlocks it.
let audio;
function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
  } catch { /* no audio */ }
}
function beep() {
  if (!audio) return;
  const t = audio.currentTime;
  for (const d of [0, 0.25]) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.001, t + d);
    g.gain.exponentialRampToValueAtTime(0.3, t + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.18);
    o.connect(g).connect(audio.destination);
    o.start(t + d);
    o.stop(t + d + 0.2);
  }
}

setInterval(() => {
  const a = db.active;
  if (!a) return;
  if (a.restEnd && Date.now() >= a.restEnd) {
    // Only make noise if the app was open when time ran out, not when coming back to it later.
    if (Date.now() - a.restEnd < 3000) { beep(); navigator.vibrate?.([200, 100, 200]); }
    a.restEnd = null;
    save();
    toast('Rest is over');
  }
  const el = $('#wk-elapsed');
  if (el) el.textContent = fmtClock(Date.now() - a.start);
  updateWkBar();
}, 1000);

// ---------------------------------------------------------------- boot

render();
checkSharedLink();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // When an update takes over, reload once so the new version shows now, not on the next launch.
  const updating = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating) location.reload(); });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
}
