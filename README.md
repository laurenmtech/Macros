# Ironbyte

A macro tracker and workout log built as an installable web app (PWA). No build step, no backend.

**Open it:** https://laurenmtech.github.io/ironbyte/ — on iPhone, tap Share → Add to Home Screen; on Android, ⋮ → Add to Home screen.

- **Diary**: Breakfast / Lunch / Dinner / Snacks, calories remaining, and protein/carbs/fat vs goals. Swipe left or right to change days; "Copy from yesterday" on empty meals.
- **Food search**: 7,793 USDA generic foods are built in (`data/usda-foods.json`) and work offline. Brand and restaurant items come from the USDA FoodData Central API.
- **Barcode scan**: Open Food Facts, with a USDA branded-foods fallback. Uses native `BarcodeDetector` where available (Android Chrome) and bundled ZXing elsewhere (iPhone).
- **Quick add**, **custom foods** (with optional barcode), **saved foods**, and 7/30-day **trends** (the Trends button on the Diary).
- **Recipes**: build a batch from weighed ingredients under My foods, then log it by the gram (soup) or by the piece (egg cups).
- **Sharing**: send any food or recipe in My foods as a link. The food is packed into the link itself, so nothing is uploaded; the other person opens it or pastes it under My foods → Import.
- **Workouts**: a logger with a built-in exercise library (plus your own exercises), routines, supersets and a rest timer. Each set shows what you did last time, and finishing a routine can update it with today's weights. Tracks weight × reps, reps only, or time, in lb or kg (Goals → Workouts).
- Data lives in `localStorage` on the device. Back it up with Goals → Export.

## Run locally

    python3 -m http.server 8765    # then open http://localhost:8765

Home-screen install and the camera need HTTPS, so use the hosted copy on a phone. It deploys to GitHub Pages from `main`.

## Rebuild data and icons

    python3 scripts/build-foods.py <FoodData_Central_sr_legacy_food_csv dir>
    python3 scripts/build-icons.py

After changing any app file, bump `CACHE` in `sw.js` so installed copies pick up the update.
