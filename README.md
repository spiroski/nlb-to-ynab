# Bank → YNAB — private static CSV converter

Convert NLB Bank Macedonia transaction statements (`.xls`, like the bank's **RetTransactions** export) into a CSV that YNAB can import. It also accepts `.xlsx` and `.csv` using an editable column mapping for unfamiliar bank formats.

**Everything related to reading and converting financial statements runs in your browser.** There is no backend, bank connection, database, analytics, API token, or upload endpoint. No statement files are included in this repository. The deployed GitHub Pages site self-hosts all code, including its Excel parser.

## Deploy on GitHub Pages (recommended)

1. Create a GitHub repository, for example `bank-to-ynab`, and upload the **contents** of this project (including `.github/workflows/deploy.yml`). Never commit actual bank statements.
2. Make `main` the default branch.
3. Open your repository's **Settings → Pages → Build and deployment → Source**, choose **GitHub Actions**.
4. Go to **Actions**, run **Deploy private bank-to-YNAB converter** if it hasn't already run, and open the URL shown after deployment. The URL is usually `https://YOUR-USERNAME.github.io/bank-to-ynab/`.

The workflow has no build tools or servers. On each push to `main`, it downloads a pinned SheetJS Community Edition browser library, copies the four site files into `_site`, changes the script tag to load the library from the same GitHub Pages origin, and publishes the site. **Your bank statements are never involved in this workflow.** A browser visiting the deployed site receives static files from GitHub Pages; selecting bank files does not send them over the network.

> GitHub Pages sites can be publicly accessible even for private repositories. That is fine for this converter's *code*, but **never commit financial exports or any other private data** to the repository.

## Using the converter

1. Export your transactions from NLB as Excel (`.xls`). Select or drop one or more files from the **same bank account**.
2. The NLB layout is recognized automatically (date, recipient, purpose, outgoing, incoming, fee, balance). For other bank layouts, map the columns displayed on screen.
3. Review the preview. The app verifies NLB running balances and flags invalid amounts or unreconciled movements. The standard fee behavior creates a separate transaction for each fee.
4. Optionally choose a date range, change merchant cleanup, or change the fee handling.
5. Click **Download YNAB CSV**. In the YNAB web app (or on an iPad), open the corresponding account and use **File-Based Import** / drag the CSV in.

The output has these **exact five columns**:

```csv
Date,Payee,Memo,Outflow,Inflow
2026-11-18,"WOLT","",1425.00,
2026-11-17,"Example employer","Salary",,32000.00
```

YNAB should recognize the columns automatically. Dates use unambiguous ISO `YYYY-MM-DD`, amounts use `.` for decimals and no thousands separators, text is UTF-8 with a BOM (to preserve Macedonian/Cyrillic names). There is **no currency column**, so choose the matching YNAB account, which must use the appropriate currency.

YNAB's import currently supports **Date, Payee, Memo, Outflow, and Inflow**, but not category or split-transaction assignments from CSV. You can classify transactions in YNAB. Internal transfers may need to be marked as transfers after import. See [YNAB's file import guide](https://support.ynab.com/en_us/file-based-import-a-guide-Bkj4Sszyo).

## NLB-specific handling

- Detects the Macedonian title/header pair, including **Задолжување** (outflow), **Побарување** (inflow), **Провизија** (fee), and **Состојба** (running balance).
- Ignores the interleaved bank-account/reference detail rows and the footer, rather than treating them as transactions.
- Reads dot-thousands / comma-decimal amounts such as `1.425,00`, including deposits/refunds.
- Conditionally shortens card-merchant names separated by wide spaces, e.g. `SKOPJE           WOLT` → `WOLT`, without changing actual payment values.
- Uses bank fees as separate outflows by default, so importing the statement can reconcile accurately. Alternatively, add a fee to its outgoing transaction or omit it deliberately.
- Validates adjacent running balances (both newest-first and oldest-first report variants). If there is a discrepancy, download is disabled instead of silently producing an incomplete CSV.
- Combines overlapping exports with occurrence-aware duplicate removal: if two identical payments happen in the **same** statement they are both kept; if they repeat across exported periods, only the repeated copy is removed. This is based on date/payee/memo/amount (no bank transaction ID in the example file), so **manually review genuine identical transactions when combining files**.
- Prevents combining files when different NLB bank account identifiers or currencies are detected. Bank account numbers are only used in browser memory for this check, never written to CSV.

## Privacy and security

- Only HTML, CSS, and JavaScript are executed on the user device; every file is read via the browser's File API.
- All computations, previews, and CSV generation happen locally. No `fetch`/XHR, remote transaction API, cookies, telemetry, or external fonts.
- Both the **GitHub Actions deployment** and the **local npm build** serve SheetJS from `vendor/` on the same origin. Content Security Policy blocks outgoing `connect` requests.
- When opened directly from the repository files or served from a branch without the supplied workflow, the page loads the pinned SheetJS script from `cdn.sheetjs.com`. That request fetches *code only*, not bank data, but third-party scripts can technically access browser data.
- `localStorage` only persists preferences (fee behavior, duplicate removal, merchant cleanup, date order); it never stores account numbers, transactions, filenames, or uploaded files.
- The GitHub Pages **web host sees normal page requests** (IP address, timing, etc.); the claim is specifically that this tool does not upload or process the bank file server-side. **YNAB itself** will receive transactions when *you* upload the generated CSV to YNAB.
- Always inspect your import preview and reconcile the final YNAB balance. This is a personal convenience tool, not financial advice.

## Local development

Use Node.js v20+ and npm. The project uses Node.js built-in modules for its local tooling, so you can run the commands directly after checkout.

```bash
npm start
```

Open <http://127.0.0.1:8000>. `npm start` and `npm run run` both build and serve the converter. Press Ctrl+C to stop the server. Set `PORT` to use a different port, for example `PORT=3000 npm start`.

You can also build, serve, or test separately.

```bash
npm run build  # Assemble the static site in _site/
npm run serve  # Serve the existing _site/ bundle
npm test       # Run the transaction conversion tests
```

The first build downloads and verifies the pinned SheetJS library. Subsequent builds reuse the verified copy in `_site/`, and the browser loads it from the local server. Run `npm run build` again and refresh the page after editing the source files.

## Files

- `index.html` — page and UI structure
- `styles.css` — responsive styles, no external assets
- `app.js` — file input, workbook parsing via SheetJS, interaction and download
- `core.js` — transaction mapping, money parsing, validation, deduplication, CSV output (tested as a standalone module)
- `scripts/site.mjs` — npm build and local HTTP server
- `tests/core.test.mjs` — automated behavioral tests with synthetic (non-private) transaction data
- `.github/workflows/deploy.yml` — self-hosted, static GitHub Pages deployment

## External library and license

[SheetJS Community Edition v0.20.3](https://docs.sheetjs.com/docs/getting-started/installation/standalone/) is used for **reading** `.xls`, `.xlsx`, and `.csv` client-side. It is distributed by SheetJS under the [Apache-2.0 license](https://www.apache.org/licenses/LICENSE-2.0). Refer to the upstream license and notices when redistributing its code. The converter's original code is MIT-licensed (see `LICENSE`).
