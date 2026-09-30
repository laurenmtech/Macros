// Macros — a MyFitnessPal-style macro tracker that lives on the home screen.
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
  const bar = $('.topbar');
  bar.classList.toggle('no-nav', tab !== 'diary');
  if (tab === 'diary') {
    const k = dkey(viewDate);
    const rel = { [dkey(new Date())]: 'Today', [dkey(addDays(new Date(), -1))]: 'Yesterday', [dkey(addDays(new Date(), 1))]: 'Tomorrow' }[k];
    $('#date-label').textContent = rel || viewDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  } else {
    $('#date-label').textContent = { trends: 'Trends', foods: 'My foods', settings: 'Goals & data' }[tab];
  }
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  ({ diary: renderDiary, trends: renderTrends, foods: renderFoods, settings: renderSettings })[tab]();
}

$('#prev-day').onclick = () => { viewDate = addDays(viewDate, -1); render(); };
$('#next-day').onclick = () => { viewDate = addDays(viewDate, 1); render(); };
$('#date-label').onclick = () => { if (tab === 'diary') { viewDate = noon(); render(); } };
$$('.tabbar button').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));

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
        <label class="field"><span>kcal</span><input id="cf-kcal" inputmode="decimal" value="${per.kcal ?? ''}"></label>
        ${MACROS.map(([k, name]) => `<label class="field"><span>${name} g</span><input id="cf-${k}" inputmode="decimal" value="${per[k] ?? ''}"></label>`).join('')}
      </div>
      <label class="field" style="max-width:25%"><span>Fiber g</span><input id="cf-fib" inputmode="decimal" value="${per.fib || ''}"></label>
      <label class="field"><span>Barcode (optional)</span><input id="cf-barcode" inputmode="numeric" value="${esc(food?.barcode || barcode || '')}"></label>
      <button class="btn primary block" id="cf-go" style="margin-top:12px">${food ? 'Save changes' : 'Save food'}</button>
      ${food ? '<button class="btn danger block" id="cf-del" style="margin-top:8px">Delete food</button>' : ''}`,
  });
  const b = sheet.body;
  $('#cf-go', b).onclick = () => {
    const num = (id) => { const v = parseQty($(id, b).value); return Number.isFinite(v) && v >= 0 ? v : 0; };
    const name = $('#cf-name', b).value.trim();
    if (!name) return toast('Give the food a name.');
    const n = { kcal: num('#cf-kcal'), p: num('#cf-p'), c: num('#cf-c'), f: num('#cf-f'), fib: num('#cf-fib') };
    if (!$('#cf-kcal', b).value.trim()) n.kcal = n.p * 4 + n.c * 4 + n.f * 9;
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
          </button>`;
      }).join('') : '<div class="empty">Save foods you eat often with ☆, create your own from a nutrition label, or build a recipe from its ingredients.</div>'}
    </section>`;
  $('#new-food', view).onclick = () => openCreateFood({});
  $('#new-recipe', view).onclick = () => openRecipe();
  $$('[data-i]', view).forEach((b) => (b.onclick = () => {
    const f = db.myFoods[+b.dataset.i];
    if (f.custom) openFoodActions(f);
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
      <p class="muted small" style="margin:12px 0 0">${Object.keys(db.log).length} days logged · ${db.myFoods.length} saved foods</p>
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

// ---------------------------------------------------------------- boot

render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js');
}
