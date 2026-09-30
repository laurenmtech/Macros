# Macros

A MyFitnessPal-style macro tracker built as an installable web app (PWA). No build step, no backend.

- **Diary**: Breakfast / Lunch / Dinner / Snacks, calories remaining, and protein/carbs/fat vs goals. Swipe left or right to change days; "Copy from yesterday" on empty meals.
- **Food search**: 7,793 USDA generic foods are built in (`data/usda-foods.json`) and work offline. Brand and restaurant items come from the USDA FoodData Central API.
- **Barcode scan**: Open Food Facts, with a USDA branded-foods fallback. Uses native `BarcodeDetector` where available (Android Chrome) and bundled ZXing elsewhere (iPhone).
- **Quick add**, **custom foods** (with optional barcode), **saved foods**, and 7/30-day **trends**.
- **Recipes**: build a batch from weighed ingredients under My foods, then log it by the gram (soup) or by the piece (egg cups).
- Data lives in `localStorage` on the device. Back it up with Goals → Export.

## Run locally

    python3 -m http.server 8765    # then open http://localhost:8765

Home-screen install and the camera need HTTPS, so host it (for example on GitHub Pages) to use it on a phone.

## Rebuild data and icons

    python3 scripts/build-foods.py <FoodData_Central_sr_legacy_food_csv dir>
    python3 scripts/build-icons.py

After changing any app file, bump `CACHE` in `sw.js` so installed copies pick up the update.
