/* Разбор выписок и разноска операций. Чистая логика без браузера и сети: работает и в приложении, и в тестах. */
(() => {
'use strict';

const TBANK = 'Т-Банк', SBER = 'Сбер', CASH = 'Наличные';
const EXPENSE = 'Расход', INCOME = 'Доход', IGNORE = 'Не учитывать';
const CAFE = 'Кафе и рестораны', LUNCH = 'Обед';

const num = s => parseFloat(String(s).replace(/[\s\u00a0]/g, '').replace(',', '.'));
const toIso = d => d.split('.').reverse().join('-');

/* Сравнение описаний: регистр, ё, знаки препинания и кавычки не важны. */
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/* «LENTA 3413 SANKT-PETERBU RUS.» → «LENTA»: для комментария и для новых правил. */
const prettyName = s => String(s || '')
  .replace(/\s+[A-Z-]+\s+RUS\.?\s*$/, '')
  .replace(/[.\s]+$/, '')
  .replace(/\s+\d+$/, '')
  .trim();

const opKey = o => [o.bank, o.date, o.stamp, o.amount.toFixed(2), norm(o.desc), o.auth || ''].join('|');

/* ---------- Т-Банк, CSV ---------- */
function splitCsv(text){
  const rows = []; let cur = [], f = '', q = false;
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (q){
      if (c !== '"') f += c;
      else if (text[i + 1] === '"'){ f += '"'; i++; }
      else q = false;
    }
    else if (c === '"') q = true;
    else if (c === ';'){ cur.push(f); f = ''; }
    else if (c === '\n'){ cur.push(f); f = ''; rows.push(cur); cur = []; }
    else if (c !== '\r') f += c;
  }
  if (f || cur.length){ cur.push(f); rows.push(cur); }
  return rows;
}
function parseTbank(text){
  const rows = splitCsv(text.replace(/^\uFEFF/, ''));
  const head = rows.shift() || [], ix = n => head.indexOf(n);
  for (const n of ['Дата операции', 'Сумма операции', 'Статус', 'Описание'])
    if (ix(n) < 0) throw new Error('Это не выписка Т-Банка: нет колонки «' + n + '»');
  const out = [];
  for (const r of rows){
    if (r.length < head.length / 2) continue;
    const [d, t] = r[ix('Дата операции')].split(' ');
    const o = {
      bank: TBANK, date: toIso(d), time: (t || '').slice(0, 5), stamp: t || '',
      amount: num(r[ix('Сумма операции')]), desc: r[ix('Описание')],
      bcat: r[ix('Категория по-умолчанию')] || '', mcc: r[ix('MCC')] || '',
      status: r[ix('Статус')], counted: r[ix('Учёт в аналитике')] !== 'Нет'
    };
    if (!isFinite(o.amount)) throw new Error('Не прочитал сумму в строке от ' + d);
    o.key = opKey(o);
    out.push(o);
  }
  return out;
}

/* ---------- Сбер, PDF ----------
   Вход: страницы, на каждой элементы текста { x, y, s } из pdf.js. Строка операции собирается по координатам:
   обычный вывод текста сдвигает суммы относительно описаний. */
const AMOUNT = /^\+?\d[\d\s\u00a0]*,\d\d$/;
function parseSber(pages){
  const ops = [], head = {}; let cur = null;
  for (const items of pages){
    const sorted = items.filter(i => i.s.trim()).map(i => ({ x: i.x, y: i.y, s: i.s.trim() }))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const i of sorted){
      const l = lines[lines.length - 1];
      if (l && Math.abs(l.y - i.y) <= 2) l.items.push(i); else lines.push({ y: i.y, items: [i] });
    }
    for (const l of lines){
      const a = l.items;
      const k = a.findIndex(i => i.s === 'Пополнение' || i.s === 'Списание');
      if (k >= 0 && a[k + 1] && AMOUNT.test(a[k + 1].s)) head[a[k].s] = num(a[k + 1].s);
      if (/^(Продолжение|Для проверки|Дата формирования)/.test(a[0].s)){ cur = null; continue; }
      const isDate = /^\d\d\.\d\d\.\d{4}$/.test(a[0].s) && a[0].x < 60, second = (a[1] && a[1].s) || '';
      const mid = a.filter(i => i.x > 140 && i.x < 360).map(i => i.s).join(' ');
      if (isDate && /^\d\d:\d\d$/.test(second)){
        const sum = a.find(i => i.x >= 360 && AMOUNT.test(i.s));
        if (!sum) throw new Error('Не нашёл сумму операции от ' + a[0].s);
        cur = {
          bank: SBER, date: toIso(a[0].s), time: second, stamp: second, bcat: mid, desc: '', mcc: '',
          amount: sum.s[0] === '+' ? num(sum.s.slice(1)) : -num(sum.s), status: 'Ок', counted: true
        };
        ops.push(cur);
      }
      else if (isDate && /^\d{6}$/.test(second) && cur){ cur.auth = second; cur.desc = mid; }
      else if (cur && cur.auth && a.length === 1 && a[0].x > 140 && a[0].x < 160) cur.desc += ' ' + a[0].s;
    }
  }
  if (head['Пополнение'] == null || head['Списание'] == null) throw new Error('Это не выписка по карте Сбера');
  for (const o of ops){
    o.desc = o.desc.replace(/\s*Операция по.*$/, '').trim();
    o.key = opKey(o);
  }
  const total = sign => ops.filter(o => o.amount * sign > 0).reduce((s, o) => s + Math.abs(o.amount), 0);
  if (Math.abs(total(1) - head['Пополнение']) > .01 || Math.abs(total(-1) - head['Списание']) > .01)
    throw new Error('Выписка Сбера не сошлась с итогами в шапке: часть строк не прочитана');
  return ops;
}

/* ---------- правила ----------
   Источник — лист «Правила импорта»: Описание | Банк | Тип | Категория | Комментарий | Условие. */
function parseRules(rows){
  const rules = [];
  for (const r of rows || []){
    const [desc, bank, type, cat, comment, cond] = r.map(x => String(x == null ? '' : x).trim()).concat(['', '', '', '', '', '']);
    if (desc === 'Общие правила') break;
    if (!desc || !type) continue;
    const small = /мелкие суммы/i.test(desc);
    const clean = desc.replace(/\([^)]*\)/g, ' ').replace(/,\s*мелкие суммы.*$/i, ' ');
    const patterns = clean.split(/\s+\/\s+/).map(norm).filter(Boolean);
    const t = type.toLowerCase(), c = cond.toLowerCase();
    const amt = re => { const m = c.match(re); return m ? num(m[1]) : null; };
    rules.push({
      patterns, bank: bank.toLowerCase() === 'любой' ? null : bank,
      action: t === 'не вносить' ? 'skip' : t === 'спрашивать' ? 'ask' : 'add',
      type: t === 'доход' ? INCOME : EXPENSE,
      cat: cat.toLowerCase() === 'по назначению' ? '' : cat, comment, note: cond,
      min: amt(/сумма от ([\d\s]+)/), max: small ? 1000 : amt(/сумма до ([\d\s]+)/),
      dir: /исходящ/.test(c) ? -1 : /входящ/.test(c) ? 1 : 0,
      lunch: /будни\s*~?\s*\d/.test(c)
    });
  }
  return rules;
}
function findRule(o, rules){
  const text = norm(o.desc), full = norm(o.bcat + ' ' + o.desc), abs = Math.abs(o.amount);
  let best = null, top = -1;
  for (const r of rules){
    if (r.bank && r.bank !== o.bank) continue;
    if (r.min != null && abs < r.min) continue;
    if (r.max != null && abs >= r.max) continue;
    if (r.dir && r.dir * o.amount < 0) continue;
    for (const p of r.patterns){
      const hit = text.includes(p) ? 200 : full.includes(p) ? 100 : 0;
      if (!hit) continue;
      /* правило с условием точнее общего, совпадение в описании точнее совпадения по категории банка */
      const score = hit + p.length + (r.min != null || r.max != null || r.dir ? 1000 : 0);
      if (score > top){ top = score; best = r; }
    }
  }
  return best;
}

/* будни, обеденное время */
const weekday = iso => new Date(iso + 'T12:00:00Z').getUTCDay();
const isLunch = o => { const d = weekday(o.date), h = +o.time.slice(0, 2); return d > 0 && d < 6 && h >= 12 && h < 15; };

/* ---------- догадка по данным банка ---------- */
const BANK_CATS = {
  'Супермаркеты': 'Продукты', 'Рестораны': CAFE, 'Рестораны и кафе': CAFE, 'Фастфуд': CAFE, 'Аптеки': 'Здоровье',
  'Местный транспорт': 'Транспорт', 'Транспорт': 'Транспорт', 'Мобильная связь': 'Связь и интернет', 'Связь': 'Связь и интернет',
  'Одежда и аксессуары': 'Одежда и обувь', 'Одежда и обувь': 'Одежда и обувь', 'Медицина': 'Здоровье', 'Здоровье и красота': 'Здоровье'
};
const MCC_CATS = { 5411: 'Продукты', 5812: CAFE, 5814: CAFE, 5912: 'Здоровье', 4111: 'Транспорт', 4131: 'Транспорт', 4814: 'Связь и интернет' };
const isTransfer = o => /перевод|наличн/i.test(o.bcat);

/* Что делать с операцией: skip — не вносить; rule — внести сразу; guess — спросить с готовым вариантом; ask — спросить. */
function classify(o, rules){
  if (o.status !== 'Ок') return { layer: 'skip', why: 'failed' };
  if (!o.counted) return { layer: 'skip', why: 'own' };
  const type = o.amount < 0 ? EXPENSE : INCOME;
  const r = findRule(o, rules);
  if (r){
    if (r.action === 'skip') return { layer: 'skip', why: 'own' };
    if (r.action === 'ask' || !r.cat) return { layer: 'ask', type, cat: '', comment: r.comment, note: r.note };
    const lunch = r.lunch && isLunch(o);
    return { layer: 'rule', type: r.type, cat: lunch ? CAFE : r.cat, comment: lunch ? LUNCH : r.comment };
  }
  const guess = o.amount < 0 && !isTransfer(o) ? BANK_CATS[o.bcat] || MCC_CATS[o.mcc] : '';
  const comment = prettyName(o.desc);
  if (guess) return { layer: 'guess', type, cat: guess, comment: guess === CAFE && isLunch(o) ? LUNCH : comment };
  return { layer: 'ask', type, cat: '', comment: isTransfer(o) ? '' : comment };
}

/* ---------- сверка с тем, что уже есть в таблице ----------
   Ручные записи бывают округлены: точное совпадение ±1 ₽, до 5 ₽ — если сходится категория или комментарий. */
function findExisting(o, c, rows, used){
  const sum = Math.abs(o.amount), dir = o.amount < 0 ? [EXPENSE] : [INCOME, IGNORE];
  let best = -1, gap = Infinity;
  rows.forEach((x, i) => {
    if (used.has(i) || x.date !== o.date || !dir.includes(x.type)) return;
    if (x.account && x.account !== o.bank) return;
    const d = Math.abs(x.sum - sum);
    const near = d <= 1.01 || (d <= 5 && ((c.cat && x.cat === c.cat) || (c.comment && norm(x.comment) === norm(c.comment))));
    if (near && d < gap){ best = i; gap = d; }
  });
  return best;
}

/* План импорта: что внести, что дополнить, о чём спросить, что отсеять. Ничего не меняет сам. */
function planImport({ ops, rules, rows, seen, cutoffs, pending }){
  const plan = { add: [], fill: [], questions: [], seen: [] };
  const n = { own: 0, failed: 0, dup: 0, old: 0, again: 0 };
  const used = new Set(), done = new Set(pending || []);
  const list = ops.slice().sort((a, b) => (a.date + a.stamp).localeCompare(b.date + b.stamp));
  for (const o of list){
    if (done.has(o.key) || seen.has(o.key)){ n.again++; continue; }
    done.add(o.key);
    if (cutoffs && cutoffs[o.bank] && o.date < cutoffs[o.bank]){ n.old++; continue; }
    const c = classify(o, rules);
    if (c.layer === 'skip'){
      n[c.why]++;
      if (c.why === 'own') plan.seen.push({ key: o.key, date: o.date, result: 'не вносить' });
      continue;
    }
    const i = findExisting(o, c, rows, used);
    if (i >= 0){
      used.add(i); n.dup++;
      if (!rows[i].account) plan.fill.push({ key: o.key, date: o.date, old: rows[i], row: Object.assign({}, rows[i], { account: o.bank }) });
      else plan.seen.push({ key: o.key, date: o.date, result: 'дубль' });
      continue;
    }
    if (c.layer === 'rule') plan.add.push({ key: o.key, op: o, row: toRow(o, c) });
    else plan.questions.push({ id: o.key, op: o, layer: c.layer, type: c.type, cat: c.cat, comment: c.comment, note: c.note || '', person: isTransfer(o) });
  }
  plan.counts = n;
  return plan;
}
const toRow = (o, c) => ({ date: o.date, type: c.type, cat: c.cat, sum: Math.abs(o.amount), comment: c.comment || '', account: o.bank });

/* Ответ на карточку → строка правила для листа. */
function ruleRow(o, a){
  const name = !isTransfer(o) ? prettyName(o.desc) : o.bank === SBER ? o.bcat + ': ' + prettyName(o.desc) : o.desc.trim();
  if (!norm(name)) return null;
  const cond = isTransfer(o) ? (o.amount < 0 ? 'исходящий перевод' : 'входящий перевод') : '';
  return [name, o.bank, a.skip ? 'не вносить' : a.type, a.skip ? '' : a.cat, a.skip ? '' : a.comment, cond];
}

/* ---------- сводка по месяцам ---------- */
function months(rows){
  const m = {};
  for (const r of rows){
    if (r.type !== EXPENSE && r.type !== INCOME) continue;
    const k = r.date.slice(0, 7), x = m[k] || (m[k] = { month: k, income: 0, expense: 0, cats: {}, incomes: {} });
    if (r.type === INCOME){ x.income += r.sum; x.incomes[r.cat] = (x.incomes[r.cat] || 0) + r.sum; }
    else { x.expense += r.sum; x.cats[r.cat] = (x.cats[r.cat] || 0) + r.sum; }
  }
  return Object.values(m).sort((a, b) => a.month.localeCompare(b.month));
}

globalThis.FinEngine = {
  TBANK, SBER, CASH, EXPENSE, INCOME, IGNORE,
  norm, prettyName, parseTbank, parseSber, parseRules, findRule, classify, planImport, toRow, ruleRow, months, isTransfer
};
})();
