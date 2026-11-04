# Live audit — deployment, privacy, performance

Every number here was measured on **2026-11-04** against
<https://row-data-converter.vercel.app/> (URL A). Nothing in this file is estimated.

Deployed commit: **`18d5cec`** (`git rev-parse --short HEAD` at the time of the runs).

---

## 1. Green build

| Check | Command | Result |
| --- | --- | --- |
| Typecheck (incl. tests) | `npm run typecheck` | exit 0, no output |
| Lint | `npm run lint` | **0 errors**, 1 warning (`react-hooks/incompatible-library` — TanStack's `useReactTable`, a library limitation, not a defect) |
| Tests | `npm test` | **8 files, 66 tests passed**, 8.31 s (Node 22 and Node 24) |
| Build | `npm run build` | exit 0, `dist/` in ~0.7 s |
| Build fails on a type error | added `src/__typecheck_probe.ts` with `const probe: number = "not a number"` | `src/__typecheck_probe.ts(1,14): error TS2322`, `BUILD_EXIT=1` (probe removed afterwards) |

`engines.node` is `22.x`; Vercel and CI both build on Node 22. Async tests previously hung
under Node 22 because pdf.js v6 calls `Promise.try`; `tests/setup-polyfills.ts` supplies it,
which took the suite from 363 s (2 failures) to ~8 s (all green).

## 2. Commits

```
18d5cec Keep the mobile header inside a 390 px viewport
766510a Fix DOCX on the deployed build and make 50 MB files usable
6eea9cf Deployment hardening: CSP, offline shell, Node 22 pin, live-audit harness
c067f0a Fix CI: track samples/dev/server.log
```

All pushed to `origin/main` (`https://github.com/HarshPatil0804/RowData-Converter`). The nested
`RowData-Converter/` clone is gitignored and untracked.

## 3. Build stamp

- `dist/version.json` → `{"hash":"18d5cec","builtAt":"2026-11-04T04:25:42.692Z"}`
- `<meta name="build" content="18d5cec">` in the built `index.html`
- Footer renders `build 18d5cec` (see `docs/screens/01-upload-desktop.png`)
- `curl -I /version.json` → `HTTP/1.1 200`, `Content-Type: application/json; charset=utf-8`,
  `Cache-Control: no-store`

## 4. Which URL serves which commit

| URL | `/version.json` | Hash equals HEAD |
| --- | --- | --- |
| **A** `https://row-data-converter.vercel.app/` | `200` `{"hash":"18d5cec",…}` | **yes** |
| **B** `https://row-data-converter-28tw.vercel.app/` | `404 DEPLOYMENT_NOT_FOUND` | **no — the domain serves nothing** |

B returned `X-Vercel-Error: DEPLOYMENT_NOT_FOUND` for both `/version.json` and `/` (HTTP 404):
it was a per-deployment alias that no longer exists. `index.html`'s canonical/og:image URLs
pointed at B and were corrected to A.

Polling A every 20 s after each push:

```
push 6eea9cf → 09:16:29 attempt 1: {"hash":"6eea9cf",…}  MATCH
push 766510a → 09:53:03 attempt 1: {"hash":"6eea9cf",…}
               09:53:24 attempt 2: {"hash":"766510a",…}  MATCH (40 s)
push 18d5cec → 09:55:30 attempt 1: {"hash":"766510a",…}
               09:55:51 attempt 2: {"hash":"18d5cec",…}  MATCH (21 s)
```

### GitHub side (public API, no token)

- `GET /repos/HarshPatil0804/RowData-Converter/deployments?per_page=3` → `[]` — this repo has
  **no GitHub Deployment records**; Vercel's Git integration here does not create them.
- `GET /repos/…/commits/18d5cec…/status` →
  `state: success`, `context: Vercel`, `description: "Deployment has completed"`,
  `target_url: https://vercel.com/data-analyst9/row-data-converter/DS6fFgfW8DPAKcBYh8oXPHuakrjs`,
  `created_at: 2026-11-04T04:25:42Z`.

So the repository is connected: the project is `data-analyst9/row-data-converter`, its
production alias is A, and the commit status agrees with the served `version.json`.

## 5. Live browser test (Playwright, headless Chrome)

`node e2e/run.mjs --base-url https://row-data-converter.vercel.app --files samples/dev --out e2e-out/live`

21 sample files uploaded, each converted, Tabular → **CSV downloaded**, Pivot → **XLSX
downloaded**:

| File | Time | Rows |
| --- | --- | --- |
| catalog.xml | 498 ms | 4 |
| config.yaml | 422 ms | 2 |
| contact_card.rtf | 434 ms | 6 |
| data_dump.zip | 393 ms | 3 |
| events.ndjson | 398 ms | 5 |
| headerless_data.csv | 398 ms | 4 |
| inventory_table.pdf | 1431 ms | 5 |
| invoice.eml | 417 ms | 1 |
| invoices.txt | 455 ms | 6 |
| legacy.xls | 482 ms | 6 |
| **meeting_notes.docx** | **389 ms** | 3 |
| messy_real_orders.csv | 687 ms | 1000 |
| messy_sales.csv | 424 ms | 12 |
| nested_customers.json | 403 ms | 4 |
| orders.tsv | 446 ms | 5 |
| plain.txt | 436 ms | 3 |
| products.xlsx | 385 ms | 6 |
| report.html | 391 ms | 4 |
| scanned_table.png (OCR) | 4620 ms | 4 |
| server.log | 403 ms | 10 |
| app_settings.txt | 4179 ms | 3 |

- Date toggle: `Dates: auto` → pipeline re-run → result in **29 ms**.
- Dark mode: `false → true` on click.
- 390 px mobile viewport: conversion ok, **horizontal overflow 0 px**.
- Console errors **0**, failed requests **0**, 4xx/5xx responses **0**.

### Defect this run found and fixed

`meeting_notes.docx` failed on the live site with
`Could not read DOCX file: Could not find file in options` even though the test suite was green:
mammoth's **browser** build reads `options.arrayBuffer`, its **Node** build reads
`options.buffer`, and the suite only exercises the Node path. `src/pipeline/extract/docx.ts`
now passes both. Re-verified in a real browser worker (local production build) and then live:
`Word table · 3 rows × 3 columns`, 389 ms.

## 6. Privacy proof

`node e2e/run.mjs --mode privacy --files samples/dev` — every request after load is recorded
for one file of each input type, then browser storage is inspected.

| Input | Converted | Requests observed |
| --- | --- | --- |
| CSV | 1983 ms | 4 |
| XLSX | 529 ms | 4 |
| PDF | 935 ms | 5 |
| Image (OCR) | 3264 ms | 8 |
| ZIP | 404 ms | 4 |

- **Cross-origin requests: 0** (all were same-origin; the OCR worker, its wasm core and the
  language data are served from `/tess/` and `/tessdata/` on the site itself).
- **File content in storage: 0** findings across `localStorage`, `sessionStorage`, IndexedDB
  and the Cache API. The only cache entries are the service worker's own app-shell assets
  (`/`, `/assets/…`, `/sw.js`, `/tess/…`, `/tessdata/…`).
- Console errors 0, failed requests 0.

### Headers served by A

```
Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none';
  frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval' 'sha256-r7yILH7…';
  worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  font-src 'self' data:; media-src 'self' blob: data:; connect-src 'self'; manifest-src 'self'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(),
  magnetometer=(), gyroscope=()
```

Every feature was re-exercised under the CSP — all five input types, both downloads, the date
toggle, dark mode — with the results above (0 console errors, 0 failed requests). A CSP that
breaks a feature would show up as a console error or a failed request in this run.

`Clear data` (header) empties `localStorage`, `sessionStorage`, IndexedDB and the Cache API and
returns to the upload screen; measured `caches: 1 → 0`, no console errors.

## 7. Performance

50 MB / 500,000-row / 8-column CSV (`e2e-out/perf-50mb.csv`, 52.6 MB):

| Metric | Before | After | On the live site |
| --- | --- | --- | --- |
| Wall time to result | 95,670 ms | 92,931 ms | **81,805 ms** |
| Longest main-thread task | **431 ms** | **67 ms** | **63 ms** |
| Tasks over 200 ms | **2** | **0** | **0** |
| Peak JS heap | 179 MB | 134 MB | 135 MB |
| Rows × columns | 500,000 × 8 | 500,000 × 8 | 500,000 × 8 |

Three changes took the long tasks out of the main thread:

1. The preview card computed a **full pivot of every row** just to print three axis labels
   (`computePivot` was discarded). Only `suggestPivot` runs now.
2. Rows come back from the worker in **50,000-row slices** instead of one message, so the
   structured-clone cost no longer lands as a single task.
3. The source `File` is re-read on demand instead of being copied up front, removing a
   synchronous 52 MB `slice(0)` and half the peak heap.

First-load JavaScript (gzipped, measured with `zlib.gzipSync` over `dist/`):

| Asset | Raw | Gzip | Loaded |
| --- | --- | --- | --- |
| `index-*.js` | 648.8 kB | **198.8 kB** | first load |
| `index-*.css` | 31.7 kB | 7.0 kB | first load |
| `index.html` | 3.0 kB | 1.1 kB | first load |
| `pipeline.worker-*.js` | 1,265.6 kB | 389.1 kB | first conversion only |
| `pdf.worker.min-*.mjs` | 1,264.3 kB | 367.7 kB | first PDF only |

First-load JS is **198.8 kB gzipped** (budget 300 kB). The parsers were already worker-only
chunks created on demand — no change was needed, and the numbers above are the measured
before/after state rather than an improvement claim.

Guard rails added for files the browser cannot finish in reasonable time:

- **Cancel** during processing disposes the worker and returns to upload (verified: processing →
  upload, 0 console errors).
- A per-file limit of 200 MB with a readable message
  (“is too large (X MB; this browser build handles up to 200 MB per file). Split it…”).

Lighthouse 12 (desktop preset, headless Chrome, 2026-11-04):

| Category | Score | Target |
| --- | --- | --- |
| Performance | **100** | 90+ |
| Accessibility | **98** | 95+ |
| Best practices | **100** | 95+ |
| SEO | **92** | 90+ |

FCP 0.4 s · LCP 0.4 s · TBT 0 ms · CLS 0.

## 8. Sharing, docs, CI

- `index.html`: `og:title`, `og:description`, `og:image` (1200×630, `public/og.png`),
  `og:image:width/height`, `twitter:card` (`summary_large_image`), `twitter:title/description/image`,
  `canonical`, an SVG favicon, `theme-color`, and a `<noscript>` fallback.
- `docs/screens/`: 9 PNGs (desktop upload/preview/tabular/needs-review/pivot/dark, mobile
  upload/preview/tabular), captured from the live site by `e2e/screens.mjs`.
- `.github/workflows/ci.yml`: on push/PR — `npm ci`, `lint`, `typecheck`, `vitest`, `build`, a
  build-stamp check (`dist/version.json` + `<meta name="build">`); then, when the repository
  variable `LIVE_URL` is set, a job that polls the live `/version.json` for 10 minutes and
  **fails if it does not equal the pushed commit**, followed by a Playwright smoke test against
  the deployed URL (`--limit 3`, fails on any console error or failed request).
