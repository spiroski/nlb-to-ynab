import {
  DEFAULT_OPTIONS, asText, sourceFromRows, combineSources, makeCsv, csvFilename,
} from './core.js';

const $ = (id) => document.getElementById(id);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 20;
const STORAGE_KEY = 'bank-to-ynab-options-v1';

const persistentKeys = ['cleanPayees', 'feeTreatment', 'deduplicate', 'dateOrder'];
function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return Object.fromEntries(persistentKeys.filter((k) => Object.hasOwn(saved, k)).map((k) => [k, saved[k]]));
  } catch { return {}; }
}
function savePreferences() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(persistentKeys.map((k) => [k, options[k]]))));
  } catch { /* local preferences are optional */ }
}

let options = { ...DEFAULT_OPTIONS, ...loadPreferences() };
let sources = [];
let lastResult = null;
let previewLimit = 35;
let busy = false;
let selectedMappingId = '';
let errorMessage = '';

const fileInput = $('fileInput');
const dropzone = $('dropzone');
const previewBody = $('previewBody');
const formatMoney = (minorUnits, currency = '') => {
  const n = minorUnits / 100;
  const text = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  return currency ? `${text} ${currency}` : text;
};
const localDate = (iso) => iso ? iso.split('-').reverse().join('.') : '—';

function setBanner(message = '', type = 'info') {
  const banner = $('banner');
  banner.textContent = message;
  banner.className = `banner ${type}`;
  banner.hidden = !message;
}

function syncInputs() {
  $('cleanPayees').checked = !!options.cleanPayees;
  $('deduplicate').checked = !!options.deduplicate;
  $('feeTreatment').value = options.feeTreatment;
  $('dateOrder').value = options.dateOrder;
  $('fromDate').value = options.fromDate;
  $('toDate').value = options.toDate;
}

function toRows(workbook, sheetName) {
  return window.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1, defval: '', blankrows: true, raw: true,
  });
}

async function parseFile(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} exceeds the 20 MB limit.`);
  if (!/\.(xls|xlsx|csv)$/i.test(file.name)) throw new Error(`Unsupported file: ${file.name}. Use .xls, .xlsx or .csv.`);
  const arrayBuffer = await file.arrayBuffer();
  // Excel/CSV bytes remain in this browser tab only.
  const workbook = window.XLSX.read(new Uint8Array(arrayBuffer), { type: 'array', cellDates: true });
  if (!workbook.SheetNames?.length) throw new Error(`${file.name} does not contain any worksheets.`);
  const candidates = workbook.SheetNames.map((name) => {
    const rows = toRows(workbook, name);
    return rows.some((row) => row?.some((cell) => asText(cell)))
      ? { name, rows, detected: sourceFromRows(rows, file.name, name) }
      : null;
  }).filter(Boolean);
  if (!candidates.length) throw new Error(`${file.name} contains no populated worksheets.`);
  const chosen = candidates.find((x) => x.detected.kind === 'nlb')
    || candidates.find((x) => x.detected.columns.date >= 0 && x.detected.columns.payee >= 0)
    || candidates[0];
  const source = chosen.detected;
  source.sheetChoices = candidates.map(({name, rows}) => ({name, rows}));
  source.displaySize = file.size;
  return source;
}

function updateBusy(value) {
  busy = value;
  $('browseButton').disabled = value;
  $('downloadButton').disabled = value || !lastResult?.transactions?.length || lastResult.issues.some((x) => x.severity === 'error');
  $('browseButton').textContent = value ? 'Reading files…' : 'Choose bank files';
  dropzone.setAttribute('aria-busy', String(value));
}

async function addFiles(files) {
  if (busy) return;
  if (!files.length) return;
  if (!window.XLSX) {
    setBanner('The Excel reader could not load. Check your internet connection, or deploy the GitHub Pages workflow to self-host the reader.', 'error');
    return;
  }
  errorMessage = '';
  setBanner('');
  updateBusy(true);
  const accepted = [...files];
  if (sources.length + accepted.length > MAX_FILES) {
    setBanner(`You can combine up to ${MAX_FILES} statement files at a time.`, 'error');
    updateBusy(false);
    return;
  }
  const failed = [];
  // Process sequentially to avoid large memory spikes on mobile devices.
  for (const file of accepted) {
    try { sources.push(await parseFile(file)); }
    catch (err) { failed.push(`${file.name}: ${err.message}`); }
  }
  if (failed.length) errorMessage = failed.join(' ');
  selectedMappingId = sources.find((s) => s.kind === 'generic')?.id || '';
  previewLimit = 35;
  updateBusy(false);
  render();
}

function node(tag, className = '', text = '') {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function renderFiles() {
  const list = $('fileList');
  list.replaceChildren();
  $('filesPanel').hidden = sources.length === 0;
  for (const source of sources) {
    const line = node('li', 'file-item');
    const icon = node('span', 'file-icon', 'XLS');
    icon.setAttribute('aria-hidden', 'true');
    const main = node('div', 'file-main');
    const title = node('strong', 'file-title', source.filename);
    const small = node('span', 'file-subtitle', `${source.profileName} · ${source.sheetName} · ${(source.displaySize / 1024).toFixed(0)} KB`);
    main.append(title, small);
    const remove = node('button', 'remove-file', 'Remove');
    remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${source.filename}`);
    remove.addEventListener('click', () => {
      sources = sources.filter((x) => x.id !== source.id);
      if (selectedMappingId === source.id) selectedMappingId = sources.find((s) => s.kind === 'generic')?.id || '';
      render();
    });
    line.append(icon, main, remove);
    list.append(line);
  }
  $('filesCount').textContent = `${sources.length} file${sources.length === 1 ? '' : 's'} added`;
}

function makeSelect(id, values, currentValue, onChange) {
  const select = node('select', 'form-control');
  select.id = id;
  for (const [value, label] of values) {
    const op = new Option(label, String(value));
    select.append(op);
  }
  select.value = String(currentValue);
  select.addEventListener('change', (e) => onChange(e.target.value));
  return select;
}

function renderMapping() {
  const generic = sources.filter((s) => s.kind === 'generic');
  $('mappingPanel').hidden = generic.length === 0;
  if (!generic.length) return;
  const source = generic.find((s) => s.id === selectedMappingId) || generic[0];
  selectedMappingId = source.id;
  const active = $('mappingFilePicker');
  active.replaceChildren();
  for (const item of generic) active.append(new Option(item.filename, item.id));
  active.value = source.id;
  $('mappingFilePickerWrap').hidden = generic.length < 2;
  $('mappingSheetPickerWrap').hidden = source.sheetChoices.length < 2;
  const sheets = $('mappingSheetPicker');
  sheets.replaceChildren();
  for (const x of source.sheetChoices) sheets.append(new Option(x.name, x.name));
  sheets.value = source.sheetName;
  const rows = source.rows;
  const headerOptions = rows.slice(0, Math.min(40, rows.length)).map((r, i) => [i, `Row ${i + 1}: ${(r || []).map(asText).filter(Boolean).slice(0, 3).join(' · ').slice(0, 78) || '—'}`]);
  const headerContainer = $('headerRowSelectWrap');
  headerContainer.replaceChildren(makeSelect('headerRowSelect', headerOptions, source.headerIndex, (v) => {
    source.headerIndex = Number(v);
    source.startIndex = source.headerIndex + ($('hasHeader').checked ? 1 : 0);
    render();
  }));
  $('hasHeader').checked = source.hasHeader !== false;
  $('mappingMode').value = source.mode;
  $('mappingExplanation').textContent = `Detected a non-NLB layout. Choose which columns contain the transactions in ${source.filename}.`;

  const header = rows[source.headerIndex] || [];
  const width = Math.min(Math.max(header.length, ...rows.slice(source.startIndex, source.startIndex + 6).map((r) => r?.length || 0)), 120);
  const columnNames = [[-1, 'Not used']];
  for (let c = 0; c < width; c++) {
    const letter = columnLetter(c);
    const sample = asText(header[c]) || asText(rows[source.startIndex]?.[c]) || '';
    columnNames.push([c, `${letter} — ${sample.slice(0, 50) || '(empty)'}`]);
  }
  const mappingFields = $('mappingFields');
  mappingFields.replaceChildren();
  const fields = source.mode === 'signed' ? ['date','payee','memo','amount','fee','balance'] : ['date','payee','memo','outflow','inflow','fee','balance'];
  const labels = {date:'Date *',payee:'Payee *',memo:'Memo',amount:'Signed amount *',outflow:'Outflow / debit',inflow:'Inflow / credit',fee:'Bank fee',balance:'Running balance'};
  for (const field of fields) {
    const wrap = node('label', 'mapping-field');
    const name = node('span', 'field-label', labels[field]);
    wrap.append(name, makeSelect(`map-${field}`, columnNames, source.columns[field], (v) => {
      source.columns[field] = Number(v);
      renderResult();
    }));
    mappingFields.append(wrap);
  }
}

function columnLetter(index) {
  let n = index + 1; let out = '';
  while (n > 0) { n--; out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26); }
  return out;
}

function renderResult() {
  lastResult = sources.length ? combineSources(sources, options) : null;
  const result = lastResult;
  const hasFiles = !!sources.length;
  $('resultPanel').hidden = !hasFiles;
  $('emptyState').hidden = hasFiles;
  $('settingsPanel').hidden = !hasFiles;
  if (!hasFiles) { setBanner(''); $('downloadButton').disabled = true; return; }

  $('totalCount').textContent = String(result.transactions.length);
  $('totalOutflow').textContent = formatMoney(result.outflowCents, result.currency);
  $('totalInflow').textContent = formatMoney(result.inflowCents, result.currency);
  $('netChange').textContent = formatMoney(result.inflowCents - result.outflowCents, result.currency);
  $('dateRange').textContent = result.dateStart ? `${localDate(result.dateStart)} — ${localDate(result.dateEnd)}` : 'No dates in selection';
  $('dedupInfo').textContent = result.duplicates ? `${result.duplicates} overlapping entr${result.duplicates === 1 ? 'y' : 'ies'} removed` : 'No overlapping entries';
  const checks = result.details.filter((d) => d.source.kind === 'nlb');
  const totalChecked = checks.reduce((s, d) => s + d.checked, 0);
  const totalChecks = checks.reduce((s, d) => s + d.checks, 0);
  $('balanceCheck').textContent = totalChecks
    ? (totalChecked === totalChecks ? `All ${totalChecks} balance transitions verified` : `${totalChecks - totalChecked} balance differences found`)
    : 'Balance check not available for this layout';
  $('balanceCheck').className = `result-footnote ${totalChecks && totalChecked !== totalChecks ? 'is-warning' : ''}`;
  const balanceIcon = $('balanceStatusIcon');
  balanceIcon.textContent = totalChecks ? (totalChecked === totalChecks ? '✓' : '!') : 'i';
  balanceIcon.className = `validation-check ${!totalChecks ? 'is-neutral' : (totalChecked !== totalChecks ? 'is-error' : '')}`;
  $('accountNote').textContent = result.accountId
    ? `Detected bank account ending in ${result.accountId.replace(/\D/g, '').slice(-4)}. Import into the matching YNAB account${result.currency ? ` (${result.currency})` : ''}.`
    : 'Confirm that every uploaded file belongs to the same bank account and currency.';

  const errors = result.issues.filter((x) => x.severity === 'error');
  const warnings = result.issues.filter((x) => x.severity === 'warning');
  const issues = $('issues');
  issues.replaceChildren();
  issues.hidden = !errors.length && !warnings.length;
  if (errors.length || warnings.length) {
    const heading = node('strong', '', `${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);
    issues.append(heading);
    const ul = node('ul', 'issue-list');
    for (const issue of result.issues.slice(0, 12)) {
      ul.append(node('li', '', `${issue.severity === 'error' ? 'Check' : 'Note'}${issue.file ? ` · ${issue.file}` : ''}${issue.row ? `, row ${issue.row}` : ''}: ${issue.message}`));
    }
    if (result.issues.length > 12) ul.append(node('li', '', `…and ${result.issues.length - 12} more.`));
    issues.append(ul);
  }
  if (errorMessage) setBanner(errorMessage, 'error');
  else if (errors.length) setBanner('Review and resolve the problems below before exporting. No CSV has been generated.', 'error');
  else if (!result.transactions.length) setBanner('No transactions match this selection. Adjust your date range or column mapping.', 'warning');
  else if (warnings.length) setBanner('Converted with warnings. Review the notes and preview before importing into YNAB.', 'warning');
  else setBanner('Your statement is ready for YNAB. Review the transactions and download the CSV.', 'success');

  const canDownload = !!result.transactions.length && !errors.length;
  $('downloadButton').disabled = busy || !canDownload;
  $('downloadLabel').textContent = canDownload ? `Download YNAB CSV (${result.transactions.length})` : 'Download YNAB CSV';
  renderPreview(result.transactions, result.currency);
}

function renderPreview(transactions, currency) {
  previewBody.replaceChildren();
  for (const t of transactions.slice(0, previewLimit)) {
    const tr = node('tr');
    tr.append(node('td', 'date-col', localDate(t.date)));
    const payee = node('td', 'payee-col');
    payee.append(node('strong', 'payee-text', t.payee));
    if (t.fee) payee.append(node('span', 'fee-tag', 'Bank fee'));
    tr.append(payee);
    tr.append(node('td', 'memo-col', t.memo || '—'));
    tr.append(node('td', 'num-col outflow', t.outflowCents ? formatMoney(t.outflowCents) : '—'));
    tr.append(node('td', 'num-col inflow', t.inflowCents ? formatMoney(t.inflowCents) : '—'));
    previewBody.append(tr);
  }
  $('previewMore').hidden = transactions.length <= previewLimit;
  $('previewMore').textContent = `Show more (${Math.min(50, transactions.length - previewLimit)} of ${transactions.length - previewLimit} remaining)`;
  $('previewCaption').textContent = `${transactions.length} transactions · amounts in ${currency || 'your account currency'} · earliest first`;
  $('previewEmpty').hidden = transactions.length > 0;
  $('previewTableWrap').hidden = transactions.length === 0;
}

function render() {
  syncInputs();
  renderFiles();
  renderMapping();
  renderResult();
}

function downloadResult() {
  if (busy || !lastResult || !lastResult.transactions.length || lastResult.issues.some((x) => x.severity === 'error')) return;
  const csv = makeCsv(lastResult.transactions);
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = csvFilename(lastResult);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  $('downloadHelp').textContent = 'CSV created locally. In YNAB, open the matching account and drag in the downloaded file.';
}

// Drop zone: keyboard and native file selection.
$('browseButton').addEventListener('click', () => fileInput.click());
$('addMoreButton').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (event) => {
  addFiles(event.target.files);
  event.target.value = '';
});
for (const kind of ['dragenter', 'dragover']) {
  dropzone.addEventListener(kind, (event) => { event.preventDefault(); dropzone.classList.add('dragging'); });
}
for (const kind of ['dragleave', 'drop']) {
  dropzone.addEventListener(kind, (event) => { event.preventDefault(); dropzone.classList.remove('dragging'); });
}
dropzone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
dropzone.addEventListener('keydown', (event) => {
  if (event.target !== dropzone) return;
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); }
});

$('clearButton').addEventListener('click', () => {
  sources = []; selectedMappingId = ''; errorMessage = ''; previewLimit = 35;
  options.fromDate = ''; options.toDate = '';
  render();
});
$('downloadButton').addEventListener('click', downloadResult);
$('previewMore').addEventListener('click', () => { previewLimit += 50; renderPreview(lastResult.transactions, lastResult.currency); });
for (const id of ['cleanPayees', 'deduplicate']) {
  $(id).addEventListener('change', (event) => { options[id] = event.target.checked; savePreferences(); renderResult(); });
}
for (const id of ['feeTreatment', 'dateOrder', 'fromDate', 'toDate']) {
  $(id).addEventListener('change', (event) => {
    options[id] = event.target.value;
    if (persistentKeys.includes(id)) savePreferences();
    renderResult();
  });
}
$('resetDates').addEventListener('click', () => {
  options.fromDate = ''; options.toDate = ''; syncInputs(); renderResult();
});
$('mappingMode').addEventListener('change', (event) => {
  const source = sources.find((s) => s.id === selectedMappingId);
  if (!source) return;
  source.mode = event.target.value;
  renderMapping(); renderResult();
});
$('hasHeader').addEventListener('change', (event) => {
  const source = sources.find((s) => s.id === selectedMappingId);
  if (!source) return;
  source.hasHeader = event.target.checked;
  source.startIndex = source.headerIndex + (source.hasHeader ? 1 : 0);
  renderResult();
});
$('mappingFilePicker').addEventListener('change', (event) => { selectedMappingId = event.target.value; renderMapping(); });
$('mappingSheetPicker').addEventListener('change', (event) => {
  const index = sources.findIndex((s) => s.id === selectedMappingId);
  if (index < 0) return;
  const old = sources[index];
  const choice = old.sheetChoices.find((s) => s.name === event.target.value);
  if (!choice) return;
  const fresh = sourceFromRows(choice.rows, old.filename, choice.name);
  fresh.sheetChoices = old.sheetChoices;
  fresh.displaySize = old.displaySize;
  sources[index] = fresh;
  selectedMappingId = fresh.id;
  render();
});

render();
