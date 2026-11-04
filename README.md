# Unstructured → Structured

A fully automated web app that turns **any file** into clean, structured data — then lets you
download it as a normal table or as a pivot table.

Upload a file, and the pipeline runs with **zero manual steps** until you reach the choice
screen. Nothing is uploaded anywhere: every byte is processed locally in your browser with
client-side JavaScript and WebAssembly.

> **No backend.** No servers, no API routes, no database. The build output is a folder of
> static files that runs from GitHub Pages, Netlify, S3, or `file://`.

**Live site:** <https://row-data-converter.vercel.app/> · the footer shows `build <git short
hash>` and `/version.json` returns the same hash with `Cache-Control: no-store`, so you can
always tell which commit is being served.

---

## Screens

| Upload | Preview → choose |
| --- | --- |
| ![Upload](docs/screens/01-upload-desktop.png) | ![Preview](docs/screens/02-preview-desktop.png) |

| Tabular | Pivot table |
| --- | --- |
| ![Tabular](docs/screens/03-tabular-desktop.png) | ![Pivot](docs/screens/05-pivot-desktop.png) |

| Needs review | Dark mode |
| --- | --- |
| ![Needs review](docs/screens/04-needs-review-desktop.png) | ![Dark mode](docs/screens/06-tabular-dark-desktop.png) |

| Mobile upload (390 px) | Mobile tabular |
| --- | --- |
| ![Mobile upload](docs/screens/07-upload-mobile.png) | ![Mobile tabular](docs/screens/09-tabular-mobile.png) |

All screenshots are captured from the live site by `node e2e/screens.mjs`; that script also
writes the 1200×630 social card at `public/og.png`.

---

## Supported inputs

Files are auto-detected from the extension, MIME type and magic bytes:

| Category | Formats |
| --- | --- |
| Tabular | CSV, TSV, XLSX, XLS, JSON, NDJSON, XML, YAML |
| Documents | PDF (text + table detection), DOCX, TXT, MD, HTML, RTF |
| Images / scans | PNG, JPG, WEBP (Tesseract.js OCR → table reconstruction) |
| Logs & email | `.log`, `.eml`, key-value text |
| Archives | ZIP — every member is processed recursively |
| Anything else | Falls back to text extraction, then heuristic parsing |

The structuring stage detects delimiters, tables, `key:value` pairs and repeated patterns,
flattens nested JSON/XML into dot-notation columns, and extracts regex entities (dates,
emails, phones, amounts, IDs) from free text.

---

## Quick start

```bash
npm install
npm run dev
```

Open the printed local URL (default <http://localhost:5173>).

`npm install` runs `postinstall`, which copies the OCR engine into `public/tess/`. The
English OCR model (`public/tessdata/eng.traineddata.gz`) ships with the repo; if it is ever
missing, restore it with:

```bash
npm run prepare:assets   # copies the engine + downloads tessdata (network needed once)
```

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Type-check (`tsc -b`) and build `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Run the full Vitest suite once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run typecheck` | TypeScript project build, no emit |
| `npm run lint` | ESLint over the whole project |
| `npm run samples` | Regenerate the messy fixtures in `samples/` |
| `npm run prepare:assets` | Refresh OCR engine + language data into `public/` |

---

## How the pipeline works

Everything runs inside a **Web Worker**, so the UI stays responsive even on a 50 MB file, and
the main thread only renders a progress bar.

```
detect → extract → structure → clean → report → choose → download
```

1. **Detect** — identify the file type and encoding from magic bytes, extension and MIME.
2. **Extract** — pull raw text/tables/records with the right parser (SheetJS, pdf.js,
   mammoth, Tesseract.js, JSZip, DOMParser, …).
3. **Structure** — convert to rows and columns: delimiter/table detection, key:value pairs,
   repeated patterns, entity extraction, nested-JSON/XML flattening.
4. **Clean** — the ten rules R1–R10 below. Outliers and oddities are **flagged, never
   silently deleted**.
5. **Quality report** — rows in/out/rejected, duplicates, nulls and conversions per column,
   ambiguous dates, flag counts, and the R10 reconciliation.

---

## Cleaning rules (R1–R10)

Every rule is generic — no column name is ever special-cased.

| Rule | What it does |
| --- | --- |
| **R1 Junk rows** | Title lines, export-date lines, blank rows, error rows (`ERR_*`, `SYSTEM ALERT`) and summary/total lines are moved to a **Rejected rows** table with a reason — never deleted silently. A total line is read as a control total for R10. |
| **R2 IDs** | A column that is mostly digits with variable prefixes/noise (`#`, `VIS-`, spaces, tags like `DUPLICATE?`) is stripped to the core ID. The untouched original stays in `<col>_raw`, the tag goes to a flag column. |
| **R3 Dates** | Day/month order is inferred **per format pattern** (separator + shape), not per column: if any value of a pattern has part 1 > 12 the pattern is DD-MM, part 2 > 12 makes it MM-DD, and the proven order is applied to that pattern's ambiguous values only. A pattern with no proof sets `date_ambiguous` and is read with the UI toggle (default **DD-MM**) — flipping the toggle re-runs the pipeline instantly. Dates after the file's export date get `date_future`. Output is ISO `YYYY-MM-DD`; `Mar 28 2026` and `17-Apr-2026` styles parse too. |
| **R4 Numbers** | `₹`, `Rs.`, `INR` and Indian grouping (`12,34,567`) parse to numbers. Text inside a numeric column (`"insurance pending"`) becomes `null` in the number and the text moves to `<col>_note`. `N/A`/blank → null. Text never survives in a numeric column. |
| **R5 Packed fields** | `key=value; key=value` cells split into separate columns (`patient_name`, `age`, `city`), and `A / B` or `A - B` cells split into two (`department`, `procedure`) — only when the pattern is consistent in ≥ 80% of cells. |
| **R6 Categories** | Trim, collapse spaces, ignore case, cluster variants and use the most frequent form as canonical. Status-like columns become `UPPER_SNAKE_CASE`; city/department become Title Case. Every before → after change is saved in the report's **Value mappings**. |
| **R7 Placeholders** | `"no extra notes"`, `N/A`, `none`, `-` become null. System-generated text (`SYSTEM NOTE: …`) moves to a `system_flag` column instead of the human notes column. |
| **R8 Duplicates** | After R2, exact duplicates are dropped and logged. Rows sharing an ID but differing in content are both kept with `duplicate_id_conflict = true`. People are never merged by name — repeated names are only counted. |
| **R9 Logic flags** | Flag only, never delete: `fee_on_cancelled_or_noshow`, `scheduled_in_past` (vs the export date), `paid_without_fee`, `age_missing`. |
| **R10 Reconciliation** | When the file has a total line, its value is compared with the sum of the parsed numeric column. Both numbers and the difference appear in the Quality Report (and its CSV/JSON download). |

The pipeline also carries later rules (R11–R18) for spelled-out numbers, multi-item cells,
overlapping categories and blank-row handling; `src/pipeline/rules.ts` is the source of truth.

> Rules R1–R10 are described below; the later ones are additive and never delete rows.

The **Needs review** tab lists every row carrying a flag — ambiguous dates, future dates, id
conflicts, logic flags, system notes — with a per-flag filter. It is a review queue: the clean
data itself is unchanged.

---

## Pivot rules (P1–P9)

| Rule | What it does |
| --- | --- |
| **P1 Order of operations** | The pivot is always built from the **final cleaned dataset** (after R1–R10). Any setting change — including the R3 date toggle — rebuilds it from the new clean data. |
| **P2 Axis check** | Before building, every row/column axis is checked for values that differ only by case, spacing or punctuation; those are re-canonicalised first. A pivot never splits `Paid` / `PAID` / ` paid `. |
| **P3 Empty vs zero** | An empty cell means *no records*; `0` means *records exist and sum to zero*. The **“Show 0 for empty cells”** toggle defaults to off. |
| **P4 Hidden rows** | A banner reports *“N of M rows have no value and are not included in this sum.”* The **Sum + Count** mode adds a second pivot of row counts so hidden rows are visible. |
| **P5 Totals** | One label, **Total**, for both the total row and the total column; in XLSX those cells carry a `total` marker instead of being ordinary values. CSV has an **Include totals** option (default on). Every download is verified first — row totals, column totals and grand total must reconcile or the download is blocked with an error. |
| **P6 Flagged-row share** | When a flag column exists, a banner shows *“31.3% of this total comes from rows flagged: fee_on_cancelled_or_noshow”* with an **Exclude flagged rows** toggle that rebuilds the pivot. |
| **P7 Number format** | The UI shows Indian grouping with 2 decimals; CSV and XLSX carry plain numbers rounded to 2 decimals, with no currency symbols. |
| **P8 Pivot info** | The pivot XLSX ships a **Pivot info** sheet: source file, row field, column field, value field, aggregation, filters applied, rows used, rows excluded (null value), rows excluded (flagged) and the reconciliation result. The CSV stays machine-clean (header + data only). |
| **P9 Default pivot** | Two categorical columns with 3–12 values each are chosen for rows × columns plus a numeric column for the sum; the top **2 suggestions** are shown as one-click buttons. |

---

### Choosing an output

At the choice screen you can switch between **Tabular** (sortable, searchable, filterable
table) and **Pivot** (drag-and-drop rows/columns/values with sum, count, avg, min, max) — and
back again — **without re-uploading**. A sensible default pivot is suggested automatically,
and the **Needs review** tab sits beside them.

The **Dates: DD-MM / MM-DD** button re-runs the whole pipeline on the already-loaded files
whenever you change your mind about ambiguous dates (R3).

Downloads are generated entirely in the browser with `Blob` + `URL.createObjectURL`:

- **Tabular** → CSV, XLSX (multi-sheet: *Clean data*, *Rejected rows*, *Quality report*,
  *Value mappings*), JSON
- **Pivot** → XLSX (*Pivot* + *Pivot info*), CSV (with an *Include totals* option)
- **Quality report** → CSV, JSON

---

## Testing

```bash
npm test
```

Eight suites, 66 tests:

| Suite | Covers |
| --- | --- |
| `tests/hospital.test.ts` | **Acceptance suite** — R1–R10 and P1–P9 against `samples/hospital/raw.csv` |
| `tests/pipeline.test.ts` | Every sample file converts to a clean table automatically |
| `tests/ocr.test.ts` | Scanned-image OCR → reconstructed table |
| `tests/pivot.test.ts` | Auto-suggestion and all five aggregations |
| `tests/export.test.ts` | CSV / JSON / XLSX round-trips through real parsers |
| `tests/offline.test.ts` | No external origins in source or in the built entry HTML |
| `tests/fuzz/accuracy.test.ts` | Randomised datasets through a generator/injector harness: parse what was injected, clean what was dirtied, without over-cleaning what was already clean |
| `tests/fuzz/smoke.test.ts` | The fuzz entries themselves stay tractable |
| `tests/helpers.ts` | Shared sample-loading fixtures |

Correctness is not judged by eyeballing output. The hospital suite pins exact numbers from a
real messy export, and the fuzz suite builds datasets from a known-clean source, injects the
kinds of damage real exports contain (junk rows, mixed date orders, currency noise, packed
cells, duplicates, casing variants), then asserts that every cell that was *not* damaged is
preserved and every cell that *was* is recovered. A rule that fixes one case by breaking
another fails there.

### The hospital regression sample

`samples/hospital/` holds a real messy export used as the regression test for the rules:

| File | What it is |
| --- | --- |
| `raw.csv` | 1001 data lines plus title, export-date, error, alert, blank, `TOTAL …` and `Export generated` junk lines; packed `patient=…; age=…; city=…` and `dept / procedure` cells, `#`/`VIS-` id prefixes, mixed `MM-DD-YYYY` and `DD/MM/YYYY` dates, `N/A` fees, casing variants, duplicates |
| `current_output.csv` | Reference of what the app produced before the patch |
| `current_pivot.csv` | Reference of the pre-patch pivot |

The suite asserts, among others: 999 clean rows and 7 rejected rows with reasons; dash dates
read as MM-DD (`02-12-2025` → `2025-02-12`) while slash dates stay DD/MM (`06/02/2026` →
`2026-02-06`); zero future dates; `fee_inr` 751 numeric / 248 null with 29 `insurance pending`
otes; 15 cities, 8 departments, ≤ 32 department+procedure combinations, 6 statuses and 5
payment statuses in upper case; 27 `system_flag` rows; 228 `fee_on_cancelled_or_noshow`
flags; and a reconciliation of 4 668 696.06 parsed vs 4 287 650.00 reported (difference
381 046.06). The pivot half checks all 30 cells, every row/column total, the 4 668 696.06
grand total, the 248/999 hidden-row banner, the 751 count total, the 31.3% flagged share and
the 3 206 869.46 total after excluding flagged rows.

`npm run samples` regenerates the 22 messy fixtures in `samples/` — a messy CSV, nested JSON,
a PDF with a table, a scanned image, a DOCX, a log file, a ZIP and more, including a
deliberately gnarly real-world export.

> **Note:** `tests/ocr.test.ts` declares `// @vitest-environment node`. Under jsdom,
> tesseract.js treats filesystem paths as URLs and percent-encodes spaces in them, so its
> worker thread cannot load. The OCR test therefore runs in a real Node environment — in the
> browser this problem does not occur because the worker path is a plain same-origin URL.

---

## Build & deploy

```bash
npm run build
```

The output is a self-contained static site in `dist/`. Vite is configured with
`base: './'`, so the app works from any sub-path (e.g. GitHub Pages project sites).

### Vercel

The live site deploys from `main` with `vercel.json`:

- **Build command:** `npm run build` · **Output:** `dist` · **Node:** 22 (`engines.node`)
- SPA fallback rewrite to `/index.html`, except `/version.json`, `/sw.js`, `/assets/`, `/tess/`,
  `/tessdata/`
- `/version.json` served as JSON with `Cache-Control: no-store`
- CSP (`default-src 'self'`), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, and a `Permissions-Policy` that denies camera, microphone and
  geolocation

The build stamps itself: Vite injects the git short hash and ISO timestamp, writes
`dist/version.json`, and adds `<meta name="build">`. After a push, CI polls the live
`/version.json` and **fails if its hash is not the commit that was just built** — so a stale or
un-connected deployment cannot pass silently.

### Netlify

- **Build command:** `npm run build`
- **Publish directory:** `dist`

Or drag-and-drop the `dist/` folder onto Netlify Drop.

### GitHub Pages

```bash
npm run build
# then publish dist/ with your preferred action, e.g. peaceiris/actions-gh-pages,
# or point Pages at a branch containing only the dist/ contents
```

Any other static host works the same way: publish `dist/`, no server required.

---

## Offline & privacy

- Files never leave the device — there is no upload endpoint to leave through.
- After the page loads, the app makes **no network requests**: OCR and PDF engines are
  vendored into `public/`, not loaded from a CDN. `npm test` asserts this.
- The only script that touches the network is `scripts/fetch-ocr-data.mjs`, which runs at
  setup time to restore language data.
- **Clear data** in the header drops the loaded results and empties `localStorage`,
  `sessionStorage`, IndexedDB and the Cache API. Only the light/dark preference is kept.

### Verify the privacy claim yourself

1. Open the live site, then DevTools → **Network**, and clear the list.
2. Convert anything — CSV, XLSX, PDF, an image, a ZIP.
3. Filter the list by **Fetch/XHR** and by **Other** (workers, wasm). Every request is
   same-origin (`row-data-converter.vercel.app`); none carries file bytes. A cross-origin
   request would be visible as a different domain in the *Domain* column.
4. DevTools → **Application** → *Local Storage*, *Session Storage*, *IndexedDB*,
   *Cache Storage*: nothing but the theme key and the service worker's own app-shell assets.

This is measured, not asserted: `node e2e/run.mjs --mode privacy` converts one file of each
input type and fails the run on any cross-origin request or any non-asset entry in browser
storage. The latest run is recorded in `docs/live-audit.md`.

---

## Project layout

```
samples/            Messy fixtures for every supported format
scripts/            Sample generator + OCR asset preparation
public/tess/        Vendored Tesseract engine and worker
public/tessdata/    OCR language data
src/pipeline/       detect → extract → structure → clean
src/worker/         Web Worker entry point and client
src/lib/            Pure helpers: dates, numbers, entities, pivot, export …
src/components/     Dropzone, progress, choice screen, tabular & pivot views
tests/              Vitest suites
```

---

## Troubleshooting

**OCR fails or hangs in tests** — run `npm run prepare:assets` to restore
`public/tessdata/eng.traineddata.gz`, and make sure the test keeps its
`@vitest-environment node` directive.

**A file is rejected** — the app shows a specific error (corrupt archive, unreadable
encoding, no parseable content) rather than failing silently. Try `npm run samples` to
generate a known-good file of the same type.