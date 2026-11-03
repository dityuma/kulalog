# Kulalog

Offline-first PWA for keeping a care and growth log of land tortoises, made for Indonesia's tortoise keeping community. Everything stays on the device (IndexedDB) and the app works without internet after the first visit.

## Run it locally

```bash
npm run serve
```

Open http://localhost:8080/. `localhost` counts as a secure context, so the service worker and "Install app" work there.

## Project layout

| Path | What it is |
| --- | --- |
| `index.html`, `css/app.css` | Page and styles |
| `js/logic.js` | Pure data logic (number parsing, units, dates, growth rate, care records, migration, backup checks, CSV). Also loaded by the unit tests |
| `js/app.js` | UI, IndexedDB storage, dialogs, export/import, service worker registration |
| `sw.js` | Service worker: precaches the app; caches Chart.js and the Google Fonts files too (best effort, 10 s limit, retried on a later visit) |
| `manifest.webmanifest`, `kulalog-icons/` | Web app manifest and icons. The manifest's "any" icons are `icon-any-*` (the artwork without its square background, made from `icon.svg`), so Android's launch screen shows the tortoise straight on `background_color`; maskable icons keep the square for launchers |
| `serve.js` | Zero-dependency static server for local testing |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |

## Releasing a change

The service worker serves the app from its cache first. **After changing any app file, raise `VERSION` in `sw.js`** (e.g. `v8` to `v9`). Installed copies then download the new version in the background and show "A new version of Kulalog is ready. Reload".

All paths are relative, so the folder can be hosted as-is on GitHub Pages or any static host (only the app files are needed, not `node_modules` or `tests`).

### GitHub Pages

The site is served from the `main` branch, folder `/ (root)` (repo Settings → Pages → Deploy from a branch), at `https://<user>.github.io/kulalog/`. To publish a change: raise `VERSION` in `sw.js`, commit and push to `main`; Pages redeploys in a minute or two.

## Data compatibility

The app keeps the prototype's storage: IndexedDB database `kulalog` (stores `tortoises`, `entries`) and localStorage key `kulalog-settings`. Old records without a `kind` are migrated automatically. Backups are JSON files (`app: "kulalog", version: 1`); a backup copied with the prototype's "Copy backup" button can be pasted into a `.json` or `.txt` file and imported.

Backups are shared between keepers, so every imported record is checked (`cleanTortoise` / `cleanEntry` in `js/logic.js`): ids, real dates, image data URLs, numbers within range (up to 1000 cm and 1000 kg), text lengths. Records already in storage go through the same checks at start-up; a record that fails is left in storage but not shown.

Numbers can be typed with a decimal comma or dot and with thousands separators (`1.234,5`, `1,234.5`, `1 234`). A single mark is always the decimal mark, so `1.250` means 1.25.

## Tests

All browser tests run in the installed **Google Chrome** (Playwright `channel: "chrome"`, Lighthouse via chrome-launcher), on a desktop window and on Chrome's Pixel 7 emulation.

```bash
npm install
npm test
```

| Command | What it covers |
| --- | --- |
| `npm run test:unit` | Vitest (220 tests): number parsing incl. thousands separators, weight units, growth per month, one care record per day, migration, backup checks against hostile files, CSV, dates |
| `npm run test:e2e` | Playwright (94 tests x desktop + Pixel 7): add tortoise, daily care, measurements, 7-day/monthly views, backup round trip, CSV, offline, installability, persistence across reload and browser restart, persistent storage, update flow (incl. several tabs), dark mode, hostile backups and stored data (security), slow or unreachable CDN, failing storage, midnight rollover |
| `npm run test:lighthouse` | Lighthouse (mobile + desktop, plus populated screens, dialogs and dark mode). Fails under a11y 95, best practices 95, SEO 90, performance 80. Reports in `tests/lighthouse/reports/` |

Notes:
- Playwright starts `serve.js` on port 8090 itself (or reuses one already running).
- Lighthouse 12 no longer has a PWA category; installability is checked through Chrome's own `Page.getInstallabilityErrors` in both the Playwright and the Lighthouse runs.
- Most browser tests need internet for the Chart.js and Google Fonts CDNs; the security and storage tests block the CDN themselves.
- Persistent-profile tests keep their Chrome profiles in a short temp folder: deep paths under `test-results/` exceed the Windows 260-character limit and break the service worker cache.
