import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OPTIONS, parseMoney, parseDate, cleanPayee, decodeEntities, sourceFromRows,
  detectNlb, convertSource, combineSources, makeCsv, csvFilename,
} from '../core.js';

const opts = () => ({...DEFAULT_OPTIONS});

function bankRow({date, payee, memo, debit, credit, fee, balance} = {}) {
  const row = Array(25).fill('');
  row[3] = date || '';
  row[4] = payee || '';
  row[7] = memo || payee || '';
  row[14] = debit || '';
  row[17] = credit || '';
  row[21] = fee || '0,00';
  row[24] = balance || '';
  return row;
}
function bankSource(filename='report.xls') {
  const header = Array(25).fill('');
  header[3] = 'Датум';
  header[4] = 'Назив и седиште на примачот';
  header[7] = 'Цел на дознаката';
  header[14] = 'Износ';
  header[21] = 'Провизија';
  header[24] = 'Состојба';
  const secondary = Array(25).fill('');
  secondary[14] = 'Задолжување';
  secondary[17] = 'Побарување';
  const account = Array(25).fill('');
  account[20] = 'MK99-000-1234567890-12MKD';
  const rows = [[], account, header, secondary,
    bankRow({ date:'03.11.2026',payee:'SKOPJE           WOLT', debit:'', credit:'10,00',balance:'35,00' }),
    ['ref'],
    bankRow({ date:'02.11.2026',payee:'Трезор на РМ',memo:'Reference',debit:'100,00',fee:'25,00',balance:'25,00' }),
    ['ref'],
    bankRow({ date:'01.11.2026',payee:'SKOPJE           TRITEKS',debit:'50,00',balance:'150,00' }),
  ];
  return sourceFromRows(rows,filename);
}

test('parseMoney: European and US formats, negatives, blanks and cents', () => {
  for (const [input, expected] of [
    ['1.425,00',142500], ['40.585,00',4058500], ['449.265,00',44926500],
    ['0,00',0], ['10,50',1050], ['1 234,56',123456], ['1,234.56',123456],
    ['-24.50',-2450], ['(12,40)',-1240], [23.12,2312], ['1.234',123400],
    ['',0], ['25,00 MKD',2500],
  ]) assert.equal(parseMoney(input).cents,expected,String(input));
  assert.ok(parseMoney('not a number').error);
  assert.ok(parseMoney('2,1234').error);
});

test('parseDate: Macedonian dd.mm.yyyy, ISO, US mode, Excel serial, impossible dates', () => {
  assert.equal(parseDate('18.11.2026'),'2026-11-18');
  assert.equal(parseDate('2026-11-18'),'2026-11-18');
  assert.equal(parseDate('11/18/2026','MDY'),'2026-11-18');
  assert.equal(parseDate('18/11/2026','DMY'),'2026-11-18');
  const serial=(Date.UTC(2026,10,18)-Date.UTC(1899,11,30))/86400000;
  assert.equal(parseDate(serial),'2026-11-18');
  assert.equal(parseDate('31.02.2026'),null);
});

test('clean payees: keep Unicode and decode HTML entities; do not remove genuine names',()=>{
  assert.equal(cleanPayee('SKOPJE           WOLT'),'WOLT');
  assert.equal(cleanPayee('SKOPJE           KORPA DOO                74846436318000235551286'),'KORPA DOO');
  assert.equal(cleanPayee('SKOPJE           H&amp;M STORE MK0003'),'H&M STORE MK0003');
  assert.equal(cleanPayee('SKOPJE CITY MALL NLB BANKA AD SKOPJE'),'SKOPJE CITY MALL NLB BANKA AD SKOPJE');
  assert.equal(cleanPayee('SKOPJE           WOLT',false),'SKOPJE WOLT');
  assert.equal(decodeEntities('A &amp; B'),'A & B');
});

test('NLB detection and accurate balances, fees as separate transactions', () => {
  const src=bankSource();
  assert.equal(src.kind,'nlb');
  assert.ok(detectNlb(src.rows));
  assert.equal(src.currency,'MKD');
  const result=convertSource(src,opts());
  assert.equal(result.rawCount,3);
  assert.equal(result.feesCount,1);
  assert.equal(result.transactions.length,4);
  assert.equal(result.checks,2);
  assert.equal(result.checked,2);
  assert.equal(result.issues.filter((x)=>x.severity==='error').length,0);
  assert.deepEqual(result.transactions.map((t)=>[t.payee,t.outflowCents,t.inflowCents]),[
    ['WOLT',0,1000],['Трезор на РМ',10000,0],['Bank fee',2500,0],['TRITEKS',5000,0],
  ]);
});

test('fee choices: merge into debit or intentionally omit with warning',()=>{
  const src=bankSource();
  const merged=convertSource(src,{...opts(),feeTreatment:'merge'});
  assert.equal(merged.transactions.length,3);
  assert.equal(merged.transactions.find((t)=>t.payee==='Трезор на РМ').outflowCents,12500);
  const ignored=convertSource(src,{...opts(),feeTreatment:'ignore'});
  assert.equal(ignored.transactions.length,3);
  assert.ok(ignored.issues.some((x)=>/fee was omitted/.test(x.message)));
});

test('validation catches mismatched balances and malformed amounts',()=>{
  const bad=bankSource();
  bad.rows[6][24]='26,00';
  let result=convertSource(bad,opts());
  assert.ok(result.issues.some((x)=>x.severity==='error'&&/Running balances/.test(x.message)));
  bad.rows[6][14]='not a number';
  result=convertSource(bad,opts());
  assert.ok(result.issues.some((x)=>x.severity==='error'&&/Unrecognized amount/.test(x.message)));
});

test('generic CSV layouts: signed amounts and editable column mapping',()=>{
  const rows=[['Booking Date','Payee','Note','Amount'],['18/11/2026','Groceries','Food','-45,50'],['17/11/2026','Employer','Wage','500,00']];
  const s=sourceFromRows(rows,'generic.csv');
  assert.equal(s.kind,'generic');
  assert.equal(s.mode,'signed');
  const result=convertSource(s,opts());
  assert.equal(result.issues.length,0);
  assert.deepEqual(result.transactions.map((t)=>[t.outflowCents,t.inflowCents]),[[4550,0],[0,50000]]);
});

test('overlapping files dedupe by occurrence, preserving same-day identical legitimate charges',()=>{
  const src1=bankSource('first.xls');
  const src2=bankSource('second.xls');
  const unique=combineSources([src1,src2],opts());
  assert.equal(unique.duplicates,4);
  assert.equal(unique.transactions.length,4);
  assert.deepEqual([unique.outflowCents,unique.inflowCents],[17500,1000]);
});


test('identical same-day charges inside a statement are preserved during multi-file merge', () => {
  const rows=[['Date','Payee','Amount'],['2026-11-18','Sample Grocery','-10.00'],['2026-11-18','Sample Grocery','-10.00']];
  const a=sourceFromRows(rows,'period-a.csv');
  const b=sourceFromRows(rows,'period-b.csv');
  const merged=combineSources([a,b],opts());
  assert.equal(merged.transactions.length,2);
  assert.equal(merged.duplicates,2);
  assert.equal(merged.outflowCents,2000);
});

test('different bank accounts cannot be silently combined',()=>{
  const src1=bankSource('one.xls');
  const src2=bankSource('two.xls');
  src2.accountId='MK07-210-9999999999-99MKD';
  assert.ok(combineSources([src1,src2],opts()).issues.some((x)=>/different bank accounts/.test(x.message)));
});

test('CSV is YNAB 5-column format, UTF-8 BOM, quoted text and stable dates',()=>{
  const combined=combineSources([bankSource()],opts());
  assert.equal(combined.transactions.length,4);
  assert.equal(combined.dateStart,'2026-11-01');
  assert.equal(combined.dateEnd,'2026-11-03');
  assert.equal(csvFilename(combined),'YNAB_MKD_2026-11-01_to_2026-11-03.csv');
  const csv=makeCsv(combined.transactions);
  assert.ok(csv.startsWith('\uFEFFDate,Payee,Memo,Outflow,Inflow\r\n'));
  assert.equal(csv.trim().split('\r\n').length,5);
  assert.ok(csv.includes('2026-11-02,"Трезор на РМ","Reference",100.00,'));
  assert.ok(csv.includes('2026-11-03,"WOLT","",,10.00'));
});

test('filter dates and fee-aware totals',()=>{
  const x=combineSources([bankSource()],{...opts(),fromDate:'2026-11-02',toDate:'2026-11-03'});
  assert.equal(x.transactions.length,3);
  assert.deepEqual([x.outflowCents,x.inflowCents],[12500,1000]);
});
