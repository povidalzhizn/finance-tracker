/* Хранение на телефоне и обмен с таблицей.
   Снимок таблицы лежит в IndexedDB, изменения копятся в очереди и уходят при первой связи: работает и без сети. */
(() => {
'use strict';

const E = window.FinEngine, CONF = 'fin.sync', CHUNK = 60;

/* ---------- IndexedDB ---------- */
let opened = null;
const open = () => opened || (opened = new Promise((res, rej) => {
  const r = indexedDB.open('fin', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
async function kv(mode, fn){
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction('kv', mode), r = fn(t.objectStore('kv'));
    t.oncomplete = () => res(r.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const load = k => kv('readonly', s => s.get(k));
const save = (k, v) => kv('readwrite', s => s.put(v, k));

/* ---------- состояние ---------- */
const blank = () => ({ rows: [], cats: { expense: [], income: [] }, rules: [], seen: [], cutoffs: {} });
const S = { snap: blank(), outbox: [], inbox: [], report: null, rules: [], busy: false, err: null, last: null, warn: null };
const changed = () => window.dispatchEvent(new Event('finchange'));
const persist = () => Promise.all([save('outbox', S.outbox), save('inbox', S.inbox), save('report', S.report)]);
const uid = () => crypto.randomUUID();
const eq = (a, b) => a.date === b.date && a.type === b.type && a.cat === b.cat && a.comment === b.comment && a.account === b.account && Math.abs(a.sum - b.sum) < .005;

/* таблица + то, что ещё не отправлено */
function view(){
  const rows = S.snap.rows.slice();
  for (const a of S.outbox){
    if (a.kind === 'add') rows.push(a.row);
    else if (a.kind === 'update' || a.kind === 'delete'){
      const i = rows.findIndex(r => eq(r, a.old));
      if (i < 0) continue;
      if (a.kind === 'update') rows[i] = a.row; else rows.splice(i, 1);
    }
  }
  return rows;
}
function seenSet(){
  const s = new Set(S.snap.seen);
  for (const a of S.outbox) s.add(a.id);
  return s;
}
function ruleRows(){
  return S.snap.rules.concat(S.outbox.filter(a => a.kind === 'rule').map(a => a.rule));
}
/* Лист правил кончается блоком «Общие правила», новые строки надо поставить перед ним. */
function refreshRules(){
  const rows = ruleRows(), i = rows.findIndex(r => r[0] === 'Общие правила');
  const fresh = i < 0 ? rows : rows.slice(0, i).concat(rows.slice(S.snap.rules.length));
  S.rules = E.parseRules(fresh);
}
async function enqueue(actions){
  S.outbox.push(...actions);
  refreshRules();
  await persist();
  changed();
  soon();
}

/* ---------- обмен ---------- */
const conf = () => { try { return JSON.parse(localStorage.getItem(CONF)) || {}; } catch (e) { return {}; } };
async function api(action, payload){
  const c = conf();
  const r = await fetch(c.url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action, token: c.token }, payload))
  });
  if (!r.ok) throw new Error('Сервер ответил ' + r.status);
  let j;
  try { j = await r.json(); } catch (e) { throw new Error('Скрипт вернул не JSON. Проверь доступ «Все» при развёртывании.'); }
  if (j.error) throw new Error(j.error);
  return j;
}
let timer = null, again = false;
function soon(ms){ clearTimeout(timer); timer = setTimeout(sync, ms == null ? 1200 : ms); }
async function sync(){
  const c = conf();
  if (!c.url || !c.token) return;
  if (S.busy){ again = true; return; }
  S.busy = true; changed();
  try {
    while (S.outbox.length){
      const part = S.outbox.slice(0, CHUNK), r = await api('apply', { actions: part });
      const failed = r.results.filter(x => !x.ok);
      if (failed.length) S.warn = failed[0].error;
      const sent = new Set(r.results.map(x => x.id));
      S.outbox = S.outbox.filter(a => !sent.has(a.id));
      await save('outbox', S.outbox);
    }
    const snap = await api('pull', {});
    S.snap = snap;
    await save('snap', snap);
    refreshRules();
    S.err = null; S.last = Date.now();
  } catch (e) {
    S.err = e instanceof TypeError ? 'Нет интернета, записи уйдут позже' : (e && e.message) || 'Нет связи';
  }
  S.busy = false; changed();
  if (again){ again = false; soon(200); }
}

/* ---------- файлы выписок ---------- */
function decode(buf){
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (e) { return new TextDecoder('windows-1251').decode(buf); }
}
let pdfjs = null;
async function readPdf(buf){
  if (!pdfjs){
    pdfjs = await import('./vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', location.href).href;
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise, pages = [];
  for (let p = 1; p <= doc.numPages; p++){
    const t = await (await doc.getPage(p)).getTextContent();
    pages.push(t.items.map(i => ({ x: i.transform[4], y: i.transform[5], s: i.str })));
  }
  return pages;
}
async function readFile(file){
  const buf = await file.arrayBuffer();
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return E.parseSber(await readPdf(buf));
  return E.parseTbank(decode(buf));
}

async function importFiles(files){
  const ops = [], errors = [];
  for (const f of files){
    try { ops.push(...await readFile(f)); }
    catch (e) { errors.push(f.name + ': ' + ((e && e.message) || 'не прочитался')); }
  }
  const plan = E.planImport({
    ops, rules: S.rules, rows: view(), seen: seenSet(), cutoffs: S.snap.cutoffs, pending: S.inbox.map(q => q.id)
  });
  const actions = [];
  for (const a of plan.add) actions.push({ id: a.key, kind: 'add', row: a.row, date: a.row.date, result: 'внесено' });
  for (const f of plan.fill) actions.push({ id: f.key, kind: 'update', old: f.old, row: f.row, date: f.date, result: 'счёт дописан' });
  for (const s of plan.seen) actions.push({ id: s.key, kind: 'seen', date: s.date, result: s.result });
  S.inbox.push(...plan.questions);
  S.report = {
    at: Date.now(), read: ops.length, errors, counts: plan.counts, filled: plan.fill.length, asked: plan.questions.length,
    added: plan.add.map(a => a.row)
  };
  await enqueue(actions);
  return S.report;
}

/* ---------- карточки ---------- */
/* Запомненное правило сразу применяется к остальным карточкам. */
function sweep(){
  const out = [];
  S.inbox = S.inbox.filter(q => {
    const c = E.classify(q.op, S.rules);
    if (c.layer === 'rule'){
      const row = E.toRow(q.op, c);
      out.push({ id: q.id, kind: 'add', row, date: row.date, result: 'внесено' });
      if (S.report) S.report.added.push(row);
      return false;
    }
    if (c.layer === 'skip'){ out.push({ id: q.id, kind: 'seen', date: q.op.date, result: 'не вносить' }); return false; }
    return true;
  });
  return out;
}
async function answer(q, a){
  S.inbox = S.inbox.filter(x => x.id !== q.id);
  const actions = [];
  if (a.skip) actions.push({ id: q.id, kind: 'seen', date: q.op.date, result: 'не вносить' });
  else {
    const row = { date: q.op.date, type: a.type, cat: a.cat, sum: Math.abs(q.op.amount), comment: a.comment, account: q.op.bank };
    actions.push({ id: q.id, kind: 'add', row, date: row.date, result: 'внесено' });
  }
  if (a.remember){
    const rule = E.ruleRow(q.op, a);
    if (rule){
      S.outbox.push({ id: uid(), kind: 'rule', rule, result: 'правило' });
      refreshRules();
      actions.push(...sweep());
    }
  }
  await enqueue(actions);
}

/* ---------- ручные правки ---------- */
const addRow = row => enqueue([{ id: uid(), kind: 'add', row, date: row.date, result: 'вручную' }]);
const updateRow = (old, row) => enqueue([{ id: uid(), kind: 'update', old, row, date: row.date, result: 'изменено' }]);
const deleteRow = old => enqueue([{ id: uid(), kind: 'delete', old, date: old.date, result: 'удалено' }]);

window.Fin = {
  state: () => ({
    rows: view(), cats: S.snap.cats, inbox: S.inbox, report: S.report, rulesCount: S.rules.length,
    waiting: S.outbox.length, busy: S.busy, err: S.err, last: S.last, warn: S.warn, on: !!(conf().url && conf().token)
  }),
  conf, sync, importFiles, answer, addRow, updateRow, deleteRow,
  clearWarn(){ S.warn = null; changed(); },
  clearReport(){ S.report = null; persist().then(changed); },
  connect(url, token){
    localStorage.setItem(CONF, JSON.stringify({ url: url.trim(), token: token.trim() }));
    S.err = null; return sync();
  },
  disconnect(){ localStorage.removeItem(CONF); S.err = null; S.last = null; changed(); },
  ready: (async () => {
    try { await navigator.storage.persist(); } catch (e) {}
    S.snap = (await load('snap')) || blank();
    S.outbox = (await load('outbox')) || [];
    S.inbox = (await load('inbox')) || [];
    S.report = (await load('report')) || null;
    refreshRules();
    changed();
    soon(200);
  })()
};
window.addEventListener('online', () => soon(200));
document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(200); });
})();
