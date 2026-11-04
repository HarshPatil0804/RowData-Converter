# Live audit — deployment, parity, privacy, performance

Every number here was measured on **2026-11-04** against
<https://row-data-converter.vercel.app/>. Nothing is estimated.

Deployed commit: **`84f0c73`** (`git rev-parse --short HEAD` when the runs were made).

---

## 1. Green build

| Check | Command | Result |
| --- | --- | --- |
| Typecheck (incl. tests) | `npm run typecheck` | exit 0, no output |
| Lint | `npm run lint` | **0 errors**, 1 warning (`react-hooks/incompatible-library` — TanStack's `useReactTable`; library limitation, not a defect) |
| Tests | `npm test` | **11 files, 70 tests passed**, 15.2 s (Node 22 and Node 24) |
| Build | `npm run build` | exit 0, `dist/` in ~0.7 s |
| Build fails on a type error | added `src/__typecheck_probe.ts` with `const probe: number = "not a number"` | `src/__typecheck_probe.ts(1,14): error TS2322`, `BUILD_EXIT=1` (probe removed) |

`engines.node` is `22.x`; Vercel and CI both build on Node 22. Async tests previously hung under
Node 22 because pdf.js v6 calls `Promise.try`; `tests/setup-polyfills.ts` supplies it (363 s with 2
failures → ~8 s green).

## 2. Commits

```
84f0c73 Test the build we ship, and make the service worker safe
1e67b20 Document the measured audit and gate CI on the live commit
18d5cec Keep the mobile header inside a 390 px viewport
766510a Fix DOCX on the deployed build and make 50 MB files usable
6eea9cf Deployment hardening: CSP, offline shell, Node 22 pin, live-audit harness
c067f0a Fix CI: track samples/dev/server.log
```

All pushed to `origin/main`. `git status` is clean; the nested `RowData-Converter/` clone is
gitignored.

## 3. Build stamp

- `dist/version.json` → `{"hash":"84f0c73","builtAt":"2026-11-04T05:19:34.115Z"}`
- `<meta name="build" content="84f0c73">` in the built and deployed `index.html`
- Footer renders `build <hash>` (`docs/screens/01-upload-desktop.png` shows the current one)
- `curl -I /version.json` → `200`, `application/json; charset=utf-8`, `Cache-Control: no-store`

## 4. URLs and GitHub

| URL | `/version.json` | Hash equals HEAD |
| --- | --- | --- |
| **A** `https://row-data-converter.vercel.app/` | `200` `{"hash":"84f0c73",…}` | **yes** |
| **B** `…-28tw.vercel.app` (obsolete) | `404 DEPLOYMENT_NOT_FOUND` | not a deployment — ignore it |

Polling A every 20 s after each push:

```
push 766510a → 09:53:03 {"hash":"6eea9cf",…} · 09:53:24 {"hash":"766510a",…}  MATCH (40 s)
push 18d5cec → 09:55:30 {"hash":"766510a",…} · 09:55:51 {"hash":"18d5cec",…}  MATCH (21 s)
push 1e67b20 → 10:04:23 {"hash":"18d5cec",…} · 10:04:44 {"hash":"1e67b20",…}  MATCH (21 s)
push 84f0c73 → 10:49:23 {"hash":"1e67b20",…} · 10:49:44 {"hash":"84f0c73",…}  MATCH (21 s)
```

Public GitHub API (no token): `/deployments` returns `[]` — this repository has no GitHub
Deployment records. `/commits/<sha>/status` reports `state: success`, `context: Vercel`,
`description: "Deployment has completed"`, `target_url:
https://vercel.com/data-analyst9/row-data-converter/…`. The project is
`data-analyst9/row-data-converter`, whose production alias is A.

## 5. Live browser test — content, not just downloads

`node e2e/run.mjs --base-url https://row-data-converter.vercel.app --files samples/dev --out e2e-out/live`

All 22 files in `samples/dev` are uploaded; each must convert, export CSV (Tabular) and XLSX
(Pivot). Every row is also checked against `e2e/expected.json`: the row count, the column count
and three specific cells per file (first cell, a middle cell, the last cell).

| File | Time | Rows | CSV | Pivot XLSX | Content check |
| --- | --- | --- | --- | --- | --- |
| app_settings.txt | 3090 ms | 3 | yes | yes | pass |
| catalog.xml | 426 ms | 4 | yes | yes | pass |
| config.yaml | 386 ms | 2 | yes | yes | pass |
| contact_card.rtf | 407 ms | 6 | yes | yes | pass |
| data_dump.zip | 406 ms | 3 | yes | yes | pass |
| events.ndjson | 402 ms | 5 | yes | yes | pass |
| headerless_data.csv | 409 ms | 4 | yes | yes | pass |
| inventory_table.pdf | 405 ms | 5 | yes | yes | pass |
| invoice.eml | 788 ms | 1 | yes | yes | pass |
| invoices.txt | 381 ms | 6 | yes | yes | pass |
| legacy.xls | 383 ms | 6 | yes | yes | pass |
| meeting_notes.docx | 387 ms | 3 | yes | yes | pass |
| messy_real_orders.csv | 698 ms | 1000 | yes | yes | pass |
| messy_sales.csv | 383 ms | 12 | yes | yes | pass |
| nested_customers.json | 408 ms | 4 | yes | yes | pass |
| orders.tsv | 393 ms | 5 | yes | yes | pass |
| plain.txt | 437 ms | 3 | yes | yes | pass |
| products.xlsx | 386 ms | 6 | yes | yes | pass |
| readme.md | 392 ms | 4 | yes | yes | pass |
| report.html | 383 ms | 4 | yes | yes | pass |
| scanned_table.png (OCR) | 3765 ms | 4 | yes | yes | pass |
| server.log | 413 ms | 10 | yes | yes | pass |

Totals: **22/22 converted, 0 content mismatches, 0 console errors, 0 failed requests, 0 4xx/5xx,
0 cross-origin requests**. Mobile 390 px pass (its own run, recorded separately):
converted, content pass, horizontal overflow **0 px**.

### Reconciling the old "22 vs 21"

The previous audit said "22/22" while its table listed 21 files, because two things were counted
together:

| Source | Count |
| --- | --- |
| Files in `samples/dev` | **22** (21 samples + `readme.md`) |
| Converted by the old e2e | 21 — `readme.md` was filtered out |
| Old report rows | 22 — the 390 px mobile pass appended a duplicate of `headerless_data.csv` |
| **Now** | 22 converted in the desktop pass, mobile pass recorded under `mobile` only |

### Defect this run found and fixed

`meeting_notes.docx` failed live with `Could not read DOCX file: Could not find file in options`
while the suite was green: mammoth's **browser** build reads `options.arrayBuffer`, its **Node**
build reads `options.buffer`. `src/pipeline/extract/docx.ts` now passes both.

### Proving the e2e can fail

Reverting that fix (`{ buffer }` only), rebuilding and running the harness on `meeting_notes.docx`:

```
→ meeting_notes.docx ... FAILED: could not be processed meeting_notes.docx — Could not read DOCX
  file: Could not find file in options …
HARNESS FAILED: Error: could not be processed …
E2E_EXIT=1
```

With the fix restored, the same command reports `files converted: 1/1`, `content mismatches: 0`,
`E2E_EXIT=0`.

## 5b. Browser parity suite

`tests/parity.test.ts` closes the gap that hid that bug: for every sample it runs the pipeline
in-process (Node), then uploads the same file to the **production bundle** (`vite preview` →
`dist/`) in headless Chromium, downloads the app's CSV and compares it **byte for byte**.

```
✓ tests/parity.test.ts (1 test) 13318ms
  ✓ every sample exports exactly what the Node pipeline computes
Test Files  1 passed (1)      Tests  1 passed (1)
```

It immediately found a second, unreported divergence of its own: **`products.xlsx` exported
`2024-04-02T00:00:10` in the browser but `2024-04-02` in Node**. The workbook cell is
`45384.22928240741` — a date-time in the author's timezone — so SheetJS's Date conversion shifted
with the machine offset. `src/pipeline/extract/spreadsheet.ts` now decides date vs date-time from
the cell's rendered text (`cell.w`) instead of a timezone-dependent `Date`, and both environments
agree.

The suite runs in CI, before any deploy.

## 5c. Date toggle — values, not speed

`tests/date-toggle.test.ts` asserts behaviour the earlier "re-run in 31 ms" check never proved:

| Fixture | Toggle | `05-03-2024` |
| --- | --- | --- |
| `05-03-2024`, `07-03-2024` (nothing proves the order) | auto | `05-03-2024` kept, 2 rows flagged `date_ambiguous` |
| same | DM | **2024-03-05** |
| same | MD | **2024-05-03** |
| `18-03-2024`, `05-03-2024` (18 > 12 proves DD-MM) | auto / DM / MD | **2024-03-05 in all three**, 0 ambiguous |

```
✓ tests/date-toggle.test.ts (2 tests) 19ms
```

The live toggle is still timed for the report (32 ms on the current build), but the correctness
claim now rests on those assertions.

## 6. Privacy proof

`node e2e/run.mjs --mode privacy --files samples/dev`, run against `84f0c73`:

| Input | Converted | Requests observed |
| --- | --- | --- |
| CSV | 2535 ms | 4 |
| XLSX | 424 ms | 4 |
| PDF | 411 ms | 5 |
| Image (OCR) | 4044 ms | 8 |
| ZIP | 407 ms | 4 |

- **Cross-origin requests: 0** — the OCR worker, its wasm core and the language data come from
  `/tess/` and `/tessdata/` on the site itself.
- **File content in storage: 0** across `localStorage`, `sessionStorage`, IndexedDB and the Cache
  API. The only cache entries are the service worker's own app assets.
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

Every feature above was exercised under that CSP in the same run. `Clear data` empties
`localStorage`, `sessionStorage`, IndexedDB and the Cache API and returns to upload (measured
`caches: 1 → 0`, no console errors).

## 6b. Service worker

**Why it exists:** the production site registered a service worker but shipped no `/sw.js`, so
every visit logged `404 /sw.js`. It also makes the app open with no network.

Policy (`public/sw.js`):

| Request | Behaviour |
| --- | --- |
| Navigations | network first with `cache: 'no-store'`; cached copy only as the offline fallback |
| `/version.json` | never intercepted |
| `/assets/`, `/tess/`, `/tessdata/` | cache first (content hashed or engine versioned) |
| `blob:`, `data:`, other origins, other paths | untouched |

Precaching reads `dist/assets.json`, written by the build, because on a first visit the worker
cannot intercept the requests that load its own bundles.

**Proof** — `tests/sw-update.test.ts` serves a real build over HTTP:

```
✓ tests/sw-update.test.ts (1 test) 1560ms
```

It asserts: the worker controls the page; the cache contains only app assets and nothing with a
`blob:`/`data:` URL; with the socket destroyed the app still renders (offline fallback); after the
served build is swapped for one with hash `beefbee`, **one reload shows `beefbee`**; and
`/version.json` returns the new hash rather than a cached copy.

## 7. Performance

50 MB / 500,000-row / 8-column CSV, live site:

| Metric | Before the fixes | Live at `18d5cec` | Live at `84f0c73` |
| --- | --- | --- | --- |
| Wall time to result | 95,670 ms | 81,805 ms | **77,153 ms** |
| Longest main-thread task | **431 ms** | 63 ms | **70 ms** |
| Tasks over 200 ms | **2** | 0 | **0** |
| Peak JS heap | 179 MB | 135 MB | **125 MB** |
| Rows × columns | 500,000 × 8 | same | same |

Three changes removed the long tasks: the preview card no longer computes a full pivot of every
row to print three labels; rows stream from the worker in 50,000-row slices; and the source `File`
is re-read on demand instead of copied.

First-load JavaScript (gzipped, `zlib.gzipSync` over `dist/`): `index-*.js` **198.8 kB**, CSS
7.0 kB, HTML 1.1 kB. The parsers live in worker chunks fetched on first use
(`pipeline.worker` 389.1 kB, `pdf.worker.min` 367.7 kB gzip).

Cancel during processing disposes the worker and returns to upload (verified: processing → upload,
0 console errors). Files over 200 MB are refused with a readable message.

## 8. Lighthouse

Desktop preset:

| Category | Score |
| --- | --- |
| Performance | 100 |
| Accessibility | 98 |
| Best practices | 100 |
| SEO | 92 |

Mobile preset — before the Gate 1 fixes: performance **95**, accessibility **98**, best practices
**100**, SEO **92**.

Mobile preset — after fixing heading order, two accessible-name mismatches and adding a valid
`robots.txt` (live, `84f0c73`):

| Category | Score | Change |
| --- | --- | --- |
| Performance | **98** | +3 |
| Accessibility | **100** | +2 |
| Best practices | **100** | — |
| SEO | **100** | +8 |

FCP 1.8 s · LCP 1.8 s · TBT 0 ms · CLS 0.

## 9. Sharing, docs, CI

- `index.html`: `og:title`, `og:description`, `og:image` (1200×630 `public/og.png`),
  `twitter:card`, `canonical`, SVG favicon, `theme-color`, `<noscript>` fallback.
- `docs/screens/`: 9 PNGs (desktop upload/preview/tabular/needs-review/pivot/dark; mobile
  upload/preview/tabular), captured from the live site by `e2e/screens.mjs`.
- `.github/workflows/ci.yml`:
  - `checks`: `npm ci`, lint, typecheck, **build**, build-stamp check, then `npm test` — which
    includes the parity suite (production bundle in Chrome) and the service-worker suite.
  - `verify-deploy`: when `LIVE_URL` is **unset** it now emits
    `::warning title=LIVE_URL is not set::…` instead of skipping silently; when set, it polls the
    live `/version.json` for 10 minutes, fails on a hash mismatch, then runs the content e2e
    (22 files, row counts and cells) against the deployed URL.
