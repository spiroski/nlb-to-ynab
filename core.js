/**
 * Bank to YNAB: pure, dependency-free normalization and conversion logic.
 * No network, no persistent transaction storage, no server APIs.
 */

export const CSV_HEADER = ['Date', 'Payee', 'Memo', 'Outflow', 'Inflow'];
export const DEFAULT_OPTIONS = Object.freeze({
  cleanPayees: true,
  feeTreatment: 'separate',
  deduplicate: true,
  dateOrder: 'DMY',
  fromDate: '',
  toDate: '',
});

const ZERO = { cents: 0, empty: true };

export function asText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\u00a0/g, ' ').trim();
}

export function decodeEntities(value) {
  return asText(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, code) => {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (code[0] !== '#') return entities[code.toLowerCase()] ?? match;
    const n = code[1].toLowerCase() === 'x'
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    return Number.isInteger(n) && n >= 32 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff)
      ? String.fromCodePoint(n)
      : match;
  });
}

export function normalizeText(value) {
  return decodeEntities(value).replace(/\s+/g, ' ').trim();
}

const CITY_PREFIXES = new Set([
  'SKOPJE', 'СКОПЈЕ', 'OHRID', 'ОХРИД', 'BITOLA', 'БИТОЛА',
  'TETOVO', 'ТЕТОВО', 'PRILEP', 'ПРИЛЕП', 'KUMANOVO', 'КУМАНОВО',
  'STRUGA', 'СТРУГА', 'SHTIP', 'ШТИП',
]);

export function cleanPayee(value, enabled = true) {
  const decoded = decodeEntities(value);
  if (!enabled) return normalizeText(decoded);
  const segments = decoded.split(/\s{3,}/).map(normalizeText).filter(Boolean);
  if (segments.length >= 2 && CITY_PREFIXES.has(segments[0].toUpperCase())) {
    const merchant = segments.slice(1).find((s) => !/^\d{10,}$/.test(s));
    if (merchant) return merchant;
  }
  return normalizeText(decoded);
}

/** Parse numeric Excel cells and EU/US text amounts into integer minor units. */
export function parseMoney(value) {
  if (value === null || value === undefined || asText(value) === '') return ZERO;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { cents: null, error: 'Invalid numeric amount' };
    const cents = Math.round(value * 100);
    return Number.isSafeInteger(cents) ? { cents, empty: false } : { cents: null, error: 'Amount is too large' };
  }
  let s = asText(value).replace(/[\u2212\u2013]/g, '-').replace(/[\s\u00a0\u202f]/g, '');
  if (s === '-' || s === '—') return ZERO;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  s = s.replace(/(?:MKD|EUR|USD|CHF|ден\.?|денари|€|\$)/gi, '');
  if (!/^[\d.,']+$/.test(s) || !/\d/.test(s)) return { cents: null, error: `Unrecognized amount: ${asText(value)}` };
  s = s.replace(/'/g, '');
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  const last = Math.max(comma, dot);
  let normalized;
  if (last < 0) {
    normalized = s;
  } else {
    const decimalLength = s.length - last - 1;
    const thousandsOnly = decimalLength === 3 && s.slice(0, last).replace(/[.,]/g, '').length >= 1;
    const treatDecimal = !thousandsOnly && decimalLength >= 1 && decimalLength <= 2;
    if (treatDecimal) {
      normalized = s.slice(0, last).replace(/[.,]/g, '') + '.' + s.slice(last + 1);
    } else if (thousandsOnly || decimalLength === 0) {
      normalized = s.replace(/[.,]/g, '');
    } else {
      return { cents: null, error: `Ambiguous amount: ${asText(value)}` };
    }
  }
  const n = Number(normalized);
  const cents = Math.round(n * 100) * (neg ? -1 : 1);
  if (!Number.isFinite(cents) || !Number.isSafeInteger(cents)) return { cents: null, error: 'Amount is too large' };
  return { cents, empty: false };
}

function isoFromParts(year, month, day) {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseDate(value, dateOrder = 'DMY') {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return isoFromParts(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number') {
    // Excel serial dates use 1899-12-30 as day zero (1900 leap-year compatibility).
    if (!Number.isFinite(value) || value < 1 || value > 100000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
    return isoFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = asText(value).replace(/[T ]\d{1,2}:\d{2}.*$/, '');
  if (!s) return null;
  const m = s.match(/^(\d{1,4})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  let year; let month; let day;
  if (m[1].length === 4 || dateOrder === 'YMD') {
    year = a; month = b; day = c;
  } else if (dateOrder === 'MDY' && !s.includes('.')) {
    month = a; day = b; year = c;
  } else {
    day = a; month = b; year = c;
  }
  if (year < 100) year += 2000;
  return isoFromParts(year, month, day);
}

const fieldLabels = {
  date: ['date', 'transactiondate', 'bookingdate', 'valuedate', 'postdate', 'datum', 'датум', 'датумнакнижење'],
  payee: ['payee', 'merchant', 'counterparty', 'beneficiary', 'recipient', 'description', 'transactiondescription', 'details', 'narrative', 'називиседиштенапримачот', 'назив', 'опис'],
  memo: ['memo', 'purpose', 'reference', 'notes', 'paymentdetails', 'целнадознаката', 'цел', 'забелешка', 'основ'],
  outflow: ['outflow', 'withdrawal', 'debit', 'debitamount', 'paidout', 'задолжување', 'расход'],
  inflow: ['inflow', 'deposit', 'credit', 'creditamount', 'paidin', 'побарување', 'приход'],
  amount: ['amount', 'transactionamount', 'value', 'sum', 'износ', 'сума'],
  fee: ['fee', 'fees', 'commission', 'bankfee', 'провизија'],
  balance: ['balance', 'runningbalance', 'closingbalance', 'состојба', 'салдо'],
};

function canonical(value) {
  return normalizeText(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function detectHeaders(row) {
  const columns = {};
  let score = 0;
  row.forEach((value, col) => {
    const key = canonical(value);
    if (!key || key.length > 60) return;
    for (const [field, names] of Object.entries(fieldLabels)) {
      if (!names.includes(key) || columns[field] !== undefined) continue;
      columns[field] = col;
      score += field === 'date' ? 4 : (field === 'payee' ? 3 : 1);
    }
  });
  return { columns, score };
}

function findNamedColumn(row, pattern) {
  return row.findIndex((value) => pattern.test(normalizeText(value).toLowerCase()));
}

export function detectNlb(rows) {
  for (let i = 0; i < Math.min(100, rows.length - 1); i++) {
    const h = rows[i] || [];
    if (!h.some((x) => /^датум$/i.test(asText(x)))) continue;
    if (!h.some((x) => /назив и седиште на примачот/i.test(asText(x)))) continue;
    if (!h.some((x) => /провизија/i.test(asText(x)))) continue;
    const sub = rows[i + 1] || [];
    const col = {
      date: findNamedColumn(h, /^датум$/),
      payee: findNamedColumn(h, /^назив и седиште на примачот$/),
      memo: findNamedColumn(h, /^цел на дознаката$/),
      outflow: findNamedColumn(sub, /^задолжување$/),
      inflow: findNamedColumn(sub, /^побарување$/),
      fee: findNamedColumn(h, /^провизија$/),
      balance: findNamedColumn(h, /^состојба$/),
    };
    if (['date','payee','outflow','inflow','fee','balance'].every((key) => col[key] >= 0)) {
      return { headerIndex: i, startIndex: i + 2, columns: col };
    }
  }
  return null;
}

function detectGeneric(rows) {
  let best = { headerIndex: 0, columns: {}, score: -1 };
  for (let i = 0; i < Math.min(80, rows.length); i++) {
    const { columns, score } = detectHeaders(rows[i] || []);
    if (score > best.score) best = { headerIndex: i, columns, score };
  }
  const cols = best.columns;
  return {
    headerIndex: best.headerIndex,
    startIndex: best.headerIndex + 1,
    columns: cols,
    mode: cols.amount !== undefined && !(cols.outflow !== undefined && cols.inflow !== undefined)
      ? 'signed' : 'separate',
  };
}

function findAccountAndCurrency(rows, headerIndex) {
  const all = (rows.slice(0, headerIndex + 1) || []).flat().map(asText);
  const account = all.map((s) => s.match(/\bMK\d{2}[-\d]{12,}(?:MKD|EUR|USD|CHF)?\b/i)).find(Boolean)?.[0] || '';
  const currency = account.match(/(MKD|EUR|USD|CHF)$/i)?.[1]?.toUpperCase() || '';
  return { accountId: account, currency };
}

/** Accept already-decoded worksheet rows, making this module testable without Excel libraries. */
export function sourceFromRows(rows, filename, sheetName = 'Sheet1') {
  if (!Array.isArray(rows) || !rows.length) throw new Error('This worksheet has no rows.');
  const nlb = detectNlb(rows);
  const profile = nlb || detectGeneric(rows);
  const generic = !nlb;
  const { accountId, currency } = nlb ? findAccountAndCurrency(rows, nlb.headerIndex) : {accountId:'',currency:''};
  return {
    id: `${filename}-${sheetName}-${Math.random().toString(36).slice(2, 9)}`,
    filename,
    sheetName,
    kind: nlb ? 'nlb' : 'generic',
    profileName: nlb ? 'NLB Bank Macedonia statement' : 'Custom column mapping',
    rows,
    accountId,
    currency,
    headerIndex: profile.headerIndex,
    startIndex: profile.startIndex,
    columns: { date: -1, payee: -1, memo: -1, amount: -1, outflow: -1, inflow: -1, fee: -1, balance: -1, ...profile.columns },
    mode: nlb ? 'separate' : profile.mode,
  };
}

function readField(row, col) { return col >= 0 ? row[col] : ''; }
function makeIssue(severity, source, index, message) {
  return { severity, file: source.filename, row: index + 1, message };
}

function buildTransaction(raw, source, options, rowIdx) {
  const payee = cleanPayee(raw.payee, options.cleanPayees);
  const rawMemo = normalizeText(raw.memo);
  const rawPayee = normalizeText(raw.payee);
  const memo = rawMemo && rawMemo.toLowerCase() !== rawPayee.toLowerCase() ? rawMemo : '';
  return {
    date: raw.date,
    payee: payee || 'Unknown payee',
    memo,
    outflowCents: Math.max(0, raw.outflowCents),
    inflowCents: Math.max(0, raw.inflowCents),
    sourceId: source.id,
    file: source.filename,
    row: rowIdx + 1,
    fee: false,
  };
}

export function convertSource(source, options = DEFAULT_OPTIONS) {
  const issues = [];
  const transactions = [];
  const sourceEntries = [];
  const cols = source.columns;
  const separate = source.mode !== 'signed';
  if (cols.date < 0 || cols.payee < 0 || (separate ? (cols.outflow < 0 && cols.inflow < 0) : cols.amount < 0)) {
    issues.push(makeIssue('error', source, source.headerIndex, 'Map the date, payee, and amount columns before exporting.'));
    return { transactions, issues, checks: 0, checked: 0, rawCount: 0, feesCount: 0 };
  }
  let rawCount = 0; let feesCount = 0;
  for (let i = source.startIndex; i < source.rows.length; i++) {
    const row = source.rows[i] || [];
    const dateCell = readField(row, cols.date);
    // NLB uses literal DD.MM.YYYY dates. Its footer contains numeric report
    // totals in the date column, which would otherwise resemble Excel dates.
    if (source.kind === 'nlb' && (typeof dateCell !== 'string' || !/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(dateCell.trim()))) continue;
    const date = parseDate(dateCell, options.dateOrder);
    const hasPayee = asText(readField(row, cols.payee)).length > 0;
    if (!date) {
      if (source.kind === 'nlb') continue; // Alternating reference rows and statement footer.
      if (hasPayee && (asText(readField(row, cols.amount)) || asText(readField(row, cols.outflow)) || asText(readField(row, cols.inflow)))) {
        issues.push(makeIssue('warning', source, i, 'A row with an amount has no recognizable date and was not included.'));
      }
      continue;
    }
    const parse = (field) => parseMoney(readField(row, cols[field]));
    const outResult = separate ? parse('outflow') : ZERO;
    const inResult = separate ? parse('inflow') : ZERO;
    const signedResult = separate ? ZERO : parse('amount');
    const feeResult = cols.fee >= 0 ? parse('fee') : ZERO;
    const balanceResult = cols.balance >= 0 ? parse('balance') : ZERO;
    const bad = [outResult, inResult, signedResult, feeResult, balanceResult].filter((x) => x.error);
    if (bad.length) {
      issues.push(makeIssue('error', source, i, bad.map((x) => x.error).join('; ')));
      continue;
    }
    let outflowCents = separate ? Math.abs(outResult.cents) : Math.max(0, -signedResult.cents);
    let inflowCents = separate ? Math.abs(inResult.cents) : Math.max(0, signedResult.cents);
    const feeCents = Math.abs(feeResult.cents);
    if (!outflowCents && !inflowCents && !feeCents) {
      issues.push(makeIssue('warning', source, i, 'A zero-amount row was excluded.'));
      continue;
    }
    if (outflowCents && inflowCents) {
      issues.push(makeIssue('error', source, i, 'Both debit and credit are nonzero; review the column mapping.'));
      continue;
    }
    rawCount++;
    const raw = { date, payee: readField(row, cols.payee), memo: readField(row, cols.memo), outflowCents, inflowCents, feeCents, balanceCents: balanceResult.empty ? null : balanceResult.cents };
    sourceEntries.push(raw);
    if (feeCents > 0 && options.feeTreatment === 'merge' && outflowCents > 0) {
      outflowCents += feeCents;
    }
    transactions.push(buildTransaction({ ...raw, outflowCents, inflowCents }, source, options, i));
    if (feeCents > 0) {
      feesCount++;
      const splitFee = options.feeTreatment === 'separate' || (options.feeTreatment === 'merge' && !raw.outflowCents);
      if (splitFee) {
        transactions.push({
          date, payee: 'Bank fee', memo: `Fee for: ${cleanPayee(raw.payee, options.cleanPayees)}`,
          outflowCents: feeCents, inflowCents: 0,
          sourceId: source.id, file: source.filename, row: i + 1, fee: true,
        });
      } else if (options.feeTreatment === 'ignore') {
        issues.push(makeIssue('warning', source, i, 'The bank fee was omitted. Your YNAB balance may not reconcile.'));
      }
    }
  }
  // The NLB export is newest-first. Validate the actual running balances, using the fee.
  // For flexibility, check both ordering directions and require an exact match in either.
  let checked = 0; let checks = 0;
  if (source.kind === 'nlb' && sourceEntries.length > 1) {
    const pairs = sourceEntries.slice(0, -1).map((current, n) => [current, sourceEntries[n + 1]]).filter(([a, b]) => a.balanceCents !== null && b.balanceCents !== null);
    const net = (x) => x.inflowCents - x.outflowCents - x.feeCents;
    const descendingMatch = pairs.filter(([newer, older]) => newer.balanceCents - older.balanceCents === net(newer)).length;
    const ascendingMatch = pairs.filter(([older, newer]) => newer.balanceCents - older.balanceCents === net(newer)).length;
    checked = Math.max(descendingMatch, ascendingMatch);
    checks = pairs.length;
    if (checked !== checks && checks > 0) {
      issues.push(makeIssue('error', source, source.startIndex, `Running balances disagree for ${checks - checked} of ${checks} neighboring transactions. Check the data before importing.`));
    }
  }
  if (rawCount === 0) issues.push(makeIssue('error', source, source.startIndex, 'No dated transactions with nonzero amounts were found.'));
  return { transactions, issues, checks, checked, rawCount, feesCount };
}

function fingerprint(tx) {
  return [tx.date, tx.payee.toLocaleLowerCase(), tx.memo.toLocaleLowerCase(), tx.outflowCents, tx.inflowCents, tx.fee ? 'fee' : 'txn'].join('\u001f');
}

/** Merge overlapping exports without collapsing repeated same-day payments in one file. */
export function combineSources(sources, options = DEFAULT_OPTIONS) {
  const all = []; const issues = []; const details = [];
  const accountNumbers = [...new Set(sources.map((s) => s.accountId.replace(/[^a-z\d]/gi, '').toUpperCase()).filter(Boolean))];
  const currencies = [...new Set(sources.map((s) => s.currency).filter(Boolean))];
  if (accountNumbers.length > 1) {
    issues.push({ severity: 'error', file: '', row: 0, message: 'The files belong to different bank accounts. Import each account separately into its corresponding YNAB account.' });
  }
  if (currencies.length > 1) {
    issues.push({ severity: 'error', file: '', row: 0, message: 'The files use different currencies. Process currencies separately.' });
  }
  const global = new Set(); let duplicates = 0;
  for (const source of sources) {
    const converted = convertSource(source, options);
    details.push({ source, ...converted });
    issues.push(...converted.issues);
    const occurrence = new Map();
    for (const tx of converted.transactions) {
      const fp = fingerprint(tx);
      const n = (occurrence.get(fp) || 0) + 1;
      occurrence.set(fp, n);
      const unique = `${fp}\u001e${n}`;
      if (options.deduplicate && global.has(unique)) { duplicates++; continue; }
      global.add(unique);
      all.push(tx);
    }
  }
  const dates = all.map((tx) => tx.date).sort();
  const from = options.fromDate || dates[0] || '';
  const to = options.toDate || dates.at(-1) || '';
  if (from && to && from > to) issues.push({severity:'error',file:'',row:0,message:'The start date is after the end date.'});
  const filtered = all.filter((t) => (!from || t.date >= from) && (!to || t.date <= to));
  // Stable sorting preserves repeated transactions on the same day.
  filtered.sort((a, b) => a.date.localeCompare(b.date));
  const totals = filtered.reduce((acc, tx) => {
    acc.outflowCents += tx.outflowCents;
    acc.inflowCents += tx.inflowCents;
    return acc;
  }, {outflowCents:0,inflowCents:0});
  return { transactions: filtered, issues, details, duplicates, totalBeforeFilter: all.length,
    currency: currencies[0] || '', accountId: accountNumbers[0] || '',
    dateStart: filtered[0]?.date || '', dateEnd: filtered.at(-1)?.date || '',
    ...totals,
  };
}

function escapeCsvText(raw) {
  let text = normalizeText(raw);
  // Spreadsheet formula injection prevention for copies opened in Excel/Calc.
  if (/^[=+@\-\t\r\n]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function makeCsv(transactions) {
  const lines = [CSV_HEADER.join(',')];
  for (const t of transactions) {
    const outflow = t.outflowCents ? (t.outflowCents / 100).toFixed(2) : '';
    const inflow = t.inflowCents ? (t.inflowCents / 100).toFixed(2) : '';
    lines.push([t.date, escapeCsvText(t.payee), escapeCsvText(t.memo), outflow, inflow].join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function csvFilename(result) {
  const currency = result.currency || 'account';
  const range = result.dateStart && result.dateEnd ? `_${result.dateStart}_to_${result.dateEnd}` : '';
  return `YNAB_${currency}${range}.csv`;
}
