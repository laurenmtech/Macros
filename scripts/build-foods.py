"""Build data/usda-foods.json from the USDA SR Legacy CSV export.

Usage: python3 scripts/build-foods.py <path-to-FoodData_Central_sr_legacy_food_csv dir>
Download: https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip
"""
import csv, json, sys, os
from collections import defaultdict

src = sys.argv[1]
out = os.path.join(os.path.dirname(__file__), '..', 'data', 'usda-foods.json')
rd = lambda f: csv.DictReader(open(os.path.join(src, f), encoding='utf-8'))

WANT = {'1008': 'kcal', '1003': 'p', '1005': 'c', '1004': 'f', '1079': 'fib'}
nut = defaultdict(dict)
for r in rd('food_nutrient.csv'):
    k = WANT.get(r['nutrient_id'])
    if k: nut[r['fdc_id']][k] = float(r['amount'] or 0)

units = {r['id']: r['name'] for r in rd('measure_unit.csv')}
portions = defaultdict(list)
for r in rd('food_portion.csv'):
    g = float(r['gram_weight'] or 0)
    if g <= 0: continue
    amt = float(r['amount'] or 1)
    amt_s = ('%g' % amt)
    unit = units.get(r['measure_unit_id'], '')
    if unit == 'undetermined': unit = ''
    label = ' '.join(x for x in [amt_s, unit, r['modifier'].strip()] if x)
    portions[r['fdc_id']].append((int(r['seq_num'] or 0), label, round(g / amt, 2) if amt else g, amt))

rows = []
for r in rd('food.csv'):
    n = nut.get(r['fdc_id'])
    if not n or 'kcal' not in n: continue
    # portion: [label for one unit, grams per unit]; labels normalised to "1 x"
    ps = []
    for _, label, g_per, amt in sorted(portions[r['fdc_id']]):
        if amt != 1:
            label = label.split(' ', 1)[1] if ' ' in label else label
            label = f'1 {label}' if not label[0].isdigit() else label
        if label not in {x[0] for x in ps}: ps.append([label, g_per])
    rows.append([int(r['fdc_id']), r['description'],
                 *[round(n.get(k, 0), 1) for k in ('kcal', 'p', 'c', 'f', 'fib')], ps])

os.makedirs(os.path.dirname(out), exist_ok=True)
json.dump(rows, open(out, 'w'), separators=(',', ':'))
print(len(rows), 'foods ->', out, os.path.getsize(out) // 1024, 'KB')
