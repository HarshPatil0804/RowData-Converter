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
| `npm run hostile` | Regenerate the hostile corpus in `tests/hostile/` |
| `npm run prepare:assets` | Refresh OCR engine + language data into `public/` |
| `npm run deps:check` | Fail if the production dependency tree differs from `security/allowed-deps.json` |
| `npm run deps:record` | Re-record the reviewed dependency inventory |
| `npm run audit:prod` | `npm audit --omit=dev --audit-level=high` |
| `npm run scan:dist` | Fail on any unjustified origin or network call in `dist/` |
| `npm run verify-live` | Compare the deployed files with `dist/` byte for byte |

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

Eleven suites, 70 tests:

| Suite | Covers |
| --- | --- |
| `tests/hospital.test.ts` | **Acceptance suite** — R1–R10 and P1–P9 against `samples/hospital/raw.csv` |
| `tests/parity.test.ts` | **Production bundle parity** — every sample through `vite preview` in headless Chromium, CSV compared byte for byte with the Node pipeline |
| `tests/sw-update.test.ts` | Service worker: offline fallback works, a new build appears after one reload, the cache holds app assets only |
| `tests/date-toggle.test.ts` | R3 toggle: ambiguous dates really change, dates proven by the data do not |
| `tests/pipeline.test.ts` | Every sample file converts to a clean table automatically |
| `tests/ocr.test.ts` | Scanned-image OCR → reconstructed table |
| `tests/pivot.test.ts` | Auto-suggestion and all five aggregations |
| `tests/export.test.ts` | CSV / JSON / XLSX round-trips through real parsers |
| `tests/offline.test.ts` | No external origins in source or in the built entry HTML |
| `tests/fuzz/accuracy.test.ts` | Randomised datasets through a generator/injector harness: parse what was injected, clean what was dirtied, without over-cleaning what was already clean |
| `tests/fuzz/smoke.test.ts` | The fuzz entries themselves stay tractable |
| `tests/helpers.ts` | Shared sample-loading fixtures |

`tests/parity.test.ts` exists because the unit tests run in Node while production runs
in a browser worker, and that gap hid a live defect: mammoth's **browser** build reads
`options.arrayBuffer` while its **Node** build reads `options.buffer`, so every `.docx` failed on the
deployed site with a green suite. The parity suite now runs each sample through the built bundle
and fails on a single differing byte.

### Dependencies with separate browser and Node builds

Vite resolves the `browser`/`module` entries, Vitest and Node resolve `main`/`exports`. Any
package that branches on the environment is a place where the two can disagree:

| Package | Node build (tests) | Browser build (deployed) | Consequence |
| --- | --- | --- | --- |
| `mammoth` | `lib/unzip.js` — reads `options.buffer` | `browser/unzip.js` — reads `options.arrayBuffer` | Every `.docx` failed live; `src/pipeline/extract/docx.ts` now supplies both keys |
| `jszip` | `lib/index.js` with `readable-stream` shim | `dist/jszip.min.js` | ZIP extraction is only proven in the browser by the parity suite |
| `papaparse` | `papaparse.js` | `papaparse.min.js` | Same parser, minified |
| `pdfjs-dist` | `build/pdf.mjs`, with `fs`, `canvas`, `http`, `url` available | the same modules mapped to `false` | pdf.js takes its fetch/canvas path in the worker; `pdf.worker.min.mjs` is precached |
| `tesseract.js` | `src/worker/node/index.js` | `src/worker/browser/index.js` | The OCR unit test runs in the Node environment; the browser worker path is covered by the live run |
| `xlsx` | `xlsx.js` (CommonJS, `crypto` available) | `xlsx.mjs` (`crypto`, `fs`, `buffer`, `stream` disabled) | Date cells: the reader now decides date vs date-time from the cell's rendered text instead of a timezone-dependent `Date` |
| `react-dom` | `server.js` | `server.browser.js` | `server.*` is not imported at runtime |

Neither build is "the" build — they are different code paths for the same feature, which is why
every input type is exercised in the browser before a deploy.

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

To turn on the deploy gate, add one repository variable — **Settings → Secrets and variables →
Actions → Variables → New repository variable**, name `LIVE_URL`,
value `https://row-data-converter.vercel.app`. While it is unset the `verify-deploy` job still
runs and posts a `LIVE_URL is not set` warning annotation, so a skipped deploy check is visible
in the Actions summary instead of looking like a pass.

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

### Threat model

This is a local data tool. It is built so that a hostile *file* is the only thing
that can attack it, and so that the person using it can verify the privacy claim
instead of trusting it.

**What it protects against**

| Threat | Defence |
| --- | --- |
| The file being uploaded to a server | There is no server. The app is static files; every parser runs in this tab or in a Web Worker, and `connect-src 'self'` plus the dist scan (`npm run scan:dist`) refuse and detect any call out. |
| A file executing script in the page (XSS via CSV/XLSX/HTML/SVG/DOCX) | Cell values are rendered as React text nodes only; the project bans `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` and `javascript:` URLs in ESLint, and the CSP additionally requires Trusted Types. `tests/hostile-browser.test.ts` uploads 30 hostile files to the built app in Chrome with a canary: no script may run. |
| A formula in a cell running in Excel / Sheets | Text columns are neutralised on export (`'=`, `'+`, `'-`, `'@`, tab, CR) unless *Spreadsheet-safe export* is turned off; XLSX text is written as string cells, never as formulas. |
| Zip bombs, billion laughs, XXE, 10 000-deep nesting, 50 MB lines, 1 M columns | Explicit limits, checked from the file header where possible, with a readable message instead of a frozen tab — see [Limits](#limits). |
| ReDoS in the cleaning heuristics | The regex-driven heuristics only run on text under `heuristicChars` (2 MB) and use no nested quantifiers. |
| A poisoned dependency or a modified deploy | `npm ci --ignore-scripts`, a reviewed production inventory, an audit gate, a pinned-action CI, and a published SHA-256 manifest of every deployed file (`npm run verify-live`). |
| A filename that lies about itself (`invoice\u202Ecod.exe`) | Download names are NFKC-normalised, stripped of path separators, control characters, bidi overrides and zero-width characters, and length-capped. |

**What it cannot protect against**

- **A compromised device.** Malware, a malicious browser extension, or someone with
  access to the machine can read the file, the tab, and the download.
- **The downloaded file itself.** Once you download a CSV or XLSX, the spreadsheet
  application that opens it is outside this app's control. That is why the export
  neutralises formulas and why the in-app notice tells you to delete the download on a
  shared computer.
- **A compromised or malicious deployment.** The integrity manifest proves the files
  are the ones this repository built; it cannot prove the repository is honest. Build
  it yourself if that matters — see [Maximum privacy mode](#maximum-privacy-mode).
- **Denial of service by the operating system.** Limits stop a browser tab from
  freezing; they do not stop a 200 MB file from being slow to read off disk.
- **Your own typing.** Anything you paste into the app is in this tab, and in the
  clipboard history of the machine.

### Limits

Measured from the file itself where possible (ZIP central directory, image header)
before any expensive work starts. Each limit throws a message written for a person,
and the app shows it verbatim. The numbers live in one place, `src/pipeline/limits.ts`.

| Limit | Value | Where |
| --- | --- | --- |
| One file | 200 MB | UI + pipeline |
| Uncompressed archive contents (all members) | 300 MB | `extract/archive.ts` |
| Archive compression ratio | 200:1 | `extract/archive.ts` |
| Files in one archive | 2 000 | `extract/archive.ts` |
| Archives inside archives | 3 | `extract/archive.ts` |
| JSON/object nesting depth | 256 | `limits.ts` (`maxJsonDepth`) |
| XML element depth | 256 | `limits.ts` (`maxXmlDepth`) |
| Longest single line | 2 MB | `limits.ts` (`assertLineLengths`) |
| Columns | 4 096 | `limits.ts` |
| Rows | 2 000 000 | `limits.ts` |
| Image pixels before OCR | 40 MP | `limits.ts` (`imageSize`, header only) |
| Text handed to the regex heuristics | 2 MB | `limits.ts` |
| DOCTYPE / entity declarations | refused outright | `limits.ts` (`assertNoDoctypeEntities`) |

The corpus that exercises these lives in `tests/hostile/` and is regenerated by
`npm run hostile` (no downloads): XSS payloads in every text format, prototype-polluting
keys, XXE and billion-laughs XML, a zip bomb, 10 000 archive entries, a deeply nested
archive, 10 000-deep JSON and XML, a 50 MB single line, a 1 M-column CSV, ReDoS strings,
a 100 MP image, and RTL/control-character filenames.

### Rendering safety

There is no raw-HTML sink in `src/` — grep for `dangerouslySetInnerHTML`, `innerHTML`,
`outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` or `srcdoc`
and the only hits are the lint rules that ban them. File text reaches the DOM as a React
text node, so markup in a cell is shown, never parsed. The lint rules are errors, so CI
fails on the first reintroduction.

The CSP in `vercel.json` sends `require-trusted-types-for 'script'; trusted-types u2s-worker`
with the **document** (and every path the SPA rewrite can serve). It was kept only after the
full browser suite passed with it. Turning it on initially broke the app in a way worth
recording: `new Worker(url)` and `serviceWorker.register(url)` refuse a plain string under
this policy, so both now mint their URL through one narrow policy (`src/lib/trusted.ts`)
that only produces same-origin `.js`/`.mjs` URLs. The conversion worker is emitted with
Vite's `?worker&url` so its filename is known before the policy mints it.

The two engine paths (`assets/`, `tess/`, `tessdata/`) are served the same CSP **without**
the Trusted Types directives. That is deliberate and is the one place the policy cannot
reach: `tess/worker.min.js` is a third-party worker script that calls `importScripts()`
from a plain string inside its *own* global, where no policy of ours exists — and the
engine owns that code. The document, which is where an injected string would become markup
or a script, is fully covered; a script URL inside the OCR engine is already constrained by
`script-src 'self'` and `worker-src 'self' blob:`.

One consequence for the engines: tesseract.js normally re-wraps its worker script in a
`blob:` URL; `workerBlobURL: false` uses the same-origin, service-worker-cached
`/tess/worker.min.js` instead.

### Spreadsheet-safe export

CSV and XLSX exports neutralise spreadsheet formulas by default: a cell in a **text**
column that starts with `=`, `+`, `-`, `@`, tab or CR is prefixed with a single quote.
Numeric and date columns are left untouched, so `-2+3` in an amount column stays a
number. XLSX text is always written as a string cell, never as a formula, so
`=HYPERLINK("https://x","y")`, `=cmd|' /C calc'!A0`, `@SUM(1+1)`, `+1+1` and `-2+3` all
arrive as literal text. The Quality Report states how many cells were neutralised.

**Trade-off:** a text cell that genuinely begins with `-` or `+` gains a leading quote in
Excel-compatible tools. Turn *Spreadsheet-safe export* off in the output panel when the
file is not going to a spreadsheet.

### Dependency and supply-chain gates

| Gate | Command | What it proves |
| --- | --- | --- |
| Install without scripts | `npm ci --ignore-scripts` | no dependency's install hook is needed to build or test |
| Reviewed inventory | `npm run deps:check` | every production package and version matches `security/allowed-deps.json`, and every install script is listed |
| Audit | `npm run audit:prod` | no high or critical advisory in production dependencies |
| Bundle scan | `npm run scan:dist` | every origin and every `fetch`/XHR/`sendBeacon`/`WebSocket`/`EventSource` in `dist/` is justified in `security/dist-baseline.json` |

The production tree is 64 packages (13 direct, 51 transitive) and exactly one runtime
package declares an install script (`tesseract.js`'s `opencollective-postinstall`, which is
never needed: the OCR assets are committed under `public/`). `npm audit --omit=dev` reports
one **moderate** advisory (`fast-xml-parser` XMLBuilder comment injection, GHSA-gh4j-gqv2-49f6);
the app only *parses* XML and never builds it, and the audit gate fails on high and critical.

`security/dist-baseline.json` rewrites the review, not the other way round: adding a
dependency or a call site fails CI until a person writes down why it is safe.

### Integrity and the live check

`npm run build` writes two extra files into `dist/`:

- `integrity.json` — SHA-256 of every shipped file (sorted, stable);
- `version.json` — `{ hash, builtAt, integrity }`, where `hash` is the commit and
  `integrity` is the SHA-256 of `integrity.json`.

Two clean builds of the same commit produce byte-identical `dist/` output except
`version.json`, whose `builtAt` is the only timestamp in the build. That reproducibility
is checked in CI on every run.

`npm run verify-live` downloads `version.json`, `integrity.json` and every listed file
from the deployed site, and fails unless the commit matches `HEAD` and every byte matches
the manifest. CI runs it after each push and retries while the deploy is still rolling out.

### Maximum privacy mode

1. `git clone <this repository>` and `cd` into it.
2. `npm ci`
3. `npm run build`
4. `npm run preview`
5. **Disconnect the network.**

The page keeps working: nothing it needs is on the internet. No server, no account, no
analytics. Every claim in this README can then be checked against the files on your disk
without a single request leaving the machine.

### Service worker policy

`public/sw.js` exists because the deployed site registered a service worker but shipped no
`sw.js`, which logged a `404 /sw.js` on every visit. It is deliberately narrow:

| Request | Policy |
| --- | --- |
| Navigations (`index.html`) | network first, `cache: 'no-store'`; the cached copy is only the offline fallback — a new deploy is live on the next reload |
| `/version.json` | never intercepted, so the build stamp is always the live commit |
| `/assets/`, `/tess/`, `/tessdata/` | cache first — those names are content hashed or engine versioned, so a cached copy cannot go stale |
| `blob:`, `data:`, other origins, every other path | untouched |

The shell and every hashed bundle are precached at install from `dist/assets.json` (written by
the build), because the first page load's asset requests happen before the worker can control
them. `tests/sw-update.test.ts` proves the whole policy: it serves a build, kills the network and
reloads (the app must still render), swaps in a second build and reloads (the new hash must
appear), and asserts the cache contains only app assets — never file content.

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