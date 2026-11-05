/* Финансы: мост между приложением и Google Таблицей учёта.
   «Операции» (A–F), «Категории» и «Правила импорта» остаются главным местом: приложение только дописывает и правит строки.
   Лист _импорт — журнал обработанного: одна и та же операция не внесётся дважды, даже если запрос повторится.
   Токен хранится в свойствах скрипта, в коде его нет. */
const OPS = 'Операции', CATS = 'Категории', RULES = 'Правила импорта', LOG = '_импорт';
const TBANK = 'Т-Банк', SBER = 'Сбер';

function setup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('TOKEN', token);
  }
  const log = logSheet_();
  if (log.getLastRow() < 2) {
    /* Всё, что старше последней записи по счёту, уже разобрано раньше: приложение туда не лезет. */
    const rows = readOps_(), last = {};
    rows.forEach(r => { if (r.account && (!last[r.account] || r.date > last[r.account])) last[r.account] = r.date; });
    const seed = [TBANK, SBER].filter(a => last[a]).map(a => ['cutoff:' + a, last[a], 'граница']);
    if (seed.length) log.getRange(2, 1, seed.length, 3).setValues(seed);
  }
  Logger.log('Токен для приложения: ' + token);
}

function doGet() {
  return json_({ ok: true });
}

function doPost(e) {
  try {
    const q = JSON.parse(e.postData.contents);
    const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || q.token !== token) return json_({ error: 'Неверный токен' });
    const fn = { pull: pull_, apply: apply_ }[q.action];
    if (!fn) return json_({ error: 'Неизвестное действие' });
    return json_(fn(q));
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('В таблице нет листа «' + name + '»');
  return sh;
}

function logSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(LOG);
  if (!sh) {
    sh = ss.insertSheet(LOG);
    sh.getRange(1, 1, 1, 3).setValues([['id', 'дата', 'результат']]);
    sh.getRange('A:C').setNumberFormat('@');
  }
  return sh;
}

function readLog_() {
  const sh = logSheet_(), n = sh.getLastRow();
  return n < 2 ? [] : sh.getRange(2, 1, n - 1, 3).getValues();
}

/* ---------- чтение ---------- */
function iso_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  const m = String(v).match(/^(\d\d)\.(\d\d)\.(\d{4})$/);
  return m ? m[3] + '-' + m[2] + '-' + m[1] : '';
}

function serial_(iso) {
  const p = iso.split('-').map(Number);
  return (Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(1899, 11, 30)) / 864e5;
}

function lastOpRow_(sh) {
  const col = sh.getRange(1, 1, sh.getMaxRows(), 1).getValues();
  let n = col.length;
  while (n > 1 && col[n - 1][0] === '') n--;
  return n;
}

function readOps_() {
  const sh = sheet_(OPS), n = lastOpRow_(sh);
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, 6).getValues().map((r, i) => ({
    n: i + 2, date: iso_(r[0]), type: String(r[1]), cat: String(r[2]), sum: Number(r[3]) || 0, comment: String(r[4]), account: String(r[5])
  })).filter(r => r.date);
}

function column_(sh, col) {
  const n = sh.getLastRow(), out = [];
  if (n < 2) return out;
  const v = sh.getRange(2, col, n - 1, 1).getValues();
  for (let i = 0; i < v.length; i++) {
    const s = String(v[i][0]).trim();
    if (!s) break;
    out.push(s);
  }
  return out;
}

function pull_() {
  const cats = sheet_(CATS), rules = sheet_(RULES), n = rules.getLastRow();
  const log = readLog_(), seen = [], cutoffs = {};
  log.forEach(r => {
    const id = String(r[0]);
    if (id.indexOf('cutoff:') === 0) cutoffs[id.slice(7)] = String(r[1]);
    else seen.push(id);
  });
  return {
    rows: readOps_(),
    cats: { expense: column_(cats, 1), income: column_(cats, 4) },
    rules: n < 2 ? [] : rules.getRange(2, 1, n - 1, 6).getValues().map(r => r.map(String)),
    seen, cutoffs
  };
}

/* ---------- запись ---------- */
const same_ = (r, o) => r.date === o.date && r.type === o.type && r.cat === o.cat && r.comment === o.comment && r.account === o.account && Math.abs(r.sum - o.sum) < .005;
const cells_ = r => [serial_(r.date), r.type, r.cat, r.sum, r.comment, r.account];

function apply_(q) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(OPS), done = {}, log = [], results = [];
    readLog_().forEach(r => { done[r[0]] = true; });
    let rows = readOps_(), adds = [], changed = false;

    const flush = () => {
      if (!adds.length) return;
      const last = lastOpRow_(sh), room = sh.getMaxRows() - last;
      if (room < adds.length) sh.insertRowsAfter(sh.getMaxRows(), adds.length - room + 50);
      sh.getRange(last + 1, 1, adds.length, 6).setValues(adds.map(cells_));
      sh.getRange(last + 1, 1, adds.length, 1).setNumberFormat('dd.mm.yyyy');
      rows = rows.concat(adds.map((r, i) => Object.assign({}, r, { n: last + 1 + i })));
      adds = []; changed = true;
    };
    const locate = old => {
      flush();
      const i = rows.findIndex(r => same_(r, old));
      if (i < 0) throw new Error('Строка уже изменена в таблице, обнови приложение');
      return i;
    };

    (q.actions || []).forEach(a => {
      if (done[a.id]) { results.push({ id: a.id, ok: true, again: true }); return; }
      try {
        if (a.kind === 'add') adds.push(a.row);
        else if (a.kind === 'update') {
          const i = locate(a.old), n = rows[i].n;
          sh.getRange(n, 1, 1, 6).setValues([cells_(a.row)]);
          rows[i] = Object.assign({}, a.row, { n }); changed = true;
        }
        else if (a.kind === 'delete') {
          const i = locate(a.old), n = rows[i].n;
          sh.deleteRow(n);
          rows.splice(i, 1);
          rows.forEach(r => { if (r.n > n) r.n--; });
        }
        else if (a.kind === 'rule') addRule_(a.rule);
        else if (a.kind !== 'seen') throw new Error('Неизвестная запись: ' + a.kind);
        done[a.id] = true;
        log.push([a.id, a.date || '', a.result || a.kind]);
        results.push({ id: a.id, ok: true });
      } catch (err) {
        results.push({ id: a.id, ok: false, error: String(err && err.message || err) });
      }
    });
    flush();
    if (changed) {
      const last = lastOpRow_(sh);
      if (last > 2) sh.getRange(2, 1, last - 1, 6).sort({ column: 1, ascending: true });
    }
    if (log.length) {
      const sheet = logSheet_(), n = sheet.getLastRow();
      sheet.getRange(n + 1, 1, log.length, 3).setValues(log);
    }
    return { results };
  } finally {
    lock.releaseLock();
  }
}

/* Новое правило встаёт перед пустой строкой над блоком «Общие правила». */
function addRule_(rule) {
  const sh = sheet_(RULES), n = sh.getLastRow();
  const col = sh.getRange(1, 1, n, 2).getValues();
  if (col.some(r => r[0] === rule[0] && r[1] === rule[1])) return;
  let at = col.findIndex(r => r[0] === 'Общие правила');
  at = at < 0 ? n + 1 : at + 1;
  if (at > 1 && at <= n && col[at - 2][0] === '') at--;
  if (at <= n) sh.insertRowBefore(at);
  sh.getRange(at, 1, 1, 6).setValues([rule]);
}
